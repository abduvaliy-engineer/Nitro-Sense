//! App Shortcut: the widget panel's launchers.
use super::desktop::{exec_args, icon_data_url, read_entry};
use super::util::spawn_detached;
use serde_json::{json, Value};

// One slot per role; the first installed desktop entry in each slot is shown.
const SLOTS: [&[&str]; 2] = [
    &["nvidia-settings.desktop"],
    &[
        "io.missioncenter.MissionCenter.desktop",
        "net.nokyan.Resources.desktop",
        "org.gnome.SystemMonitor.desktop",
        "gnome-system-monitor.desktop",
        "btop.desktop",
        "htop.desktop",
    ],
];

pub fn list() -> Value {
    let mut shortcuts = Vec::new();
    for slot in SLOTS {
        if let Some((id, entry)) = slot.iter().find_map(|id| Some((id, read_entry(id)?))) {
            shortcuts.push(json!({ "id": id, "name": entry.name, "icon": icon_data_url(entry.icon.as_deref()) }));
        }
    }
    json!(shortcuts)
}

pub fn launch(id: &str) -> Result<(), String> {
    if !SLOTS.iter().any(|slot| slot.contains(&id)) {
        return Err(format!("unknown shortcut: {id}"));
    }
    let entry = read_entry(id).ok_or_else(|| format!("{id} is not installed"))?;
    let mut command = exec_args(&entry.exec);
    if entry.terminal {
        command.insert(0, "xdg-terminal-exec".to_string());
    }
    if let Some((program, args)) = command.split_first() {
        spawn_detached(program, args);
    }
    Ok(())
}
