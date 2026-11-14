// window.nitro: what the pages call. Each call goes to the background part (nitrosense) and comes back as a promise;
// its events (power mode changed, App Sync switch, update progress) reach the listeners registered here.
(() => {
  if (window.top !== window || window.nitro) return;

  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  const post = (message) => window.ipc.postMessage(JSON.stringify(message));
  const send = (cmd, ...args) => post({ cmd, args });
  const invoke = (cmd, ...args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ id, cmd, args });
  });
  const on = (event, callback) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(callback);
  };

  // Called by nitrosense-ui with each message from the background part.
  Object.defineProperty(window, "__nitroReceive", {
    value(message) {
      if (message.event) {
        for (const callback of listeners.get(message.event) ?? []) callback(message.payload);
        return;
      }
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.ok) call.resolve(message.result);
      else call.reject(new Error(message.error));
    },
  });

  window.nitro = {
    window: {
      minimize: () => send("window:minimize"),
      toggleMaximize: () => send("window:toggle-maximize"),
      close: () => send("window:close"),
      onMaximized: (callback) => on("window:maximized", callback),
    },
    sensors: {
      snapshot: () => invoke("sensors:snapshot"),
      onChange: (callback) => on("sensors:changed", () => callback()),
    },
    system: {
      info: () => invoke("system:info"),
    },
    settings: {
      get: (key) => invoke("settings:get", key),
      set: (key, value) => invoke("settings:set", key, value),
    },
    updates: {
      check: () => invoke("updates:check"),
      version: () => invoke("updates:version"),
      checkout: () => invoke("updates:checkout"),
      packaged: () => invoke("updates:packaged"),
      install: (version) => invoke("updates:install", version),
      // The update being installed ({ version, stage }), or undefined.
      status: () => invoke("updates:status"),
      onProgress: (callback) => on("updates:progress", callback),
      open: (url) => invoke("updates:open", url),
    },
    shortcuts: {
      list: () => invoke("shortcuts:list"),
      launch: (id) => invoke("shortcuts:launch", id),
    },
    controls: {
      setProfile: (profile) => invoke("controls:setProfile", profile),
      setFanSpeed: (cpu, gpu) => invoke("controls:setFanSpeed", cpu, gpu),
      setModeKeyCycle: (cycle) => invoke("controls:setModeKeyCycle", cycle),
    },
    personal: {
      read: () => invoke("personal:read"),
      set: (name, value) => invoke("personal:set", name, value),
      applyGpuMode: (mode) => invoke("personal:applyGpuMode", mode),
    },
    lighting: {
      info: () => invoke("lighting:info"),
      apply: (lighting) => invoke("lighting:apply", lighting),
      // For the window opening: sends nothing when the keyboard already shows this lighting.
      restore: (lighting) => invoke("lighting:restore", lighting),
      pickColor: () => invoke("lighting:pickColor"),
    },
    apps: {
      list: () => invoke("apps:list"),
      resolve: (refs) => invoke("apps:resolve", refs),
      pickFile: () => invoke("apps:pickFile"),
      refresh: () => invoke("apps:refresh"),
    },
    appSync: {
      configure: (config) => invoke("appsync:configure", config),
      onSwitch: (callback) => on("appsync:switch", callback),
    },
    notify: (title, body) => invoke("notify", title, body),
  };

  // The header is the title bar: dragging it moves the window, a double click maximizes it.
  document.addEventListener("mousedown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || !target?.closest("#nav") || target.closest("button, input, select, textarea, a")) return;
    event.preventDefault();
    send(event.detail === 2 ? "window:toggle-maximize" : "window:drag");
  }, true);
})();
