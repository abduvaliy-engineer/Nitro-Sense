//! Small JSON store for UI state (widget order, panel state, scenarios, ...): ~/.config/NitroSense/settings.json.
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

struct Store {
    file: PathBuf,
    data: Option<Map<String, Value>>,
}

fn store() -> MutexGuard<'static, Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| super::util::home().join(".config"));
            Mutex::new(Store { file: config.join("NitroSense/settings.json"), data: None })
        })
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn load(store: &mut Store) -> &mut Map<String, Value> {
    let file = &store.file;
    store.data.get_or_insert_with(|| {
        std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    })
}

/// None when the key was never set.
pub fn get(key: &str) -> Option<Value> {
    load(&mut store()).get(key).cloned()
}

pub fn set(key: &str, value: Value) -> Result<(), String> {
    let mut store = store();
    load(&mut store).insert(key.to_string(), value);
    let json = serde_json::to_string_pretty(&store.data).map_err(|error| error.to_string())?;
    let failed = |error: std::io::Error| format!("Saving settings failed: {error}");
    if let Some(dir) = store.file.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let temporary = store.file.with_extension("json.tmp");
    std::fs::write(&temporary, json).map_err(failed)?;
    std::fs::rename(&temporary, &store.file).map_err(failed)
}
