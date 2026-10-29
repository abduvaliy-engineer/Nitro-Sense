const fs = require("fs/promises");
const path = require("path");

const PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
const PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";
const SENSE_DIRS = ["/sys/devices/platform/acer-wmi/nitro_sense", "/sys/devices/platform/acer-wmi/predator_sense"];

async function write(file, value) {
  try {
    await fs.writeFile(file, `${value}\n`);
  } catch (error) {
    if (error.code === "EACCES") throw new Error(`No permission to write ${file}. Run install.sh to grant the linuwu_sense group access.`);
    throw new Error(`Driver rejected ${value}: ${error.message}`);
  }
}

async function senseFile(name) {
  for (const dir of SENSE_DIRS) {
    try {
      await fs.access(`${dir}/${name}`);
      return `${dir}/${name}`;
    } catch {
      // try the next layout
    }
  }
  throw new Error("linuwu-sense controls are not available");
}

// Rewriting the current mode still notifies the kernel's listeners, so only real changes are written.
async function setProfile(profile) {
  const choices = (await fs.readFile(PLATFORM_PROFILE_CHOICES, "utf8")).trim().split(/\s+/);
  if (!choices.includes(profile)) throw new Error(`Unsupported power mode: ${profile}`);
  if ((await fs.readFile(PLATFORM_PROFILE, "utf8")).trim() === profile) return;
  await write(PLATFORM_PROFILE, profile);
}

// 0,0 = automatic, 100,100 = maximum, anything else = custom percentages.
async function setFanSpeed(cpu, gpu) {
  const values = [cpu, gpu].map((v) => Math.round(Number(v)));
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error("Fan speeds must be 0-100%");
  await write(await senseFile("fan_speed"), values.join(","));
}

async function setModeKeyCycle(cycle) {
  await write("/sys/module/linuwu_sense/parameters/cycle_gaming_thermal_profile", cycle ? "Y" : "N");
}

// Personal Settings: the linuwu-sense attributes and the values each accepts.
const PERSONAL = {
  battery_limiter: [0, 1], // 1 = charge to 80 % (Optimized Battery Charging)
  usb_charging: [0, 10, 20, 30], // power-off USB charging, stopping at that battery level; 0 = off
  lcd_override: [0, 1], // LCD Overdrive
  backlight_timeout: [0, 1], // keyboard backlight off after 30 s
  boot_animation_sound: [0, 1],
};

// GPU Operating: linuwu-sense's gpu_mode reads 0 Optimus, 1 NVIDIA GPU only or 2 Automatic Selection, and takes
// 0 or 1. The firmware switches at the next boot.
const GPU_MODES = [0, 1];

// Without gpu_mode in the driver: the mode from the GPU that drives the connected laptop panel (in NVIDIA GPU only
// mode the AMD panel connector stays listed, disconnected). null when no panel is connected.
async function panelGpuMode() {
  for (const connector of await fs.readdir("/sys/class/drm").catch(() => [])) {
    const card = /^(card\d+)-eDP-/.exec(connector)?.[1];
    if (!card) continue;
    const status = await fs.readFile(`/sys/class/drm/${connector}/status`, "utf8").catch(() => "");
    if (status.trim() !== "connected") continue;
    const driver = path.basename(await fs.readlink(`/sys/class/drm/${card}/device/driver`).catch(() => ""));
    return /^(nvidia|nouveau)$/.test(driver) ? 1 : 0;
  }
  return null;
}

async function readGpuMode() {
  try {
    const mode = parseInt(await fs.readFile(await senseFile("gpu_mode"), "utf8"), 10);
    if ([0, 1, 2].includes(mode)) return { mode, settable: true };
  } catch {
    // this linuwu-sense has no gpu_mode
  }
  return { mode: await panelGpuMode(), settable: false };
}

async function setGpuMode(mode) {
  if (!GPU_MODES.includes(mode)) throw new Error(`Unsupported GPU mode: ${mode}`);
  await write(await senseFile("gpu_mode"), mode);
}

// Current values; an attribute this model lacks reads as null.
async function readPersonal() {
  const values = {};
  for (const name of Object.keys(PERSONAL)) {
    try {
      const value = parseInt(await fs.readFile(await senseFile(name), "utf8"), 10);
      values[name] = Number.isNaN(value) ? null : value;
    } catch {
      values[name] = null;
    }
  }
  const gpu = await readGpuMode();
  values.gpu_mode = gpu.mode;
  values.gpu_mode_settable = gpu.settable;
  return values;
}

async function setPersonal(name, value) {
  if (!PERSONAL[name]?.includes(value)) throw new Error(`Unsupported setting: ${name} = ${value}`);
  await write(await senseFile(name), value);
}

module.exports = { write, senseFile, setProfile, setFanSpeed, setModeKeyCycle, readPersonal, setPersonal, setGpuMode };
