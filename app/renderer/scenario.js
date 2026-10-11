// Scenario profiles (NitroSense electron-store "Scenario"): presets, active profile, apply and edit.
(() => {
  const KEY = "scenario";
  const LIMIT = 15;

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
  const PRESETS = [
    { name: "Daily Use", mode: "balanced", dcMode: "balanced", fan: { ...DEFAULT_FAN }, lighting: defaultLighting("WAVE") },
    { name: "Gaming", mode: "balanced-performance", dcMode: "balanced", fan: { ...DEFAULT_FAN }, lighting: defaultLighting("BREATHING") },
    { name: "Quiet Occasion", mode: "quiet", dcMode: "balanced", fan: { ...DEFAULT_FAN }, lighting: defaultLighting("STATIC") },
  ];

  let state = null;
  let loading = null;
  let lastPower = null;
  const listeners = new Set();

  const emit = () => listeners.forEach((listener) => listener(state));
  const save = () => window.nitro.settings.set(KEY, state);
  const onBattery = () => lastPower?.ac === false;

  async function load() {
    if (state) return state;
    loading ??= window.nitro.settings.get(KEY).catch(() => null).then((stored) => {
      state = stored?.profiles?.length ? stored : { active: 0, profiles: clone(PRESETS) };
      for (const profile of state.profiles) {
        profile.dcMode ??= "balanced";
        profile.fan = { ...DEFAULT_FAN, ...profile.fan };
        profile.lighting ??= defaultLighting(profile.effect?.toUpperCase() ?? "WAVE");
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
  async function apply(index, { notify = true } = {}) {
    await load();
    const profile = state.profiles[index];
    if (!profile) return;
    state.active = index;
    await save();
    emit();
    const mode = onBattery() ? profile.dcMode : profile.mode;
    try {
      await window.nitro.controls.setProfile(mode);
      await window.nitro.controls.setFanSpeed(...fanSpeeds(profile.fan));
    } catch (error) {
      console.error("applying scenario failed", error);
      return;
    }
    // The main process holds this until the mode-change flash has played, as Windows does.
    window.nitro.lighting.apply(profile.lighting).catch((error) => console.error("applying lighting failed", error));
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

  // ---------- editing (NitroSense ⋮ menu) ----------

  const isFull = () => state.profiles.length >= LIMIT;
  const nameTaken = (name) => state.profiles.some((p) => p.name.replace(/\s/g, "") === name.replace(/\s/g, ""));

  function duplicateName() {
    const base = state.profiles[state.active].name;
    for (let n = 1; n <= LIMIT; n++) if (!nameTaken(`${base} (${n})`)) return `${base} (${n})`;
    return base;
  }

  async function add(name) {
    if (isFull()) return;
    state.profiles.push({ ...clone(PRESETS[0]), name });
    await apply(state.profiles.length - 1);
  }

  async function rename(name) {
    state.profiles[state.active].name = name;
    await save();
    emit();
  }

  async function duplicate(name) {
    if (isFull()) return;
    state.profiles.push({ ...clone(state.profiles[state.active]), name });
    state.active = state.profiles.length - 1;
    await save();
    emit();
  }

  async function remove() {
    if (state.profiles.length <= 1) return;
    state.profiles.splice(state.active, 1);
    await apply(0);
  }

  async function restore(presetIndex) {
    const { name } = state.profiles[state.active];
    state.profiles[state.active] = { ...clone(PRESETS[presetIndex]), name };
    await apply(state.active);
  }

  window.NitroScenario = {
    MODE_NAMES,
    FAN_NAMES,
    PRESETS,
    LIMIT,
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
