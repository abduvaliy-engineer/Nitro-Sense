//! Writes to the linuwu-sense driver: power mode, fan speeds, the mode key and Personal Settings.
use super::sensors::PLATFORM_PROFILE;
use super::system::SENSE_DIRS;
use super::util::{exists, js_round, parse_int, read};
use serde_json::{json, Map, Value};
use std::fmt::Display;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PLATFORM_PROFILE_CHOICES: &str = "/sys/firmware/acpi/platform_profile_choices";

/// When NitroSense itself last changed the mode or the fans.
static CHANGED: Mutex<Option<Instant>> = Mutex::new(None);

fn mark_changed() {
    *CHANGED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
}

/// Whether NitroSense itself changed the mode or the fans within `window`: a reading taken that soon may not show
/// all of it yet.
pub fn changed_within(window: Duration) -> bool {
    CHANGED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some_and(|time| time.elapsed() < window)
}

pub fn write(file: &str, value: impl Display) -> Result<(), String> {
    std::fs::write(file, format!("{value}\n")).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            format!("No permission to write {file}. Run nitrosense.sh, then log in again.")
        } else {
            format!("Driver rejected {value}: {error}")
        }
    })
}

pub fn sense_file(name: &str) -> Result<String, String> {
    SENSE_DIRS
        .iter()
        .map(|dir| format!("{dir}/{name}"))
        .find(|file| exists(file))
        .ok_or_else(|| "linuwu-sense controls are not available".to_string())
}

/// Rewriting the current mode still notifies the kernel's listeners, so only real changes are written.
pub fn set_profile(profile: &str) -> Result<(), String> {
    let read = |file: &str| std::fs::read_to_string(file).map_err(|error| format!("Can't read {file}: {error}"));
    let choices = read(PLATFORM_PROFILE_CHOICES)?;
    if !choices.split_whitespace().any(|choice| choice == profile) {
        return Err(format!("Unsupported power mode: {profile}"));
    }
    if read(PLATFORM_PROFILE)?.trim() == profile {
        return Ok(());
    }
    mark_changed();
    let written = write(PLATFORM_PROFILE, profile);
    mark_changed();
    written
}

/// 0,0 = automatic, 100,100 = maximum, anything else = custom percentages.
pub fn set_fan_speed(cpu: f64, gpu: f64) -> Result<(), String> {
    let values = [js_round(cpu), js_round(gpu)];
    if values.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 100.0) {
        return Err("Fan speeds must be 0-100%".to_string());
    }
    let file = sense_file("fan_speed")?;
    mark_changed();
    let written = write(&file, format!("{},{}", values[0] as i64, values[1] as i64));
    mark_changed();
    written
}

pub fn set_mode_key_cycle(cycle: bool) -> Result<(), String> {
    write("/sys/module/linuwu_sense/parameters/cycle_gaming_thermal_profile", if cycle { "Y" } else { "N" })
}

// Personal Settings: the linuwu-sense attributes and the values each accepts.
const PERSONAL: [(&str, &[i64]); 5] = [
    ("battery_limiter", &[0, 1]),        // 1 = charge to 80 % (Optimized Battery Charging)
    ("usb_charging", &[0, 10, 20, 30]),  // power-off USB charging, stopping at that battery level; 0 = off
    ("lcd_override", &[0, 1]),           // LCD Overdrive
    ("backlight_timeout", &[0, 1]),      // keyboard backlight off after 30 s
    ("boot_animation_sound", &[0, 1]),
];

// GPU Operating: linuwu-sense's gpu_mode reads 0 Optimus, 1 NVIDIA GPU only or 2 Automatic Selection, and takes
// 0 or 1. The firmware switches at the next boot.
const GPU_MODES: [i64; 2] = [0, 1];

// Without gpu_mode in the driver: the mode from the GPU that drives the connected laptop panel (in NVIDIA GPU only
// mode the AMD panel connector stays listed, disconnected). null when no panel is connected.
fn panel_gpu_mode() -> Option<i64> {
    for connector in super::util::entries("/sys/class/drm") {
        let Some((card, _)) = connector.split_once("-eDP-") else { continue };
        let Some(number) = card.strip_prefix("card") else { continue };
        if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if read(format!("/sys/class/drm/{connector}/status")).as_deref() != Some("connected") {
            continue;
        }
        let driver = std::fs::read_link(format!("/sys/class/drm/{card}/device/driver")).ok();
        let driver = driver.as_deref().and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned());
        return Some(i64::from(matches!(driver.as_deref(), Some("nvidia" | "nouveau"))));
    }
    None
}

fn read_gpu_mode() -> (Option<i64>, bool) {
    let mode = sense_file("gpu_mode").ok().and_then(|file| read(file)).and_then(|text| parse_int(&text));
    match mode {
        Some(mode @ 0..=2) => (Some(mode), true),
        // this linuwu-sense has no gpu_mode
        _ => (panel_gpu_mode(), false),
    }
}

pub fn set_gpu_mode(mode: f64) -> Result<(), String> {
    let Some(mode) = GPU_MODES.iter().find(|&&allowed| allowed as f64 == mode) else {
        return Err(format!("Unsupported GPU mode: {mode}"));
    };
    write(&sense_file("gpu_mode")?, mode)
}

/// Current values; an attribute this model lacks reads as null.
pub fn read_personal() -> Value {
    let mut values = Map::new();
    for (name, _) in PERSONAL {
        let value = sense_file(name).ok().and_then(|file| read(file)).and_then(|text| parse_int(&text));
        values.insert(name.to_string(), json!(value));
    }
    let (mode, settable) = read_gpu_mode();
    values.insert("gpu_mode".to_string(), json!(mode));
    values.insert("gpu_mode_settable".to_string(), json!(settable));
    Value::Object(values)
}

pub fn set_personal(name: &str, value: f64) -> Result<(), String> {
    let allowed = PERSONAL.iter().find(|(known, _)| *known == name).and_then(|(_, values)| values.iter().find(|&&v| v as f64 == value));
    let Some(value) = allowed else { return Err(format!("Unsupported setting: {name} = {value}")) };
    write(&sense_file(name)?, value)
}
