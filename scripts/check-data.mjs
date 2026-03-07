import fs from "node:fs";
import vm from "node:vm";

const files = ["data.js", "lrc_data.js", "flaps_up_data.js", "diversion_data.js"];
const context = { window: {} };
vm.createContext(context);

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(source, context, { filename: file });
}

const required = ["TABLE_DATA", "LRC_CRUISE_TABLE", "FLAPS_UP_TABLE", "DIVERSION_LRC_TABLE"];
for (const key of required) {
  if (!(key in context.window)) {
    throw new Error(`Missing window.${key}`);
  }
}

const diversion = context.window.DIVERSION_LRC_TABLE;
if (!(diversion.low && diversion.high)) {
  throw new Error("DIVERSION_LRC_TABLE must contain low/high bands");
}

console.log("Data checks passed.");
