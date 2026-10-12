// App Sync (NitroSense Scenario.ChangeProfile): while a linked app is in front, its profile is applied;
// any other window in front (NitroSense's own too) brings back the profile the user picked. Hyprland
// reports focus; without it the most recently started running linked app counts.
const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const { readEntry, execArgs } = require("./desktop");
const { readPower } = require("./sensors");

const POLL_MS = 3000; // NitroSense AppWatcherTime
const SETTLE_MS = 3000; // a focus change must hold this long, so alt-tabbing doesn't switch profiles

// Programs that never identify an app on their own (they run many apps).
const GENERIC = /^(env|sh|bash|dash|zsh|fish|python[\d.]*|node|nodejs|electron\d*|java|dotnet|mono|wine\d*|wine-preloader|wine64-preloader|wineserver|steam|steamwebhelper|reaper|pressure-vessel.*|srt-bwrap|bwrap|flatpak|xdg-dbus-proxy|systemd|uwsm.*|gtk-launch|xdg-terminal-exec|foot|footclient|kitty|alacritty|ghostty|chromium|chrome|google-chrome.*|brave.*|firefox|soffice\.bin|libreoffice)$/i;
// Launch prefixes stripped from Exec lines (NitroSense matches the real target).
const PREFIXES = new Set(["setsid", "prime-run", "primusrun", "optirun", "pvkrun", "gamemoderun", "mangohud", "obs-gamecapture", "dbus-run-session", "app2unit"]);
const INTERPRETERS = /^(electron\d*|java|dotnet|mono|python[\d.]*|node|nodejs|sh|bash|dash|zsh|wine\d*)$/i;

let notify = () => {};
let config = null; // { active, select, profiles: [{ name, appSync, apps }] }
let links = []; // [{ index, enabled, matcher }]
let last; // desired profile name (null = the user's own) from the last switch
let pending; // desired value waiting to settle
let settleTimer = null;
let pollTimer = null;
let focus = null; // { pid, class, initialClass } of the window in front (Hyprland)
let hyprland = null;

// ---------- processes ----------

const procs = new Map(); // pid → { start, info }

async function procInfo(pid) {
  const dir = `/proc/${pid}`;
  try {
    const [stat, exe, cmdline, cgroup] = await Promise.all([
      fs.readFile(`${dir}/stat`, "utf8"),
      fs.readlink(`${dir}/exe`),
      fs.readFile(`${dir}/cmdline`, "utf8"),
      fs.readFile(`${dir}/cgroup`, "utf8").catch(() => ""),
    ]);
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return {
      pid,
      ppid: Number(fields[1]),
      start: Number(fields[19]),
      comm: stat.slice(stat.indexOf("(") + 1, close),
      exe: exe.replace(/ \(deleted\)$/, ""),
      argv: cmdline.split("\0").filter(Boolean),
      unit: cgroup.trim().split("/").pop().replace(/\\x2d/g, "-"),
    };
  } catch {
    return null; // gone, a kernel thread or another user's process
  }
}

async function info(pid) {
  const cached = procs.get(pid);
  if (cached) return cached;
  const found = await procInfo(pid);
  if (found) procs.set(pid, found);
  return found;
}

// Our processes, cached by pid + start time (a reused pid gets read again).
async function scanProcesses() {
  const pids = (await fs.readdir("/proc").catch(() => [])).filter((name) => /^\d+$/.test(name)).map(Number);
  const alive = new Set(pids);
  for (const pid of procs.keys()) if (!alive.has(pid)) procs.delete(pid);
  const result = [];
  for (const pid of pids) {
    let item = procs.get(pid);
    if (!item) item = await info(pid);
    if (item) result.push(item);
  }
  return result;
}

async function ancestors(item) {
  const chain = [];
  for (let current = item, guard = 0; current && current.ppid > 1 && guard < 32; guard++) {
    current = await info(current.ppid);
    if (current) chain.push(current);
  }
  return chain;
}

async function descendants(pid, depth = 0) {
  if (depth > 6) return [];
  const children = await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => "");
  const result = [];
  for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
    const item = await info(child);
    if (item) result.push(item, ...(await descendants(child, depth + 1)));
  }
  return result;
}

const isOwn = async (item) => item.pid === process.pid || (await ancestors(item)).some((a) => a.pid === process.pid);

// ---------- matchers ----------

async function resolveProgram(program) {
  if (!program) return null;
  let file = program;
  if (!program.includes("/")) {
    file = null;
    for (const dir of (process.env.PATH ?? "").split(":")) {
      try {
        await fs.access(path.join(dir, program));
        file = path.join(dir, program);
        break;
      } catch {
        // keep looking
      }
    }
  }
  return file && fs.realpath(file).catch(() => file);
}

// Strip launch wrappers: env, sh -c, setsid, mangohud …
function stripWrappers(args) {
  let rest = [...args];
  for (let guard = 0; guard < 10 && rest.length; guard++) {
    const name = path.basename(rest[0]);
    if (name === "env") {
      rest = rest.slice(1);
      while (rest.length && (/^-/.test(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
        if (rest[0] === "-u" || rest[0] === "-C") rest = rest.slice(1);
        rest = rest.slice(1);
      }
    } else if (/^(sh|bash|dash|zsh)$/.test(name) && rest[1] === "-c" && rest[2]) {
      rest = execArgs(rest[2].split(/[;&|]/)[0]);
    } else if (name === "nice" || name === "ionice" || name === "taskset" || name === "chrt") {
      rest = rest.slice(1);
      while (rest.length && (/^-/.test(rest[0]) || /^\d+$/.test(rest[0]))) rest = rest.slice(1);
    } else if (PREFIXES.has(name) || name === "uwsm-app") {
      rest = rest.slice(1);
      if (rest[0] === "--") rest = rest.slice(1);
    } else break;
  }
  return rest;
}

const isElf = (head) => head.subarray(0, 4).toString("latin1") === "\x7fELF";

// A launcher script's final `exec <program> <args>` line, with simple VAR=value assignments filled in.
// "$@" marks where the caller's arguments go; anything else still dynamic is dropped.
function execLine(text) {
  const vars = {};
  for (const match of text.matchAll(/^\s*(?:export\s+|local\s+|readonly\s+)?([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s$`;|&]*))\s*$/gm)) {
    vars[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  const line = text.split("\n").reverse().find((l) => /^\s*exec\s+/.test(l));
  if (!line) return null;
  const args = [];
  for (const raw of execArgs(line.trim().replace(/^exec\s+/, ""))) {
    if (raw === "$@" || raw === "${@}" || raw === "$*") {
      args.push("$@");
      continue;
    }
    const value = raw.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => vars[a ?? b] ?? all);
    if (!value.includes("$")) args.push(value);
  }
  return args;
}

// What actually runs for a command line: the real executable, or an interpreter and the app file it
// runs (Obsidian: electron + app.asar, TLauncher: java + TLauncher.jar). Launcher scripts are followed.
async function target(args, depth = 0) {
  args = stripWrappers(args);
  const program = await resolveProgram(args[0]);
  const head = program && (await fs.readFile(program).catch(() => null));
  if (!head || depth > 4) return {};
  if (isElf(head)) {
    if (!INTERPRETERS.test(path.basename(program))) return { exe: program };
    const file = args.slice(1).find((a) => a.startsWith("/"));
    return file ? { interpreter: program, arg: file } : {};
  }
  const text = head.toString("utf8");
  if (!text.startsWith("#!")) return {};
  const line = execLine(text);
  if (line) {
    const pass = line.indexOf("$@");
    const next = pass < 0 ? line : [...line.slice(0, pass), ...args.slice(1), ...line.slice(pass + 1)];
    const inner = await target(next, depth + 1);
    if (inner.exe || inner.interpreter) return inner;
  }
  return { arg: program }; // the script itself runs as `sh <program>`
}

// How to recognise a linked app's processes and windows (equality only, never NitroSense's substring match).
async function matcher(app) {
  if (app.kind === "steam") return { steam: app.steamAppId, classes: [`steam_app_${app.steamAppId}`] };
  if (app.kind === "file") {
    if (/\.exe$/i.test(app.path)) return { windowsExe: path.basename(app.path).toLowerCase() };
    if (/\.appimage$/i.test(app.path)) return { appImage: app.path };
    const runs = await target([app.path]);
    return runs.exe || runs.interpreter ? runs : { exe: app.path };
  }
  const found = await readEntry(app.desktopId);
  if (!found) return null; // missing: never matches
  const { entry } = found;
  const id = app.desktopId.replace(/\.desktop$/, "");
  const result = { classes: [id], unit: id, names: [], game: /(^|;)Game(;|$)/.test(entry.Categories ?? "") };
  if (entry.StartupWMClass && !entry.StartupWMClass.includes("@@")) result.classes.push(entry.StartupWMClass);
  let args = stripWrappers(execArgs(entry.Exec));
  const steam = /steam:\/\/rungameid\/(\d+)/.exec(entry.Exec)?.[1];
  if (steam) return { steam: Number(steam), classes: [`steam_app_${steam}`] };
  if (path.basename(args[0] ?? "") === "flatpak" && args.includes("run")) {
    const flatpak = args.slice(args.indexOf("run") + 1).find((a) => !a.startsWith("-"));
    return { classes: [flatpak], unit: `flatpak-${flatpak}` };
  }
  const webapp = entry.Exec.match(/(?:omarchy-launch-webapp|--app=)\s*"?(https?:\/\/[^\s"]+)/);
  if (webapp) return { classes: result.classes, webHost: new URL(webapp[1]).host.toLowerCase() };
  if (path.basename(args[0] ?? "") === "xdg-terminal-exec" || entry.Terminal === "true") {
    result.terminal = true;
    if (path.basename(args[0] ?? "") === "xdg-terminal-exec") args = args.slice(args.indexOf("-e") + 1 || 1).filter((a) => !a.startsWith("--app-id"));
  }
  const runs = await target(args);
  if (runs.exe && !GENERIC.test(path.basename(runs.exe))) result.exe = runs.exe;
  if (runs.arg) Object.assign(result, { arg: runs.arg }, runs.interpreter && { interpreter: runs.interpreter });
  const base = path.basename(args[0] ?? "");
  if (base && !GENERIC.test(base)) result.names.push(base.toLowerCase());
  if (/^[A-Za-z][A-Za-z0-9]{3,}$/.test(entry.Name ?? "")) result.names.push(entry.Name.toLowerCase());
  return result;
}

function matchProcess(m, item) {
  if (!m || !item) return false;
  if (m.exe && item.exe === m.exe) return true;
  if (m.arg && item.argv.includes(m.arg) && (!m.interpreter || item.exe === m.interpreter || GENERIC.test(path.basename(item.exe)))) return true;
  if (m.unit && item.unit.startsWith("app-") && (item.unit.includes(`-${m.unit}-`) || item.unit.includes(`-${m.unit}@`) || item.unit.endsWith(`-${m.unit}.scope`))) return true;
  if (m.windowsExe && [item.argv[0], item.comm].some((a) => a && path.basename(a.replace(/\\/g, "/")).toLowerCase() === m.windowsExe)) return true;
  if (m.names?.length && !GENERIC.test(item.comm) && m.names.includes(item.comm.toLowerCase())) return true;
  return false;
}

async function matchSteam(m, item) {
  if (!m.steam) return false;
  return [item, ...(await ancestors(item))].some((p) => p.argv.includes("SteamLaunch") && p.argv.includes(`AppId=${m.steam}`));
}

async function matchAppImage(m, item) {
  if (!m.appImage || !item.exe.startsWith("/tmp/.mount_")) return false;
  const environ = await fs.readFile(`/proc/${item.pid}/environ`, "utf8").catch(() => "");
  return environ.split("\0").includes(`APPIMAGE=${m.appImage}`);
}

async function matchesProcess(m, item) {
  return matchProcess(m, item) || (await matchSteam(m, item)) || (await matchAppImage(m, item));
}

async function matchesWindow(m, window, item) {
  const classes = [window.class, window.initialClass].filter(Boolean).map((c) => c.toLowerCase());
  if (m.classes?.some((c) => classes.includes(c.toLowerCase()))) return true;
  if (m.webHost && classes.some((c) => c.includes(m.webHost))) return true;
  if (!item || m.webHost) return false;
  if (await matchesProcess(m, item)) return true;
  if (m.game) for (const parent of await ancestors(item)) if (matchProcess(m, parent)) return true;
  if (m.terminal) for (const child of await descendants(item.pid)) if (matchProcess(m, child)) return true;
  return false;
}

// ---------- desired profile ----------

// → { name } of the linked profile, null (the user's own profile) or "hold" (an app of a profile with
// App Sync off is in front: NitroSense then neither switches nor reverts).
async function desired() {
  if (hyprland) {
    if (!focus?.pid) return null;
    const item = await info(focus.pid);
    if (item && (await isOwn(item))) return null;
    for (const link of links) {
      if (await matchesWindow(link.matcher, focus, item)) return link.enabled ? { name: config.profiles[link.index].name } : "hold";
    }
    return null;
  }
  let best = null;
  for (const item of await scanProcesses()) {
    if (item.pid === process.pid) continue;
    for (const link of links) {
      if ((!best || item.start > best.start) && (await matchesProcess(link.matcher, item))) best = { link, start: item.start };
    }
  }
  if (!best) return null;
  return best.link.enabled ? { name: config.profiles[best.link.index].name } : "hold";
}

async function evaluate() {
  if (!config) return;
  const wanted = await desired();
  if (wanted === "hold") {
    pending = undefined;
    clearTimeout(settleTimer);
    return;
  }
  const key = wanted?.name ?? null;
  if (key === last) {
    pending = undefined;
    clearTimeout(settleTimer);
    return;
  }
  if (key === pending) return;
  pending = key;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(async () => {
    pending = undefined;
    last = key;
    const index = key === null ? config.select : config.profiles.findIndex((p) => p.name === key);
    if (index >= 0 && index !== config.active) notify({ index, reason: key === null ? "revert" : "app", power: await readPower() });
  }, hyprland ? SETTLE_MS : 0);
}

// ---------- Hyprland focus ----------

function hyprSocket(name) {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtime = process.env.XDG_RUNTIME_DIR;
  return signature && runtime ? path.join(runtime, "hypr", signature, name) : null;
}

function hyprRequest(command) {
  return new Promise((resolve) => {
    const socket = net.createConnection(hyprSocket(".socket.sock"));
    let data = "";
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("connect", () => socket.write(command));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("close", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    socket.on("error", () => resolve(null));
  });
}

async function refreshFocus() {
  const window = await hyprRequest("j/activewindow");
  focus = window?.pid > 0 ? { pid: window.pid, class: window.class, initialClass: window.initialClass } : null;
}

function listenHyprland() {
  const file = hyprSocket(".socket2.sock");
  if (!file) return false;
  let buffer = "";
  let timer = null;
  const socket = net.createConnection(file);
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    if (lines.some((line) => /^(activewindowv2|closewindow|openwindow)>>/.test(line))) {
      clearTimeout(timer);
      timer = setTimeout(() => refreshFocus().then(evaluate).catch(() => {}), 50);
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    if (hyprland === socket) {
      hyprland = null;
      setTimeout(() => pollTimer && start(), POLL_MS);
    }
  });
  hyprland = socket;
  return true;
}

// ---------- lifecycle ----------

function start() {
  if (!pollTimer) {
    pollTimer = setInterval(async () => {
      if (hyprland) await refreshFocus();
      evaluate().catch((error) => console.error("app sync", error.message));
    }, POLL_MS);
  }
  if (!hyprland) listenHyprland();
}

function stop() {
  clearInterval(pollTimer);
  pollTimer = null;
  hyprland?.destroy();
  hyprland = null;
}

// From the renderer after every scenario change: { active, select, profiles: [{ name, appSync, apps }] }.
async function configure(next) {
  config = next;
  const derived = [];
  for (const [index, profile] of (next.profiles ?? []).entries()) {
    for (const app of profile.apps ?? []) {
      const m = await matcher(app).catch(() => null);
      if (m) derived.push({ index, enabled: profile.appSync !== false, matcher: m });
    }
  }
  links = derived;
  // Watch while something is linked, or while a linked profile still has to be reverted.
  if (links.length || next.active !== next.select) start();
  else stop();
  if (hyprland) await refreshFocus();
  await evaluate();
}

function init(onSwitch) {
  notify = onSwitch;
}

module.exports = { init, configure, matcher, matchProcess, stripWrappers };
