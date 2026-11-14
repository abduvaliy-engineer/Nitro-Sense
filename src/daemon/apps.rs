//! Apps that can be linked to a scenario profile (NitroSense's "Add Apps to Link" list): desktop entries,
//! installed Steam games and files the user picked. A linked app is stored as a small reference:
//!   { key, kind: "desktop" | "steam" | "file", name, desktopId? , steamAppId?, path? }
use super::desktop::{all_entries, exec_args, field, icon_data_url, installed_ms, read_entry, refresh_icons, Entry, Item};
use super::settings;
use super::util::{basename, exists, home, on_path, parse_int};
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const USER_APPS_KEY: &str = "appSync.userApps";
const OWN_ENTRIES: [&str; 1] = ["nitrosense.desktop"];

fn steam_roots() -> [PathBuf; 3] {
    let home = home();
    [
        home.join(".local/share/Steam"),
        home.join(".steam/steam"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    ]
}

// Steam installs these like games; they are runtimes, not apps.
fn is_steam_tool(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["proton", "steam linux runtime", "steamworks common redistributables"].iter().any(|tool| lower.starts_with(tool))
}

fn desktop_ref(id: &str, name: &str) -> Value {
    json!({ "key": format!("desktop:{id}"), "kind": "desktop", "name": name, "desktopId": id })
}
fn steam_ref(appid: &str, name: &str) -> Value {
    json!({ "key": format!("steam:{appid}"), "kind": "steam", "name": name, "steamAppId": appid.parse::<i64>().unwrap_or(0) })
}
fn file_ref(file: &str) -> Value {
    let name = Regex::new(r"(?i)\.(exe|appimage)$").unwrap().replace(basename(file), "").into_owned();
    json!({ "key": format!("file:{file}"), "kind": "file", "name": name, "path": file })
}

fn program_exists(program: &str) -> bool {
    if program.contains('/') { exists(program) } else { on_path(program, libc::F_OK).is_some() }
}

fn listed(value: Option<&String>) -> Vec<&str> {
    value.map(|value| value.split(';').filter(|item| !item.is_empty()).collect()).unwrap_or_default()
}

pub fn is_game(entry: &Entry) -> bool {
    entry.get("Categories").is_some_and(|categories| categories.split(';').any(|category| category == "Game"))
}

/// The entries a launcher would show (NitroSense lists the Start menu the same way).
pub fn launcher_entries() -> Vec<Item> {
    let desktops = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let current: Vec<&str> = desktops.split(':').filter(|desktop| !desktop.is_empty()).collect();
    let is = |entry: &Entry, key: &str| entry.get(key).is_some_and(|value| value == "true");
    all_entries()
        .into_iter()
        .filter(|item| {
            let entry = &item.entry;
            if field(entry, "Type").is_some_and(|kind| kind != "Application") || field(entry, "Exec").is_none() {
                return false;
            }
            if is(entry, "NoDisplay") || is(entry, "Hidden") || OWN_ENTRIES.contains(&item.id.as_str()) {
                return false;
            }
            let only = listed(entry.get("OnlyShowIn"));
            if !only.is_empty() && !only.iter().any(|desktop| current.contains(desktop)) {
                return false;
            }
            if listed(entry.get("NotShowIn")).iter().any(|desktop| current.contains(desktop)) {
                return false;
            }
            !field(entry, "TryExec").is_some_and(|program| !program_exists(program))
        })
        .collect()
}

// ---------- Steam ----------

fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let pattern = format!(r#""{}"\s+"((?:[^"\\]|\\.)*)""#, regex::escape(key));
    Regex::new(&pattern).unwrap().captures_iter(text).map(|found| found[1].replace(r"\\", r"\")).collect()
}

pub struct SteamGame {
    pub appid: String,
    pub name: String,
    root: PathBuf,
    installed: f64,
}

pub fn steam_games() -> Vec<SteamGame> {
    let mut games: Vec<SteamGame> = Vec::new();
    for root in steam_roots() {
        let folders = std::fs::read_to_string(root.join("steamapps/libraryfolders.vdf")).unwrap_or_default();
        let mut libraries = vec![root.clone()];
        for library in vdf_values(&folders, "path").into_iter().map(PathBuf::from) {
            if !libraries.contains(&library) {
                libraries.push(library);
            }
        }
        for library in libraries {
            let dir = library.join("steamapps");
            for name in super::util::entries(&dir) {
                let manifest = name.strip_prefix("appmanifest_").and_then(|rest| rest.strip_suffix(".acf"));
                if !manifest.is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) {
                    continue;
                }
                let text = std::fs::read(dir.join(&name)).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
                let first = |key: &str| vdf_values(&text, key).into_iter().next().filter(|value| !value.is_empty());
                let (Some(appid), Some(name)) = (first("appid"), first("name")) else { continue };
                if is_steam_tool(&name) || games.iter().any(|game| game.appid == appid) {
                    continue;
                }
                let updated = first("LastUpdated").and_then(|value| value.trim().parse::<f64>().ok()).unwrap_or(0.0);
                games.push(SteamGame { appid, name, root: root.clone(), installed: updated * 1000.0 });
            }
        }
    }
    games
}

fn steam_icon(game: &SteamGame) -> Option<String> {
    let cache = game.root.join("appcache/librarycache").join(&game.appid);
    let is_icon = |file: &str| {
        file.strip_suffix(".jpg").is_some_and(|hash| hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    };
    let icon = super::util::entries(&cache).into_iter().find(|file| is_icon(file));
    match icon {
        Some(icon) => icon_data_url(cache.join(icon).to_str()),
        None => icon_data_url(Some(&format!("steam_icon_{}", game.appid))),
    }
}

/// The Steam app a desktop entry's Exec line starts.
pub fn steam_launch(exec: &str) -> Option<String> {
    let rest = &exec[exec.find("steam://rungameid/")? + "steam://rungameid/".len()..];
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0).then(|| rest[..digits].to_string())
}

// ---------- list / resolve / pick ----------

fn user_apps() -> Vec<Value> {
    settings::get(USER_APPS_KEY).and_then(|apps| apps.as_array().cloned()).unwrap_or_default()
}

/// Everything the Add Apps dialog offers: { ...ref, icon, game, installed }.
pub fn list() -> Value {
    let mut items: Vec<Value> = Vec::new();
    let has = |items: &[Value], key: &Value| items.iter().any(|item| item["key"] == *key);
    let add = |items: &mut Vec<Value>, mut item: Value, game: bool, installed: f64, icon: Option<String>| {
        item["game"] = json!(game);
        item["installed"] = json!(installed);
        item["icon"] = json!(icon);
        items.push(item);
    };
    for game in steam_games() {
        add(&mut items, steam_ref(&game.appid, &game.name), true, game.installed, steam_icon(&game));
    }
    for item in launcher_entries() {
        let entry = &item.entry;
        let exec = field(entry, "Exec").unwrap_or("");
        let appid = steam_launch(exec);
        let name = field(entry, "Name").unwrap_or(&item.id);
        let reference = match &appid {
            Some(appid) => steam_ref(appid, name),
            None => desktop_ref(&item.id, name),
        };
        if has(&items, &reference["key"]) {
            continue;
        }
        let icon = icon_data_url(entry.get("Icon").map(String::as_str));
        add(&mut items, reference, is_game(entry) || appid.is_some(), item.installed, icon);
    }
    for reference in user_apps() {
        let Some(path) = reference["path"].as_str() else { continue };
        if has(&items, &reference["key"]) || !exists(path) {
            continue;
        }
        let installed = installed_ms(Path::new(path));
        add(&mut items, reference.clone(), false, installed, None);
    }
    json!(items)
}

/// Name, icon and whether a linked app still exists (NitroSense's "File Path Missing").
pub fn resolve(refs: &Value) -> Value {
    let refs = refs.as_array().map(Vec::as_slice).unwrap_or_default();
    let games = if refs.iter().any(|r| r["kind"] == "steam") { steam_games() } else { Vec::new() };
    let resolved: Vec<Value> = refs
        .iter()
        .map(|reference| {
            let key = &reference["key"];
            let stored_name = &reference["name"];
            match reference["kind"].as_str() {
                Some("desktop") => {
                    let id = reference["desktopId"].as_str().unwrap_or("");
                    let found = read_entry(id);
                    json!({
                        "key": key,
                        "name": found.as_ref().map(|found| json!(found.name)).unwrap_or_else(|| stored_name.clone()),
                        "icon": found.as_ref().and_then(|found| icon_data_url(found.icon.as_deref())),
                        "missing": found.is_none(),
                        "source": id,
                    })
                }
                Some("steam") => {
                    let appid = reference["steamAppId"].as_i64();
                    let is_app = |id: &str| appid.is_some() && parse_int(id) == appid;
                    let game = games.iter().find(|game| is_app(&game.appid));
                    let entry = if game.is_some() {
                        None
                    } else {
                        launcher_entries().into_iter().find(|item| {
                            field(&item.entry, "Exec").and_then(steam_launch).is_some_and(|id| is_app(&id))
                        })
                    };
                    let entry_name = entry.as_ref().and_then(|item| field(&item.entry, "Name"));
                    let name = game.map(|game| json!(game.name)).or_else(|| entry_name.map(|name| json!(name)));
                    let icon = match (game, &entry) {
                        (Some(game), _) => steam_icon(game),
                        (None, Some(item)) => icon_data_url(item.entry.get("Icon").map(String::as_str)),
                        (None, None) => None,
                    };
                    json!({
                        "key": key,
                        "name": name.unwrap_or_else(|| stored_name.clone()),
                        "icon": icon,
                        "missing": game.is_none() && entry.is_none(),
                        "source": format!("steam://rungameid/{}", reference["steamAppId"]),
                    })
                }
                _ => {
                    let path = reference["path"].as_str().unwrap_or("");
                    json!({ "key": key, "name": stored_name, "icon": null, "missing": !exists(path), "source": path })
                }
            }
        })
        .collect();
    json!(resolved)
}

/// "Cannot find app?": an executable, AppImage or Windows .exe the list doesn't have. `picked` is the file the
/// window's file dialog returned (None when it was cancelled).
pub fn pick_file(picked: Option<&str>, app_dir: &Path) -> Result<Value, String> {
    let Some(picked) = picked.filter(|path| !path.is_empty()) else { return Ok(Value::Null) };
    let real = std::fs::canonicalize(picked).map_err(|error| format!("Can't open {picked}: {error}"))?;
    let file = real.to_string_lossy().into_owned();
    let already = json!({ "exists": true });
    // NitroSense itself can't be linked.
    let own = std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok());
    let own_dir = own.as_deref().and_then(Path::parent);
    if real.starts_with(app_dir) || own_dir.is_some_and(|dir| real == dir.join("nitrosense") || real == dir.join("nitrosense-ui")) {
        return Ok(already);
    }
    let known = list();
    let known = known.as_array().map(Vec::as_slice).unwrap_or_default();
    if known.iter().any(|item| item["key"] == format!("file:{file}")) {
        return Ok(already);
    }
    for item in known.iter().filter(|item| item["kind"] == "desktop") {
        let found = item["desktopId"].as_str().and_then(read_entry);
        let Some(program) = found.and_then(|found| exec_args(&found.exec).into_iter().next()) else { continue };
        let resolved = std::fs::canonicalize(&program).map(|path| path.to_string_lossy().into_owned()).unwrap_or(program);
        if resolved == file {
            return Ok(already);
        }
    }
    let reference = file_ref(&file);
    let mut apps = user_apps();
    apps.push(reference.clone());
    settings::set(USER_APPS_KEY, json!(apps))?;
    Ok(json!({ "ref": reference }))
}

pub fn refresh() {
    refresh_icons();
}
