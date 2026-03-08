import { spawnSync } from "node:child_process";

const files = [
  "app.js",
  "data.js",
  "lrc_data.js",
  "eo_diversion_data.js",
  "flaps_up_data.js",
  "diversion_data.js",
  "go_around_data.js",
  "sw.js",
];

let hasError = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log("Syntax checks passed.");
