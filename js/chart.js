/*
 * chart.js —— KM 生存曲线 SVG 渲染（阶梯线 + 置信区间带 + 可点击节点 + 十字线）。
 * 设计约束（dataviz 方法）：2px 线、节点 r>=4 带 2px 表面色环、区间带为系列色 10% 透明度、
 * 网格/坐标轴为浅一级实线、图例常驻（>=2 个系列）、末端直接标注（拥挤时让位于图例）、
 * 命中区域 >=24px、tooltip 不独占信息（风险表/明细表是其表格孪生）。
 * 曲线只画到最后一个退出时点（maxExit），样本耗尽后不外推。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KMChart = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const M = { top: 18, right: 96, bottom: 44, left: 56 };
  const W = 960, H = 460;
  const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

  // 1/2/2.5/5 × 10^k 的"好看"刻度
  function niceTicks(max, target) {
    target = target || 6;
    if (!(max > 0)) return { ticks: [0], max: 1 };
    const raw = max / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = 10 * mag;
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (raw <= m * mag) { step = m * mag; break; }
    }
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= niceMax + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { ticks, max: niceMax };
  }

  // 阶梯折线：S 只在故障时点下降，之后平到最后退出时点（不外推）
  function stepLinePath(steps, maxExit, x, y) {
    let d = `M ${x(0)} ${y(1)}`;
    let S = 1;
    for (const s of steps) {
      if (s.d > 0) {
        d += ` L ${x(s.t)} ${y(S)} L ${x(s.t)} ${y(s.S)}`;
        S = s.S;
      }
    }
    d += ` L ${x(maxExit)} ${y(S)}`;
    return d;
  }

  // 置信区间阶梯带（ci 为空的区段不画）
  function bandPath(steps, maxExit, x, y) {
    const seq = steps.filter((s) => s.ciLo !== null && s.ciHi !== null);
    if (!seq.length) return null;
    const lastIdx = steps.indexOf(seq[seq.length - 1]);
    const bandEnd = lastIdx + 1 < steps.length ? steps[lastIdx + 1].t : maxExit;
    let d = `M ${x(seq[0].t)} ${y(seq[0].ciHi)}`;
    for (let i = 1; i < seq.length; i++) {
      d += ` L ${x(seq[i].t)} ${y(seq[i - 1].ciHi)} L ${x(seq[i].t)} ${y(seq[i].ciHi)}`;
    }
    d += ` L ${x(bandEnd)} ${y(seq[seq.length - 1].ciHi)}`;
    d += ` L ${x(bandEnd)} ${y(seq[seq.length - 1].ciLo)}`;
    for (let i = seq.length - 1; i > 0; i--) {
      d += ` L ${x(seq[i].t)} ${y(seq[i].ciLo)} L ${x(seq[i - 1].t)} ${y(seq[i].ciLo)}`;
    }
    d += ` L ${x(seq[0].t)} ${y(seq[0].ciLo)} Z`;
    return d;
  }

  function el(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const pct = (v) => (v * 100).toFixed(1) + "%";

  /*
   * render(container, opts)
   * opts: {
   *   series: [{name, color, steps, maxExit, devices}],
   *   showCI, showCensor, selected: {name, t}|null,
   *   onSelect(name, t), Survival (引擎引用，用于 sAt/nAtRisk)
   * }
   */
  function render(container, opts) {
    const S = opts.Survival;
    container.textContent = "";
    const surface = cssVar("--surface-1") || "#fcfcfb";
    const ink = cssVar("--text-primary") || "#0b0b0b";
    const muted = cssVar("--text-muted") || "#898781";
    const grid = cssVar("--gridline") || "#e1e0d9";
    const axisInk = cssVar("--axis") || "#c3c2b7";

    const wrap = document.createElement("div");
    wrap.className = "km-chart";
    container.appendChild(wrap);

    const series = opts.series.filter((s) => s.steps.length);
    if (!series.length) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "当前筛选条件下没有可分析的设备。";
      wrap.appendChild(p);
      return;
    }

    const xMaxData = Math.max(...series.map((s) => s.maxExit), 1);
    const xt = niceTicks(xMaxData, 6);
    const x = (t) => M.left + (t / xt.max) * PW;
    const y = (v) => M.top + (1 - v) * PH;

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "首次故障生存曲线（Kaplan-Meier）",
    });
    wrap.appendChild(svg);

    // 网格与坐标轴
    for (const v of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      svg.appendChild(el("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), stroke: grid, "stroke-width": 1 }));
      const t = el("text", { x: M.left - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-text" });
      t.textContent = (v * 100).toFixed(0) + "%";
      svg.appendChild(t);
    }
    for (const v of xt.ticks) {
      svg.appendChild(el("line", { x1: x(v), x2: x(v), y1: M.top, y2: M.top + PH, stroke: grid, "stroke-width": 1 }));
      const t = el("text", { x: x(v), y: M.top + PH + 18, "text-anchor": "middle", class: "axis-text" });
      t.textContent = String(v);
      svg.appendChild(t);
    }
    svg.appendChild(el("line", { x1: M.left, x2: W - M.right, y1: y(0), y2: y(0), stroke: axisInk, "stroke-width": 1 }));
    const ylabel = el("text", { x: 14, y: M.top + PH / 2, "text-anchor": "middle", class: "axis-title",
      transform: `rotate(-90 14 ${M.top + PH / 2})` });
    ylabel.textContent = "首次故障生存率 S(t)";
    svg.appendChild(ylabel);
    const xlabel = el("text", { x: M.left + PW / 2, y: H - 6, "text-anchor": "middle", class: "axis-title" });
    xlabel.textContent = "投用后天数（设备年龄，天）";
    svg.appendChild(xlabel);

    // 系列：区间带 -> 阶梯线 -> 删失刻度 -> 节点 -> 末端标记
    const endLabels = [];
    for (const s of series) {
      const g = el("g", {});
      svg.appendChild(g);
      if (opts.showCI) {
        const bp = bandPath(s.steps, s.maxExit, x, y);
        if (bp) g.appendChild(el("path", { d: bp, fill: s.color, "fill-opacity": 0.1 }));
      }
      g.appendChild(el("path", {
        d: stepLinePath(s.steps, s.maxExit, x, y),
        fill: "none", stroke: s.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
      if (opts.showCensor) {
        for (const st of s.steps) {
          if (st.c > 0) {
            const yy = y(S.sAt(s.steps, st.t));
            g.appendChild(el("line", {
              x1: x(st.t), x2: x(st.t), y1: yy - 4, y2: yy + 4,
              stroke: s.color, "stroke-width": 1.5, "stroke-opacity": 0.65,
            }));
          }
        }
      }
      // 事件节点（可点击）
      for (const st of s.steps) {
        if (st.d === 0) continue;
        const selected = opts.selected && opts.selected.name === s.name && opts.selected.t === st.t;
        const hit = el("circle", {
          cx: x(st.t), cy: y(st.S), r: 13, fill: "transparent",
          tabindex: 0, role: "button", style: "cursor:pointer",
          "aria-label": `${s.name}，投用后第 ${st.t} 天：生存率 ${pct(st.S)}，在险 ${st.n}，故障 ${st.d}，删失 ${st.c}。回车查看详情`,
        });
        hit.dataset.model = s.name; hit.dataset.t = st.t;
        const dot = el("circle", {
          cx: x(st.t), cy: y(st.S), r: selected ? 5.5 : 4,
          fill: s.color, stroke: selected ? ink : surface, "stroke-width": 2,
          "pointer-events": "none",
        });
        g.appendChild(hit); g.appendChild(dot);
      }
      // 末端标记：曲线到此为止，不外推
      const lastS = S.sAt(s.steps, s.maxExit);
      const endN = S.nAtRisk(s.devices, s.maxExit);
      const endNote = endN === 0 ? "样本耗尽" : `观测结束（余 ${endN} 台）`;
      const capLine = el("line", {
        x1: x(s.maxExit), x2: x(s.maxExit), y1: y(lastS) - 6, y2: y(lastS) + 6,
        stroke: s.color, "stroke-width": 2,
      });
      const capTitle = el("title", {});
      capTitle.textContent = `${s.name}：${endNote}，曲线不再外推`;
      capLine.appendChild(capTitle);
      g.appendChild(capLine);
      endLabels.push({ name: s.name, y: y(lastS), x: x(s.maxExit), s: lastS });
    }

    // 末端直接标注：垂直间距不足 14px 时全部让位于图例+tooltip
    endLabels.sort((a, b) => a.y - b.y);
    let crowded = false;
    for (let i = 1; i < endLabels.length; i++) {
      if (endLabels[i].y - endLabels[i - 1].y < 14) { crowded = true; break; }
    }
    if (!crowded) {
      for (const L of endLabels) {
        // 估算文本宽度，贴右缘会溢出时改放到端点左侧
        const est = L.name.length * 7 + 40;
        const overflow = L.x + 8 + est > W - 4;
        const t = el("text", {
          x: overflow ? L.x - 8 : L.x + 8, y: L.y + 4,
          "text-anchor": overflow ? "end" : "start", class: "end-label",
        });
        t.textContent = `${L.name} ${pct(L.s)}`;
        svg.appendChild(t);
      }
    }

    // 十字线 + 统一 tooltip（一个 X 列出所有系列）
    const cross = el("line", { y1: M.top, y2: M.top + PH, stroke: muted, "stroke-width": 1, visibility: "hidden" });
    svg.appendChild(cross);
    const tip = document.createElement("div");
    tip.className = "km-tooltip";
    tip.style.display = "none";
    wrap.appendChild(tip);

    svg.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * (W / rect.width);
      if (px < M.left || px > W - M.right) { cross.setAttribute("visibility", "hidden"); tip.style.display = "none"; return; }
      const t = Math.round(((px - M.left) / PW) * xt.max);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px);
      cross.setAttribute("visibility", "visible");
      tip.textContent = "";
      const h = document.createElement("div");
      h.className = "tip-head";
      h.textContent = `投用后第 ${t} 天`;
      tip.appendChild(h);
      for (const s of series) {
        if (t > s.maxExit) continue;
        const row = document.createElement("div");
        row.className = "tip-row";
        const key = document.createElement("span");
        key.className = "tip-key"; key.style.background = s.color;
        const val = document.createElement("strong");
        val.textContent = pct(S.sAt(s.steps, t));
        const name = document.createElement("span");
        name.textContent = ` ${s.name} · 在险 ${S.nAtRisk(s.devices, t)}`;
        row.appendChild(key); row.appendChild(val); row.appendChild(name);
        tip.appendChild(row);
      }
      tip.style.display = "block";
      const wrapRect = wrap.getBoundingClientRect();
      let lx = ev.clientX - wrapRect.left + 14;
      if (lx + 220 > wrapRect.width) lx = ev.clientX - wrapRect.left - 230;
      tip.style.left = lx + "px";
      tip.style.top = Math.max(0, ev.clientY - wrapRect.top - 10) + "px";
    });
    svg.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      tip.style.display = "none";
    });
    svg.addEventListener("click", (ev) => {
      const c = ev.target.closest("circle[data-model]");
      if (c && opts.onSelect) opts.onSelect(c.dataset.model, +c.dataset.t);
    });
    svg.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches("circle[data-model]")) {
        ev.preventDefault();
        if (opts.onSelect) opts.onSelect(ev.target.dataset.model, +ev.target.dataset.t);
      }
    });

    // 图例（>=2 个系列时）
    if (series.length >= 2) {
      const leg = document.createElement("div");
      leg.className = "km-legend";
      for (const s of series) {
        const item = document.createElement("span");
        item.className = "legend-item";
        const sw = document.createElement("span");
        sw.className = "legend-line"; sw.style.background = s.color;
        const tx = document.createElement("span");
        tx.textContent = `${s.name}（${s.devices.length} 台）`;
        item.appendChild(sw); item.appendChild(tx);
        leg.appendChild(item);
      }
      wrap.appendChild(leg);
    }
    const note = document.createElement("p");
    note.className = "chart-note";
    note.textContent = "曲线仅画到各型号最后一个退出时点（竖线端标），样本耗尽后不外推；末端标注拥挤时以图例为准。";
    wrap.appendChild(note);
    return { xTicks: xt.ticks, xMax: xt.max };
  }

  return { render, niceTicks, stepLinePath, bandPath };
});
