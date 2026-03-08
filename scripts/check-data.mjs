import fs from "node:fs";
import vm from "node:vm";

const files = [
  "data.js",
  "lrc_data.js",
  "lrc_altitude_limits_data.js",
  "driftdown_data.js",
  "eo_diversion_data.js",
  "flaps_up_data.js",
  "diversion_data.js",
  "go_around_data.js",
];
const context = { window: {} };
vm.createContext(context);

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(source, context, { filename: file });
}

const required = [
  "TABLE_DATA",
  "LRC_CRUISE_TABLE",
  "LRC_ALTITUDE_LIMITS_TABLE",
  "DRIFTDOWN_TABLE",
  "EO_DIVERSION_TABLE",
  "FLAPS_UP_TABLE",
  "DIVERSION_LRC_TABLE",
  "GO_AROUND_TABLE",
];
for (const key of required) {
  if (!(key in context.window)) {
    throw new Error(`Missing window.${key}`);
  }
}

const diversion = context.window.DIVERSION_LRC_TABLE;
if (!(diversion.low && diversion.high)) {
  throw new Error("DIVERSION_LRC_TABLE must contain low/high bands");
}

const goAround = context.window.GO_AROUND_TABLE;
if (!(goAround.flap20 && goAround.flap5)) {
  throw new Error("GO_AROUND_TABLE must contain flap20 and flap5");
}

const eoDiversion = context.window.EO_DIVERSION_TABLE;
if (!(eoDiversion.groundToAir && eoDiversion.fuelTime && eoDiversion.fuelAdjustment)) {
  throw new Error("EO_DIVERSION_TABLE must contain groundToAir/fuelTime/fuelAdjustment");
}

console.log("Data checks passed.");
