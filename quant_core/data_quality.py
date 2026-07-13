from __future__ import annotations

import math
from datetime import datetime
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


def stddev(values: list[float]) -> float:
    rows = [value for value in values if math.isfinite(value)]
    if len(rows) < 2:
        return 0.0
    center = mean(rows)
    return math.sqrt(sum((value - center) ** 2 for value in rows) / len(rows))


def pct_change(current: float, previous: float) -> float:
    return ((current - previous) / previous * 100.0) if previous else 0.0


def _parse_day(value: Any) -> datetime | None:
    text = str(value or "")[:10]
    try:
        if len(text) == 10 and text[4:5] == "-" and text[7:8] == "-":
            return datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None
    return None


def assess_candle_quality(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Score point-in-time OHLCV rows before model training.

    The scores are intentionally conservative. A low score does not delete a
    row; it lowers the sample weight so the model learns less from suspicious
    data while still preserving chronological continuity.
    """
    qualities: list[dict[str, Any]] = []
    volumes = [max(0.0, number(row.get("volume"))) for row in rows]
    volume20 = []
    for index, _ in enumerate(rows):
        window = volumes[max(0, index - 19):index + 1]
        volume20.append(mean(window) or 0.0)
    stale_streak = 0
    previous_day: datetime | None = None
    for index, row in enumerate(rows):
        close = number(row.get("close"))
        open_value = number(row.get("open"), close)
        high = number(row.get("high"), max(open_value, close))
        low = number(row.get("low"), min(open_value, close))
        volume = max(0.0, number(row.get("volume")))
        previous_close = number(rows[index - 1].get("close")) if index else close
        change = pct_change(close, previous_close) if index else 0.0
        score = 100.0
        flags: list[str] = []

        if close <= 0 or open_value <= 0:
            score -= 70
            flags.append("non_positive_price")
        if high < max(open_value, close) or low > min(open_value, close) or low <= 0:
            score -= 35
            flags.append("ohlc_range_inconsistent")
        if volume <= 0:
            score -= 12
            flags.append("zero_volume")
        elif volume20[index] > 0 and volume / max(1.0, volume20[index]) > 12:
            score -= 8
            flags.append("volume_spike")
        if index and abs(change) >= 35:
            score -= 45
            flags.append("possible_split_or_provider_jump")
        elif index and abs(change) >= 18:
            score -= 20
            flags.append("extreme_return")

        if index and abs(close - previous_close) <= max(1e-9, previous_close * 0.00002):
            stale_streak += 1
        else:
            stale_streak = 0
        if stale_streak >= 4 and volume <= max(1.0, volume20[index]) * 0.15:
            score -= 18
            flags.append("stale_close_low_volume")

        day = _parse_day(row.get("date"))
        if day and previous_day:
            gap_days = (day - previous_day).days
            if gap_days > 10:
                score -= 10
                flags.append("large_calendar_gap")
            if gap_days < 0:
                score -= 45
                flags.append("time_order_violation")
        if day:
            previous_day = day

        quality_score = clamp(score, 5.0, 100.0)
        sample_weight = clamp(quality_score / 100.0, 0.12, 1.0)
        qualities.append({
            "index": index,
            "date": row.get("date"),
            "score": round(quality_score, 3),
            "sampleWeight": round(sample_weight, 5),
            "flags": flags,
            "returnPct": round(change, 5),
            "volumeRatio20": round(volume / max(1.0, volume20[index]), 5) if volume20[index] else 0.0,
        })

    scores = [number(row.get("score")) for row in qualities]
    weights = [number(row.get("sampleWeight")) for row in qualities]
    issue_counts: dict[str, int] = {}
    for row in qualities:
        for flag in row.get("flags") or []:
            issue_counts[flag] = issue_counts.get(flag, 0) + 1
    high_quality = sum(1 for score in scores if score >= 82)
    degraded = sum(1 for score in scores if score < 65)
    return {
        "framework": "point-in-time-candle-quality-gate",
        "rowCount": len(rows),
        "avgScore": round(mean(scores), 3),
        "minScore": round(min(scores), 3) if scores else 0.0,
        "highQualityPct": round(high_quality / len(scores) * 100, 3) if scores else 0.0,
        "degradedRowPct": round(degraded / len(scores) * 100, 3) if scores else 0.0,
        "avgSampleWeight": round(mean(weights), 5),
        "issueCounts": dict(sorted(issue_counts.items(), key=lambda item: (-item[1], item[0]))),
        "grade": "high" if scores and mean(scores) >= 88 and degraded / max(1, len(scores)) <= 0.04 else "usable" if scores and mean(scores) >= 74 else "degraded",
        "rows": qualities,
    }


def label_confidence_for_window(
    rows: list[dict[str, Any]],
    quality_rows: list[dict[str, Any]],
    index: int,
    horizon: int,
    outcome: dict[str, Any],
    target_upside: float,
    stop_loss: float,
) -> dict[str, Any]:
    entry_index = int(number(outcome.get("entryIndex"), index + 1))
    future = quality_rows[entry_index:min(len(quality_rows), entry_index + horizon)]
    current = quality_rows[index] if 0 <= index < len(quality_rows) else {"sampleWeight": 0.5, "flags": []}
    quality_weight = min([number(row.get("sampleWeight"), 0.5) for row in [current, *future]] or [0.5])
    avg_future = mean([number(row.get("sampleWeight"), 0.5) for row in future]) if future else 0.5
    max_upside = number(outcome.get("maxUpside"))
    max_drawdown = abs(number(outcome.get("maxDrawdown")))
    forward_return = number(outcome.get("forwardReturn"))
    target_margin = abs(max_upside - target_upside) / max(0.5, target_upside)
    stop_margin = abs(max_drawdown - stop_loss) / max(0.5, stop_loss)
    ambiguous = target_margin < 0.12 or stop_margin < 0.12
    both_touched = bool(outcome.get("hitTarget")) and bool(outcome.get("hitStop"))
    same_bar_order_unknown = bool(outcome.get("ambiguousBarrierOrder"))

    entry = number(outcome.get("entryPrice"), number(rows[entry_index].get("open")) if 0 <= entry_index < len(rows) else 0.0)
    path = rows[entry_index:min(len(rows), entry_index + horizon)]
    daily_returns: list[float] = []
    cumulative_returns: list[float] = []
    previous_close = entry
    for row in path:
        close = number(row.get("close"), previous_close)
        if previous_close > 0:
            daily_returns.append(pct_change(close, previous_close))
        if entry > 0:
            cumulative_returns.append(pct_change(close, entry))
        previous_close = close
    path_volatility = stddev(daily_returns)
    gross_path_move = sum(abs(value) for value in daily_returns)
    chop_ratio = gross_path_move / max(0.35, abs(forward_return))
    conflict_ratio = min(
        max(0.0, max_upside) / max(0.5, target_upside),
        max(0.0, max_drawdown) / max(0.5, stop_loss),
    )
    sign_flips = 0
    last_sign = 0
    for value in cumulative_returns:
        sign = 1 if value > 0.15 else -1 if value < -0.15 else 0
        if sign and last_sign and sign != last_sign:
            sign_flips += 1
        if sign:
            last_sign = sign
    final_inconclusive = (
        abs(forward_return) <= max(0.35, target_upside * 0.16)
        and (max_upside >= target_upside * 0.45 or max_drawdown >= stop_loss * 0.45)
    )
    high_path_chop = chop_ratio >= 4.5 and gross_path_move >= max(1.2, target_upside * 0.55)
    two_sided_excursion = conflict_ratio >= 0.55

    confidence = 0.34 + quality_weight * 0.42 + avg_future * 0.18
    if ambiguous:
        confidence -= 0.14
    if both_touched:
        confidence -= 0.10
    if same_bar_order_unknown:
        confidence -= 0.18
    if final_inconclusive:
        confidence -= 0.10
    if high_path_chop:
        confidence -= 0.08
    if two_sided_excursion:
        confidence -= min(0.14, conflict_ratio * 0.09)
    if sign_flips >= 2:
        confidence -= min(0.10, sign_flips * 0.025)
    confidence -= min(0.12, max(0.0, path_volatility - 2.8) * 0.018)
    if len(future) < horizon:
        confidence -= 0.16

    flags: list[str] = []
    if ambiguous:
        flags.append("near_barrier_boundary")
    if both_touched:
        flags.append("both_target_and_stop_touched")
    if same_bar_order_unknown:
        flags.append("same_bar_barrier_order_unknown")
    if final_inconclusive:
        flags.append("final_return_inconclusive")
    if high_path_chop:
        flags.append("high_path_chop")
    if two_sided_excursion:
        flags.append("two_sided_excursion")
    if sign_flips >= 2:
        flags.append("frequent_direction_flips")
    if path_volatility >= 4.2:
        flags.append("high_path_volatility")
    if len(future) < horizon:
        flags.append("incomplete_future_window")
    if quality_weight < 0.65:
        flags.append("low_quality_candle_in_window")
    noise_score = clamp(
        (1.0 - clamp(confidence, 0.0, 1.0)) * 72
        + min(18.0, max(0.0, chop_ratio - 2.5) * 2.6)
        + min(16.0, conflict_ratio * 10.0)
        + min(10.0, sign_flips * 1.8)
        + (8.0 if same_bar_order_unknown else 0.0),
        0.0,
        100.0,
    )
    return {
        "labelConfidence": round(clamp(confidence, 0.12, 1.0), 5),
        "qualityWeight": round(quality_weight, 5),
        "futureQualityWeight": round(avg_future, 5),
        "labelNoiseScore": round(noise_score, 5),
        "pathVolatility": round(path_volatility, 5),
        "pathChopRatio": round(chop_ratio, 5),
        "twoSidedExcursionRatio": round(conflict_ratio, 5),
        "directionFlips": sign_flips,
        "flags": flags,
    }
