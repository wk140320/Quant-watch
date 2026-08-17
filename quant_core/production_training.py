from __future__ import annotations

import hashlib
import importlib.util
import importlib.metadata
import json
import math
import gzip
import os
import random
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, datetime, time, timezone
from pathlib import Path
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from data_quality import assess_candle_quality, label_confidence_for_window
from historical_backtest import (
    adaptive_barriers,
    apply_standardizer,
    build_feature_series,
    clamp,
    dot,
    feature_dict,
    fit_logistic,
    fit_ridge,
    fit_standardizer,
    number,
    outcome_window,
    predict_linear,
    predict_logistic,
    sanitize_candles,
)


MACRO_FEATURE_NAMES = [
    "macroRatesImpulse",
    "macroInflationImpulse",
    "macroLaborImpulse",
    "macroGrowthImpulse",
    "macroVolatilityImpulse",
    "macroCreditImpulse",
    "macroYieldCurveImpulse",
    "macroFxImpulse",
    "macroCommodityImpulse",
    "macroDataCoverage",
]

EVENT_FEATURE_NAMES = [
    "eventSentiment",
    "eventRelevance",
    "eventNovelty",
    "announcementScore",
    "fundamentalQuality",
    "macroRisk",
    "sourceQuality",
    "freshnessScore",
    "positiveCatalyst",
    "negativeCatalyst",
    "dilutionRisk",
    "regulatoryRisk",
    "earningsEvent",
    "capitalAllocation",
    "operationalMomentum",
    "eventIntensity",
    "companyEventCoverage",
    "companyEventFreshness",
    *MACRO_FEATURE_NAMES,
]

EVENT_AGGREGATION_SCHEMA = "pit-event-aggregation-v8-date-cached-market-company-split"
FEATURE_MATRIX_SCHEMA = "market-feature-matrix-v17-orthogonal-price-flow-features"

CORE_TECHNICAL_FEATURE_NAMES = [
    "bias",
    "change1",
    "change3",
    "change5",
    "change10",
    "change20",
    "volumeRatio",
    "rsi",
    "macdHist",
    "smaGap",
    "volatility",
    "rangePosition",
    "gap",
    "bodyPosition",
    "closeLocation",
    "trueRange",
    "buyPressure5",
    "pressureChange",
    "volumeAccel",
    "volumeTrend",
    "profileDistance",
    "profileSkew",
    "profilePocDistance",
    "profileImbalance",
    "liquidityShock",
    "trendQuality",
    "reversalPressure",
]

COMPACT_TECHNICAL_FEATURE_NAMES = [
    "bias",
    "change5",
    "change20",
    "volumeRatio",
    "macdHist",
    "volatility",
    "rangePosition",
    "gap",
    "closeLocation",
    "trueRange",
    "buyPressure5",
    "volumeAccel",
    "profilePocDistance",
    "liquidityShock",
    "reversalPressure",
]

CROSS_SECTIONAL_FEATURE_NAMES = [
    "xsMomentum5Rank",
    "xsMomentum20Rank",
    "xsVolumeRatioRank",
    "xsLowVolatilityRank",
    "xsLiquidityRank",
    "xsTrendQualityRank",
    "xsPressureChangeRank",
    "xsVwapDistanceRank",
    "marketBreadth5",
]

COMPACT_CROSS_SECTIONAL_FEATURE_NAMES = [
    "xsMomentum5Rank",
    "xsMomentum20Rank",
    "xsVolumeRatioRank",
    "xsLowVolatilityRank",
    "xsLiquidityRank",
    "marketBreadth5",
]

FALSE_POSITIVE_FEATURE_NAMES = [
    "change5",
    "change20",
    "volumeRatio",
    "volatility",
    "gap",
    "closeLocation",
    "buyPressure5",
    "liquidityShock",
    "reversalPressure",
    "profilePocDistance",
    "xsMomentum5Rank",
    "xsMomentum20Rank",
    "xsLiquidityRank",
    "marketBreadth5",
    "eventSentiment",
    "macroRisk",
    *MACRO_FEATURE_NAMES,
    "positiveCatalyst",
    "negativeCatalyst",
    "dilutionRisk",
    "regulatoryRisk",
    "earningsEvent",
    "capitalAllocation",
    "operationalMomentum",
    "eventIntensity",
    "companyEventCoverage",
    "companyEventFreshness",
    # Append-only schema: existing persisted OOF vectors keep their original
    # column meaning while new diagnostics gain the richer price-flow context.
    "change1",
    "change3",
    "change10",
    "rsi",
    "smaGap",
    "bodyPosition",
    "pressureChange",
    "volumeTrend",
    "profileDistance",
    "profileSkew",
    "profileImbalance",
    "trendQuality",
    "xsTrendQualityRank",
    "xsPressureChangeRank",
    "xsVwapDistanceRank",
]

FEATURE_FAMILIES = {
    "momentum_trend": {"bias", "change1", "change3", "change5", "change10", "change20", "rsi", "macdHist", "smaGap", "trendQuality"},
    "volume_flow": {"volumeRatio", "buyPressure5", "pressureChange", "volumeAccel", "volumeTrend", "liquidityShock"},
    "volatility_risk": {"volatility", "trueRange", "gap", "bodyPosition", "rangePosition", "closeLocation", "reversalPressure"},
    "volume_profile": {"profileDistance", "profileSkew", "profilePocDistance", "profileImbalance"},
    "event_fundamental": set(EVENT_FEATURE_NAMES) - set(MACRO_FEATURE_NAMES) - {"macroRisk"},
    "macro_regime": {*MACRO_FEATURE_NAMES, "macroRisk"},
    "market_cross_section": set(CROSS_SECTIONAL_FEATURE_NAMES),
}


def _feature_names_for_row(row: dict[str, Any]) -> list[str]:
    explicit = list(row.get("featureNames") or [])
    if explicit:
        return explicit
    width = len(row.get("x") or [])
    technical_only = [*CORE_TECHNICAL_FEATURE_NAMES, *CROSS_SECTIONAL_FEATURE_NAMES]
    with_events = [*CORE_TECHNICAL_FEATURE_NAMES, *EVENT_FEATURE_NAMES, *CROSS_SECTIONAL_FEATURE_NAMES]
    if width == len(technical_only):
        return technical_only
    if width == len(with_events):
        return with_events
    return with_events[:width]


def _event_feature_vector(row: dict[str, Any]) -> list[float]:
    explicit = row.get("eventX")
    if isinstance(explicit, list) and len(explicit) == len(EVENT_FEATURE_NAMES):
        return [number(value) for value in explicit]
    names = _feature_names_for_row(row)
    values = list(row.get("x") or [])
    lookup = {name: number(values[index]) for index, name in enumerate(names) if index < len(values)}
    return [lookup.get(name, 0.0) for name in EVENT_FEATURE_NAMES]

MODEL_OUTPUT_KEYS = [
    "ridgePrediction",
    "elasticPrediction",
    "lightgbmPrediction",
    "rankerPrediction",
    "pathSafetyPrediction",
    "quantilePrediction",
    "eventPrediction",
]

DIRECTION_OUTPUT_KEYS = [
    "ridgeDirectionPrediction",
    "elasticDirectionPrediction",
    "treeDirectionPrediction",
    "returnDirectionPrediction",
    "regimeDirectionPrediction",
]

MARKET_DATA_TARGETS = {
    "US": {"symbols": 300, "matureSymbols": 800, "years": 8, "matureYears": 12, "rows": 600_000, "matureRows": 2_400_000},
    "ASX": {"symbols": 200, "matureSymbols": 400, "years": 10, "matureYears": 15, "rows": 500_000, "matureRows": 1_500_000},
    "CN": {"symbols": 500, "matureSymbols": 1500, "years": 8, "matureYears": 12, "rows": 1_000_000, "matureRows": 4_500_000},
}

PRODUCTION_THRESHOLDS = {
    "researchMinRows": 500,
    "productionMinRows": 50_000,
    "productionMinTestRows": 1_000,
    "productionMinTestDates": 120,
    "productionMinTargetEvents": 500,
    "productionMinStopEvents": 500,
    "productionMinFolds": 5,
    "productionPositiveFolds": 4,
    "maxEcePct": 5.0,
    "maxDegradedEcePct": 10.0,
    "minCalibrationSlope": 0.8,
    "maxCalibrationSlope": 1.2,
    "minBrierSkill": 0.0,
    "maxModelWeight": 0.35,
    "maxResidualCorrelation": 0.8,
    "minRankIc": 0.0,
    "minProbabilityBucketEvents": 30,
    "maxTopDecileDrawdownPct": 15.0,
}

MARKET_COST_BPS = {"US": 12.0, "ASX": 18.0, "CN": 20.0}
MARKET_TIME_ZONE = {"US": "America/New_York", "ASX": "Australia/Sydney", "CN": "Asia/Shanghai"}
MARKET_CLOSE = {"US": time(16, 0), "ASX": time(16, 10), "CN": time(15, 0)}


def stable_hash(value: Any, length: int = 16) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:length]


def _atomic_gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), default=str)
    temporary.replace(path)


def _read_gzip_json(path: Path) -> Any | None:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None


def _fold_checkpoint_context(
    rows: list[dict[str, Any]],
    folds: list[dict[str, Any]],
    *,
    market: str,
    horizon: int,
    config: dict[str, Any],
) -> dict[str, Any] | None:
    directory_text = str(config.get("checkpointDir") or config.get("artifactDir") or "").strip()
    if not directory_text:
        return None
    dates = sorted({str(row.get("date") or "") for row in rows if row.get("date")})
    symbols = sorted({str(row.get("symbol") or "") for row in rows if row.get("symbol")})
    dataset_content_hash = str(config.get("datasetContentHash") or "").strip()
    if dataset_content_hash:
        row_content_hash = dataset_content_hash
        row_hash_method = "immutable-feature-matrix-content-hash"
    else:
        row_digest = hashlib.sha256()
        for row in sorted(rows, key=lambda value: (str(value.get("date") or ""), str(value.get("symbol") or ""))):
            row_digest.update(json.dumps({
                "date": row.get("date"),
                "symbol": row.get("symbol"),
                "x": row.get("x"),
                "actualTarget": row.get("actualTarget"),
                "actualStop": row.get("actualStop"),
                "actualTimeout": row.get("actualTimeout"),
                "actualDirection": row.get("actualDirection"),
                "actualReturn": row.get("actualReturn"),
                "trainingWeight": row.get("trainingWeight"),
                "entrySource": row.get("entrySource"),
            }, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8"))
        row_content_hash = row_digest.hexdigest()
        row_hash_method = "full-row-content-hash"
    dependency_versions = {}
    for package in ("numpy", "scikit-learn", "catboost", "lightgbm"):
        try:
            dependency_versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            dependency_versions[package] = None
    training_source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    model_configuration = {
        "treeBackend": str(config.get("treeBackend") or os.getenv("PRODUCTION_TREE_BACKEND", "catboost")),
        "treeMaxRows": int(config.get("treeMaxRows", os.getenv("PRODUCTION_TREE_MAX_ROWS", "40000"))),
        "treeIterations": int(config.get("treeIterations", os.getenv("PRODUCTION_TREE_ITERATIONS", "72"))),
        "treeEarlyStoppingRounds": int(os.getenv("PRODUCTION_TREE_EARLY_STOPPING_ROUNDS", "12")),
        "treeThreads": int(config.get("treeThreads", os.getenv("PRODUCTION_TREE_THREADS", "2"))),
        "treeClassBalance": str(config.get("treeClassBalance") or os.getenv("PRODUCTION_TREE_CLASS_BALANCE", "SqrtBalanced")),
        "baselineMaxRows": int(config.get("baselineMaxRows", os.getenv("PRODUCTION_BASELINE_MAX_ROWS", "6000"))),
        "quantileMaxRows": int(config.get("quantileMaxRows", os.getenv("PRODUCTION_QUANTILE_MAX_ROWS", "6000"))),
        "maxModelWeight": number(config.get("maxModelWeight"), 0.35),
        "embargoDays": int(config.get("embargoDays", 7)),
        "foldCount": int(config.get("foldCount", 5)),
        "minTrainDates": int(config.get("minTrainDates", 500)),
        "testDates": int(config.get("testDates", 120)),
    }
    signature_payload = {
        "schema": "oof-fold-checkpoint-v7-matrix-code-config",
        "market": market,
        "horizon": horizon,
        "rows": len(rows),
        "dateRange": [dates[0] if dates else None, dates[-1] if dates else None],
        "dateCount": len(dates),
        "symbols": symbols,
        "folds": [
            {
                "index": fold.get("fold"),
                "trainStart": fold.get("trainStart"),
                "trainEnd": fold.get("trainEnd"),
                "testStart": fold.get("testStart"),
                "testEnd": fold.get("testEnd"),
                "trainRows": len(fold.get("train") or []),
                "testRows": len(fold.get("test") or []),
            }
            for fold in folds
        ],
        "treeModels": bool(config.get("enableTreeModels", False)),
        "sklearnModels": bool(config.get("enableSklearnModels", False)),
        "featureSchema": _feature_names_for_row(rows[0]) if rows else [],
        "rowContentHash": row_content_hash,
        "rowHashMethod": row_hash_method,
        "trainingSourceHash": training_source_hash,
        "dependencyVersions": dependency_versions,
        "modelConfiguration": model_configuration,
    }
    signature = stable_hash(signature_payload, 24)
    root = Path(directory_text).expanduser().resolve() / "checkpoints" / f"{market.lower()}-{horizon}d-{signature}"
    return {"root": root, "signature": signature, "payload": signature_payload}


def _load_fold_checkpoint(context: dict[str, Any] | None, fold_index: int) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    if not context:
        return None
    path = context["root"] / f"fold-{fold_index}.json.gz"
    saved = _read_gzip_json(path)
    if not isinstance(saved, dict) or saved.get("signature") != context.get("signature"):
        return None
    predictions = saved.get("predictions")
    metadata = saved.get("metadata")
    if not isinstance(predictions, list) or not isinstance(metadata, dict):
        return None
    return predictions, metadata


def _save_fold_checkpoint(
    context: dict[str, Any] | None,
    fold_index: int,
    predictions: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> None:
    if not context:
        return
    root = context["root"]
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "manifest.json.gz"
    if not manifest.exists():
        _atomic_gzip_json(manifest, {
            "signature": context.get("signature"),
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "definition": context.get("payload"),
        })
    _atomic_gzip_json(root / f"fold-{fold_index}.json.gz", {
        "signature": context.get("signature"),
        "fold": fold_index,
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "predictions": predictions,
        "metadata": metadata,
    })


def _dataset_cache_path(
    items: list[dict[str, Any]],
    *,
    market: str,
    horizon: int,
    target_upside: float,
    stop_loss: float,
    transaction_cost_bps: Any,
    config: dict[str, Any],
    market_point_in_time_features: list[dict[str, Any]] | None = None,
) -> Path | None:
    directory_text = str(config.get("checkpointDir") or config.get("artifactDir") or "").strip()
    if not directory_text:
        return None
    digest = hashlib.sha256()
    digest.update(f"{FEATURE_MATRIX_SCHEMA}|{EVENT_AGGREGATION_SCHEMA}|{market}|{horizon}|{target_upside}|{stop_loss}|{transaction_cost_bps}".encode("utf-8"))
    for item in sorted((row for row in items if isinstance(row, dict)), key=lambda row: str(row.get("symbol") or "")):
        # Provider labels can change when the same real rows are served from local cache.
        # Cache identity follows market data and PIT content, not the delivery route.
        digest.update(f"|{item.get('market')}|{item.get('symbol')}".encode("utf-8"))
        for candle in item.get("candles") or []:
            if isinstance(candle, dict):
                digest.update(
                    f"|{candle.get('date')}|{candle.get('open')}|{candle.get('high')}|{candle.get('low')}|{candle.get('close')}|{candle.get('volume')}".encode("utf-8")
                )
        for event in item.get("pointInTimeFeatures") or item.get("point_in_time_features") or item.get("events") or []:
            if isinstance(event, dict):
                digest.update(json.dumps(event, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))
        for collection in ("universeHistory", "corporateActions"):
            for event in item.get(collection) or []:
                if isinstance(event, dict):
                    digest.update(json.dumps(event, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))
        digest.update(f"|pit={item.get('pitDataVersion')}|adjustment={item.get('adjustment')}|adjusted={item.get('corporateActionAdjusted')}".encode("utf-8"))
    for event in market_point_in_time_features or []:
        if isinstance(event, dict):
            digest.update(json.dumps(event, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))
    return Path(directory_text).expanduser().resolve() / "datasets" / f"{market.lower()}-{horizon}d-{digest.hexdigest()[:20]}.json.gz"


def _load_dataset_cache(path: Path | None, *, market: str, horizon: int) -> dict[str, Any] | None:
    if path is None or not path.exists():
        return None
    payload = _read_gzip_json(path)
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != FEATURE_MATRIX_SCHEMA
        or payload.get("eventAggregationSchema") != EVENT_AGGREGATION_SCHEMA
    ):
        return None
    dataset = payload.get("dataset")
    if payload.get("market") != market or int(payload.get("horizon") or 0) != int(horizon):
        return None
    return dataset if isinstance(dataset, dict) and isinstance(dataset.get("rows"), list) else None


def _load_latest_eligible_dataset_cache(
    directory: Any,
    *,
    market: str,
    horizon: int,
    min_symbols: int,
    min_dates: int,
    require_pit_version: bool = False,
) -> tuple[dict[str, Any] | None, Path | None]:
    root = Path(str(directory or "")).expanduser().resolve() / "datasets"
    if not root.exists():
        return None, None
    candidates = sorted(
        root.glob(f"{market.lower()}-{horizon}d-*.json.gz"),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        dataset = _load_dataset_cache(candidate, market=market, horizon=horizon)
        summary = dataset.get("summary") if isinstance(dataset, dict) else {}
        pit_version = str((summary or {}).get("pitDataVersion") or "").strip()
        if require_pit_version and not pit_version:
            # A feature matrix created before the PIT lake was joined must not
            # be selected by a resume-only run. Reusing its completed folds is
            # fast, but would permanently hide newly available event evidence.
            continue
        if (
            dataset is not None
            and int((summary or {}).get("symbolCount") or 0) >= min_symbols
            and int((summary or {}).get("dateCount") or 0) >= min_dates
        ):
            return dataset, candidate
    return None, None


def _save_dataset_cache(path: Path | None, dataset: dict[str, Any], *, market: str, horizon: int) -> None:
    if path is None:
        return
    _atomic_gzip_json(path, {
        "schema": FEATURE_MATRIX_SCHEMA,
        "eventAggregationSchema": EVENT_AGGREGATION_SCHEMA,
        "market": market,
        "horizon": horizon,
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "dataset": dataset,
    })
    siblings = sorted(
        path.parent.glob(f"{market.lower()}-{horizon}d-*.json.gz"),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    for stale in siblings[3:]:
        if stale != path:
            stale.unlink(missing_ok=True)
    cutoff = datetime.now(timezone.utc).timestamp() - 60 * 60
    for temporary in path.parent.glob(f"{market.lower()}-{horizon}d-*.tmp"):
        if temporary.stat().st_mtime < cutoff:
            temporary.unlink(missing_ok=True)


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-clamp(value, -24.0, 24.0)))


def parse_timestamp(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if len(text) == 10:
        try:
            return datetime.combine(date.fromisoformat(text), time(23, 59, 59), timezone.utc)
        except ValueError:
            return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def market_close_timestamp(day: str, market: str) -> datetime | None:
    try:
        local_day = date.fromisoformat(str(day)[:10])
    except ValueError:
        return None
    key = str(market or "ASX").upper()
    return datetime.combine(local_day, MARKET_CLOSE.get(key, time(16, 0)), ZoneInfo(MARKET_TIME_ZONE.get(key, "UTC"))).astimezone(timezone.utc)


def _prepare_point_in_time_candidates(
    item: dict[str, Any],
    market_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    item_candidates = item.get("pointInTimeFeatures") or item.get("point_in_time_features") or item.get("events") or []
    candidates_prepared: list[tuple[datetime, str, dict[str, Any], str, int]] = []
    audit = {
        "unverifiedRowsExcluded": 0,
        "invalidTimestampRowsExcluded": 0,
        "temporalOrderViolations": 0,
        "duplicateEventRowsExcluded": 0,
    }
    candidate_sets = (
        (market_candidates or [], True),
        (item_candidates if isinstance(item_candidates, list) else [], False),
    )
    for candidates, market_wide in candidate_sets:
        for raw in candidates:
            if not isinstance(raw, dict):
                continue
            if raw.get("historicalAvailabilityVerified") is not True or raw.get("historicalAvailabilityUnverified") is True:
                audit["unverifiedRowsExcluded"] += 1
                continue
            available_at = parse_timestamp(raw.get("available_at", raw.get("availableAt", raw.get("publishedAt"))))
            event_at = parse_timestamp(raw.get("event_time", raw.get("eventTime", raw.get("publishedAt", raw.get("date")))))
            if available_at is None or event_at is None:
                audit["invalidTimestampRowsExcluded"] += 1
                continue
            if available_at < event_at:
                audit["temporalOrderViolations"] += 1
                continue
            effective_day = str(raw.get(
                "effective_date",
                raw.get("effectiveDate", raw.get("event_time", raw.get("eventTime", raw.get("date", "")))),
            ))[:10]
            values = raw.get("values") if isinstance(raw.get("values"), dict) else raw
            prepared_values = {
                **values,
                "__dataset": str(raw.get("dataset") or values.get("__dataset") or "news").lower(),
                "__source": str(raw.get("source") or values.get("__source") or "unknown"),
                "__marketWide": market_wide,
            }
            event_id = str(raw.get("id") or values.get("__eventId") or "").strip()
            priority = 2 if prepared_values["__dataset"] == "financial_disclosures" else 1
            candidates_prepared.append((available_at, effective_day, prepared_values, event_id, priority))
    selected_by_identity: dict[tuple[bool, str], tuple[datetime, str, dict[str, Any], str, int]] = {}
    anonymous: list[tuple[datetime, str, dict[str, Any], str, int]] = []
    for row in candidates_prepared:
        identity = row[3]
        if not identity:
            anonymous.append(row)
            continue
        key = (bool(row[2].get("__marketWide")), identity)
        previous = selected_by_identity.get(key)
        if previous is None or row[4] > previous[4]:
            if previous is not None:
                audit["duplicateEventRowsExcluded"] += 1
            selected_by_identity[key] = row
        else:
            audit["duplicateEventRowsExcluded"] += 1
    prepared = [(row[0], row[1], row[2]) for row in [*selected_by_identity.values(), *anonymous]]
    prepared.sort(key=lambda row: row[0])
    return {"rows": prepared, "audit": audit}


def _point_in_time_features_from_prepared(
    prepared_bundle: dict[str, Any] | list[tuple[datetime, str, dict[str, Any]]],
    signal_day: str,
    market: str,
) -> dict[str, Any]:
    if isinstance(prepared_bundle, dict):
        prepared = prepared_bundle.get("rows") or []
        audit = prepared_bundle.get("audit") or {}
    else:
        prepared = prepared_bundle
        audit = {}
    structural_violations = sum(int(audit.get(name) or 0) for name in (
        "unverifiedRowsExcluded", "invalidTimestampRowsExcluded", "temporalOrderViolations"
    ))
    signal_at = market_close_timestamp(signal_day, market)
    output = {name: 0.0 for name in EVENT_FEATURE_NAMES}
    if signal_at is None:
        return {
            "values": output,
            "signalAt": None,
            "latestAvailableAt": None,
            "sourceRows": 0,
            "futureRowsExcluded": len(prepared),
            "joinViolationCount": 0,
            "excludedViolationCount": structural_violations,
            **audit,
        }
    upper = bisect_right(prepared, signal_at, key=lambda row: row[0])
    excluded_future = len(prepared) - upper
    selected: list[tuple[datetime, dict[str, Any]]] = []
    dataset_counts: dict[str, int] = defaultdict(int)
    dataset_limits = {"news": 40, "social": 16, "fundamentals": 12, "financial_disclosures": 16, "macro": 24}
    max_age_days = {"news": 180.0, "social": 21.0, "fundamentals": 400.0, "financial_disclosures": 400.0, "macro": 120.0}
    macro_series_counts: dict[str, int] = defaultdict(int)
    cursor = upper - 1
    while cursor >= 0:
        available_at, effective_day, values = prepared[cursor]
        cursor -= 1
        if effective_day and effective_day > str(signal_day)[:10]:
            excluded_future += 1
            continue
        age_days = max(0.0, (signal_at - available_at).total_seconds() / 86400.0)
        if age_days > 400.0:
            break
        dataset = str(values.get("__dataset") or "news").lower()
        if age_days > max_age_days.get(dataset, 180.0):
            continue
        if dataset == "macro":
            series_id = str(values.get("__seriesId") or "UNKNOWN")
            if macro_series_counts[series_id] >= 2:
                continue
        if dataset_counts[dataset] >= dataset_limits.get(dataset, 24):
            continue
        selected.append((available_at, values))
        dataset_counts[dataset] += 1
        if dataset == "macro":
            macro_series_counts[str(values.get("__seriesId") or "UNKNOWN")] += 1
    selected.reverse()
    latest_at = max((row[0] for row in selected), default=None)
    weighted_sums = {name: 0.0 for name in EVENT_FEATURE_NAMES}
    weighted_denominators = {name: 0.0 for name in EVENT_FEATURE_NAMES}
    decayed_max = {name: 0.0 for name in EVENT_FEATURE_NAMES}
    saturating_products = {name: 1.0 for name in ("positiveCatalyst", "negativeCatalyst", "dilutionRisk", "regulatoryRisk")}
    signed_names = {
        "eventSentiment", "fundamentalQuality", "macroRisk", "capitalAllocation", "operationalMomentum",
        *[name for name in MACRO_FEATURE_NAMES if name != "macroDataCoverage"],
    }
    average_names = {"eventRelevance", "sourceQuality", "macroDataCoverage"}
    max_names = {"eventNovelty", "announcementScore", "earningsEvent"}
    intensity_sum = 0.0
    company_source_rows = 0
    market_source_rows = 0
    company_freshness = 0.0
    for available_at, values in selected:
        age_days = max(0.0, (signal_at - available_at).total_seconds() / 86400.0)
        dataset = str(values.get("__dataset") or "news").lower()
        half_life = 45.0 if dataset in {"fundamentals", "financial_disclosures"} else 30.0 if dataset == "macro" else 24.0 if dataset == "news" else 7.0
        decay = math.exp(-math.log(2.0) * age_days / half_life)
        relevance = clamp(number(values.get("eventRelevance"), 0.5), 0.05, 1.0)
        source_quality = clamp(number(values.get("sourceQuality"), 0.5), 0.20, 1.0)
        evidence_weight = decay * relevance * source_quality
        if values.get("__marketWide") is True:
            market_source_rows += 1
        else:
            company_source_rows += 1
            company_freshness = max(company_freshness, decay)
        for name in signed_names:
            value = clamp(number(values.get(name)), -1.0, 1.0)
            if abs(value) > 1e-12:
                weighted_sums[name] += value * evidence_weight
                weighted_denominators[name] += evidence_weight
        for name in average_names:
            if name == "macroDataCoverage" and dataset != "macro":
                continue
            value = clamp(number(values.get(name)), 0.0, 1.0)
            weighted_sums[name] += value * decay
            weighted_denominators[name] += decay
        for name in max_names:
            decayed_max[name] = max(decayed_max[name], clamp(number(values.get(name)), 0.0, 1.0) * decay)
        for name in saturating_products:
            contribution = clamp(number(values.get(name)), 0.0, 1.0) * evidence_weight
            saturating_products[name] *= 1.0 - clamp(contribution, 0.0, 0.95)
        intensity_sum += clamp(number(values.get("eventIntensity")), 0.0, 1.0) * evidence_weight
        output["freshnessScore"] = max(output["freshnessScore"], decay)
    for name in signed_names | average_names:
        if weighted_denominators[name] > 1e-12:
            output[name] = clamp(weighted_sums[name] / weighted_denominators[name], -1.0, 1.0)
    for name in max_names:
        output[name] = clamp(decayed_max[name], 0.0, 1.0)
    for name in saturating_products:
        output[name] = clamp(1.0 - saturating_products[name], 0.0, 1.0)
    output["eventIntensity"] = clamp(math.tanh(intensity_sum / 2.5), 0.0, 1.0)
    output["companyEventCoverage"] = 1.0 if company_source_rows else 0.0
    output["companyEventFreshness"] = clamp(company_freshness, 0.0, 1.0)
    return {
        "values": output,
        "signalAt": signal_at.isoformat() if signal_at else None,
        "latestAvailableAt": latest_at.isoformat() if latest_at else None,
        "sourceRows": len(selected),
        "companySourceRows": company_source_rows,
        "marketSourceRows": market_source_rows,
        "sourceRowsByDataset": dict(dataset_counts),
        "aggregationSchema": EVENT_AGGREGATION_SCHEMA,
        "futureRowsExcluded": excluded_future,
        "joinViolationCount": 0,
        "excludedViolationCount": structural_violations,
        **audit,
    }


def _combine_company_market_point_in_time(
    company: dict[str, Any],
    market: dict[str, Any],
) -> dict[str, Any]:
    values = {name: number((company.get("values") or {}).get(name)) for name in EVENT_FEATURE_NAMES}
    for name in ["macroRisk", *MACRO_FEATURE_NAMES]:
        values[name] = number((market.get("values") or {}).get(name))
    dataset_counts: dict[str, int] = defaultdict(int)
    for source in (company.get("sourceRowsByDataset") or {}, market.get("sourceRowsByDataset") or {}):
        for name, count in source.items():
            dataset_counts[str(name)] += int(count or 0)
    latest_values = [value for value in (company.get("latestAvailableAt"), market.get("latestAvailableAt")) if value]
    return {
        "values": values,
        "signalAt": company.get("signalAt") or market.get("signalAt"),
        "latestAvailableAt": max(latest_values) if latest_values else None,
        "sourceRows": int(company.get("sourceRows") or 0) + int(market.get("sourceRows") or 0),
        "companySourceRows": int(company.get("companySourceRows") or company.get("sourceRows") or 0),
        "marketSourceRows": int(market.get("marketSourceRows") or market.get("sourceRows") or 0),
        "sourceRowsByDataset": dict(dataset_counts),
        "aggregationSchema": EVENT_AGGREGATION_SCHEMA,
        "futureRowsExcluded": int(company.get("futureRowsExcluded") or 0) + int(market.get("futureRowsExcluded") or 0),
        "joinViolationCount": 0,
        "excludedViolationCount": int(company.get("excludedViolationCount") or 0) + int(market.get("excludedViolationCount") or 0),
    }


def point_in_time_features(
    item: dict[str, Any],
    signal_day: str,
    market: str,
    market_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return _point_in_time_features_from_prepared(
        _prepare_point_in_time_candidates(item, market_candidates),
        signal_day,
        market,
    )


def verified_pit_coverage(records: Any, signal_day: str, market: str) -> dict[str, Any]:
    signal_at = market_close_timestamp(signal_day, market)
    available = []
    excluded_future = 0
    for raw in records if isinstance(records, list) else []:
        if not isinstance(raw, dict) or raw.get("historicalAvailabilityVerified") is not True:
            continue
        if str(raw.get("eventType") or "").lower() == "coverage":
            coverage_start = str(raw.get("coverageStart") or "")[:10]
            coverage_end = str(raw.get("coverageEnd") or "")[:10]
            if coverage_start and coverage_end and coverage_start <= str(signal_day)[:10] <= coverage_end:
                available.append(raw)
            continue
        available_at = parse_timestamp(raw.get("available_at", raw.get("availableAt")))
        event_at = parse_timestamp(raw.get("event_time", raw.get("eventTime", raw.get("date"))))
        if available_at is None or event_at is None or signal_at is None:
            continue
        if available_at > signal_at or event_at > signal_at:
            excluded_future += 1
            continue
        available.append(raw)
    return {
        "covered": bool(available),
        "rows": len(available),
        "futureRowsExcluded": excluded_future,
        "latestAvailableAt": max((str(row.get("available_at") or "") for row in available), default=None),
    }


def _dataset_row_weight(quality_weight: float, label_confidence: float, liquidity_weight: float, recency_weight: float) -> tuple[float, float]:
    evaluation = clamp(quality_weight * liquidity_weight, 0.05, 1.0)
    training = clamp(evaluation * clamp(label_confidence, 0.2, 1.0) * recency_weight, 0.05, 1.35)
    return training, evaluation


def _rank_cross_section(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[(str(row["date"]), int(row["horizon"]))].append(row)
    for group in groups.values():
        ordered = sorted(group, key=lambda row: number(row.get("actualReturn")))
        denominator = max(1, len(ordered) - 1)
        for index, row in enumerate(ordered):
            rank = index / denominator if len(ordered) > 1 else 0.5
            row["returnRank"] = rank
            # Path class is the primary ranking target. The within-day return
            # percentile is only a tie-breaker, so a large but unstable move
            # cannot outrank a target-first or positive-expiry path merely by
            # magnitude. This ordering matches the production Top-K objective.
            target_first = number(row.get("actualTarget")) >= 0.5
            stop_first = number(row.get("actualStop")) >= 0.5
            positive_expiry = number(row.get("actualDirection")) >= 0.5
            path_grade = 3.0 if target_first else 0.0 if stop_first else 2.0 if positive_expiry else 1.0
            row["rankRelevance"] = path_grade * 3.0 + rank * 2.0
            row["crossSectionSize"] = len(ordered)
        breadth = sum(1 for row in group if number((row.get("feature") or {}).get("change5")) > 0) / max(1, len(group))

        def ranked(feature_name: str, *, reverse: bool = False) -> dict[int, float]:
            indexes = sorted(
                range(len(group)),
                key=lambda index: number((group[index].get("crossSectionRaw") or {}).get(feature_name)),
                reverse=reverse,
            )
            denominator = max(1, len(indexes) - 1)
            return {
                index: (rank / denominator if len(indexes) > 1 else 0.5) * 2.0 - 1.0
                for rank, index in enumerate(indexes)
            }

        feature_ranks = [
            ranked("change5"),
            ranked("change20"),
            ranked("volumeRatio"),
            ranked("volatility", reverse=True),
            ranked("dollarLiquidity"),
            ranked("trendQuality"),
            ranked("pressureChange"),
            ranked("profileDistance"),
        ]
        for index, row in enumerate(group):
            row["x"].extend([
                feature_ranks[0][index],
                feature_ranks[1][index],
                feature_ranks[2][index],
                feature_ranks[3][index],
                feature_ranks[4][index],
                feature_ranks[5][index],
                feature_ranks[6][index],
                feature_ranks[7][index],
                breadth * 2.0 - 1.0,
            ])


def build_market_dataset(
    items: list[dict[str, Any]],
    *,
    market: str,
    horizons: list[int],
    target_upside: float = 5.0,
    stop_loss: float = 4.0,
    transaction_cost_bps: float | None = None,
    market_point_in_time_features: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    key = str(market or "ASX").upper()
    costs = MARKET_COST_BPS.get(key, 18.0) if transaction_cost_bps is None else max(0.0, number(transaction_cost_bps))
    dataset: list[dict[str, Any]] = []
    source_rows = 0
    excluded_future_rows = 0
    join_violation_count = 0
    prepared_market_pit = _prepare_point_in_time_candidates({}, market_point_in_time_features)
    market_pit_by_day: dict[str, dict[str, Any]] = {}
    market_pit_audit = prepared_market_pit.get("audit") or {}
    excluded_violation_count = sum(int(market_pit_audit.get(name) or 0) for name in (
        "unverifiedRowsExcluded", "invalidTimestampRowsExcluded", "temporalOrderViolations"
    ))
    cross_market_rows_excluded = 0
    source_names: set[str] = set()
    def has_verified_features(candidates: Any) -> bool:
        if not isinstance(candidates, list):
            return False
        return any(
            isinstance(row, dict)
            and row.get("historicalAvailabilityVerified") is True
            and row.get("historicalAvailabilityUnverified") is not True
            for row in candidates
        )

    event_item_count = sum(
        1
        for item in items or []
        if isinstance(item, dict)
        and has_verified_features(item.get("pointInTimeFeatures") or item.get("point_in_time_features") or item.get("events") or [])
    )
    verified_market_features = has_verified_features(market_point_in_time_features or [])
    event_features_enabled = verified_market_features or event_item_count / max(1, len(items or [])) >= 0.60
    active_feature_names = [
        *CORE_TECHNICAL_FEATURE_NAMES,
        *(EVENT_FEATURE_NAMES if event_features_enabled else []),
        *CROSS_SECTIONAL_FEATURE_NAMES,
    ]
    for item in items or []:
        item_market = str(item.get("market") or "").upper()
        if item_market and item_market != key:
            cross_market_rows_excluded += 1
            continue
        symbol = str(item.get("symbol") or "").upper()
        candles = sanitize_candles(item.get("candles") or [])
        if not symbol or len(candles) < 70:
            continue
        source_names.add(str(item.get("source") or "unknown"))
        item_adjusted = item.get("corporateActionAdjusted") is True \
            or str(item.get("adjustment") or "").lower() == "split-dividend-adjusted" \
            or any(number(candle.get("adjClose")) > 0 for candle in item.get("candles") or [] if isinstance(candle, dict))
        quality = assess_candle_quality(candles)
        quality_rows = list(quality.get("rows") or [])
        volumes = sorted(max(0.0, number(row.get("volume"))) for row in candles if number(row.get("volume")) > 0)
        median_volume = median(volumes) if volumes else 1.0
        feature_series = build_feature_series(candles)
        prepared_item_pit = _prepare_point_in_time_candidates(item)
        item_pit_audit = prepared_item_pit.get("audit") or {}
        prepared_pit = prepared_item_pit
        prepared_audit = prepared_pit.get("audit") or {}
        excluded_violation_count += sum(int(prepared_audit.get(name) or 0) for name in (
            "unverifiedRowsExcluded", "invalidTimestampRowsExcluded", "temporalOrderViolations"
        ))
        feature_cache = {
            index: feature_dict(candles, index, feature_series)
            for index in range(55, max(55, len(candles) - 1))
        }
        for horizon in horizons:
            horizon = max(1, int(horizon))
            for index in range(55, len(candles) - horizon):
                feature = feature_cache.get(index)
                if not feature:
                    continue
                barriers = adaptive_barriers(candles, index, horizon, target_upside, stop_loss)
                outcome = outcome_window(
                    candles,
                    index,
                    horizon,
                    barriers["targetPct"],
                    barriers["stopPct"],
                    transaction_cost_bps=costs,
                )
                row_quality = quality_rows[index] if index < len(quality_rows) else {"sampleWeight": 1.0, "score": 100.0}
                label_quality = label_confidence_for_window(
                    candles,
                    quality_rows,
                    index,
                    horizon,
                    outcome,
                    barriers["targetPct"],
                    barriers["stopPct"],
                )
                signal_day = str(candles[index].get("date") or "")
                company_pit = _point_in_time_features_from_prepared(
                    prepared_pit,
                    signal_day,
                    key,
                )
                market_pit = market_pit_by_day.get(signal_day)
                if market_pit is None:
                    market_pit = _point_in_time_features_from_prepared(prepared_market_pit, signal_day, key)
                    market_pit_by_day[signal_day] = market_pit
                pit = _combine_company_market_point_in_time(company_pit, market_pit)
                universe_coverage = verified_pit_coverage(item.get("universeHistory"), str(candles[index].get("date") or ""), key)
                action_coverage = verified_pit_coverage(item.get("corporateActions"), str(candles[index].get("date") or ""), key)
                source_rows += int(pit["sourceRows"])
                excluded_future_rows += int(pit["futureRowsExcluded"])
                event_values = pit["values"]
                x = [number(feature.get(name)) for name in CORE_TECHNICAL_FEATURE_NAMES]
                if event_features_enabled:
                    x.extend(number(event_values.get(name)) for name in EVENT_FEATURE_NAMES)
                liquidity_weight = clamp(math.sqrt(max(0.0, number(candles[index].get("volume"))) / max(1.0, median_volume)), 0.25, 1.0)
                recency_weight = 0.85 + 0.15 * index / max(1, len(candles) - 1)
                training_weight, evaluation_weight = _dataset_row_weight(
                    number(row_quality.get("sampleWeight"), 1.0),
                    number(label_quality.get("labelConfidence"), 1.0),
                    liquidity_weight,
                    recency_weight,
                )
                timeout = not outcome.get("hitTarget") and not outcome.get("hitStop")
                ambiguous = bool(outcome.get("ambiguousBarrierOrder"))
                dataset.append({
                    "date": str(candles[index].get("date") or "")[:10],
                    "signalAt": pit["signalAt"],
                    "availableAt": pit["latestAvailableAt"],
                    "market": key,
                    "symbol": symbol,
                    "sector": str(item.get("sector") or "Unknown"),
                    "horizon": horizon,
                    "x": x,
                    "featureNames": active_feature_names,
                    "eventX": [number(event_values.get(name)) for name in EVENT_FEATURE_NAMES],
                    "feature": feature,
                    "regime": _regime_label(feature),
                    "entryDate": outcome.get("entryDate"),
                    "entryPrice": number(outcome.get("entryPrice")),
                    "entrySource": outcome.get("entrySource"),
                    "targetBarrierPct": number(barriers.get("targetPct")),
                    "stopBarrierPct": number(barriers.get("stopPct")),
                    "transactionCostBps": costs,
                    "actualTarget": 1.0 if outcome.get("targetWins") else 0.0,
                    "actualStop": 1.0 if outcome.get("stopWins") else 0.0,
                    "actualTimeout": 1.0 if timeout else 0.0,
                    "ambiguousBarrierOrder": ambiguous,
                    "actualReturn": number(outcome.get("forwardReturn")),
                    "actualDirection": 1.0 if number(outcome.get("forwardReturn")) > 0 else 0.0,
                    "actualGrossReturn": number(outcome.get("grossForwardReturn")),
                    "actualMaxUpside": number(outcome.get("maxUpside")),
                    "actualMaxDrawdown": number(outcome.get("maxDrawdown")),
                    "barrierClass": 3 if ambiguous else 0 if outcome.get("stopWins") else 2 if outcome.get("targetWins") else 1,
                    "trainingWeight": training_weight,
                    "evaluationWeight": evaluation_weight,
                    "sampleWeight": evaluation_weight,
                    "labelConfidence": number(label_quality.get("labelConfidence"), 1.0),
                    "dataQualityScore": number(row_quality.get("score"), 100.0),
                    "liquidityWeight": liquidity_weight,
                    "eventCoverage": 1.0 if int(pit.get("companySourceRows") or 0) > 0 else 0.0,
                    "marketEventCoverage": 1.0 if int(pit.get("marketSourceRows") or 0) > 0 else 0.0,
                    "companyEventSourceRows": int(pit.get("companySourceRows") or 0),
                    "historicalUniverseCoverage": 1.0 if universe_coverage["covered"] else 0.0,
                    "corporateActionCoverage": 1.0 if action_coverage["covered"] else 0.0,
                    "adjustedPriceCoverage": 1.0 if item_adjusted else 0.0,
                    "corporateActionAdjusted": bool(item_adjusted),
                    "pitDataVersion": item.get("pitDataVersion"),
                    "pitFutureRowsExcluded": pit["futureRowsExcluded"],
                    "pitJoinViolationCount": pit["joinViolationCount"],
                    "source": str(item.get("source") or "unknown"),
                    "crossSectionRaw": {
                        "change5": number(feature.get("change5")),
                        "change20": number(feature.get("change20")),
                        "volumeRatio": number(feature.get("volumeRatio")),
                        "volatility": number(feature.get("volatility")),
                        "dollarLiquidity": math.log1p(max(0.0, number(candles[index].get("close"))) * max(0.0, number(candles[index].get("volume")))),
                        "trendQuality": number(feature.get("trendQuality")),
                        "pressureChange": number(feature.get("pressureChange")),
                        "profileDistance": number(feature.get("profileDistance")),
                    },
                })
    unique_dataset: list[dict[str, Any]] = []
    seen_dataset_rows: set[tuple[str, str, str, int]] = set()
    duplicate_rows_excluded = 0
    for row in dataset:
        identity = (str(row["market"]), str(row["symbol"]), str(row["date"]), int(row["horizon"]))
        if identity in seen_dataset_rows:
            duplicate_rows_excluded += 1
            continue
        seen_dataset_rows.add(identity)
        unique_dataset.append(row)
    dataset = unique_dataset
    _rank_cross_section(dataset)
    by_horizon: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in dataset:
        by_horizon[int(row["horizon"])].append(row)
    for rows in by_horizon.values():
        target_rate = sum(number(row["actualTarget"]) for row in rows) / max(1, len(rows))
        stop_rate = sum(number(row["actualStop"]) for row in rows) / max(1, len(rows))
        for row in rows:
            class_weight = 1.0
            if row["actualTarget"] and target_rate > 0:
                class_weight = min(2.0, 0.5 / target_rate)
            elif row["actualStop"] and stop_rate > 0:
                class_weight = min(2.0, 0.5 / stop_rate)
            row["trainingWeight"] = clamp(number(row["trainingWeight"]) * class_weight, 0.05, 1.5)
        # A date with more listed symbols must not count as a larger number of
        # independent market regimes. Keep all cross-sectional rows, but give
        # every trading date approximately the same aggregate training mass.
        date_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            date_rows[str(row.get("date") or "")].append(row)
        date_totals = [
            sum(number(row.get("trainingWeight"), 1.0) for row in values)
            for values in date_rows.values()
            if values
        ]
        target_date_mass = median(date_totals) if date_totals else 1.0
        for values in date_rows.values():
            current_mass = sum(number(row.get("trainingWeight"), 1.0) for row in values) or 1.0
            date_scale = clamp(target_date_mass / current_mass, 0.25, 4.0)
            for row in values:
                row["trainingWeight"] = clamp(number(row["trainingWeight"]) * date_scale, 0.02, 2.0)
                row["dateBalanceScale"] = date_scale
    summary = dataset_profile(
        dataset,
        market=key,
        item_count=len(items or []),
        source_names=sorted(source_names),
        source_rows=source_rows,
        excluded_future_rows=excluded_future_rows,
        join_violation_count=join_violation_count,
        excluded_violation_count=excluded_violation_count,
        historical_universe_rows=sum(number(row.get("historicalUniverseCoverage")) for row in dataset),
        corporate_action_rows=sum(number(row.get("corporateActionCoverage")) for row in dataset),
        action_adjusted_rows=sum(number(row.get("adjustedPriceCoverage")) for row in dataset),
        duplicate_rows_excluded=duplicate_rows_excluded,
        cross_market_rows_excluded=cross_market_rows_excluded,
    )
    summary["activeFeatureNames"] = active_feature_names
    summary["activeFeatureCount"] = len(active_feature_names)
    summary["eventFeaturesEnabled"] = event_features_enabled
    summary["eventItemCoveragePct"] = round(
        event_item_count / max(1, len(items or [])) * 100.0,
        3,
    )
    summary["marketPointInTimeFeaturesAvailable"] = verified_market_features
    summary["eventFeatureActivationReason"] = (
        "verified-market-and-company-pit" if verified_market_features and event_item_count
        else "verified-market-pit" if verified_market_features
        else "verified-company-pit" if event_item_count
        else "insufficient-verified-pit"
    )
    summary["rankingLabel"] = {
        "schema": "daily-net-return-decile-plus-target-stop-v3",
        "formula": "return_decile + 2*target_first + positive_expiry - 2*stop_first",
        "range": [0, 12],
        "pointInTimeSafe": True,
        "note": "This is a future outcome label used only during training; it is never included in the prediction feature vector.",
    }
    pit_versions = sorted({
        str(item.get("pitDataVersion") or "").strip()
        for item in items or []
        if isinstance(item, dict) and str(item.get("pitDataVersion") or "").strip()
    })
    summary["pitDataVersion"] = stable_hash(pit_versions, 24) if pit_versions else None
    summary["pitDataVersionCount"] = len(pit_versions)
    summary["trainingDateBalance"] = {
        "enabled": True,
        "method": "equal-aggregate-weight-per-market-date",
        "reason": "Overlapping cross-sectional rows remain usable without pretending that dates with more symbols are more independent.",
    }
    technical_count = len(CORE_TECHNICAL_FEATURE_NAMES) + len(CROSS_SECTIONAL_FEATURE_NAMES)
    summary["featurePolicy"] = (
        f"Core {technical_count} normalized technical/cross-sectional features plus verified point-in-time event features."
        if event_features_enabled
        else f"Core {technical_count} normalized technical/cross-sectional features; event features withheld because verified point-in-time coverage is insufficient."
    )
    # These fields have already been reduced into the immutable summary or the
    # final feature vector. Dropping them prevents each cached row from
    # repeating another full technical dictionary and PIT audit payload.
    compact_only_fields = {
        "feature",
        "featureNames",
        "eventX",
        "crossSectionRaw",
        "sampleWeight",
        "pitFutureRowsExcluded",
        "pitJoinViolationCount",
        "corporateActionAdjusted",
        "pitDataVersion",
        "historicalUniverseCoverage",
        "corporateActionCoverage",
        "adjustedPriceCoverage",
        "companyEventSourceRows",
        "marketEventCoverage",
        "crossSectionSize",
        "dateBalanceScale",
    }
    for row in dataset:
        for name in compact_only_fields:
            row.pop(name, None)
    return {"rows": dataset, "summary": summary}


def _regime_label(feature: dict[str, Any]) -> str:
    volatility = number(feature.get("volatility"))
    trend = number(feature.get("trendScore"), 50.0)
    if volatility >= 1.55:
        return "high_volatility"
    if trend >= 60:
        return "trend_up"
    if trend <= 40:
        return "risk_off"
    return "range"


def effective_weighted_rows(rows: list[dict[str, Any]]) -> float:
    weights = [max(0.0, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(weights)
    squared = sum(weight * weight for weight in weights)
    return total * total / squared if squared > 1e-12 else 0.0


def dataset_profile(
    rows: list[dict[str, Any]],
    *,
    market: str,
    item_count: int,
    source_names: list[str],
    source_rows: int,
    excluded_future_rows: int,
    join_violation_count: int,
    excluded_violation_count: int = 0,
    historical_universe_rows: int,
    corporate_action_rows: int,
    action_adjusted_rows: int,
    duplicate_rows_excluded: int = 0,
    cross_market_rows_excluded: int = 0,
) -> dict[str, Any]:
    dates = sorted({str(row.get("date")) for row in rows if row.get("date")})
    symbols = sorted({str(row.get("symbol")) for row in rows if row.get("symbol")})
    horizons = sorted({int(row.get("horizon") or 0) for row in rows if row.get("horizon")})
    target_events = sum(1 for row in rows if number(row.get("actualTarget")) >= 0.5)
    stop_events = sum(1 for row in rows if number(row.get("actualStop")) >= 0.5)
    independent = {
        str(horizon): math.ceil(len({row["date"] for row in rows if int(row["horizon"]) == horizon}) / max(1, horizon))
        for horizon in horizons
    }
    target = MARKET_DATA_TARGETS.get(market, MARKET_DATA_TARGETS["ASX"])
    return {
        "rawRows": len(rows),
        "effectiveWeightedRows": round(effective_weighted_rows(rows), 3),
        "independentDateBlocks": independent,
        "positiveEventCount": target_events,
        "stopEventCount": stop_events,
        "symbolCount": len(symbols),
        "sourceItemCount": item_count,
        "dateCount": len(dates),
        "dateRange": {"start": dates[0] if dates else None, "end": dates[-1] if dates else None},
        "horizons": horizons,
        "pointInTimeFeatureRows": source_rows,
        "pointInTimeCoveragePct": round(sum(number(row.get("eventCoverage")) for row in rows) / max(1, len(rows)) * 100.0, 4),
        "futureFeatureRowsExcluded": excluded_future_rows,
        "pointInTimeJoinViolationCount": join_violation_count,
        "pointInTimeExcludedViolationCount": excluded_violation_count,
        "historicalUniverseCoveragePct": round(historical_universe_rows / max(1, len(rows)) * 100.0, 3),
        "corporateActionCoveragePct": round(corporate_action_rows / max(1, len(rows)) * 100.0, 3),
        "adjustedPriceCoveragePct": round(action_adjusted_rows / max(1, len(rows)) * 100.0, 3),
        "coverageDenominator": "date-symbol training rows",
        "duplicateRowsExcluded": int(duplicate_rows_excluded),
        "crossMarketRowsExcluded": int(cross_market_rows_excluded),
        "sources": source_names,
        "firstStageTarget": target,
        "coverageVsTargetPct": round(min(100.0, len(rows) / max(1, target["rows"]) * 100.0), 4),
        "sampleMeaning": {
            "rawRows": "overlapping date×symbol rows used for fitting",
            "effectiveWeightedRows": "Kish effective sample size after evaluation-quality weights",
            "independentDateBlocks": "non-overlapping horizon blocks; a stricter view of temporal independence",
            "positiveEventCount": "target-before-stop events",
        },
    }


def purged_walk_forward_folds(
    rows: list[dict[str, Any]],
    *,
    horizon: int,
    fold_count: int = 5,
    embargo_days: int = 7,
    min_train_dates: int = 500,
    test_dates: int = 120,
) -> list[dict[str, Any]]:
    dates = sorted({str(row.get("date")) for row in rows if row.get("date")})
    if len(dates) < 60:
        return []
    purge = max(1, int(horizon)) + max(0, int(embargo_days))
    adaptive_train = min(max(40, int(len(dates) * 0.45)), max(40, min_train_dates))
    available = len(dates) - adaptive_train - purge
    if available < 12:
        return []
    folds_requested = max(2, min(int(fold_count), max(2, available // 10)))
    block = min(max(10, available // folds_requested), max(10, int(test_dates)))
    start = max(adaptive_train + purge, len(dates) - block * folds_requested)
    folds: list[dict[str, Any]] = []
    for fold_index in range(folds_requested):
        test_start = start + fold_index * block
        if test_start >= len(dates):
            break
        test_end = min(len(dates), test_start + block)
        train_end = test_start - purge
        if train_end < 40:
            continue
        train_dates = set(dates[:train_end])
        evaluation_dates = set(dates[test_start:test_end])
        train_rows = [row for row in rows if row.get("date") in train_dates]
        evaluation_rows = [row for row in rows if row.get("date") in evaluation_dates]
        if not train_rows or not evaluation_rows:
            continue
        folds.append({
            "fold": len(folds) + 1,
            "train": train_rows,
            "test": evaluation_rows,
            "trainStart": dates[0],
            "trainEnd": dates[train_end - 1],
            "testStart": dates[test_start],
            "testEnd": dates[test_end - 1],
            "purgeDays": int(horizon),
            "embargoDays": int(embargo_days),
            "trainDates": len(train_dates),
            "testDates": len(evaluation_dates),
        })
    return folds


def fit_quantile_linear(rows: list[dict[str, Any]], alpha: float, *, epochs: int = 65, penalty: float = 0.08) -> dict[str, Any]:
    if not rows:
        return {"weights": [], "intercept": 0.0, "centers": [], "scales": []}
    centers, scales = fit_standardizer(rows)
    matrix = [apply_standardizer(row["x"], centers, scales) for row in rows]
    targets = [number(row.get("actualReturn")) for row in rows]
    weights = [0.0 for _ in matrix[0]]
    intercept = median(targets) if targets else 0.0
    row_weights = [max(0.05, number(row.get("trainingWeight"), 1.0)) for row in rows]
    total = sum(row_weights) or 1.0
    step = 0.025 / math.sqrt(max(1, len(weights)))
    for _ in range(max(10, epochs)):
        grad_w = [2.0 * penalty * value for value in weights]
        grad_b = 0.0
        for row_index, x_row in enumerate(matrix):
            residual = targets[row_index] - (intercept + dot(weights, x_row))
            pinball = alpha if residual >= 0 else alpha - 1.0
            importance = row_weights[row_index] / total
            grad_b -= pinball * importance
            for index, value in enumerate(x_row):
                grad_w[index] -= pinball * value * importance
        intercept -= step * grad_b
        weights = [value - step * grad_w[index] for index, value in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def predict_quantile(model: dict[str, Any], rows: list[dict[str, Any]]) -> list[float]:
    matrix = [apply_standardizer(row["x"], model["centers"], model["scales"]) for row in rows]
    return [number(model["intercept"]) + dot(model["weights"], row) for row in matrix]


def _percentile_by_date(rows: list[dict[str, Any]], scores: list[float]) -> list[float]:
    output = [0.5 for _ in rows]
    groups: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        groups[str(row.get("date"))].append(index)
    for indexes in groups.values():
        ordered = sorted(indexes, key=lambda index: scores[index])
        denominator = max(1, len(ordered) - 1)
        for rank, index in enumerate(ordered):
            output[index] = rank / denominator if len(ordered) > 1 else 0.5
    return output


def model_library_status() -> dict[str, Any]:
    return {
        "catboost": importlib.util.find_spec("catboost") is not None,
        "lightgbm": importlib.util.find_spec("lightgbm") is not None,
        "sklearn": importlib.util.find_spec("sklearn") is not None,
        "deepModelsEnabled": False,
        "deepModelPolicy": "TCN/LSTM/Transformer remain challenger-only until at least 250k sequences and 250 untouched test dates consistently beat tree models.",
    }


def _sklearn_baseline_predictions(
    train: list[dict[str, Any]],
    test: list[dict[str, Any]],
    *,
    enabled: bool = False,
    max_rows: int = 50_000,
) -> dict[str, Any] | None:
    if not enabled or not model_library_status()["sklearn"]:
        return None
    try:
        import numpy as np  # type: ignore
        from sklearn.linear_model import BayesianRidge, LogisticRegression, Ridge, SGDClassifier  # type: ignore
        from sklearn.preprocessing import StandardScaler  # type: ignore

        model_train = _evenly_spaced_rows(train, max(2_000, int(max_rows)))
        x_train = np.asarray([row["x"] for row in model_train], dtype=float)
        x_test = np.asarray([row["x"] for row in test], dtype=float)
        sample_weight = np.asarray([number(row.get("trainingWeight"), 1.0) for row in model_train], dtype=float)
        scaler = StandardScaler()
        scaled_train = scaler.fit_transform(x_train)
        scaled_test = scaler.transform(x_test)

        ridge_return = Ridge(alpha=2.0, random_state=13)
        ridge_return.fit(scaled_train, [row["actualReturn"] for row in model_train], sample_weight=sample_weight)
        bayesian_return = BayesianRidge(alpha_1=1e-6, alpha_2=1e-6, lambda_1=1e-6, lambda_2=1e-6)
        try:
            bayesian_return.fit(scaled_train, [row["actualReturn"] for row in model_train], sample_weight=sample_weight)
        except TypeError:
            bayesian_return.fit(scaled_train, [row["actualReturn"] for row in model_train])
        ridge_rank = Ridge(alpha=2.6, random_state=17)
        ridge_rank.fit(scaled_train, [row["returnRank"] for row in model_train], sample_weight=sample_weight)

        path_labels = np.asarray([
            2 if number(row.get("actualTarget")) >= 0.5
            else 0 if number(row.get("actualStop")) >= 0.5
            else 1
            for row in model_train
        ], dtype=int)
        path_model = (
            SGDClassifier(
                loss="log_loss",
                penalty="l2",
                alpha=0.00065,
                max_iter=700,
                tol=2e-4,
                random_state=29,
                average=True,
                class_weight="balanced",
            )
            if len(model_train) >= 25_000
            else LogisticRegression(
                C=0.55,
                solver="lbfgs",
                max_iter=260,
                random_state=29,
                class_weight="balanced",
            )
        )
        path_model.fit(scaled_train, path_labels, sample_weight=sample_weight)
        path_matrix = path_model.predict_proba(scaled_test)
        path_classes = {int(label): index for index, label in enumerate(path_model.classes_)}

        def path_probability(label: int) -> list[float]:
            position = path_classes.get(label)
            if position is None:
                return [0.0 for _ in test]
            return [number(row[position]) for row in path_matrix]

        def binary_predictions(target_key: str, *, elastic: bool = False) -> list[float]:
            target = np.asarray([1 if number(row[target_key]) >= 0.5 else 0 for row in model_train], dtype=int)
            if len(np.unique(target)) < 2:
                return [float(target[0]) if len(target) else 0.5 for _ in test]
            if elastic:
                model = SGDClassifier(
                    loss="log_loss",
                    penalty="elasticnet",
                    alpha=0.0008,
                    l1_ratio=0.22,
                    max_iter=700,
                    tol=2e-4,
                    random_state=23,
                    average=True,
                )
            else:
                model = LogisticRegression(C=0.75, solver="lbfgs", max_iter=400, random_state=19)
            model.fit(scaled_train, target, sample_weight=sample_weight)
            return [number(value) for value in model.predict_proba(scaled_test)[:, 1]]

        return {
            "family": "sklearn-bayesian-ridge-multinomial-logistic",
            "baselineReturn": [number(value) for value in bayesian_return.predict(scaled_test)],
            "ridgeReturn": [number(value) for value in ridge_return.predict(scaled_test)],
            "direction": binary_predictions("actualDirection"),
            "elasticDirection": binary_predictions("actualDirection", elastic=True),
            "target": path_probability(2),
            "elasticTarget": binary_predictions("actualTarget", elastic=True),
            "stop": path_probability(0),
            "timeout": path_probability(1),
            "rank": [number(value) for value in ridge_rank.predict(scaled_test)],
            "pathModel": "multinomial-logistic-joint-target-stop-timeout",
            "trainingRows": len(model_train),
        }
    except Exception:
        return None


def _fallback_baseline_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]], *, max_rows: int | None = None) -> dict[str, Any]:
    baseline_max_rows = max(2_000, min(50_000, int(max_rows or os.getenv("PRODUCTION_BASELINE_MAX_ROWS", "6000"))))
    bounded_train = _evenly_spaced_rows(train, baseline_max_rows)
    ridge_return = fit_ridge(bounded_train, "actualReturn", 0.12, epochs=32)
    ridge_target = fit_logistic(bounded_train, "actualTarget", 0.12, epochs=32)
    elastic_target = fit_logistic(bounded_train, "actualTarget", 0.2, epochs=32)
    ridge_stop = fit_logistic(bounded_train, "actualStop", 0.12, epochs=32)
    ridge_timeout = fit_logistic(bounded_train, "actualTimeout", 0.12, epochs=32)
    ridge_rank = fit_ridge(bounded_train, "returnRank", 0.14, epochs=32)
    ridge_direction = fit_logistic(bounded_train, "actualDirection", 0.12, epochs=32)
    elastic_direction = fit_logistic(bounded_train, "actualDirection", 0.2, epochs=32)
    return {
        "family": "python-logistic-ridge-fallback",
        "baselineReturn": [predict_linear(ridge_return, row["x"]) for row in test],
        "direction": [predict_logistic(ridge_direction, row["x"]) for row in test],
        "elasticDirection": [predict_logistic(elastic_direction, row["x"]) for row in test],
        "target": [predict_logistic(ridge_target, row["x"]) for row in test],
        "elasticTarget": [predict_logistic(elastic_target, row["x"]) for row in test],
        "stop": [predict_logistic(ridge_stop, row["x"]) for row in test],
        "timeout": [predict_logistic(ridge_timeout, row["x"]) for row in test],
        "rank": [predict_linear(ridge_rank, row["x"]) for row in test],
        "trainingRows": len(bounded_train),
        "fullTrainingRows": len(train),
    }


def _tree_fold_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]], *, enabled: bool, config: dict[str, Any] | None = None) -> dict[str, Any] | None:
    config = config or {}
    status = model_library_status()
    preferred_backend = str(config.get("treeBackend") or os.getenv("PRODUCTION_TREE_BACKEND", "catboost")).strip().lower()
    tree_max_rows = max(20_000, int(config.get("treeMaxRows", os.getenv("PRODUCTION_TREE_MAX_ROWS", "40000"))))
    tree_iterations = max(40, min(200, int(config.get("treeIterations", os.getenv("PRODUCTION_TREE_ITERATIONS", "72")))))
    early_stopping_rounds = max(8, min(30, int(os.getenv("PRODUCTION_TREE_EARLY_STOPPING_ROUNDS", "12"))))
    tree_threads = max(1, min(4, int(config.get("treeThreads", os.getenv("PRODUCTION_TREE_THREADS", "2")))))
    requested_class_balance = str(
        config.get("treeClassBalance") or os.getenv("PRODUCTION_TREE_CLASS_BALANCE", "SqrtBalanced")
    ).strip()
    tree_class_balance = requested_class_balance if requested_class_balance in {"Balanced", "SqrtBalanced"} else None
    full_train = train
    train_dates = sorted({str(row.get("date")) for row in full_train})
    cross_sections = defaultdict(set)
    for row in full_train:
        cross_sections[str(row.get("date"))].add(str(row.get("symbol")))
    median_cross_section = median([len(symbols) for symbols in cross_sections.values()]) if cross_sections else 0
    if not enabled or len(full_train) < 5_000 or len(train_dates) < 250 or median_cross_section < 30:
        return None
    if preferred_backend == "lightgbm" and status["lightgbm"]:
        preferred = _lightgbm_fold_predictions(full_train, test, config=config)
        if preferred and not preferred.get("error"):
            preferred["preferredBackend"] = True
            return preferred
    train = _evenly_spaced_rows(full_train, tree_max_rows)
    x_train = [row["x"] for row in train]
    x_test = [row["x"] for row in test]
    sample_weight = [number(row.get("trainingWeight"), 1.0) for row in train]
    try:
        if status["catboost"]:
            from catboost import CatBoostClassifier, CatBoostRanker, CatBoostRegressor, Pool  # type: ignore

            validation_date_count = max(20, min(60, int(len(train_dates) * 0.15)))
            validation_dates = set(train_dates[-validation_date_count:])
            fit_indexes = [
                index for index, row in enumerate(train)
                if str(row.get("date")) not in validation_dates and not row.get("ambiguousBarrierOrder")
            ]
            validation_indexes = [
                index for index, row in enumerate(train)
                if str(row.get("date")) in validation_dates and not row.get("ambiguousBarrierOrder")
            ]
            if len(fit_indexes) < 2_000 or len(validation_indexes) < 300:
                return None
            path = CatBoostClassifier(
                iterations=tree_iterations,
                depth=4,
                learning_rate=0.04,
                loss_function="MultiClass",
                l2_leaf_reg=8.0,
                random_strength=0.35,
                bootstrap_type="Bernoulli",
                subsample=0.80,
                od_type="Iter",
                od_wait=early_stopping_rounds,
                verbose=False,
                random_seed=17,
                thread_count=tree_threads,
                auto_class_weights=tree_class_balance,
            )
            path.fit(
                [x_train[index] for index in fit_indexes],
                [train[index]["barrierClass"] for index in fit_indexes],
                sample_weight=[sample_weight[index] for index in fit_indexes],
                eval_set=(
                    [x_train[index] for index in validation_indexes],
                    [train[index]["barrierClass"] for index in validation_indexes],
                ),
                use_best_model=True,
            )
            direction_labels = [int(train[index]["actualDirection"]) for index in fit_indexes]
            direction_classes = sorted(set(direction_labels))
            direction = None
            direction_predictions = [float(direction_classes[0])] * len(test) if direction_classes else [0.5] * len(test)
            direction_importance: list[float] = []
            if len(direction_classes) >= 2:
                direction = CatBoostClassifier(
                    iterations=tree_iterations,
                    depth=4,
                    learning_rate=0.04,
                    loss_function="Logloss",
                    eval_metric="BrierScore",
                    l2_leaf_reg=10.0,
                    random_strength=0.35,
                    bootstrap_type="Bernoulli",
                    subsample=0.80,
                    od_type="Iter",
                    od_wait=early_stopping_rounds,
                    verbose=False,
                    random_seed=31,
                    thread_count=tree_threads,
                    auto_class_weights=tree_class_balance,
                )
                direction.fit(
                    [x_train[index] for index in fit_indexes],
                    direction_labels,
                    sample_weight=[sample_weight[index] for index in fit_indexes],
                    eval_set=(
                        [x_train[index] for index in validation_indexes],
                        [train[index]["actualDirection"] for index in validation_indexes],
                    ),
                    use_best_model=True,
                )
                direction_matrix = direction.predict_proba(x_test)
                direction_class_map = {
                    int(label): index
                    for index, label in enumerate(getattr(direction, "classes_", direction_classes))
                }
                positive_position = direction_class_map.get(1)
                direction_predictions = (
                    [number(row[positive_position]) for row in direction_matrix]
                    if positive_position is not None
                    else [0.0] * len(test)
                )
                direction_importance = [number(value) for value in direction.get_feature_importance()]
            rank_scores = None
            if median_cross_section >= 30:
                rank_fit_indexes = sorted(fit_indexes, key=lambda index: (str(train[index].get("date")), str(train[index].get("symbol"))))
                rank_validation_indexes = sorted(validation_indexes, key=lambda index: (str(train[index].get("date")), str(train[index].get("symbol"))))
                rank_train_pool = Pool(
                    [x_train[index] for index in rank_fit_indexes],
                    label=[train[index]["rankRelevance"] for index in rank_fit_indexes],
                    group_id=[str(train[index].get("date")) for index in rank_fit_indexes],
                    weight=[sample_weight[index] for index in rank_fit_indexes],
                )
                rank_validation_pool = Pool(
                    [x_train[index] for index in rank_validation_indexes],
                    label=[train[index]["rankRelevance"] for index in rank_validation_indexes],
                    group_id=[str(train[index].get("date")) for index in rank_validation_indexes],
                    weight=[sample_weight[index] for index in rank_validation_indexes],
                )
                ranker = CatBoostRanker(
                    iterations=tree_iterations,
                    depth=4,
                    learning_rate=0.04,
                    loss_function="YetiRank",
                    eval_metric="NDCG",
                    l2_leaf_reg=10.0,
                    random_strength=0.30,
                    bootstrap_type="Bernoulli",
                    subsample=0.80,
                    od_type="Iter",
                    od_wait=early_stopping_rounds,
                    verbose=False,
                    random_seed=41,
                    thread_count=tree_threads,
                )
                ranker.fit(rank_train_pool, eval_set=rank_validation_pool, use_best_model=True)
                rank_scores = [number(value) for value in ranker.predict(x_test)]
            path_matrix = path.predict_proba(x_test)
            path_classes = {
                int(label): index
                for index, label in enumerate(getattr(path, "classes_", [0, 1, 2]))
            }

            def path_probability(label: int) -> list[float]:
                position = path_classes.get(label)
                if position is None:
                    return [0.0 for _ in test]
                return [number(row[position]) for row in path_matrix]

            quantiles = []
            for alpha in (0.1, 0.5, 0.9):
                model = CatBoostRegressor(
                    iterations=tree_iterations,
                    depth=4,
                    learning_rate=0.04,
                    loss_function=f"Quantile:alpha={alpha}",
                    l2_leaf_reg=8.0,
                    random_strength=0.35,
                    bootstrap_type="Bernoulli",
                    subsample=0.80,
                    od_type="Iter",
                    od_wait=early_stopping_rounds,
                    verbose=False,
                    random_seed=29,
                    thread_count=tree_threads,
                )
                model.fit(
                    [x_train[index] for index in fit_indexes],
                    [train[index]["actualReturn"] for index in fit_indexes],
                    sample_weight=[sample_weight[index] for index in fit_indexes],
                    eval_set=(
                        [x_train[index] for index in validation_indexes],
                        [train[index]["actualReturn"] for index in validation_indexes],
                    ),
                    use_best_model=True,
                )
                quantiles.append([number(value) for value in model.predict(x_test)])
            return {
                "family": "catboost-shallow-joint-path-quantile",
                "target": path_probability(2),
                "stop": path_probability(0),
                "timeout": path_probability(1),
                "rank": rank_scores,
                "quantiles": quantiles,
                "challengerTarget": path_probability(2),
                "direction": direction_predictions,
                "directionFeatureImportance": direction_importance,
                "trainingPolicy": {
                    "depth": 4,
                    "earlyStoppingRounds": early_stopping_rounds,
                    "iterations": tree_iterations,
                    "maxRows": tree_max_rows,
                    "validationDates": validation_date_count,
                    "fullTrainingRows": len(full_train),
                    "sampledTrainingRows": len(train),
                    "fitRows": len(fit_indexes),
                    "validationRows": len(validation_indexes),
                    "jointPathModel": True,
                    "rankerWithheld": rank_scores is None,
            "rankLabelSchema": "daily-path-priority-plus-return-tiebreak-v4",
                    "directionSingleClass": len(direction_classes) < 2,
                    "classBalance": tree_class_balance or "None",
                },
            }
        if status["lightgbm"]:
            return _lightgbm_fold_predictions(train, test, config=config)
    except Exception as exc:  # noqa: BLE001 - optional challenger failure must not block baselines.
        if status["lightgbm"]:
            fallback = _lightgbm_fold_predictions(train, test, config=config)
            if fallback and not fallback.get("error"):
                fallback["fallbackFrom"] = f"catboost: {exc}"
                return fallback
        return {"error": str(exc), "family": "optional_tree_error"}
    return None


def _lightgbm_fold_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]], *, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    try:
        import lightgbm as lgb  # type: ignore

        full_train_rows = len(train)
        tree_max_rows = max(20_000, int(config.get("treeMaxRows", os.getenv("PRODUCTION_TREE_MAX_ROWS", "40000"))))
        train = _evenly_spaced_rows(train, tree_max_rows)
        x_train = [row["x"] for row in train]
        x_test = [row["x"] for row in test]
        sample_weight = [number(row.get("trainingWeight"), 1.0) for row in train]
        dates = sorted({str(row.get("date")) for row in train})
        validation_date_count = max(20, min(60, int(len(dates) * 0.15)))
        validation_dates = set(dates[-validation_date_count:])
        fit_indexes = [
            index for index, row in enumerate(train)
            if str(row.get("date")) not in validation_dates and not row.get("ambiguousBarrierOrder")
        ]
        validation_indexes = [
            index for index, row in enumerate(train)
            if str(row.get("date")) in validation_dates and not row.get("ambiguousBarrierOrder")
        ]
        if len(fit_indexes) < 2_000 or len(validation_indexes) < 300:
            return {"error": "LightGBM fold lacks a separate chronological validation block.", "family": "lightgbm_error"}
        tree_iterations = max(40, min(200, int(config.get("treeIterations", os.getenv("PRODUCTION_TREE_ITERATIONS", "72")))))
        early_stopping_rounds = max(8, min(30, int(os.getenv("PRODUCTION_TREE_EARLY_STOPPING_ROUNDS", "12"))))
        common = {
            "n_estimators": tree_iterations,
            "learning_rate": 0.04,
            "num_leaves": 15,
            "max_depth": 4,
            "min_child_samples": 80,
            "subsample": 0.80,
            "colsample_bytree": 0.76,
            "reg_lambda": 8.0,
            "reg_alpha": 0.2,
            "verbosity": -1,
            "n_jobs": max(1, min(4, int(config.get("treeThreads", os.getenv("PRODUCTION_TREE_THREADS", "2"))))),
        }
        path = lgb.LGBMClassifier(objective="multiclass", num_class=3, **common)
        path.fit(
            [x_train[index] for index in fit_indexes],
            [train[index]["barrierClass"] for index in fit_indexes],
            sample_weight=[sample_weight[index] for index in fit_indexes],
            eval_set=(
                [x_train[index] for index in validation_indexes],
                [train[index]["barrierClass"] for index in validation_indexes],
            ),
            callbacks=[lgb.early_stopping(early_stopping_rounds, verbose=False)],
        )
        direction_labels = [int(train[index]["actualDirection"]) for index in fit_indexes]
        direction_classes = sorted(set(direction_labels))
        direction = None
        direction_predictions = [float(direction_classes[0])] * len(test) if direction_classes else [0.5] * len(test)
        direction_importance: list[float] = []
        if len(direction_classes) >= 2:
            direction = lgb.LGBMClassifier(objective="binary", **common)
            direction.fit(
                [x_train[index] for index in fit_indexes],
                direction_labels,
                sample_weight=[sample_weight[index] for index in fit_indexes],
                eval_set=(
                    [x_train[index] for index in validation_indexes],
                    [train[index]["actualDirection"] for index in validation_indexes],
                ),
                callbacks=[lgb.early_stopping(early_stopping_rounds, verbose=False)],
            )
            direction_matrix = direction.predict_proba(x_test, validate_features=False)
            direction_class_map = {int(label): index for index, label in enumerate(direction.classes_)}
            positive_position = direction_class_map.get(1)
            direction_predictions = (
                [number(row[positive_position]) for row in direction_matrix]
                if positive_position is not None
                else [0.0] * len(test)
            )
            direction_importance = [number(value) for value in direction.feature_importances_]
        path_matrix = path.predict_proba(x_test, validate_features=False)
        path_classes = {int(label): index for index, label in enumerate(path.classes_)}

        def path_probability(label: int) -> list[float]:
            position = path_classes.get(label)
            if position is None:
                return [0.0 for _ in test]
            return [number(row[position]) for row in path_matrix]

        quantiles = []
        for alpha in (0.1, 0.5, 0.9):
            model = lgb.LGBMRegressor(objective="quantile", alpha=alpha, **common)
            model.fit(
                [x_train[index] for index in fit_indexes],
                [train[index]["actualReturn"] for index in fit_indexes],
                sample_weight=[sample_weight[index] for index in fit_indexes],
                eval_set=(
                    [x_train[index] for index in validation_indexes],
                    [train[index]["actualReturn"] for index in validation_indexes],
                ),
                callbacks=[lgb.early_stopping(early_stopping_rounds, verbose=False)],
            )
            quantiles.append([number(value) for value in model.predict(x_test)])
        return {
            "family": "lightgbm-shallow-joint-path-quantile",
            "target": path_probability(2),
            "stop": path_probability(0),
            "timeout": path_probability(1),
            "rank": None,
            "quantiles": quantiles,
            "challengerTarget": path_probability(2),
            "direction": direction_predictions,
            "directionFeatureImportance": direction_importance,
            "trainingPolicy": {
                "depth": 4,
                "earlyStoppingRounds": early_stopping_rounds,
                "iterations": tree_iterations,
                "maxRows": tree_max_rows,
                "fullTrainingRows": full_train_rows,
                "sampledTrainingRows": len(train),
                "fitRows": len(fit_indexes),
                "validationRows": len(validation_indexes),
                "validationDates": validation_date_count,
                "jointPathModel": True,
                "rankerWithheld": True,
                "directionSingleClass": len(direction_classes) < 2,
            },
        }
    except Exception as exc:  # noqa: BLE001 - optional model family must not block baselines.
        return {"error": str(exc), "family": "lightgbm_error"}


def _event_fold_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> list[float | None] | None:
    event_train = [row for row in train if number(row.get("eventCoverage")) > 0]
    coverage = len(event_train) / max(1, len(train))
    if coverage < 0.10 or len(event_train) < 2_000 or sum(row["actualTarget"] for row in event_train) < 200:
        return None
    mapped_train = [{**row, "x": _event_feature_vector(row)} for row in event_train]
    mapped_test = [{**row, "x": _event_feature_vector(row)} for row in test]
    model = fit_logistic(mapped_train, "actualTarget", 0.14)
    predictions = [predict_logistic(model, row["x"]) for row in mapped_test]
    return [predictions[index] if number(row.get("eventCoverage")) > 0 else None for index, row in enumerate(test)]


def _date_level_regime_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> list[float] | None:
    """Predict broad market direction once per date, then broadcast it to that date's stocks."""
    if not train or not test:
        return None
    feature_names = _feature_names_for_row(train[0])
    selected_names = [
        "change5",
        "change20",
        "volatility",
        "volumeRatio",
        "xsMomentum5Rank",
        "xsMomentum20Rank",
        "xsLowVolatilityRank",
        "marketBreadth5",
    ]
    indexes = [feature_names.index(name) for name in selected_names if name in feature_names]
    if len(indexes) < 4:
        return None

    def aggregate(rows: list[dict[str, Any]], *, labelled: bool) -> tuple[list[dict[str, Any]], dict[str, int]]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            grouped[str(row.get("date") or "")].append(row)
        output = []
        positions = {}
        for position, day in enumerate(sorted(grouped)):
            group = grouped[day]
            values = [
                sum(number(row.get("x", [])[index]) for row in group if len(row.get("x") or []) > index) / max(1, len(group))
                for index in indexes
            ]
            record = {
                "date": day,
                "x": values,
                "trainingWeight": min(1.0, len(group) / 50.0),
            }
            if labelled:
                returns = sorted(number(row.get("actualReturn")) for row in group)
                record["actualDirection"] = 1.0 if median(returns) > 0 else 0.0
            output.append(record)
            positions[day] = position
        return output, positions

    train_dates, _ = aggregate(train, labelled=True)
    test_dates, test_positions = aggregate(test, labelled=False)
    if len(train_dates) < 250 or len({row["actualDirection"] for row in train_dates}) < 2:
        return None
    model = fit_logistic(train_dates, "actualDirection", 0.32, epochs=90)
    date_probabilities = [predict_logistic(model, row["x"]) for row in test_dates]
    return [
        clamp(number(date_probabilities[test_positions[str(row.get("date") or "")]]), 0.001, 0.999)
        for row in test
    ]


def _evenly_spaced_rows(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if len(rows) <= limit:
        return rows
    step = len(rows) / max(1, limit)
    return [rows[min(len(rows) - 1, int(index * step))] for index in range(limit)]


def feature_drift_summary(train: list[dict[str, Any]], test: list[dict[str, Any]], max_rows: int = 5000) -> dict[str, Any]:
    if not train or not test:
        return {"available": False}

    def sampled(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len(rows) <= max_rows:
            return rows
        step = len(rows) / max_rows
        return [rows[min(len(rows) - 1, int(index * step))] for index in range(max_rows)]

    train_sample = sampled(train)
    test_sample = sampled(test)
    feature_names = _feature_names_for_row(train_sample[0])
    feature_names = feature_names[: len(train_sample[0].get("x") or [])]
    drift_rows = []
    for feature_index, name in enumerate(feature_names):
        train_values = sorted(number(row["x"][feature_index]) for row in train_sample)
        test_values = [number(row["x"][feature_index]) for row in test_sample]
        if not train_values:
            continue
        boundaries = [train_values[min(len(train_values) - 1, int(len(train_values) * quantile / 10))] for quantile in range(1, 10)]

        def distribution(values: list[float]) -> list[float]:
            counts = [0 for _ in range(10)]
            for value in values:
                counts[min(9, bisect_left(boundaries, value))] += 1
            return [max(1e-4, count / max(1, len(values))) for count in counts]

        train_distribution = distribution(train_values)
        test_distribution = distribution(test_values)
        psi = sum(
            (test_distribution[index] - train_distribution[index])
            * math.log(test_distribution[index] / train_distribution[index])
            for index in range(10)
        )
        train_mean = sum(train_values) / len(train_values)
        train_std = math.sqrt(sum((value - train_mean) ** 2 for value in train_values) / max(1, len(train_values))) or 1.0
        test_mean = sum(test_values) / len(test_values)
        drift_rows.append({"feature": name, "psi": psi, "standardizedMeanShift": abs(test_mean - train_mean) / train_std})
    drift_rows.sort(key=lambda row: row["psi"], reverse=True)
    return {
        "available": bool(drift_rows),
        "method": "population-stability-index",
        "trainRows": len(train_sample),
        "testRows": len(test_sample),
        "meanPsi": round(sum(row["psi"] for row in drift_rows) / max(1, len(drift_rows)), 6),
        "maxPsi": round(max((row["psi"] for row in drift_rows), default=0.0), 6),
        "driftedFeatureCount": sum(1 for row in drift_rows if row["psi"] >= 0.25),
        "features": [
            {"feature": row["feature"], "psi": round(row["psi"], 6), "standardizedMeanShift": round(row["standardizedMeanShift"], 6)}
            for row in drift_rows
        ],
        "topFeatures": [
            {"feature": row["feature"], "psi": round(row["psi"], 6), "standardizedMeanShift": round(row["standardizedMeanShift"], 6)}
            for row in drift_rows[:8]
        ],
    }


def _training_stable_feature_panel(
    train: list[dict[str, Any]],
    test: list[dict[str, Any]],
    *,
    max_psi: float = 0.25,
    minimum_features: int = 8,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Prune unstable features using the training window only.

    The held-out fold labels and feature distribution are not used to choose
    features. This keeps the control point-in-time safe while preventing a
    handful of regime-sensitive columns from dominating every later fold.
    """
    dates = sorted({str(row.get("date") or "") for row in train if row.get("date")})
    if len(dates) < 120 or not train or not test:
        return train, test, {"available": False, "reason": "insufficient-training-dates"}
    split = max(40, min(len(dates) - 40, int(len(dates) * 0.70)))
    early_dates = set(dates[:split])
    late_dates = set(dates[split:])
    early = [row for row in train if str(row.get("date") or "") in early_dates]
    late = [row for row in train if str(row.get("date") or "") in late_dates]
    stability = feature_drift_summary(early, late)
    stability_windows = [{
        "start": dates[0],
        "split": dates[split],
        "end": dates[-1],
        "summary": stability,
    }]
    # A single early/late comparison can miss a feature that repeatedly changes
    # distribution inside the training history. Compare adjacent chronological
    # blocks too, and use the worst training-only PSI. The held-out fold remains
    # completely untouched by feature selection.
    block_count = 4
    block_edges = [round(index * len(dates) / block_count) for index in range(block_count + 1)]
    for block in range(block_count - 1):
        left_dates = set(dates[block_edges[block]:block_edges[block + 1]])
        right_dates = set(dates[block_edges[block + 1]:block_edges[block + 2]])
        if len(left_dates) < 40 or len(right_dates) < 40:
            continue
        left = [row for row in train if str(row.get("date") or "") in left_dates]
        right = [row for row in train if str(row.get("date") or "") in right_dates]
        summary = feature_drift_summary(left, right)
        stability_windows.append({
            "start": dates[block_edges[block]],
            "split": dates[block_edges[block + 1]],
            "end": dates[min(len(dates) - 1, block_edges[block + 2] - 1)],
            "summary": summary,
        })
    names = _feature_names_for_row(train[0])
    names = names[: len(train[0].get("x") or [])]
    psi_by_name: dict[str, float] = {}
    for window in stability_windows:
        summary = window.get("summary") or {}
        for row in summary.get("features") or summary.get("topFeatures") or []:
            name = str(row.get("feature"))
            psi_by_name[name] = max(psi_by_name.get(name, 0.0), number(row.get("psi")))
    excluded = {name for name, psi in psi_by_name.items() if psi >= max_psi}
    keep_indexes = [index for index, name in enumerate(names) if name not in excluded]
    if len(keep_indexes) < minimum_features:
        ranked = sorted(range(len(names)), key=lambda index: psi_by_name.get(names[index], 0.0))
        keep_indexes = sorted(ranked[: min(len(names), minimum_features)])
    if len(keep_indexes) == len(names):
        return train, test, {
            "available": True,
            "method": "training-window-psi",
            "excludedFeatures": [],
            "retainedFeatures": names,
            "trainingStability": stability,
            "trainingStabilityWindows": stability_windows,
            "worstTrainingPsi": psi_by_name,
        }
    retained = [names[index] for index in keep_indexes]

    def project(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                **row,
                "x": [row["x"][index] for index in keep_indexes],
                "featureNames": retained,
            }
            for row in rows
        ]

    return project(train), project(test), {
        "available": True,
        "method": "training-window-psi",
        "threshold": max_psi,
        "selectionUsesHeldOutFold": False,
        "excludedFeatures": [name for name in names if name not in retained],
        "retainedFeatures": retained,
        "trainingStability": stability,
        "trainingStabilityWindows": stability_windows,
        "worstTrainingPsi": psi_by_name,
    }


def _training_feature_family_gate(
    train: list[dict[str, Any]],
    test: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Remove clearly harmful event families using only an inner training split."""
    if not train or not test:
        return train, test, {"available": False, "reason": "empty-fold"}
    names = _feature_names_for_row(train[0])[: len(train[0].get("x") or [])]
    dates = sorted({str(row.get("date") or "") for row in train if row.get("date")})
    if len(dates) < 240:
        return train, test, {"available": False, "reason": "insufficient-inner-training-dates"}
    validation_size = min(120, max(60, len(dates) // 5))
    validation_dates = set(dates[-validation_size:])
    inner_dates = set(dates[: max(0, len(dates) - validation_size - 7)])
    inner = _evenly_spaced_rows([row for row in train if str(row.get("date")) in inner_dates], 4_000)
    validation = _evenly_spaced_rows([row for row in train if str(row.get("date")) in validation_dates], 4_000)
    if len(inner) < 1_000 or len(validation) < 300:
        return train, test, {"available": False, "reason": "insufficient-inner-training-rows"}

    def mapped(source: list[dict[str, Any]], indexes: list[int]) -> list[dict[str, Any]]:
        retained = [names[index] for index in indexes]
        return [
            {
                **row,
                "x": [number(row.get("x", [])[index]) for index in indexes],
                "featureNames": retained,
            }
            for row in source
        ]

    def evaluate(indexes: list[int]) -> dict[str, Any]:
        fit_rows = mapped(inner, indexes)
        validation_rows = mapped(validation, indexes)
        model = fit_logistic(fit_rows, "actualDirection", 0.24, epochs=24)
        probabilities = [predict_logistic(model, row["x"]) for row in validation_rows]
        return calibration_metrics(validation_rows, probabilities, bins=6, actual_key="actualDirection")

    all_indexes = list(range(len(names)))
    # Macro releases are consumed by the dedicated event/regime experts. Raw
    # macro states must not enter every price/path model: doing so makes all
    # base learners share the same revision and regime-shift error. This is an
    # architecture rule decided before any held-out fold is observed.
    excluded_families: list[str] = ["macro_regime"]
    macro_names = FEATURE_FAMILIES["macro_regime"]
    specialist_indexes = [index for index, name in enumerate(names) if name not in macro_names]
    baseline = evaluate(specialist_indexes)
    comparisons: list[dict[str, Any]] = [{
        "family": "macro_regime",
        "removedFeatureCount": sum(1 for name in names if name in FEATURE_FAMILIES["macro_regime"]),
        "excluded": True,
        "reason": "specialist-only-regime-input",
    }]
    for family in ("event_fundamental",):
        family_names = FEATURE_FAMILIES[family]
        removed = [index for index, name in enumerate(names) if name in family_names]
        retained = [index for index in specialist_indexes if index not in removed]
        if not removed or len(retained) < 8:
            continue
        reduced = evaluate(retained)
        brier_penalty = number(baseline.get("brier"), 1.0) - number(reduced.get("brier"), 1.0)
        accuracy_penalty = number(reduced.get("balancedAccuracyPct")) - number(baseline.get("balancedAccuracyPct"))
        harmful = brier_penalty > 0.0005 and accuracy_penalty > -0.10
        if harmful:
            excluded_families.append(family)
        comparisons.append({
            "family": family,
            "removedFeatureCount": len(removed),
            "fullBrier": baseline.get("brier"),
            "withoutFamilyBrier": reduced.get("brier"),
            "fullBalancedAccuracyPct": baseline.get("balancedAccuracyPct"),
            "withoutFamilyBalancedAccuracyPct": reduced.get("balancedAccuracyPct"),
            "excluded": harmful,
        })
    excluded_names = set().union(*(FEATURE_FAMILIES[name] for name in excluded_families)) if excluded_families else set()
    keep_indexes = [index for index, name in enumerate(names) if name not in excluded_names]
    return mapped(train, keep_indexes), mapped(test, keep_indexes), {
        "available": True,
        "method": "inner-chronological-direction-family-gate",
        "macroPolicy": "Macro PIT features are reserved for event/regime specialists and cannot directly drive every base model.",
        "selectionUsesHeldOutFold": False,
        "innerTrainRows": len(inner),
        "innerValidationRows": len(validation),
        "innerValidationDates": len(validation_dates),
        "excludedFamilies": excluded_families,
        "comparisons": comparisons,
        "retainedFeatures": [names[index] for index in keep_indexes],
    }


def _training_feature_profile_gate(
    train: list[dict[str, Any]],
    test: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Select a compact or enriched feature profile on inner training windows.

    Each candidate is fitted only on dates preceding its validation block. The
    outer fold remains untouched, so changing feature breadth cannot tune to
    the reported OOF period.
    """
    if not train or not test:
        return train, test, {"available": False, "reason": "empty-fold"}
    names = _feature_names_for_row(train[0])[: len(train[0].get("x") or [])]
    dates = sorted({str(row.get("date") or "") for row in train if row.get("date")})
    if len(dates) < 480:
        return train, test, {"available": False, "reason": "insufficient-inner-training-dates"}

    compact_names = set(COMPACT_TECHNICAL_FEATURE_NAMES) | set(COMPACT_CROSS_SECTIONAL_FEATURE_NAMES)
    technical_names = set(CORE_TECHNICAL_FEATURE_NAMES) | set(CROSS_SECTIONAL_FEATURE_NAMES)
    event_names = set(EVENT_FEATURE_NAMES) - set(MACRO_FEATURE_NAMES) - {"macroRisk"}
    profile_names = {
        "compact-price-flow": compact_names,
        "enriched-price-flow": technical_names,
        "enriched-with-events": technical_names | event_names,
    }
    candidates: dict[str, list[int]] = {}
    for profile, allowed in profile_names.items():
        indexes = [index for index, name in enumerate(names) if name in allowed]
        if len(indexes) >= 8:
            candidates[profile] = indexes
    if len(candidates) < 2:
        return train, test, {"available": False, "reason": "insufficient-distinct-profiles"}

    def mapped(source: list[dict[str, Any]], indexes: list[int]) -> list[dict[str, Any]]:
        retained = [names[index] for index in indexes]
        return [
            {
                **row,
                "x": [number(row.get("x", [])[index]) for index in indexes],
                "featureNames": retained,
            }
            for row in source
        ]

    validation_size = min(100, max(60, len(dates) // 10))
    validation_ends = [
        len(dates) - validation_size * 2,
        len(dates) - validation_size,
        len(dates),
    ]
    windows: list[dict[str, Any]] = []
    candidate_metrics: dict[str, list[dict[str, Any]]] = {name: [] for name in candidates}
    for end in validation_ends:
        start = max(0, end - validation_size)
        train_end = max(0, start - 7)
        if train_end < 300:
            continue
        inner_dates = set(dates[:train_end])
        validation_dates = set(dates[start:end])
        inner = _evenly_spaced_rows(
            [row for row in train if str(row.get("date") or "") in inner_dates],
            4_000,
        )
        validation = _evenly_spaced_rows(
            [row for row in train if str(row.get("date") or "") in validation_dates],
            4_000,
        )
        if len(inner) < 1_000 or len(validation) < 300:
            continue
        weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in validation]
        total_weight = sum(weights) or 1.0
        prevalence = sum(number(row.get("actualDirection")) * weights[index] for index, row in enumerate(validation)) / total_weight
        baseline_brier = sum(
            (prevalence - number(row.get("actualDirection"))) ** 2 * weights[index]
            for index, row in enumerate(validation)
        ) / total_weight
        window = {
            "trainEnd": dates[train_end - 1],
            "validationStart": dates[start],
            "validationEnd": dates[end - 1],
            "trainRows": len(inner),
            "validationRows": len(validation),
        }
        windows.append(window)
        for profile, indexes in candidates.items():
            fit_rows = mapped(inner, indexes)
            validation_rows = mapped(validation, indexes)
            model = fit_logistic(fit_rows, "actualDirection", 0.28, epochs=28)
            probabilities = [predict_logistic(model, row["x"]) for row in validation_rows]
            metrics = calibration_metrics(validation_rows, probabilities, bins=6, actual_key="actualDirection")
            model_brier = number(metrics.get("brier"), 1.0)
            candidate_metrics[profile].append({
                "brier": model_brier,
                "brierSkill": (baseline_brier - model_brier) / baseline_brier if baseline_brier > 0 else 0.0,
                "balancedAccuracyPct": number(metrics.get("balancedAccuracyPct")),
                "f1Pct": number(metrics.get("f1Pct")),
            })
    if len(windows) < 2:
        return train, test, {"available": False, "reason": "insufficient-inner-validation-windows"}

    comparisons = []
    for profile, rows in candidate_metrics.items():
        mean_brier = sum(number(row.get("brier"), 1.0) for row in rows) / max(1, len(rows))
        mean_skill = sum(number(row.get("brierSkill")) for row in rows) / max(1, len(rows))
        mean_balanced = sum(number(row.get("balancedAccuracyPct")) for row in rows) / max(1, len(rows))
        mean_f1 = sum(number(row.get("f1Pct")) for row in rows) / max(1, len(rows))
        negative_windows = sum(1 for row in rows if number(row.get("brierSkill")) <= 0)
        score = mean_brier + negative_windows * 0.00075 + max(0.0, 50.0 - mean_balanced) / 1_000.0
        comparisons.append({
            "profile": profile,
            "featureCount": len(candidates[profile]),
            "meanBrier": round(mean_brier, 7),
            "meanBrierSkill": round(mean_skill, 7),
            "meanBalancedAccuracyPct": round(mean_balanced, 5),
            "meanF1Pct": round(mean_f1, 5),
            "negativeSkillWindows": negative_windows,
            "selectionScore": round(score, 7),
            "windows": rows,
        })
    comparisons.sort(key=lambda row: (number(row.get("selectionScore"), 1.0), -number(row.get("meanF1Pct"))))
    selected_profile = str(comparisons[0]["profile"])
    selected_indexes = candidates[selected_profile]
    return mapped(train, selected_indexes), mapped(test, selected_indexes), {
        "available": True,
        "method": "nested-multi-window-feature-profile-selection",
        "selectionUsesHeldOutFold": False,
        "selectedProfile": selected_profile,
        "retainedFeatures": [names[index] for index in selected_indexes],
        "windows": windows,
        "comparisons": comparisons,
    }


def _false_positive_feature_vector(row: dict[str, Any]) -> list[float]:
    names = _feature_names_for_row(row)
    values = list(row.get("x") or [])
    lookup = {
        str(name): number(values[index])
        for index, name in enumerate(names)
        if index < len(values)
    }
    return [lookup.get(name, 0.0) for name in FALSE_POSITIVE_FEATURE_NAMES]


def _fold_oof_predictions(
    fold: dict[str, Any],
    *,
    enable_tree_models: bool,
    enable_sklearn_models: bool,
    config: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    config = config or {}
    original_train = fold["train"]
    original_test = fold["test"]
    pre_control_drift = feature_drift_summary(original_train, original_test)
    train, test, feature_stability = _training_stable_feature_panel(original_train, original_test)
    train, test, feature_family_gate = _training_feature_family_gate(train, test)
    train, test, feature_profile_gate = _training_feature_profile_gate(train, test)
    baseline_rows = int(config.get("baselineMaxRows", os.getenv("PRODUCTION_BASELINE_MAX_ROWS", "6000")))
    baseline = _sklearn_baseline_predictions(
        train,
        test,
        enabled=enable_sklearn_models,
        max_rows=max(2_000, baseline_rows),
    ) or _fallback_baseline_predictions(train, test, max_rows=baseline_rows)
    baseline_return = baseline["baselineReturn"]
    stable_direction_probability = baseline["direction"]
    elastic_direction_probability = baseline["elasticDirection"]
    direction_probability_rows = baseline["direction"]
    stable_baseline_probability = baseline["target"]
    elastic_probability = baseline["elasticTarget"]
    target_probability_rows = baseline["target"]
    stop_probability = baseline["stop"]
    timeout_probability = baseline["timeout"]
    rank_scores = baseline["rank"]
    tree = _tree_fold_predictions(train, test, enabled=enable_tree_models, config=config)
    family = baseline["family"]
    if tree and not tree.get("error"):
        family = f"{family}+{tree.get('family')}"
        target_probability_rows = tree["target"]
        stop_probability = tree["stop"]
        timeout_probability = tree["timeout"]
        if tree.get("rank") is not None:
            rank_scores = tree["rank"]
        quantiles = tree["quantiles"]
        if tree.get("direction") is not None:
            direction_probability_rows = tree["direction"]
    else:
        quantile_max_rows = max(2_000, min(50_000, int(config.get("quantileMaxRows", os.getenv("PRODUCTION_QUANTILE_MAX_ROWS", "6000")))))
        quantile_train = _evenly_spaced_rows(train, quantile_max_rows)
        quantile_epochs = 32 if len(quantile_train) >= 5_000 else 50
        q_models = [fit_quantile_linear(quantile_train, alpha, epochs=quantile_epochs) for alpha in (0.1, 0.5, 0.9)]
        quantiles = [predict_quantile(model, test) for model in q_models]
    rank_probability = _percentile_by_date(test, rank_scores)
    event_probability = _event_fold_predictions(train, test)
    regime_direction_probability = _date_level_regime_predictions(train, test)
    drift = feature_drift_summary(train, test)
    output: list[dict[str, Any]] = []
    return_scale = max(0.75, math.sqrt(sum(number(row.get("actualReturn")) ** 2 for row in train) / max(1, len(train))))
    for index, row in enumerate(test):
        q10, q50, q90 = (number(quantiles[position][index]) for position in range(3))
        width = max(0.35, q90 - q10)
        quantile_probability = sigmoid(q50 / width * 2.0)
        raw_path = [
            clamp(number(target_probability_rows[index]), 0.001, 0.999),
            clamp(number(stop_probability[index]), 0.001, 0.999),
            clamp(number(timeout_probability[index]), 0.001, 0.999),
        ]
        path_total = sum(raw_path) or 1.0
        target_probability, stop_prob, timeout_prob = [value / path_total for value in raw_path]
        output.append({
            "date": row["date"],
            "symbol": row["symbol"],
            "market": row["market"],
            "horizon": row["horizon"],
            "actualTarget": row["actualTarget"],
            "actualStop": row["actualStop"],
            "actualTimeout": row["actualTimeout"],
            "actualDirection": row["actualDirection"],
            "actualReturn": row["actualReturn"],
            "actualGrossReturn": row["actualGrossReturn"],
            "targetBarrierPct": row["targetBarrierPct"],
            "stopBarrierPct": row["stopBarrierPct"],
            "ridgePrediction": clamp(number(stable_baseline_probability[index]), 0.001, 0.999),
            "elasticPrediction": clamp(number(elastic_probability[index]), 0.001, 0.999),
            "lightgbmPrediction": (
                clamp(number(tree.get("challengerTarget")[index]), 0.001, 0.999)
                if tree and tree.get("challengerTarget") is not None
                else None
            ),
            "rankerPrediction": clamp(number(rank_probability[index]), 0.001, 0.999),
            "pathSafetyPrediction": clamp(target_probability * (1.0 - stop_prob), 0.001, 0.999),
            "quantilePrediction": clamp(quantile_probability, 0.001, 0.999),
            "eventPrediction": (
                clamp(number(event_probability[index]), 0.001, 0.999)
                if event_probability is not None and event_probability[index] is not None
                else None
            ),
            "ridgeDirectionPrediction": clamp(number(stable_direction_probability[index]), 0.001, 0.999),
            "elasticDirectionPrediction": clamp(number(elastic_direction_probability[index]), 0.001, 0.999),
            "treeDirectionPrediction": (
                clamp(number(direction_probability_rows[index]), 0.001, 0.999)
                if tree and not tree.get("error") and tree.get("direction") is not None
                else None
            ),
            "returnDirectionPrediction": clamp(sigmoid(number(baseline_return[index]) / return_scale), 0.001, 0.999),
            "regimeDirectionPrediction": (
                clamp(number(regime_direction_probability[index]), 0.001, 0.999)
                if regime_direction_probability is not None
                else None
            ),
            "targetProbability": target_probability,
            "stopProbability": stop_prob,
            "timeoutProbability": timeout_prob,
            "quantileP10": q10,
            "quantileP50": q50,
            "quantileP90": q90,
            "baselineReturn": number(baseline_return[index]),
            "regime": row["regime"],
            "sector": row.get("sector") or "Unknown",
            "liquidityWeight": row.get("liquidityWeight"),
            "dataQuality": row["dataQualityScore"],
            "evaluationWeight": row["evaluationWeight"],
            "transactionCostBps": row["transactionCostBps"],
            "entrySource": row["entrySource"],
            "falsePositiveFeatures": _false_positive_feature_vector(row),
            "fold": fold["fold"],
        })
    return output, {
        "fold": fold["fold"],
        "family": family,
        "optionalTreeError": tree.get("error") if tree else None,
        "resourcePolicy": {
            "sklearnEnabled": bool(enable_sklearn_models),
            "treeChallengerEnabled": bool(enable_tree_models),
            "baseline": "low-memory-python-logistic-ridge" if baseline.get("family") == "python-logistic-ridge-fallback" else baseline.get("family"),
            "reason": "Complex challengers are opt-in so a constrained machine can always finish and checkpoint the deterministic Champion first.",
        },
        "baselineTrainingRows": int(baseline.get("trainingRows") or len(train)),
        "panelTrainingRows": len(original_train),
        "eligibleTrainingRows": len(train),
        "baselineFullTrainingRows": int(baseline.get("fullTrainingRows") or len(train)),
        "treeSampledTrainingRows": int((tree.get("trainingPolicy") or {}).get("sampledTrainingRows") or 0) if tree and not tree.get("error") else 0,
        "treeFitRows": int((tree.get("trainingPolicy") or {}).get("fitRows") or 0) if tree and not tree.get("error") else 0,
        "treeValidationRows": int((tree.get("trainingPolicy") or {}).get("validationRows") or 0) if tree and not tree.get("error") else 0,
        "treeTrainingPolicy": dict(tree.get("trainingPolicy") or {}) if tree and not tree.get("error") else {},
        "quantileTrainingRows": len(train) if tree and not tree.get("error") else len(quantile_train),
        "trainRows": len(train),
        "testRows": len(test),
        "trainDates": fold["trainDates"],
        "testDates": fold["testDates"],
        "trainEnd": fold["trainEnd"],
        "testStart": fold["testStart"],
        "testEnd": fold["testEnd"],
        "purgeDays": fold["purgeDays"],
        "embargoDays": fold["embargoDays"],
        "featureDrift": drift,
        "preControlFeatureDrift": pre_control_drift,
        "featureStabilityControl": feature_stability,
        "featureFamilyGate": feature_family_gate,
        "featureProfileGate": feature_profile_gate,
        "directionFeatureImportance": (
            [
                {"feature": name, "importance": number(value)}
                for name, value in zip(_feature_names_for_row(test[0]), tree.get("directionFeatureImportance") or [])
            ]
            if tree and not tree.get("error") and test
            else []
        ),
    }


def _model_value(row: dict[str, Any], name: str) -> float:
    value = row.get(name)
    return 0.5 if value is None else clamp(number(value, 0.5), 0.001, 0.999)


def residual_correlation(rows: list[dict[str, Any]], left: str, right: str, *, actual_key: str = "actualTarget") -> float:
    if len(rows) < 3:
        return 0.0
    left_values = [_model_value(row, left) - number(row[actual_key]) for row in rows]
    right_values = [_model_value(row, right) - number(row[actual_key]) for row in rows]
    left_mean = sum(left_values) / len(left_values)
    right_mean = sum(right_values) / len(right_values)
    covariance = sum((left_values[index] - left_mean) * (right_values[index] - right_mean) for index in range(len(rows)))
    left_var = sum((value - left_mean) ** 2 for value in left_values)
    right_var = sum((value - right_mean) ** 2 for value in right_values)
    return covariance / math.sqrt(max(1e-12, left_var * right_var))


def brier(
    rows: list[dict[str, Any]],
    probability_key: str | None = None,
    probabilities: list[float] | None = None,
    *,
    actual_key: str = "actualTarget",
) -> float:
    if not rows:
        return 0.0
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(weights) or 1.0
    values = probabilities if probabilities is not None else [_model_value(row, str(probability_key)) for row in rows]
    return sum((number(values[index]) - number(row[actual_key])) ** 2 * weights[index] for index, row in enumerate(rows)) / total


def brier_skilled_models(
    rows: list[dict[str, Any]],
    names: list[str],
    *,
    actual_key: str = "actualTarget",
) -> tuple[list[str], list[dict[str, Any]]]:
    if not rows or not names:
        return [], []
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(weights) or 1.0
    prevalence = sum(number(row.get(actual_key)) * weights[index] for index, row in enumerate(rows)) / total
    baseline = brier(rows, probabilities=[prevalence] * len(rows), actual_key=actual_key)
    scored = [(name, brier(rows, name, actual_key=actual_key)) for name in names]
    kept = [name for name, score in scored if score <= baseline + 1e-9]
    if not kept and scored:
        kept = [min(scored, key=lambda item: item[1])[0]]
    rejected = [
        {
            "model": name,
            "because": "negative-meta-train-brier-skill",
            "brier": round(score, 7),
            "baselineBrier": round(baseline, 7),
        }
        for name, score in scored
        if name not in kept
    ]
    return kept, rejected


def prune_correlated_models(
    rows: list[dict[str, Any]],
    names: list[str],
    threshold: float = 0.8,
    *,
    actual_key: str = "actualTarget",
) -> tuple[list[str], list[dict[str, Any]]]:
    kept = list(names)
    pruned: list[dict[str, Any]] = []
    changed = True
    while changed and len(kept) > 3:
        changed = False
        for left_index in range(len(kept)):
            for right_index in range(left_index + 1, len(kept)):
                left, right = kept[left_index], kept[right_index]
                correlation = residual_correlation(rows, left, right, actual_key=actual_key)
                if abs(correlation) <= threshold:
                    continue
                left_brier = brier(rows, left, actual_key=actual_key)
                right_brier = brier(rows, right, actual_key=actual_key)
                removed = right if left_brier <= right_brier else left
                kept.remove(removed)
                pruned.append({"model": removed, "because": left if removed == right else right, "residualCorrelation": round(correlation, 5)})
                changed = True
                break
            if changed:
                break
    return kept, pruned


def project_capped_simplex(values: list[float], cap: float) -> list[float]:
    if not values:
        return []
    cap = max(1.0 / len(values), min(1.0, cap))
    projected = [max(0.0, number(value)) for value in values]
    total = sum(projected)
    projected = [value / total for value in projected] if total > 1e-12 else [1.0 / len(values) for _ in values]
    for _ in range(12):
        overflow = sum(max(0.0, value - cap) for value in projected)
        projected = [min(value, cap) for value in projected]
        receivers = [index for index, value in enumerate(projected) if value < cap - 1e-9]
        if overflow <= 1e-10 or not receivers:
            break
        room = sum(cap - projected[index] for index in receivers)
        for index in receivers:
            projected[index] += overflow * (cap - projected[index]) / max(1e-12, room)
    total = sum(projected)
    return [value / total for value in projected] if total > 1e-12 else projected


def fit_constrained_stack(
    rows: list[dict[str, Any]],
    names: list[str],
    *,
    cap: float = 0.35,
    shrinkage: float = 0.18,
    actual_key: str = "actualTarget",
) -> list[float]:
    if not rows or not names:
        return []
    prior = [1.0 / len(names) for _ in names]
    weights = list(prior)
    row_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(row_weights) or 1.0
    # The weighted Brier objective is quadratic. Build its tiny sufficient-statistic
    # matrix once instead of rescanning a market-sized OOF table on every step.
    size = len(names)
    gram = [[0.0 for _ in range(size)] for _ in range(size)]
    target_product = [0.0 for _ in range(size)]
    for row_index, row in enumerate(rows):
        values = [_model_value(row, name) for name in names]
        importance = row_weights[row_index] / total
        actual = number(row[actual_key])
        for left in range(size):
            target_product[left] += importance * values[left] * actual
            for right in range(left, size):
                gram[left][right] += importance * values[left] * values[right]
    for left in range(size):
        for right in range(left):
            gram[left][right] = gram[right][left]
    lipschitz_bound = max(
        1e-6,
        max(sum(abs(value) for value in row) for row in gram) + shrinkage,
    )
    step = 0.45 / lipschitz_bound
    for _ in range(300):
        gradients = [
            2.0 * (
                sum(gram[index][other] * weights[other] for other in range(size))
                - target_product[index]
                + shrinkage * (weights[index] - prior[index])
            )
            for index in range(size)
        ]
        previous = list(weights)
        weights = project_capped_simplex([weights[index] - step * gradients[index] for index in range(len(names))], cap)
        if sum(abs(weights[index] - previous[index]) for index in range(size)) < 1e-10:
            break
    return weights


def ensemble_probabilities(rows: list[dict[str, Any]], names: list[str], weights: list[float]) -> list[float]:
    return [
        clamp(sum(weights[index] * _model_value(row, name) for index, name in enumerate(names)), 0.001, 0.999)
        for row in rows
    ]


def fit_platt(probabilities: list[float], actuals: list[float]) -> dict[str, float]:
    if not probabilities:
        return {"intercept": 0.0, "slope": 1.0}
    prevalence = clamp(sum(number(value) for value in actuals) / max(1, len(actuals)), 0.001, 0.999)
    intercept = math.log(prevalence / (1.0 - prevalence))
    slope = 1.0
    regularization = 0.02
    for _ in range(30):
        grad_intercept = 0.0
        grad_slope = regularization * (slope - 1.0)
        hessian_intercept = 1e-8
        hessian_cross = 0.0
        hessian_slope = regularization + 1e-8
        for probability, actual in zip(probabilities, actuals):
            logit = math.log(clamp(probability, 0.001, 0.999) / (1.0 - clamp(probability, 0.001, 0.999)))
            prediction = sigmoid(intercept + slope * logit)
            error = prediction - actual
            grad_intercept += error
            grad_slope += error * logit
            curvature = max(1e-8, prediction * (1.0 - prediction))
            hessian_intercept += curvature
            hessian_cross += curvature * logit
            hessian_slope += curvature * logit * logit
        determinant = hessian_intercept * hessian_slope - hessian_cross * hessian_cross
        if abs(determinant) < 1e-12:
            break
        delta_intercept = (hessian_slope * grad_intercept - hessian_cross * grad_slope) / determinant
        delta_slope = (-hessian_cross * grad_intercept + hessian_intercept * grad_slope) / determinant
        intercept = clamp(intercept - delta_intercept, -20.0, 20.0)
        slope = clamp(slope - delta_slope, 0.02, 4.0)
        if abs(delta_intercept) + abs(delta_slope) < 1e-7:
            break
    return {"intercept": intercept, "slope": slope}


def apply_platt(model: dict[str, float], probabilities: list[float]) -> list[float]:
    return [
        sigmoid(number(model.get("intercept")) + number(model.get("slope"), 1.0) * math.log(clamp(value, 0.001, 0.999) / (1.0 - clamp(value, 0.001, 0.999))))
        for value in probabilities
    ]


def _fit_isotonic_pav(probabilities: list[float], actuals: list[float]) -> dict[str, Any]:
    """Fit monotone calibration with pool-adjacent-violators and no heavy imports."""
    grouped: list[dict[str, float]] = []
    for probability, actual in sorted(
        zip(probabilities, actuals),
        key=lambda item: number(item[0]),
    ):
        x_value = clamp(number(probability), 0.001, 0.999)
        y_value = clamp(number(actual), 0.0, 1.0)
        if grouped and abs(grouped[-1]["x"] - x_value) <= 1e-12:
            grouped[-1]["sum"] += y_value
            grouped[-1]["count"] += 1.0
            grouped[-1]["mean"] = grouped[-1]["sum"] / grouped[-1]["count"]
        else:
            grouped.append({"x": x_value, "sum": y_value, "count": 1.0, "mean": y_value})

    blocks: list[dict[str, float]] = []
    for group in grouped:
        blocks.append({
            "xSum": group["x"] * group["count"],
            "sum": group["sum"],
            "count": group["count"],
            "mean": group["mean"],
        })
        while len(blocks) >= 2 and blocks[-2]["mean"] > blocks[-1]["mean"]:
            right = blocks.pop()
            left = blocks.pop()
            count = left["count"] + right["count"]
            total = left["sum"] + right["sum"]
            blocks.append({
                "xSum": left["xSum"] + right["xSum"],
                "sum": total,
                "count": count,
                "mean": total / count,
            })

    return {
        "method": "isotonic",
        "implementation": "pure-python-pool-adjacent-violators",
        "xThresholds": [block["xSum"] / block["count"] for block in blocks],
        "yThresholds": [clamp(block["mean"], 0.001, 0.999) for block in blocks],
        "inputRows": len(probabilities),
        "blocks": len(blocks),
    }


def _fit_calibrator_method(
    method: str,
    probabilities: list[float],
    actuals: list[float],
    *,
    independent_dates: int = 0,
) -> dict[str, Any]:
    if method == "identity":
        return {"method": "identity"}
    if method == "shrinkage":
        prior = clamp(sum(number(value) for value in actuals) / max(1, len(actuals)), 0.001, 0.999)
        evidence_cap = clamp(independent_dates / 120.0, 0.10, 1.0)
        best_alpha = 0.0
        best_brier = float("inf")
        for step in range(21):
            alpha = evidence_cap * step / 20.0
            brier = sum(
                (prior + alpha * (clamp(number(probability), 0.001, 0.999) - prior) - number(actual)) ** 2
                for probability, actual in zip(probabilities, actuals)
            ) / max(1, len(actuals))
            if brier < best_brier:
                best_brier = brier
                best_alpha = alpha
        return {
            "method": "shrinkage",
            "prior": prior,
            "alpha": best_alpha,
            "independentDates": independent_dates,
            "evidenceCap": evidence_cap,
        }
    if method == "isotonic" and len(probabilities) >= 5000 and independent_dates >= 120:
        return _fit_isotonic_pav(probabilities, actuals)
    return {"method": "platt", **fit_platt(probabilities, actuals)}


def fit_probability_calibrator(
    probabilities: list[float],
    actuals: list[float],
    *,
    independent_dates: int | None = None,
    dates: list[str] | None = None,
) -> dict[str, Any]:
    date_rows = [str(value) for value in (dates or [])]
    unique_dates = sorted(set(date_rows)) if len(date_rows) == len(probabilities) else []
    if len(probabilities) >= 500 and len(unique_dates) >= 40:
        split_index = max(10, min(len(unique_dates) - 10, int(len(unique_dates) * 0.80)))
        fit_dates = set(unique_dates[:split_index])
        fit_indexes = [index for index, value in enumerate(date_rows) if value in fit_dates]
        validation_indexes = [index for index, value in enumerate(date_rows) if value not in fit_dates]
        fit_probabilities = [probabilities[index] for index in fit_indexes]
        fit_actuals = [actuals[index] for index in fit_indexes]
        validation_probabilities = [probabilities[index] for index in validation_indexes]
        validation_actuals = [actuals[index] for index in validation_indexes]
        methods = ["identity", "shrinkage", "platt"]
        if len(fit_probabilities) >= 5000 and len(fit_dates) >= 120:
            methods.append("isotonic")
        scored: list[tuple[float, str]] = []
        for method in methods:
            candidate = _fit_calibrator_method(
                method,
                fit_probabilities,
                fit_actuals,
                independent_dates=len(fit_dates),
            )
            calibrated = apply_probability_calibrator(candidate, validation_probabilities)
            score = sum(
                (number(calibrated[index]) - number(validation_actuals[index])) ** 2
                for index in range(len(validation_actuals))
            ) / max(1, len(validation_actuals))
            scored.append((score, method))
        scored.sort(key=lambda item: (item[0], methods.index(item[1])))
        selected_method = scored[0][1]
        fitted = _fit_calibrator_method(
            selected_method,
            probabilities,
            actuals,
            independent_dates=len(unique_dates),
        )
        fitted["selection"] = {
            "framework": "chronological-calibration-method-selection",
            "fitRows": len(fit_indexes),
            "validationRows": len(validation_indexes),
            "fitDates": len(fit_dates),
            "validationDates": len(unique_dates) - len(fit_dates),
            "candidateBrier": {method: round(score, 8) for score, method in scored},
            "selectedMethod": fitted.get("method"),
        }
        return fitted
    return _fit_calibrator_method(
        "isotonic" if len(probabilities) >= 5000 and int(independent_dates or 0) >= 120 else "shrinkage",
        probabilities,
        actuals,
        independent_dates=int(independent_dates or 0),
    )


def apply_probability_calibrator(model: dict[str, Any], probabilities: list[float]) -> list[float]:
    if model.get("method") == "identity":
        return [clamp(number(value), 0.001, 0.999) for value in probabilities]
    if model.get("method") == "shrinkage":
        prior = clamp(number(model.get("prior"), 0.5), 0.001, 0.999)
        alpha = clamp(number(model.get("alpha"), 0.0), 0.0, 1.0)
        return [
            clamp(prior + alpha * (clamp(number(value), 0.001, 0.999) - prior), 0.001, 0.999)
            for value in probabilities
        ]
    if model.get("method") != "isotonic":
        return apply_platt(model, probabilities)
    x_values = [number(value) for value in model.get("xThresholds") or []]
    y_values = [number(value) for value in model.get("yThresholds") or []]
    if not x_values or len(x_values) != len(y_values):
        return probabilities
    output = []
    for probability in probabilities:
        value = clamp(number(probability), x_values[0], x_values[-1])
        right = bisect_left(x_values, value)
        if right <= 0:
            output.append(y_values[0])
            continue
        if right >= len(x_values):
            output.append(y_values[-1])
            continue
        left = right - 1
        width = x_values[right] - x_values[left]
        ratio = (value - x_values[left]) / width if width > 1e-12 else 0.0
        output.append(clamp(y_values[left] + (y_values[right] - y_values[left]) * ratio, 0.001, 0.999))
    return output


def select_robust_direction_models(
    rows: list[dict[str, Any]],
    names: list[str],
    *,
    purge_days: int = 7,
) -> tuple[list[str], list[dict[str, Any]], dict[str, Any]]:
    """Keep direction models that retain calibrated skill across inner windows.

    A capped simplex cannot honour a 35% per-model limit when only two models
    survive. In that case, forcing an equal-weight ensemble can dilute the
    stronger model. We therefore select a single Champion from nested OOF
    windows until at least three genuinely distinct skilled models exist.
    """
    if not rows or not names:
        return names, [], {"available": False, "reason": "empty-meta-training-set"}
    dates = sorted({str(row.get("date") or "") for row in rows if row.get("date")})
    if len(dates) < 240:
        return names, [], {"available": False, "reason": "insufficient-meta-training-dates"}
    window_size = min(80, max(60, len(dates) // 6))
    validation_ends = [len(dates) - window_size * 2, len(dates) - window_size, len(dates)]
    model_windows: dict[str, list[dict[str, Any]]] = {name: [] for name in names}
    windows = []
    for end in validation_ends:
        start = max(0, end - window_size)
        train_end = max(0, start - max(1, purge_days))
        if train_end < 120:
            continue
        train_dates = set(dates[:train_end])
        validation_dates = set(dates[start:end])
        fit_rows = [row for row in rows if str(row.get("date") or "") in train_dates]
        validation_rows = [row for row in rows if str(row.get("date") or "") in validation_dates]
        if len(fit_rows) < 1_000 or len(validation_rows) < 300:
            continue
        validation_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in validation_rows]
        weight_total = sum(validation_weights) or 1.0
        prevalence = sum(
            number(row.get("actualDirection")) * validation_weights[index]
            for index, row in enumerate(validation_rows)
        ) / weight_total
        baseline_brier = brier(
            validation_rows,
            probabilities=[prevalence] * len(validation_rows),
            actual_key="actualDirection",
        )
        windows.append({
            "trainEnd": dates[train_end - 1],
            "validationStart": dates[start],
            "validationEnd": dates[end - 1],
            "trainRows": len(fit_rows),
            "validationRows": len(validation_rows),
        })
        for name in names:
            train_probabilities = [_model_value(row, name) for row in fit_rows]
            calibrator = fit_probability_calibrator(
                train_probabilities,
                [number(row.get("actualDirection")) for row in fit_rows],
                independent_dates=len(train_dates),
                dates=[str(row.get("date") or "") for row in fit_rows],
            )
            probabilities = apply_probability_calibrator(
                calibrator,
                [_model_value(row, name) for row in validation_rows],
            )
            model_brier = brier(
                validation_rows,
                probabilities=probabilities,
                actual_key="actualDirection",
            )
            model_windows[name].append({
                "brier": round(model_brier, 7),
                "baselineBrier": round(baseline_brier, 7),
                "brierSkill": round((baseline_brier - model_brier) / baseline_brier, 7) if baseline_brier > 0 else 0.0,
                "calibrator": calibrator.get("method"),
            })
    if len(windows) < 2:
        return names, [], {"available": False, "reason": "insufficient-inner-validation-windows"}

    comparisons = []
    for name in names:
        values = model_windows[name]
        mean_skill = sum(number(value.get("brierSkill")) for value in values) / max(1, len(values))
        positive_windows = sum(1 for value in values if number(value.get("brierSkill")) > 0)
        comparisons.append({
            "model": name,
            "meanBrierSkill": round(mean_skill, 7),
            "positiveWindows": positive_windows,
            "windowCount": len(values),
            "windows": values,
        })
    comparisons.sort(key=lambda row: (-number(row.get("meanBrierSkill")), -number(row.get("positiveWindows"))))
    minimum_positive = max(2, math.ceil(len(windows) * 2 / 3))
    eligible = [
        str(row["model"])
        for row in comparisons
        if number(row.get("meanBrierSkill")) > 0 and int(row.get("positiveWindows") or 0) >= minimum_positive
    ]
    if not eligible:
        eligible = [str(comparisons[0]["model"])]
    selected = eligible if len(eligible) >= 3 else [eligible[0]]
    rejected = [
        {
            "model": str(row["model"]),
            "because": "nested-direction-champion-selection",
            "meanBrierSkill": row.get("meanBrierSkill"),
            "positiveWindows": row.get("positiveWindows"),
        }
        for row in comparisons
        if str(row["model"]) not in selected
    ]
    return selected, rejected, {
        "available": True,
        "method": "nested-calibrated-brier-champion-selection",
        "selectionUsesHeldOutMetaTest": False,
        "ensembleMinimumDistinctModels": 3,
        "selectedModels": selected,
        "windows": windows,
        "comparisons": comparisons,
    }


def conformalize_quantiles(train_rows: list[dict[str, Any]], test_rows: list[dict[str, Any]], alpha: float = 0.20) -> dict[str, Any]:
    scores = sorted(
        max(number(row.get("quantileP10")) - number(row.get("actualReturn")), number(row.get("actualReturn")) - number(row.get("quantileP90")), 0.0)
        for row in train_rows
    )
    if not scores:
        return {"available": False, "method": "conformalized-quantile-regression"}
    quantile_index = min(len(scores) - 1, max(0, math.ceil((len(scores) + 1) * (1.0 - alpha)) - 1))
    correction = scores[quantile_index]
    covered = 0
    widths = []
    for row in test_rows:
        low = number(row.get("quantileP10")) - correction
        high = number(row.get("quantileP90")) + correction
        row["conformalP10"] = low
        row["conformalP90"] = high
        covered += 1 if low <= number(row.get("actualReturn")) <= high else 0
        widths.append(high - low)
    return {
        "available": bool(test_rows),
        "method": "conformalized-quantile-regression",
        "nominalCoveragePct": round((1.0 - alpha) * 100.0, 3),
        "observedCoveragePct": round(covered / max(1, len(test_rows)) * 100.0, 4),
        "correctionPct": round(correction, 6),
        "meanIntervalWidthPct": round(sum(widths) / max(1, len(widths)), 6),
        "calibrationRows": len(train_rows),
        "testRows": len(test_rows),
    }


def _rank_values(values: list[float]) -> list[float]:
    ordered = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0 for _ in values]
    for rank, index in enumerate(ordered):
        ranks[index] = float(rank)
    return ranks


def rank_ic_summary(rows: list[dict[str, Any]], *, score_key: str = "rankerPrediction") -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("date"))].append(row)
    correlations = []
    top_returns = []
    universe_returns = []
    ndcg_values = []
    precision_values = []
    direction_values = []
    for group in groups.values():
        if len(group) < 5:
            continue
        predicted = _rank_values([_model_value(row, score_key) for row in group])
        actual = _rank_values([number(row.get("actualReturn")) for row in group])
        pred_mean = sum(predicted) / len(predicted)
        actual_mean = sum(actual) / len(actual)
        numerator = sum((predicted[index] - pred_mean) * (actual[index] - actual_mean) for index in range(len(group)))
        denominator = math.sqrt(
            sum((value - pred_mean) ** 2 for value in predicted)
            * sum((value - actual_mean) ** 2 for value in actual)
        )
        correlations.append(numerator / denominator if denominator > 1e-12 else 0.0)
        top_count = max(1, math.ceil(len(group) * 0.10))
        selected = sorted(group, key=lambda row: _model_value(row, score_key), reverse=True)[:top_count]
        top_returns.append(sum(number(row.get("actualReturn")) for row in selected) / len(selected))
        universe_returns.append(sum(number(row.get("actualReturn")) for row in group) / len(group))
        relevance = lambda row: 3.0 if number(row.get("actualTarget")) >= 0.5 else 0.0 if number(row.get("actualStop")) >= 0.5 else 2.0 if number(row.get("actualReturn")) > 0 else 1.0
        def dcg(values: list[float]) -> float:
            return sum((2.0 ** value - 1.0) / math.log2(index + 2.0) for index, value in enumerate(values))
        selected_relevance = [relevance(row) for row in selected]
        ideal_relevance = sorted((relevance(row) for row in group), reverse=True)[:top_count]
        ideal_dcg = dcg(ideal_relevance)
        ndcg_values.append(dcg(selected_relevance) / ideal_dcg if ideal_dcg > 1e-12 else 0.0)
        precision_values.append(sum(number(row.get("actualTarget")) >= 0.5 for row in selected) / len(selected))
        direction_values.append(sum(number(row.get("actualDirection")) >= 0.5 for row in selected) / len(selected))
    cumulative = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in top_returns:
        cumulative *= 1.0 + value / 100.0
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, (peak - cumulative) / max(1e-12, peak) * 100.0)
    return {
        "available": bool(correlations),
        "scoreKey": score_key,
        "dateCount": len(correlations),
        "rankIc": round(sum(correlations) / max(1, len(correlations)), 6),
        "topDecileNetReturn": round(sum(top_returns) / max(1, len(top_returns)), 6),
        "universeNetReturn": round(sum(universe_returns) / max(1, len(universe_returns)), 6),
        "topDecileLift": round((sum(top_returns) / max(1, len(top_returns))) - (sum(universe_returns) / max(1, len(universe_returns))), 6),
        "ndcgAtK": round(sum(ndcg_values) / max(1, len(ndcg_values)), 6),
        "top10TargetFirstRatePct": round(sum(precision_values) / max(1, len(precision_values)) * 100.0, 5),
        "top10DirectionHitRatePct": round(sum(direction_values) / max(1, len(direction_values)) * 100.0, 5),
        "maxDrawdownPct": round(max_drawdown, 6),
    }


def fit_selective_ranking_head(
    train_rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
    train_direction_probabilities: list[float],
    test_direction_probabilities: list[float],
    train_target_probabilities: list[float],
    test_target_probabilities: list[float],
) -> dict[str, Any]:
    """Select a conservative Top-K blend on a purged inner OOF block.

    Every component is already an out-of-fold prediction. The final untouched
    meta-test labels are never read while choosing the blend.
    """
    if len(train_rows) < 500 or len(test_rows) < 100:
        return {
            "available": False,
            "active": False,
            "reason": "Selective ranking requires at least 500 meta-train and 100 untouched meta-test rows.",
            "scores": [_model_value(row, "rankerPrediction") for row in test_rows],
        }

    component_names = [
        "rank",
        "direction",
        "target",
        "pathSafety",
        "stopSafety",
        "quantileMedian",
        "baselineReturn",
        "liquidity",
    ]

    def components(
        rows: list[dict[str, Any]],
        direction_probabilities: list[float],
        target_probabilities: list[float],
    ) -> list[dict[str, float]]:
        raw = {
            "rank": [_model_value(row, "rankerPrediction") for row in rows],
            "direction": [clamp(number(value), 0.001, 0.999) for value in direction_probabilities],
            "target": [clamp(number(value), 0.001, 0.999) for value in target_probabilities],
            "pathSafety": [_model_value(row, "pathSafetyPrediction") for row in rows],
            "stopSafety": [1.0 - _model_value(row, "stopProbability") for row in rows],
            "quantileMedian": [number(row.get("quantileP50")) for row in rows],
            "baselineReturn": [number(row.get("baselineReturn")) for row in rows],
            "liquidity": [number(row.get("liquidityWeight"), 0.5) for row in rows],
        }
        ranked = {name: _percentile_by_date(rows, values) for name, values in raw.items()}
        return [
            {name: clamp(number(ranked[name][index]), 0.0, 1.0) for name in component_names}
            for index in range(len(rows))
        ]

    train_components = components(train_rows, train_direction_probabilities, train_target_probabilities)
    test_components = components(test_rows, test_direction_probabilities, test_target_probabilities)
    ordered_dates = sorted({str(row.get("date") or "") for row in train_rows})
    validation_start = max(1, int(len(ordered_dates) * 0.75))
    inner_purge_start = max(0, validation_start - 12)
    inner_training_dates = set(ordered_dates[:inner_purge_start])
    validation_dates = set(ordered_dates[validation_start:])
    inner_train_indexes = [index for index, row in enumerate(train_rows) if str(row.get("date") or "") in inner_training_dates]
    validation_indexes = [index for index, row in enumerate(train_rows) if str(row.get("date") or "") in validation_dates]
    if len(inner_train_indexes) < 300 or len(validation_indexes) < 100 or len(validation_dates) < 30:
        return {
            "available": False,
            "active": False,
            "reason": "Selective ranking lacks a sufficiently deep independent inner validation date block.",
            "scores": [_model_value(row, "rankerPrediction") for row in test_rows],
        }

    candidates: dict[str, dict[str, float]] = {
        "rank-only": {"rank": 1.0},
        "rank-direction": {"rank": 0.55, "direction": 0.45},
        "rank-direction-path": {"rank": 0.45, "direction": 0.35, "target": 0.10, "pathSafety": 0.10},
        "risk-adjusted": {"rank": 0.40, "direction": 0.30, "target": 0.10, "stopSafety": 0.15, "liquidity": 0.05},
        "return-aware": {"rank": 0.35, "direction": 0.30, "pathSafety": 0.10, "quantileMedian": 0.15, "baselineReturn": 0.10},
    }
    stack_rows = []
    stack_keys = [f"selection_{name}" for name in component_names]
    for index in inner_train_indexes:
        stack_rows.append({
            **train_rows[index],
            **{stack_keys[position]: train_components[index][name] for position, name in enumerate(component_names)},
        })
    learned_weights = fit_constrained_stack(
        stack_rows,
        stack_keys,
        cap=0.45,
        actual_key="actualDirection",
    )
    if learned_weights:
        candidates["learned-direction-stack"] = {
            name: learned_weights[index]
            for index, name in enumerate(component_names)
            if learned_weights[index] > 1e-8
        }

    def blended_scores(matrix: list[dict[str, float]], weights: dict[str, float]) -> list[float]:
        total = sum(max(0.0, number(value)) for value in weights.values()) or 1.0
        return [
            clamp(sum(max(0.0, number(weight)) * row.get(name, 0.5) for name, weight in weights.items()) / total, 0.0, 1.0)
            for row in matrix
        ]

    validation_rows = [train_rows[index] for index in validation_indexes]
    validation_matrix = [train_components[index] for index in validation_indexes]
    comparisons = []
    for name, weights in candidates.items():
        scores = blended_scores(validation_matrix, weights)
        scored_rows = [{**row, "selectionScore": scores[index]} for index, row in enumerate(validation_rows)]
        metrics = rank_ic_summary(scored_rows, score_key="selectionScore")
        objective = (
            (number(metrics.get("top10DirectionHitRatePct")) - 50.0) * 0.20
            + number(metrics.get("topDecileLift")) * 1.5
            + number(metrics.get("topDecileNetReturn")) * 0.5
            + number(metrics.get("rankIc")) * 3.0
            - number(metrics.get("maxDrawdownPct")) * 0.01
        )
        comparisons.append({"name": name, "weights": weights, "metrics": metrics, "objective": round(objective, 7)})
    baseline = next(row for row in comparisons if row["name"] == "rank-only")

    def admissible(candidate: dict[str, Any]) -> bool:
        if candidate["name"] == "rank-only":
            return True
        current = candidate["metrics"]
        base = baseline["metrics"]
        direction_gain = number(current.get("top10DirectionHitRatePct")) - number(base.get("top10DirectionHitRatePct"))
        return_gain = number(current.get("topDecileNetReturn")) - number(base.get("topDecileNetReturn"))
        lift_gain = number(current.get("topDecileLift")) - number(base.get("topDecileLift"))
        drawdown_change = number(current.get("maxDrawdownPct")) - number(base.get("maxDrawdownPct"))
        direction_case = direction_gain >= 0.50 and return_gain >= -0.02 and lift_gain >= -0.02 and drawdown_change <= 2.0
        return_case = return_gain >= 0.05 and direction_gain >= 0.0 and lift_gain >= 0.03 and drawdown_change <= 1.0
        return direction_case or return_case

    eligible = [row for row in comparisons if admissible(row)]
    selected = max(eligible, key=lambda row: number(row.get("objective"))) if eligible else baseline
    active = selected["name"] != "rank-only"
    test_scores = blended_scores(test_components, selected["weights"])
    return {
        "available": True,
        "active": active,
        "selected": selected["name"],
        "weights": {name: round(number(value), 6) for name, value in selected["weights"].items()},
        "reason": (
            "Activated only after improving the purged inner Top-K validation block without violating return, lift, or drawdown non-degradation gates."
            if active else
            "Rank-only remained the safest candidate on the purged inner validation block."
        ),
        "innerTrainDates": len(inner_training_dates),
        "innerValidationDates": len(validation_dates),
        "innerPurgeDates": validation_start - inner_purge_start,
        "comparisons": comparisons,
        "scores": test_scores,
        "policy": "Selection weights are chosen before the untouched meta-test and cannot create a probability; they only rank already eligible candidates.",
    }


def persist_oof_artifact(rows: list[dict[str, Any]], artifact_dir: str | None, model_version: str) -> dict[str, Any] | None:
    directory_text = str(artifact_dir or "").strip()
    if not directory_text or not rows:
        return None
    directory = Path(directory_text).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{''.join(char if char.isalnum() or char in '-_' else '_' for char in model_version)}-oof.jsonl.gz"
    target = directory / filename
    digest = hashlib.sha256()
    with gzip.open(target, "wt", encoding="utf-8") as handle:
        for row in rows:
            line = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
            handle.write(f"{line}\n")
            digest.update(line.encode("utf-8"))
    return {
        "format": "gzip-jsonl",
        "filename": filename,
        "rowCount": len(rows),
        "sha256": digest.hexdigest(),
        "schema": [
            "date", "symbol", "market", "horizon", "actualTarget", "actualStop", "actualTimeout", "actualDirection", "actualReturn",
            *MODEL_OUTPUT_KEYS, *DIRECTION_OUTPUT_KEYS, "ensembleProbability", "directionProbability", "selectionScore", "targetProbability", "stopProbability", "timeoutProbability",
            "quantileP10", "quantileP50", "quantileP90", "conformalP10", "conformalP90", "regime", "sector", "liquidityWeight", "fold",
        ],
    }


def calibration_metrics(
    rows: list[dict[str, Any]],
    probabilities: list[float],
    *,
    bins: int = 10,
    actual_key: str = "actualTarget",
) -> dict[str, Any]:
    if not rows:
        return {"samples": 0, "brier": None, "brierSkillScore": None, "ecePct": None, "calibrationSlope": None, "reliabilityCurve": []}
    actuals = [number(row[actual_key]) for row in rows]
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total_weight = sum(weights) or 1.0
    base_rate = sum(actuals[index] * weights[index] for index in range(len(rows))) / total_weight
    model_brier = brier(rows, probabilities=probabilities, actual_key=actual_key)
    baseline_brier = sum((base_rate - actuals[index]) ** 2 * weights[index] for index in range(len(rows))) / total_weight
    curve = []
    ece = 0.0
    for bucket in range(bins):
        low = bucket / bins
        high = (bucket + 1) / bins
        indexes = [index for index, value in enumerate(probabilities) if low <= value < high or (bucket == bins - 1 and value == 1.0)]
        if not indexes:
            continue
        bucket_weight = sum(weights[index] for index in indexes) or 1.0
        predicted = sum(probabilities[index] * weights[index] for index in indexes) / bucket_weight
        actual = sum(actuals[index] * weights[index] for index in indexes) / bucket_weight
        ece += abs(predicted - actual) * bucket_weight / total_weight
        curve.append({"bucket": f"{int(low * 100)}-{int(high * 100)}", "count": len(indexes), "predictedPct": round(predicted * 100, 4), "actualPct": round(actual * 100, 4)})
    slope_model = fit_platt(probabilities, actuals)
    ordered = sorted(range(len(rows)), key=lambda index: probabilities[index], reverse=True)
    top_count = max(1, math.ceil(len(rows) * 0.10))
    top = ordered[:top_count]
    top_return = sum(number(rows[index]["actualReturn"]) for index in top) / len(top)
    all_return = sum(number(row["actualReturn"]) for row in rows) / len(rows)
    top_target = sum(actuals[index] for index in top) / len(top) * 100.0
    actual_rates = [number(row.get("actualPct")) for row in curve]
    monotonic_inversions = sum(1 for index in range(1, len(actual_rates)) if actual_rates[index] + 3.0 < actual_rates[index - 1])
    predicted_classes = [1 if probability >= 0.5 else 0 for probability in probabilities]
    actual_classes = [1 if actual >= 0.5 else 0 for actual in actuals]
    tp = sum(1 for predicted, actual in zip(predicted_classes, actual_classes) if predicted == actual == 1)
    tn = sum(1 for predicted, actual in zip(predicted_classes, actual_classes) if predicted == actual == 0)
    fp = sum(1 for predicted, actual in zip(predicted_classes, actual_classes) if predicted == 1 and actual == 0)
    fn = sum(1 for predicted, actual in zip(predicted_classes, actual_classes) if predicted == 0 and actual == 1)
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    specificity = tn / max(1, tn + fp)
    f1 = 2.0 * precision * recall / max(1e-12, precision + recall)
    mcc_denominator = math.sqrt(max(1e-12, (tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)))
    mcc = (tp * tn - fp * fn) / mcc_denominator
    selective_count = max(1, math.ceil(len(rows) * 0.10))
    selective_indexes = sorted(
        range(len(rows)),
        key=lambda index: abs(probabilities[index] - 0.5),
        reverse=True,
    )[:selective_count]
    selective_correct = sum(predicted_classes[index] == actual_classes[index] for index in selective_indexes)
    selective_accuracy = selective_correct / max(1, selective_count)
    grouped_correct: dict[str, list[float]] = defaultdict(list)
    for index in selective_indexes:
        grouped_correct[str(rows[index].get("date") or "unknown")].append(float(predicted_classes[index] == actual_classes[index]))
    date_scores = [(day, sum(values) / len(values)) for day, values in sorted(grouped_correct.items())]
    week_blocks: dict[str, list[float]] = defaultdict(list)
    for day, score in date_scores:
        try:
            parsed_day = date.fromisoformat(day[:10])
            iso = parsed_day.isocalendar()
            key = f"{iso.year}-W{iso.week:02d}"
        except ValueError:
            key = day
        week_blocks[key].append(score)
    blocks = [sum(values) / len(values) for _, values in sorted(week_blocks.items())]
    if len(blocks) < 8:
        blocks = [score for _, score in date_scores]
    bootstrap_values = []
    if blocks:
        generator = random.Random(20260810)
        for _ in range(600):
            sample = [blocks[generator.randrange(len(blocks))] for _ in blocks]
            bootstrap_values.append(sum(sample) / len(sample))
    bootstrap_values.sort()
    selective_lower = bootstrap_values[max(0, int(len(bootstrap_values) * 0.025) - 1)] if bootstrap_values else 0.0
    probability_mean = sum(probabilities) / len(probabilities)
    probability_std = math.sqrt(sum((value - probability_mean) ** 2 for value in probabilities) / max(1, len(probabilities)))
    occupied_buckets = len(curve)
    positive_prediction_rate = sum(predicted_classes) / len(predicted_classes)
    probability_resolution_passed = (
        occupied_buckets >= 4
        and probability_std >= 0.03
        and 0.02 < positive_prediction_rate < 0.98
        and precision > 0.0 and recall > 0.0 and f1 > 0.0
    )
    return {
        "samples": len(rows),
        "testDates": len({row["date"] for row in rows}),
        "brier": round(model_brier, 6),
        "baselineBrier": round(baseline_brier, 6),
        "brierSkillScore": round(1.0 - model_brier / baseline_brier, 6) if baseline_brier > 1e-12 else None,
        "ecePct": round(ece * 100.0, 5),
        "calibrationSlope": round(number(slope_model["slope"]), 5),
        "calibrationIntercept": round(number(slope_model["intercept"]), 5),
        "accuracyPct": round((tp + tn) / max(1, len(actual_classes)) * 100.0, 5),
        "balancedAccuracyPct": round((recall + specificity) / 2.0 * 100.0, 5),
        "precisionPct": round(precision * 100.0, 5),
        "recallPct": round(recall * 100.0, 5),
        "f1Pct": round(f1 * 100.0, 5),
        "matthewsCorrelation": round(mcc, 6),
        "selectiveTop10CoveragePct": round(selective_count / max(1, len(rows)) * 100.0, 5),
        "selectiveTop10AccuracyPct": round(selective_accuracy * 100.0, 5),
        "selectiveTop10Accuracy95LowerPct": round(selective_lower * 100.0, 5),
        "selectiveTop10IndependentBlocks": len(blocks),
        "selectiveTop10CiMethod": "date/week-block-bootstrap-600",
        "confusionMatrix": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        "topDecileTargetRate": round(top_target, 4),
        "topDecileNetReturn": round(top_return, 5),
        "allSampleNetReturn": round(all_return, 5),
        "topDecileLift": round(top_return - all_return, 5),
        "probabilityBucketMinCount": min((int(row["count"]) for row in curve), default=0),
        "occupiedProbabilityBuckets": occupied_buckets,
        "probabilityStd": round(probability_std, 7),
        "positivePredictionRatePct": round(positive_prediction_rate * 100.0, 5),
        "probabilityResolutionPassed": probability_resolution_passed,
        "reliabilityMonotonic": monotonic_inversions <= 1,
        "reliabilityInversions": monotonic_inversions,
        "reliabilityCurve": curve,
    }


def expected_value_summary(rows: list[dict[str, Any]], probabilities: list[float]) -> dict[str, Any]:
    if not rows:
        return {"available": False}
    p_target = sum(probabilities) / len(probabilities)
    p_stop = sum(number(row.get("stopProbability")) for row in rows) / len(rows)
    p_timeout = sum(number(row.get("timeoutProbability")) for row in rows) / len(rows)
    probability_total = max(1e-12, p_target + p_stop + p_timeout)
    p_target, p_stop, p_timeout = (p_target / probability_total, p_stop / probability_total, p_timeout / probability_total)
    target_return = sum(number(row.get("targetBarrierPct")) for row in rows) / len(rows)
    stop_loss = sum(number(row.get("stopBarrierPct")) for row in rows) / len(rows)
    timeout_rows = [row for row in rows if number(row.get("actualTimeout")) >= 0.5]
    timeout_return = sum(number(row.get("actualGrossReturn", row.get("actualReturn"))) for row in timeout_rows) / max(1, len(timeout_rows))
    costs = sum(number(row.get("transactionCostBps"), MARKET_COST_BPS.get(str(row.get("market")), 18.0)) for row in rows) / len(rows) / 100.0
    value = p_target * target_return - p_stop * stop_loss + p_timeout * timeout_return - costs
    return {
        "available": True,
        "expectedValuePct": round(value, 5),
        "targetProbability": round(p_target * 100, 4),
        "stopProbability": round(p_stop * 100, 4),
        "timeoutProbability": round(p_timeout * 100, 4),
        "targetNetReturnPct": round(target_return, 4),
        "stopNetLossPct": round(stop_loss, 4),
        "timeoutExpectedReturnPct": round(timeout_return, 4),
        "roundTripCostPct": round(costs, 4),
        "formula": "P(target)*targetNet - P(stop)*stopLoss + P(timeout)*timeoutExpectedReturn - fees - slippage",
    }


def _long_signal_metrics(
    rows: list[dict[str, Any]],
    direction_probabilities: list[float],
    target_probabilities: list[float],
    threshold: float,
) -> dict[str, Any]:
    indexes = [
        index for index, probability in enumerate(direction_probabilities)
        if number(probability) >= threshold
    ]
    selected = [rows[index] for index in indexes]
    selected_target_probabilities = [target_probabilities[index] for index in indexes]
    if not selected:
        return {
            "available": False,
            "threshold": round(threshold, 4),
            "signalCount": 0,
            "signalDates": 0,
            "selectedIndexes": [],
        }
    hits = [float(number(row.get("actualDirection")) >= 0.5) for row in selected]
    grouped: dict[str, list[float]] = defaultdict(list)
    daily_returns: dict[str, list[float]] = defaultdict(list)
    fold_rows: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row, hit in zip(selected, hits):
        day = str(row.get("date") or "unknown")
        grouped[day].append(hit)
        daily_returns[day].append(number(row.get("actualReturn")))
        fold_rows[int(row.get("fold") or 0)].append(row)
    week_blocks: dict[str, list[float]] = defaultdict(list)
    for day, values in sorted(grouped.items()):
        score = sum(values) / len(values)
        try:
            parsed_day = date.fromisoformat(day[:10])
            iso = parsed_day.isocalendar()
            block = f"{iso.year}-W{iso.week:02d}"
        except ValueError:
            block = day
        week_blocks[block].append(score)
    blocks = [sum(values) / len(values) for _, values in sorted(week_blocks.items())]
    if len(blocks) < 8:
        blocks = [sum(values) / len(values) for _, values in sorted(grouped.items())]
    bootstrap = []
    if blocks:
        generator = random.Random(20260811)
        for _ in range(600):
            sample = [blocks[generator.randrange(len(blocks))] for _ in blocks]
            bootstrap.append(sum(sample) / len(sample))
    bootstrap.sort()
    lower = bootstrap[max(0, int(len(bootstrap) * 0.025) - 1)] if bootstrap else 0.0
    fold_evidence = []
    for fold, fold_items in sorted(fold_rows.items()):
        fold_hit = sum(float(number(row.get("actualDirection")) >= 0.5) for row in fold_items) / len(fold_items)
        fold_return = sum(number(row.get("actualReturn")) for row in fold_items) / len(fold_items)
        fold_evidence.append({
            "fold": fold,
            "signals": len(fold_items),
            "directionHitRatePct": round(fold_hit * 100.0, 5),
            "meanNetReturnPct": round(fold_return, 5),
            "positive": len(fold_items) >= 20 and fold_hit > 0.50 and fold_return > 0,
        })
    cumulative = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for day in sorted(daily_returns):
        daily_return = sum(daily_returns[day]) / len(daily_returns[day])
        cumulative *= 1.0 + daily_return / 100.0
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, (peak - cumulative) / max(1e-12, peak) * 100.0)
    expected = expected_value_summary(selected, selected_target_probabilities)
    return {
        "available": True,
        "threshold": round(threshold, 4),
        "signalCount": len(selected),
        "signalDates": len(grouped),
        "coveragePct": round(len(selected) / max(1, len(rows)) * 100.0, 5),
        "directionHitRatePct": round(sum(hits) / len(hits) * 100.0, 5),
        "directionHitRate95LowerPct": round(lower * 100.0, 5),
        "ciMethod": "date/week-block-bootstrap-600",
        "targetFirstRatePct": round(sum(number(row.get("actualTarget")) for row in selected) / len(selected) * 100.0, 5),
        "meanNetReturnPct": round(sum(number(row.get("actualReturn")) for row in selected) / len(selected), 5),
        "maxDrawdownPct": round(max_drawdown, 5),
        "positiveFoldCount": sum(1 for row in fold_evidence if row["positive"]),
        "foldCount": len(fold_evidence),
        "foldEvidence": fold_evidence,
        "expectedValue": expected,
        "selectedIndexes": indexes,
    }


def fit_long_trade_gate(
    train_rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
    train_direction_probabilities: list[float],
    test_direction_probabilities: list[float],
    train_target_probabilities: list[float],
    test_target_probabilities: list[float],
) -> dict[str, Any]:
    """Learn a long-only rejection threshold before reading test outcomes."""
    candidates = []
    for step in range(50, 81):
        threshold = step / 100.0
        metrics = _long_signal_metrics(
            train_rows,
            train_direction_probabilities,
            train_target_probabilities,
            threshold,
        )
        expected_value = number((metrics.get("expectedValue") or {}).get("expectedValuePct"), -1.0)
        stable_folds = int(metrics.get("positiveFoldCount") or 0)
        qualified = (
            metrics.get("available") is True
            and int(metrics.get("signalCount") or 0) >= 200
            and int(metrics.get("signalDates") or 0) >= 120
            and number(metrics.get("directionHitRatePct")) >= 55.0
            and number(metrics.get("directionHitRate95LowerPct")) > 50.0
            and number(metrics.get("meanNetReturnPct")) > 0
            and expected_value > 0
            and stable_folds >= 3
        )
        objective = (
            number(metrics.get("directionHitRatePct"))
            + number(metrics.get("directionHitRate95LowerPct")) * 0.20
            + min(2.0, max(-2.0, number(metrics.get("meanNetReturnPct")))) * 0.50
            + stable_folds * 0.10
        )
        candidates.append({
            "threshold": round(threshold, 4),
            "qualified": qualified,
            "objective": round(objective, 6),
            "metrics": {key: value for key, value in metrics.items() if key != "selectedIndexes"},
        })
    eligible = [row for row in candidates if row["qualified"]]
    if not eligible:
        return {
            "available": True,
            "active": False,
            "reason": "No long-only threshold met the minimum train-only sample, stability, calibration, and net-return gates.",
            "candidates": candidates,
            "eligibleIndexes": [],
        }
    selected = max(eligible, key=lambda row: (number(row["objective"]), -number(row["threshold"])))
    test_metrics = _long_signal_metrics(
        test_rows,
        test_direction_probabilities,
        test_target_probabilities,
        number(selected["threshold"]),
    )
    test_expected_value = number((test_metrics.get("expectedValue") or {}).get("expectedValuePct"), -1.0)
    holdout_passed = (
        test_metrics.get("available") is True
        and int(test_metrics.get("signalCount") or 0) >= 200
        and int(test_metrics.get("signalDates") or 0) >= 80
        and number(test_metrics.get("directionHitRatePct")) >= 57.0
        and number(test_metrics.get("directionHitRate95LowerPct")) > 50.0
        and number(test_metrics.get("meanNetReturnPct")) > 0
        and test_expected_value > 0
        and int(test_metrics.get("positiveFoldCount") or 0) >= 2
    )
    return {
        "available": True,
        "active": holdout_passed,
        "threshold": selected["threshold"],
        "reason": (
            "Threshold passed the earlier OOF selection window and the untouched holdout activation gates."
            if holdout_passed
            else "Threshold passed the earlier OOF selection window but failed untouched holdout activation; all long signals remain No Trade."
        ),
        "trainingEvidence": selected["metrics"],
        "testEvidence": {key: value for key, value in test_metrics.items() if key != "selectedIndexes"},
        "candidateCount": len(candidates),
        "qualifiedCandidateCount": len(eligible),
        "eligibleIndexes": list(test_metrics.get("selectedIndexes") or []) if holdout_passed else [],
        "policy": "The train window chooses a threshold; only an untouched holdout pass can activate it. The gate can reject a buy signal but cannot raise its probability or create a trade.",
    }


def fit_false_positive_risk_head(
    train_rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
    train_probabilities: list[float],
    test_probabilities: list[float],
) -> dict[str, Any]:
    """Fit a strictly nested gate that may only reduce high-confidence direction scores."""
    if len(train_rows) < 300 or len(test_rows) < 100:
        return {
            "available": False,
            "active": False,
            "reason": "False-positive risk head requires at least 300 meta-train and 100 untouched meta-test rows.",
            "probabilities": test_probabilities,
        }
    ordered_dates = sorted({str(row.get("date") or "") for row in train_rows})
    validation_start = max(1, int(len(ordered_dates) * 0.75))
    inner_purge_start = max(0, validation_start - 12)
    inner_training_dates = set(ordered_dates[:inner_purge_start])
    validation_dates = set(ordered_dates[validation_start:])
    inner_train_indexes = [index for index, row in enumerate(train_rows) if str(row.get("date") or "") in inner_training_dates]
    inner_validation_indexes = [index for index, row in enumerate(train_rows) if str(row.get("date") or "") in validation_dates]
    if len(inner_train_indexes) < 200 or len(inner_validation_indexes) < 60:
        return {
            "available": False,
            "active": False,
            "reason": "False-positive risk head lacks an independent inner validation date block.",
            "probabilities": test_probabilities,
        }
    ordered = sorted(clamp(train_probabilities[index], 0.001, 0.999) for index in inner_train_indexes)
    threshold = ordered[min(len(ordered) - 1, max(0, int(len(ordered) * 0.75)))]
    candidate_indexes = [index for index in inner_train_indexes if train_probabilities[index] >= threshold]
    false_count = sum(1 for index in candidate_indexes if number(train_rows[index].get("actualDirection")) < 0.5)
    true_count = len(candidate_indexes) - false_count
    if len(candidate_indexes) < 80 or min(false_count, true_count) < 20:
        return {
            "available": False,
            "active": False,
            "reason": "High-confidence OOF candidates do not yet contain enough true and false outcomes for a stable risk head.",
            "candidateRows": len(candidate_indexes),
            "falsePositiveRows": false_count,
            "truePositiveRows": true_count,
            "threshold": round(threshold, 6),
            "probabilities": test_probabilities,
        }

    def mapped(row: dict[str, Any], probability: float, target: float | None = None) -> dict[str, Any]:
        features = list(row.get("falsePositiveFeatures") or row.get("x") or [])
        direction_outputs = [
            _model_value(row, name)
            for name in DIRECTION_OUTPUT_KEYS
            if row.get(name) is not None
        ]
        direction_mean = sum(direction_outputs) / max(1, len(direction_outputs))
        direction_disagreement = math.sqrt(
            sum((value - direction_mean) ** 2 for value in direction_outputs) / max(1, len(direction_outputs))
        ) if direction_outputs else 0.0
        features.extend([
            clamp(probability, 0.001, 0.999),
            number(row.get("liquidityWeight"), 1.0),
            number(row.get("dataQuality"), 0.0),
            _model_value(row, "rankerPrediction"),
            _model_value(row, "targetProbability"),
            _model_value(row, "stopProbability"),
            number(row.get("quantileP50")),
            max(0.0, number(row.get("quantileP90")) - number(row.get("quantileP10"))),
            direction_disagreement,
        ])
        value = {**row, "x": features}
        if target is not None:
            value["falsePositiveTarget"] = target
        return value

    training = [
        mapped(
            train_rows[index],
            train_probabilities[index],
            1.0 if number(train_rows[index].get("actualDirection")) < 0.5 else 0.0,
        )
        for index in candidate_indexes
    ]
    model = fit_logistic(training, "falsePositiveTarget", 0.28, epochs=70)
    validation_rows = [train_rows[index] for index in inner_validation_indexes]
    validation_probabilities = [train_probabilities[index] for index in inner_validation_indexes]
    risk_validation = [
        predict_logistic(model, mapped(train_rows[index], train_probabilities[index])["x"])
        for index in inner_validation_indexes
    ]
    adjusted_validation = [
        clamp(
            probability * (1.0 - max(0.0, risk_validation[index] - 0.5) * 0.70)
            if probability >= threshold else probability,
            0.001,
            0.999,
        )
        for index, probability in enumerate(validation_probabilities)
    ]
    base_metrics = calibration_metrics(validation_rows, validation_probabilities, actual_key="actualDirection")
    adjusted_metrics = calibration_metrics(validation_rows, adjusted_validation, actual_key="actualDirection")
    top_gain = number(adjusted_metrics.get("selectiveTop10AccuracyPct")) - number(base_metrics.get("selectiveTop10AccuracyPct"))
    brier_gain = number(adjusted_metrics.get("brierSkillScore"), -1.0) - number(base_metrics.get("brierSkillScore"), -1.0)
    balanced_change = number(adjusted_metrics.get("balancedAccuracyPct")) - number(base_metrics.get("balancedAccuracyPct"))
    active = top_gain >= 1.0 and brier_gain >= -0.005 and balanced_change >= -1.0
    final_probabilities = list(test_probabilities)
    if active:
        all_candidates = [index for index, value in enumerate(train_probabilities) if value >= threshold]
        final_training = [
            mapped(
                train_rows[index],
                train_probabilities[index],
                1.0 if number(train_rows[index].get("actualDirection")) < 0.5 else 0.0,
            )
            for index in all_candidates
        ]
        final_model = fit_logistic(final_training, "falsePositiveTarget", 0.28, epochs=70)
        final_risk = [
            predict_logistic(final_model, mapped(row, test_probabilities[index])["x"])
            for index, row in enumerate(test_rows)
        ]
        final_probabilities = [
            clamp(
                probability * (1.0 - max(0.0, final_risk[index] - 0.5) * 0.70)
                if probability >= threshold else probability,
                0.001,
                0.999,
            )
            for index, probability in enumerate(test_probabilities)
        ]
    return {
        "available": True,
        "active": active,
        "reason": (
            "Activated because the purged inner validation block improved Top-10 accuracy without material Brier or balanced-accuracy degradation; the final meta-test remained untouched."
            if active else
            "Retained as a dormant Challenger because it did not improve the purged inner validation block under the non-degradation gates; the final meta-test remained untouched."
        ),
        "candidateRows": len(candidate_indexes),
        "falsePositiveRows": false_count,
        "truePositiveRows": true_count,
        "threshold": round(threshold, 6),
        "innerTrainDates": len({str(train_rows[index].get("date")) for index in inner_train_indexes}),
        "innerValidationDates": len(validation_dates),
        "innerPurgeDates": validation_start - inner_purge_start,
        "top10AccuracyGainPct": round(top_gain, 6),
        "brierSkillGain": round(brier_gain, 7),
        "balancedAccuracyChangePct": round(balanced_change, 6),
        "baseMetrics": base_metrics,
        "adjustedMetrics": adjusted_metrics,
        "probabilities": final_probabilities,
        "policy": "The risk head may only lower a high-confidence score or trigger No Trade; it can never raise a buy probability.",
    }


def diagnostic_bucket_summary(rows: list[dict[str, Any]], probabilities: list[float]) -> dict[str, Any]:
    if not rows:
        return {"available": False}
    liquidity = sorted(number(row.get("liquidityWeight")) for row in rows)
    def quantile(ratio: float) -> float:
        return liquidity[min(len(liquidity) - 1, max(0, int((len(liquidity) - 1) * ratio)))]
    q1, q2, q3 = quantile(0.25), quantile(0.50), quantile(0.75)
    def liquidity_bucket(row: dict[str, Any]) -> str:
        value = number(row.get("liquidityWeight"))
        return "Q1-low" if value <= q1 else "Q2" if value <= q2 else "Q3" if value <= q3 else "Q4-high"
    definitions = {
        "year": lambda row: str(row.get("date") or "")[:4] or "unknown",
        "regime": lambda row: str(row.get("regime") or "unknown"),
        "sector": lambda row: str(row.get("sector") or "Unknown")[:80],
        "liquidity": liquidity_bucket,
    }
    output: dict[str, list[dict[str, Any]]] = {}
    for family, selector in definitions.items():
        groups: dict[str, list[int]] = defaultdict(list)
        for index, row in enumerate(rows):
            groups[selector(row)].append(index)
        output[family] = []
        for label, indexes in sorted(groups.items()):
            if len(indexes) < 10:
                continue
            selected_rows = [rows[index] for index in indexes]
            selected_probabilities = [probabilities[index] for index in indexes]
            metrics = calibration_metrics(selected_rows, selected_probabilities, bins=5, actual_key="actualDirection")
            output[family].append({
                "bucket": label,
                "samples": len(indexes),
                "dates": len({row.get("date") for row in selected_rows}),
                "accuracyPct": metrics.get("accuracyPct"),
                "balancedAccuracyPct": metrics.get("balancedAccuracyPct"),
                "brier": metrics.get("brier"),
                "brierSkillScore": metrics.get("brierSkillScore"),
                "ecePct": metrics.get("ecePct"),
                "averageNetReturnPct": round(sum(number(row.get("actualReturn")) for row in selected_rows) / len(selected_rows), 6),
            })
    top_count = max(1, math.ceil(len(rows) * 0.10))
    top_indexes = sorted(range(len(rows)), key=lambda index: probabilities[index], reverse=True)[:top_count]
    false_positive_indexes = [index for index in top_indexes if number(rows[index].get("actualDirection")) < 0.5]
    true_positive_indexes = [index for index in top_indexes if number(rows[index].get("actualDirection")) >= 0.5]
    uses_false_positive_vector = any(row.get("falsePositiveFeatures") for row in rows)
    feature_names = FALSE_POSITIVE_FEATURE_NAMES if uses_false_positive_vector else _feature_names_for_row(rows[0])
    vector_key = "falsePositiveFeatures" if uses_false_positive_vector else "x"
    feature_deltas = []
    for feature_index, feature_name in enumerate(feature_names):
        false_values = [number(rows[index].get(vector_key, [])[feature_index]) for index in false_positive_indexes if feature_index < len(rows[index].get(vector_key) or [])]
        comparison_values = [number(rows[index].get(vector_key, [])[feature_index]) for index in true_positive_indexes if feature_index < len(rows[index].get(vector_key) or [])]
        if not false_values or not comparison_values:
            continue
        feature_deltas.append({
            "feature": feature_name,
            "falsePositiveMean": round(sum(false_values) / len(false_values), 6),
            "truePositiveMean": round(sum(comparison_values) / len(comparison_values), 6),
            "difference": round(sum(false_values) / len(false_values) - sum(comparison_values) / len(comparison_values), 6),
        })
    feature_deltas.sort(key=lambda row: abs(number(row.get("difference"))), reverse=True)
    false_positive_library = {
        "status": "evidence_library",
        "activeRiskHead": False,
        "reason": "Top-decile OOF false positives are retained for a future strictly nested risk head; this library cannot create or raise a buy signal.",
        "topSignalCount": top_count,
        "falsePositiveCount": len(false_positive_indexes),
        "falsePositiveRatePct": round(len(false_positive_indexes) / top_count * 100.0, 5),
        "featureDeltas": feature_deltas[:20],
        "items": [
            {
                "date": rows[index].get("date"),
                "symbol": rows[index].get("symbol"),
                "probability": round(probabilities[index], 6),
                "actualReturn": round(number(rows[index].get("actualReturn")), 6),
                "regime": rows[index].get("regime"),
                "sector": rows[index].get("sector"),
                "liquidityWeight": round(number(rows[index].get("liquidityWeight")), 6),
                "dataQuality": round(number(rows[index].get("dataQuality")), 4),
            }
            for index in false_positive_indexes[:50]
        ],
    }
    return {
        "available": True,
        "liquidityThresholds": [round(q1, 6), round(q2, 6), round(q3, 6)],
        "buckets": output,
        "highConfidenceFalsePositiveLibrary": false_positive_library,
    }


def feature_family_ablation(rows: list[dict[str, Any]], test_dates: set[str], *, horizon: int, embargo_days: int) -> dict[str, Any]:
    if not rows or not test_dates:
        return {"available": False, "reason": "No untouched test dates."}
    feature_names = _feature_names_for_row(rows[0])
    all_dates = sorted({str(row.get("date") or "") for row in rows})
    first_test = min(test_dates)
    try:
        test_start = all_dates.index(first_test)
    except ValueError:
        return {"available": False, "reason": "Test dates are absent from the feature matrix."}
    train_dates = set(all_dates[:max(0, test_start - max(1, horizon) - max(0, embargo_days))])
    train = _evenly_spaced_rows([row for row in rows if str(row.get("date")) in train_dates], 4_000)
    test = _evenly_spaced_rows([row for row in rows if str(row.get("date")) in test_dates], 4_000)
    if len(train) < 500 or len(test) < 100:
        return {"available": False, "reason": "Ablation requires at least 500 chronological train rows and 100 untouched test rows.", "trainRows": len(train), "testRows": len(test)}
    def mapped(selected_indexes: list[int], source: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{**row, "x": [number(row.get("x", [])[index]) for index in selected_indexes]} for row in source]
    def evaluate(selected_indexes: list[int]) -> dict[str, Any]:
        mapped_train = mapped(selected_indexes, train)
        mapped_test = mapped(selected_indexes, test)
        model = fit_logistic(mapped_train, "actualDirection", 0.18, epochs=30)
        probabilities = [predict_logistic(model, row["x"]) for row in mapped_test]
        return calibration_metrics(mapped_test, probabilities, bins=5, actual_key="actualDirection")
    all_indexes = list(range(len(feature_names)))
    baseline = evaluate(all_indexes)
    families = []
    for family, names in FEATURE_FAMILIES.items():
        removed = [index for index, name in enumerate(feature_names) if name in names]
        retained = [index for index in all_indexes if index not in removed]
        if not removed or not retained:
            continue
        metrics = evaluate(retained)
        families.append({
            "family": family,
            "removedFeatures": [feature_names[index] for index in removed],
            "balancedAccuracyPct": metrics.get("balancedAccuracyPct"),
            "brier": metrics.get("brier"),
            "balancedAccuracyDeltaPct": round(number(metrics.get("balancedAccuracyPct")) - number(baseline.get("balancedAccuracyPct")), 6),
            "brierDelta": round(number(metrics.get("brier")) - number(baseline.get("brier")), 8),
            "interpretation": "Negative accuracy delta and positive Brier delta mean this feature family added out-of-sample value.",
        })
    return {
        "available": True,
        "framework": "chronological-heldout-feature-family-ablation",
        "trainRows": len(train),
        "testRows": len(test),
        "trainEnd": max(train_dates) if train_dates else None,
        "testStart": first_test,
        "purgeDays": max(1, horizon),
        "embargoDays": max(0, embargo_days),
        "baseline": {"balancedAccuracyPct": baseline.get("balancedAccuracyPct"), "brier": baseline.get("brier"), "brierSkillScore": baseline.get("brierSkillScore")},
        "families": families,
        "usedForProductionWeights": False,
    }


def direction_feature_importance_summary(
    rows: list[dict[str, Any]],
    fold_metrics: list[dict[str, Any]],
    feature_names: list[str],
) -> list[dict[str, Any]]:
    tree_values: dict[str, list[float]] = defaultdict(list)
    for fold in fold_metrics:
        for item in fold.get("directionFeatureImportance") or []:
            tree_values[str(item.get("feature") or "")].append(abs(number(item.get("importance"))))
    if tree_values:
        averaged = {name: sum(values) / len(values) for name, values in tree_values.items() if name and values}
        total = sum(averaged.values()) or 1.0
        return [
            {"feature": name, "importance": round(value / total, 7), "method": "mean-shallow-tree-importance"}
            for name, value in sorted(averaged.items(), key=lambda item: item[1], reverse=True)
        ]
    sample = _evenly_spaced_rows(rows, 50_000)
    if not sample:
        return []
    labels = [number(row.get("actualDirection")) for row in sample]
    label_mean = sum(labels) / len(labels)
    label_variance = sum((value - label_mean) ** 2 for value in labels)
    values = []
    for index, name in enumerate(feature_names):
        feature_values = [
            number(vector[index]) if index < len(vector) else 0.0
            for row in sample
            for vector in [row.get("x") or []]
        ]
        feature_mean = sum(feature_values) / len(feature_values)
        covariance = sum((feature_values[row_index] - feature_mean) * (labels[row_index] - label_mean) for row_index in range(len(sample)))
        feature_variance = sum((value - feature_mean) ** 2 for value in feature_values)
        correlation = covariance / math.sqrt(max(1e-12, feature_variance * label_variance))
        values.append((name, correlation))
    total = sum(abs(value) for _, value in values) or 1.0
    return [
        {"feature": name, "importance": round(abs(value) / total, 7), "direction": 1 if value >= 0 else -1, "method": "point-biserial-oof-training"}
        for name, value in sorted(values, key=lambda item: abs(item[1]), reverse=True)
    ]


def train_horizon_model(rows: list[dict[str, Any]], *, market: str, horizon: int, config: dict[str, Any]) -> dict[str, Any]:
    folds = purged_walk_forward_folds(
        rows,
        horizon=horizon,
        fold_count=int(config.get("foldCount", 5)),
        embargo_days=int(config.get("embargoDays", 7)),
        min_train_dates=int(config.get("minTrainDates", 500)),
        test_dates=int(config.get("testDates", 120)),
    )
    if not folds:
        return {"available": False, "horizon": horizon, "reason": "Not enough distinct dates for purged walk-forward OOF folds.", "rowCount": len(rows)}
    oof: list[dict[str, Any]] = []
    fold_metrics: list[dict[str, Any]] = []
    checkpoint_context = _fold_checkpoint_context(rows, folds, market=market, horizon=horizon, config=config)
    resumed_folds = 0
    for fold in folds:
        fold_index = int(fold.get("fold") or len(fold_metrics) + 1)
        restored = _load_fold_checkpoint(checkpoint_context, fold_index)
        if restored:
            predictions, metadata = restored
            resumed_folds += 1
        else:
            predictions, metadata = _fold_oof_predictions(
                fold,
                enable_tree_models=bool(config.get("enableTreeModels", False)),
                enable_sklearn_models=bool(config.get("enableSklearnModels", False)),
                config=config,
            )
            _save_fold_checkpoint(checkpoint_context, fold_index, predictions, metadata)
        fold_probability = [number(row["pathSafetyPrediction"]) for row in predictions]
        metric = calibration_metrics(predictions, fold_probability)
        direction_probability = [number(row["ridgeDirectionPrediction"]) for row in predictions]
        direction_metric = calibration_metrics(predictions, direction_probability, actual_key="actualDirection")
        oof.extend(predictions)
        fold_metrics.append({
            **metadata,
            "brierSkillScore": metric.get("brierSkillScore"),
            "ecePct": metric.get("ecePct"),
            "topDecileNetReturn": metric.get("topDecileNetReturn"),
            "directionBrierSkillScore": direction_metric.get("brierSkillScore"),
            "directionBalancedAccuracyPct": direction_metric.get("balancedAccuracyPct"),
            "directionF1Pct": direction_metric.get("f1Pct"),
            "positive": number(metric.get("topDecileNetReturn")) > 0 and number(direction_metric.get("brierSkillScore"), -1.0) > 0,
        })
    dates = sorted({row["date"] for row in oof})
    split_index = max(1, int(len(dates) * 0.65))
    meta_train_dates = set(dates[:split_index])
    purge_dates = set(dates[split_index:split_index + horizon + int(config.get("embargoDays", 7))])
    meta_train = [row for row in oof if row["date"] in meta_train_dates]
    meta_test = [row for row in oof if row["date"] not in meta_train_dates and row["date"] not in purge_dates]
    names = [name for name in MODEL_OUTPUT_KEYS if any(row.get(name) is not None for row in meta_train)]
    names, skill_pruned = brier_skilled_models(meta_train, names)
    names, correlation_pruned = prune_correlated_models(meta_train, names, float(config.get("maxResidualCorrelation", PRODUCTION_THRESHOLDS["maxResidualCorrelation"])))
    pruned = [*skill_pruned, *correlation_pruned]
    if len(names) < 1 or len(meta_train) < 30 or len(meta_test) < 20:
        return {"available": False, "horizon": horizon, "reason": "OOF rows exist, but the untouched meta split is too small for constrained stacking.", "rowCount": len(rows), "folds": fold_metrics}
    weights = fit_constrained_stack(meta_train, names, cap=float(config.get("maxModelWeight", PRODUCTION_THRESHOLDS["maxModelWeight"])))
    raw_train = ensemble_probabilities(meta_train, names, weights)
    raw_test = ensemble_probabilities(meta_test, names, weights)
    train_actuals = [number(row["actualTarget"]) for row in meta_train]
    calibrator = fit_probability_calibrator(
        raw_train,
        train_actuals,
        independent_dates=len(meta_train_dates),
        dates=[str(row["date"]) for row in meta_train],
    )
    calibrated_train = apply_probability_calibrator(calibrator, raw_train)
    calibrated_test = apply_probability_calibrator(calibrator, raw_test)
    direction_names = [name for name in DIRECTION_OUTPUT_KEYS if any(row.get(name) is not None for row in meta_train)]
    direction_names, direction_skill_pruned = brier_skilled_models(
        meta_train,
        direction_names,
        actual_key="actualDirection",
    )
    direction_names, direction_correlation_pruned = prune_correlated_models(
        meta_train,
        direction_names,
        float(config.get("maxResidualCorrelation", PRODUCTION_THRESHOLDS["maxResidualCorrelation"])),
        actual_key="actualDirection",
    )
    direction_names, direction_robust_pruned, direction_model_selection = select_robust_direction_models(
        meta_train,
        direction_names,
        purge_days=horizon + int(config.get("embargoDays", 7)),
    )
    direction_pruned = [*direction_skill_pruned, *direction_correlation_pruned, *direction_robust_pruned]
    direction_weights = fit_constrained_stack(
        meta_train,
        direction_names,
        cap=float(config.get("maxModelWeight", PRODUCTION_THRESHOLDS["maxModelWeight"])),
        actual_key="actualDirection",
    )
    raw_direction_train = ensemble_probabilities(meta_train, direction_names, direction_weights)
    raw_direction_test = ensemble_probabilities(meta_test, direction_names, direction_weights)
    direction_calibrator = fit_probability_calibrator(
        raw_direction_train,
        [number(row["actualDirection"]) for row in meta_train],
        independent_dates=len(meta_train_dates),
        dates=[str(row["date"]) for row in meta_train],
    )
    calibrated_direction_test = apply_probability_calibrator(direction_calibrator, raw_direction_test)
    calibrated_direction_train = apply_probability_calibrator(direction_calibrator, raw_direction_train)
    false_positive_risk_head = fit_false_positive_risk_head(
        meta_train,
        meta_test,
        calibrated_direction_train,
        calibrated_direction_test,
    )
    calibrated_direction_test = list(false_positive_risk_head.get("probabilities") or calibrated_direction_test)
    long_trade_gate = fit_long_trade_gate(
        meta_train,
        meta_test,
        calibrated_direction_train,
        calibrated_direction_test,
        calibrated_train,
        calibrated_test,
    )
    long_trade_indexes = set(long_trade_gate.get("eligibleIndexes") or [])
    selective_ranking_head = fit_selective_ranking_head(
        meta_train,
        meta_test,
        calibrated_direction_train,
        calibrated_direction_test,
        calibrated_train,
        calibrated_test,
    )
    selection_scores = list(selective_ranking_head.get("scores") or [_model_value(row, "rankerPrediction") for row in meta_test])
    conformal_quantiles = conformalize_quantiles(meta_train, meta_test)
    for index, row in enumerate(meta_test):
        row["ensembleProbability"] = calibrated_test[index]
        row["directionProbability"] = calibrated_direction_test[index]
        row["selectionScore"] = selection_scores[index]
        row["longTradeEligible"] = index in long_trade_indexes
    metrics = calibration_metrics(meta_test, calibrated_test)
    direction_metrics = calibration_metrics(meta_test, calibrated_direction_test, actual_key="actualDirection")
    model_comparison = []
    for name in direction_names:
        comparison_calibrator = fit_probability_calibrator(
            [_model_value(row, name) for row in meta_train],
            [number(row["actualDirection"]) for row in meta_train],
            independent_dates=len(meta_train_dates),
            dates=[str(row["date"]) for row in meta_train],
        )
        comparison_probabilities = apply_probability_calibrator(
            comparison_calibrator,
            [_model_value(row, name) for row in meta_test],
        )
        comparison_metrics = calibration_metrics(meta_test, comparison_probabilities, actual_key="actualDirection")
        model_comparison.append({
            "model": name,
            "calibrator": comparison_calibrator.get("method"),
            "samples": comparison_metrics.get("samples"),
            "balancedAccuracyPct": comparison_metrics.get("balancedAccuracyPct"),
            "accuracyPct": comparison_metrics.get("accuracyPct"),
            "f1Pct": comparison_metrics.get("f1Pct"),
            "brier": comparison_metrics.get("brier"),
            "brierSkillScore": comparison_metrics.get("brierSkillScore"),
            "ecePct": comparison_metrics.get("ecePct"),
        })
    model_comparison.sort(key=lambda row: (-number(row.get("brierSkillScore"), -10), -number(row.get("balancedAccuracyPct"), -1)))
    diagnostic_buckets = diagnostic_bucket_summary(meta_test, calibrated_direction_test)
    diagnostic_buckets["highConfidenceFalsePositiveRiskHead"] = {
        key: value for key, value in false_positive_risk_head.items() if key != "probabilities"
    }
    false_positive_library = diagnostic_buckets.get("highConfidenceFalsePositiveLibrary") or {}
    false_positive_library["activeRiskHead"] = false_positive_risk_head.get("active") is True
    false_positive_library["riskHeadReason"] = false_positive_risk_head.get("reason")
    diagnostic_buckets["highConfidenceFalsePositiveLibrary"] = false_positive_library
    ablation = (
        feature_family_ablation(
            rows,
            {str(row.get("date")) for row in meta_test},
            horizon=horizon,
            embargo_days=int(config.get("embargoDays", 7)),
        )
        if horizon == 5 and config.get("enableFeatureAblation", True)
        else {"available": False, "reason": "Feature-family ablation is reserved for the active 5-day production horizon."}
    )
    ranking = rank_ic_summary(meta_test, score_key="selectionScore")
    regime_diagnostics = {}
    for regime in sorted({str(row.get("regime") or "unknown") for row in meta_test}):
        indexes = [index for index, row in enumerate(meta_test) if str(row.get("regime") or "unknown") == regime]
        regime_diagnostics[regime] = calibration_metrics(
            [meta_test[index] for index in indexes],
            [calibrated_test[index] for index in indexes],
            bins=5,
        )
    expected_value = expected_value_summary(meta_test, calibrated_test)
    long_trade_expected_value = ((long_trade_gate.get("testEvidence") or {}).get("expectedValue") or {"available": False})
    marginal = []
    full_brier = brier(meta_test, probabilities=calibrated_test)
    for index, name in enumerate(names):
        reduced_names = [value for value in names if value != name]
        reduced_weights = [weights[position] for position, value in enumerate(names) if value != name]
        reduced_weights = project_capped_simplex(reduced_weights, max(0.5, float(config.get("maxModelWeight", 0.35))))
        reduced_train_raw = ensemble_probabilities(meta_train, reduced_names, reduced_weights)
        reduced_raw = ensemble_probabilities(meta_test, reduced_names, reduced_weights)
        reduced_calibrator = fit_probability_calibrator(
            reduced_train_raw,
            train_actuals,
            independent_dates=len(meta_train_dates),
            dates=[str(row["date"]) for row in meta_train],
        )
        reduced_calibrated = apply_probability_calibrator(reduced_calibrator, reduced_raw)
        marginal.append({"model": name, "brierGain": round(brier(meta_test, probabilities=reduced_calibrated) - full_brier, 7)})
    thresholds = {**PRODUCTION_THRESHOLDS, **(config.get("thresholds") or {})}
    positive_folds = sum(1 for row in fold_metrics if row.get("positive"))
    target_events = sum(1 for row in rows if row["actualTarget"] >= 0.5)
    stop_events = sum(1 for row in rows if row["actualStop"] >= 0.5)
    timeout_events = sum(1 for row in rows if row["actualTimeout"] >= 0.5)
    ambiguous_events = sum(1 for row in rows if row.get("ambiguousBarrierOrder"))
    event_counts = {"target": target_events, "stop": stop_events, "timeout": timeout_events, "ambiguous": ambiguous_events}
    production_checks = {
        "trainingRows": len(rows) >= int(thresholds["productionMinRows"]),
        "testRows": len(meta_test) >= int(thresholds["productionMinTestRows"]),
        "testDates": int(metrics.get("testDates") or 0) >= int(thresholds["productionMinTestDates"]),
        "targetEvents": target_events >= int(thresholds["productionMinTargetEvents"]),
        "stopEvents": stop_events >= int(thresholds["productionMinStopEvents"]),
        "foldCount": len(folds) >= int(thresholds["productionMinFolds"]),
        "positiveFolds": positive_folds >= int(thresholds["productionPositiveFolds"]),
        "brierSkill": number(metrics.get("brierSkillScore"), -1.0) > float(thresholds["minBrierSkill"]),
        "directionBrierSkill": number(direction_metrics.get("brierSkillScore"), -1.0) > float(thresholds["minBrierSkill"]),
        "directionBalancedAccuracy": number(direction_metrics.get("balancedAccuracyPct"), 0.0) > 50.0,
        "directionSelectiveHighConfidence": (
            long_trade_gate.get("active") is True
            and number((long_trade_gate.get("testEvidence") or {}).get("directionHitRatePct"), 0.0) >= 57.0
            and number((long_trade_gate.get("testEvidence") or {}).get("directionHitRate95LowerPct"), 0.0) > 50.0
        ),
        "longTradeSampleSupport": (
            int((long_trade_gate.get("testEvidence") or {}).get("signalCount") or 0) >= 200
            and int((long_trade_gate.get("testEvidence") or {}).get("signalDates") or 0) >= 80
        ),
        "longTradeNetReturn": number((long_trade_gate.get("testEvidence") or {}).get("meanNetReturnPct"), -1.0) > 0,
        "targetProbabilityResolution": metrics.get("probabilityResolutionPassed") is True,
        "directionProbabilityResolution": direction_metrics.get("probabilityResolutionPassed") is True,
        "ece": number(metrics.get("ecePct"), 100.0) <= float(thresholds["maxEcePct"]),
        "calibrationSlope": float(thresholds["minCalibrationSlope"]) <= number(metrics.get("calibrationSlope")) <= float(thresholds["maxCalibrationSlope"]),
        "topDecileLift": number(metrics.get("topDecileLift")) > 0,
        "topDecileAbsoluteReturn": number(metrics.get("topDecileNetReturn")) > 0,
        "expectedValuePositive": number(long_trade_expected_value.get("expectedValuePct"), -1.0) > 0,
        "rankIc": number(ranking.get("rankIc"), -1.0) > float(thresholds["minRankIc"]),
        "rankTopDecileLift": number(ranking.get("topDecileLift")) > 0,
        "rankTopDecileAbsoluteReturn": number(ranking.get("topDecileNetReturn")) > 0,
        "rankDrawdown": number(ranking.get("maxDrawdownPct"), 100.0) <= float(thresholds["maxTopDecileDrawdownPct"]),
        "probabilityBucketSupport": int(metrics.get("probabilityBucketMinCount") or 0) >= int(thresholds["minProbabilityBucketEvents"]),
        "reliabilityMonotonic": metrics.get("reliabilityMonotonic") is True,
        "conformalCoverage": not conformal_quantiles.get("available") or 70.0 <= number(conformal_quantiles.get("observedCoveragePct")) <= 95.0,
        "featureDrift": all(number((row.get("featureDrift") or {}).get("maxPsi"), 1.0) <= 0.40 for row in fold_metrics),
        "marginalGain": all(number(row.get("brierGain")) >= -0.001 for row in marginal),
    }
    production_evidence = all(production_checks.values())
    research_eligible = len(rows) >= int(thresholds["researchMinRows"]) and len(meta_test) >= 20
    deployment_status = "shadow" if research_eligible else "research"
    active_feature_names = _feature_names_for_row(rows[0]) if rows else list(CORE_TECHNICAL_FEATURE_NAMES)
    feature_importance = direction_feature_importance_summary(meta_train, fold_metrics, active_feature_names)
    version_basis = {
        "market": market,
        "horizon": horizon,
        "dates": [dates[0] if dates else None, dates[-1] if dates else None],
        "rows": len(rows),
        "features": active_feature_names,
        "weights": [round(value, 8) for value in weights],
        "directionWeights": [round(value, 8) for value in direction_weights],
        "calibrator": calibrator,
        "falsePositiveRiskHead": {
            key: value for key, value in false_positive_risk_head.items()
            if key not in {"probabilities", "baseMetrics", "adjustedMetrics"}
        },
        "longTradeGate": {
            "active": long_trade_gate.get("active") is True,
            "threshold": long_trade_gate.get("threshold"),
            "trainingEvidence": long_trade_gate.get("trainingEvidence"),
        },
        "selectiveRankingHead": {
            key: value for key, value in selective_ranking_head.items()
            if key not in {"scores", "comparisons"}
        },
    }
    model_version = f"{market.lower()}-{horizon}d-{stable_hash(version_basis, 12)}"
    for row in oof:
        row["modelVersion"] = model_version
        row["predictionId"] = stable_hash({
            "market": row.get("market"),
            "symbol": row.get("symbol"),
            "signalAt": row.get("signalAt") or row.get("date"),
            "horizon": horizon,
            "labelDefinition": "atr-adaptive-triple-barrier-next-session-entry-v2",
            "featureSchemaHash": stable_hash(active_feature_names),
            "modelVersion": model_version,
        }, 32)
        row.pop("falsePositiveFeatures", None)
    oof_artifact = persist_oof_artifact(oof, config.get("artifactDir"), model_version)
    return {
        "available": True,
        "horizon": horizon,
        "task": "market-level-multitask-target-stop-rank-quantile",
        "modelVersion": model_version,
        "deploymentStatus": deployment_status,
        "productionEvidencePassed": production_evidence,
        "productionActivationBlocked": True,
        "activationReason": "A newly trained candidate can enter Shadow only; Paper Champion requires 2-3 full live prediction cycles and Production requires explicit promotion.",
        "rowCount": len(rows),
        "oofRows": len(oof),
        "metaTrainRows": len(meta_train),
        "metaTestRows": len(meta_test),
        "eventCounts": event_counts,
        "models": names,
        "weights": {name: round(weights[index], 6) for index, name in enumerate(names)},
        "directionModels": direction_names,
        "directionWeights": {name: round(direction_weights[index], 6) for index, name in enumerate(direction_names)},
        "directionPrunedModels": direction_pruned,
        "directionModelSelection": direction_model_selection,
        "prunedModels": pruned,
        "residualCorrelations": [
            {"left": names[left], "right": names[right], "correlation": round(residual_correlation(meta_train, names[left], names[right]), 5)}
            for left in range(len(names)) for right in range(left + 1, len(names))
        ],
        "marginalContribution": marginal,
        "calibrator": {**calibrator, "version": f"{calibrator.get('method', 'platt')}-{stable_hash(calibrator, 10)}"},
        "directionCalibrator": {**direction_calibrator, "version": f"{direction_calibrator.get('method', 'platt')}-{stable_hash(direction_calibrator, 10)}"},
        "metrics": metrics,
        "directionMetrics": direction_metrics,
        "modelComparison": model_comparison,
        "diagnosticBuckets": diagnostic_buckets,
        "highConfidenceFalsePositiveRiskHead": {
            key: value for key, value in false_positive_risk_head.items() if key != "probabilities"
        },
        "longTradeGate": {
            key: value for key, value in long_trade_gate.items()
            if key not in {"eligibleIndexes", "candidates"}
        },
        "selectiveRankingHead": {
            key: value for key, value in selective_ranking_head.items() if key != "scores"
        },
        "featureAblation": ablation,
        "featureImportance": feature_importance,
        "rankingMetrics": ranking,
        "conformalQuantiles": conformal_quantiles,
        "regimeDiagnostics": regime_diagnostics,
        "expectedValue": expected_value,
        "longTradeExpectedValue": long_trade_expected_value,
        "foldMetrics": fold_metrics,
        "foldCheckpoint": {
            "enabled": checkpoint_context is not None,
            "signature": checkpoint_context.get("signature") if checkpoint_context else None,
            "completedFolds": len(fold_metrics),
            "resumedFolds": resumed_folds,
            "path": str(checkpoint_context.get("root")) if checkpoint_context else None,
        },
        "positiveFoldCount": positive_folds,
        "productionChecks": production_checks,
        "oofSchema": [
            "date", "symbol", "market", "horizon", "actualTarget", "actualStop", "actualDirection", "actualReturn",
            *MODEL_OUTPUT_KEYS, *DIRECTION_OUTPUT_KEYS, "ensembleProbability", "directionProbability", "targetProbability", "stopProbability", "timeoutProbability", "quantileP10", "quantileP50", "quantileP90",
            "selectionScore", "longTradeEligible", "regime", "sector", "liquidityWeight", "dataQuality", "fold",
        ],
        "oofPreview": oof[-40:],
        "oofArtifact": oof_artifact,
        "leakageControl": {
            "baseModels": "Every base prediction is generated by a model fitted only on earlier dates.",
            "metaModel": "The constrained stack reads only OOF predictions, never raw features.",
            "purge": horizon,
            "embargo": int(config.get("embargoDays", 7)),
            "entry": "next-session VWAP/open",
            "evaluationWeights": "future-path label confidence excluded",
        },
    }


def aggregate_dataset_profiles(profiles: list[dict[str, Any]], market: str) -> dict[str, Any]:
    if not profiles:
        return dataset_profile(
            [],
            market=market,
            item_count=0,
            source_names=[],
            source_rows=0,
            excluded_future_rows=0,
            join_violation_count=0,
            historical_universe_rows=0,
            corporate_action_rows=0,
            action_adjusted_rows=0,
        )
    raw_rows = sum(int(row.get("rawRows") or 0) for row in profiles)
    weighted_coverage = sum(number(row.get("pointInTimeCoveragePct")) * int(row.get("rawRows") or 0) for row in profiles) / max(1, raw_rows)
    starts = [(row.get("dateRange") or {}).get("start") for row in profiles if (row.get("dateRange") or {}).get("start")]
    ends = [(row.get("dateRange") or {}).get("end") for row in profiles if (row.get("dateRange") or {}).get("end")]
    per_horizon = {
        str((row.get("horizons") or [0])[0]): {
            "rawRows": int(row.get("rawRows") or 0),
            "effectiveWeightedRows": number(row.get("effectiveWeightedRows")),
            "independentDateBlocks": (row.get("independentDateBlocks") or {}).get(str((row.get("horizons") or [0])[0]), 0),
            "positiveEventCount": int(row.get("positiveEventCount") or 0),
            "stopEventCount": int(row.get("stopEventCount") or 0),
        }
        for row in profiles
    }
    target = MARKET_DATA_TARGETS.get(market, MARKET_DATA_TARGETS["ASX"])
    minimum_horizon_rows = min((row["rawRows"] for row in per_horizon.values()), default=0)
    pit_versions = sorted({str(row.get("pitDataVersion") or "").strip() for row in profiles if str(row.get("pitDataVersion") or "").strip()})
    return {
        "rawRows": raw_rows,
        "rawRowsPerHorizon": per_horizon,
        "effectiveWeightedRows": round(sum(number(row.get("effectiveWeightedRows")) for row in profiles), 3),
        "independentDateBlocks": {
            key: value["independentDateBlocks"] for key, value in per_horizon.items()
        },
        "positiveEventCount": sum(int(row.get("positiveEventCount") or 0) for row in profiles),
        "stopEventCount": sum(int(row.get("stopEventCount") or 0) for row in profiles),
        "symbolCount": max((int(row.get("symbolCount") or 0) for row in profiles), default=0),
        "sourceItemCount": max((int(row.get("sourceItemCount") or 0) for row in profiles), default=0),
        "dateCount": max((int(row.get("dateCount") or 0) for row in profiles), default=0),
        "dateRange": {"start": min(starts) if starts else None, "end": max(ends) if ends else None},
        "horizons": sorted(int(key) for key in per_horizon),
        "pointInTimeFeatureRows": sum(int(row.get("pointInTimeFeatureRows") or 0) for row in profiles),
        "pointInTimeCoveragePct": round(weighted_coverage, 4),
        "futureFeatureRowsExcluded": sum(int(row.get("futureFeatureRowsExcluded") or 0) for row in profiles),
        "pointInTimeJoinViolationCount": sum(int(row.get("pointInTimeJoinViolationCount") or 0) for row in profiles),
        "pointInTimeExcludedViolationCount": sum(int(row.get("pointInTimeExcludedViolationCount") or 0) for row in profiles),
        "pitDataVersion": pit_versions[0] if len(pit_versions) == 1 else stable_hash(pit_versions, 24) if pit_versions else None,
        "pitDataVersionCount": len(pit_versions),
        "duplicateRowsExcluded": sum(int(row.get("duplicateRowsExcluded") or 0) for row in profiles),
        "crossMarketRowsExcluded": sum(int(row.get("crossMarketRowsExcluded") or 0) for row in profiles),
        "historicalUniverseCoveragePct": min((number(row.get("historicalUniverseCoveragePct")) for row in profiles), default=0.0),
        "corporateActionCoveragePct": min((number(row.get("corporateActionCoveragePct")) for row in profiles), default=0.0),
        "adjustedPriceCoveragePct": min((number(row.get("adjustedPriceCoveragePct")) for row in profiles), default=0.0),
        "sources": sorted({source for row in profiles for source in row.get("sources") or []}),
        "activeFeatureNames": list(profiles[0].get("activeFeatureNames") or CORE_TECHNICAL_FEATURE_NAMES),
        "activeFeatureCount": int(profiles[0].get("activeFeatureCount") or len(CORE_TECHNICAL_FEATURE_NAMES)),
        "eventFeaturesEnabled": all(bool(row.get("eventFeaturesEnabled")) for row in profiles),
        "eventItemCoveragePct": min((number(row.get("eventItemCoveragePct")) for row in profiles), default=0.0),
        "marketPointInTimeFeaturesAvailable": all(bool(row.get("marketPointInTimeFeaturesAvailable")) for row in profiles),
        "eventFeatureActivationReason": profiles[0].get("eventFeatureActivationReason") or "insufficient-verified-pit",
        "featurePolicy": profiles[0].get("featurePolicy") or "Core low-redundancy feature set.",
        "firstStageTarget": target,
        "coverageVsTargetPct": round(min(100.0, minimum_horizon_rows / max(1, target["rows"]) * 100.0), 4),
        "sampleMeaning": profiles[0].get("sampleMeaning") or {},
        "memoryPolicy": "Each horizon is built, trained, and released separately so 5d/15d/30d rows are not retained in memory together.",
    }


def hydrate_verified_pit_from_data_lake(
    items: list[dict[str, Any]],
    *,
    market: str,
    root: Any,
    limit_per_symbol: int = 600,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Join verified PIT records inside Python so large event panels never cross IPC twice."""
    try:
        from .data_lake import read_pit_panel
    except ImportError:  # Direct script/test imports keep quant_core on sys.path.
        from data_lake import read_pit_panel

    key = str(market or "ASX").upper()

    def identity(value: Any) -> str:
        text = str(value or "").strip().upper()
        if key == "ASX" and text.endswith(".AX"):
            return text[:-3]
        if key == "CN" and text.endswith((".SS", ".SH", ".SZ")):
            return text.rsplit(".", 1)[0]
        return text

    symbols = [str(item.get("symbol") or "") for item in items if isinstance(item, dict) and item.get("symbol")]
    panel = read_pit_panel({
        "root": root,
        "market": key,
        "symbols": symbols,
        "datasets": ["financial_disclosures", "news", "social", "fundamentals", "macro", "corporate_actions", "universe"],
        "limit_per_symbol": max(1, min(2_000, int(limit_per_symbol or 600))),
        "broadcast_market_wide": False,
        "verified_only": True,
    })
    by_symbol = {identity(row.get("symbol")): row for row in panel.get("items") or [] if isinstance(row, dict)}
    hydrated = []
    covered_symbols = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        pit = by_symbol.get(identity(item.get("symbol"))) or {}
        features = list(pit.get("pointInTimeFeatures") or [])
        if features:
            covered_symbols += 1
        hydrated.append({
            **item,
            "pointInTimeFeatures": features,
            "universeHistory": list(pit.get("universeHistory") or []),
            "corporateActions": list(pit.get("corporateActions") or []),
            "pitCoverage": pit.get("coverage") or {},
            "pitDataVersion": panel.get("dataVersion"),
        })
    return hydrated, list(panel.get("marketPointInTimeFeatures") or []), {
        "available": panel.get("available") is True,
        "rows": int(panel.get("rows") or 0),
        "coveredSymbols": covered_symbols,
        "requestedSymbols": len(symbols),
        "marketFeatureRows": len(panel.get("marketPointInTimeFeatures") or []),
        "dataVersion": panel.get("dataVersion"),
        "verifiedOnly": panel.get("verifiedOnly") is True,
        "transport": "python-local-parquet",
    }


def train_market_multitask(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "ASX").upper()
    raw_horizons = payload.get("horizons") or payload.get("horizon_days") or payload.get("horizonDays") or [5, 15, 30]
    requested_horizons = sorted({max(1, int(number(value, 15))) for value in (raw_horizons if isinstance(raw_horizons, list) else [raw_horizons])})
    items = payload.get("items") or []
    market_point_in_time_features = payload.get("market_point_in_time_features", payload.get("marketPointInTimeFeatures")) or []
    pit_load = None
    if payload.get("load_pit_from_data_lake", payload.get("loadPitFromDataLake", False)) is True:
        items, market_point_in_time_features, pit_load = hydrate_verified_pit_from_data_lake(
            items,
            market=market,
            root=payload.get("data_lake_root", payload.get("dataLakeRoot")),
            limit_per_symbol=int(payload.get("pit_rows_per_symbol", payload.get("pitRowsPerSymbol", 600)) or 600),
        )
    panel_dates: dict[str, set[str]] = defaultdict(set)
    panel_symbols: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or (item.get("market") and str(item.get("market")).upper() != market):
            continue
        symbol = str(item.get("symbol") or "").upper()
        if not symbol:
            continue
        panel_symbols.add(symbol)
        for candle in item.get("candles") or []:
            day = str(candle.get("date") or "")[:10] if isinstance(candle, dict) else ""
            if day:
                panel_dates[day].add(symbol)
    minimum_daily_breadth = max(5, min(50, math.ceil(len(panel_symbols) * 0.5)))
    usable_panel_dates = sum(1 for symbols in panel_dates.values() if len(symbols) >= minimum_daily_breadth)
    preferred_short_horizon = 5 if 5 in requested_horizons else min(requested_horizons or [5])
    if usable_panel_dates < 500 or len(panel_symbols) < 50:
        horizons = [preferred_short_horizon]
    elif usable_panel_dates < 1_000 or len(panel_symbols) < 100:
        horizons = [value for value in requested_horizons if value <= 15] or [preferred_short_horizon]
    else:
        horizons = requested_horizons
    withheld_horizons = [value for value in requested_horizons if value not in horizons]
    target_upside = number(payload.get("target_upside", payload.get("targetUpside")), 5.0)
    stop_loss = number(payload.get("stop_loss", payload.get("stopLoss")), 4.0)
    transaction_cost_bps = payload.get("transaction_cost_bps", payload.get("transactionCostBps"))
    config = {
        "foldCount": int(payload.get("production_fold_count", payload.get("productionFoldCount", 5)) or 5),
        "embargoDays": int(payload.get("production_embargo_days", payload.get("productionEmbargoDays", 7)) or 7),
        "minTrainDates": int(payload.get("production_min_train_dates", payload.get("productionMinTrainDates", 500)) or 500),
        "testDates": int(payload.get("production_test_dates", payload.get("productionTestDates", 120)) or 120),
        "enableTreeModels": payload.get("enable_tree_models", payload.get("enableTreeModels", False)) is True,
        "enableSklearnModels": payload.get("enable_sklearn_models", payload.get("enableSklearnModels", False)) is True,
        "maxModelWeight": number(payload.get("max_model_weight", payload.get("maxModelWeight")), PRODUCTION_THRESHOLDS["maxModelWeight"]),
        "maxResidualCorrelation": number(payload.get("max_residual_correlation", payload.get("maxResidualCorrelation")), PRODUCTION_THRESHOLDS["maxResidualCorrelation"]),
        "artifactDir": payload.get("artifact_dir", payload.get("artifactDir")),
        "checkpointDir": payload.get("checkpoint_dir", payload.get("checkpointDir")),
        "resumeLatestDataset": payload.get("resume_latest_dataset", payload.get("resumeLatestDataset", False)) is True,
        "resumeMinSymbols": int(payload.get("resume_min_symbols", payload.get("resumeMinSymbols", 50)) or 50),
        "resumeMinDates": int(payload.get("resume_min_dates", payload.get("resumeMinDates", 500)) or 500),
        "resumeRequirePitVersion": payload.get("resume_require_pit_version", payload.get("resumeRequirePitVersion", False)) is True,
        "thresholds": payload.get("productionThresholds") or {},
        "treeBackend": payload.get("tree_backend", payload.get("treeBackend")),
        "treeMaxRows": int(payload.get("tree_max_rows", payload.get("treeMaxRows", os.getenv("PRODUCTION_TREE_MAX_ROWS", "40000"))) or 40000),
        "treeIterations": int(payload.get("tree_iterations", payload.get("treeIterations", os.getenv("PRODUCTION_TREE_ITERATIONS", "72"))) or 72),
        "treeThreads": int(payload.get("tree_threads", payload.get("treeThreads", os.getenv("PRODUCTION_TREE_THREADS", "2"))) or 2),
        "treeClassBalance": str(payload.get("tree_class_balance", payload.get("treeClassBalance", os.getenv("PRODUCTION_TREE_CLASS_BALANCE", "SqrtBalanced"))) or "SqrtBalanced"),
        "baselineMaxRows": int(payload.get("baseline_max_rows", payload.get("baselineMaxRows", os.getenv("PRODUCTION_BASELINE_MAX_ROWS", "6000"))) or 6000),
        "quantileMaxRows": int(payload.get("quantile_max_rows", payload.get("quantileMaxRows", os.getenv("PRODUCTION_QUANTILE_MAX_ROWS", "6000"))) or 6000),
    }
    horizon_models = []
    dataset_profiles = []
    for horizon in horizons:
        dataset = None
        dataset_cache_path = None
        if config["resumeLatestDataset"] and not items:
            dataset, dataset_cache_path = _load_latest_eligible_dataset_cache(
                config.get("checkpointDir") or config.get("artifactDir"),
                market=market,
                horizon=horizon,
                min_symbols=config["resumeMinSymbols"],
                min_dates=config["resumeMinDates"],
                require_pit_version=config["resumeRequirePitVersion"],
            )
        if dataset_cache_path is None:
            dataset_cache_path = _dataset_cache_path(
                items,
                market=market,
                horizon=horizon,
                target_upside=target_upside,
                stop_loss=stop_loss,
                transaction_cost_bps=transaction_cost_bps,
                config=config,
                market_point_in_time_features=market_point_in_time_features,
            )
        if dataset is None:
            dataset = _load_dataset_cache(dataset_cache_path, market=market, horizon=horizon)
        dataset_cache_hit = dataset is not None
        if dataset is None:
            dataset = build_market_dataset(
                items,
                market=market,
                horizons=[horizon],
                target_upside=target_upside,
                stop_loss=stop_loss,
                transaction_cost_bps=transaction_cost_bps,
                market_point_in_time_features=market_point_in_time_features,
            )
            _save_dataset_cache(dataset_cache_path, dataset, market=market, horizon=horizon)
        dataset["summary"]["featureMatrixCache"] = {
            "hit": dataset_cache_hit,
            "schema": FEATURE_MATRIX_SCHEMA,
            "eventAggregationSchema": EVENT_AGGREGATION_SCHEMA,
            "path": str(dataset_cache_path) if dataset_cache_path else None,
        }
        dataset_profiles.append(dataset["summary"])
        horizon_config = {
            **config,
            "datasetContentHash": (
                dataset_cache_path.name
                if dataset_cache_path is not None
                else stable_hash(dataset.get("summary") or {}, 24)
            ),
        }
        horizon_models.append(train_horizon_model(dataset["rows"], market=market, horizon=horizon, config=horizon_config))
    for horizon in withheld_horizons:
        horizon_models.append({
            "available": False,
            "horizon": horizon,
            "status": "withheld_limited_data",
            "reason": (
                f"{horizon}d training is withheld until the market panel reaches at least "
                f"{'500 dates and 50 symbols' if horizon <= 15 else '1,000 dates and 100 symbols'}; "
                f"current synchronized evidence is {usable_panel_dates} dates and {len(panel_symbols)} symbols."
            ),
            "productionEvidencePassed": False,
            "productionActivationBlocked": True,
        })
    horizon_models.sort(key=lambda row: int(row.get("horizon") or 0))
    summary = aggregate_dataset_profiles(dataset_profiles, market)
    if pit_load is not None:
        summary["pitLoad"] = pit_load
        summary["eventItemCoveragePct"] = round(
            number(pit_load.get("coveredSymbols")) / max(1, number(pit_load.get("requestedSymbols"), 1.0)) * 100.0,
            3,
        )
        summary["companyEventItemCoveragePct"] = summary["eventItemCoveragePct"]
        summary["marketPointInTimeFeaturesAvailable"] = number(pit_load.get("marketFeatureRows")) > 0
    historical_universe_ok = number(summary.get("historicalUniverseCoveragePct")) >= 95.0
    corporate_actions_ok = number(summary.get("corporateActionCoveragePct")) >= 95.0
    adjusted_prices_ok = number(summary.get("adjustedPriceCoveragePct")) >= 95.0
    pit_ok = int(summary.get("pointInTimeJoinViolationCount") or 0) == 0
    sample_isolation_ok = int(summary.get("duplicateRowsExcluded") or 0) == 0 and int(summary.get("crossMarketRowsExcluded") or 0) == 0
    available_models = [model for model in horizon_models if model.get("available")]
    event_history_ok = number(summary.get("eventItemCoveragePct")) >= 20.0
    universe_breadth_ok = int(summary.get("symbolCount") or 0) >= int(MARKET_DATA_TARGETS.get(market, MARKET_DATA_TARGETS["ASX"])["symbols"])
    primary_five_day = next((model for model in horizon_models if int(model.get("horizon") or 0) == 5), None)
    evidence_passed = bool(primary_five_day and primary_five_day.get("available") and primary_five_day.get("productionEvidencePassed"))
    production_data_ready = historical_universe_ok and corporate_actions_ok and adjusted_prices_ok and pit_ok and sample_isolation_ok and event_history_ok and universe_breadth_ok
    training_as_of = datetime.now(timezone.utc).isoformat()
    schema = list(summary.get("activeFeatureNames") or CORE_TECHNICAL_FEATURE_NAMES)
    data_version = stable_hash({"summary": summary, "sources": summary.get("sources")})
    feature_schema_hash = stable_hash(schema)
    downgrade_reasons = []
    for model in available_models:
        metrics = model.get("metrics") or {}
        ranking = model.get("rankingMetrics") or {}
        long_gate = model.get("longTradeGate") or {}
        long_gate_evidence = long_gate.get("testEvidence") or {}
        if number(metrics.get("brierSkillScore"), -1.0) <= 0:
            downgrade_reasons.append(f"{model.get('horizon')}d Brier Skill Score <= 0")
        if number(metrics.get("ecePct"), 100.0) > PRODUCTION_THRESHOLDS["maxDegradedEcePct"]:
            downgrade_reasons.append(f"{model.get('horizon')}d ECE > 10%")
        if long_gate.get("active") is True:
            if number(long_gate_evidence.get("directionHitRatePct")) < 57.0:
                downgrade_reasons.append(f"{model.get('horizon')}d eligible-long direction hit rate < 57%")
            if number(long_gate_evidence.get("meanNetReturnPct")) <= 0:
                downgrade_reasons.append(f"{model.get('horizon')}d eligible-long net return <= 0")
            if number((model.get("longTradeExpectedValue") or {}).get("expectedValuePct")) <= 0:
                downgrade_reasons.append(f"{model.get('horizon')}d eligible-long expected value <= 0")
        else:
            if number(ranking.get("topDecileLift")) <= 0:
                downgrade_reasons.append(f"{model.get('horizon')}d Top-K no longer beats universe")
            if number((model.get("expectedValue") or {}).get("expectedValuePct")) <= 0:
                downgrade_reasons.append(f"{model.get('horizon')}d net expected value <= 0")
        if any(number((fold.get("featureDrift") or {}).get("maxPsi")) > 0.40 for fold in model.get("foldMetrics") or []):
            downgrade_reasons.append(f"{model.get('horizon')}d feature PSI > 0.40")
    candidate_status = (
        "shadow"
        if available_models and not downgrade_reasons and any(model.get("deploymentStatus") == "shadow" for model in available_models)
        else "research"
    )
    manifest = {
        "model_version": f"{market.lower()}-multitask-{stable_hash([model.get('modelVersion') for model in horizon_models], 12)}",
        "training_run_id": f"{market.lower()}-{training_as_of[:19].replace(':', '').replace('-', '')}-{stable_hash([data_version, feature_schema_hash, requested_horizons], 10)}",
        "training_as_of": training_as_of,
        "data_version": data_version,
        "feature_schema_hash": feature_schema_hash,
        "universe_version": stable_hash(sorted({str(item.get("universeVersion") or item.get("universeAsOf") or item.get("symbol")) for item in payload.get("items") or []})),
        "label_definition": "atr-adaptive-triple-barrier-next-session-entry-v2",
        "fold_metrics": [{"horizon": model.get("horizon"), "folds": model.get("foldMetrics", [])} for model in horizon_models],
        "calibrator_version": stable_hash([model.get("calibrator") for model in horizon_models]),
        "deployment_status": candidate_status,
    }
    return {
        "available": bool(summary.get("rawRows")),
        "framework": "market-level-multitask-oof-calibrated-stack",
        "market": market,
        "horizons": requested_horizons,
        "trainedHorizons": horizons,
        "withheldHorizons": withheld_horizons,
        "limitedDataPolicy": {
            "active": bool(withheld_horizons),
            "usablePanelDates": usable_panel_dates,
            "panelSymbols": len(panel_symbols),
            "minimumDailyBreadth": minimum_daily_breadth,
            "policy": "Train 5d first; unlock 15d after 500 synchronized dates/50 symbols and 30d after 1,000 dates/100 symbols.",
        },
        "architecture": [
            "multi-task market dataset",
            "purged walk-forward OOF base predictions",
            "residual-correlation pruning",
            "non-negative capped Ridge/Logistic stack",
            "sample-size-aware Platt/Isotonic probability calibration",
            "conformalized quantile return intervals",
            "reject-trade and deployment gates",
        ],
        "dataset": summary,
        "modelLibraries": model_library_status(),
        "horizonModels": horizon_models,
        "manifest": manifest,
        "productionEligibility": {
            "evidencePassed": evidence_passed,
            "dataReady": production_data_ready,
            "eligible": evidence_passed and production_data_ready,
            "autoPromotionAllowed": False,
            "primaryPromotionHorizon": 5,
            "longerHorizonsResearchOnly": [horizon for horizon in requested_horizons if horizon != 5],
            "checks": {
                "historicalUniversePointInTime": historical_universe_ok,
                "corporateActionHistoryPointInTime": corporate_actions_ok,
                "adjustedPriceSeries": adjusted_prices_ok,
                "pointInTimeJoin": pit_ok,
                "sampleIsolation": sample_isolation_ok,
                "pointInTimeEventHistory": event_history_ok,
                "marketUniverseBreadth": universe_breadth_ok,
                "primary5DayEvidence": evidence_passed,
                "allHorizonEvidence": not withheld_horizons and all(model.get("productionEvidencePassed") for model in available_models),
            },
            "reason": "Candidates remain Research/Shadow until point-in-time universe and corporate-action coverage are complete and Paper Champion has observed 2-3 full prediction cycles.",
        },
        "monitoringStatus": {
            "status": "degraded" if downgrade_reasons else "healthy-shadow-candidate",
            "automaticDowngradeApplied": bool(downgrade_reasons),
            "recommendedDeploymentStatus": candidate_status,
            "reasons": downgrade_reasons,
            "evaluatedAt": training_as_of,
        },
        "rejectTradePolicy": {
            "enabled": True,
            "cashPriorWeight": 0.15,
            "learnedLongThresholds": {
                f"{model.get('horizon')}d": (model.get("longTradeGate") or {}).get("threshold")
                for model in available_models
                if (model.get("longTradeGate") or {}).get("active") is True
            },
            "rejectWhen": [
                "calibrated probability is below the strategy threshold",
                "Brier Skill Score <= 0 or ECE > 10%",
                "quantile interval is too wide for the expected return",
                "data source is stale/degraded or a critical point-in-time feature is missing",
                "feature drift exceeds its training envelope",
                "recent two rolling windows have negative net expected value",
            ],
        },
        "monitoringPolicy": {
            "weightUpdateCadence": "monthly",
            "automaticDowngrade": [
                "two recent rolling windows have negative net expectation",
                "Brier Skill Score below zero",
                "ECE above 10%",
                "Top-K net return no longer beats the full universe",
                "feature distribution drift",
                "stale cache, degraded provider, or missing critical features",
            ],
            "deploymentStages": ["research", "shadow", "paper_champion", "production_champion"],
        },
        "dataSourcePolicy": {
            "dailyBars": "licensed/exchange or primary vendor + independent validation source",
            "intraday": "authorised consolidated feed for volume/order-flow training; IEX-only data remains auxiliary",
            "companyActions": "point-in-time split/dividend/merger adjustment history",
            "fundamentals": "filing timestamp and revision-aware SEC/ASX/China exchange records",
            "macro": "vintage-aware releases such as ALFRED, never today's revised history backfilled into the past",
            "news": "first-published timestamp, deduplicated event clusters, historical archive",
            "social": "auxiliary feature only; never the sole production model",
        },
        "limitations": [
            "No delisted or historical-index membership coverage is fabricated when the provider does not supply it.",
            "Event models stay unavailable when point-in-time event history is insufficient.",
            "Deep models remain challengers and receive zero production weight until they beat tree models across multiple untouched windows.",
        ],
    }


def recover_oof_artifacts(payload: dict[str, Any]) -> dict[str, Any]:
    """Register orphaned OOF files as auditable Research evidence without promoting them."""
    market = str(payload.get("market") or "ASX").upper()
    directory = Path(str(payload.get("artifact_dir") or payload.get("artifactDir") or "")).expanduser().resolve()
    if not directory.exists():
        return {"available": False, "market": market, "reason": "OOF artifact directory does not exist."}
    latest_by_horizon: dict[int, Path] = {}
    for path in directory.glob("*.jsonl.gz"):
        try:
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                first = json.loads(next(handle))
            horizon = int(number(first.get("horizon")))
            if horizon <= 0 or str(first.get("market") or "").upper() != market:
                continue
            previous = latest_by_horizon.get(horizon)
            if previous is None or path.stat().st_mtime > previous.stat().st_mtime:
                latest_by_horizon[horizon] = path
        except (OSError, StopIteration, ValueError, TypeError):
            continue
    if not latest_by_horizon:
        return {"available": False, "market": market, "reason": "No readable same-market OOF artifacts were found."}
    horizon_models = []
    all_symbols: set[str] = set()
    all_dates: set[str] = set()
    total_rows = 0
    for horizon, path in sorted(latest_by_horizon.items()):
        raw_rows = []
        malformed = 0
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                    if str(row.get("market") or "").upper() != market or int(number(row.get("horizon"))) != horizon:
                        continue
                    raw_rows.append(row)
                except (ValueError, TypeError):
                    malformed += 1
        unique: dict[str, dict[str, Any]] = {}
        for row in raw_rows:
            identity = stable_hash({
                "market": market,
                "symbol": row.get("symbol"),
                "date": row.get("date"),
                "horizon": horizon,
                "fold": row.get("fold"),
                "label": "atr-adaptive-triple-barrier-next-session-entry-v2",
            }, 32)
            row["predictionId"] = identity
            row["strictOof"] = True
            unique.setdefault(identity, row)
        rows = sorted(unique.values(), key=lambda row: (str(row.get("date")), str(row.get("symbol"))))
        dates = sorted({str(row.get("date")) for row in rows if row.get("date")})
        all_dates.update(dates)
        all_symbols.update(str(row.get("symbol")) for row in rows if row.get("symbol"))
        total_rows += len(rows)
        split = max(1, int(len(dates) * 0.65))
        train_dates = set(dates[:split])
        purge = set(dates[split:split + horizon + int(payload.get("embargo_days") or 7)])
        meta_train = [row for row in rows if str(row.get("date")) in train_dates]
        meta_test = [row for row in rows if str(row.get("date")) not in train_dates and str(row.get("date")) not in purge]
        names = [name for name in MODEL_OUTPUT_KEYS if any(row.get(name) is not None for row in meta_train)]
        names, skill_pruned = brier_skilled_models(meta_train, names)
        names, correlation_pruned = prune_correlated_models(meta_train, names, PRODUCTION_THRESHOLDS["maxResidualCorrelation"])
        pruned = [*skill_pruned, *correlation_pruned]
        if len(names) < 1 or len(meta_test) < 20:
            horizon_models.append({
                "available": False,
                "horizon": horizon,
                "reason": "Recovered OOF artifact lacks enough independent model outputs or untouched meta-test rows.",
                "rowCount": len(rows),
                "malformedRows": malformed,
            })
            continue
        weights = fit_constrained_stack(meta_train, names, cap=PRODUCTION_THRESHOLDS["maxModelWeight"])
        train_raw = ensemble_probabilities(meta_train, names, weights)
        test_raw = ensemble_probabilities(meta_test, names, weights)
        calibrator = fit_probability_calibrator(
            train_raw,
            [number(row.get("actualTarget")) for row in meta_train],
            independent_dates=len(train_dates),
            dates=[str(row.get("date")) for row in meta_train],
        )
        calibrated = apply_probability_calibrator(calibrator, test_raw)
        metrics = calibration_metrics(meta_test, calibrated)
        ranking = rank_ic_summary(meta_test)
        fold_metrics = []
        for fold in sorted({int(number(row.get("fold"))) for row in rows}):
            fold_rows = [row for row in rows if int(number(row.get("fold"))) == fold]
            fold_probabilities = [number(row.get("pathSafetyPrediction"), 0.5) for row in fold_rows]
            fold_metric = calibration_metrics(fold_rows, fold_probabilities)
            fold_metrics.append({
                "fold": fold,
                "testRows": len(fold_rows),
                "testDates": len({str(row.get("date")) for row in fold_rows}),
                "brierSkillScore": fold_metric.get("brierSkillScore"),
                "ecePct": fold_metric.get("ecePct"),
                "topDecileNetReturn": fold_metric.get("topDecileNetReturn"),
                "positive": number(fold_metric.get("topDecileNetReturn")) > 0,
                "recovered": True,
            })
        model_version = f"{market.lower()}-{horizon}d-recovered-{stable_hash([path.name, len(rows), dates[:1], dates[-1:]], 12)}"
        horizon_models.append({
            "available": True,
            "horizon": horizon,
            "modelVersion": model_version,
            "deploymentStatus": "research",
            "productionEvidencePassed": False,
            "productionActivationBlocked": True,
            "activationReason": "Recovered OOF evidence is usable for audit/replay, but lacks the immutable PIT dataset manifest required for promotion.",
            "rowCount": len(rows),
            "oofRows": len(rows),
            "metaTrainRows": len(meta_train),
            "metaTestRows": len(meta_test),
            "eventCounts": {
                "target": sum(1 for row in rows if number(row.get("actualTarget")) >= 0.5),
                "stop": sum(1 for row in rows if number(row.get("actualStop")) >= 0.5),
                "timeout": sum(1 for row in rows if number(row.get("actualTimeout")) >= 0.5),
            },
            "models": names,
            "weights": {name: round(weights[index], 6) for index, name in enumerate(names)},
            "prunedModels": pruned,
            "calibrator": {**calibrator, "version": f"recovered-{stable_hash(calibrator, 10)}"},
            "metrics": metrics,
            "rankingMetrics": ranking,
            "foldMetrics": fold_metrics,
            "positiveFoldCount": sum(1 for row in fold_metrics if row.get("positive")),
            "productionChecks": {
                "immutableDatasetManifest": False,
                "pointInTimeCoverage": False,
                "companyActions": False,
                "sampleIsolation": len(raw_rows) == len(rows),
                "brierSkill": number(metrics.get("brierSkillScore"), -1) > 0,
                "ece": number(metrics.get("ecePct"), 100) <= PRODUCTION_THRESHOLDS["maxEcePct"],
            },
            "oofArtifact": {
                "format": "gzip-jsonl",
                "filename": path.name,
                "rowCount": len(rows),
                "recovered": True,
            },
            "leakageControl": {
                "status": "legacy-artifact-audited",
                "note": "Rows are preserved as strict OOF evidence; production activation is blocked until their source dataset can be reproduced point-in-time.",
            },
        })
    now = datetime.now(timezone.utc).isoformat()
    version = f"{market.lower()}-recovered-oof-{stable_hash([row.get('modelVersion') for row in horizon_models], 12)}"
    dataset = {
        "rawRows": total_rows,
        "symbolCount": len(all_symbols),
        "dateCount": len(all_dates),
        "dateRange": {"start": min(all_dates) if all_dates else None, "end": max(all_dates) if all_dates else None},
        "pointInTimeCoveragePct": 0.0,
        "historicalUniverseCoveragePct": 0.0,
        "corporateActionCoveragePct": 0.0,
        "adjustedPriceCoveragePct": 0.0,
        "pointInTimeJoinViolationCount": 0,
        "duplicateRowsExcluded": sum(max(0, int(model.get("rowCount") or 0) - int(model.get("oofRows") or 0)) for model in horizon_models),
        "crossMarketRowsExcluded": 0,
        "sources": ["recovered-local-oof-artifact"],
    }
    return {
        "available": any(model.get("available") for model in horizon_models),
        "framework": "recovered-strict-oof-evidence",
        "market": market,
        "horizons": sorted(latest_by_horizon),
        "trainedHorizons": [],
        "withheldHorizons": sorted(latest_by_horizon),
        "dataset": dataset,
        "modelLibraries": model_library_status(),
        "horizonModels": horizon_models,
        "manifest": {
            "model_version": version,
            "training_run_id": f"recovery-{stable_hash([market, now, version], 16)}",
            "training_as_of": now,
            "data_version": stable_hash(dataset, 16),
            "feature_schema_hash": "legacy-oof-output-only",
            "universe_version": "unverified-legacy-artifact",
            "label_definition": "atr-adaptive-triple-barrier-next-session-entry-v2",
            "fold_metrics": [{"horizon": model.get("horizon"), "folds": model.get("foldMetrics", [])} for model in horizon_models],
            "calibrator_version": stable_hash([model.get("calibrator") for model in horizon_models], 16),
            "deployment_status": "research",
            "recovered_artifact": True,
        },
        "productionEligibility": {
            "eligible": False,
            "evidencePassed": False,
            "dataReady": False,
            "autoPromotionAllowed": False,
            "reason": "Recovered OOF evidence is registered for reporting and Agent replay only; immutable PIT lineage is unavailable.",
        },
        "monitoringStatus": {"status": "research-recovered", "automaticDowngradeApplied": True, "evaluatedAt": now},
        "rejectTradePolicy": {"enabled": True, "reason": "Recovered artifacts cannot authorize new trades."},
    }
