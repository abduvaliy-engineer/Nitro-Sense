const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const HWMON = "/sys/class/hwmon";
const CPUS = "/sys/devices/system/cpu";
const PCI = "/sys/bus/pci/devices";
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

async function readFans() {
  const { acer } = await hwmonPaths();
  if (!acer) return { cpu: null, gpu: null };
  return { cpu: await readInt(path.join(acer, "fan1_input")), gpu: await readInt(path.join(acer, "fan2_input")) };
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
  return { frequency, usage, maxFrequency: cpuMax };
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

async function readGpu() {
  const gpu = await findGpu();
  if (!gpu) return { frequency: null, usage: null, active: false };

  if (gpu.vendor === "nvidia") {
    // Never wake a suspended dGPU just to read its clock.
    if ((await read(path.join(gpu.dir, "power", "runtime_status"))) !== "active") {
      return { frequency: 0, usage: 0, maxFrequency: null, active: false };
    }
    const sample = await nvidiaSmi();
    return sample ? { ...sample, active: true } : { frequency: null, usage: null, maxFrequency: null, active: true };
  }

  const sclk = (await read(path.join(gpu.dir, "pp_dpm_sclk")))?.split("\n").find((l) => l.includes("*"));
  return {
    frequency: sclk ? parseInt(sclk.split(":")[1], 10) : null,
    usage: await readInt(path.join(gpu.dir, "gpu_busy_percent")),
    active: true,
  };
}

async function readRam() {
  const info = await read("/proc/meminfo");
  if (!info) return { usage: null, used: null, total: null };
  const kb = (key) => parseInt(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1], 10);
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (!total || Number.isNaN(available)) return { usage: null, used: null, total: null };
  const used = total - available;
  return { usage: Math.round((used / total) * 1000) / 10, used: used * 1024, total: total * 1024 };
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
  const [temps, fans, cpu, gpu, ram, profile, fanMode, power, modeKeyCycle] = await Promise.all([
    readTemps(), readFans(), readCpu(), readGpu(), readRam(), read(PLATFORM_PROFILE), readFanMode(), readPower(),
    readModeKeyCycle(),
  ]);
  return { temps, fans, cpu, gpu, ram, profile, fanMode, power, modeKeyCycle };
}

module.exports = { snapshot };
