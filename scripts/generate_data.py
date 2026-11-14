#!/usr/bin/env python3
"""生成设备可靠性示例数据（首次故障生存分析用）。

输出：
  data/sample_devices.csv   —— 上传页面用的 CSV
  js/sample_data.js         —— 同一份数据的 JS 内嵌副本（页面"载入示例数据"按钮用，
                               保证 file:// 直接打开也能用）

数据包含分析所需的全部情形：
  - 3 个型号 × 12 个投用批次（2022Q1..2024Q4），Weibull 首次故障时间
  - 延迟进入：部分设备投用后 0~240 天才进入观测
  - 右删失：退役（退役年龄分布）与数据观测截止（2026-06-30）
  - 少量"超窗故障"记录（故障日期晚于数据截止，按窗口末删失）
  - 约 2.5% 的隔离记录：日期倒置 / 首次故障早于可观察范围 / 非法日期
  - 少量可修正记录：开始观测缺失或早于投用（按投用日进入）、数据截止缺失

用法：python3 scripts/generate_data.py [--seed 42] [--outdir .]
"""
import argparse
import csv
import io
import json
import math
import os
import random
from datetime import date, timedelta

DATA_CUTOFF = date(2026, 6, 30)  # 数据自带观测截止

# 型号 -> (Weibull 形状 k, Weibull 尺度 lam, 说明)
MODELS = {
    "AX-100": (1.5, 1400.0),
    "BX-200": (1.2, 1100.0),
    "CX-300": (2.2, 2000.0),
}
# BX-200 自 2023Q3 起的批次可靠性变差（混杂演示：型号间差异可能来自批次构成）
BX200_BAD_FROM = (2023, 3)
BX200_BAD_FACTOR = 0.75

QUARTERS = [(y, q) for y in (2022, 2023, 2024) for q in (1, 2, 3, 4)]


def quarter_label(y, q):
    return f"{y}Q{q}"


def random_day_in_quarter(rng, y, q):
    start = date(y, 3 * q - 2, 1)
    end_m = 3 * q + 1
    end = date(y, end_m, 1) if end_m <= 12 else date(y + 1, 1, 1)
    return start + timedelta(days=rng.randrange((end - start).days))


def weibull(rng, k, lam):
    return lam * (-math.log(1.0 - rng.random())) ** (1.0 / k)


def iso(d):
    return d.isoformat() if d else ""


def make_device(rng, model, y, q, idx):
    k, lam = MODELS[model]
    if model == "BX-200" and (y, q) >= BX200_BAD_FROM:
        lam = lam * BX200_BAD_FACTOR
    batch = quarter_label(y, q)
    commission = random_day_in_quarter(rng, y, q)

    # 延迟进入：70% 在 0~30 天内进入观测，30% 延迟 60~240 天
    delay = rng.randint(0, 30) if rng.random() < 0.7 else rng.randint(60, 240)
    observe_start = commission + timedelta(days=delay)

    fail_age = int(round(weibull(rng, k, lam)))
    failure = commission + timedelta(days=fail_age)

    # 退役：退役年龄 ~ Weibull(k=3, lam=2600)；4% 提前退役
    if rng.random() < 0.04:
        retire_age = rng.randint(200, 900)
    else:
        retire_age = int(round(weibull(rng, 3.0, 2600.0)))
    retire = commission + timedelta(days=retire_age)

    # 只有观测窗口内发生的故障才会被记录；窗口外故障 -> 窗口末删失
    window_end = min(retire, DATA_CUTOFF)
    recorded_failure = failure if failure <= window_end else None

    return {
        "device_id": f"{model.replace('-', '')}-{batch}-{idx:04d}",
        "model": model,
        "batch": batch,
        "commission_date": iso(commission),
        "observe_start": iso(observe_start),
        "first_failure_date": iso(recorded_failure),
        "retire_date": iso(retire),
        "data_cutoff": iso(DATA_CUTOFF),
    }


def corrupt_records(rng, rows):
    """注入隔离/修正场景，返回追加的坏记录与改动说明计数。"""
    bad = []
    n = len(rows)

    def base(i):
        return dict(rows[rng.randrange(n)])

    # Q2 退役早于投用（日期倒置）
    for _ in range(3):
        r = base(0)
        c = date.fromisoformat(r["commission_date"])
        r["retire_date"] = iso(c - timedelta(days=rng.randint(30, 400)))
        r["first_failure_date"] = ""
        r["device_id"] += "-BADQ2"
        bad.append(r)
    # Q3 故障早于投用（日期倒置）
    for _ in range(3):
        r = base(0)
        c = date.fromisoformat(r["commission_date"])
        r["first_failure_date"] = iso(c - timedelta(days=rng.randint(10, 200)))
        r["device_id"] += "-BADQ3"
        bad.append(r)
    # Q5 首次故障早于开始观测（故障不在可观察范围内）
    for _ in range(3):
        r = base(0)
        c = date.fromisoformat(r["commission_date"])
        o = date.fromisoformat(r["observe_start"])
        if (o - c).days > 10:
            r["first_failure_date"] = iso(o - timedelta(days=rng.randint(5, min(60, (o - c).days - 1))))
            r["device_id"] += "-BADQ5"
            bad.append(r)
    # Q6 退役早于故障（日期倒置）
    for _ in range(3):
        r = base(0)
        if r["first_failure_date"]:
            f = date.fromisoformat(r["first_failure_date"])
            c = date.fromisoformat(r["commission_date"])
            r["retire_date"] = iso(max(c + timedelta(days=1), f - timedelta(days=rng.randint(10, 300))))
            r["device_id"] += "-BADQ6"
            bad.append(r)
    # Q1 非法/缺失日期
    r = base(0)
    r["commission_date"] = "2023-13-45"
    r["device_id"] += "-BADQ1a"
    bad.append(r)
    r = base(0)
    r["commission_date"] = ""
    r["device_id"] += "-BADQ1b"
    bad.append(r)
    # A4 故障日期晚于数据截止（超窗故障，按窗口末删失）
    for _ in range(4):
        r = base(0)
        r["first_failure_date"] = iso(DATA_CUTOFF + timedelta(days=rng.randint(30, 300)))
        r["retire_date"] = ""
        r["device_id"] += "-LATEF"
        bad.append(r)
    # A2 开始观测早于投用（按投用日进入）
    for _ in range(5):
        r = base(0)
        c = date.fromisoformat(r["commission_date"])
        r["observe_start"] = iso(c - timedelta(days=rng.randint(5, 90)))
        r["device_id"] += "-EARLYO"
        bad.append(r)
    # A1 开始观测缺失（按投用日进入）
    for _ in range(5):
        r = base(0)
        r["observe_start"] = ""
        r["device_id"] += "-NOOBS"
        bad.append(r)
    # A3 数据观测截止缺失（按统一截止处理）
    for _ in range(4):
        r = base(0)
        r["data_cutoff"] = ""
        r["device_id"] += "-NOCUT"
        bad.append(r)
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--outdir", default=os.path.join(os.path.dirname(__file__), ".."))
    args = ap.parse_args()
    rng = random.Random(args.seed)

    rows = []
    for model in MODELS:
        for (y, q) in QUARTERS:
            for i in range(1, rng.randint(8, 14) + 1):
                rows.append(make_device(rng, model, y, q, i))
    rows.extend(corrupt_records(rng, rows))
    rng.shuffle(rows)

    fields = ["device_id", "model", "batch", "commission_date", "observe_start",
              "first_failure_date", "retire_date", "data_cutoff"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    csv_text = buf.getvalue()

    outdir = os.path.abspath(args.outdir)
    os.makedirs(os.path.join(outdir, "data"), exist_ok=True)
    os.makedirs(os.path.join(outdir, "js"), exist_ok=True)
    csv_path = os.path.join(outdir, "data", "sample_devices.csv")
    with open(csv_path, "w", newline="") as f:
        f.write(csv_text)

    meta = {"seed": args.seed, "data_cutoff": iso(DATA_CUTOFF), "n_records": len(rows),
            "models": sorted(MODELS), "note": "由 scripts/generate_data.py 生成，可复现"}
    js_path = os.path.join(outdir, "js", "sample_data.js")
    with open(js_path, "w") as f:
        f.write("// 本文件由 scripts/generate_data.py 自动生成，请勿手改。\n")
        f.write("window.SAMPLE_CSV = " + json.dumps(csv_text, ensure_ascii=False) + ";\n")
        f.write("window.SAMPLE_META = " + json.dumps(meta, ensure_ascii=False) + ";\n")

    print(f"已生成 {len(rows)} 条记录 -> {csv_path}")
    print(f"内嵌副本 -> {js_path}")


if __name__ == "__main__":
    main()
