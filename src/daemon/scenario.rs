//! Scenario profiles while no window is open. The window's scenario.js owns the profiles; when it isn't running,
//! this applies what it would: the active profile's lighting at start, and App Sync's switches.
use super::{appsync, controls, lighting, notify, settings};
use serde_json::{json, Value};

const KEY: &str = "scenario";
const LOW_BATTERY: f64 = 40.0;

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
    let lighting = state["profiles"][state["active"].as_u64().unwrap_or(0) as usize]["lighting"].clone();
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
}
