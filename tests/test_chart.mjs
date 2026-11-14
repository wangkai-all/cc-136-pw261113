// tests/test_chart.mjs —— 图表纯函数与整页数据流冒烟测试（无 DOM 部分）。
// 运行：node --test tests/test_chart.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const Survival = require("../js/survival.js");
const CSVUtil = require("../js/csv.js");
const KMChart = require("../js/chart.js");

// sample_data.js 写入 window.*，node 下用 globalThis 模拟
globalThis.window = globalThis;
require("../js/sample_data.js");

test("niceTicks 生成好看刻度且覆盖最大值", () => {
  const r = KMChart.niceTicks(1613, 6);
  assert.ok(r.max >= 1613);
  assert.equal(r.ticks[0], 0);
  assert.ok(r.ticks.length >= 4 && r.ticks.length <= 12);
  const step = r.ticks[1] - r.ticks[0];
  for (let i = 1; i < r.ticks.length; i++) {
    assert.ok(Math.abs(r.ticks[i] - r.ticks[i - 1] - step) < 1e-6);
  }
  assert.deepEqual(KMChart.niceTicks(0, 6), { ticks: [0], max: 1 });
});

test("stepLinePath：从 (0,1) 出发、只在故障点下降、终于 maxExit", () => {
  const x = (t) => t * 2, y = (v) => 100 - v * 100;
  const steps = [
    { t: 0, d: 0, S: 1 }, { t: 3, d: 1, S: 0.5 }, { t: 7, d: 0, S: 0.5 }, { t: 9, d: 1, S: 0 },
  ];
  const d = KMChart.stepLinePath(steps, 12, x, y);
  assert.ok(d.startsWith("M 0 0"));
  assert.ok(d.includes("L 6 0 L 6 50")); // t=3 处下降
  assert.ok(!d.includes("L 14"));        // t=7 是删失点，不产生下降
  assert.ok(d.includes("L 18 50 L 18 100"));
  assert.ok(d.endsWith("L 24 100"));     // 尾部平到 maxExit，不外推
});

test("bandPath：只在有 CI 的区段生成闭合阶梯带", () => {
  const x = (t) => t, y = (v) => 100 - v * 100;
  const steps = [
    { t: 0, d: 0, S: 1, ciLo: null, ciHi: null },
    { t: 2, d: 1, S: 0.8, ciLo: 0.5, ciHi: 0.95 },
    { t: 4, d: 1, S: 0.6, ciLo: 0.3, ciHi: 0.85 },
    { t: 6, d: 0, S: 0.6, ciLo: 0.3, ciHi: 0.85 },
  ];
  const d = KMChart.bandPath(steps, 10, x, y);
  assert.ok(d.startsWith("M 2 5"));   // 从第一个有 CI 的时点开始
  assert.ok(d.endsWith("Z"));
  assert.ok(d.includes("L 10"));      // 延伸到 maxExit
  assert.equal(KMChart.bandPath([{ t: 0, d: 0, S: 1, ciLo: null, ciHi: null }], 5, x, y), null);
});

test("示例数据全流程：解析 -> 分析 -> 曲线不变量", () => {
  const records = CSVUtil.parseObjects(window.SAMPLE_CSV);
  assert.ok(records.length > 400);
  let cutoffMs = null;
  for (const r of records) {
    const ms = Survival.parseDate(r.data_cutoff);
    if (typeof ms === "number") cutoffMs = cutoffMs === null ? ms : Math.max(cutoffMs, ms);
  }
  const a = Survival.buildAnalysis(records, { cutoffMs });
  assert.ok(a.quarantined.length >= 10, "示例数据应含隔离记录");
  assert.ok(a.adjusted.length >= 5, "示例数据应含修正记录");
  assert.ok(Object.keys(a.models).length === 3);

  for (const [name, km] of Object.entries(a.models)) {
    // S 单调不增
    for (let i = 1; i < km.steps.length; i++) {
      assert.ok(km.steps[i].S <= km.steps[i - 1].S + 1e-12, `${name} S 非单调`);
    }
    // 最后一个时点 == maxExit；在险数不为负
    assert.equal(km.steps[km.steps.length - 1].t, km.maxExit);
    for (const s of km.steps) {
      assert.ok(s.n >= s.d, `${name} t=${s.t} 在险小于故障`);
      assert.ok(s.n >= 0);
      // 同一时点：故障与删失都计入在险（约定可复查）
      if (s.d > 0 && s.c > 0) assert.ok(s.n >= s.d + s.c - 0);
      // CI 只在 0<S<1 时出现，且包含 S
      if (s.ciLo !== null) {
        assert.ok(s.ciLo <= s.S + 1e-9 && s.S <= s.ciHi + 1e-9, `${name} t=${s.t} CI 不含 S`);
      }
    }
    // 事件节点携带设备清单（时点详情用）
    const ev = km.steps.find((s) => s.d > 0);
    assert.ok(Array.isArray(ev.failIds) && ev.failIds.length === ev.d);
    assert.ok(Array.isArray(ev.enterIds) && Array.isArray(ev.censorIds));
  }
});

test("切换统一截止日：更早的截止只会增加删失、不会增加故障", () => {
  const records = CSVUtil.parseObjects(window.SAMPLE_CSV);
  const late = Survival.buildAnalysis(records, { cutoffMs: Survival.parseDate("2026-06-30") });
  const early = Survival.buildAnalysis(records, { cutoffMs: Survival.parseDate("2024-12-31") });
  const ev = (a) => a.devices.filter((d) => d.event === 1).length;
  assert.ok(ev(early) <= ev(late));
  assert.ok(early.devices.length <= late.devices.length);
});
