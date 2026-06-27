from __future__ import annotations

import math
from typing import Any

MAX_ENSEMBLE_ROWS = 600
MAX_SUPERVISED_ROWS = 720
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


def tail_rows(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or len(rows) <= limit:
        return rows
    return rows[-limit:]


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
                "date": str(outcome.get("resolvedAt") or sample.get("resolvedAt") or sample.get("createdAt") or sample.get("asOfDate") or ""),
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
                "date": str(outcome.get("resolvedAt") or sample.get("resolvedAt") or sample.get("createdAt") or sample.get("asOfDate") or ""),
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
    if len(rows) < 48:
        return 0
    return max(2, min(20, math.ceil(len(rows) * DEFAULT_EMBARGO_FRACTION)))


def split_supervised_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    train_end = max(10, math.floor(len(rows) * 0.58))
    validation_end = max(train_end + 5, math.floor(len(rows) * 0.78))
    gap = embargo_gap_for_rows(rows)
    train = rows[:max(0, train_end - gap)]
    validation = rows[min(len(rows), train_end + gap):max(min(len(rows), train_end + gap), validation_end - gap)]
    test = rows[min(len(rows), validation_end + gap):]
    if len(train) < 10 or len(validation) < 5 or len(test) < 5:
        reduced_gap = gap // 2
        train = rows[:max(0, train_end - reduced_gap)]
        validation = rows[min(len(rows), train_end + reduced_gap):max(min(len(rows), train_end + reduced_gap), validation_end - reduced_gap)]
        test = rows[min(len(rows), validation_end + reduced_gap):]
    if len(train) < 10 or len(validation) < 5 or len(test) < 5:
        return rows[:train_end], rows[train_end:validation_end], rows[validation_end:]
    return train, validation, test


def split_audit(rows: list[dict[str, Any]]) -> dict[str, Any]:
    train, validation, test = split_supervised_rows(rows)
    gap = embargo_gap_for_rows(rows)
    return {
        "method": "purged_walk_forward_embargo",
        "sampleCount": len(rows),
        "embargoSamples": gap,
        "trainSamples": len(train),
        "validationSamples": len(validation),
        "testSamples": len(test),
        "note": "Training, validation, and test windows are time-ordered with an embargo gap to reduce overlapping-label leakage.",
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
        return {"name": name, "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 32}
    train, validation, test = split_supervised_rows(rows)
    if len(validation) < 5 or len(test) < 5:
        return {"name": name, "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 40}
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
    active = number(selected["validation"].get("improvementPct"), -999) >= 1 and number(test_metrics.get("improvementPct"), -999) >= 0.5
    return {
        "name": name,
        "kind": "ridge_regression",
        "status": "active" if active else "rejected_oos",
        "active": active,
        "sampleCount": len(rows),
        "featureNames": feature_names,
        "selectedLambda": selected["penalty"],
        "validation": round_metrics(selected["validation"]),
        "test": round_metrics(test_metrics),
        "model": serialize_linear_model(deployment_model, feature_names),
        "reason": "OOS regression head improved over baseline." if active else "Regression head did not beat the existing baseline on validation/test.",
    }


def train_logistic_head(rows: list[dict[str, Any]], name: str, feature_names: list[str], target_key: str, baseline_key: str = "stored_target_probability") -> dict[str, Any]:
    if len(rows) < 32:
        return {"name": name, "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 32}
    train, validation, test = split_supervised_rows(rows)
    if len(validation) < 5 or len(test) < 5:
        return {"name": name, "status": "collecting", "active": False, "sampleCount": len(rows), "minSamples": 40}
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
    active = number(selected["validation"].get("improvementPct"), -999) >= 1 and number(test_metrics.get("improvementPct"), -999) >= 0.5
    return {
        "name": name,
        "kind": "logistic_meta_label",
        "target": target_key,
        "status": "active" if active else "rejected_oos",
        "active": active,
        "sampleCount": len(rows),
        "featureNames": feature_names,
        "selectedLambda": selected["penalty"],
        "validation": round_metrics(selected["validation"]),
        "test": round_metrics(test_metrics),
        "model": serialize_linear_model(deployment_model, feature_names),
        "reason": "OOS logistic head improved over baseline." if active else "Logistic head did not beat the existing probability baseline on validation/test.",
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
    try:
        import torch  # type: ignore  # noqa: F401

        torch_ready = True
    except Exception:
        torch_ready = False
    return {
        "framework": "pytorch_optional_local_heads",
        "torchReady": torch_ready,
        "active": False,
        "status": "ready_waiting_samples" if torch_ready and sample_count >= 180 else "collecting_or_missing_torch",
        "minSamples": 180,
        "sampleCount": sample_count,
        "reason": (
            "PyTorch is importable; deep heads should train only after enough point-in-time samples and should beat ridge/logistic heads OOS."
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
    active = (
        number(validation_improvement, -999) >= 1
        and number(test_improvement, -999) >= 0.5
        and direction_floor_ok
        and target_floor_ok
    )
    sample_power = clamp((len(rows) - 24) / 120, 0, 1)
    deployment_blend = round(0.35 + sample_power * 0.45, 2) if active else 0
    weights = {name: round(deployment_weights[index], 5) for index, name in enumerate(names)}
    prior_weights = {name: round(deployment_prior[index], 5) for index, name in enumerate(names)}
    return {
        "framework": "python-local-simplex-ridge-ensemble",
        "market": market,
        "status": "active" if active else "rejected_oos",
        "active": active,
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
            if active
            else "Python local model did not beat the stored ensemble on validation/test without weakening direction or target-hit reliability."
        ),
    }


def train_local_model_suite(samples: list[dict[str, Any]], market: str = "ASX") -> dict[str, Any]:
    supervised = supervised_rows(samples)
    return {
        "framework": "python-local-quant-model-suite",
        "market": market,
        "ensembleWeightOptimization": train_local_ensemble_weights(samples, market),
        "signalModels": train_local_signal_heads(samples, market),
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
