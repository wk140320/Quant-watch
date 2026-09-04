"""Auditable data and point-in-time semantics for the research lake.

This module intentionally does not repair or impute market data.  It classifies
rows before they can be used by a model and keeps enough detail to explain why
a row was accepted, quarantined, or restricted to Shadow research.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from pit_contract import parse_pit_timestamp


SEMANTICS_SCHEMA = "data-semantics-audit-v1"
PIT_REQUIRED_FIELDS = ("event_time", "available_at", "first_seen_at", "ingested_at")
STRICT_EVENT_DATASETS = {"fundamentals", "financial_disclosures", "news", "macro", "social"}
ACTION_DATASETS = {"corporate_actions", "universe"}


def _hash(value: Any, length: int = 64) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:length]


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _record_identity(row: dict[str, Any]) -> str:
    identity = row.get("id") or row.get("url") or row.get("link") or row.get("record_key")
    if identity:
        base = str(identity)
    else:
        base = _hash({
            "dataset": row.get("dataset"),
            "market": row.get("market"),
            "exchange": row.get("exchange"),
            "symbol": row.get("symbol"),
            "event_time": row.get("event_time"),
            "values": row.get("values"),
            "title": row.get("title") or row.get("headline"),
        }, 32)
    # Public MARKET/000000 partitions can contain one event annotated for
    # several affected companies. Keep the affected entity in the identity so
    # only a same-entity duplicate is quarantined.
    dataset = str(row.get("dataset") or "").lower()
    related = (
        row.get("relatedSymbol")
        or row.get("related_symbol")
        or row.get("relatedTicker")
        or row.get("code")
        or row.get("ticker")
    )
    physical_symbol = str(row.get("symbol") or "").upper()
    if related and (dataset in {"news", "social", "universe"} or physical_symbol in {"MARKET", "000000"}):
        base = f"{base}|entity={str(related).strip().upper()}"
    return base


def _pit_key(row: dict[str, Any]) -> str:
    return ":".join(str(row.get(name) or "") for name in (
        "dataset", "market", "exchange", "symbol", "event_time", "available_at", "revision",
    )) + ":" + _record_identity(row)


def _source_matches_market(source: Any, market: str) -> bool:
    source_text = _text(source)
    if not source_text:
        return False
    # These providers intentionally serve multiple markets. The row's market
    # and exchange identity, not a provider name, is the authority.
    neutral_sources = (
        "market-pool-live", "market-pool-disk", "multi-news",
        "fred-alfred", "free-public-macro", "openfigi", "gleif",
        "abn-lookup", "google-news-rss", "newsapi", "marketaux",
        "reddit", "social",
    )
    if any(token in source_text for token in neutral_sources):
        return True
    if market == "ASX":
        return not any(token in source_text for token in (
            "alpaca", "nasdaq-us", "tiingo-us", "eodhd-us", "yahoo-us",
            "sec-", "sec_", "fmp-us", "-us-",
        ))
    if market == "US":
        return not any(token in source_text for token in (
            "stockanalysis-asx", "tiingo-asx", "eodhd-asx", "yahoo-asx",
            "asx-official", "-asx-",
        ))
    if market == "CN":
        return not any(token in source_text for token in (
            "alpaca", "nasdaq-us", "tiingo-us", "eodhd-us", "yahoo-us",
            "sec-", "sec_", "fmp-us", "stockanalysis-asx", "tiingo-asx",
            "eodhd-asx", "yahoo-asx", "asx-official", "-asx-",
        ))
    return False


def _symbol_is_valid(symbol: Any, market: str) -> bool:
    value = str(symbol or "").strip().upper()
    if not value:
        return False
    if market in {"ASX", "US"} and re.fullmatch(r"\d{6}", value):
        return False
    if market == "CN" and not re.fullmatch(r"\d{6}", value.replace(".", "")):
        return False
    return len(value) <= 32 and ".." not in value


def _timestamp_errors(row: dict[str, Any], dataset: str) -> list[str]:
    errors: list[str] = []
    parsed: dict[str, datetime | None] = {
        name: parse_pit_timestamp(row.get(name), date_only="end" if name in {"available_at", "first_seen_at", "ingested_at"} else "start")
        for name in PIT_REQUIRED_FIELDS
    }
    for name, value in parsed.items():
        if value is None:
            errors.append(f"missing_or_invalid_{name}")
    if any(value is None for value in parsed.values()):
        return errors
    if parsed["first_seen_at"] < parsed["available_at"]:
        errors.append("first_seen_before_available")
    if parsed["ingested_at"] < parsed["first_seen_at"]:
        errors.append("ingested_before_first_seen")
    # A report-period end or macro observation date is not the publication
    # instant.  SEC filing rows and vintage macro rows preserve that period in
    # ``event_time`` while ``available_at`` is the true public timestamp.  Do
    # not call this a PIT violation; the payload still exposes the period.
    source = _text(row.get("source"))
    period_semantics = (
        ("sec-edgar" in source and bool(row.get("reportDate") or row.get("filingDate") or row.get("observation_period_end") or row.get("observationPeriodEnd")))
        or (dataset == "macro" and ("fred" in source or "alfred" in source) and bool(row.get("seriesId")))
    )
    # For news, financial and macro observations an event cannot be publicly
    # available before its timestamp unless event_time is explicitly a period
    # end.  Corporate actions and listings may have a future effective date.
    if dataset in STRICT_EVENT_DATASETS and parsed["available_at"] < parsed["event_time"] and not period_semantics:
        errors.append("available_before_event")
    if parsed["available_at"] > datetime.now(timezone.utc):
        errors.append("available_in_future")
    return errors


def _classify_record(row: dict[str, Any], *, market: str | None = None) -> tuple[str, list[str]]:
    """Return the deterministic PIT identity and all quarantine reasons."""
    row_market = str(row.get("market") or "").upper()
    dataset = str(row.get("dataset") or "").lower()
    key = _pit_key(row)
    issues: list[str] = []
    if market and row_market != str(market).upper():
        issues.append("market_mismatch")
    if row_market not in {"ASX", "US", "CN"}:
        issues.append("unsupported_market")
    if not _symbol_is_valid(row.get("symbol"), row_market):
        issues.append("invalid_symbol")
    if not dataset:
        issues.append("missing_dataset")
    if dataset not in STRICT_EVENT_DATASETS | ACTION_DATASETS:
        issues.append("unsupported_dataset")
    if not _source_matches_market(row.get("source"), row_market):
        issues.append("source_market_mismatch")
    issues.extend(_timestamp_errors(row, dataset))
    if row.get("historicalAvailabilityVerified") is not True or row.get("historicalAvailabilityUnverified") is True:
        issues.append("historical_availability_unverified")
    return key, issues


def audit_pit_records(records: Iterable[dict[str, Any]], *, market: str | None = None) -> dict[str, Any]:
    """Audit PIT rows without modifying them.

    ``rawRows`` is always the number supplied.  Each row is assigned exactly
    one bucket: accepted, duplicate, or quarantined.  This makes row
    conservation testable and prevents missing records from becoming silent
    zeros in a feature matrix.
    """
    rows = [row for row in records if isinstance(row, dict)]
    seen: set[str] = set()
    accepted: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    quarantined: list[dict[str, Any]] = []
    issue_counts: Counter[str] = Counter()
    missing_timestamp_rows = 0
    source_counts: Counter[str] = Counter()
    dataset_counts: Counter[str] = Counter()
    market_counts: Counter[str] = Counter()
    for row in rows:
        dataset = str(row.get("dataset") or "").lower()
        dataset_counts[dataset] += 1
        row_market = str(row.get("market") or "").upper()
        market_counts[row_market] += 1
        source_counts[str(row.get("source") or "unknown")] += 1
        key, issues = _classify_record(row, market=market)
        if key in seen:
            duplicates.append({"key": key, "reason": "duplicate_pit_key"})
            issue_counts["duplicate_pit_key"] += 1
            continue
        seen.add(key)
        if any(issue.startswith("missing_or_invalid_") for issue in issues):
            missing_timestamp_rows += 1
        for issue in issues:
            issue_counts[issue] += 1
        if issues:
            quarantined.append({"key": key, "issues": issues, "market": row_market, "dataset": dataset})
        else:
            accepted.append(row)
    raw = len(rows)
    result = {
        "schema": SEMANTICS_SCHEMA,
        "market": str(market).upper() if market else "ALL",
        "rawRows": raw,
        "acceptedRows": len(accepted),
        "duplicateRows": len(duplicates),
        "quarantinedRows": len(quarantined),
        "rowConservation": raw == len(accepted) + len(duplicates) + len(quarantined),
        "duplicateKeys": len(duplicates),
        "pitViolations": sum(value for name, value in issue_counts.items() if name in {
            "available_before_event", "first_seen_before_available", "ingested_before_first_seen", "available_in_future",
        }),
        "missingRequiredTimestampRows": missing_timestamp_rows,
        "unverifiedRows": issue_counts["historical_availability_unverified"],
        "datasetCounts": dict(sorted(dataset_counts.items())),
        "marketCounts": dict(sorted(market_counts.items())),
        "sourceCounts": dict(sorted(source_counts.items())),
        "issueCounts": dict(sorted(issue_counts.items())),
        "acceptedRecordHash": _hash(accepted),
        "quarantinePreview": quarantined[:100],
        "duplicatePreview": duplicates[:100],
        "grade": "pass" if raw and not quarantined and not duplicates else "partial" if accepted else "blocked",
    }
    return result


def compare_source_rows(rows: Iterable[dict[str, Any]], *, price_tolerance: float = 0.005, volume_tolerance: float = 0.20) -> dict[str, Any]:
    """Compare same-key source observations and require a disposition for conflicts."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if isinstance(row, dict):
            key = ":".join(str(row.get(name) or "") for name in ("market", "exchange", "symbol", "interval", "timestamp", "date"))
            groups[key].append(row)
    conflicts: list[dict[str, Any]] = []
    paired = 0
    for key, candidates in groups.items():
        if len(candidates) < 2:
            continue
        paired += 1
        reference = candidates[0]
        for candidate in candidates[1:]:
            price_deltas = []
            for name in ("open", "high", "low", "close"):
                left, right = _finite(reference.get(name)), _finite(candidate.get(name))
                if left is not None and right is not None and left:
                    price_deltas.append(abs(right - left) / abs(left))
            left_volume, right_volume = _finite(reference.get("volume")), _finite(candidate.get("volume"))
            volume_delta = abs(right_volume - left_volume) / max(abs(left_volume), 1.0) if left_volume is not None and right_volume is not None else 0.0
            if (price_deltas and max(price_deltas) > price_tolerance) or volume_delta > volume_tolerance:
                conflicts.append({
                    "key": key,
                    "sources": [reference.get("source"), candidate.get("source")],
                    "maxPriceDelta": max(price_deltas or [0.0]),
                    "volumeDelta": volume_delta,
                    "disposition": candidate.get("conflictDisposition") or reference.get("conflictDisposition"),
                })
    unresolved = [row for row in conflicts if not row.get("disposition")]
    return {
        "pairedKeys": paired,
        "conflictCount": len(conflicts),
        "unresolvedConflictCount": len(unresolved),
        "conflicts": conflicts[:100],
        "passed": not unresolved,
    }


def validate_adjustment_windows(windows: Iterable[dict[str, Any]], *, tolerance: float = 1e-6) -> dict[str, Any]:
    """Validate raw/adjusted prices against an explicit adjustment factor."""
    checked = 0
    failures: list[dict[str, Any]] = []
    for window in windows:
        if not isinstance(window, dict):
            continue
        raw = _finite(window.get("rawPrice"))
        adjusted = _finite(window.get("adjustedPrice"))
        factor = _finite(window.get("adjustmentFactor"))
        if raw is None or adjusted is None or factor is None or raw == 0:
            failures.append({"id": window.get("id"), "reason": "missing_adjustment_inputs"})
            continue
        checked += 1
        error = abs(adjusted - raw * factor)
        if error > tolerance:
            failures.append({"id": window.get("id"), "error": error})
    return {"checked": checked, "failed": len(failures), "maxError": max((float(item.get("error") or 0) for item in failures), default=0.0), "passed": checked > 0 and not failures, "failures": failures[:100]}


def missingness_matrix(records: Iterable[dict[str, Any]], *, fields: Iterable[str], expected_rows: dict[str, int] | None = None) -> dict[str, Any]:
    """Return missingness by market/year/field with an explicit denominator.

    ``expected_rows`` may contain keys such as ``US:2025``.  When no expected
    denominator is supplied, the observed row count is reported and the result
    is explicitly marked ``observed_only``; it must not be presented as full
    universe coverage.
    """
    field_names = [str(field) for field in fields]
    buckets: dict[str, dict[str, Any]] = {}
    for row in records:
        if not isinstance(row, dict):
            continue
        market = str(row.get("market") or "UNKNOWN").upper()
        year = str(row.get("event_time") or row.get("available_at") or "unknown")[:4]
        key = f"{market}:{year}"
        bucket = buckets.setdefault(key, {"market": market, "year": year, "observedRows": 0, "missing": Counter()})
        bucket["observedRows"] += 1
        for field in field_names:
            value = row.get(field)
            if value is None and isinstance(row.get("values"), dict):
                value = row["values"].get(field)
            if value in (None, ""):
                bucket["missing"][field] += 1
    output = []
    for key, bucket in sorted(buckets.items()):
        denominator = int((expected_rows or {}).get(key) or bucket["observedRows"])
        output.append({
            "key": key,
            "market": bucket["market"],
            "year": bucket["year"],
            "observedRows": bucket["observedRows"],
            "expectedRows": denominator,
            "denominatorKind": "expected" if expected_rows and key in expected_rows else "observed_only",
            "missing": dict(sorted(bucket["missing"].items())),
            "coverage": {
                field: round((denominator - count) / max(1, denominator) * 100.0, 4)
                for field, count in bucket["missing"].items()
            },
        })
    return {"fields": field_names, "buckets": output, "denominatorComplete": bool(expected_rows), "passed": bool(output) and all(item["denominatorKind"] == "expected" for item in output)}


def revision_chain_audit(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Validate that revisions are ordered by first availability.

    A revision can change a value, but it cannot become visible before the
    previous version.  The audit does not choose a winner for a signal date;
    downstream PIT joins must still select the latest version with
    ``available_at <= signal_time``.
    """
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in records:
        if not isinstance(row, dict):
            continue
        identity = ":".join(str(row.get(name) or "") for name in ("dataset", "market", "exchange", "symbol", "event_time", "id"))
        groups[identity].append(row)
    violations: list[dict[str, Any]] = []
    revisioned = 0
    for identity, rows in groups.items():
        if len(rows) < 2:
            continue
        revisioned += 1
        ordered = sorted(rows, key=lambda row: str(row.get("available_at") or ""))
        seen_revisions: set[str] = set()
        for row in ordered:
            revision = str(row.get("revision") or "initial")
            if revision in seen_revisions:
                violations.append({"identity": identity, "revision": revision, "reason": "duplicate_revision_at_identity"})
            seen_revisions.add(revision)
        for previous, current in zip(ordered, ordered[1:]):
            if str(current.get("available_at") or "") < str(previous.get("available_at") or ""):
                violations.append({"identity": identity, "reason": "availability_order_violation"})
    return {"identities": len(groups), "revisionedIdentities": revisioned, "violations": len(violations), "passed": not violations, "preview": violations[:100]}


def source_quality_audit(records: Iterable[dict[str, Any]], *, low_quality_threshold: float = 0.5) -> dict[str, Any]:
    """Summarize source quality without converting missing quality into zero."""
    rows = [row for row in records if isinstance(row, dict)]
    values = [_finite(row.get("sourceQuality")) for row in rows]
    known = [value for value in values if value is not None]
    low = sum(1 for value in known if value < low_quality_threshold)
    missing = len(rows) - len(known)
    return {
        "rows": len(rows),
        "knownQualityRows": len(known),
        "missingQualityRows": missing,
        "lowQualityRows": low,
        "lowQualityPct": round(low / max(1, len(rows)) * 100.0, 4),
        "missingQualityPct": round(missing / max(1, len(rows)) * 100.0, 4),
        "silentZeroForbidden": True,
        "passed": bool(rows) and missing == 0,
    }


def cluster_events(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Cluster obvious reposts while retaining every contributing source."""
    clusters: dict[str, dict[str, Any]] = {}
    assignments: list[dict[str, Any]] = []
    for row in records:
        if not isinstance(row, dict):
            continue
        entity = str(row.get("symbol") or row.get("entity") or "").upper()
        title = _text(row.get("title") or row.get("headline") or row.get("summary"))
        url = _text(row.get("url") or row.get("link"))
        fingerprint = _hash({"entity": entity, "title": title, "url": url}, 32)
        # Exact canonical links/titles are safe to cluster without semantic
        # guessing.  Similarity models belong in a separately validated event
        # expert and must not alter PIT timestamps here.
        cluster_key = _hash({"entity": entity, "title": title, "url": url}, 24)
        if url:
            cluster_key = _hash({"entity": entity, "url": url}, 24)
        cluster = clusters.setdefault(cluster_key, {
            "eventClusterId": cluster_key,
            "entity": entity,
            "firstAvailableAt": row.get("available_at"),
            "sourceIds": [],
            "recordIds": [],
            "fingerprints": [],
        })
        available = str(row.get("available_at") or "")
        if available and str(cluster.get("firstAvailableAt") or "") > available:
            cluster["firstAvailableAt"] = available
        cluster["sourceIds"].append(row.get("source"))
        cluster["recordIds"].append(_record_identity(row))
        cluster["fingerprints"].append(fingerprint)
        assignments.append({"recordId": _record_identity(row), "eventClusterId": cluster_key, "firstAvailableAt": cluster["firstAvailableAt"]})
    return {
        "rawEvents": len(assignments),
        "clusterCount": len(clusters),
        "dedupeReduction": len(assignments) - len(clusters),
        "clusters": list(clusters.values()),
        "assignments": assignments,
    }


def validate_trading_dates(dates: Iterable[str], *, market: str) -> dict[str, Any]:
    """Check supplied dates for ordering, weekends, and duplicate labels.

    Exchange holidays are source data, not guessed here.  The result therefore
    distinguishes weekend errors from unverified holiday coverage.
    """
    values = [str(value)[:10] for value in dates if str(value).strip()]
    unique = sorted(set(values))
    duplicates = len(values) - len(unique)
    invalid = []
    for value in unique:
        try:
            day = datetime.fromisoformat(value).date()
        except ValueError:
            invalid.append({"date": value, "reason": "invalid_date"})
            continue
        if day.weekday() >= 5:
            invalid.append({"date": value, "reason": "weekend"})
    return {
        "market": str(market).upper(),
        "inputDates": len(values),
        "uniqueDates": len(unique),
        "duplicateDates": duplicates,
        "weekendOrInvalid": len(invalid),
        "holidayCalendarVerified": False,
        "passed": duplicates == 0 and not invalid,
        "issues": invalid[:100],
    }


def audit_lake(payload: dict[str, Any]) -> dict[str, Any]:
    """Scan the PIT portion of a Parquet lake and emit bounded evidence.

    OHLCV quality is audited by ``data_lake.audit``.  This function deliberately
    audits only PIT datasets, because mixing bar rows and events would make
    coverage denominators meaningless.  A bounded scan is marked as truncated
    rather than silently presenting a partial audit as complete.
    """
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    from data_lake import _root  # local import avoids a module cycle at import time

    root = _root(payload)
    requested_market = str(payload.get("market") or "").upper()
    if requested_market and requested_market not in {"ASX", "US", "CN"}:
        raise ValueError(f"Unsupported market for semantic audit: {requested_market}")
    max_rows = max(1_000, min(2_000_000, int(payload.get("max_rows") or payload.get("maxRows") or 500_000)))
    records: list[dict[str, Any]] = []
    scanned_rows = 0
    datasets_seen: list[str] = []
    connection = duckdb.connect()
    try:
        for dataset in sorted(STRICT_EVENT_DATASETS | ACTION_DATASETS):
            dataset_root = root / dataset
            files = list(dataset_root.glob("market=*/exchange=*/symbol=*/data.parquet")) if dataset_root.exists() else []
            # The explicit glob above is intentionally anchored to the dataset
            # directory; it avoids opening provider-cache files or quarantine.
            if not files:
                continue
            datasets_seen.append(dataset)
            for path in files:
                escaped = str(path).replace("'", "''")
                query = f"SELECT market, exchange, symbol, event_time, available_at, revision, source, payload_json FROM read_parquet('{escaped}')"
                for market, exchange, symbol, event_time, available_at, revision, source, payload_json in connection.execute(query).fetchall():
                    if requested_market and str(market or "").upper() != requested_market:
                        continue
                    scanned_rows += 1
                    if len(records) >= max_rows:
                        continue
                    try:
                        raw = json.loads(payload_json or "{}")
                    except (TypeError, json.JSONDecodeError):
                        raw = {}
                    # Do not infer the four PIT timestamps in the audit.  The
                    # ingest layer may use a conservative fallback, but the
                    # report must reveal whether the provider supplied it.
                    records.append({
                        **raw,
                        "dataset": dataset,
                        "market": str(market or "").upper(),
                        "exchange": exchange,
                        "symbol": symbol,
                        "event_time": event_time,
                        "available_at": available_at,
                        "revision": revision,
                        "source": source,
                    })
    finally:
        connection.close()
    evidence = audit_pit_records(records, market=requested_market or None)
    evidence.update({
        "root": str(root),
        "datasetsScanned": datasets_seen,
        "scannedRows": scanned_rows,
        "materializedRows": len(records),
        "truncated": scanned_rows > len(records),
        "scanComplete": scanned_rows <= len(records),
        "contentHash": _hash({"scannedRows": scanned_rows, "records": records}),
    })
    return evidence


def audit_lake_complete(payload: dict[str, Any]) -> dict[str, Any]:
    """Audit every PIT row with bounded memory and an immutable row count.

    ``audit_lake`` is useful for previews, but a capped materialization cannot
    be used as a market-level gate.  This variant streams one dataset at a
    time from DuckDB, keeps only identities and counters, and therefore makes
    the coverage denominator explicit without loading the lake into Python.
    """
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    from data_lake import _root  # local import avoids a module cycle at import time

    root = _root(payload)
    requested_market = str(payload.get("market") or "").upper()
    if requested_market and requested_market not in {"ASX", "US", "CN"}:
        raise ValueError(f"Unsupported market for semantic audit: {requested_market}")

    scanned_rows = 0
    accepted_rows = 0
    duplicate_rows = 0
    quarantined_rows = 0
    missing_timestamp_rows = 0
    verified_missing_timestamp_rows = 0
    unverified_rows = 0
    pit_violations = 0
    verified_pit_violations = 0
    datasets_seen: list[str] = []
    dataset_counts: Counter[str] = Counter()
    market_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    issue_counts: Counter[str] = Counter()
    issue_counts_by_dataset: dict[str, Counter[str]] = defaultdict(Counter)
    issue_counts_by_market: dict[str, Counter[str]] = defaultdict(Counter)
    verified_missing_timestamp_by_market: Counter[str] = Counter()
    verified_pit_violations_by_market: Counter[str] = Counter()
    seen: set[str] = set()
    quarantine_preview: list[dict[str, Any]] = []
    duplicate_preview: list[dict[str, Any]] = []
    accepted_hasher = hashlib.sha256()
    row_hasher = hashlib.sha256()
    connection = duckdb.connect()
    try:
        for dataset in sorted(STRICT_EVENT_DATASETS | ACTION_DATASETS):
            dataset_root = root / dataset
            pattern = str(dataset_root / "market=*" / "exchange=*" / "symbol=*" / "data.parquet")
            if not dataset_root.exists() or not list(dataset_root.glob("market=*/exchange=*/symbol=*/data.parquet")):
                continue
            datasets_seen.append(dataset)
            escaped_pattern = pattern.replace("'", "''")
            query = (
                "SELECT record_key, market, exchange, symbol, event_time, available_at, "
                "revision, source, payload_json FROM read_parquet('" + escaped_pattern + "', union_by_name=true)"
            )
            cursor = connection.execute(query)
            while True:
                batch = cursor.fetchmany(20_000)
                if not batch:
                    break
                for record_key, market_value, exchange, symbol, event_time, available_at, revision, source, payload_json in batch:
                    row_market = str(market_value or "").upper()
                    if requested_market and row_market != requested_market:
                        continue
                    try:
                        raw = json.loads(payload_json or "{}")
                    except (TypeError, json.JSONDecodeError):
                        raw = {}
                    row = {
                        **raw,
                        "record_key": record_key,
                        "dataset": dataset,
                        "market": row_market,
                        "exchange": exchange,
                        "symbol": symbol,
                        "event_time": event_time,
                        "available_at": available_at,
                        "revision": revision,
                        "source": source,
                    }
                    scanned_rows += 1
                    dataset_counts[dataset] += 1
                    market_counts[row_market] += 1
                    source_counts[str(source or "unknown")] += 1
                    key, issues = _classify_record(row, market=requested_market or None)
                    row_hasher.update((key + "\n" + str(payload_json or "") + "\n").encode("utf-8"))
                    if key in seen:
                        duplicate_rows += 1
                        issue_counts["duplicate_pit_key"] += 1
                        if len(duplicate_preview) < 100:
                            duplicate_preview.append({"key": key, "reason": "duplicate_pit_key"})
                        continue
                    seen.add(key)
                    for issue in issues:
                        issue_counts[issue] += 1
                        issue_counts_by_dataset[dataset][issue] += 1
                        issue_counts_by_market[row_market][issue] += 1
                    if any(issue.startswith("missing_or_invalid_") for issue in issues):
                        missing_timestamp_rows += 1
                        if "historical_availability_unverified" not in issues:
                            verified_missing_timestamp_rows += 1
                            verified_missing_timestamp_by_market[row_market] += 1
                    if "historical_availability_unverified" in issues:
                        unverified_rows += 1
                    temporal_issues = [
                        issue for issue in issues
                        if issue in {"available_before_event", "first_seen_before_available", "ingested_before_first_seen", "available_in_future"}
                    ]
                    if temporal_issues:
                        pit_violations += len(temporal_issues)
                        if "historical_availability_unverified" not in issues:
                            verified_pit_violations += len(temporal_issues)
                            verified_pit_violations_by_market[row_market] += len(temporal_issues)
                    if issues:
                        quarantined_rows += 1
                        if len(quarantine_preview) < 100:
                            quarantine_preview.append({"key": key, "issues": issues, "market": row_market, "dataset": dataset})
                    else:
                        accepted_rows += 1
                        accepted_hasher.update((key + "\n").encode("utf-8"))
    finally:
        connection.close()

    return {
        "schema": "data-semantics-audit-complete-v1",
        "market": requested_market or "ALL",
        "root": str(root),
        "rawRows": scanned_rows,
        "acceptedRows": accepted_rows,
        "duplicateRows": duplicate_rows,
        "quarantinedRows": quarantined_rows,
        "rowConservation": scanned_rows == accepted_rows + duplicate_rows + quarantined_rows,
        "duplicateKeys": duplicate_rows,
        "pitViolations": pit_violations,
        "verifiedPitViolations": verified_pit_violations,
        "missingRequiredTimestampRows": missing_timestamp_rows,
        "verifiedMissingRequiredTimestampRows": verified_missing_timestamp_rows,
        "unverifiedRows": unverified_rows,
        "verifiedMissingRequiredTimestampRowsByMarket": dict(sorted(verified_missing_timestamp_by_market.items())),
        "verifiedPitViolationsByMarket": dict(sorted(verified_pit_violations_by_market.items())),
        "datasetCounts": dict(sorted(dataset_counts.items())),
        "marketCounts": dict(sorted(market_counts.items())),
        "sourceCounts": dict(sorted(source_counts.items())),
        "issueCounts": dict(sorted(issue_counts.items())),
        "issueCountsByDataset": {
            dataset: dict(sorted(counts.items()))
            for dataset, counts in sorted(issue_counts_by_dataset.items())
        },
        "issueCountsByMarket": {
            market: dict(sorted(counts.items()))
            for market, counts in sorted(issue_counts_by_market.items())
        },
        "acceptedRecordHash": accepted_hasher.hexdigest(),
        "contentHash": row_hasher.hexdigest(),
        "quarantinePreview": quarantine_preview,
        "duplicatePreview": duplicate_preview,
        "datasetsScanned": datasets_seen,
        "scannedRows": scanned_rows,
        "materializedRows": scanned_rows,
        "truncated": False,
        "scanComplete": True,
        "grade": "pass" if scanned_rows and not quarantined_rows and not duplicate_rows else "partial" if accepted_rows else "blocked",
    }


__all__ = [
    "ACTION_DATASETS", "PIT_REQUIRED_FIELDS", "SEMANTICS_SCHEMA", "STRICT_EVENT_DATASETS",
    "audit_pit_records", "cluster_events", "compare_source_rows", "missingness_matrix",
    "revision_chain_audit", "source_quality_audit", "validate_adjustment_windows",
    "validate_trading_dates", "audit_lake", "audit_lake_complete",
]
