from __future__ import annotations

import importlib.util
import math
import os
from typing import Any

# Keep enough resolved history for meaningful market/horizon diagnostics. These are
# memory guards, not training targets; the production trainer persists its full OOF
# table separately and applies stricter market-level gates.
MAX_ENSEMBLE_ROWS = 20_000
MAX_SUPERVISED_ROWS = 50_000
MODEL_ZOO_MIN_ROWS = 48
HORIZON_SCOPE_MIN_ROWS = 32
PRODUCTION_MIN_ROWS = 500
PRODUCTION_MIN_TEST_ROWS = 150
PRODUCTION_MIN_TARGET_EVENTS = 50
PRODUCTION_MIN_STOP_EVENTS = 50
PRODUCTION_MIN_FOLDS = 5
PRODUCTION_MIN_POSITIVE_FOLDS = 4
TRIPLE_BARRIER_CLASSES = {"stop": 0, "timeout": 1, "target": 2}
DEFAULT_EMBARGO_FRACTION = 0.025
FEATURE_CATALOG = {
    "trend": {"family": "technical", "label": "趋势强度", "why": "趋势延续是中短期收益的重要基线，但必须用样本外表现约束。"},
    "momentum": {"family": "technical", "label": "动量", "why": "MACD、RSI 和短期涨跌共同反映资金追随强度。"},
    "change5d": {"family": "technical", "label": "5日涨跌", "why": "捕捉短线动量或短线过热后的回撤风险。"},
    "change20d": {"family": "technical", "label": "20日涨跌", "why": "用于区分中期趋势和短期噪声。"},
    "volumeRatio": {"family": "volume", "label": "量比", "why": "成交量放大决定信号可信度，低量上涨容易失真。"},
    "volume": {"family": "volume", "label": "量能评分", "why": "衡量流动性和成交活跃度，低流动性会放大滑点。"},
    "buyPressure": {"family": "orderflow", "label": "当日买卖压力", "why": "真实买卖量可反映主动成交；缺失时只作为OHLCV代理。"},
    "buyPressure5": {"family": "orderflow", "label": "5日买卖压力", "why": "连续主动买入比单日异动更可靠。"},
    "pressureChange": {"family": "orderflow", "label": "买压变化", "why": "买压边际增强/衰减常领先短期价格变化。"},
    "profileDistance": {"family": "volume_profile", "label": "价格偏离VWAP/POC", "why": "价格远离成交密集区时可能存在回归或突破两类状态。"},
    "volumeAccel": {"family": "volume_profile", "label": "成交加速度", "why": "量能突然增加会改变趋势延续和反转概率。"},
    "liquidityShock": {"family": "risk", "label": "流动性冲击", "why": "大波动叠加异常放量常意味着风险或事件冲击。"},
    "factor": {"family": "factor", "label": "综合因子分", "why": "汇总基本面、新闻、社媒、宏观、相对强弱等多源证据。"},
    "socialScore": {"family": "factor", "label": "社媒分", "why": "高影响社媒信息可能提前反映关注度和情绪，但需防操纵。"},
    "macroScore": {"family": "factor", "label": "宏观分", "why": "利率、汇率、战争和政策会影响市场风险偏好。"},
    "sectorScore": {"family": "factor", "label": "行业分", "why": "上下游和竞品事件常通过行业链条传导。"},
    "flowScore": {"family": "factor", "label": "资金流/期权分", "why": "资金流和衍生品隐含风险可辅助判断拥挤度。"},
    "liquidityScore": {"family": "factor", "label": "流动性因子", "why": "影响可交易性、滑点和信号执行质量。"},
    "relativeStrengthScore": {"family": "factor", "label": "相对强弱", "why": "横截面强弱可辅助选股排序。"},
    "calibrationScore": {"family": "factor", "label": "回测校准分", "why": "同类历史预测是否有效决定当前信号可信度。"},
    "announcementScore": {"family": "factor", "label": "公告/财报分", "why": "公告和财报是基本面再定价的直接来源。"},
}


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def mean(values: list[float]) -> float:
    rows = [value for value in values if math.isfinite(value)]
    return sum(rows) / len(rows) if rows else 0.0


def percentile(values: list[float], q: float) -> float:
    rows = sorted(value for value in values if math.isfinite(value))
    if not rows:
        return 0.0
    index = min(len(rows) - 1, max(0, int(round((len(rows) - 1) * clamp(q, 0.0, 1.0)))))
    return rows[index]


def pearson(left: list[float], right: list[float]) -> float:
    pairs = [(a, b) for a, b in zip(left, right) if math.isfinite(a) and math.isfinite(b)]
    if len(pairs) < 3:
        return 0.0
    left_mean = mean([row[0] for row in pairs])
    right_mean = mean([row[1] for row in pairs])
    covariance = mean([(a - left_mean) * (b - right_mean) for a, b in pairs])
    left_var = mean([(a - left_mean) ** 2 for a, _ in pairs])
    right_var = mean([(b - right_mean) ** 2 for _, b in pairs])
    if left_var <= 1e-12 or right_var <= 1e-12:
        return 0.0
    return clamp(covariance / math.sqrt(left_var * right_var), -1.0, 1.0)


def tail_rows(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or len(rows) <= limit:
        return rows
    return rows[-limit:]


def horizon_bucket_for_days(value: Any) -> str:
    """Keep short-, mid-, and long-horizon labels from contaminating each other."""
    days = max(1, int(number(value, 15)))
    if days <= 7:
        return "short"
    if days <= 25:
        return "mid"
    return "long"


def horizon_bucket_for_sample(sample: dict[str, Any]) -> str:
    return horizon_bucket_for_days(
        sample.get("horizonDays", sample.get("horizon_days", (sample.get("strategy") or {}).get("horizonDays", 15)))
    )


def horizon_samples_by_bucket(samples: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    buckets = {"short": [], "mid": [], "long": []}
    for sample in samples or []:
        if not isinstance(sample, dict):
            continue
        buckets[horizon_bucket_for_sample(sample)].append(sample)
    return buckets


def sample_model_weight(model: dict[str, Any]) -> float:
    normalized = number(model.get("normalizedWeight"), math.nan)
    if math.isfinite(normalized) and normalized > 0:
        return normalized
    raw = number(model.get("weight"), 0.0)
    return raw if raw > 0 else 0.0


def ensemble_weight_learning_rows(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sample in samples or []:
        outcome = sample.get("outcome") or {}
        ensemble = sample.get("ensemble") or {}
        models = ensemble.get("models") or []
        if not outcome.get("resolved") or not isinstance(models, list):
            continue
        model_values: dict[str, float] = {}
        prior_weights: dict[str, float] = {}
        for model in models:
            if not isinstance(model, dict) or model.get("available") is False or not model.get("name"):
                continue
            projected = number(model.get("projectedUpside"), math.nan)
            if not math.isfinite(projected):
                continue
            name = str(model["name"])
            model_values[name] = clamp(projected, -18.0, 18.0)
            prior_weights[name] = sample_model_weight(model)
        if len(model_values) < 2:
            continue
        actual_return = clamp(number(outcome.get("forwardReturnPct"), 0.0), -24.0, 24.0)
        stored_prediction = clamp(
            number(
                ensemble.get("projectedUpside", sample.get("projectedFinalReturn", sample.get("projectedUpside", 0.0))),
                0.0,
            ),
            -18.0,
            18.0,
        )
        rows.append(
            {
                "date": str(sample.get("signalAt") or sample.get("asOfDate") or sample.get("createdAt") or "")[:10],
                "resolvedDate": str(outcome.get("resolvedAt") or sample.get("resolvedAt") or "")[:10],
                "symbol": sample.get("symbol") or "",
                "actual_return": actual_return,
                "target_wins": bool(outcome.get("targetWins")),
                "stop_wins": bool(outcome.get("stopWins")),
                "stored_prediction": stored_prediction,
                "model_values": model_values,
                "prior_weights": prior_weights,
            }
        )
    return tail_rows(sorted(rows, key=lambda row: row["date"]), MAX_ENSEMBLE_ROWS)


def model_names_for_weight_learning(rows: list[dict[str, Any]]) -> list[str]:
    stats: dict[str, dict[str, float]] = {}
    for row in rows:
        for name, value in row["model_values"].items():
            stat = stats.setdefault(name, {"count": 0.0, "abs_signal": 0.0})
            stat["count"] += 1
            stat["abs_signal"] += abs(number(value))
    min_count = max(6, math.ceil(len(rows) * 0.28))
    names = [
        name
        for name, stat in stats.items()
        if stat["count"] >= min_count and stat["abs_signal"] / max(1.0, stat["count"]) >= 0.08
    ]
    return sorted(names, key=lambda name: (-stats[name]["count"], -stats[name]["abs_signal"]))[:14]


def normalize_weights(values: list[float]) -> list[float]:
    cleaned = [max(0.0, number(value)) for value in values]
    total = sum(cleaned)
    if total > 0:
        return [value / total for value in cleaned]
    return [1.0 / len(cleaned) for _ in cleaned] if cleaned else []


def average_prior_vector(rows: list[dict[str, Any]], names: list[str]) -> list[float]:
    sums = [0.0 for _ in names]
    contributing = 0
    for row in rows:
        raw = [max(0.0, number(row["prior_weights"].get(name))) for name in names]
        total = sum(raw)
        if total <= 0:
            continue
        for index, value in enumerate(raw):
            sums[index] += value / total
        contributing += 1
    if not contributing:
        return [1.0 / len(names) for _ in names] if names else []
    return normalize_weights([value / contributing for value in sums])


def project_to_simplex(values: list[float]) -> list[float]:
    if not values:
        return []
    sorted_values = sorted(values, reverse=True)
    cumulative = 0.0
    rho = 0
    for index, value in enumerate(sorted_values, start=1):
        cumulative += value
        theta = (cumulative - 1.0) / index
        if value - theta > 0:
            rho = index
    theta = (sum(sorted_values[:rho]) - 1.0) / max(1, rho)
    return [max(0.0, value - theta) for value in values]


def prediction_for_weight_vector(row: dict[str, Any], names: list[str], weights: list[float]) -> float:
    return sum(number(weights[index]) * number(row["model_values"].get(name)) for index, name in enumerate(names))


def evaluate_stored_ensemble_forecast(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"samples": 0, "mse": None, "mae": None, "directionHitRate": None, "targetHitRate": None}
    errors = [number(row["stored_prediction"]) - number(row["actual_return"]) for row in rows]
    direction_hits = sum(
        1
        for row in rows
        if (number(row["stored_prediction"]) >= 0 and number(row["actual_return"]) >= 0)
        or (number(row["stored_prediction"]) < 0 and number(row["actual_return"]) < 0)
    )
    target_rows = [row for row in rows if number(row["stored_prediction"]) > 0]
    return {
        "samples": len(rows),
        "mse": mean([error * error for error in errors]),
        "mae": mean([abs(error) for error in errors]),
        "directionHitRate": direction_hits / len(rows) * 100,
        "targetHitRate": (sum(1 for row in target_rows if row["target_wins"]) / len(target_rows) * 100) if target_rows else None,
    }


def evaluate_weight_vector(rows: list[dict[str, Any]], names: list[str], weights: list[float]) -> dict[str, Any]:
    if not rows or not names or not weights:
        return {"samples": 0, "mse": None, "mae": None, "directionHitRate": None, "targetHitRate": None}
    predictions = [prediction_for_weight_vector(row, names, weights) for row in rows]
    errors = [predictions[index] - number(row["actual_return"]) for index, row in enumerate(rows)]
    direction_hits = sum(
        1
        for index, row in enumerate(rows)
        if (predictions[index] >= 0 and number(row["actual_return"]) >= 0)
        or (predictions[index] < 0 and number(row["actual_return"]) < 0)
    )
    target_indexes = [index for index, predicted in enumerate(predictions) if predicted > 0]
    return {
        "samples": len(rows),
        "mse": mean([error * error for error in errors]),
        "mae": mean([abs(error) for error in errors]),
        "directionHitRate": direction_hits / len(rows) * 100,
        "targetHitRate": (
            sum(1 for index in target_indexes if rows[index]["target_wins"]) / len(target_indexes) * 100
            if target_indexes
            else None
        ),
        "avgPrediction": mean(predictions),
    }


def fit_simplex_ridge_weights(rows: list[dict[str, Any]], names: list[str], prior: list[float], penalty: float = 0.06) -> list[float]:
    if not rows or not names:
        return normalize_weights(prior)
    weights = normalize_weights(prior)
    all_signals = [abs(number(row["model_values"].get(name))) for row in rows for name in names]
    avg_signal = mean(all_signals)
    step = 0.018 / (1 + avg_signal * avg_signal * 0.16)
    ridge = max(0.001, number(penalty, 0.06))
    for _ in range(240):
        gradient = [2 * ridge * (weights[index] - (prior[index] if index < len(prior) else 0.0)) for index in range(len(names))]
        for row in rows:
            predicted = prediction_for_weight_vector(row, names, weights)
            error = predicted - number(row["actual_return"])
            for index, name in enumerate(names):
                gradient[index] += (2 / len(rows)) * error * number(row["model_values"].get(name))
        weights = project_to_simplex([weight - step * gradient[index] for index, weight in enumerate(weights)])
    return normalize_weights(weights)


def improvement_pct(candidate_mse: Any, baseline_mse: Any) -> float | None:
    candidate = number(candidate_mse, math.nan)
    baseline = number(baseline_mse, math.nan)
    if not math.isfinite(candidate) or not math.isfinite(baseline) or baseline <= 0:
        return None
    return (baseline - candidate) / baseline * 100


def round_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    rounded: dict[str, Any] = {}
    for key, value in metrics.items():
        if isinstance(value, float) and math.isfinite(value):
            rounded[key] = round(value, 5)
        else:
            rounded[key] = value
    return rounded


def triple_barrier_label(outcome: dict[str, Any], actual_return: float) -> str:
    if outcome.get("targetWins"):
        return "target"
    if outcome.get("stopWins"):
        return "stop"
    if actual_return > 0.15:
        return "timeout_positive"
    if actual_return < -0.15:
        return "timeout_negative"
    return "timeout_flat"


def triple_barrier_class(label: str) -> int:
    if label == "target":
        return TRIPLE_BARRIER_CLASSES["target"]
    if label == "stop":
        return TRIPLE_BARRIER_CLASSES["stop"]
    return TRIPLE_BARRIER_CLASSES["timeout"]


def supervised_rows(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sample in samples or []:
        outcome = sample.get("outcome") or {}
        if not outcome.get("resolved"):
            continue
        feature = sample.get("featureScores") or {}
        signals = sample.get("signalCounts") or {}
        ensemble = sample.get("ensemble") or {}
        actual_return = clamp(number(outcome.get("forwardReturnPct"), 0.0), -24.0, 24.0)
        barrier_label = triple_barrier_label(outcome, actual_return)
        max_upside = max(0.0, number(outcome.get("maxUpsidePct", outcome.get("maxUpside")), max(0.0, actual_return)))
        max_drawdown = min(0.0, number(outcome.get("maxDrawdownPct", outcome.get("maxDrawdown")), min(0.0, actual_return)))
        target_upside = max(0.25, number(sample.get("targetUpside"), 5.0))
        stop_loss = max(0.25, abs(number(sample.get("stopLoss"), 4.0)))
        features = {
            "trend": number(feature.get("trend"), 50.0),
            "momentum": number(feature.get("momentum"), 50.0),
            "change5d": number(feature.get("change5d"), 0.0),
            "change20d": number(feature.get("change20d"), 0.0),
            "volumeRatio": number(feature.get("volumeRatio"), 1.0),
            "rsi": number(feature.get("rsi"), 50.0),
            "volume": number(feature.get("volume"), 50.0),
            "risk": number(feature.get("risk"), 50.0),
            "factor": number(feature.get("factor"), 0.0),
            "gap": number(feature.get("gap"), 0.0),
            "buyPressure": number(feature.get("buyPressure"), 0.0),
            "buyPressure5": number(feature.get("buyPressure5"), 0.0),
            "pressureChange": number(feature.get("pressureChange"), 0.0),
            "volumeAccel": number(feature.get("volumeAccel"), 0.0),
            "profileDistance": number(feature.get("profileDistance"), 0.0),
            "liquidityShock": number(feature.get("liquidityShock"), 0.0),
            "socialScore": number(feature.get("socialScore"), 0.0),
            "macroScore": number(feature.get("macroScore"), 0.0),
            "sectorScore": number(feature.get("sectorScore"), 0.0),
            "flowScore": number(feature.get("flowScore"), 0.0),
            "liquidityScore": number(feature.get("liquidityScore"), 0.0),
            "relativeStrengthScore": number(feature.get("relativeStrengthScore"), 0.0),
            "calibrationScore": number(feature.get("calibrationScore"), 0.0),
            "announcementScore": number(feature.get("announcementScore"), 0.0),
            "analogConfidence": number(feature.get("analogConfidence"), 0.0),
            "modelConfidence": number(feature.get("modelConfidence"), 0.0),
            "newsCount": number(signals.get("news"), 0.0),
            "xCount": number(signals.get("x"), 0.0),
            "youtubeCount": number(signals.get("youtube"), 0.0),
            "factorCount": number(signals.get("factors"), 0.0),
            "upsideAgreement": number(ensemble.get("upsideAgreement"), 50.0),
            "consensusAgreement": number(ensemble.get("consensusAgreement"), 50.0),
            "predictionConfidence": number(sample.get("predictionConfidence", sample.get("confidence")), 0.0),
            "strategyHitProbability": number(sample.get("strategyHitProbability", sample.get("strategyConfidence")), 0.0),
            "magnitudeHitProbability": number(sample.get("magnitudeHitProbability", sample.get("magnitudeConfidence")), 0.0),
            "projectedFinalReturn": number(sample.get("projectedFinalReturn", sample.get("projectedUpside")), 0.0),
            "projectedMaxUpside": number(sample.get("projectedMaxUpside"), 0.0),
        }
        rows.append(
            {
                "date": str(sample.get("signalAt") or sample.get("asOfDate") or sample.get("createdAt") or "")[:10],
                "resolvedDate": str(outcome.get("resolvedAt") or sample.get("resolvedAt") or "")[:10],
                "symbol": str(sample.get("symbol") or ""),
                "features": features,
                "actual_return": actual_return,
                "max_upside": clamp(max_upside, 0.0, 32.0),
                "max_drawdown": clamp(max_drawdown, -32.0, 0.0),
                "barrier_label": barrier_label,
                "barrier_class": triple_barrier_class(barrier_label),
                "target_upside": target_upside,
                "stop_loss": stop_loss,
                "risk_reward_label": 1.0 if outcome.get("targetWins") and not outcome.get("stopWins") else 0.0,
                "direction_label": 1.0 if actual_return >= 0 else 0.0,
                "target_label": 1.0 if outcome.get("targetWins") else 0.0,
                "stop_label": 1.0 if outcome.get("stopWins") else 0.0,
                "stored_prediction": clamp(number(ensemble.get("projectedUpside", sample.get("projectedFinalReturn", sample.get("projectedUpside"))), 0.0), -18.0, 18.0),
                "stored_target_probability": clamp(number(sample.get("strategyHitProbability", sample.get("strategyConfidence")), 0.0) / 100.0, 0.0, 1.0),
                "stored_stop_probability": clamp(
                    number(
                        sample.get(
                            "downsideConfidence",
                            100.0 - number(sample.get("strategyHitProbability", sample.get("strategyConfidence")), 50.0)
                            + max(0.0, -number(sample.get("projectedFinalReturn", sample.get("projectedUpside")), 0.0)) * 5.0,
                        ),
                        50.0,
                    )
                    / 100.0,
                    0.0,
                    1.0,
                ),
            }
        )
    return tail_rows(sorted(rows, key=lambda row: row["date"]), MAX_SUPERVISED_ROWS)


def embargo_gap_for_rows(rows: list[dict[str, Any]]) -> int:
    date_count = len({str(row.get("date") or "")[:10] for row in rows if row.get("date")})
    if date_count < 24:
        return 0
    return max(2, min(20, math.ceil(date_count * DEFAULT_EMBARGO_FRACTION)))


def split_supervised_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    rows = sorted(rows, key=lambda row: (str(row.get("date") or "")[:10], str(row.get("symbol") or "")))
    dates = sorted({str(row.get("date") or "")[:10] for row in rows if row.get("date")})
    if len(dates) < 3:
        return rows, [], []
    train_end = max(1, min(len(dates) - 2, math.floor(len(dates) * 0.58)))
    validation_end = max(train_end + 1, min(len(dates) - 1, math.floor(len(dates) * 0.78)))
    gap = embargo_gap_for_rows(rows)
    def partition(current_gap: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        train_dates = set(dates[:max(0, train_end - current_gap)])
        validation_dates = set(dates[min(len(dates), train_end + current_gap):max(min(len(dates), train_end + current_gap), validation_end - current_gap)])
        test_dates = set(dates[min(len(dates), validation_end + current_gap):])
        return (
            [row for row in rows if str(row.get("date") or "")[:10] in train_dates],
            [row for row in rows if str(row.get("date") or "")[:10] in validation_dates],
            [row for row in rows if str(row.get("date") or "")[:10] in test_dates],
        )
    train, validation, test = partition(gap)
    if not train or not validation or not test:
        train, validation, test = partition(0)
    return train, validation, test


def split_audit(rows: list[dict[str, Any]]) -> dict[str, Any]:
    train, validation, test = split_supervised_rows(rows)
    gap = embargo_gap_for_rows(rows)
    return {
        "method": "signal-date-grouped-purged-walk-forward-embargo",
        "sampleCount": len(rows),
        "embargoSamples": gap,
        "trainSamples": len(train),
        "validationSamples": len(validation),
        "testSamples": len(test),
        "trainDates": len({row.get("date") for row in train}),
        "validationDates": len({row.get("date") for row in validation}),
        "testDates": len({row.get("date") for row in test}),
        "dateOverlapCount": len(
            ({row.get("date") for row in train} & {row.get("date") for row in validation})
            | ({row.get("date") for row in train} & {row.get("date") for row in test})
            | ({row.get("date") for row in validation} & {row.get("date") for row in test})
        ),
        "legacyProvisional": True,
        "note": "All symbols from one signal date stay in the same split; this legacy suite remains provisional until market-level strict OOF evidence passes.",
    }


def legacy_production_gate(
    rows: list[dict[str, Any]],
    research_active: bool,
    stability: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Prevent small local research fits from silently becoming live models.

    The market-level production trainer owns the real Champion/Challenger path. This
    gate keeps the older per-record model suite useful for diagnostics while making
    its deployment contract explicit and conservative.
    """
    audit = split_audit(rows)
    stability = stability or {}
    candidates = stability.get("candidates") or []
    positive_folds = max(
        [int(number(candidate.get("positiveJointFoldCount"), 0)) for candidate in candidates]
        or [0]
    )
    target_events = sum(1 for row in rows if number(row.get("target_label"), 0) >= 0.5)
    stop_events = sum(1 for row in rows if number(row.get("stop_label"), 0) >= 0.5)
    checks = {
        "researchEvidencePassed": bool(research_active),
        "trainingRows": len(rows) >= PRODUCTION_MIN_ROWS,
        "independentTestRows": int(audit.get("testSamples") or 0) >= PRODUCTION_MIN_TEST_ROWS,
        "targetEvents": target_events >= PRODUCTION_MIN_TARGET_EVENTS,
        "stopEvents": stop_events >= PRODUCTION_MIN_STOP_EVENTS,
        "rollingFolds": int(stability.get("foldCount") or 0) >= PRODUCTION_MIN_FOLDS,
        "positiveRollingFolds": positive_folds >= PRODUCTION_MIN_POSITIVE_FOLDS,
    }
    failed = [name for name, passed in checks.items() if not passed]
    return {
        "eligible": not failed,
        "status": "production_eligible" if not failed else "research_or_shadow_only",
        "checks": checks,
        "failedChecks": failed,
        "observed": {
            "rows": len(rows),
            "testRows": int(audit.get("testSamples") or 0),
            "targetEvents": target_events,
            "stopEvents": stop_events,
            "rollingFolds": int(stability.get("foldCount") or 0),
            "positiveRollingFolds": positive_folds,
        },
        "required": {
            "rows": PRODUCTION_MIN_ROWS,
            "testRows": PRODUCTION_MIN_TEST_ROWS,
            "targetEvents": PRODUCTION_MIN_TARGET_EVENTS,
            "stopEvents": PRODUCTION_MIN_STOP_EVENTS,
            "rollingFolds": PRODUCTION_MIN_FOLDS,
            "positiveRollingFolds": PRODUCTION_MIN_POSITIVE_FOLDS,
        },
        "reason": (
            "Legacy local candidate passed the conservative production evidence gate."
            if not failed
            else "Local candidate remains research/Shadow evidence and cannot change live probability or weights."
        ),
    }


def feature_matrix(rows: list[dict[str, Any]], feature_names: list[str]) -> list[list[float]]:
    return [[number(row["features"].get(name)) for name in feature_names] for row in rows]


def standardize_fit(matrix: list[list[float]]) -> tuple[list[float], list[float]]:
    if not matrix:
        return [], []
    width = len(matrix[0])
    centers: list[float] = []
    scales: list[float] = []
    for col in range(width):
        values = [row[col] for row in matrix]
        center = mean(values)
        variance = mean([(value - center) ** 2 for value in values])
        scale = math.sqrt(variance) or 1.0
        centers.append(center)
        scales.append(scale)
    return centers, scales


def standardize_apply(matrix: list[list[float]], centers: list[float], scales: list[float]) -> list[list[float]]:
    return [
        [(value - centers[index]) / max(1e-9, scales[index]) for index, value in enumerate(row)]
        for row in matrix
    ]


def dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def fit_ridge_regression(rows: list[dict[str, Any]], feature_names: list[str], target_key: str, penalty: float = 0.08) -> dict[str, Any]:
    matrix = feature_matrix(rows, feature_names)
    targets = [number(row[target_key]) for row in rows]
    centers, scales = standardize_fit(matrix)
    x_rows = standardize_apply(matrix, centers, scales)
    weights = [0.0 for _ in feature_names]
    intercept = mean(targets)
    step = 0.035 / max(1, len(feature_names))
    for _ in range(190):
        grad_w = [2 * penalty * value for value in weights]
        grad_b = 0.0
        for x_row, target in zip(x_rows, targets):
            pred = intercept + dot(weights, x_row)
            error = pred - target
            grad_b += 2 * error / len(x_rows)
            for index, value in enumerate(x_row):
                grad_w[index] += 2 * error * value / len(x_rows)
        intercept -= step * grad_b
        weights = [weight - step * grad_w[index] for index, weight in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def fit_logistic(rows: list[dict[str, Any]], feature_names: list[str], target_key: str, penalty: float = 0.08) -> dict[str, Any]:
    matrix = feature_matrix(rows, feature_names)
    targets = [1.0 if number(row[target_key]) >= 0.5 else 0.0 for row in rows]
    centers, scales = standardize_fit(matrix)
    x_rows = standardize_apply(matrix, centers, scales)
    base_rate = clamp(mean(targets), 0.02, 0.98)
    intercept = math.log(base_rate / (1 - base_rate))
    weights = [0.0 for _ in feature_names]
    step = 0.055 / max(1, len(feature_names))
    for _ in range(190):
        grad_w = [2 * penalty * value for value in weights]
        grad_b = 0.0
        for x_row, target in zip(x_rows, targets):
            z = clamp(intercept + dot(weights, x_row), -18, 18)
            pred = 1 / (1 + math.exp(-z))
            error = pred - target
            grad_b += error / len(x_rows)
            for index, value in enumerate(x_row):
                grad_w[index] += error * value / len(x_rows)
        intercept -= step * grad_b
        weights = [weight - step * grad_w[index] for index, weight in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def predict_regression(model: dict[str, Any], rows: list[dict[str, Any]], feature_names: list[str]) -> list[float]:
    matrix = standardize_apply(feature_matrix(rows, feature_names), model["centers"], model["scales"])
    return [number(model["intercept"]) + dot(model["weights"], row) for row in matrix]


def predict_logistic(model: dict[str, Any], rows: list[dict[str, Any]], feature_names: list[str]) -> list[float]:
    matrix = standardize_apply(feature_matrix(rows, feature_names), model["centers"], model["scales"])
    return [1 / (1 + math.exp(-clamp(number(model["intercept"]) + dot(model["weights"], row), -18, 18))) for row in matrix]


def evaluate_regression_head(rows: list[dict[str, Any]], predictions: list[float], baseline_key: str = "stored_prediction") -> dict[str, Any]:
    if not rows:
        return {"samples": 0, "mse": None, "mae": None, "directionHitRate": None, "baselineMse": None, "improvementPct": None}
    targets = [number(row["actual_return"]) for row in rows]
    errors = [predictions[index] - targets[index] for index in range(len(rows))]
    baseline = [number(row.get(baseline_key)) for row in rows]
    baseline_errors = [baseline[index] - targets[index] for index in range(len(rows))]
    direction_hits = sum(1 for index, target in enumerate(targets) if (predictions[index] >= 0 and target >= 0) or (predictions[index] < 0 and target < 0))
    mse = mean([error * error for error in errors])
    baseline_mse = mean([error * error for error in baseline_errors])
    return {
        "samples": len(rows),
        "mse": mse,
        "mae": mean([abs(error) for error in errors]),
        "directionHitRate": direction_hits / len(rows) * 100,
        "baselineMse": baseline_mse,
        "improvementPct": improvement_pct(mse, baseline_mse),
    }


def evaluate_logistic_head(rows: list[dict[str, Any]], probabilities: list[float], target_key: str, baseline_key: str = "stored_target_probability") -> dict[str, Any]:
    if not rows:
        return {"samples": 0, "brier": None, "hitRate": None, "baselineBrier": None, "improvementPct": None}
    targets = [1.0 if number(row[target_key]) >= 0.5 else 0.0 for row in rows]
    brier = mean([(probabilities[index] - targets[index]) ** 2 for index in range(len(rows))])
    baseline = [clamp(number(row.get(baseline_key)), 0.0, 1.0) for row in rows]
    baseline_brier = mean([(baseline[index] - targets[index]) ** 2 for index in range(len(rows))])
    hits = sum(1 for index, target in enumerate(targets) if (probabilities[index] >= 0.5 and target >= 0.5) or (probabilities[index] < 0.5 and target < 0.5))
    return {
        "samples": len(rows),
        "brier": brier,
        "hitRate": hits / len(rows) * 100,
        "baselineBrier": baseline_brier,
        "improvementPct": improvement_pct(brier, baseline_brier),
    }


def serialize_linear_model(model: dict[str, Any], feature_names: list[str], limit: int = 12) -> dict[str, Any]:
    coefs = [
        {"feature": name, "coef": round(number(model["weights"][index]), 6)}
        for index, name in enumerate(feature_names)
    ]
    coefs.sort(key=lambda row: abs(row["coef"]), reverse=True)
    return {
        "intercept": round(number(model["intercept"]), 6),
        "weights": {
            name: round(number(model["weights"][index]), 8)
            for index, name in enumerate(feature_names)
        },
        "centers": {
            name: round(number(model["centers"][index]), 8)
            for index, name in enumerate(feature_names)
        },
        "scales": {
            name: round(max(1e-9, number(model["scales"][index], 1.0)), 8)
            for index, name in enumerate(feature_names)
        },
        "topCoefficients": coefs[:limit],
        "featureCount": len(feature_names),
    }


def train_regression_head(rows: list[dict[str, Any]], name: str, feature_names: list[str], baseline_key: str = "stored_prediction") -> dict[str, Any]:
    if len(rows) < 32:
        return {"name": name, "status": "collecting", "active": False, "researchActive": False, "productionEligible": False, "sampleCount": len(rows), "minSamples": 32}
    train, validation, test = split_supervised_rows(rows)
    if len(validation) < 5 or len(test) < 5:
        return {"name": name, "status": "collecting", "active": False, "researchActive": False, "productionEligible": False, "sampleCount": len(rows), "minSamples": 40}
    penalties = [0.24, 0.1, 0.04]
    candidates = []
    for penalty in penalties:
        model = fit_ridge_regression(train, feature_names, "actual_return", penalty)
        candidates.append({
            "penalty": penalty,
            "model": model,
            "validation": evaluate_regression_head(validation, predict_regression(model, validation, feature_names), baseline_key),
        })
    candidates.sort(key=lambda item: number(item["validation"].get("mse"), float("inf")))
    selected = candidates[0]
    deployment_model = fit_ridge_regression([*train, *validation], feature_names, "actual_return", selected["penalty"])
    test_metrics = evaluate_regression_head(test, predict_regression(deployment_model, test, feature_names), baseline_key)
    research_active = number(selected["validation"].get("improvementPct"), -999) >= 1 and number(test_metrics.get("improvementPct"), -999) >= 0.5
    production_gate = legacy_production_gate(rows, research_active)
    production_eligible = bool(production_gate["eligible"])
    return {
        "name": name,
        "kind": "ridge_regression",
        "status": "production_eligible" if production_eligible else "research_active" if research_active else "rejected_oos",
        "active": production_eligible,
        "researchActive": research_active,
        "productionEligible": production_eligible,
        "productionGate": production_gate,
        "sampleCount": len(rows),
        "featureNames": feature_names,
        "selectedLambda": selected["penalty"],
        "validation": round_metrics(selected["validation"]),
        "test": round_metrics(test_metrics),
        "model": serialize_linear_model(deployment_model, feature_names),
        "reason": (
            "OOS regression head passed the production evidence gate."
            if production_eligible
            else "OOS regression head is retained for research but cannot affect live forecasts until the market-level production gate passes."
            if research_active
            else "Regression head did not beat the existing baseline on validation/test."
        ),
    }


def train_logistic_head(rows: list[dict[str, Any]], name: str, feature_names: list[str], target_key: str, baseline_key: str = "stored_target_probability") -> dict[str, Any]:
    if len(rows) < 32:
        return {"name": name, "status": "collecting", "active": False, "researchActive": False, "productionEligible": False, "sampleCount": len(rows), "minSamples": 32}
    train, validation, test = split_supervised_rows(rows)
    if len(validation) < 5 or len(test) < 5:
        return {"name": name, "status": "collecting", "active": False, "researchActive": False, "productionEligible": False, "sampleCount": len(rows), "minSamples": 40}
    penalties = [0.24, 0.1, 0.04]
    candidates = []
    for penalty in penalties:
        model = fit_logistic(train, feature_names, target_key, penalty)
        candidates.append({
            "penalty": penalty,
            "model": model,
            "validation": evaluate_logistic_head(validation, predict_logistic(model, validation, feature_names), target_key, baseline_key),
        })
    candidates.sort(key=lambda item: number(item["validation"].get("brier"), float("inf")))
    selected = candidates[0]
    deployment_model = fit_logistic([*train, *validation], feature_names, target_key, selected["penalty"])
    test_metrics = evaluate_logistic_head(test, predict_logistic(deployment_model, test, feature_names), target_key, baseline_key)
    research_active = number(selected["validation"].get("improvementPct"), -999) >= 1 and number(test_metrics.get("improvementPct"), -999) >= 0.5
    production_gate = legacy_production_gate(rows, research_active)
    production_eligible = bool(production_gate["eligible"])
    return {
        "name": name,
        "kind": "logistic_meta_label",
        "target": target_key,
        "status": "production_eligible" if production_eligible else "research_active" if research_active else "rejected_oos",
        "active": production_eligible,
        "researchActive": research_active,
        "productionEligible": production_eligible,
        "productionGate": production_gate,
        "sampleCount": len(rows),
        "featureNames": feature_names,
        "selectedLambda": selected["penalty"],
        "validation": round_metrics(selected["validation"]),
        "test": round_metrics(test_metrics),
        "model": serialize_linear_model(deployment_model, feature_names),
        "reason": (
            "OOS logistic head passed the production evidence gate."
            if production_eligible
            else "OOS logistic head is retained for research but cannot affect live forecasts until the market-level production gate passes."
            if research_active
            else "Logistic head did not beat the existing probability baseline on validation/test."
        ),
    }


def triple_barrier_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for row in rows:
        label = str(row.get("barrier_label") or "unknown")
        counts[label] = counts.get(label, 0) + 1
    total = len(rows)
    target = counts.get("target", 0)
    stop = counts.get("stop", 0)
    timeout = sum(count for label, count in counts.items() if label.startswith("timeout"))
    return {
        "framework": "triple-barrier-labels",
        "sampleCount": total,
        "classes": counts,
        "targetRate": target / total * 100 if total else None,
        "stopRate": stop / total * 100 if total else None,
        "timeoutRate": timeout / total * 100 if total else None,
        "labels": ["target", "stop", "timeout_positive", "timeout_negative", "timeout_flat"],
        "note": "Prediction success is judged by target-before-stop, stop-first, and timeout outcomes instead of final direction only.",
    }


def probability_bucket(value: float) -> str:
    pct = clamp(value, 0.0, 1.0) * 100
    if pct < 40:
        return "0-39"
    if pct < 50:
        return "40-49"
    if pct < 60:
        return "50-59"
    if pct < 70:
        return "60-69"
    if pct < 80:
        return "70-79"
    return "80-99"


def calibration_diagnostics(rows: list[dict[str, Any]], probability_key: str, target_key: str) -> dict[str, Any]:
    buckets: dict[str, dict[str, float]] = {}
    for row in rows:
        bucket = probability_bucket(number(row.get(probability_key), 0.0))
        item = buckets.setdefault(bucket, {"count": 0.0, "predicted": 0.0, "actual": 0.0, "brier": 0.0})
        probability = clamp(number(row.get(probability_key), 0.0), 0.0, 1.0)
        actual = 1.0 if number(row.get(target_key), 0.0) >= 0.5 else 0.0
        item["count"] += 1
        item["predicted"] += probability
        item["actual"] += actual
        item["brier"] += (probability - actual) ** 2
    ordered = []
    for label in ["0-39", "40-49", "50-59", "60-69", "70-79", "80-99"]:
        item = buckets.get(label)
        if not item:
            continue
        count = max(1.0, item["count"])
        ordered.append({
            "bucket": label,
            "count": int(item["count"]),
            "avgPredicted": round(item["predicted"] / count * 100, 2),
            "observedRate": round(item["actual"] / count * 100, 2),
            "brier": round(item["brier"] / count, 5),
            "calibrationError": round((item["predicted"] - item["actual"]) / count * 100, 2),
        })
    if not rows:
        return {"rows": [], "brier": None, "expectedCalibrationError": None}
    weighted_error = sum(abs(row["calibrationError"]) * row["count"] for row in ordered) / max(1, sum(row["count"] for row in ordered))
    brier = mean([
        (clamp(number(row.get(probability_key), 0.0), 0.0, 1.0) - (1.0 if number(row.get(target_key), 0.0) >= 0.5 else 0.0)) ** 2
        for row in rows
    ])
    return {
        "rows": ordered,
        "brier": round(brier, 5),
        "expectedCalibrationError": round(weighted_error, 2),
    }


def no_trade_diagnostics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"sampleCount": 0, "status": "collecting"}
    flagged = [
        row
        for row in rows
        if number(row.get("stored_target_probability"), 0.0) < 0.55
        or number(row.get("stored_stop_probability"), 0.0) >= 0.62
        or number(row.get("barrier_class"), TRIPLE_BARRIER_CLASSES["timeout"]) == TRIPLE_BARRIER_CLASSES["stop"]
    ]
    tradable = [row for row in rows if row not in flagged]
    flagged_stop = mean([1.0 if row.get("stop_label") else 0.0 for row in flagged]) * 100 if flagged else None
    tradable_target = mean([1.0 if row.get("target_label") else 0.0 for row in tradable]) * 100 if tradable else None
    return {
        "framework": "no-trade-quality-gate",
        "sampleCount": len(rows),
        "flaggedCount": len(flagged),
        "tradableCount": len(tradable),
        "flaggedStopRate": None if flagged_stop is None else round(flagged_stop, 2),
        "tradableTargetRate": None if tradable_target is None else round(tradable_target, 2),
        "defaultRules": [
            "stored target probability < 55%",
            "stored stop probability >= 62%",
            "resolved stop-first examples are treated as no-trade training evidence",
        ],
        "note": "The gate is designed to improve precision by refusing low-quality trades instead of forcing a directional prediction.",
    }


def feature_importance_rows(model: Any, feature_names: list[str], limit: int = 12) -> list[dict[str, Any]]:
    importances = getattr(model, "feature_importances_", None)
    if importances is None:
        return []
    rows = [
        {"feature": feature_names[index], "importance": int(value)}
        for index, value in enumerate(importances)
    ]
    rows.sort(key=lambda row: row["importance"], reverse=True)
    return rows[:limit]


def evaluate_multiclass_barrier(rows: list[dict[str, Any]], probabilities: list[list[float]]) -> dict[str, Any]:
    if not rows or not probabilities:
        return {"samples": 0, "accuracy": None, "targetRecall": None, "stopRecall": None}
    actual = [int(number(row.get("barrier_class"), TRIPLE_BARRIER_CLASSES["timeout"])) for row in rows]
    predicted = [max(range(len(row)), key=lambda index: number(row[index])) for row in probabilities]
    correct = sum(1 for index, value in enumerate(actual) if predicted[index] == value)
    target_indexes = [index for index, value in enumerate(actual) if value == TRIPLE_BARRIER_CLASSES["target"]]
    stop_indexes = [index for index, value in enumerate(actual) if value == TRIPLE_BARRIER_CLASSES["stop"]]
    return {
        "samples": len(rows),
        "accuracy": correct / len(rows) * 100,
        "targetRecall": (sum(1 for index in target_indexes if predicted[index] == TRIPLE_BARRIER_CLASSES["target"]) / len(target_indexes) * 100) if target_indexes else None,
        "stopRecall": (sum(1 for index in stop_indexes if predicted[index] == TRIPLE_BARRIER_CLASSES["stop"]) / len(stop_indexes) * 100) if stop_indexes else None,
    }


def lightgbm_unavailable(rows: list[dict[str, Any]], reason: str = "missing_tree_model") -> dict[str, Any]:
    return {
        "framework": "tree-model-optional-local-baseline",
        "available": False,
        "active": False,
        "status": reason,
        "sampleCount": len(rows),
        "reason": "LightGBM/sklearn tree models are optional; install/import a tree model in the active Python environment to train the non-linear baseline.",
    }


def lightgbm_training_error_head(name: str, kind: str, rows: list[dict[str, Any]], error: Exception) -> dict[str, Any]:
    return {
        "name": name,
        "kind": kind,
        "status": "training_error",
        "active": False,
        "sampleCount": len(rows),
        "error": str(error)[:240],
        "reason": "This optional tree-model head failed training and was excluded; other local heads remain available.",
    }


def train_lightgbm_classifier(rows: list[dict[str, Any]], lgb: Any, name: str, feature_names: list[str], target_key: str, baseline_key: str = "stored_target_probability") -> dict[str, Any]:
    if len(rows) < 80:
        return {"name": name, "kind": "lightgbm_classifier", "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 80}
    train, validation, test = split_supervised_rows(rows)
    if len({int(number(row[target_key])) for row in train}) < 2:
        return {"name": name, "kind": "lightgbm_classifier", "status": "single_class_train", "active": False, "sampleCount": len(rows)}
    model = lgb.LGBMClassifier(
        n_estimators=80,
        learning_rate=0.045,
        max_depth=3,
        num_leaves=15,
        min_child_samples=12,
        subsample=0.9,
        colsample_bytree=0.85,
        reg_alpha=0.08,
        reg_lambda=0.18,
        random_state=17,
        verbose=-1,
    )
    model.fit(feature_matrix(train, feature_names), [int(number(row[target_key])) for row in train])

    def positive_prob(split_rows: list[dict[str, Any]]) -> list[float]:
        classes = list(getattr(model, "classes_", []))
        if 1 not in classes:
            return [0.0 for _ in split_rows]
        index = classes.index(1)
        return [float(row[index]) for row in model.predict_proba(feature_matrix(split_rows, feature_names))]

    validation_metrics = evaluate_logistic_head(validation, positive_prob(validation), target_key, baseline_key)
    test_metrics = evaluate_logistic_head(test, positive_prob(test), target_key, baseline_key)
    active = number(validation_metrics.get("improvementPct"), -999) >= 1 and number(test_metrics.get("improvementPct"), -999) >= 0.5
    return {
        "name": name,
        "kind": "lightgbm_classifier",
        "status": "active" if active else "rejected_oos",
        "active": active,
        "sampleCount": len(rows),
        "featureNames": feature_names,
        "validation": round_metrics(validation_metrics),
        "test": round_metrics(test_metrics),
        "topFeatures": feature_importance_rows(model, feature_names),
        "reason": "LightGBM classifier beat the probability baseline out-of-sample." if active else "LightGBM classifier did not beat the probability baseline on validation/test.",
    }


def train_lightgbm_regressor(rows: list[dict[str, Any]], lgb: Any, name: str, feature_names: list[str], target_key: str = "actual_return", baseline_key: str = "stored_prediction") -> dict[str, Any]:
    if len(rows) < 80:
        return {"name": name, "kind": "lightgbm_regressor", "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 80}
    train, validation, test = split_supervised_rows(rows)
    model = lgb.LGBMRegressor(
        n_estimators=90,
        learning_rate=0.04,
        max_depth=3,
        num_leaves=15,
        min_child_samples=12,
        subsample=0.9,
        colsample_bytree=0.85,
        reg_alpha=0.08,
        reg_lambda=0.2,
        random_state=23,
        verbose=-1,
    )
    model.fit(feature_matrix(train, feature_names), [number(row[target_key]) for row in train])
    validation_predictions = [float(value) for value in model.predict(feature_matrix(validation, feature_names))]
    test_predictions = [float(value) for value in model.predict(feature_matrix(test, feature_names))]
    validation_metrics = evaluate_regression_head(validation, validation_predictions, baseline_key)
    test_metrics = evaluate_regression_head(test, test_predictions, baseline_key)
    active = number(validation_metrics.get("improvementPct"), -999) >= 1 and number(test_metrics.get("improvementPct"), -999) >= 0.5
    return {
        "name": name,
        "kind": "lightgbm_regressor",
        "status": "active" if active else "rejected_oos",
        "active": active,
        "sampleCount": len(rows),
        "featureNames": feature_names,
        "validation": round_metrics(validation_metrics),
        "test": round_metrics(test_metrics),
        "topFeatures": feature_importance_rows(model, feature_names),
        "reason": "LightGBM regressor beat the return baseline out-of-sample." if active else "LightGBM regressor did not beat the return baseline on validation/test.",
    }


def train_lightgbm_barrier_classifier(rows: list[dict[str, Any]], lgb: Any, feature_names: list[str]) -> dict[str, Any]:
    if len(rows) < 90:
        return {"name": "lgb_triple_barrier", "kind": "lightgbm_multiclass", "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 90}
    train, validation, test = split_supervised_rows(rows)
    if len({int(number(row["barrier_class"])) for row in train}) < 2:
        return {"name": "lgb_triple_barrier", "kind": "lightgbm_multiclass", "status": "single_class_train", "active": False, "sampleCount": len(rows)}
    model = lgb.LGBMClassifier(
        objective="multiclass",
        num_class=3,
        n_estimators=90,
        learning_rate=0.04,
        max_depth=3,
        num_leaves=15,
        min_child_samples=12,
        subsample=0.9,
        colsample_bytree=0.85,
        reg_alpha=0.08,
        reg_lambda=0.2,
        random_state=31,
        verbose=-1,
    )
    model.fit(feature_matrix(train, feature_names), [int(number(row["barrier_class"])) for row in train])

    def aligned_probs(split_rows: list[dict[str, Any]]) -> list[list[float]]:
        raw = model.predict_proba(feature_matrix(split_rows, feature_names))
        classes = list(getattr(model, "classes_", []))
        aligned: list[list[float]] = []
        for row in raw:
            values = [0.0, 0.0, 0.0]
            for index, klass in enumerate(classes):
                if int(klass) in {0, 1, 2}:
                    values[int(klass)] = float(row[index])
            aligned.append(values)
        return aligned

    validation_metrics = evaluate_multiclass_barrier(validation, aligned_probs(validation))
    test_metrics = evaluate_multiclass_barrier(test, aligned_probs(test))
    active = number(validation_metrics.get("accuracy"), 0) >= 42 and number(test_metrics.get("accuracy"), 0) >= 42
    return {
        "name": "lgb_triple_barrier",
        "kind": "lightgbm_multiclass",
        "status": "active" if active else "rejected_oos",
        "active": active,
        "sampleCount": len(rows),
        "classes": {"0": "stop", "1": "timeout", "2": "target"},
        "validation": round_metrics(validation_metrics),
        "test": round_metrics(test_metrics),
        "topFeatures": feature_importance_rows(model, feature_names),
        "reason": "Triple-barrier classifier passed basic OOS accuracy floors." if active else "Triple-barrier classifier did not pass OOS accuracy floors.",
    }


def train_lightgbm_suite(rows: list[dict[str, Any]], market: str = "ASX") -> dict[str, Any]:
    if len(rows) < 80:
        result = lightgbm_unavailable(rows, "collecting")
        result["reason"] = "Need at least 80 resolved point-in-time samples before training LightGBM or sklearn tree baselines."
        return result
    if str(os.getenv("LOCAL_MODEL_TREE_ENABLED", "false")).strip().lower() != "true":
        result = lightgbm_unavailable(rows, "resource_policy_disabled")
        result["reason"] = "The deterministic local Champion remains active; tree challengers are opt-in and run only in a supervised resource window."
        return result
    provider = "lightgbm"
    try:
        import lightgbm as lgb  # type: ignore
    except Exception as lightgbm_error:
        try:
            from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor  # type: ignore

            class SklearnTreeFallback:
                @staticmethod
                def LGBMClassifier(**kwargs: Any) -> Any:
                    return GradientBoostingClassifier(
                        n_estimators=int(kwargs.get("n_estimators", 80)),
                        learning_rate=float(kwargs.get("learning_rate", 0.045)),
                        max_depth=int(kwargs.get("max_depth", 3)),
                        random_state=int(kwargs.get("random_state", 17)),
                    )

                @staticmethod
                def LGBMRegressor(**kwargs: Any) -> Any:
                    return GradientBoostingRegressor(
                        n_estimators=int(kwargs.get("n_estimators", 90)),
                        learning_rate=float(kwargs.get("learning_rate", 0.04)),
                        max_depth=int(kwargs.get("max_depth", 3)),
                        random_state=int(kwargs.get("random_state", 23)),
                    )

            lgb = SklearnTreeFallback()
            provider = "sklearn-gradient-boosting-fallback"
        except Exception as sklearn_error:
            result = lightgbm_unavailable(rows, "missing_tree_model")
            result["lightgbmError"] = str(lightgbm_error)[:240]
            result["sklearnError"] = str(sklearn_error)[:240]
            return result
    feature_names = [
        "trend",
        "momentum",
        "change5d",
        "change20d",
        "volumeRatio",
        "rsi",
        "volume",
        "risk",
        "factor",
        "gap",
        "buyPressure",
        "buyPressure5",
        "pressureChange",
        "volumeAccel",
        "profileDistance",
        "liquidityShock",
        "socialScore",
        "macroScore",
        "sectorScore",
        "flowScore",
        "liquidityScore",
        "relativeStrengthScore",
        "calibrationScore",
        "announcementScore",
        "analogConfidence",
        "modelConfidence",
        "newsCount",
        "factorCount",
        "upsideAgreement",
        "consensusAgreement",
        "predictionConfidence",
        "strategyHitProbability",
        "magnitudeHitProbability",
        "projectedFinalReturn",
        "projectedMaxUpside",
    ]
    try:
        target_head = train_lightgbm_classifier(rows, lgb, "lgb_target_before_stop", feature_names, "target_label")
    except Exception as error:
        target_head = lightgbm_training_error_head("lgb_target_before_stop", "lightgbm_classifier", rows, error)
    try:
        stop_head = train_lightgbm_classifier(rows, lgb, "lgb_stop_first", feature_names, "stop_label", baseline_key="stored_stop_probability")
    except Exception as error:
        stop_head = lightgbm_training_error_head("lgb_stop_first", "lightgbm_classifier", rows, error)
    try:
        return_head = train_lightgbm_regressor(rows, lgb, "lgb_forward_return", feature_names)
    except Exception as error:
        return_head = lightgbm_training_error_head("lgb_forward_return", "lightgbm_regressor", rows, error)
    try:
        barrier_head = train_lightgbm_barrier_classifier(rows, lgb, feature_names)
    except Exception as error:
        barrier_head = lightgbm_training_error_head("lgb_triple_barrier", "lightgbm_multiclass", rows, error)
    active_count = sum(1 for head in [target_head, stop_head, return_head, barrier_head] if head.get("active"))
    return {
        "framework": "tree-model-optional-local-baseline",
        "available": True,
        "active": active_count > 0,
        "status": "active" if active_count else "rejected_oos",
        "provider": provider,
        "market": market,
        "sampleCount": len(rows),
        "activeHeadCount": active_count,
        "targetHead": target_head,
        "stopHead": stop_head,
        "returnHead": return_head,
        "tripleBarrierHead": barrier_head,
        "reason": "LightGBM heads are allowed into research evidence only after OOS validation beats their baselines.",
    }


MODEL_ZOO_LABELS = {
    "stored_ensemble": "当前线上综合预测",
    "technical_ridge": "技术面线性挑战者",
    "factor_ridge": "因子/新闻线性挑战者",
    "orderflow_profile_ridge": "订单流/成交密集区挑战者",
    "wide_regularized_ridge": "全特征正则挑战者",
    "target_stop_meta": "目标-止损Meta挑战者",
    "sequence_state_proxy": "序列状态代理挑战者",
    "tree_boosting_return": "LightGBM/树模型挑战者",
}


def model_zoo_feature_groups() -> dict[str, list[str]]:
    return {
        "technical_ridge": [
            "trend",
            "momentum",
            "change5d",
            "change20d",
            "volumeRatio",
            "rsi",
            "volume",
            "risk",
            "gap",
        ],
        "factor_ridge": [
            "factor",
            "socialScore",
            "macroScore",
            "sectorScore",
            "flowScore",
            "liquidityScore",
            "relativeStrengthScore",
            "calibrationScore",
            "announcementScore",
            "analogConfidence",
            "modelConfidence",
            "newsCount",
            "factorCount",
        ],
        "orderflow_profile_ridge": [
            "buyPressure",
            "buyPressure5",
            "pressureChange",
            "volumeAccel",
            "profileDistance",
            "liquidityShock",
            "volumeRatio",
            "risk",
            "change5d",
        ],
        "wide_regularized_ridge": [
            "trend",
            "momentum",
            "change5d",
            "change20d",
            "volumeRatio",
            "rsi",
            "volume",
            "risk",
            "factor",
            "gap",
            "buyPressure",
            "buyPressure5",
            "pressureChange",
            "volumeAccel",
            "profileDistance",
            "liquidityShock",
            "socialScore",
            "macroScore",
            "sectorScore",
            "flowScore",
            "liquidityScore",
            "relativeStrengthScore",
            "calibrationScore",
            "announcementScore",
            "analogConfidence",
            "modelConfidence",
            "newsCount",
            "factorCount",
            "upsideAgreement",
            "consensusAgreement",
            "predictionConfidence",
            "strategyHitProbability",
            "magnitudeHitProbability",
            "projectedFinalReturn",
            "projectedMaxUpside",
        ],
        "target_stop_meta": [
            "predictionConfidence",
            "strategyHitProbability",
            "magnitudeHitProbability",
            "projectedFinalReturn",
            "projectedMaxUpside",
            "factor",
            "calibrationScore",
            "buyPressure5",
            "profileDistance",
            "volumeAccel",
            "risk",
            "volumeRatio",
            "upsideAgreement",
            "consensusAgreement",
        ],
        "sequence_state_proxy": [
            "change5d",
            "change20d",
            "momentum",
            "trend",
            "volumeAccel",
            "pressureChange",
            "profileDistance",
            "liquidityShock",
            "upsideAgreement",
            "consensusAgreement",
        ],
    }


def sequence_state_proxy_predictions(rows: list[dict[str, Any]]) -> list[float]:
    predictions: list[float] = []
    for row in rows:
        feature = row.get("features") or {}
        trend = (number(feature.get("trend"), 50) - 50) / 50
        momentum = (number(feature.get("momentum"), 50) - 50) / 50
        change5 = number(feature.get("change5d"), 0) / 8
        change20 = number(feature.get("change20d"), 0) / 18
        volume_accel = number(feature.get("volumeAccel"), 0)
        pressure = number(feature.get("pressureChange"), 0) + number(feature.get("buyPressure5"), 0) * 0.7
        profile = -number(feature.get("profileDistance"), 0) / 5
        liquidity = -max(0.0, number(feature.get("liquidityShock"), 0)) * 0.18
        agreement = (number(feature.get("upsideAgreement"), 50) - 50) / 50
        prediction = (
            trend * 1.1
            + momentum * 1.0
            + change20 * 1.2
            + change5 * 0.7
            + volume_accel * 0.42
            + pressure * 0.95
            + profile * 0.55
            + agreement * 0.65
            + liquidity
        )
        predictions.append(clamp(prediction, -18.0, 18.0))
    return predictions


def target_stop_meta_predictions(target_model: dict[str, Any], stop_model: dict[str, Any], rows: list[dict[str, Any]], feature_names: list[str]) -> list[float]:
    target_probabilities = predict_logistic(target_model, rows, feature_names)
    stop_probabilities = predict_logistic(stop_model, rows, feature_names)
    predictions: list[float] = []
    for index, row in enumerate(rows):
        target_prob = clamp(number(target_probabilities[index]), 0.0, 1.0)
        stop_prob = clamp(number(stop_probabilities[index]), 0.0, 1.0)
        target_upside = max(0.5, number(row.get("target_upside"), 5.0))
        stop_loss = max(0.8, abs(number(row.get("stop_loss"), 4.0)))
        expected = (
            (target_prob - 0.5) * target_upside * 2.25
            - max(0.0, stop_prob - 0.35) * stop_loss * 1.35
            + (target_prob - stop_prob) * 0.8
        )
        predictions.append(clamp(expected, -18.0, 18.0))
    return predictions


def evaluate_zoo_candidate(rows: list[dict[str, Any]], predictions: list[float], baseline_predictions: list[float] | None = None) -> dict[str, Any]:
    if not rows or not predictions:
        return {"samples": 0, "mse": None, "mae": None, "directionHitRate": None, "targetPrecision": None, "improvementPct": None}
    targets = [number(row.get("actual_return"), 0.0) for row in rows]
    errors = [number(predictions[index]) - targets[index] for index in range(len(rows))]
    mse = mean([error * error for error in errors])
    baseline_mse = None
    improvement = None
    if baseline_predictions:
        baseline_errors = [number(baseline_predictions[index]) - targets[index] for index in range(min(len(rows), len(baseline_predictions)))]
        baseline_mse = mean([error * error for error in baseline_errors])
        improvement = improvement_pct(mse, baseline_mse)
    direction_hits = sum(
        1
        for index, target in enumerate(targets)
        if (number(predictions[index]) >= 0 and target >= 0) or (number(predictions[index]) < 0 and target < 0)
    )
    positive_indexes = [index for index, value in enumerate(predictions) if number(value) > 0.15]
    target_precision = (
        sum(1 for index in positive_indexes if number(rows[index].get("target_label")) >= 0.5) / len(positive_indexes) * 100
        if positive_indexes
        else None
    )
    return {
        "samples": len(rows),
        "mse": mse,
        "mae": mean([abs(error) for error in errors]),
        "directionHitRate": direction_hits / len(rows) * 100,
        "targetPrecision": target_precision,
        "baselineMse": baseline_mse,
        "improvementPct": improvement,
        "avgPrediction": mean(predictions),
        "avgActualReturn": mean(targets),
        "correlation": pearson(predictions, targets),
    }


def zoo_weight_rows(rows: list[dict[str, Any]], predictions_by_name: dict[str, list[float]], names: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        out.append({
            "actual_return": number(row.get("actual_return")),
            "target_wins": number(row.get("target_label")) >= 0.5,
            "model_values": {
                name: number((predictions_by_name.get(name) or [0.0 for _ in rows])[index])
                for name in names
            },
        })
    return out


def prediction_dispersion(values: list[float], weights: list[float] | None = None) -> float:
    clean = [number(value) for value in values if math.isfinite(number(value, math.nan))]
    if not clean:
        return 0.0
    if weights and len(weights) == len(values):
        normalized = normalize_weights(weights)
        center = sum(number(values[index]) * normalized[index] for index in range(len(values)))
        variance = sum(((number(values[index]) - center) ** 2) * normalized[index] for index in range(len(values)))
    else:
        center = mean(clean)
        variance = mean([(value - center) ** 2 for value in clean])
    return math.sqrt(max(0.0, variance))


def evaluate_zoo_ensemble(rows: list[dict[str, Any]], predictions_by_name: dict[str, list[float]], names: list[str], weights: list[float]) -> dict[str, Any]:
    weighted_rows = zoo_weight_rows(rows, predictions_by_name, names)
    metrics = evaluate_weight_vector(weighted_rows, names, weights)
    predictions = [prediction_for_weight_vector(row, names, weights) for row in weighted_rows]
    actuals = [number(row.get("actual_return")) for row in weighted_rows]
    metrics["correlation"] = pearson(predictions, actuals)
    metrics["dispersionMedian"] = percentile([
        prediction_dispersion([number((predictions_by_name.get(name) or [0.0 for _ in rows])[index]) for name in names], weights)
        for index in range(len(rows))
    ], 0.5)
    metrics["dispersionP75"] = percentile([
        prediction_dispersion([number((predictions_by_name.get(name) or [0.0 for _ in rows])[index]) for name in names], weights)
        for index in range(len(rows))
    ], 0.75)
    return metrics


def cap_model_zoo_double_check_weights(names: list[str], weights: list[float], candidates: list[dict[str, Any]]) -> tuple[list[float], dict[str, Any]]:
    """Keep optional/open-source challengers as double-check evidence, not the main forecast driver."""
    if not names or not weights:
        return weights, {"applied": False, "reason": "No model-zoo weights."}
    family_by_name = {str(candidate.get("name")): str(candidate.get("family") or "") for candidate in candidates}
    external_indexes = [
        index for index, name in enumerate(names)
        if name == "tree_boosting_return" or family_by_name.get(name) in {"open_source_tree", "external_adapter"}
    ]
    if not external_indexes:
        return normalize_weights(weights), {
            "applied": False,
            "maxExternalShare": 0.12,
            "maxSingleExternalShare": 0.08,
            "selfModelMinShare": 0.88,
            "reason": "No external/open-source challenger carried deployment weight.",
        }
    capped = normalize_weights(weights)
    max_single = 0.08
    for index in external_indexes:
        capped[index] = min(capped[index], max_single)
    external_total = sum(capped[index] for index in external_indexes)
    max_external = 0.12
    if external_total > max_external:
        scale = max_external / max(1e-12, external_total)
        for index in external_indexes:
            capped[index] *= scale
    internal_indexes = [index for index in range(len(capped)) if index not in external_indexes]
    internal_total = sum(capped[index] for index in internal_indexes)
    leftover = max(0.0, 1.0 - sum(capped[index] for index in external_indexes))
    if internal_indexes and internal_total > 0:
        for index in internal_indexes:
            capped[index] = capped[index] / internal_total * leftover
    capped = normalize_weights(capped)
    return capped, {
        "applied": True,
        "framework": "self-model-primary-double-check-cap",
        "selfModelMinShare": 0.88,
        "maxExternalShare": max_external,
        "maxSingleExternalShare": max_single,
        "externalModelNames": [names[index] for index in external_indexes],
        "reason": "External/open-source challengers are capped as double-check evidence; local models keep the dominant committee share.",
    }


def average_residual_correlation(rows: list[dict[str, Any]], predictions_by_name: dict[str, list[float]], names: list[str]) -> float:
    residuals: dict[str, list[float]] = {}
    actuals = [number(row.get("actual_return")) for row in rows]
    for name in names:
        predictions = predictions_by_name.get(name) or []
        if len(predictions) != len(rows):
            continue
        residuals[name] = [number(predictions[index]) - actuals[index] for index in range(len(rows))]
    values: list[float] = []
    keys = list(residuals)
    for left_index, left in enumerate(keys):
        for right in keys[left_index + 1:]:
            values.append(abs(pearson(residuals[left], residuals[right])))
    return mean(values)


def build_reject_gate(rows: list[dict[str, Any]], predictions_by_name: dict[str, list[float]], names: list[str], weights: list[float]) -> dict[str, Any]:
    if not rows or not names:
        return {"active": False, "reason": "No model-zoo rows."}
    dispersions = [
        prediction_dispersion([number((predictions_by_name.get(name) or [0.0 for _ in rows])[index]) for name in names], weights)
        for index in range(len(rows))
    ]
    threshold = max(0.75, percentile(dispersions, 0.72))
    accepted_indexes = [index for index, value in enumerate(dispersions) if value <= threshold]
    if len(accepted_indexes) < max(4, int(len(rows) * 0.35)):
        threshold = percentile(dispersions, 0.85)
        accepted_indexes = [index for index, value in enumerate(dispersions) if value <= threshold]
    ensemble_rows = zoo_weight_rows(rows, predictions_by_name, names)
    all_predictions = [prediction_for_weight_vector(row, names, weights) for row in ensemble_rows]
    accepted_predictions = [all_predictions[index] for index in accepted_indexes]
    accepted_rows = [rows[index] for index in accepted_indexes]
    accepted_metrics = evaluate_zoo_candidate(accepted_rows, accepted_predictions)
    all_metrics = evaluate_zoo_candidate(rows, all_predictions)
    return {
        "active": True,
        "framework": "dispersion-abstention-gate",
        "threshold": round(threshold, 4),
        "acceptedSamples": len(accepted_indexes),
        "rejectedSamples": len(rows) - len(accepted_indexes),
        "acceptedRatio": round(len(accepted_indexes) / max(1, len(rows)) * 100, 2),
        "allDirectionHitRate": round(number(all_metrics.get("directionHitRate")), 3),
        "acceptedDirectionHitRate": round(number(accepted_metrics.get("directionHitRate")), 3),
        "acceptedMse": round(number(accepted_metrics.get("mse")), 5),
        "reason": "When model dispersion is high, the live system should lower confidence or refuse high-conviction buy signals instead of forcing a prediction.",
    }


def lightgbm_return_candidate(
    train: list[dict[str, Any]],
    validation: list[dict[str, Any]],
    test: list[dict[str, Any]],
    feature_names: list[str],
    baseline_validation: list[float],
    baseline_test: list[float],
) -> dict[str, Any] | None:
    if len([*train, *validation, *test]) < 80:
        return None
    if str(os.getenv("LOCAL_MODEL_TREE_ENABLED", "false")).strip().lower() != "true":
        return None
    provider = "lightgbm"
    try:
        import lightgbm as lgb  # type: ignore
    except Exception:
        try:
            from sklearn.ensemble import GradientBoostingRegressor  # type: ignore

            class SklearnRegressor:
                @staticmethod
                def LGBMRegressor(**kwargs: Any) -> Any:
                    return GradientBoostingRegressor(
                        n_estimators=int(kwargs.get("n_estimators", 70)),
                        learning_rate=float(kwargs.get("learning_rate", 0.04)),
                        max_depth=int(kwargs.get("max_depth", 3)),
                        random_state=int(kwargs.get("random_state", 37)),
                    )

            lgb = SklearnRegressor()
            provider = "sklearn-gradient-boosting-fallback"
        except Exception:
            return None
    model = lgb.LGBMRegressor(
        n_estimators=70,
        learning_rate=0.04,
        max_depth=3,
        num_leaves=15,
        min_child_samples=12,
        subsample=0.88,
        colsample_bytree=0.82,
        reg_alpha=0.12,
        reg_lambda=0.28,
        random_state=37,
        verbose=-1,
    )
    model.fit(feature_matrix(train, feature_names), [number(row["actual_return"]) for row in train])
    validation_predictions = [float(value) for value in model.predict(feature_matrix(validation, feature_names))]
    test_predictions = [float(value) for value in model.predict(feature_matrix(test, feature_names))]
    return {
        "name": "tree_boosting_return",
        "label": MODEL_ZOO_LABELS["tree_boosting_return"],
        "family": "open_source_tree",
        "kind": "lightgbm_regressor",
        "provider": provider,
        "featureNames": feature_names,
        "validationPredictions": validation_predictions,
        "testPredictions": test_predictions,
        "validation": evaluate_zoo_candidate(validation, validation_predictions, baseline_validation),
        "test": evaluate_zoo_candidate(test, test_predictions, baseline_test),
        "topFeatures": feature_importance_rows(model, feature_names),
        "serializable": False,
        "reason": "Optional LightGBM/sklearn tree challenger; used only if its validation/test evidence supports the ensemble.",
    }


def model_zoo_fold_predictions(
    train: list[dict[str, Any]],
    evaluation: list[dict[str, Any]],
    groups: dict[str, list[str]],
) -> dict[str, list[float]]:
    """Fit only on the earlier fold and score the immediately following fold."""
    predictions: dict[str, list[float]] = {
        "stored_ensemble": [number(row.get("stored_prediction")) for row in evaluation],
    }
    for name in ["technical_ridge", "factor_ridge", "orderflow_profile_ridge", "wide_regularized_ridge"]:
        feature_names = groups[name]
        penalty = 0.12 if name != "wide_regularized_ridge" else 0.2
        model = fit_ridge_regression(train, feature_names, "actual_return", penalty)
        predictions[name] = predict_regression(model, evaluation, feature_names)
    meta_features = groups["target_stop_meta"]
    target_model = fit_logistic(train, meta_features, "target_label", 0.12)
    stop_model = fit_logistic(train, meta_features, "stop_label", 0.12)
    predictions["target_stop_meta"] = target_stop_meta_predictions(target_model, stop_model, evaluation, meta_features)
    predictions["sequence_state_proxy"] = sequence_state_proxy_predictions(evaluation)
    return predictions


def model_zoo_walk_forward_stability(rows: list[dict[str, Any]], groups: dict[str, list[str]]) -> dict[str, Any]:
    """Require more than one later-period regime before a committee may deploy.

    This intentionally checks simple serializable candidates only. Optional tree/deep
    candidates remain challengers in the final holdout, but cannot create a false
    sense of stability from a single favourable split.
    """
    if len(rows) < 72:
        return {
            "available": False,
            "framework": "expanding-walk-forward-model-zoo-stability",
            "sampleCount": len(rows),
            "minSamples": 72,
            "reason": "Need at least 72 resolved samples before judging model-zoo stability across later periods.",
        }
    min_train = max(24, int(len(rows) * 0.42))
    fold_size = max(6, min(24, int(len(rows) * 0.12)))
    candidate_starts = [
        max(min_train, int(len(rows) * fraction))
        for fraction in (0.48, 0.58, 0.68, 0.78, 0.88)
    ]
    folds: list[dict[str, Any]] = []
    stats: dict[str, dict[str, Any]] = {}
    seen_starts: set[int] = set()
    for start in candidate_starts:
        if start in seen_starts:
            continue
        seen_starts.add(start)
        end = min(len(rows), start + fold_size)
        train = rows[:start]
        evaluation = rows[start:end]
        if len(train) < min_train or len(evaluation) < 6:
            continue
        predictions = model_zoo_fold_predictions(train, evaluation, groups)
        baseline = predictions["stored_ensemble"]
        fold_candidates: list[dict[str, Any]] = []
        for name, values in predictions.items():
            metric = evaluate_zoo_candidate(evaluation, values, baseline)
            direction_lift = number(metric.get("directionHitRate")) - number(
                evaluate_zoo_candidate(evaluation, baseline).get("directionHitRate")
            )
            row = {
                "name": name,
                "mseImprovementPct": round(number(metric.get("improvementPct")), 5) if name != "stored_ensemble" else 0.0,
                "directionLiftPct": round(direction_lift, 5) if name != "stored_ensemble" else 0.0,
                "directionHitRate": round(number(metric.get("directionHitRate")), 5),
                "mse": round(number(metric.get("mse")), 5),
            }
            fold_candidates.append(row)
            if name == "stored_ensemble":
                continue
            item = stats.setdefault(name, {
                "name": name,
                "folds": 0,
                "mseImprovement": [],
                "directionLift": [],
                "directionHit": [],
                "positiveJointFolds": 0,
            })
            item["folds"] += 1
            item["mseImprovement"].append(number(metric.get("improvementPct")))
            item["directionLift"].append(direction_lift)
            item["directionHit"].append(number(metric.get("directionHitRate")))
            if number(metric.get("improvementPct")) >= 0 and direction_lift >= 0:
                item["positiveJointFolds"] += 1
        folds.append({
            "trainSamples": len(train),
            "evaluationSamples": len(evaluation),
            "startDate": str(evaluation[0].get("date") or ""),
            "endDate": str(evaluation[-1].get("date") or ""),
            "candidates": fold_candidates,
        })
    candidate_rows: list[dict[str, Any]] = []
    for name, item in stats.items():
        mse_values = item["mseImprovement"]
        direction_values = item["directionLift"]
        positive_mse_pct = mean([1.0 if value >= 0 else 0.0 for value in mse_values]) * 100
        positive_direction_pct = mean([1.0 if value >= 0 else 0.0 for value in direction_values]) * 100
        avg_mse = mean(mse_values)
        avg_direction = mean(direction_values)
        stable = (
            item["folds"] >= 2
            and positive_mse_pct >= 50
            and positive_direction_pct >= 50
            and (avg_mse >= 0 or avg_direction >= 1.0)
        )
        candidate_rows.append({
            "name": name,
            "foldCount": item["folds"],
            "avgMseImprovementPct": round(avg_mse, 5),
            "avgDirectionLiftPct": round(avg_direction, 5),
            "positiveMseFoldPct": round(positive_mse_pct, 5),
            "positiveDirectionFoldPct": round(positive_direction_pct, 5),
            "positiveJointFoldCount": int(item["positiveJointFolds"]),
            "avgDirectionHitRate": round(mean(item["directionHit"]), 5),
            "stable": stable,
        })
    candidate_rows.sort(key=lambda row: (row["stable"], row["avgMseImprovementPct"], row["avgDirectionLiftPct"]), reverse=True)
    stable_rows = [row for row in candidate_rows if row["stable"]]
    avg_mse = mean([row["avgMseImprovementPct"] for row in stable_rows]) if stable_rows else 0.0
    avg_direction = mean([row["avgDirectionLiftPct"] for row in stable_rows]) if stable_rows else 0.0
    stability_score = clamp(
        42
        + min(22, len(stable_rows) * 7)
        + clamp(avg_mse, -10, 14) * 1.1
        + clamp(avg_direction, -6, 10) * 1.7
        + min(10, len(folds) * 2.5),
        0,
        100,
    )
    passed = len(folds) >= 2 and len(stable_rows) >= 2 and stability_score >= 56
    return {
        "available": bool(folds),
        "framework": "expanding-walk-forward-model-zoo-stability",
        "sampleCount": len(rows),
        "foldCount": len(folds),
        "foldSize": fold_size,
        "stableCandidateCount": len(stable_rows),
        "stableCandidateNames": [row["name"] for row in stable_rows],
        "stabilityScore": round(stability_score, 5),
        "pass": passed,
        "candidates": candidate_rows,
        "folds": folds,
        "leakageControl": "Each expanding fold fits its candidates only on rows before the fold and evaluates on the next unseen period.",
        "reason": "Multiple later-period folds support the candidate set." if passed else "Candidate performance is not stable enough across later periods; keep the committee research-only.",
    }


def train_model_zoo(rows: list[dict[str, Any]], market: str = "ASX") -> dict[str, Any]:
    if len(rows) < MODEL_ZOO_MIN_ROWS:
        return {
            "framework": "python-local-model-zoo-committee",
            "market": market,
            "status": "collecting",
            "active": False,
            "researchActive": False,
            "productionEligible": False,
            "sampleCount": len(rows),
            "minSamples": MODEL_ZOO_MIN_ROWS,
            "reason": "Need more resolved point-in-time prediction samples before running model-zoo challenger validation.",
            "externalAdapters": [
                {"id": "qlib_lightgbm", "status": "waiting_samples", "role": "tree challenger"},
                {"id": "qlib_lstm_transformer", "status": "waiting_large_history", "role": "sequence challenger"},
                {"id": "finrl_policy", "status": "adapter_schema_ready", "role": "policy challenger"},
            ],
        }
    train, validation, test = split_supervised_rows(rows)
    if len(train) < 18 or len(validation) < 6 or len(test) < 6:
        return {
            "framework": "python-local-model-zoo-committee",
            "market": market,
            "status": "collecting",
            "active": False,
            "researchActive": False,
            "productionEligible": False,
            "sampleCount": len(rows),
            "minSamples": MODEL_ZOO_MIN_ROWS,
            "splitAudit": split_audit(rows),
            "reason": "Need train/validation/test windows before candidate models can be compared without leakage.",
        }

    groups = model_zoo_feature_groups()
    stability = model_zoo_walk_forward_stability(rows, groups)
    baseline_validation = [number(row.get("stored_prediction")) for row in validation]
    baseline_test = [number(row.get("stored_prediction")) for row in test]
    candidates: list[dict[str, Any]] = [{
        "name": "stored_ensemble",
        "label": MODEL_ZOO_LABELS["stored_ensemble"],
        "family": "current_system",
        "kind": "baseline",
        "featureNames": [],
        "validationPredictions": baseline_validation,
        "testPredictions": baseline_test,
        "validation": evaluate_zoo_candidate(validation, baseline_validation),
        "test": evaluate_zoo_candidate(test, baseline_test),
        "serializable": True,
        "reason": "Current production ensemble forecast recorded at prediction time.",
    }]

    for name in ["technical_ridge", "factor_ridge", "orderflow_profile_ridge", "wide_regularized_ridge"]:
        feature_names = groups[name]
        model = fit_ridge_regression(train, feature_names, "actual_return", 0.12 if name != "wide_regularized_ridge" else 0.2)
        validation_predictions = predict_regression(model, validation, feature_names)
        test_predictions = predict_regression(model, test, feature_names)
        candidates.append({
            "name": name,
            "label": MODEL_ZOO_LABELS[name],
            "family": "local_supervised",
            "kind": "ridge_regression",
            "featureNames": feature_names,
            "validationPredictions": validation_predictions,
            "testPredictions": test_predictions,
            "validation": evaluate_zoo_candidate(validation, validation_predictions, baseline_validation),
            "test": evaluate_zoo_candidate(test, test_predictions, baseline_test),
            "model": serialize_linear_model(model, feature_names),
            "serializable": True,
            "reason": "Regularized linear challenger trained only on the train window and scored on later windows.",
        })

    meta_features = groups["target_stop_meta"]
    target_model = fit_logistic(train, meta_features, "target_label", 0.12)
    stop_model = fit_logistic(train, meta_features, "stop_label", 0.12)
    validation_predictions = target_stop_meta_predictions(target_model, stop_model, validation, meta_features)
    test_predictions = target_stop_meta_predictions(target_model, stop_model, test, meta_features)
    candidates.append({
        "name": "target_stop_meta",
        "label": MODEL_ZOO_LABELS["target_stop_meta"],
        "family": "meta_label",
        "kind": "target_stop_logistic",
        "featureNames": meta_features,
        "validationPredictions": validation_predictions,
        "testPredictions": test_predictions,
        "validation": evaluate_zoo_candidate(validation, validation_predictions, baseline_validation),
        "test": evaluate_zoo_candidate(test, test_predictions, baseline_test),
        "targetModel": serialize_linear_model(target_model, meta_features),
        "stopModel": serialize_linear_model(stop_model, meta_features),
        "targetValidation": evaluate_logistic_head(validation, predict_logistic(target_model, validation, meta_features), "target_label"),
        "stopValidation": evaluate_logistic_head(validation, predict_logistic(stop_model, validation, meta_features), "stop_label", baseline_key="stored_stop_probability"),
        "serializable": True,
        "reason": "Transforms target-before-stop and stop-first probabilities into an expected-return challenger.",
    })

    sequence_validation = sequence_state_proxy_predictions(validation)
    sequence_test = sequence_state_proxy_predictions(test)
    candidates.append({
        "name": "sequence_state_proxy",
        "label": MODEL_ZOO_LABELS["sequence_state_proxy"],
        "family": "sequence_proxy",
        "kind": "formula_proxy",
        "featureNames": groups["sequence_state_proxy"],
        "validationPredictions": sequence_validation,
        "testPredictions": sequence_test,
        "validation": evaluate_zoo_candidate(validation, sequence_validation, baseline_validation),
        "test": evaluate_zoo_candidate(test, sequence_test, baseline_test),
        "serializable": True,
        "reason": "A lightweight LSTM/Transformer proxy using recent trend, pressure, volume, and state features until deep heads have enough data.",
    })

    try:
        tree_candidate = lightgbm_return_candidate(
            train,
            validation,
            test,
            groups["wide_regularized_ridge"],
            baseline_validation,
            baseline_test,
        )
        if tree_candidate:
            candidates.append(tree_candidate)
    except Exception as error:
        candidates.append({
            "name": "tree_boosting_return",
            "label": MODEL_ZOO_LABELS["tree_boosting_return"],
            "family": "open_source_tree",
            "kind": "lightgbm_regressor",
            "status": "training_error",
            "active": False,
            "error": str(error)[:220],
            "validationPredictions": [],
            "testPredictions": [],
            "validation": {"samples": 0},
            "test": {"samples": 0},
            "reason": "Tree challenger failed and was excluded from the ensemble.",
        })

    usable = [
        candidate for candidate in candidates
        if len(candidate.get("validationPredictions") or []) == len(validation)
        and len(candidate.get("testPredictions") or []) == len(test)
    ]
    names = [candidate["name"] for candidate in usable]
    validation_map = {candidate["name"]: candidate["validationPredictions"] for candidate in usable}
    test_map = {candidate["name"]: candidate["testPredictions"] for candidate in usable}
    prior = normalize_weights([
        0.18 if candidate["name"] == "stored_ensemble" else max(0.04, number(candidate.get("validation", {}).get("directionHitRate"), 50) / 100)
        for candidate in usable
    ])
    validation_rows = zoo_weight_rows(validation, validation_map, names)
    penalties = [0.02, 0.06, 0.14, 0.28]
    weight_candidates = []
    for penalty in penalties:
        weights = fit_simplex_ridge_weights(validation_rows, names, prior, penalty)
        metric = evaluate_zoo_ensemble(validation, validation_map, names, weights)
        weight_candidates.append({
            "penalty": penalty,
            "weights": weights,
            "validation": metric,
            "rankScore": number(metric.get("mse"), 999) - number(metric.get("directionHitRate"), 0) * 0.01,
        })
    selected = min(weight_candidates, key=lambda item: number(item["rankScore"], 999))
    selected_weights, double_check_policy = cap_model_zoo_double_check_weights(names, selected["weights"], usable)
    equal_weights = [1.0 / len(names) for _ in names]
    stored_weights = [1.0 if name == "stored_ensemble" else 0.0 for name in names]
    selected_validation = evaluate_zoo_ensemble(validation, validation_map, names, selected_weights)
    selected_test = evaluate_zoo_ensemble(test, test_map, names, selected_weights)
    equal_test = evaluate_zoo_ensemble(test, test_map, names, equal_weights)
    stored_test = evaluate_zoo_ensemble(test, test_map, names, stored_weights)
    equal_improvement = improvement_pct(selected_test.get("mse"), equal_test.get("mse")) or 0.0
    stored_improvement = improvement_pct(selected_test.get("mse"), stored_test.get("mse")) or 0.0
    direction_lift_vs_equal = number(selected_test.get("directionHitRate")) - number(equal_test.get("directionHitRate"))
    direction_lift_vs_stored = number(selected_test.get("directionHitRate")) - number(stored_test.get("directionHitRate"))
    residual_corr = average_residual_correlation(test, test_map, names)
    reject_gate = build_reject_gate(test, test_map, names, selected_weights)
    research_active = (
        len(test) >= 6
        and number(selected_validation.get("directionHitRate"), 0) >= 48
        and (
            equal_improvement >= 1.0
            or stored_improvement >= 1.0
            or direction_lift_vs_equal >= 3.0
            or direction_lift_vs_stored >= 3.0
        )
        and number(selected_test.get("directionHitRate"), 0) >= max(48, min(number(equal_test.get("directionHitRate"), 50), number(stored_test.get("directionHitRate"), 50)) - 1.5)
        and bool(stability.get("pass"))
    )
    production_gate = legacy_production_gate(rows, research_active, stability)
    production_eligible = bool(production_gate["eligible"])
    sample_power = clamp((len(rows) - MODEL_ZOO_MIN_ROWS) / 180, 0.0, 1.0)
    stability_multiplier = clamp(number(stability.get("stabilityScore"), 56.0) / 100.0, 0.5, 1.0) if stability.get("available") else 0.5
    deployment_blend = round((0.18 + sample_power * 0.34) * stability_multiplier, 3) if production_eligible else 0.0
    deployment_weights = {name: round(number(selected_weights[index]), 5) for index, name in enumerate(names)}
    candidate_rows = []
    for candidate in usable:
        name = candidate["name"]
        validation_metric = round_metrics(candidate.get("validation") or {})
        test_metric = round_metrics(candidate.get("test") or {})
        weight = deployment_weights.get(name, 0.0)
        candidate_active = weight > 0.015 and number(test_metric.get("samples"), 0) > 0
        row = {
            "name": name,
            "label": candidate.get("label") or name,
            "family": candidate.get("family") or "model",
            "kind": candidate.get("kind") or "candidate",
            "status": "production_eligible" if production_eligible and candidate_active else "research_active" if research_active and candidate_active else "research_only",
            "active": bool(production_eligible and candidate_active),
            "researchActive": bool(research_active and candidate_active),
            "productionEligible": bool(production_eligible and candidate_active),
            "weight": weight,
            "featureNames": candidate.get("featureNames") or [],
            "validation": validation_metric,
            "test": test_metric,
            "serializable": bool(candidate.get("serializable")),
            "reason": candidate.get("reason") or "",
        }
        if candidate.get("model"):
            row["model"] = candidate["model"]
        if candidate.get("targetModel"):
            row["targetModel"] = candidate["targetModel"]
        if candidate.get("stopModel"):
            row["stopModel"] = candidate["stopModel"]
        if candidate.get("topFeatures"):
            row["topFeatures"] = candidate["topFeatures"]
        if candidate.get("provider"):
            row["provider"] = candidate["provider"]
        candidate_rows.append(row)
    candidate_rows.sort(key=lambda row: (number(row.get("weight")), number(row.get("test", {}).get("directionHitRate"))), reverse=True)
    return {
        "framework": "python-local-model-zoo-committee",
        "market": market,
        "status": "production_eligible" if production_eligible else "research_active" if research_active else "research_only",
        "active": production_eligible,
        "researchActive": research_active,
        "productionEligible": production_eligible,
        "productionGate": production_gate,
        "sampleCount": len(rows),
        "candidateCount": len(usable),
        "activeCandidateCount": sum(1 for row in candidate_rows if row.get("active")),
        "splitAudit": split_audit(rows),
        "selectedLambda": selected["penalty"],
        "deploymentBlend": deployment_blend,
        "deploymentWeights": deployment_weights,
        "doubleCheckPolicy": double_check_policy,
        "validation": round_metrics(selected_validation),
        "test": round_metrics(selected_test),
        "baselines": {
            "equalWeight": round_metrics(equal_test),
            "storedEnsemble": round_metrics(stored_test),
        },
        "testImprovementVsEqualPct": round(equal_improvement, 4),
        "testImprovementVsStoredPct": round(stored_improvement, 4),
        "directionLiftVsEqualPct": round(direction_lift_vs_equal, 4),
        "directionLiftVsStoredPct": round(direction_lift_vs_stored, 4),
        "averageResidualCorrelation": round(residual_corr, 4),
        "stability": stability,
        "rejectGate": reject_gate,
        "standardOutput": [
            "P(target-before-stop)",
            "P(stop-first)",
            "E(final return)",
            "E(max upside touch)",
            "E(max drawdown)",
            "calibration error",
        ],
        "candidates": candidate_rows,
        "externalAdapters": [
            {"id": "qlib_lightgbm", "status": "represented_by_tree_boosting_return" if any(row["name"] == "tree_boosting_return" for row in candidate_rows) else "not_available", "role": "tree challenger"},
            {"id": "qlib_lstm_transformer", "status": "readiness_only_until_large_sequence_cache", "role": "deep sequence challenger"},
            {"id": "finrl_policy", "status": "adapter_schema_ready_not_live_trading", "role": "policy/reward challenger"},
            {"id": "backtrader_vectorbt", "status": "distilled_rules_plus_backtest_benchmark", "role": "indicator/backtest challenger"},
        ],
        "guardrails": [
            "Weights are learned only on the validation window and judged on untouched later test rows.",
            "The model-zoo must also show stable candidate evidence across expanding later-period folds before it may deploy.",
            "Candidates that fail test evidence remain research-only and cannot lift live confidence.",
            "High committee dispersion activates abstention/no-trade pressure instead of forcing a directional call.",
            "Average residual correlation is monitored so redundant models do not create fake confidence.",
        ],
        "reason": (
            f"Model-zoo committee passed OOS and stability validation: test direction {number(selected_test.get('directionHitRate')):.1f}%, MSE lift vs equal {equal_improvement:.1f}%, vs stored {stored_improvement:.1f}%, stability {number(stability.get('stabilityScore')):.0f}."
            if production_eligible
            else f"Model-zoo committee is research/Shadow-only: test direction {number(selected_test.get('directionHitRate')):.1f}%, MSE lift vs equal {equal_improvement:.1f}%, vs stored {stored_improvement:.1f}%; production gate: {', '.join(production_gate['failedChecks']) or 'pending'}"
        ),
    }


def train_local_signal_heads(samples: list[dict[str, Any]], market: str = "ASX") -> dict[str, Any]:
    rows = supervised_rows(samples)
    feature_names = [
        "trend",
        "momentum",
        "change5d",
        "change20d",
        "volumeRatio",
        "rsi",
        "volume",
        "risk",
        "gap",
        "buyPressure",
        "buyPressure5",
        "pressureChange",
        "volumeAccel",
        "profileDistance",
        "liquidityShock",
        "newsCount",
        "factorCount",
        "upsideAgreement",
        "consensusAgreement",
    ]
    factor_names = [
        "factor",
        "analogConfidence",
        "modelConfidence",
        "socialScore",
        "macroScore",
        "sectorScore",
        "flowScore",
        "liquidityScore",
        "relativeStrengthScore",
        "calibrationScore",
        "announcementScore",
        "newsCount",
        "factorCount",
        "upsideAgreement",
        "consensusAgreement",
    ]
    backtest_names = [
        "predictionConfidence",
        "strategyHitProbability",
        "magnitudeHitProbability",
        "projectedFinalReturn",
        "projectedMaxUpside",
        "factor",
        "calibrationScore",
        "buyPressure5",
        "profileDistance",
        "volumeAccel",
        "upsideAgreement",
        "consensusAgreement",
    ]
    stop_names = [
        "predictionConfidence",
        "strategyHitProbability",
        "magnitudeHitProbability",
        "projectedFinalReturn",
        "projectedMaxUpside",
        "risk",
        "volumeRatio",
        "change5d",
        "change20d",
        "rsi",
        "factor",
        "liquidityScore",
        "liquidityShock",
        "buyPressure5",
        "pressureChange",
        "profileDistance",
        "upsideAgreement",
        "consensusAgreement",
    ]
    return {
        "framework": "python-local-supervised-signal-heads",
        "market": market,
        "sampleCount": len(rows),
        "splitAudit": split_audit(rows),
        "featureScoreHead": train_regression_head(rows, "feature_score_head", feature_names),
        "factorScoreHead": train_regression_head(rows, "factor_score_head", factor_names, baseline_key="stored_prediction"),
        "backtestMetaHead": train_logistic_head(rows, "backtest_meta_head", backtest_names, "target_label"),
        "stopRiskHead": train_logistic_head(rows, "stop_risk_head", stop_names, "stop_label", baseline_key="stored_stop_probability"),
        "tradeQualityHead": train_logistic_head(rows, "trade_quality_head", backtest_names, "risk_reward_label"),
        "tripleBarrier": triple_barrier_summary(rows),
        "calibrationDiagnostics": {
            "target": calibration_diagnostics(rows, "stored_target_probability", "target_label"),
            "stop": calibration_diagnostics(rows, "stored_stop_probability", "stop_label"),
        },
        "noTradeGate": no_trade_diagnostics(rows),
        "selfSupervisedLabels": ["actual_return", "max_upside", "max_drawdown", "direction_label", "target_label", "stop_label", "barrier_class", "risk_reward_label"],
    }


def deep_learning_readiness(sample_count: int) -> dict[str, Any]:
    torch_ready = importlib.util.find_spec("torch") is not None
    return {
        "framework": "pytorch_optional_local_heads",
        "torchReady": torch_ready,
        "active": False,
        "productionEligible": False,
        "status": "challenger_research_ready" if torch_ready and sample_count >= 10_000 else "collecting_or_missing_torch",
        "researchMinSamples": 10_000,
        "minSamples": 250_000,
        "sampleCount": sample_count,
        "reason": (
            "PyTorch is importable; TCN/LSTM/Transformer stay Challenger-only until at least 250,000 point-in-time sequences and repeated OOS wins over tree models."
            if torch_ready
            else "PyTorch is not importable in this worker environment; local ridge/logistic heads are used."
        ),
    }


def train_local_ensemble_weights(samples: list[dict[str, Any]], market: str = "ASX") -> dict[str, Any]:
    rows = ensemble_weight_learning_rows(samples)
    if len(rows) < 24:
        return {
            "framework": "python-local-simplex-ridge-ensemble",
            "market": market,
            "status": "collecting",
            "active": False,
            "researchActive": False,
            "productionEligible": False,
            "sampleCount": len(rows),
            "minSamples": 24,
            "reason": "Need at least 24 resolved ensemble samples before replacing engineering prior weights.",
        }
    names = model_names_for_weight_learning(rows)
    if len(names) < 2:
        return {
            "framework": "python-local-simplex-ridge-ensemble",
            "market": market,
            "status": "collecting",
            "active": False,
            "researchActive": False,
            "productionEligible": False,
            "sampleCount": len(rows),
            "minSamples": 24,
            "reason": "Not enough recurrent ensemble models to optimize a stable simplex weight vector.",
        }
    train_end = max(10, math.floor(len(rows) * 0.58))
    validation_end = max(train_end + 5, math.floor(len(rows) * 0.78))
    train = rows[:train_end]
    validation = rows[train_end:validation_end]
    test = rows[validation_end:]
    if len(validation) < 5 or len(test) < 5:
        return {
            "framework": "python-local-simplex-ridge-ensemble",
            "market": market,
            "status": "collecting",
            "active": False,
            "researchActive": False,
            "productionEligible": False,
            "sampleCount": len(rows),
            "minSamples": 32,
            "modelNames": names,
            "reason": "Need separate validation and untouched test windows for weight learning.",
        }
    prior = average_prior_vector(train, names)
    penalties = [0.14, 0.065, 0.025]
    candidates = []
    for penalty in penalties:
        weights = fit_simplex_ridge_weights(train, names, prior, penalty)
        candidates.append({"penalty": penalty, "weights": weights, "validation": evaluate_weight_vector(validation, names, weights)})
    candidates.sort(key=lambda item: number(item["validation"].get("mse"), float("inf")))
    selected = candidates[0]
    deployment_prior = average_prior_vector([*train, *validation], names)
    deployment_weights = fit_simplex_ridge_weights([*train, *validation], names, deployment_prior, selected["penalty"])
    train_metrics = evaluate_weight_vector(train, names, deployment_weights)
    validation_metrics = selected["validation"]
    test_metrics = evaluate_weight_vector(test, names, deployment_weights)
    stored_validation = evaluate_stored_ensemble_forecast(validation)
    stored_test = evaluate_stored_ensemble_forecast(test)
    prior_test = evaluate_weight_vector(test, names, deployment_prior)
    validation_improvement = improvement_pct(validation_metrics.get("mse"), stored_validation.get("mse"))
    test_improvement = improvement_pct(test_metrics.get("mse"), stored_test.get("mse"))
    direction_floor_ok = (
        stored_test.get("directionHitRate") is None
        or number(test_metrics.get("directionHitRate")) >= number(stored_test.get("directionHitRate")) - 2.5
    )
    target_floor_ok = (
        stored_test.get("targetHitRate") is None
        or test_metrics.get("targetHitRate") is None
        or number(test_metrics.get("targetHitRate")) >= number(stored_test.get("targetHitRate")) - 4
    )
    research_active = (
        number(validation_improvement, -999) >= 1
        and number(test_improvement, -999) >= 0.5
        and direction_floor_ok
        and target_floor_ok
    )
    production_gate = legacy_production_gate(supervised_rows(samples), research_active)
    production_eligible = bool(production_gate["eligible"])
    sample_power = clamp((len(rows) - 24) / 120, 0, 1)
    deployment_blend = round(0.35 + sample_power * 0.45, 2) if production_eligible else 0
    weights = {name: round(deployment_weights[index], 5) for index, name in enumerate(names)}
    prior_weights = {name: round(deployment_prior[index], 5) for index, name in enumerate(names)}
    return {
        "framework": "python-local-simplex-ridge-ensemble",
        "market": market,
        "status": "production_eligible" if production_eligible else "research_active" if research_active else "rejected_oos",
        "active": production_eligible,
        "researchActive": research_active,
        "productionEligible": production_eligible,
        "productionGate": production_gate,
        "sampleCount": len(rows),
        "modelCount": len(names),
        "modelNames": names,
        "selectedLambda": selected["penalty"],
        "deploymentBlend": deployment_blend,
        "weights": weights,
        "priorWeights": prior_weights,
        "train": round_metrics(train_metrics),
        "validation": round_metrics(validation_metrics),
        "test": round_metrics(test_metrics),
        "baselines": {
            "storedValidation": round_metrics(stored_validation),
            "storedTest": round_metrics(stored_test),
            "priorTest": round_metrics(prior_test),
        },
        "validationImprovementPct": round(validation_improvement, 2) if validation_improvement is not None else None,
        "testImprovementPct": round(test_improvement, 2) if test_improvement is not None else None,
        "reason": (
            f"Python local model optimized simplex weights improved untouched test MSE by {number(test_improvement):.1f}% versus stored ensemble."
            if production_eligible
            else "Python local weight optimizer is research/Shadow-only and cannot replace live weights until the market-level OOF production gate passes."
            if research_active
            else "Python local model did not beat the stored ensemble on validation/test without weakening direction or target-hit reliability."
        ),
    }


def train_local_model_suite_for_scope(samples: list[dict[str, Any]], market: str = "ASX", scope: str = "market_all") -> dict[str, Any]:
    supervised = supervised_rows(samples)
    ensemble_optimization = train_local_ensemble_weights(samples, market)
    model_zoo = train_model_zoo(supervised, market)
    signal_models = train_local_signal_heads(samples, market)
    production_eligible = bool(model_zoo.get("productionEligible"))
    return {
        "framework": "python-local-quant-model-suite",
        "market": market,
        "horizonScope": scope,
        "sampleCount": len(supervised),
        "deploymentStatus": "production_eligible" if production_eligible else "research_or_shadow_only",
        "productionEligible": production_eligible,
        "productionPolicy": {
            "owner": "market-level-multitask-oof-calibrated-stack",
            "legacyLocalModelsMayVote": production_eligible,
            "explicitEligibilityRequired": True,
            "researchRowsRetained": len(supervised),
            "maxResearchRows": MAX_SUPERVISED_ROWS,
            "reason": "Low-sample local heads remain visible for research but cannot alter live probability, confidence, or ensemble weights.",
        },
        "ensembleWeightOptimization": ensemble_optimization,
        "modelZoo": model_zoo,
        "signalModels": signal_models,
        "lightgbm": train_lightgbm_suite(supervised, market),
        "tripleBarrier": triple_barrier_summary(supervised),
        "splitAudit": split_audit(supervised),
        "calibrationDiagnostics": {
            "target": calibration_diagnostics(supervised, "stored_target_probability", "target_label"),
            "stop": calibration_diagnostics(supervised, "stored_stop_probability", "stop_label"),
        },
        "noTradeGate": no_trade_diagnostics(supervised),
        "deepLearning": deep_learning_readiness(len(supervised)),
        "featureCatalog": FEATURE_CATALOG,
    }


def collecting_horizon_scope(bucket: str, samples: list[dict[str, Any]]) -> dict[str, Any]:
    resolved = supervised_rows(samples)
    return {
        "framework": "python-local-quant-model-suite",
        "horizonScope": bucket,
        "sampleCount": len(resolved),
        "status": "collecting",
        "available": False,
        "minSamples": HORIZON_SCOPE_MIN_ROWS,
        "reason": "Need at least 32 resolved samples in this horizon bucket; market-wide models remain a fallback only.",
    }


def train_local_model_suite(samples: list[dict[str, Any]], market: str = "ASX") -> dict[str, Any]:
    """Train an auditable market fallback plus horizon-specific deployment candidates.

    A 3-day signal and a 30-day signal are distinct targets. The market-wide suite is
    preserved for diagnostics and low-data fallback, while the Node layer selects a
    matching horizon suite only after it has enough resolved examples.
    """
    suite = train_local_model_suite_for_scope(samples, market, "market_all")
    scopes: dict[str, dict[str, Any]] = {}
    for bucket, scoped_samples in horizon_samples_by_bucket(samples).items():
        resolved_count = len(supervised_rows(scoped_samples))
        scopes[bucket] = (
            train_local_model_suite_for_scope(scoped_samples, market, bucket)
            if resolved_count >= HORIZON_SCOPE_MIN_ROWS
            else collecting_horizon_scope(bucket, scoped_samples)
        )
    suite["horizonSuites"] = scopes
    suite["horizonPolicy"] = {
        "framework": "horizon-isolated-local-model-deployment",
        "buckets": {
            "short": "1-7 trading days",
            "mid": "8-25 trading days",
            "long": "26+ trading days",
        },
        "minResolvedSamples": HORIZON_SCOPE_MIN_ROWS,
        "fallback": "Use market-wide evidence only while the matching horizon bucket is still collecting; fallback predictions cannot raise high-conviction buy confidence.",
        "note": "Horizon scopes are separated before fitting weights, coefficients, calibration, and no-trade diagnostics.",
    }
    return suite
