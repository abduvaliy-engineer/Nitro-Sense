//! App Sync (NitroSense Scenario.ChangeProfile): while a linked app is in front, its profile is applied;
//! any other window in front (NitroSense's own too) brings back the profile the user picked. Hyprland
//! reports focus; without it the most recently started running linked app counts.
use super::apps::is_game;
use super::desktop::{exec_args, field, read_entry};
use super::sensors::read_power;
use super::util::{basename, exists};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(3000); // NitroSense AppWatcherTime
const SETTLE: Duration = Duration::from_millis(3000); // a focus change must hold this long, so alt-tabbing doesn't switch profiles
const FOCUS_DEBOUNCE: Duration = Duration::from_millis(50);

// Launch prefixes stripped from Exec lines (NitroSense matches the real target).
const PREFIXES: [&str; 10] =
    ["setsid", "prime-run", "primusrun", "optirun", "pvkrun", "gamemoderun", "mangohud", "obs-gamecapture", "dbus-run-session", "app2unit"];

// Programs that never identify an app on their own (they run many apps).
fn generic(name: &str) -> bool {
    static GENERIC: OnceLock<Regex> = OnceLock::new();
    GENERIC
        .get_or_init(|| {
            Regex::new(r"(?i)^(env|sh|bash|dash|zsh|fish|python[0-9.]*|node|nodejs|electron[0-9]*|java|dotnet|mono|wine[0-9]*|wine-preloader|wine64-preloader|wineserver|steam|steamwebhelper|reaper|pressure-vessel.*|srt-bwrap|bwrap|flatpak|xdg-dbus-proxy|systemd|uwsm.*|gtk-launch|xdg-terminal-exec|foot|footclient|kitty|alacritty|ghostty|chromium|chrome|google-chrome.*|brave.*|firefox|soffice\.bin|libreoffice)$").unwrap()
        })
        .is_match(name)
}

fn interpreter(name: &str) -> bool {
    static INTERPRETERS: OnceLock<Regex> = OnceLock::new();
    INTERPRETERS
        .get_or_init(|| Regex::new(r"(?i)^(electron[0-9]*|java|dotnet|mono|python[0-9.]*|node|nodejs|sh|bash|dash|zsh|wine[0-9]*)$").unwrap())
        .is_match(name)
}

// ---------- processes ----------

#[derive(Clone, Debug, Default)]
pub struct Proc {
    pub pid: i64,
    pub ppid: i64,
    pub start: u64,
    pub comm: String,
    pub exe: String,
    pub argv: Vec<String>,
    pub unit: String,
}

fn proc_info(pid: i64) -> Option<Proc> {
    let dir = format!("/proc/{pid}");
    let lossy = |bytes: Vec<u8>| String::from_utf8_lossy(&bytes).into_owned();
    // None: gone, a kernel thread or another user's process.
    let stat = lossy(std::fs::read(format!("{dir}/stat")).ok()?);
    let exe = std::fs::read_link(format!("{dir}/exe")).ok()?.to_string_lossy().into_owned();
    let cmdline = lossy(std::fs::read(format!("{dir}/cmdline")).ok()?);
    let cgroup = std::fs::read(format!("{dir}/cgroup")).map(lossy).unwrap_or_default();
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat.get(close + 2..)?.split(' ').collect();
    Some(Proc {
        pid,
        ppid: fields.get(1)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
        comm: stat.get(stat.find('(')? + 1..close)?.to_string(),
        exe: exe.strip_suffix(" (deleted)").unwrap_or(&exe).to_string(),
        argv: cmdline.split('\0').filter(|arg| !arg.is_empty()).map(str::to_string).collect(),
        unit: cgroup.trim().rsplit('/').next().unwrap_or("").replace("\\x2d", "-"),
    })
}

/// Our processes, cached by pid (a pid that is gone is dropped at the next scan).
#[derive(Default)]
struct Procs {
    known: HashMap<i64, Proc>,
}

impl Procs {
    fn info(&mut self, pid: i64) -> Option<Proc> {
        if let Some(cached) = self.known.get(&pid) {
            return Some(cached.clone());
        }
        let found = proc_info(pid)?;
        self.known.insert(pid, found.clone());
        Some(found)
    }

    fn scan(&mut self) -> Vec<Proc> {
        let pids: Vec<i64> = std::fs::read_dir("/proc")
            .map(|entries| entries.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).collect())
            .unwrap_or_default();
        self.known.retain(|pid, _| pids.contains(pid));
        pids.into_iter().filter_map(|pid| self.info(pid)).collect()
    }

    fn ancestors(&mut self, item: &Proc) -> Vec<Proc> {
        let mut chain = Vec::new();
        let mut current = Some(item.clone());
        for _ in 0..32 {
            let Some(parent) = current.as_ref().filter(|proc| proc.ppid > 1).map(|proc| proc.ppid) else { break };
            current = self.info(parent);
            chain.extend(current.clone());
        }
        chain
    }

    fn descendants(&mut self, pid: i64, depth: u8) -> Vec<Proc> {
        if depth > 6 {
            return Vec::new();
        }
        let children = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).unwrap_or_default();
        let mut result = Vec::new();
        for child in children.split_whitespace().filter_map(|child| child.parse::<i64>().ok()) {
            if let Some(item) = self.info(child) {
                result.push(item);
                result.extend(self.descendants(child, depth + 1));
            }
        }
        result
    }

    fn is_own(&mut self, item: &Proc) -> bool {
        let own = i64::from(std::process::id());
        item.pid == own || self.ancestors(item).iter().any(|ancestor| ancestor.pid == own)
    }
}

// ---------- matchers ----------

fn resolve_program(program: Option<&String>) -> Option<String> {
    let program = program.filter(|program| !program.is_empty())?;
    let file = if program.contains('/') {
        PathBuf::from(program)
    } else {
        let path = std::env::var("PATH").unwrap_or_default();
        path.split(':').map(|dir| Path::new(dir).join(program)).find(|file| exists(file))?
    };
    Some(std::fs::canonicalize(&file).unwrap_or(file).to_string_lossy().into_owned())
}

/// Strip launch wrappers: env, sh -c, setsid, mangohud …
pub fn strip_wrappers(args: &[String]) -> Vec<String> {
    let assignment = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap();
    let digits = |arg: &str| !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_digit());
    let mut rest: Vec<String> = args.to_vec();
    for _ in 0..10 {
        if rest.is_empty() {
            break;
        }
        let name = basename(&rest[0]).to_string();
        if name == "env" {
            rest.remove(0);
            while !rest.is_empty() && (rest[0].starts_with('-') || assignment.is_match(&rest[0])) {
                if rest[0] == "-u" || rest[0] == "-C" {
                    rest.remove(0);
                }
                if !rest.is_empty() {
                    rest.remove(0);
                }
            }
        } else if matches!(name.as_str(), "sh" | "bash" | "dash" | "zsh")
            && rest.get(1).is_some_and(|arg| arg == "-c")
            && rest.get(2).is_some_and(|script| !script.is_empty())
        {
            rest = exec_args(rest[2].split([';', '&', '|']).next().unwrap_or(""));
        } else if matches!(name.as_str(), "nice" | "ionice" | "taskset" | "chrt") {
            rest.remove(0);
            while !rest.is_empty() && (rest[0].starts_with('-') || digits(&rest[0])) {
                rest.remove(0);
            }
        } else if PREFIXES.contains(&name.as_str()) || name == "uwsm-app" {
            rest.remove(0);
            if rest.first().is_some_and(|arg| arg == "--") {
                rest.remove(0);
            }
        } else {
            break;
        }
    }
    rest
}

// A launcher script's final `exec <program> <args>` line, with simple VAR=value assignments filled in.
// "$@" marks where the caller's arguments go; anything else still dynamic is dropped.
fn exec_line(text: &str) -> Option<Vec<String>> {
    let assignment = Regex::new(
        r#"(?m)^\s*(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"$`]*)"|'([^']*)'|([^\s$`;|&]*))\s*$"#,
    )
    .unwrap();
    let mut vars: HashMap<String, String> = HashMap::new();
    for found in assignment.captures_iter(text) {
        let value = found.get(2).or(found.get(3)).or(found.get(4)).map(|value| value.as_str()).unwrap_or("");
        vars.insert(found[1].to_string(), value.to_string());
    }
    let exec = Regex::new(r"^\s*exec\s+").unwrap();
    let line = text.split('\n').rev().find(|line| exec.is_match(line))?;
    let variable = Regex::new(r"\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)").unwrap();
    let mut args = Vec::new();
    for raw in exec_args(&exec.replace(line.trim(), "")) {
        if raw == "$@" || raw == "${@}" || raw == "$*" {
            args.push("$@".to_string());
            continue;
        }
        let value = variable.replace_all(&raw, |found: &regex::Captures| {
            let name = found.get(1).or(found.get(2)).map(|name| name.as_str()).unwrap_or("");
            vars.get(name).cloned().unwrap_or_else(|| found[0].to_string())
        });
        if !value.contains('$') {
            args.push(value.into_owned());
        }
    }
    Some(args)
}

/// What actually runs for a command line.
#[derive(Default)]
struct Target {
    exe: Option<String>,
    interpreter: Option<String>,
    arg: Option<String>,
}

// The first bytes of a program, and all of it when it is a script.
fn read_program(program: &str) -> Option<(bool, String)> {
    let mut file = std::fs::File::open(program).ok()?;
    let mut head = [0u8; 4];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    if head == *b"\x7fELF" {
        return Some((true, String::new()));
    }
    let mut bytes = head[..filled].to_vec();
    file.take(1 << 20).read_to_end(&mut bytes).ok()?;
    Some((false, String::from_utf8_lossy(&bytes).into_owned()))
}

// The real executable, or an interpreter and the app file it runs (Obsidian: electron + app.asar, TLauncher:
// java + TLauncher.jar). Launcher scripts are followed.
fn target(args: &[String], depth: u8) -> Target {
    let args = strip_wrappers(args);
    let Some(program) = resolve_program(args.first()) else { return Target::default() };
    let Some((elf, text)) = read_program(&program).filter(|_| depth <= 4) else { return Target::default() };
    if elf {
        if !interpreter(basename(&program)) {
            return Target { exe: Some(program), ..Default::default() };
        }
        return match args.iter().skip(1).find(|arg| arg.starts_with('/')) {
            Some(file) => Target { interpreter: Some(program), arg: Some(file.clone()), ..Default::default() },
            None => Target::default(),
        };
    }
    if !text.starts_with("#!") {
        return Target::default();
    }
    if let Some(line) = exec_line(&text) {
        let next: Vec<String> = match line.iter().position(|arg| arg == "$@") {
            Some(pass) => line[..pass].iter().chain(args.iter().skip(1)).chain(&line[pass + 1..]).cloned().collect(),
            None => line,
        };
        let inner = target(&next, depth + 1);
        if inner.exe.is_some() || inner.interpreter.is_some() {
            return inner;
        }
    }
    Target { arg: Some(program), ..Default::default() } // the script itself runs as `sh <program>`
}

/// How to recognise a linked app's processes and windows (equality only, never NitroSense's substring match).
#[derive(Clone, Debug, Default)]
pub struct Matcher {
    pub steam: Option<i64>,
    pub classes: Vec<String>,
    pub windows_exe: Option<String>,
    pub app_image: Option<String>,
    pub exe: Option<String>,
    pub interpreter: Option<String>,
    pub arg: Option<String>,
    pub unit: Option<String>,
    pub names: Vec<String>,
    pub game: bool,
    pub terminal: bool,
    pub web_host: Option<String>,
}

fn steam_matcher(appid: i64) -> Matcher {
    Matcher { steam: Some(appid), classes: vec![format!("steam_app_{appid}")], ..Default::default() }
}

// The host[:port] of a URL, lowercase, as the URL standard's `host` gives it (default ports dropped).
fn url_host(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("").to_lowercase();
    let default_port = if scheme.eq_ignore_ascii_case("https") { ":443" } else { ":80" };
    host.strip_suffix(default_port).unwrap_or(&host).to_string()
}

/// None: the app is missing and never matches.
pub fn matcher(app: &Value) -> Option<Matcher> {
    let ends_with = |path: &str, extension: &str| path.to_lowercase().ends_with(extension);
    match app["kind"].as_str() {
        Some("steam") => return Some(steam_matcher(app["steamAppId"].as_i64()?)),
        Some("file") => {
            let path = app["path"].as_str()?;
            if ends_with(path, ".exe") {
                return Some(Matcher { windows_exe: Some(basename(path).to_lowercase()), ..Default::default() });
            }
            if ends_with(path, ".appimage") {
                return Some(Matcher { app_image: Some(path.to_string()), ..Default::default() });
            }
            let runs = target(&[path.to_string()], 0);
            return Some(if runs.exe.is_some() || runs.interpreter.is_some() {
                Matcher { exe: runs.exe, interpreter: runs.interpreter, arg: runs.arg, ..Default::default() }
            } else {
                Matcher { exe: Some(path.to_string()), ..Default::default() }
            });
        }
        _ => {}
    }
    let desktop_id = app["desktopId"].as_str()?;
    let found = read_entry(desktop_id)?;
    let entry = &found.entry;
    let id = desktop_id.strip_suffix(".desktop").unwrap_or(desktop_id);
    let mut result = Matcher { classes: vec![id.to_string()], unit: Some(id.to_string()), game: is_game(entry), ..Default::default() };
    if let Some(class) = field(entry, "StartupWMClass").filter(|class| !class.contains("@@")) {
        result.classes.push(class.to_string());
    }
    let mut args = strip_wrappers(&exec_args(&found.exec));
    if let Some(steam) = super::apps::steam_launch(&found.exec).and_then(|appid| appid.parse().ok()) {
        return Some(steam_matcher(steam));
    }
    let first = args.first().map(|arg| basename(arg).to_string()).unwrap_or_default();
    if first == "flatpak" && args.iter().any(|arg| arg == "run") {
        let run = args.iter().position(|arg| arg == "run").unwrap_or(0);
        let flatpak = args[run + 1..].iter().find(|arg| !arg.starts_with('-'))?;
        return Some(Matcher { classes: vec![flatpak.clone()], unit: Some(format!("flatpak-{flatpak}")), ..Default::default() });
    }
    let webapp = Regex::new(r#"(?:omarchy-launch-webapp|--app=)\s*"?(https?://[^\s"]+)"#).unwrap();
    if let Some(found) = webapp.captures(&found.exec) {
        return Some(Matcher { classes: result.classes, web_host: Some(url_host(&found[1])), ..Default::default() });
    }
    if first == "xdg-terminal-exec" || found.terminal {
        result.terminal = true;
        if first == "xdg-terminal-exec" {
            let from = args.iter().position(|arg| arg == "-e").map_or(1, |at| at + 1);
            args = args.into_iter().skip(from).filter(|arg| !arg.starts_with("--app-id")).collect();
        }
    }
    let runs = target(&args, 0);
    if let Some(exe) = runs.exe.filter(|exe| !generic(basename(exe))) {
        result.exe = Some(exe);
    }
    if runs.arg.is_some() {
        result.arg = runs.arg;
        if runs.interpreter.is_some() {
            result.interpreter = runs.interpreter;
        }
    }
    let base = args.first().map(|arg| basename(arg)).unwrap_or("");
    if !base.is_empty() && !generic(base) {
        result.names.push(base.to_lowercase());
    }
    let name = field(entry, "Name").unwrap_or("");
    let mut chars = name.chars();
    if name.len() >= 4 && chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric()) {
        result.names.push(name.to_lowercase());
    }
    Some(result)
}

pub fn match_process(m: &Matcher, item: &Proc) -> bool {
    if m.exe.as_ref().is_some_and(|exe| item.exe == *exe) {
        return true;
    }
    if let Some(arg) = &m.arg {
        let runs_it = m.interpreter.as_ref().is_none_or(|interpreter| item.exe == *interpreter || generic(basename(&item.exe)));
        if item.argv.contains(arg) && runs_it {
            return true;
        }
    }
    if let Some(unit) = &m.unit {
        let scope = &item.unit;
        if scope.starts_with("app-")
            && (scope.contains(&format!("-{unit}-")) || scope.contains(&format!("-{unit}@")) || scope.ends_with(&format!("-{unit}.scope")))
        {
            return true;
        }
    }
    if let Some(windows_exe) = &m.windows_exe {
        let named = |name: &String| !name.is_empty() && basename(&name.replace('\\', "/")).to_lowercase() == *windows_exe;
        if item.argv.first().is_some_and(named) || named(&item.comm) {
            return true;
        }
    }
    !m.names.is_empty() && !generic(&item.comm) && m.names.contains(&item.comm.to_lowercase())
}

fn match_steam(procs: &mut Procs, m: &Matcher, item: &Proc) -> bool {
    let Some(steam) = m.steam else { return false };
    let app_id = format!("AppId={steam}");
    let launched = |proc: &Proc| proc.argv.iter().any(|arg| arg == "SteamLaunch") && proc.argv.contains(&app_id);
    launched(item) || procs.ancestors(item).iter().any(launched)
}

fn match_app_image(m: &Matcher, item: &Proc) -> bool {
    let Some(app_image) = m.app_image.as_ref().filter(|_| item.exe.starts_with("/tmp/.mount_")) else { return false };
    let environ = std::fs::read(format!("/proc/{}/environ", item.pid)).unwrap_or_default();
    let wanted = format!("APPIMAGE={app_image}");
    environ.split(|&b| b == 0).any(|variable| variable == wanted.as_bytes())
}

fn matches_process(procs: &mut Procs, m: &Matcher, item: &Proc) -> bool {
    match_process(m, item) || match_steam(procs, m, item) || match_app_image(m, item)
}

struct Focus {
    pid: i64,
    class: String,
    initial_class: String,
}

fn matches_window(procs: &mut Procs, m: &Matcher, window: &Focus, item: Option<&Proc>) -> bool {
    let classes: Vec<String> = [&window.class, &window.initial_class].iter().filter(|c| !c.is_empty()).map(|c| c.to_lowercase()).collect();
    if m.classes.iter().any(|class| classes.contains(&class.to_lowercase())) {
        return true;
    }
    if let Some(host) = &m.web_host {
        return classes.iter().any(|class| class.contains(host));
    }
    let Some(item) = item else { return false };
    if matches_process(procs, m, item) {
        return true;
    }
    if m.game && procs.ancestors(item).iter().any(|parent| match_process(m, parent)) {
        return true;
    }
    m.terminal && procs.descendants(item.pid, 0).iter().any(|child| match_process(m, child))
}

// ---------- the watcher ----------

struct Link {
    index: usize,
    enabled: bool,
    /// The linked app's name, for the notification.
    app: String,
    matcher: Matcher,
}

/// What should run now: the user's own profile, a linked profile, or no change (an app of a profile with App
/// Sync off is in front: NitroSense then neither switches nor reverts).
enum Desired {
    Own,
    /// The profile's name and the linked app that asks for it.
    Profile(String, String),
    Hold,
}

enum Message {
    Configure(Value, Sender<()>),
    FocusChanged(u64),
    HyprlandClosed(u64),
}

type Notify = Box<dyn Fn(Value) + Send>;

struct Watcher {
    notify: Notify,
    sender: Sender<Message>,
    config: Option<Value>, // { active, select, profiles: [{ name, appSync, apps }] }
    links: Vec<Link>,
    last: Option<Option<String>>,    // desired profile name (None inside = the user's own) from the last switch
    pending: Option<Option<String>>, // desired value waiting to settle
    pending_app: Option<String>,     // the linked app behind it
    settle_at: Option<Instant>,
    poll_at: Option<Instant>, // Some while watching
    focus_at: Option<Instant>,
    reconnect_at: Option<Instant>,
    focus: Option<Focus>, // the window in front (Hyprland)
    hyprland: Option<(u64, UnixStream)>,
    connections: u64,
    procs: Procs,
}

fn hypr_socket(name: &str) -> Option<PathBuf> {
    let env = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    Some(Path::new(&env("XDG_RUNTIME_DIR")?).join("hypr").join(env("HYPRLAND_INSTANCE_SIGNATURE")?).join(name))
}

fn hypr_request(command: &str) -> Option<Value> {
    let mut socket = UnixStream::connect(hypr_socket(".socket.sock")?).ok()?;
    socket.set_read_timeout(Some(Duration::from_millis(1000))).ok()?;
    socket.set_write_timeout(Some(Duration::from_millis(1000))).ok()?;
    socket.write_all(command.as_bytes()).ok()?;
    let mut data = Vec::new();
    let _ = socket.read_to_end(&mut data);
    serde_json::from_slice(&data).ok()
}

impl Watcher {
    fn refresh_focus(&mut self) {
        let window = hypr_request("j/activewindow");
        self.focus = window.filter(|window| window["pid"].as_i64().is_some_and(|pid| pid > 0)).map(|window| Focus {
            pid: window["pid"].as_i64().unwrap_or(0),
            class: window["class"].as_str().unwrap_or("").to_string(),
            initial_class: window["initialClass"].as_str().unwrap_or("").to_string(),
        });
    }

    fn profile_name(&self, index: usize) -> String {
        self.config.as_ref().and_then(|config| config["profiles"][index]["name"].as_str()).unwrap_or("").to_string()
    }

    fn desired(&mut self) -> Desired {
        let own = i64::from(std::process::id());
        let mut choice: Option<(usize, bool, String)> = None;
        if self.hyprland.is_some() {
            let Some(focus) = self.focus.take() else { return Desired::Own };
            let item = self.procs.info(focus.pid);
            let is_own = item.as_ref().is_some_and(|item| self.procs.is_own(item));
            if !is_own {
                let found = self.links.iter().find(|link| matches_window(&mut self.procs, &link.matcher, &focus, item.as_ref()));
                choice = found.map(|link| (link.index, link.enabled, link.app.clone()));
            }
            self.focus = Some(focus);
        } else {
            let mut best_start: Option<u64> = None;
            for item in self.procs.scan() {
                if item.pid == own {
                    continue;
                }
                for link in &self.links {
                    if best_start.is_none_or(|start| item.start > start) && matches_process(&mut self.procs, &link.matcher, &item) {
                        best_start = Some(item.start);
                        choice = Some((link.index, link.enabled, link.app.clone()));
                    }
                }
            }
        }
        match choice {
            None => Desired::Own,
            Some((index, true, app)) => Desired::Profile(self.profile_name(index), app),
            Some((_, false, _)) => Desired::Hold,
        }
    }

    fn evaluate(&mut self) {
        if self.config.is_none() {
            return;
        }
        let (key, app) = match self.desired() {
            Desired::Hold => {
                self.pending = None;
                self.settle_at = None;
                return;
            }
            Desired::Own => (None, None),
            Desired::Profile(name, app) => (Some(name), Some(app)),
        };
        if self.last.as_ref() == Some(&key) {
            self.pending = None;
            self.settle_at = None;
            return;
        }
        if self.pending.as_ref() == Some(&key) {
            return;
        }
        self.pending = Some(key);
        self.pending_app = app;
        self.settle_at = Some(Instant::now() + if self.hyprland.is_some() { SETTLE } else { Duration::ZERO });
    }

    // The pending choice held long enough: switch.
    fn settle(&mut self) {
        self.settle_at = None;
        let Some(key) = self.pending.take() else { return };
        let app = self.pending_app.take();
        self.last = Some(key.clone());
        let Some(config) = &self.config else { return };
        let index = match &key {
            None => config["select"].as_i64(),
            Some(name) => config["profiles"].as_array().and_then(|profiles| profiles.iter().position(|p| p["name"] == *name)).map(|i| i as i64),
        };
        if let Some(index) = index.filter(|&index| index >= 0 && Some(index) != config["active"].as_i64()) {
            let reason = if key.is_none() { "revert" } else { "app" };
            (self.notify)(json!({ "index": index, "reason": reason, "app": app, "power": read_power() }));
        }
    }

    fn listen_hyprland(&mut self) {
        let Some(file) = hypr_socket(".socket2.sock") else { return };
        self.connections += 1;
        let id = self.connections;
        let sender = self.sender.clone();
        let Ok(socket) = UnixStream::connect(file) else {
            // Try again later, like a connection that closes.
            self.reconnect_at = self.poll_at.map(|_| Instant::now() + POLL);
            return;
        };
        let Ok(reader) = socket.try_clone() else { return };
        self.hyprland = Some((id, socket));
        std::thread::spawn(move || {
            for line in BufReader::new(reader).split(b'\n') {
                let Ok(line) = line else { break };
                if [&b"activewindowv2>>"[..], b"closewindow>>", b"openwindow>>"].iter().any(|event| line.starts_with(event))
                    && sender.send(Message::FocusChanged(id)).is_err()
                {
                    return;
                }
            }
            let _ = sender.send(Message::HyprlandClosed(id));
        });
    }

    fn start(&mut self) {
        if self.poll_at.is_none() {
            self.poll_at = Some(Instant::now() + POLL);
        }
        if self.hyprland.is_none() {
            self.listen_hyprland();
        }
    }

    fn stop(&mut self) {
        self.poll_at = None;
        self.reconnect_at = None;
        if let Some((_, socket)) = self.hyprland.take() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }

    // From the window after every scenario change: { active, select, profiles: [{ name, appSync, apps }] }.
    fn configure(&mut self, next: Value) {
        let mut links = Vec::new();
        for (index, profile) in next["profiles"].as_array().map(Vec::as_slice).unwrap_or_default().iter().enumerate() {
            for app in profile["apps"].as_array().map(Vec::as_slice).unwrap_or_default() {
                if let Some(matcher) = matcher(app) {
                    let app = app["name"].as_str().unwrap_or("").to_string();
                    links.push(Link { index, enabled: profile["appSync"] != false, app, matcher });
                }
            }
        }
        // Watch while something is linked, or while a linked profile still has to be reverted.
        let watch = !links.is_empty() || next["active"] != next["select"];
        self.links = links;
        self.config = Some(next);
        if watch {
            self.start();
        } else {
            self.stop();
        }
        if self.hyprland.is_some() {
            self.refresh_focus();
        }
        self.evaluate();
    }

    fn run(mut self, receiver: std::sync::mpsc::Receiver<Message>) {
        loop {
            let next = [self.settle_at, self.poll_at, self.focus_at, self.reconnect_at].into_iter().flatten().min();
            let message = match next {
                Some(at) => match receiver.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                },
                None => match receiver.recv() {
                    Ok(message) => Some(message),
                    Err(_) => return,
                },
            };
            match message {
                Some(Message::Configure(config, done)) => {
                    self.configure(config);
                    let _ = done.send(());
                }
                Some(Message::FocusChanged(id)) => {
                    if self.hyprland.as_ref().is_some_and(|(current, _)| *current == id) {
                        self.focus_at = Some(Instant::now() + FOCUS_DEBOUNCE);
                    }
                }
                Some(Message::HyprlandClosed(id)) => {
                    if self.hyprland.as_ref().is_some_and(|(current, _)| *current == id) {
                        self.hyprland = None;
                        self.reconnect_at = Some(Instant::now() + POLL);
                    }
                }
                None => {}
            }
            let now = Instant::now();
            let due = |at: Option<Instant>| at.is_some_and(|at| at <= now);
            if due(self.focus_at) {
                self.focus_at = None;
                self.refresh_focus();
                self.evaluate();
            }
            if due(self.reconnect_at) {
                self.reconnect_at = None;
                if self.poll_at.is_some() {
                    self.start();
                }
            }
            if due(self.poll_at) {
                self.poll_at = Some(now + POLL);
                if self.hyprland.is_some() {
                    self.refresh_focus();
                }
                self.evaluate();
            }
            if due(self.settle_at) {
                self.settle();
            }
        }
    }
}

fn sender() -> &'static Mutex<Option<Sender<Message>>> {
    static SENDER: Mutex<Option<Sender<Message>>> = Mutex::new(None);
    &SENDER
}

/// Starts the watcher. `on_switch` gets { index, reason, power } when another profile should run; it is called on
/// the watcher's thread, so it must not wait for configure().
pub fn init(on_switch: impl Fn(Value) + Send + 'static) {
    let (tx, receiver) = channel();
    let watcher = Watcher {
        notify: Box::new(on_switch),
        sender: tx.clone(),
        config: None,
        links: Vec::new(),
        last: None,
        pending: None,
        pending_app: None,
        settle_at: None,
        poll_at: None,
        focus_at: None,
        reconnect_at: None,
        focus: None,
        hyprland: None,
        connections: 0,
        procs: Procs::default(),
    };
    std::thread::spawn(move || watcher.run(receiver));
    *sender().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(tx);
}

/// Replaces what App Sync watches; returns once the new links are in place.
pub fn configure(config: Value) {
    let Some(tx) = sender().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() else { return };
    let (done, configured) = channel();
    if tx.send(Message::Configure(config, done)).is_ok() {
        let _ = configured.recv();
    }
}

#[cfg(test)]
mod tests {
    //! Matching checks on synthetic processes (no /proc, no Hyprland).
    use super::*;

    fn proc(exe: &str, argv: &[&str]) -> Proc {
        let comm: String = basename(exe).chars().take(15).collect();
        Proc { pid: 1000, ppid: 1, start: 1, comm, exe: exe.to_string(), argv: argv.iter().map(|a| a.to_string()).collect(), unit: String::new() }
    }
    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn interpreters_match_by_their_app_file() {
        let obsidian = Matcher {
            arg: Some("/usr/lib/obsidian/app.asar".into()),
            interpreter: Some("/usr/lib/electron43/electron".into()),
            names: vec!["obsidian".into()],
            ..Default::default()
        };
        let electron = "/usr/lib/electron43/electron";
        assert!(match_process(&obsidian, &proc(electron, &[electron, "/usr/lib/obsidian/app.asar"])));
        assert!(!match_process(&obsidian, &proc(electron, &[electron, "."])), "another app on the same electron");
    }

    #[test]
    fn executables_and_names() {
        let telegram = Matcher { exe: Some("/usr/bin/Telegram".into()), ..Default::default() };
        assert!(match_process(&telegram, &proc("/usr/bin/Telegram", &["telegram-desktop"])));
        assert!(!match_process(&telegram, &proc("/usr/bin/nautilus", &["nautilus"])));
        let discord = Matcher { names: vec!["discord".into()], ..Default::default() };
        let mut process = proc("/opt/discord/Discord", &["/opt/discord/Discord"]);
        process.comm = "Discord".into();
        assert!(match_process(&discord, &process));
        let python = Matcher { names: vec!["python3".into()], ..Default::default() };
        assert!(!match_process(&python, &proc("/usr/bin/python3", &["python3"])), "a generic process name never matches");
    }

    #[test]
    fn systemd_scopes() {
        let discord = Matcher { unit: Some("discord".into()), ..Default::default() };
        let scoped = |unit: &str| Proc { unit: unit.into(), ..proc("/x/y", &["y"]) };
        assert!(match_process(&discord, &scoped("app-discord-3518.scope")));
        assert!(!match_process(&discord, &scoped("app-discordia-1.scope")));
    }

    #[test]
    fn windows_games_match_by_exe_name() {
        let launcher = Matcher { windows_exe: Some("launcher.exe".into()), ..Default::default() };
        assert!(match_process(&launcher, &proc("/usr/bin/wine64-preloader", &["C:\\Games\\HoYo\\launcher.exe"])));
    }

    #[test]
    fn wrappers_are_stripped() {
        assert_eq!(strip_wrappers(&strings(&["env", "FOO=1", "mangohud", "java", "-jar", "/a.jar"])).join(" "), "java -jar /a.jar");
        assert_eq!(strip_wrappers(&strings(&["sh", "-c", "gamemoderun /usr/bin/game --x; echo done"])).join(" "), "/usr/bin/game --x");
    }

    #[test]
    fn launcher_scripts_are_read() {
        let script = "#!/bin/sh\nAPP=/opt/app\nexport NAME=\"tool\"\nexec \"$APP/bin/${NAME}\" --flag \"$@\" $UNKNOWN\n";
        assert_eq!(exec_line(script).unwrap(), ["/opt/app/bin/tool", "--flag", "$@"]);
        assert_eq!(url_host("https://Example.com:443/path?x#y"), "example.com");
        assert_eq!(url_host("http://localhost:3000/"), "localhost:3000");
    }
}
