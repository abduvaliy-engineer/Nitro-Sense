//! The background part: the hardware backend, App Sync, the mode-change keyboard flash, and the socket the window
//! talks to. One JSON object per line in both directions:
//!   window → here   { id, cmd, args }                       a call
//!   here → window   { id, ok: true, result } / { id, ok: false, error }
//!   here → window   { event, payload }                      sensors:changed, appsync:switch, updates:progress
//!   here → window   { control: "show" | "quit" }
pub mod apps;
pub mod appsync;
pub mod controls;
pub mod desktop;
pub mod lighting;
pub mod package_update;
pub mod scenario;
pub mod sensors;
pub mod settings;
pub mod shortcuts;
pub mod system;
pub mod updates;
pub mod util;

use crate::common;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

type Writer = Arc<Mutex<UnixStream>>;

enum Ui {
    Closed,
    /// nitrosense-ui was started and hasn't connected yet.
    Starting,
    /// `listening`: its page has loaded the profiles, so it handles App Sync's switches.
    Open { writer: Writer, listening: bool },
}

struct Daemon {
    ui: Mutex<Ui>,
    /// An App Sync switch that arrived while the window was starting.
    waiting_switch: Mutex<Option<Value>>,
    app_dir: PathBuf,
    /// nitrosense-ui, next to this program. Found at start: once an update replaces this program's file, its own
    /// path reads "<path> (deleted)".
    ui_program: Option<PathBuf>,
    /// The update being installed ({ version, stage }), for a window opened during it.
    update: Mutex<Option<Value>>,
    dev: bool,
}

static DAEMON: OnceLock<Daemon> = OnceLock::new();

fn daemon() -> &'static Daemon {
    DAEMON.get().expect("the background part is running")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn send_line(writer: &Writer, message: &Value) -> bool {
    writeln!(lock(writer), "{message}").is_ok()
}

fn window_closed() -> bool {
    matches!(&*lock(&daemon().ui), Ui::Closed)
}

fn ui_writer() -> Option<Writer> {
    match &*lock(&daemon().ui) {
        Ui::Open { writer, .. } => Some(writer.clone()),
        _ => None,
    }
}

fn emit(event: &str, payload: Value) {
    if let Some(writer) = ui_writer() {
        send_line(&writer, &json!({ "event": event, "payload": payload }));
    }
}

/// A desktop notification (org.freedesktop.Notifications over the session bus).
pub fn notify(title: &str, body: &str) {
    use gio::glib::{prelude::*, Variant};
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else { return };
    let mut hints = std::collections::HashMap::<&str, Variant>::new();
    hints.insert("desktop-entry", "nitrosense".to_variant());
    // NitroSense's logo, when Acer's artwork is installed. Notification services that know the desktop entry show
    // its icon in place of the app icon, so the logo also goes as the notification's image.
    let logo = daemon().app_dir.join("assets/acer/home_headerlogo.svg");
    let icon = if logo.is_file() { logo.to_string_lossy().into_owned() } else { String::new() };
    if !icon.is_empty() {
        hints.insert("image-path", format!("file://{}", icon.replace('%', "%25").replace(' ', "%20")).to_variant());
    }
    let parameters = ("NitroSense", 0u32, icon.as_str(), title, body, Vec::<String>::new(), hints, -1i32).to_variant();
    let sent = bus.call_sync(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        Some(&parameters),
        None,
        gio::DBusCallFlags::NONE,
        5000,
        gio::Cancellable::NONE,
    );
    if let Err(error) = sent {
        eprintln!("notification failed: {error}");
    }
}

// ---------- the window ----------

fn start_ui() {
    let daemon = daemon();
    let Some(program) = &daemon.ui_program else {
        eprintln!("nitrosense: can't find nitrosense-ui");
        return;
    };
    let mut command = std::process::Command::new(program);
    command.env("NITROSENSE_SOCKET", common::socket_path()).env("NITROSENSE_APP_DIR", &daemon.app_dir);
    if daemon.dev {
        command.arg("--dev");
    }
    match command.spawn() {
        Ok(mut child) => {
            *lock(&daemon.ui) = Ui::Starting;
            std::thread::spawn(move || {
                let _ = child.wait();
                ui_closed(None);
            });
        }
        Err(error) => eprintln!("nitrosense: can't start {}: {error}", program.display()),
    }
}

/// Shows the window: opens it, or brings the open one to the front.
fn show() {
    let state = lock(&daemon().ui);
    match &*state {
        Ui::Closed => {
            drop(state);
            start_ui();
        }
        Ui::Starting => {}
        Ui::Open { writer, .. } => {
            send_line(writer, &json!({ "control": "show" }));
        }
    }
}

// The window is gone (`writer`: that connection closed; None: its process ended). From here on the profiles are
// applied here: App Sync follows the stored ones, and a switch the window never got is made now.
fn ui_closed(writer: Option<&Writer>) {
    let daemon = daemon();
    {
        let mut state = lock(&daemon.ui);
        let gone = match (&*state, writer) {
            (Ui::Closed, _) => false,
            (Ui::Open { writer: open, .. }, Some(closed)) => Arc::ptr_eq(open, closed),
            // The process ended: an open connection reports its own end.
            (Ui::Open { .. }, None) => false,
            (Ui::Starting, _) => true,
        };
        if !gone {
            return;
        }
        *state = Ui::Closed;
    }
    scenario::watch_apps();
    // Taken first: applying the switch configures App Sync, which waits for App Sync's thread, and that thread
    // takes this lock in on_switch.
    let change = lock(&daemon.waiting_switch).take();
    if let Some(change) = change {
        scenario::switch(&change);
    }
}

// App Sync wants another profile: the window applies it when it is open, otherwise it is applied here.
fn on_switch(change: Value) {
    let daemon = daemon();
    let state = lock(&daemon.ui);
    match &*state {
        Ui::Open { writer, listening: true } => {
            send_line(writer, &json!({ "event": "appsync:switch", "payload": change }));
        }
        Ui::Open { .. } | Ui::Starting => *lock(&daemon.waiting_switch) = Some(change),
        Ui::Closed => {
            drop(state);
            // Not on App Sync's own thread: applying the profile configures App Sync again.
            std::thread::spawn(move || scenario::switch(&change));
        }
    }
}

fn quit() -> ! {
    if let Some(writer) = ui_writer() {
        send_line(&writer, &json!({ "control": "quit" }));
    }
    let _ = std::fs::remove_file(common::socket_path());
    std::process::exit(0);
}

// After an update: start the new version in this one's place, with its window showing (the user asked for the
// update, so it must not start hidden).
fn relaunch() -> ! {
    use std::os::unix::process::CommandExt;
    if let Some(writer) = ui_writer() {
        send_line(&writer, &json!({ "control": "quit" }));
    }
    std::thread::sleep(Duration::from_millis(300));
    let _ = std::fs::remove_file(common::socket_path());
    let mut args = std::env::args();
    let program = args.next().unwrap_or_else(|| "nitrosense".to_string());
    let error = std::process::Command::new(program).args(args.filter(|arg| arg != "--hidden")).exec();
    eprintln!("nitrosense: restarting failed: {error}");
    std::process::exit(1);
}

// ---------- calls from the window ----------

fn text(args: &[Value], index: usize) -> String {
    match args.get(index) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

// JavaScript's Number(value) for what the window sends.
fn number(args: &[Value], index: usize) -> f64 {
    match args.get(index) {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) if text.trim().is_empty() => 0.0,
        Some(Value::String(text)) => text.trim().parse().unwrap_or(f64::NAN),
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

fn truthy(args: &[Value], index: usize) -> bool {
    match args.get(index) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

/// One call. Ok(None) is JavaScript's undefined.
fn handle(cmd: &str, args: &[Value]) -> Result<Option<Value>, String> {
    let daemon = daemon();
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    let done = |result: Result<(), String>| result.map(|()| None);
    match cmd {
        "sensors:snapshot" => Ok(Some(sensors::snapshot())),
        "system:info" => Ok(Some(system::info())),
        "settings:get" => Ok(settings::get(&text(args, 0))),
        "settings:set" => done(settings::set(&text(args, 0), arg(1))),
        "updates:check" => updates::check(common::VERSION).map(Some),
        "updates:version" => Ok(Some(json!(common::VERSION))),
        "updates:checkout" => Ok(Some(json!(updates::is_checkout(&daemon.app_dir)))),
        "updates:packaged" => Ok(Some(json!(updates::packaged(&daemon.app_dir)))),
        "updates:status" => Ok(lock(&daemon.update).clone()),
        // One at a time: a window opened during an update follows it instead of starting another.
        "updates:install" => {
            let version = text(args, 0);
            {
                let mut update = lock(&daemon.update);
                if update.is_some() {
                    return Err("An update is already being installed".to_string());
                }
                *update = Some(json!({ "version": version, "stage": "downloading" }));
            }
            let progress = |stage: &str| {
                if let Some(update) = &mut *lock(&daemon.update) {
                    update["stage"] = json!(stage);
                }
                emit("updates:progress", json!(stage));
            };
            let result = updates::install(&version, &daemon.app_dir, &progress);
            match &result {
                // Kept until the restart.
                Ok(result) if result["installed"] == true => {
                    // Long enough for the "finished" dialog to be read.
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_millis(2500));
                        relaunch();
                    });
                }
                Ok(_) => *lock(&daemon.update) = None,
                Err(_) => {
                    *lock(&daemon.update) = None;
                    emit("updates:progress", json!("failed"));
                }
            }
            result.map(Some)
        }
        "updates:open" => {
            let url = text(args, 0);
            let url = if updates::is_release_url(&url) { url } else { updates::releases() };
            util::spawn_detached("xdg-open", &[url]);
            Ok(None)
        }
        "shortcuts:list" => Ok(Some(shortcuts::list())),
        "shortcuts:launch" => done(shortcuts::launch(&text(args, 0))),
        "controls:setProfile" => done(controls::set_profile(&text(args, 0))),
        "controls:setFanSpeed" => done(controls::set_fan_speed(number(args, 0), number(args, 1))),
        "controls:setModeKeyCycle" => done(controls::set_mode_key_cycle(truthy(args, 0))),
        "personal:read" => Ok(Some(controls::read_personal())),
        "personal:set" => done(controls::set_personal(&text(args, 0), number(args, 1))),
        "personal:applyGpuMode" => {
            controls::set_gpu_mode(number(args, 0))?;
            done(system::restart())
        }
        "lighting:info" => Ok(Some(lighting::info())),
        "lighting:apply" => done(lighting::apply(arg(0))),
        "lighting:restore" => done(lighting::restore(arg(0))),
        "lighting:pickColor" => Ok(Some(lighting::pick_color())),
        "apps:list" => Ok(Some(apps::list())),
        "apps:resolve" => Ok(Some(apps::resolve(&arg(0)))),
        // The window shows the file dialog and passes the picked file on.
        "apps:pickFile" => apps::pick_file(args.first().and_then(Value::as_str), &daemon.app_dir).map(Some),
        "apps:refresh" => {
            apps::refresh();
            Ok(None)
        }
        "appsync:configure" => {
            appsync::configure(arg(0));
            // The page has its profiles now: from here on it applies App Sync's switches itself.
            let writer = match &mut *lock(&daemon.ui) {
                Ui::Open { writer, listening } => {
                    *listening = true;
                    Some(writer.clone())
                }
                _ => None,
            };
            let change = lock(&daemon.waiting_switch).take();
            if let (Some(writer), Some(change)) = (writer, change) {
                send_line(&writer, &json!({ "event": "appsync:switch", "payload": change }));
            }
            Ok(None)
        }
        "notify" => {
            notify(&text(args, 0), &text(args, 1));
            Ok(None)
        }
        _ => Err(format!("Unknown call: {cmd}")),
    }
}

fn serve_ui(stream: UnixStream, reader: BufReader<UnixStream>) {
    let daemon = daemon();
    let writer: Writer = Arc::new(Mutex::new(stream));
    {
        let mut state = lock(&daemon.ui);
        if let Ui::Open { writer: open, .. } = &*state {
            // One window only: the open one comes to the front and this one goes away.
            send_line(open, &json!({ "control": "show" }));
            send_line(&writer, &json!({ "control": "quit" }));
            return;
        }
        *state = Ui::Open { writer: writer.clone(), listening: false };
    }
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(call) = serde_json::from_str::<Value>(&line) else { continue };
        let writer = writer.clone();
        std::thread::spawn(move || {
            let cmd = call["cmd"].as_str().unwrap_or("");
            let args = call["args"].as_array().cloned().unwrap_or_default();
            let reply = match handle(cmd, &args) {
                Ok(Some(result)) => json!({ "id": call["id"], "ok": true, "result": result }),
                Ok(None) => json!({ "id": call["id"], "ok": true }),
                Err(error) => json!({ "id": call["id"], "ok": false, "error": error }),
            };
            if !call["id"].is_null() {
                send_line(&writer, &reply);
            }
        });
    }
    ui_closed(Some(&writer));
}

fn serve(stream: UnixStream) {
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut hello = String::new();
    if reader.read_line(&mut hello).is_err() {
        return;
    }
    let hello: Value = serde_json::from_str(&hello).unwrap_or(Value::Null);
    match hello["hello"].as_str() {
        Some("ui") => serve_ui(stream, reader),
        Some("cli") => {
            let mut stream = stream;
            let _ = writeln!(stream, "ok");
            match hello["cmd"].as_str() {
                Some("quit") => quit(),
                Some("show") => show(),
                _ => {}
            }
        }
        _ => {}
    }
}

// ---------- power mode changes ----------

// The kernel notifies platform_profile changes (sysfs_notify → inotify) within milliseconds, so the window
// refreshes at once and the keyboard flashes the new mode's color. Rewriting the same mode notifies too.
fn watch_platform_profile() {
    let read_profile = || util::read(sensors::PLATFORM_PROFILE).filter(|profile| !profile.is_empty());
    let path = std::ffi::CString::new(sensors::PLATFORM_PROFILE).expect("a path without NUL");
    let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC) };
    if fd < 0 || unsafe { libc::inotify_add_watch(fd, path.as_ptr(), libc::IN_MODIFY | libc::IN_ATTRIB) } < 0 {
        eprintln!("platform_profile watch unavailable: {}", std::io::Error::last_os_error());
        return;
    }
    std::thread::spawn(move || {
        let mut last = read_profile();
        let mut buffer = [0u8; 4096];
        loop {
            if unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) } <= 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return;
            }
            loop {
                let profile = read_profile();
                if let (Some(profile), Some(last)) = (&profile, &last) {
                    if profile != last {
                        lighting::flash(profile);
                    }
                }
                if profile.is_some() {
                    last = profile;
                }
                // The window hears about it once the changes have been quiet for 30 ms.
                let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                if unsafe { libc::poll(&mut poll, 1, 30) } <= 0 {
                    break;
                }
                if unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) } <= 0 {
                    break;
                }
            }
            emit("sensors:changed", Value::Null);
        }
    });
}

// ---------- start ----------

/// Held for as long as the background part runs, so two copies started together don't both become it.
pub fn single_instance_lock() -> Option<std::fs::File> {
    let mut path = common::socket_path().into_os_string();
    path.push(".lock");
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path).ok()?;
    (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0).then_some(file)
}

pub fn run(_lock: std::fs::File, hidden: bool, dev: bool) {
    let socket = common::socket_path();
    // Nothing answered there (main tried), so a socket file is a leftover.
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("nitrosense: can't listen on {}: {error}", socket.display());
            std::process::exit(1);
        }
    };
    let ui_program = std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok()).and_then(|exe| Some(exe.parent()?.join("nitrosense-ui")));
    let state = Daemon {
        ui: Mutex::new(Ui::Closed),
        waiting_switch: Mutex::new(None),
        app_dir: common::app_dir(),
        ui_program,
        update: Mutex::new(None),
        dev,
    };
    if DAEMON.set(state).is_err() {
        return;
    }
    appsync::init(on_switch);
    watch_platform_profile();
    scenario::follow_power(window_closed);
    std::thread::spawn(|| {
        scenario::restore_lighting();
        scenario::watch_apps();
    });
    if !hidden {
        start_ui();
    }
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || serve(stream));
    }
}
