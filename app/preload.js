const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nitro", {
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    onMaximized: (callback) => ipcRenderer.on("window:maximized", (_e, value) => callback(value)),
  },
  sensors: {
    snapshot: () => ipcRenderer.invoke("sensors:snapshot"),
  },
});
