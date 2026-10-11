// Scenario profiles (NitroSense electron-store "Scenario"): presets, active profile, apply.
(() => {
  const KEY = "scenario";

  const MODE_NAMES = {
    "low-power": "Eco",
    quiet: "Quiet",
    balanced: "Balanced",
    "balanced-performance": "Performance",
    performance: "Turbo",
  };
  const FAN_NAMES = { auto: "Auto", max: "Max", custom: "Custom" };

  // NitroSense's built-in presets (getDefaultProfile / getGamingProfile / getQUIETProfile).
  const PRESETS = [
    { name: "Daily Use", mode: "balanced", fan: { mode: "auto", cpu: 30, gpu: 30 }, effect: "Wave" },
    { name: "Gaming", mode: "balanced-performance", fan: { mode: "auto", cpu: 30, gpu: 30 }, effect: "Breathing" },
    { name: "Quiet Occasion", mode: "quiet", fan: { mode: "auto", cpu: 30, gpu: 30 }, effect: "Static" },
  ];

  let state = null;
  const listeners = new Set();

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const emit = () => listeners.forEach((listener) => listener(state));
  const save = () => window.nitro.settings.set(KEY, state);

  let loading = null;

  async function load() {
    if (state) return state;
    loading ??= window.nitro.settings.get(KEY).catch(() => null).then((stored) => {
      state = stored?.profiles?.length ? stored : { active: 0, profiles: clone(PRESETS) };
      emit();
      return state;
    });
    return loading;
  }

  function fanSpeeds(fan) {
    if (fan.mode === "max") return [100, 100];
    if (fan.mode === "custom") return [fan.cpu, fan.gpu];
    return [0, 0];
  }

  // linuwu-sense resets the fans to auto when the platform profile changes, so the mode goes first.
  async function apply(index) {
    await load();
    const profile = state.profiles[index];
    if (!profile) return;
    state.active = index;
    await save();
    emit();
    try {
      await window.nitro.controls.setProfile(profile.mode);
      await window.nitro.controls.setFanSpeed(...fanSpeeds(profile.fan));
    } catch (error) {
      console.error("applying scenario failed", error);
      return;
    }
    const plugged = lastPower?.ac !== false;
    window.nitro.notify(
      `${profile.name} Enabled`,
      `${plugged ? "System mode (AC Plugged In):" : "Current system mode:"}\n${MODE_NAMES[profile.mode] ?? profile.mode}`,
    );
  }

  let lastPower = null;

  // Mode and fan changes made elsewhere (keys, other pages) are written into the active profile.
  async function sync(snapshot) {
    lastPower = snapshot.power;
    if (!state) await load();
    const profile = state.profiles[state.active];
    if (!profile) return;
    let changed = false;
    if (snapshot.profile && MODE_NAMES[snapshot.profile] && profile.mode !== snapshot.profile) {
      profile.mode = snapshot.profile;
      changed = true;
    }
    const fanMode = snapshot.fanMode?.mode;
    if (fanMode && profile.fan.mode !== fanMode) {
      profile.fan.mode = fanMode;
      if (fanMode === "custom") Object.assign(profile.fan, { cpu: snapshot.fanMode.cpu, gpu: snapshot.fanMode.gpu });
      changed = true;
    }
    if (changed) {
      save();
      emit();
    }
  }

  window.NitroScenario = {
    MODE_NAMES,
    FAN_NAMES,
    load,
    apply,
    sync,
    subscribe(listener) {
      listeners.add(listener);
      if (state) listener(state);
      return () => listeners.delete(listener);
    },
  };
})();
