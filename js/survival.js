/*
 * survival.js —— 首次故障生存分析引擎（Kaplan-Meier，含延迟进入与右删失）。
 * 纯计算、无 DOM 依赖；浏览器挂 window.Survival，Node 下可 require。
 *
 * 口径约定（与 scripts/verify_km.py 完全一致，页面"口径与假设"页签可见）：
 *  - 时间原点：投用日期；时间单位：天（设备年龄）。
 *  - 延迟进入（左截断）：设备自 observe_start（开始观测）起才进入在险集合，
 *    即进入时间 L = observe_start - commission；L<0 时按 0 处理（修正记录）。
 *  - 观测窗口：[observe_start, min(retire_date, data_cutoff, 统一截止日)]。
 *  - 窗口内记录到首次故障 -> 事件，T = first_failure - commission；
 *    否则在窗口末右删失（退役 / 数据截止 / 统一截止，取先到者）。
 *  - 故障日期晚于窗口末 -> 按窗口末删失（修正记录 A4）。
 *  - 同一时点 t 的处理顺序：先计入新进入（L<=t），再发生故障，最后移除删失；
 *    即 t 时刻删失的设备仍计入 t 的在险数 n(t)。
 *  - 置信区间：Greenwood 方差 + log-log 变换，z 默认 1.959964（95%）。
 *  - 曲线不向外推：只画到最后一个退出（故障或删失）时点为止。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.Survival = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DAY_MS = 86400000;
  const Z_DEFAULT = 1.959963984540054; // 95% 双侧

  // 解析 YYYY-MM-DD；空串 -> null；非法 -> "INVALID"
  function parseDate(s) {
    if (s === null || s === undefined) return null;
    const t = String(s).trim();
    if (t === "") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (!m) return "INVALID";
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "INVALID";
    const ms = Date.UTC(y, mo - 1, d);
    const dt = new Date(ms);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return "INVALID"; // 例如 2023-02-30
    }
    return ms;
  }

  function fmtDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  const RULE_TEXT = {
    Q1: "必需日期缺失或无法解析（投用/开始观测/首次故障/退役/观测截止）",
    Q2: "日期倒置：退役日期早于投用日期",
    Q3: "日期倒置：首次故障早于投用日期",
    Q4: "日期倒置：退役日期早于开始观测（设备从未进入可观测状态）",
    Q5: "首次故障早于可观察范围（故障日期早于开始观测）",
    Q6: "日期倒置：退役日期早于首次故障",
    Q7: "日期倒置：数据观测截止早于投用日期",
  };

  /*
   * buildAnalysis(records, opts)
   * records: 原始行对象数组，字段为字符串：
   *   {device_id, model, batch, commission_date, observe_start,
   *    first_failure_date, retire_date, data_cutoff}
   * opts: {cutoffMs: number|null, models: Set|null, batches: Set|null, z: number}
   * 返回 {quarantined, adjusted, excluded, devices, models, cutoffMs}
   */
  function buildAnalysis(records, opts) {
    opts = opts || {};
    const z = opts.z || Z_DEFAULT;
    const cutoffMs = opts.cutoffMs === undefined ? null : opts.cutoffMs;
    const modelFilter = opts.models || null;
    const batchFilter = opts.batches || null;

    const quarantined = []; // {record, rules:[{code,text}]}
    const adjusted = [];    // {record, notes:[string]}
    const excluded = [];    // {record, reason}
    const devices = [];     // 分析用设备

    for (const rec of records) {
      const rules = [];
      const notes = [];
      const d = {
        commission: parseDate(rec.commission_date),
        observe: parseDate(rec.observe_start),
        failure: parseDate(rec.first_failure_date),
        retire: parseDate(rec.retire_date),
        cutoff: parseDate(rec.data_cutoff),
      };
      // Q1：投用必填；其余字段"填写了就必须合法"
      if (d.commission === null || d.commission === "INVALID") rules.push("Q1");
      for (const k of ["observe", "failure", "retire", "cutoff"]) {
        if (d[k] === "INVALID") rules.push("Q1");
      }
      if (rules.length === 0) {
        const c = d.commission;
        if (d.retire !== null && d.retire < c) rules.push("Q2");
        if (d.failure !== null && d.failure < c) rules.push("Q3");
        if (d.observe !== null && d.retire !== null && d.retire < d.observe) rules.push("Q4");
        if (d.failure !== null && d.observe !== null && d.failure < d.observe) rules.push("Q5");
        if (d.failure !== null && d.retire !== null && d.retire < d.failure) rules.push("Q6");
        if (d.cutoff !== null && d.cutoff < c) rules.push("Q7");
      }
      if (rules.length) {
        quarantined.push({
          record: rec,
          rules: [...new Set(rules)].map((code) => ({ code, text: RULE_TEXT[code] })),
        });
        continue;
      }

      // ---- 可修正项 ----
      const c = d.commission;
      let L;
      if (d.observe === null) {
        L = 0;
        notes.push("开始观测缺失，按投用日进入（L=0）");
      } else if (d.observe < c) {
        L = 0;
        notes.push("开始观测早于投用，按投用日进入（L=0）");
      } else {
        L = Math.round((d.observe - c) / DAY_MS);
      }
      if (d.cutoff === null) {
        notes.push("数据观测截止缺失，仅按统一观测截止处理");
      }

      // 观测窗口末端：min(退役, 数据截止, 统一截止)
      const ends = [];
      if (d.retire !== null) ends.push({ ms: d.retire, why: "退役" });
      if (d.cutoff !== null) ends.push({ ms: d.cutoff, why: "数据观测截止" });
      if (cutoffMs !== null) ends.push({ ms: cutoffMs, why: "统一观测截止" });
      if (!ends.length) {
        excluded.push({ record: rec, reason: "观测窗口无法确定（退役/数据截止/统一截止均缺失）" });
        continue;
      }
      ends.sort((a, b) => a.ms - b.ms);
      const end = ends[0];

      const Lms = c + L * DAY_MS;
      if (Lms > end.ms) {
        excluded.push({
          record: rec,
          reason: `开始观测（${fmtDate(Lms)}）晚于观测窗口末（${fmtDate(end.ms)}，${end.why}），未进入分析`,
        });
        continue;
      }

      let event = 0;
      let timeMs = end.ms;
      let censorReason = end.why;
      if (d.failure !== null) {
        if (d.failure <= end.ms) {
          event = 1;
          timeMs = d.failure;
          censorReason = null;
        } else {
          notes.push(`首次故障日期（${fmtDate(d.failure)}）晚于观测窗口末（${fmtDate(end.ms)}，${end.why}），按窗口末右删失`);
        }
      }

      const dev = {
        id: String(rec.device_id ?? ""),
        model: String(rec.model ?? ""),
        batch: String(rec.batch ?? ""),
        L,
        time: Math.round((timeMs - c) / DAY_MS),
        event,
        censorReason, // event=1 时为 null
        commissionMs: c,
      };
      if (notes.length) adjusted.push({ record: rec, notes });
      devices.push(dev);
    }

    // 型号/批次过滤只影响进入分析的设备，隔离清单始终展示全量
    const inScope = devices.filter(
      (x) =>
        (!modelFilter || modelFilter.has(x.model)) &&
        (!batchFilter || batchFilter.has(x.batch))
    );

    const models = {};
    for (const dev of inScope) {
      (models[dev.model] = models[dev.model] || []).push(dev);
    }
    const modelResults = {};
    for (const name of Object.keys(models)) {
      modelResults[name] = kmCurve(models[name], z);
    }

    return { quarantined, adjusted, excluded, devices: inScope, models: modelResults, cutoffMs };
  }

  /*
   * kmCurve(devices, z) —— 单组 Kaplan-Meier。
   * devices: [{id, L, time, event, censorReason, batch}]
   * 返回 {steps, nTotal, nEvents, nCensored, maxExit, median}
   * steps 覆盖所有"有变化"的时点（进入/故障/删失），列为：
   *   {t, entered, n, d, c, S, greenwood, seLog, ciLo, ciHi,
   *    failIds, censorIds, enterIds}
   */
  function kmCurve(devices, z) {
    z = z || Z_DEFAULT;
    const times = new Set([0]); // t=0 初始行：展示期初进入
    for (const x of devices) {
      times.add(x.time);
      if (x.L > 0) times.add(x.L);
    }
    const sorted = [...times].sort((a, b) => a - b);

    let S = 1;
    let greenwood = 0;
    const steps = [];
    for (const t of sorted) {
      let entered = 0, d = 0, c = 0, n = 0;
      const failIds = [], censorIds = [], enterIds = [];
      for (const x of devices) {
        if (x.L === t) { entered++; enterIds.push(x.id); }
        if (x.L <= t && x.time >= t) n++; // 在险：已进入且尚未退出（删失视为在故障之后）
        if (x.time === t) {
          if (x.event === 1) { d++; failIds.push(x.id); }
          else { c++; censorIds.push(x.id); }
        }
      }
      if (d > 0) {
        S = S * (1 - d / n);
        if (n > d) greenwood += d / (n * (n - d));
        else greenwood = Infinity; // n==d：S 降至 0 或更低，方差退化
      }
      const seLog = Math.sqrt(greenwood);
      let ciLo = null, ciHi = null;
      // S 与 Greenwood 累积量在非故障时点不变，故区间在任意时点都可给出（阶梯带）
      if (S > 0 && S < 1 && isFinite(greenwood) && greenwood > 0) {
        const seTheta = seLog / Math.abs(Math.log(S));
        ciLo = Math.exp(-Math.exp(Math.log(-Math.log(S)) + z * seTheta));
        ciHi = Math.exp(-Math.exp(Math.log(-Math.log(S)) - z * seTheta));
      }
      steps.push({ t, entered, n, d, c, S, greenwood: isFinite(greenwood) ? greenwood : null,
                   seLog: isFinite(greenwood) ? seLog : null, ciLo, ciHi,
                   failIds, censorIds, enterIds });
    }
    const nEvents = devices.filter((x) => x.event === 1).length;
    const maxExit = devices.length ? Math.max(...devices.map((x) => x.time)) : 0;
    const lastEventStep = [...steps].reverse().find((s) => s.d > 0);
    const medianStep = steps.find((s) => s.S <= 0.5);
    return {
      steps,
      nTotal: devices.length,
      nEvents,
      nCensored: devices.length - nEvents,
      maxExit,
      lastEventT: lastEventStep ? lastEventStep.t : null,
      median: medianStep ? medianStep.t : null,
    };
  }

  // 任意时点 t 的在险数（用于"每个区间剩余样本"表）
  function nAtRisk(devices, t) {
    let n = 0;
    for (const x of devices) if (x.L <= t && x.time >= t) n++;
    return n;
  }

  // 时点 t 的 S 值（阶梯函数：取最后一个 d>0 且 <=t 的步）
  function sAt(steps, t) {
    let S = 1;
    for (const s of steps) {
      if (s.t > t) break;
      S = s.S;
    }
    return S;
  }

  // 与 scripts/verify_km.py 的 format(x, ".12g") 对齐的数字格式（导出 CSV 用，
  // 保证页面导出与 verify_km.py 输出可逐字节 diff）
  function fmtNum(x) {
    if (x === null || x === undefined) return "";
    if (Number.isInteger(x)) return String(x);
    const exp = Math.floor(Math.log10(Math.abs(x)));
    if (exp < -4 || exp >= 12) {
      let s = x.toExponential(11).replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
      return s.replace(/e([+-])(\d)$/, "e$10$2"); // 指数补齐两位，对齐 Python
    }
    return String(parseFloat(x.toPrecision(12)));
  }

  // 计算明细导出（与 verify_km.py 的 km_steps_all.csv 同格式）
  function stepsCSV(analysis) {
    const header = ["model", "t", "entered", "n_risk", "failures", "censored",
      "S", "se_log", "ci_lo", "ci_hi"];
    const rows = [];
    for (const name of Object.keys(analysis.models).sort()) {
      for (const s of analysis.models[name].steps) {
        rows.push([name, s.t, s.entered, s.n, s.d, s.c,
          fmtNum(s.S), fmtNum(s.seLog), fmtNum(s.ciLo), fmtNum(s.ciHi)]);
      }
    }
    return { header, rows };
  }

  return { parseDate, fmtDate, buildAnalysis, kmCurve, nAtRisk, sAt, fmtNum, stepsCSV, RULE_TEXT, Z_DEFAULT, DAY_MS };
});
