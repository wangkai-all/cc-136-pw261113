#!/usr/bin/env python3
"""独立复算 Kaplan-Meier（首次故障、延迟进入、右删失），用于复查页面计算。

口径与 js/survival.js 完全一致（见该文件头部注释与 README）：
  时间原点=投用日；L=开始观测-投用（<0 按 0）；观测窗口末=min(退役, 数据截止, 统一截止)；
  窗口内首次故障=事件，否则窗口末右删失；同一时点先进入、再故障、后删失；
  Greenwood + log-log 95% 置信区间；曲线不外推。

用法：
  python3 scripts/verify_km.py data/sample_devices.csv [--cutoff 2026-06-30]
        [--model AX-100 --model BX-200] [--out out] [--json]
默认输出 out/km_steps_<型号>.csv（每型号一份）与 out/km_steps_all.csv（合并，含 model 列）、
out/quarantine.csv（隔离记录）。--json 时改为向 stdout 打印全部结果，供脚本对照。
页面"导出计算明细"得到的 CSV 与 km_steps_all.csv 同格式，可直接 diff。
"""
import argparse
import csv
import json
import math
import os
import re
import sys
from datetime import date

DAY = 1  # 时间单位：天（date 差值即天数）
Z = 1.959963984540054
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

RULE_TEXT = {
    "Q1": "必需日期缺失或无法解析（投用/开始观测/首次故障/退役/观测截止）",
    "Q2": "日期倒置：退役日期早于投用日期",
    "Q3": "日期倒置：首次故障早于投用日期",
    "Q4": "日期倒置：退役日期早于开始观测（设备从未进入可观测状态）",
    "Q5": "首次故障早于可观察范围（故障日期早于开始观测）",
    "Q6": "日期倒置：退役日期早于首次故障",
    "Q7": "日期倒置：数据观测截止早于投用日期",
}

FIELDS = ["device_id", "model", "batch", "commission_date", "observe_start",
          "first_failure_date", "retire_date", "data_cutoff"]


def parse_date(s):
    """空 -> None；非法 -> 'INVALID'；合法 -> date。"""
    if s is None:
        return None
    t = str(s).strip()
    if t == "":
        return None
    if not DATE_RE.match(t):
        return "INVALID"
    try:
        return date.fromisoformat(t)
    except ValueError:
        return "INVALID"


def build_analysis(records, cutoff=None, models=None, batches=None):
    """返回 dict：quarantined / adjusted / excluded / devices / （按型号过滤在调用方做）。"""
    quarantined, adjusted, excluded, devices = [], [], [], []
    for rec in records:
        rules, notes = [], []
        d = {
            "commission": parse_date(rec.get("commission_date")),
            "observe": parse_date(rec.get("observe_start")),
            "failure": parse_date(rec.get("first_failure_date")),
            "retire": parse_date(rec.get("retire_date")),
            "cutoff": parse_date(rec.get("data_cutoff")),
        }
        if d["commission"] is None or d["commission"] == "INVALID":
            rules.append("Q1")
        for k in ("observe", "failure", "retire", "cutoff"):
            if d[k] == "INVALID":
                rules.append("Q1")
        if not rules:
            c = d["commission"]
            if d["retire"] is not None and d["retire"] < c:
                rules.append("Q2")
            if d["failure"] is not None and d["failure"] < c:
                rules.append("Q3")
            if d["observe"] is not None and d["retire"] is not None and d["retire"] < d["observe"]:
                rules.append("Q4")
            if d["failure"] is not None and d["observe"] is not None and d["failure"] < d["observe"]:
                rules.append("Q5")
            if d["failure"] is not None and d["retire"] is not None and d["retire"] < d["failure"]:
                rules.append("Q6")
            if d["cutoff"] is not None and d["cutoff"] < c:
                rules.append("Q7")
        if rules:
            quarantined.append({
                "record": rec,
                "rules": [{"code": code, "text": RULE_TEXT[code]} for code in sorted(set(rules))],
            })
            continue

        c = d["commission"]
        if d["observe"] is None:
            L = 0
            notes.append("开始观测缺失，按投用日进入（L=0）")
        elif d["observe"] < c:
            L = 0
            notes.append("开始观测早于投用，按投用日进入（L=0）")
        else:
            L = (d["observe"] - c).days
        if d["cutoff"] is None:
            notes.append("数据观测截止缺失，仅按统一观测截止处理")

        ends = []
        if d["retire"] is not None:
            ends.append((d["retire"], "退役"))
        if d["cutoff"] is not None:
            ends.append((d["cutoff"], "数据观测截止"))
        if cutoff is not None:
            ends.append((cutoff, "统一观测截止"))
        if not ends:
            excluded.append({"record": rec, "reason": "观测窗口无法确定（退役/数据截止/统一截止均缺失）"})
            continue
        end_date, end_why = min(ends, key=lambda x: x[0])

        observe_date = c if L == 0 else d["observe"]
        if observe_date > end_date:
            excluded.append({
                "record": rec,
                "reason": f"开始观测（{observe_date.isoformat()}）晚于观测窗口末（{end_date.isoformat()}，{end_why}），未进入分析",
            })
            continue

        event, time_date, censor_reason = 0, end_date, end_why
        if d["failure"] is not None:
            if d["failure"] <= end_date:
                event, time_date, censor_reason = 1, d["failure"], None
            else:
                notes.append(f"首次故障日期（{d['failure'].isoformat()}）晚于观测窗口末（{end_date.isoformat()}，{end_why}），按窗口末右删失")

        devices.append({
            "id": str(rec.get("device_id", "")),
            "model": str(rec.get("model", "")),
            "batch": str(rec.get("batch", "")),
            "L": L,
            "time": (time_date - c).days,
            "event": event,
            "censorReason": censor_reason,
        })
        if notes:
            adjusted.append({"record": rec, "notes": notes})

    if models is not None or batches is not None:
        devices = [x for x in devices
                   if (models is None or x["model"] in models)
                   and (batches is None or x["batch"] in batches)]
    return {"quarantined": quarantined, "adjusted": adjusted,
            "excluded": excluded, "devices": devices}


def km_curve(devices, z=Z):
    """与 js/survival.js 的 kmCurve 完全一致的计算顺序（保证浮点结果一致）。"""
    times = {0}
    for x in devices:
        times.add(x["time"])
        if x["L"] > 0:
            times.add(x["L"])
    steps = []
    S = 1.0
    greenwood = 0.0
    gw_ok = True
    for t in sorted(times):
        entered = d = c = n = 0
        for x in devices:
            if x["L"] == t:
                entered += 1
            if x["L"] <= t and x["time"] >= t:
                n += 1
            if x["time"] == t:
                if x["event"] == 1:
                    d += 1
                else:
                    c += 1
        if d > 0:
            S = S * (1 - d / n)
            if n > d:
                greenwood += d / (n * (n - d))
            else:
                gw_ok = False
                greenwood = math.inf
        se_log = math.sqrt(greenwood) if gw_ok else None
        ci_lo = ci_hi = None
        # S 与 Greenwood 累积量在非故障时点不变，区间在任意时点都可给出（阶梯带）
        if 0 < S < 1 and gw_ok and greenwood > 0:
            se_theta = se_log / abs(math.log(S))
            ci_lo = math.exp(-math.exp(math.log(-math.log(S)) + z * se_theta))
            ci_hi = math.exp(-math.exp(math.log(-math.log(S)) - z * se_theta))
        steps.append({"t": t, "entered": entered, "n": n, "d": d, "c": c,
                      "S": S, "seLog": se_log, "ciLo": ci_lo, "ciHi": ci_hi})
    n_events = sum(1 for x in devices if x["event"] == 1)
    return {
        "steps": steps,
        "nTotal": len(devices),
        "nEvents": n_events,
        "nCensored": len(devices) - n_events,
        "maxExit": max((x["time"] for x in devices), default=0),
    }


def default_cutoff(records):
    """统一截止默认值：数据中最大的 data_cutoff；缺失时退化为所有日期的最大值。"""
    cuts = [parse_date(r.get("data_cutoff")) for r in records]
    cuts = [c for c in cuts if isinstance(c, date)]
    if cuts:
        return max(cuts)
    all_dates = []
    for r in records:
        for f in ("commission_date", "observe_start", "first_failure_date",
                  "retire_date"):
            v = parse_date(r.get(f))
            if isinstance(v, date):
                all_dates.append(v)
    return max(all_dates) if all_dates else None


def fmt_num(x):
    if x is None:
        return ""
    if isinstance(x, int):
        return str(x)
    return format(x, ".12g")


def steps_csv_rows(model, steps):
    for s in steps:
        yield [model, s["t"], s["entered"], s["n"], s["d"], s["c"],
               fmt_num(s["S"]), fmt_num(s["seLog"]), fmt_num(s["ciLo"]), fmt_num(s["ciHi"])]


def run(csv_path, cutoff=None, model_names=None, out_dir=None, as_json=False):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        records = list(csv.DictReader(f))
    if cutoff is None:
        cutoff = default_cutoff(records)
    analysis = build_analysis(records, cutoff=cutoff,
                              models=set(model_names) if model_names else None)
    by_model = {}
    for dev in analysis["devices"]:
        by_model.setdefault(dev["model"], []).append(dev)
    results = {name: km_curve(devs) for name, devs in sorted(by_model.items())}

    if as_json:
        return json.dumps({
            "cutoff": cutoff.isoformat() if cutoff else None,
            "models": results,
            "counts": {
                "quarantined": len(analysis["quarantined"]),
                "adjusted": len(analysis["adjusted"]),
                "excluded": len(analysis["excluded"]),
                "analyzed": len(analysis["devices"]),
            },
            "quarantined": [
                {"device_id": q["record"].get("device_id", ""),
                 "rules": [r["code"] for r in q["rules"]]}
                for q in analysis["quarantined"]
            ],
        }, ensure_ascii=False, indent=2)

    os.makedirs(out_dir, exist_ok=True)
    header = ["model", "t", "entered", "n_risk", "failures", "censored",
              "S", "se_log", "ci_lo", "ci_hi"]
    all_rows = []
    for name, res in results.items():
        rows = list(steps_csv_rows(name, res["steps"]))
        all_rows.extend(rows)
        per = os.path.join(out_dir, f"km_steps_{name}.csv")
        with open(per, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(header[1:])  # 单型号文件不带 model 列
            w.writerows([r[1:] for r in rows])
    with open(os.path.join(out_dir, "km_steps_all.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(all_rows)
    with open(os.path.join(out_dir, "quarantine.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["device_id", "model", "batch", "rules"])
        for q in analysis["quarantined"]:
            w.writerow([q["record"].get("device_id", ""), q["record"].get("model", ""),
                        q["record"].get("batch", ""),
                        ";".join(r["code"] for r in q["rules"])])
    return (f"统一观测截止: {cutoff}\n"
            f"纳入分析 {len(analysis['devices'])} 台；隔离 {len(analysis['quarantined'])} 条；"
            f"修正 {len(analysis['adjusted'])} 条；未进入分析 {len(analysis['excluded'])} 条\n"
            f"明细已写入 {out_dir}/ （km_steps_<型号>.csv、km_steps_all.csv、quarantine.csv）")


def main(argv=None):
    ap = argparse.ArgumentParser(description="复算 KM 生存曲线（含延迟进入/右删失），用于复查页面计算")
    ap.add_argument("csv", help="设备数据 CSV（列：%s）" % ",".join(FIELDS))
    ap.add_argument("--cutoff", help="统一观测截止日 YYYY-MM-DD（默认：数据中最大 data_cutoff）")
    ap.add_argument("--model", action="append", dest="models", help="只分析指定型号（可多次）")
    ap.add_argument("--out", default="out", help="输出目录（默认 out/）")
    ap.add_argument("--json", action="store_true", help="向 stdout 输出 JSON（不写文件）")
    args = ap.parse_args(argv)

    cutoff = None
    if args.cutoff:
        cutoff = parse_date(args.cutoff)
        if not isinstance(cutoff, date):
            ap.error(f"--cutoff 非法: {args.cutoff}")
    out = run(args.csv, cutoff=cutoff, model_names=args.models,
              out_dir=args.out, as_json=args.json)
    print(out)


if __name__ == "__main__":
    main()
