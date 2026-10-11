const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// One slot per role; the first installed desktop entry in each slot is shown.
const SLOTS = [
  ["nvidia-settings.desktop"],
  [
    "io.missioncenter.MissionCenter.desktop",
    "net.nokyan.Resources.desktop",
    "org.gnome.SystemMonitor.desktop",
    "gnome-system-monitor.desktop",
    "btop.desktop",
    "htop.desktop",
  ],
];

const HOME = os.homedir();
const DATA_DIRS = [
  process.env.XDG_DATA_HOME || path.join(HOME, ".local/share"),
  ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
  path.join(HOME, ".local/share/flatpak/exports/share"),
  "/var/lib/flatpak/exports/share",
];
const ICON_SIZES = ["scalable", "512x512", "256x256", "128x128", "96x96", "64x64", "48x48"];

async function readEntry(id) {
  for (const dir of DATA_DIRS) {
    const file = path.join(dir, "applications", id);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const entry = {};
    let inMain = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("[")) inMain = line.trim() === "[Desktop Entry]";
      else if (inMain && line.includes("=")) {
        const [key, ...rest] = line.split("=");
        if (!(key in entry)) entry[key.trim()] = rest.join("=").trim();
      }
    }
    if (entry.Hidden === "true" || !entry.Exec) return null;
    return { id, file, name: entry.Name || id, icon: entry.Icon, exec: entry.Exec, terminal: entry.Terminal === "true" };
  }
  return null;
}

async function iconDataUrl(icon) {
  if (!icon) return null;
  const candidates = [];
  if (path.isAbsolute(icon)) candidates.push(icon);
  for (const dir of DATA_DIRS) {
    for (const theme of ["hicolor", "Adwaita"]) {
      for (const size of ICON_SIZES) {
        for (const ext of ["svg", "png"]) candidates.push(path.join(dir, "icons", theme, size, "apps", `${icon}.${ext}`));
      }
    }
  }
  candidates.push(`/usr/share/pixmaps/${icon}.png`, `/usr/share/pixmaps/${icon}.svg`);
  for (const file of candidates) {
    try {
      const data = await fs.readFile(file);
      const type = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
      return `data:${type};base64,${data.toString("base64")}`;
    } catch {
      // try the next location
    }
  }
  return null;
}

async function list() {
  const shortcuts = [];
  for (const slot of SLOTS) {
    for (const id of slot) {
      const entry = await readEntry(id);
      if (!entry) continue;
      shortcuts.push({ id, name: entry.name, icon: await iconDataUrl(entry.icon) });
      break;
    }
  }
  return shortcuts;
}

// Drop desktop-entry field codes and split the Exec line like a shell would (quotes only).
function execArgs(exec) {
  const args = [];
  for (const match of exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const arg = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2];
    if (!/^%[fFuUdDnNickvm]$/.test(arg)) args.push(arg);
  }
  return args;
}

async function launch(id) {
  if (!SLOTS.flat().includes(id)) throw new Error(`unknown shortcut: ${id}`);
  const entry = await readEntry(id);
  if (!entry) throw new Error(`${id} is not installed`);
  const args = execArgs(entry.exec);
  const command = entry.terminal ? ["xdg-terminal-exec", ...args] : args;
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

module.exports = { list, launch };
