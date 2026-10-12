// Lighting encoder byte checks against the reports from Acer's Windows lighting service: node tests/lighting-encode.js app
const Module = require("module");
const orig = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? {} : orig.call(this, req, ...rest); };
const L = require(require("path").resolve(process.argv[2] ?? "app", "backend/lighting.js"));
const hex = (reports) => reports.map((r) => Buffer.from(r).toString("hex").replace(/(..)(?!$)/g, "$1 "));
const base = { speed: 3, brightness: 5, direction: 1, color: "#ffa000", colortype: 1 };
const g = (effect, extra = {}) => ({ mode: "global", global: { ...base, effect, ...extra }, keyboard: {} });
const zones = ["#ff0000", "#00ff00", "#0000ff", "#ffffff"];
const area = (effect, extra = {}) => ({ mode: "area", global: { ...base, effect: "WAVE" }, keyboard: { ...base, effect, zones, ...extra } });
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : `  want ${JSON.stringify(want)}`}`);
};
check("enek global WAVE s3 b5 RIGHT", hex(L.encode("enek", g("WAVE"))), ["a4 21 07 64 05 01 00 00 00 0f 00"]);
check("enek global WAVE LEFT", hex(L.encode("enek", g("WAVE", { direction: 2 }))), ["a4 21 07 64 05 02 00 00 00 0f 00"]);
check("enek global BREATHING #ffa000", hex(L.encode("enek", g("BREATHING"))), ["a4 21 04 64 05 01 ff a0 00 0f 00"]);
check("enek global STATIC #ffa000", hex(L.encode("enek", g("STATIC"))), ["a4 21 02 64 00 00 ff a0 00 0f 00"]);
check("enek SHIFTING is 08, speed 5 -> 9", hex(L.encode("enek", g("SHIFTING", { speed: 5 }))), ["a4 21 08 64 09 01 ff a0 00 0f 00"]);
check("enek NEON no color, b1 -> 0", hex(L.encode("enek", g("NEON", { brightness: 1 }))), ["a4 21 05 00 05 01 00 00 00 0f 00"]);
check("enek METEOR/TWINKLING/ZOOM bytes", [g("METEOR"), g("TWINKLING"), g("ZOOM")].map((l) => hex(L.encode("enek", l))[0].slice(6, 8)), ["0a", "0b", "09"]);
check("enek unknown effect -> NEON", hex(L.encode("enek", g("RAIN_DROP")))[0].slice(6, 8), "05");
check("enek area static 4 zones b3", hex(L.encode("enek", area("STATIC", { brightness: 3 }))), [
  "a4 21 02 32 00 00 ff 00 00 01 00", "a4 21 02 32 00 00 00 ff 00 02 00", "a4 21 02 32 00 00 00 00 ff 04 00", "a4 21 02 32 00 00 ff ff ff 08 00"]);
check("enek area BREATHING uses keyboard effect", hex(L.encode("enek", area("BREATHING"))), ["a4 21 04 64 05 01 ff a0 00 0f 00"]);
check("enek flash balanced", hex(L.flashPayload("enek", L.FLASH_COLORS.balanced)), ["a4 21 06 64 00 02 00 ae c7 0f 00"]);
check("4z global STATIC", L.encode("four_zone", g("STATIC")), [["four_zone_mode", "0,0,100,0,255,160,0"]]);
check("4z global WAVE LEFT s1", L.encode("four_zone", g("WAVE", { direction: 2, speed: 1 })), [["four_zone_mode", "3,1,100,2,0,0,0"]]);
check("4z SHIFTING dir 1", L.encode("four_zone", g("SHIFTING")), [["four_zone_mode", "4,5,100,1,255,160,0"]]);
check("4z area static", L.encode("four_zone", area("STATIC", { brightness: 2 })), [["per_zone_mode", "ff0000,00ff00,0000ff,ffffff,25"]]);
check("4z bad zone color -> off", L.encode("four_zone", area("STATIC", { zones: ["#12", null, "#ABCDEF", "#00ff00"] })), [["per_zone_mode", "000000,000000,abcdef,00ff00,100"]]);
check("4z flash turbo", L.flashPayload("four_zone", L.FLASH_COLORS.performance), [["four_zone_mode", "0,0,100,0,199,0,255"]]);
check("out-of-range levels clamp", hex(L.encode("enek", g("BREATHING", { speed: 99, brightness: -4 }))), ["a4 21 04 00 09 01 ff a0 00 0f 00"]);
try { L.encode("enek", {}); check("missing lighting throws", false, true); } catch { check("missing lighting throws", true, true); }
console.log(fail ? `${fail} FAILED` : "all passed");
process.exit(fail ? 1 : 0);
