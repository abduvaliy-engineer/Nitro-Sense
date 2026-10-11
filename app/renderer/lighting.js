// Pulsar Lighting model rules (NitroSense LightingMgr): whether the keyboard is supported, the 4-zone
// effect list, 2025-model effect names and which controls each effect offers.
(() => {
  // NitroSense's Is2025Prezone list, as DMI product_name.
  const MODELS_2025 = new Set([
    "AN16-61", "AN16-74", "AN18-61", "AN18-71", "ANV14-62", "ANV14-71", "ANV16-61", "ANV16-72", "ANV17-61",
    "ANV17-71", "ANV16S-71", "ANV16S-61", "ANV16S-41", "AN16S-61", "ANV17-41", "ANV16-42", "ANV15-51",
    "ANV15-52", "AN16-A71", "ANE16-N51", "ANE16-151", "ANV16-I51", "ANV16-A71", "ANV17-131", "ANV15-131",
    "ANV15-A31",
  ].map((model) => `Nitro ${model}`).concat(
    ["PTN16-71", "PHN16S-71", "PHN14-71", "PHN16-73", "PHN18-72"].map((model) => `Predator ${model}`),
  ));

  const EFFECTS = ["STATIC", "BREATHING", "NEON", "WAVE", "SHIFTING", "ZOOM", "METEOR", "TWINKLING"];
  const NAMES = {
    STATIC: "Static", BREATHING: "Breathing", NEON: "Neon", WAVE: "Wave",
    SHIFTING: "Shifting", ZOOM: "Zoom", METEOR: "Meteor", TWINKLING: "Twinkling",
  };
  const NAMES_2025 = { ...NAMES, SHIFTING: "Ripple", METEOR: "Snake", TWINKLING: "Disco" };
  const ICONS_2025 = { SHIFTING: "EC_RIPPLE", METEOR: "EC_SNAKE", TWINKLING: "DISCO" };

  let info = null;
  let loading = null;

  function load() {
    loading ??= Promise.all([window.nitro.lighting.info(), window.nitro.system.info()])
      .then(([lighting, system]) => ({ supported: Boolean(lighting?.backend), is2025: MODELS_2025.has(system?.model?.trim()) }))
      .catch(() => ({ supported: false, is2025: false }))
      .then((result) => (info = result));
    return loading;
  }

  window.NitroLighting = {
    EFFECTS,
    load,
    get info() { return info; },
    name: (effect) => (info?.is2025 ? NAMES_2025 : NAMES)[effect] ?? effect,
    icon: (effect) => (info?.is2025 && ICONS_2025[effect]) || effect,
    // The effect shown on the keyboard: Area mode is static zone colors.
    current: (lighting) => (lighting?.mode === "area" ? "STATIC" : lighting?.global.effect),
    // "Auto" color: 2025 models lock every effect but Static; Neon and Wave never take a color.
    colorLocked: (effect) => effect !== "STATIC" && (info?.is2025 || effect === "NEON" || effect === "WAVE"),
    hasSpeed: (effect) => effect !== "STATIC",
    hasDirection: (effect) => effect === "WAVE" || (effect === "SHIFTING" && !info?.is2025),
  };
})();
