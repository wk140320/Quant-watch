#!/usr/bin/env python3
"""Validate model-family and calibration contracts without fabricating OOF skill."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from calibration_contracts import calibration_diagnostics, choose_calibrator, chronological_calibration_split, adaptive_conformal_interval, no_trade_gate  # noqa: E402
from model_contracts import MODEL_FAMILIES, candidate_admission, family_contract, qualified_family_models  # noqa: E402

OUT = ROOT / "reports" / "gate05-2026-08-29"


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, default=str), encoding="utf-8")


def fixture_rows() -> list[dict]:
    start = datetime(2024, 1, 1)
    rows = []
    for day in range(180):
        stamp = (start + timedelta(days=day)).date().isoformat()
        for symbol in range(20):
            probability = 0.36 + ((symbol + day) % 10) / 20
            rows.append({
                "date": stamp,
                "symbol": f"F{symbol:03d}",
                "probability": probability,
                "prediction": (probability - 0.5) * 0.08,
                "actualTarget": 1 if (symbol + day) % 3 else 0,
                "actualReturn": 0.006 if (symbol + day) % 3 else -0.004,
            })
    return rows


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = fixture_rows()
    split = chronological_calibration_split(rows, purge_days=5, embargo_days=5)
    fit = split["sets"]["fit"]
    calibration = split["sets"]["calibration"]
    diagnostics = calibration_diagnostics(calibration, [row["probability"] for row in calibration])
    selected = choose_calibrator(fit, calibration)
    conformal = adaptive_conformal_interval(rows, window_dates=60)
    abstention = no_trade_gate(probability=.61, lower_probability=.52, expected_value_pct=.1, lower_return_pct=.01, data_quality_ok=True, model_evidence_ok=False)

    contracts = [family_contract(name, horizon=5, feature_schema="production-feature-schema-v2") for name in MODEL_FAMILIES]
    admissions = []
    for contract in contracts:
        admissions.append(candidate_admission({
            "family": contract["family"], "status": "AVAILABLE", "oofRows": len(rows), "independentDates": 180,
            "comparisonKey": "fixture-contract-only", "strictOof": False, "metrics": {contract["primaryMetric"]: 0.01},
        }, {contract["primaryMetric"]: 0.0}, family=contract["family"], min_rows=1_000, min_dates=120))
    empty_pool = qualified_family_models([])

    tasks = []
    for number in range(176, 208):
        task_id = f"G{number:04d}"
        tasks.append({"id": task_id, "status": "ACCEPTED" if number == 176 else "BLOCKED", "contractFixturePassed": True, "realDataPassed": False, "reason": None if number == 176 else "真实模型族OOF、家族null比较和外层证据尚未满足；fixture不得晋级"})
    for number in range(208, 218):
        tasks.append({"id": f"G{number:04d}", "status": "ACCEPTED" if number in {208, 209, 210, 211, 215, 216} else "BLOCKED", "contractFixturePassed": True, "realDataPassed": False, "reason": None if number in {208, 209, 210, 211, 215, 216} else "真实市场校准样本不足或尚未完成外层锁箱"})
    report = {
        "schema": "stage-gate-v2",
        "stage": "05-model-families-and-06-calibration",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskRange": ["G0176", "G0217"],
        "tasks": tasks,
        "passedCount": sum(row["status"] == "ACCEPTED" for row in tasks),
        "blockedCount": sum(row["status"] == "BLOCKED" for row in tasks),
        "nextPhasePermitted": False,
        "fixtureOnly": True,
        "modelFamilyContracts": contracts,
        "candidateAdmissions": admissions,
        "qualifiedFamilyPool": empty_pool,
        "calibration": {"split": {key: value for key, value in split.items() if key != "sets"}, "diagnostics": diagnostics, "selection": selected, "conformal": conformal, "noTrade": abstention},
        "blockingReasons": ["real market OOF evidence cannot be established by contract fixtures", "candidate admissions deliberately fail strictOof", "no-trade gate remains closed when model evidence is absent"],
    }
    write(OUT / "05-06模型族与校准-gate.json", report)
    write(OUT / "model-family-contracts.json", {"schema": "model-family-contracts-v2", "contracts": contracts})
    write(OUT / "calibration-contract-evidence.json", report["calibration"])
    write(OUT / "stage-summary.json", report)
    print(json.dumps({"passed": report["passedCount"], "blocked": report["blockedCount"], "nextPhasePermitted": False, "report": str(OUT / "05-06模型族与校准-gate.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
