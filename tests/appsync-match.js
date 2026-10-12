// App Sync matching checks on synthetic processes (no /proc, no Hyprland): node tests/appsync-match.js app
const path = require("path");
const appsync = require(path.resolve(process.argv[2] ?? "app", "backend/appsync.js"));

const proc = (exe, argv, extra = {}) => ({ pid: 1000, ppid: 1, start: 1, comm: path.basename(exe).slice(0, 15), exe, argv, unit: "", ...extra });
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const obsidian = { arg: "/usr/lib/obsidian/app.asar", interpreter: "/usr/lib/electron43/electron", names: ["obsidian"] };
check("electron app matches by its app file", appsync.matchProcess(obsidian, proc("/usr/lib/electron43/electron", ["/usr/lib/electron43/electron", "/usr/lib/obsidian/app.asar"])), true);
check("NitroSense on the same electron does not", appsync.matchProcess(obsidian, proc("/usr/lib/electron43/electron", ["/usr/lib/electron43/electron", "."])), false);
check("exact executable", appsync.matchProcess({ exe: "/usr/bin/Telegram" }, proc("/usr/bin/Telegram", ["telegram-desktop"])), true);
check("other executable", appsync.matchProcess({ exe: "/usr/bin/Telegram" }, proc("/usr/bin/nautilus", ["nautilus"])), false);
check("process name", appsync.matchProcess({ names: ["discord"] }, proc("/opt/discord/Discord", ["/opt/discord/Discord"], { comm: "Discord" })), true);
check("generic process name never matches", appsync.matchProcess({ names: ["python3"] }, proc("/usr/bin/python3", ["python3"], { comm: "python3" })), false);
check("systemd scope of the desktop entry", appsync.matchProcess({ unit: "discord" }, proc("/x/y", ["y"], { unit: "app-discord-3518.scope" })), true);
check("unrelated scope", appsync.matchProcess({ unit: "discord" }, proc("/x/y", ["y"], { unit: "app-discordia-1.scope" })), false);
check("Windows game by exe name", appsync.matchProcess({ windowsExe: "launcher.exe" }, proc("/usr/bin/wine64-preloader", ["C:\\Games\\HoYo\\launcher.exe"])), true);
check("wrappers are stripped", appsync.stripWrappers(["env", "FOO=1", "mangohud", "java", "-jar", "/a.jar"]).join(" "), "java -jar /a.jar");
check("sh -c is unwrapped", appsync.stripWrappers(["sh", "-c", "gamemoderun /usr/bin/game --x; echo done"]).join(" "), "/usr/bin/game --x");
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
