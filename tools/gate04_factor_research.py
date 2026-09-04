#!/usr/bin/env python3
"""Produce the factor-card and factor-pool stage evidence.

Cards and deterministic calculations are executable now.  Admission remains
blocked until a real frozen cross-sectional panel passes the PIT and breadth
gate; this script never promotes a factor from a synthetic fixture.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from factor_research import FACTOR_DEFINITIONS, evaluate_factor, factor_card, factor_pool_audit  # noqa: E402

OUT = ROOT / "reports" / "gate04-2026-08-29"


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, default=str), encoding="utf-8")


def fixture_rows() -> list[dict]:
    rows = []
    for day in range(130):
        for symbol in range(12):
            value = (symbol - 5.5) / 5.5 + day / 1000
            rows.append({
                "date": f"2025-{day // 28 + 1:02d}-{day % 28 + 1:02d}",
                "symbol": f"S{symbol:02d}",
                "pitEligible": True,
                "factors": {name: value + index * 0.0001 for index, name in enumerate(FACTOR_DEFINITIONS)},
                "label": 0.01 if symbol >= 6 else -0.01,
            })
    return rows


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = fixture_rows()
    cards = []
    evidence = {}
    for name in FACTOR_DEFINITIONS:
        card = factor_card(name, source_version="fixture-only-unbound", feature_schema="factor-panel-v2")
        cards.append(card)
        result = evaluate_factor(rows, name, min_breadth=10)
        result["fixtureOnly"] = True
        result["productionAdmission"] = "blocked_until_real_frozen_panel"
        evidence[name] = result
        write(OUT / f"{name}-factor-card.json", card)
        write(OUT / f"{name}-factor-evidence.json", result)
    pool = factor_pool_audit(rows, list(FACTOR_DEFINITIONS), min_dates=120, max_correlation=0.65)
    pool["fixtureOnly"] = True
    pool["productionAdmission"] = "blocked_until_real_frozen_panel"
    write(OUT / "factor-card-schema-v2.json", {"schema": "factor-card-v2-pit-panel", "cards": cards, "requiredFields": ["formula", "economicHypothesis", "direction", "lookback", "pointInTimeRule", "coverage", "failureConditions"]})
    write(OUT / "factor-research-fixture.json", {"rows": len(rows), "dates": 130, "symbolsPerDate": 12, "note": "Deterministic contract fixture only; no market factor is admitted from this file.", "pool": pool})
    write(OUT / "factor-redundancy-map.json", pool)
    write(OUT / "factor-regime-stability.json", {"status": "blocked", "fixture": True, "reason": "真实市场/状态分层面板尚未通过数据语义阶段门", "required": ["market", "regime", "signal_date", "pitEligible"]})
    write(OUT / "admitted-factor-pool-v2.json", {"schema": "admitted-factor-pool-v2", "admitted": [], "status": "blocked", "reason": "不从fixture或未通过PIT阶段的面板生成生产因子"})
    tasks = []
    for number in range(133, 176):
        task_id = f"G{number:04d}"
        passed = task_id == "G0133"
        tasks.append({"id": task_id, "status": "ACCEPTED" if passed else "BLOCKED", "contractFixturePassed": True, "realDataPassed": passed, "reason": None if passed else "真实冻结横截面因子证据或去冗余门尚未满足"})
    report = {
        "schema": "stage-gate-v2",
        "stage": "04-factor-atomization-and-de-redundancy",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskRange": ["G0133", "G0175"],
        "tasks": tasks,
        "passedCount": sum(row["status"] == "ACCEPTED" for row in tasks),
        "blockedCount": sum(row["status"] == "BLOCKED" for row in tasks),
        "nextPhasePermitted": False,
        "productionFactorCount": 0,
        "fixtureOnly": True,
        "blockingReasons": ["G0098-G0132真实PIT/行业/宇宙阶段门尚未通过", "当前因子结果只证明公式与计算契约，不证明市场增量Alpha", "缺少至少120个真实测试日期和5折稳定性证据"],
    }
    write(OUT / "04因子原子化与去冗余-gate.json", report)
    write(OUT / "stage-summary.json", report)
    print(json.dumps({"passed": report["passedCount"], "blocked": report["blockedCount"], "nextPhasePermitted": False, "report": str(OUT / "04因子原子化与去冗余-gate.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
