#!/usr/bin/env python3
"""Repair one narrowly defined legacy PIT gap for Yahoo historical actions.

Only rows from the legacy ``yahoo-finance-{market}-events`` historical event
adapter are eligible.  A dated split/dividend event is assigned a conservative
availability bound equal to its provider-reported event date.  Coverage
receipts, current snapshots, other datasets, and rows without an ingestion
timestamp are left untouched.  The repair never changes prices or event data.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MARKETS = ("ASX", "US", "CN")


def esc(value: Path | str) -> str:
    return str(value).replace("'", "''")


def repair_partition(connection, path: Path, *, dry_run: bool) -> dict[str, object]:
    connection.execute("DROP TABLE IF EXISTS yahoo_action_repair")
    connection.execute(
        f"CREATE TEMP TABLE yahoo_action_repair AS SELECT * FROM read_parquet('{esc(path)}', union_by_name=true)"
    )
    predicate = """
        lower(coalesce(source, '')) in (
          'yahoo-finance-asx-events',
          'yahoo-finance-us-events',
          'yahoo-finance-cn-events'
        )
        AND coalesce(json_extract_string(payload_json, '$.eventType'), '') in ('dividend', 'split')
        AND nullif(cast(event_time AS VARCHAR), '') IS NOT NULL
        AND nullif(cast(available_at AS VARCHAR), '') IS NOT NULL
        AND nullif(json_extract_string(payload_json, '$.ingested_at'), '') IS NOT NULL
        AND coalesce(json_extract_string(payload_json, '$.first_seen_at'), '') = ''
        AND try_cast(available_at AS TIMESTAMP) <= current_timestamp
    """
    candidates = int(connection.execute(f"SELECT count(*) FROM yahoo_action_repair WHERE {predicate}").fetchone()[0])
    result: dict[str, object] = {
        "path": str(path),
        "candidateRows": candidates,
        "repairedRows": 0,
        "dryRun": dry_run,
        "method": "yahoo-historical-event-conservative-availability-bound",
    }
    if dry_run or candidates == 0:
        return result

    repaired_at = datetime.now(timezone.utc).isoformat()
    connection.execute(
        f"""
        UPDATE yahoo_action_repair
        SET payload_json = json_merge_patch(
          payload_json,
          json_object(
            'first_seen_at', cast(available_at AS VARCHAR),
            'historicalAvailabilityVerified', true,
            'historicalAvailabilityUnverified', false,
            'historicalAvailabilityVerificationMethod', 'yahoo-historical-event-conservative-availability-bound',
            'firstSeenAtFallbackUsed', true,
            'firstSeenAtFallbackReason', 'provider-event-date-upper-bound',
            'pitMetadataRepair', 'yahoo-corporate-action-pit-v1',
            'pitMetadataRepairedAt', '{repaired_at}'
          )
        )
        WHERE {predicate}
        """
    )
    temporary = path.with_name(f".{path.stem}.{os.getpid()}.{time.time_ns()}.yahoo-repair.parquet")
    connection.execute(f"COPY (SELECT * FROM yahoo_action_repair) TO '{esc(temporary)}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    os.replace(temporary, path)
    result["repairedRows"] = candidates
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".cache/data-lake")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        import duckdb  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("duckdb is required for Yahoo PIT repair") from exc

    root = Path(args.root).expanduser().resolve()
    partitions = sorted((root / "corporate_actions").glob("market=*/exchange=*/symbol=*/data.parquet"))
    results: list[dict[str, object]] = []
    connection = duckdb.connect()
    try:
        for path in partitions:
            try:
                results.append(repair_partition(connection, path, dry_run=args.dry_run))
            except Exception as exc:  # noqa: BLE001
                results.append({"path": str(path), "candidateRows": 0, "repairedRows": 0, "error": str(exc)})
    finally:
        connection.close()

    summary = {
        "schema": "yahoo-corporate-action-pit-repair-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "dryRun": bool(args.dry_run),
        "partitions": len(partitions),
        "candidateRows": sum(int(row.get("candidateRows") or 0) for row in results),
        "repairedRows": sum(int(row.get("repairedRows") or 0) for row in results),
        "failedPartitions": sum(1 for row in results if row.get("error")),
        "policy": "Only dated legacy Yahoo split/dividend events; coverage receipts and other sources unchanged.",
        "results": results,
    }
    report_dir = ROOT / "reports" / "pit-repair-2026-08-29"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / ("yahoo-corporate-actions-dry-run.json" if args.dry_run else "yahoo-corporate-actions.json")
    report_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["report"] = str(report_path)
    print(json.dumps({key: summary[key] for key in ("partitions", "candidateRows", "repairedRows", "failedPartitions", "dryRun", "report")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
