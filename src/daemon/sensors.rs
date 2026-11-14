//! Temperatures, fans, CPU, GPU, memory, network and power, read from sysfs and procfs for each poll.
use super::util::{entries, exists, js_round, now_ms, parse_int, read, read_int, run};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const HWMON: &str = "/sys/class/hwmon";
const CPUS: &str = "/sys/devices/system/cpu";
const PCI: &str = "/sys/bus/pci/devices";
const NET: &str = "/sys/class/net";
const NVIDIA_GPUS: &str = "/proc/driver/nvidia/gpus";
const UDEV_DMI: &str = "/run/udev/data/+dmi:id";
pub const PLATFORM_PROFILE: &str = "/sys/firmware/acpi/platform_profile";
const FAN_SPEED: [&str; 2] = [
    "/sys/devices/platform/acer-wmi/nitro_sense/fan_speed",
    "/sys/devices/platform/acer-wmi/predator_sense/fan_speed",
];

#[derive(Clone)]
struct Gpu {
    dir: PathBuf,
    nvidia: bool,
}

struct NetCounter {
    wifi: bool,
    rx: i64,
    tx: i64,
}

/// What is kept between polls: paths that don't move, names read once, and the previous counters.
#[derive(Default)]
struct State {
    hwmon: Option<(Option<PathBuf>, Option<PathBuf>)>,
    fan_count: Option<u8>,
    cpu_name: Option<Option<String>>,
    last_stat: HashMap<String, (f64, f64)>,
    core_cache: (Option<String>, Vec<usize>),
    cpu_max: Option<i64>,
    gpu: Option<Option<Gpu>>,
    gpu_name: Option<String>,
    ram_frequency: Option<Option<i64>>,
    last_net: Option<(u64, HashMap<String, NetCounter>)>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

fn find_hwmon(name: &str) -> Option<PathBuf> {
    entries(HWMON).into_iter().map(|entry| Path::new(HWMON).join(entry)).find(|dir| read(dir.join("name")).as_deref() == Some(name))
}

fn hwmon_paths(state: &mut State) -> (Option<PathBuf>, Option<PathBuf>) {
    state
        .hwmon
        .get_or_insert_with(|| (find_hwmon("acer"), find_hwmon("k10temp").or_else(|| find_hwmon("coretemp"))))
        .clone()
}

// The EC reports 0 for sensors that are powered down (e.g. a suspended dGPU).
fn temp(dir: &Option<PathBuf>, index: u8) -> Option<i64> {
    let value = read_int(dir.as_ref()?.join(format!("temp{index}_input")))?;
    (value != 0).then(|| js_round(value as f64 / 1000.0) as i64)
}

fn read_temps(state: &mut State) -> Value {
    let (acer, cpu) = hwmon_paths(state);
    json!({ "cpu": temp(&acer, 1).or_else(|| temp(&cpu, 1)), "gpu": temp(&acer, 2), "system": temp(&acer, 3) })
}

// count = fan tachometers on the EC (1 on single-fan models, where it is the CPU fan).
fn read_fans(state: &mut State) -> Value {
    let (acer, _) = hwmon_paths(state);
    let Some(acer) = acer else { return json!({ "cpu": null, "gpu": null, "count": 0 }) };
    let count = *state.fan_count.get_or_insert_with(|| {
        if exists(acer.join("fan2_input")) {
            2
        } else if exists(acer.join("fan1_input")) {
            1
        } else {
            0
        }
    });
    json!({ "cpu": read_int(acer.join("fan1_input")), "gpu": read_int(acer.join("fan2_input")), "count": count })
}

fn read_cpu_name(state: &mut State) -> Option<String> {
    state
        .cpu_name
        .get_or_insert_with(|| {
            let info = read("/proc/cpuinfo")?;
            let name = Regex::new(r"(?m)^model name\s*:\s*(.+)$").unwrap().captures(&info)?[1].trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .clone()
}

// Busy share since the previous poll for each /proc/stat "cpu" line ("" = all CPUs, "0", "1", ...).
fn busy_share(state: &mut State, label: &str, fields: &[f64]) -> Option<i64> {
    let idle = fields.get(3).copied().unwrap_or(0.0) + fields.get(4).copied().unwrap_or(0.0);
    let total: f64 = fields.iter().sum();
    let last = state.last_stat.insert(label.to_string(), (idle, total));
    let (last_idle, last_total) = last?;
    if total <= last_total {
        return None;
    }
    let share = js_round((1.0 - (idle - last_idle) / (total - last_total)) * 100.0);
    Some(share.clamp(0.0, 100.0) as i64)
}

// "0-3,5,8-15" -> [0, 1, 2, 3, 5, 8, ...]. Offline CPUs have no readable clock, so they are left out.
fn online_cpus() -> Vec<i64> {
    let mut ids = Vec::new();
    for part in read(Path::new(CPUS).join("online")).unwrap_or_default().split(',') {
        let mut bounds = part.split('-').map(parse_int);
        let Some(Some(first)) = bounds.next() else { continue };
        let last = bounds.next().flatten().unwrap_or(first);
        ids.extend(first..=last);
    }
    if !ids.is_empty() {
        return ids;
    }
    // The directory lists in no useful order (cpu1, cpu10, cpu11 ... cpu2), so sort the numbers.
    let mut ids: Vec<i64> = entries(CPUS)
        .iter()
        .filter_map(|entry| entry.strip_prefix("cpu"))
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|id| id.parse().ok())
        .collect();
    ids.sort_unstable();
    ids
}

// Threads of one physical core share a sibling list ("0-1"). Read again only when the set of online CPUs changes.
fn physical_cores(state: &mut State, ids: &[i64]) -> Vec<usize> {
    let key = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    if state.core_cache.0.as_deref() == Some(&key) {
        return state.core_cache.1.clone();
    }
    let mut order: Vec<String> = Vec::new();
    let mut cores = Vec::new();
    for id in ids {
        let topology = Path::new(CPUS).join(format!("cpu{id}")).join("topology");
        let siblings = read(topology.join("core_cpus_list"))
            .or_else(|| read(topology.join("thread_siblings_list")))
            .unwrap_or_else(|| id.to_string());
        let index = order.iter().position(|known| *known == siblings).unwrap_or_else(|| {
            order.push(siblings);
            order.len() - 1
        });
        cores.push(index);
    }
    state.core_cache = (Some(key), cores.clone());
    cores
}

// NitroSense scales the CPU gauge to the SMBIOS "Max Speed" (root-only to read), which nitrosense.sh
// stores in /etc/nitrosense/cpu_max_mhz; fall back to the kernel's cpuinfo_max_freq.
fn read_cpu_max() -> Option<i64> {
    if let Some(smbios) = read_int("/etc/nitrosense/cpu_max_mhz").filter(|&mhz| mhz != 0) {
        return Some(smbios);
    }
    let khz = read_int(Path::new(CPUS).join("cpu0/cpufreq/cpuinfo_max_freq")).filter(|&khz| khz != 0)?;
    Some(js_round(khz as f64 / 1000.0) as i64)
}

fn read_cpu(state: &mut State) -> Value {
    let mut usage = None;
    let mut per_cpu: HashMap<i64, Option<i64>> = HashMap::new();
    for line in read("/proc/stat").unwrap_or_default().lines() {
        let Some(rest) = line.strip_prefix("cpu") else { continue };
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let (label, values) = rest.split_at(digits);
        if !values.starts_with(char::is_whitespace) {
            continue;
        }
        let fields: Vec<f64> = values.split_whitespace().map(|v| v.parse().unwrap_or(0.0)).collect();
        let share = busy_share(state, label, &fields);
        match label.parse::<i64>() {
            Ok(id) => drop(per_cpu.insert(id, share)),
            Err(_) => usage = share,
        }
    }

    // One entry per online logical CPU in CPU order (the CPU Details rows): its clock, rounded up like NitroSense,
    // its usage and its physical core (0, 1, ... in order of appearance). null where a read fails. The card's
    // average clock comes from the same reads.
    let ids = online_cpus();
    let khz: Vec<Option<i64>> = ids
        .iter()
        .map(|id| {
            let dir = Path::new(CPUS).join(format!("cpu{id}")).join("cpufreq");
            read_int(dir.join("cpuinfo_avg_freq")).or_else(|| read_int(dir.join("scaling_cur_freq")))
        })
        .collect();
    let core_of = physical_cores(state, &ids);
    let mhz = |khz: i64| (khz as f64 / 1000.0).ceil() as i64;
    let cores: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            json!({
                "id": id,
                "frequency": khz[i].filter(|&khz| khz != 0).map(mhz),
                "usage": per_cpu.get(id).copied().flatten(),
                "core": core_of[i],
            })
        })
        .collect();
    let measured: Vec<i64> = khz.iter().flatten().copied().filter(|&khz| khz != 0).collect();
    let frequency = (!measured.is_empty())
        .then(|| (measured.iter().sum::<i64>() as f64 / measured.len() as f64 / 1000.0).ceil() as i64);
    let load: Option<Vec<Option<f64>>> =
        read("/proc/loadavg").map(|text| text.split_whitespace().take(3).map(|v| v.parse().ok()).collect());
    if state.cpu_max.is_none() {
        state.cpu_max = read_cpu_max();
    }
    json!({
        "frequency": frequency,
        "cores": cores,
        "usage": usage,
        "load": load,
        "maxFrequency": state.cpu_max,
        "name": read_cpu_name(state),
    })
}

fn find_gpu(state: &mut State) -> Option<Gpu> {
    if let Some(found) = &state.gpu {
        return found.clone();
    }
    let mut found: Option<Gpu> = None;
    for entry in entries(PCI) {
        let dir = Path::new(PCI).join(entry);
        if !read(dir.join("class")).is_some_and(|class| class.starts_with("0x03")) {
            continue;
        }
        match read(dir.join("vendor")).as_deref() {
            Some("0x10de") => {
                found = Some(Gpu { dir, nvidia: true });
                break;
            }
            Some("0x1002") if found.is_none() => found = Some(Gpu { dir, nvidia: false }),
            _ => {}
        }
    }
    state.gpu = Some(found.clone());
    found
}

fn nvidia_smi() -> Option<Value> {
    let args = ["--query-gpu=clocks.gr,utilization.gpu,clocks.max.gr", "--format=csv,noheader,nounits"];
    let output = run("nvidia-smi", &args, Duration::from_millis(1500)).ok().filter(|output| output.success)?;
    let mut values = output.stdout.trim().split(',').map(parse_int);
    let mut next = || values.next().flatten();
    Some(json!({ "frequency": next(), "usage": next(), "maxFrequency": next() }))
}

// The driver's model name ("NVIDIA GeForce RTX 5050 Laptop GPU", the name Windows shows). Like nvidia-smi it is only
// read while the dGPU is awake, then kept.
fn read_nvidia_name(state: &mut State, dir: &Path) -> Option<String> {
    if state.gpu_name.is_none() {
        let info = read(Path::new(NVIDIA_GPUS).join(dir.file_name()?).join("information"))?;
        let name = Regex::new(r"(?m)^Model:\s*(.+)$").unwrap().captures(&info)?[1].trim().to_string();
        state.gpu_name = (!name.is_empty()).then_some(name);
    }
    state.gpu_name.clone()
}

fn read_gpu(state: &mut State) -> Value {
    let Some(gpu) = find_gpu(state) else {
        return json!({ "frequency": null, "usage": null, "active": false, "name": null });
    };

    if gpu.nvidia {
        // Never wake a suspended dGPU just to read its clock.
        if read(gpu.dir.join("power/runtime_status")).as_deref() != Some("active") {
            return json!({ "frequency": 0, "usage": 0, "maxFrequency": null, "active": false, "name": state.gpu_name });
        }
        let name = read_nvidia_name(state, &gpu.dir);
        let mut sample = nvidia_smi().unwrap_or_else(|| json!({ "frequency": null, "usage": null, "maxFrequency": null }));
        sample["active"] = json!(true);
        sample["name"] = json!(name);
        return sample;
    }

    let sclk = read(gpu.dir.join("pp_dpm_sclk")).and_then(|text| text.lines().find(|line| line.contains('*')).map(str::to_string));
    json!({
        "frequency": sclk.and_then(|line| line.split(':').nth(1).and_then(parse_int)),
        "usage": read_int(gpu.dir.join("gpu_busy_percent")),
        "active": true,
        "name": null,
    })
}

// systemd-udev's dmi_memory_id copies the SMBIOS memory devices into a world-readable udev record (dmidecode needs root).
fn read_ram_frequency(state: &mut State) -> Option<i64> {
    *state.ram_frequency.get_or_insert_with(|| {
        let record = read(UDEV_DMI).unwrap_or_default();
        let first_speed = |key: &str| {
            Regex::new(&format!(r"(?m)^E:MEMORY_DEVICE_[0-9]+_{key}=([0-9]+)$"))
                .unwrap()
                .captures_iter(&record)
                .filter_map(|found| found[1].parse::<i64>().ok())
                .find(|&speed| speed != 0)
        };
        first_speed("CONFIGURED_SPEED_MTS").or_else(|| first_speed("SPEED_MTS"))
    })
}

fn read_ram(state: &mut State) -> Value {
    let frequency = read_ram_frequency(state);
    let empty = json!({ "usage": null, "used": null, "total": null, "frequency": frequency });
    let Some(info) = read("/proc/meminfo") else { return empty };
    let kb = |key: &str| {
        info.lines().find_map(|line| line.strip_prefix(key)?.strip_prefix(':')).and_then(|rest| {
            let value = rest.trim_start();
            (value.len() < rest.len()).then(|| parse_int(value)).flatten()
        })
    };
    let (Some(total), Some(available)) = (kb("MemTotal").filter(|&kb| kb != 0), kb("MemAvailable")) else { return empty };
    let used = total - available;
    json!({
        "usage": js_round(used as f64 / total as f64 * 1000.0) / 10.0,
        "used": used * 1024,
        "total": total * 1024,
        "frequency": frequency,
    })
}

// Download/upload in kilobits per second since the previous snapshot, per adapter kind like Windows reports them.
// Only physical adapters count (a device link); Wi-Fi ones have a wireless/phy80211 entry.
fn read_network(state: &mut State) -> Value {
    let now = now_ms();
    let mut counters = HashMap::new();
    for name in entries(NET) {
        let dir = Path::new(NET).join(&name);
        if !exists(dir.join("device")) {
            continue;
        }
        let wifi = exists(dir.join("wireless")) || exists(dir.join("phy80211"));
        if !wifi && read(dir.join("type")).as_deref() != Some("1") {
            continue;
        }
        let rx = read_int(dir.join("statistics/rx_bytes"));
        let tx = read_int(dir.join("statistics/tx_bytes"));
        if let (Some(rx), Some(tx)) = (rx, tx) {
            counters.insert(name, NetCounter { wifi, rx, tx });
        }
    }
    // [ethernet, wifi] x [download, upload]
    let mut rates = [[0.0f64; 2]; 2];
    if let Some((time, before)) = &state.last_net {
        let seconds = (now as f64 - *time as f64) / 1000.0;
        if seconds > 0.0 {
            for (name, current) in &counters {
                let Some(before) = before.get(name) else { continue };
                let kind = usize::from(current.wifi);
                rates[kind][0] += ((current.rx - before.rx).max(0) * 8) as f64 / 1000.0 / seconds;
                rates[kind][1] += ((current.tx - before.tx).max(0) * 8) as f64 / 1000.0 / seconds;
            }
        }
    }
    state.last_net = Some((now, counters));
    json!({
        "ethernet": { "download": rates[0][0], "upload": rates[0][1] },
        "wifi": { "download": rates[1][0], "upload": rates[1][1] },
    })
}

// linuwu-sense echoes the last written "cpu,gpu" percentages: 0,0 = auto, 100,100 = max.
pub fn read_fan_mode() -> Value {
    for file in FAN_SPEED {
        let Some(value) = read(file) else { continue };
        let mut parts = value.split(',').map(parse_int);
        let cpu = parts.next().flatten();
        let gpu = parts.next().flatten();
        let mode = match (cpu, gpu) {
            (Some(0), Some(0)) => "auto",
            (Some(100), Some(100)) => "max",
            _ => "custom",
        };
        return json!({ "mode": mode, "cpu": cpu, "gpu": gpu });
    }
    Value::Null
}

pub fn read_power() -> Value {
    let mut ac = None;
    let mut battery = None;
    for entry in entries("/sys/class/power_supply") {
        let dir = Path::new("/sys/class/power_supply").join(entry);
        match read(dir.join("type")).as_deref() {
            Some("Mains") => ac = Some(read(dir.join("online")).as_deref() == Some("1")),
            Some("Battery") => battery = read_int(dir.join("capacity")),
            _ => {}
        }
    }
    json!({ "ac": ac, "battery": battery })
}

// linuwu-sense: Y = the mode key cycles modes, N = it toggles Turbo on/off.
pub fn read_mode_key_cycle() -> Option<bool> {
    read("/sys/module/linuwu_sense/parameters/cycle_gaming_thermal_profile").map(|value| value == "Y" || value == "1")
}

pub fn snapshot() -> Value {
    let mut state = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = &mut *state;
    json!({
        "temps": read_temps(state),
        "fans": read_fans(state),
        "cpu": read_cpu(state),
        "gpu": read_gpu(state),
        "ram": read_ram(state),
        "profile": read(PLATFORM_PROFILE),
        "fanMode": read_fan_mode(),
        "power": read_power(),
        "modeKeyCycle": read_mode_key_cycle(),
        "network": read_network(state),
    })
}
