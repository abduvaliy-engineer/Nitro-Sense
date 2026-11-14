//! Scenario profiles outside the window. The window's scenario.js owns the profiles while it's open; when it isn't,
//! this does what it would: the active profile's lighting at start, App Sync's switches, and saving mode and fan
//! changes made elsewhere. Following the power source is done here open or not: the window only runs while it's
//! open, and 0.15.1's hidden window used to do it all the time.
use super::{appsync, controls, lighting, notify, sensors, settings, util};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const KEY: &str = "scenario";
const LOW_BATTERY: f64 = 40.0;
const MODE_KEY_SETTING: &str = "modeKey.cycle";
const MODES: [&str; 5] = ["low-power", "quiet", "balanced", "balanced-performance", "performance"];
/// The window's poll.
const POLL: Duration = Duration::from_secs(2);
/// A reading this soon after NitroSense changed the mode or the fans may not show all of it (scenario.js's 2.5 s).
const SETTLE: Duration = Duration::from_millis(2500);

/// Held while the stored profiles are changed here or a profile is being applied, so a reading taken halfway
/// isn't saved as a change.
fn busy() -> MutexGuard<'static, ()> {
    static BUSY: Mutex<()> = Mutex::new(());
    BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn active(state: &Value) -> usize {
    state["active"].as_u64().unwrap_or(0) as usize
}

fn mode_name(mode: &str) -> &str {
    match mode {
        "low-power" => "Eco",
        "quiet" => "Quiet",
        "balanced" => "Balanced",
        "balanced-performance" => "Performance",
        "performance" => "Turbo",
        other => other,
    }
}

// Pulsar Lighting's defaults, as in scenario.js.
fn default_lighting(effect: &str) -> Value {
    json!({
        "mode": "global",
        "global": { "effect": effect, "speed": 3, "brightness": 5, "direction": 1, "color": "#ffa000" },
        "keyboard": {
            "effect": "STATIC", "speed": 5, "brightness": 5, "direction": 1, "color": "#ffa000",
            "zones": ["#ffa000", "#ffa000", "#ffa000", "#ffa000"],
        },
    })
}

fn default_fan() -> Value {
    json!({ "mode": "auto", "cpu": 30, "gpu": 30, "cpuAuto": true, "gpuAuto": true })
}

// NitroSense's built-in presets (getDefaultProfile / getGamingProfile / getQUIETProfile).
fn presets() -> Value {
    let preset = |name: &str, mode: &str, effect: &str| {
        json!({ "name": name, "mode": mode, "dcMode": "balanced", "fan": default_fan(), "lighting": default_lighting(effect), "apps": [], "appSync": true })
    };
    json!([preset("Daily Use", "balanced", "WAVE"), preset("Gaming", "balanced-performance", "BREATHING"), preset("Quiet Occasion", "quiet", "STATIC")])
}

/// The stored profiles with the defaults scenario.js fills in when it loads them.
pub fn load() -> Value {
    let stored = settings::get(KEY).filter(|stored| stored["profiles"].as_array().is_some_and(|profiles| !profiles.is_empty()));
    let mut state = stored.unwrap_or_else(|| json!({ "active": 0, "profiles": presets() }));
    if state["select"].is_null() {
        state["select"] = state["active"].clone();
    }
    for profile in state["profiles"].as_array_mut().into_iter().flatten() {
        if !profile.is_object() {
            continue;
        }
        if profile["dcMode"].is_null() {
            profile["dcMode"] = json!("balanced");
        }
        let mut fan = default_fan();
        for (key, value) in profile["fan"].as_object().into_iter().flatten() {
            fan[key] = value.clone();
        }
        profile["fan"] = fan;
        if profile["lighting"].is_null() {
            let effect = profile["effect"].as_str().map(str::to_uppercase).unwrap_or_else(|| "WAVE".to_string());
            profile["lighting"] = default_lighting(&effect);
        }
        if profile["apps"].is_null() {
            profile["apps"] = json!([]);
        }
        if profile["appSync"].is_null() {
            profile["appSync"] = json!(true);
        }
        if let Some(fields) = profile.as_object_mut() {
            fields.shift_remove("effect");
        }
    }
    state
}

fn configure_app_sync(state: &Value) {
    let profiles: Vec<Value> = state["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|profile| json!({ "name": profile["name"], "appSync": profile["appSync"], "apps": profile["apps"] }))
        .collect();
    appsync::configure(json!({ "active": state["active"], "select": state["select"], "profiles": profiles }));
}

/// App Sync follows the stored profiles (at start, and again whenever the window closes).
pub fn watch_apps() {
    configure_app_sync(&load());
}

/// At start: show the active profile's lighting, as NitroSense does when it opens.
pub fn restore_lighting() {
    let state = load();
    let lighting = state["profiles"][active(&state)]["lighting"].clone();
    if let Err(error) = lighting::restore(lighting) {
        eprintln!("restoring lighting failed: {error}");
    }
}

// linuwu-sense fan_speed "cpu,gpu": 0 = that fan on auto, 0,0 = auto, 100,100 = max.
pub fn fan_speeds(fan: &Value) -> (f64, f64) {
    let speed = |auto: &str, value: &str| if fan[auto] == true { 0.0 } else { fan[value].as_f64().unwrap_or(0.0) };
    match fan["mode"].as_str() {
        Some("max") => (100.0, 100.0),
        Some("custom") => (speed("cpuAuto", "cpu"), speed("gpuAuto", "gpu")),
        _ => (0.0, 0.0),
    }
}

// The mode a profile runs right now: battery slot, or the AC mode under the low-battery lock (on AC power below
// 40 % battery NitroSense keeps Quiet and runs everything else as Balanced).
pub fn live_mode(profile: &Value, power: &Value) -> String {
    let on_battery = power["ac"] == false;
    if on_battery {
        return profile["dcMode"].as_str().unwrap_or("balanced").to_string();
    }
    let low_battery = power["battery"].as_f64().is_some_and(|battery| battery < LOW_BATTERY);
    let mode = profile["mode"].as_str().unwrap_or("balanced");
    if low_battery && mode != "quiet" { "balanced".to_string() } else { mode.to_string() }
}

/// App Sync asks for another profile while no window is open: the linked app in front gets its profile, otherwise
/// the user's own profile comes back. The user's choice (select) stays.
pub fn switch(change: &Value) {
    let _busy = busy();
    let mut state = load();
    let power = &change["power"];
    let Some(index) = change["index"].as_u64() else { return };
    let profile = state["profiles"][index as usize].clone();
    if state["active"].as_u64() == Some(index) || !profile.is_object() {
        return;
    }
    state["active"] = json!(index);
    if let Err(error) = settings::set(KEY, state.clone()) {
        eprintln!("saving the scenario failed: {error}");
    }
    configure_app_sync(&state);
    // linuwu-sense resets the fans to auto when the platform profile changes, so the mode goes first.
    let mode = live_mode(&profile, power);
    let (cpu, gpu) = fan_speeds(&profile["fan"]);
    if let Err(error) = controls::set_profile(&mode).and_then(|()| controls::set_fan_speed(cpu, gpu)) {
        eprintln!("applying scenario failed: {error}");
        return;
    }
    // The lighting queue holds this until the mode-change flash has played, as Windows does.
    if let Err(error) = lighting::apply(profile["lighting"].clone()) {
        eprintln!("applying lighting failed: {error}");
    }
    let heading = if power["ac"] == false { "Current system mode:" } else { "System mode (AC Plugged In):" };
    // Which linked app brought the profile up, as scenario.js says it.
    let app = change["app"].as_str().filter(|app| !app.is_empty()).map(|app| format!("App Sync: {app}\n")).unwrap_or_default();
    notify(&format!("{} Enabled", profile["name"].as_str().unwrap_or("")), &format!("{app}{heading}\n{}", mode_name(&mode)));
}

/// The power state a profile's live mode depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PowerState {
    Battery,
    /// On AC below 40 % battery (see live_mode).
    Locked,
    Ac,
}

fn power_state(power: &Value) -> PowerState {
    if power["ac"] == false {
        PowerState::Battery
    } else if power["battery"].as_f64().is_some_and(|battery| battery < LOW_BATTERY) {
        PowerState::Locked
    } else {
        PowerState::Ac
    }
}

/// Plugging in, unplugging, or the low-battery lock starting or ending runs the active profile's mode for the new
/// power state, and its fans on AC (linuwu-sense puts the fans on auto when the mode changes). Nothing is saved.
fn run_live_mode(power: &Value) {
    let _busy = busy();
    let state = load();
    let profile = &state["profiles"][active(&state)];
    if !profile.is_object() {
        return;
    }
    let mut result = controls::set_profile(&live_mode(profile, power));
    if power["ac"] != false {
        let (cpu, gpu) = fan_speeds(&profile["fan"]);
        result = result.and_then(|()| controls::set_fan_speed(cpu, gpu));
    }
    if let Err(error) = result {
        eprintln!("running the profile's mode failed: {error}");
    }
}

/// Mode and fan changes made elsewhere (the Mode Switch Key, other tools) written into the profile, as scenario.js's
/// sync does. Only a mode other than the one the profile runs now is a change (the low-battery lock's Balanced
/// isn't); it goes into the slot for the power source. On AC, fans other than the profile's are one too (Quiet and
/// Eco force them to auto); battery changes to the fans aren't saved. False when nothing differs.
fn record_live(profile: &mut Value, mode: Option<&str>, fans: &Value, power: &Value) -> bool {
    if !profile.is_object() {
        return false;
    }
    let on_battery = power["ac"] == false;
    let mut changed = false;
    if let Some(mode) = mode.filter(|mode| MODES.contains(mode)) {
        if mode != live_mode(profile, power) {
            profile[if on_battery { "dcMode" } else { "mode" }] = json!(mode);
            changed = true;
        }
    }
    if on_battery || !fans.is_object() {
        return changed;
    }
    let (cpu, gpu) = fan_speeds(&profile["fan"]);
    if fans["cpu"].as_f64() == Some(cpu) && fans["gpu"].as_f64() == Some(gpu) {
        return changed;
    }
    let fan = &mut profile["fan"];
    if fans["mode"] == "custom" {
        // A fan at 0 is on auto and keeps the profile's percentage; "Custom with both fans on Auto" stays Custom.
        let running = |speed: &Value| speed.as_f64().is_some_and(|speed| speed != 0.0);
        fan["mode"] = json!("custom");
        for (speed, auto) in [("cpu", "cpuAuto"), ("gpu", "gpuAuto")] {
            if running(&fans[speed]) {
                fan[speed] = fans[speed].clone();
            }
            fan[auto] = json!(!running(&fans[speed]));
        }
    } else {
        fan["mode"] = fans["mode"].clone();
    }
    true
}

/// While no window is open, changes made elsewhere go into the active profile (the window saves them while it's
/// open), so the next plug-in or unplug restores what the user last picked.
fn record(power: &Value) {
    let _busy = busy();
    if controls::changed_within(SETTLE) {
        return;
    }
    let mut state = load();
    let index = active(&state);
    let Some(profile) = state.get_mut("profiles").and_then(|profiles| profiles.get_mut(index)) else { return };
    let mode = util::read(sensors::PLATFORM_PROFILE);
    if record_live(profile, mode.as_deref(), &sensors::read_fan_mode(), power) {
        if let Err(error) = settings::set(KEY, state) {
            eprintln!("saving the scenario failed: {error}");
        }
    }
}

/// The driver's Mode Switch Key setting stays on the user's choice: module parameters reset whenever linuwu-sense
/// loads. `failed` keeps a failing write from being logged every poll.
fn keep_mode_key(failed: &mut bool) {
    let Some(Value::Bool(cycle)) = settings::get(MODE_KEY_SETTING) else { return };
    match sensors::read_mode_key_cycle() {
        Some(live) if live != cycle => {}
        _ => return,
    }
    match controls::set_mode_key_cycle(cycle) {
        Ok(()) => *failed = false,
        Err(error) if !*failed => {
            eprintln!("setting the Mode Switch Key failed: {error}");
            *failed = true;
        }
        Err(_) => {}
    }
}

/// What the window's 2-second poll did all the time in 0.15.1. Power changes run the profile's mode, window open or
/// not (the window only stops saving the readings until that has landed); `window_closed` says when saving changes
/// made elsewhere is up to this.
pub fn follow_power(window_closed: fn() -> bool) {
    std::thread::spawn(move || {
        let mut last = None;
        let mut mode_key_failed = false;
        loop {
            let power = sensors::read_power();
            let now = power_state(&power);
            if last.is_some_and(|last| last != now) {
                run_live_mode(&power);
            } else if window_closed() {
                record(&power);
            }
            last = Some(now);
            keep_mode_key(&mut mode_key_failed);
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fans_and_modes_follow_the_profile() {
        let profile = json!({ "mode": "performance", "dcMode": "low-power", "fan": { "mode": "custom", "cpu": 60, "gpu": 50, "cpuAuto": false, "gpuAuto": true } });
        assert_eq!(fan_speeds(&profile["fan"]), (60.0, 0.0));
        assert_eq!(fan_speeds(&json!({ "mode": "max" })), (100.0, 100.0));
        assert_eq!(fan_speeds(&json!({ "mode": "auto", "cpu": 30, "gpu": 30 })), (0.0, 0.0));
        assert_eq!(live_mode(&profile, &json!({ "ac": true, "battery": 80 })), "performance");
        assert_eq!(live_mode(&profile, &json!({ "ac": false, "battery": 80 })), "low-power");
        assert_eq!(live_mode(&profile, &json!({ "ac": true, "battery": 30 })), "balanced", "the low-battery lock");
        assert_eq!(live_mode(&json!({ "mode": "quiet" }), &json!({ "ac": true, "battery": 30 })), "quiet");
        assert_eq!(live_mode(&profile, &json!({ "ac": null, "battery": null })), "performance");
    }

    // tests/scenario-power.js's plug and unplug sequence, from this side.
    #[test]
    fn power_changes_and_changes_made_elsewhere() {
        let mut profile = json!({
            "mode": "balanced-performance", "dcMode": "balanced",
            "fan": { "mode": "custom", "cpu": 60, "gpu": 50, "cpuAuto": false, "gpuAuto": false },
        });
        let custom = json!({ "mode": "custom", "cpu": 60, "gpu": 50 });
        let auto = json!({ "mode": "auto", "cpu": 0, "gpu": 0 });
        let ac = json!({ "ac": true, "battery": 80 });
        let battery = json!({ "ac": false, "battery": 80 });
        let locked = json!({ "ac": true, "battery": 30 });
        assert_eq!(power_state(&ac), PowerState::Ac);
        assert_eq!(power_state(&battery), PowerState::Battery);
        assert_eq!(power_state(&locked), PowerState::Locked);
        assert_eq!(power_state(&json!({ "ac": true, "battery": 40 })), PowerState::Ac, "40 % ends the lock");
        assert_eq!(power_state(&json!({ "ac": null, "battery": null })), PowerState::Ac, "no power supply readings");

        assert!(!record_live(&mut profile, Some("balanced-performance"), &custom, &ac), "nothing differs");
        assert!(!record_live(&mut profile, Some("balanced"), &auto, &battery), "unplugged, the battery mode runs");
        assert!(record_live(&mut profile, Some("low-power"), &auto, &battery), "the key picked Eco on battery");
        assert_eq!(profile["dcMode"], "low-power");
        assert_eq!(profile["mode"], "balanced-performance");
        assert_eq!(profile["fan"]["mode"], "custom", "fans on battery aren't saved");

        // Plugging in runs the AC mode, then its fans.
        assert_eq!(live_mode(&profile, &ac), "balanced-performance");
        assert_eq!(fan_speeds(&profile["fan"]), (60.0, 50.0));
        assert!(record_live(&mut profile, Some("performance"), &custom, &ac), "the key picked Turbo on AC");
        assert_eq!(profile["mode"], "performance");

        // Plugged in below 40 %: Balanced runs, and isn't the user's choice.
        assert_eq!(live_mode(&profile, &locked), "balanced");
        assert!(!record_live(&mut profile, Some("balanced"), &custom, &locked));
        assert_eq!(profile["mode"], "performance");
        assert!(!record_live(&mut profile, Some("custom"), &custom, &ac), "not a mode (amd-pmf hasn't caught up)");
        assert!(!record_live(&mut profile, None, &Value::Null, &ac), "no driver");

        // Quiet puts the fans on auto: saved. Custom with both fans on Auto writes 0,0 and stays Custom.
        assert!(record_live(&mut profile, Some("performance"), &auto, &ac));
        assert_eq!(profile["fan"]["mode"], "auto");
        profile["fan"] = json!({ "mode": "custom", "cpu": 60, "gpu": 50, "cpuAuto": true, "gpuAuto": true });
        assert!(!record_live(&mut profile, Some("performance"), &auto, &ac));
        assert!(record_live(&mut profile, Some("performance"), &json!({ "mode": "custom", "cpu": 70, "gpu": 0 }), &ac));
        assert_eq!(profile["fan"], json!({ "mode": "custom", "cpu": 70, "gpu": 50, "cpuAuto": false, "gpuAuto": true }));
    }
}
