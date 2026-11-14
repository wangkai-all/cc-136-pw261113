// tests/test_dom_smoke.mjs —— 用 jsdom 对整页做 DOM 冒烟测试（可选，需要 jsdom）。
// 运行：NODE_PATH=/tmp/domtest/node_modules node --test tests/test_dom_smoke.mjs
// （或任何安装了 jsdom 的位置；未安装时自动跳过）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let JSDOM = null;
try { JSDOM = require("jsdom").JSDOM; } catch { /* jsdom 未安装则跳过 */ }

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function buildPage() {
  const html = read("index.html");
  const dom = new JSDOM(html, { url: "https://local.test/index.html", runScripts: "outside-only" });
  const { window } = dom;
  // jsdom 不加载外部样式表，内联 CSS 让 getComputedStyle 能取到自定义属性
  const style = window.document.createElement("style");
  style.textContent = read("css/style.css");
  window.document.head.appendChild(style);
  for (const src of ["js/csv.js", "js/survival.js", "js/sample_data.js", "js/chart.js", "js/app.js"]) {
    window.eval(read(src));
  }
  return window;
}

test("整页 DOM 冒烟：加载示例数据并渲染全部区域", { skip: !JSDOM }, () => {
  const w = buildPage();
  const d = w.document;

  // 自动载入示例数据
  assert.ok(d.getElementById("data-source-info").textContent.includes("示例数据"));
  assert.ok(!d.getElementById("filter-card").hidden);

  // KPI 四块
  assert.equal(d.querySelectorAll("#kpis .kpi").length, 4);
  assert.ok(d.querySelector("#kpis .k-value").textContent.length > 0);

  // 图表：3 条系列线、事件节点、图例、风险表
  const svg = d.querySelector("#chart svg");
  assert.ok(svg, "应有 SVG 图");
  const lines = svg.querySelectorAll('path[stroke-width="2"]');
  assert.equal(lines.length, 3);
  const nodes = svg.querySelectorAll("circle[data-model]");
  assert.ok(nodes.length > 50, "应有很多可点击事件节点");
  assert.equal(d.querySelectorAll(".km-legend .legend-item").length, 3);
  assert.equal(d.querySelectorAll("#risk-table tbody tr").length, 3);
  // 置信区间带默认开启
  assert.ok(svg.querySelectorAll('path[fill-opacity="0.1"]').length >= 1);

  // 计算明细：3 个型号各一张表
  assert.equal(d.querySelectorAll("#steps-tables .model-head").length, 3);
  assert.ok(d.querySelectorAll("#steps-tables tbody tr").length > 100);

  // 隔离页签有记录与徽标
  assert.ok(+d.getElementById("quarantine-badge").textContent > 0);
  assert.ok(d.getElementById("quarantine-tables").textContent.includes("Q5"));

  // 点击事件节点 -> 时点详情
  const before = d.getElementById("node-detail").hidden;
  assert.ok(before);
  nodes[0].dispatchEvent(new w.Event("click", { bubbles: true }));
  const detail = d.getElementById("node-detail");
  assert.ok(!detail.hidden, "点击后应显示时点详情");
  assert.ok(detail.textContent.includes("在险设备"));
  assert.ok(detail.textContent.includes("故障设备"));
  assert.ok(detail.querySelectorAll(".id-cols .id-list").length === 3);

  // 切换统一截止日 -> 重渲染不报错
  const sel = d.getElementById("cutoff-select");
  sel.value = "2024-12-31";
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.ok(d.getElementById("cutoff-note").textContent.includes("2024-12-31"));

  // 关掉置信区间 -> 区间带消失
  const ci = d.getElementById("toggle-ci");
  ci.checked = false;
  ci.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.equal(d.querySelectorAll('#chart path[fill-opacity="0.1"]').length, 0);

  // 主题切换 -> data-theme 改变且重渲染不报错
  d.getElementById("theme-toggle").dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.equal(d.documentElement.dataset.theme, "dark");
  assert.ok(d.querySelector("#chart svg"));
});

test("系列色取自 CSS 变量且跟随型号", { skip: !JSDOM }, () => {
  const w = buildPage();
  const d = w.document;
  const keys = [...d.querySelectorAll(".km-legend .legend-line")].map((e) => e.style.background);
  // jsdom 会把 rgb() 规范化；只断言三个系列颜色互不相同且非空
  assert.equal(new Set(keys).size, 3);
  for (const k of keys) assert.ok(k.length > 0);
});
