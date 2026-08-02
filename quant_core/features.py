from __future__ import annotations

import math
import statistics
from typing import Any, Iterable


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def mean(values: Iterable[float]) -> float:
    rows = [number(value) for value in values if math.isfinite(number(value))]
    return sum(rows) / len(rows) if rows else 0.0


def stddev(values: Iterable[float]) -> float:
    rows = [number(value) for value in values if math.isfinite(number(value))]
    return statistics.pstdev(rows) if len(rows) > 1 else 0.0


def pct_change(start: float, end: float) -> float:
    return (end / start - 1) * 100 if start > 0 else 0.0


def sanitize_candles(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in candles or []:
        close = number(raw.get("close"))
        if close <= 0:
            continue
        open_price = number(raw.get("open"), close) or close
        high = max(number(raw.get("high"), close), open_price, close)
        low_candidate = number(raw.get("low"), min(open_price, close))
        low = min(low_candidate if low_candidate > 0 else min(open_price, close), open_price, close)
        raw_levels = raw.get("price_levels") or raw.get("priceLevels") or []
        price_levels: list[dict[str, Any]] = []
        if isinstance(raw_levels, list):
            for level in raw_levels:
                price = number(level.get("price") or level.get("level") or level.get("mid"))
                if price <= 0:
                    continue
                price_levels.append(
                    {
                        "price": price,
                        "buy_volume": max(0.0, number(level.get("buy_volume") or level.get("buyVolume") or level.get("activeBuyVolume"))),
                        "sell_volume": max(0.0, number(level.get("sell_volume") or level.get("sellVolume") or level.get("activeSellVolume"))),
                        "neutral_volume": max(0.0, number(level.get("neutral_volume") or level.get("neutralVolume"))),
                        "buy_trades": max(0.0, number(level.get("buy_trades") or level.get("buyTrades") or level.get("buyCount"))),
                        "sell_trades": max(0.0, number(level.get("sell_trades") or level.get("sellTrades") or level.get("sellCount"))),
                        "neutral_trades": max(0.0, number(level.get("neutral_trades") or level.get("neutralTrades"))),
                        "source": str(level.get("source") or raw.get("orderflowSource") or raw.get("orderflow_source") or ""),
                        "side_method": str(level.get("sideMethod") or level.get("side_method") or raw.get("orderflowSideMethod") or raw.get("orderflow_side_method") or ""),
                    }
                )
        rows.append(
            {
                "date": str(raw.get("date") or raw.get("datetime") or raw.get("timestamp") or ""),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": max(0.0, number(raw.get("volume"))),
                "trade_count": max(0.0, number(raw.get("trade_count") or raw.get("tradeCount"))),
                "active_buy_volume": max(0.0, number(raw.get("active_buy_volume") or raw.get("buyVolume") or raw.get("activeBuyVolume"))),
                "active_sell_volume": max(0.0, number(raw.get("active_sell_volume") or raw.get("sellVolume") or raw.get("activeSellVolume"))),
                "neutral_volume": max(0.0, number(raw.get("neutral_volume") or raw.get("neutralVolume"))),
                "active_buy_count": max(0.0, number(raw.get("active_buy_count") or raw.get("buyTrades") or raw.get("activeBuyTrades"))),
                "active_sell_count": max(0.0, number(raw.get("active_sell_count") or raw.get("sellTrades") or raw.get("activeSellTrades"))),
                "neutral_count": max(0.0, number(raw.get("neutral_count") or raw.get("neutralTrades"))),
                "price_levels": price_levels,
                "orderflow_source": str(raw.get("orderflow_source") or raw.get("orderflowSource") or ""),
                "orderflow_side_method": str(raw.get("orderflow_side_method") or raw.get("orderflowSideMethod") or ""),
                "aggressor_side_available": bool(raw.get("aggressor_side_available") or raw.get("aggressorSideAvailable")),
                "source": str(raw.get("source") or ""),
            }
        )
    return sorted(rows, key=lambda row: row["date"])


def _rolling_mean(values: list[float], end: int, window: int) -> float:
    return mean(values[max(0, end - window + 1) : end + 1])


def _volume_profile(rows: list[dict[str, Any]], bucket_count: int = 18) -> dict[str, Any]:
    if not rows:
        return {"buckets": [], "point_of_control": None, "value_area": None}
    low = min(row["low"] for row in rows)
    high = max(row["high"] for row in rows)
    width = max((high - low) / bucket_count, max(high, 1) * 0.0001)
    buckets = [
        {"low": low + index * width, "high": low + (index + 1) * width, "volume": 0.0, "notional": 0.0}
        for index in range(bucket_count)
    ]
    total_volume = 0.0
    for row in rows:
        price = (row["high"] + row["low"] + row["close"]) / 3
        index = min(bucket_count - 1, max(0, int((price - low) / width)))
        buckets[index]["volume"] += row["volume"]
        buckets[index]["notional"] += row["volume"] * price
        total_volume += row["volume"]
    for bucket in buckets:
        bucket["mid"] = (bucket["low"] + bucket["high"]) / 2
        bucket["share_pct"] = bucket["volume"] / total_volume * 100 if total_volume else 0.0
        for key in ("low", "high", "mid", "volume", "notional", "share_pct"):
            bucket[key] = round(bucket[key], 4)
    ranked = sorted(buckets, key=lambda item: item["volume"], reverse=True)
    point = ranked[0] if ranked else None
    selected: list[dict[str, Any]] = []
    running = 0.0
    for bucket in ranked:
        if total_volume and running / total_volume >= 0.7:
            break
        selected.append(bucket)
        running += bucket["volume"]
    value_area = None
    if selected:
        value_area = {
            "low": min(item["low"] for item in selected),
            "high": max(item["high"] for item in selected),
            "volume_share_pct": running / total_volume * 100 if total_volume else 0.0,
        }
    return {
        "buckets": buckets,
        "point_of_control": point,
        "value_area": value_area,
    }


def _bollinger_series(rows: list[dict[str, Any]], window: int = 20, multiplier: float = 2.0) -> list[dict[str, float]]:
    closes = [row["close"] for row in rows]
    series: list[dict[str, float]] = []
    for index, close in enumerate(closes):
        slice_rows = closes[max(0, index - window + 1) : index + 1]
        middle = mean(slice_rows)
        sigma = stddev(slice_rows)
        upper = middle + multiplier * sigma
        lower = middle - multiplier * sigma
        spread = upper - lower
        percent_b = (close - lower) / spread if spread else 0.5
        bandwidth_pct = spread / middle * 100 if middle else 0.0
        series.append(
            {
                "middle": middle,
                "upper": upper,
                "lower": lower,
                "percent_b": percent_b,
                "bandwidth_pct": bandwidth_pct,
            }
        )
    return series


def _bollinger_snapshot(rows: list[dict[str, Any]]) -> dict[str, Any]:
    series = _bollinger_series(rows)
    latest = series[-1] if series else {"middle": 0.0, "upper": 0.0, "lower": 0.0, "percent_b": 0.5, "bandwidth_pct": 0.0}
    recent_widths = [row["bandwidth_pct"] for row in series[-80:]]
    bandwidth_rank = (
        sum(1 for value in recent_widths if value <= latest["bandwidth_pct"]) / len(recent_widths) * 100
        if recent_widths
        else 50.0
    )
    squeeze_score = clamp(100 - bandwidth_rank, 0, 100)
    return {
        "middle": round(latest["middle"], 6),
        "upper": round(latest["upper"], 6),
        "lower": round(latest["lower"], 6),
        "percent_b": round(latest["percent_b"], 4),
        "bandwidth_pct": round(latest["bandwidth_pct"], 4),
        "bandwidth_rank_pct": round(bandwidth_rank, 1),
        "squeeze_score": round(squeeze_score, 1),
        "state": "squeeze" if squeeze_score >= 75 else "expansion" if bandwidth_rank >= 75 else "normal",
    }


def _fibonacci_snapshot(rows: list[dict[str, Any]], lookback: int = 60) -> dict[str, Any]:
    window = rows[-lookback:] if len(rows) > lookback else rows
    if not window:
        return {"available": False, "reason": "no rows"}
    high_index, high_row = max(enumerate(window), key=lambda item: item[1]["high"])
    low_index, low_row = min(enumerate(window), key=lambda item: item[1]["low"])
    high = high_row["high"]
    low = low_row["low"]
    close = window[-1]["close"]
    span = max(high - low, high * 0.0001)
    upswing = low_index < high_index
    ratios = [0.236, 0.382, 0.5, 0.618, 0.786]
    levels: list[dict[str, Any]] = []
    for ratio in ratios:
        price = high - span * ratio if upswing else low + span * ratio
        levels.append(
            {
                "ratio": ratio,
                "label": f"{ratio * 100:.1f}%",
                "price": round(price, 6),
                "distance_pct": round(pct_change(price, close), 4),
            }
        )
    nearest = min(levels, key=lambda item: abs(item["distance_pct"])) if levels else None
    return {
        "available": True,
        "lookback": len(window),
        "direction": "upswing_retracement" if upswing else "downswing_retracement",
        "swing_high": {"date": high_row["date"], "price": round(high, 6)},
        "swing_low": {"date": low_row["date"], "price": round(low, 6)},
        "span_pct": round(span / close * 100 if close else 0.0, 4),
        "levels": levels,
        "nearest": nearest,
        "fib_618_distance_pct": next((item["distance_pct"] for item in levels if item["label"] == "61.8%"), 0.0),
    }


def _detect_fvg(rows: list[dict[str, Any]], lookback: int = 140) -> list[dict[str, Any]]:
    start = max(0, len(rows) - lookback)
    gaps: list[dict[str, Any]] = []
    for index in range(max(2, start), len(rows)):
        left = rows[index - 2]
        current = rows[index]
        if current["low"] > left["high"]:
            gap_low, gap_high = left["high"], current["low"]
            future = rows[index + 1 :]
            filled = any(row["low"] <= gap_low for row in future)
            gaps.append(
                {
                    "index": index + 1,
                    "date": current["date"],
                    "type": "bullish_fvg",
                    "gap_low": round(gap_low, 6),
                    "gap_high": round(gap_high, 6),
                    "mid": round((gap_low + gap_high) / 2, 6),
                    "size_pct": round((gap_high - gap_low) / max(current["close"], 0.0001) * 100, 4),
                    "status": "filled" if filled else "open",
                    "pressure": 1 if not filled else 0.35,
                }
            )
        if current["high"] < left["low"]:
            gap_low, gap_high = current["high"], left["low"]
            future = rows[index + 1 :]
            filled = any(row["high"] >= gap_high for row in future)
            gaps.append(
                {
                    "index": index + 1,
                    "date": current["date"],
                    "type": "bearish_fvg",
                    "gap_low": round(gap_low, 6),
                    "gap_high": round(gap_high, 6),
                    "mid": round((gap_low + gap_high) / 2, 6),
                    "size_pct": round((gap_high - gap_low) / max(current["close"], 0.0001) * 100, 4),
                    "status": "filled" if filled else "open",
                    "pressure": -1 if not filled else -0.35,
                }
            )
    return gaps[-80:]


def _fvg_pressure(rows: list[dict[str, Any]], lookback: int = 60) -> float:
    gaps = _detect_fvg(rows, lookback)
    recent = gaps[-12:]
    return clamp(sum(number(gap["pressure"]) * number(gap["size_pct"]) for gap in recent), -12, 12)


def _detect_ict_sweeps(rows: list[dict[str, Any]], lookback: int = 120, swing_window: int = 10) -> list[dict[str, Any]]:
    start = max(swing_window, len(rows) - lookback)
    volumes = [row["volume"] for row in rows]
    sweeps: list[dict[str, Any]] = []
    for index in range(start, len(rows)):
        prior = rows[index - swing_window : index]
        if not prior:
            continue
        row = rows[index]
        prior_high = max(item["high"] for item in prior)
        prior_low = min(item["low"] for item in prior)
        volume_base = mean(volumes[max(0, index - 19) : index + 1])
        volume_ratio = row["volume"] / volume_base if volume_base else 0.0
        if row["high"] > prior_high and row["close"] < prior_high:
            depth_pct = (row["high"] - prior_high) / max(row["close"], 0.0001) * 100
            sweeps.append(
                {
                    "index": index + 1,
                    "date": row["date"],
                    "type": "buy_side_liquidity_sweep",
                    "level": round(prior_high, 6),
                    "close": round(row["close"], 6),
                    "depth_pct": round(depth_pct, 4),
                    "volume_ratio": round(volume_ratio, 4),
                    "pressure": round(-depth_pct * max(1.0, volume_ratio), 4),
                }
            )
        if row["low"] < prior_low and row["close"] > prior_low:
            depth_pct = (prior_low - row["low"]) / max(row["close"], 0.0001) * 100
            sweeps.append(
                {
                    "index": index + 1,
                    "date": row["date"],
                    "type": "sell_side_liquidity_sweep",
                    "level": round(prior_low, 6),
                    "close": round(row["close"], 6),
                    "depth_pct": round(depth_pct, 4),
                    "volume_ratio": round(volume_ratio, 4),
                    "pressure": round(depth_pct * max(1.0, volume_ratio), 4),
                }
            )
    return sweeps[-80:]


def _ict_pressure(rows: list[dict[str, Any]], lookback: int = 60) -> float:
    sweeps = _detect_ict_sweeps(rows, lookback)
    return clamp(sum(number(row["pressure"]) for row in sweeps[-10:]), -12, 12)


def _wyckoff_proxy(rows: list[dict[str, Any]], lookback: int = 60) -> dict[str, Any]:
    window = rows[-lookback:] if len(rows) > lookback else rows
    if len(window) < 20:
        return {"phase": "insufficient", "confidence": 0.0, "phase_score": 0.0}
    closes = [row["close"] for row in window]
    volumes = [row["volume"] for row in window]
    high = max(row["high"] for row in window)
    low = min(row["low"] for row in window)
    span = max(high - low, closes[-1] * 0.0001)
    slope_pct = pct_change(closes[0], closes[-1])
    range_position = (closes[-1] - low) / span
    first_volume = mean(volumes[: len(volumes) // 2])
    second_volume = mean(volumes[len(volumes) // 2 :])
    volume_expansion = second_volume / first_volume if first_volume else 1.0
    ranges_pct = [(row["high"] - row["low"]) / max(row["close"], 0.0001) * 100 for row in window]
    compression = 1 - clamp(mean(ranges_pct[-12:]) / max(mean(ranges_pct), 0.0001), 0, 2)
    if slope_pct >= 6 and range_position >= 0.58:
        phase = "markup"
        phase_score = 1.0
    elif slope_pct <= -6 and range_position <= 0.42:
        phase = "markdown"
        phase_score = -1.0
    elif abs(slope_pct) < 6 and range_position <= 0.48:
        phase = "accumulation"
        phase_score = 0.45
    elif abs(slope_pct) < 6 and range_position >= 0.52:
        phase = "distribution"
        phase_score = -0.45
    else:
        phase = "range"
        phase_score = 0.0
    confidence = clamp(abs(slope_pct) * 2.2 + abs(range_position - 0.5) * 55 + max(0, volume_expansion - 1) * 12 + max(0, compression) * 18, 10, 92)
    return {
        "phase": phase,
        "phase_score": round(phase_score, 3),
        "confidence": round(confidence, 1),
        "lookback": len(window),
        "slope_pct": round(slope_pct, 4),
        "range_position": round(range_position, 4),
        "volume_expansion": round(volume_expansion, 4),
        "range_compression": round(compression, 4),
    }


def _orderflow_structure(enriched: list[dict[str, Any]]) -> dict[str, Any]:
    recent = enriched[-20:]
    if not recent:
        return {"pressure": 0.0, "absorption_proxy": 0.0, "effort_vs_result": 0.0}
    pressure = mean(item["imbalance_proxy"] for item in recent)
    absorption_events = [
        item
        for item in recent
        if item["volume_ratio"] >= 1.6 and abs(item["return_pct"]) <= 0.45
    ]
    absorption_proxy = mean(item["volume_ratio"] * (1 - abs(item["return_pct"]) / 0.45) for item in absorption_events) if absorption_events else 0.0
    effort_vs_result = mean(item["volume_ratio"] / (abs(item["return_pct"]) + 0.25) for item in recent)
    return {
        "pressure": round(pressure, 4),
        "absorption_proxy": round(absorption_proxy, 4),
        "effort_vs_result": round(effort_vs_result, 4),
        "recent_window": len(recent),
        "absorption_events": [
            {
                "date": item["date"],
                "return_pct": item["return_pct"],
                "volume_ratio": item["volume_ratio"],
                "imbalance_proxy": item["imbalance_proxy"],
            }
            for item in absorption_events[-12:]
        ],
    }


def analyze_features(
    candles: list[dict[str, Any]],
    market: str = "ASX",
    symbol: str = "",
    source: str = "",
    interval: str = "1d",
) -> dict[str, Any]:
    rows = sanitize_candles(candles)
    if len(rows) < 10:
        raise ValueError("Feature analysis requires at least 10 real candle rows.")

    cumulative_notional = 0.0
    cumulative_volume = 0.0
    enriched: list[dict[str, Any]] = []
    ranges: list[float] = []
    returns: list[float] = []
    illiquidity: list[float] = []
    volumes = [row["volume"] for row in rows]
    has_price_level_footprint = any(row.get("price_levels") for row in rows)
    has_side_totals = any((row.get("active_buy_volume", 0.0) + row.get("active_sell_volume", 0.0)) > 0 for row in rows)
    aggressor_side_available = any(bool(row.get("aggressor_side_available")) for row in rows)

    for index, row in enumerate(rows):
        typical = (row["high"] + row["low"] + row["close"]) / 3
        notional = typical * row["volume"]
        cumulative_notional += notional
        cumulative_volume += row["volume"]
        vwap = cumulative_notional / cumulative_volume if cumulative_volume else typical
        price_range = max(row["high"] - row["low"], row["close"] * 0.0001)
        direction = clamp((row["close"] - row["open"]) / price_range, -1, 1)
        close_location = clamp(((row["close"] - row["low"]) / price_range) * 2 - 1, -1, 1)
        proxy_imbalance = clamp(direction * 0.55 + close_location * 0.45, -1, 1)
        proxy_buy_share = clamp(0.5 + proxy_imbalance * 0.42, 0.05, 0.95)
        price_levels = row.get("price_levels") or []
        level_buy_notional = sum(level["price"] * level["buy_volume"] for level in price_levels)
        level_sell_notional = sum(level["price"] * level["sell_volume"] for level in price_levels)
        level_neutral_notional = sum(level["price"] * level.get("neutral_volume", 0.0) for level in price_levels)
        reported_buy_volume = sum(level["buy_volume"] for level in price_levels) or row.get("active_buy_volume", 0.0)
        reported_sell_volume = sum(level["sell_volume"] for level in price_levels) or row.get("active_sell_volume", 0.0)
        reported_neutral_volume = sum(level.get("neutral_volume", 0.0) for level in price_levels) or row.get("neutral_volume", 0.0)
        reported_buy_count = sum(level["buy_trades"] for level in price_levels) or row.get("active_buy_count", 0.0)
        reported_sell_count = sum(level["sell_trades"] for level in price_levels) or row.get("active_sell_count", 0.0)
        reported_neutral_count = sum(level.get("neutral_trades", 0.0) for level in price_levels) or row.get("neutral_count", 0.0)
        has_reported_side = (reported_buy_volume + reported_sell_volume) > 0
        if has_reported_side:
            active_buy_notional = level_buy_notional or typical * reported_buy_volume
            active_sell_notional = level_sell_notional or typical * reported_sell_volume
            neutral_notional = level_neutral_notional or typical * reported_neutral_volume
            side_total = active_buy_notional + active_sell_notional
            imbalance = clamp((active_buy_notional - active_sell_notional) / side_total, -1, 1) if side_total else proxy_imbalance
            buy_share = active_buy_notional / side_total if side_total else proxy_buy_share
            active_buy_count = round(reported_buy_count) if reported_buy_count > 0 else None
            active_sell_count = round(reported_sell_count) if reported_sell_count > 0 else None
            neutral_count = round(reported_neutral_count) if reported_neutral_count > 0 else None
            orderflow_source = row.get("orderflow_source") or (price_levels[0].get("source") if price_levels else "reported-side-totals")
            side_method = row.get("orderflow_side_method") or (price_levels[0].get("side_method") if price_levels else "reported-side-totals")
        else:
            active_buy_notional = notional * proxy_buy_share
            active_sell_notional = notional * (1 - proxy_buy_share)
            neutral_notional = 0.0
            imbalance = proxy_imbalance
            buy_share = proxy_buy_share
            trade_count = row["trade_count"] if row["trade_count"] > 0 else None
            active_buy_count = round(trade_count * buy_share) if trade_count is not None else None
            active_sell_count = round(trade_count * (1 - buy_share)) if trade_count is not None else None
            neutral_count = None
            orderflow_source = row.get("orderflow_source") or "ohlcv-proxy"
            side_method = "ohlcv_proxy"
        trade_count = row["trade_count"] if row["trade_count"] > 0 else (reported_buy_count + reported_sell_count + reported_neutral_count if has_reported_side else 0.0)
        current_return = pct_change(rows[index - 1]["close"], row["close"]) if index else 0.0
        volume_mean = _rolling_mean(volumes, index, 20)
        volume_ratio = row["volume"] / volume_mean if volume_mean > 0 else 0.0
        ranges.append(price_range / row["close"] * 100)
        returns.append(current_return)
        if notional > 0:
            illiquidity.append(abs(current_return / 100) / notional)
        enriched.append(
            {
                "index": index + 1,
                "date": row["date"],
                "open": round(row["open"], 6),
                "high": round(row["high"], 6),
                "low": round(row["low"], 6),
                "close": round(row["close"], 6),
                "volume": round(row["volume"], 2),
                "trade_count": round(trade_count) if trade_count > 0 else None,
                "notional": round(notional, 2),
                "vwap": round(vwap, 6),
                "return_pct": round(current_return, 4),
                "volume_ratio": round(volume_ratio, 4),
                "close_location": round(close_location, 4),
                "active_buy_notional": round(active_buy_notional, 2),
                "active_sell_notional": round(active_sell_notional, 2),
                "neutral_notional": round(neutral_notional, 2),
                "active_buy_count": active_buy_count,
                "active_sell_count": active_sell_count,
                "neutral_count": neutral_count,
                "imbalance_proxy": round(imbalance, 4),
                "orderflow_source": orderflow_source,
                "orderflow_side_method": side_method,
                "aggressor_side_available": bool(row.get("aggressor_side_available")),
                "price_levels": [
                    {
                        "price": round(level["price"], 6),
                        "buyVolume": round(level["buy_volume"], 4),
                        "sellVolume": round(level["sell_volume"], 4),
                        "neutralVolume": round(level.get("neutral_volume", 0.0), 4),
                        "buyTrades": round(level["buy_trades"]),
                        "sellTrades": round(level["sell_trades"]),
                        "neutralTrades": round(level.get("neutral_trades", 0.0)),
                        "source": level.get("source") or orderflow_source,
                        "sideMethod": level.get("side_method") or side_method,
                    }
                    for level in price_levels
                ],
            }
        )

    latest = enriched[-1]
    profile = _volume_profile(rows[-120:])
    atr_pct = mean(ranges[-14:])
    return_volatility = stddev(returns[-20:])
    recent_imbalance = mean(item["imbalance_proxy"] for item in enriched[-10:])
    recent_volume_ratio = mean(item["volume_ratio"] for item in enriched[-10:])
    vwap_distance = pct_change(latest["vwap"], latest["close"])
    flow_stance = "主动买入占优" if recent_imbalance > 0.12 else "主动卖出占优" if recent_imbalance < -0.12 else "买卖力量接近平衡"
    volume_threshold = max(1.8, mean(item["volume_ratio"] for item in enriched) + stddev(item["volume_ratio"] for item in enriched) * 1.2)
    return_threshold = max(1.2, stddev(returns) * 1.35)
    anomaly_segments = []
    for item in enriched:
        is_breakout = item["return_pct"] >= return_threshold and item["volume_ratio"] >= volume_threshold * 0.75
        is_selloff = item["return_pct"] <= -return_threshold and item["volume_ratio"] >= volume_threshold * 0.75
        is_volume_shock = item["volume_ratio"] >= volume_threshold and abs(item["return_pct"]) >= return_threshold * 0.45
        if is_breakout or is_selloff or is_volume_shock:
            anomaly_segments.append(
                {
                    "index": item["index"],
                    "date": item["date"],
                    "type": "拉升放量" if is_breakout else "下跌放量" if is_selloff else "异常放量",
                    "return_pct": item["return_pct"],
                    "volume_ratio": item["volume_ratio"],
                    "imbalance_proxy": item["imbalance_proxy"],
                    "vwap": item["vwap"],
                    "close": item["close"],
                }
            )
    bollinger = _bollinger_snapshot(rows)
    fibonacci = _fibonacci_snapshot(rows)
    fvg_segments = _detect_fvg(rows)
    ict_sweeps = _detect_ict_sweeps(rows)
    wyckoff = _wyckoff_proxy(rows)
    orderflow = _orderflow_structure(enriched)
    fvg_pressure = _fvg_pressure(rows)
    ict_pressure = _ict_pressure(rows)
    trade_count_available = any(row["trade_count"] > 0 for row in rows)
    granularity = "intraday-candle" if interval != "1d" else "daily-candle"
    if trade_count_available:
        granularity = f"{granularity}-with-trade-count"
    proxy_only = not (has_price_level_footprint or has_side_totals)
    quality_score = clamp(
        45
        + min(25, len(rows) / 8)
        + (10 if has_price_level_footprint else 5 if has_side_totals else 0)
        + (8 if source else 0),
        0,
        100,
    )

    return {
        "market": market,
        "symbol": symbol,
        "source": source,
        "interval": interval,
        "row_count": len(rows),
        "granularity": granularity,
        "true_l2": False,
        "quality": {
            "score": round(quality_score, 1),
            "proxy_only": proxy_only,
            "true_tick_footprint": has_price_level_footprint,
            "side_totals_available": has_side_totals,
            "aggressor_side_available": aggressor_side_available,
            "side_method": "exchange_reported" if aggressor_side_available else "tick_rule_estimate" if has_price_level_footprint else "reported_side_totals" if has_side_totals else "ohlcv_proxy",
            "notes": [
                "已使用真实逐笔成交聚合价位层级；买卖方向为 tick-rule 估算，不等同交易所 aggressor side。"
                if has_price_level_footprint and not aggressor_side_available
                else "已使用数据源返回的主动买卖/逐笔方向字段。"
                if aggressor_side_available
                else "主动买卖为 OHLCV 推断代理，接入逐笔成交后会自动替换为真实成交流。",
                "行情源提供了 K 线成交笔数，但主动买卖拆分仍是代理。"
                if trade_count_available and proxy_only
                else "当前行情源未提供成交笔数。",
                "L2 深度未接入；不会用逐笔或 K线推断 L2。"
                if not aggressor_side_available
                else "真实 L2 仍需单独深度源确认。",
                "所有结果来自真实行情或已保存真实快照，不生成模拟行情。",
            ],
        },
        "summary": {
            "last_close": latest["close"],
            "cumulative_vwap": latest["vwap"],
            "vwap_distance_pct": round(vwap_distance, 3),
            "atr_pct_14": round(atr_pct, 3),
            "return_volatility_20": round(return_volatility, 3),
            "volume_ratio_20": round(latest["volume_ratio"], 3),
            "recent_volume_ratio": round(recent_volume_ratio, 3),
            "orderflow_imbalance_proxy": round(recent_imbalance, 3),
            "orderflow_pressure": orderflow["pressure"],
            "absorption_proxy": orderflow["absorption_proxy"],
            "effort_vs_result": orderflow["effort_vs_result"],
            "amihud_illiquidity": round(mean(illiquidity[-20:]), 12),
            "bollinger_percent_b": bollinger["percent_b"],
            "bollinger_bandwidth_pct": bollinger["bandwidth_pct"],
            "fvg_pressure": round(fvg_pressure, 4),
            "ict_sweep_pressure": round(ict_pressure, 4),
            "wyckoff_phase": wyckoff["phase"],
            "flow_stance": flow_stance,
        },
        "structure": {
            "bollinger": bollinger,
            "fibonacci": fibonacci,
            "fvg": {
                "segments": fvg_segments[-40:],
                "open_count": sum(1 for row in fvg_segments if row["status"] == "open"),
                "pressure": round(fvg_pressure, 4),
            },
            "ict": {
                "liquidity_sweeps": ict_sweeps[-40:],
                "pressure": round(ict_pressure, 4),
            },
            "wyckoff": wyckoff,
            "orderflow_proxy": orderflow,
        },
        "volume_profile": profile,
        "anomaly_segments": anomaly_segments[-80:],
        "formula_book": [
            {"name": "VWAP", "formula": "sum(typical_price * volume) / sum(volume)", "usage": "衡量全周期成交重心，价格偏离 VWAP 可用于判断追高或低位承接。"},
            {"name": "active_buy_notional_proxy", "formula": "notional * clamp(0.5 + orderflow_imbalance_proxy * 0.42, 0.05, 0.95)", "usage": "OHLCV 条件下的主动买入额代理；有真实逐笔方向时应替换。"},
            {"name": "orderflow_imbalance_proxy", "formula": "0.55 * candle_direction + 0.45 * close_location", "usage": "估计 K 线内买卖力量，不等同真实 aggressor side。"},
            {"name": "Amihud illiquidity", "formula": "abs(return) / notional", "usage": "衡量价格对成交额的敏感度，数值越高越容易被资金冲击。"},
            {"name": "volume_profile", "formula": "bucket typical_price by price and aggregate volume/notional", "usage": "寻找成交密集区、POC 和 70% 价值区。"},
            {"name": "Bollinger percent_b", "formula": "(close - lower_band) / (upper_band - lower_band)", "usage": "判断价格在波动带中的位置，配合带宽识别挤压和扩张。"},
            {"name": "Fibonacci retracement", "formula": "swing_high - (swing_high - swing_low) * ratio", "usage": "在最近摆动区间中寻找 38.2/50/61.8 等支撑阻力参考。"},
            {"name": "FVG pressure proxy", "formula": "sum(open_fvg_direction * gap_size_pct)", "usage": "检测三根 K 线未回补的 Fair Value Gap，作为结构不平衡代理。"},
            {"name": "ICT liquidity sweep proxy", "formula": "break prior swing high/low then close back inside range", "usage": "检测扫前高/前低后回收的流动性扫荡，作为反转或诱多诱空信号。"},
            {"name": "Wyckoff phase proxy", "formula": "trend_slope + range_position + volume_expansion + range_compression", "usage": "用 OHLCV 规则近似识别吸筹、拉升、派发、下跌阶段。"},
            {"name": "Effort vs Result", "formula": "mean(volume_ratio / (abs(return_pct) + 0.25))", "usage": "识别放量但价格推进有限的吸收或派发迹象。"},
        ],
        "data_log": enriched,
    }


def _pearson(xs: list[float], ys: list[float]) -> float:
    if len(xs) != len(ys) or len(xs) < 3:
        return 0.0
    avg_x, avg_y = mean(xs), mean(ys)
    numerator = sum((x - avg_x) * (y - avg_y) for x, y in zip(xs, ys))
    denom_x = math.sqrt(sum((x - avg_x) ** 2 for x in xs))
    denom_y = math.sqrt(sum((y - avg_y) ** 2 for y in ys))
    return numerator / (denom_x * denom_y) if denom_x and denom_y else 0.0


def _ranks(values: list[float]) -> list[float]:
    ordered = sorted(enumerate(values), key=lambda item: item[1])
    ranks = [0.0] * len(values)
    cursor = 0
    while cursor < len(ordered):
        end = cursor + 1
        while end < len(ordered) and ordered[end][1] == ordered[cursor][1]:
            end += 1
        rank = (cursor + end - 1) / 2 + 1
        for index in range(cursor, end):
            ranks[ordered[index][0]] = rank
        cursor = end
    return ranks


def _spearman(xs: list[float], ys: list[float]) -> float:
    return _pearson(_ranks(xs), _ranks(ys))


def _percentile(values: list[float], pct: float) -> float:
    rows = sorted(number(value) for value in values if math.isfinite(number(value)))
    if not rows:
        return 0.0
    position = (len(rows) - 1) * clamp(pct, 0.0, 1.0)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return rows[lower]
    return rows[lower] + (rows[upper] - rows[lower]) * (position - lower)


def _quantile_spread(values: list[float], labels: list[float], direction: int, buckets: int = 5) -> float:
    paired = sorted(
        [(number(value), number(label)) for value, label in zip(values, labels) if math.isfinite(number(value)) and math.isfinite(number(label))],
        key=lambda item: item[0],
    )
    if len(paired) < buckets * 4:
        return 0.0
    bucket_size = max(1, len(paired) // buckets)
    low = [label for _, label in paired[:bucket_size]]
    high = [label for _, label in paired[-bucket_size:]]
    return (mean(high) - mean(low)) * (1 if direction >= 0 else -1)


def _turnover_proxy(values: list[float]) -> float:
    if len(values) < 3:
        return 0.0
    scale = stddev(values) or 1.0
    return mean(abs(number(values[index]) - number(values[index - 1])) / scale for index in range(1, len(values)))


def _factor_cluster_map(names: list[str], matrix: dict[str, dict[str, float]], threshold: float = 0.72) -> dict[str, dict[str, Any]]:
    parent = {name: name for name in names}

    def find(name: str) -> str:
        while parent[name] != name:
            parent[name] = parent[parent[name]]
            name = parent[name]
        return name

    def union(left: str, right: str) -> None:
        root_left = find(left)
        root_right = find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for left_index, left in enumerate(names):
        for right in names[left_index + 1:]:
            if abs(number(matrix.get(left, {}).get(right))) >= threshold:
                union(left, right)

    grouped: dict[str, list[str]] = {}
    for name in names:
        grouped.setdefault(find(name), []).append(name)
    cluster_lookup: dict[str, dict[str, Any]] = {}
    for cluster_index, members in enumerate(grouped.values(), start=1):
        cluster_id = f"cluster-{cluster_index}"
        for name in members:
            cluster_lookup[name] = {
                "cluster": cluster_id,
                "members": sorted(members),
                "size": len(members),
            }
    return cluster_lookup


def _factor_prediction_metrics(predictions: list[float], actuals: list[float], cost_bps: float = 18.0) -> dict[str, float]:
    if not predictions or not actuals:
        return {"samples": 0, "mae": 0.0, "mase": 0.0, "rmse": 0.0, "direction_hit_rate_pct": 0.0, "ic": 0.0, "rank_ic": 0.0, "avg_net_signal_return_pct": 0.0}
    rows = list(zip(predictions, actuals))
    errors = [prediction - actual for prediction, actual in rows]
    hits = sum(1 for prediction, actual in rows if (prediction >= 0 and actual >= 0) or (prediction < 0 and actual < 0))
    naive_scale = mean(abs(actuals[index] - actuals[index - 1]) for index in range(1, len(actuals))) if len(actuals) > 1 else 0.0
    mae = mean(abs(error) for error in errors)
    one_way_cost_pct = max(0.0, number(cost_bps)) / 100.0
    net_signal_returns = [
        (actual if prediction >= 0 else -actual) - one_way_cost_pct
        for prediction, actual in rows
    ]
    return {
        "samples": len(rows),
        "mae": round(mae, 4),
        "mase": round(mae / max(1e-9, naive_scale), 4) if naive_scale > 0 else 0.0,
        "rmse": round(math.sqrt(mean(error * error for error in errors)), 4),
        "direction_hit_rate_pct": round(hits / len(rows) * 100, 2),
        "ic": round(_pearson(predictions, actuals), 4),
        "rank_ic": round(_spearman(predictions, actuals), 4),
        "avg_net_signal_return_pct": round(mean(net_signal_returns), 5),
        "cost_bps": round(max(0.0, number(cost_bps)), 3),
    }


def _fit_factor_ridge(
    factor_series: dict[str, list[float]],
    labels: list[float],
    names: list[str],
    train_indexes: list[int],
    penalty: float,
    epochs: int = 90,
) -> dict[str, Any]:
    centers = {name: mean(factor_series[name][index] for index in train_indexes) for name in names}
    scales = {name: stddev(factor_series[name][index] for index in train_indexes) or 1.0 for name in names}
    label_center = mean(labels[index] for index in train_indexes)
    label_scale = stddev(labels[index] for index in train_indexes) or 1.0
    weights = [0.0] * len(names)
    bias = 0.0
    learning_rate = 0.035

    def normalized_vector(index: int) -> list[float]:
        return [
            clamp((factor_series[name][index] - centers[name]) / scales[name], -6, 6)
            for name in names
        ]

    for epoch in range(epochs):
        decay = 1.0 / (1.0 + epoch * 0.015)
        for index in train_indexes:
            x = normalized_vector(index)
            target = clamp((labels[index] - label_center) / label_scale, -6, 6)
            prediction = bias + sum(weight * value for weight, value in zip(weights, x))
            error = prediction - target
            for position, value in enumerate(x):
                gradient = error * value + penalty * weights[position]
                weights[position] -= learning_rate * decay * clamp(gradient, -4, 4)
            bias -= learning_rate * decay * clamp(error, -4, 4)

    def predict(index: int) -> float:
        normalized = bias + sum(weight * value for weight, value in zip(weights, normalized_vector(index)))
        return normalized * label_scale + label_center

    return {
        "weights": weights,
        "bias": bias,
        "centers": centers,
        "scales": scales,
        "label_center": label_center,
        "label_scale": label_scale,
        "predict": predict,
    }


def _equal_factor_baseline(
    factor_series: dict[str, list[float]],
    labels: list[float],
    names: list[str],
    train_indexes: list[int],
    test_indexes: list[int],
) -> list[float]:
    directions = {
        name: 1 if _pearson([factor_series[name][index] for index in train_indexes], [labels[index] for index in train_indexes]) >= 0 else -1
        for name in names
    }
    centers = {name: mean(factor_series[name][index] for index in train_indexes) for name in names}
    scales = {name: stddev(factor_series[name][index] for index in train_indexes) or 1.0 for name in names}
    train_predictions = []
    for index in train_indexes:
        train_predictions.append(mean(
            clamp((factor_series[name][index] - centers[name]) / scales[name], -6, 6) * directions[name]
            for name in names
        ))
    scale = (stddev(labels[index] for index in train_indexes) or 1.0) / (stddev(train_predictions) or 1.0)
    center = mean(labels[index] for index in train_indexes)
    pred_center = mean(train_predictions)
    return [
        (mean(
            clamp((factor_series[name][index] - centers[name]) / scales[name], -6, 6) * directions[name]
            for name in names
        ) - pred_center) * scale + center
        for index in test_indexes
    ]


def _factor_walk_forward_folds(
    factor_series: dict[str, list[float]],
    labels: list[float],
    names: list[str],
    horizon: int,
    penalty: float,
    fold_count: int = 5,
) -> list[dict[str, Any]]:
    sample_count = len(labels)
    purge = max(1, horizon)
    first_test = max(60 + purge, int(sample_count * 0.45))
    available = sample_count - first_test
    fold_size = max(8, available // max(1, fold_count))
    folds: list[dict[str, Any]] = []
    for fold in range(fold_count):
        test_start = first_test + fold * fold_size
        test_end = sample_count if fold == fold_count - 1 else min(sample_count, test_start + fold_size)
        train_end = test_start - purge
        if train_end < 55 or test_end - test_start < 8:
            continue
        train_indexes = list(range(train_end))
        test_indexes = list(range(test_start, test_end))
        model = _fit_factor_ridge(factor_series, labels, names, train_indexes, penalty)
        predictions = [model["predict"](index) for index in test_indexes]
        metrics = _factor_prediction_metrics(predictions, [labels[index] for index in test_indexes])
        folds.append({
            "fold": fold + 1,
            "train": len(train_indexes),
            "test": len(test_indexes),
            "test_start": test_start,
            "test_end": test_end,
            **metrics,
            "positive": metrics["rank_ic"] > 0 and metrics["avg_net_signal_return_pct"] > 0,
        })
    return folds


def _factor_ml_combo_validation(
    factor_series: dict[str, list[float]],
    labels: list[float],
    horizon: int,
    candidate_names: list[str] | None = None,
) -> dict[str, Any]:
    names = [name for name in (candidate_names or list(factor_series)) if name in factor_series]
    sample_count = len(labels)
    purge = max(1, horizon)
    embargo = max(2, horizon // 3)
    train_end = int(sample_count * 0.62)
    validation_start = train_end + purge
    validation_end = int(sample_count * 0.80)
    test_start = validation_end + embargo
    if len(names) < 2 or train_end < 55 or validation_end - validation_start < 10 or sample_count - test_start < 10:
        return {
            "available": False,
            "framework": "factor-ridge-ml-combination",
            "reason": "Not enough samples or factors for purged train/validation/test factor-combo learning.",
            "sample_count": sample_count,
            "factor_count": len(names),
        }

    train_indexes = list(range(0, train_end))
    validation_indexes = list(range(validation_start, validation_end))
    test_indexes = list(range(test_start, sample_count))
    selected: dict[str, Any] | None = None
    for penalty in [0.01, 0.03, 0.08, 0.16, 0.32, 0.64]:
        model = _fit_factor_ridge(factor_series, labels, names, train_indexes, penalty)
        predictions = [model["predict"](index) for index in validation_indexes]
        metrics = _factor_prediction_metrics(predictions, [labels[index] for index in validation_indexes])
        score = metrics["direction_hit_rate_pct"] + max(0.0, metrics["ic"]) * 35 - metrics["mae"] * 1.6
        candidate = {"penalty": penalty, "model": model, "validation": metrics, "score": score}
        if selected is None or candidate["score"] > selected["score"]:
            selected = candidate
    assert selected is not None

    deployment_train = list(range(0, validation_end))
    deployment = _fit_factor_ridge(factor_series, labels, names, deployment_train, selected["penalty"], epochs=110)
    test_predictions = [deployment["predict"](index) for index in test_indexes]
    test_actuals = [labels[index] for index in test_indexes]
    equal_predictions = _equal_factor_baseline(factor_series, labels, names, deployment_train, test_indexes)
    momentum_name = "momentum_20" if "momentum_20" in names else names[0]
    momentum_direction = 1 if _pearson(
        [factor_series[momentum_name][index] for index in deployment_train],
        [labels[index] for index in deployment_train],
    ) >= 0 else -1
    momentum_center = mean(factor_series[momentum_name][index] for index in deployment_train)
    momentum_scale = stddev(factor_series[momentum_name][index] for index in deployment_train) or 1.0
    label_center = mean(labels[index] for index in deployment_train)
    label_scale = stddev(labels[index] for index in deployment_train) or 1.0
    momentum_predictions = [
        ((factor_series[momentum_name][index] - momentum_center) / momentum_scale) * momentum_direction * label_scale * 0.35 + label_center
        for index in test_indexes
    ]
    test_metrics = _factor_prediction_metrics(test_predictions, test_actuals)
    equal_metrics = _factor_prediction_metrics(equal_predictions, test_actuals)
    momentum_metrics = _factor_prediction_metrics(momentum_predictions, test_actuals)
    walk_forward_folds = _factor_walk_forward_folds(
        factor_series,
        labels,
        names,
        horizon,
        selected["penalty"],
        fold_count=5,
    )
    positive_folds = sum(1 for fold in walk_forward_folds if fold.get("positive"))
    direction_lift = test_metrics["direction_hit_rate_pct"] - max(50.0, equal_metrics["direction_hit_rate_pct"], momentum_metrics["direction_hit_rate_pct"])
    mae_lift = min(equal_metrics["mae"], momentum_metrics["mae"]) - test_metrics["mae"]
    baseline_mae = min(equal_metrics["mae"], momentum_metrics["mae"])
    independent_test_blocks = len(test_indexes) / max(1, horizon)
    admission_checks = {
        "independentTestBlocks": independent_test_blocks >= 12,
        "directionLift": direction_lift >= 1.0,
        "maeImprovement": mae_lift > 0 and mae_lift / max(1e-9, baseline_mae) >= 0.01,
        "positiveIc": test_metrics["ic"] > 0,
        "positiveRankIc": test_metrics["rank_ic"] > 0,
        "validationIc": number(selected["validation"].get("ic")) > 0,
        "validationRankIc": number(selected["validation"].get("rank_ic")) > 0,
        "walkForwardFoldCount": len(walk_forward_folds) >= 5,
        "walkForwardStability": positive_folds >= 4,
        "netCostImprovement": test_metrics["avg_net_signal_return_pct"] > max(
            equal_metrics["avg_net_signal_return_pct"],
            momentum_metrics["avg_net_signal_return_pct"],
        ),
    }
    active = all(admission_checks.values())
    abs_total = sum(abs(weight) for weight in deployment["weights"]) or 1.0
    coefficients = [
        {
            "name": name,
            "coefficient": round(deployment["weights"][index], 6),
            "abs_weight_pct": round(abs(deployment["weights"][index]) / abs_total * 100, 2),
            "direction": "positive" if deployment["weights"][index] >= 0 else "negative",
        }
        for index, name in enumerate(names)
    ]
    coefficients.sort(key=lambda row: row["abs_weight_pct"], reverse=True)
    return {
        "available": True,
        "active": active,
        "framework": "factor-ridge-ml-combination",
        "method": "Purged chronological train/validation/test ridge factor-combination model; penalty selected on validation only.",
        "sample_count": sample_count,
        "factor_count": len(names),
        "horizon_days": horizon,
        "purge_samples": purge,
        "embargo_samples": embargo,
        "split": {
            "train": len(train_indexes),
            "validation": len(validation_indexes),
            "test": len(test_indexes),
            "rule": "validation/test rows occur after train rows; labels inside the prediction horizon are purged before the next split.",
        },
        "selected_penalty": selected["penalty"],
        "validation": selected["validation"],
        "test": test_metrics,
        "benchmarks": [
            {"name": "random_direction", "direction_hit_rate_pct": 50.0},
            {"name": "equal_weight_quality_factors", **equal_metrics},
            {"name": f"single_{momentum_name}", **momentum_metrics},
        ],
        "direction_lift_pct": round(direction_lift, 3),
        "mae_lift_pct": round(mae_lift, 4),
        "mae_lift_relative_pct": round(mae_lift / max(1e-9, baseline_mae) * 100, 4),
        "independent_test_blocks": round(independent_test_blocks, 3),
        "walk_forward_folds": walk_forward_folds,
        "positive_walk_forward_folds": positive_folds,
        "admission_checks": admission_checks,
        "failed_checks": [name for name, passed in admission_checks.items() if not passed],
        "coefficients": coefficients,
        "model_risk": "active" if active else "research_only",
        "guardrail": "Activation requires positive holdout IC/RankIC, at least 1% MAE improvement, positive direction lift, and 12 independent test blocks.",
    }


def _factor_evidence_score(
    row: dict[str, Any],
    *,
    quantile_spread: float,
    turnover_penalty: float,
    redundancy_penalty: float,
    decay_penalty: float,
    model_weight: float,
    ml_active: bool,
) -> dict[str, Any]:
    predictive = clamp((abs(number(row.get("ic"))) + abs(number(row.get("rank_ic")))) * 45, 0, 20)
    economic = clamp(max(0.0, quantile_spread) * 2.2 - turnover_penalty * 0.45, 0, 15)
    incremental = clamp((12 if ml_active else 0) + max(0.0, model_weight) * 30, 0, 15)
    stability = clamp(
        max(0.0, number(row.get("positive_window_share_pct"), number(row.get("positive_day_share_pct"))) - 45) * 0.3
        + number(row.get("stability")) * 2
        - decay_penalty * 0.65,
        0,
        15,
    )
    execution = clamp(10 - turnover_penalty, 0, 10)
    redundancy = clamp(10 - redundancy_penalty, 0, 10)
    inferred_quality = 100.0 if number(row.get("date_count")) >= 120 and number(row.get("sample_count")) >= 1000 else 60.0
    data_quality = clamp(number(row.get("quality_score"), inferred_quality) / 10, 0, 10)
    explainability = 5 if str(row.get("formula") or "").strip() else 0
    breakdown = {
        "predictiveSignal": round(predictive, 2),
        "economicReturn": round(economic, 2),
        "incrementalValue": round(incremental, 2),
        "stability": round(stability, 2),
        "execution": round(execution, 2),
        "redundancy": round(redundancy, 2),
        "dataQuality": round(data_quality, 2),
        "explainability": round(explainability, 2),
    }
    total = sum(breakdown.values())
    return {
        "score": round(total, 2),
        "maximum": 100,
        "breakdown": breakdown,
        "researchPass": total >= 60,
        "shadowPass": total >= 70 and ml_active,
        "policy": "100-point audit score; hard OOS, leakage, cost and redundancy gates still override the total.",
    }


def _dynamic_factor_research(
    factor_rows: list[dict[str, Any]],
    factor_series: dict[str, list[float]],
    labels: list[float],
    matrix: dict[str, dict[str, float]],
    horizon: int,
) -> dict[str, Any]:
    row_by_name = {row["name"]: row for row in factor_rows}
    names = list(factor_series)
    clusters = _factor_cluster_map(names, matrix, threshold=0.72)
    leaders: dict[str, str] = {}
    for name, cluster in clusters.items():
        cluster_id = cluster["cluster"]
        members = cluster["members"]
        leaders[cluster_id] = max(members, key=lambda item: number(row_by_name.get(item, {}).get("score")))

    ml_names = [
        row["name"]
        for row in factor_rows
        if row.get("quality_pass") and number(row.get("score")) >= 8
    ] or [
        row["name"]
        for row in factor_rows[: min(10, len(factor_rows))]
    ]
    ml_backtest = _factor_ml_combo_validation(factor_series, labels, horizon, ml_names)
    ml_weight_lookup = {
        row["name"]: number(row.get("abs_weight_pct")) / 100
        for row in ml_backtest.get("coefficients", [])
    } if ml_backtest.get("available") else {}

    candidates: list[dict[str, Any]] = []
    for row in factor_rows:
        name = row["name"]
        values = factor_series[name]
        direction = int(number(row.get("direction"), 1)) or 1
        rolling = [number(value) for value in row.get("rolling_ic") or []]
        latest_rolling = mean(rolling[-3:]) if rolling else 0.0
        long_rolling = mean(rolling) if rolling else 0.0
        decay_penalty = max(0.0, abs(long_rolling) - abs(latest_rolling)) * 8
        if latest_rolling and long_rolling and latest_rolling * long_rolling < 0:
            decay_penalty += 5
        turnover_penalty = min(8.0, _turnover_proxy(values) * 1.2)
        cluster = clusters.get(name, {"cluster": "solo", "members": [name], "size": 1})
        cluster_leader = leaders.get(cluster["cluster"], name)
        redundant = name != cluster_leader and cluster.get("size", 1) > 1
        redundancy_penalty = 12.0 if redundant else 0.0
        quantile_spread = _quantile_spread(values, labels, direction)
        model_gain = ml_weight_lookup.get(name, 0.0) * 18 if ml_backtest.get("active") else ml_weight_lookup.get(name, 0.0) * 8
        quality_bonus = number(row.get("quality_score")) / 100 * 6
        stability_bonus = min(8.0, number(row.get("stability")) * 2.4)
        base_score = (
            abs(number(row.get("ic"))) * 30
            + abs(number(row.get("rank_ic"))) * 24
            + max(0.0, quantile_spread) * 1.8
            + stability_bonus
            + max(0.0, number(row.get("positive_window_share_pct")) - 50) * 0.08
            + model_gain
            + quality_bonus
            - turnover_penalty
            - redundancy_penalty
            - decay_penalty
            - max(0.0, number(row.get("quality_gate", {}).get("max_overlap_correlation")) - 0.72) * 16
        )
        reasons: list[str] = []
        evidence_score = _factor_evidence_score(
            row,
            quantile_spread=quantile_spread,
            turnover_penalty=turnover_penalty,
            redundancy_penalty=redundancy_penalty,
            decay_penalty=decay_penalty,
            model_weight=ml_weight_lookup.get(name, 0.0),
            ml_active=ml_backtest.get("active") is True,
        )
        if not row.get("quality_pass"):
            reasons.append("six_gate_not_all_passed")
        if number(row.get("score")) < 8:
            reasons.append("weak_single_factor_score")
        if redundant:
            reasons.append(f"redundant_with_{cluster_leader}")
        if decay_penalty >= 5:
            reasons.append("recent_ic_decay")
        if turnover_penalty >= 5:
            reasons.append("high_turnover_cost_proxy")
        if ml_backtest.get("available") and not ml_backtest.get("active") and ml_weight_lookup.get(name, 0.0) < 0.03:
            reasons.append("ml_combo_holdout_not_supportive")
        if ml_backtest.get("available") and not ml_backtest.get("active"):
            reasons.append("factor_combo_failed_strict_oos_gate")
        if evidence_score["score"] < 70:
            reasons.append("factor_evidence_score_below_70")
        admitted = (
            not reasons
            and bool(row.get("quality_pass"))
            and not redundant
            and number(row.get("score")) >= 8
            and ml_backtest.get("active") is True
            and ml_weight_lookup.get(name, 0.0) >= 0.03
            and number(row.get("ic")) * direction > 0
            and number(row.get("rank_ic")) * direction > 0
            and evidence_score["shadowPass"]
        )
        candidate = {
            "name": name,
            "formula": row.get("formula", ""),
            "direction": direction,
            "status": "admitted" if admitted else "watchlist",
            "base_score": round(base_score, 4),
            "quality_pass": bool(row.get("quality_pass")),
            "quality_score": number(row.get("quality_score")),
            "ic": row.get("ic"),
            "rank_ic": row.get("rank_ic"),
            "quantile_spread_pct": round(quantile_spread, 4),
            "model_weight_hint_pct": round(ml_weight_lookup.get(name, 0.0) * 100, 3),
            "turnover_penalty": round(turnover_penalty, 3),
            "decay_penalty": round(decay_penalty, 3),
            "redundancy_penalty": round(redundancy_penalty, 3),
            "redundancy": {
                "cluster": cluster.get("cluster"),
                "leader": cluster_leader,
                "cluster_size": cluster.get("size", 1),
                "members": cluster.get("members", [name]),
            },
            "evidence_score": evidence_score,
            "reasons": reasons or ["passed_dynamic_admission"],
            "latest_value": row.get("latest_value"),
        }
        candidates.append(candidate)

    admitted_rows = [row for row in candidates if row["status"] == "admitted" and row["base_score"] > 0]
    if not admitted_rows:
        research_rows = sorted([row for row in candidates if row["base_score"] > 0], key=lambda item: item["base_score"], reverse=True)[:5]
        for row in research_rows:
            row["status"] = "research_only"
            if "fallback_top_candidate" not in row["reasons"]:
                row["reasons"].append("fallback_top_candidate")
    else:
        research_rows = []
    temperature = max(4.0, stddev(row["base_score"] for row in admitted_rows) or 6.0)
    exp_rows = [(row, math.exp(clamp(row["base_score"] / temperature, -8, 8))) for row in admitted_rows]
    exp_total = sum(value for _, value in exp_rows) or 1.0
    weights = []
    for row, exp_value in exp_rows:
        pct = exp_value / exp_total * 100
        row["dynamic_weight_pct"] = round(pct, 3)
        weights.append({
            "name": row["name"],
            "weight_pct": round(pct, 3),
            "status": row["status"],
            "direction": "positive" if row["direction"] >= 0 else "negative",
            "base_score": row["base_score"],
            "reason": ", ".join(row["reasons"][:3]),
        })

    live_components = []
    live_score = 0.0
    for row in admitted_rows:
        name = row["name"]
        values = factor_series[name]
        recent = values[-min(120, len(values)):]
        z_value = clamp((values[-1] - mean(recent)) / (stddev(recent) or 1.0), -4, 4)
        normalized_weight = number(row.get("dynamic_weight_pct")) / 100
        contribution = z_value * row["direction"] * normalized_weight * 7
        live_score += contribution
        live_components.append({
            "name": name,
            "z_value": round(z_value, 4),
            "weight_pct": row.get("dynamic_weight_pct", 0),
            "direction": "positive" if row["direction"] >= 0 else "negative",
            "contribution": round(contribution, 4),
        })

    live_score = clamp(live_score, -12, 12)
    confidence = clamp(
        42
        + max(0.0, number(ml_backtest.get("test", {}).get("direction_hit_rate_pct")) - 50) * 1.4
        + max(0.0, number(ml_backtest.get("direction_lift_pct"))) * 1.8
        + min(12, len(admitted_rows) * 1.1)
        - max(0, len(candidates) - len(admitted_rows)) * 0.08,
        0,
        86 if admitted_rows else 45,
    )
    return {
        "framework": "dynamic-factor-admission-and-ml-weighting",
        "available": bool(candidates),
        "horizon_days": horizon,
        "candidate_count": len(candidates),
        "admitted_count": len(admitted_rows),
        "research_candidate_count": len(research_rows),
        "watchlist_count": len([row for row in candidates if row["status"] == "watchlist"]),
        "redundancy_threshold": 0.72,
        "weight_formula": "softmax(IC + RankIC + quantile spread + stability + ML holdout weight - turnover - redundancy - decay penalties)",
        "leakage_control": "Factor values use candles at or before t; future returns only form labels. ML split uses purged chronological train/validation/test.",
        "candidates": sorted(candidates, key=lambda item: item["base_score"], reverse=True),
        "weights": sorted(weights, key=lambda item: item["weight_pct"], reverse=True),
        "ml_backtest": ml_backtest,
        "live_signal": {
            "score": round(live_score, 3),
            "stance": "supportive" if live_score > 2.5 else "risk-off" if live_score < -2.5 else "mixed",
            "confidence": round(confidence, 1),
            "components": sorted(live_components, key=lambda item: abs(item["contribution"]), reverse=True)[:12],
        },
        "admission_rules": [
            "Six-gate factor quality must pass or remain research-only.",
            "Highly correlated factors share a cluster; only the best generalizing factor receives full admission.",
            "ML combo weights are selected only on validation and reported on a later holdout test.",
            "The 100-point evidence score must reach 70, but cannot override a failed OOS, cost, stability, leakage, or redundancy gate.",
            "Recent IC decay, turnover proxy, and redundancy reduce active weight.",
        ],
    }


def _factor_quality_gate(
    name: str,
    values: list[float],
    labels: list[float],
    formula: str,
    factor_series: dict[str, list[float]],
) -> dict[str, Any]:
    expected = max(1, len(labels))
    finite = [number(value) for value in values if math.isfinite(number(value))]
    missing_pct = max(0.0, (expected - len(finite)) / expected * 100)
    unique_ratio = len({round(value, 8) for value in finite}) / max(1, len(finite))
    sigma = stddev(finite)
    median = _percentile(finite, 0.5)
    q1 = _percentile(finite, 0.25)
    q3 = _percentile(finite, 0.75)
    iqr = q3 - q1
    robust_scale = iqr / 1.349 if iqr else sigma or 1.0
    outliers = [
        value
        for value in finite
        if abs(value - median) / max(robust_scale, 1e-9) > 8
    ]
    outlier_pct = len(outliers) / max(1, len(finite)) * 100
    max_overlap = 0.0
    max_overlap_factor = ""
    for other_name, other_values in factor_series.items():
        if other_name == name:
            continue
        correlation = abs(_pearson(values, other_values))
        if correlation > max_overlap:
            max_overlap = correlation
            max_overlap_factor = other_name
    formula_lower = formula.lower()
    future_terms = ["future", "label", "target", "t+", "lead(", "shift(-"]
    leakage_risk = any(term in formula_lower for term in future_terms)
    max_abs = max((abs(value) for value in finite), default=0.0)
    dimensionless_formula = any(
        token in formula_lower
        for token in [" / ", "/", "pct", "ratio", "zscore", "rank", "std", "mean", "position", "score", "pressure", "closeness"]
    )
    checks = {
        "dimensionless": {
          "pass": bool(dimensionless_formula or max_abs <= 100),
          "detail": "ratio/rank/percentage/score style factor; not raw price-scale" if dimensionless_formula or max_abs <= 100 else "raw magnitude may leak market price scale",
        },
        "richness": {
          "pass": bool(unique_ratio >= 0.12 and max_overlap < 0.92 and sigma > 1e-10),
          "detail": f"unique {unique_ratio:.2f}, max overlap {max_overlap:.2f}{f' vs {max_overlap_factor}' if max_overlap_factor else ''}",
        },
        "no_future_leakage": {
          "pass": not leakage_risk,
          "detail": "formula uses only current/past bars; label window starts after decision timestamp" if not leakage_risk else "formula text references future/label-like terms",
        },
        "missing_values": {
          "pass": missing_pct <= 2.0,
          "detail": f"missing {missing_pct:.2f}%",
        },
        "outliers": {
          "pass": outlier_pct <= 6.0,
          "detail": f"robust outlier share {outlier_pct:.2f}% using median/IQR",
        },
        "standardization": {
          "pass": bool(sigma > 1e-10),
          "detail": "train-window z-score standardization available; production must fit scaler on past data only" if sigma > 1e-10 else "constant factor cannot be standardized",
        },
    }
    passed = sum(1 for item in checks.values() if item["pass"])
    return {
        "pass": passed == 6,
        "passed": passed,
        "total": 6,
        "checks": checks,
        "missing_pct": round(missing_pct, 3),
        "outlier_pct": round(outlier_pct, 3),
        "unique_ratio": round(unique_ratio, 4),
        "max_overlap_correlation": round(max_overlap, 4),
        "max_overlap_factor": max_overlap_factor,
        "standardization": "walk-forward train-window zscore with clipping to [-6, 6]",
    }


def _walk_forward_factor_validation(
    factor_series: dict[str, list[float]],
    labels: list[float],
    horizon: int,
) -> dict[str, Any]:
    sample_count = len(labels)
    min_train = max(50, int(sample_count * 0.45))
    validation_size = max(12, min(40, sample_count // 6))
    purge_samples = max(1, horizon)
    embargo_samples = max(2, horizon // 3)
    checkpoints: list[dict[str, Any]] = []
    validation_start = min_train + purge_samples

    while validation_start + validation_size <= sample_count:
        train_end = validation_start - purge_samples
        validation_end = validation_start + validation_size
        raw_weights: dict[str, float] = {}
        directions: dict[str, int] = {}
        centers: dict[str, float] = {}
        scales: dict[str, float] = {}

        for name, values in factor_series.items():
            train_values = values[:train_end]
            train_labels = labels[:train_end]
            ic = _pearson(train_values, train_labels)
            if abs(ic) < 0.025:
                continue
            raw_weights[name] = abs(ic)
            directions[name] = 1 if ic >= 0 else -1
            centers[name] = mean(train_values)
            scales[name] = stddev(train_values) or 1.0

        weight_total = sum(raw_weights.values()) or 1.0
        weights = {name: value / weight_total for name, value in raw_weights.items()}
        predictions: list[float] = []
        actuals = labels[validation_start:validation_end]
        for index in range(validation_start, validation_end):
            prediction = sum(
                ((factor_series[name][index] - centers[name]) / scales[name]) * directions[name] * weight
                for name, weight in weights.items()
            )
            predictions.append(prediction)

        validation_ic = _pearson(predictions, actuals) if predictions else 0.0
        rank_ic = _spearman(predictions, actuals) if predictions else 0.0
        direction_hits = [
            1
            for prediction, actual in zip(predictions, actuals)
            if (prediction >= 0 and actual >= 0) or (prediction < 0 and actual < 0)
        ]
        hit_rate = len(direction_hits) / len(actuals) * 100 if actuals else 0.0
        checkpoint_score = max(0.0, validation_ic) * 60 + max(0.0, rank_ic) * 25 + max(0.0, hit_rate - 50) * 0.3
        checkpoints.append(
            {
                "id": f"wf-{len(checkpoints) + 1}",
                "train_samples": train_end,
                "validation_samples": len(actuals),
                "validation_start_index": validation_start,
                "validation_end_index": validation_end - 1,
                "validation_ic": round(validation_ic, 4),
                "validation_rank_ic": round(rank_ic, 4),
                "direction_hit_rate_pct": round(hit_rate, 1),
                "score": round(checkpoint_score, 2),
                "weights": {name: round(value * 100, 2) for name, value in sorted(weights.items(), key=lambda item: item[1], reverse=True)},
            }
        )
        validation_start = validation_end + embargo_samples

    if not checkpoints:
        return {
            "status": "insufficient_samples",
            "purge_samples": purge_samples,
            "embargo_samples": embargo_samples,
            "checkpoints": [],
            "best_checkpoint": None,
            "latest_checkpoint": None,
            "rollback_recommended": False,
        }
    best = max(checkpoints, key=lambda item: item["score"])
    latest = checkpoints[-1]
    rollback_recommended = latest["id"] != best["id"] and latest["score"] + 3 < best["score"]
    return {
        "status": "ready",
        "method": "expanding walk-forward validation with purged labels and embargoed folds",
        "purge_samples": purge_samples,
        "embargo_samples": embargo_samples,
        "checkpoints": checkpoints,
        "best_checkpoint": best,
        "latest_checkpoint": latest,
        "rollback_recommended": rollback_recommended,
        "recommendation": (
            f"Latest validation degraded; retain {best['id']} weights until a newer checkpoint beats it."
            if rollback_recommended
            else f"Retain latest checkpoint {latest['id']}; it is not materially worse than the best checkpoint."
        ),
    }


def _gradient_accumulation_training(
    factor_series: dict[str, list[float]],
    labels: list[float],
    horizon: int,
    accumulation_batches: int = 3,
) -> dict[str, Any]:
    names = list(factor_series)
    sample_count = len(labels)
    accumulation_batches = max(2, min(4, int(accumulation_batches or 3)))
    purge = max(1, horizon)
    train_end = int(sample_count * 0.68)
    validation_start = train_end + purge
    validation_end = int(sample_count * 0.84)
    test_start = validation_end + purge
    if train_end < 50 or validation_end - validation_start < 10 or sample_count - test_start < 8:
        return {
            "status": "insufficient_samples",
            "gradient_accumulation_batches": accumulation_batches,
            "checkpoints": [],
            "best_checkpoint": None,
            "latest_checkpoint": None,
            "rollback_applied": False,
        }

    feature_centers = {name: mean(factor_series[name][:train_end]) for name in names}
    feature_scales = {name: stddev(factor_series[name][:train_end]) or 1.0 for name in names}
    label_center = mean(labels[:train_end])
    label_scale = stddev(labels[:train_end]) or 1.0

    def vector(index: int) -> list[float]:
        return [
            clamp((factor_series[name][index] - feature_centers[name]) / feature_scales[name], -6, 6)
            for name in names
        ]

    def target(index: int) -> float:
        return clamp((labels[index] - label_center) / label_scale, -6, 6)

    def predict(weights: list[float], bias: float, index: int) -> float:
        normalized = bias + sum(weight * value for weight, value in zip(weights, vector(index)))
        return normalized * label_scale + label_center

    def metrics(weights: list[float], bias: float, start: int, end: int) -> dict[str, float]:
        predictions = [predict(weights, bias, index) for index in range(start, end)]
        actuals = labels[start:end]
        if not actuals:
            return {"mae": 0.0, "direction_hit_rate_pct": 0.0, "ic": 0.0, "score": -999.0}
        mae = mean(abs(prediction - actual) for prediction, actual in zip(predictions, actuals))
        hits = sum(
            1
            for prediction, actual in zip(predictions, actuals)
            if (prediction >= 0 and actual >= 0) or (prediction < 0 and actual < 0)
        )
        direction_hit_rate = hits / len(actuals) * 100
        ic = _pearson(predictions, actuals)
        score = direction_hit_rate * 0.55 + max(0.0, ic) * 35 - mae * 2.4
        return {
            "mae": round(mae, 4),
            "direction_hit_rate_pct": round(direction_hit_rate, 1),
            "ic": round(ic, 4),
            "score": round(score, 3),
        }

    weights = [0.0] * len(names)
    bias = 0.0
    learning_rate = 0.025
    l2 = 0.002
    batch_size = max(8, min(24, train_end // 8))
    checkpoints: list[dict[str, Any]] = []
    best_weights = list(weights)
    best_bias = bias
    best_score = -999.0
    stale_checkpoints = 0
    accumulated_weight_grad = [0.0] * len(names)
    accumulated_bias_grad = 0.0
    accumulated_batches_count = 0
    optimizer_steps = 0

    for epoch in range(1, 61):
        for batch_start in range(0, train_end, batch_size):
            batch_end = min(train_end, batch_start + batch_size)
            if batch_end <= batch_start:
                continue
            weight_grad = [0.0] * len(names)
            bias_grad = 0.0
            for index in range(batch_start, batch_end):
                x = vector(index)
                normalized_prediction = bias + sum(weight * value for weight, value in zip(weights, x))
                error = normalized_prediction - target(index)
                for position, value in enumerate(x):
                    weight_grad[position] += error * value
                bias_grad += error
            divisor = max(1, batch_end - batch_start)
            for position in range(len(names)):
                accumulated_weight_grad[position] += weight_grad[position] / divisor
            accumulated_bias_grad += bias_grad / divisor
            accumulated_batches_count += 1

            last_batch = batch_end >= train_end
            if accumulated_batches_count >= accumulation_batches or last_batch:
                divisor = max(1, accumulated_batches_count)
                for position in range(len(names)):
                    gradient = clamp(accumulated_weight_grad[position] / divisor + l2 * weights[position], -3, 3)
                    weights[position] -= learning_rate * gradient
                bias -= learning_rate * clamp(accumulated_bias_grad / divisor, -3, 3)
                accumulated_weight_grad = [0.0] * len(names)
                accumulated_bias_grad = 0.0
                accumulated_batches_count = 0
                optimizer_steps += 1

        if epoch == 1 or epoch % 5 == 0:
            validation_metrics = metrics(weights, bias, validation_start, validation_end)
            checkpoint = {
                "id": f"grad-{epoch:02d}",
                "epoch": epoch,
                "optimizer_steps": optimizer_steps,
                "validation_mae": validation_metrics["mae"],
                "validation_direction_hit_rate_pct": validation_metrics["direction_hit_rate_pct"],
                "validation_ic": validation_metrics["ic"],
                "score": validation_metrics["score"],
            }
            checkpoints.append(checkpoint)
            if checkpoint["score"] > best_score + 0.15:
                best_score = checkpoint["score"]
                best_weights = list(weights)
                best_bias = bias
                stale_checkpoints = 0
            else:
                stale_checkpoints += 1
            if stale_checkpoints >= 4:
                break

    best = max(checkpoints, key=lambda item: item["score"])
    latest = checkpoints[-1]
    rollback_applied = latest["id"] != best["id"]
    test_metrics = metrics(best_weights, best_bias, test_start, sample_count)
    return {
        "status": "ready",
        "method": "chronological train/validation/test linear model with gradient accumulation, early stopping, and best-checkpoint rollback",
        "gradient_accumulation_batches": accumulation_batches,
        "batch_size": batch_size,
        "optimizer_steps": optimizer_steps,
        "early_stopping_patience_checkpoints": 4,
        "purge_samples": purge,
        "training_samples": train_end,
        "validation_samples": validation_end - validation_start,
        "test_samples": sample_count - test_start,
        "checkpoints": checkpoints,
        "best_checkpoint": best,
        "latest_checkpoint": latest,
        "rollback_applied": rollback_applied,
        "test": test_metrics,
        "best_weights": {name: round(value, 5) for name, value in zip(names, best_weights)},
        "best_bias": round(best_bias, 5),
    }


def analyze_factors(candles: list[dict[str, Any]], horizon: int = 15, symbol: str = "", market: str = "ASX") -> dict[str, Any]:
    rows = sanitize_candles(candles)
    horizon = max(1, min(60, int(horizon or 15)))
    required_rows = max(70, horizon + 35)
    if len(rows) < required_rows:
        real_rows = len(rows)
        return {
            "available": False,
            "status": "insufficient_data",
            "production_eligible": False,
            "market": market,
            "symbol": symbol,
            "horizon_days": horizon,
            "row_count": real_rows,
            "sample_count": max(0, real_rows - 20 - horizon),
            "label": f"future_return_{horizon}d",
            "labels": {
                "future_close_return": f"future_return_{horizon}d",
                "future_window_vwap_return": f"future_vwap_return_{horizon}d",
                "future_close_return_mean_pct": None,
                "future_window_vwap_return_mean_pct": None,
            },
            "method": "point-in-time real-candle factor audit; model fitting is disabled until the minimum evidence threshold is met",
            "reason": (
                f"Only {real_rows} real daily candle rows are available; "
                f"{required_rows} are required for the {horizon}-day purged walk-forward evaluation."
            ),
            "sample_audit": {
                "real_rows": real_rows,
                "required_rows": required_rows,
                "missing_rows": max(0, required_rows - real_rows),
                "horizon_days": horizon,
                "synthetic_rows": 0,
                "model_training_allowed": False,
                "alpha_evolution_allowed": False,
                "production_eligible": False,
            },
            "factors": [],
            "series": {
                "horizon_days": horizon,
                "factor_names": [],
                "rows": [],
                "note": "No factor score is produced from insufficient evidence. No synthetic candles were added.",
            },
            "factor_library": [],
            "correlation_matrix": {},
            "high_overlap": [],
            "quality_gate": {
                "method": "factor quality gates remain closed until enough real point-in-time rows are available",
                "pass_count": 0,
                "factor_count": 0,
                "pass_rate_pct": 0.0,
                "all_pass": False,
                "checks": ["sample_size", "dimensionless", "richness", "no_future_leakage", "missing_values", "outliers", "standardization"],
                "rows": [],
            },
            "validation": {
                "status": "insufficient_data",
                "available": False,
                "checkpoints": [],
                "purge_samples": horizon,
                "embargo_samples": max(2, horizon // 3),
                "rollback_recommended": False,
                "recommendation": "Collect or restore more real daily history, then rerun the factor experiment.",
            },
            "training_controls": {
                "status": "insufficient_data",
                "available": False,
                "checkpoints": [],
                "gradient_accumulation_batches": 0,
                "batch_size": 0,
                "optimizer_steps": 0,
                "training_samples": 0,
                "validation_samples": 0,
                "test_samples": 0,
                "rollback_applied": False,
            },
            "factor_research": {
                "available": False,
                "status": "insufficient_data",
                "framework": "dynamic-factor-admission-and-ml-weighting",
                "candidate_count": 0,
                "admitted_count": 0,
                "research_candidate_count": 0,
                "weights": [],
                "candidates": [],
                "live_signal": {"available": False, "score": None, "weight_pct": 0},
                "ml_backtest": {"available": False, "active": False, "reason": "insufficient_real_rows"},
                "leakage_control": "No model was fitted and no factor weight was admitted from the short sample.",
            },
            "dynamic_factor_weights": {
                "available": False,
                "status": "insufficient_data",
                "weights": [],
                "candidates": [],
                "admitted_count": 0,
            },
            "guardrails": [
                "Only real provider or persisted real candles are accepted; no synthetic rows are generated.",
                "Insufficient samples never enter dynamic factor weights, alpha evolution, or production prediction.",
                "The evidence threshold grows with the prediction horizon so purge and holdout windows remain valid.",
            ],
        }

    closes = [row["close"] for row in rows]
    volumes = [row["volume"] for row in rows]
    factor_series: dict[str, list[float]] = {
        "momentum_5": [],
        "momentum_20": [],
        "reversal_5": [],
        "volatility_10": [],
        "volume_ratio_20": [],
        "trend_gap_20": [],
        "vwap_gap": [],
        "range_position": [],
        "bollinger_percent_b": [],
        "bollinger_bandwidth": [],
        "fib_618_closeness": [],
        "fvg_pressure": [],
        "ict_sweep_pressure": [],
        "wyckoff_phase_score": [],
        "orderflow_pressure": [],
        "effort_vs_result": [],
        "volume_accel_5_20": [],
        "trend_efficiency_20": [],
        "downside_volatility_20": [],
        "macd_volume_confirmation": [],
        "gap_followthrough": [],
        "liquidity_absorption": [],
        "volume_profile_closeness": [],
        "value_area_position": [],
    }
    labels: list[float] = []
    vwap_labels: list[float] = []
    factor_formulas = {
        "momentum_5": "close / close[t-5] - 1",
        "momentum_20": "close / close[t-20] - 1",
        "reversal_5": "-(close / close[t-5] - 1)",
        "volatility_10": "-std(return_10d)",
        "volume_ratio_20": "volume / mean(volume_20d)",
        "trend_gap_20": "close / mean(close_20d) - 1",
        "vwap_gap": "close / rolling_vwap_20d - 1",
        "range_position": "(close - low_20d) / (high_20d - low_20d)",
        "bollinger_percent_b": "(close - lower_band_20d) / (upper_band_20d - lower_band_20d)",
        "bollinger_bandwidth": "(upper_band_20d - lower_band_20d) / middle_band_20d",
        "fib_618_closeness": "-abs(close / fib_61.8_retracement - 1)",
        "fvg_pressure": "sum(recent_fvg_direction * gap_size_pct * open_gap_weight)",
        "ict_sweep_pressure": "sum(recent_liquidity_sweep_direction * sweep_depth_pct * volume_ratio)",
        "wyckoff_phase_score": "markup=1, accumulation=0.45, range=0, distribution=-0.45, markdown=-1",
        "orderflow_pressure": "0.55 * candle_direction + 0.45 * close_location",
        "effort_vs_result": "volume_ratio / (abs(return_pct) + 0.25)",
        "volume_accel_5_20": "mean(volume_5d) / mean(volume_20d) - 1",
        "trend_efficiency_20": "abs(close / close[t-20] - 1) / sum(abs(return_1d), 20d)",
        "downside_volatility_20": "-std(min(return_1d, 0), 20d)",
        "macd_volume_confirmation": "zscore(macd_hist_pct, 20d) * zscore(volume_ratio_20, 20d)",
        "gap_followthrough": "overnight_gap_pct * intraday_return_pct",
        "liquidity_absorption": "volume_ratio_20 * close_location - abs(return_pct)",
        "volume_profile_closeness": "-abs(close / point_of_control_60d - 1)",
        "value_area_position": "(close - value_area_low_60d) / (value_area_high_60d - value_area_low_60d)",
    }
    factor_usage = {
        "momentum_5": "短线顺势因子，正相关时适合跟随强势拉升，负相关时说明短线过热容易回撤。",
        "momentum_20": "中短趋势因子，正相关代表趋势延续，负相关代表均值回归占优。",
        "reversal_5": "短线反转因子，正相关代表跌后修复/涨后回落结构有效。",
        "volatility_10": "低波动偏好因子，正相关代表稳态更有利，负相关代表波动扩张更有利。",
        "volume_ratio_20": "成交放大因子，用于识别资金关注度和异常活跃段。",
        "trend_gap_20": "价格相对 20 日均线偏离，判断趋势强度或追高风险。",
        "vwap_gap": "价格相对成交重心偏离，辅助判断资金承接与成本线。",
        "range_position": "20 日区间位置，判断突破、贴近高位或低位修复。",
        "bollinger_percent_b": "价格在布林带中的位置，用于识别贴上轨突破、贴下轨修复或过热。",
        "bollinger_bandwidth": "布林带宽度，用于识别波动挤压后的扩张机会或风险。",
        "fib_618_closeness": "越接近 61.8% 回撤位数值越高，用于检验关键回撤位附近是否有统计优势。",
        "fvg_pressure": "未回补 FVG 的方向和缺口大小，用于衡量结构不平衡压力。",
        "ict_sweep_pressure": "扫前高/前低后回收的方向压力，用于识别诱多诱空后的反向概率。",
        "wyckoff_phase_score": "Wyckoff 阶段代理，把吸筹/拉升/派发/下跌转成可回测的方向分数。",
        "orderflow_pressure": "K 线方向与收盘位置推断的主动买卖压力代理。",
        "effort_vs_result": "成交努力相对价格结果，数值高代表放量但推进有限，需结合方向判断吸收或派发。",
        "volume_accel_5_20": "短期成交量相对 20 日成交均值的加速度，用于识别新增关注是否持续。",
        "trend_efficiency_20": "20 日方向位移相对日内波动总和，衡量趋势是否干净，避免只追逐噪声涨跌。",
        "downside_volatility_20": "只惩罚下行波动，避免把健康上涨波动和下跌风险混在一起。",
        "macd_volume_confirmation": "MACD 动能与成交异常的交互项，检验动能是否由真实放量确认。",
        "gap_followthrough": "隔夜跳空后日内是否继续同向，识别消息驱动是否被市场接受。",
        "liquidity_absorption": "放量但收盘位置强弱与收益不匹配时的吸收/派发代理。",
        "volume_profile_closeness": "价格越接近 60 日成交密集 POC，越可能出现承接或阻力，需要用样本外结果决定方向。",
        "value_area_position": "价格在 60 日价值区内的位置，用于识别低位承接、高位突破或追高风险。",
    }

    for index in range(20, len(rows) - horizon):
        close = closes[index]
        recent = rows[index - 19 : index + 1]
        # These structure factors only depend on their declared 20-60 bar lookbacks.
        # Bounding the prefix avoids quadratic recomputation without changing point-in-time values.
        structure_window = rows[max(0, index - 69) : index + 1]
        typical_notional = sum(((row["high"] + row["low"] + row["close"]) / 3) * row["volume"] for row in recent)
        volume_sum = sum(row["volume"] for row in recent)
        vwap = typical_notional / volume_sum if volume_sum else close
        returns_10 = [pct_change(closes[pos - 1], closes[pos]) for pos in range(index - 9, index + 1)]
        high_20 = max(row["high"] for row in recent)
        low_20 = min(row["low"] for row in recent)
        volume_mean_20 = mean(volumes[index - 19 : index + 1])
        volume_mean_5 = mean(volumes[index - 4 : index + 1])
        bollinger_current = _bollinger_series(recent)[-1]
        fibonacci_current = _fibonacci_snapshot(structure_window, lookback=60)
        fib_618_price = next((item["price"] for item in fibonacci_current.get("levels", []) if item["label"] == "61.8%"), close)
        wyckoff_current = _wyckoff_proxy(structure_window, lookback=60)
        volume_profile_current = _volume_profile(rows[max(0, index - 59) : index + 1], bucket_count=16)
        profile_poc = number((volume_profile_current.get("point_of_control") or {}).get("mid"), close)
        value_area = volume_profile_current.get("value_area") or {}
        value_low = number(value_area.get("low"), low_20)
        value_high = number(value_area.get("high"), high_20)
        value_span = max(value_high - value_low, close * 0.0001)
        price_range = max(rows[index]["high"] - rows[index]["low"], close * 0.0001)
        candle_direction = clamp((close - rows[index]["open"]) / price_range, -1, 1)
        close_location = clamp(((close - rows[index]["low"]) / price_range) * 2 - 1, -1, 1)
        orderflow_pressure = clamp(candle_direction * 0.55 + close_location * 0.45, -1, 1)
        current_return = pct_change(closes[index - 1], close) if index else 0.0
        previous_close = closes[index - 1] if index else close
        overnight_gap_pct = pct_change(previous_close, rows[index]["open"]) if previous_close else 0.0
        intraday_return_pct = pct_change(rows[index]["open"], close)
        volume_ratio = volumes[index] / volume_mean_20 if volume_mean_20 else 0.0
        raw_returns_20 = [pct_change(closes[pos - 1], closes[pos]) for pos in range(index - 19, index + 1) if pos > 0]
        total_abs_return_20 = sum(abs(value) for value in raw_returns_20) or 1.0
        trend_efficiency = abs(pct_change(closes[index - 20], close)) / total_abs_return_20 if index >= 20 else 0.0
        downside_returns = [min(0.0, value) for value in raw_returns_20]
        macd_proxy = pct_change(mean(closes[index - 11 : index + 1]), mean(closes[index - 25 : index + 1])) if index >= 25 else 0.0
        factor_series["momentum_5"].append(pct_change(closes[index - 5], close))
        factor_series["momentum_20"].append(pct_change(closes[index - 20], close))
        factor_series["reversal_5"].append(-pct_change(closes[index - 5], close))
        factor_series["volatility_10"].append(-stddev(returns_10))
        factor_series["volume_ratio_20"].append(volume_ratio)
        factor_series["trend_gap_20"].append(pct_change(mean(closes[index - 19 : index + 1]), close))
        factor_series["vwap_gap"].append(pct_change(vwap, close))
        factor_series["range_position"].append((close - low_20) / (high_20 - low_20) if high_20 > low_20 else 0.5)
        factor_series["bollinger_percent_b"].append(bollinger_current["percent_b"])
        factor_series["bollinger_bandwidth"].append(bollinger_current["bandwidth_pct"])
        factor_series["fib_618_closeness"].append(-abs(pct_change(fib_618_price, close)))
        factor_series["fvg_pressure"].append(_fvg_pressure(structure_window, lookback=50))
        factor_series["ict_sweep_pressure"].append(_ict_pressure(structure_window, lookback=50))
        factor_series["wyckoff_phase_score"].append(number(wyckoff_current.get("phase_score")))
        factor_series["orderflow_pressure"].append(orderflow_pressure)
        factor_series["effort_vs_result"].append(volume_ratio / (abs(current_return) + 0.25))
        factor_series["volume_accel_5_20"].append(volume_mean_5 / volume_mean_20 - 1 if volume_mean_20 else 0.0)
        factor_series["trend_efficiency_20"].append(trend_efficiency)
        factor_series["downside_volatility_20"].append(-stddev(downside_returns))
        factor_series["macd_volume_confirmation"].append(macd_proxy * (volume_ratio - 1))
        factor_series["gap_followthrough"].append(overnight_gap_pct * intraday_return_pct / 100)
        factor_series["liquidity_absorption"].append(volume_ratio * close_location - abs(current_return) * 0.15)
        factor_series["volume_profile_closeness"].append(-abs(pct_change(profile_poc, close)))
        factor_series["value_area_position"].append(clamp((close - value_low) / value_span, -1.5, 2.5))
        labels.append(pct_change(close, closes[index + horizon]))
        future_rows = rows[index + 1 : index + horizon + 1]
        future_notional = sum(((row["high"] + row["low"] + row["close"]) / 3) * row["volume"] for row in future_rows)
        future_volume = sum(row["volume"] for row in future_rows)
        future_vwap = future_notional / future_volume if future_volume else closes[index + horizon]
        vwap_labels.append(pct_change(close, future_vwap))

    factor_rows: list[dict[str, Any]] = []
    for name, values in factor_series.items():
        ic = _pearson(values, labels)
        rank_ic = _spearman(values, labels)
        vwap_ic = _pearson(values, vwap_labels)
        vwap_rank_ic = _spearman(values, vwap_labels)
        rolling: list[float] = []
        window = min(60, max(24, len(values) // 4))
        step = max(8, window // 3)
        for start in range(0, max(1, len(values) - window + 1), step):
            rolling.append(_pearson(values[start : start + window], labels[start : start + window]))
        positive_share = sum(1 for value in rolling if value > 0) / len(rolling) if rolling else 0.0
        stability = abs(mean(rolling)) / (stddev(rolling) + 0.05) if rolling else 0.0
        score = clamp(abs(ic) * 45 + abs(rank_ic) * 35 + min(20, stability * 8), 0, 100)
        direction = 1 if ic >= 0 else -1
        factor_rows.append(
            {
                "name": name,
                "formula": factor_formulas.get(name, ""),
                "interpretation": factor_usage.get(name, ""),
                "ic": round(ic, 4),
                "rank_ic": round(rank_ic, 4),
                "future_vwap_ic": round(vwap_ic, 4),
                "future_vwap_rank_ic": round(vwap_rank_ic, 4),
                "price_correlation": round(_pearson(values, closes[20 : len(rows) - horizon]), 4),
                "prediction_correlation": round((ic * 0.6 + vwap_ic * 0.4), 4),
                "direction_label": "positive" if ic >= 0 else "negative",
                "long_short_usage": "因子值越高，未来标签倾向越高" if ic >= 0 else "因子值越高，未来标签倾向越低",
                "rolling_ic": [round(value, 4) for value in rolling[-12:]],
                "positive_window_share_pct": round(positive_share * 100, 1),
                "stability": round(stability, 3),
                "score": round(score, 1),
                "direction": direction,
                "latest_value": round(values[-1], 4),
            }
        )
    factor_rows.sort(key=lambda row: row["score"], reverse=True)
    score_total = sum(row["score"] for row in factor_rows if row["score"] >= 12) or 1
    for row in factor_rows:
        row["suggested_weight_pct"] = round(row["score"] / score_total * 100, 1) if row["score"] >= 12 else 0.0

    names = list(factor_series)
    matrix = {
        left: {right: round(_pearson(factor_series[left], factor_series[right]), 4) for right in names}
        for left in names
    }
    high_overlap: list[dict[str, Any]] = []
    for left_index, left in enumerate(names):
        for right in names[left_index + 1 :]:
            correlation = matrix[left][right]
            if abs(correlation) >= 0.75:
                high_overlap.append({"left": left, "right": right, "correlation": correlation})
    quality_rows: list[dict[str, Any]] = []
    for row in factor_rows:
        gate = _factor_quality_gate(
            row["name"],
            factor_series[row["name"]],
            labels,
            factor_formulas.get(row["name"], ""),
            factor_series,
        )
        row["quality_gate"] = gate
        row["quality_pass"] = gate["pass"]
        row["quality_score"] = round(gate["passed"] / gate["total"] * 100, 1)
        quality_rows.append({"name": row["name"], **gate})
    quality_pass_count = sum(1 for row in quality_rows if row["pass"])
    validation = _walk_forward_factor_validation(factor_series, labels, horizon)
    training_controls = _gradient_accumulation_training(factor_series, labels, horizon, accumulation_batches=3)
    factor_research = _dynamic_factor_research(factor_rows, factor_series, labels, matrix, horizon)
    research_by_name = {row["name"]: row for row in factor_research.get("candidates", [])}
    weight_by_name = {row["name"]: row for row in factor_research.get("weights", [])}
    for row in factor_rows:
        candidate = research_by_name.get(row["name"], {})
        weight_row = weight_by_name.get(row["name"], {})
        row["admission_status"] = candidate.get("status", "watchlist")
        row["admission_reasons"] = candidate.get("reasons", [])
        row["dynamic_weight_pct"] = round(number(weight_row.get("weight_pct")), 3)
        row["ml_weight_hint_pct"] = candidate.get("model_weight_hint_pct", 0)
        row["redundancy_cluster"] = candidate.get("redundancy", {}).get("cluster", "")
        row["redundancy_leader"] = candidate.get("redundancy", {}).get("leader", "")
    factor_view_rows: list[dict[str, Any]] = []
    for offset, index in enumerate(range(20, len(rows) - horizon)):
        row = rows[index]
        factor_view_rows.append(
            {
                "date": row["date"],
                "open": round(row["open"], 6),
                "high": round(row["high"], 6),
                "low": round(row["low"], 6),
                "close": round(row["close"], 6),
                "volume": round(row["volume"], 2),
                "future_return_pct": round(labels[offset], 4),
                "future_vwap_return_pct": round(vwap_labels[offset], 4),
                "factors": {
                    name: round(values[offset], 6)
                    for name, values in factor_series.items()
                },
            }
        )

    return {
        "available": True,
        "status": "ready",
        "production_eligible": False,
        "market": market,
        "symbol": symbol,
        "horizon_days": horizon,
        "sample_count": len(labels),
        "label": f"future_return_{horizon}d",
        "labels": {
            "future_close_return": f"future_return_{horizon}d",
            "future_window_vwap_return": f"future_vwap_return_{horizon}d",
            "future_close_return_mean_pct": round(mean(labels), 4),
            "future_window_vwap_return_mean_pct": round(mean(vwap_labels), 4),
        },
        "method": "walk-forward time-series IC; factors only use information available before each label window",
        "factors": factor_rows,
        "series": {
            "horizon_days": horizon,
            "factor_names": names,
            "rows": factor_view_rows[-360:],
            "note": "Factor values use only information available at each row; future returns are labels for visual audit and scoring.",
        },
        "factor_library": [
            {"name": name, "formula": factor_formulas[name], "usage": factor_usage[name]}
            for name in names
        ],
        "correlation_matrix": matrix,
        "high_overlap": sorted(high_overlap, key=lambda row: abs(row["correlation"]), reverse=True),
        "quality_gate": {
            "method": "six-gate factor audit before model use: dimensionless, richness, no future leakage, missing values, outliers, standardization",
            "pass_count": quality_pass_count,
            "factor_count": len(quality_rows),
            "pass_rate_pct": round(quality_pass_count / max(1, len(quality_rows)) * 100, 1),
            "all_pass": quality_pass_count == len(quality_rows),
            "checks": ["dimensionless", "richness", "no_future_leakage", "missing_values", "outliers", "standardization"],
            "rows": quality_rows,
        },
        "validation": validation,
        "training_controls": training_controls,
        "factor_research": factor_research,
        "dynamic_factor_weights": factor_research,
        "guardrails": [
            "不使用未来数据构造因子；标签只用于样本外评分。",
            "因子进入模型前必须通过无量纲、丰富度、未来函数、缺失值、极端值、标准化六项闸门。",
            "滚动验证在训练与验证之间清除一个预测周期，并在验证折之间设置 embargo。",
            "最新检查点若明显弱于最佳检查点，则建议回滚而不是继续使用退化权重。",
            "单标的时间序列 IC 不能替代完整横截面 IC，后续会扩展为市场级横截面评估。",
            "高相关因子不重复满权，优先保留样本外稳定性更强者。",
            "动态因子权重来自 IC/Rank IC/分组收益/ML holdout/去重/衰减/换手成本惩罚，不再只依赖人工固定权重。",
            "训练模型按时间顺序切分训练/验证/测试集，累计 3 个小批次后才更新参数，并使用验证集早停与最佳检查点回滚。",
            "借鉴 Qlib/FinRL/NeuralForecast/TFT 一类时间序列项目：只在训练窗拟合 scaler，用滚动样本外验证选择检查点，深度模型启用 dropout/weight decay，并用独立测试窗约束泛化。",
            "如果训练窗明显强于验证/测试窗，界面会优先降低泛化评分，而不是把样本内高胜率当成实盘置信率。",
        ],
    }


PANEL_FACTOR_FORMULAS = {
    "momentum_5": "close / close[t-5] - 1",
    "momentum_20": "close / close[t-20] - 1",
    "reversal_5": "-(close / close[t-5] - 1)",
    "volatility_10": "-std(return_10d)",
    "volume_ratio_20": "volume / mean(volume_20d)",
    "trend_gap_20": "close / mean(close_20d) - 1",
    "vwap_gap": "close / rolling_vwap_20d - 1",
    "range_position": "(close - low_20d) / (high_20d - low_20d)",
    "volume_accel_5_20": "mean(volume_5d) / mean(volume_20d) - 1",
    "trend_efficiency_20": "abs(close / close[t-20] - 1) / sum(abs(return_1d), 20d)",
    "downside_volatility_20": "-std(min(return_1d, 0), 20d)",
    "macd_volume_confirmation": "zscore(macd_hist_pct, 20d) * zscore(volume_ratio_20, 20d)",
    "gap_followthrough": "overnight_gap_pct * intraday_return_pct",
    "liquidity_absorption": "volume_ratio_20 * close_location - abs(return_pct)",
    "volume_profile_closeness": "-abs(close / point_of_control_60d - 1)",
    "value_area_position": "(close - value_area_low_60d) / (value_area_high_60d - value_area_low_60d)",
}


def _panel_factor_rows(candles: list[dict[str, Any]], horizon: int, symbol: str, sector: str = "") -> list[dict[str, Any]]:
    rows = sanitize_candles(candles)
    if len(rows) < max(85, horizon + 65):
        return []
    closes = [row["close"] for row in rows]
    volumes = [row["volume"] for row in rows]
    out: list[dict[str, Any]] = []
    start_index = 60
    for index in range(start_index, len(rows) - horizon):
        close = closes[index]
        recent20 = rows[index - 19:index + 1]
        recent60 = rows[index - 59:index + 1]
        volume_mean_20 = mean(volumes[index - 19:index + 1])
        volume_mean_5 = mean(volumes[index - 4:index + 1])
        high20 = max(row["high"] for row in recent20)
        low20 = min(row["low"] for row in recent20)
        typical_notional = sum(((row["high"] + row["low"] + row["close"]) / 3) * row["volume"] for row in recent20)
        volume_sum = sum(row["volume"] for row in recent20)
        vwap = typical_notional / volume_sum if volume_sum else close
        raw_returns_20 = [pct_change(closes[pos - 1], closes[pos]) for pos in range(index - 19, index + 1) if pos > 0]
        returns_10 = raw_returns_20[-10:]
        current_return = pct_change(closes[index - 1], close) if index else 0.0
        previous_close = closes[index - 1] if index else close
        overnight_gap_pct = pct_change(previous_close, rows[index]["open"]) if previous_close else 0.0
        intraday_return_pct = pct_change(rows[index]["open"], close)
        volume_ratio = volumes[index] / volume_mean_20 if volume_mean_20 else 0.0
        total_abs_return_20 = sum(abs(value) for value in raw_returns_20) or 1.0
        trend_efficiency = abs(pct_change(closes[index - 20], close)) / total_abs_return_20 if index >= 20 else 0.0
        downside_returns = [min(0.0, value) for value in raw_returns_20]
        price_range = max(rows[index]["high"] - rows[index]["low"], close * 0.0001)
        close_location = clamp(((close - rows[index]["low"]) / price_range) * 2 - 1, -1, 1)
        macd_proxy = pct_change(mean(closes[index - 11:index + 1]), mean(closes[index - 25:index + 1])) if index >= 25 else 0.0
        profile = _volume_profile(recent60, bucket_count=16)
        poc = number((profile.get("point_of_control") or {}).get("mid"), close)
        value_area = profile.get("value_area") or {}
        value_low = number(value_area.get("low"), low20)
        value_high = number(value_area.get("high"), high20)
        value_span = max(value_high - value_low, close * 0.0001)
        factors = {
            "momentum_5": pct_change(closes[index - 5], close),
            "momentum_20": pct_change(closes[index - 20], close),
            "reversal_5": -pct_change(closes[index - 5], close),
            "volatility_10": -stddev(returns_10),
            "volume_ratio_20": volume_ratio,
            "trend_gap_20": pct_change(mean(closes[index - 19:index + 1]), close),
            "vwap_gap": pct_change(vwap, close),
            "range_position": (close - low20) / (high20 - low20) if high20 > low20 else 0.5,
            "volume_accel_5_20": volume_mean_5 / volume_mean_20 - 1 if volume_mean_20 else 0.0,
            "trend_efficiency_20": trend_efficiency,
            "downside_volatility_20": -stddev(downside_returns),
            "macd_volume_confirmation": macd_proxy * (volume_ratio - 1),
            "gap_followthrough": overnight_gap_pct * intraday_return_pct / 100,
            "liquidity_absorption": volume_ratio * close_location - abs(current_return) * 0.15,
            "volume_profile_closeness": -abs(pct_change(poc, close)),
            "value_area_position": clamp((close - value_low) / value_span, -1.5, 2.5),
        }
        future = rows[index + 1:index + horizon + 1]
        future_high = max((row["high"] for row in future), default=close)
        future_low = min((row["low"] for row in future), default=close)
        out.append({
            "date": rows[index]["date"][:10],
            "symbol": symbol,
            "sector": sector or "Unknown",
            "close": close,
            "label": pct_change(close, closes[index + horizon]),
            "max_upside": pct_change(close, future_high),
            "max_drawdown": pct_change(close, future_low),
            "factors": factors,
        })
    return out


def _group_by_date(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("date") or ""), []).append(row)
    return grouped


def _panel_factor_metrics(
    rows: list[dict[str, Any]],
    factor_name: str,
    min_symbols: int,
) -> dict[str, Any]:
    by_date = _group_by_date(rows)
    daily: list[dict[str, Any]] = []
    for date, date_rows in sorted(by_date.items()):
        clean = [
            row for row in date_rows
            if math.isfinite(number(row.get("factors", {}).get(factor_name))) and math.isfinite(number(row.get("label")))
        ]
        if len(clean) < min_symbols:
            continue
        values = [number(row["factors"][factor_name]) for row in clean]
        labels = [number(row["label"]) for row in clean]
        if stddev(values) <= 1e-10 or stddev(labels) <= 1e-10:
            continue
        ordered = sorted(zip(values, labels), key=lambda item: item[0])
        bucket = max(1, len(ordered) // 5)
        low_return = mean(label for _, label in ordered[:bucket])
        high_return = mean(label for _, label in ordered[-bucket:])
        daily.append({
            "date": date,
            "symbols": len(clean),
            "ic": _pearson(values, labels),
            "rank_ic": _spearman(values, labels),
            "high_minus_low": high_return - low_return,
        })

    values_all = [number(row["factors"].get(factor_name)) for row in rows if factor_name in row.get("factors", {})]
    labels_all = [number(row["label"]) for row in rows if factor_name in row.get("factors", {})]
    full_ic = _pearson(values_all, labels_all)
    full_rank_ic = _spearman(values_all, labels_all)
    direction = 1 if (mean(row["rank_ic"] for row in daily) or full_rank_ic or full_ic) >= 0 else -1
    directed_spreads = [row["high_minus_low"] * direction for row in daily]
    positive_days = sum(1 for row in daily if row["rank_ic"] * direction > 0)

    residual_values: list[float] = []
    residual_labels: list[float] = []
    for date_rows in by_date.values():
        sector_groups: dict[str, list[dict[str, Any]]] = {}
        for row in date_rows:
            sector_groups.setdefault(str(row.get("sector") or "Unknown"), []).append(row)
        for sector_rows in sector_groups.values():
            clean = [row for row in sector_rows if factor_name in row.get("factors", {})]
            if len(clean) < 2:
                continue
            factor_center = mean(number(row["factors"].get(factor_name)) for row in clean)
            label_center = mean(number(row.get("label")) for row in clean)
            residual_values.extend(number(row["factors"].get(factor_name)) - factor_center for row in clean)
            residual_labels.extend(number(row.get("label")) - label_center for row in clean)

    sector_neutral_ic = _pearson(residual_values, residual_labels)
    sector_neutral_rank_ic = _spearman(residual_values, residual_labels)
    return {
        "name": factor_name,
        "formula": PANEL_FACTOR_FORMULAS.get(factor_name, ""),
        "direction": direction,
        "direction_label": "positive" if direction >= 0 else "negative",
        "ic": round(full_ic, 4),
        "rank_ic": round(full_rank_ic, 4),
        "daily_ic_mean": round(mean(row["ic"] for row in daily), 4),
        "daily_rank_ic_mean": round(mean(row["rank_ic"] for row in daily), 4),
        "sector_neutral_ic": round(sector_neutral_ic, 4),
        "sector_neutral_rank_ic": round(sector_neutral_rank_ic, 4),
        "quantile_spread_pct": round(mean(directed_spreads), 4),
        "positive_day_share_pct": round(positive_days / max(1, len(daily)) * 100, 2),
        "date_count": len(daily),
        "sample_count": len(values_all),
        "latest_rank_ic": round(mean(row["rank_ic"] for row in daily[-12:]), 4) if daily else 0.0,
        "stability": round(abs(mean(row["rank_ic"] for row in daily)) / (stddev(row["rank_ic"] for row in daily) + 0.05), 4) if daily else 0.0,
    }


def _fit_panel_ridge(rows: list[dict[str, Any]], factor_names: list[str], penalty: float, epochs: int = 80) -> dict[str, Any]:
    centers = {name: mean(row["factors"].get(name, 0.0) for row in rows) for name in factor_names}
    scales = {name: stddev(row["factors"].get(name, 0.0) for row in rows) or 1.0 for name in factor_names}
    label_center = mean(row["label"] for row in rows)
    label_scale = stddev(row["label"] for row in rows) or 1.0
    weights = [0.0] * len(factor_names)
    bias = 0.0
    learning_rate = 0.028

    def vector(row: dict[str, Any]) -> list[float]:
        return [
            clamp((number(row["factors"].get(name)) - centers[name]) / scales[name], -6, 6)
            for name in factor_names
        ]

    for epoch in range(epochs):
        decay = 1.0 / (1.0 + epoch * 0.02)
        for row in rows:
            x = vector(row)
            target = clamp((number(row["label"]) - label_center) / label_scale, -6, 6)
            prediction = bias + sum(weight * value for weight, value in zip(weights, x))
            error = prediction - target
            for position, value in enumerate(x):
                weights[position] -= learning_rate * decay * clamp(error * value + penalty * weights[position], -4, 4)
            bias -= learning_rate * decay * clamp(error, -4, 4)

    def predict(row: dict[str, Any]) -> float:
        normalized = bias + sum(weight * value for weight, value in zip(weights, vector(row)))
        return normalized * label_scale + label_center

    return {"weights": weights, "bias": bias, "predict": predict}


def _panel_equal_baseline(train_rows: list[dict[str, Any]], test_rows: list[dict[str, Any]], factor_names: list[str]) -> list[float]:
    directions = {}
    centers = {}
    scales = {}
    for name in factor_names:
        values = [number(row["factors"].get(name)) for row in train_rows]
        labels = [number(row["label"]) for row in train_rows]
        directions[name] = 1 if _spearman(values, labels) >= 0 else -1
        centers[name] = mean(values)
        scales[name] = stddev(values) or 1.0
    train_scores = [
        mean(clamp((number(row["factors"].get(name)) - centers[name]) / scales[name], -6, 6) * directions[name] for name in factor_names)
        for row in train_rows
    ]
    label_center = mean(row["label"] for row in train_rows)
    scale = (stddev(row["label"] for row in train_rows) or 1.0) / (stddev(train_scores) or 1.0)
    score_center = mean(train_scores)
    return [
        (mean(clamp((number(row["factors"].get(name)) - centers[name]) / scales[name], -6, 6) * directions[name] for name in factor_names) - score_center) * scale + label_center
        for row in test_rows
    ]


def _panel_walk_forward_folds(
    rows: list[dict[str, Any]],
    factor_names: list[str],
    horizon: int,
    penalty: float,
    fold_count: int = 5,
) -> list[dict[str, Any]]:
    dates = sorted({row["date"] for row in rows})
    purge = max(1, min(20, horizon))
    first_test = max(60 + purge, int(len(dates) * 0.45))
    fold_size = max(8, (len(dates) - first_test) // max(1, fold_count))
    folds: list[dict[str, Any]] = []
    for fold in range(fold_count):
        test_start = first_test + fold * fold_size
        test_end = len(dates) if fold == fold_count - 1 else min(len(dates), test_start + fold_size)
        train_end = test_start - purge
        if train_end < 40 or test_end - test_start < 8:
            continue
        train_dates = set(dates[:train_end])
        test_dates = set(dates[test_start:test_end])
        train_rows = [row for row in rows if row["date"] in train_dates]
        test_rows = [row for row in rows if row["date"] in test_dates]
        if not train_rows or not test_rows:
            continue
        model = _fit_panel_ridge(train_rows, factor_names, penalty)
        predictions = [model["predict"](row) for row in test_rows]
        metrics = _factor_prediction_metrics(predictions, [row["label"] for row in test_rows])
        folds.append({
            "fold": fold + 1,
            "train_dates": len(train_dates),
            "test_dates": len(test_dates),
            "test_rows": len(test_rows),
            **metrics,
            "positive": metrics["rank_ic"] > 0 and metrics["avg_net_signal_return_pct"] > 0,
        })
    return folds


def _panel_ml_backtest(rows: list[dict[str, Any]], factor_names: list[str], horizon: int) -> dict[str, Any]:
    dates = sorted({row["date"] for row in rows})
    purge = max(1, min(20, horizon))
    embargo = max(1, min(10, horizon // 2))
    train_end = int(len(dates) * 0.58)
    validation_start = train_end + purge
    validation_end = int(len(dates) * 0.78)
    test_start = validation_end + embargo
    if len(factor_names) < 2 or train_end < 40 or validation_end - validation_start < 8 or len(dates) - test_start < 8:
        return {
            "available": False,
            "framework": "cross-sectional-factor-ridge",
            "reason": "Not enough dates/factors for purged cross-sectional train/validation/test.",
            "date_count": len(dates),
            "factor_count": len(factor_names),
        }
    train_dates = set(dates[:train_end])
    validation_dates = set(dates[validation_start:validation_end])
    test_dates = set(dates[test_start:])
    train_rows = [row for row in rows if row["date"] in train_dates]
    validation_rows = [row for row in rows if row["date"] in validation_dates]
    test_rows = [row for row in rows if row["date"] in test_dates]
    selected: dict[str, Any] | None = None
    for penalty in [0.01, 0.03, 0.08, 0.16, 0.32, 0.64]:
        model = _fit_panel_ridge(train_rows, factor_names, penalty)
        predictions = [model["predict"](row) for row in validation_rows]
        metrics = _factor_prediction_metrics(predictions, [row["label"] for row in validation_rows])
        score = metrics["direction_hit_rate_pct"] + max(0.0, metrics["rank_ic"]) * 35 - metrics["mae"] * 1.4
        candidate = {"penalty": penalty, "model": model, "validation": metrics, "score": score}
        if selected is None or candidate["score"] > selected["score"]:
            selected = candidate
    assert selected is not None
    deployment_rows = [row for row in rows if row["date"] in set(dates[:validation_end])]
    deployment = _fit_panel_ridge(deployment_rows, factor_names, selected["penalty"], epochs=100)
    predictions = [deployment["predict"](row) for row in test_rows]
    actuals = [row["label"] for row in test_rows]
    test_metrics = _factor_prediction_metrics(predictions, actuals)
    equal_predictions = _panel_equal_baseline(deployment_rows, test_rows, factor_names)
    equal_metrics = _factor_prediction_metrics(equal_predictions, actuals)
    momentum_name = "momentum_20" if "momentum_20" in factor_names else factor_names[0]
    momentum_predictions = _panel_equal_baseline(deployment_rows, test_rows, [momentum_name])
    momentum_metrics = _factor_prediction_metrics(momentum_predictions, actuals)
    walk_forward_folds = _panel_walk_forward_folds(
        rows,
        factor_names,
        horizon,
        selected["penalty"],
        fold_count=5,
    )
    positive_folds = sum(1 for fold in walk_forward_folds if fold.get("positive"))
    direction_lift = test_metrics["direction_hit_rate_pct"] - max(50.0, equal_metrics["direction_hit_rate_pct"], momentum_metrics["direction_hit_rate_pct"])
    baseline_mae = min(equal_metrics["mae"], momentum_metrics["mae"])
    mae_lift = baseline_mae - test_metrics["mae"]
    independent_test_blocks = len(test_dates) / max(1, horizon)
    abs_total = sum(abs(value) for value in deployment["weights"]) or 1.0
    coefficients = [
        {
            "name": name,
            "coefficient": round(deployment["weights"][index], 6),
            "abs_weight_pct": round(abs(deployment["weights"][index]) / abs_total * 100, 3),
            "direction": "positive" if deployment["weights"][index] >= 0 else "negative",
        }
        for index, name in enumerate(factor_names)
    ]
    coefficients.sort(key=lambda row: row["abs_weight_pct"], reverse=True)
    admission_checks = {
        "independentTestBlocks": independent_test_blocks >= 12,
        "directionLift": direction_lift >= 1.0,
        "maeImprovement": mae_lift > 0 and mae_lift / max(1e-9, baseline_mae) >= 0.01,
        "positiveIc": test_metrics["ic"] > 0,
        "positiveRankIc": test_metrics["rank_ic"] > 0,
        "validationIc": number(selected["validation"].get("ic")) > 0,
        "validationRankIc": number(selected["validation"].get("rank_ic")) > 0,
        "walkForwardFoldCount": len(walk_forward_folds) >= 5,
        "walkForwardStability": positive_folds >= 4,
        "netCostImprovement": test_metrics["avg_net_signal_return_pct"] > max(
            equal_metrics["avg_net_signal_return_pct"],
            momentum_metrics["avg_net_signal_return_pct"],
        ),
    }
    active = all(admission_checks.values())
    return {
        "available": True,
        "active": active,
        "framework": "cross-sectional-factor-ridge",
        "method": "Date-split cross-sectional ridge model with purge/embargo; factor scalers fit on train dates only.",
        "horizon_days": horizon,
        "selected_penalty": selected["penalty"],
        "split": {
            "train_dates": len(train_dates),
            "validation_dates": len(validation_dates),
            "test_dates": len(test_dates),
            "train_rows": len(train_rows),
            "validation_rows": len(validation_rows),
            "test_rows": len(test_rows),
        },
        "purge_dates": purge,
        "embargo_dates": embargo,
        "validation": selected["validation"],
        "test": test_metrics,
        "benchmarks": [
            {"name": "random_direction", "direction_hit_rate_pct": 50.0},
            {"name": "equal_weight_cross_section", **equal_metrics},
            {"name": f"single_{momentum_name}", **momentum_metrics},
        ],
        "direction_lift_pct": round(direction_lift, 3),
        "mae_lift_pct": round(mae_lift, 4),
        "mae_lift_relative_pct": round(mae_lift / max(1e-9, baseline_mae) * 100, 4),
        "independent_test_blocks": round(independent_test_blocks, 3),
        "walk_forward_folds": walk_forward_folds,
        "positive_walk_forward_folds": positive_folds,
        "admission_checks": admission_checks,
        "failed_checks": [name for name, passed in admission_checks.items() if not passed],
        "coefficients": coefficients,
        "guardrail": "Inactive unless holdout direction/rank IC beats simple baselines.",
    }


def analyze_cross_sectional_factors(
    items: list[dict[str, Any]],
    market: str = "ASX",
    horizons: list[int] | int | float | None = None,
    min_symbols: int = 4,
) -> dict[str, Any]:
    if horizons is not None and not isinstance(horizons, list):
        horizons = [int(number(horizons, 15))]
    horizons = [max(1, min(60, int(number(value, 15)))) for value in (horizons or [5, 15, 30])]
    horizons = list(dict.fromkeys(horizons))
    min_symbols = max(3, int(min_symbols or 4))
    prepared = [
        {
            "symbol": str(item.get("symbol") or ""),
            "sector": str(item.get("sector") or item.get("industry") or "Unknown"),
            "candles": item.get("candles") or [],
            "source": str(item.get("source") or ""),
        }
        for item in items or []
        if item.get("symbol") and item.get("candles")
    ]
    horizon_results: list[dict[str, Any]] = []
    aggregate_weights: dict[str, float] = {}
    aggregate_samples: dict[str, float] = {}
    factor_names = list(PANEL_FACTOR_FORMULAS)
    for horizon in horizons:
        panel_rows: list[dict[str, Any]] = []
        symbol_depths: list[dict[str, Any]] = []
        for item in prepared:
            rows = _panel_factor_rows(item["candles"], horizon, item["symbol"], item["sector"])
            if rows:
                panel_rows.extend(rows)
            symbol_depths.append({
                "symbol": item["symbol"],
                "sector": item["sector"],
                "rows": len(rows),
                "source": item["source"],
            })
        date_groups = _group_by_date(panel_rows)
        usable_dates = [date for date, rows in date_groups.items() if len({row["symbol"] for row in rows}) >= min_symbols]
        panel_rows = [row for row in panel_rows if row["date"] in set(usable_dates)]
        if len(panel_rows) < min_symbols * 20:
            horizon_results.append({
                "available": False,
                "horizon_days": horizon,
                "reason": "Not enough synchronized cross-sectional rows.",
                "row_count": len(panel_rows),
                "symbol_depths": symbol_depths,
            })
            continue
        matrix = {
            left: {
                right: round(_pearson(
                    [number(row["factors"].get(left)) for row in panel_rows],
                    [number(row["factors"].get(right)) for row in panel_rows],
                ), 4)
                for right in factor_names
            }
            for left in factor_names
        }
        clusters = _factor_cluster_map(factor_names, matrix, threshold=0.72)
        stats = [_panel_factor_metrics(panel_rows, name, min_symbols) for name in factor_names]
        ml_names = [
            row["name"] for row in stats
            if row["date_count"] >= 12 and abs(number(row["daily_rank_ic_mean"])) >= 0.005
        ] or [row["name"] for row in sorted(stats, key=lambda item: abs(number(item["daily_rank_ic_mean"])), reverse=True)[:8]]
        ml = _panel_ml_backtest(panel_rows, ml_names[:12], horizon)
        ml_lookup = {
            row["name"]: number(row.get("abs_weight_pct")) / 100
            for row in ml.get("coefficients", [])
        } if ml.get("available") else {}
        leaders: dict[str, str] = {}
        stats_by_name = {row["name"]: row for row in stats}
        for name, cluster in clusters.items():
            leaders[cluster["cluster"]] = max(cluster["members"], key=lambda member: abs(number(stats_by_name.get(member, {}).get("daily_rank_ic_mean"))))
        candidates = []
        for row in stats:
            name = row["name"]
            cluster = clusters.get(name, {"cluster": "solo", "members": [name], "size": 1})
            leader = leaders.get(cluster["cluster"], name)
            redundant = cluster.get("size", 1) > 1 and name != leader
            decay_penalty = max(0.0, abs(number(row["daily_rank_ic_mean"])) - abs(number(row["latest_rank_ic"]))) * 18
            if number(row["daily_rank_ic_mean"]) and number(row["latest_rank_ic"]) and number(row["daily_rank_ic_mean"]) * number(row["latest_rank_ic"]) < 0:
                decay_penalty += 5
            redundancy_penalty = 10 if redundant else 0
            model_gain = ml_lookup.get(name, 0.0) * (16 if ml.get("active") else 7)
            evidence_score = _factor_evidence_score(
                row,
                quantile_spread=number(row.get("quantile_spread_pct")),
                turnover_penalty=2.0,
                redundancy_penalty=redundancy_penalty,
                decay_penalty=decay_penalty,
                model_weight=ml_lookup.get(name, 0.0),
                ml_active=ml.get("active") is True,
            )
            base_score = (
                abs(number(row["daily_rank_ic_mean"])) * 42
                + abs(number(row["sector_neutral_rank_ic"])) * 28
                + max(0.0, number(row["quantile_spread_pct"])) * 1.9
                + max(0.0, number(row["positive_day_share_pct"]) - 50) * 0.12
                + min(8.0, number(row["stability"]) * 3.2)
                + model_gain
                - redundancy_penalty
                - decay_penalty
            )
            reasons = []
            if row["date_count"] < 120:
                reasons.append("too_few_cross_section_dates")
            if len({panel_row["symbol"] for panel_row in panel_rows}) < 30:
                reasons.append("too_few_cross_section_symbols")
            if abs(number(row["daily_rank_ic_mean"])) < 0.005 and abs(number(row["sector_neutral_rank_ic"])) < 0.005:
                reasons.append("weak_cross_section_rank_ic")
            if number(row["daily_rank_ic_mean"]) * row["direction"] <= 0:
                reasons.append("non_positive_directed_rank_ic")
            if number(row["sector_neutral_rank_ic"]) * row["direction"] <= 0:
                reasons.append("non_positive_sector_neutral_rank_ic")
            if redundant:
                reasons.append(f"redundant_with_{leader}")
            if decay_penalty >= 4:
                reasons.append("recent_cross_section_decay")
            if ml.get("active") is not True:
                reasons.append("cross_section_combo_failed_strict_oos_gate")
            if evidence_score["score"] < 70:
                reasons.append("factor_evidence_score_below_70")
            admitted = (
                not reasons
                and base_score > 0
                and ml_lookup.get(name, 0.0) >= 0.03
                and evidence_score["shadowPass"]
            )
            candidate = {
                **row,
                "status": "admitted" if admitted else "watchlist",
                "base_score": round(base_score, 4),
                "dynamic_weight_pct": 0.0,
                "ml_weight_hint_pct": round(ml_lookup.get(name, 0.0) * 100, 3),
                "redundancy": {
                    "cluster": cluster.get("cluster"),
                    "leader": leader,
                    "members": cluster.get("members", [name]),
                },
                "evidence_score": evidence_score,
                "reasons": reasons or ["passed_cross_section_admission"],
            }
            candidates.append(candidate)
        active_candidates = [row for row in candidates if row["status"] == "admitted" and row["base_score"] > 0]
        if not active_candidates:
            research_candidates = sorted([row for row in candidates if row["base_score"] > 0], key=lambda item: item["base_score"], reverse=True)[:6]
            for row in research_candidates:
                row["status"] = "research_only"
                row["reasons"].append("fallback_top_cross_section_candidate")
        else:
            research_candidates = []
        temperature = max(4.0, stddev(row["base_score"] for row in active_candidates) or 6.0)
        exp_rows = [(row, math.exp(clamp(row["base_score"] / temperature, -8, 8))) for row in active_candidates]
        exp_total = sum(value for _, value in exp_rows) or 1.0
        weights = []
        for row, exp_value in exp_rows:
            pct = exp_value / exp_total * 100
            row["dynamic_weight_pct"] = round(pct, 3)
            weights.append({
                "name": row["name"],
                "weight_pct": round(pct, 3),
                "direction": row["direction_label"],
                "status": row["status"],
                "score": row["base_score"],
            })
            aggregate_weights[row["name"]] = aggregate_weights.get(row["name"], 0.0) + pct * len(panel_rows)
            aggregate_samples[row["name"]] = aggregate_samples.get(row["name"], 0.0) + len(panel_rows)
        horizon_results.append({
            "available": True,
            "horizon_days": horizon,
            "row_count": len(panel_rows),
            "date_count": len(usable_dates),
            "symbol_count": len({row["symbol"] for row in panel_rows}),
            "min_symbols_per_date": min_symbols,
            "factor_count": len(factor_names),
            "admitted_count": len(active_candidates),
            "research_candidate_count": len(research_candidates),
            "weights": sorted(weights, key=lambda item: item["weight_pct"], reverse=True),
            "factors": sorted(candidates, key=lambda item: item["base_score"], reverse=True),
            "ml_backtest": ml,
            "correlation_matrix": matrix,
            "high_overlap": sorted([
                {"left": left, "right": right, "correlation": matrix[left][right]}
                for left_index, left in enumerate(factor_names)
                for right in factor_names[left_index + 1:]
                if abs(matrix[left][right]) >= 0.72
            ], key=lambda item: abs(item["correlation"]), reverse=True)[:30],
            "symbol_depths": symbol_depths,
        })
    aggregate = [
        {
            "name": name,
            "weight_pct": round(total / max(1.0, aggregate_samples.get(name, 1.0)), 3),
        }
        for name, total in aggregate_weights.items()
    ]
    total_weight = sum(row["weight_pct"] for row in aggregate) or 1.0
    for row in aggregate:
        row["weight_pct"] = round(row["weight_pct"] / total_weight * 100, 3)
    return {
        "available": any(row.get("available") for row in horizon_results),
        "framework": "market-cross-sectional-factor-research",
        "market": market,
        "horizons": horizons,
        "symbol_count": len(prepared),
        "min_symbols_per_date": min_symbols,
        "factor_library": [{"name": name, "formula": formula} for name, formula in PANEL_FACTOR_FORMULAS.items()],
        "aggregate_weights": sorted(aggregate, key=lambda item: item["weight_pct"], reverse=True),
        "horizon_results": horizon_results,
        "leakage_control": "For each date, factors use only candles at or before t; labels are future returns. ML split is chronological by date with purge/embargo between train, validation, and test.",
        "admission_policy": [
            "Prefer factors with stable daily Rank IC across the market.",
            "Require sector-neutral evidence when sector labels are available.",
            "Penalize highly correlated duplicate factors and recent IC decay.",
            "Use ML holdout coefficients only when they beat equal-weight and momentum baselines.",
            "Require a 100-point evidence score of at least 70 plus five walk-forward folds with at least four positive after costs.",
        ],
    }
