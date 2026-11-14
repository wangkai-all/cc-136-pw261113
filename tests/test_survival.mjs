// tests/test_survival.mjs —— js/survival.js 的手算对照测试。
// 运行：node --test tests/test_survival.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Survival = require("../js/survival.js");

const D = (s) => Survival.parseDate(s); // "YYYY-MM-DD" -> ms
const rec = (o) => ({
  device_id: o.id || "X", model: o.model || "M", batch: o.batch || "B",
  commission_date: o.commission, observe_start: o.observe ?? o.commission,
  first_failure_date: o.failure ?? "", retire_date: o.retire ?? "",
  data_cutoff: o.cutoff ?? "",
});
const dev = (L, time, event) => ({ id: `${L}-${time}-${event}`, model: "M", batch: "B", L, time, event, censorReason: event ? null : "观测截止" });

test("基本 KM：无删失、无延迟进入", () => {
  const r = Survival.kmCurve([dev(0, 2, 1), dev(0, 3, 1), dev(0, 5, 1), dev(0, 5, 1), dev(0, 8, 1)]);
  const at = (t) => r.steps.find((s) => s.t === t);
  assert.equal(at(0).entered, 5);
  assert.equal(at(2).n, 5); assert.equal(at(2).d, 1); assert.ok(Math.abs(at(2).S - 0.8) < 1e-12);
  assert.equal(at(3).n, 4); assert.ok(Math.abs(at(3).S - 0.6) < 1e-12);
  assert.equal(at(5).n, 3); assert.equal(at(5).d, 2); assert.ok(Math.abs(at(5).S - 0.2) < 1e-12);
  assert.equal(at(8).n, 1); assert.equal(at(8).S, 0);
  assert.equal(at(8).ciLo, null); // n==d 时方差退化，不给区间
  assert.equal(r.median, 5);
  assert.equal(r.maxExit, 8);
});

test("延迟进入：投用到进入观测之间不计入在险", () => {
  const r = Survival.kmCurve([
    dev(0, 5, 1), dev(0, 12, 1), dev(10, 20, 1), dev(10, 25, 0),
  ]);
  const at = (t) => r.steps.find((s) => s.t === t);
  assert.equal(at(5).n, 2);  // C、D 第 10 天才进入，t=5 不在险
  assert.ok(Math.abs(at(5).S - 0.5) < 1e-12);
  assert.equal(at(10).entered, 2);
  assert.equal(at(12).n, 3);
  assert.ok(Math.abs(at(12).S - 1 / 3) < 1e-12);
  assert.equal(at(20).n, 2);
  assert.ok(Math.abs(at(20).S - 1 / 6) < 1e-12);
  assert.equal(at(25).c, 1);
  assert.ok(Math.abs(at(25).S - 1 / 6) < 1e-12); // 删失不改变 S
});

test("同一时点故障与删失：删失计入当点在险（视为故障之后）", () => {
  const r = Survival.kmCurve([dev(0, 5, 1), dev(0, 5, 0), dev(0, 8, 1)]);
  const at = (t) => r.steps.find((s) => s.t === t);
  assert.equal(at(5).n, 3); // 删失设备仍计入
  assert.equal(at(5).d, 1); assert.equal(at(5).c, 1);
  assert.ok(Math.abs(at(5).S - 2 / 3) < 1e-12);
  assert.equal(at(8).n, 1); // 删失已在 t=5 后移除
});

test("进入与故障同一时点：新进入者计入当点在险", () => {
  const r = Survival.kmCurve([dev(0, 5, 1), dev(5, 10, 1), dev(5, 12, 0)]);
  const at = (t) => r.steps.find((s) => s.t === t);
  assert.equal(at(5).entered, 2);
  assert.equal(at(5).n, 3);
  assert.ok(Math.abs(at(5).S - 2 / 3) < 1e-12);
});

test("Greenwood 与 log-log 置信区间（手算值）", () => {
  const r = Survival.kmCurve([dev(0, 1, 1), dev(0, 2, 1), dev(0, 3, 1), dev(0, 4, 1)]);
  const at = (t) => r.steps.find((s) => s.t === t);
  assert.ok(Math.abs(at(1).greenwood - 1 / 12) < 1e-12);
  assert.ok(Math.abs(at(2).greenwood - 0.25) < 1e-12);
  assert.ok(Math.abs(at(2).seLog - 0.5) < 1e-12);
  // t=2, S=0.5：log-log 95% CI ≈ [0.05785, 0.84487]
  assert.ok(Math.abs(at(2).ciLo - 0.0578541) < 1e-4);
  assert.ok(Math.abs(at(2).ciHi - 0.8448696) < 1e-4);
});

test("隔离规则 Q1..Q7", () => {
  const base = { commission: "2023-01-01", observe: "2023-02-01", cutoff: "2026-06-30" };
  const records = [
    rec({ ...base, id: "q1a", commission: "" }),
    rec({ ...base, id: "q1b", commission: "2023-13-45" }),
    rec({ ...base, id: "q2", retire: "2022-06-01" }),
    rec({ ...base, id: "q3", failure: "2022-06-01" }),
    rec({ ...base, id: "q4", observe: "2023-06-01", retire: "2023-03-01" }),
    rec({ ...base, id: "q5", failure: "2023-01-15" }), // observe=2023-02-01
    rec({ ...base, id: "q6", failure: "2024-01-01", retire: "2023-06-01" }),
    rec({ ...base, id: "q7", cutoff: "2022-06-01" }),
    rec({ ...base, id: "ok", failure: "2024-06-01" }),
  ];
  const a = Survival.buildAnalysis(records, { cutoffMs: D("2026-06-30") });
  const byId = Object.fromEntries(a.quarantined.map((q) => [q.record.device_id, q.rules.map((r) => r.code)]));
  assert.deepEqual(byId.q1a, ["Q1"]);
  assert.deepEqual(byId.q1b, ["Q1"]);
  assert.deepEqual(byId.q2, ["Q2", "Q4"]); // 退役既早于投用、也早于开始观测
  assert.deepEqual(byId.q3, ["Q3", "Q5"]); // 故障既早于投用、也早于开始观测
  assert.deepEqual(byId.q4, ["Q4"]);
  assert.deepEqual(byId.q5, ["Q5"]);
  assert.deepEqual(byId.q6, ["Q6"]);
  assert.deepEqual(byId.q7, ["Q7"]);
  assert.equal(a.quarantined.length, 8);
  assert.equal(a.devices.length, 1);
  assert.equal(a.devices[0].event, 1);
});

test("超窗故障按窗口末删失（A4），退役优先于截止", () => {
  const a = Survival.buildAnalysis([
    rec({ id: "late", commission: "2023-01-01", observe: "2023-01-01", failure: "2027-01-01", cutoff: "2026-06-30" }),
    rec({ id: "ret", commission: "2023-01-01", observe: "2023-01-01", retire: "2025-01-01", cutoff: "2026-06-30" }),
  ], { cutoffMs: D("2026-06-30") });
  assert.equal(a.devices.length, 2);
  const late = a.devices.find((x) => x.id === "late");
  assert.equal(late.event, 0);
  assert.equal(late.censorReason, "数据观测截止");
  assert.equal(late.time, Math.round((D("2026-06-30") - D("2023-01-01")) / Survival.DAY_MS));
  assert.ok(a.adjusted.some((x) => x.record.device_id === "late"));
  const ret = a.devices.find((x) => x.id === "ret");
  assert.equal(ret.censorReason, "退役");
});

test("修正项：开始观测缺失/早于投用按投用日进入；数据截止缺失用统一截止", () => {
  const a = Survival.buildAnalysis([
    rec({ id: "noobs", commission: "2023-01-01", observe: "", failure: "2024-01-01", cutoff: "2026-06-30" }),
    rec({ id: "early", commission: "2023-01-01", observe: "2022-06-01", failure: "2024-01-01", cutoff: "2026-06-30" }),
    rec({ id: "nocut", commission: "2023-01-01", observe: "2023-01-01", cutoff: "" }),
  ], { cutoffMs: D("2026-06-30") });
  assert.equal(a.devices.length, 3);
  assert.equal(a.devices.find((x) => x.id === "noobs").L, 0);
  assert.equal(a.devices.find((x) => x.id === "early").L, 0);
  const nocut = a.devices.find((x) => x.id === "nocut");
  assert.equal(nocut.censorReason, "统一观测截止");
  assert.equal(a.adjusted.length, 3);
});

test("开始观测晚于观测窗口末 -> 未进入分析（不隔离）", () => {
  const a = Survival.buildAnalysis([
    rec({ id: "late", commission: "2025-01-01", observe: "2026-01-01", cutoff: "2026-06-30" }),
  ], { cutoffMs: D("2025-06-30") });
  assert.equal(a.devices.length, 0);
  assert.equal(a.excluded.length, 1);
  assert.equal(a.quarantined.length, 0);
});

test("型号/批次过滤只影响分析集，不影响隔离清单", () => {
  const records = [
    rec({ id: "a1", model: "A", batch: "2023Q1", commission: "2023-01-01", failure: "2024-01-01", cutoff: "2026-06-30" }),
    rec({ id: "b1", model: "B", batch: "2023Q2", commission: "2023-01-01", failure: "2024-01-01", cutoff: "2026-06-30" }),
    rec({ id: "bad", model: "A", commission: "", cutoff: "2026-06-30" }),
  ];
  const a = Survival.buildAnalysis(records, { cutoffMs: D("2026-06-30"), models: new Set(["A"]) });
  assert.equal(a.devices.length, 1);
  assert.equal(a.devices[0].id, "a1");
  assert.equal(a.quarantined.length, 1); // 隔离清单仍是全量
});

test("nAtRisk / sAt 辅助函数", () => {
  const devices = [dev(0, 5, 1), dev(0, 8, 0), dev(10, 20, 1), dev(10, 25, 0)];
  assert.equal(Survival.nAtRisk(devices, 5), 2);
  assert.equal(Survival.nAtRisk(devices, 10), 2); // 前两台已在 t=5、8 退出
  assert.equal(Survival.nAtRisk(devices, 26), 0);
  const r = Survival.kmCurve(devices);
  // t=5: n=2,d=1 -> S=0.5；t=20: n=2,d=1 -> S=0.25
  assert.equal(Survival.sAt(r.steps, 4), 1);
  assert.ok(Math.abs(Survival.sAt(r.steps, 9) - 0.5) < 1e-12);
  assert.ok(Math.abs(Survival.sAt(r.steps, 20) - 0.25) < 1e-12);
});
