const fs = require("fs/promises");
const { constants } = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DMI = "/sys/class/dmi/id";
const POWER = "/sys/class/power_supply";
const HIDRAW = "/sys/class/hidraw";
const SENSE_DIRS = ["/sys/devices/platform/acer-wmi/nitro_sense", "/sys/devices/platform/acer-wmi/predator_sense"];
const ENEK5130_ID = "0CF2:5130";

async function read(file) {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function accessible(file, mode) {
  try {
    await fs.access(file, mode);
    return true;
  } catch {
    return false;
  }
}

async function battery() {
  for (const entry of await fs.readdir(POWER).catch(() => [])) {
    const dir = path.join(POWER, entry);
    if ((await read(path.join(dir, "type"))) !== "Battery") continue;
    const num = async (name) => {
      const value = parseInt(await read(path.join(dir, name)), 10);
      return Number.isNaN(value) ? null : value;
    };
    const full = (await num("charge_full")) ?? (await num("energy_full"));
    const design = (await num("charge_full_design")) ?? (await num("energy_full_design"));
    return {
      capacity: await num("capacity"),
      status: await read(path.join(dir, "status")),
      cycles: await num("cycle_count"),
      health: full && design ? Math.round((full / design) * 100) : null,
    };
  }
  return null;
}

async function keyboardDevice() {
  for (const entry of await fs.readdir(HIDRAW).catch(() => [])) {
    const uevent = (await read(path.join(HIDRAW, entry, "device", "uevent"))) || "";
    if (uevent.toUpperCase().includes(ENEK5130_ID)) return `/dev/${entry}`;
  }
  return null;
}

async function info() {
  let senseDir = null;
  for (const dir of SENSE_DIRS) if (await accessible(dir, constants.F_OK)) senseDir = dir;
  const keyboard = await keyboardDevice();
  const limiter = senseDir ? await read(path.join(senseDir, "battery_limiter")) : null;

  return {
    model: await read(path.join(DMI, "product_name")),
    biosVersion: await read(path.join(DMI, "bios_version")),
    biosDate: await read(path.join(DMI, "bios_date")),
    battery: await battery(),
    chargeLimit: limiter === null ? null : limiter === "1",
    driver: {
      loaded: await accessible("/sys/module/linuwu_sense", constants.F_OK),
      writable: senseDir ? await accessible(path.join(senseDir, "fan_speed"), constants.W_OK) : false,
    },
    keyboard: {
      device: keyboard,
      writable: keyboard ? await accessible(keyboard, constants.R_OK | constants.W_OK) : false,
    },
  };
}

// Like NitroSense, restarts at once (logind lets the active session's user reboot without a password).
function restart() {
  return new Promise((resolve, reject) => {
    execFile("systemctl", ["reboot"], (error, _stdout, stderr) => {
      if (error) reject(new Error(`Restart failed: ${(stderr || error.message).trim()}. The GPU mode changes at the next restart.`));
      else resolve();
    });
  });
}

module.exports = { info, restart };
