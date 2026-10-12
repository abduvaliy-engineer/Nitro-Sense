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
    onChange: (callback) => ipcRenderer.on("sensors:changed", () => callback()),
  },
  system: {
    info: () => ipcRenderer.invoke("system:info"),
  },
  settings: {
    get: (key) => ipcRenderer.invoke("settings:get", key),
    set: (key, value) => ipcRenderer.invoke("settings:set", key, value),
  },
  updates: {
    check: () => ipcRenderer.invoke("updates:check"),
    version: () => ipcRenderer.invoke("updates:version"),
    checkout: () => ipcRenderer.invoke("updates:checkout"),
    install: (version) => ipcRenderer.invoke("updates:install", version),
    onProgress: (callback) => ipcRenderer.on("updates:progress", (_e, stage) => callback(stage)),
    open: (url) => ipcRenderer.invoke("updates:open", url),
  },
  shortcuts: {
    list: () => ipcRenderer.invoke("shortcuts:list"),
    launch: (id) => ipcRenderer.invoke("shortcuts:launch", id),
  },
  controls: {
    setProfile: (profile) => ipcRenderer.invoke("controls:setProfile", profile),
    setFanSpeed: (cpu, gpu) => ipcRenderer.invoke("controls:setFanSpeed", cpu, gpu),
    setModeKeyCycle: (cycle) => ipcRenderer.invoke("controls:setModeKeyCycle", cycle),
  },
  personal: {
    read: () => ipcRenderer.invoke("personal:read"),
    set: (name, value) => ipcRenderer.invoke("personal:set", name, value),
  },
  lighting: {
    info: () => ipcRenderer.invoke("lighting:info"),
    apply: (lighting) => ipcRenderer.invoke("lighting:apply", lighting),
    pickColor: () => ipcRenderer.invoke("lighting:pickColor"),
  },
  apps: {
    list: () => ipcRenderer.invoke("apps:list"),
    resolve: (refs) => ipcRenderer.invoke("apps:resolve", refs),
    pickFile: () => ipcRenderer.invoke("apps:pickFile"),
    refresh: () => ipcRenderer.invoke("apps:refresh"),
  },
  appSync: {
    configure: (config) => ipcRenderer.invoke("appsync:configure", config),
    onSwitch: (callback) => ipcRenderer.on("appsync:switch", (_e, change) => callback(change)),
  },
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
});
