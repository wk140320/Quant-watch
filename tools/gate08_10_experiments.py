#!/usr/bin/env python3
"""Register experiment and forward-validation status without fake market results."""

from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT_ROOT = Path("/Users/wukai/Documents/审视量化项目/三市场预测成功率原子级深化审计-2026-08-28")
TASKS = AUDIT_ROOT / "预测成功率原子任务台账-v2-2026-08-29.csv"
OUT = ROOT / "reports" / "gate08-10-2026-08-29"


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, default=str), encoding="utf-8")


def task_rows(start: int, end: int, reason: str) -> list[dict]:
    rows = []
    for number in range(start, end + 1):
        rows.append({"id": f"G{number:04d}", "status": "BLOCKED", "contractFixturePassed": False, "realDataPassed": False, "reason": reason})
    return rows


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    experiment_tasks = task_rows(230, 272, "前置的真实数据语义、行业/宇宙覆盖和可重复 OOF 门尚未全部通过；禁止用内层成绩替代外层实验")
    forward_tasks = task_rows(287, 300, "真实 Qualified Shadow/Paper 观察期必须按交易日自然积累；当前没有 Champion，不能伪造 60/120 日前向证据")
    report = {
        "schema": "stage-gate-v2",
        "stage": "08-market-experiments-and-10-forward-acceptance",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskRange": ["G0230", "G0300"],
        "tasks": [*experiment_tasks, *forward_tasks],
        "passedCount": 0,
        "blockedCount": len(experiment_tasks) + len(forward_tasks),
        "nextPhasePermitted": False,
        "fixtureOnly": False,
        "preRegisteredExperiments": [
            {"market": "ASX", "experiments": ["fold-reconciliation", "direction-rank", "sector-residual", "financial-event", "5-vs-10", "5-vs-20", "outer-ranking-collapse"]},
            {"market": "US", "experiments": ["verified-equity-universe", "sector-residual", "market-timing-removal", "return-aware-ranking", "drawdown-risk", "sparse-event", "drift"]},
            {"market": "CN", "experiments": ["broad-sector", "tradability", "liquidity-rank", "10-day", "20-day", "earnings-and-capital-event", "probability-collapse"]},
        ],
        "policy": "每个实验固定数据身份、标签、成本、外层测试和比较键；所有实验失败也必须进入实验账本，不得自动晋级。",
        "blockingReasons": ["真实市场实验需要前置阶段的可审计 PIT 面板", "Qualified Shadow 和 Paper 证据依赖未来真实交易日，不能在当前日期一次生成", "当前三个市场不应创建生产 Champion"],
    }
    write(OUT / "08-10实验与前向验收-gate.json", report)
    write(OUT / "pre-registered-experiments.json", {"schema": "pre-registered-market-experiments-v1", "experiments": report["preRegisteredExperiments"], "lockboxPolicy": "new live lockbox per changed data/label/feature identity"})
    write(OUT / "stage-summary.json", report)
    print(json.dumps({"passed": 0, "blocked": report["blockedCount"], "nextPhasePermitted": False, "report": str(OUT / "08-10实验与前向验收-gate.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
