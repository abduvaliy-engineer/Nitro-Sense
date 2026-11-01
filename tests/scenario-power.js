// Scenario power-source checks on a fake window (no Electron, no hardware): node tests/scenario-power.js app
// Plugging in, unplugging and NitroSense's low-battery lock run the profile's mode for the new power state;
// they must not save the previous mode into the new slot.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const calls = [];
let now = 1_000_000;
class FakeDate extends Date {
  static now() {
    return now;
  }
}
const stored = {
  active: 0,
  select: 0,
  profiles: [{
    name: "Daily Use", mode: "balanced-performance", dcMode: "balanced",
    fan: { mode: "custom", cpu: 60, gpu: 50, cpuAuto: false, gpuAuto: false },
    lighting: { mode: "global", global: {}, keyboard: {} }, apps: [], appSync: true,
  }],
};
const window = {
  nitro: {
    settings: { get: async () => JSON.parse(JSON.stringify(stored)), set: async () => {} },
    controls: {
      setProfile: async (mode) => calls.push(`profile ${mode}`),
      setFanSpeed: async (cpu, gpu) => calls.push(`fan ${cpu},${gpu}`),
    },
    appSync: { configure: async () => {}, onSwitch: () => {} },
    lighting: { apply: async () => {} },
    notify: () => {},
  },
};
const context = vm.createContext({ window, console, setTimeout, clearTimeout, Date: FakeDate });
vm.runInContext(fs.readFileSync(path.resolve(process.argv[2] ?? "app", "renderer/scenario.js"), "utf8"), context);
const scenario = window.NitroScenario;

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got "${got}", want "${want}"`}`);
};
// A 2 s poll: power source, battery %, the live platform profile and fan mode.
const poll = (ac, battery, profile, fan = { mode: "custom", cpu: 60, gpu: 50 }) => {
  now += 3000;
  return scenario.sync({ power: { ac, battery }, profile, fanMode: fan });
};
const AUTO = { mode: "auto", cpu: 0, gpu: 0 };
const taken = () => {
  const list = calls.join(" | ");
  calls.length = 0;
  return list;
};

(async () => {
  const state = await scenario.load();
  const profile = () => state.profiles[state.active];

  await poll(true, 80, "balanced-performance");
  check("nothing runs while nothing changes", taken(), "");

  await poll(false, 80, "balanced-performance");
  check("unplugging runs the battery mode", taken(), "profile balanced");
  check("unplugging keeps the AC mode", profile().mode, "balanced-performance");

  await poll(false, 80, "low-power", AUTO);
  check("a mode picked on battery (Mode Switch Key: Eco) is saved as the battery mode", profile().dcMode, "low-power");
  check("saving it runs nothing", taken(), "");

  await poll(true, 80, "low-power", AUTO);
  check("plugging in runs the AC mode, then its fans", taken(), "profile balanced-performance | fan 60,50");
  check("plugging in doesn't save Eco as the AC mode", profile().mode, "balanced-performance");
  check("plugging in keeps the battery mode", profile().dcMode, "low-power");

  now += 1000 - 3000; // a reading taken right after, before the switch landed
  await poll(true, 80, "low-power", AUTO);
  check("a stale reading right after doesn't overwrite the AC mode", profile().mode, "balanced-performance");

  await poll(true, 80, "performance");
  check("a mode picked on AC (Mode Switch Key: Turbo) is saved as the AC mode", profile().mode, "performance");
  taken();

  await poll(false, 80, "performance");
  check("unplugging from Turbo runs the battery mode", taken(), "profile low-power");

  await poll(true, 30, "low-power", AUTO);
  check("plugging in below 40 % runs Balanced (the low-battery lock)", taken(), "profile balanced | fan 60,50");
  await poll(true, 30, "balanced");
  check("the lock's Balanced isn't saved as the AC mode", profile().mode, "performance");

  await poll(true, 40, "balanced");
  check("reaching 40 % runs the AC mode again", taken(), "profile performance | fan 60,50");

  console.log(fail ? `${fail} FAILED` : "all passed");
  process.exit(fail ? 1 : 0);
})();
