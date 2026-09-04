#!/usr/bin/env python3
"""Run the reproducible five-day market OOF rebuild from frozen lake snapshots.

This is intentionally a command-line research job, not a web-request handler.
It loads one market at a time, uses a deterministic liquid-history universe,
hydrates only verified PIT rows, resumes fold checkpoints, and writes an
immutable result summary.  A failed optional native wheel cannot silently
become a claimed tree-model result: the training artifact records the runtime
health and keeps the pure-Python baseline explicit.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "quant_core") not in sys.path:
    sys.path.insert(0, str(ROOT / "quant_core"))

from data_lake import read_panel  # noqa: E402
from production_training import train_market_multitask  # noqa: E402


TARGETS = {"ASX": 200, "US": 300, "CN": 500}
SNAPSHOTS = {
    "ASX": "4272945cccd952d4eb7a30d51512ce82",
    "US": "5f6da302adee3dc21b07bc6fd716c3c7",
    "CN": "c742e2e48c50daceedac81f0ddaed3bd",
}


def _latest_snapshot_id(lake_root: Path, market: str) -> str:
    directory = lake_root / "snapshots" / f"market={market}"
    candidates = []
    for path in directory.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if payload.get("status") != "frozen" or payload.get("snapshotId") != path.stem:
            continue
        candidates.append((path.stat().st_mtime, path.stem))
    return max(candidates)[1] if candidates else SNAPSHOTS[market]


def _symbols(root: Path, market: str, target: int, min_rows: int) -> list[str]:
    pattern = str(root / "ohlcv" / f"market={market}" / "exchange=*" / "interval=1d" / "symbol=*" / "data.parquet").replace("'", "''")
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            f"""
            SELECT symbol, count(*) AS rows, max(timestamp) AS last_timestamp
            FROM read_parquet('{pattern}', union_by_name=true)
            GROUP BY symbol
            HAVING count(*) >= {int(min_rows)}
            ORDER BY rows DESC, symbol
            LIMIT {int(target)}
            """
        ).fetchall()
    finally:
        connection.close()
    return [str(row[0]).upper() for row in rows]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, default=str), encoding="utf-8")
    temporary.replace(path)


def run_market(
    market: str,
    lake_root: Path,
    artifact_root: Path,
    limit: int,
    symbol_limit: int | None = None,
    *,
    resume_run_id: str | None = None,
    run_label_tournament: bool = True,
) -> dict[str, Any]:
    market = market.upper()
    target = min(TARGETS[market], int(symbol_limit)) if symbol_limit else TARGETS[market]
    snapshot_id = _latest_snapshot_id(lake_root, market)
    selected = _symbols(lake_root, market, target, min_rows=70)
    if not selected:
        return {"market": market, "status": "failed", "reason": "no eligible 1d symbols"}
    panel = read_panel({
        "root": str(lake_root),
        "market": market,
        "symbols": selected,
        "interval": "1d",
        "limit": int(limit),
        "min_rows": 70,
        "snapshot_id": snapshot_id,
    })
    items = panel.get("items") or []
    run_id = resume_run_id or f"frozen-{market.lower()}-5d-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    run_root = artifact_root / market.lower() / run_id
    progress_path = run_root / "runtime-progress.json"
    # Build ranks on the complete eligible date×symbol panel, then fit on a
    # deterministic rotating slice.  This is the resource-safe equivalent of
    # full cross-sectional ranking: it avoids keeping a full PIT feature vector
    # for every symbol while preserving the ranking universe in the audit.
    panel_max_symbols = max(50, (target + 2) // 3)
    payload = {
        "market": market,
        "items": items,
        "data_lake_root": str(lake_root),
        "frozen_snapshot_id": snapshot_id,
        "freeze_data_snapshot": True,
        "load_pit_from_data_lake": True,
        "pit_rows_per_symbol": 600,
        "horizons": [5],
        "production_training": True,
        "production_fold_count": 5,
        "production_min_train_dates": 500,
        "production_test_dates": 120,
        "production_embargo_days": 7,
        "enable_tree_models": True,
        "enable_sklearn_models": True,
        "tree_backend": "catboost",
        "tree_max_rows": 40_000,
        "tree_iterations": 72,
        "tree_threads": 2,
        "baseline_max_rows": 6_000,
        "quantile_max_rows": 6_000,
        "panel_max_symbols": panel_max_symbols,
        "panel_date_stride": 1,
        "label_tournament_max_rows": 120_000,
        "label_tournament_epochs": 8,
        "run_label_tournament": bool(run_label_tournament),
        "artifact_dir": str(run_root),
        "checkpoint_dir": str(run_root),
        "progress_path": str(progress_path),
        "training_run_id": run_id,
        "resume_latest_dataset": True,
        "resume_min_symbols": min(50, len(items)),
        "resume_min_dates": 500,
        "resume_require_pit_version": False,
        "training_lane": "strict_production",
        "trainingLane": "strict_production",
        "strict_gate03_approved": False,
        "strictGate03Approved": False,
        "changed_hypotheses": ["strict frozen market OOF evaluation"],
        "changedHypotheses": ["strict frozen market OOF evaluation"],
    }
    started = datetime.now(timezone.utc).isoformat()
    try:
        result = train_market_multitask(payload)
        summary = {
            "market": market,
            "runId": run_id,
            "startedAt": started,
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "status": (
                "completed_promoted"
                if (result.get("productionEligibility") or {}).get("eligible") is True
                else "completed_not_promoted"
                if result.get("available") or result.get("horizons")
                else "failed"
            ),
            "snapshotId": snapshot_id,
            "requestedSymbols": len(selected),
            "loadedSymbols": len(items),
            "panelFailures": panel.get("failures") or [],
            "result": result,
        }
    except Exception as exc:  # noqa: BLE001 - persist the failure evidence.
        summary = {
            "market": market,
            "runId": run_id,
            "startedAt": started,
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "status": "failed",
            "snapshotId": snapshot_id,
            "requestedSymbols": len(selected),
            "loadedSymbols": len(items),
            "panelFailures": panel.get("failures") or [],
            "error": f"{type(exc).__name__}: {exc}",
        }
    _write_json(run_root / "frozen-oof-result.json", summary)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", choices=["ASX", "US", "CN", "ALL"], default="ALL")
    parser.add_argument("--lake-root", default=str(ROOT / ".cache" / "data-lake"))
    parser.add_argument("--artifact-root", default=str(ROOT / ".cache" / "models" / "frozen-oof"))
    parser.add_argument("--limit", type=int, default=2_400, help="max daily candles per symbol")
    parser.add_argument("--symbol-limit", type=int, default=0, help="diagnostic override; production runs use the market target")
    parser.add_argument("--resume-run-id", default="", help="reuse an existing run directory and its feature-matrix/checkpoint artifacts")
    parser.add_argument("--skip-label-tournament", action="store_true", help="finish OOF first; run the optional heavy label tournament as a separate job")
    args = parser.parse_args()
    markets = ["ASX", "US", "CN"] if args.market == "ALL" else [args.market]
    reports = []
    for market in markets:
        reports.append(run_market(
            market,
            Path(args.lake_root),
            Path(args.artifact_root),
            args.limit,
            args.symbol_limit or None,
            resume_run_id=args.resume_run_id or None,
            run_label_tournament=not args.skip_label_tournament,
        ))
        print(json.dumps(reports[-1], ensure_ascii=False, default=str), flush=True)
    _write_json(Path(args.artifact_root) / "latest-frozen-oof-summary.json", {
        "schema": "frozen-market-oof-summary-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "reports": reports,
    })
    return 0 if all(row.get("status") != "failed" for row in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
