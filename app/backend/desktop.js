// Desktop entries (.desktop files) and their icons, shared by App Shortcut and App Sync.
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const DATA_DIRS = [
  process.env.XDG_DATA_HOME || path.join(HOME, ".local/share"),
  ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
  path.join(HOME, ".local/share/flatpak/exports/share"),
  "/var/lib/flatpak/exports/share",
  "/var/lib/snapd/desktop",
];

// The [Desktop Entry] group's keys; localized keys (Name[fr]) are skipped.
function parseEntry(text) {
  const entry = {};
  let inMain = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) inMain = line.trim() === "[Desktop Entry]";
    else if (inMain && line.includes("=")) {
      const [key, ...rest] = line.split("=");
      const name = key.trim();
      if (!name.includes("[") && !(name in entry)) entry[name] = rest.join("=").trim();
    }
  }
  return entry;
}

function described(id, file, entry) {
  if (entry.Hidden === "true" || !entry.Exec) return null;
  return { id, file, entry, name: entry.Name || id, icon: entry.Icon, exec: entry.Exec, terminal: entry.Terminal === "true" };
}

async function readEntry(id) {
  for (const dir of DATA_DIRS) {
    const file = path.join(dir, "applications", id);
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text !== null) return described(id, file, parseEntry(text));
  }
  // Entries in subdirectories: "wine-Programs-X.desktop" is wine/Programs/X.desktop.
  const found = (await allEntries()).find((item) => item.id === id);
  return found ? described(id, found.file, found.entry) : null;
}

// Every desktop entry, keyed by desktop-file ID (subdirectories join with "-"); the first data dir wins.
async function allEntries() {
  const found = new Map();
  async function walk(base, dir) {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(base, full);
      else if (item.name.endsWith(".desktop")) {
        const id = path.relative(base, full).split(path.sep).join("-");
        if (found.has(id)) continue;
        try {
          const [text, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
          found.set(id, { id, file: full, entry: parseEntry(text), installed: stat.birthtimeMs || stat.mtimeMs });
        } catch {
          // unreadable entry
        }
      }
    }
  }
  for (const dir of DATA_DIRS) await walk(path.join(dir, "applications"), path.join(dir, "applications"));
  return [...found.values()];
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

// ---------- icons ----------

async function iconTheme() {
  for (const file of [path.join(HOME, ".config/gtk-4.0/settings.ini"), path.join(HOME, ".config/gtk-3.0/settings.ini")]) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const name = /^gtk-icon-theme-name\s*=\s*(.+)$/m.exec(text)?.[1].trim();
    if (name) return name;
  }
  return null;
}

// Icon name → best file, from the user's theme, the themes it inherits, hicolor and Adwaita (largest first).
let iconIndex = null;
function buildIconIndex() {
  iconIndex ??= (async () => {
    const index = new Map();
    const themes = [];
    const queue = [await iconTheme(), "hicolor", "Adwaita"].filter(Boolean);
    while (queue.length) {
      const theme = queue.shift();
      if (themes.includes(theme)) continue;
      themes.push(theme);
      for (const dir of DATA_DIRS) {
        const text = await fs.readFile(path.join(dir, "icons", theme, "index.theme"), "utf8").catch(() => "");
        const inherits = /^Inherits\s*=\s*(.+)$/m.exec(text)?.[1];
        if (inherits) queue.splice(queue.length - 2, 0, ...inherits.split(",").map((t) => t.trim()).filter(Boolean));
      }
    }
    const rank = (size) => (size === "scalable" ? 10000 : parseInt(size, 10) * (size.includes("@2x") ? 2 : 1) || 0);
    for (const theme of themes) {
      for (const dir of [...DATA_DIRS.map((d) => path.join(d, "icons", theme)), path.join(HOME, ".icons", theme)]) {
        const sizes = await fs.readdir(dir).catch(() => []);
        for (const size of sizes.filter((s) => rank(s) >= 32 || s === "scalable").sort((a, b) => rank(b) - rank(a))) {
          const contexts = await fs.readdir(path.join(dir, size)).catch(() => []);
          for (const context of contexts) {
            const files = await fs.readdir(path.join(dir, size, context)).catch(() => []);
            for (const file of files) {
              const match = /^(.+)\.(svg|png)$/.exec(file);
              if (match && !index.has(match[1])) index.set(match[1], path.join(dir, size, context, file));
            }
          }
        }
      }
    }
    for (const file of await fs.readdir("/usr/share/pixmaps").catch(() => [])) {
      const match = /^(.+)\.(svg|png|xpm)$/.exec(file);
      if (match && match[2] !== "xpm" && !index.has(match[1])) index.set(match[1], path.join("/usr/share/pixmaps", file));
    }
    return index;
  })();
  return iconIndex;
}

const iconCache = new Map();
async function iconDataUrl(icon) {
  if (!icon) return null;
  if (iconCache.has(icon)) return iconCache.get(icon);
  const file = path.isAbsolute(icon) ? icon : (await buildIconIndex()).get(icon);
  const type = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" }[
    /\.(\w+)$/.exec(file ?? "")?.[1].toLowerCase()];
  let url = null;
  if (type) {
    try {
      url = `data:${type};base64,${(await fs.readFile(file)).toString("base64")}`;
    } catch {
      // missing file
    }
  }
  iconCache.set(icon, url);
  return url;
}

function refreshIcons() {
  iconIndex = null;
  iconCache.clear();
}

module.exports = { DATA_DIRS, parseEntry, readEntry, allEntries, execArgs, iconDataUrl, refreshIcons };
