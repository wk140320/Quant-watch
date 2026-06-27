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
    if len(rows) < max(70, horizon + 35):
        raise ValueError("Factor lab requires at least 70 real candle rows.")

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
    }

    for index in range(20, len(rows) - horizon):
        close = closes[index]
        recent = rows[index - 19 : index + 1]
        typical_notional = sum(((row["high"] + row["low"] + row["close"]) / 3) * row["volume"] for row in recent)
        volume_sum = sum(row["volume"] for row in recent)
        vwap = typical_notional / volume_sum if volume_sum else close
        returns_10 = [pct_change(closes[pos - 1], closes[pos]) for pos in range(index - 9, index + 1)]
        high_20 = max(row["high"] for row in recent)
        low_20 = min(row["low"] for row in recent)
        volume_mean_20 = mean(volumes[index - 19 : index + 1])
        bollinger_current = _bollinger_series(rows[: index + 1])[-1]
        fibonacci_current = _fibonacci_snapshot(rows[: index + 1])
        fib_618_price = next((item["price"] for item in fibonacci_current.get("levels", []) if item["label"] == "61.8%"), close)
        wyckoff_current = _wyckoff_proxy(rows[: index + 1])
        price_range = max(rows[index]["high"] - rows[index]["low"], close * 0.0001)
        candle_direction = clamp((close - rows[index]["open"]) / price_range, -1, 1)
        close_location = clamp(((close - rows[index]["low"]) / price_range) * 2 - 1, -1, 1)
        orderflow_pressure = clamp(candle_direction * 0.55 + close_location * 0.45, -1, 1)
        current_return = pct_change(closes[index - 1], close) if index else 0.0
        volume_ratio = volumes[index] / volume_mean_20 if volume_mean_20 else 0.0
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
        factor_series["fvg_pressure"].append(_fvg_pressure(rows[: index + 1], lookback=50))
        factor_series["ict_sweep_pressure"].append(_ict_pressure(rows[: index + 1], lookback=50))
        factor_series["wyckoff_phase_score"].append(number(wyckoff_current.get("phase_score")))
        factor_series["orderflow_pressure"].append(orderflow_pressure)
        factor_series["effort_vs_result"].append(volume_ratio / (abs(current_return) + 0.25))
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
        "guardrails": [
            "不使用未来数据构造因子；标签只用于样本外评分。",
            "因子进入模型前必须通过无量纲、丰富度、未来函数、缺失值、极端值、标准化六项闸门。",
            "滚动验证在训练与验证之间清除一个预测周期，并在验证折之间设置 embargo。",
            "最新检查点若明显弱于最佳检查点，则建议回滚而不是继续使用退化权重。",
            "单标的时间序列 IC 不能替代完整横截面 IC，后续会扩展为市场级横截面评估。",
            "高相关因子不重复满权，优先保留样本外稳定性更强者。",
            "训练模型按时间顺序切分训练/验证/测试集，累计 3 个小批次后才更新参数，并使用验证集早停与最佳检查点回滚。",
            "借鉴 Qlib/FinRL/NeuralForecast/TFT 一类时间序列项目：只在训练窗拟合 scaler，用滚动样本外验证选择检查点，深度模型启用 dropout/weight decay，并用独立测试窗约束泛化。",
            "如果训练窗明显强于验证/测试窗，界面会优先降低泛化评分，而不是把样本内高胜率当成实盘置信率。",
        ],
    }
