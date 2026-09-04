#!/usr/bin/env python3
"""Audit ASX numerical PIT coverage without treating event scores as facts."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import duckdb  # type: ignore


NUMERIC_FACTS = {
    "revenue", "netIncome", "profit", "gross_profit", "ebitda", "assets",
    "liabilities", "equity", "cashAndEquivalents", "operatingCashFlow",
    "capitalExpenditure", "dilutedEps", "eps", "revenueGrowth", "profitGrowth",
}
EVENT_ONLY = {
    "eventSentiment", "eventRelevance", "eventNovelty", "announcementScore",
    "fundamentalQuality", "positiveCatalyst", "negativeCatalyst", "dilutionRisk",
    "regulatoryRisk", "earningsEvent", "capitalAllocation", "operationalMomentum",
    "eventIntensity", "sourceQuality",
}


def audit(root: Path, target_symbols: set[str] | None = None) -> dict:
    paths = sorted((root / "fundamentals" / "market=ASX").glob("exchange=*/symbol=*/data.parquet"))
    if not paths:
        return {
            "schema": "asx-numeric-pit-audit-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "root": str(root),
            "status": "no-fundamentals-partitions",
            "rows": 0,
            "symbols": 0,
            "strictNumericRows": 0,
            "strictNumericSymbols": 0,
        }
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            "SELECT symbol, source, available_at, payload_json FROM read_parquet(?, union_by_name=true)",
            [[str(path) for path in paths]],
        ).fetchall()
    finally:
        connection.close()

    source_counts: Counter[str] = Counter()
    strict_source_counts: Counter[str] = Counter()
    all_symbols: set[str] = set()
    strict_symbols: set[str] = set()
    strict_rows = 0
    numeric_rows = 0
    temporal_failures = 0
    numeric_field_counts: Counter[str] = Counter()
    event_only_rows = 0
    strict_symbol_stats: dict[str, dict[str, object]] = {}
    for symbol, source, available_at, payload_json in rows:
        code = str(symbol or "").upper().removesuffix(".AX")
        if target_symbols and code not in target_symbols:
            continue
        all_symbols.add(code)
        source_counts[str(source or "unknown")] += 1
        try:
            payload = json.loads(payload_json or "{}")
        except json.JSONDecodeError:
            temporal_failures += 1
            continue
        values = payload.get("values") if isinstance(payload.get("values"), dict) else {}
        numeric = {
            key: value
            for key, value in values.items()
            if key in NUMERIC_FACTS and isinstance(value, (int, float)) and value == value
        }
        strict = payload.get("historicalAvailabilityVerified") is True and payload.get("historicalAvailabilityUnverified") is not True
        timestamps = [
            payload.get("observation_period_end") or payload.get("event_time"),
            payload.get("published_at") or payload.get("available_at") or available_at,
            payload.get("first_seen_at"),
            payload.get("ingested_at"),
        ]
        if strict and any(not str(value or "").strip() for value in timestamps):
            temporal_failures += 1
            strict = False
        if numeric:
            numeric_rows += 1
        if numeric and strict:
            strict_rows += 1
            strict_symbols.add(code)
            stats = strict_symbol_stats.setdefault(code, {
                "symbol": code,
                "rows": 0,
                "fields": set(),
                "periodEnds": set(),
                "sources": set(),
            })
            stats["rows"] = int(stats["rows"]) + 1
            stats["fields"].update(numeric)
            stats["sources"].add(str(source or "unknown"))
            period_end = payload.get("observation_period_end") or payload.get("event_time")
            if str(period_end or "").strip():
                stats["periodEnds"].add(str(period_end)[:10])
            strict_source_counts[str(source or "unknown")] += 1
            for key in numeric:
                numeric_field_counts[key] += 1
        elif values and set(values).issubset(EVENT_ONLY):
            event_only_rows += 1

    snapshot_path = root / "replenishment-snapshot-asx.json"
    training_denominator = None
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        training_denominator = int(((snapshot.get("snapshot") or {}).get("target") or {}).get("symbols") or 0) or None
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    training_pct = round(len(strict_symbols) / training_denominator * 100, 4) if training_denominator else None
    strict_symbol_coverage = []
    for symbol in sorted(strict_symbol_stats):
        stats = strict_symbol_stats[symbol]
        periods = sorted(stats["periodEnds"])
        strict_symbol_coverage.append({
            "symbol": symbol,
            "strictRows": stats["rows"],
            "fieldCount": len(stats["fields"]),
            "fields": sorted(stats["fields"]),
            "periodCount": len(periods),
            "firstPeriodEnd": periods[0] if periods else None,
            "lastPeriodEnd": periods[-1] if periods else None,
            "sources": sorted(stats["sources"]),
        })
    return {
        "schema": "asx-numeric-pit-audit-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "root": str(root),
        "status": "audited",
        "rows": len(rows),
        "symbols": len(all_symbols),
        "numericRows": numeric_rows,
        "nonStrictNumericRows": max(0, numeric_rows - strict_rows),
        "strictNumericRows": strict_rows,
        "strictNumericSymbols": len(strict_symbols),
        "strictNumericSymbolList": sorted(strict_symbols),
        "strictSymbolCoverage": strict_symbol_coverage,
        "trainingUniverseDenominator": training_denominator,
        "trainingUniverseStrictNumericCoveragePct": training_pct,
        "eventOnlyRows": event_only_rows,
        "temporalFailures": temporal_failures,
        "sourceCounts": dict(source_counts),
        "strictSourceCounts": dict(strict_source_counts),
        "numericFieldCounts": dict(numeric_field_counts),
        "note": "Event scores are excluded. Strict numeric coverage requires verified availability and complete PIT timestamps.",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1] / ".cache" / "data-lake")
    parser.add_argument("--symbols", default="")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "reports" / "asx-numeric-pit-audit.json")
    args = parser.parse_args()
    symbols = {item.strip().upper().removesuffix(".AX") for item in args.symbols.split(",") if item.strip()} or None
    result = audit(args.root.expanduser().resolve(), symbols)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result["output"] = str(args.output.resolve())
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: result.get(key) for key in ("status", "rows", "symbols", "numericRows", "strictNumericRows", "strictNumericSymbols", "eventOnlyRows", "temporalFailures", "output")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
