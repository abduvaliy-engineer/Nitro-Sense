const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, Notification } = require("electron");
const sensors = require("./sensors");
const system = require("./system");
const updates = require("./updates");
const shortcuts = require("./shortcuts");
const controls = require("./controls");
const { Settings } = require("./settings");

// The kernel notifies platform_profile changes (sysfs_notify → inotify) within milliseconds,
// so windows refresh at once instead of waiting for the next poll.
function watchPlatformProfile() {
  let timer = null;
  try {
    fs.watch("/sys/firmware/acpi/platform_profile", () => {
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
  ipcMain.handle("sensors:snapshot", () => sensors.snapshot());
  ipcMain.handle("system:info", () => system.info());
  ipcMain.handle("settings:get", (_e, key) => settings.get(key));
  ipcMain.handle("settings:set", (_e, key, value) => settings.set(key, value));
  ipcMain.handle("updates:check", () => updates.check(app.getVersion()));
  ipcMain.handle("updates:open", (_e, url) => shell.openExternal(updates.isReleaseUrl(url) ? url : updates.RELEASES));
  ipcMain.handle("shortcuts:list", () => shortcuts.list());
  ipcMain.handle("shortcuts:launch", (_e, id) => shortcuts.launch(id));
  ipcMain.handle("controls:setProfile", (_e, profile) => controls.setProfile(profile));
  ipcMain.handle("controls:setFanSpeed", (_e, cpu, gpu) => controls.setFanSpeed(cpu, gpu));
  ipcMain.handle("controls:setModeKeyCycle", (_e, cycle) => controls.setModeKeyCycle(Boolean(cycle)));
  ipcMain.handle("notify", (_e, title, body) => {
    if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show();
  });
}

module.exports = { registerIpc };
