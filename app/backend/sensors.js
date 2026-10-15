const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const HWMON = "/sys/class/hwmon";
const CPUS = "/sys/devices/system/cpu";
const PCI = "/sys/bus/pci/devices";
const NET = "/sys/class/net";
const NVIDIA_GPUS = "/proc/driver/nvidia/gpus";
const UDEV_DMI = "/run/udev/data/+dmi:id";
const PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
const FAN_SPEED = ["/sys/devices/platform/acer-wmi/nitro_sense/fan_speed", "/sys/devices/platform/acer-wmi/predator_sense/fan_speed"];

async function read(file) {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readInt(file) {
  const value = parseInt(await read(file), 10);
  return Number.isNaN(value) ? null : value;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findHwmon(name) {
  for (const entry of await fs.readdir(HWMON).catch(() => [])) {
    if ((await read(path.join(HWMON, entry, "name"))) === name) return path.join(HWMON, entry);
  }
  return null;
}

let hwmon = null;

async function hwmonPaths() {
  if (!hwmon) hwmon = { acer: await findHwmon("acer"), cpu: await findHwmon("k10temp") || await findHwmon("coretemp") };
  return hwmon;
}

// The EC reports 0 for sensors that are powered down (e.g. a suspended dGPU).
async function temp(dir, index) {
  if (!dir) return null;
  const value = await readInt(path.join(dir, `temp${index}_input`));
  return value ? Math.round(value / 1000) : null;
}

async function readTemps() {
  const { acer, cpu } = await hwmonPaths();
  return {
    cpu: (await temp(acer, 1)) ?? (await temp(cpu, 1)),
    gpu: await temp(acer, 2),
    system: await temp(acer, 3),
  };
}

// count = fan tachometers on the EC (1 on single-fan models, where it is the CPU fan).
let fanCount;

async function readFans() {
  const { acer } = await hwmonPaths();
  if (!acer) return { cpu: null, gpu: null, count: 0 };
  fanCount ??= (await exists(path.join(acer, "fan2_input"))) ? 2 : (await exists(path.join(acer, "fan1_input"))) ? 1 : 0;
  return {
    cpu: await readInt(path.join(acer, "fan1_input")),
    gpu: await readInt(path.join(acer, "fan2_input")),
    count: fanCount,
  };
}

let cpuName;

async function readCpuName() {
  if (cpuName === undefined) {
    cpuName = (await read("/proc/cpuinfo"))?.match(/^model name\s*:\s*(.+)$/m)?.[1].trim() || null;
  }
  return cpuName;
}

let lastStat = null;

async function readCpu() {
  const line = (await read("/proc/stat"))?.split("\n")[0];
  let usage = null;
  if (line) {
    const fields = line.split(/\s+/).slice(1).map(Number);
    const idle = fields[3] + (fields[4] || 0);
    const total = fields.reduce((sum, v) => sum + v, 0);
    if (lastStat && total > lastStat.total) {
      usage = Math.round((1 - (idle - lastStat.idle) / (total - lastStat.total)) * 100);
    }
    lastStat = { idle, total };
  }

  const entries = (await fs.readdir(CPUS).catch(() => [])).filter((e) => /^cpu\d+$/.test(e));
  const freqs = [];
  for (const cpu of entries) {
    const dir = path.join(CPUS, cpu, "cpufreq");
    const khz = (await readInt(path.join(dir, "cpuinfo_avg_freq"))) ?? (await readInt(path.join(dir, "scaling_cur_freq")));
    if (khz) freqs.push(khz);
  }
  const frequency = freqs.length ? Math.round(freqs.reduce((a, b) => a + b, 0) / freqs.length / 1000) : null;
  cpuMax ??= await readCpuMax();
  return { frequency, usage, maxFrequency: cpuMax, name: await readCpuName() };
}

// NitroSense scales the CPU gauge to the SMBIOS "Max Speed" (root-only to read), which install.sh
// stores in /etc/nitrosense/cpu_max_mhz; fall back to the kernel's cpuinfo_max_freq.
let cpuMax;

async function readCpuMax() {
  const smbios = await readInt("/etc/nitrosense/cpu_max_mhz");
  if (smbios) return smbios;
  const khz = await readInt(path.join(CPUS, "cpu0", "cpufreq", "cpuinfo_max_freq"));
  return khz ? Math.round(khz / 1000) : null;
}

let gpuDevice;

async function findGpu() {
  if (gpuDevice !== undefined) return gpuDevice;
  gpuDevice = null;
  for (const entry of await fs.readdir(PCI).catch(() => [])) {
    const dir = path.join(PCI, entry);
    if (!(await read(path.join(dir, "class")))?.startsWith("0x03")) continue;
    const vendor = await read(path.join(dir, "vendor"));
    if (vendor === "0x10de") return (gpuDevice = { dir, vendor: "nvidia" });
    if (vendor === "0x1002" && !gpuDevice) gpuDevice = { dir, vendor: "amd" };
  }
  return gpuDevice;
}

function nvidiaSmi() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=clocks.gr,utilization.gpu,clocks.max.gr", "--format=csv,noheader,nounits"],
      { timeout: 1500 }, (error, stdout) => {
        if (error) return resolve(null);
        const [frequency, usage, maxFrequency] = stdout.trim().split(",").map((v) => parseInt(v, 10));
        resolve({ frequency, usage, maxFrequency });
      });
  });
}

// The driver's model name ("NVIDIA GeForce RTX 5050 Laptop GPU", the name Windows shows). Like nvidia-smi it is only
// read while the dGPU is awake, then kept.
let gpuName = null;

async function readNvidiaName(dir) {
  if (gpuName) return gpuName;
  const info = await read(path.join(NVIDIA_GPUS, path.basename(dir), "information"));
  gpuName = info?.match(/^Model:\s*(.+)$/m)?.[1].trim() || null;
  return gpuName;
}

async function readGpu() {
  const gpu = await findGpu();
  if (!gpu) return { frequency: null, usage: null, active: false, name: null };

  if (gpu.vendor === "nvidia") {
    // Never wake a suspended dGPU just to read its clock.
    if ((await read(path.join(gpu.dir, "power", "runtime_status"))) !== "active") {
      return { frequency: 0, usage: 0, maxFrequency: null, active: false, name: gpuName };
    }
    const [sample, name] = await Promise.all([nvidiaSmi(), readNvidiaName(gpu.dir)]);
    return sample ? { ...sample, active: true, name } : { frequency: null, usage: null, maxFrequency: null, active: true, name };
  }

  const sclk = (await read(path.join(gpu.dir, "pp_dpm_sclk")))?.split("\n").find((l) => l.includes("*"));
  return {
    frequency: sclk ? parseInt(sclk.split(":")[1], 10) : null,
    usage: await readInt(path.join(gpu.dir, "gpu_busy_percent")),
    active: true,
    name: null,
  };
}

// systemd-udev's dmi_memory_id copies the SMBIOS memory devices into a world-readable udev record (dmidecode needs root).
let ramFrequency;

async function readRamFrequency() {
  if (ramFrequency === undefined) {
    const record = (await read(UDEV_DMI)) ?? "";
    const speeds = (key) => [...record.matchAll(new RegExp(`^E:MEMORY_DEVICE_\\d+_${key}=(\\d+)$`, "gm"))]
      .map((match) => Number(match[1])).filter(Boolean);
    ramFrequency = speeds("CONFIGURED_SPEED_MTS")[0] ?? speeds("SPEED_MTS")[0] ?? null;
  }
  return ramFrequency;
}

async function readRam() {
  const [info, frequency] = await Promise.all([read("/proc/meminfo"), readRamFrequency()]);
  if (!info) return { usage: null, used: null, total: null, frequency };
  const kb = (key) => parseInt(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1], 10);
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (!total || Number.isNaN(available)) return { usage: null, used: null, total: null, frequency };
  const used = total - available;
  return { usage: Math.round((used / total) * 1000) / 10, used: used * 1024, total: total * 1024, frequency };
}

// Download/upload in kilobits per second since the previous snapshot, per adapter kind like Windows reports them.
// Only physical adapters count (a device link); Wi-Fi ones have a wireless/phy80211 entry.
let lastNet = null;

async function readNetwork() {
  const now = Date.now();
  const counters = new Map();
  for (const name of await fs.readdir(NET).catch(() => [])) {
    const dir = path.join(NET, name);
    if (!(await exists(path.join(dir, "device")))) continue;
    const wifi = (await exists(path.join(dir, "wireless"))) || (await exists(path.join(dir, "phy80211")));
    if (!wifi && (await read(path.join(dir, "type"))) !== "1") continue;
    const rx = await readInt(path.join(dir, "statistics", "rx_bytes"));
    const tx = await readInt(path.join(dir, "statistics", "tx_bytes"));
    if (rx !== null && tx !== null) counters.set(name, { kind: wifi ? "wifi" : "ethernet", rx, tx });
  }
  const rates = { ethernet: { download: 0, upload: 0 }, wifi: { download: 0, upload: 0 } };
  const seconds = lastNet ? (now - lastNet.time) / 1000 : 0;
  if (seconds > 0) {
    for (const [name, current] of counters) {
      const before = lastNet.counters.get(name);
      if (!before) continue;
      rates[current.kind].download += (Math.max(0, current.rx - before.rx) * 8) / 1000 / seconds;
      rates[current.kind].upload += (Math.max(0, current.tx - before.tx) * 8) / 1000 / seconds;
    }
  }
  lastNet = { time: now, counters };
  return rates;
}

// linuwu-sense echoes the last written "cpu,gpu" percentages: 0,0 = auto, 100,100 = max.
async function readFanMode() {
  for (const file of FAN_SPEED) {
    const value = await read(file);
    if (value === null) continue;
    const [cpu, gpu] = value.split(",").map((v) => parseInt(v, 10));
    const mode = cpu === 0 && gpu === 0 ? "auto" : cpu === 100 && gpu === 100 ? "max" : "custom";
    return { mode, cpu, gpu };
  }
  return null;
}

async function readPower() {
  let ac = null;
  let battery = null;
  for (const entry of await fs.readdir("/sys/class/power_supply").catch(() => [])) {
    const dir = path.join("/sys/class/power_supply", entry);
    const type = await read(path.join(dir, "type"));
    if (type === "Mains") ac = (await read(path.join(dir, "online"))) === "1";
    else if (type === "Battery") battery = await readInt(path.join(dir, "capacity"));
  }
  return { ac, battery };
}

// linuwu-sense: Y = the mode key cycles modes, N = it toggles Turbo on/off.
async function readModeKeyCycle() {
  const value = await read("/sys/module/linuwu_sense/parameters/cycle_gaming_thermal_profile");
  return value === null ? null : value === "Y" || value === "1";
}

async function snapshot() {
  const [temps, fans, cpu, gpu, ram, profile, fanMode, power, modeKeyCycle, network] = await Promise.all([
    readTemps(), readFans(), readCpu(), readGpu(), readRam(), read(PLATFORM_PROFILE), readFanMode(), readPower(),
    readModeKeyCycle(), readNetwork(),
  ]);
  return { temps, fans, cpu, gpu, ram, profile, fanMode, power, modeKeyCycle, network };
}

module.exports = { snapshot, readPower };
