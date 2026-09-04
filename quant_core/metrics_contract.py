"""Versioned, conservative evaluation contracts for market-model evidence.

The functions in this module deliberately separate mathematical metrics from
promotion policy.  They do not select a threshold, model, label, or test set.
Callers must provide the already-frozen rows and, for Brier Skill, the
training-window prevalence.  Undefined statistics return ``None`` with an
explicit reason instead of a numeric placeholder.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Any, Callable, Iterable


METRIC_CONTRACT_VERSION = "metric-contract-5d-v2"
PRIMARY_BLOCK_DAYS = 10
DEFAULT_BOOTSTRAP_REPETITIONS = 600


def _number(value: Any, fallback: float | None = None) -> float | None:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else fallback
    except (TypeError, ValueError):
        return fallback


def _date_key(row: dict[str, Any]) -> str:
    return str(row.get("signalTimestamp") or row.get("signalAt") or row.get("date") or "")


def _valid_rows(
    rows: Iterable[dict[str, Any]],
    probability_key: str,
    actual_key: str,
    eligible_key: str | None = None,
) -> list[dict[str, Any]]:
    output = []
    for row in rows:
        if eligible_key and row.get(eligible_key) is False:
            continue
        probability = _number(row.get(probability_key))
        actual = _number(row.get(actual_key))
        if probability is None or actual is None:
            continue
        output.append(row)
    return output


def _clamp_probability(value: Any) -> float:
    parsed = _number(value, 0.5)
    return max(0.001, min(0.999, float(parsed)))


def _counts(actuals: list[int], predicted: list[int]) -> dict[str, int]:
    return {
        "tp": sum(a == 1 and p == 1 for a, p in zip(actuals, predicted)),
        "tn": sum(a == 0 and p == 0 for a, p in zip(actuals, predicted)),
        "fp": sum(a == 0 and p == 1 for a, p in zip(actuals, predicted)),
        "fn": sum(a == 1 and p == 0 for a, p in zip(actuals, predicted)),
    }


def _safe_ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator > 0 else None


def _calibration_slope(actuals: list[int], probabilities: list[float]) -> tuple[float | None, float | None]:
    """Fit the calibration line logit(y) ~ intercept + slope*logit(p)."""
    if len(actuals) < 10 or len(set(actuals)) < 2:
        return None, None
    logits = [math.log(_clamp_probability(p) / (1.0 - _clamp_probability(p))) for p in probabilities]
    intercept = 0.0
    slope = 1.0
    for _ in range(40):
        g0 = g1 = 0.0
        h00 = 1e-8
        h01 = 0.0
        h11 = 1e-8
        for x, actual in zip(logits, actuals):
            linear = max(-24.0, min(24.0, intercept + slope * x))
            fitted = 1.0 / (1.0 + math.exp(-linear))
            curvature = max(1e-8, fitted * (1.0 - fitted))
            error = fitted - actual
            g0 += error
            g1 += error * x
            h00 += curvature
            h01 += curvature * x
            h11 += curvature * x * x
        determinant = h00 * h11 - h01 * h01
        if abs(determinant) < 1e-12:
            break
        step0 = (h11 * g0 - h01 * g1) / determinant
        step1 = (-h01 * g0 + h00 * g1) / determinant
        step0 = max(-2.0, min(2.0, step0))
        step1 = max(-1.0, min(1.0, step1))
        intercept -= step0
        slope = max(0.02, min(5.0, slope - step1))
        if abs(step0) < 1e-7 and abs(step1) < 1e-7:
            break
    return slope, intercept


def _ece_equal_width(probabilities: list[float], actuals: list[int], bins: int) -> tuple[float | None, list[dict[str, Any]]]:
    if not probabilities:
        return None, []
    buckets: list[list[int]] = [[] for _ in range(bins)]
    for index, probability in enumerate(probabilities):
        bucket = min(bins - 1, max(0, int(probability * bins)))
        buckets[bucket].append(index)
    curve = []
    total = len(probabilities)
    ece = 0.0
    for bucket, indexes in enumerate(buckets):
        if not indexes:
            continue
        predicted = sum(probabilities[index] for index in indexes) / len(indexes)
        observed = sum(actuals[index] for index in indexes) / len(indexes)
        ece += abs(predicted - observed) * len(indexes) / total
        curve.append({
            "bucket": f"{bucket / bins:.2f}-{(bucket + 1) / bins:.2f}",
            "count": len(indexes),
            "predictedPct": predicted * 100.0,
            "actualPct": observed * 100.0,
            "independentDateCount": len({_date_key(rows[index]) for index in indexes}) if False else None,
        })
    return ece, curve


def _ece_equal_frequency(probabilities: list[float], actuals: list[int], bins: int) -> tuple[float | None, list[dict[str, Any]]]:
    if not probabilities:
        return None, []
    order = sorted(range(len(probabilities)), key=lambda index: probabilities[index])
    bucket_count = min(bins, len(order))
    curve = []
    ece = 0.0
    for bucket in range(bucket_count):
        start = (bucket * len(order)) // bucket_count
        end = ((bucket + 1) * len(order)) // bucket_count
        indexes = order[start:end]
        if not indexes:
            continue
        predicted = sum(probabilities[index] for index in indexes) / len(indexes)
        observed = sum(actuals[index] for index in indexes) / len(indexes)
        ece += abs(predicted - observed) * len(indexes) / len(order)
        curve.append({
            "bucket": bucket,
            "count": len(indexes),
            "predictedPct": predicted * 100.0,
            "actualPct": observed * 100.0,
        })
    return ece, curve


def classification_metrics(
    rows: list[dict[str, Any]],
    probability_key: str,
    actual_key: str = "actualDirection",
    *,
    baseline_probability: float | None = None,
    baseline_rows: list[dict[str, Any]] | None = None,
    threshold: float = 0.5,
    eligible_key: str | None = None,
    bins: int = 10,
) -> dict[str, Any]:
    valid = _valid_rows(rows, probability_key, actual_key, eligible_key)
    if not valid:
        return {
            "available": False,
            "metricStatus": "NO_EVIDENCE",
            "reason": "No rows with both probability and actual label.",
            "samples": 0,
        }
    actuals = [1 if _number(row.get(actual_key), 0.0) >= 0.5 else 0 for row in valid]
    probabilities = [_clamp_probability(row.get(probability_key)) for row in valid]
    predictions = [1 if value >= threshold else 0 for value in probabilities]
    counts = _counts(actuals, predictions)
    tp, tn, fp, fn = (counts[key] for key in ("tp", "tn", "fp", "fn"))
    positive_support = tp + fn
    negative_support = tn + fp
    precision = _safe_ratio(tp, tp + fp)
    recall = _safe_ratio(tp, positive_support)
    negative_recall = _safe_ratio(tn, negative_support)
    negative_precision = _safe_ratio(tn, tn + fn)
    f1 = _safe_ratio(2 * tp, 2 * tp + fp + fn)
    negative_f1 = _safe_ratio(2 * tn, 2 * tn + fp + fn)
    accuracy = (tp + tn) / len(valid)
    balanced_accuracy = (
        (recall + negative_recall) / 2.0
        if recall is not None and negative_recall is not None
        else None
    )
    mcc_denominator = math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    mcc = (tp * tn - fp * fn) / mcc_denominator if mcc_denominator else None
    brier = sum((probability - actual) ** 2 for probability, actual in zip(probabilities, actuals)) / len(valid)

    baseline_source = "missing-training-prevalence"
    baseline = baseline_probability
    if baseline is not None:
        baseline_source = "explicit-frozen-training-prevalence"
    if baseline is None and baseline_rows:
        training_labels = [
            1 if _number(row.get(actual_key), 0.0) >= 0.5 else 0
            for row in baseline_rows
            if _number(row.get(actual_key)) is not None
        ]
        if training_labels:
            baseline = sum(training_labels) / len(training_labels)
            baseline_source = "training-window-prevalence"
    if baseline is None:
        row_baselines = [_number(row.get("baselineProbability")) for row in valid]
        if row_baselines and all(value is not None for value in row_baselines):
            baseline = sum(float(value) for value in row_baselines) / len(row_baselines)
            baseline_source = "row-level-training-prevalence"
    if baseline is None:
        # Kept for legacy report compatibility, but explicitly not strict.
        baseline = sum(actuals) / len(actuals)
        baseline_source = "evaluation-window-prevalence-legacy"
    baseline = max(0.001, min(0.999, float(baseline)))
    baseline_brier = sum((baseline - actual) ** 2 for actual in actuals) / len(actuals)
    ece_width, reliability = _ece_equal_width(probabilities, actuals, bins)
    ece_frequency, frequency_curve = _ece_equal_frequency(probabilities, actuals, bins)
    slope, intercept = _calibration_slope(actuals, probabilities)
    dates = len({_date_key(row) for row in valid if _date_key(row)})
    bucket_support = [int(row["count"]) for row in reliability]
    occupied_30 = sum(count >= 30 for count in bucket_support)
    probability_std = math.sqrt(sum((value - sum(probabilities) / len(probabilities)) ** 2 for value in probabilities) / len(probabilities))
    return {
        "available": True,
        "metricStatus": "OK" if balanced_accuracy is not None else "PARTIAL_SINGLE_CLASS",
        "samples": len(valid),
        "independentDates": dates,
        "positiveSupport": positive_support,
        "negativeSupport": negative_support,
        "threshold": threshold,
        "accuracyPct": accuracy * 100.0,
        "balancedAccuracyPct": None if balanced_accuracy is None else balanced_accuracy * 100.0,
        "precisionPct": None if precision is None else precision * 100.0,
        "recallPct": None if recall is None else recall * 100.0,
        "f1Pct": None if f1 is None else f1 * 100.0,
        "macroF1Pct": None if f1 is None or negative_f1 is None else (f1 + negative_f1) / 2.0 * 100.0,
        "mcc": mcc,
        "brier": brier,
        "baselineBrier": baseline_brier,
        "baselineProbability": baseline,
        "baselineSource": baseline_source,
        "brierSkillScore": 1.0 - brier / baseline_brier if baseline_brier > 1e-12 else None,
        "eceEqualWidthPct": None if ece_width is None else ece_width * 100.0,
        "eceEqualFrequencyPct": None if ece_frequency is None else ece_frequency * 100.0,
        "ecePct": None if ece_width is None else ece_width * 100.0,
        "calibrationSlope": slope,
        "calibrationIntercept": intercept,
        "probabilityStd": probability_std,
        "occupiedProbabilityBuckets": len(reliability),
        "probabilityBucketsWithAtLeast30Events": occupied_30,
        "confusionMatrix": counts,
        "reliabilityCurve": reliability,
        "equalFrequencyCurve": frequency_curve,
        "undefinedMetrics": [
            name for name, value in {
                "balancedAccuracyPct": balanced_accuracy,
                "mcc": mcc,
                "calibrationSlope": slope,
            }.items() if value is None
        ],
    }


def _spearman(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    def ranks(values: list[float]) -> list[float]:
        order = sorted(range(len(values)), key=lambda index: values[index])
        output = [0.0] * len(values)
        index = 0
        while index < len(order):
            end = index + 1
            while end < len(order) and values[order[end]] == values[order[index]]:
                end += 1
            rank = (index + end - 1) / 2.0 + 1.0
            for position in order[index:end]:
                output[position] = rank
            index = end
        return output
    return _pearson(ranks(left), ranks(right))


def _pearson(left: list[float], right: list[float]) -> float | None:
    if len(left) < 2 or len(left) != len(right):
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    denominator = math.sqrt(
        sum((a - left_mean) ** 2 for a in left) * sum((b - right_mean) ** 2 for b in right)
    )
    return numerator / denominator if denominator > 1e-12 else None


def _ndcg(relevances: list[float], k: int) -> float | None:
    if not relevances:
        return None
    def dcg(values: list[float]) -> float:
        return sum((2.0 ** value - 1.0) / math.log2(index + 2.0) for index, value in enumerate(values[:k]))
    ideal = dcg(sorted(relevances, reverse=True))
    return dcg(relevances) / ideal if ideal > 1e-12 else None


def ranking_metrics(
    rows: list[dict[str, Any]],
    score_key: str = "rankerPrediction",
    actual_key: str = "actualReturn",
    *,
    min_symbols_per_date: int = 30,
    top_fraction: float = 0.10,
    ndcg_k: int = 10,
) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        score = _number(row.get(score_key))
        actual = _number(row.get(actual_key))
        if score is None or actual is None or row.get("eligibleMask") is False:
            continue
        groups[_date_key(row)].append(row)
    rank_values: list[float] = []
    ndcg_values: list[float] = []
    top_direction_values: list[float] = []
    top_profit_values: list[float] = []
    top_net_returns: list[float] = []
    universe_net_returns: list[float] = []
    excluded_small_dates = 0
    excluded_no_relevance_dates = 0
    date_details = []
    for day, group in sorted(groups.items()):
        if len(group) < min_symbols_per_date:
            excluded_small_dates += 1
            continue
        ordered = sorted(group, key=lambda row: float(_number(row.get(score_key), 0.0)), reverse=True)
        actuals = [float(_number(row.get(actual_key), 0.0)) for row in group]
        scores = [float(_number(row.get(score_key), 0.0)) for row in group]
        correlation = _spearman(scores, actuals)
        if correlation is not None:
            rank_values.append(correlation)
        top_count = max(1, math.ceil(len(group) * top_fraction))
        selected = ordered[:top_count]
        top_returns = [float(_number(row.get(actual_key), 0.0)) for row in selected]
        universe_returns = [float(_number(row.get(actual_key), 0.0)) for row in group]
        top_net_returns.append(sum(top_returns) / len(top_returns))
        universe_net_returns.append(sum(universe_returns) / len(universe_returns))
        top_direction_values.append(sum(value > 0 for value in top_returns) / len(top_returns))
        top_profit_values.append(sum(float(_number(row.get("actualReturn"), 0.0)) > 0 for row in selected) / len(selected))
        # Relevance is a frozen label derived from cost-adjusted return; it is
        # never substituted with target-first path outcomes.
        median_return = sorted(universe_returns)[len(universe_returns) // 2]
        relevance = [
            3.0 if value > 0 and value >= median_return else 2.0 if value > 0 else 0.0
            for value in universe_returns
        ]
        selected_relevance = [
            3.0 if float(_number(row.get(actual_key), 0.0)) > 0 and float(_number(row.get(actual_key), 0.0)) >= median_return else 2.0 if float(_number(row.get(actual_key), 0.0)) > 0 else 0.0
            for row in selected
        ]
        value = _ndcg(selected_relevance, ndcg_k)
        ideal = _ndcg(sorted(relevance, reverse=True), ndcg_k)
        # _ndcg(ideal) is exactly one when relevance is non-zero.
        if value is None or ideal is None:
            excluded_no_relevance_dates += 1
        else:
            ndcg_values.append(value)
        date_details.append({"date": day, "symbols": len(group), "selected": len(selected), "rankIc": correlation})
    if not groups:
        return {"available": False, "metricStatus": "NO_EVIDENCE", "reason": "No valid ranked rows.", "dateCount": 0}
    return {
        "available": bool(rank_values or ndcg_values),
        "metricStatus": "OK" if rank_values or ndcg_values else "INSUFFICIENT_DATE_BREADTH",
        "dateCount": len(rank_values),
        "eligibleDateCount": len(date_details),
        "excludedSmallDates": excluded_small_dates,
        "excludedNoRelevanceDates": excluded_no_relevance_dates,
        "minSymbolsPerDate": min_symbols_per_date,
        "rankIc": sum(rank_values) / len(rank_values) if rank_values else None,
        "rankIcIndependentDates": len(rank_values),
        "ndcgAt10": sum(ndcg_values) / len(ndcg_values) if ndcg_values else None,
        "ndcgK": ndcg_k,
        "ndcgIndependentDates": len(ndcg_values),
        "top10DirectionHitRatePct": sum(top_direction_values) / len(top_direction_values) * 100.0 if top_direction_values else None,
        "top10ProfitHitRatePct": sum(top_profit_values) / len(top_profit_values) * 100.0 if top_profit_values else None,
        "top10NetReturnPct": sum(top_net_returns) / len(top_net_returns) if top_net_returns else None,
        "universeNetReturnPct": sum(universe_net_returns) / len(universe_net_returns) if universe_net_returns else None,
        "top10NetReturnLiftPct": (
            sum(top_net_returns) / len(top_net_returns) - sum(universe_net_returns) / len(universe_net_returns)
            if top_net_returns and universe_net_returns else None
        ),
        "dateDetails": date_details,
        "definitions": {
            "top10Direction": "daily complete eligible cross-section top ceil(10%) by rank score; net return > 0",
            "top10Profit": "same selected set; cost-adjusted actual return > 0",
            "ndcg": f"date-equal-weighted NDCG@{ndcg_k}; relevance is frozen from cost-adjusted return",
        },
    }


def max_drawdown(daily_returns: Iterable[float], initial_equity: float = 1.0) -> dict[str, Any]:
    equity = float(initial_equity)
    peak = equity
    drawdown = 0.0
    trough = equity
    for value in daily_returns:
        parsed = _number(value)
        if parsed is None:
            continue
        equity *= 1.0 + parsed / 100.0
        if equity > peak:
            peak = equity
        current = (peak - equity) / peak if peak > 0 else None
        if current is not None and current > drawdown:
            drawdown = current
            trough = equity
    return {
        "available": equity != initial_equity or peak != initial_equity,
        "maxDrawdownPct": drawdown * 100.0,
        "endingEquity": equity,
        "peakEquity": peak,
        "troughEquity": trough,
    }


def turnover_and_cost(
    previous_weights: dict[str, float],
    current_weights: dict[str, float],
    *,
    commission_bps: float = 0.0,
    impact_bps: float = 0.0,
) -> dict[str, Any]:
    symbols = set(previous_weights) | set(current_weights)
    one_way = sum(abs(float(current_weights.get(symbol, 0.0)) - float(previous_weights.get(symbol, 0.0))) for symbol in symbols)
    two_way = one_way / 2.0
    cost_bps = commission_bps + impact_bps
    return {
        "available": True,
        "oneWayTurnoverPct": one_way * 100.0,
        "twoWayTurnoverPct": two_way * 100.0,
        "commissionBps": commission_bps,
        "impactBps": impact_bps,
        "estimatedCostPct": one_way * cost_bps / 100.0,
        "formula": "sum(abs(current_weight-previous_weight)) * (commission_bps+impact_bps) / 100",
    }


def paired_comparison(
    candidate_rows: list[dict[str, Any]],
    baseline_rows: list[dict[str, Any]],
    *,
    value_key: str = "actualReturn",
    identity_keys: tuple[str, ...] = ("market", "symbol", "date", "horizon", "labelDefinition", "transactionCostBps"),
    min_common_coverage: float = 0.90,
) -> dict[str, Any]:
    def identity(row: dict[str, Any]) -> tuple[str, ...]:
        return tuple(str(row.get(key) or "") for key in identity_keys)
    candidate = {identity(row): row for row in candidate_rows if _number(row.get(value_key)) is not None}
    baseline = {identity(row): row for row in baseline_rows if _number(row.get(value_key)) is not None}
    common = sorted(set(candidate) & set(baseline))
    denominator = max(len(candidate), len(baseline), 1)
    coverage = len(common) / denominator
    if coverage < min_common_coverage:
        return {
            "available": False,
            "status": "INCOMPARABLE",
            "commonRows": len(common),
            "candidateRows": len(candidate),
            "baselineRows": len(baseline),
            "commonCoveragePct": coverage * 100.0,
            "reason": "Common date-symbol-cost-label panel is below the frozen coverage threshold.",
        }
    differences = [float(_number(candidate[key][value_key], 0.0)) - float(_number(baseline[key][value_key], 0.0)) for key in common]
    dates = len({key[2] for key in common})
    return {
        "available": True,
        "status": "COMPARABLE",
        "commonRows": len(common),
        "candidateRows": len(candidate),
        "baselineRows": len(baseline),
        "commonCoveragePct": coverage * 100.0,
        "differenceMean": sum(differences) / len(differences) if differences else None,
        "differenceCount": len(differences),
        "independentDates": dates,
        "identityKeys": list(identity_keys),
    }


def paired_block_bootstrap(
    differences: list[tuple[str, float]],
    *,
    block_lengths: tuple[int, ...] = (5, 10, 20),
    repetitions: int = DEFAULT_BOOTSTRAP_REPETITIONS,
    seed: int = 20260829,
) -> dict[str, Any]:
    groups: dict[str, list[float]] = defaultdict(list)
    for day, value in differences:
        parsed = _number(value)
        if parsed is not None and day:
            groups[str(day)].append(parsed)
    dates = sorted(groups)
    if len(dates) < 5:
        return {
            "available": False,
            "status": "INSUFFICIENT_DATE_BLOCKS",
            "independentDates": len(dates),
            "reason": "At least five ordered independent dates are required.",
        }
    observed_values = [sum(groups[day]) / len(groups[day]) for day in dates]
    observed = sum(observed_values) / len(observed_values)
    rng = random.Random(seed)
    blocks: dict[str, dict[str, Any]] = {}
    for requested in block_lengths:
        block = min(max(1, requested), len(dates))
        samples = []
        for _ in range(max(600, repetitions)):
            values = []
            for _ in range(math.ceil(len(dates) / block)):
                start = rng.randrange(0, len(dates))
                for offset in range(block):
                    values.append(observed_values[(start + offset) % len(dates)])
                    if len(values) >= len(dates):
                        break
                if len(values) >= len(dates):
                    break
            samples.append(sum(values) / len(values))
        samples.sort()
        low = samples[max(0, int(len(samples) * 0.025) - 1)]
        high = samples[min(len(samples) - 1, int(len(samples) * 0.975))]
        blocks[str(requested)] = {
            "requestedBlockDays": requested,
            "effectiveBlockDays": block,
            "mean": observed,
            "low": min(observed, low),
            "high": max(observed, high),
            "repetitions": len(samples),
            "independentDates": len(dates),
        }
    return {
        "available": True,
        "status": "OK",
        "method": "moving-date-block-bootstrap",
        "primaryBlockDays": PRIMARY_BLOCK_DAYS,
        "independentDates": len(dates),
        "observedMean": observed,
        "blocks": blocks,
        "seed": seed,
    }


def positive_fold_contract(
    *,
    balanced_accuracy_pct: float | None,
    brier_skill_score: float | None,
    top10_net_lift_pct: float | None,
) -> dict[str, Any]:
    checks = {
        "balancedAccuracyAbove50": balanced_accuracy_pct is not None and balanced_accuracy_pct > 50.0,
        "brierSkillPositive": brier_skill_score is not None and brier_skill_score > 0.0,
        "top10NetLiftPositive": top10_net_lift_pct is not None and top10_net_lift_pct > 0.0,
    }
    return {
        "positive": all(checks.values()),
        "status": "POSITIVE" if all(checks.values()) else "NOT_POSITIVE",
        "checks": checks,
        "undefined": [name for name, value in {
            "balancedAccuracyPct": balanced_accuracy_pct,
            "brierSkillScore": brier_skill_score,
            "top10NetLiftPct": top10_net_lift_pct,
        }.items() if value is None],
        "contract": "BA>50 and BSS>0 and Top10 cost-adjusted lift>0; null never counts as positive.",
    }


def metric_contract_manifest() -> dict[str, Any]:
    return {
        "schema": METRIC_CONTRACT_VERSION,
        "horizonTradingDays": 5,
        "signalTime": "completed-session-close",
        "entry": "next-session-open-or-vwap",
        "return": "cost-adjusted-net-return",
        "evaluationUnit": "date-symbol row; date-equal-weighted aggregation for ranking",
        "thresholds": {"raw": 0.5, "selected": "earlier OOF only", "abstention": "excluded and reported as coverage"},
        "metrics": {
            "accuracy": "(TP+TN)/(TP+TN+FP+FN), fixed threshold 0.5 for raw contract",
            "balancedAccuracy": "(TPR+TNR)/2; null when either class support is zero",
            "mcc": "complete confusion matrix formula; null when denominator is zero",
            "brier": "mean((probability-actual)^2) on evaluation rows",
            "brierSkillScore": "1-model_brier/baseline_brier; baseline prevalence comes from training window only",
            "ece": "equal-width and equal-frequency 10-bin calibration error; counts and dates are exposed",
            "calibrationSlope": "independent calibration-window logistic slope of actual on logit(prediction)",
            "top10": "daily complete eligible cross-section, ceil(10%) selected, net return > 0",
            "ndcgAt10": "date-equal-weighted NDCG@10 using frozen cost-adjusted-return relevance",
            "rankIc": "date-wise Spearman, dates with fewer than 30 eligible symbols excluded and counted",
            "drawdown": "peak-to-trough drawdown of chronological portfolio equity",
            "turnover": "sum(abs(current_weight-previous_weight)); costs are explicit",
        },
        "confidenceIntervals": {
            "method": "paired moving date-block bootstrap",
            "blocks": [5, 10, 20],
            "primaryBlockDays": 10,
            "minimumRepetitions": 600,
        },
        "promotion": {
            "positiveFold": "BA>50 and BSS>0 and Top10 cost-adjusted lift>0; null is not positive",
            "ordinaryAccuracyIsNotSufficient": True,
            "incomparablePanelProducesNoDelta": True,
        },
        "undefinedMetricPolicy": {
            "noRows": "null",
            "singleClassBalancedAccuracy": "null",
            "zeroMccDenominator": "null",
            "noValidRankDates": "null",
            "incomparablePairedPanel": "no delta",
            "neverUseZeroAsMissing": True,
        },
    }


__all__ = [
    "DEFAULT_BOOTSTRAP_REPETITIONS",
    "METRIC_CONTRACT_VERSION",
    "classification_metrics",
    "max_drawdown",
    "metric_contract_manifest",
    "paired_block_bootstrap",
    "paired_comparison",
    "positive_fold_contract",
    "ranking_metrics",
    "turnover_and_cost",
]
