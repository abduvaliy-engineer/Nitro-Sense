// Scenario profiles (NitroSense electron-store "Scenario"): presets, active profile, apply and edit.
// state.active = the applied profile; state.select = the one the user chose (App Sync applies a linked
// profile temporarily and returns to it).
(() => {
  const KEY = "scenario";
  const LIMIT = 15;
  const APP_LIMIT = 12;
  const LOW_BATTERY = 40;

  const MODE_NAMES = {
    "low-power": "Eco",
    quiet: "Quiet",
    balanced: "Balanced",
    "balanced-performance": "Performance",
    performance: "Turbo",
  };
  const FAN_NAMES = { auto: "Auto", max: "Max", custom: "Custom" };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  // Pulsar Lighting: "global" shows one effect on the whole keyboard, "area" gives each of the four zones
  // its own static color. Levels are NitroSense's 1-5 (brightness 1 = backlight off).
  const LIGHTING_GLOBAL = { effect: "WAVE", speed: 3, brightness: 5, direction: 1, color: "#ffa000" };
  const LIGHTING_KEYBOARD = {
    effect: "STATIC", speed: 5, brightness: 5, direction: 1, color: "#ffa000",
    zones: ["#ffa000", "#ffa000", "#ffa000", "#ffa000"],
  };
  const defaultLighting = (effect) => ({ mode: "global", global: { ...LIGHTING_GLOBAL, effect }, keyboard: clone(LIGHTING_KEYBOARD) });

  // NitroSense's built-in presets (getDefaultProfile / getGamingProfile / getQUIETProfile).
  // mode applies on AC, dcMode on battery (linuwu-sense only accepts Eco and Balanced on battery).
  // fan.cpu/gpu are custom percentages; cpuAuto/gpuAuto hand a fan back to the firmware in Custom mode.
  const DEFAULT_FAN = { mode: "auto", cpu: 30, gpu: 30, cpuAuto: true, gpuAuto: true };
  // apps = App Sync's linked apps; appSync = whether linking is on for this profile.
  const preset = (name, mode, effect) => ({
    name, mode, dcMode: "balanced", fan: { ...DEFAULT_FAN }, lighting: defaultLighting(effect), apps: [], appSync: true,
  });
  const PRESETS = [
    preset("Daily Use", "balanced", "WAVE"),
    preset("Gaming", "balanced-performance", "BREATHING"),
    preset("Quiet Occasion", "quiet", "STATIC"),
  ];

  let state = null;
  let loading = null;
  let lastPower = null;
  let lastApply = 0;
  const listeners = new Set();

  // App Sync (main process) watches the linked apps of every profile.
  let configureTimer = null;
  function configureAppSync() {
    clearTimeout(configureTimer);
    configureTimer = setTimeout(() => {
      const profiles = state.profiles.map(({ name, appSync, apps }) => ({ name, appSync, apps }));
      window.nitro.appSync.configure({ active: state.active, select: state.select, profiles })
        .catch((error) => console.error("app sync configure failed", error));
    }, 100);
  }

  const emit = () => {
    listeners.forEach((listener) => listener(state));
    configureAppSync();
  };
  const save = () => window.nitro.settings.set(KEY, state);
  const onBattery = () => lastPower?.ac === false;
  // NitroSense locks the AC mode on AC power below 40 % battery: Quiet stays, everything else runs Balanced.
  const lowBattery = () => !onBattery() && lastPower?.battery != null && lastPower.battery < LOW_BATTERY;

  async function load() {
    if (state) return state;
    loading ??= window.nitro.settings.get(KEY).catch(() => null).then((stored) => {
      state = stored?.profiles?.length ? stored : { active: 0, profiles: clone(PRESETS) };
      state.select ??= state.active;
      for (const profile of state.profiles) {
        profile.dcMode ??= "balanced";
        profile.fan = { ...DEFAULT_FAN, ...profile.fan };
        profile.lighting ??= defaultLighting(profile.effect?.toUpperCase() ?? "WAVE");
        profile.apps ??= [];
        profile.appSync ??= true;
        delete profile.effect;
      }
      emit();
      return state;
    });
    return loading;
  }

  // linuwu-sense fan_speed "cpu,gpu": 0 = that fan on auto, 0,0 = auto, 100,100 = max.
  function fanSpeeds(fan) {
    if (fan.mode === "max") return [100, 100];
    if (fan.mode === "custom") return [fan.cpuAuto ? 0 : fan.cpu, fan.gpuAuto ? 0 : fan.gpu];
    return [0, 0];
  }

  // linuwu-sense resets the fans to auto when the platform profile changes, so the mode goes first.
  // user: the user picked this profile (App Sync's temporary switches pass false and keep state.select).
  async function apply(index, { notify = true, user = true } = {}) {
    await load();
    const profile = state.profiles[index];
    if (!profile) return;
    state.active = index;
    if (user) state.select = index;
    lastApply = Date.now();
    await save();
    emit();
    const mode = liveMode(profile);
    try {
      await window.nitro.controls.setProfile(mode);
      await window.nitro.controls.setFanSpeed(...fanSpeeds(profile.fan));
    } catch (error) {
      console.error("applying scenario failed", error);
      return;
    }
    // The main process holds this until the mode-change flash has played, as Windows does.
    window.nitro.lighting.apply(profile.lighting).catch((error) => console.error("applying lighting failed", error));
    lastApply = Date.now();
    if (notify) {
      window.nitro.notify(
        `${profile.name} Enabled`,
        `${onBattery() ? "Current system mode:" : "System mode (AC Plugged In):"}\n${MODE_NAMES[mode] ?? mode}`,
      );
    }
  }

  // Fan page: apply a fan setting and record it in the active profile. Like NitroSense, changes made on
  // battery apply without being saved.
  async function setFan(fan) {
    await load();
    if (!onBattery()) {
      state.profiles[state.active].fan = { ...fan };
      save();
      emit();
    }
    await window.nitro.controls.setFanSpeed(...fanSpeeds(fan));
  }

  // Mode page: switch the live mode and record it in the active profile (AC or battery slot).
  async function setMode(mode) {
    await load();
    const profile = state.profiles[state.active];
    profile[onBattery() ? "dcMode" : "mode"] = mode;
    save();
    emit();
    await window.nitro.controls.setProfile(mode);
  }

  // Pulsar Lighting page: apply and record the lighting in the active profile.
  async function setLighting(lighting) {
    await load();
    state.profiles[state.active].lighting = clone(lighting);
    save();
    emit();
    await window.nitro.lighting.apply(lighting);
  }

  // NitroSense "Reset": defaults for both pages, keeping the global effect and the Global/Area choice.
  async function resetLighting() {
    await load();
    const { mode, global } = state.profiles[state.active].lighting;
    await setLighting({ mode, global: { ...LIGHTING_GLOBAL, effect: global.effect }, keyboard: clone(LIGHTING_KEYBOARD) });
  }

  // App start: show the active profile's lighting again, as NitroSense does when it opens.
  async function restoreLighting() {
    await load();
    await window.nitro.lighting.apply(state.profiles[state.active].lighting);
  }

  // Mode and fan changes made elsewhere (keys, other pages) are written into the active profile.
  async function sync(snapshot) {
    lastPower = snapshot.power;
    if (!state) await load();
    // A reading taken while a profile was being applied may still show the previous mode.
    if (Date.now() - lastApply < 2500) return;
    const profile = state.profiles[state.active];
    if (!profile) return;
    let changed = false;
    const slot = onBattery() ? "dcMode" : "mode";
    if (snapshot.profile && MODE_NAMES[snapshot.profile] && profile[slot] !== snapshot.profile) {
      profile[slot] = snapshot.profile;
      changed = true;
    }
    // Follow the driver only when its fans differ from what the profile asks for (e.g. Quiet/Eco forcing
    // auto); "Custom with both fans on Auto" writes 0,0 and must stay Custom. Battery changes aren't saved.
    const live = snapshot.fanMode;
    if (live && !onBattery()) {
      const [cpu, gpu] = fanSpeeds(profile.fan);
      if (live.cpu !== cpu || live.gpu !== gpu) {
        profile.fan = live.mode === "custom"
          ? { ...profile.fan, mode: "custom", cpu: live.cpu || profile.fan.cpu, gpu: live.gpu || profile.fan.gpu, cpuAuto: !live.cpu, gpuAuto: !live.gpu }
          : { ...profile.fan, mode: live.mode };
        changed = true;
      }
    }
    if (changed) {
      save();
      emit();
    }
  }

  // ---------- editing (NitroSense ⋮ menu and Scenario Manager; index = any profile) ----------

  const isFull = () => state.profiles.length >= LIMIT;
  const nameTaken = (name) => state.profiles.some((p) => p.name.replace(/\s/g, "") === name.replace(/\s/g, ""));

  function duplicateName(index = state.active) {
    const base = state.profiles[index].name;
    for (let n = 1; n <= LIMIT; n++) if (!nameTaken(`${base} (${n})`)) return `${base} (${n})`;
    return base;
  }

  // The mode a profile runs right now: battery slot, or the AC mode under the low-battery lock.
  function liveMode(profile) {
    if (onBattery()) return profile.dcMode;
    return lowBattery() && profile.mode !== "quiet" ? "balanced" : profile.mode;
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Scenario Manager edits: saved at once. On the applied profile only the changed parts go to the
  // hardware, so a fan edit doesn't rewrite the mode or restart the keyboard lighting.
  async function update(index, mutate) {
    await load();
    const profile = state.profiles[index];
    if (!profile) return;
    const before = clone(profile);
    mutate(profile);
    await save();
    emit();
    if (index !== state.active) return;
    const mode = liveMode(profile);
    const modeChanged = mode !== liveMode(before);
    try {
      if (modeChanged) await window.nitro.controls.setProfile(mode);
      if (modeChanged || !same(fanSpeeds(before.fan), fanSpeeds(profile.fan))) {
        await window.nitro.controls.setFanSpeed(...fanSpeeds(profile.fan));
      }
    } catch (error) {
      console.error("applying profile change failed", error);
    }
    if (!same(before.lighting, profile.lighting)) {
      window.nitro.lighting.apply(profile.lighting).catch((error) => console.error("applying lighting failed", error));
    }
  }

  // App Sync links: an app belongs to one profile, so linking it here unlinks it everywhere else.
  async function setApps(index, apps) {
    await load();
    const keys = new Set(apps.map((app) => app.key));
    state.profiles.forEach((profile, i) => {
      profile.apps = i === index ? clone(apps) : profile.apps.filter((app) => !keys.has(app.key));
    });
    await save();
    emit();
  }

  async function add(name) {
    if (isFull()) return;
    state.profiles.push({ ...clone(PRESETS[0]), name });
    await apply(state.profiles.length - 1);
  }

  async function rename(index, name) {
    state.profiles[index].name = name;
    await save();
    emit();
  }

  // The copy gets no linked apps and is applied, like a new profile.
  async function duplicate(index, name) {
    if (isFull()) return;
    state.profiles.push({ ...clone(state.profiles[index]), name, apps: [] });
    await apply(state.profiles.length - 1);
  }

  async function remove(index) {
    if (state.profiles.length <= 1) return;
    const wasActive = index === state.active;
    state.profiles.splice(index, 1);
    const shift = (i) => (i > index ? i - 1 : Math.min(i, state.profiles.length - 1));
    state.select = shift(state.select);
    if (wasActive) return apply(0);
    state.active = shift(state.active);
    await save();
    emit();
  }

  // "Restore Settings": a preset's settings under the same name, linked apps cleared.
  async function restore(index, presetIndex) {
    const { name } = state.profiles[index];
    state.profiles[index] = { ...clone(PRESETS[presetIndex]), name };
    if (index === state.active) return apply(index, { notify: false, user: false });
    await save();
    emit();
  }

  // App Sync: the linked app in front gets its profile; otherwise the user's own profile comes back.
  window.nitro.appSync.onSwitch(async ({ index, power }) => {
    if (power) lastPower = power;
    await load();
    if (index !== state.active && state.profiles[index]) apply(index, { notify: true, user: false });
  });

  window.NitroScenario = {
    MODE_NAMES,
    FAN_NAMES,
    PRESETS,
    LIMIT,
    APP_LIMIT,
    fanSpeeds,
    load,
    apply,
    setMode,
    setFan,
    setLighting,
    resetLighting,
    restoreLighting,
    sync,
    onBattery,
    lowBattery,
    update,
    setApps,
    isFull,
    nameTaken,
    duplicateName,
    add,
    rename,
    duplicate,
    remove,
    restore,
    get state() { return state; },
    subscribe(listener) {
      listeners.add(listener);
      if (state) listener(state);
      return () => listeners.delete(listener);
    },
  };
})();
