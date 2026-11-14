# 设备可靠性 · 首次故障生存分析

纯前端页面：按型号与投用批次展示**首次故障的 Kaplan-Meier 生存曲线**，支持延迟进入（左截断）、
右删失（退役 / 观测截止）、可切换的统一观测截止日、95% 置信区间，点击曲线节点可查看该时点的
在险设备、故障数与删失数。所有风险集与曲线计算都可逐步复查。

## 快速开始

```bash
# 方式一：直接双击打开 index.html（示例数据已内嵌，file:// 可用）
# 方式二：本地服务
python3 -m http.server 8000   # 然后访问 http://localhost:8000
```

打开后自动载入示例数据。也可以「上传 CSV」使用自己的数据（列要求见页面「口径与假设」页签，
或点「下载 CSV 模板」）。

## 数据列

| 列 | 含义 |
|---|---|
| `device_id` / `model` / `batch` | 设备编号 / 型号 / 投用批次 |
| `commission_date` | 投用日期（时间原点） |
| `observe_start` | 开始观测日期（延迟进入；空或早于投用按投用日进入） |
| `first_failure_date` | 首次故障日期（空 = 窗口内未故障，右删失） |
| `retire_date` | 退役日期（空 = 未退役） |
| `data_cutoff` | 数据观测截止（空 = 仅按页面统一截止） |

## 计算口径（摘要）

- **时间原点**为投用日，横轴为设备年龄（天）。
- **延迟进入**：设备自 `observe_start` 起才进入在险集合，不从投用日计入。
- **右删失**：观测窗口末 = min（退役， 数据观测截止， 页面统一观测截止）；窗口内未故障即删失。
  没有故障不代表永不故障。
- **同一时点约定**：先进入 → 再故障 → 后删失（当点删失设备仍计入当点在险）。每个时点的
  进入/在险/故障/删失四列在「计算明细」逐行可查。
- **置信区间**：Greenwood 方差 + log-log 变换，95%。
- **尾部不外推**：曲线画到最后一个退出时点为止；风险表给出各时点剩余在险样本。
- **隔离**：日期倒置（Q2/Q3/Q4/Q6/Q7）、首次故障早于可观察范围（Q5）、必需日期非法（Q1）
  的记录先隔离，全部列于「隔离与修正」页签。
- **退役删失假设**：退役按独立删失处理；若退役与故障风险相关，S(t) 可能被高估——页面
  「口径与假设」有完整说明。**型号间曲线差异是描述性结果，不构成因果结论。**

## 本地生成与复查数据

```bash
python3 scripts/generate_data.py            # 重新生成 data/sample_devices.csv 与 js/sample_data.js（种子固定，可复现）
python3 scripts/verify_km.py data/sample_devices.csv --out out
# 得到 out/km_steps_<型号>.csv、out/km_steps_all.csv、out/quarantine.csv
```

页面「导出计算明细 CSV」（在全部型号、全部批次、截止=数据自带截止时）与
`out/km_steps_all.csv` **逐字节一致**，可直接 `diff`。

## 测试

```bash
node --test tests/test_survival.mjs tests/test_chart.mjs tests/test_export_csv.mjs
python3 -m unittest tests.test_verify_km
node tests/compare_engines.mjs     # JS 与 Python 两套实现逐时点对照
# 可选（需 npm i jsdom）：NODE_PATH=<jsdom所在>/node_modules node --test tests/test_dom_smoke.mjs
```

- `tests/test_survival.mjs` / `tests/test_verify_km.py`：手算对照（基本 KM、延迟进入、
  同时点故障+删失、Greenwood/CI、全部隔离规则、修正与排除规则）。
- `tests/compare_engines.mjs`：浏览器引擎（js/survival.js）与 Python 引擎
  （scripts/verify_km.py）在示例数据上 594 个时点逐步相同。
- `tests/test_export_csv.mjs`：页面导出与 verify_km.py 输出逐字节一致。
- `tests/test_dom_smoke.mjs`：jsdom 整页冒烟（渲染、点击节点、切换截止日、主题）。

## 目录结构

```
index.html            页面（含「口径与假设」完整说明）
css/style.css         样式（明暗两态调色板，已经色盲校验）
js/csv.js             CSV 解析
js/survival.js        分析引擎（KM + 延迟进入 + 删失 + Greenwood/log-log CI）
js/chart.js           SVG 阶梯曲线（CI 带、可点击节点、十字线、风险表联动）
js/app.js             页面状态与渲染
js/sample_data.js     内嵌示例数据（generate_data.py 生成，勿手改）
scripts/generate_data.py   示例数据生成器
scripts/verify_km.py       独立复算器（与 JS 引擎同口径）
data/sample_devices.csv    示例数据
tests/                单元 / 对照 / 冒烟测试
```
