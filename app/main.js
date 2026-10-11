const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const sensors = require("./backend/sensors");
const system = require("./backend/system");

function createWindow() {
  const win = new BrowserWindow({
    width: 1168,
    height: 780,
    minWidth: 500,
    frame: false,
    show: false,
    center: true,
    backgroundColor: "#381200",
    title: "NitroSense",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (process.argv.includes("--dev")) watchForChanges(win);
}

// --dev: reload the window when the UI changes, restart when the main process changes.
function watchForChanges(win) {
  let timer = null;
  fs.watch(__dirname, { recursive: true }, (_event, file) => {
    if (!file || file.startsWith("node_modules")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (/^(renderer|assets|vendor)\//.test(file)) {
        win.webContents.reloadIgnoringCache();
      } else {
        app.relaunch();
        app.exit(0);
      }
    }, 200);
  });
}

ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender).minimize());
ipcMain.on("window:toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle("sensors:snapshot", () => sensors.snapshot());
ipcMain.handle("system:info", () => system.info());
ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender).close());

app.setName("NitroSense");
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
