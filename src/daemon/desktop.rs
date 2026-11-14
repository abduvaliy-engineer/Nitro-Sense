//! Desktop entries (.desktop files) and their icons, shared by App Shortcut and App Sync.
use super::util::home;
use base64::Engine;
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub type Entry = HashMap<String, String>;

pub fn data_dirs() -> &'static [PathBuf] {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let home = home();
        let mut dirs = vec![env("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"))];
        let system = env("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
        dirs.extend(system.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from));
        dirs.push(home.join(".local/share/flatpak/exports/share"));
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
        dirs.push(PathBuf::from("/var/lib/snapd/desktop"));
        dirs
    })
}

/// The [Desktop Entry] group's keys; localized keys (Name[fr]) are skipped.
pub fn parse_entry(text: &str) -> Entry {
    let mut entry = Entry::new();
    let mut in_main = false;
    for line in text.split('\n') {
        if line.starts_with('[') {
            in_main = line.trim() == "[Desktop Entry]";
        } else if in_main {
            if let Some((key, value)) = line.split_once('=') {
                let name = key.trim();
                if !name.contains('[') && !entry.contains_key(name) {
                    entry.insert(name.to_string(), value.trim().to_string());
                }
            }
        }
    }
    entry
}

/// A non-empty key of an entry.
pub fn field<'a>(entry: &'a Entry, key: &str) -> Option<&'a str> {
    entry.get(key).map(String::as_str).filter(|value| !value.is_empty())
}

#[derive(Clone)]
pub struct Described {
    pub entry: Entry,
    pub name: String,
    pub icon: Option<String>,
    pub exec: String,
    pub terminal: bool,
}

fn described(id: &str, entry: Entry) -> Option<Described> {
    if entry.get("Hidden").is_some_and(|hidden| hidden == "true") {
        return None;
    }
    let exec = field(&entry, "Exec")?.to_string();
    Some(Described {
        name: field(&entry, "Name").unwrap_or(id).to_string(),
        icon: entry.get("Icon").cloned(),
        terminal: entry.get("Terminal").is_some_and(|terminal| terminal == "true"),
        exec,
        entry,
    })
}

pub fn read_entry(id: &str) -> Option<Described> {
    for dir in data_dirs() {
        if let Ok(bytes) = std::fs::read(dir.join("applications").join(id)) {
            return described(id, parse_entry(&String::from_utf8_lossy(&bytes)));
        }
    }
    // Entries in subdirectories: "wine-Programs-X.desktop" is wine/Programs/X.desktop.
    let found = all_entries().into_iter().find(|item| item.id == id)?;
    described(id, found.entry)
}

pub struct Item {
    pub id: String,
    pub entry: Entry,
    /// When the file appeared (creation time, else last change), in milliseconds.
    pub installed: f64,
}

/// A file's creation time, else its last change, in milliseconds since 1970; 0 when unknown.
pub fn installed_ms(file: &Path) -> f64 {
    let Ok(meta) = std::fs::metadata(file) else { return 0.0 };
    let ms = |time: std::io::Result<std::time::SystemTime>| {
        time.ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0)
    };
    ms(meta.created()).filter(|&created| created != 0.0).or_else(|| ms(meta.modified())).unwrap_or(0.0)
}

/// Every desktop entry, keyed by desktop-file ID (subdirectories join with "-"); the first data dir wins.
pub fn all_entries() -> Vec<Item> {
    fn walk(base: &Path, dir: &Path, found: &mut Vec<Item>) {
        let Ok(items) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<_> = items.flatten().collect();
        items.sort_by_key(|item| item.file_name());
        for item in items {
            let full = item.path();
            let name = item.file_name().to_string_lossy().into_owned();
            if item.file_type().is_ok_and(|kind| kind.is_dir()) {
                walk(base, &full, found);
            } else if name.ends_with(".desktop") {
                let Ok(relative) = full.strip_prefix(base) else { continue };
                let id = relative.to_string_lossy().replace('/', "-");
                if found.iter().any(|known| known.id == id) {
                    continue;
                }
                // An unreadable entry is skipped.
                if let Ok(bytes) = std::fs::read(&full) {
                    let entry = parse_entry(&String::from_utf8_lossy(&bytes));
                    found.push(Item { id, entry, installed: installed_ms(&full) });
                }
            }
        }
    }
    let mut found = Vec::new();
    for dir in data_dirs() {
        let applications = dir.join("applications");
        walk(&applications, &applications, &mut found);
    }
    found
}

/// Drop desktop-entry field codes and split the Exec line like a shell would (quotes only).
pub fn exec_args(exec: &str) -> Vec<String> {
    static PARTS: OnceLock<Regex> = OnceLock::new();
    let parts = PARTS.get_or_init(|| Regex::new(r#""((?:[^"\\]|\\.)*)"|(\S+)"#).unwrap());
    let mut args = Vec::new();
    for found in parts.captures_iter(exec) {
        let arg = match found.get(1) {
            Some(quoted) => unescape(quoted.as_str()),
            None => found[2].to_string(),
        };
        let code = arg.len() == 2 && arg.starts_with('%') && "fFuUdDnNickvm".contains(&arg[1..]);
        if !code {
            args.push(arg);
        }
    }
    args
}

// \x → x
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.extend(chars.next().or(Some('\\'))),
            _ => out.push(c),
        }
    }
    out
}

// ---------- icons ----------

fn entries(dir: &Path) -> Vec<String> {
    super::util::entries(dir)
}

fn icon_theme() -> Option<String> {
    let name = Regex::new(r"(?m)^gtk-icon-theme-name\s*=\s*(.+)$").unwrap();
    [".config/gtk-4.0/settings.ini", ".config/gtk-3.0/settings.ini"].iter().find_map(|file| {
        let text = std::fs::read_to_string(home().join(file)).ok()?;
        let theme = name.captures(&text)?[1].trim().to_string();
        (!theme.is_empty()).then_some(theme)
    })
}

// Icon name → best file, from the user's theme, the themes it inherits, hicolor and Adwaita (largest first).
fn build_icon_index() -> HashMap<String, PathBuf> {
    let mut index = HashMap::new();
    let mut themes: Vec<String> = Vec::new();
    let mut queue: Vec<String> = icon_theme().into_iter().chain(["hicolor".to_string(), "Adwaita".to_string()]).collect();
    let inherits = Regex::new(r"(?m)^Inherits\s*=\s*(.+)$").unwrap();
    while !queue.is_empty() {
        let theme = queue.remove(0);
        if themes.contains(&theme) {
            continue;
        }
        for dir in data_dirs() {
            let text = std::fs::read_to_string(dir.join("icons").join(&theme).join("index.theme")).unwrap_or_default();
            if let Some(found) = inherits.captures(&text) {
                // Inherited themes go before the two fallbacks at the end.
                let at = queue.len().saturating_sub(2);
                let parents: Vec<String> = found[1].split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
                queue.splice(at..at, parents);
            }
        }
        themes.push(theme);
    }
    let rank = |size: &str| -> i64 {
        if size == "scalable" {
            return 10000;
        }
        super::util::parse_int(size).unwrap_or(0) * if size.contains("@2x") { 2 } else { 1 }
    };
    let image = Regex::new(r"^(.+)\.(svg|png)$").unwrap();
    for theme in &themes {
        let mut dirs: Vec<PathBuf> = data_dirs().iter().map(|dir| dir.join("icons").join(theme)).collect();
        dirs.push(home().join(".icons").join(theme));
        for dir in dirs {
            let mut sizes: Vec<String> = entries(&dir).into_iter().filter(|size| rank(size) >= 32).collect();
            sizes.sort_by_key(|size| std::cmp::Reverse(rank(size)));
            for size in sizes {
                for context in entries(&dir.join(&size)) {
                    for file in entries(&dir.join(&size).join(&context)) {
                        if let Some(found) = image.captures(&file) {
                            index.entry(found[1].to_string()).or_insert_with(|| dir.join(&size).join(&context).join(&file));
                        }
                    }
                }
            }
        }
    }
    for file in entries(Path::new("/usr/share/pixmaps")) {
        if let Some(found) = image.captures(&file) {
            index.entry(found[1].to_string()).or_insert_with(|| Path::new("/usr/share/pixmaps").join(&file));
        }
    }
    index
}

#[derive(Default)]
struct Icons {
    index: Option<Arc<HashMap<String, PathBuf>>>,
    cache: HashMap<String, Option<String>>,
}

fn icons() -> &'static Mutex<Icons> {
    static ICONS: OnceLock<Mutex<Icons>> = OnceLock::new();
    ICONS.get_or_init(Default::default)
}

/// An icon name or file path as a data: URL the window can show.
pub fn icon_data_url(icon: Option<&str>) -> Option<String> {
    let icon = icon.filter(|icon| !icon.is_empty())?;
    let mut icons = icons().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = icons.cache.get(icon) {
        return cached.clone();
    }
    let file = if icon.starts_with('/') {
        Some(PathBuf::from(icon))
    } else {
        icons.index.get_or_insert_with(|| Arc::new(build_icon_index())).get(icon).cloned()
    };
    let url = file.and_then(|file| {
        let kind = match file.extension()?.to_str()?.to_lowercase().as_str() {
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            _ => return None,
        };
        let bytes = std::fs::read(&file).ok()?;
        Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    });
    icons.cache.insert(icon.to_string(), url.clone());
    url
}

pub fn refresh_icons() {
    *icons().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Icons::default();
}
