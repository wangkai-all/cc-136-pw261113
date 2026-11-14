// tests/test_export_csv.mjs —— 页面导出 CSV 与 verify_km.py 输出逐字节一致。
// 这是「导出计算明细 -> diff out/km_steps_all.csv」复查路径的自动化保证。
// 运行：node --test tests/test_export_csv.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const Survival = require("../js/survival.js");
const CSVUtil = require("../js/csv.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("fmtNum 与 Python .12g 对齐", () => {
  const py = (x) =>
    execFileSync("python3", ["-c", `import sys; x=float(sys.argv[1]); print(format(x, ".12g"))`, String(x)],
      { encoding: "utf8" }).trim();
  for (const x of [0.992, 0.00803219328902, 1 / 3, 0.00001, 1.5e-7, 123456.789, 0.1 + 0.2]) {
    assert.equal(Survival.fmtNum(x), py(x), `fmtNum(${x})`);
  }
  assert.equal(Survival.fmtNum(1), "1");
  assert.equal(Survival.fmtNum(0), "0");
  assert.equal(Survival.fmtNum(null), "");
});

test("导出 CSV 与 verify_km.py 的 km_steps_all.csv 逐字节一致", () => {
  const csvPath = join(root, "data", "sample_devices.csv");
  const records = CSVUtil.parseObjects(readFileSync(csvPath, "utf8"));
  let cutoffMs = null;
  for (const r of records) {
    const ms = Survival.parseDate(r.data_cutoff);
    if (typeof ms === "number") cutoffMs = cutoffMs === null ? ms : Math.max(cutoffMs, ms);
  }
  const analysis = Survival.buildAnalysis(records, { cutoffMs });
  const { header, rows } = Survival.stepsCSV(analysis);
  const pageCSV = CSVUtil.toCSV(header, rows);

  const outDir = mkdtempSync(join(tmpdir(), "km-verify-"));
  execFileSync("python3", [join(root, "scripts", "verify_km.py"), csvPath, "--out", outDir]);
  const pyCSV = readFileSync(join(outDir, "km_steps_all.csv"), "utf8");

  writeFileSync(join(outDir, "km_steps_export.csv"), pageCSV); // 便于失败时人工 diff
  assert.equal(pageCSV, pyCSV, "页面导出与 verify_km.py 输出不一致");
});
