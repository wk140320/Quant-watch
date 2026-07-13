from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import gzip
from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, time, timezone
from pathlib import Path
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from data_quality import assess_candle_quality, label_confidence_for_window
from historical_backtest import (
    FEATURE_NAMES,
    adaptive_barriers,
    apply_standardizer,
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


EVENT_FEATURE_NAMES = [
    "eventSentiment",
    "eventRelevance",
    "eventNovelty",
    "announcementScore",
    "fundamentalQuality",
    "macroRisk",
    "sourceQuality",
    "freshnessScore",
]

MODEL_OUTPUT_KEYS = [
    "ridgePrediction",
    "elasticPrediction",
    "lightgbmPrediction",
    "rankerPrediction",
    "pathSafetyPrediction",
    "quantilePrediction",
    "eventPrediction",
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
}

MARKET_COST_BPS = {"US": 12.0, "ASX": 18.0, "CN": 20.0}
MARKET_TIME_ZONE = {"US": "America/New_York", "ASX": "Australia/Sydney", "CN": "Asia/Shanghai"}
MARKET_CLOSE = {"US": time(16, 0), "ASX": time(16, 10), "CN": time(15, 0)}


def stable_hash(value: Any, length: int = 16) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:length]


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


def point_in_time_features(item: dict[str, Any], signal_day: str, market: str) -> dict[str, Any]:
    signal_at = market_close_timestamp(signal_day, market)
    candidates = item.get("pointInTimeFeatures") or item.get("point_in_time_features") or item.get("events") or []
    selected: list[tuple[datetime, dict[str, Any]]] = []
    excluded_future = 0
    join_violations = 0
    for raw in candidates if isinstance(candidates, list) else []:
        if not isinstance(raw, dict):
            continue
        available_at = parse_timestamp(raw.get("available_at", raw.get("availableAt", raw.get("publishedAt"))))
        if available_at is None:
            continue
        if signal_at is None or available_at > signal_at:
            excluded_future += 1
            continue
        effective_day = str(raw.get("effective_date", raw.get("effectiveDate", raw.get("date", ""))))[:10]
        if effective_day and effective_day > str(signal_day)[:10]:
            excluded_future += 1
            continue
        values = raw.get("values") if isinstance(raw.get("values"), dict) else raw
        selected.append((available_at, values))
    selected.sort(key=lambda row: row[0])
    output = {name: 0.0 for name in EVENT_FEATURE_NAMES}
    latest_at = None
    for available_at, values in selected[-24:]:
        if signal_at is not None and available_at > signal_at:
            join_violations += 1
            continue
        latest_at = available_at
        age_days = max(0.0, (signal_at - available_at).total_seconds() / 86400.0) if signal_at else 0.0
        decay = math.exp(-age_days / 20.0)
        for name in EVENT_FEATURE_NAMES:
            if name in values:
                output[name] = clamp(number(values.get(name)) * decay, -5.0, 5.0)
    return {
        "values": output,
        "signalAt": signal_at.isoformat() if signal_at else None,
        "latestAvailableAt": latest_at.isoformat() if latest_at else None,
        "sourceRows": len(selected),
        "futureRowsExcluded": excluded_future,
        "joinViolationCount": join_violations,
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
            row["rankRelevance"] = min(4, max(0, int(rank * 5)))
            row["crossSectionSize"] = len(ordered)


def build_market_dataset(
    items: list[dict[str, Any]],
    *,
    market: str,
    horizons: list[int],
    target_upside: float = 5.0,
    stop_loss: float = 4.0,
    transaction_cost_bps: float | None = None,
) -> dict[str, Any]:
    key = str(market or "ASX").upper()
    costs = MARKET_COST_BPS.get(key, 18.0) if transaction_cost_bps is None else max(0.0, number(transaction_cost_bps))
    dataset: list[dict[str, Any]] = []
    source_rows = 0
    excluded_future_rows = 0
    join_violation_count = 0
    historical_universe_rows = 0
    action_adjusted_rows = 0
    source_names: set[str] = set()
    for item in items or []:
        symbol = str(item.get("symbol") or "").upper()
        candles = sanitize_candles(item.get("candles") or [])
        if not symbol or len(candles) < 70:
            continue
        source_names.add(str(item.get("source") or "unknown"))
        historical_universe_rows += 1 if item.get("universeAsOf") or item.get("historicalUniverse") else 0
        action_adjusted_rows += 1 if item.get("corporateActionAdjusted") else 0
        quality = assess_candle_quality(candles)
        quality_rows = list(quality.get("rows") or [])
        volumes = sorted(max(0.0, number(row.get("volume"))) for row in candles if number(row.get("volume")) > 0)
        median_volume = median(volumes) if volumes else 1.0
        feature_cache = {
            index: feature_dict(candles, index)
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
                pit = point_in_time_features(item, str(candles[index].get("date") or ""), key)
                source_rows += int(pit["sourceRows"])
                excluded_future_rows += int(pit["futureRowsExcluded"])
                join_violation_count += int(pit["joinViolationCount"])
                event_values = pit["values"]
                x = [number(feature.get(name)) for name in FEATURE_NAMES] + [number(event_values.get(name)) for name in EVENT_FEATURE_NAMES]
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
                    "eventCoverage": 1.0 if pit["sourceRows"] else 0.0,
                    "pitFutureRowsExcluded": pit["futureRowsExcluded"],
                    "pitJoinViolationCount": pit["joinViolationCount"],
                    "source": str(item.get("source") or "unknown"),
                })
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
    summary = dataset_profile(
        dataset,
        market=key,
        item_count=len(items or []),
        source_names=sorted(source_names),
        source_rows=source_rows,
        excluded_future_rows=excluded_future_rows,
        join_violation_count=join_violation_count,
        historical_universe_rows=historical_universe_rows,
        action_adjusted_rows=action_adjusted_rows,
    )
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
    historical_universe_rows: int,
    action_adjusted_rows: int,
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
        "historicalUniverseCoveragePct": round(historical_universe_rows / max(1, item_count) * 100.0, 3),
        "corporateActionCoveragePct": round(action_adjusted_rows / max(1, item_count) * 100.0, 3),
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


def _sklearn_baseline_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not model_library_status()["sklearn"]:
        return None
    try:
        import numpy as np  # type: ignore
        from sklearn.linear_model import LogisticRegression, Ridge, SGDClassifier  # type: ignore
        from sklearn.preprocessing import StandardScaler  # type: ignore

        x_train = np.asarray([row["x"] for row in train], dtype=float)
        x_test = np.asarray([row["x"] for row in test], dtype=float)
        sample_weight = np.asarray([number(row.get("trainingWeight"), 1.0) for row in train], dtype=float)
        scaler = StandardScaler()
        scaled_train = scaler.fit_transform(x_train)
        scaled_test = scaler.transform(x_test)

        ridge_return = Ridge(alpha=2.0, random_state=13)
        ridge_return.fit(scaled_train, [row["actualReturn"] for row in train], sample_weight=sample_weight)
        ridge_rank = Ridge(alpha=2.6, random_state=17)
        ridge_rank.fit(scaled_train, [row["returnRank"] for row in train], sample_weight=sample_weight)

        def binary_predictions(target_key: str, *, elastic: bool = False) -> list[float]:
            target = np.asarray([1 if number(row[target_key]) >= 0.5 else 0 for row in train], dtype=int)
            if len(np.unique(target)) < 2:
                return [float(target[0]) if len(target) else 0.5 for _ in test]
            if elastic:
                model = SGDClassifier(
                    loss="log_loss",
                    penalty="elasticnet",
                    alpha=0.0008,
                    l1_ratio=0.22,
                    max_iter=1800,
                    tol=1e-4,
                    random_state=23,
                    average=True,
                )
            else:
                model = LogisticRegression(C=0.75, solver="lbfgs", max_iter=400, random_state=19)
            model.fit(scaled_train, target, sample_weight=sample_weight)
            return [number(value) for value in model.predict_proba(scaled_test)[:, 1]]

        return {
            "family": "sklearn-logistic-ridge-elasticnet",
            "baselineReturn": [number(value) for value in ridge_return.predict(scaled_test)],
            "target": binary_predictions("actualTarget"),
            "elasticTarget": binary_predictions("actualTarget", elastic=True),
            "stop": binary_predictions("actualStop"),
            "timeout": binary_predictions("actualTimeout"),
            "rank": [number(value) for value in ridge_rank.predict(scaled_test)],
        }
    except Exception:
        return None


def _fallback_baseline_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> dict[str, Any]:
    ridge_return = fit_ridge(train, "actualReturn", 0.12)
    ridge_target = fit_logistic(train, "actualTarget", 0.12)
    elastic_target = fit_logistic(train, "actualTarget", 0.2)
    ridge_stop = fit_logistic(train, "actualStop", 0.12)
    ridge_timeout = fit_logistic(train, "actualTimeout", 0.12)
    ridge_rank = fit_ridge(train, "returnRank", 0.14)
    return {
        "family": "python-logistic-ridge-fallback",
        "baselineReturn": predict_linear(ridge_return, test),
        "target": predict_logistic(ridge_target, test),
        "elasticTarget": predict_logistic(elastic_target, test),
        "stop": predict_logistic(ridge_stop, test),
        "timeout": predict_logistic(ridge_timeout, test),
        "rank": predict_linear(ridge_rank, test),
    }


def _tree_fold_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]], *, enabled: bool) -> dict[str, Any] | None:
    status = model_library_status()
    if not enabled or len(train) < 500:
        return None
    x_train = [row["x"] for row in train]
    x_test = [row["x"] for row in test]
    sample_weight = [number(row.get("trainingWeight"), 1.0) for row in train]
    try:
        if status["catboost"]:
            from catboost import CatBoostClassifier, CatBoostRanker, CatBoostRegressor  # type: ignore

            target = CatBoostClassifier(iterations=160, depth=6, learning_rate=0.045, loss_function="Logloss", verbose=False, random_seed=17, thread_count=2)
            stop = CatBoostClassifier(iterations=160, depth=6, learning_rate=0.045, loss_function="Logloss", verbose=False, random_seed=19, thread_count=2)
            timeout = CatBoostClassifier(iterations=160, depth=6, learning_rate=0.045, loss_function="Logloss", verbose=False, random_seed=21, thread_count=2)
            target.fit(x_train, [row["actualTarget"] for row in train], sample_weight=sample_weight)
            stop.fit(x_train, [row["actualStop"] for row in train], sample_weight=sample_weight)
            timeout.fit(x_train, [row["actualTimeout"] for row in train], sample_weight=sample_weight)
            ordered = sorted(range(len(train)), key=lambda index: (train[index]["date"], train[index]["symbol"]))
            ranker = CatBoostRanker(iterations=160, depth=6, learning_rate=0.045, loss_function="QueryRMSE", verbose=False, random_seed=23, thread_count=2)
            ranker.fit(
                [x_train[index] for index in ordered],
                [train[index]["rankRelevance"] for index in ordered],
                group_id=[train[index]["date"] for index in ordered],
                sample_weight=[sample_weight[index] for index in ordered],
            )
            quantiles = []
            for alpha in (0.1, 0.5, 0.9):
                model = CatBoostRegressor(iterations=160, depth=6, learning_rate=0.045, loss_function=f"Quantile:alpha={alpha}", verbose=False, random_seed=29, thread_count=2)
                model.fit(x_train, [row["actualReturn"] for row in train], sample_weight=sample_weight)
                quantiles.append([number(value) for value in model.predict(x_test)])
            challenger_target = None
            if status["lightgbm"]:
                try:
                    import lightgbm as lgb  # type: ignore

                    challenger = lgb.LGBMClassifier(
                        objective="binary",
                        n_estimators=140,
                        learning_rate=0.04,
                        num_leaves=15,
                        max_depth=7,
                        subsample=0.82,
                        colsample_bytree=0.78,
                        reg_lambda=1.2,
                        verbosity=-1,
                        n_jobs=2,
                    )
                    challenger.fit(x_train, [row["actualTarget"] for row in train], sample_weight=sample_weight)
                    challenger_target = [number(row[1]) for row in challenger.predict_proba(x_test, validate_features=False)]
                except Exception:
                    challenger_target = None
            return {
                "family": "catboost+lightgbm-challenger" if challenger_target is not None else "catboost",
                "target": [number(row[1]) for row in target.predict_proba(x_test)],
                "stop": [number(row[1]) for row in stop.predict_proba(x_test)],
                "timeout": [number(row[1]) for row in timeout.predict_proba(x_test)],
                "rank": [number(value) for value in ranker.predict(x_test)],
                "quantiles": quantiles,
                "challengerTarget": challenger_target,
            }
        if status["lightgbm"]:
            return _lightgbm_fold_predictions(train, test)
    except Exception as exc:  # noqa: BLE001 - optional challenger failure must not block baselines.
        if status["lightgbm"]:
            fallback = _lightgbm_fold_predictions(train, test)
            if fallback and not fallback.get("error"):
                fallback["fallbackFrom"] = f"catboost: {exc}"
                return fallback
        return {"error": str(exc), "family": "optional_tree_error"}
    return None


def _lightgbm_fold_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        import lightgbm as lgb  # type: ignore

        x_train = [row["x"] for row in train]
        x_test = [row["x"] for row in test]
        sample_weight = [number(row.get("trainingWeight"), 1.0) for row in train]
        common = {"n_estimators": 160, "learning_rate": 0.04, "num_leaves": 15, "max_depth": 7, "subsample": 0.82, "colsample_bytree": 0.78, "reg_lambda": 1.2, "verbosity": -1, "n_jobs": 2}
        target = lgb.LGBMClassifier(objective="binary", **common)
        stop = lgb.LGBMClassifier(objective="binary", **common)
        timeout = lgb.LGBMClassifier(objective="binary", **common)
        target.fit(x_train, [row["actualTarget"] for row in train], sample_weight=sample_weight)
        stop.fit(x_train, [row["actualStop"] for row in train], sample_weight=sample_weight)
        timeout.fit(x_train, [row["actualTimeout"] for row in train], sample_weight=sample_weight)
        ordered_rows = sorted(train, key=lambda row: (row["date"], row["symbol"]))
        groups: list[int] = []
        last_date = None
        for row in ordered_rows:
            if row["date"] != last_date:
                groups.append(0)
                last_date = row["date"]
            groups[-1] += 1
        ranker = lgb.LGBMRanker(objective="lambdarank", **common)
        ranker.fit(
            [row["x"] for row in ordered_rows],
            [row["rankRelevance"] for row in ordered_rows],
            group=groups,
            sample_weight=[row["trainingWeight"] for row in ordered_rows],
        )
        quantiles = []
        for alpha in (0.1, 0.5, 0.9):
            model = lgb.LGBMRegressor(objective="quantile", alpha=alpha, **common)
            model.fit(x_train, [row["actualReturn"] for row in train], sample_weight=sample_weight)
            quantiles.append([number(value) for value in model.predict(x_test)])
        return {
            "family": "lightgbm",
            "target": [number(row[1]) for row in target.predict_proba(x_test, validate_features=False)],
            "stop": [number(row[1]) for row in stop.predict_proba(x_test, validate_features=False)],
            "timeout": [number(row[1]) for row in timeout.predict_proba(x_test, validate_features=False)],
            "rank": [number(value) for value in ranker.predict(x_test)],
            "quantiles": quantiles,
        }
    except Exception as exc:  # noqa: BLE001 - optional model family must not block baselines.
        return {"error": str(exc), "family": "lightgbm_error"}


def _event_fold_predictions(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> list[float | None] | None:
    event_train = [row for row in train if number(row.get("eventCoverage")) > 0]
    if len(event_train) < 80 or sum(row["actualTarget"] for row in event_train) < 12:
        return None
    mapped_train = [{**row, "x": row["eventX"]} for row in event_train]
    mapped_test = [{**row, "x": row["eventX"]} for row in test]
    model = fit_logistic(mapped_train, "actualTarget", 0.14)
    predictions = predict_logistic(model, mapped_test)
    return [predictions[index] if number(row.get("eventCoverage")) > 0 else None for index, row in enumerate(test)]


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
    feature_names = [*FEATURE_NAMES, *EVENT_FEATURE_NAMES]
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
        "topFeatures": [
            {"feature": row["feature"], "psi": round(row["psi"], 6), "standardizedMeanShift": round(row["standardizedMeanShift"], 6)}
            for row in drift_rows[:8]
        ],
    }


def _fold_oof_predictions(fold: dict[str, Any], *, enable_tree_models: bool) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    train = fold["train"]
    test = fold["test"]
    baseline = _sklearn_baseline_predictions(train, test) or _fallback_baseline_predictions(train, test)
    baseline_return = baseline["baselineReturn"]
    stable_baseline_probability = baseline["target"]
    elastic_probability = baseline["elasticTarget"]
    target_probability_rows = baseline["target"]
    stop_probability = baseline["stop"]
    timeout_probability = baseline["timeout"]
    rank_scores = baseline["rank"]
    tree = _tree_fold_predictions(train, test, enabled=enable_tree_models)
    family = baseline["family"]
    if tree and not tree.get("error"):
        family = f"{family}+{tree.get('family')}"
        target_probability_rows = tree["target"]
        stop_probability = tree["stop"]
        timeout_probability = tree["timeout"]
        rank_scores = tree["rank"]
        quantiles = tree["quantiles"]
    else:
        q_models = [fit_quantile_linear(train, alpha) for alpha in (0.1, 0.5, 0.9)]
        quantiles = [predict_quantile(model, test) for model in q_models]
    rank_probability = _percentile_by_date(test, rank_scores)
    event_probability = _event_fold_predictions(train, test)
    drift = feature_drift_summary(train, test)
    output: list[dict[str, Any]] = []
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
            "targetProbability": target_probability,
            "stopProbability": stop_prob,
            "timeoutProbability": timeout_prob,
            "quantileP10": q10,
            "quantileP50": q50,
            "quantileP90": q90,
            "baselineReturn": number(baseline_return[index]),
            "regime": row["regime"],
            "dataQuality": row["dataQualityScore"],
            "evaluationWeight": row["evaluationWeight"],
            "transactionCostBps": row["transactionCostBps"],
            "entrySource": row["entrySource"],
            "fold": fold["fold"],
        })
    return output, {
        "fold": fold["fold"],
        "family": family,
        "optionalTreeError": tree.get("error") if tree else None,
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
    }


def _model_value(row: dict[str, Any], name: str) -> float:
    value = row.get(name)
    return 0.5 if value is None else clamp(number(value, 0.5), 0.001, 0.999)


def residual_correlation(rows: list[dict[str, Any]], left: str, right: str) -> float:
    if len(rows) < 3:
        return 0.0
    left_values = [_model_value(row, left) - number(row["actualTarget"]) for row in rows]
    right_values = [_model_value(row, right) - number(row["actualTarget"]) for row in rows]
    left_mean = sum(left_values) / len(left_values)
    right_mean = sum(right_values) / len(right_values)
    covariance = sum((left_values[index] - left_mean) * (right_values[index] - right_mean) for index in range(len(rows)))
    left_var = sum((value - left_mean) ** 2 for value in left_values)
    right_var = sum((value - right_mean) ** 2 for value in right_values)
    return covariance / math.sqrt(max(1e-12, left_var * right_var))


def brier(rows: list[dict[str, Any]], probability_key: str | None = None, probabilities: list[float] | None = None) -> float:
    if not rows:
        return 0.0
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(weights) or 1.0
    values = probabilities if probabilities is not None else [_model_value(row, str(probability_key)) for row in rows]
    return sum((number(values[index]) - number(row["actualTarget"])) ** 2 * weights[index] for index, row in enumerate(rows)) / total


def prune_correlated_models(rows: list[dict[str, Any]], names: list[str], threshold: float = 0.8) -> tuple[list[str], list[dict[str, Any]]]:
    kept = list(names)
    pruned: list[dict[str, Any]] = []
    changed = True
    while changed and len(kept) > 3:
        changed = False
        for left_index in range(len(kept)):
            for right_index in range(left_index + 1, len(kept)):
                left, right = kept[left_index], kept[right_index]
                correlation = residual_correlation(rows, left, right)
                if abs(correlation) <= threshold:
                    continue
                left_brier = brier(rows, left)
                right_brier = brier(rows, right)
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


def fit_constrained_stack(rows: list[dict[str, Any]], names: list[str], *, cap: float = 0.35, shrinkage: float = 0.18) -> list[float]:
    if not rows or not names:
        return []
    prior = [1.0 / len(names) for _ in names]
    weights = list(prior)
    row_weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total = sum(row_weights) or 1.0
    step = 0.035 / max(1, len(names))
    for _ in range(600):
        gradients = [2.0 * shrinkage * (weights[index] - prior[index]) for index in range(len(names))]
        for row_index, row in enumerate(rows):
            prediction = sum(weights[index] * _model_value(row, name) for index, name in enumerate(names))
            error = prediction - number(row["actualTarget"])
            importance = row_weights[row_index] / total
            for index, name in enumerate(names):
                gradients[index] += 2.0 * error * _model_value(row, name) * importance
        weights = project_capped_simplex([weights[index] - step * gradients[index] for index in range(len(names))], cap)
    return weights


def ensemble_probabilities(rows: list[dict[str, Any]], names: list[str], weights: list[float]) -> list[float]:
    return [
        clamp(sum(weights[index] * _model_value(row, name) for index, name in enumerate(names)), 0.001, 0.999)
        for row in rows
    ]


def fit_platt(probabilities: list[float], actuals: list[float]) -> dict[str, float]:
    if not probabilities:
        return {"intercept": 0.0, "slope": 1.0}
    intercept = 0.0
    slope = 1.0
    for _ in range(500):
        grad_intercept = 0.0
        grad_slope = 0.0
        for probability, actual in zip(probabilities, actuals):
            logit = math.log(clamp(probability, 0.001, 0.999) / (1.0 - clamp(probability, 0.001, 0.999)))
            prediction = sigmoid(intercept + slope * logit)
            error = prediction - actual
            grad_intercept += error
            grad_slope += error * logit
        scale = 1.0 / max(1, len(probabilities))
        intercept -= 0.08 * grad_intercept * scale
        slope -= 0.025 * (grad_slope * scale + 0.02 * (slope - 1.0))
        slope = clamp(slope, 0.05, 4.0)
    return {"intercept": intercept, "slope": slope}


def apply_platt(model: dict[str, float], probabilities: list[float]) -> list[float]:
    return [
        sigmoid(number(model.get("intercept")) + number(model.get("slope"), 1.0) * math.log(clamp(value, 0.001, 0.999) / (1.0 - clamp(value, 0.001, 0.999))))
        for value in probabilities
    ]


def fit_probability_calibrator(probabilities: list[float], actuals: list[float]) -> dict[str, Any]:
    if len(probabilities) >= 5000 and model_library_status()["sklearn"]:
        try:
            from sklearn.isotonic import IsotonicRegression  # type: ignore

            model = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
            model.fit(probabilities, actuals)
            return {
                "method": "isotonic",
                "xThresholds": [number(value) for value in model.X_thresholds_],
                "yThresholds": [number(value) for value in model.y_thresholds_],
            }
        except Exception:
            pass
    return {"method": "platt", **fit_platt(probabilities, actuals)}


def apply_probability_calibrator(model: dict[str, Any], probabilities: list[float]) -> list[float]:
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


def rank_ic_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("date"))].append(row)
    correlations = []
    top_returns = []
    universe_returns = []
    for group in groups.values():
        if len(group) < 5:
            continue
        predicted = _rank_values([_model_value(row, "rankerPrediction") for row in group])
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
        selected = sorted(group, key=lambda row: _model_value(row, "rankerPrediction"), reverse=True)[:top_count]
        top_returns.append(sum(number(row.get("actualReturn")) for row in selected) / len(selected))
        universe_returns.append(sum(number(row.get("actualReturn")) for row in group) / len(group))
    return {
        "available": bool(correlations),
        "dateCount": len(correlations),
        "rankIc": round(sum(correlations) / max(1, len(correlations)), 6),
        "topDecileNetReturn": round(sum(top_returns) / max(1, len(top_returns)), 6),
        "universeNetReturn": round(sum(universe_returns) / max(1, len(universe_returns)), 6),
        "topDecileLift": round((sum(top_returns) / max(1, len(top_returns))) - (sum(universe_returns) / max(1, len(universe_returns))), 6),
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
            "date", "symbol", "market", "horizon", "actualTarget", "actualStop", "actualTimeout", "actualReturn",
            *MODEL_OUTPUT_KEYS, "ensembleProbability", "targetProbability", "stopProbability", "timeoutProbability",
            "quantileP10", "quantileP50", "quantileP90", "conformalP10", "conformalP90", "regime", "fold",
        ],
    }


def calibration_metrics(rows: list[dict[str, Any]], probabilities: list[float], *, bins: int = 10) -> dict[str, Any]:
    if not rows:
        return {"samples": 0, "brier": None, "brierSkillScore": None, "ecePct": None, "calibrationSlope": None, "reliabilityCurve": []}
    actuals = [number(row["actualTarget"]) for row in rows]
    weights = [max(0.05, number(row.get("evaluationWeight"), 1.0)) for row in rows]
    total_weight = sum(weights) or 1.0
    base_rate = sum(actuals[index] * weights[index] for index in range(len(rows))) / total_weight
    model_brier = brier(rows, probabilities=probabilities)
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
    return {
        "samples": len(rows),
        "testDates": len({row["date"] for row in rows}),
        "brier": round(model_brier, 6),
        "baselineBrier": round(baseline_brier, 6),
        "brierSkillScore": round(1.0 - model_brier / baseline_brier, 6) if baseline_brier > 1e-12 else None,
        "ecePct": round(ece * 100.0, 5),
        "calibrationSlope": round(number(slope_model["slope"]), 5),
        "calibrationIntercept": round(number(slope_model["intercept"]), 5),
        "topDecileTargetRate": round(top_target, 4),
        "topDecileNetReturn": round(top_return, 5),
        "allSampleNetReturn": round(all_return, 5),
        "topDecileLift": round(top_return - all_return, 5),
        "probabilityBucketMinCount": min((int(row["count"]) for row in curve), default=0),
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
    for fold in folds:
        predictions, metadata = _fold_oof_predictions(fold, enable_tree_models=bool(config.get("enableTreeModels", True)))
        fold_probability = [number(row["pathSafetyPrediction"]) for row in predictions]
        metric = calibration_metrics(predictions, fold_probability)
        oof.extend(predictions)
        fold_metrics.append({**metadata, "brierSkillScore": metric.get("brierSkillScore"), "ecePct": metric.get("ecePct"), "topDecileNetReturn": metric.get("topDecileNetReturn"), "positive": number(metric.get("topDecileNetReturn")) > 0})
    dates = sorted({row["date"] for row in oof})
    split_index = max(1, int(len(dates) * 0.65))
    meta_train_dates = set(dates[:split_index])
    purge_dates = set(dates[split_index:split_index + horizon + int(config.get("embargoDays", 7))])
    meta_train = [row for row in oof if row["date"] in meta_train_dates]
    meta_test = [row for row in oof if row["date"] not in meta_train_dates and row["date"] not in purge_dates]
    names = [name for name in MODEL_OUTPUT_KEYS if any(row.get(name) is not None for row in meta_train)]
    names, pruned = prune_correlated_models(meta_train, names, float(config.get("maxResidualCorrelation", PRODUCTION_THRESHOLDS["maxResidualCorrelation"])))
    if len(names) < 3 or len(meta_train) < 30 or len(meta_test) < 20:
        return {"available": False, "horizon": horizon, "reason": "OOF rows exist, but the untouched meta split is too small for constrained stacking.", "rowCount": len(rows), "folds": fold_metrics}
    weights = fit_constrained_stack(meta_train, names, cap=float(config.get("maxModelWeight", PRODUCTION_THRESHOLDS["maxModelWeight"])))
    raw_train = ensemble_probabilities(meta_train, names, weights)
    raw_test = ensemble_probabilities(meta_test, names, weights)
    train_actuals = [number(row["actualTarget"]) for row in meta_train]
    calibrator = fit_probability_calibrator(raw_train, train_actuals)
    calibrated_test = apply_probability_calibrator(calibrator, raw_test)
    conformal_quantiles = conformalize_quantiles(meta_train, meta_test)
    for index, row in enumerate(meta_test):
        row["ensembleProbability"] = calibrated_test[index]
    metrics = calibration_metrics(meta_test, calibrated_test)
    ranking = rank_ic_summary(meta_test)
    regime_diagnostics = {}
    for regime in sorted({str(row.get("regime") or "unknown") for row in meta_test}):
        indexes = [index for index, row in enumerate(meta_test) if str(row.get("regime") or "unknown") == regime]
        regime_diagnostics[regime] = calibration_metrics(
            [meta_test[index] for index in indexes],
            [calibrated_test[index] for index in indexes],
            bins=5,
        )
    expected_value = expected_value_summary(meta_test, calibrated_test)
    marginal = []
    full_brier = brier(meta_test, probabilities=calibrated_test)
    for index, name in enumerate(names):
        reduced_names = [value for value in names if value != name]
        reduced_weights = [weights[position] for position, value in enumerate(names) if value != name]
        reduced_weights = project_capped_simplex(reduced_weights, max(0.5, float(config.get("maxModelWeight", 0.35))))
        reduced_train_raw = ensemble_probabilities(meta_train, reduced_names, reduced_weights)
        reduced_raw = ensemble_probabilities(meta_test, reduced_names, reduced_weights)
        reduced_calibrator = fit_probability_calibrator(reduced_train_raw, train_actuals)
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
        "ece": number(metrics.get("ecePct"), 100.0) <= float(thresholds["maxEcePct"]),
        "calibrationSlope": float(thresholds["minCalibrationSlope"]) <= number(metrics.get("calibrationSlope")) <= float(thresholds["maxCalibrationSlope"]),
        "topDecileLift": number(metrics.get("topDecileLift")) > 0,
        "rankIc": number(ranking.get("rankIc"), -1.0) > float(thresholds["minRankIc"]),
        "rankTopDecileLift": number(ranking.get("topDecileLift")) > 0,
        "probabilityBucketSupport": int(metrics.get("probabilityBucketMinCount") or 0) >= int(thresholds["minProbabilityBucketEvents"]),
        "reliabilityMonotonic": metrics.get("reliabilityMonotonic") is True,
        "conformalCoverage": not conformal_quantiles.get("available") or 70.0 <= number(conformal_quantiles.get("observedCoveragePct")) <= 95.0,
        "featureDrift": all(number(row.get("featureDrift", {}).get("maxPsi"), 1.0) <= 0.40 for row in fold_metrics),
        "marginalGain": all(number(row.get("brierGain")) >= -0.001 for row in marginal),
    }
    production_evidence = all(production_checks.values())
    research_eligible = len(rows) >= int(thresholds["researchMinRows"]) and len(meta_test) >= 20
    deployment_status = "shadow" if research_eligible else "research"
    version_basis = {
        "market": market,
        "horizon": horizon,
        "dates": [dates[0] if dates else None, dates[-1] if dates else None],
        "rows": len(rows),
        "features": [*FEATURE_NAMES, *EVENT_FEATURE_NAMES],
        "weights": [round(value, 8) for value in weights],
        "calibrator": calibrator,
    }
    model_version = f"{market.lower()}-{horizon}d-{stable_hash(version_basis, 12)}"
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
        "prunedModels": pruned,
        "residualCorrelations": [
            {"left": names[left], "right": names[right], "correlation": round(residual_correlation(meta_train, names[left], names[right]), 5)}
            for left in range(len(names)) for right in range(left + 1, len(names))
        ],
        "marginalContribution": marginal,
        "calibrator": {**calibrator, "version": f"{calibrator.get('method', 'platt')}-{stable_hash(calibrator, 10)}"},
        "metrics": metrics,
        "rankingMetrics": ranking,
        "conformalQuantiles": conformal_quantiles,
        "regimeDiagnostics": regime_diagnostics,
        "expectedValue": expected_value,
        "foldMetrics": fold_metrics,
        "positiveFoldCount": positive_folds,
        "productionChecks": production_checks,
        "oofSchema": [
            "date", "symbol", "market", "horizon", "actualTarget", "actualStop", "actualReturn",
            *MODEL_OUTPUT_KEYS, "targetProbability", "stopProbability", "timeoutProbability", "quantileP10", "quantileP50", "quantileP90",
            "regime", "dataQuality", "fold",
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
            action_adjusted_rows=0,
        )
    raw_rows = sum(int(row.get("rawRows") or 0) for row in profiles)
    weighted_coverage = sum(number(row.get("pointInTimeCoveragePct")) * int(row.get("rawRows") or 0) for row in profiles) / max(1, raw_rows)
    starts = [row.get("dateRange", {}).get("start") for row in profiles if row.get("dateRange", {}).get("start")]
    ends = [row.get("dateRange", {}).get("end") for row in profiles if row.get("dateRange", {}).get("end")]
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
        "historicalUniverseCoveragePct": min((number(row.get("historicalUniverseCoveragePct")) for row in profiles), default=0.0),
        "corporateActionCoveragePct": min((number(row.get("corporateActionCoveragePct")) for row in profiles), default=0.0),
        "sources": sorted({source for row in profiles for source in row.get("sources") or []}),
        "firstStageTarget": target,
        "coverageVsTargetPct": round(min(100.0, minimum_horizon_rows / max(1, target["rows"]) * 100.0), 4),
        "sampleMeaning": profiles[0].get("sampleMeaning") or {},
        "memoryPolicy": "Each horizon is built, trained, and released separately so 5d/15d/30d rows are not retained in memory together.",
    }


def train_market_multitask(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "ASX").upper()
    raw_horizons = payload.get("horizons") or payload.get("horizon_days") or payload.get("horizonDays") or [5, 15, 30]
    horizons = sorted({max(1, int(number(value, 15))) for value in (raw_horizons if isinstance(raw_horizons, list) else [raw_horizons])})
    items = payload.get("items") or []
    target_upside = number(payload.get("target_upside", payload.get("targetUpside")), 5.0)
    stop_loss = number(payload.get("stop_loss", payload.get("stopLoss")), 4.0)
    transaction_cost_bps = payload.get("transaction_cost_bps", payload.get("transactionCostBps"))
    config = {
        "foldCount": int(payload.get("production_fold_count", payload.get("productionFoldCount", 5)) or 5),
        "embargoDays": int(payload.get("production_embargo_days", payload.get("productionEmbargoDays", 7)) or 7),
        "minTrainDates": int(payload.get("production_min_train_dates", payload.get("productionMinTrainDates", 500)) or 500),
        "testDates": int(payload.get("production_test_dates", payload.get("productionTestDates", 120)) or 120),
        "enableTreeModels": payload.get("enable_tree_models", payload.get("enableTreeModels", True)) is not False,
        "maxModelWeight": number(payload.get("max_model_weight", payload.get("maxModelWeight")), PRODUCTION_THRESHOLDS["maxModelWeight"]),
        "maxResidualCorrelation": number(payload.get("max_residual_correlation", payload.get("maxResidualCorrelation")), PRODUCTION_THRESHOLDS["maxResidualCorrelation"]),
        "artifactDir": payload.get("artifact_dir", payload.get("artifactDir")),
        "thresholds": payload.get("productionThresholds") or {},
    }
    horizon_models = []
    dataset_profiles = []
    for horizon in horizons:
        dataset = build_market_dataset(
            items,
            market=market,
            horizons=[horizon],
            target_upside=target_upside,
            stop_loss=stop_loss,
            transaction_cost_bps=transaction_cost_bps,
        )
        dataset_profiles.append(dataset["summary"])
        horizon_models.append(train_horizon_model(dataset["rows"], market=market, horizon=horizon, config=config))
    summary = aggregate_dataset_profiles(dataset_profiles, market)
    historical_universe_ok = number(summary.get("historicalUniverseCoveragePct")) >= 95.0
    corporate_actions_ok = number(summary.get("corporateActionCoveragePct")) >= 95.0
    pit_ok = int(summary.get("pointInTimeJoinViolationCount") or 0) == 0
    available_models = [model for model in horizon_models if model.get("available")]
    event_history_ok = number(summary.get("pointInTimeCoveragePct")) >= 20.0
    universe_breadth_ok = int(summary.get("symbolCount") or 0) >= int(MARKET_DATA_TARGETS.get(market, MARKET_DATA_TARGETS["ASX"])["symbols"])
    evidence_passed = len(available_models) == len(horizons) and all(model.get("productionEvidencePassed") for model in available_models)
    production_data_ready = historical_universe_ok and corporate_actions_ok and pit_ok and event_history_ok and universe_breadth_ok
    training_as_of = datetime.now(timezone.utc).isoformat()
    schema = [*FEATURE_NAMES, *EVENT_FEATURE_NAMES]
    downgrade_reasons = []
    for model in available_models:
        metrics = model.get("metrics") or {}
        ranking = model.get("rankingMetrics") or {}
        if number(metrics.get("brierSkillScore"), -1.0) <= 0:
            downgrade_reasons.append(f"{model.get('horizon')}d Brier Skill Score <= 0")
        if number(metrics.get("ecePct"), 100.0) > PRODUCTION_THRESHOLDS["maxDegradedEcePct"]:
            downgrade_reasons.append(f"{model.get('horizon')}d ECE > 10%")
        if number(ranking.get("topDecileLift")) <= 0:
            downgrade_reasons.append(f"{model.get('horizon')}d Top-K no longer beats universe")
        if number(model.get("expectedValue", {}).get("expectedValuePct")) <= 0:
            downgrade_reasons.append(f"{model.get('horizon')}d net expected value <= 0")
        if any(number(fold.get("featureDrift", {}).get("maxPsi")) > 0.40 for fold in model.get("foldMetrics") or []):
            downgrade_reasons.append(f"{model.get('horizon')}d feature PSI > 0.40")
    candidate_status = (
        "shadow"
        if available_models and not downgrade_reasons and any(model.get("deploymentStatus") == "shadow" for model in available_models)
        else "research"
    )
    manifest = {
        "model_version": f"{market.lower()}-multitask-{stable_hash([model.get('modelVersion') for model in horizon_models], 12)}",
        "training_as_of": training_as_of,
        "data_version": stable_hash({"summary": summary, "sources": summary.get("sources")}),
        "feature_schema_hash": stable_hash(schema),
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
        "horizons": horizons,
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
            "checks": {
                "historicalUniversePointInTime": historical_universe_ok,
                "corporateActionsAdjusted": corporate_actions_ok,
                "pointInTimeJoin": pit_ok,
                "pointInTimeEventHistory": event_history_ok,
                "marketUniverseBreadth": universe_breadth_ok,
                "allHorizonEvidence": evidence_passed,
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
