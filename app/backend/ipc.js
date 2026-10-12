const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, Notification } = require("electron");
const sensors = require("./sensors");
const system = require("./system");
const updates = require("./updates");
const shortcuts = require("./shortcuts");
const controls = require("./controls");
const lighting = require("./lighting");
const apps = require("./apps");
const appsync = require("./appsync");
const { Settings } = require("./settings");

const PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";

function readProfile() {
  try {
    return fs.readFileSync(PLATFORM_PROFILE, "utf8").trim();
  } catch {
    return null;
  }
}

// The kernel notifies platform_profile changes (sysfs_notify → inotify) within milliseconds, so windows
// refresh at once and the keyboard flashes the new mode's color. Rewriting the same mode notifies too.
function watchPlatformProfile() {
  let timer = null;
  let last = readProfile();
  try {
    fs.watch(PLATFORM_PROFILE, () => {
      const profile = readProfile();
      if (profile && last && profile !== last) lighting.flash(profile);
      if (profile) last = profile;
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send("sensors:changed");
      }, 30);
    });
  } catch (error) {
    console.error("platform_profile watch unavailable", error.message);
  }
}

function registerIpc() {
  watchPlatformProfile();
  const settings = new Settings(app.getPath("userData"));
  apps.init(settings);
  appsync.init((change) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("appsync:switch", change);
  });
  ipcMain.handle("sensors:snapshot", () => sensors.snapshot());
  ipcMain.handle("system:info", () => system.info());
  ipcMain.handle("settings:get", (_e, key) => settings.get(key));
  ipcMain.handle("settings:set", (_e, key, value) => settings.set(key, value));
  ipcMain.handle("updates:check", () => updates.check(app.getVersion()));
  ipcMain.handle("updates:install", (_e, version) => updates.install(version));
  ipcMain.handle("updates:open", (_e, url) => shell.openExternal(updates.isReleaseUrl(url) ? url : updates.RELEASES));
  ipcMain.handle("shortcuts:list", () => shortcuts.list());
  ipcMain.handle("shortcuts:launch", (_e, id) => shortcuts.launch(id));
  ipcMain.handle("controls:setProfile", (_e, profile) => controls.setProfile(profile));
  ipcMain.handle("controls:setFanSpeed", (_e, cpu, gpu) => controls.setFanSpeed(cpu, gpu));
  ipcMain.handle("controls:setModeKeyCycle", (_e, cycle) => controls.setModeKeyCycle(Boolean(cycle)));
  ipcMain.handle("controls:setBacklightTimeout", (_e, on) => controls.setBacklightTimeout(Boolean(on)));
  ipcMain.handle("lighting:info", () => lighting.info());
  ipcMain.handle("lighting:apply", (_e, value) => lighting.apply(value));
  ipcMain.handle("lighting:pickColor", () => lighting.pickColor());
  ipcMain.handle("apps:list", () => apps.list());
  ipcMain.handle("apps:resolve", (_e, refs) => apps.resolve(refs));
  ipcMain.handle("apps:pickFile", (e) => apps.pickFile(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle("apps:refresh", () => apps.refresh());
  ipcMain.handle("appsync:configure", (_e, config) => appsync.configure(config));
  ipcMain.handle("notify", (_e, title, body) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
  });
}

module.exports = { registerIpc };
