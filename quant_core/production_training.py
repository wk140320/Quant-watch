from __future__ import annotations

import hashlib
import importlib.util
import importlib.metadata
import json
import math
import gzip
import os
import random
import subprocess
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, datetime, time, timezone
from pathlib import Path
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo


_NATIVE_ML_HEALTH: dict[str, dict[str, Any]] = {}

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
from research_governance import (
    consume_lockbox,
    create_lockbox,
    experiment_hypothesis_contract,
    open_lockbox,
    record_experiment,
)
try:
    from research_lane import (
        RESEARCH_LANES,
        adaptive_fold_count,
        default_horizons,
        research_artifact_root,
        research_lockbox_fields,
        resolve_training_lane,
        validate_training_request,
    )
except ImportError:  # pragma: no cover - package and script entry points differ
    from .research_lane import (
        RESEARCH_LANES,
        adaptive_fold_count,
        default_horizons,
        research_artifact_root,
        research_lockbox_fields,
        resolve_training_lane,
        validate_training_request,
    )
try:
    from pit_contract import fundamental_coverage_layers, normalize_pit_timestamps, parse_pit_timestamp
except ImportError:  # pragma: no cover - package and script entry points differ
    from .pit_contract import fundamental_coverage_layers, normalize_pit_timestamps, parse_pit_timestamp


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

# Keep raw fundamental dimensions separate from the event score.  These are
# normalized point-in-time inputs, not absolute accounting values, so a
# company cannot dominate the model merely because it is larger.
FUNDAMENTAL_FEATURE_NAMES = [
    "fundamentalRevenueGrowth",
    "fundamentalProfitGrowth",
    "fundamentalRoe",
    "fundamentalRoa",
    "fundamentalGrossMargin",
    "fundamentalNetMargin",
    "fundamentalDebtToAssets",
    "fundamentalCurrentRatio",
    "fundamentalCashRatio",
    "fundamentalOperatingCashFlowGrowth",
    "fundamentalAssetGrowth",
    "fundamentalEquityGrowth",
    "fundamentalEpsGrowth",
]

EVENT_AGGREGATION_SCHEMA = "pit-event-aggregation-v8-date-cached-market-company-split"
FEATURE_MATRIX_SCHEMA = "market-feature-matrix-v21-pit-fundamentals-label-tournament"
NULL_MODEL_CONTRACT_VERSION = "no-model-propagation-v2"

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

# These are calculated only from candles available on the signal date.  They
# distinguish a liquid, consistently tradable name from a one-day volume spike.
LIQUIDITY_FEATURE_NAMES = [
    "logDollarVolume20",
    "dollarVolumeStability20",
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
    "sectorMomentum5Rank",
    "sectorMomentum20Rank",
    "sectorRelativeMomentum5",
    "sectorBreadth5",
    "sectorLiquidityRank",
    "sectorCoverage",
]

# These features describe the common market/sector state.  They are useful to
# the Regime/Sector experts, but allowing them into the stock ranker makes the
# ranker repeat the same market call for every symbol in a date group.
REGIME_FEATURE_NAMES = [
    "marketBreadth5",
    "sectorMomentum5Rank",
    "sectorMomentum20Rank",
    "sectorRelativeMomentum5",
    "sectorBreadth5",
    "sectorLiquidityRank",
    "sectorCoverage",
    *MACRO_FEATURE_NAMES,
    "macroRisk",
]
RANK_EXCLUDED_FEATURE_NAMES = set(REGIME_FEATURE_NAMES)

COMPACT_CROSS_SECTIONAL_FEATURE_NAMES = [
    "xsMomentum5Rank",
    "xsMomentum20Rank",
    "xsVolumeRatioRank",
    "xsLowVolatilityRank",
    "xsLiquidityRank",
    "marketBreadth5",
    "sectorMomentum5Rank",
    "sectorRelativeMomentum5",
    "sectorBreadth5",
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
    "logDollarVolume20",
    "dollarVolumeStability20",
    "sectorMomentum5Rank",
    "sectorMomentum20Rank",
    "sectorRelativeMomentum5",
    "sectorBreadth5",
    "sectorLiquidityRank",
    "sectorCoverage",
]

FEATURE_FAMILIES = {
    "momentum_trend": {"bias", "change1", "change3", "change5", "change10", "change20", "rsi", "macdHist", "smaGap", "trendQuality"},
    "volume_flow": {"volumeRatio", "buyPressure5", "pressureChange", "volumeAccel", "volumeTrend", "liquidityShock"},
    "volatility_risk": {"volatility", "trueRange", "gap", "bodyPosition", "rangePosition", "closeLocation", "reversalPressure"},
    "volume_profile": {"profileDistance", "profileSkew", "profilePocDistance", "profileImbalance"},
    "liquidity_execution": set(LIQUIDITY_FEATURE_NAMES),
    "event_fundamental": (set(EVENT_FEATURE_NAMES) - set(MACRO_FEATURE_NAMES) - {"macroRisk"}) | set(FUNDAMENTAL_FEATURE_NAMES),
    "macro_regime": {*MACRO_FEATURE_NAMES, "macroRisk"},
    "market_cross_section": set(CROSS_SECTIONAL_FEATURE_NAMES),
}


def _feature_names_for_row(row: dict[str, Any]) -> list[str]:
    explicit = list(row.get("featureNames") or [])
    if explicit:
        return explicit
    width = len(row.get("x") or [])
    technical_only = [*CORE_TECHNICAL_FEATURE_NAMES, *LIQUIDITY_FEATURE_NAMES, *CROSS_SECTIONAL_FEATURE_NAMES]
    with_events = [*CORE_TECHNICAL_FEATURE_NAMES, *LIQUIDITY_FEATURE_NAMES, *EVENT_FEATURE_NAMES, *CROSS_SECTIONAL_FEATURE_NAMES]
    with_fundamentals = [*CORE_TECHNICAL_FEATURE_NAMES, *LIQUIDITY_FEATURE_NAMES, *EVENT_FEATURE_NAMES, *FUNDAMENTAL_FEATURE_NAMES, *CROSS_SECTIONAL_FEATURE_NAMES]
    if width == len(technical_only):
        return technical_only
    if width == len(with_events):
        return with_events
    if width == len(with_fundamentals):
        return with_fundamentals
    return with_events[:width]


def _rank_feature_layout(row: dict[str, Any]) -> dict[str, Any]:
    """Return the stock-alpha feature projection used by ranker experts.

    The full feature vector remains available to direction/path/risk heads.
    Rankers use only individual and residual-relative features so a common
    market move cannot be counted as independent stock-selection evidence.
    """
    names = _feature_names_for_row(row)
    indexes = [index for index, name in enumerate(names) if name not in RANK_EXCLUDED_FEATURE_NAMES]
    if not indexes:
        indexes = list(range(len(names)))
    return {
        "indexes": indexes,
        "names": [names[index] for index in indexes],
        "excluded": [name for name in names if name in RANK_EXCLUDED_FEATURE_NAMES],
        "schema": "stock-alpha-residual-features-v1",
    }


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
    # A cross-sectional rank is not a probability by itself.  It is exposed
    # as a direction challenger only after the inner OOF selector and the
    # final calibrator have accepted it.
    "rankerDirectionPrediction",
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
    "maxEcePct": 3.0,
    "maxDegradedEcePct": 10.0,
    "minCalibrationSlope": 0.8,
    "maxCalibrationSlope": 1.2,
    "minBrierSkill": 0.02,
    "minAccuracyPct": 60.0,
    "minBalancedAccuracyPct": 57.0,
    "minDirectionMcc": 0.0,
    "minRelativeMajorityAccuracyPct": 0.0,
    "minThresholdCoveragePct": 50.0,
    "minTop10DirectionHitRatePct": 60.0,
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


def _write_training_progress(config: dict[str, Any] | None, phase: str, **details: Any) -> None:
    """Publish non-blocking phase progress for the Node job diagnostics endpoint."""
    if not config:
        return
    progress_path = str(config.get("progressPath") or config.get("progress_path") or "").strip()
    if not progress_path:
        return
    payload = {
        "schema": "production-training-progress.v1",
        "trainingRunId": config.get("trainingRunId") or config.get("training_run_id"),
        "market": config.get("market"),
        "phase": str(phase),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        **details,
    }
    try:
        path = Path(progress_path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str), encoding="utf-8")
        temporary.replace(path)
    except (OSError, TypeError, ValueError):
        # Progress must never make a valid training run fail.
        return


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
        "panelMaxSymbols": int(config.get("panelMaxSymbols", os.getenv("PRODUCTION_PANEL_MAX_SYMBOLS_PER_DATE", "0"))),
        "panelDateStride": int(config.get("panelDateStride", os.getenv("PRODUCTION_PANEL_DATE_STRIDE", "1"))),
        "maxModelWeight": number(config.get("maxModelWeight"), 0.35),
        "expertResidualCorrelation": number(config.get("expertResidualCorrelation"), 0.65),
        "labelSchema": "daily-sign-first-net-sector-residual-v1",
        "embargoDays": int(config.get("embargoDays", 7)),
        "foldCount": int(config.get("foldCount", 5)),
        "minTrainDates": int(config.get("minTrainDates", 500)),
        "testDates": int(config.get("testDates", 120)),
    }
    signature_payload = {
        "schema": "oof-fold-checkpoint-v8-matrix-code-config-null-contract",
        "nullModelContractVersion": NULL_MODEL_CONTRACT_VERSION,
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
    # Checkpoints created before the null/no-model contract was enforced may
    # contain fallback predictions for a fold that should have been empty.
    # They are intentionally not reusable: the fold must be recomputed under
    # the current contract instead of silently preserving an invalid model.
    if metadata.get("nullModelContractVersion") != NULL_MODEL_CONTRACT_VERSION:
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
    digest.update(
        f"{FEATURE_MATRIX_SCHEMA}|{EVENT_AGGREGATION_SCHEMA}|{market}|{horizon}|{target_upside}|{stop_loss}|{transaction_cost_bps}"
        f"|panel={int(config.get('panelMaxSymbols') or 0)}|stride={int(config.get('panelDateStride') or 1)}"
        f"|snapshot={config.get('snapshotId') or ''}".encode("utf-8")
    )
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


def _save_dataset_cache(
    path: Path | None,
    dataset: dict[str, Any],
    *,
    market: str,
    horizon: int,
    snapshot_id: str | None = None,
) -> None:
    if path is None:
        return
    _atomic_gzip_json(path, {
        "schema": FEATURE_MATRIX_SCHEMA,
        "eventAggregationSchema": EVENT_AGGREGATION_SCHEMA,
        "market": market,
        "snapshotId": snapshot_id,
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
    return parse_pit_timestamp(value, date_only="end")


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
        "timestampFallbackRows": 0,
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
            timestamps = normalize_pit_timestamps(raw)
            available_at = parse_pit_timestamp(timestamps.get("published_at"), date_only="end")
            event_at = parse_pit_timestamp(timestamps.get("observation_period_end"), date_only="start")
            ingested_at = parse_pit_timestamp(timestamps.get("ingested_at"), date_only="end")
            effective_at = parse_pit_timestamp(timestamps.get("effective_at"), date_only="start")
            if not timestamps.get("complete") or not timestamps.get("orderValid") or any(
                value is None for value in (available_at, event_at, ingested_at, effective_at)
            ):
                audit["invalidTimestampRowsExcluded"] += 1
                continue
            if available_at < event_at or available_at > ingested_at or effective_at > ingested_at:
                audit["temporalOrderViolations"] += 1
                continue
            if timestamps.get("fallbackUsed"):
                audit["timestampFallbackRows"] += 1
            effective_day = str(raw.get(
                "effective_date",
                raw.get("effectiveDate", raw.get("event_time", raw.get("eventTime", raw.get("date", "")))),
            ))[:10]
            if not effective_day:
                effective_day = effective_at.date().isoformat()
            values = raw.get("values") if isinstance(raw.get("values"), dict) else raw
            prepared_values = {
                **values,
                "__dataset": str(raw.get("dataset") or values.get("__dataset") or "news").lower(),
                "__source": str(raw.get("source") or values.get("__source") or "unknown"),
                "__marketWide": market_wide,
                "__pitTimestamps": timestamps,
            }
            # External callers may provide raw financial aliases instead of
            # the normalized lake names. Normalize the aliases here as well
            # so a valid PIT row cannot disappear at aggregation time.
            fundamental_aliases = {
                "fundamentalRevenueGrowth": ("revenueGrowth", "or_yoy", "tr_yoy", "revenue_yoy"),
                "fundamentalProfitGrowth": ("profitGrowth", "earningsGrowth", "netprofit_yoy", "dt_netprofit_yoy"),
                "fundamentalRoe": ("roe", "roe_waa", "roe_yearly", "roe_yoy"),
                "fundamentalRoa": ("roa", "roa2_yearly"),
                "fundamentalGrossMargin": ("grossMargin", "gross_margin", "grossprofit_margin"),
                "fundamentalNetMargin": ("netMargin", "profitMargin", "netprofit_margin"),
                "fundamentalDebtToAssets": ("debtToAssets", "debt_to_assets"),
                "fundamentalCurrentRatio": ("currentRatio", "current_ratio"),
                "fundamentalCashRatio": ("cashRatio", "cash_ratio"),
                "fundamentalOperatingCashFlowGrowth": ("operatingCashFlowGrowth", "ocf_yoy"),
                "fundamentalAssetGrowth": ("assetGrowth", "assets_yoy"),
                "fundamentalEquityGrowth": ("equityGrowth", "eqt_yoy"),
                "fundamentalEpsGrowth": ("epsGrowth", "eps_yoy", "dt_eps_yoy"),
            }
            for normalized_name, aliases in fundamental_aliases.items():
                if normalized_name not in prepared_values:
                    alias_value = next((prepared_values.get(alias) for alias in aliases if prepared_values.get(alias) is not None), None)
                    if alias_value is not None:
                        prepared_values[normalized_name] = alias_value
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
    all_pit_feature_names = [*EVENT_FEATURE_NAMES, *FUNDAMENTAL_FEATURE_NAMES]
    output = {name: 0.0 for name in all_pit_feature_names}
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
    # `bisect(..., key=...)` is only available in newer Python versions. Keep
    # the worker compatible with the project venv by bisecting a timestamp
    # projection instead of relying on that optional keyword.
    upper = bisect_right([row[0] for row in prepared], signal_at)
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
    weighted_sums = {name: 0.0 for name in all_pit_feature_names}
    weighted_denominators = {name: 0.0 for name in all_pit_feature_names}
    decayed_max = {name: 0.0 for name in all_pit_feature_names}
    saturating_products = {name: 1.0 for name in ("positiveCatalyst", "negativeCatalyst", "dilutionRisk", "regulatoryRisk")}
    signed_names = {
        "eventSentiment", "fundamentalQuality", "macroRisk", "capitalAllocation", "operationalMomentum",
        *[name for name in MACRO_FEATURE_NAMES if name != "macroDataCoverage"],
        *FUNDAMENTAL_FEATURE_NAMES,
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
    values = {
        name: number((company.get("values") or {}).get(name))
        for name in [*EVENT_FEATURE_NAMES, *FUNDAMENTAL_FEATURE_NAMES]
    }
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


def _sector_key(row: dict[str, Any]) -> str:
    value = str(row.get("sector") or "").strip().upper()
    return value if value and value not in {"UNKNOWN", "GENERAL", "US EQUITIES", "N/A", "NONE"} else ""


def _sector_semantics_audit(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Check whether sector-relative labels have enough cross-sectional meaning."""
    groups: dict[tuple[str, str], int] = defaultdict(int)
    date_breadths: dict[str, set[str]] = defaultdict(set)
    known_rows = 0
    for row in rows:
        sector = _sector_key(row)
        if not sector:
            continue
        day = str(row.get("date") or "")[:10]
        groups[(day, sector)] += 1
        date_breadths[day].add(sector)
        known_rows += 1
    breadths = list(groups.values())
    eligible_groups = sum(1 for value in breadths if value >= 10)
    usable_rows = sum(value for value in breadths if value >= 10)
    row_coverage = known_rows / max(1, len(rows))
    eligible = (
        bool(rows)
        and row_coverage >= 0.80
        and len({key[1] for key in groups}) >= 10
        and eligible_groups >= max(30, len(groups) // 2)
    )
    return {
        "available": bool(groups),
        "eligible": eligible,
        "knownSectorRowCoveragePct": round(row_coverage * 100.0, 4),
        "sectorCount": len({key[1] for key in groups}),
        "dateCount": len(date_breadths),
        "groupCount": len(groups),
        "groupsWithAtLeast10": eligible_groups,
        "eligibleRowCoveragePct": round(usable_rows / max(1, len(rows)) * 100.0, 4),
        "medianGroupBreadth": round(float(median(breadths)) if breadths else 0.0, 4),
        "minimumGroupBreadth": 10,
        "status": "eligible" if eligible else "insufficient-sector-semantic-support",
        "policy": "Sector residual labels are valid only for known sectors with at least 10 names on a date and 80% aggregate coverage.",
    }


def _rank_cross_section(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[(str(row["date"]), int(row["horizon"]))].append(row)
    for group in groups.values():
        ordered = sorted(group, key=lambda row: number(row.get("actualReturn")))
        denominator = max(1, len(ordered) - 1)
        # ``actualReturn`` is produced by outcome_window and already contains
        # the round-trip cost.  Older/recovered rows may only contain a gross
        # return, so support that schema explicitly without subtracting costs
        # twice from current training data.
        cost_returns = [
            number(row.get("actualReturn"))
            if row.get("actualReturnIsNet") is True or row.get("actualGrossReturn") is None
            else number(row.get("actualGrossReturn"))
            - number(row.get("transactionCostBps"), MARKET_COST_BPS.get(str(row.get("market") or "ASX").upper(), 18.0)) / 100.0
            for row in ordered
        ]
        cost_min = min(cost_returns) if cost_returns else 0.0
        cost_max = max(cost_returns) if cost_returns else 0.0
        cost_span = max(1e-9, cost_max - cost_min)
        for index, row in enumerate(ordered):
            rank = index / denominator if len(ordered) > 1 else 0.5
            row["returnRank"] = rank
            cost_return = cost_returns[index]
            # This is a separate, cost-aware direction ranking target.  It is
            # deliberately not the path label below: reaching a target before
            # the horizon is useful risk evidence, but it must not outrank a
            # stock whose final net return is negative when the production
            # Top-K metric is final long-only direction.
            row["costAdjustedReturn"] = cost_return
            row["costReturnRank"] = (cost_return - cost_min) / cost_span if len(ordered) > 1 else 0.5
            # Direction labels are deliberately sign-first.  A continuous
            # return percentile teaches a ranker to prefer a few large
            # winners even when most selected names lose.  The first stage of
            # the Top-K contract must instead learn net-positive outcomes.
            row["netUpLabel"] = 1 if cost_return > 0 else 0
            row["marketResidualReturn"] = 0.0
            row["sectorResidualReturn"] = 0.0
            row["marketResidualUp"] = 0
            row["sectorResidualUp"] = 0
            row["topDecilePositive"] = 0
            row["utilityRelevance"] = clamp(cost_return / max(0.25, number(row.get("targetBarrierPct"), 1.0)), -4.0, 4.0)
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
        # Sector features are formed inside the same date/horizon group. They
        # never use a later close and remain neutral for sectors too small to
        # support a meaningful cross-sectional comparison.
        sector_groups: dict[str, list[int]] = defaultdict(list)
        for index, row in enumerate(group):
            sector = _sector_key(row)
            if sector:
                sector_groups[sector].append(index)
        sector_values: dict[int, list[float]] = {index: [0.0] * 6 for index in range(len(group))}
        market_change5 = sum(number((row.get("crossSectionRaw") or {}).get("change5")) for row in group) / max(1, len(group))
        market_change20 = sum(number((row.get("crossSectionRaw") or {}).get("change20")) for row in group) / max(1, len(group))
        for indexes in sector_groups.values():
            if len(indexes) < 10:
                continue

            def local_rank(feature_name: str) -> dict[int, float]:
                ordered_indexes = sorted(indexes, key=lambda item: number((group[item].get("crossSectionRaw") or {}).get(feature_name)))
                local_denominator = max(1, len(ordered_indexes) - 1)
                return {
                    item: (position / local_denominator if len(ordered_indexes) > 1 else 0.5) * 2.0 - 1.0
                    for position, item in enumerate(ordered_indexes)
                }

            momentum5 = local_rank("change5")
            momentum20 = local_rank("change20")
            liquidity = local_rank("dollarLiquidity")
            sector_change5 = sum(number((group[item].get("crossSectionRaw") or {}).get("change5")) for item in indexes) / len(indexes)
            sector_change20 = sum(number((group[item].get("crossSectionRaw") or {}).get("change20")) for item in indexes) / len(indexes)
            sector_breadth = sum(
                number((group[item].get("crossSectionRaw") or {}).get("change5")) > 0
                for item in indexes
            ) / len(indexes)
            # Scale the sector-market spread by contemporaneous dispersion so
            # a volatile market does not make a small sector move look decisive.
            dispersion = math.sqrt(sum(
                (number((row.get("crossSectionRaw") or {}).get("change5")) - market_change5) ** 2
                for row in group
            ) / max(1, len(group)))
            relative_momentum = clamp((sector_change5 - market_change5) / max(0.25, dispersion), -2.0, 2.0) / 2.0
            # Keep the 20-day market comparison evaluated for auditability;
            # the per-name local 20-day rank carries it to the model.
            _ = sector_change20 - market_change20
            coverage = min(1.0, len(indexes) / 10.0)
            for item in indexes:
                sector_values[item] = [
                    momentum5[item], momentum20[item], relative_momentum,
                    sector_breadth * 2.0 - 1.0, liquidity[item], coverage,
                ]
        market_cost_mean = sum(cost_returns) / max(1, len(cost_returns))
        top_cut = max(0, math.ceil(len(ordered) * 0.90) - 1)
        cost_by_row_id = {id(candidate): cost_returns[position] for position, candidate in enumerate(ordered)}
        for position, row in enumerate(ordered):
            sector_indexes = sector_groups.get(_sector_key(row), [])
            # Use the already built group indexes without looking at any
            # future feature.  All values here are outcome labels for model
            # training, never part of x.
            if len(sector_indexes) >= 10:
                sector_mean = sum(
                    cost_by_row_id.get(id(group[item]), 0.0)
                    for item in sector_indexes
                ) / len(sector_indexes)
            else:
                sector_mean = market_cost_mean
            row["marketResidualReturn"] = round(cost_returns[position] - market_cost_mean, 8)
            row["sectorResidualValid"] = 1 if len(sector_indexes) >= 10 else 0
            row["sectorResidualReturn"] = round(cost_returns[position] - sector_mean, 8) if len(sector_indexes) >= 10 else None
            row["marketResidualUp"] = 1 if row["marketResidualReturn"] > 0 else 0
            row["sectorResidualUp"] = 1 if len(sector_indexes) >= 10 and row["sectorResidualReturn"] > 0 else None
            row["topDecilePositive"] = 1 if position >= top_cut and row["netUpLabel"] else 0
            # Tiered relevance: sign first, then sector-relative and top
            # decile evidence.  Continuous return only breaks ties.
            row["rankDirectionRelevance"] = (
                float(row["netUpLabel"])
                + 0.75 * number(row.get("sectorResidualUp"), 0.0)
                + 0.75 * float(row["topDecilePositive"])
                + 0.05 * number(row["costReturnRank"])
            )
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
                *sector_values[index],
            ])


def label_tournament_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe the competing labels without using future labels as features.

    This is an evidence contract, not a promise that every label is
    learnable.  It makes the available positive rate, date support and
    overlap explicit so a later OOF experiment can compare one label at a
    time on the same frozen folds.
    """
    contracts = {
        "net_up": "netUpLabel",
        "sector_residual_up": "sectorResidualUp",
        "market_residual_up": "marketResidualUp",
        "top_decile_positive": "topDecilePositive",
        "triple_barrier": "barrierClass",
        "utility_relevance": "utilityRelevance",
    }
    output = {}
    for name, key in contracts.items():
        values = [number(row.get(key)) for row in rows if row.get(key) is not None]
        dates = {str(row.get("date") or "") for row in rows if row.get(key) is not None}
        binary = name != "utility_relevance" and name != "triple_barrier"
        output[name] = {
            "field": key,
            "rows": len(values),
            "independentDates": len(dates),
            "positiveRows": sum(1 for value in values if value >= 0.5) if binary else None,
            "positiveRatePct": round(sum(1 for value in values if value >= 0.5) / max(1, len(values)) * 100.0, 4) if binary else None,
            "classCount": len(set(values)) if values else 0,
            "pointInTimeSafe": True,
            "status": "ready_for_frozen_oof_tournament" if len(dates) >= 250 and len(values) >= 50_000 else "evidence_insufficient",
        }
    return {
        "schema": "label-tournament-v1-sign-first-cost-aware",
        "contracts": output,
        "selectionRule": "same frozen folds; complete date cross-section; at least 50,000 rows, 250 dates and 100 symbols per eligible date; no meta-test peeking",
        "entryRule": "next-session-open-or-vwap",
        "costAware": True,
    }


def label_prevalence_report(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Expose monthly label imbalance instead of hiding it in one average."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        month = str(row.get("date") or "")[:7]
        if month:
            grouped[month].append(row)
    monthly = []
    for month in sorted(grouped):
        values = grouped[month]
        count = len(values)
        net_up = sum(1 for row in values if number(row.get("netUpLabel"), number(row.get("actualDirection"))) >= 0.5)
        target = sum(1 for row in values if number(row.get("actualTarget")) >= 0.5)
        stop = sum(1 for row in values if number(row.get("actualStop")) >= 0.5)
        monthly.append({
            "month": month,
            "rows": count,
            "netUpRatePct": round(net_up / max(1, count) * 100.0, 6),
            "targetRatePct": round(target / max(1, count) * 100.0, 6),
            "stopRatePct": round(stop / max(1, count) * 100.0, 6),
        })
    rates = [number(row.get("netUpRatePct")) for row in monthly]
    return {
        "schema": "monthly-label-prevalence-v1",
        "available": bool(monthly),
        "months": monthly,
        "monthCount": len(monthly),
        "netUpRateRangePct": round(max(rates) - min(rates), 6) if rates else None,
        "structuralDriftWarning": bool(rates and max(rates) - min(rates) >= 20.0),
        "policy": "Monthly prevalence is descriptive only; test-period prevalence never sets a training threshold or baseline probability.",
    }


def label_noise_sensitivity(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Measure whether small cost changes reverse the proposed Net-Up label."""
    eligible = [row for row in rows if row.get("actualGrossReturn") is not None]
    scenarios = []
    for multiplier in (0.5, 1.0, 2.0, 3.0):
        flips = 0
        positives = 0
        for row in eligible:
            gross = number(row.get("actualGrossReturn"))
            cost_pct = number(
                row.get("transactionCostBps"),
                MARKET_COST_BPS.get(str(row.get("market") or "ASX").upper(), 18.0),
            ) / 100.0
            stressed = gross - cost_pct * multiplier
            stressed_positive = stressed > 0
            base_positive = number(row.get("netUpLabel"), number(row.get("actualDirection"))) >= 0.5
            positives += 1 if stressed_positive else 0
            flips += 1 if stressed_positive != base_positive else 0
        scenarios.append({
            "costMultiplier": multiplier,
            "rows": len(eligible),
            "positiveRatePct": round(positives / max(1, len(eligible)) * 100.0, 6),
            "flipRatePct": round(flips / max(1, len(eligible)) * 100.0, 6),
        })
    double_cost = next((row for row in scenarios if row["costMultiplier"] == 2.0), None) or {}
    return {
        "schema": "label-noise-cost-sensitivity-v1",
        "available": len(eligible) >= 1_000,
        "rows": len(eligible),
        "scenarios": scenarios,
        "doubleCostFlipRatePct": double_cost.get("flipRatePct"),
        "unstable": number(double_cost.get("flipRatePct"), 100.0) >= 10.0,
        "executionDelaySensitivity": {
            "available": False,
            "reason": "A second point-in-time executable entry series is required; the current dataset does not fabricate delayed VWAP returns.",
        },
        "policy": "A cost-stress flip rate of 10% or more blocks this label from production selection until its execution definition is revised.",
    }


def _complete_cross_section_rows(
    rows: list[dict[str, Any]],
    *,
    min_symbols_per_date: int = 100,
    max_rows: int | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Keep whole eligible date panels; never rank after symbol sampling."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        day = str(row.get("date") or "")[:10]
        if day:
            grouped[day].append(row)
    eligible_days = [
        day for day in sorted(grouped)
        if len({str(row.get("symbol") or "") for row in grouped[day]}) >= min_symbols_per_date
    ]
    if max_rows and max_rows > 0:
        selected_days: list[str] = []
        total = 0
        for day in eligible_days:
            size = len(grouped[day])
            if selected_days and total + size > max_rows:
                break
            selected_days.append(day)
            total += size
        eligible_days = selected_days
    selected_rows = [
        row
        for day in eligible_days
        for row in sorted(grouped[day], key=lambda item: str(item.get("symbol") or ""))
    ]
    return selected_rows, {
        "totalDates": len(grouped),
        "eligibleDates": len(eligible_days),
        "minSymbolsPerDate": int(min_symbols_per_date),
        "rows": len(selected_rows),
        "symbols": len({str(row.get("symbol") or "") for row in selected_rows}),
        "completeDatePanels": True,
    }


def _select_label_tournament_candidate(
    comparisons: list[dict[str, Any]],
    *,
    expected_folds: int,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], int]:
    """Apply the pre-registered label gate without forcing a winner."""
    required_positive_folds = max(3, math.ceil(max(1, expected_folds) * 0.75))
    audited: list[dict[str, Any]] = []
    for candidate in comparisons:
        row = dict(candidate)
        reasons: list[str] = []
        if not row.get("available"):
            reasons.append(str(row.get("status") or "candidate_unavailable"))
        elif row.get("specialistOnly"):
            reasons.append("specialist_task_not_comparable_to_general_label_tournament")
        if int(row.get("foldCount") or 0) != int(expected_folds):
            reasons.append("incomplete_oof_folds")
        if number(row.get("commonPanelCoveragePct"), 0.0) < 95.0:
            reasons.append("common_panel_coverage_below_95pct")
        if int(row.get("positiveFolds") or 0) < required_positive_folds:
            reasons.append("positive_fold_gate_failed")
        if number(row.get("balancedAccuracyPct"), 0.0) <= 50.0:
            reasons.append("balanced_accuracy_not_above_null")
        if number(row.get("brierSkillScore"), -1.0) <= 0.0:
            reasons.append("brier_skill_not_positive")
        if number(row.get("topDecileLift"), -1.0) <= 0.0:
            reasons.append("top_decile_lift_not_positive")
        row["requiredPositiveFolds"] = required_positive_folds
        row["selectionEligible"] = not reasons
        row["rejectionReasons"] = reasons
        audited.append(row)
    eligible = [row for row in audited if row.get("selectionEligible")]
    selected = max(eligible, key=lambda item: number(item.get("objective"), -1e9)) if eligible else None
    return selected, audited, required_positive_folds


def run_label_tournament_oof(
    rows: list[dict[str, Any]],
    *,
    market: str,
    horizon: int,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compare label semantics on identical purged OOF folds.

    This is intentionally a research artifact.  The selected label is not
    allowed to enter the final model or lockbox until a separate untouched
    evaluation accepts it.  The old implementation only counted labels,
    which made the label tournament look complete without comparing outcomes.
    """
    config = config or {}
    required_dates = max(250, int(config.get("labelTournamentMinDates", 250)))
    required_breadth = max(100, int(config.get("labelTournamentMinSymbolsPerDate", 100)))
    tournament_rows, panel_contract = _complete_cross_section_rows(
        rows,
        min_symbols_per_date=required_breadth,
        max_rows=None,
    )
    if len(tournament_rows) < 50_000 or panel_contract["eligibleDates"] < required_dates:
        result = {
            "available": False,
            "status": "evidence_insufficient",
            "reason": f"Label tournament requires at least 50,000 rows, {required_dates} independent dates and {required_breadth} symbols per eligible date.",
            "candidateCount": 6,
            "panelContract": panel_contract,
            "selection": "null/no-model",
            "nullCandidate": {"label": "null", "available": True, "reason": "No label may be selected before complete panel evidence exists."},
        }
        record_experiment(
            config.get("artifactDir"),
            {
                "market": str(market or "ASX").upper(),
                "family": "label-tournament",
                "changedHypothesis": "pre_registered_label_semantics_tournament",
                "horizon": int(horizon),
                "dataVersion": config.get("datasetContentHash"),
                "status": result["status"],
                "candidateCount": 6,
                "panelContract": panel_contract,
                "reason": result["reason"],
                "promotionEligible": False,
            },
        )
        return result
    grouped_dates: dict[str, int] = defaultdict(int)
    for row in tournament_rows:
        grouped_dates[str(row.get("date") or "")] += 1
    eligible_days_for_budget = [
        day for day in sorted(grouped_dates)
        if grouped_dates[day] >= required_breadth
    ]
    required_panel_rows = sum(
        grouped_dates[day]
        for day in eligible_days_for_budget[:required_dates]
    )
    # Selection is by whole dates, never by partial rows.  Add one complete
    # date budget so the 50k row contract cannot miss by a handful of rows
    # when the last eligible date would otherwise be cut off.
    required_panel_rows = max(50_000, required_panel_rows) + max(grouped_dates.values(), default=0)
    # A row cap is only a resource hint.  It may not silently reduce the
    # independent-date contract below 250 complete cross-sections.
    configured_max_rows = int(config.get("labelTournamentMaxRows", 120_000) or 0)
    max_rows = max(50_000, configured_max_rows, required_panel_rows)
    if len(tournament_rows) > max_rows:
        tournament_rows, panel_contract = _complete_cross_section_rows(
            tournament_rows,
            min_symbols_per_date=required_breadth,
            max_rows=max_rows,
        )
    folds = purged_walk_forward_folds(
        tournament_rows,
        horizon=horizon,
        fold_count=int(config.get("foldCount", 5)),
        embargo_days=int(config.get("embargoDays", 7)),
        min_train_dates=min(120, int(config.get("minTrainDates", 500))),
        test_dates=int(config.get("testDates", 120)),
    )
    if len(folds) < 3:
        result = {"available": False, "status": "collecting_evidence", "reason": "Not enough purged folds for label comparison.", "foldCount": len(folds)}
        record_experiment(
            config.get("artifactDir"),
            {
                "market": str(market or "ASX").upper(),
                "family": "label-tournament",
                "changedHypothesis": "pre_registered_label_semantics_tournament",
                "horizon": int(horizon),
                "dataVersion": config.get("datasetContentHash"),
                "status": result["status"],
                "candidateCount": 6,
                "foldCount": len(folds),
                "reason": result["reason"],
                "promotionEligible": False,
            },
        )
        return result
    definitions = {
        "net_up": {
            "labeler": lambda row: number(row.get("netUpLabel"), number(row.get("actualDirection"))) >= 0.5,
            "meaning": "cost-adjusted final return is positive",
        },
        "market_residual_up": {
            "labeler": lambda row: number(row.get("marketResidualUp")) >= 0.5,
            "meaning": "cost-adjusted return exceeds the same-day market cross-section",
        },
        "sector_residual_up": {
            "labeler": lambda row: number(row.get("sectorResidualUp")) >= 0.5,
            "meaning": "cost-adjusted return exceeds a leave-one-out same-sector benchmark",
        },
        "top_decile_positive": {
            "labeler": lambda row: number(row.get("topDecilePositive")) >= 0.5,
            "meaning": "positive cost-adjusted return in the same-day top decile",
        },
        "triple_barrier_target_first": {
            "labeler": lambda row: int(number(row.get("barrierClass"), 1)) == 2,
            "meaning": "adaptive target barrier is reached before the stop barrier",
        },
        "event_car_positive": {
            "labeler": lambda row: number(row.get("eventActionable")) > 0 and number(row.get("marketResidualReturn")) > 0,
            "meaning": "verified actionable event has positive market-residual return",
            "specialistOnly": True,
        },
    }
    # The tournament is a research comparison, not the production learner.
    # Cap each fold deliberately so six labels cannot monopolize the OOF
    # worker or make the task appear frozen at the 60% pre-training phase.
    tournament_epochs = max(6, min(16, int(config.get("labelTournamentEpochs", 8))))
    # Keep one immutable panel in memory.  The previous implementation made
    # six full copies of every feature row before the first fold ran.  On a
    # 500-symbol CN panel that could terminate the worker before any label
    # comparison was recorded.  Candidate labels are now attached only to the
    # current fold, while support is audited from shared row references.
    base_by_key = {
        (str(row.get("date")), str(row.get("symbol"))): row
        for row in tournament_rows
    }
    def tournament_predict(train_rows: list[dict[str, Any]], test_rows: list[dict[str, Any]]) -> list[float]:
        """Use the isolated sklearn runtime for the research-only tournament.

        The production learner keeps its own model stack.  This helper is only
        a fast, fold-local comparator; the pure-Python learner remains the
        deterministic fallback when sklearn is unavailable.
        """
        try:
            # A broken native wheel can terminate this process with SIGBUS
            # before Python can raise an import exception. Probe it in a short
            # child process first, then keep the fallback auditable.
            if not _probe_native_ml_package("sklearn").get("importable"):
                raise RuntimeError("sklearn-native-probe-unavailable")
            import numpy as np  # type: ignore
            from sklearn.linear_model import LogisticRegression  # type: ignore
            from sklearn.pipeline import make_pipeline  # type: ignore
            from sklearn.preprocessing import StandardScaler  # type: ignore
            width = max((len(row.get("x") or []) for row in train_rows), default=0)
            if width <= 0:
                raise ValueError("empty tournament feature vector")
            def matrix(rows):
                return np.nan_to_num(
                    np.asarray([(list(row.get("x") or []) + [0.0] * width)[:width] for row in rows], dtype=float),
                    nan=0.0,
                    posinf=0.0,
                    neginf=0.0,
                )
            x_train = matrix(train_rows)
            y_train = np.asarray([number(row.get("__tournamentLabel")) for row in train_rows], dtype=int)
            if len(set(y_train.tolist())) < 2:
                raise ValueError("single tournament class")
            model = make_pipeline(
                StandardScaler(),
                LogisticRegression(C=0.35, class_weight="balanced", max_iter=120, solver="liblinear", random_state=19),
            )
            model.fit(x_train, y_train)
            return [clamp(float(value), 0.001, 0.999) for value in model.predict_proba(matrix(test_rows))[:, 1]]
        except Exception:
            model = fit_logistic(train_rows, "__tournamentLabel", 0.18, epochs=tournament_epochs)
            return [clamp(predict_logistic(model, row.get("x") or []), 0.001, 0.999) for row in test_rows]

    comparisons = []
    base_keys = {
        (str(row.get("date")), str(row.get("symbol")))
        for row in tournament_rows
    }
    for name, definition in definitions.items():
        labeler = definition["labeler"]
        candidate_rows = [
            row
            for row in tournament_rows
            if not (name == "event_car_positive" and number(row.get("eventActionable")) <= 0)
            and not (name == "sector_residual_up" and row.get("sectorResidualUp") is None)
        ]
        labelled_panel, labelled_contract = _complete_cross_section_rows(
            candidate_rows,
            min_symbols_per_date=required_breadth,
            max_rows=None,
        )
        if len(labelled_panel) < 50_000 or labelled_contract["eligibleDates"] < required_dates:
            comparisons.append({
                "label": name,
                "available": False,
                "status": "insufficient_support",
                "rows": len(candidate_rows),
                "meaning": definition.get("meaning"),
                "specialistOnly": bool(definition.get("specialistOnly")),
                "foldCount": 0,
                "commonPanelCoveragePct": round(len(candidate_rows) / max(1, len(tournament_rows)) * 100.0, 6),
                "panelContract": labelled_contract,
            })
            continue
        fold_metrics = []
        fold_test_members: list[tuple[str, str]] = []
        candidate_keys = {
            (str(item.get("date")), str(item.get("symbol")))
            for item in candidate_rows
        }
        label_by_key = {
            key: 1.0 if labeler(row) else 0.0
            for key, row in base_by_key.items()
            if key in candidate_keys
        }
        for fold in folds:
            # Re-attach the candidate label without changing x or the fold.
            train = [
                {**row, "__tournamentLabel": label_by_key[(str(row.get("date")), str(row.get("symbol")))]}
                for row in fold.get("train") or []
                if (str(row.get("date")), str(row.get("symbol"))) in candidate_keys
            ]
            test = [
                {**row, "__tournamentLabel": label_by_key[(str(row.get("date")), str(row.get("symbol")))]}
                for row in fold.get("test") or []
                if (str(row.get("date")), str(row.get("symbol"))) in candidate_keys
            ]
            train, train_contract = _complete_cross_section_rows(
                train,
                min_symbols_per_date=required_breadth,
                max_rows=max_rows,
            )
            test, test_contract = _complete_cross_section_rows(
                test,
                min_symbols_per_date=required_breadth,
                max_rows=None,
            )
            if len(train) < 10_000 or len(test) < 1_000 or len({number(row.get("__tournamentLabel")) for row in train}) < 2:
                continue
            fold_test_members.extend(
                (str(row.get("date")), str(row.get("symbol")))
                for row in test
            )
            probabilities = tournament_predict(train, test)
            metrics = calibration_metrics(
                test,
                probabilities,
                actual_key="__tournamentLabel",
                bins=5,
                baseline_probability=weighted_prevalence(train, "__tournamentLabel"),
            )
            ranking = rank_ic_summary(
                [{**row, "selectionScore": probabilities[index]} for index, row in enumerate(test)],
                score_key="selectionScore",
            )
            fold_metrics.append({
                "fold": fold.get("fold"),
                "trainRows": len(train),
                "testRows": len(test),
                "testDates": len({str(row.get("date") or "") for row in test}),
                "trainPanel": train_contract,
                "testPanel": test_contract,
                "balancedAccuracyPct": metrics.get("balancedAccuracyPct"),
                "brierSkillScore": metrics.get("brierSkillScore"),
                "top10DirectionHitRatePct": ranking.get("top10DirectionHitRatePct"),
                "topDecileLift": ranking.get("topDecileLift"),
                "positive": (
                    number(metrics.get("balancedAccuracyPct"), 0.0) > 50.0
                    and number(metrics.get("brierSkillScore"), -1.0) > 0
                    and number(ranking.get("topDecileLift"), -1.0) > 0
                ),
            })
        if not fold_metrics:
            comparisons.append({
                "label": name,
                "available": False,
                "status": "no_valid_oof_fold",
                "rows": len(candidate_rows),
                "meaning": definition.get("meaning"),
                "specialistOnly": bool(definition.get("specialistOnly")),
                "foldCount": 0,
                "commonPanelCoveragePct": round(len(candidate_keys & base_keys) / max(1, len(base_keys)) * 100.0, 6),
            })
            continue
        numeric = lambda key: sum(number(item.get(key)) for item in fold_metrics) / len(fold_metrics)
        objective = (numeric("balancedAccuracyPct") - 50.0) + 100.0 * numeric("brierSkillScore") + numeric("topDecileLift")
        comparisons.append({
            "label": name,
            "available": True,
            "status": "oof_compared",
            "meaning": definition.get("meaning"),
            "specialistOnly": bool(definition.get("specialistOnly")),
            "rows": len(candidate_rows),
            "independentDates": len({str(row.get("date") or "") for row in candidate_rows}),
            "foldCount": len(fold_metrics),
            "commonPanelCoveragePct": round(len(candidate_keys & base_keys) / max(1, len(base_keys)) * 100.0, 6),
            "foldTestMembershipHash": stable_hash(sorted(set(fold_test_members)), 24),
            "foldMetrics": fold_metrics,
            "positiveFolds": sum(1 for item in fold_metrics if item.get("positive")),
            "balancedAccuracyPct": round(numeric("balancedAccuracyPct"), 6),
            "brierSkillScore": round(numeric("brierSkillScore"), 8),
            "top10DirectionHitRatePct": round(numeric("top10DirectionHitRatePct"), 6),
            "topDecileLift": round(numeric("topDecileLift"), 8),
            "objective": round(objective, 8),
        })
    available = [item for item in comparisons if item.get("available")]
    selected, audited_comparisons, required_positive_folds = _select_label_tournament_candidate(
        comparisons,
        expected_folds=len(folds),
    )
    result = {
        "available": bool(available),
        "status": "oof_compared" if available else "evidence_insufficient",
        "schema": "label-tournament-v2-six-task-purged-oof",
        "market": str(market or "ASX").upper(),
        "horizon": int(horizon),
        "foldCount": len(folds),
        "requiredPositiveFolds": required_positive_folds,
        "candidateCount": len(definitions),
        "panelContract": panel_contract,
        "selectionUsesUntouchedTest": False,
        "selectionPolicy": "Research ranking only; final label requires a new lockbox and an untouched outer test. A general label needs complete OOF folds, at least 95% common-panel coverage, positive BA/BSS/Top-K lift and at least 75% positive folds. Sparse event CAR remains a separate specialist and cannot win this tournament.",
        "candidates": sorted(audited_comparisons, key=lambda item: number(item.get("objective"), -1e9), reverse=True),
        "selectedResearchCandidate": selected.get("label") if selected else None,
        "selection": selected.get("label") if selected else "null/no-model",
        "nullCandidate": None if selected else {
            "label": "null",
            "available": True,
            "status": "evidence_insufficient",
            "reason": "All candidate labels failed the research gate; no candidate is forced into the model.",
        },
    }
    record_experiment(
        config.get("artifactDir"),
        {
            "market": str(market or "ASX").upper(),
            "family": "label-tournament",
            "changedHypothesis": "pre_registered_label_semantics_tournament",
            "horizon": int(horizon),
            "dataVersion": config.get("datasetContentHash"),
            "status": result["status"],
            "candidateCount": len(definitions),
            "selectedResearchCandidate": result["selectedResearchCandidate"],
            "metrics": result["candidates"],
            "promotionEligible": False,
        },
    )
    return result


def build_market_dataset(
    items: list[dict[str, Any]],
    *,
    market: str,
    horizons: list[int],
    target_upside: float = 5.0,
    stop_loss: float = 4.0,
    transaction_cost_bps: float | None = None,
    market_point_in_time_features: list[dict[str, Any]] | None = None,
    panel_max_symbols: int | None = None,
    panel_date_stride: int = 1,
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
    eligible_panel_rows = 0
    sampled_panel_rows = 0
    skipped_panel_rows = 0
    unexplained_extreme_return_rows = 0
    explained_extreme_return_rows = 0
    extreme_return_examples: list[dict[str, Any]] = []
    audited_outer_exclusions: list[dict[str, Any]] = []
    valid_symbols = sorted({
        str(item.get("symbol") or "").upper()
        for item in items or []
        if isinstance(item, dict)
        and (not str(item.get("market") or "").upper() or str(item.get("market") or "").upper() == key)
        and str(item.get("symbol") or "").strip()
        and len(sanitize_candles(item.get("candles") or [])) >= 70
    })
    max_symbols_per_day = max(0, int(panel_max_symbols or 0))
    date_stride = max(1, int(panel_date_stride or 1))
    bucket_count = max(1, math.ceil(len(valid_symbols) / max_symbols_per_day)) if max_symbols_per_day else 1
    # Hash ordering avoids an alphabetical/listing bias while contiguous
    # buckets guarantee the configured per-date cross-section is a true cap.
    bucket_order = sorted(
        valid_symbols,
        key=lambda symbol: (hashlib.sha256(symbol.encode("utf-8")).hexdigest(), symbol),
    )
    symbol_bucket = {
        symbol: min(bucket_count - 1, index // max(1, max_symbols_per_day))
        for index, symbol in enumerate(bucket_order)
    }

    def selected_panel_row(symbol: str, signal_day: str) -> bool:
        if max_symbols_per_day <= 0 or bucket_count <= 1:
            return True
        try:
            ordinal = date.fromisoformat(signal_day[:10]).toordinal()
        except ValueError:
            return False
        if ordinal % date_stride:
            return False
        return symbol_bucket.get(symbol, 0) == ((ordinal // date_stride) % bucket_count)

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
    fundamental_layer_rows = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        candidates = item.get("pointInTimeFeatures") or item.get("point_in_time_features") or item.get("events") or []
        fundamental_layer_rows.append(
            fundamental_coverage_layers(candidates, FUNDAMENTAL_FEATURE_NAMES)
        )
    fundamental_coverage = {
        layer: sum(1 for row in fundamental_layer_rows if row.get(layer))
        for layer in ("source", "verified", "temporalValid", "nonNull", "nonZero", "actionable")
    }
    fundamental_coverage["items"] = len(fundamental_layer_rows)
    fundamental_coverage["rowCount"] = sum(int(row.get("rowCount") or 0) for row in fundamental_layer_rows)
    fundamental_item_count = fundamental_coverage.get("actionable", 0)
    verified_market_features = has_verified_features(market_point_in_time_features or [])
    event_features_enabled = verified_market_features or event_item_count / max(1, len(items or [])) >= 0.60
    fundamental_features_enabled = fundamental_item_count / max(1, len(items or [])) >= 0.20
    active_feature_names = [
        *CORE_TECHNICAL_FEATURE_NAMES,
        *LIQUIDITY_FEATURE_NAMES,
        *(EVENT_FEATURE_NAMES if event_features_enabled else []),
        *(FUNDAMENTAL_FEATURE_NAMES if fundamental_features_enabled else []),
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
        for horizon in horizons:
            horizon = max(1, int(horizon))
            for index in range(55, len(candles) - horizon):
                signal_day = str(candles[index].get("date") or "")[:10]
                eligible_panel_rows += 1
                panel_selected = selected_panel_row(symbol, signal_day)
                feature = feature_dict(candles, index, feature_series)
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
                universe_coverage = verified_pit_coverage(item.get("universeHistory"), str(candles[index].get("date") or ""), key)
                action_coverage = verified_pit_coverage(item.get("corporateActions"), str(candles[index].get("date") or ""), key)
                gross_return = number(outcome.get("grossForwardReturn"), number(outcome.get("forwardReturn")))
                has_verified_action_evidence = bool(
                    action_coverage.get("covered")
                    or item.get("corporateActionEvidenceVerified") is True
                )
                # Build a compact ranking skeleton for rows that will not be
                # fitted.  This preserves the complete date×symbol universe
                # for cross-sectional ranks without materialising PIT joins,
                # event vectors, and technical feature arrays for every row.
                # The final training matrix still contains only the selected
                # rows, and the summary records both populations.
                if abs(gross_return) > 100.0 and not has_verified_action_evidence:
                    unexplained_extreme_return_rows += 1
                    exclusion = {
                        "market": key,
                        "symbol": symbol,
                        "date": signal_day,
                        "horizon": horizon,
                        "grossReturnPct": gross_return,
                        "reasonCode": "UNVERIFIED_CORPORATE_ACTION_RETURN",
                    }
                    audited_outer_exclusions.append(exclusion)
                    if len(extreme_return_examples) < 20:
                        extreme_return_examples.append(exclusion)
                    continue
                if abs(gross_return) > 100.0 and has_verified_action_evidence:
                    explained_extreme_return_rows += 1
                liquidity_window = candles[max(0, index - 19):index + 1]
                dollar_volumes = [
                    max(0.0, number(candle.get("close"))) * max(0.0, number(candle.get("volume")))
                    for candle in liquidity_window
                ]
                average_dollar_volume = sum(dollar_volumes) / max(1, len(dollar_volumes))
                dollar_volume_variance = sum(
                    (value - average_dollar_volume) ** 2 for value in dollar_volumes
                ) / max(1, len(dollar_volumes))
                dollar_volume_stability = clamp(
                    1.0 - math.sqrt(dollar_volume_variance) / max(1.0, average_dollar_volume),
                    0.0,
                    1.0,
                )
                liquidity_weight = clamp(
                    math.sqrt(max(0.0, number(candles[index].get("volume"))) / max(1.0, median_volume)),
                    0.25,
                    1.0,
                )
                recency_weight = 0.85 + 0.15 * index / max(1, len(candles) - 1)
                training_weight, evaluation_weight = _dataset_row_weight(
                    number(row_quality.get("sampleWeight"), 1.0),
                    number(label_quality.get("labelConfidence"), 1.0),
                    liquidity_weight,
                    recency_weight,
                )
                timeout = not outcome.get("hitTarget") and not outcome.get("hitStop")
                ambiguous = bool(outcome.get("ambiguousBarrierOrder"))
                cross_section_raw = {
                    "change5": number(feature.get("change5")),
                    "change20": number(feature.get("change20")),
                    "volumeRatio": number(feature.get("volumeRatio")),
                    "volatility": number(feature.get("volatility")),
                    "dollarLiquidity": math.log1p(average_dollar_volume),
                    "trendQuality": number(feature.get("trendQuality")),
                    "pressureChange": number(feature.get("pressureChange")),
                    "profileDistance": number(feature.get("profileDistance")),
                }
                if not panel_selected:
                    dataset.append({
                        "date": signal_day,
                        "market": key,
                        "symbol": symbol,
                        "sector": str(item.get("sector") or "Unknown"),
                        "horizon": horizon,
                        "x": [],
                        "featureNames": active_feature_names,
                        "feature": {
                            "change5": number(feature.get("change5")),
                            "change20": number(feature.get("change20")),
                            "volatility": number(feature.get("volatility")),
                            "trendScore": number(feature.get("trendScore"), 50.0),
                        },
                        "regime": _regime_label(feature),
                        "targetBarrierPct": number(barriers.get("targetPct")),
                        "stopBarrierPct": number(barriers.get("stopPct")),
                        "transactionCostBps": costs,
                        "actualTarget": 1.0 if outcome.get("targetWins") else 0.0,
                        "actualStop": 1.0 if outcome.get("stopWins") else 0.0,
                        "actualTimeout": 1.0 if timeout else 0.0,
                        "ambiguousBarrierOrder": ambiguous,
                        "actualReturn": number(outcome.get("forwardReturn")),
                        "actualReturnIsNet": True,
                        "actualDirection": 1.0 if number(outcome.get("forwardReturn")) > 0 else 0.0,
                        "actualGrossReturn": gross_return,
                        "actualMaxUpside": number(outcome.get("maxUpside")),
                        "actualMaxDrawdown": number(outcome.get("maxDrawdown")),
                        "barrierClass": 3 if ambiguous else 0 if outcome.get("stopWins") else 2 if outcome.get("targetWins") else 1,
                        "trainingWeight": training_weight,
                        "evaluationWeight": evaluation_weight,
                        "sampleWeight": evaluation_weight,
                        "labelConfidence": number(label_quality.get("labelConfidence"), 1.0),
                        "dataQualityScore": number(row_quality.get("score"), 100.0),
                        "liquidityWeight": liquidity_weight,
                        "averageDollarVolume20": average_dollar_volume,
                        "dollarVolumeStability20": dollar_volume_stability,
                        "crossSectionRaw": cross_section_raw,
                        "_panelSelected": False,
                    })
                    continue
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
                source_rows += int(pit["sourceRows"])
                excluded_future_rows += int(pit["futureRowsExcluded"])
                event_values = pit["values"]
                x = [number(feature.get(name)) for name in CORE_TECHNICAL_FEATURE_NAMES]
                x.extend([
                    math.log1p(average_dollar_volume),
                    dollar_volume_stability,
                ])
                if event_features_enabled:
                    x.extend(number(event_values.get(name)) for name in EVENT_FEATURE_NAMES)
                if fundamental_features_enabled:
                    x.extend(number(event_values.get(name)) for name in FUNDAMENTAL_FEATURE_NAMES)
                dataset.append({
                    "date": str(candles[index].get("date") or "")[:10],
                    "signalTimestamp": str(candles[index].get("date") or "")[:10],
                    "signalAt": pit["signalAt"],
                    "availableAt": pit["latestAvailableAt"],
                    "market": key,
                    "symbol": symbol,
                    "sector": str(item.get("sector") or "Unknown"),
                    "horizon": horizon,
                    "x": x,
                    "featureNames": active_feature_names,
                    "eventX": [number(event_values.get(name)) for name in EVENT_FEATURE_NAMES],
                    "fundamentalX": [number(event_values.get(name)) for name in FUNDAMENTAL_FEATURE_NAMES],
                    "feature": feature,
                    "regime": _regime_label(feature),
                    "entryDate": outcome.get("entryDate"),
                    "entryPrice": number(outcome.get("entryPrice")),
                    "entrySource": outcome.get("entrySource"),
                    "exitDate": outcome.get("exitDate"),
                    "exitPrice": number(outcome.get("exitPrice")),
                    "exitSource": outcome.get("exitSource"),
                    "targetBarrierPct": number(barriers.get("targetPct")),
                    "stopBarrierPct": number(barriers.get("stopPct")),
                    "transactionCostBps": costs,
                    "actualTarget": 1.0 if outcome.get("targetWins") else 0.0,
                    "actualStop": 1.0 if outcome.get("stopWins") else 0.0,
                    "actualTimeout": 1.0 if timeout else 0.0,
                    "ambiguousBarrierOrder": ambiguous,
                    "actualReturn": number(outcome.get("forwardReturn")),
                    "actualReturnIsNet": True,
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
                    "averageDollarVolume20": average_dollar_volume,
                    "dollarVolumeStability20": dollar_volume_stability,
                    "eventCoverage": 1.0 if int(pit.get("companySourceRows") or 0) > 0 else 0.0,
                    "marketEventCoverage": 1.0 if int(pit.get("marketSourceRows") or 0) > 0 else 0.0,
                    "eventActionable": 1.0 if (
                        number(event_values.get("eventIntensity")) >= 0.15
                        and (
                            int(pit.get("companySourceRows") or 0) > 0
                            or number(event_values.get("announcementScore")) > 0
                        )
                    ) else 0.0,
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
                        "dollarLiquidity": math.log1p(average_dollar_volume),
                        "trendQuality": number(feature.get("trendQuality")),
                        "pressureChange": number(feature.get("pressureChange")),
                        "profileDistance": number(feature.get("profileDistance")),
                    },
                    # Keep the full panel through cross-sectional feature and
                    # label construction.  This marker is applied only after
                    # ranks are computed, so sampling cannot change the
                    # within-day universe used by the ranker.
                    "_panelSelected": panel_selected,
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
    ranking_universe_rows = len(dataset)
    ranking_universe_symbols = len({str(row.get("symbol")) for row in dataset})
    ranking_universe_dates = len({str(row.get("date")) for row in dataset})
    _rank_cross_section(dataset)
    daily_return_sentinel: list[dict[str, Any]] = []
    daily_returns: dict[str, list[float]] = defaultdict(list)
    for row in dataset:
        daily_returns[str(row.get("date") or "")].append(number(row.get("actualGrossReturn")))
    for day, values in daily_returns.items():
        if len(values) < 10:
            continue
        mean_return = sum(values) / len(values)
        # actualGrossReturn is the cumulative label for the current horizon,
        # not a one-session return.  A five-day market rally around 20% is a
        # legitimate regime; treating it as a daily-feed failure incorrectly
        # blocked the CN run on 2024-09-23/24.  Keep the sentinel for genuine
        # impossible-scale contamination (for example the previously observed
        # multi-million-percent US rows), while retaining the exact horizon in
        # the audit output.
        horizon_values = [int(row.get("horizon") or 1) for row in dataset if str(row.get("date") or "") == day]
        horizon = max(1, max(horizon_values, default=1))
        sentinel_threshold = max(100.0, 20.0 * math.sqrt(horizon))
        if abs(mean_return) > sentinel_threshold:
            daily_return_sentinel.append({
                "date": day,
                "rows": len(values),
                "meanGrossReturnPct": round(mean_return, 6),
                "horizonDays": horizon,
                "thresholdPct": round(sentinel_threshold, 6),
            })
    sector_semantics = _sector_semantics_audit(dataset)
    skipped_panel_rows = sum(1 for row in dataset if not row.get("_panelSelected", True))
    sampled_panel_rows = sum(1 for row in dataset if row.get("_panelSelected", True))
    sentinel_days = {str(row.get("date") or "") for row in daily_return_sentinel}
    sentinel_rows_excluded = sum(
        1 for row in dataset
        if row.get("_panelSelected", True) and str(row.get("date") or "") in sentinel_days
    )
    for row in dataset:
        if row.get("_panelSelected", True) and str(row.get("date") or "") in sentinel_days:
            audited_outer_exclusions.append({
                "market": key,
                "symbol": str(row.get("symbol") or ""),
                "date": str(row.get("date") or ""),
                "horizon": int(row.get("horizon") or 0),
                "reasonCode": "DAILY_CROSS_SECTION_RETURN_SENTINEL",
            })
        elif not row.get("_panelSelected", True):
            audited_outer_exclusions.append({
                "market": key,
                "symbol": str(row.get("symbol") or ""),
                "date": str(row.get("date") or ""),
                "horizon": int(row.get("horizon") or 0),
                "reasonCode": "INNER_BUDGET_PANEL_SAMPLE",
            })
    # A date-level mean move above 20% across a broad panel is a provider or
    # corporate-action integrity failure, not a market regime. Keep the full
    # skeleton for audit/ranking diagnostics, but exclude that date from every
    # fitted/evaluated matrix so a bad feed cannot manufacture alpha.
    dataset = [
        row for row in dataset
        if row.get("_panelSelected", True) and str(row.get("date") or "") not in sentinel_days
    ]
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
    summary["eventActionableRowCoveragePct"] = round(
        sum(1 for row in dataset if number(row.get("eventActionable")) > 0) / max(1, len(dataset)) * 100.0,
        3,
    )
    summary["fundamentalItemCoveragePct"] = round(
        fundamental_coverage.get("nonZero", 0) / max(1, len(items or [])) * 100.0,
        3,
    )
    summary["fundamentalCoverageLayers"] = {
        **fundamental_coverage,
        "percent": {
            layer: round(value / max(1, len(items or [])) * 100.0, 3)
            for layer, value in fundamental_coverage.items()
            if layer in {"source", "verified", "temporalValid", "nonNull", "nonZero", "actionable"}
        },
    }
    summary["fundamentalFeaturesEnabled"] = fundamental_features_enabled
    summary["fundamentalFeatureNames"] = FUNDAMENTAL_FEATURE_NAMES if fundamental_features_enabled else []
    summary["marketPointInTimeFeaturesAvailable"] = verified_market_features
    summary["eventFeatureActivationReason"] = (
        "verified-market-and-company-pit" if verified_market_features and event_item_count
        else "verified-market-pit" if verified_market_features
        else "verified-company-pit" if event_item_count
        else "insufficient-verified-pit"
    )
    summary["rankingLabel"] = {
        "schema": "daily-sign-first-net-sector-residual-v1",
        "formula": "net_up + 0.75*sector_residual_up + 0.75*top_decile_positive + 0.05*cost_return_rank",
        "range": [0, 2.55],
        "pointInTimeSafe": True,
        "note": "Direction relevance is sign-first; continuous return is only a tie-breaker. Labels are future outcomes used only during training and never enter x.",
    }
    summary["rankingLabelTournament"] = {
        "pathObjective": "rankRelevance: target-first path with return tie-break",
        "directionObjective": "rankDirectionRelevance: net_up first, then sector residual and top-decile positive",
        "selectionMetric": "long_only_top_decile_final_direction_and_cost_adjusted_return",
        "selectionPolicy": "Both rankers are trained as challengers; the inner purged validation block chooses the safer objective before the untouched meta-test.",
        "pointInTimeSafe": True,
    }
    summary["labelTournament"] = label_tournament_summary(dataset)
    summary["labelPrevalence"] = label_prevalence_report(dataset)
    summary["labelNoiseSensitivity"] = label_noise_sensitivity(dataset)
    # A small number of fully quarantined cross-sectional sentinel dates must
    # not poison an otherwise usable OOF matrix.  The rows are already removed
    # above; only a material share of the panel or too many dates remains a
    # hard training block.  This keeps the audit strict while allowing US to
    # proceed after the known two-date corporate-action feed anomaly is
    # isolated rather than silently used for fitting.
    sentinel_quarantine_ratio = sentinel_rows_excluded / max(1, ranking_universe_rows)
    sentinel_quarantine_allowed = bool(
        daily_return_sentinel
        and sentinel_quarantine_ratio <= 0.01
        and len(sentinel_days) <= max(10, int(ranking_universe_dates * 0.02))
    )
    sentinel_hard_blocked = bool(daily_return_sentinel) and not sentinel_quarantine_allowed
    summary["returnAudit"] = {
        "schema": "return-sentinel-v1",
        "grossReturnThresholdPct": 100.0,
        "sentinelMeanThresholdPolicy": "max(100%, 20% * sqrt(horizon_days)); actualGrossReturn is cumulative, not one-session return",
        "unexplainedExtremeRowsExcluded": unexplained_extreme_return_rows,
        "sentinelDaysRowsExcluded": sentinel_rows_excluded,
        "sentinelDaysExcluded": sorted(sentinel_days),
        "explainedExtremeRowsRetained": explained_extreme_return_rows,
        "dailyCrossSectionSentinels": daily_return_sentinel[:20],
        "examples": extreme_return_examples,
        "sentinelRowsRatio": round(sentinel_quarantine_ratio, 8),
        "sentinelQuarantineAllowed": sentinel_quarantine_allowed,
        "trainingBlocked": sentinel_hard_blocked,
        "policy": "exclude unexplained corporate-action outliers; never winsorize labels",
    }
    training_block_reasons = []
    if sentinel_hard_blocked:
        training_block_reasons.append("unexplained-daily-return-sentinel")
    if int(cross_market_rows_excluded or 0) > 0:
        training_block_reasons.append("cross-market-contamination-excluded")
    # Rows whose feature timestamp is after the signal date are expected to be
    # removed by the point-in-time join.  Keep the count for auditability, but
    # do not treat normal leakage prevention as evidence that the dataset is
    # invalid.  A true temporal violation is recorded separately by the PIT
    # join audit and remains a hard blocker.
    summary["futureFeaturePolicy"] = {
        "excludedRowsAreExpected": True,
        "excludedRows": int(excluded_future_rows or 0),
        "hardBlockField": "pointInTimeJoinViolationCount",
    }
    summary["trainingBlockReasons"] = training_block_reasons
    summary["trainingBlocked"] = bool(training_block_reasons)
    summary["trainingQuarantineReasons"] = (
        ["unexplained-daily-return-sentinel"] if sentinel_quarantine_allowed else []
    )
    summary["sectorSemantics"] = sector_semantics
    summary["regimeAlphaSplit"] = {
        "schema": "regime-sector-stock-alpha-v1",
        "regimeFeatures": REGIME_FEATURE_NAMES,
        "stockRankerExcludedFeatures": sorted(RANK_EXCLUDED_FEATURE_NAMES),
        "stockRankerUsesResidualLabels": ["sectorResidualUp", "marketResidualUp"],
        "executionFeaturesRemainSeparate": True,
        "status": "wired_into_ranker_projection",
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
    summary["panelSampling"] = {
        "enabled": max_symbols_per_day > 0 and (bucket_count > 1 or date_stride > 1),
        "method": "deterministic-date-stratified-cross-section",
        "maxSymbolsPerSelectedDate": max_symbols_per_day or None,
        "dateStride": date_stride,
        "bucketCount": bucket_count,
        "eligiblePanelRows": eligible_panel_rows,
        "sampledPanelRows": sampled_panel_rows,
        "skippedPanelRows": skipped_panel_rows,
        "rankingUniverseRows": ranking_universe_rows,
        "rankingUniverseSymbols": ranking_universe_symbols,
        "rankingUniverseDates": ranking_universe_dates,
        "rankingComputedBeforeSampling": True,
        "note": "Daily cross-sectional and sector ranks are computed on the complete eligible date×symbol panel first. Deterministic sampling is applied only after those ranks exist; fitted-row counts remain the actual sampled counts.",
    }
    exclusion_reason_counts: dict[str, int] = defaultdict(int)
    for exclusion in audited_outer_exclusions:
        exclusion_reason_counts[str(exclusion.get("reasonCode") or "UNSPECIFIED")] += 1
    outer_eligible_rows = len(dataset) + len(audited_outer_exclusions)
    outer_conservation = {
        "schema": "outer-panel-row-conservation-v1",
        "eligibleRows": outer_eligible_rows,
        "evaluatedRows": len(dataset),
        "auditedExcludedRows": len(audited_outer_exclusions),
        "sampledRows": len(dataset),
        "skippedRows": 0,
        "identity": "market:symbol:signal_date:horizon",
        "reasonCounts": dict(sorted(exclusion_reason_counts.items())),
        "exclusions": audited_outer_exclusions,
        "passed": outer_eligible_rows == len(dataset) + len(audited_outer_exclusions),
        "completeDailyCrossSection": max_symbols_per_day == 0 and date_stride == 1,
        "note": "Outer OOF evaluates the full audited daily cross-section. Any inner-budget sampling is an explicit audited exclusion and is prohibited for promotion evidence.",
    }
    summary["outerCrossSectionRowConservation"] = outer_conservation
    technical_count = len(CORE_TECHNICAL_FEATURE_NAMES) + len(LIQUIDITY_FEATURE_NAMES) + len(CROSS_SECTIONAL_FEATURE_NAMES)
    enabled_pit_families = []
    if event_features_enabled:
        enabled_pit_families.append("event")
    if fundamental_features_enabled:
        enabled_pit_families.append("fundamental")
    summary["featurePolicy"] = (
        f"Core {technical_count} normalized technical/cross-sectional features plus verified point-in-time {', '.join(enabled_pit_families)} features."
        if enabled_pit_families
        else f"Core {technical_count} normalized technical/cross-sectional features; event and fundamental features withheld because verified point-in-time coverage is insufficient."
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
        "_panelSelected",
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


def frozen_oof_test_membership(
    rows: list[dict[str, Any]],
    *,
    horizon: int,
    fold_count: int = 5,
    embargo_days: int = 7,
    min_train_dates: int = 500,
    test_dates: int = 120,
) -> dict[str, Any]:
    """Hash the actual outer OOF members before any learner is fitted."""
    folds = purged_walk_forward_folds(
        rows,
        horizon=horizon,
        fold_count=fold_count,
        embargo_days=embargo_days,
        min_train_dates=min_train_dates,
        test_dates=test_dates,
    )
    def member(fold_number: int, row: dict[str, Any]) -> tuple[int, str, str, str]:
        return (
            int(fold_number),
            str(row.get("date") or ""),
            str(row.get("symbol") or ""),
            stable_hash({
                "x": row.get("x") or [],
                "actualReturn": row.get("actualReturn"),
                "actualDirection": row.get("actualDirection"),
                "actualTarget": row.get("actualTarget"),
                "actualStop": row.get("actualStop"),
                "barrierClass": row.get("barrierClass"),
                "netUpLabel": row.get("netUpLabel"),
                "marketResidualUp": row.get("marketResidualUp"),
                "sectorResidualUp": row.get("sectorResidualUp"),
                "topDecilePositive": row.get("topDecilePositive"),
            }, 24),
        )
    test_members = sorted({
        member(int(fold.get("fold") or 0), row)
        for fold in folds
        for row in (fold.get("test") or [])
        if row.get("date") and row.get("symbol")
    })
    train_members = sorted({
        member(int(fold.get("fold") or 0), row)
        for fold in folds
        for row in (fold.get("train") or [])
        if row.get("date") and row.get("symbol")
    })
    universe_members = sorted({
        (str(row.get("date") or ""), str(row.get("symbol") or ""))
        for row in rows
        if row.get("date") and row.get("symbol")
    })
    dates = sorted({day for _, day, _, _ in test_members})
    split_contract = [{
        "fold": int(fold.get("fold") or 0),
        "trainStart": fold.get("trainStart"),
        "trainEnd": fold.get("trainEnd"),
        "testStart": fold.get("testStart"),
        "testEnd": fold.get("testEnd"),
        "purgeDays": fold.get("purgeDays"),
        "embargoDays": fold.get("embargoDays"),
    } for fold in folds]
    return {
        "schema": "frozen-oof-test-membership-v1",
        "signature": stable_hash(test_members, 32) if test_members else None,
        "testMembershipHash": stable_hash(test_members, 32) if test_members else None,
        "trainMembershipHash": stable_hash(train_members, 32) if train_members else None,
        "universeMembershipHash": stable_hash(universe_members, 32) if universe_members else None,
        "splitHash": stable_hash(split_contract, 32) if split_contract else None,
        "foldCount": len(folds),
        "rowCount": len(test_members),
        "trainRowCount": len(train_members),
        "independentDates": len(dates),
        "firstDate": dates[0] if dates else None,
        "lastDate": dates[-1] if dates else None,
        "purgeDays": max(1, int(horizon)),
        "embargoDays": max(0, int(embargo_days)),
    }


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


def _probe_native_ml_package(module: str) -> dict[str, Any]:
    """Probe optional native ML wheels out-of-process.

    Some macOS wheels can terminate the interpreter with SIGBUS while loading
    OpenMP/native code. A normal try/except cannot catch that signal, so the
    probe runs in a short child process and lets the pure-Python baseline
    continue when a wheel is installed but not importable.
    """
    key = str(module or "").strip()
    if key in _NATIVE_ML_HEALTH:
        return dict(_NATIVE_ML_HEALTH[key])
    try:
        installed = importlib.util.find_spec(key) is not None
    except Exception as exc:  # pragma: no cover - import machinery failure
        result = {"installed": False, "importable": False, "error": str(exc)[:240]}
        _NATIVE_ML_HEALTH[key] = result
        return dict(result)
    if not installed or str(os.getenv("QUANT_DISABLE_NATIVE_ML", "")).lower() in {"1", "true", "yes"}:
        result = {
            "installed": installed,
            "importable": False,
            "error": "disabled-by-resource-policy" if installed else "package-not-installed",
        }
        _NATIVE_ML_HEALTH[key] = result
        return dict(result)
    try:
        # Native wheels are optional.  A broken OpenMP/pandas wheel must not
        # block the entire training worker or make the status page wait for a
        # minute while probing three packages.  The pure-Python baseline is
        # the deterministic fallback when this short probe fails.
        probe_timeout_ms = max(750, min(8_000, int(os.getenv("QUANT_NATIVE_ML_PROBE_TIMEOUT_MS", "2500"))))
        probe = subprocess.run(
            [sys.executable, "-c", "import importlib; importlib.import_module(__import__('sys').argv[1])", key],
            cwd=str(Path(__file__).resolve().parent.parent),
            env={**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=probe_timeout_ms / 1000,
            check=False,
        )
        if probe.returncode == 0:
            result = {"installed": True, "importable": True, "error": None}
        else:
            result = {
                "installed": True,
                "importable": False,
                "error": f"probe-exit-{probe.returncode}: {probe.stderr.decode(errors='replace')[-240:]}",
            }
    except Exception as exc:
        result = {"installed": True, "importable": False, "error": str(exc)[:240]}
    _NATIVE_ML_HEALTH[key] = result
    return dict(result)


def model_library_status() -> dict[str, Any]:
    health = {name: _probe_native_ml_package(name) for name in ("catboost", "lightgbm", "sklearn")}
    return {
        "catboost": health["catboost"]["importable"],
        "lightgbm": health["lightgbm"]["importable"],
        "sklearn": health["sklearn"]["importable"],
        "catboostInstalled": health["catboost"]["installed"],
        "lightgbmInstalled": health["lightgbm"]["installed"],
        "sklearnInstalled": health["sklearn"]["installed"],
        "nativeImportErrors": {
            name: value["error"]
            for name, value in health.items()
            if value.get("error")
        },
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
    # The caller's resource profile is a hard budget.  The former 20k floor
    # silently overrode balanced/low-memory runs and could terminate a fold
    # after the feature matrix had already been built.  Five thousand rows is
    # still above the tree eligibility gate and lets a Research Challenger
    # complete on a constrained local machine.
    tree_max_rows = max(5_000, int(config.get("treeMaxRows", os.getenv("PRODUCTION_TREE_MAX_ROWS", "40000"))))
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
    feature_width = len(x_train[0]) if x_train else 0
    if feature_width == 0:
        # A null/no-model feature profile is an intentional evidence result,
        # not a native-library failure.  Keep the challenger in the report as
        # skipped so the fold cannot be mistaken for a broken CatBoost run.
        return {
            "error": "tree-challenger-skipped: selected feature profile is null/no-model",
            "skippedReason": "feature-profile-null/no-model",
            "trainingPolicy": {
                "sampledTrainingRows": 0,
                "fitRows": 0,
                "validationRows": 0,
                "featureCount": 0,
            },
        }
    rank_layout = _rank_feature_layout(train[0]) if train else {"indexes": [], "names": [], "excluded": []}
    rank_indexes = list(rank_layout.get("indexes") or range(len(x_train[0]) if x_train else 0))
    rank_x_train = [[values[index] for index in rank_indexes] for values in x_train]
    rank_x_test = [[values[index] for index in rank_indexes] for values in x_test]
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
            # A path class can legitimately be absent in a short or unusually
            # one-sided window.  That must not discard the independent
            # direction, rank and quantile challengers for the whole fold.
            tree_warnings: list[str] = []
            path_labels = [int(train[index]["barrierClass"]) for index in fit_indexes]
            path_classes_seen = sorted(set(path_labels))
            path = None
            if len(path_classes_seen) >= 2:
                try:
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
                        path_labels,
                        sample_weight=[sample_weight[index] for index in fit_indexes],
                        eval_set=(
                            [x_train[index] for index in validation_indexes],
                            [train[index]["barrierClass"] for index in validation_indexes],
                        ),
                        use_best_model=True,
                    )
                except Exception as exc:  # noqa: BLE001 - retain other independent heads.
                    path = None
                    tree_warnings.append(f"path: {exc}")
            else:
                tree_warnings.append("path: single-class training window")
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
            direction_rank_scores = None
            ranker_objectives: list[str] = []
            rank_weight_policy = {
                "applied": False,
                "reason": "CatBoost pairwise ranking does not support object weights; ranking uses unweighted date groups.",
            }
            if median_cross_section >= 30:
                rank_fit_indexes = sorted(fit_indexes, key=lambda index: (str(train[index].get("date")), str(train[index].get("symbol"))))
                rank_validation_indexes = sorted(validation_indexes, key=lambda index: (str(train[index].get("date")), str(train[index].get("symbol"))))

                def fit_ranker(label_key: str, seed: int) -> list[float] | None:
                    try:
                        rank_train_pool = Pool(
                            [rank_x_train[index] for index in rank_fit_indexes],
                            label=[number(train[index].get(label_key)) for index in rank_fit_indexes],
                            group_id=[str(train[index].get("date")) for index in rank_fit_indexes],
                        )
                        rank_validation_pool = Pool(
                            [rank_x_train[index] for index in rank_validation_indexes],
                            label=[number(train[index].get(label_key)) for index in rank_validation_indexes],
                            group_id=[str(train[index].get("date")) for index in rank_validation_indexes],
                        )
                        ranker = CatBoostRanker(
                            iterations=tree_iterations,
                            depth=4,
                            learning_rate=0.04,
                            loss_function="YetiRankPairwise",
                            eval_metric="NDCG",
                            l2_leaf_reg=10.0,
                            random_strength=0.30,
                            bootstrap_type="Bernoulli",
                            subsample=0.80,
                            od_type="Iter",
                            od_wait=early_stopping_rounds,
                            verbose=False,
                            random_seed=seed,
                            thread_count=tree_threads,
                        )
                        ranker.fit(rank_train_pool, eval_set=rank_validation_pool, use_best_model=True)
                        ranker_objectives.append(label_key)
                        return [number(value) for value in ranker.predict(rank_x_test)]
                    except Exception as exc:  # noqa: BLE001 - keep the independent baseline usable.
                        tree_warnings.append(f"rank-{label_key}: {exc}")
                        return None

                # Keep the path-oriented ranker as an auditable challenger,
                # and train a separate ranker whose label exactly matches the
                # production long-only Top-10 direction metric.
                rank_scores = fit_ranker("rankRelevance", 41)
                direction_rank_scores = fit_ranker("rankDirectionRelevance", 43)
            path_matrix = path.predict_proba(x_test) if path is not None else None
            path_classes = {
                int(label): index
                for index, label in enumerate(getattr(path, "classes_", path_classes_seen))
            } if path is not None else {}
            path_priors = {
                label: sum(value == label for value in path_labels) / max(1, len(path_labels))
                for label in (0, 1, 2)
            }

            def path_probability(label: int) -> list[float]:
                if path_matrix is None:
                    return [number(path_priors.get(label)) for _ in test]
                position = path_classes.get(label)
                if position is None:
                    return [number(path_priors.get(label)) for _ in test]
                return [number(row[position]) for row in path_matrix]

            quantiles = []
            for alpha in (0.1, 0.5, 0.9):
                try:
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
                except Exception as exc:  # noqa: BLE001 - keep a fold usable with a linear fallback later.
                    tree_warnings.append(f"quantile-{alpha}: {exc}")
                    quantiles = []
                    break
            return {
                "family": "catboost-shallow-joint-path-quantile",
                "target": path_probability(2),
                "stop": path_probability(0),
                "timeout": path_probability(1),
                "rank": rank_scores,
                "directionRank": direction_rank_scores,
                "quantiles": quantiles or None,
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
                    "jointPathModel": path is not None,
                    "rankerWithheld": rank_scores is None,
                    "directionRankerWithheld": direction_rank_scores is None,
                    "rankLabelSchema": "daily-path-priority-plus-return-tiebreak-v4",
                    "directionRankLabelSchema": "daily-sign-first-net-sector-residual-v1",
                    "rankFeatureSchema": rank_layout.get("schema"),
                    "rankFeatureNames": rank_layout.get("names"),
                    "rankExcludedRegimeFeatures": rank_layout.get("excluded"),
                    "rankerObjectives": ranker_objectives,
                    "rankWeightPolicy": rank_weight_policy,
                    "directionSingleClass": len(direction_classes) < 2,
                    "warnings": tree_warnings,
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
    # An event expert is conditional.  No event is not a neutral event and
    # must not be converted into a confident average prediction.
    event_train = [row for row in train if number(row.get("eventActionable")) > 0]
    coverage = len(event_train) / max(1, len(train))
    if coverage < 0.10 or len(event_train) < 2_000 or sum(row["actualTarget"] for row in event_train) < 200:
        return None
    mapped_train = [{**row, "x": _event_feature_vector(row)} for row in event_train]
    mapped_test = [{**row, "x": _event_feature_vector(row)} for row in test]
    model = fit_logistic(mapped_train, "actualTarget", 0.14)
    predictions = [predict_logistic(model, row["x"]) for row in mapped_test]
    return [predictions[index] if number(row.get("eventActionable")) > 0 else None for index, row in enumerate(test)]


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
        return calibration_metrics(
            validation_rows,
            probabilities,
            bins=6,
            actual_key="actualDirection",
            baseline_probability=weighted_prevalence(fit_rows, "actualDirection"),
        )

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

    compact_names = set(COMPACT_TECHNICAL_FEATURE_NAMES) | set(LIQUIDITY_FEATURE_NAMES) | set(COMPACT_CROSS_SECTIONAL_FEATURE_NAMES)
    technical_names = set(CORE_TECHNICAL_FEATURE_NAMES) | set(LIQUIDITY_FEATURE_NAMES) | set(CROSS_SECTIONAL_FEATURE_NAMES)
    event_names = (set(EVENT_FEATURE_NAMES) - set(MACRO_FEATURE_NAMES) - {"macroRisk"}) | set(FUNDAMENTAL_FEATURE_NAMES)
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
    null_window_briers: list[float] = []
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
        train_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in inner]
        train_weight_total = sum(train_weights) or 1.0
        prevalence = sum(
            number(row.get("actualDirection")) * train_weights[index]
            for index, row in enumerate(inner)
        ) / train_weight_total
        baseline_brier = sum(
            (prevalence - number(row.get("actualDirection"))) ** 2 * weights[index]
            for index, row in enumerate(validation)
        ) / total_weight
        null_window_briers.append(baseline_brier)
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
            metrics = calibration_metrics(
                validation_rows,
                probabilities,
                bins=6,
                actual_key="actualDirection",
                baseline_probability=prevalence,
            )
            model_brier = number(metrics.get("brier"), 1.0)
            candidate_metrics[profile].append({
                "brier": model_brier,
                "baselineBrier": baseline_brier,
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
        brier_values = [number(row.get("brier"), 1.0) for row in rows]
        brier_se = (
            math.sqrt(sum((value - mean_brier) ** 2 for value in brier_values) / max(1, len(brier_values) - 1))
            / math.sqrt(max(1, len(brier_values)))
            if len(brier_values) > 1 else 0.0
        )
        mean_balanced = sum(number(row.get("balancedAccuracyPct")) for row in rows) / max(1, len(rows))
        mean_f1 = sum(number(row.get("f1Pct")) for row in rows) / max(1, len(rows))
        negative_windows = sum(1 for row in rows if number(row.get("brierSkill")) <= 0)
        score = mean_brier + negative_windows * 0.00075 + max(0.0, 50.0 - mean_balanced) / 1_000.0
        comparisons.append({
            "profile": profile,
            "featureCount": len(candidates[profile]),
            "meanBrier": round(mean_brier, 7),
            "brierStandardError": round(brier_se, 7),
            "meanBrierSkill": round(mean_skill, 7),
            "meanBalancedAccuracyPct": round(mean_balanced, 5),
            "meanF1Pct": round(mean_f1, 5),
            "negativeSkillWindows": negative_windows,
            "selectionScore": round(score, 7),
            "windows": rows,
        })
    comparisons.sort(key=lambda row: (number(row.get("selectionScore"), 1.0), -number(row.get("meanF1Pct"))))
    null_brier = sum(null_window_briers) / max(1, len(null_window_briers))
    null_se = (
        math.sqrt(sum((value - null_brier) ** 2 for value in null_window_briers) / max(1, len(null_window_briers) - 1))
        / math.sqrt(max(1, len(null_window_briers)))
        if len(null_window_briers) > 1 else 0.0
    )
    best = comparisons[0]
    improvement = null_brier - number(best.get("meanBrier"), 1.0)
    one_se = math.sqrt(number(best.get("brierStandardError")) ** 2 + null_se ** 2)
    null_reason = None
    if number(best.get("meanBrierSkill"), -1.0) <= 0:
        null_reason = "all-feature-profiles-have-non-positive-inner-brier-skill"
    elif improvement <= one_se:
        null_reason = "best-profile-improvement-is-within-one-standard-error-of-null"
    if null_reason:
        selected_profile = "null/no-model"
        selected_indexes: list[int] = []
        return train, test, {
            "available": True,
            "method": "nested-multi-window-feature-profile-selection",
            "familyScope": "linear-direction-only",
            "selectionUsesHeldOutFold": False,
            "selectedProfile": selected_profile,
            "modelEligible": False,
            "nullReason": null_reason,
            "nullMeanBrier": round(null_brier, 7),
            "nullStandardError": round(null_se, 7),
            "bestImprovementVsNull": round(improvement, 7),
            "oneStandardError": round(one_se, 7),
            "retainedFeatures": [],
            "windows": windows,
            "comparisons": comparisons,
        }
    # A one-standard-error rule prefers the smallest profile whose score is
    # statistically indistinguishable from the best profile.  This keeps
    # event/fundamental expansions from winning on a tiny inner-window edge.
    best_score = number(best.get("selectionScore"), 1.0)
    eligible = [
        row for row in comparisons
        if number(row.get("selectionScore"), 1.0) <= best_score + number(best.get("brierStandardError"))
    ]
    selected_profile = min(
        eligible,
        key=lambda row: (int(row.get("featureCount") or 10**9), number(row.get("selectionScore"), 1.0)),
    )["profile"]
    selected_indexes = candidates[str(selected_profile)]
    return mapped(train, selected_indexes), mapped(test, selected_indexes), {
        "available": True,
        "method": "nested-multi-window-feature-profile-selection",
        "familyScope": "linear-direction-only",
        "selectionUsesHeldOutFold": False,
        "selectedProfile": selected_profile,
        "modelEligible": True,
        "nullMeanBrier": round(null_brier, 7),
        "nullStandardError": round(null_se, 7),
        "bestImprovementVsNull": round(improvement, 7),
        "oneStandardError": round(one_se, 7),
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
    # Feature-profile selection is a linear-direction experiment. It must not
    # silently narrow the inputs of the path, rank, return, event or tree
    # experts, and a null Logistic result cannot stand in for every model
    # family. Keep the shared panel intact and project a separate copy only for
    # the linear direction heads.
    shared_train, shared_test = train, test
    direction_train, direction_test, feature_profile_gate = _training_feature_profile_gate(
        shared_train,
        shared_test,
    )
    direction_profile_null = feature_profile_gate.get("selectedProfile") == "null/no-model"
    # The direction profile gate is deliberately strict, but it is only a
    # gate for the direction probability head.  Previously its null result
    # aborted the whole fold, which also discarded independent path, ranking,
    # return and event evidence.  That turned a weak direction signal into a
    # market-wide NO_MODEL and made the latest candidate look much worse than
    # the actual family-level evidence.  Keep those other experts research-
    # only until their own OOF gates are evaluated below.
    if direction_profile_null and (
        len(shared_train) < 10
        or len(shared_test) < 2
        or not all(
            "actualTarget" in row and "actualReturn" in row
            for row in shared_train[: min(10, len(shared_train))]
        )
    ):
        return [], {
            "status": "NO_MODEL",
            "candidateStatus": "NO_MODEL",
            "nullModelContractVersion": NULL_MODEL_CONTRACT_VERSION,
            "reason": "feature-profile-null/no-model-and-no-independent-path-evidence",
            "predictionCount": 0,
            "trainRows": len(original_train),
            "testRows": len(original_test),
            "featureProfileGate": feature_profile_gate,
            "featureStability": feature_stability,
            "featureFamilyGate": feature_family_gate,
            "preControlFeatureDrift": pre_control_drift,
        }
    baseline_rows = int(config.get("baselineMaxRows", os.getenv("PRODUCTION_BASELINE_MAX_ROWS", "6000")))
    path_train = [row for row in shared_train if row.get("ambiguousBarrierOrder") is not True]
    baseline = _sklearn_baseline_predictions(
        path_train,
        shared_test,
        enabled=enable_sklearn_models,
        max_rows=max(2_000, baseline_rows),
    ) or _fallback_baseline_predictions(path_train, shared_test, max_rows=baseline_rows)
    direction_baseline = None
    if not direction_profile_null:
        shared_names = _feature_names_for_row(shared_train[0]) if shared_train else []
        direction_names = _feature_names_for_row(direction_train[0]) if direction_train else []
        direction_baseline = _sklearn_baseline_predictions(
            direction_train,
            direction_test,
            enabled=enable_sklearn_models,
            max_rows=max(2_000, baseline_rows),
        ) or _fallback_baseline_predictions(direction_train, direction_test, max_rows=baseline_rows)
    baseline_return = baseline["baselineReturn"]
    stable_direction_probability = direction_baseline["direction"] if direction_baseline else None
    elastic_direction_probability = direction_baseline["elasticDirection"] if direction_baseline else None
    direction_probability_rows = direction_baseline["direction"] if direction_baseline else None
    stable_baseline_probability = baseline["target"]
    elastic_probability = baseline["elasticTarget"]
    target_probability_rows = baseline["target"]
    stop_probability = baseline["stop"]
    timeout_probability = baseline["timeout"]
    rank_scores = baseline["rank"]
    tree = _tree_fold_predictions(shared_train, shared_test, enabled=enable_tree_models, config=config)
    quantile_train: list[dict[str, Any]] = []
    quantiles: list[list[float]] | None = None
    family = baseline["family"]
    if tree and not tree.get("error"):
        family = f"{family}+{tree.get('family')}"
        target_probability_rows = tree["target"]
        stop_probability = tree["stop"]
        timeout_probability = tree["timeout"]
        if tree.get("rank") is not None:
            rank_scores = tree["rank"]
        quantiles = tree.get("quantiles")
        if tree.get("direction") is not None:
            direction_probability_rows = tree["direction"]
    if not quantiles:
        quantile_max_rows = max(2_000, min(50_000, int(config.get("quantileMaxRows", os.getenv("PRODUCTION_QUANTILE_MAX_ROWS", "6000")))))
        quantile_train = _evenly_spaced_rows(shared_train, quantile_max_rows)
        quantile_epochs = 32 if len(quantile_train) >= 5_000 else 50
        q_models = [fit_quantile_linear(quantile_train, alpha, epochs=quantile_epochs) for alpha in (0.1, 0.5, 0.9)]
        quantiles = [predict_quantile(model, shared_test) for model in q_models]
    rank_probability = _percentile_by_date(shared_test, rank_scores)
    direction_rank_scores = tree.get("directionRank") if tree and not tree.get("error") else None
    direction_rank_probability = (
        _percentile_by_date(shared_test, direction_rank_scores)
        if direction_rank_scores is not None else [None for _ in shared_test]
    )
    event_probability = _event_fold_predictions(shared_train, shared_test)
    regime_direction_probability = _date_level_regime_predictions(shared_train, shared_test)
    drift = feature_drift_summary(shared_train, shared_test)
    output: list[dict[str, Any]] = []
    return_scale = max(0.75, math.sqrt(sum(number(row.get("actualReturn")) ** 2 for row in shared_train) / max(1, len(shared_train))))
    tree_direction_available = bool(tree and not tree.get("error") and tree.get("direction") is not None)
    linear_direction_available = direction_baseline is not None
    direction_candidate_available = linear_direction_available or tree_direction_available
    for index, row in enumerate(shared_test):
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
        signal_timestamp = str(row.get("signalTimestamp") or row.get("date") or "")
        entry_timestamp = str(row.get("entryDate") or "")
        entry_source = str(row.get("entrySource") or "")
        execution_auditable = bool(
            number(row.get("entryPrice")) > 0
            and signal_timestamp
            and entry_timestamp
            and entry_timestamp > signal_timestamp
            and entry_source in {"next_session_open", "next_session_vwap"}
        )
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
            "actualReturnIsNet": row.get("actualReturnIsNet") is True,
            "actualGrossReturn": row["actualGrossReturn"],
            "signalTimestamp": signal_timestamp,
            "entryTimestamp": entry_timestamp,
            "entryPrice": row.get("entryPrice"),
            "entrySource": row.get("entrySource"),
            "exitTimestamp": row.get("exitDate"),
            "exitPrice": row.get("exitPrice"),
            "exitSource": row.get("exitSource"),
            "grossReturn": row.get("actualGrossReturn"),
            "estimatedCost": number(row.get("transactionCostBps")) / 100.0,
            "netReturn": row.get("actualReturn"),
            "ambiguousBarrierOrder": row.get("ambiguousBarrierOrder") is True,
            "netUpLabel": row.get("netUpLabel"),
            "marketResidualReturn": row.get("marketResidualReturn"),
            "sectorResidualReturn": row.get("sectorResidualReturn"),
            "marketResidualUp": row.get("marketResidualUp"),
            "sectorResidualUp": row.get("sectorResidualUp"),
            "topDecilePositive": row.get("topDecilePositive"),
            "rankDirectionRelevance": row.get("rankDirectionRelevance"),
            "rankRelevance": row.get("rankRelevance"),
            "crossSectionSize": row.get("crossSectionSize"),
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
            "ridgeDirectionPrediction": (
                clamp(number(stable_direction_probability[index]), 0.001, 0.999)
                if stable_direction_probability is not None else None
            ),
            "elasticDirectionPrediction": (
                clamp(number(elastic_direction_probability[index]), 0.001, 0.999)
                if elastic_direction_probability is not None else None
            ),
            "treeDirectionPrediction": (
                clamp(number(direction_probability_rows[index]), 0.001, 0.999)
                if tree_direction_available
                else None
            ),
            "returnDirectionPrediction": clamp(sigmoid(number(baseline_return[index]) / return_scale), 0.001, 0.999),
            "regimeDirectionPrediction": (
                clamp(number(regime_direction_probability[index]), 0.001, 0.999)
                if regime_direction_probability is not None
                else None
            ),
            "rankerDirectionPrediction": (
                clamp(number(direction_rank_probability[index]), 0.001, 0.999)
                if direction_rank_probability[index] is not None else None
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
            "averageDollarVolume20": row.get("averageDollarVolume20"),
            "dollarVolumeStability20": row.get("dollarVolumeStability20"),
            "dataQuality": row["dataQualityScore"],
            "evaluationWeight": row["evaluationWeight"],
            "transactionCostBps": row["transactionCostBps"],
            "eligibleMask": {
                "path": row.get("ambiguousBarrierOrder") is not True and execution_auditable,
                "direction": execution_auditable,
                "ranking": execution_auditable and row.get("rankDirectionRelevance") is not None,
                "return": execution_auditable,
            },
            "eligibilityReason": (
                ["AMBIGUOUS_BARRIER_ORDER"] if row.get("ambiguousBarrierOrder") is True else []
            ) + ([] if execution_auditable else ["EXECUTION_UNAUDITABLE"]),
            "falsePositiveFeatures": _false_positive_feature_vector(row),
            "fold": fold["fold"],
        })
    prevalence_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in shared_train]
    prevalence_weight_total = sum(prevalence_weights) or 1.0
    train_target_prevalence = sum(
        number(row.get("actualTarget")) * prevalence_weights[index]
        for index, row in enumerate(shared_train)
    ) / prevalence_weight_total
    train_direction_prevalence = sum(
        number(row.get("actualDirection")) * prevalence_weights[index]
        for index, row in enumerate(shared_train)
    ) / prevalence_weight_total
    return output, {
        "nullModelContractVersion": NULL_MODEL_CONTRACT_VERSION,
        "fold": fold["fold"],
        "status": "COMPLETE" if direction_candidate_available else "PARTIAL",
        "candidateStatus": "AVAILABLE" if direction_candidate_available else "PARTIAL_DIRECTION_NO_MODEL",
        "directionModelStatus": "RESEARCH_CANDIDATE" if direction_candidate_available else "NO_MODEL",
        "directionModelReason": (
            None
            if direction_candidate_available
            else feature_profile_gate.get("nullReason") or "no-linear-or-tree-direction-candidate"
        ),
        "directionFamilyGate": {
            "linear": "NO_MODEL" if direction_profile_null else "RESEARCH_CANDIDATE",
            "tree": "RESEARCH_CANDIDATE" if tree_direction_available else "UNAVAILABLE",
            "selectedAt": "strict-meta-train-oof",
            "policy": "A linear profile null result cannot suppress an independently fitted tree direction expert.",
        },
        "familyAvailability": {
            "direction": direction_candidate_available,
            "path": bool(baseline),
            "ranking": bool(rank_scores),
            "return": bool(quantiles),
            "event": event_probability is not None,
            "regime": regime_direction_probability is not None,
        },
        "headEligibility": {
            "pathTrainRows": len(path_train),
            "pathAmbiguousRowsExcluded": len(shared_train) - len(path_train),
            "directionTrainRows": len(direction_train),
            "directionAmbiguityPolicy": "included-for-net-return-direction; reported-with-and-without-ambiguous-rows",
        },
        "family": family,
        "optionalTreeError": tree.get("error") if tree else None,
        "resourcePolicy": {
            "sklearnEnabled": bool(enable_sklearn_models),
            "treeChallengerEnabled": bool(enable_tree_models),
            "baseline": "low-memory-python-logistic-ridge" if baseline.get("family") == "python-logistic-ridge-fallback" else baseline.get("family"),
            "reason": "Complex challengers are opt-in so a constrained machine can always finish and checkpoint the deterministic Champion first.",
        },
        "baselineTrainingRows": int(baseline.get("trainingRows") or len(train)),
        "trainTargetPrevalence": round(train_target_prevalence, 7),
        "trainDirectionPrevalence": round(train_direction_prevalence, 7),
        "panelTrainingRows": len(original_train),
        "eligibleTrainingRows": len(train),
        "baselineFullTrainingRows": int(baseline.get("fullTrainingRows") or len(train)),
        "treeSampledTrainingRows": int((tree.get("trainingPolicy") or {}).get("sampledTrainingRows") or 0) if tree and not tree.get("error") else 0,
        "treeFitRows": int((tree.get("trainingPolicy") or {}).get("fitRows") or 0) if tree and not tree.get("error") else 0,
        "treeValidationRows": int((tree.get("trainingPolicy") or {}).get("validationRows") or 0) if tree and not tree.get("error") else 0,
        "treeTrainingPolicy": dict(tree.get("trainingPolicy") or {}) if tree and not tree.get("error") else {},
        "quantileTrainingRows": len(train) if tree and not tree.get("error") and not quantile_train else len(quantile_train),
        "trainRows": len(shared_train),
        "testRows": len(shared_test),
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
                for name, value in zip(_feature_names_for_row(shared_test[0]), tree.get("directionFeatureImportance") or [])
            ]
            if tree and not tree.get("error") and shared_test
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


def weighted_prevalence(rows: list[dict[str, Any]], actual_key: str) -> float:
    if not rows:
        return 0.5
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(weights) or 1.0
    return clamp(
        sum(number(row.get(actual_key)) * weights[index] for index, row in enumerate(rows)) / total,
        0.001,
        0.999,
    )


def brier_skilled_models(
    rows: list[dict[str, Any]],
    names: list[str],
    *,
    actual_key: str = "actualTarget",
) -> tuple[list[str], list[dict[str, Any]]]:
    if not rows or not names:
        return [], []
    prevalence = weighted_prevalence(rows, actual_key)
    baseline = brier(rows, probabilities=[prevalence] * len(rows), actual_key=actual_key)
    scored = [(name, brier(rows, name, actual_key=actual_key)) for name in names]
    # Equality with the family null is not evidence of skill.  Keeping an
    # equal-scoring candidate used to make a constant/prior output look like
    # a learned expert and allowed the downstream stack to choose a loser.
    kept = [name for name, score in scored if score < baseline - 1e-9]
    rejected = [
        {
            "model": name,
            "because": (
                "negative-meta-train-brier-skill"
                if score > baseline + 1e-9
                else "candidate-not-strictly-better-than-null"
            ),
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
    # The diversity contract applies even to a two-model family.  The old
    # `> 3` guard left two near-identical models in the stack, so a small model
    # set could still count duplicate evidence twice.
    while changed and len(kept) > 1:
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


def expert_ensemble_audit(
    rows: list[dict[str, Any]],
    names: list[str],
    weights: list[float],
    *,
    actual_key: str = "actualDirection",
    residual_threshold: float = 0.65,
) -> dict[str, Any]:
    """Audit whether a stack is genuinely multi-expert or a single-model proxy."""
    def family(name: str) -> str:
        lowered = name.lower()
        if "rank" in lowered:
            return "ranking"
        if "regime" in lowered or "market" in lowered:
            return "regime"
        if "event" in lowered or "news" in lowered:
            return "event"
        if "return" in lowered or "quantile" in lowered:
            return "return"
        if "tree" in lowered or "lightgbm" in lowered:
            return "nonlinear_direction"
        return "linear_direction"

    active = [
        {"model": name, "weight": round(number(weight), 7), "family": family(name)}
        for name, weight in zip(names, weights)
        if number(weight) > 1e-6
    ]
    families = sorted({item["family"] for item in active})
    correlations = []
    max_abs = 0.0
    for left_index, left in enumerate(names):
        for right in names[left_index + 1:]:
            value = residual_correlation(rows, left, right, actual_key=actual_key)
            max_abs = max(max_abs, abs(value))
            correlations.append({"left": left, "right": right, "absCorrelation": round(abs(value), 6)})
    collapsed = len(active) <= 1 or len(families) <= 1 or max(number(item["weight"]) for item in active or [{"weight": 0.0}]) >= 0.80
    return {
        "available": bool(active),
        "activeModels": active,
        "activeFamilies": families,
        "familyCount": len(families),
        "maxResidualCorrelation": round(max_abs, 6),
        "residualCorrelationThreshold": residual_threshold,
        "residualCorrelationPassed": max_abs < residual_threshold if correlations else True,
        "singleModelCollapse": collapsed,
        "productionEligible": bool(active) and len(families) >= 2 and not collapsed and max_abs < residual_threshold,
        "reason": (
            "Independent expert families are present and residual correlations are below the ensemble gate."
            if bool(active) and len(families) >= 2 and not collapsed and max_abs < residual_threshold
            else "Stack is a single-family or highly correlated proxy; keep it in Research/Shadow."
        ),
        "correlations": correlations,
    }


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


def fit_regime_probability_calibrators(
    rows: list[dict[str, Any]],
    probabilities: list[float],
    actuals: list[float],
    *,
    actual_key: str,
    minimum_rows: int = 500,
    minimum_dates: int = 40,
) -> dict[str, Any]:
    """Fit regime-specific calibrators using only the training side of a split.

    A regime is allowed to override the global calibrator only when it has
    enough rows, dates, and both outcome classes. Sparse regimes deliberately
    fall back to the global calibration model instead of inventing a precise
    probability from a handful of observations.
    """
    groups: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        groups[str(row.get("regime") or "unknown")].append(index)
    calibrators: dict[str, dict[str, Any]] = {}
    skipped: dict[str, str] = {}
    for regime, indexes in sorted(groups.items()):
        regime_dates = {str(rows[index].get("date") or "") for index in indexes}
        regime_actuals = [number(actuals[index]) for index in indexes]
        if len(indexes) < minimum_rows:
            skipped[regime] = "insufficient-rows"
            continue
        if len(regime_dates) < minimum_dates:
            skipped[regime] = "insufficient-independent-dates"
            continue
        if len({int(value >= 0.5) for value in regime_actuals}) < 2:
            skipped[regime] = "single-outcome-class"
            continue
        calibrators[regime] = fit_probability_calibrator(
            [number(probabilities[index]) for index in indexes],
            regime_actuals,
            independent_dates=len(regime_dates),
            dates=[str(rows[index].get("date") or "") for index in indexes],
        )
    return {
        "available": bool(calibrators),
        "method": "market-regime-calibration",
        "actualKey": actual_key,
        "minimumRows": minimum_rows,
        "minimumIndependentDates": minimum_dates,
        "calibrators": calibrators,
        "skippedRegimes": skipped,
        "regimeCount": len(groups),
        "activeRegimeCount": len(calibrators),
    }


def apply_regime_probability_calibrators(
    calibration: dict[str, Any],
    global_calibrator: dict[str, Any],
    rows: list[dict[str, Any]],
    probabilities: list[float],
) -> list[float]:
    """Apply a trained regime layer; sparse/unseen regimes use global output."""
    calibrators = calibration.get("calibrators") if isinstance(calibration, dict) else {}
    output: list[float] = []
    for row, probability in zip(rows, probabilities):
        regime = str(row.get("regime") or "unknown")
        model = calibrators.get(regime) if isinstance(calibrators, dict) else None
        output.append(apply_probability_calibrator(model or global_calibrator, [probability])[0])
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
    # Pre-register six windows when history supports them. Shorter histories
    # retain three 60+ day windows instead of manufacturing tiny, noisy blocks.
    window_count = 6 if len(dates) >= 480 else 3
    window_size = min(80, max(60, len(dates) // (window_count + 4)))
    validation_ends = [
        len(dates) - window_size * offset
        for offset in reversed(range(window_count))
        if len(dates) - window_size * offset > 0
    ]
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
        fit_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in fit_rows]
        fit_weight_total = sum(fit_weights) or 1.0
        prevalence = sum(
            number(row.get("actualDirection")) * fit_weights[index]
            for index, row in enumerate(fit_rows)
        ) / fit_weight_total
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
        if number(row.get("meanBrierSkill")) > 0.001 and int(row.get("positiveWindows") or 0) >= minimum_positive
    ]
    selected = [] if not eligible else eligible if len(eligible) >= 3 else [eligible[0]]
    rejected = [
        {
            "model": str(row["model"]),
            "because": (
                "nested-direction-champion-selection"
                if selected
                else "no-model-beats-null-across-required-windows"
            ),
            "meanBrierSkill": row.get("meanBrierSkill"),
            "positiveWindows": row.get("positiveWindows"),
        }
        for row in comparisons
        if str(row["model"]) not in selected
    ]
    return selected, rejected, {
        "available": True,
        "method": "nested-calibrated-brier-champion-selection",
        "windowPolicy": "six-when-480-dates-otherwise-three-fixed-chronological-windows-v1",
        "windowManifestHash": stable_hash(windows, 32),
        "selectionUsesHeldOutMetaTest": False,
        "ensembleMinimumDistinctModels": 3,
        "selectedModels": selected,
        "status": "valid" if selected else "NO_MODEL",
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


def moving_block_bootstrap_ci(
    values: list[float],
    *,
    block_lengths: tuple[int, ...] = (5, 10, 20),
    repetitions: int = 600,
    seed: int = 20260815,
) -> dict[str, Any]:
    """Estimate a date-ordered mean CI without treating adjacent dates as iid.

    The input must already be aggregated to one value per independent date.
    Short series are reported honestly with the largest feasible block rather
    than being expanded with synthetic observations.
    """
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return {"available": False, "method": "moving-date-block-bootstrap", "blocks": {}}
    generator = random.Random(seed)
    results: dict[str, Any] = {}
    n = len(clean)
    observed_mean = sum(clean) / n
    for requested in block_lengths:
        block = min(max(1, int(requested)), n)
        samples: list[float] = []
        for _ in range(max(50, int(repetitions))):
            sample: list[float] = []
            while len(sample) < n:
                start = generator.randrange(0, n - block + 1)
                sample.extend(clean[start:start + block])
            sample = sample[:n]
            samples.append(sum(sample) / n)
        samples.sort()
        low_index = max(0, min(len(samples) - 1, int(len(samples) * 0.025)))
        high_index = max(0, min(len(samples) - 1, int(len(samples) * 0.975) - 1))
        results[str(requested)] = {
            "requestedBlockLength": int(requested),
            "effectiveBlockLength": block,
            "independentDates": n,
            # A bootstrap percentile interval must contain the observed
            # statistic.  Small, persistent samples can otherwise produce a
            # visibly contradictory report where the point estimate lies
            # outside its own 95% interval.
            "low": round(min(samples[low_index], observed_mean), 8),
            "high": round(max(samples[high_index], observed_mean), 8),
            "mean": round(observed_mean, 8),
            "level": 0.95,
            "repetitions": len(samples),
        }
    return {
        "available": True,
        "method": "moving-date-block-bootstrap",
        "independentDates": n,
        "blocks": results,
        "primaryBlockLength": 10 if n >= 10 else min(block_lengths),
    }


def rank_ic_summary(rows: list[dict[str, Any]], *, score_key: str = "rankerPrediction") -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("date"))].append(row)
    correlations = []
    top_returns = []
    universe_returns = []
    ndcg_values = []
    ndcg_skipped_no_relevance = 0
    precision_values = []
    direction_values = []
    universe_direction_values = []
    top10_date_scores = []
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
        def net_return(row: dict[str, Any]) -> float:
            if row.get("actualReturnIsNet") is True or row.get("actualGrossReturn") is None:
                return number(row.get("actualReturn"))
            gross = number(row.get("actualGrossReturn"), number(row.get("actualReturn")))
            cost_pct = number(row.get("transactionCostBps"), MARKET_COST_BPS.get(str(row.get("market") or "ASX").upper(), 18.0)) / 100.0
            return gross - cost_pct

        top_returns.append(sum(net_return(row) for row in selected) / len(selected))
        universe_returns.append(sum(net_return(row) for row in group) / len(group))
        direction_relevance = "direction" in str(score_key).lower() or "selection" in str(score_key).lower()
        relevance = (
            (lambda row: 3.0 if number(row.get("topDecilePositive")) >= 0.5 else 2.0 if number(row.get("sectorResidualUp")) >= 0.5 else 1.0 if number(row.get("netUpLabel")) >= 0.5 else 0.0)
            if direction_relevance
            else
            (lambda row: 3.0 if number(row.get("actualTarget")) >= 0.5 else 0.0 if number(row.get("actualStop")) >= 0.5 else 2.0 if number(row.get("actualReturn")) > 0 else 1.0)
        )
        def dcg(values: list[float]) -> float:
            return sum((2.0 ** value - 1.0) / math.log2(index + 2.0) for index, value in enumerate(values))
        selected_relevance = [relevance(row) for row in selected]
        ideal_relevance = sorted((relevance(row) for row in group), reverse=True)[:top_count]
        ideal_dcg = dcg(ideal_relevance)
        if ideal_dcg > 1e-12:
            ndcg_values.append(dcg(selected_relevance) / ideal_dcg)
        else:
            # A zero NDCG is not evidence that a ranker performed badly when
            # the group has no valid relevance label. Keep that case explicit
            # so an empty/legacy label stream cannot masquerade as a metric.
            ndcg_skipped_no_relevance += 1
        precision_values.append(sum(number(row.get("actualTarget")) >= 0.5 for row in selected) / len(selected))
        direction_values.append(sum(number(row.get("actualDirection")) >= 0.5 for row in selected) / len(selected))
        universe_direction_values.append(
            sum(number(row.get("actualDirection")) >= 0.5 for row in group) / len(group)
        )
        top10_date_scores.append(direction_values[-1])
    cumulative = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in top_returns:
        cumulative *= 1.0 + value / 100.0
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, (peak - cumulative) / max(1e-12, peak) * 100.0)
    top10_block_bootstrap = moving_block_bootstrap_ci(top10_date_scores)
    primary_block = str(top10_block_bootstrap.get("primaryBlockLength", 10))
    primary_interval = (top10_block_bootstrap.get("blocks") or {}).get(primary_block) or {}
    top10_low = primary_interval.get("low")
    top10_high = primary_interval.get("high")
    top10_rate = sum(direction_values) / max(1, len(direction_values)) * 100.0
    universe_direction_rate = sum(universe_direction_values) / max(1, len(universe_direction_values)) * 100.0
    if top10_low is not None:
        top10_low = min(float(top10_low), top10_rate / 100.0)
    if top10_high is not None:
        top10_high = max(float(top10_high), top10_rate / 100.0)
    return {
        "available": bool(correlations),
        "scoreKey": score_key,
        "dateCount": len(correlations),
        "rankIc": round(sum(correlations) / max(1, len(correlations)), 6),
        "topDecileNetReturn": round(sum(top_returns) / max(1, len(top_returns)), 6),
        "universeNetReturn": round(sum(universe_returns) / max(1, len(universe_returns)), 6),
        "topDecileLift": round((sum(top_returns) / max(1, len(top_returns))) - (sum(universe_returns) / max(1, len(universe_returns))), 6),
        "ndcgAtK": round(sum(ndcg_values) / len(ndcg_values), 6) if ndcg_values else None,
        "ndcgDateCount": len(ndcg_values),
        "ndcgSkippedNoRelevanceDates": ndcg_skipped_no_relevance,
        "ndcgAvailable": len(ndcg_values) >= 30,
        "ndcgAvailabilityReason": (
            "at-least-30-date-relevance-evidence"
            if len(ndcg_values) >= 30
            else "insufficient-valid-relevance-date-groups"
        ),
        "top10TargetFirstRatePct": round(sum(precision_values) / max(1, len(precision_values)) * 100.0, 5),
        "top10DirectionHitRatePct": round(top10_rate, 5),
        "universeDirectionRatePct": round(universe_direction_rate, 5),
        "top10DirectionLiftPct": round(top10_rate - universe_direction_rate, 5),
        "top10Definition": "long_only_top_decile_by_selection_score; direction means actual forward return > 0",
        "top10SelectedRows": sum(max(1, math.ceil(len(group) * 0.10)) for group in groups.values() if len(group) >= 5),
        "top10IndependentDateCount": len(top10_date_scores),
        "top10DirectionConfidenceInterval": {
            "low": round(top10_low * 100.0, 5),
            "high": round(top10_high * 100.0, 5),
            "level": 0.95,
            "method": "moving-date-block-bootstrap",
            "independentDates": len(top10_date_scores),
            "blocks": top10_block_bootstrap.get("blocks", {}),
        } if top10_low is not None and top10_high is not None else None,
        "maxDrawdownPct": round(max_drawdown, 6),
        "costModel": "actualReturn is net of round-trip transactionCostBps; legacy gross rows are adjusted once",
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
        "rankInverse",
        "pathRank",
        "pathRankInverse",
        "direction",
        "target",
        "pathSafety",
        "stopSafety",
        "quantileMedian",
        "baselineReturn",
        "liquidity",
        "tradability",
    ]

    def components(
        rows: list[dict[str, Any]],
        direction_probabilities: list[float],
        target_probabilities: list[float],
    ) -> list[dict[str, float]]:
        raw = {
            # Prefer the ranker trained on the same final-direction objective
            # used by rank_ic_summary. Older fixtures and legacy OOF rows do
            # not have it, so they remain backward-compatible with the path
            # ranker instead of silently becoming unavailable.
            "rank": [
                _model_value(row, "rankerDirectionPrediction")
                if row.get("rankerDirectionPrediction") is not None
                else _model_value(row, "rankerPrediction")
                for row in rows
            ],
            "pathRank": [_model_value(row, "rankerPrediction") for row in rows],
            "direction": [clamp(number(value), 0.001, 0.999) for value in direction_probabilities],
            "target": [clamp(number(value), 0.001, 0.999) for value in target_probabilities],
            "pathSafety": [_model_value(row, "pathSafetyPrediction") for row in rows],
            "stopSafety": [1.0 - _model_value(row, "stopProbability") for row in rows],
            "quantileMedian": [number(row.get("quantileP50")) for row in rows],
            "baselineReturn": [number(row.get("baselineReturn")) for row in rows],
            "liquidity": [number(row.get("liquidityWeight"), 0.5) for row in rows],
            "tradability": [
                math.sqrt(max(0.0, number(row.get("liquidityWeight"), 0.5)) * max(0.0, number(row.get("dollarVolumeStability20"), 0.5)))
                for row in rows
            ],
        }
        raw["rankInverse"] = [1.0 - value for value in raw["rank"]]
        raw["pathRankInverse"] = [1.0 - value for value in raw["pathRank"]]
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
        "path-rank-only": {"pathRank": 1.0},
        "direction-rank-only": {"rank": 1.0},
        # Orientation is selected only on purged inner OOF windows. This is a
        # diagnostic correction for a systematically reversed ranker, not a
        # post-hoc inversion of the untouched meta-test.
        "path-rank-inverted": {"pathRankInverse": 1.0},
        "direction-rank-inverted": {"rankInverse": 1.0},
        "rank-direction": {"rank": 0.45, "pathRank": 0.15, "direction": 0.40},
        "rank-direction-path": {"rank": 0.40, "pathRank": 0.10, "direction": 0.30, "target": 0.10, "pathSafety": 0.10},
        "risk-adjusted": {"rank": 0.35, "pathRank": 0.10, "direction": 0.25, "target": 0.10, "stopSafety": 0.15, "liquidity": 0.05},
        "tradability-risk-adjusted": {"rank": 0.33, "pathRank": 0.10, "direction": 0.24, "target": 0.08, "stopSafety": 0.15, "tradability": 0.10},
        "return-aware": {"rank": 0.30, "pathRank": 0.10, "direction": 0.25, "pathSafety": 0.10, "quantileMedian": 0.15, "baselineReturn": 0.10},
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
    validation_date_list = sorted(validation_dates)
    validation_window_count = 4
    validation_window_size = max(1, len(validation_date_list) // validation_window_count)
    validation_windows = [
        set(validation_date_list[index * validation_window_size:(index + 1) * validation_window_size]
            if index < validation_window_count - 1
            else validation_date_list[index * validation_window_size:])
        for index in range(validation_window_count)
    ]
    validation_windows = [window for window in validation_windows if window]
    if len(validation_windows) < validation_window_count:
        return {
            "available": False,
            "active": False,
            "reason": "Selective ranking requires four chronological inner validation windows.",
            "scores": [_model_value(row, "rankerPrediction") for row in test_rows],
        }

    def aggregate_window_metrics(window_metrics: list[dict[str, Any]]) -> dict[str, Any]:
        if not window_metrics:
            return {"available": False}
        numeric_keys = [
            "rankIc", "topDecileNetReturn", "universeNetReturn", "topDecileLift",
            "ndcgAtK", "top10TargetFirstRatePct", "top10DirectionHitRatePct",
            "universeDirectionRatePct", "top10DirectionLiftPct", "maxDrawdownPct",
        ]
        aggregate = {
            key: round(sum(number(metric.get(key)) for metric in window_metrics) / len(window_metrics), 6)
            for key in numeric_keys
        }
        aggregate["available"] = all(metric.get("available") is True for metric in window_metrics)
        aggregate["top10SelectedRows"] = sum(int(metric.get("top10SelectedRows") or 0) for metric in window_metrics)
        aggregate["top10IndependentDateCount"] = sum(int(metric.get("top10IndependentDateCount") or 0) for metric in window_metrics)
        aggregate["windowCount"] = len(window_metrics)
        return aggregate

    comparisons = []
    for name, weights in candidates.items():
        window_metrics = []
        for window_dates in validation_windows:
            window_indexes = [index for index, row in enumerate(train_rows) if str(row.get("date") or "") in window_dates]
            window_rows = [train_rows[index] for index in window_indexes]
            window_matrix = [train_components[index] for index in window_indexes]
            scores = blended_scores(window_matrix, weights)
            scored_rows = [{**row, "selectionScore": scores[index]} for index, row in enumerate(window_rows)]
            metrics = rank_ic_summary(scored_rows, score_key="selectionScore")
            if metrics.get("available") is True:
                window_metrics.append(metrics)
        metrics = aggregate_window_metrics(window_metrics)
        objective = (
            # Direction is the declared first promotion objective. Return,
            # lift and drawdown remain constraints/secondary evidence rather
            # than allowing an outlier return to replace a weaker Top-10
            # direction result.
            (number(metrics.get("top10DirectionHitRatePct")) - 50.0) * 1.00
            + number(metrics.get("topDecileLift")) * 0.50
            + number(metrics.get("topDecileNetReturn")) * 0.20
            + number(metrics.get("rankIc")) * 1.50
            - number(metrics.get("maxDrawdownPct")) * 0.02
        )
        comparisons.append({
            "name": name,
            "weights": weights,
            "metrics": metrics,
            "windowMetrics": window_metrics,
            "objective": round(objective, 7),
        })
    # The path ranker is the frozen pre-change comparator. A candidate must
    # also beat the date-level no-skill expectation; otherwise choosing the
    # least-bad head would turn an empty ranking result into a false signal.
    baseline = next(row for row in comparisons if row["name"] == "path-rank-only")

    def admissible(candidate: dict[str, Any]) -> bool:
        current = candidate["metrics"]
        base = baseline["metrics"]
        direction_gain = number(current.get("top10DirectionHitRatePct")) - number(base.get("top10DirectionHitRatePct"))
        return_gain = number(current.get("topDecileNetReturn")) - number(base.get("topDecileNetReturn"))
        lift_gain = number(current.get("topDecileLift")) - number(base.get("topDecileLift"))
        drawdown_change = number(current.get("maxDrawdownPct")) - number(base.get("maxDrawdownPct"))
        current_windows = candidate.get("windowMetrics") or []
        base_windows = baseline.get("windowMetrics") or []
        absolute_window_wins = sum(
            1
            for current_window in current_windows
            if number(current_window.get("top10DirectionLiftPct")) > 0.0
            and number(current_window.get("topDecileLift")) >= -0.02
        )
        absolute_case = (
            number(current.get("top10DirectionLiftPct")) >= 0.50
            and number(current.get("topDecileLift")) > 0.0
            and absolute_window_wins >= 3
        )
        if candidate["name"] == "path-rank-only":
            return absolute_case
        window_wins = 0
        for current_window, base_window in zip(current_windows, base_windows):
            window_direction_gain = number(current_window.get("top10DirectionHitRatePct")) - number(base_window.get("top10DirectionHitRatePct"))
            window_lift_gain = number(current_window.get("topDecileLift")) - number(base_window.get("topDecileLift"))
            window_return_change = number(current_window.get("topDecileNetReturn")) - number(base_window.get("topDecileNetReturn"))
            if window_direction_gain >= -0.25 and window_lift_gain >= -0.03 and window_return_change >= -0.05:
                window_wins += 1
        direction_case = direction_gain >= 0.50 and return_gain >= -0.02 and lift_gain >= -0.02 and drawdown_change <= 2.0
        return_case = return_gain >= 0.05 and direction_gain >= 0.0 and lift_gain >= 0.03 and drawdown_change <= 1.0
        return absolute_case and (direction_case or return_case) and window_wins >= 3

    eligible = [row for row in comparisons if admissible(row)]
    if not eligible:
        return {
            "available": True,
            "active": False,
            "modelEligible": False,
            "selected": "null/no-model",
            "weights": {},
            "reason": "No ranking candidate produced positive direction lift and cost-adjusted lift in at least three of four purged inner windows.",
            "innerTrainDates": len(inner_training_dates),
            "innerValidationDates": len(validation_dates),
            "innerPurgeDates": validation_start - inner_purge_start,
            "validationWindowCount": len(validation_windows),
            "minimumWindowWins": 3,
            "comparisons": comparisons,
            # Keep the legacy score only for diagnostics. modelEligible=false
            # prevents it from entering a trade or promotion decision.
            "scores": [_model_value(row, "rankerPrediction") for row in test_rows],
            "policy": "A ranking head may abstain; the untouched meta-test is never used to rescue or invert it.",
            "objectivePriority": "positive Top10 direction lift and cost-adjusted lift before absolute hit rate",
        }
    selected = max(eligible, key=lambda row: number(row.get("objective")))
    active = selected["name"] != "path-rank-only"
    test_scores = blended_scores(test_components, selected["weights"])
    return {
        "available": True,
        "active": active,
        "modelEligible": True,
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
        "validationWindowCount": len(validation_windows),
        "minimumWindowWins": 3,
        "comparisons": comparisons,
        "scores": test_scores,
        "policy": "Selection weights are chosen before the untouched meta-test and cannot create a probability; they only rank already eligible candidates.",
        "objectivePriority": "top10-final-direction-first; lift/net-return/rank-IC/drawdown are secondary non-degradation evidence",
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
            "date", "symbol", "market", "horizon", "actualTarget", "actualStop", "actualTimeout", "actualDirection", "actualReturn", "actualReturnIsNet", "actualGrossReturn",
            "netUpLabel", "marketResidualReturn", "sectorResidualReturn", "marketResidualUp", "sectorResidualUp", "topDecilePositive", "rankDirectionRelevance", "rankRelevance", "crossSectionSize",
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
    baseline_probability: float | None = None,
) -> dict[str, Any]:
    if not rows:
        return {
            "samples": 0,
            "brier": None,
            "brierSkillScore": None,
            "ecePct": None,
            "calibrationSlope": None,
            "reliabilityCurve": [],
            "probabilityBucketMinIndependentDates": 0,
        }
    actuals = [number(row[actual_key]) for row in rows]
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total_weight = sum(weights) or 1.0
    observed_rate = sum(actuals[index] * weights[index] for index in range(len(rows))) / total_weight
    base_rate = clamp(number(baseline_probability), 0.001, 0.999) if baseline_probability is not None else observed_rate
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
        curve.append({
            "bucket": f"{int(low * 100)}-{int(high * 100)}",
            "count": len(indexes),
            "independentDateCount": len({str(rows[index].get("date") or "") for index in indexes}),
            "predictedPct": round(predicted * 100, 4),
            "actualPct": round(actual * 100, 4),
        })
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
    selective_upper = bootstrap_values[min(len(bootstrap_values) - 1, max(0, int(len(bootstrap_values) * 0.975) - 1))] if bootstrap_values else 0.0
    selective_lower = min(selective_lower, selective_accuracy)
    selective_upper = max(selective_upper, selective_accuracy)
    probability_mean = sum(probabilities) / len(probabilities)
    probability_std = math.sqrt(sum((value - probability_mean) ** 2 for value in probabilities) / max(1, len(probabilities)))
    occupied_buckets = len(curve)
    positive_prediction_rate = sum(predicted_classes) / len(predicted_classes)
    test_dates = len({str(row.get("date") or "") for row in rows})
    probability_bucket_min_independent_dates = min(
        (int(row.get("independentDateCount") or 0) for row in curve),
        default=0,
    )
    # Probability resolution is a production evidence requirement, not a
    # relative-to-current-sample convenience. Lowering this to test_dates/4
    # made a one-event bucket look valid on tiny holdouts.
    required_bucket_events = 30
    required_bucket_independent_dates = 30
    probability_resolution_passed = (
        occupied_buckets >= 4
        and probability_std >= 0.03
        and 0.02 < positive_prediction_rate < 0.98
        and precision > 0.0 and recall > 0.0 and f1 > 0.0
        and test_dates >= required_bucket_independent_dates
        and min((int(row.get("count") or 0) for row in curve), default=0) >= required_bucket_events
        and probability_bucket_min_independent_dates >= required_bucket_independent_dates
    )
    return {
        "samples": len(rows),
        "effectiveSampleCount": round(effective_weighted_rows(rows), 3),
        "testDates": test_dates,
        "independentDateBlocks": math.ceil(test_dates / max(1, int(number(rows[0].get("horizon"), 1)))) if rows else 0,
        "brier": round(model_brier, 6),
        "baselineBrier": round(baseline_brier, 6),
        "baselineProbability": round(base_rate, 7),
        "baselineSource": "training-window-prevalence" if baseline_probability is not None else "evaluation-window-prevalence-legacy",
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
        "selectiveTop10Accuracy95UpperPct": round(selective_upper * 100.0, 5),
        "selectiveTop10Definition": "highest absolute probability distance from 0.5; not the long-only ranking Top 10%",
        "selectiveTop10IndependentBlocks": len(blocks),
        "selectiveTop10CiMethod": "date/week-block-bootstrap-600",
        "confusionMatrix": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        "topDecileTargetRate": round(top_target, 4),
        "topDecileNetReturn": round(top_return, 5),
        "allSampleNetReturn": round(all_return, 5),
        "topDecileLift": round(top_return - all_return, 5),
        "probabilityBucketMinCount": min((int(row["count"]) for row in curve), default=0),
        "probabilityBucketRequiredCount": required_bucket_events,
        "probabilityBucketMinIndependentDates": probability_bucket_min_independent_dates,
        "probabilityBucketRequiredIndependentDates": required_bucket_independent_dates,
        "occupiedProbabilityBuckets": occupied_buckets,
        "probabilityStd": round(probability_std, 7),
        "positivePredictionRatePct": round(positive_prediction_rate * 100.0, 5),
        "probabilityResolutionPassed": probability_resolution_passed,
        "reliabilityMonotonic": monotonic_inversions <= 1,
        "reliabilityInversions": monotonic_inversions,
        "reliabilityCurve": curve,
    }


def thresholded_direction_metrics(
    rows: list[dict[str, Any]],
    probabilities: list[float],
    *,
    threshold: float,
    abstain_margin: float = 0.0,
) -> dict[str, Any]:
    """Evaluate a decision threshold without changing the calibrated probability.

    Rows inside the abstention band are explicitly No Trade.  The threshold is
    selected only from an earlier OOF window; this function is also used on the
    untouched meta-test window for the honest holdout evidence.
    """
    selected_indexes = [
        index for index, probability in enumerate(probabilities)
        if abs(number(probability, 0.5) - threshold) > abstain_margin
    ]
    if not selected_indexes:
        return {
            "available": False,
            "threshold": round(threshold, 4),
            "abstainMargin": round(abstain_margin, 4),
            "signalCount": 0,
            "coveragePct": 0.0,
            "noTradePct": 100.0,
        }
    actuals = [1 if number(rows[index].get("actualDirection")) >= 0.5 else 0 for index in selected_indexes]
    predictions = [1 if number(probabilities[index], 0.5) >= threshold else 0 for index in selected_indexes]
    positives = sum(actuals)
    negatives = len(actuals) - positives
    tp = sum(1 for predicted, actual in zip(predictions, actuals) if predicted == actual == 1)
    tn = sum(1 for predicted, actual in zip(predictions, actuals) if predicted == actual == 0)
    fp = sum(1 for predicted, actual in zip(predictions, actuals) if predicted == 1 and actual == 0)
    fn = sum(1 for predicted, actual in zip(predictions, actuals) if predicted == 0 and actual == 1)
    sensitivity = tp / max(1, tp + fn)
    specificity = tn / max(1, tn + fp)
    accuracy = (tp + tn) / max(1, len(actuals))
    denominator = math.sqrt(max(1e-12, (tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)))
    mcc = (tp * tn - fp * fn) / denominator
    majority_accuracy = max(positives, negatives) / max(1, len(actuals))
    dates = len({str(rows[index].get("date") or "") for index in selected_indexes})
    return {
        "available": True,
        "threshold": round(threshold, 4),
        "abstainMargin": round(abstain_margin, 4),
        "signalCount": len(selected_indexes),
        "signalDates": dates,
        "coveragePct": round(len(selected_indexes) / max(1, len(rows)) * 100.0, 5),
        "noTradePct": round((1.0 - len(selected_indexes) / max(1, len(rows))) * 100.0, 5),
        "accuracyPct": round(accuracy * 100.0, 5),
        "majorityBaselineAccuracyPct": round(majority_accuracy * 100.0, 5),
        "relativeMajorityAccuracyPct": round((accuracy - majority_accuracy) * 100.0, 5),
        "balancedAccuracyPct": round((sensitivity + specificity) / 2.0 * 100.0, 5),
        "precisionPct": round(tp / max(1, tp + fp) * 100.0, 5),
        "recallPct": round(sensitivity * 100.0, 5),
        "f1Pct": round((2.0 * tp / max(1, 2 * tp + fp + fn)) * 100.0, 5),
        "matthewsCorrelation": round(mcc, 6),
        "confusionMatrix": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        "selectedIndexes": selected_indexes,
    }


def fit_nested_direction_threshold(
    rows: list[dict[str, Any]],
    probabilities: list[float],
    *,
    horizon: int,
    min_coverage_pct: float = 50.0,
) -> dict[str, Any]:
    """Choose a classification threshold using only the meta-train OOF rows.

    The final meta-test rows are deliberately not accepted here. Four
    chronological validation blocks provide a small, reproducible threshold
    tournament inside the already purged OOF meta-train window. The untouched
    meta-test window is never read here. This is decision-threshold selection,
    not probability recalibration.
    """
    dates = sorted({str(row.get("date") or "") for row in rows if row.get("date")})
    if len(dates) < 16 or len(rows) < 120:
        return {
            "available": False,
            "reason": "Nested threshold selection requires at least 16 dates and 120 meta-train rows.",
            "selectedThreshold": 0.5,
            "abstainMargin": 0.0,
            "candidates": [],
        }
    block_count = 4
    block_size = max(1, len(dates) // block_count)
    validation_blocks = [
        set(dates[index * block_size:(index + 1) * block_size] if index < block_count - 1 else dates[index * block_size:])
        for index in range(block_count)
    ]
    candidates = []
    for threshold_step in range(42, 59):
        threshold = threshold_step / 100.0
        for margin_step in (0, 1, 2):
            margin = margin_step / 100.0
            block_metrics = []
            for block_dates in validation_blocks:
                block_rows = [row for row in rows if str(row.get("date") or "") in block_dates]
                block_indexes = [index for index, row in enumerate(rows) if str(row.get("date") or "") in block_dates]
                metrics = thresholded_direction_metrics(
                    block_rows,
                    [probabilities[index] for index in block_indexes],
                    threshold=threshold,
                    abstain_margin=margin,
                )
                if metrics.get("available") and int(metrics.get("signalCount") or 0) >= 20:
                    block_metrics.append(metrics)
            if len(block_metrics) < 3:
                continue
            coverage = sum(number(metric.get("coveragePct")) for metric in block_metrics) / len(block_metrics)
            balanced = sum(number(metric.get("balancedAccuracyPct")) for metric in block_metrics) / len(block_metrics)
            mcc = sum(number(metric.get("matthewsCorrelation")) for metric in block_metrics) / len(block_metrics)
            relative = sum(number(metric.get("relativeMajorityAccuracyPct")) for metric in block_metrics) / len(block_metrics)
            objective = balanced + 8.0 * mcc + 0.25 * relative
            if coverage < min_coverage_pct:
                objective -= (min_coverage_pct - coverage) * 0.50
            candidates.append({
                "threshold": round(threshold, 4),
                "abstainMargin": round(margin, 4),
                "validationBlocks": len(block_metrics),
                "coveragePct": round(coverage, 5),
                "balancedAccuracyPct": round(balanced, 5),
                "matthewsCorrelation": round(mcc, 6),
                "relativeMajorityAccuracyPct": round(relative, 5),
                "objective": round(objective, 6),
            })
    if not candidates:
        return {
            "available": False,
            "reason": "No threshold candidate had sufficient support across three chronological OOF blocks.",
            "selectedThreshold": 0.5,
            "abstainMargin": 0.0,
            "candidates": [],
        }
    selected = max(candidates, key=lambda item: (number(item.get("objective"), -1e9), -abs(number(item.get("threshold"), 0.5) - 0.5), -number(item.get("abstainMargin"))))
    return {
        "available": True,
        "selectedThreshold": selected["threshold"],
        "abstainMargin": selected["abstainMargin"],
        "selectedEvidence": selected,
        "candidateCount": len(candidates),
        "validationBlocks": selected["validationBlocks"],
        "horizon": horizon,
        "selectionSource": "meta-train-only-four-block-threshold-tournament-inside-purged-OOF-window",
        "candidates": sorted(candidates, key=lambda item: number(item.get("objective"), -1e9), reverse=True)[:12],
    }


def expected_value_summary(rows: list[dict[str, Any]], probabilities: list[float]) -> dict[str, Any]:
    if not rows:
        return {
            "available": False,
            "status": "no-eligible-long-evidence",
            "expectedValuePct": None,
            "confidenceInterval": None,
        }
    row_values: list[float] = []
    target_probabilities: list[float] = []
    stop_probabilities: list[float] = []
    timeout_probabilities: list[float] = []
    target_returns: list[float] = []
    stop_losses: list[float] = []
    timeout_returns: list[float] = []
    costs = []
    for index, row in enumerate(rows):
        p_target = clamp(number(probabilities[index]), 0.001, 0.999)
        p_stop = clamp(number(row.get("stopProbability")), 0.001, 0.999)
        p_timeout = clamp(number(row.get("timeoutProbability")), 0.001, 0.999)
        probability_total = max(1e-12, p_target + p_stop + p_timeout)
        p_target, p_stop, p_timeout = (p_target / probability_total, p_stop / probability_total, p_timeout / probability_total)
        target_return = number(row.get("targetBarrierPct"))
        stop_loss = number(row.get("stopBarrierPct"))
        # Timeout return must be a signal-time prediction. Actual future
        # returns are labels and must never enter the EV estimate.
        timeout_return = number(row.get("quantileP50"), number(row.get("baselineReturn")))
        cost = number(row.get("transactionCostBps"), MARKET_COST_BPS.get(str(row.get("market") or "ASX").upper(), 18.0)) / 100.0
        row_values.append(p_target * target_return - p_stop * stop_loss + p_timeout * timeout_return - cost)
        target_probabilities.append(p_target)
        stop_probabilities.append(p_stop)
        timeout_probabilities.append(p_timeout)
        target_returns.append(target_return)
        stop_losses.append(stop_loss)
        timeout_returns.append(timeout_return)
        costs.append(cost)
    value = sum(row_values) / len(row_values)
    daily_values: dict[str, list[float]] = defaultdict(list)
    for row, row_value in zip(rows, row_values):
        daily_values[str(row.get("date") or "unknown")].append(row_value)
    daily_ev = [sum(values) / len(values) for _, values in sorted(daily_values.items()) if values]
    ev_bootstrap = moving_block_bootstrap_ci(daily_ev, seed=20260812)
    ev_block = str(ev_bootstrap.get("primaryBlockLength", 10))
    ev_interval = (ev_bootstrap.get("blocks") or {}).get(ev_block) or {}
    ev_low = ev_interval.get("low")
    ev_high = ev_interval.get("high")
    if ev_low is not None:
        ev_low = min(float(ev_low), value)
    if ev_high is not None:
        ev_high = max(float(ev_high), value)
    top_count = max(1, math.ceil(len(rows) * 0.10))
    top_indexes = sorted(range(len(rows)), key=lambda index: target_probabilities[index], reverse=True)[:top_count]
    top_value = sum(row_values[index] for index in top_indexes) / len(top_indexes)
    return {
        "available": True,
        "status": "oof-signal-time-inputs-only",
        "expectedValuePct": round(value, 5),
        "independentDates": len(daily_ev),
        "confidenceInterval": {
            "low": round(ev_low, 5),
            "high": round(ev_high, 5),
            "level": 0.95,
            "method": "moving-date-block-bootstrap",
            "blocks": ev_bootstrap.get("blocks", {}),
        } if ev_low is not None and ev_high is not None else None,
        "topDecileExpectedValuePct": round(top_value, 5),
        "topDecileCount": top_count,
        "targetProbability": round(sum(target_probabilities) / len(target_probabilities) * 100, 4),
        "stopProbability": round(sum(stop_probabilities) / len(stop_probabilities) * 100, 4),
        "timeoutProbability": round(sum(timeout_probabilities) / len(timeout_probabilities) * 100, 4),
        "targetNetReturnPct": round(sum(target_returns) / len(target_returns), 4),
        "stopNetLossPct": round(sum(stop_losses) / len(stop_losses), 4),
        "timeoutExpectedReturnPct": round(sum(timeout_returns) / len(timeout_returns), 4),
        "roundTripCostPct": round(sum(costs) / len(costs), 4),
        "formula": "OOF P(target)*targetNet - OOF P(stop)*stopLoss + signal-time P(timeout)*P50 - fees - slippage",
        "leakageSafe": True,
        "costEvidence": {
            "available": True,
            "costAppliedOnce": True,
            "transactionCostUnit": "basis_points_round_trip",
            "transactionCostPct": round(sum(costs) / len(costs), 6),
            "usesFutureOutcomeInProbability": False,
            "usesSignalTimeInputsOnly": True,
        },
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
            "status": "no-eligible-long-evidence",
            "expectedValueStatus": "no-eligible-long-evidence",
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
    daily_hit_rates = [
        sum(values) / len(values)
        for _, values in sorted(grouped.items())
    ]
    block_bootstrap = moving_block_bootstrap_ci(daily_hit_rates, seed=20260811)
    primary_block = str(block_bootstrap.get("primaryBlockLength", 10))
    primary_interval = (block_bootstrap.get("blocks") or {}).get(primary_block) or {}
    lower = number(primary_interval.get("low"), 0.0)
    upper = number(primary_interval.get("high"), 0.0)
    observed_hit_rate = sum(hits) / max(1, len(hits))
    lower = min(lower, observed_hit_rate)
    upper = max(upper, observed_hit_rate)
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
        "status": "oof-long-signal-evidence",
        "threshold": round(threshold, 4),
        "signalCount": len(selected),
        "signalDates": len(grouped),
        "coveragePct": round(len(selected) / max(1, len(rows)) * 100.0, 5),
        "directionHitRatePct": round(sum(hits) / len(hits) * 100.0, 5),
        "directionHitRate95LowerPct": round(lower * 100.0, 5),
        "directionHitRate95UpperPct": round(upper * 100.0, 5),
        "ciMethod": "moving-date-block-bootstrap",
        "ciIndependentDates": len(daily_hit_rates),
        "ciBlocks": block_bootstrap.get("blocks", {}),
        "targetFirstRatePct": round(sum(number(row.get("actualTarget")) for row in selected) / len(selected) * 100.0, 5),
        "meanNetReturnPct": round(sum(number(row.get("actualReturn")) for row in selected) / len(selected), 5),
        "maxDrawdownPct": round(max_drawdown, 5),
        "positiveFoldCount": sum(1 for row in fold_evidence if row["positive"]),
        "foldCount": len(fold_evidence),
        "foldEvidence": fold_evidence,
        "expectedValue": expected,
        "expectedValueStatus": expected.get("status"),
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
    risk_baseline_probability = weighted_prevalence(
        [train_rows[index] for index in inner_train_indexes],
        "actualDirection",
    )
    base_metrics = calibration_metrics(
        validation_rows,
        validation_probabilities,
        actual_key="actualDirection",
        baseline_probability=risk_baseline_probability,
    )
    adjusted_metrics = calibration_metrics(
        validation_rows,
        adjusted_validation,
        actual_key="actualDirection",
        baseline_probability=risk_baseline_probability,
    )
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


def diagnostic_bucket_summary(
    rows: list[dict[str, Any]],
    probabilities: list[float],
    *,
    baseline_probability: float | None = None,
) -> dict[str, Any]:
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
            metrics = calibration_metrics(
                selected_rows,
                selected_probabilities,
                bins=5,
                actual_key="actualDirection",
                baseline_probability=baseline_probability,
            )
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
        return calibration_metrics(
            mapped_test,
            probabilities,
            bins=5,
            actual_key="actualDirection",
            baseline_probability=weighted_prevalence(mapped_train, "actualDirection"),
        )
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


def _training_block_reasons(summary: dict[str, Any] | None) -> list[str]:
    """Return deterministic data-quality blockers before any model fitting."""
    summary = summary or {}
    reasons = [str(value) for value in summary.get("trainingBlockReasons") or [] if str(value).strip()]
    audit = summary.get("returnAudit") or {}
    if audit.get("trainingBlocked") is True and not reasons:
        reasons.append("return-integrity-sentinel")
    if int(summary.get("crossMarketRowsExcluded") or 0) > 0:
        reasons.append("cross-market-contamination-excluded")
    # `futureFeatureRowsExcluded` is the normal result of purging features
    # that were not yet available at the signal time.  It must remain visible
    # in the report, but it is not a data-quality failure.  Only explicit PIT
    # violations can block fitting.
    if int(summary.get("pointInTimeJoinViolationCount") or 0) > 0:
        reasons.append("point-in-time-join-violation")
    return list(dict.fromkeys(reasons))


def _blocked_horizon_result(rows: list[dict[str, Any]], *, market: str, horizon: int, reasons: list[str]) -> dict[str, Any]:
    return {
        "available": False,
        "horizon": horizon,
        "status": "blocked_data_quality",
        "trainingBlocked": True,
        "productionEvidencePassed": False,
        "productionActivationBlocked": True,
        "modelVersion": None,
        "rowCount": len(rows),
        "market": market,
        "blockReasons": reasons,
        "reason": "Training was stopped before OOF fitting because the frozen dataset failed a hard data-quality contract.",
        "foldMetrics": [],
        "oofRows": 0,
    }


def train_horizon_model(rows: list[dict[str, Any]], *, market: str, horizon: int, config: dict[str, Any]) -> dict[str, Any]:
    primary_horizon = int(config.get("primaryPromotionHorizon", 5) or 5)
    lockbox_candidate_id = stable_hash({
        "schema": "lockbox-candidate-v1",
        "market": market,
        "horizon": horizon,
        "trainingRunId": config.get("trainingRunId"),
        "snapshotId": config.get("snapshotId"),
        "datasetContentHash": config.get("datasetContentHash"),
        "changedHypothesis": config.get("changedHypothesis"),
        "lockboxId": (config.get("preFitLockbox") or {}).get("lockboxId"),
    }, 32)
    existing_lockbox = config.get("preFitLockbox") or {}
    if horizon == primary_horizon and existing_lockbox.get("status") == "consumed":
        return {
            "available": False,
            "horizon": horizon,
            "status": "NO_MODEL",
            "trainingStatus": "NO_MODEL",
            "reason": "The immutable final-test lockbox has already been consumed; create a new data/label/feature/test identity before another candidate is evaluated.",
            "rowCount": len(rows),
            "oofRows": 0,
            "models": [],
            "directionModels": [],
            "productionEvidencePassed": False,
            "productionActivationBlocked": True,
            "lockboxCandidateId": lockbox_candidate_id,
        }
    if config.get("trainingBlocked") is True:
        return _blocked_horizon_result(
            rows,
            market=market,
            horizon=horizon,
            reasons=[str(value) for value in config.get("trainingBlockReasons") or ["data-quality-contract"]],
        )
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
    _write_training_progress(
        config,
        "horizon-start",
        horizon=horizon,
        foldCount=len(folds),
        rowCount=len(rows),
        dateCount=len({str(row.get("date")) for row in rows}),
    )
    oof: list[dict[str, Any]] = []
    fold_metrics: list[dict[str, Any]] = []
    checkpoint_context = _fold_checkpoint_context(rows, folds, market=market, horizon=horizon, config=config)
    resumed_folds = 0
    for fold in folds:
        fold_index = int(fold.get("fold") or len(fold_metrics) + 1)
        restored = _load_fold_checkpoint(checkpoint_context, fold_index)
        _write_training_progress(
            config,
            "fold-start",
            horizon=horizon,
            fold=fold_index,
            foldCount=len(folds),
            completedFolds=len(fold_metrics),
            resumed=bool(restored),
        )
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
        if metadata.get("status") == "NO_MODEL":
            fold_metrics.append({
                **metadata,
                "fold": fold_index,
                "positive": False,
                "testRows": 0,
                "oofRows": 0,
            })
            _write_training_progress(
                config,
                "fold-complete",
                horizon=horizon,
                fold=fold_index,
                foldCount=len(folds),
                completedFolds=len(fold_metrics),
                testRows=0,
                status="NO_MODEL",
                resumed=bool(restored),
            )
            continue
        fold_probability = [number(row["pathSafetyPrediction"]) for row in predictions]
        path_predictions = [row for row in predictions if (row.get("eligibleMask") or {}).get("path") is True]
        path_probability = [number(row["pathSafetyPrediction"]) for row in path_predictions]
        metric = calibration_metrics(
            path_predictions,
            path_probability,
            baseline_probability=number(metadata.get("trainTargetPrevalence"), 0.5),
        )
        direction_available = any(row.get("ridgeDirectionPrediction") is not None for row in predictions)
        direction_probability = [
            number(row.get("ridgeDirectionPrediction"), 0.5) if direction_available else 0.5
            for row in predictions
        ]
        direction_metric = calibration_metrics(
            predictions,
            direction_probability,
            actual_key="actualDirection",
            baseline_probability=number(metadata.get("trainDirectionPrevalence"), 0.5),
        )
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
        _write_training_progress(
            config,
            "fold-complete",
            horizon=horizon,
            fold=fold_index,
            foldCount=len(folds),
            completedFolds=len(fold_metrics),
            testRows=len(predictions),
            resumed=bool(restored),
        )
    _write_training_progress(
        config,
        "horizon-complete",
        horizon=horizon,
        foldCount=len(folds),
        completedFolds=len(fold_metrics),
        oofRows=len(oof),
    )
    no_model_folds = [row for row in fold_metrics if row.get("status") == "NO_MODEL"]
    if no_model_folds:
        return {
            "available": False,
            "horizon": horizon,
            "status": "NO_MODEL",
            "trainingStatus": "NO_MODEL",
            "reason": "At least one purged OOF fold selected null/no-model; incomplete OOF cannot be promoted or used as a model.",
            "rowCount": len(rows),
            "oofRows": 0,
            "models": [],
            "directionModels": [],
            "productionEvidencePassed": False,
            "productionActivationBlocked": True,
            "foldMetrics": fold_metrics,
        }
    dates = sorted({row["date"] for row in oof})
    split_index = max(1, int(len(dates) * 0.65))
    meta_train_dates = set(dates[:split_index])
    purge_dates = set(dates[split_index:split_index + horizon + int(config.get("embargoDays", 7))])
    meta_train = [row for row in oof if row["date"] in meta_train_dates]
    meta_test = [row for row in oof if row["date"] not in meta_train_dates and row["date"] not in purge_dates]
    path_meta_train = [row for row in meta_train if (row.get("eligibleMask") or {}).get("path") is True]
    path_meta_test = [row for row in meta_test if (row.get("eligibleMask") or {}).get("path") is True]
    names = [name for name in MODEL_OUTPUT_KEYS if any(row.get(name) is not None for row in path_meta_train)]
    names, skill_pruned = brier_skilled_models(path_meta_train, names)
    names, correlation_pruned = prune_correlated_models(path_meta_train, names, float(config.get("maxResidualCorrelation", PRODUCTION_THRESHOLDS["maxResidualCorrelation"])))
    pruned = [*skill_pruned, *correlation_pruned]
    path_model_status = "AVAILABLE" if names else "NO_MODEL"
    path_model_reason = None if names else "All path experts failed the inner Brier/null comparison; path probability output is abstained while independent ranking, return, event and regime evidence remains available."
    if len(meta_train) < 30 or len(meta_test) < 20:
        return {"available": False, "horizon": horizon, "status": "evidence_insufficient", "reason": "OOF rows exist, but the untouched meta split is too small for constrained stacking.", "rowCount": len(rows), "folds": fold_metrics}
    if horizon == primary_horizon and existing_lockbox:
        if existing_lockbox.get("status") == "frozen_untouched":
            existing_lockbox = open_lockbox(
                existing_lockbox,
                candidate_id=lockbox_candidate_id,
                root=config.get("artifactDir"),
            )
            config["preFitLockbox"] = existing_lockbox
            config["lockboxCandidateId"] = lockbox_candidate_id
            _write_training_progress(
                config,
                "lockbox-opened-final-evaluation",
                horizon=horizon,
                lockboxId=existing_lockbox.get("lockboxId"),
                candidateId=lockbox_candidate_id,
                accessCount=existing_lockbox.get("accessCount"),
            )
        elif existing_lockbox.get("status") == "opened":
            if existing_lockbox.get("openedByCandidateId") != lockbox_candidate_id:
                raise ValueError("lockbox_candidate_mismatch")
            config["lockboxCandidateId"] = lockbox_candidate_id
        else:
            raise ValueError(f"lockbox_invalid_final_evaluation_state:{existing_lockbox.get('status')}")
    train_actuals = [number(row["actualTarget"]) for row in path_meta_train]
    meta_train_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in path_meta_train]
    meta_train_weight_total = sum(meta_train_weights) or 1.0
    target_baseline_probability = sum(
        train_actuals[index] * meta_train_weights[index]
        for index in range(len(path_meta_train))
    ) / meta_train_weight_total
    direction_meta_train_weights = [
        max(0.05, number(row.get("evaluationWeight"), 1.0))
        for row in meta_train
        if (row.get("eligibleMask") or {}).get("direction") is True
    ]
    direction_meta_train_rows = [
        row for row in meta_train
        if (row.get("eligibleMask") or {}).get("direction") is True
    ]
    direction_meta_train_weight_total = sum(direction_meta_train_weights) or 1.0
    direction_baseline_probability = sum(
        number(row.get("actualDirection")) * direction_meta_train_weights[index]
        for index, row in enumerate(direction_meta_train_rows)
    ) / direction_meta_train_weight_total
    if names:
        weights = fit_constrained_stack(path_meta_train, names, cap=float(config.get("maxModelWeight", PRODUCTION_THRESHOLDS["maxModelWeight"])))
        raw_train = ensemble_probabilities(path_meta_train, names, weights)
        raw_test = ensemble_probabilities(meta_test, names, weights)
        calibrator = fit_probability_calibrator(
            raw_train,
            train_actuals,
            independent_dates=len(meta_train_dates),
            dates=[str(row["date"]) for row in path_meta_train],
        )
        regime_calibrator = fit_regime_probability_calibrators(
            path_meta_train,
            raw_train,
            train_actuals,
            actual_key="actualTarget",
        )
        raw_train_full = ensemble_probabilities(meta_train, names, weights)
        calibrated_train = apply_regime_probability_calibrators(regime_calibrator, calibrator, meta_train, raw_train_full)
        calibrated_test = apply_regime_probability_calibrators(regime_calibrator, calibrator, meta_test, raw_test)
    else:
        # Path probability is a separate expert family.  Its failure must not
        # erase OOF evidence produced by ranking, return, event, or regime
        # experts. Neutral values are retained only for shape-safe diagnostics;
        # the path metrics and trade gate below are explicitly unavailable.
        weights = []
        raw_train = [0.5 for _ in path_meta_train]
        raw_test = [0.5 for _ in meta_test]
        calibrator = {
            "available": False,
            "method": "abstain",
            "reason": path_model_reason,
        }
        regime_calibrator = {
            "available": False,
            "method": "abstain",
            "reason": path_model_reason,
        }
        calibrated_train = [0.5 for _ in meta_train]
        calibrated_test = list(raw_test)
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
    direction_model_status = "AVAILABLE" if direction_names else "NO_MODEL"
    if direction_names:
        direction_weights = fit_constrained_stack(
            meta_train,
            direction_names,
            cap=float(config.get("maxModelWeight", PRODUCTION_THRESHOLDS["maxModelWeight"])),
            actual_key="actualDirection",
        )
        direction_expert_audit = expert_ensemble_audit(
            meta_train,
            direction_names,
            direction_weights,
            actual_key="actualDirection",
            residual_threshold=float(config.get("expertResidualCorrelation", 0.65)),
        )
        raw_direction_train = ensemble_probabilities(meta_train, direction_names, direction_weights)
        raw_direction_test = ensemble_probabilities(meta_test, direction_names, direction_weights)
    else:
        # Preserve non-direction OOF evidence while making direction
        # abstention explicit. These neutral values are diagnostics only; the
        # direction gates and long-trade gate remain closed below.
        direction_weights = []
        direction_expert_audit = {
            "available": False,
            "activeModels": [],
            "activeFamilies": [],
            "familyCount": 0,
            "singleModelCollapse": False,
            "productionEligible": False,
            "reason": "No direction expert passed the inner Brier/null and stability comparison; direction output is abstained.",
            "correlations": [],
        }
        raw_direction_train = [0.5 for _ in meta_train]
        raw_direction_test = [0.5 for _ in meta_test]
    direction_calibrator = fit_probability_calibrator(
        raw_direction_train,
        [number(row["actualDirection"]) for row in meta_train],
        independent_dates=len(meta_train_dates),
        dates=[str(row["date"]) for row in meta_train],
    )
    direction_regime_calibrator = fit_regime_probability_calibrators(
        meta_train,
        raw_direction_train,
        [number(row["actualDirection"]) for row in meta_train],
        actual_key="actualDirection",
    )
    calibrated_direction_test = apply_regime_probability_calibrators(
        direction_regime_calibrator,
        direction_calibrator,
        meta_test,
        raw_direction_test,
    )
    calibrated_direction_train = apply_regime_probability_calibrators(
        direction_regime_calibrator,
        direction_calibrator,
        meta_train,
        raw_direction_train,
    )
    false_positive_risk_head = fit_false_positive_risk_head(
        meta_train,
        meta_test,
        calibrated_direction_train,
        calibrated_direction_test,
    )
    calibrated_direction_test = list(false_positive_risk_head.get("probabilities") or calibrated_direction_test)
    direction_threshold_selection = fit_nested_direction_threshold(
        meta_train,
        calibrated_direction_train,
        horizon=horizon,
        min_coverage_pct=float((config.get("thresholds") or {}).get("minThresholdCoveragePct", PRODUCTION_THRESHOLDS["minThresholdCoveragePct"])),
    )
    selected_direction_threshold = number(direction_threshold_selection.get("selectedThreshold"), 0.5)
    selected_direction_abstain_margin = number(direction_threshold_selection.get("abstainMargin"), 0.0)
    thresholded_direction_test = thresholded_direction_metrics(
        meta_test,
        calibrated_direction_test,
        threshold=selected_direction_threshold,
        abstain_margin=selected_direction_abstain_margin,
    )
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
    path_meta_test_indexes = [index for index, row in enumerate(meta_test) if (row.get("eligibleMask") or {}).get("path") is True]
    metrics = calibration_metrics(
        [meta_test[index] for index in path_meta_test_indexes],
        [calibrated_test[index] for index in path_meta_test_indexes],
        baseline_probability=target_baseline_probability,
    )
    if not names:
        metrics = {
            **metrics,
            "available": False,
            "reason": path_model_reason,
        }
    direction_metrics = calibration_metrics(
        meta_test,
        calibrated_direction_test,
        actual_key="actualDirection",
        baseline_probability=direction_baseline_probability,
    )
    if not direction_names:
        direction_metrics = {
            **direction_metrics,
            "available": False,
            "reason": "No direction expert passed the inner Brier/null and stability comparison; direction output is abstained.",
        }
    direction_unambiguous_indexes = [
        index for index, row in enumerate(meta_test)
        if row.get("ambiguousBarrierOrder") is not True
    ]
    direction_without_ambiguous = calibration_metrics(
        [meta_test[index] for index in direction_unambiguous_indexes],
        [calibrated_direction_test[index] for index in direction_unambiguous_indexes],
        actual_key="actualDirection",
        baseline_probability=direction_baseline_probability,
    )
    ambiguity_ba_delta = abs(
        number(direction_metrics.get("balancedAccuracyPct"))
        - number(direction_without_ambiguous.get("balancedAccuracyPct"))
    )
    direction_ambiguity_audit = {
        "schema": "ambiguous-direction-policy-v1",
        "policy": "Daily same-bar double-touch rows remain eligible for end-of-horizon net-return direction, but never for path metrics.",
        "included": direction_metrics,
        "excluded": direction_without_ambiguous,
        "ambiguousRows": len(meta_test) - len(direction_unambiguous_indexes),
        "balancedAccuracyDeltaPp": round(ambiguity_ba_delta, 7),
        "labelReviewRequired": ambiguity_ba_delta > 0.5,
    }
    final_direction_fold_metrics = []
    for fold_id in sorted({int(row.get("fold") or 0) for row in meta_test}):
        indexes = [index for index, row in enumerate(meta_test) if int(row.get("fold") or 0) == fold_id]
        fold_direction = calibration_metrics(
            [meta_test[index] for index in indexes],
            [calibrated_direction_test[index] for index in indexes],
            actual_key="actualDirection",
            baseline_probability=direction_baseline_probability,
        )
        final_direction_fold_metrics.append({
            "fold": fold_id,
            "head": "direction",
            "family": list(direction_names),
            "eligibleRows": len(indexes),
            "excludedRows": 0,
            "balancedAccuracyPct": fold_direction.get("balancedAccuracyPct"),
            "brier": fold_direction.get("brier"),
            "baselineBrier": fold_direction.get("baselineBrier"),
            "brierSkillScore": fold_direction.get("brierSkillScore"),
            "confusionMatrix": fold_direction.get("confusionMatrix"),
            "positive": number(fold_direction.get("brierSkillScore"), -1.0) > 0,
        })
    fold_confusion = {
        key: sum(int((row.get("confusionMatrix") or {}).get(key) or 0) for row in final_direction_fold_metrics)
        for key in ("tp", "tn", "fp", "fn")
    }
    fold_recall = fold_confusion["tp"] / max(1, fold_confusion["tp"] + fold_confusion["fn"])
    fold_specificity = fold_confusion["tn"] / max(1, fold_confusion["tn"] + fold_confusion["fp"])
    fold_balanced_accuracy = (fold_recall + fold_specificity) / 2.0 * 100.0
    fold_rows_total = sum(int(row.get("eligibleRows") or 0) for row in final_direction_fold_metrics)
    reconciled_indexes = [
        index
        for fold_id in sorted({int(row.get("fold") or 0) for row in meta_test})
        for index, row in enumerate(meta_test)
        if int(row.get("fold") or 0) == fold_id
    ]
    reconciled_direction = calibration_metrics(
        [meta_test[index] for index in reconciled_indexes],
        [calibrated_direction_test[index] for index in reconciled_indexes],
        actual_key="actualDirection",
        baseline_probability=direction_baseline_probability,
    )
    balanced_accuracy_difference = abs(number(reconciled_direction.get("balancedAccuracyPct")) - number(direction_metrics.get("balancedAccuracyPct")))
    brier_skill_difference = abs(number(reconciled_direction.get("brierSkillScore")) - number(direction_metrics.get("brierSkillScore")))
    fold_reconciliation = {
        "schema": "final-family-fold-reconciliation-v1",
        "head": "direction",
        "selectedModels": list(direction_names),
        "eligibleRows": len(meta_test),
        "foldRows": fold_rows_total,
        "aggregateBalancedAccuracyPct": direction_metrics.get("balancedAccuracyPct"),
        "aggregateBrierSkillScore": direction_metrics.get("brierSkillScore"),
        "recomputedFromFoldMembershipBalancedAccuracyPct": reconciled_direction.get("balancedAccuracyPct"),
        "recomputedFromFoldMembershipBrierSkillScore": reconciled_direction.get("brierSkillScore"),
        "balancedAccuracyDifference": round(balanced_accuracy_difference, 9),
        "brierSkillDifference": round(brier_skill_difference, 9) if math.isfinite(brier_skill_difference) else None,
        "tolerance": 0.000001,
        "reconciled": (
            fold_rows_total == len(meta_test)
            and balanced_accuracy_difference <= 0.000001
            and brier_skill_difference <= 0.000001
        ),
        "policy": "The aggregate and fold rows use the same final selected direction family, calibrated probabilities, eligible mask and frozen meta-test population.",
    }
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
        comparison_metrics = calibration_metrics(
            meta_test,
            comparison_probabilities,
            actual_key="actualDirection",
            baseline_probability=direction_baseline_probability,
        )
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
    diagnostic_buckets = diagnostic_bucket_summary(
        meta_test,
        calibrated_direction_test,
        baseline_probability=direction_baseline_probability,
    )
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
    ranking["modelEligible"] = selective_ranking_head.get("modelEligible") is True
    if selective_ranking_head.get("modelEligible") is not True:
        ranking["reason"] = selective_ranking_head.get("reason") or "ranking-head-abstained"
    regime_diagnostics = {}
    for regime in sorted({str(row.get("regime") or "unknown") for row in meta_test}):
        indexes = [index for index, row in enumerate(meta_test) if str(row.get("regime") or "unknown") == regime]
        regime_diagnostics[regime] = calibration_metrics(
            [meta_test[index] for index in indexes],
            [calibrated_test[index] for index in indexes],
            bins=5,
            baseline_probability=target_baseline_probability,
        )
    expected_value = expected_value_summary(meta_test, calibrated_test)
    long_trade_expected_value = ((long_trade_gate.get("testEvidence") or {}).get("expectedValue") or {"available": False})
    marginal = []
    full_brier = brier([meta_test[index] for index in path_meta_test_indexes], probabilities=[calibrated_test[index] for index in path_meta_test_indexes])
    for index, name in enumerate(names):
        reduced_names = [value for value in names if value != name]
        reduced_weights = [weights[position] for position, value in enumerate(names) if value != name]
        reduced_weights = project_capped_simplex(reduced_weights, max(0.5, float(config.get("maxModelWeight", 0.35))))
        reduced_train_raw = ensemble_probabilities(path_meta_train, reduced_names, reduced_weights)
        reduced_raw = ensemble_probabilities(meta_test, reduced_names, reduced_weights)
        reduced_calibrator = fit_probability_calibrator(
            reduced_train_raw,
            train_actuals,
            independent_dates=len(meta_train_dates),
            dates=[str(row["date"]) for row in path_meta_train],
        )
        reduced_calibrated = apply_probability_calibrator(reduced_calibrator, reduced_raw)
        marginal.append({"model": name, "brierGain": round(brier([meta_test[index] for index in path_meta_test_indexes], probabilities=[reduced_calibrated[index] for index in path_meta_test_indexes]) - full_brier, 7)})
    thresholds = {**PRODUCTION_THRESHOLDS, **(config.get("thresholds") or {})}
    panel_sampling = config.get("panelSampling") or {}
    row_conservation = config.get("outerCrossSectionRowConservation") or {}
    outer_cross_section_complete = (
        row_conservation.get("passed") is True
        and row_conservation.get("completeDailyCrossSection") is True
        and int(row_conservation.get("eligibleRows") or 0) > 0
        and int(row_conservation.get("eligibleRows") or 0)
            == int(row_conservation.get("evaluatedRows") or 0) + int(row_conservation.get("auditedExcludedRows") or 0)
        and int(row_conservation.get("sampledRows") or 0) == int(row_conservation.get("evaluatedRows") or 0)
        and int(row_conservation.get("skippedRows") or 0) == 0
    )
    path_fold_metrics = fold_metrics
    fold_metrics = final_direction_fold_metrics
    positive_folds = sum(1 for row in fold_metrics if row.get("positive"))
    path_rows = [row for row in rows if row.get("ambiguousBarrierOrder") is not True]
    target_events = sum(1 for row in path_rows if row["actualTarget"] >= 0.5)
    stop_events = sum(1 for row in path_rows if row["actualStop"] >= 0.5)
    timeout_events = sum(1 for row in path_rows if row["actualTimeout"] >= 0.5)
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
        # Raw accuracy remains visible for audit, but is not a promotion gate:
        # a majority-class predictor can pass it while having no tradable skill.
        "directionAccuracy": True,
        "directionBalancedAccuracy": number(thresholded_direction_test.get("balancedAccuracyPct"), 0.0) >= float(thresholds["minBalancedAccuracyPct"]),
        "directionMcc": number(thresholded_direction_test.get("matthewsCorrelation"), -1.0) >= float(thresholds["minDirectionMcc"]),
        "directionRelativeMajority": number(thresholded_direction_test.get("relativeMajorityAccuracyPct"), -100.0) >= float(thresholds["minRelativeMajorityAccuracyPct"]),
        "directionThresholdCoverage": number(thresholded_direction_test.get("coveragePct"), 0.0) >= float(thresholds["minThresholdCoveragePct"]),
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
        "rankingModelEligible": selective_ranking_head.get("modelEligible") is True,
        "rankTopDecileLift": number(ranking.get("topDecileLift")) > 0,
        "rankTop10Direction": number(ranking.get("top10DirectionHitRatePct"), 0.0) >= float(thresholds["minTop10DirectionHitRatePct"]),
        "rankNdcg": ranking.get("ndcgAvailable") is True and number(ranking.get("ndcgAtK"), -1.0) > 0.0,
        "rankTopDecileAbsoluteReturn": number(ranking.get("topDecileNetReturn")) > 0,
        "rankDrawdown": number(ranking.get("maxDrawdownPct"), 100.0) <= float(thresholds["maxTopDecileDrawdownPct"]),
        "probabilityBucketSupport": (
            metrics.get("probabilityResolutionPassed") is True
            and direction_metrics.get("probabilityResolutionPassed") is True
            and int(metrics.get("probabilityBucketMinCount") or 0) >= int(thresholds["minProbabilityBucketEvents"])
            and int(metrics.get("probabilityBucketMinIndependentDates") or 0) >= int(thresholds["minProbabilityBucketIndependentDates"])
            and int(direction_metrics.get("probabilityBucketMinCount") or 0) >= int(thresholds["minProbabilityBucketEvents"])
            and int(direction_metrics.get("probabilityBucketMinIndependentDates") or 0) >= int(thresholds["minProbabilityBucketIndependentDates"])
        ),
        "reliabilityMonotonic": metrics.get("reliabilityMonotonic") is True,
        "conformalCoverage": not conformal_quantiles.get("available") or 70.0 <= number(conformal_quantiles.get("observedCoveragePct")) <= 95.0,
        "featureDrift": all(number((row.get("featureDrift") or {}).get("maxPsi"), 1.0) <= 0.40 for row in fold_metrics),
        "marginalGain": all(number(row.get("brierGain")) >= 0.0 for row in marginal),
        "expertDiversity": direction_expert_audit.get("productionEligible") is True,
        "outerCrossSectionComplete": outer_cross_section_complete,
        "sectorSemantics": (config.get("sectorAudit") or {}).get("eligible") is True,
        "labelNoiseStable": (config.get("labelNoiseSensitivity") or {}).get("unstable") is not True,
    }
    production_evidence = all(production_checks.values())
    research_eligible = len(rows) >= int(thresholds["researchMinRows"]) and len(meta_test) >= 20
    deployment_status = "shadow" if research_eligible and config.get("trainingLane") == "prequential_shadow" else "research"
    active_feature_names = _feature_names_for_row(rows[0]) if rows else list(CORE_TECHNICAL_FEATURE_NAMES)
    feature_importance = direction_feature_importance_summary(meta_train, fold_metrics, active_feature_names)
    version_basis = {
        "market": market,
        "horizon": horizon,
        "labelVersion": "daily-sign-first-net-sector-residual-v1",
        "expertResidualCorrelation": number(config.get("expertResidualCorrelation"), 0.65),
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
    if horizon == primary_horizon and (config.get("preFitLockbox") or {}).get("status") == "opened":
        config["preFitLockbox"] = consume_lockbox(
            config["preFitLockbox"],
            candidate_id=lockbox_candidate_id,
            outcome="accepted" if production_evidence else "rejected",
            root=config.get("artifactDir"),
        )
        _write_training_progress(
            config,
            "lockbox-consumed-final-evaluation",
            horizon=horizon,
            lockboxId=config["preFitLockbox"].get("lockboxId"),
            candidateId=lockbox_candidate_id,
            outcome=config["preFitLockbox"].get("evaluationOutcome"),
        )

    def head_denominator(head: str) -> dict[str, Any]:
        eligible = 0
        reasons: dict[str, int] = defaultdict(int)
        for candidate in meta_test:
            if (candidate.get("eligibleMask") or {}).get(head) is True:
                eligible += 1
                continue
            candidate_reasons = list(candidate.get("eligibilityReason") or [])
            if head != "path":
                candidate_reasons = [reason for reason in candidate_reasons if reason != "AMBIGUOUS_BARRIER_ORDER"]
            if head == "ranking" and candidate.get("rankDirectionRelevance") is None:
                candidate_reasons.append("RANKING_LABEL_UNAVAILABLE")
            for reason in sorted(set(candidate_reasons or ["HEAD_MASK_FALSE"])):
                reasons[str(reason)] += 1
        return {
            "eligibleRows": eligible,
            "excludedRows": len(meta_test) - eligible,
            "excludedReasonCounts": dict(sorted(reasons.items())),
        }

    return {
        "available": True,
        "attemptCompleted": True,
        "artifactProduced": True,
        "predictiveModelProduced": bool(direction_names),
        "tradeModelProduced": bool(
            direction_names
            and selective_ranking_head.get("modelEligible") is True
            and long_trade_gate.get("active") is True
        ),
        "horizon": horizon,
        "task": "market-level-multitask-target-stop-rank-quantile",
        "modelVersion": model_version,
        "status": "PARTIAL" if not names or not direction_names else "AVAILABLE",
        "trainingStatus": "PARTIAL" if not names or not direction_names else "AVAILABLE",
        "deploymentStatus": deployment_status,
        "productionEvidencePassed": production_evidence,
        "productionActivationBlocked": True,
        "activationReason": "Path and/or direction expert abstained; independent family evidence is retained for research, but long-trade and production gates remain closed." if not names or not direction_names else "A newly trained candidate can enter Shadow only; Paper Champion requires 2-3 full live prediction cycles and Production requires explicit promotion.",
        "rowCount": len(rows),
        "oofRows": len(oof),
        "metaTrainRows": len(meta_train),
        "metaTestRows": len(meta_test),
        "eventCounts": event_counts,
        "models": names,
        "modelFamilyStatus": {
            "path": path_model_status,
            "pathReason": path_model_reason,
            "direction": direction_model_status,
            "ranking": "AVAILABLE" if selective_ranking_head.get("modelEligible") is True else "NO_MODEL",
            "rankingReason": None if selective_ranking_head.get("modelEligible") is True else selective_ranking_head.get("reason"),
            "return": "AVAILABLE" if any(row.get("quantilePrediction") is not None for row in oof) else "NO_MODEL",
            "event": "AVAILABLE" if any(row.get("eventPrediction") is not None for row in oof) else "NO_MODEL",
            "regime": "AVAILABLE" if any(row.get("regimeDirectionPrediction") is not None for row in oof) else "NO_MODEL",
        },
        "weights": {name: round(weights[index], 6) for index, name in enumerate(names)},
        "directionModels": direction_names,
        "directionWeights": {name: round(direction_weights[index], 6) for index, name in enumerate(direction_names)},
        "directionPrunedModels": direction_pruned,
        "directionModelSelection": direction_model_selection,
        "directionExpertAudit": direction_expert_audit,
        "prunedModels": pruned,
        "residualCorrelations": [
            {"left": names[left], "right": names[right], "correlation": round(residual_correlation(meta_train, names[left], names[right]), 5)}
            for left in range(len(names)) for right in range(left + 1, len(names))
        ],
        "marginalContribution": marginal,
        "calibrator": {**calibrator, "version": f"{calibrator.get('method', 'platt')}-{stable_hash(calibrator, 10)}"},
        "directionCalibrator": {**direction_calibrator, "version": f"{direction_calibrator.get('method', 'platt')}-{stable_hash(direction_calibrator, 10)}"},
        "regimeCalibrator": regime_calibrator,
        "directionRegimeCalibrator": direction_regime_calibrator,
        "metrics": metrics,
        "directionMetrics": direction_metrics,
        "directionAmbiguityAudit": direction_ambiguity_audit,
        "foldMetricReconciliation": fold_reconciliation,
        "directionThresholdSelection": direction_threshold_selection,
        "directionThresholdMetrics": {key: value for key, value in thresholded_direction_test.items() if key != "selectedIndexes"},
        "thresholdMetricContract": {
            "raw": {"threshold": 0.5, "selectionWindow": "none-fixed-contract", "coverage": 1.0, "balancedAccuracyPct": direction_metrics.get("balancedAccuracyPct")},
            "selected": {"threshold": selected_direction_threshold, "selectionWindow": direction_threshold_selection.get("selectionSource"), "coverage": number(thresholded_direction_test.get("coveragePct")) / 100.0, "balancedAccuracyPct": thresholded_direction_test.get("balancedAccuracyPct")},
            "interchangeable": False,
        },
        "modelComparison": model_comparison,
        "labelTournamentOOF": config.get("labelTournamentOOF") or {"status": "not_run", "reason": "missing from immutable run manifest"},
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
        "top10MetricContract": {
            "absoluteConfidenceTop10": {
                "label": "双向高置信 Top10 命中",
                "valuePct": direction_metrics.get("selectiveTop10AccuracyPct"),
                "definition": direction_metrics.get("selectiveTop10Definition"),
            },
            "longOnlyRankingTop10": {
                "label": "做多排名 Top10 方向命中",
                "valuePct": ranking.get("top10DirectionHitRatePct"),
                "definition": "highest long-only selection score within each eligible trading date",
            },
            "interchangeable": False,
        },
        "conformalQuantiles": conformal_quantiles,
        "regimeDiagnostics": regime_diagnostics,
        "expectedValue": expected_value,
        "longTradeExpectedValue": long_trade_expected_value,
        "foldMetrics": fold_metrics,
        "pathFoldMetrics": path_fold_metrics,
        "foldCheckpoint": {
            "enabled": checkpoint_context is not None,
            "signature": checkpoint_context.get("signature") if checkpoint_context else None,
            "completedFolds": len(fold_metrics),
            "resumedFolds": resumed_folds,
            "path": str(checkpoint_context.get("root")) if checkpoint_context else None,
        },
        "positiveFoldCount": positive_folds,
        "productionChecks": production_checks,
        "lockboxCandidateId": lockbox_candidate_id if horizon == primary_horizon else None,
        "outerCrossSection": {
            "complete": outer_cross_section_complete,
            "eligiblePanelRows": int(row_conservation.get("eligibleRows") or 0),
            "evaluatedPanelRows": int(row_conservation.get("evaluatedRows") or 0),
            "auditedExcludedRows": int(row_conservation.get("auditedExcludedRows") or 0),
            "sampledPanelRows": int(row_conservation.get("sampledRows") or 0),
            "skippedPanelRows": int(row_conservation.get("skippedRows") or 0),
            "independentDates": int(panel_sampling.get("rankingUniverseDates") or 0),
            "reasonCounts": row_conservation.get("reasonCounts") or {},
            "policy": "outer OOF covers the complete date x symbol panel; inner fitting row caps remain allowed",
        },
        "perHeadDenominators": {
            "schema": "per-head-eligible-mask-v1",
            "path": head_denominator("path"),
            "direction": {**head_denominator("direction"), "ambiguityPolicy": direction_ambiguity_audit.get("policy")},
            "ranking": head_denominator("ranking"),
            "return": head_denominator("return"),
        },
        "informationalMetrics": {
            "directionAccuracyPct": direction_metrics.get("accuracyPct"),
            "directionAccuracyThresholdPct": thresholds.get("minAccuracyPct"),
            "directionAccuracyIsPromotionGate": False,
        },
        "oofSchema": [
            "date", "symbol", "market", "horizon", "signalTimestamp", "entryTimestamp", "entryPrice", "entrySource", "exitTimestamp", "grossReturn", "estimatedCost", "netReturn", "eligibleMask", "eligibilityReason", "actualTarget", "actualStop", "actualDirection", "actualReturn",
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
    panel_sampling = profiles[0].get("panelSampling") or {}
    outer_conservation = profiles[0].get("outerCrossSectionRowConservation") or {}
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
        "eventActionableRowCoveragePct": min((number(row.get("eventActionableRowCoveragePct")) for row in profiles), default=0.0),
        "fundamentalItemCoveragePct": min((number(row.get("fundamentalItemCoveragePct")) for row in profiles), default=0.0),
        "fundamentalFeaturesEnabled": all(bool(row.get("fundamentalFeaturesEnabled")) for row in profiles),
        "fundamentalFeatureNames": list(profiles[0].get("fundamentalFeatureNames") or []),
        "fundamentalCoverageLayers": profiles[0].get("fundamentalCoverageLayers") or {},
        "returnAudit": {
            "schema": "return-sentinel-v1",
            "unexplainedExtremeRowsExcluded": sum(
                int((row.get("returnAudit") or {}).get("unexplainedExtremeRowsExcluded") or 0)
                for row in profiles
            ),
            "sentinelDaysRowsExcluded": sum(
                int((row.get("returnAudit") or {}).get("sentinelDaysRowsExcluded") or 0)
                for row in profiles
            ),
            "sentinelDaysExcluded": sorted({
                str(day)
                for row in profiles
                for day in (row.get("returnAudit") or {}).get("sentinelDaysExcluded") or []
            }),
            "dailyCrossSectionSentinels": [
                sentinel
                for row in profiles
                for sentinel in (row.get("returnAudit") or {}).get("dailyCrossSectionSentinels") or []
            ][:40],
            "trainingBlocked": any(
                bool((row.get("returnAudit") or {}).get("trainingBlocked"))
                for row in profiles
            ),
        },
        "trainingBlockReasons": sorted({
            str(reason)
            for row in profiles
            for reason in row.get("trainingBlockReasons") or []
            if str(reason).strip()
        }),
        "trainingBlocked": any(bool(row.get("trainingBlocked")) for row in profiles),
        "sectorSemantics": {
            "eligible": all((row.get("sectorSemantics") or {}).get("eligible") is True for row in profiles),
            "markets": [row.get("sectorSemantics") for row in profiles if row.get("sectorSemantics")],
            "status": "eligible" if all((row.get("sectorSemantics") or {}).get("eligible") is True for row in profiles) else "insufficient-sector-semantic-support",
        },
        "labelPrevalence": profiles[0].get("labelPrevalence") or {},
        "labelNoiseSensitivity": profiles[0].get("labelNoiseSensitivity") or {},
        "marketPointInTimeFeaturesAvailable": all(bool(row.get("marketPointInTimeFeaturesAvailable")) for row in profiles),
        "eventFeatureActivationReason": profiles[0].get("eventFeatureActivationReason") or "insufficient-verified-pit",
        "featurePolicy": profiles[0].get("featurePolicy") or "Core low-redundancy feature set.",
        "firstStageTarget": target,
        "coverageVsTargetPct": round(min(100.0, minimum_horizon_rows / max(1, target["rows"]) * 100.0), 4),
        "sampleMeaning": profiles[0].get("sampleMeaning") or {},
        "memoryPolicy": "Each horizon is built, trained, and released separately so 5d/15d/30d rows are not retained in memory together.",
        "panelSampling": panel_sampling,
        "outerCrossSectionRowConservation": outer_conservation,
    }


def hydrate_verified_pit_from_data_lake(
    items: list[dict[str, Any]],
    *,
    market: str,
    root: Any,
    limit_per_symbol: int = 600,
    snapshot_id: str | None = None,
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
        "snapshot_id": snapshot_id,
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
        "snapshotId": snapshot_id,
    }


def _lane_blocked_result(
    *,
    market: str,
    lane_policy: dict[str, Any],
    reason: str,
    hypothesis_contract: dict[str, Any],
) -> dict[str, Any]:
    """Return a terminal no-fit result for an invalid or frozen lane."""
    lane = lane_policy.get("lane")
    return {
        "available": False,
        "attemptCompleted": False,
        "artifactProduced": False,
        "predictiveModelProduced": False,
        "tradeModelProduced": False,
        "market": market,
        "trainingLane": lane,
        "evidenceTier": lane_policy.get("evidenceTier"),
        "evidenceType": lane_policy.get("evidenceType"),
        "status": "BLOCKED_GATE03" if lane == "strict_production" else "REJECTED_RESEARCH_REQUEST",
        "trainingStatus": "BLOCKED_GATE03" if lane == "strict_production" else "REJECTED",
        "deploymentStatus": "frozen" if lane == "strict_production" else "research",
        "productionEvidencePassed": False,
        "productionActivationBlocked": True,
        "promotionEligible": False,
        "reason": reason,
        "blockReasons": [reason],
        "manifest": {
            "model_version": None,
            "candidate_status": "BLOCKED_GATE03" if lane == "strict_production" else "REJECTED_RESEARCH_REQUEST",
            "training_lane": lane,
            "evidence_tier": lane_policy.get("evidenceTier"),
            "evidence_type": lane_policy.get("evidenceType"),
            "research_contract_schema": lane_policy.get("contractSchema"),
            "research_contract_hash": lane_policy.get("contractHash"),
            "hypothesis_contract": hypothesis_contract,
            "lockbox_read": False,
            "best_challenger_updated": False,
            "promotion_eligible": False,
        },
        "productionEligibility": {
            "eligible": False,
            "autoPromotionAllowed": False,
            "championUpdateAllowed": False,
            "longTradeGateAllowed": False,
            "reason": reason,
        },
    }


def train_market_multitask(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "ASX").upper()
    hypothesis_contract = experiment_hypothesis_contract(payload)
    if not hypothesis_contract.get("valid"):
        raise ValueError(str(hypothesis_contract.get("rejectionReason") or "invalid_experiment_hypothesis"))
    if hypothesis_contract.get("jobType") == "evidence_refresh":
        return {
            "available": False,
            "status": "EVIDENCE_REFRESH_COMPLETE",
            "trainingStatus": "NOT_FITTED",
            "jobType": "evidence_refresh",
            "attemptCompleted": True,
            "artifactProduced": True,
            "predictiveModelProduced": False,
            "tradeModelProduced": False,
            "horizonModels": [],
            "manifest": {
                "model_version": None,
                "candidate_status": "EVIDENCE_REFRESH",
                "hypothesis_contract": hypothesis_contract,
                "lockbox_read": False,
                "best_challenger_updated": False,
                "training_lane": "strict_production",
                "evidence_tier": "D4",
                "promotion_eligible": False,
            },
            "reason": "Evidence refresh is a non-fitting governance job and cannot create or promote a model.",
        }
    lane_policy = resolve_training_lane(payload)
    request_policy = validate_training_request(payload, hypothesis_contract=hypothesis_contract)
    # Older local unit callers did not carry a gate context.  Keep those
    # diagnostic calls compatible, while every server/scheduler request now
    # carries an explicit gate decision and is enforced above this branch.
    gate_context_present = any(
        key in payload
        for key in ("strictGate03Approved", "strict_gate03_approved", "gate03NextPhasePermitted", "trainingLane", "training_lane")
    )
    if not request_policy.get("allowed") and lane_policy.get("lane") == "strict_production" and not gate_context_present:
        request_policy = {
            **request_policy,
            "allowed": True,
            "reason": "legacy_unbound_caller_requires_scheduler_gate_context",
            "unboundGateContext": True,
        }
    if not request_policy.get("allowed"):
        return _lane_blocked_result(
            market=market,
            lane_policy=lane_policy,
            reason=str(request_policy.get("reason") or "training_lane_request_rejected"),
            hypothesis_contract=hypothesis_contract,
        )
    training_lane = str(lane_policy.get("lane") or "strict_production")
    raw_horizons = default_horizons(payload, training_lane)
    requested_horizons = sorted({max(1, int(number(value, 15))) for value in raw_horizons})
    items = payload.get("items") or []
    data_lake_root = payload.get("data_lake_root", payload.get("dataLakeRoot"))
    snapshot_manifest = None
    if payload.get("freeze_data_snapshot", payload.get("freezeDataSnapshot", True)) is not False:
        frozen_snapshot_id = str(payload.get("frozen_snapshot_id") or payload.get("frozenSnapshotId") or payload.get("snapshot_id") or payload.get("snapshotId") or "").strip()
        if frozen_snapshot_id:
            snapshot_path = Path(str(data_lake_root or ".cache/data-lake")).expanduser().resolve() / "snapshots" / f"market={market}" / f"{frozen_snapshot_id}.json"
            try:
                candidate = json.loads(snapshot_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError(f"Frozen training snapshot is unavailable: {frozen_snapshot_id}") from exc
            if candidate.get("snapshotId") != frozen_snapshot_id or candidate.get("status") == "mutable":
                raise ValueError(f"Frozen training snapshot failed validation: {frozen_snapshot_id}")
            snapshot_manifest = candidate
        else:
            try:
                from .data_lake import create_training_snapshot
            except ImportError:  # Direct worker imports keep quant_core on sys.path.
                from data_lake import create_training_snapshot
            snapshot_manifest = create_training_snapshot({
                "root": data_lake_root,
                "market": market,
                "symbols": [item.get("symbol") for item in items if isinstance(item, dict)],
            })
    snapshot_id = snapshot_manifest.get("snapshotId") if snapshot_manifest else None
    market_point_in_time_features = payload.get("market_point_in_time_features", payload.get("marketPointInTimeFeatures")) or []
    pit_load = None
    if payload.get("load_pit_from_data_lake", payload.get("loadPitFromDataLake", False)) is True:
        items, market_point_in_time_features, pit_load = hydrate_verified_pit_from_data_lake(
            items,
            market=market,
            root=data_lake_root,
            limit_per_symbol=int(payload.get("pit_rows_per_symbol", payload.get("pitRowsPerSymbol", 600)) or 600),
            snapshot_id=snapshot_id,
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
        "expertResidualCorrelation": number(payload.get("expert_residual_correlation", payload.get("expertResidualCorrelation")), 0.65),
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
        # Promotion evidence must evaluate the complete audited daily panel.
        # Row caps remain available inside individual fitters, but may not
        # alter the outer OOF universe or its cross-sectional labels.
        "requestedPanelMaxSymbols": int(payload.get("panel_max_symbols", payload.get("panelMaxSymbols", os.getenv("PRODUCTION_PANEL_MAX_SYMBOLS_PER_DATE", "0"))) or 0),
        "requestedPanelDateStride": int(payload.get("panel_date_stride", payload.get("panelDateStride", os.getenv("PRODUCTION_PANEL_DATE_STRIDE", "1"))) or 1),
        "panelMaxSymbols": 0,
        "panelDateStride": 1,
        "progressPath": payload.get("progress_path", payload.get("progressPath")),
        "trainingRunId": payload.get("training_run_id", payload.get("trainingRunId")),
        "market": market,
        "snapshotId": snapshot_id,
        "preFitLockbox": None,
        "preFitLockboxDataVersion": None,
        "preFitUniverseVersion": None,
        "preFitTestMembership": None,
        "lockboxCreatedBeforeFit": False,
        "primaryPromotionHorizon": preferred_short_horizon,
        "jobType": hypothesis_contract.get("jobType"),
        "changedHypothesis": hypothesis_contract.get("changedHypothesis"),
        "trainingLane": training_lane,
        "evidenceTier": lane_policy.get("evidenceTier"),
        "evidenceType": lane_policy.get("evidenceType"),
        "laneContractSchema": lane_policy.get("contractSchema"),
        "laneContractHash": lane_policy.get("contractHash"),
        "researchOnly": training_lane in RESEARCH_LANES,
        "experimentId": str(payload.get("experimentId", payload.get("experiment_id", "")) or "").strip() or None,
        "hypothesisId": str(payload.get("hypothesisId", payload.get("hypothesis_id", "")) or "").strip() or None,
    }
    if config["researchOnly"]:
        config["artifactDir"] = str(research_artifact_root(
            payload.get("artifact_root", payload.get("artifactRoot", payload.get("artifact_dir", payload.get("artifactDir")))),
            market=market,
            lane=training_lane,
            hypothesis_id=config["hypothesisId"] or "hypothesis",
            data_version=snapshot_id or "pending-snapshot",
            run_id=config.get("trainingRunId") or "research-run",
        ))
    _write_training_progress(config, "training-start", requestedHorizons=requested_horizons, itemCount=len(items))
    horizon_models = []
    dataset_profiles = []
    prefit_lockbox = None
    prefit_data_version = None
    prefit_universe_version = None
    for horizon in horizons:
        dataset = None
        dataset_cache_path = None
        if config["resumeLatestDataset"] and not items:
            _write_training_progress(config, "restoring-feature-matrix", horizon=horizon)
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
            _write_training_progress(config, "feature-matrix-build", horizon=horizon, itemCount=len(items))
            dataset = build_market_dataset(
                items,
                market=market,
                horizons=[horizon],
                target_upside=target_upside,
                stop_loss=stop_loss,
                transaction_cost_bps=transaction_cost_bps,
                market_point_in_time_features=market_point_in_time_features,
                panel_max_symbols=config["panelMaxSymbols"],
                panel_date_stride=config["panelDateStride"],
            )
            _save_dataset_cache(
                dataset_cache_path,
                dataset,
                market=market,
                horizon=horizon,
                snapshot_id=snapshot_id,
            )
        dataset["summary"]["featureMatrixCache"] = {
            "hit": dataset_cache_hit,
            "schema": FEATURE_MATRIX_SCHEMA,
            "eventAggregationSchema": EVENT_AGGREGATION_SCHEMA,
            "path": str(dataset_cache_path) if dataset_cache_path else None,
        }
        block_reasons = _training_block_reasons(dataset.get("summary") or {})
        dataset["summary"]["trainingBlocked"] = bool(block_reasons)
        dataset["summary"]["trainingBlockReasons"] = block_reasons
        if block_reasons:
            # The audit result is a hard pre-fit contract.  In particular, do
            # not run the label tournament here: it trains fold-local models
            # too, and previously allowed a blocked dataset to leave model
            # artifacts behind before the final summary noticed the problem.
            dataset_profiles.append(dataset["summary"])
            _write_training_progress(
                config,
                "training-blocked-data-quality",
                horizon=horizon,
                reasons=block_reasons,
                rowCount=len(dataset.get("rows") or []),
            )
            horizon_models.append(_blocked_horizon_result(
                dataset.get("rows") or [],
                market=market,
                horizon=horizon,
                reasons=block_reasons,
            ))
            _write_training_progress(config, "horizon-result", horizon=horizon, available=False, status="blocked_data_quality")
            continue
        if config["researchOnly"]:
            independent_dates = int((dataset.get("summary") or {}).get("dateCount") or 0)
            selected_fold_count = adaptive_fold_count(independent_dates)
            if selected_fold_count < 3:
                reason = "research_requires_at_least_30_independent_dates"
                dataset["summary"]["trainingBlocked"] = True
                dataset["summary"]["trainingBlockReasons"] = [reason]
                dataset_profiles.append(dataset["summary"])
                horizon_models.append(_blocked_horizon_result(
                    dataset.get("rows") or [],
                    market=market,
                    horizon=horizon,
                    reasons=[reason],
                ) | {
                    "status": "NO_MODEL",
                    "trainingStatus": "NO_MODEL",
                    "evidenceTier": config.get("evidenceTier"),
                    "evidenceType": config.get("evidenceType"),
                })
                _write_training_progress(config, "research-insufficient-dates", horizon=horizon, dateCount=independent_dates, requiredDates=30)
                continue
            config["foldCount"] = selected_fold_count
            config["minTrainDates"] = min(int(config.get("minTrainDates", 500)), max(40, int(independent_dates * 0.45)))
            config["testDates"] = min(int(config.get("testDates", 120)), max(10, int(independent_dates * 0.15)))
            _write_training_progress(
                config,
                "research-fold-policy",
                horizon=horizon,
                independentDates=independent_dates,
                foldCount=selected_fold_count,
                policy="30-59:3,60-119:4,120+:5",
            )
        # Freeze the primary comparison identity before label selection or any
        # learner is fitted.  This is an immutable research boundary, not a
        # post-hoc report generated after seeing the results.
        if horizon == preferred_short_horizon and prefit_lockbox is None:
            prefit_summary = dataset.get("summary") or {}
            prefit_schema = list(prefit_summary.get("activeFeatureNames") or CORE_TECHNICAL_FEATURE_NAMES)
            prefit_universe_version = stable_hash(sorted({
                str(item.get("universeVersion") or item.get("universeAsOf") or item.get("symbol"))
                for item in items
                if isinstance(item, dict)
            }))
            prefit_version_summary = {
                key: value for key, value in prefit_summary.items()
                if key not in {
                    "featureMatrixCache",
                    "labelTournamentOOF",
                    "trainingBlocked",
                    "trainingBlockReasons",
                }
            }
            prefit_data_version = stable_hash({
                "schema": FEATURE_MATRIX_SCHEMA,
                "market": market,
                "horizon": preferred_short_horizon,
                "summary": prefit_version_summary,
                "sources": prefit_summary.get("sources"),
                "snapshotId": snapshot_id,
                "snapshotContentHash": snapshot_manifest.get("contentHash") if snapshot_manifest else None,
            })
            prefit_test_membership = frozen_oof_test_membership(
                dataset.get("rows") or [],
                horizon=preferred_short_horizon,
                fold_count=int(config.get("foldCount", 5)),
                embargo_days=int(config.get("embargoDays", 7)),
                min_train_dates=int(config.get("minTrainDates", 500)),
                test_dates=int(config.get("testDates", 120)),
            )
            prefit_test_signature = prefit_test_membership.get("signature")
            prefit_summary["frozenOofTestMembership"] = prefit_test_membership
            prefit_lockbox = create_lockbox(
                market=market,
                data_version=prefit_data_version,
                feature_schema_hash=stable_hash(prefit_schema),
                universe_version=prefit_universe_version,
                label_definition="atr-adaptive-triple-barrier-next-session-entry-v2",
                test_set_signature=prefit_test_signature,
                source_versions=[*list(prefit_summary.get("sources") or []), str(prefit_summary.get("pitDataVersion") or "")],
                root=config.get("artifactDir"),
                independent_test_dates=int(prefit_test_membership.get("independentDates") or 0),
                row_count=int(prefit_test_membership.get("rowCount") or 0),
                training_lane=training_lane,
            )
            config["preFitLockbox"] = prefit_lockbox
            config["preFitLockboxDataVersion"] = prefit_data_version
            config["preFitUniverseVersion"] = prefit_universe_version
            config["preFitTestMembership"] = prefit_test_membership
            config["lockboxCreatedBeforeFit"] = True
            _write_training_progress(
                config,
                "lockbox-frozen-before-fit",
                horizon=horizon,
                lockboxId=prefit_lockbox.get("lockboxId"),
                dataVersion=prefit_data_version,
                featureSchemaHash=stable_hash(prefit_schema),
                testSetSignature=prefit_test_signature,
                testRows=prefit_test_membership.get("rowCount"),
                independentTestDates=prefit_test_membership.get("independentDates"),
            )
        if horizon == preferred_short_horizon and payload.get("run_label_tournament", payload.get("runLabelTournament", True)) is not False:
            tournament_config = {
                **config,
                "datasetContentHash": dataset_cache_path.name if dataset_cache_path is not None else stable_hash(dataset.get("summary") or {}, 24),
                "labelTournamentMaxRows": int(payload.get("label_tournament_max_rows", payload.get("labelTournamentMaxRows", 2_000)) or 2_000),
                "labelTournamentEpochs": int(payload.get("label_tournament_epochs", payload.get("labelTournamentEpochs", 8)) or 8),
            }
            _write_training_progress(config, "label-tournament-start", horizon=horizon, candidateCount=6, maxRows=tournament_config["labelTournamentMaxRows"])
            dataset["summary"]["labelTournamentOOF"] = run_label_tournament_oof(
                dataset.get("rows") or [],
                market=market,
                horizon=horizon,
                config=tournament_config,
            )
            _write_training_progress(
                config,
                "label-tournament-complete",
                horizon=horizon,
                status=(dataset["summary"].get("labelTournamentOOF") or {}).get("status"),
                selected=(dataset["summary"].get("labelTournamentOOF") or {}).get("selectedResearchCandidate"),
            )
        dataset_profiles.append(dataset["summary"])
        _write_training_progress(
            config,
            "feature-matrix-ready",
            horizon=horizon,
            rowCount=len(dataset.get("rows") or []),
            symbolCount=dataset.get("summary", {}).get("symbolCount"),
            dateCount=dataset.get("summary", {}).get("dateCount"),
            cacheHit=dataset_cache_hit,
        )
        horizon_config = {
            **config,
            "panelSampling": dataset.get("summary", {}).get("panelSampling") or {},
            "outerCrossSectionRowConservation": dataset.get("summary", {}).get("outerCrossSectionRowConservation") or {},
            "sectorAudit": dataset.get("summary", {}).get("sectorSemantics") or {},
            "labelNoiseSensitivity": dataset.get("summary", {}).get("labelNoiseSensitivity") or {},
            "labelTournamentOOF": dataset.get("summary", {}).get("labelTournamentOOF") or {
                "status": "not_run",
                "reason": "label tournament was disabled or the dataset was blocked before fitting",
            },
            "datasetContentHash": (
                dataset_cache_path.name
                if dataset_cache_path is not None
                else stable_hash(dataset.get("summary") or {}, 24)
            ),
        }
        try:
            horizon_result = train_horizon_model(dataset["rows"], market=market, horizon=horizon, config=horizon_config)
        except Exception:
            opened_lockbox = horizon_config.get("preFitLockbox") or {}
            candidate_id = str(horizon_config.get("lockboxCandidateId") or "")
            if opened_lockbox.get("status") == "opened" and candidate_id:
                failed_lockbox = consume_lockbox(
                    opened_lockbox,
                    candidate_id=candidate_id,
                    outcome="failed",
                    root=config.get("artifactDir"),
                )
                horizon_config["preFitLockbox"] = failed_lockbox
                config["preFitLockbox"] = failed_lockbox
                _write_training_progress(
                    config,
                    "lockbox-consumed-final-evaluation",
                    horizon=horizon,
                    lockboxId=failed_lockbox.get("lockboxId"),
                    candidateId=candidate_id,
                    outcome="failed",
                )
            raise
        config["preFitLockbox"] = horizon_config.get("preFitLockbox") or config.get("preFitLockbox")
        config["lockboxCandidateId"] = horizon_config.get("lockboxCandidateId") or config.get("lockboxCandidateId")
        horizon_result["trainingLane"] = training_lane
        horizon_result["evidenceTier"] = lane_policy.get("evidenceTier")
        horizon_result["evidenceType"] = lane_policy.get("evidenceType")
        horizon_result["promotionEligible"] = False if config["researchOnly"] else bool(horizon_result.get("productionEvidencePassed"))
        if config["researchOnly"]:
            horizon_result["productionActivationBlocked"] = True
        horizon_models.append(horizon_result)
        _write_training_progress(config, "horizon-result", horizon=horizon, available=bool(horizon_models[-1].get("available")))
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
    summary["trainingLane"] = training_lane
    summary["evidenceTier"] = lane_policy.get("evidenceTier")
    summary["evidenceType"] = lane_policy.get("evidenceType")
    summary["researchOnly"] = config["researchOnly"]
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
    primary_five_day = next((model for model in horizon_models if int(model.get("horizon") or 0) == preferred_short_horizon), None)
    panel_sampling = summary.get("panelSampling") or {}
    primary_row_count = int((primary_five_day or {}).get("rowCount") or 0)
    sampled_panel_rows = int(panel_sampling.get("sampledPanelRows") or 0)
    eligible_panel_rows = int(panel_sampling.get("eligiblePanelRows") or sampled_panel_rows or primary_row_count)
    fitted_rows = primary_row_count or sampled_panel_rows
    summary["eligibleRows"] = eligible_panel_rows
    summary["effectiveRows"] = fitted_rows
    summary["fittedRows"] = fitted_rows
    summary["oofRows"] = int((primary_five_day or {}).get("oofRows") or 0)
    summary["independentTestDates"] = int(
        ((primary_five_day or {}).get("directionMetrics") or {}).get("testDates")
        or ((primary_five_day or {}).get("metrics") or {}).get("testDates")
        or 0
    )
    summary["sampleCountContract"] = {
        "schema": "training-sample-counts-v2",
        "eligibleRows": "Rows eligible after market, time, PIT and label validation, before optional deterministic panel sampling.",
        "effectiveRows": "Actual rows supplied to the primary 5-day learner after deterministic sampling.",
        "oofRows": "Strict out-of-fold predictions emitted by the primary 5-day learner.",
        "independentTestDates": "Distinct signal dates represented by the strict OOF evaluation.",
        "legacyEffectiveWeightedRows": "Quality-weighted analytical support; it is not a physical fitted-row count.",
    }
    candidate_model_available = bool(available_models)
    evidence_passed = bool(primary_five_day and primary_five_day.get("available") and primary_five_day.get("productionEvidencePassed"))
    production_data_ready = (
        historical_universe_ok
        and corporate_actions_ok
        and adjusted_prices_ok
        and pit_ok
        and sample_isolation_ok
        and event_history_ok
        and universe_breadth_ok
        and (summary.get("labelNoiseSensitivity") or {}).get("unstable") is not True
        and not bool((summary.get("returnAudit") or {}).get("trainingBlocked"))
    )
    training_as_of = datetime.now(timezone.utc).isoformat()
    schema = list(summary.get("activeFeatureNames") or CORE_TECHNICAL_FEATURE_NAMES)
    data_version = str(config.get("preFitLockboxDataVersion") or stable_hash({
        "summary": summary,
        "sources": summary.get("sources"),
        "snapshotId": snapshot_id,
        "snapshotContentHash": snapshot_manifest.get("contentHash") if snapshot_manifest else None,
    }))
    feature_schema_hash = stable_hash(schema)
    universe_version = str(config.get("preFitUniverseVersion") or stable_hash(sorted({str(item.get("universeVersion") or item.get("universeAsOf") or item.get("symbol")) for item in payload.get("items") or []})))
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
            downgrade_reasons.append(f"{model.get('horizon')}d eligible-long gate inactive; no production EV fallback is permitted")
        if any(number((fold.get("featureDrift") or {}).get("maxPsi")) > 0.40 for fold in model.get("foldMetrics") or []):
            downgrade_reasons.append(f"{model.get('horizon')}d feature PSI > 0.40")
    primary_status = str((primary_five_day or {}).get("status") or "").upper()
    candidate_status = (
        "NO_MODEL"
        if not candidate_model_available
        else "RESEARCH"
        if training_lane in RESEARCH_LANES
        else "PARTIAL"
        if primary_status in {"NO_MODEL", "PARTIAL", "EVIDENCE_INSUFFICIENT"}
        else "SHADOW"
        if not downgrade_reasons and any(model.get("deploymentStatus") == "shadow" for model in available_models)
        else "RESEARCH"
    )
    candidate_training_status = (
        "NO_MODEL"
        if candidate_status == "NO_MODEL"
        else "PARTIAL"
        if candidate_status == "PARTIAL"
        else "AVAILABLE"
    )
    metric_contract_path = Path(__file__).resolve().parent / "contracts" / "metric-contract-5d.json"
    metric_contract_hash = hashlib.sha256(metric_contract_path.read_bytes()).hexdigest()
    manifest = {
        "model_version": (
            f"{market.lower()}-multitask-{stable_hash([model.get('modelVersion') for model in horizon_models], 12)}"
            if candidate_model_available
            else None
        ),
        "training_run_id": f"{market.lower()}-{training_as_of[:19].replace(':', '').replace('-', '')}-{stable_hash([data_version, feature_schema_hash, requested_horizons], 10)}",
        "training_as_of": training_as_of,
        "data_version": data_version,
        "feature_schema_hash": feature_schema_hash,
        "universe_version": universe_version,
        "label_definition": "atr-adaptive-triple-barrier-next-session-entry-v2",
        "fold_metrics": [{"horizon": model.get("horizon"), "folds": model.get("foldMetrics", [])} for model in horizon_models],
        "calibrator_version": stable_hash([model.get("calibrator") for model in horizon_models]),
        "deployment_status": candidate_status.lower(),
        "candidate_status": candidate_status,
        "training_status": candidate_training_status,
        "training_lane": training_lane,
        "evidence_tier": lane_policy.get("evidenceTier"),
        "evidence_type": lane_policy.get("evidenceType"),
        "research_only": config["researchOnly"],
        "research_contract_schema": lane_policy.get("contractSchema"),
        "research_contract_hash": lane_policy.get("contractHash"),
        "experiment_id": config.get("experimentId"),
        "hypothesis_id": config.get("hypothesisId"),
        "promotion_eligible": False if config["researchOnly"] else False,
        "attempt_completed": True,
        "model_produced": candidate_model_available and candidate_status != "NO_MODEL",
        "artifact_produced": any(model.get("artifactProduced") is True for model in horizon_models),
        "predictive_model_produced": bool((primary_five_day or {}).get("predictiveModelProduced")),
        "trade_model_produced": bool((primary_five_day or {}).get("tradeModelProduced")),
        "model_family_status": (primary_five_day or {}).get("modelFamilyStatus") or {},
        "testSetPolicy": "live-lockbox-created-before-threshold-or-label-selection; final acceptance may read it once",
        "lockbox_created_before_fit": bool(config.get("lockboxCreatedBeforeFit")),
        "experimentLedgerSchema": "research-experiment-record-v1",
        "changed_hypothesis": config.get("changedHypothesis"),
        "hypothesis_contract": hypothesis_contract,
        "metric_contract": "metric-contract-5d-v2",
        "metric_contract_hash": metric_contract_hash,
        "snapshot_id": snapshot_id,
        "snapshot_content_hash": snapshot_manifest.get("contentHash") if snapshot_manifest else None,
        "training_fingerprint": stable_hash({
            "codeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "config": config,
            "snapshotId": snapshot_id,
            "dataVersion": data_version,
            "featureSchemaHash": feature_schema_hash,
            "labelDefinition": "atr-adaptive-triple-barrier-next-session-entry-v2",
            "transactionCostBps": transaction_cost_bps,
            "market": market,
        }, 64),
    }
    lockbox = config.get("preFitLockbox") or create_lockbox(
        market=market,
        data_version=data_version,
        feature_schema_hash=feature_schema_hash,
        universe_version=manifest["universe_version"],
        label_definition=manifest["label_definition"],
        test_set_signature=stable_hash({
            "market": market,
            "dataVersion": data_version,
            "featureSchemaHash": feature_schema_hash,
            "universeVersion": manifest["universe_version"],
            "horizon": preferred_short_horizon,
            "policy": "new-live-lockbox-2026-08-18",
        }, 32),
        source_versions=[*list(summary.get("sources") or []), str(summary.get("pitDataVersion") or "")],
        root=config.get("artifactDir"),
        independent_test_dates=int((primary_five_day or {}).get("metrics", {}).get("testDates") or 0),
        row_count=int(summary.get("rawRows") or 0),
        training_lane=training_lane,
    )
    manifest["lockbox_id"] = lockbox.get("lockboxId")
    manifest["lockbox_status"] = lockbox.get("status")
    manifest["lockbox_evaluation_outcome"] = lockbox.get("evaluationOutcome")
    manifest["lockbox_access_count"] = int(lockbox.get("accessCount") or 0)
    lockbox_integrity_passed = bool(
        lockbox.get("status") == "consumed"
        and int(lockbox.get("accessCount") or 0) == 1
        and str(lockbox.get("openedByCandidateId") or "")
        == str(lockbox.get("consumedByCandidateId") or "")
        and str(lockbox.get("evaluationOutcome") or "") in {"accepted", "rejected", "failed", "cancelled"}
    )
    candidate_accepted = lockbox.get("evaluationOutcome") == "accepted"
    manifest["lockbox_integrity_passed"] = lockbox_integrity_passed
    manifest["candidate_accepted"] = candidate_accepted
    membership_contract = config.get("preFitTestMembership") or {}
    label_contract = {
        "schema": "atr-adaptive-triple-barrier-next-session-entry-v2",
        "horizon": preferred_short_horizon,
        "entry": "next-session-open-or-vwap",
        "targetUpsidePct": target_upside,
        "stopLossPct": stop_loss,
        "ambiguousBarrierPolicy": "excluded",
    }
    feature_contract = {
        "featureMatrixSchema": FEATURE_MATRIX_SCHEMA,
        "eventAggregationSchema": EVENT_AGGREGATION_SCHEMA,
        "activeFeatureNames": schema,
        "missingValuePolicy": "fold-local-standardize-and-neutral-fill",
    }
    cost_contract = {
        "market": market,
        "transactionCostBps": transaction_cost_bps,
        "entry": "next-session-open-or-vwap",
        "returnField": "cost-adjusted-net-return",
    }
    comparison_key_fields = {
        "market": market,
        "trainingLane": training_lane,
        "evidenceTier": lane_policy.get("evidenceTier"),
        "experimentId": config.get("experimentId"),
        "hypothesisId": config.get("hypothesisId"),
        "horizon": preferred_short_horizon,
        "dataVersion": data_version,
        "featureSchemaHash": feature_schema_hash,
        "universeVersion": manifest["universe_version"],
        "labelDefinition": manifest["label_definition"],
        "transactionCostBps": transaction_cost_bps,
        "splitPolicy": "purged-walk-forward-v1",
        "foldCount": int(config.get("foldCount", 5)),
        "embargoDays": int(config.get("embargoDays", 7)),
        "testSetSignature": lockbox.get("testSetSignature"),
        "trainMembershipHash": membership_contract.get("trainMembershipHash"),
        "testMembershipHash": membership_contract.get("testMembershipHash") or lockbox.get("testSetSignature"),
        "universeMembershipHash": membership_contract.get("universeMembershipHash"),
        "labelHash": stable_hash(label_contract, 32),
        "featureHash": stable_hash(feature_contract, 32),
        "costHash": stable_hash(cost_contract, 32),
        "splitHash": membership_contract.get("splitHash"),
        "innerSelectionWindowHash": ((primary_five_day or {}).get("directionModelSelection") or {}).get("windowManifestHash"),
        "metricContractHash": metric_contract_hash,
    }
    manifest["comparison_key_fields"] = comparison_key_fields
    manifest["comparison_key"] = stable_hash(comparison_key_fields, 32)
    return {
        "available": candidate_model_available,
        "status": candidate_status,
        "trainingStatus": candidate_training_status,
        "trainingLane": training_lane,
        "evidenceTier": lane_policy.get("evidenceTier"),
        "evidenceType": lane_policy.get("evidenceType"),
        "researchOnly": config["researchOnly"],
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
        "researchLockbox": lockbox,
        "productionEligibility": {
            "gateContract": "promotion-evidence-v3",
            "requiresImmutableSupervisorEvidence": True,
            "evidencePassed": evidence_passed,
            "dataReady": production_data_ready,
            "lockboxConsumed": lockbox.get("status") == "consumed",
            "lockboxIntegrityPassed": lockbox_integrity_passed,
            "candidateAccepted": candidate_accepted,
            "lockboxAccepted": candidate_accepted,
            "lockboxAccessCount": int(lockbox.get("accessCount") or 0),
            "requiresLockbox": True,
            "eligible": (
                not config["researchOnly"]
                and evidence_passed
                and production_data_ready
                and lockbox.get("status") == "consumed"
                and lockbox.get("evaluationOutcome") == "accepted"
                and int(lockbox.get("accessCount") or 0) == 1
            ),
            "autoPromotionAllowed": False,
            "championUpdateAllowed": not config["researchOnly"],
            "longTradeGateAllowed": not config["researchOnly"],
            "primaryPromotionHorizon": preferred_short_horizon,
            "longerHorizonsResearchOnly": [horizon for horizon in requested_horizons if horizon != preferred_short_horizon],
            "checks": {
                "historicalUniversePointInTime": historical_universe_ok,
                "corporateActionHistoryPointInTime": corporate_actions_ok,
                "adjustedPriceSeries": adjusted_prices_ok,
                "pointInTimeJoin": pit_ok,
                "sampleIsolation": sample_isolation_ok,
                "pointInTimeEventHistory": event_history_ok,
                "marketUniverseBreadth": universe_breadth_ok,
                "sectorSemantics": (summary.get("sectorSemantics") or {}).get("eligible") is True,
                "labelNoiseStable": (summary.get("labelNoiseSensitivity") or {}).get("unstable") is not True,
                "immutableLiveLockbox": (
                    lockbox_integrity_passed
                    and candidate_accepted
                ),
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
        metrics = calibration_metrics(
            meta_test,
            calibrated,
            baseline_probability=weighted_prevalence(meta_train, "actualTarget"),
        )
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
            "gateContract": "promotion-evidence-v2",
            "requiresImmutableSupervisorEvidence": True,
            "eligible": False,
            "evidencePassed": False,
            "dataReady": False,
            "autoPromotionAllowed": False,
            "reason": "Recovered OOF evidence is registered for reporting and Agent replay only; immutable PIT lineage is unavailable.",
        },
        "monitoringStatus": {"status": "research-recovered", "automaticDowngradeApplied": True, "evaluatedAt": now},
        "rejectTradePolicy": {"enabled": True, "reason": "Recovered artifacts cannot authorize new trades."},
    }
