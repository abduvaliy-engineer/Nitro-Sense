const { spawn } = require("child_process");
const { readEntry, execArgs, iconDataUrl } = require("./desktop");

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
