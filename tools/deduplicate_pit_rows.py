#!/usr/bin/env python3
"""Deduplicate PIT partitions without losing audit evidence.

The lake stores market-wide news and universe snapshots in MARKET/000000
partitions.  A URL can therefore occur once for each affected entity.  This
tool keeps those rows distinct and removes only a deterministic duplicate of
the same entity/event identity.  Removed rows are copied to a timestamped
quarantine Parquet tree before the source partition is atomically replaced.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import duckdb  # type: ignore
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("duckdb is required for PIT deduplication") from exc


ROOT = Path(__file__).resolve().parents[1]
DATASETS = (
    "corporate_actions", "financial_disclosures", "fundamentals", "macro",
    "news", "social", "universe",
)


def esc(value: Path | str) -> str:
    return str(value).replace("'", "''")


def identity_sql() -> str:
    base = """
      coalesce(
        nullif(json_extract_string(payload_json, '$.id'), ''),
        nullif(json_extract_string(payload_json, '$.url'), ''),
        nullif(json_extract_string(payload_json, '$.link'), ''),
        record_key
      )
    """
    entity = """
      upper(coalesce(
        nullif(json_extract_string(payload_json, '$.relatedSymbol'), ''),
        nullif(json_extract_string(payload_json, '$.related_symbol'), ''),
        nullif(json_extract_string(payload_json, '$.relatedTicker'), ''),
        nullif(json_extract_string(payload_json, '$.code'), ''),
        nullif(json_extract_string(payload_json, '$.ticker'), ''),
        ''
      ))
    """
    return f"""
      concat(
        dataset, ':', market, ':', exchange, ':', symbol, ':', event_time, ':',
        available_at, ':', revision, ':', {base},
        case when {entity} <> '' and (dataset in ('news', 'social', 'universe')
                    or upper(cast(symbol as varchar)) in ('MARKET', '000000'))
             then concat('|entity=', {entity}) else '' end
      )
    """


def compact_partition(connection, path: Path, quarantine: Path, *, apply: bool) -> dict[str, object]:
    source = esc(path)
    relative = path.relative_to(ROOT / ".cache" / "data-lake")
    quarantine_path = quarantine / relative
    key = identity_sql()
    ranked = f"""
      select *, row_number() over (
        partition by {key}
        order by
          case when json_extract_string(payload_json, '$.historicalAvailabilityVerified') = 'true'
               and coalesce(json_extract_string(payload_json, '$.historicalAvailabilityUnverified'), 'false') <> 'true'
               then 0 else 1 end,
          case when coalesce(json_extract_string(payload_json, '$.pitTimestampFallbackUsed'), 'false') = 'true'
               then 1 else 0 end,
          coalesce(try_cast(json_extract_string(payload_json, '$.sourceQuality') as double), 0) desc,
          saved_at asc nulls last,
          record_key asc
      ) as _pit_rank
      from read_parquet('{source}', union_by_name=true)
    """
    duplicate_count = int(connection.execute(
        f"select count(*) from ({ranked}) where _pit_rank > 1"
    ).fetchone()[0])
    if duplicate_count == 0 or not apply:
        return {"path": str(path), "duplicateRows": duplicate_count, "keptRows": None, "applied": False}

    quarantine_path.parent.mkdir(parents=True, exist_ok=True)
    escaped_quarantine = esc(quarantine_path)
    connection.execute(
        f"copy (select * exclude(_pit_rank) from ({ranked}) where _pit_rank > 1) "
        f"to '{escaped_quarantine}' (format parquet, compression zstd)"
    )
    temporary = path.with_suffix(f".{os.getpid()}.dedup.tmp.parquet")
    escaped_temporary = esc(temporary)
    connection.execute(
        f"copy (select * exclude(_pit_rank) from ({ranked}) where _pit_rank = 1 "
        f"order by available_at, event_time, record_key) "
        f"to '{escaped_temporary}' (format parquet, compression zstd)"
    )
    os.replace(temporary, path)
    kept_count = int(connection.execute(f"select count(*) from read_parquet('{esc(path)}')").fetchone()[0])
    return {"path": str(path), "duplicateRows": duplicate_count, "keptRows": kept_count, "applied": True, "quarantine": str(quarantine_path)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".cache/data-lake")
    parser.add_argument("--apply", action="store_true", help="atomically compact partitions and quarantine duplicates")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        raise SystemExit(f"data lake not found: {root}")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    quarantine = root / "quarantine" / f"pit-duplicates={stamp}"
    partitions = [
        path for dataset in DATASETS
        for path in sorted((root / dataset).glob("market=*/exchange=*/symbol=*/data.parquet"))
        if path.is_file()
    ]
    connection = duckdb.connect()
    results: list[dict[str, object]] = []
    try:
        for path in partitions:
            try:
                results.append(compact_partition(connection, path, quarantine, apply=args.apply))
            except Exception as exc:  # noqa: BLE001 - preserve progress per partition.
                results.append({"path": str(path), "duplicateRows": None, "keptRows": None, "applied": False, "error": str(exc)})
    finally:
        connection.close()
    summary = {
        "schema": "pit-deduplication-v1",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "apply": bool(args.apply),
        "partitionCount": len(partitions),
        "duplicateRows": sum(int(row.get("duplicateRows") or 0) for row in results),
        "partitionsChanged": sum(bool(row.get("applied")) for row in results),
        "failedPartitions": sum(bool(row.get("error")) for row in results),
        "quarantine": str(quarantine) if args.apply else None,
        "results": results,
    }
    report_dir = ROOT / "reports" / "pit-dedup-2026-08-29"
    report_dir.mkdir(parents=True, exist_ok=True)
    report = report_dir / ("apply.json" if args.apply else "dry-run.json")
    report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "partitionCount": summary["partitionCount"],
        "duplicateRows": summary["duplicateRows"],
        "partitionsChanged": summary["partitionsChanged"],
        "failedPartitions": summary["failedPartitions"],
        "apply": summary["apply"],
        "report": str(report),
    }, ensure_ascii=False))
    return 0 if not summary["failedPartitions"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
