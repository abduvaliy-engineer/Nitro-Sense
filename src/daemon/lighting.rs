//! Keyboard lighting (Pulsar Lighting): ENEK5130 HID keyboards through hidraw feature reports, or linuwu-sense's
//! four_zoned_kb on other models. Values follow Acer's Windows lighting service (AcerAgentService and
//! its OpenRGB keyboard controller), so the same profile looks the same as on Windows.
use super::controls::write;
use super::util::{exists, js_round, on_path, run};
use regex::Regex;
use serde_json::{json, Value};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const FOUR_ZONE_DIR: &str = "/sys/devices/platform/acer-wmi/four_zoned_kb";
const KEYBOARD_ID: u8 = 0x21;
const ALL_ZONES: u16 = 0x0f;
const ENEK_OPMODE: u8 = 0x06;
const THROTTLE: Duration = Duration::from_millis(150); // the service's minimum gap between keyboard updates
const FLASH_HOLD: Duration = Duration::from_millis(1600); // after a mode flash the service holds other updates for 1.55 s

/// value = Acer mode (also linuwu's four_zone_mode), enek = ENEK5130 effect byte, color = sends an RGB.
struct Effect {
    name: &'static str,
    value: u8,
    enek: u8,
    color: bool,
}

const EFFECTS: [Effect; 8] = [
    Effect { name: "STATIC", value: 0, enek: 0x02, color: true },
    Effect { name: "BREATHING", value: 1, enek: 0x04, color: true },
    Effect { name: "NEON", value: 2, enek: 0x05, color: false },
    Effect { name: "WAVE", value: 3, enek: 0x07, color: false },
    Effect { name: "SHIFTING", value: 4, enek: 0x08, color: true },
    Effect { name: "ZOOM", value: 5, enek: 0x09, color: true },
    Effect { name: "METEOR", value: 6, enek: 0x0a, color: true },
    Effect { name: "TWINKLING", value: 7, enek: 0x0b, color: true },
];

/// AcerAgentService's mode-change colors, by platform_profile.
pub fn flash_color(profile: &str) -> Option<&'static str> {
    Some(match profile {
        "quiet" => "#ffffff",
        "balanced" => "#00aec7",
        "balanced-performance" => "#2e09c7",
        "performance" => "#c700ff",
        "low-power" => "#10dc00",
        _ => return None,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Enek,
    FourZone,
}

/// What goes to the keyboard: HID feature reports, or (file, value) writes to four_zoned_kb.
#[derive(PartialEq, Eq, Debug)]
pub enum Payload {
    Reports(Vec<Vec<u8>>),
    Writes(Vec<(&'static str, String)>),
}

fn level(value: &Value, fallback: f64) -> f64 {
    match value.as_f64() {
        Some(number) if number.is_finite() => js_round(number).clamp(1.0, 5.0),
        _ => fallback,
    }
}
// NitroSense levels 1-5 → brightness 0/25/50/75/100 and speed 1/3/5/7/9.
fn brightness_byte(brightness: &Value) -> u8 {
    ((level(brightness, 5.0) - 1.0) * 25.0) as u8
}
fn speed_byte(speed: &Value) -> u8 {
    (level(speed, 3.0) * 2.0 - 1.0) as u8
}
fn hex6(color: &Value) -> String {
    let color = color.as_str().unwrap_or("");
    let valid = color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if valid { color[1..].to_lowercase() } else { "000000".to_string() }
}
fn rgb(color: &Value) -> [u8; 3] {
    let n = u32::from_str_radix(&hex6(color), 16).unwrap_or(0);
    [(n >> 16) as u8, (n >> 8) as u8, n as u8]
}

struct Plan {
    effect: &'static Effect,
    brightness: u8,
    speed: u8,
    direction: u8,
    color: Value,
    zones: Option<[Value; 4]>,
}

// The keyboard shows the Global effect, or its own effect in Area mode. Unknown effects fall back to Neon,
// as in NitroSense. Area Static carries the four zone colors.
fn plan(lighting: &Value) -> Result<Plan, String> {
    let area = lighting["mode"] == "area";
    let source = &lighting[if area { "keyboard" } else { "global" }];
    if !source.is_object() {
        return Err("Lighting settings are missing".to_string());
    }
    let neon = &EFFECTS[2];
    let effect = source["effect"].as_str().and_then(|name| EFFECTS.iter().find(|e| e.name == name)).unwrap_or(neon);
    let is_static = effect.name == "STATIC";
    Ok(Plan {
        effect,
        brightness: brightness_byte(&source["brightness"]),
        speed: if is_static { 0 } else { speed_byte(&source["speed"]) },
        direction: if is_static { 0 } else if source["direction"].as_f64() == Some(2.0) { 2 } else { 1 },
        color: if effect.color { source["color"].clone() } else { Value::Null },
        zones: (is_static && area).then(|| [0, 1, 2, 3].map(|i| source["zones"][i].clone())),
    })
}

// HID feature report A4: id, effect, brightness, speed, direction, R, G, B, zone mask (u16 LE).
fn enek_report(effect: u8, brightness: u8, speed: u8, direction: u8, color: &Value, mask: u16) -> Vec<u8> {
    let [r, g, b] = rgb(color);
    vec![0xa4, KEYBOARD_ID, effect, brightness, speed, direction, r, g, b, (mask & 0xff) as u8, (mask >> 8) as u8]
}

fn enek_reports(lighting: &Value) -> Result<Vec<Vec<u8>>, String> {
    let p = plan(lighting)?;
    if let Some(zones) = &p.zones {
        return Ok(zones.iter().enumerate().map(|(i, zone)| enek_report(p.effect.enek, p.brightness, 0, 0, zone, 1 << i)).collect());
    }
    Ok(vec![enek_report(p.effect.enek, p.brightness, p.speed, p.direction, &p.color, ALL_ZONES)])
}

// linuwu-sense: four_zone_mode "mode,speed,brightness,direction,r,g,b"; per_zone_mode "RRGGBB x4,brightness".
fn four_zone_writes(lighting: &Value) -> Result<Vec<(&'static str, String)>, String> {
    let p = plan(lighting)?;
    if let Some(zones) = &p.zones {
        return Ok(vec![("per_zone_mode", format!("{},{}", zones.iter().map(hex6).collect::<Vec<_>>().join(","), p.brightness))]);
    }
    let [r, g, b] = rgb(&p.color);
    Ok(vec![("four_zone_mode", format!("{},{},{},{},{r},{g},{b}", p.effect.value, p.speed, p.brightness, p.direction))])
}

// Windows sends OPMODE at brightness 0, which the firmware ignores; 100 keeps the flash visible either way.
// four_zoned_kb has no OPMODE, so a static color stands in for it.
pub fn flash_payload(kind: Kind, color: &str) -> Payload {
    let color = json!(color);
    match kind {
        Kind::Enek => Payload::Reports(vec![enek_report(ENEK_OPMODE, 100, 0, 2, &color, ALL_ZONES)]),
        Kind::FourZone => {
            let [r, g, b] = rgb(&color);
            Payload::Writes(vec![("four_zone_mode", format!("0,0,100,0,{r},{g},{b}"))])
        }
    }
}

pub fn encode(kind: Kind, lighting: &Value) -> Result<Payload, String> {
    Ok(match kind {
        Kind::Enek => Payload::Reports(enek_reports(lighting)?),
        Kind::FourZone => Payload::Writes(four_zone_writes(lighting)?),
    })
}

// ---------- device ----------

#[derive(Clone)]
struct Backend {
    kind: Kind,
    device: String,
}

fn find_enek() -> Option<String> {
    let id = Regex::new(r"(?im)^HID_ID=[0-9A-Za-z_]+:00000CF2:00005130$").unwrap();
    for name in super::util::entries("/sys/class/hidraw") {
        let uevent = std::fs::read_to_string(format!("/sys/class/hidraw/{name}/device/uevent")).unwrap_or_default();
        if id.is_match(&uevent) {
            return Some(format!("/dev/{name}"));
        }
    }
    None
}

fn detect() -> Option<Backend> {
    if let Some(device) = find_enek() {
        return Some(Backend { kind: Kind::Enek, device });
    }
    exists(format!("{FOUR_ZONE_DIR}/four_zone_mode")).then(|| Backend { kind: Kind::FourZone, device: FOUR_ZONE_DIR.to_string() })
}

// None until detected, Some(None) when the laptop has no supported lighting.
fn backend(refresh: bool) -> Option<Backend> {
    static BACKEND: Mutex<Option<Option<Backend>>> = Mutex::new(None);
    let mut cached = BACKEND.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if cached.is_none() || refresh {
        *cached = Some(detect());
    }
    cached.clone().flatten()
}

enum SendError {
    /// The device node is gone (its hidraw number can change after resume).
    Vanished,
    Failed(String),
}

// ioctl HIDIOCSFEATURE(len): _IOC(_IOC_WRITE | _IOC_READ, 'H', 0x06, len)
fn hidiocsfeature(length: usize) -> libc::c_ulong {
    ((3 << 30) | (length << 16) | ((b'H' as usize) << 8) | 0x06) as libc::c_ulong
}

fn send_enek(device: &str, reports: &[Vec<u8>]) -> Result<(), SendError> {
    let failed = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::NotFound => SendError::Vanished,
        std::io::ErrorKind::PermissionDenied => SendError::Failed(format!(
            "No permission to use the keyboard lighting ({device}). Run install.sh to grant the linuwu_sense group access."
        )),
        _ => SendError::Failed(format!("Keyboard lighting failed: {error}")),
    };
    let file = std::fs::OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open(device).map_err(failed)?;
    for (i, report) in reports.iter().enumerate() {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(20)); // Acer waits 20 ms between zone reports
        }
        let mut buffer = report.clone();
        if unsafe { libc::ioctl(file.as_raw_fd(), hidiocsfeature(buffer.len()), buffer.as_mut_ptr()) } < 0 {
            return Err(failed(std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

fn write_four_zone(writes: &[(&'static str, String)]) -> Result<(), SendError> {
    for (file, value) in writes {
        write(&format!("{FOUR_ZONE_DIR}/{file}"), value).map_err(SendError::Failed)?;
    }
    Ok(())
}

// The hidraw number can change after resume, so a vanished device is looked up once more.
fn send(payload_for: impl Fn(Kind) -> Result<Payload, String>) -> Result<(), String> {
    for attempt in 0.. {
        let Some(found) = backend(attempt > 0) else { return Ok(()) };
        let sent = match payload_for(found.kind)? {
            Payload::Reports(reports) => send_enek(&found.device, &reports),
            Payload::Writes(writes) => write_four_zone(&writes),
        };
        match sent {
            Ok(()) => return Ok(()),
            Err(SendError::Vanished) if attempt == 0 => continue,
            Err(SendError::Vanished) => return Err(format!("Keyboard lighting failed: {} is gone", found.device)),
            Err(SendError::Failed(message)) => return Err(message),
        }
    }
    Ok(())
}

// ---------- queue ----------

type Waiter = Sender<Result<(), String>>;

enum Job {
    /// Show the target lighting (whatever it is when the job runs: the latest apply wins).
    Show,
    Flash(&'static str),
}

#[derive(Default)]
struct Queue {
    target: Option<Value>, // the lighting the keyboard should show
    waiting: Option<Vec<Waiter>>, // Some while a Show job is queued; its callers
    hold_until: Option<Instant>,
    hold_generation: u64,
    jobs: Option<Sender<Job>>,
}

fn queue() -> &'static Mutex<Queue> {
    static QUEUE: OnceLock<Mutex<Queue>> = OnceLock::new();
    QUEUE.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, Queue> {
    queue().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One thread writes to the keyboard, one job after another, never closer together than THROTTLE.
fn jobs(queue: &mut Queue) -> Sender<Job> {
    queue
        .jobs
        .get_or_insert_with(|| {
            let (sender, receiver) = channel::<Job>();
            std::thread::spawn(move || {
                let mut last_write: Option<Instant> = None;
                for job in receiver {
                    if let Some(wait) = last_write.and_then(|last| (last + THROTTLE).checked_duration_since(Instant::now())) {
                        std::thread::sleep(wait);
                    }
                    match job {
                        Job::Show => {
                            let (target, waiting) = {
                                let mut queue = lock();
                                (queue.target.clone(), queue.waiting.take().unwrap_or_default())
                            };
                            let result = match &target {
                                Some(target) => send(|kind| encode(kind, target)),
                                None => Ok(()),
                            };
                            if let (true, Err(error)) = (waiting.is_empty(), &result) {
                                eprintln!("restoring lighting failed: {error}");
                            }
                            for waiter in waiting {
                                let _ = waiter.send(result.clone());
                            }
                        }
                        Job::Flash(color) => {
                            if let Err(error) = send(|kind| Ok(flash_payload(kind, color))) {
                                eprintln!("mode flash failed: {error}");
                            }
                        }
                    }
                    last_write = Some(Instant::now());
                }
            });
            sender
        })
        .clone()
}

fn schedule(queue: &mut Queue, waiter: Option<Waiter>) {
    match &mut queue.waiting {
        Some(waiting) => waiting.extend(waiter),
        None => {
            queue.waiting = Some(waiter.into_iter().collect());
            let _ = jobs(queue).send(Job::Show);
        }
    }
}

/// Shows this lighting on the keyboard; returns once it has been sent (at once during a mode flash, which sends it
/// when the flash ends).
pub fn apply(lighting: Value) -> Result<(), String> {
    plan(&lighting)?;
    let (waiter, sent) = channel();
    {
        let mut queue = lock();
        queue.target = Some(lighting);
        if queue.hold_until.is_some_and(|until| Instant::now() < until) {
            return Ok(());
        }
        schedule(&mut queue, Some(waiter));
    }
    sent.recv().unwrap_or(Ok(()))
}

/// Like apply, for the window opening: nothing is sent when the keyboard already shows this lighting, so reopening
/// the window doesn't restart the keyboard's animation.
pub fn restore(lighting: Value) -> Result<(), String> {
    if lock().target.as_ref() == Some(&lighting) {
        return Ok(());
    }
    apply(lighting)
}

/// Mode change: flash the mode color, then show the profile's lighting again.
pub fn flash(profile: &str) {
    let Some(color) = flash_color(profile) else { return };
    let mut queue = lock();
    if queue.target.is_none() {
        return;
    }
    queue.hold_until = Some(Instant::now() + FLASH_HOLD);
    queue.hold_generation += 1;
    let generation = queue.hold_generation;
    std::thread::spawn(move || {
        std::thread::sleep(FLASH_HOLD);
        let mut queue = lock();
        if queue.hold_generation == generation {
            queue.hold_until = None;
            schedule(&mut queue, None);
        }
    });
    let _ = jobs(&mut queue).send(Job::Flash(color));
}

pub fn info() -> Value {
    let kind = backend(false).map(|found| match found.kind {
        Kind::Enek => "enek",
        Kind::FourZone => "four_zone",
    });
    json!({ "backend": kind, "picker": on_path("hyprpicker", libc::X_OK).is_some() })
}

/// Eyedropper: hyprpicker prints the picked color, or nothing when cancelled with Escape.
pub fn pick_color() -> Value {
    let output = run("hyprpicker", &["-f", "hex", "-l", "-b", "-q"], Duration::from_secs(60));
    let stdout = output.map(|output| output.stdout).unwrap_or_default();
    let color = Regex::new(r"(?i)#[0-9a-f]{6}").unwrap().find(&stdout).map(|found| found.as_str().to_lowercase());
    json!(color)
}

#[cfg(test)]
mod tests {
    //! Byte checks against the reports from Acer's Windows lighting service.
    use super::*;

    fn hex(payload: Payload) -> Vec<String> {
        let Payload::Reports(reports) = payload else { panic!("expected HID reports") };
        reports.iter().map(|r| r.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")).collect()
    }
    fn writes(payload: Payload) -> Vec<(&'static str, String)> {
        let Payload::Writes(writes) = payload else { panic!("expected sysfs writes") };
        writes
    }
    fn with(mut base: Value, extra: Value) -> Value {
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }
    fn base() -> Value {
        json!({ "speed": 3, "brightness": 5, "direction": 1, "color": "#ffa000", "colortype": 1 })
    }
    fn g(effect: &str, extra: Value) -> Value {
        json!({ "mode": "global", "global": with(with(base(), json!({ "effect": effect })), extra), "keyboard": {} })
    }
    fn area(effect: &str, extra: Value) -> Value {
        let zones = json!(["#ff0000", "#00ff00", "#0000ff", "#ffffff"]);
        json!({
            "mode": "area",
            "global": with(base(), json!({ "effect": "WAVE" })),
            "keyboard": with(with(base(), json!({ "effect": effect, "zones": zones })), extra),
        })
    }
    fn enek(lighting: Value) -> Vec<String> {
        hex(encode(Kind::Enek, &lighting).unwrap())
    }
    fn four(lighting: Value) -> Vec<(&'static str, String)> {
        writes(encode(Kind::FourZone, &lighting).unwrap())
    }

    #[test]
    fn enek_global() {
        assert_eq!(enek(g("WAVE", json!({}))), ["a4 21 07 64 05 01 00 00 00 0f 00"]);
        assert_eq!(enek(g("WAVE", json!({ "direction": 2 }))), ["a4 21 07 64 05 02 00 00 00 0f 00"]);
        assert_eq!(enek(g("BREATHING", json!({}))), ["a4 21 04 64 05 01 ff a0 00 0f 00"]);
        assert_eq!(enek(g("STATIC", json!({}))), ["a4 21 02 64 00 00 ff a0 00 0f 00"]);
        // Shifting is 08, speed 5 -> 9
        assert_eq!(enek(g("SHIFTING", json!({ "speed": 5 }))), ["a4 21 08 64 09 01 ff a0 00 0f 00"]);
        // Neon sends no color, brightness 1 -> 0
        assert_eq!(enek(g("NEON", json!({ "brightness": 1 }))), ["a4 21 05 00 05 01 00 00 00 0f 00"]);
    }

    #[test]
    fn enek_effect_bytes() {
        let byte = |effect: &str| enek(g(effect, json!({})))[0][6..8].to_string();
        assert_eq!([byte("METEOR"), byte("TWINKLING"), byte("ZOOM")], ["0a", "0b", "09"]);
        assert_eq!(byte("RAIN_DROP"), "05", "an unknown effect falls back to Neon");
    }

    #[test]
    fn enek_area() {
        assert_eq!(
            enek(area("STATIC", json!({ "brightness": 3 }))),
            [
                "a4 21 02 32 00 00 ff 00 00 01 00",
                "a4 21 02 32 00 00 00 ff 00 02 00",
                "a4 21 02 32 00 00 00 00 ff 04 00",
                "a4 21 02 32 00 00 ff ff ff 08 00",
            ]
        );
        // Area mode with another effect shows the keyboard's effect on all zones.
        assert_eq!(enek(area("BREATHING", json!({}))), ["a4 21 04 64 05 01 ff a0 00 0f 00"]);
    }

    #[test]
    fn flashes() {
        assert_eq!(hex(flash_payload(Kind::Enek, flash_color("balanced").unwrap())), ["a4 21 06 64 00 02 00 ae c7 0f 00"]);
        assert_eq!(
            writes(flash_payload(Kind::FourZone, flash_color("performance").unwrap())),
            [("four_zone_mode", "0,0,100,0,199,0,255".to_string())]
        );
    }

    #[test]
    fn four_zone() {
        assert_eq!(four(g("STATIC", json!({}))), [("four_zone_mode", "0,0,100,0,255,160,0".to_string())]);
        assert_eq!(four(g("WAVE", json!({ "direction": 2, "speed": 1 }))), [("four_zone_mode", "3,1,100,2,0,0,0".to_string())]);
        assert_eq!(four(g("SHIFTING", json!({}))), [("four_zone_mode", "4,5,100,1,255,160,0".to_string())]);
        assert_eq!(four(area("STATIC", json!({ "brightness": 2 }))), [("per_zone_mode", "ff0000,00ff00,0000ff,ffffff,25".to_string())]);
        // A bad zone color turns that zone off.
        assert_eq!(
            four(area("STATIC", json!({ "zones": ["#12", null, "#ABCDEF", "#00ff00"] }))),
            [("per_zone_mode", "000000,000000,abcdef,00ff00,100".to_string())]
        );
    }

    #[test]
    fn levels_clamp_and_missing_lighting_fails() {
        assert_eq!(enek(g("BREATHING", json!({ "speed": 99, "brightness": -4 }))), ["a4 21 04 00 09 01 ff a0 00 0f 00"]);
        assert!(encode(Kind::Enek, &json!({})).is_err());
    }
}
