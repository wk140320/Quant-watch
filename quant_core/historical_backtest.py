from __future__ import annotations

import math
from statistics import median
from typing import Any


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


def pct_change(current: float, previous: float) -> float:
    return ((current - previous) / previous * 100.0) if previous else 0.0


def sanitize_candles(candles: list[dict[str, Any]]) -> list[dict[str, float | str]]:
    rows: list[dict[str, float | str]] = []
    for row in candles or []:
        close = number(row.get("close"), math.nan)
        if not math.isfinite(close) or close <= 0:
            continue
        open_value = number(row.get("open"), close)
        high = max(close, open_value, number(row.get("high"), close))
        low = min(close, open_value, number(row.get("low"), close))
        raw_date = str(row.get("date") or "")
        valid_iso_day = (
            len(raw_date) >= 10
            and raw_date[4:5] == "-"
            and raw_date[7:8] == "-"
            and raw_date[:4].isdigit()
            and raw_date[5:7].isdigit()
            and raw_date[8:10].isdigit()
            and 1 <= int(raw_date[5:7]) <= 12
            and 1 <= int(raw_date[8:10]) <= 31
            and (len(raw_date) == 10 or raw_date[10:11] in {"T", " "})
        )
        date = raw_date[:10] if valid_iso_day else raw_date
        rows.append({
            "date": date,
            "open": open_value,
            "high": high,
            "low": low,
            "close": close,
            "volume": max(0.0, number(row.get("volume"), 0.0)),
        })
    rows = [row for row in rows if len(str(row["date"])) >= 8]
    rows.sort(key=lambda item: str(item["date"]))
    deduped: list[dict[str, float | str]] = []
    seen: set[str] = set()
    for row in rows:
        date = str(row["date"])
        if date in seen:
            deduped[-1] = row
            continue
        seen.add(date)
        deduped.append(row)
    return deduped


def sma(values: list[float], window: int, end: int) -> float:
    if end < 0:
        return values[0] if values else 0.0
    start = max(0, end - window + 1)
    return mean(values[start:end + 1])


def ema_series(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    out = [values[0]]
    for value in values[1:]:
        out.append(value * alpha + out[-1] * (1 - alpha))
    return out


def rsi_at(closes: list[float], end: int, period: int = 14) -> float:
    if end <= 0:
        return 50.0
    start = max(1, end - period + 1)
    gains = []
    losses = []
    for index in range(start, end + 1):
        change = closes[index] - closes[index - 1]
        gains.append(max(0.0, change))
        losses.append(max(0.0, -change))
    avg_gain = mean(gains)
    avg_loss = mean(losses)
    if avg_loss <= 1e-9:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def macd_hist_at(closes: list[float], end: int) -> float:
    usable = closes[:end + 1]
    if len(usable) < 3:
        return 0.0
    ema12 = ema_series(usable, 12)
    ema26 = ema_series(usable, 26)
    macd = [ema12[index] - ema26[index] for index in range(len(usable))]
    signal = ema_series(macd, 9)
    return macd[-1] - signal[-1]


def feature_dict(rows: list[dict[str, float | str]], end: int) -> dict[str, float]:
    closes = [number(row["close"]) for row in rows]
    volumes = [number(row["volume"]) for row in rows]
    close = closes[end]
    sma20 = sma(closes, 20, end) or close
    sma50 = sma(closes, 50, end) or close
    volume20 = sma(volumes, 20, end) or 1.0
    returns = [pct_change(closes[index], closes[index - 1]) for index in range(max(1, end - 19), end + 1)]
    volatility = math.sqrt(mean([value * value for value in returns])) if returns else 0.0
    change1 = pct_change(close, closes[end - 1]) if end >= 1 else 0.0
    change3 = pct_change(close, closes[end - 3]) if end >= 3 else 0.0
    change5 = pct_change(close, closes[end - 5]) if end >= 5 else 0.0
    change10 = pct_change(close, closes[end - 10]) if end >= 10 else 0.0
    change20 = pct_change(close, closes[end - 20]) if end >= 20 else 0.0
    rsi_value = rsi_at(closes, end)
    macd_hist = macd_hist_at(closes, end)
    volume_ratio = volumes[end] / max(1.0, volume20)
    range20 = closes[max(0, end - 20):end + 1]
    high20 = max(range20) if range20 else close
    low20 = min(range20) if range20 else close
    range_position = (close - low20) / max(1e-9, high20 - low20)
    trend_score = clamp(50 + (12 if close > sma20 else -9) + (11 if sma20 > sma50 else -10) + clamp(change20 * 0.62, -9, 9), 0, 100)
    momentum_score = clamp(50 + (macd_hist / close) * 9200 + (rsi_value - 50) * 0.55 + clamp(change5, -6, 6) * 0.35 + clamp(change20 * 0.12, -3, 3), 0, 100)
    risk_score = clamp(82 - volatility * 8, 0, 100)
    return {
        "bias": 1.0,
        "change1": clamp(change1 / 10, -2.5, 2.5),
        "change3": clamp(change3 / 15, -2.5, 2.5),
        "change5": clamp(change5 / 20, -2.5, 2.5),
        "change10": clamp(change10 / 25, -2.5, 2.5),
        "change20": clamp(change20 / 35, -2.5, 2.5),
        "volumeRatio": clamp((volume_ratio - 1) / 3, -2.5, 2.5),
        "rsi": clamp((rsi_value - 50) / 50, -2.0, 2.0),
        "macdHist": clamp((macd_hist / close) * 20, -2.5, 2.5),
        "smaGap": clamp((sma20 / max(1e-9, sma50) - 1) * 8, -2.5, 2.5),
        "volatility": clamp(volatility / 5, 0, 3.0),
        "rangePosition": clamp((range_position - 0.5) * 2, -1.5, 1.5),
        "trendScore": trend_score,
        "momentumScore": momentum_score,
        "riskScore": risk_score,
        "rawChange5": change5,
        "rawChange20": change20,
        "rawVolumeRatio": volume_ratio,
        "rawRsi": rsi_value,
    }


FEATURE_NAMES = [
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
]


def vector_from_feature(feature: dict[str, float]) -> list[float]:
    return [number(feature.get(name)) for name in FEATURE_NAMES]


def outcome_window(rows: list[dict[str, float | str]], index: int, horizon: int, target_upside: float, stop_loss: float) -> dict[str, Any]:
    entry = number(rows[index]["close"])
    end = min(len(rows) - 1, index + horizon)
    if entry <= 0 or end <= index:
        return {"targetWins": False, "stopWins": False, "forwardReturn": 0.0, "maxUpside": 0.0, "maxDrawdown": 0.0}
    max_high = entry
    min_low = entry
    first_event = None
    for offset in range(index + 1, end + 1):
        high_return = pct_change(number(rows[offset]["high"]), entry)
        low_return = pct_change(number(rows[offset]["low"]), entry)
        max_high = max(max_high, number(rows[offset]["high"]))
        min_low = min(min_low, number(rows[offset]["low"]))
        if first_event is None and high_return >= target_upside:
            first_event = "target"
        if first_event is None and low_return <= -stop_loss:
            first_event = "stop"
    max_upside = pct_change(max_high, entry)
    max_drawdown = pct_change(min_low, entry)
    hit_target = max_upside >= target_upside
    hit_stop = max_drawdown <= -stop_loss
    forward_return = pct_change(number(rows[end]["close"]), entry)
    return {
        "targetWins": hit_target and (not hit_stop or first_event == "target"),
        "stopWins": hit_stop and (not hit_target or first_event == "stop"),
        "hitTarget": hit_target,
        "hitStop": hit_stop,
        "forwardReturn": forward_return,
        "maxUpside": max_upside,
        "maxDrawdown": max_drawdown,
        "riskAdjustedReturn": min(max_upside, target_upside) if hit_target and (not hit_stop or first_event == "target") else (-stop_loss if hit_stop and (not hit_target or first_event == "stop") else forward_return),
    }


def build_labeled_rows(rows: list[dict[str, float | str]], horizon: int, target_upside: float, stop_loss: float) -> list[dict[str, Any]]:
    labeled = []
    start = 55
    for end in range(start, len(rows) - horizon):
        feature = feature_dict(rows, end)
        outcome = outcome_window(rows, end, horizon, target_upside, stop_loss)
        labeled.append({
            "index": end,
            "date": rows[end]["date"],
            "x": vector_from_feature(feature),
            "feature": feature,
            "outcome": outcome,
            "y_return": clamp(number(outcome["riskAdjustedReturn"]), -24, 24),
            "y_final": clamp(number(outcome["forwardReturn"]), -24, 24),
            "y_max": clamp(max(0.0, number(outcome["maxUpside"])), 0, 32),
            "y_target": 1.0 if outcome["targetWins"] else 0.0,
            "y_stop": 1.0 if outcome["stopWins"] else 0.0,
        })
    return labeled


def fit_standardizer(samples: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    width = len(samples[0]["x"]) if samples else 0
    centers: list[float] = []
    scales: list[float] = []
    for index in range(width):
        values = [number(row["x"][index]) for row in samples]
        center = mean(values)
        variance = mean([(value - center) ** 2 for value in values])
        centers.append(center)
        scales.append(math.sqrt(variance) or 1.0)
    return centers, scales


def apply_standardizer(x: list[float], centers: list[float], scales: list[float]) -> list[float]:
    return [(number(value) - centers[index]) / max(1e-9, scales[index]) for index, value in enumerate(x)]


def dot(weights: list[float], x: list[float]) -> float:
    return sum(number(weights[index]) * number(value) for index, value in enumerate(x))


def fit_ridge(samples: list[dict[str, Any]], target_key: str, penalty: float = 0.08, epochs: int = 40) -> dict[str, Any]:
    centers, scales = fit_standardizer(samples)
    targets = [number(row[target_key]) for row in samples]
    weights = [0.0 for _ in centers]
    intercept = mean(targets)
    step = 0.028 / max(1, len(weights))
    for _ in range(max(30, int(epochs))):
        grad_w = [2 * penalty * value for value in weights]
        grad_b = 0.0
        for row, target in zip(samples, targets):
            x = apply_standardizer(row["x"], centers, scales)
            error = intercept + dot(weights, x) - target
            grad_b += 2 * error / len(samples)
            for index, value in enumerate(x):
                grad_w[index] += 2 * error * value / len(samples)
        intercept -= step * grad_b
        weights = [weight - step * grad_w[index] for index, weight in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def fit_logistic(samples: list[dict[str, Any]], target_key: str, penalty: float = 0.08, epochs: int = 40) -> dict[str, Any]:
    centers, scales = fit_standardizer(samples)
    targets = [1.0 if number(row[target_key]) >= 0.5 else 0.0 for row in samples]
    base = clamp(mean(targets), 0.02, 0.98)
    intercept = math.log(base / (1 - base))
    weights = [0.0 for _ in centers]
    step = 0.045 / max(1, len(weights))
    for _ in range(max(30, int(epochs))):
        grad_w = [2 * penalty * value for value in weights]
        grad_b = 0.0
        for row, target in zip(samples, targets):
            x = apply_standardizer(row["x"], centers, scales)
            pred = 1 / (1 + math.exp(-clamp(intercept + dot(weights, x), -18, 18)))
            error = pred - target
            grad_b += error / len(samples)
            for index, value in enumerate(x):
                grad_w[index] += error * value / len(samples)
        intercept -= step * grad_b
        weights = [weight - step * grad_w[index] for index, weight in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def predict_linear(model: dict[str, Any], x: list[float]) -> float:
    return number(model["intercept"]) + dot(model["weights"], apply_standardizer(x, model["centers"], model["scales"]))


def predict_logistic(model: dict[str, Any], x: list[float]) -> float:
    return 1 / (1 + math.exp(-clamp(predict_linear(model, x), -18, 18)))


def knn_prediction(train_rows: list[dict[str, Any]], x: list[float], k: int = 18) -> dict[str, float]:
    if not train_rows:
        return {"targetProb": 0.0, "stopProb": 0.0, "return": 0.0, "finalReturn": 0.0, "maxUpside": 0.0}
    centers, scales = fit_standardizer(train_rows)
    target_x = apply_standardizer(x, centers, scales)
    ranked = []
    for row in train_rows:
        row_x = apply_standardizer(row["x"], centers, scales)
        distance = math.sqrt(mean([(row_x[index] - target_x[index]) ** 2 for index in range(len(target_x))]))
        ranked.append((distance, row))
    best = [row for _, row in sorted(ranked, key=lambda item: item[0])[:max(4, min(k, len(ranked)))]]
    return {
        "targetProb": mean([row["y_target"] for row in best]),
        "stopProb": mean([row["y_stop"] for row in best]),
        "return": mean([row["y_return"] for row in best]),
        "finalReturn": mean([row["y_final"] for row in best]),
        "maxUpside": mean([row["y_max"] for row in best]),
        "neighborCount": float(len(best)),
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


def calibration_rows(predictions: list[dict[str, Any]], probability_key: str, actual_key: str) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, float]] = {}
    for row in predictions:
        bucket = probability_bucket(number(row.get(probability_key), 0.0))
        item = buckets.setdefault(bucket, {"count": 0.0, "predicted": 0.0, "actual": 0.0})
        item["count"] += 1
        item["predicted"] += clamp(number(row.get(probability_key)), 0.0, 1.0)
        item["actual"] += 1.0 if row.get(actual_key) else 0.0
    out = []
    for label in ["0-39", "40-49", "50-59", "60-69", "70-79", "80-99"]:
        item = buckets.get(label)
        if not item:
            continue
        count = max(1.0, item["count"])
        out.append({
            "bucket": label,
            "count": int(item["count"]),
            "avgPredicted": round(item["predicted"] / count * 100, 2),
            "observedRate": round(item["actual"] / count * 100, 2),
            "calibrationError": round((item["predicted"] - item["actual"]) / count * 100, 2),
        })
    return out


def summarize_predictions(predictions: list[dict[str, Any]], target_upside: float) -> dict[str, Any]:
    if not predictions:
        return {"samples": 0}
    buy_rows = [row for row in predictions if row["buySignal"]]
    trade_rows = buy_rows or predictions
    direction_hits = [
        (row["predictedReturn"] >= 0 and row["actualFinalReturn"] >= 0)
        or (row["predictedReturn"] < 0 and row["actualFinalReturn"] < 0)
        for row in predictions
    ]
    final_hits = [
        row["actualFinalReturn"] >= abs(row["predictedFinalReturn"]) * 0.82
        if row["predictedFinalReturn"] >= 0
        else row["actualFinalReturn"] <= -abs(row["predictedFinalReturn"]) * 0.82
        for row in predictions
        if abs(row["predictedFinalReturn"]) >= 0.25
    ]
    max_hits = [
        row["actualMaxUpside"] >= max(0.25, row["predictedMaxUpside"] * 0.82)
        for row in predictions
        if row["predictedMaxUpside"] >= 0.25
    ]
    brier_target = mean([(row["targetProbability"] - (1.0 if row["targetWins"] else 0.0)) ** 2 for row in predictions])
    brier_stop = mean([(row["stopProbability"] - (1.0 if row["stopWins"] else 0.0)) ** 2 for row in predictions])
    rejected = [row for row in predictions if not row["buySignal"]]
    return {
        "samples": len(predictions),
        "buySignals": len(buy_rows),
        "noTradeSignals": len(rejected),
        "directionHitRate": mean([1.0 if item else 0.0 for item in direction_hits]) * 100,
        "targetHitRate": mean([1.0 if row["targetWins"] else 0.0 for row in trade_rows]) * 100,
        "stopRate": mean([1.0 if row["stopWins"] else 0.0 for row in trade_rows]) * 100,
        "finalReturnHitRate": mean([1.0 if item else 0.0 for item in final_hits]) * 100 if final_hits else None,
        "maxUpsideHitRate": mean([1.0 if item else 0.0 for item in max_hits]) * 100 if max_hits else None,
        "avgForwardReturn": mean([row["actualFinalReturn"] for row in trade_rows]),
        "avgRiskAdjustedReturn": mean([row["actualRiskAdjustedReturn"] for row in trade_rows]),
        "avgMaxUpside": mean([row["actualMaxUpside"] for row in trade_rows]),
        "avgMaxDrawdown": mean([row["actualMaxDrawdown"] for row in trade_rows]),
        "brierTarget": brier_target,
        "brierStop": brier_stop,
        "acceptedTargetRate": mean([1.0 if row["targetWins"] else 0.0 for row in buy_rows]) * 100 if buy_rows else None,
        "rejectedStopRate": mean([1.0 if row["stopWins"] else 0.0 for row in rejected]) * 100 if rejected else None,
        "targetUpside": target_upside,
        "calibration": {
            "target": calibration_rows(predictions, "targetProbability", "targetWins"),
            "stop": calibration_rows(predictions, "stopProbability", "stopWins"),
        },
    }


METHOD_LABELS = {
    "ridge_final_return": "Ridge final-return head",
    "ridge_risk_adjusted": "Ridge risk-adjusted return head",
    "knn_analog": "KNN historical analog head",
    "trend_momentum": "Trend/momentum technical head",
    "mean_reversion": "RSI mean-reversion head",
    "volume_breakout": "Volume breakout head",
    "risk_guard": "Stop-risk adjusted head",
    "target_probability": "Target-probability return head",
}


def horizon_bucket(horizon: int) -> str:
    days = int(horizon or 15)
    if days <= 7:
        return "short"
    if days <= 25:
        return "mid"
    return "long"


def horizon_label(horizon: int) -> str:
    bucket = horizon_bucket(horizon)
    return {"short": "短期", "mid": "中期", "long": "长期"}.get(bucket, "中期")


def method_predictions(
    feature: dict[str, float],
    analog: dict[str, float],
    *,
    model_return: float,
    model_final: float,
    target_prob: float,
    stop_prob: float,
    target_upside: float,
    stop_loss: float,
) -> dict[str, float]:
    """Return-only model heads for prediction calibration, not trade execution."""
    raw_change5 = number(feature.get("rawChange5"))
    raw_change20 = number(feature.get("rawChange20"))
    raw_rsi = number(feature.get("rawRsi"), 50.0)
    volume_ratio = number(feature.get("rawVolumeRatio"), 1.0)
    macd = number(feature.get("macdHist"))
    trend = number(feature.get("trendScore"), 50.0)
    momentum = number(feature.get("momentumScore"), 50.0)
    risk = number(feature.get("riskScore"), 50.0)
    trend_head = (
        raw_change20 * 0.12
        + raw_change5 * 0.18
        + (trend - 50) * 0.035
        + (momentum - 50) * 0.03
        + macd * 1.6
    )
    mean_reversion_head = (
        clamp((50 - raw_rsi) * 0.075, -4.5, 4.5)
        - raw_change5 * 0.18
        + (0.25 if raw_change20 > -8 else -0.45)
    )
    volume_breakout_head = (
        max(0.0, volume_ratio - 1.0) * 1.35 * (1 if raw_change5 >= 0 else -0.55)
        + raw_change20 * 0.08
        + macd * 1.2
    )
    probability_head = (target_prob - 0.5) * target_upside * 2.2 - max(0.0, stop_prob - 0.36) * stop_loss * 1.25
    risk_guard_head = model_final - stop_prob * stop_loss * 0.9 + (risk - 50) * 0.025
    return {
        "ridge_final_return": clamp(model_final, -18, 18),
        "ridge_risk_adjusted": clamp(model_return, -18, 18),
        "knn_analog": clamp(number(analog.get("finalReturn")), -18, 18),
        "trend_momentum": clamp(trend_head, -18, 18),
        "mean_reversion": clamp(mean_reversion_head, -18, 18),
        "volume_breakout": clamp(volume_breakout_head, -18, 18),
        "risk_guard": clamp(risk_guard_head, -18, 18),
        "target_probability": clamp(probability_head, -18, 18),
    }


def project_simplex(weights: list[float], cap: float = 0.48) -> list[float]:
    values = [max(0.0, number(value)) for value in weights]
    total = sum(values)
    if total <= 1e-12:
        values = [1.0 / max(1, len(values)) for _ in values]
    else:
        values = [value / total for value in values]
    cap = max(0.18, min(1.0, cap))
    for _ in range(4):
        overflow = sum(max(0.0, value - cap) for value in values)
        if overflow <= 1e-9:
            break
        values = [min(value, cap) for value in values]
        receivers = [index for index, value in enumerate(values) if value < cap - 1e-9]
        if not receivers:
            break
        add = overflow / len(receivers)
        for index in receivers:
            values[index] += add
    total = sum(values)
    return [value / total for value in values] if total > 0 else values


def combined_prediction(row: dict[str, Any], names: list[str], weights: list[float]) -> float:
    methods = row.get("methodPredictions") or {}
    return sum(number(methods.get(name)) * number(weights[index]) for index, name in enumerate(names))


def prediction_metrics(rows: list[dict[str, Any]], names: list[str], weights: list[float]) -> dict[str, Any]:
    if not rows:
        return {"samples": 0}
    errors: list[float] = []
    absolute_errors: list[float] = []
    direction_hits: list[float] = []
    target_hits: list[float] = []
    predicted: list[float] = []
    actuals: list[float] = []
    for row in rows:
        pred = combined_prediction(row, names, weights)
        actual = number(row.get("actualFinalReturn"))
        predicted.append(pred)
        actuals.append(actual)
        errors.append((pred - actual) ** 2)
        absolute_errors.append(abs(pred - actual))
        direction_hits.append(1.0 if (pred >= 0 and actual >= 0) or (pred < 0 and actual < 0) else 0.0)
        target_hits.append(1.0 if (pred >= 0 and actual >= max(0.25, pred * 0.72)) or (pred < 0 and actual <= pred * 0.72) else 0.0)
    pred_mean = mean(predicted)
    actual_mean = mean(actuals)
    covariance = mean([(predicted[index] - pred_mean) * (actuals[index] - actual_mean) for index in range(len(rows))])
    pred_var = mean([(value - pred_mean) ** 2 for value in predicted])
    actual_var = mean([(value - actual_mean) ** 2 for value in actuals])
    corr = covariance / math.sqrt(max(1e-9, pred_var * actual_var))
    return {
        "samples": len(rows),
        "mse": mean(errors),
        "mae": mean(absolute_errors),
        "directionHitRate": mean(direction_hits) * 100,
        "magnitudeHitRate": mean(target_hits) * 100,
        "avgPredictedReturn": pred_mean,
        "avgActualReturn": actual_mean,
        "correlation": clamp(corr, -1.0, 1.0),
    }


def fit_prediction_weights(rows: list[dict[str, Any]], names: list[str], penalty: float) -> list[float]:
    if not rows or not names:
        return []
    weights = [1.0 / len(names) for _ in names]
    prior = list(weights)
    lr = 0.0012 / max(1, len(names))
    for _ in range(420):
        gradients = [2 * penalty * (weights[index] - prior[index]) for index in range(len(names))]
        for row in rows:
            methods = row.get("methodPredictions") or {}
            pred = combined_prediction(row, names, weights)
            err = pred - number(row.get("actualFinalReturn"))
            for index, name in enumerate(names):
                gradients[index] += 2 * err * number(methods.get(name)) / len(rows)
        weights = project_simplex([weights[index] - lr * gradients[index] for index in range(len(names))])
    return weights


def optimize_prediction_calibration(predictions: list[dict[str, Any]], horizon: int, target_upside: float) -> dict[str, Any]:
    rows = [
        row for row in predictions
        if isinstance(row.get("methodPredictions"), dict) and math.isfinite(number(row.get("actualFinalReturn"), math.nan))
    ]
    if len(rows) < 24:
        return {
            "available": False,
            "framework": "prediction-method-weight-calibration",
            "status": "collecting",
            "sampleCount": len(rows),
            "minSamples": 24,
            "horizonDays": horizon,
            "horizonBucket": horizon_bucket(horizon),
            "reason": "Not enough historical prediction cuts to fit method weights without overfitting.",
        }
    names = [name for name in METHOD_LABELS if all(name in (row.get("methodPredictions") or {}) for row in rows)]
    if not names:
        return {
            "available": False,
            "framework": "prediction-method-weight-calibration",
            "status": "no_methods",
            "sampleCount": len(rows),
            "horizonDays": horizon,
            "horizonBucket": horizon_bucket(horizon),
            "reason": "No common prediction method columns were available.",
        }
    train_end = max(12, int(len(rows) * 0.58))
    validation_end = max(train_end + 6, int(len(rows) * 0.79))
    validation_end = min(validation_end, len(rows) - 4)
    train_rows = rows[:train_end]
    validation_rows = rows[train_end:validation_end]
    test_rows = rows[validation_end:]
    if len(validation_rows) < 4 or len(test_rows) < 4:
        train_rows = rows[:max(12, int(len(rows) * 0.7))]
        validation_rows = rows[max(12, int(len(rows) * 0.7)):max(16, int(len(rows) * 0.85))]
        test_rows = rows[max(16, int(len(rows) * 0.85)):]
    equal_weights = [1.0 / len(names) for _ in names]
    penalties = [0.0, 0.006, 0.02, 0.06, 0.14, 0.32]
    candidates = []
    for penalty in penalties:
        weights = fit_prediction_weights(train_rows, names, penalty)
        validation = prediction_metrics(validation_rows, names, weights)
        candidates.append({
            "penalty": penalty,
            "weights": weights,
            "validation": validation,
            "rankScore": number(validation.get("mse"), 999) - number(validation.get("directionHitRate"), 0) * 0.012,
        })
    best = min(candidates, key=lambda item: number(item["rankScore"], 999))
    train_metrics = prediction_metrics(train_rows, names, best["weights"])
    validation_metrics = prediction_metrics(validation_rows, names, best["weights"])
    test_metrics = prediction_metrics(test_rows, names, best["weights"])
    equal_test = prediction_metrics(test_rows, names, equal_weights)
    momentum_weights = [0.0 for _ in names]
    if "trend_momentum" in names:
        momentum_weights[names.index("trend_momentum")] = 1.0
    else:
        momentum_weights = list(equal_weights)
    momentum_test = prediction_metrics(test_rows, names, momentum_weights)
    base_mse = number(equal_test.get("mse"), 0)
    learned_mse = number(test_metrics.get("mse"), 0)
    improvement_pct = (base_mse - learned_mse) / base_mse * 100 if base_mse > 1e-9 else 0.0
    direction_lift = number(test_metrics.get("directionHitRate")) - number(equal_test.get("directionHitRate"))
    active = len(test_rows) >= 8 and (
        (improvement_pct >= 2.0 and direction_lift >= -1.0 and number(test_metrics.get("directionHitRate")) >= 50)
        or direction_lift >= 3.0
    )
    deployment_blend = 0.0
    if active:
        deployment_blend = clamp(0.35 + min(0.35, max(0.0, improvement_pct) / 100) + min(0.2, max(0.0, direction_lift) / 100), 0.25, 0.8)
    weights_map = {name: round(number(best["weights"][index]), 5) for index, name in enumerate(names)}
    method_stats = []
    for name in names:
        single = [1.0 if item == name else 0.0 for item in names]
        metric = prediction_metrics(test_rows, names, single)
        method_stats.append({
            "name": name,
            "label": METHOD_LABELS.get(name, name),
            "testMse": round(number(metric.get("mse")), 5),
            "directionHitRate": round(number(metric.get("directionHitRate")), 3),
            "avgPredictedReturn": round(number(metric.get("avgPredictedReturn")), 5),
            "weight": weights_map.get(name, 0),
        })
    method_stats.sort(key=lambda item: (item["weight"], -item["testMse"]), reverse=True)
    reason = (
        f"Optimized weights passed holdout: test MSE improved {improvement_pct:.1f}% and direction lift {direction_lift:.1f}pct."
        if active else
        f"Holdout did not beat equal-weight enough: MSE improvement {improvement_pct:.1f}%, direction lift {direction_lift:.1f}pct; keeping it as research evidence only."
    )
    return {
        "available": True,
        "framework": "prediction-method-weight-calibration",
        "status": "active" if active else "research_only",
        "active": active,
        "sampleCount": len(rows),
        "methodCount": len(names),
        "horizonDays": horizon,
        "horizonBucket": horizon_bucket(horizon),
        "horizonLabel": horizon_label(horizon),
        "targetUpside": target_upside,
        "target": "actual final return over the selected horizon",
        "optimizedWeights": weights_map,
        "deploymentBlend": round(deployment_blend, 4),
        "penalty": best["penalty"],
        "testImprovementPct": round(improvement_pct, 4),
        "directionLiftPct": round(direction_lift, 4),
        "train": {key: round(value, 5) if isinstance(value, float) else value for key, value in train_metrics.items()},
        "validation": {key: round(value, 5) if isinstance(value, float) else value for key, value in validation_metrics.items()},
        "test": {key: round(value, 5) if isinstance(value, float) else value for key, value in test_metrics.items()},
        "baselines": {
            "equalWeight": {key: round(value, 5) if isinstance(value, float) else value for key, value in equal_test.items()},
            "momentumOnly": {key: round(value, 5) if isinstance(value, float) else value for key, value in momentum_test.items()},
        },
        "methodStats": method_stats,
        "split": {
            "trainSamples": len(train_rows),
            "validationSamples": len(validation_rows),
            "testSamples": len(test_rows),
            "mode": "time_ordered_walk_forward_holdout",
        },
        "leakageControl": "Each method prediction is generated from models trained only on labels whose full future horizon ended before the prediction date; weights are fitted on earlier cuts and reported on later holdout cuts.",
        "reason": reason,
    }


def aggregate_prediction_calibrations(results: list[dict[str, Any]], horizon: int | None = None) -> dict[str, Any] | None:
    rows = [
        row.get("predictionCalibration") for row in results
        if row.get("available") and row.get("predictionCalibration", {}).get("available")
    ]
    if horizon is not None:
        rows = [row for row in rows if int(row.get("horizonDays") or 0) == int(horizon)]
    if not rows:
        return None
    total_samples = sum(max(1, int(number(row.get("sampleCount")))) for row in rows)
    weights: dict[str, float] = {}
    for row in rows:
        sample_weight = max(1, int(number(row.get("sampleCount")))) / max(1, total_samples)
        quality = 1.0 + max(0.0, number(row.get("testImprovementPct"))) / 100 + max(0.0, number(row.get("directionLiftPct"))) / 100
        for name, value in (row.get("optimizedWeights") or {}).items():
            weights[name] = weights.get(name, 0.0) + number(value) * sample_weight * quality
    total_weight = sum(max(0.0, value) for value in weights.values()) or 1.0
    weights = {name: round(max(0.0, value) / total_weight, 5) for name, value in weights.items()}
    weighted = lambda key, section="test": (
        sum(number(row.get(section, {}).get(key)) * max(1, int(number(row.get("sampleCount")))) for row in rows)
        / max(1, total_samples)
    )
    active_count = sum(1 for row in rows if row.get("active"))
    return {
        "available": True,
        "framework": "prediction-method-weight-calibration-aggregate",
        "status": "active" if active_count else "research_only",
        "active": bool(active_count),
        "symbolCount": len(rows),
        "activeSymbolCount": active_count,
        "sampleCount": total_samples,
        "horizonDays": horizon or rows[0].get("horizonDays"),
        "horizonBucket": horizon_bucket(int(horizon or rows[0].get("horizonDays") or 15)),
        "horizonLabel": horizon_label(int(horizon or rows[0].get("horizonDays") or 15)),
        "optimizedWeights": weights,
        "test": {
            "mse": round(weighted("mse"), 5),
            "mae": round(weighted("mae"), 5),
            "directionHitRate": round(weighted("directionHitRate"), 4),
            "magnitudeHitRate": round(weighted("magnitudeHitRate"), 4),
            "correlation": round(weighted("correlation"), 5),
        },
        "baselines": {
            "equalWeightDirectionHitRate": round(
                sum(number(row.get("baselines", {}).get("equalWeight", {}).get("directionHitRate")) * max(1, int(number(row.get("sampleCount")))) for row in rows) / max(1, total_samples),
                4,
            ),
            "momentumOnlyDirectionHitRate": round(
                sum(number(row.get("baselines", {}).get("momentumOnly", {}).get("directionHitRate")) * max(1, int(number(row.get("sampleCount")))) for row in rows) / max(1, total_samples),
                4,
            ),
        },
        "reason": "Aggregated across symbols by sample count and holdout quality; used as market-level prediction-weight evidence, not as a trade rule by itself.",
    }


def compact_horizon_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "available": bool(result.get("available")),
        "market": result.get("market"),
        "symbol": result.get("symbol"),
        "horizonDays": result.get("horizonDays"),
        "candleCount": result.get("candleCount"),
        "dateRange": result.get("dateRange"),
        "dataDepth": result.get("dataDepth"),
        "metrics": result.get("metrics"),
        "predictionCalibration": result.get("predictionCalibration"),
        "values": result.get("values"),
        "reason": result.get("reason"),
    }


def run_historical_backtest(
    candles: list[dict[str, Any]],
    *,
    market: str = "ASX",
    symbol: str = "",
    horizon: int = 15,
    target_upside: float = 5.0,
    stop_loss: float = 4.0,
    min_train: int = 120,
    step: int = 1,
    max_predictions: int = 2000,
    retrain_interval: int = 60,
    max_train_window: int = 240,
    knn_window: int = 260,
) -> dict[str, Any]:
    rows = sanitize_candles(candles)
    horizon = max(1, int(horizon or 15))
    target_upside = max(0.5, number(target_upside, 5.0))
    stop_loss = max(0.8, abs(number(stop_loss, 4.0)))
    step = max(1, int(step or 1))
    if len(rows) < min_train + horizon + 40:
        return {
            "available": False,
            "framework": "historical-walk-forward-backtest",
            "market": market,
            "symbol": symbol,
            "candleCount": len(rows),
            "minRequired": min_train + horizon + 40,
            "reason": "Not enough historical candles for point-in-time walk-forward backtest.",
        }

    labeled = build_labeled_rows(rows, horizon, target_upside, stop_loss)
    by_index = {row["index"]: row for row in labeled}
    predictions: list[dict[str, Any]] = []
    model_cache: dict[int, dict[str, Any]] = {}
    candidate_indexes = [
        index
        for index in range(max(70, min_train), len(rows) - horizon, step)
        if index in by_index
    ]
    if len(candidate_indexes) > max_predictions:
        stride = math.ceil(len(candidate_indexes) / max_predictions)
        candidate_indexes = candidate_indexes[::stride]

    train_depths: list[int] = []
    embargo = max(2, math.ceil(horizon / 2))
    for position, index in enumerate(candidate_indexes):
        train_cutoff = index - horizon - embargo
        train_rows = [row for row in labeled if row["index"] <= train_cutoff]
        if len(train_rows) < min_train:
            continue
        train_depths.append(len(train_rows))
        model_train_rows = train_rows[-max(80, int(max_train_window or 520)):]
        knn_train_rows = train_rows[-max(60, int(knn_window or 360)):]
        cache_key = train_rows[-1]["index"] // max(1, retrain_interval)
        if cache_key not in model_cache:
            model_cache[cache_key] = {
                "return": fit_ridge(model_train_rows, "y_return", 0.1),
                "final": fit_ridge(model_train_rows, "y_final", 0.1),
                "max": fit_ridge(model_train_rows, "y_max", 0.1),
                "target": fit_logistic(model_train_rows, "y_target", 0.1),
                "stop": fit_logistic(model_train_rows, "y_stop", 0.1),
            }
        models = model_cache[cache_key]
        current = by_index[index]
        x = current["x"]
        analog = knn_prediction(knn_train_rows, x, 18)
        model_return = predict_linear(models["return"], x)
        model_final = predict_linear(models["final"], x)
        model_max = max(0.0, predict_linear(models["max"], x))
        target_prob = clamp(predict_logistic(models["target"], x) * 0.62 + analog["targetProb"] * 0.38, 0.0, 1.0)
        stop_prob = clamp(predict_logistic(models["stop"], x) * 0.62 + analog["stopProb"] * 0.38, 0.0, 1.0)
        predicted_return = clamp(model_return * 0.58 + analog["return"] * 0.42, -18, 18)
        predicted_final = clamp(model_final * 0.58 + analog["finalReturn"] * 0.42, -18, 18)
        predicted_max = clamp(model_max * 0.58 + analog["maxUpside"] * 0.42, 0, 24)
        methods = method_predictions(
            current["feature"],
            analog,
            model_return=model_return,
            model_final=model_final,
            target_prob=target_prob,
            stop_prob=stop_prob,
            target_upside=target_upside,
            stop_loss=stop_loss,
        )
        buy_signal = (
            target_prob >= 0.56
            and stop_prob <= 0.46
            and predicted_max >= target_upside * 0.45
            and predicted_return > -0.15
        )
        outcome = current["outcome"]
        predictions.append({
            "date": current["date"],
            "index": index,
            "trainSamples": len(train_rows),
            "targetProbability": target_prob,
            "stopProbability": stop_prob,
            "predictedReturn": predicted_return,
            "predictedFinalReturn": predicted_final,
            "predictedMaxUpside": predicted_max,
            "methodPredictions": methods,
            "buySignal": buy_signal,
            "targetWins": bool(outcome["targetWins"]),
            "stopWins": bool(outcome["stopWins"]),
            "actualFinalReturn": number(outcome["forwardReturn"]),
            "actualMaxUpside": number(outcome["maxUpside"]),
            "actualMaxDrawdown": number(outcome["maxDrawdown"]),
            "actualRiskAdjustedReturn": number(outcome["riskAdjustedReturn"]),
        })

    summary = summarize_predictions(predictions, target_upside)
    prediction_calibration = optimize_prediction_calibration(predictions, horizon, target_upside)
    if not predictions:
        return {
            "available": False,
            "framework": "historical-walk-forward-backtest",
            "market": market,
            "symbol": symbol,
            "candleCount": len(rows),
            "reason": "Historical candles existed, but no cut had enough prior fully-known labels.",
        }
    buy_hold_direction = mean([
        1.0 if row["actualFinalReturn"] >= 0 else 0.0
        for row in predictions
    ]) * 100
    momentum_direction = mean([
        1.0 if (
            (by_index[row["index"]]["feature"]["rawChange20"] >= 0 and row["actualFinalReturn"] >= 0)
            or (by_index[row["index"]]["feature"]["rawChange20"] < 0 and row["actualFinalReturn"] < 0)
        ) else 0.0
        for row in predictions
    ]) * 100
    first = rows[0]
    last = rows[-1]
    return {
        "available": True,
        "framework": "historical-walk-forward-backtest",
        "market": market,
        "symbol": symbol,
        "source": "point-in-time-ohlcv-walk-forward",
        "candleCount": len(rows),
        "dateRange": {"start": first["date"], "end": last["date"]},
        "horizonDays": horizon,
        "targetUpside": target_upside,
        "stopLoss": stop_loss,
        "embargoSamples": embargo,
        "minTrainSamples": min_train,
        "step": step,
        "model": {
            "name": "rolling-ridge-logistic-plus-knn-analog",
            "featureCount": len(FEATURE_NAMES),
            "features": FEATURE_NAMES,
            "retrainInterval": retrain_interval,
            "maxTrainWindow": max_train_window,
            "knnWindow": knn_window,
            "leakageControl": "For each historical cut, labels are trained only when their full future window ended before the prediction date, plus embargo.",
            "predictionWeightCalibration": "Return-prediction method weights are trained on earlier prediction cuts and evaluated on later holdout cuts; inactive unless they beat simple baselines.",
        },
        "dataDepth": {
            "labelCount": len(labeled),
            "predictionCuts": len(predictions),
            "trainSamplesMin": min(train_depths) if train_depths else 0,
            "trainSamplesMedian": median(train_depths) if train_depths else 0,
            "trainSamplesMax": max(train_depths) if train_depths else 0,
            "maxPredictions": max_predictions,
        },
        "metrics": {key: (round(value, 5) if isinstance(value, float) and math.isfinite(value) else value) for key, value in summary.items()},
        "benchmarks": [
            {"name": "random_direction", "directionHitRate": 50.0, "note": "Coin-flip baseline."},
            {"name": "buy_hold_direction", "directionHitRate": round(buy_hold_direction, 2), "note": "Always assumes non-negative horizon return."},
            {"name": "simple_20d_momentum_direction", "directionHitRate": round(momentum_direction, 2), "note": "Predicts next direction from prior 20-day return sign."},
        ],
        "predictionCalibration": prediction_calibration,
        "recentPredictions": predictions[-30:],
        "values": {
            "samples": summary.get("buySignals") or summary.get("samples") or 0,
            "hitRate": summary.get("acceptedTargetRate") if summary.get("acceptedTargetRate") is not None else summary.get("targetHitRate"),
            "stopRate": summary.get("stopRate"),
            "avgReturn": summary.get("avgForwardReturn"),
            "directionHitRate": summary.get("directionHitRate"),
            "predictionWeightDirectionHitRate": prediction_calibration.get("test", {}).get("directionHitRate") if prediction_calibration else None,
            "predictionWeightMse": prediction_calibration.get("test", {}).get("mse") if prediction_calibration else None,
            "predictionWeightActive": bool(prediction_calibration.get("active")) if prediction_calibration else False,
            "brierTarget": summary.get("brierTarget"),
            "brierStop": summary.get("brierStop"),
        },
        "thesis": [
            f"Historical walk-forward used {len(predictions)} point-in-time cuts from {len(rows)} real OHLCV candles.",
            f"Each cut trained on fully-known prior labels only; median training depth {median(train_depths) if train_depths else 0} samples, embargo {embargo} candles.",
            f"Accepted buy-signal target hit {summary.get('acceptedTargetRate') if summary.get('acceptedTargetRate') is not None else summary.get('targetHitRate'):.1f}%, stop-first {summary.get('stopRate'):.1f}%, average forward return {summary.get('avgForwardReturn'):.2f}%.",
            f"Prediction-weight calibration ({horizon_label(horizon)}): {prediction_calibration.get('status', 'collecting')} with {prediction_calibration.get('sampleCount', 0)} historical cuts.",
        ],
    }


def batch_historical_backtest(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("items") or []
    results = []
    raw_horizons = payload.get("horizons") or payload.get("horizon_days") or payload.get("horizonDays") or 15
    if isinstance(raw_horizons, list):
        horizons = [max(1, int(number(value, 15))) for value in raw_horizons]
    else:
        horizons = [max(1, int(number(raw_horizons, 15)))]
    main_horizon = max(1, int(number(payload.get("horizon_days", payload.get("horizonDays")), horizons[0] or 15)))
    horizon_set = []
    for value in [main_horizon, *horizons]:
        if value not in horizon_set:
            horizon_set.append(value)
    all_horizon_results: dict[int, list[dict[str, Any]]] = {value: [] for value in horizon_set}
    for item in items:
        horizon_results = []
        for horizon in horizon_set:
            result = run_historical_backtest(
                item.get("candles") or [],
                market=str(item.get("market") or payload.get("market") or "ASX"),
                symbol=str(item.get("symbol") or ""),
                horizon=horizon,
                target_upside=number(payload.get("target_upside", payload.get("targetUpside")), 5.0),
                stop_loss=number(payload.get("stop_loss", payload.get("stopLoss")), 4.0),
                min_train=int(payload.get("min_train", payload.get("minTrain")) or 120),
                step=int(payload.get("step") or 1),
                max_predictions=int(payload.get("max_predictions", payload.get("maxPredictions")) or 2000),
                retrain_interval=int(payload.get("retrain_interval", payload.get("retrainInterval")) or 60),
                max_train_window=int(payload.get("max_train_window", payload.get("maxTrainWindow")) or 240),
                knn_window=int(payload.get("knn_window", payload.get("knnWindow")) or 260),
            )
            all_horizon_results[horizon].append(result)
            horizon_results.append(result)
        main_result = next((row for row in horizon_results if int(row.get("horizonDays") or 0) == main_horizon), horizon_results[0])
        if len(horizon_results) > 1:
            main_result = {**main_result, "horizonResults": [compact_horizon_result(row) for row in horizon_results]}
        results.append(main_result)
    available = [row for row in results if row.get("available")]
    sample_total = sum(int(number(row.get("metrics", {}).get("samples"))) for row in available)
    buy_total = sum(int(number(row.get("metrics", {}).get("buySignals"))) for row in available)
    weighted = lambda key: (
        sum(number(row.get("metrics", {}).get(key)) * max(1, int(number(row.get("metrics", {}).get("samples")))) for row in available)
        / max(1, sum(max(1, int(number(row.get("metrics", {}).get("samples")))) for row in available))
    )
    horizon_calibrations = [
        row for row in (
            aggregate_prediction_calibrations(all_horizon_results.get(horizon, []), horizon)
            for horizon in horizon_set
        )
        if row
    ]
    main_prediction_calibration = next(
        (row for row in horizon_calibrations if int(row.get("horizonDays") or 0) == main_horizon),
        aggregate_prediction_calibrations(results, main_horizon),
    )
    return {
        "framework": "historical-walk-forward-backtest-batch",
        "market": str(payload.get("market") or "ASX"),
        "available": bool(available),
        "symbolCount": len(results),
        "availableCount": len(available),
        "sampleTotal": sample_total,
        "buySignalTotal": buy_total,
        "metrics": {
            "directionHitRate": round(weighted("directionHitRate"), 4) if available else None,
            "targetHitRate": round(weighted("targetHitRate"), 4) if available else None,
            "stopRate": round(weighted("stopRate"), 4) if available else None,
            "avgForwardReturn": round(weighted("avgForwardReturn"), 4) if available else None,
            "brierTarget": round(weighted("brierTarget"), 5) if available else None,
        },
        "predictionCalibration": main_prediction_calibration,
        "horizonCalibrations": horizon_calibrations,
        "modelStorage": {
            "persistRecommended": True,
            "sampleRetention": "append-only local market cache; historical candles and learned weights are reusable because past OHLCV rows are point-in-time stable after adjustment policy is fixed",
        },
        "results": results,
    }
