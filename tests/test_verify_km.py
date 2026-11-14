#!/usr/bin/env python3
"""tests/test_verify_km.py —— scripts/verify_km.py 的手算对照测试。
运行：python3 -m unittest tests.test_verify_km -v   （或 python3 tests/test_verify_km.py）
"""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import verify_km  # noqa: E402

CUTOFF = date(2026, 6, 30)


def rec(id="X", model="M", batch="B", commission="2023-01-01", observe=None,
        failure="", retire="", cutoff="2026-06-30"):
    return {
        "device_id": id, "model": model, "batch": batch,
        "commission_date": commission,
        "observe_start": commission if observe is None else observe,
        "first_failure_date": failure, "retire_date": retire, "data_cutoff": cutoff,
    }


def dev(L, time, event):
    return {"id": f"{L}-{time}-{event}", "model": "M", "batch": "B",
            "L": L, "time": time, "event": event,
            "censorReason": None if event else "观测截止"}


def at(steps, t):
    return next(s for s in steps if s["t"] == t)


class TestKmCurve(unittest.TestCase):
    def test_basic(self):
        r = verify_km.km_curve([dev(0, 2, 1), dev(0, 3, 1), dev(0, 5, 1),
                                dev(0, 5, 1), dev(0, 8, 1)])
        self.assertEqual(at(r["steps"], 0)["entered"], 5)
        self.assertAlmostEqual(at(r["steps"], 2)["S"], 0.8)
        self.assertAlmostEqual(at(r["steps"], 3)["S"], 0.6)
        self.assertEqual(at(r["steps"], 5)["d"], 2)
        self.assertAlmostEqual(at(r["steps"], 5)["S"], 0.2)
        self.assertEqual(at(r["steps"], 8)["S"], 0.0)
        self.assertIsNone(at(r["steps"], 8)["ciLo"])

    def test_delayed_entry(self):
        r = verify_km.km_curve([dev(0, 5, 1), dev(0, 12, 1),
                                dev(10, 20, 1), dev(10, 25, 0)])
        self.assertEqual(at(r["steps"], 5)["n"], 2)
        self.assertAlmostEqual(at(r["steps"], 5)["S"], 0.5)
        self.assertEqual(at(r["steps"], 10)["entered"], 2)
        self.assertEqual(at(r["steps"], 12)["n"], 3)
        self.assertAlmostEqual(at(r["steps"], 12)["S"], 1 / 3)
        self.assertAlmostEqual(at(r["steps"], 20)["S"], 1 / 6)

    def test_tie_failure_censor(self):
        r = verify_km.km_curve([dev(0, 5, 1), dev(0, 5, 0), dev(0, 8, 1)])
        s5 = at(r["steps"], 5)
        self.assertEqual((s5["n"], s5["d"], s5["c"]), (3, 1, 1))
        self.assertAlmostEqual(s5["S"], 2 / 3)
        self.assertEqual(at(r["steps"], 8)["n"], 1)

    def test_greenwood_ci(self):
        r = verify_km.km_curve([dev(0, 1, 1), dev(0, 2, 1), dev(0, 3, 1), dev(0, 4, 1)])
        s2 = at(r["steps"], 2)
        self.assertAlmostEqual(s2["S"], 0.5)
        self.assertAlmostEqual(s2["seLog"], 0.5)
        self.assertAlmostEqual(s2["ciLo"], 0.0578541, places=4)
        self.assertAlmostEqual(s2["ciHi"], 0.8448696, places=4)


class TestBuildAnalysis(unittest.TestCase):
    def test_quarantine_rules(self):
        base = dict(commission="2023-01-01", observe="2023-02-01")
        records = [
            rec("q1a", commission="", **{k: v for k, v in base.items() if k != "commission"}),
            rec("q1b", commission="2023-13-45", observe="2023-02-01"),
            rec("q2", retire="2022-06-01", **base),
            rec("q3", failure="2022-06-01", **base),
            rec("q4", observe="2023-06-01", retire="2023-03-01"),
            rec("q5", failure="2023-01-15", **base),
            rec("q6", failure="2024-01-01", retire="2023-06-01", **base),
            rec("q7", cutoff="2022-06-01", **base),
            rec("ok", failure="2024-06-01", **base),
        ]
        a = verify_km.build_analysis(records, cutoff=CUTOFF)
        by_id = {q["record"]["device_id"]: [r["code"] for r in q["rules"]]
                 for q in a["quarantined"]}
        self.assertEqual(by_id["q1a"], ["Q1"])
        self.assertEqual(by_id["q1b"], ["Q1"])
        self.assertEqual(by_id["q2"], ["Q2", "Q4"])  # 退役既早于投用、也早于开始观测
        self.assertEqual(by_id["q3"], ["Q3", "Q5"])  # 故障既早于投用、也早于开始观测
        self.assertEqual(by_id["q4"], ["Q4"])
        self.assertEqual(by_id["q5"], ["Q5"])
        self.assertEqual(by_id["q6"], ["Q6"])
        self.assertEqual(by_id["q7"], ["Q7"])
        self.assertEqual(len(a["devices"]), 1)

    def test_late_failure_censored_at_window_end(self):
        a = verify_km.build_analysis(
            [rec("late", observe="2023-01-01", failure="2027-01-01")], cutoff=CUTOFF)
        self.assertEqual(len(a["devices"]), 1)
        d = a["devices"][0]
        self.assertEqual(d["event"], 0)
        self.assertEqual(d["censorReason"], "数据观测截止")
        self.assertEqual(d["time"], (CUTOFF - date(2023, 1, 1)).days)
        self.assertEqual(len(a["adjusted"]), 1)

    def test_retire_beats_cutoff(self):
        a = verify_km.build_analysis(
            [rec("r", observe="2023-01-01", retire="2025-01-01")], cutoff=CUTOFF)
        self.assertEqual(a["devices"][0]["censorReason"], "退役")

    def test_adjustments(self):
        a = verify_km.build_analysis([
            rec("noobs", observe="", failure="2024-01-01"),
            rec("early", observe="2022-06-01", failure="2024-01-01"),
            rec("nocut", observe="2023-01-01", cutoff=""),
        ], cutoff=CUTOFF)
        self.assertEqual(len(a["devices"]), 3)
        by_id = {d["id"]: d for d in a["devices"]}
        self.assertEqual(by_id["noobs"]["L"], 0)
        self.assertEqual(by_id["early"]["L"], 0)
        self.assertEqual(by_id["nocut"]["censorReason"], "统一观测截止")
        self.assertEqual(len(a["adjusted"]), 3)

    def test_excluded_when_observe_after_window(self):
        a = verify_km.build_analysis(
            [rec("late", commission="2025-01-01", observe="2026-01-01")],
            cutoff=date(2025, 6, 30))
        self.assertEqual(len(a["devices"]), 0)
        self.assertEqual(len(a["excluded"]), 1)
        self.assertEqual(len(a["quarantined"]), 0)


if __name__ == "__main__":
    unittest.main()
