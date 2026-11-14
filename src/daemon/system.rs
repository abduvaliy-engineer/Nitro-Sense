//! The laptop itself: model, BIOS, battery health, and whether the driver and keyboard can be used.
use super::util::{entries, accessible, exists, js_round, parse_int, read, run, RunError};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const DMI: &str = "/sys/class/dmi/id";
const POWER: &str = "/sys/class/power_supply";
const HIDRAW: &str = "/sys/class/hidraw";
pub const SENSE_DIRS: [&str; 2] = ["/sys/devices/platform/acer-wmi/nitro_sense", "/sys/devices/platform/acer-wmi/predator_sense"];
const ENEK5130_ID: &str = "0CF2:5130";

fn battery() -> Value {
    for entry in entries(POWER) {
        let dir = Path::new(POWER).join(entry);
        if read(dir.join("type")).as_deref() != Some("Battery") {
            continue;
        }
        let num = |name: &str| read(dir.join(name)).and_then(|text| parse_int(&text));
        let full = num("charge_full").or_else(|| num("energy_full"));
        let design = num("charge_full_design").or_else(|| num("energy_full_design"));
        let health = match (full, design) {
            (Some(full), Some(design)) if full != 0 && design != 0 => Some(js_round(full as f64 / design as f64 * 100.0) as i64),
            _ => None,
        };
        return json!({
            "capacity": num("capacity"),
            "status": read(dir.join("status")),
            "cycles": num("cycle_count"),
            "health": health,
        });
    }
    Value::Null
}

fn keyboard_device() -> Option<String> {
    entries(HIDRAW).into_iter().find_map(|entry| {
        let uevent = read(Path::new(HIDRAW).join(&entry).join("device/uevent")).unwrap_or_default();
        uevent.to_uppercase().contains(ENEK5130_ID).then(|| format!("/dev/{entry}"))
    })
}

pub fn info() -> Value {
    let sense_dir = SENSE_DIRS.iter().rev().find(|dir| exists(dir));
    let keyboard = keyboard_device();
    let limiter = sense_dir.and_then(|dir| read(Path::new(dir).join("battery_limiter")));
    json!({
        "model": read(Path::new(DMI).join("product_name")),
        "biosVersion": read(Path::new(DMI).join("bios_version")),
        "biosDate": read(Path::new(DMI).join("bios_date")),
        "battery": battery(),
        "chargeLimit": limiter.map(|value| value == "1"),
        "driver": {
            "loaded": exists("/sys/module/linuwu_sense"),
            "writable": sense_dir.is_some_and(|dir| accessible(Path::new(dir).join("fan_speed"), libc::W_OK)),
        },
        "keyboard": {
            "writable": keyboard.as_ref().is_some_and(|device| accessible(device, libc::R_OK | libc::W_OK)),
            "device": keyboard,
        },
    })
}

/// Like NitroSense, restarts at once (logind lets the active session's user reboot without a password).
pub fn restart() -> Result<(), String> {
    let failed = |reason: &str| format!("Restart failed: {}. The GPU mode changes at the next restart.", reason.trim());
    match run("systemctl", &["reboot"], Duration::from_secs(60)) {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err(failed(if output.stderr.trim().is_empty() { "systemctl reboot failed" } else { &output.stderr })),
        Err(RunError::NotFound) => Err(failed("systemctl is not installed")),
        Err(RunError::Failed(reason)) => Err(failed(&reason)),
    }
}
