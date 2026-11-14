// tests/compare_engines.mjs —— JS 引擎与 Python 引擎在示例数据上逐步对照。
// 运行：node tests/compare_engines.mjs
// 退出码非 0 表示两套实现不一致（页面计算不可信，需排查）。
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const Survival = require("../js/survival.js");
const CSVUtil = require("../js/csv.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = join(root, "data", "sample_devices.csv");
const records = CSVUtil.parseObjects(readFileSync(csvPath, "utf8"));

// 统一截止默认值 = 数据中最大 data_cutoff（与 verify_km.py 的 default_cutoff 一致）
let cutoffMs = null;
for (const r of records) {
  const ms = Survival.parseDate(r.data_cutoff);
  if (typeof ms === "number" && (cutoffMs === null || ms > cutoffMs)) cutoffMs = ms;
}

const js = Survival.buildAnalysis(records, { cutoffMs });
const pyJson = execFileSync(
  "python3", [join(root, "scripts", "verify_km.py"), csvPath, "--json"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);
const py = JSON.parse(pyJson);

let failures = 0;
const fail = (msg) => { failures++; console.error("MISMATCH:", msg); };

const close = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
};

// 计数对照
if (js.quarantined.length !== py.counts.quarantined)
  fail(`quarantined: js=${js.quarantined.length} py=${py.counts.quarantined}`);
if (js.adjusted.length !== py.counts.adjusted)
  fail(`adjusted: js=${js.adjusted.length} py=${py.counts.adjusted}`);
if (js.excluded.length !== py.counts.excluded)
  fail(`excluded: js=${js.excluded.length} py=${py.counts.excluded}`);
if (js.devices.length !== py.counts.analyzed)
  fail(`analyzed: js=${js.devices.length} py=${py.counts.analyzed}`);

// 逐步对照
const jsModels = Object.keys(js.models).sort();
const pyModels = Object.keys(py.models).sort();
if (JSON.stringify(jsModels) !== JSON.stringify(pyModels))
  fail(`models: js=${jsModels} py=${pyModels}`);

let nSteps = 0;
for (const m of jsModels) {
  const jsSteps = js.models[m].steps;
  const pySteps = py.models[m].steps;
  if (jsSteps.length !== pySteps.length) {
    fail(`${m}: step count js=${jsSteps.length} py=${pySteps.length}`);
    continue;
  }
  for (let i = 0; i < jsSteps.length; i++) {
    const a = jsSteps[i], b = pySteps[i];
    nSteps++;
    for (const k of ["t", "entered", "n", "d", "c"]) {
      if (a[k] !== b[k]) fail(`${m} step ${i} (t=${a.t}): ${k} js=${a[k]} py=${b[k]}`);
    }
    for (const [jk, pk] of [["S", "S"], ["seLog", "seLog"], ["ciLo", "ciLo"], ["ciHi", "ciHi"]]) {
      if (!close(a[jk], b[pk])) fail(`${m} step ${i} (t=${a.t}): ${jk} js=${a[jk]} py=${b[pk]}`);
    }
  }
  for (const k of ["nTotal", "nEvents", "nCensored", "maxExit"]) {
    if (js.models[m][k] !== py.models[m][k])
      fail(`${m}: ${k} js=${js.models[m][k]} py=${py.models[m][k]}`);
  }
}

if (failures) {
  console.error(`\nFAIL: ${failures} 处不一致（对照了 ${jsModels.length} 个型号、${nSteps} 个时点）`);
  process.exit(1);
}
console.log(`PASS: JS 与 Python 引擎一致 —— ${jsModels.length} 个型号、${nSteps} 个时点逐步相同；` +
  `纳入 ${js.devices.length} 台，隔离 ${js.quarantined.length} 条，修正 ${js.adjusted.length} 条，未进入 ${js.excluded.length} 条`);
