/* app.js —— 页面状态与 UI 渲染。计算全部在 js/survival.js，图表在 js/chart.js。 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_SERIES = 8; // 分类调色板槽位数，超出不允许再选（避免生成第 9 个色相）

  const state = {
    records: null,
    sourceName: "",
    allModels: [],
    allBatches: [],
    modelSlot: {},      // 型号 -> 固定色槽（颜色跟随实体，不随筛选重排）
    models: new Set(),
    batches: new Set(),
    cutoffMs: null,
    defaultCutoffMs: null,
    showCI: true,
    showCensor: false,
    selected: null,     // {name, t}
    analysis: null,
    chartInfo: null,
  };

  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // 调色板兜底：CSS 变量不可用（异常环境）时仍保证 8 个固定槽位色。与 css/style.css 中数值一致。
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  };
  const seriesColor = (slot) => {
    const v = cssVar("--series-" + slot);
    if (v) return v;
    const dark = document.documentElement.dataset.theme === "dark" ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches &&
        document.documentElement.dataset.theme !== "light");
    return PALETTE[dark ? "dark" : "light"][(slot - 1) % MAX_SERIES];
  };
  const fmtDate = (ms) => Survival.fmtDate(ms);
  const pct = (v) => (v * 100).toFixed(1) + "%";
  const fmt4 = (v) => (v === null || v === undefined ? "—" : (+v).toFixed(4));

  /* ---------------- 数据加载 ---------------- */

  function setData(records, sourceName) {
    if (!records.length) { alert("CSV 中没有数据行。"); return; }
    const need = ["device_id", "model", "batch", "commission_date", "observe_start",
      "first_failure_date", "retire_date", "data_cutoff"];
    const missing = need.filter((k) => !(k in records[0]));
    if (missing.length) { alert("CSV 缺少必需列：" + missing.join(", ")); return; }

    state.records = records;
    state.sourceName = sourceName;
    state.allModels = [...new Set(records.map((r) => String(r.model)))].sort();
    state.allBatches = [...new Set(records.map((r) => String(r.batch)))].sort();
    state.modelSlot = {};
    state.allModels.forEach((m, i) => { state.modelSlot[m] = (i % MAX_SERIES) + 1; });
    state.models = new Set(state.allModels.slice(0, MAX_SERIES));
    state.batches = new Set(state.allBatches);
    state.selected = null;

    // 默认统一截止 = 数据中最大 data_cutoff（与 verify_km.py 一致）
    let maxCut = null, maxAny = null;
    for (const r of records) {
      const c = Survival.parseDate(r.data_cutoff);
      if (typeof c === "number") maxCut = maxCut === null ? c : Math.max(maxCut, c);
      for (const k of ["commission_date", "observe_start", "first_failure_date", "retire_date"]) {
        const v = Survival.parseDate(r[k]);
        if (typeof v === "number") maxAny = maxAny === null ? v : Math.max(maxAny, v);
      }
    }
    state.defaultCutoffMs = maxCut !== null ? maxCut : maxAny;
    state.cutoffMs = state.defaultCutoffMs;

    buildFilterUI();
    $("data-source-info").textContent =
      `当前数据：${sourceName} · ${records.length} 条记录 · ${state.allModels.length} 个型号 · ${state.allBatches.length} 个批次`;
    for (const id of ["filter-card", "kpis", "chart-card"]) $(id).hidden = false;
    update();
  }

  /* ---------------- 筛选 UI ---------------- */

  function buildFilterUI() {
    const mc = $("model-chips");
    mc.textContent = "";
    for (const m of state.allModels) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.setAttribute("aria-pressed", state.models.has(m));
      b.style.setProperty("--chip-color", seriesColor(state.modelSlot[m]));
      const dot = document.createElement("span"); dot.className = "dot";
      const tx = document.createElement("span"); tx.textContent = m;
      b.appendChild(dot); b.appendChild(tx);
      b.addEventListener("click", () => {
        if (state.models.has(m)) state.models.delete(m);
        else {
          if (state.models.size >= MAX_SERIES) {
            alert(`最多同时对照 ${MAX_SERIES} 个型号（调色板槽位限制）。`);
            return;
          }
          state.models.add(m);
        }
        b.setAttribute("aria-pressed", state.models.has(m));
        state.selected = null;
        update();
      });
      mc.appendChild(b);
    }

    const bc = $("batch-chips");
    bc.textContent = "";
    for (const bname of state.allBatches) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.setAttribute("aria-pressed", "true");
      const tx = document.createElement("span"); tx.textContent = bname;
      b.appendChild(tx);
      b.addEventListener("click", () => {
        if (state.batches.has(bname)) state.batches.delete(bname);
        else state.batches.add(bname);
        b.setAttribute("aria-pressed", state.batches.has(bname));
        state.selected = null;
        update();
      });
      bc.appendChild(b);
    }

    // 统一截止：数据自带截止（默认）+ 各年末 + 自定义
    const sel = $("cutoff-select");
    sel.textContent = "";
    const opt = (v, label) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    };
    opt("default", `数据自带截止（${fmtDate(state.defaultCutoffMs)}）`);
    const minYear = new Date(Math.min(...state.records.map((r) => Survival.parseDate(r.commission_date)).filter((v) => typeof v === "number"))).getUTCFullYear();
    const maxYear = new Date(state.defaultCutoffMs).getUTCFullYear();
    for (let y = minYear; y <= maxYear; y++) opt(`${y}-12-31`, `${y} 年末`);
    opt("custom", "自定义…");
    sel.value = "default";
    $("cutoff-custom").hidden = true;
  }

  function currentCutoffFromUI() {
    const v = $("cutoff-select").value;
    if (v === "default") return state.defaultCutoffMs;
    if (v === "custom") {
      const ms = Survival.parseDate($("cutoff-custom").value);
      return typeof ms === "number" ? ms : state.defaultCutoffMs;
    }
    return Survival.parseDate(v);
  }

  /* ---------------- 主渲染 ---------------- */

  function update() {
    state.cutoffMs = currentCutoffFromUI();
    const a = Survival.buildAnalysis(state.records, {
      cutoffMs: state.cutoffMs,
      models: state.models,
      batches: state.batches,
    });
    state.analysis = a;

    renderKPIs(a);
    renderChart(a);
    renderRiskTable(a);
    renderDetail(a);
    renderStepsPane(a);
    renderQuarantinePane(a);

    $("cutoff-note").textContent =
      `统一观测截止日 ${fmtDate(state.cutoffMs)} 对所有型号一致生效；` +
      (a.excluded.length ? `当前截止下有 ${a.excluded.length} 台设备尚未进入观测（见「隔离与修正」）。` : "");
  }

  function renderKPIs(a) {
    const events = a.devices.filter((d) => d.event === 1).length;
    const cens = a.devices.length - events;
    const retired = a.devices.filter((d) => d.event === 0 && d.censorReason === "退役").length;
    const tiles = [
      { label: "纳入分析设备", value: a.devices.length, sub: `${state.models.size} 个型号 · ${state.batches.size} 个批次` },
      { label: "首次故障", value: events, sub: "观测窗口内记录到的首次故障" },
      { label: "右删失", value: cens, sub: `退役 ${retired} · 观测截止 ${cens - retired}` },
      { label: "隔离记录", value: a.quarantined.length, sub: `修正 ${a.adjusted.length} · 未进入分析 ${a.excluded.length}` },
    ];
    const k = $("kpis");
    k.textContent = "";
    for (const t of tiles) {
      const d = document.createElement("div");
      d.className = "kpi";
      const l = document.createElement("div"); l.className = "k-label"; l.textContent = t.label;
      const v = document.createElement("div"); v.className = "k-value"; v.textContent = t.value;
      const s = document.createElement("div"); s.className = "k-sub"; s.textContent = t.sub;
      d.appendChild(l); d.appendChild(v); d.appendChild(s);
      k.appendChild(d);
    }
  }

  function modelSeries(a) {
    return Object.keys(a.models).sort().map((name) => ({
      name,
      color: seriesColor(state.modelSlot[name]),
      steps: a.models[name].steps,
      maxExit: a.models[name].maxExit,
      devices: a.devices.filter((d) => d.model === name),
    }));
  }

  function renderChart(a) {
    state.chartInfo = KMChart.render($("chart"), {
      series: modelSeries(a),
      showCI: state.showCI,
      showCensor: state.showCensor,
      selected: state.selected,
      Survival,
      onSelect: (name, t) => {
        state.selected = state.selected && state.selected.name === name && state.selected.t === t
          ? null : { name, t };
        update();
      },
    });
  }

  function renderRiskTable(a) {
    const el = $("risk-table");
    el.textContent = "";
    if (!state.chartInfo) return;
    const times = state.chartInfo.xTicks;
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const h0 = document.createElement("th"); h0.textContent = "型号 \\ 投用后天数";
    hr.appendChild(h0);
    for (const t of times) {
      const th = document.createElement("th"); th.textContent = t;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const s of modelSeries(a)) {
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      const key = document.createElement("span");
      key.className = "legend-line"; key.style.background = s.color;
      key.style.marginRight = "6px";
      td0.appendChild(key);
      td0.appendChild(document.createTextNode(s.name));
      tr.appendChild(td0);
      for (const t of times) {
        const td = document.createElement("td");
        td.textContent = t <= s.maxExit ? Survival.nAtRisk(s.devices, t) : "—";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);
    const note = document.createElement("p");
    note.className = "chart-note";
    note.textContent = "「—」表示该型号曲线已结束（样本耗尽或观测结束），不再外推。";
    el.appendChild(note);
  }

  /* ---------------- 时点详情 ---------------- */

  function renderDetail(a) {
    const el = $("node-detail");
    if (!state.selected || !a.models[state.selected.name]) { el.hidden = true; return; }
    const { name, t } = state.selected;
    const step = a.models[name].steps.find((s) => s.t === t && s.d > 0);
    if (!step) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = "";

    const head = document.createElement("div");
    head.className = "detail-head";
    const h = document.createElement("h2");
    h.textContent = `${name} · 投用后第 ${t} 天`;
    const close = document.createElement("button");
    close.className = "btn ghost"; close.type = "button"; close.textContent = "关闭";
    close.addEventListener("click", () => { state.selected = null; update(); });
    head.appendChild(h); head.appendChild(close);
    el.appendChild(head);

    const stats = document.createElement("div");
    stats.className = "detail-stats";
    const items = [
      ["生存率 S(t)", pct(step.S)],
      ["95% 置信区间", step.ciLo === null ? "不可估计（样本耗尽）" : `${pct(step.ciLo)} ~ ${pct(step.ciHi)}`],
      ["在险设备", step.n],
      ["故障", step.d],
      ["删失", step.c],
      ["新进入", step.entered],
    ];
    for (const [l, v] of items) {
      const d = document.createElement("div");
      d.className = "detail-stat";
      const dl = document.createElement("div"); dl.className = "ds-label"; dl.textContent = l;
      const dv = document.createElement("div"); dv.className = "ds-value"; dv.textContent = v;
      d.appendChild(dl); d.appendChild(dv);
      stats.appendChild(d);
    }
    el.appendChild(stats);

    if (step.d > 0 && step.c > 0) {
      const note = document.createElement("div");
      note.className = "tie-note";
      note.textContent = `本时点同时发生故障与删失。按统一约定（先进入 → 再故障 → 后删失），` +
        `本时点 ${step.c} 台删失设备仍计入在险 ${step.n}，自下一时点起离开。`;
      el.appendChild(note);
    }

    const devs = a.devices.filter((d) => d.model === name);
    const cols = document.createElement("div");
    cols.className = "id-cols";
    const mkList = (title, ids, annotate) => {
      const box = document.createElement("div");
      const h4 = document.createElement("h3");
      h4.textContent = `${title}（${ids.length}）`;
      box.appendChild(h4);
      const list = document.createElement("div");
      list.className = "id-list";
      if (!ids.length) {
        list.textContent = "无";
      } else {
        for (const id of ids) {
          const row = document.createElement("div");
          row.textContent = annotate ? annotate(id) : id;
          list.appendChild(row);
        }
      }
      box.appendChild(list);
      return box;
    };
    const byId = Object.fromEntries(devs.map((d) => [d.id, d]));
    cols.appendChild(mkList("故障设备", step.failIds,
      (id) => `${id}（批次 ${byId[id] ? byId[id].batch : "?"}）`));
    cols.appendChild(mkList("本时点删失", step.censorIds,
      (id) => `${id}（${byId[id] && byId[id].censorReason ? byId[id].censorReason : "删失"}）`));
    cols.appendChild(mkList("本时点新进入", step.enterIds,
      (id) => `${id}（批次 ${byId[id] ? byId[id].batch : "?"}）`));
    el.appendChild(cols);

    const atRisk = devs.filter((d) => d.L <= t && d.time >= t).map((d) => d.id).sort();
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = `在险设备清单（${atRisk.length} 台，含本时点故障与删失）`;
    det.appendChild(sum);
    const list = document.createElement("div");
    list.className = "id-list";
    for (const id of atRisk) {
      const row = document.createElement("div");
      row.textContent = id;
      list.appendChild(row);
    }
    det.appendChild(list);
    el.appendChild(det);
  }

  /* ---------------- 计算明细 / 隔离页签 ---------------- */

  function renderStepsPane(a) {
    const el = $("steps-tables");
    el.textContent = "";
    const series = modelSeries(a);
    if (!series.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "当前筛选条件下没有可分析的设备。";
      el.appendChild(p);
      return;
    }
    for (const s of series) {
      const head = document.createElement("div");
      head.className = "model-head";
      const key = document.createElement("span");
      key.className = "legend-line"; key.style.background = s.color;
      const tx = document.createElement("span");
      const km = a.models[s.name];
      tx.textContent = `${s.name} —— ${km.nTotal} 台 · 故障 ${km.nEvents} · 删失 ${km.nCensored}` +
        (km.median !== null ? ` · 中位生存期 ${km.median} 天` : " · 中位生存期未达到");
      head.appendChild(key); head.appendChild(tx);
      el.appendChild(head);

      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      const table = document.createElement("table");
      const cols = ["t（天）", "新进入", "在险", "故障", "删失", "S(t)", "se(log S)", "CI 下限", "CI 上限"];
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const c of cols) {
        const th = document.createElement("th"); th.textContent = c;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const st of s.steps) {
        const tr = document.createElement("tr");
        const vals = [st.t, st.entered, st.n, st.d, st.c,
          fmt4(st.S), fmt4(st.seLog), fmt4(st.ciLo), fmt4(st.ciHi)];
        for (const v of vals) {
          const td = document.createElement("td"); td.textContent = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      el.appendChild(wrap);
    }
  }

  function renderQuarantinePane(a) {
    $("quarantine-badge").textContent = a.quarantined.length || "";
    const el = $("quarantine-tables");
    el.textContent = "";

    const section = (title, note) => {
      const h = document.createElement("h3");
      h.textContent = title;
      el.appendChild(h);
      if (note) {
        const p = document.createElement("p");
        p.className = "muted"; p.textContent = note;
        el.appendChild(p);
      }
    };
    const mkTable = (header, rows) => {
      if (!rows.length) {
        const p = document.createElement("p");
        p.className = "muted"; p.textContent = "无。";
        el.appendChild(p);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const c of header) {
        const th = document.createElement("th"); th.textContent = c; th.style.textAlign = "left";
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const r of rows) {
        const tr = document.createElement("tr");
        for (const v of r) {
          const td = document.createElement("td"); td.textContent = v; td.style.textAlign = "left";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      el.appendChild(wrap);
    };

    section(`隔离记录（${a.quarantined.length}）`, "日期倒置或首次故障早于可观察范围的记录不进入分析，全部列于此。");
    mkTable(
      ["设备编号", "型号", "批次", "投用", "开始观测", "首次故障", "退役", "数据截止", "触发规则"],
      a.quarantined.map((q) => [
        q.record.device_id, q.record.model, q.record.batch,
        q.record.commission_date, q.record.observe_start, q.record.first_failure_date,
        q.record.retire_date, q.record.data_cutoff,
        q.rules.map((r) => `${r.code} ${r.text}`).join("；"),
      ])
    );

    section(`修正记录（${a.adjusted.length}）`, "可保守修正的记录：修正后继续参与分析，修正内容列于此。");
    mkTable(
      ["设备编号", "型号", "批次", "修正说明"],
      a.adjusted.map((x) => [x.record.device_id, x.record.model, x.record.batch, x.notes.join("；")])
    );

    section(`未进入分析（${a.excluded.length}）`, "记录有效，但在当前统一观测截止日下尚未进入观测窗口。");
    mkTable(
      ["设备编号", "型号", "批次", "原因"],
      a.excluded.map((x) => [x.record.device_id, x.record.model, x.record.batch, x.reason])
    );
  }

  /* ---------------- 导出 ---------------- */

  function exportSteps() {
    const a = state.analysis;
    if (!a) return;
    const { header, rows } = Survival.stepsCSV(a); // 与 verify_km.py 的 km_steps_all.csv 同格式
    download("km_steps_export.csv", CSVUtil.toCSV(header, rows));
  }

  function download(name, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadTemplate() {
    const header = ["device_id", "model", "batch", "commission_date", "observe_start",
      "first_failure_date", "retire_date", "data_cutoff"];
    const rows = [
      ["AX100-2023Q1-0001", "AX-100", "2023Q1", "2023-01-15", "2023-02-01", "2024-03-20", "", "2026-06-30"],
      ["AX100-2023Q1-0002", "AX-100", "2023Q1", "2023-01-20", "", "", "2025-11-01", "2026-06-30"],
    ];
    download("devices_template.csv", CSVUtil.toCSV(header, rows));
  }

  /* ---------------- 页签 / 主题 ---------------- */

  function initTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b === btn));
        for (const pane of ["steps", "quarantine", "method"]) {
          $("pane-" + pane).hidden = btn.dataset.tab !== pane;
        }
      });
    });
  }

  function initTheme() {
    const store = {
      get() { try { return localStorage.getItem("km-theme"); } catch { return null; } },
      set(v) { try { localStorage.setItem("km-theme", v); } catch { /* 隐私模式等场景下静默失败 */ } },
    };
    const saved = store.get();
    if (saved) document.documentElement.dataset.theme = saved;
    const sync = () => {
      $("theme-toggle").textContent =
        document.documentElement.dataset.theme === "dark" ? "浅色模式" : "深色模式";
    };
    sync();
    $("theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      store.set(next);
      sync();
      if (state.analysis) update(); // 系列色取自 CSS 变量，换主题需重绘
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function init() {
    initTabs();
    initTheme();
    $("load-sample").addEventListener("click", () => {
      setData(CSVUtil.parseObjects(window.SAMPLE_CSV),
        `示例数据（种子 ${window.SAMPLE_META.seed}，scripts/generate_data.py 生成）`);
    });
    $("file-input").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => setData(CSVUtil.parseObjects(String(rd.result)), f.name);
      rd.readAsText(f, "utf-8");
      ev.target.value = "";
    });
    $("download-template").addEventListener("click", downloadTemplate);
    $("cutoff-select").addEventListener("change", () => {
      $("cutoff-custom").hidden = $("cutoff-select").value !== "custom";
      state.selected = null;
      update();
    });
    $("cutoff-custom").addEventListener("change", () => { state.selected = null; update(); });
    $("toggle-ci").addEventListener("change", (e) => { state.showCI = e.target.checked; update(); });
    $("toggle-censor").addEventListener("change", (e) => { state.showCensor = e.target.checked; update(); });
    $("export-steps").addEventListener("click", exportSteps);

    // 有内嵌示例数据时直接载入，打开页面即可看到曲线
    if (window.SAMPLE_CSV) {
      setData(CSVUtil.parseObjects(window.SAMPLE_CSV),
        `示例数据（种子 ${window.SAMPLE_META.seed}，scripts/generate_data.py 生成）`);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
