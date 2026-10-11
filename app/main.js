const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { registerIpc } = require("./backend/ipc");

app.setName("NitroSense");

function createWindow() {
  const win = new BrowserWindow({
    width: 1168,
    height: 780,
    minWidth: 500,
    minHeight: 670,
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

// --dev: reload the window in place when the UI changes; restart for main-process changes, but only
// while the window is focused, so a relaunch never pops a new window up while the user is elsewhere.
function watchForChanges(win) {
  let timer = null;
  let restartPending = false;
  const restart = () => {
    app.relaunch();
    app.exit(0);
  };
  win.on("focus", () => restartPending && restart());
  fs.watch(__dirname, { recursive: true }, (_event, file) => {
    if (!file || file.startsWith("node_modules")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (/^(renderer|assets|vendor)\//.test(file)) win.webContents.reloadIgnoringCache();
      else if (win.isFocused()) restart();
      else restartPending = true;
    }, 200);
  });
}

ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender).minimize());
ipcMain.on("window:toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender).close());
registerIpc();

// Like NitroSense, a second launch focuses the running window instead of opening another.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(createWindow);
}
app.on("window-all-closed", () => app.quit());
