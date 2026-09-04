#!/usr/bin/env python3
"""Conservatively repair legacy PIT metadata and quarantine invalid verified rows.

The repair never changes event_time, available_at, values, or source facts.
Missing ingestion metadata is filled from the earliest existing observation.
For already verified rows, a missing first_seen_at can use the provider's
available_at and is explicitly marked as a fallback.  Rows with a verified
but impossible time relation are marked unverified and retained for audit;
they are never used by strict training reads.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


DATASETS = (
    "corporate_actions",
    "financial_disclosures",
    "fundamentals",
    "macro",
    "news",
    "social",
    "universe",
)


def esc(value: Path | str) -> str:
    return str(value).replace("'", "''")


def repair_partition(connection, path: Path, *, dataset: str, dry_run: bool) -> dict[str, object]:
    connection.execute("DROP TABLE IF EXISTS pit_repair")
    connection.execute(
        f"CREATE TEMP TABLE pit_repair AS SELECT * FROM read_parquet('{esc(path)}', union_by_name=true)"
    )
    first_seen_predicate = """
        try_cast(json_extract(payload_json, '$.historicalAvailabilityVerified') AS BOOLEAN) = true
        AND coalesce(try_cast(json_extract(payload_json, '$.historicalAvailabilityUnverified') AS BOOLEAN), false) = false
        AND (try(json_extract_string(payload_json, '$.first_seen_at')) IS NULL
             OR try(json_extract_string(payload_json, '$.first_seen_at')) = '')
        AND nullif(cast(available_at AS VARCHAR), '') IS NOT NULL
    """
    ingested_predicate = """
        (try(json_extract_string(payload_json, '$.ingested_at')) IS NULL
         OR try(json_extract_string(payload_json, '$.ingested_at')) = '')
        AND coalesce(
              nullif(try(json_extract_string(payload_json, '$.first_seen_at')), ''),
              nullif(try(json_extract_string(payload_json, '$.saved_at')), ''),
              nullif(cast(saved_at AS VARCHAR), '')
            ) IS NOT NULL
    """
    # Keep the source values intact, but remove the verified claim whenever a
    # verified record violates a generic PIT ordering rule.  The event-time
    # rule is restricted to fundamentals: an accounting period can end before
    # filing, while an ex-date or a news event may legitimately be announced
    # before it becomes effective.  This makes the repair conservative across
    # heterogeneous datasets and prevents a bad row from keeping Gate03 open.
    quarantine_predicate = f"""
        try_cast(json_extract(payload_json, '$.historicalAvailabilityVerified') AS BOOLEAN) = true
        AND coalesce(try_cast(json_extract(payload_json, '$.historicalAvailabilityUnverified') AS BOOLEAN), false) = false
        AND (
          try_cast(available_at AS TIMESTAMP) > current_timestamp
          OR try_cast(json_extract_string(payload_json, '$.first_seen_at') AS TIMESTAMP) > current_timestamp
          OR try_cast(json_extract_string(payload_json, '$.ingested_at') AS TIMESTAMP) > current_timestamp
          OR try_cast(json_extract_string(payload_json, '$.first_seen_at') AS TIMESTAMP) < try_cast(available_at AS TIMESTAMP)
          OR try_cast(json_extract_string(payload_json, '$.ingested_at') AS TIMESTAMP) < try_cast(json_extract_string(payload_json, '$.first_seen_at') AS TIMESTAMP)
          {"OR try_cast(available_at AS TIMESTAMP) < try_cast(event_time AS TIMESTAMP)" if dataset == "fundamentals" else ""}
        )
    """
    quarantine_count = int(connection.execute(
        f"SELECT count(*) FROM pit_repair WHERE {quarantine_predicate or 'false'}"
    ).fetchone()[0])
    first_seen_count = int(connection.execute(
        f"SELECT count(*) FROM pit_repair WHERE {first_seen_predicate}"
    ).fetchone()[0])
    ingested_count = int(connection.execute(
        """
        SELECT count(*)
        FROM pit_repair
        WHERE (try(json_extract_string(payload_json, '$.ingested_at')) IS NULL
               OR try(json_extract_string(payload_json, '$.ingested_at')) = '')
          AND coalesce(
                nullif(try(json_extract_string(payload_json, '$.first_seen_at')), ''),
                nullif(try(json_extract_string(payload_json, '$.saved_at')), ''),
                nullif(cast(saved_at AS VARCHAR), '')
              ) IS NOT NULL
        """
    ).fetchone()[0])
    candidate = max(0, first_seen_count + ingested_count + quarantine_count)
    result: dict[str, object] = {
        "path": str(path),
        "dataset": dataset,
        "candidateRows": candidate,
        "repaired": 0,
        "firstSeenRepaired": first_seen_count,
        "ingestedRepaired": ingested_count,
        "quarantinedRows": quarantine_count,
        "dryRun": dry_run,
    }
    if dry_run or candidate == 0:
        return result

    connection.execute(
        f"""
        UPDATE pit_repair
        SET payload_json = json_merge_patch(
          payload_json,
          json_object(
            'first_seen_at', cast(available_at AS VARCHAR),
            'firstSeenAtFallbackUsed', true,
            'firstSeenAtFallbackReason', 'verified-row-available-at',
            'pitTimestampFallbackUsed', true,
            'pitTimestampFallbackFields', json_array('first_seen_at')
          )
        )
        WHERE {first_seen_predicate}
        """
    )
    connection.execute(
        """
        UPDATE pit_repair
        SET payload_json = json_merge_patch(
          payload_json,
          json_object(
            'ingested_at', coalesce(
              nullif(try(json_extract_string(payload_json, '$.first_seen_at')), ''),
              nullif(try(json_extract_string(payload_json, '$.saved_at')), ''),
              nullif(cast(saved_at AS VARCHAR), '')
            ),
            'ingestedAtFallbackUsed', true,
            'ingestedAtFallbackReason', 'legacy-row-first-observation',
            'pitTimestampFallbackUsed', true,
            'pitTimestampFallbackFields', json_array('ingested_at')
          )
        )
        WHERE (try(json_extract_string(payload_json, '$.ingested_at')) IS NULL
               OR try(json_extract_string(payload_json, '$.ingested_at')) = '')
          AND coalesce(
                nullif(try(json_extract_string(payload_json, '$.first_seen_at')), ''),
                nullif(try(json_extract_string(payload_json, '$.saved_at')), ''),
                nullif(cast(saved_at AS VARCHAR), '')
              ) IS NOT NULL
        """
    )
    if quarantine_predicate:
        connection.execute(
            f"""
            UPDATE pit_repair
            SET payload_json = json_merge_patch(
              payload_json,
              json_object(
                'historicalAvailabilityVerified', false,
                'historicalAvailabilityUnverified', true,
                'pitQuarantineReason', 'verified-row-impossible-time-relation',
                'pitQuarantineAt', '{datetime.now(timezone.utc).isoformat()}'
              )
            )
            WHERE {quarantine_predicate}
            """
        )
    temporary = path.with_name(f".{path.stem}.{os.getpid()}.{time.time_ns()}.repair.parquet")
    connection.execute(
        f"COPY (SELECT * FROM pit_repair) TO '{esc(temporary)}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    os.replace(temporary, path)
    result["repaired"] = candidate
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".cache/data-lake")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        import duckdb  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment guard
        raise SystemExit("duckdb is required for PIT metadata repair") from exc

    root = Path(args.root).expanduser().resolve()
    partitions = []
    for dataset in DATASETS:
        partitions.extend(sorted((root / dataset).glob("market=*/exchange=*/symbol=*/data.parquet")))
    started = datetime.now(timezone.utc).isoformat()
    results = []
    connection = duckdb.connect()
    try:
        for path in partitions:
            dataset = next((name for name in DATASETS if f"/{name}/" in str(path)), "unknown")
            try:
                results.append(repair_partition(connection, path, dataset=dataset, dry_run=args.dry_run))
            except Exception as exc:  # noqa: BLE001 - one bad partition must not stop the migration.
                results.append({"path": str(path), "candidateRows": None, "repaired": 0, "error": str(exc)})
    finally:
        connection.close()
    summary = {
        "schema": "pit-metadata-repair-v1",
        "startedAt": started,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "dryRun": bool(args.dry_run),
        "partitions": len(partitions),
        "candidateRows": sum(int(row.get("candidateRows") or 0) for row in results),
        "repairedRows": sum(int(row.get("repaired") or 0) for row in results),
        "firstSeenRepairedRows": sum(int(row.get("firstSeenRepaired") or 0) for row in results),
        "ingestedRepairedRows": sum(int(row.get("ingestedRepaired") or 0) for row in results),
        "quarantinedRows": sum(int(row.get("quarantinedRows") or 0) for row in results),
        "failedPartitions": sum(1 for row in results if row.get("error")),
        "results": results,
    }
    report_dir = Path(__file__).resolve().parents[1] / "reports" / "pit-repair-2026-08-29"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / ("dry-run.json" if args.dry_run else "repair.json")
    report_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["report"] = str(report_path)
    print(json.dumps({key: summary[key] for key in ("partitions", "candidateRows", "repairedRows", "firstSeenRepairedRows", "ingestedRepairedRows", "quarantinedRows", "failedPartitions", "dryRun", "report")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
