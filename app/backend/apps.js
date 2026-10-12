// Apps that can be linked to a scenario profile (NitroSense's "Add Apps to Link" list): desktop entries,
// installed Steam games and files the user picked. A linked app is stored as a small reference:
//   { key, kind: "desktop" | "steam" | "file", name, desktopId? , steamAppId?, path? }
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { dialog } = require("electron");
const { allEntries, readEntry, execArgs, iconDataUrl, refreshIcons } = require("./desktop");

const HOME = os.homedir();
const USER_APPS_KEY = "appSync.userApps";
const STEAM_ROOTS = [
  path.join(HOME, ".local/share/Steam"),
  path.join(HOME, ".steam/steam"),
  path.join(HOME, ".var/app/com.valvesoftware.Steam/.local/share/Steam"),
];
// Steam installs these like games; they are runtimes, not apps.
const STEAM_TOOLS = /^(Proton|Steam Linux Runtime|Steamworks Common Redistributables)/i;
const OWN_ENTRIES = new Set(["nitrosense.desktop"]);

let settings = null;
function init(store) {
  settings = store;
}

const desktopRef = (id, name) => ({ key: `desktop:${id}`, kind: "desktop", name, desktopId: id });
const steamRef = (appid, name) => ({ key: `steam:${appid}`, kind: "steam", name, steamAppId: Number(appid) });
const fileRef = (file) => ({ key: `file:${file}`, kind: "file", name: path.basename(file).replace(/\.(exe|appimage)$/i, ""), path: file });

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function onPath(program) {
  if (program.includes("/")) return exists(program);
  for (const dir of (process.env.PATH ?? "").split(":")) if (await exists(path.join(dir, program))) return true;
  return false;
}

const desktops = () => (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").filter(Boolean);
const listed = (value) => (value ?? "").split(";").filter(Boolean);

// The entries a launcher would show (NitroSense lists the Start menu the same way).
async function launcherEntries() {
  const current = desktops();
  const result = [];
  for (const item of await allEntries()) {
    const { entry } = item;
    if ((entry.Type && entry.Type !== "Application") || !entry.Exec) continue;
    if (entry.NoDisplay === "true" || entry.Hidden === "true" || OWN_ENTRIES.has(item.id)) continue;
    const only = listed(entry.OnlyShowIn);
    if (only.length && !only.some((d) => current.includes(d))) continue;
    if (listed(entry.NotShowIn).some((d) => current.includes(d))) continue;
    if (entry.TryExec && !(await onPath(entry.TryExec))) continue;
    result.push(item);
  }
  return result;
}

// ---------- Steam ----------

function vdfValues(text, key) {
  return [...text.matchAll(new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, "g"))].map((m) => m[1].replace(/\\\\/g, "\\"));
}

async function steamGames() {
  const games = new Map();
  for (const root of STEAM_ROOTS) {
    const folders = await fs.readFile(path.join(root, "steamapps/libraryfolders.vdf"), "utf8").catch(() => "");
    for (const library of new Set([root, ...vdfValues(folders, "path")])) {
      const dir = path.join(library, "steamapps");
      for (const file of await fs.readdir(dir).catch(() => [])) {
        if (!/^appmanifest_\d+\.acf$/.test(file)) continue;
        const text = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
        const [appid] = vdfValues(text, "appid");
        const [name] = vdfValues(text, "name");
        if (!appid || !name || STEAM_TOOLS.test(name) || games.has(appid)) continue;
        const [updated] = vdfValues(text, "LastUpdated");
        games.set(appid, { appid, name, root, installed: Number(updated) * 1000 || 0 });
      }
    }
  }
  return [...games.values()];
}

async function steamIcon(game) {
  const cache = path.join(game.root, "appcache/librarycache", game.appid);
  const files = await fs.readdir(cache).catch(() => []);
  const icon = files.find((file) => /^[0-9a-f]{40}\.jpg$/.test(file));
  return (icon && iconDataUrl(path.join(cache, icon))) || iconDataUrl(`steam_icon_${game.appid}`);
}

const steamLaunch = (exec) => /steam:\/\/rungameid\/(\d+)/.exec(exec ?? "")?.[1];

// ---------- list / resolve / pick ----------

const userApps = async () => (await settings?.get(USER_APPS_KEY)) ?? [];

// Everything the Add Apps dialog offers: { ...ref, icon, game, installed }.
async function list() {
  const items = new Map();
  for (const game of await steamGames()) {
    items.set(`steam:${game.appid}`, { ...steamRef(game.appid, game.name), game: true, installed: game.installed, icon: steamIcon(game) });
  }
  for (const item of await launcherEntries()) {
    const { entry } = item;
    const appid = steamLaunch(entry.Exec);
    const game = /(^|;)Game(;|$)/.test(entry.Categories ?? "") || Boolean(appid);
    const ref = appid ? steamRef(appid, entry.Name || item.id) : desktopRef(item.id, entry.Name || item.id);
    if (items.has(ref.key)) continue;
    items.set(ref.key, { ...ref, game, installed: item.installed, icon: iconDataUrl(entry.Icon) });
  }
  for (const ref of await userApps()) {
    if (items.has(ref.key) || !(await exists(ref.path))) continue;
    const stat = await fs.stat(ref.path).catch(() => null);
    items.set(ref.key, { ...ref, game: false, installed: stat?.birthtimeMs || stat?.mtimeMs || 0, icon: null });
  }
  const result = [...items.values()];
  await Promise.all(result.map(async (item) => { item.icon = await item.icon; }));
  return result;
}

// Name, icon and whether a linked app still exists (NitroSense's "File Path Missing").
async function resolve(refs) {
  const games = refs.some((ref) => ref.kind === "steam") ? await steamGames() : [];
  return Promise.all((refs ?? []).map(async (ref) => {
    if (ref.kind === "desktop") {
      const found = await readEntry(ref.desktopId);
      return { key: ref.key, name: found?.name ?? ref.name, icon: found ? await iconDataUrl(found.icon) : null, missing: !found, source: ref.desktopId };
    }
    if (ref.kind === "steam") {
      const game = games.find((g) => Number(g.appid) === ref.steamAppId);
      const entry = game ? null : (await launcherEntries()).find((item) => Number(steamLaunch(item.entry.Exec)) === ref.steamAppId);
      return {
        key: ref.key,
        name: game?.name ?? entry?.entry.Name ?? ref.name,
        icon: game ? await steamIcon(game) : entry ? await iconDataUrl(entry.entry.Icon) : null,
        missing: !game && !entry,
        source: `steam://rungameid/${ref.steamAppId}`,
      };
    }
    return { key: ref.key, name: ref.name, icon: null, missing: !(await exists(ref.path)), source: ref.path };
  }));
}

// "Cannot find app?": an executable, AppImage or Windows .exe the list doesn't have.
async function pickFile(win) {
  const result = await dialog.showOpenDialog(win, { title: "Add Apps to Link", properties: ["openFile"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = await fs.realpath(result.filePaths[0]);
  if (file.startsWith(path.dirname(__dirname)) || file === process.execPath) return { exists: true };
  const known = await list();
  if (known.some((item) => item.key === `file:${file}`)) return { exists: true };
  for (const item of known.filter((i) => i.kind === "desktop")) {
    const found = await readEntry(item.desktopId);
    const program = found && execArgs(found.exec)[0];
    if (program && (await fs.realpath(program).catch(() => program)) === file) return { exists: true };
  }
  const ref = fileRef(file);
  await settings?.set(USER_APPS_KEY, [...(await userApps()), ref]);
  return { ref };
}

function refresh() {
  refreshIcons();
}

module.exports = { init, list, resolve, pickFile, refresh, steamGames, launcherEntries, steamLaunch };
