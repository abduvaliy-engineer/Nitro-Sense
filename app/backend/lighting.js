// Keyboard lighting (Pulsar Lighting): ENEK5130 HID keyboards through enek-write.py, or linuwu-sense's
// four_zoned_kb on other models. Values follow Acer's Windows lighting service (AcerAgentService and
// its OpenRGB keyboard controller), so the same profile looks the same as on Windows.
const fs = require("fs/promises");
const { constants: fsConstants } = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { write } = require("./controls");

const FOUR_ZONE_DIR = "/sys/devices/platform/acer-wmi/four_zoned_kb";
const HELPER = path.join(__dirname, "enek-write.py");
const KEYBOARD_ID = 0x21;
const ALL_ZONES = 0x0f;
const ENEK_OPMODE = 0x06;
const THROTTLE_MS = 150; // the service's minimum gap between keyboard updates
const FLASH_HOLD_MS = 1600; // after a mode flash the service holds other updates for 1.55 s

// value = Acer mode (also linuwu's four_zone_mode), enek = ENEK5130 effect byte, color = sends an RGB.
const EFFECTS = {
  STATIC: { value: 0, enek: 0x02, color: true },
  BREATHING: { value: 1, enek: 0x04, color: true },
  NEON: { value: 2, enek: 0x05, color: false },
  WAVE: { value: 3, enek: 0x07, color: false },
  SHIFTING: { value: 4, enek: 0x08, color: true },
  ZOOM: { value: 5, enek: 0x09, color: true },
  METEOR: { value: 6, enek: 0x0a, color: true },
  TWINKLING: { value: 7, enek: 0x0b, color: true },
};

// AcerAgentService's mode-change colors, by platform_profile.
const FLASH_COLORS = {
  quiet: "#ffffff",
  balanced: "#00aec7",
  "balanced-performance": "#2e09c7",
  performance: "#c700ff",
  "low-power": "#10dc00",
};

const level = (value, fallback) => (Number.isFinite(value) ? Math.min(5, Math.max(1, Math.round(value))) : fallback);
// NitroSense levels 1-5 → brightness 0/25/50/75/100 and speed 1/3/5/7/9.
const brightnessByte = (brightness) => (level(brightness, 5) - 1) * 25;
const speedByte = (speed) => level(speed, 3) * 2 - 1;
const hex6 = (color) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color.slice(1).toLowerCase() : "000000");
const rgb = (color) => {
  const n = parseInt(hex6(color), 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff];
};

// The keyboard shows the Global effect, or its own effect in Area mode. Unknown effects fall back to Neon,
// as in NitroSense. Area Static carries the four zone colors.
function plan(lighting) {
  const source = lighting?.mode === "area" ? lighting.keyboard : lighting?.global;
  if (!source) throw new Error("Lighting settings are missing");
  const name = EFFECTS[source.effect] ? source.effect : "NEON";
  const effect = EFFECTS[name];
  return {
    effect,
    brightness: brightnessByte(source.brightness),
    speed: name === "STATIC" ? 0 : speedByte(source.speed),
    direction: name === "STATIC" ? 0 : source.direction === 2 ? 2 : 1,
    color: effect.color ? source.color : null,
    zones: name === "STATIC" && lighting.mode === "area" ? [0, 1, 2, 3].map((i) => source.zones?.[i]) : null,
  };
}

// HID feature report A4: id, effect, brightness, speed, direction, R, G, B, zone mask (u16 LE).
const enekReport = (effect, brightness, speed, direction, color, mask) =>
  [0xa4, KEYBOARD_ID, effect, brightness, speed, direction, ...rgb(color), mask & 0xff, mask >> 8];

function enekReports(lighting) {
  const p = plan(lighting);
  if (p.zones) return p.zones.map((zone, i) => enekReport(p.effect.enek, p.brightness, 0, 0, zone, 1 << i));
  return [enekReport(p.effect.enek, p.brightness, p.speed, p.direction, p.color, ALL_ZONES)];
}

// linuwu-sense: four_zone_mode "mode,speed,brightness,direction,r,g,b"; per_zone_mode "RRGGBB x4,brightness".
function fourZoneWrites(lighting) {
  const p = plan(lighting);
  if (p.zones) return [["per_zone_mode", `${p.zones.map(hex6).join(",")},${p.brightness}`]];
  return [["four_zone_mode", [p.effect.value, p.speed, p.brightness, p.direction, ...rgb(p.color)].join(",")]];
}

// Windows sends OPMODE at brightness 0, which the firmware ignores; 100 keeps the flash visible either way.
// four_zoned_kb has no OPMODE, so a static color stands in for it.
const flashPayload = (type, color) => (type === "enek"
  ? [enekReport(ENEK_OPMODE, 100, 0, 2, color, ALL_ZONES)]
  : [["four_zone_mode", [0, 0, 100, 0, ...rgb(color)].join(",")]]);

const encode = (type, lighting) => (type === "enek" ? enekReports(lighting) : fourZoneWrites(lighting));

// ---------- device ----------

async function findEnek() {
  const names = await fs.readdir("/sys/class/hidraw").catch(() => []);
  for (const name of names) {
    const uevent = await fs.readFile(`/sys/class/hidraw/${name}/device/uevent`, "utf8").catch(() => "");
    if (/^HID_ID=\w+:00000CF2:00005130$/im.test(uevent)) return `/dev/${name}`;
  }
  return null;
}

async function detect() {
  const device = await findEnek();
  if (device) return { type: "enek", device };
  try {
    await fs.access(`${FOUR_ZONE_DIR}/four_zone_mode`);
    return { type: "four_zone", device: FOUR_ZONE_DIR };
  } catch {
    return null;
  }
}

let backend; // undefined until detected, null when the laptop has no supported lighting
async function getBackend(refresh = false) {
  if (backend === undefined || refresh) backend = await detect();
  return backend;
}

function sendEnek(device, reports) {
  const hex = reports.map((report) => Buffer.from(report).toString("hex"));
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", HELPER, device, ...hex], { timeout: 3000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if (error.code === "ENOENT" && error.path === "python3") return reject(new Error("Keyboard lighting needs python3"));
      const code = /^(E[A-Z]+):/m.exec(stderr)?.[1];
      const message = code === "EACCES"
        ? `No permission to use the keyboard lighting (${device}). Run install.sh to grant the linuwu_sense group access.`
        : `Keyboard lighting failed: ${stderr.trim() || error.message}`;
      reject(Object.assign(new Error(message), { code }));
    });
  });
}

async function writeFourZone(writes) {
  for (const [file, value] of writes) await write(`${FOUR_ZONE_DIR}/${file}`, value);
}

// The hidraw number can change after resume, so a vanished device is looked up once more.
async function send(payloadFor) {
  for (let attempt = 0; ; attempt++) {
    const found = await getBackend(attempt > 0);
    if (!found) return;
    try {
      const payload = payloadFor(found.type);
      return await (found.type === "enek" ? sendEnek(found.device, payload) : writeFourZone(payload));
    } catch (error) {
      if (error.code !== "ENOENT" || attempt > 0) throw error;
    }
  }
}

// ---------- queue ----------

let target = null; // the lighting the keyboard should show; the latest apply wins
let chain = Promise.resolve();
let queued = null;
let lastWrite = 0;
let holdUntil = 0;
let holdTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueue(job) {
  const run = chain.then(async () => {
    const wait = lastWrite + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      await job();
    } finally {
      lastWrite = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

function schedule() {
  queued ??= enqueue(() => {
    queued = null;
    return send((type) => encode(type, target));
  });
  return queued;
}

function apply(lighting) {
  plan(lighting);
  target = lighting;
  if (Date.now() < holdUntil) return Promise.resolve(); // sent when the mode flash ends
  return schedule();
}

// Mode change: flash the mode color, then show the profile's lighting again.
function flash(profile) {
  const color = FLASH_COLORS[profile];
  if (!color || !target) return;
  holdUntil = Date.now() + FLASH_HOLD_MS;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdUntil = 0;
    schedule().catch((error) => console.error("restoring lighting failed", error.message));
  }, FLASH_HOLD_MS);
  enqueue(() => send((type) => flashPayload(type, color)))
    .catch((error) => console.error("mode flash failed", error.message));
}

async function hasCommand(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    try {
      await fs.access(path.join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

async function info() {
  const found = await getBackend();
  return { backend: found?.type ?? null, picker: await hasCommand("hyprpicker") };
}

// Eyedropper: hyprpicker prints the picked color, or nothing when cancelled with Escape.
function pickColor() {
  return new Promise((resolve) => {
    execFile("hyprpicker", ["-f", "hex", "-l", "-b", "-q"], { timeout: 60000 }, (_error, stdout) => {
      resolve(/#[0-9a-f]{6}/i.exec(stdout ?? "")?.[0].toLowerCase() ?? null);
    });
  });
}

module.exports = { info, apply, flash, pickColor, encode, flashPayload, EFFECTS, FLASH_COLORS };
