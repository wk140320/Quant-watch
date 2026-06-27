from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from typing import Any


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _time_value(value: Any) -> float:
    text = str(value or "").replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0.0


def sanitize_trades(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw in trades or []:
        price = number(raw.get("price") or raw.get("p"))
        size = number(raw.get("size") or raw.get("s"))
        timestamp = str(raw.get("timestamp") or raw.get("t") or "")
        if price <= 0 or size <= 0 or not timestamp:
            continue
        rows.append(
            {
                "timestamp": timestamp,
                "price": price,
                "size": size,
                "notional": price * size,
                "exchange": str(raw.get("exchange") or raw.get("x") or "")[:20],
                "trade_id": str(raw.get("trade_id") or raw.get("id") or raw.get("i") or "")[:120],
                "conditions": [str(item)[:30] for item in (raw.get("conditions") or raw.get("c") or [])][:20],
                "tape": str(raw.get("tape") or raw.get("z") or "")[:20],
                "sequence": number(raw.get("sequence") or raw.get("q"), 0),
            }
        )
    return sorted(rows, key=lambda row: (_time_value(row["timestamp"]), row["sequence"]))


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def analyze_trades(
    trades: list[dict[str, Any]],
    market: str = "US",
    symbol: str = "",
    source: str = "",
) -> dict[str, Any]:
    rows = sanitize_trades(trades)
    if not rows:
        return {
            "available": False,
            "market": market,
            "symbol": symbol,
            "source": source,
            "true_tick": False,
            "true_l2": False,
            "aggressor_side_available": False,
            "reason": "The authorised provider returned no usable real trades.",
            "trades": [],
        }

    total_size = sum(row["size"] for row in rows)
    total_notional = sum(row["notional"] for row in rows)
    vwap = total_notional / total_size if total_size else 0.0
    sizes = [row["size"] for row in rows]
    large_threshold = max(1.0, _percentile(sizes, 0.9))
    large_rows = [row for row in rows if row["size"] >= large_threshold]
    large_size = sum(row["size"] for row in large_rows)
    start_time = _time_value(rows[0]["timestamp"])
    end_time = _time_value(rows[-1]["timestamp"])
    duration_seconds = max(0.0, end_time - start_time)
    price_change_pct = (rows[-1]["price"] / rows[0]["price"] - 1) * 100 if rows[0]["price"] > 0 else 0.0

    exchanges: dict[str, dict[str, float]] = defaultdict(lambda: {"trades": 0.0, "size": 0.0, "notional": 0.0})
    minute_buckets: dict[str, dict[str, float]] = defaultdict(lambda: {"trades": 0.0, "size": 0.0, "notional": 0.0, "last_price": 0.0})
    for row in rows:
        exchange = row["exchange"] or "unknown"
        exchanges[exchange]["trades"] += 1
        exchanges[exchange]["size"] += row["size"]
        exchanges[exchange]["notional"] += row["notional"]
        minute = row["timestamp"][:16]
        minute_buckets[minute]["trades"] += 1
        minute_buckets[minute]["size"] += row["size"]
        minute_buckets[minute]["notional"] += row["notional"]
        minute_buckets[minute]["last_price"] = row["price"]

    return {
        "available": True,
        "market": market,
        "symbol": symbol,
        "source": source,
        "true_tick": True,
        "true_l2": False,
        "aggressor_side_available": False,
        "row_count": len(rows),
        "summary": {
            "first_timestamp": rows[0]["timestamp"],
            "last_timestamp": rows[-1]["timestamp"],
            "duration_seconds": round(duration_seconds, 3),
            "trade_rate_per_minute": round(len(rows) / max(1.0, duration_seconds / 60), 3),
            "first_price": round(rows[0]["price"], 6),
            "last_price": round(rows[-1]["price"], 6),
            "price_change_pct": round(price_change_pct, 4),
            "vwap": round(vwap, 6),
            "total_size": round(total_size, 4),
            "total_notional": round(total_notional, 2),
            "average_trade_size": round(total_size / len(rows), 4),
            "large_trade_threshold": round(large_threshold, 4),
            "large_trade_count": len(large_rows),
            "large_trade_size_share_pct": round(large_size / total_size * 100 if total_size else 0.0, 3),
            "exchange_count": len(exchanges),
        },
        "exchange_breakdown": [
            {
                "exchange": exchange,
                "trades": int(values["trades"]),
                "size": round(values["size"], 4),
                "notional": round(values["notional"], 2),
                "size_share_pct": round(values["size"] / total_size * 100 if total_size else 0.0, 3),
            }
            for exchange, values in sorted(exchanges.items(), key=lambda item: item[1]["size"], reverse=True)
        ],
        "minute_buckets": [
            {
                "minute": minute,
                "trades": int(values["trades"]),
                "size": round(values["size"], 4),
                "notional": round(values["notional"], 2),
                "vwap": round(values["notional"] / values["size"] if values["size"] else 0.0, 6),
                "last_price": round(values["last_price"], 6),
            }
            for minute, values in sorted(minute_buckets.items())
        ][-120:],
        "trades": [
            {
                **row,
                "price": round(row["price"], 6),
                "size": round(row["size"], 4),
                "notional": round(row["notional"], 2),
            }
            for row in rows[-200:]
        ],
        "quality": {
            "notes": [
                "These rows are real provider-reported trades, not candles or simulated ticks.",
                "The provider response does not include bid/ask quotes or aggressor side; buy/sell direction is intentionally unavailable.",
                "True L2/order-book depth requires a separately licensed quote/depth feed.",
            ]
        },
    }
