"""Point-in-time executable label construction for market panels.

Labels are built from completed candles only.  The signal row is never used as
an entry fill: entry is the next completed session's open (or an explicitly
provided executable VWAP), and every label carries the exact time axis and
cost components used to derive it.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Iterable


LABEL_CONTRACT_VERSION = "labels-v2-next-session-executable"
HORIZONS = (1, 2, 3, 5, 10, 20)


def _number(value: Any, fallback: float | None = None) -> float | None:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else fallback
    except (TypeError, ValueError):
        return fallback


def _timestamp(row: dict[str, Any]) -> str | None:
    value = row.get("timestamp") or row.get("date") or row.get("datetime")
    return str(value) if value is not None else None


def _valid_bar(row: dict[str, Any]) -> bool:
    prices = [_number(row.get(key)) for key in ("open", "high", "low", "close")]
    return all(value is not None and value > 0 for value in prices) and float(prices[2]) <= float(prices[1])


def _tradability(row: dict[str, Any]) -> tuple[bool, str, list[str]]:
    reasons = []
    if row.get("isHalted") is True or row.get("halted") is True:
        reasons.append("halted")
    if row.get("noTrade") is True or row.get("tradable") is False:
        reasons.append("provider_non_tradable")
    if row.get("limitUp") is True:
        reasons.append("limit_up")
    if row.get("limitDown") is True:
        reasons.append("limit_down")
    if _number(row.get("volume"), 0.0) <= 0:
        reasons.append("no_volume")
    if not _valid_bar(row):
        reasons.append("invalid_ohlc")
    return not reasons, "provided" if any(key in row for key in ("tradable", "isHalted", "limitUp", "limitDown")) else "ohlcv_contract", reasons


def _cost_components(row: dict[str, Any], costs: dict[str, float]) -> dict[str, float]:
    values = {}
    for name in ("commissionBps", "spreadBps", "impactBps", "taxBps", "borrowBps"):
        values[name] = max(0.0, float(_number(row.get(name), costs.get(name, 0.0))))
    values["totalRoundTripBps"] = sum(values.values())
    return values


def _return_pct(start: float, end: float) -> float:
    return (end / start - 1.0) * 100.0 if start > 0 and end > 0 else math.nan


def _first_touch(window: list[dict[str, Any]], entry: float, target_pct: float, stop_pct: float) -> dict[str, Any]:
    target_day = None
    stop_day = None
    ambiguous = []
    for offset, row in enumerate(window, start=1):
        high_return = _return_pct(entry, float(_number(row.get("high"), entry)))
        low_return = _return_pct(entry, float(_number(row.get("low"), entry)))
        target_hit = high_return >= target_pct
        stop_hit = low_return <= -abs(stop_pct)
        if target_hit and target_day is None:
            target_day = offset
        if stop_hit and stop_day is None:
            stop_day = offset
        if target_hit and stop_hit:
            ambiguous.append(offset)
    if ambiguous:
        first_event = "ambiguous"
    elif target_day is not None and (stop_day is None or target_day < stop_day):
        first_event = "target"
    elif stop_day is not None and (target_day is None or stop_day < target_day):
        first_event = "stop"
    else:
        first_event = "timeout"
    return {
        "targetTouchDay": target_day,
        "stopTouchDay": stop_day,
        "ambiguousBarrierOrder": bool(ambiguous),
        "ambiguousBarrierDays": ambiguous,
        "firstBarrierEvent": first_event,
    }


def build_atomic_label(
    rows: list[dict[str, Any]],
    signal_index: int,
    horizon: int,
    *,
    costs: dict[str, float] | None = None,
    target_pct: float = 5.0,
    stop_pct: float = 4.0,
    alternate_entry: str = "next_session_close",
) -> dict[str, Any] | None:
    """Build one label; return ``None`` when the complete execution path is unavailable."""
    if horizon not in HORIZONS and horizon <= 0:
        raise ValueError("horizon must be a positive trading-day count")
    entry_index = signal_index + 1
    exit_index = entry_index + horizon - 1
    if signal_index < 0 or exit_index >= len(rows):
        return None
    signal = rows[signal_index]
    entry_row = rows[entry_index]
    window = rows[entry_index:exit_index + 1]
    if not _valid_bar(signal) or not _valid_bar(entry_row) or not all(_valid_bar(row) for row in window):
        return None
    entry_ok, entry_source_quality, entry_reasons = _tradability(entry_row)
    if not entry_ok:
        return {
            "contract": LABEL_CONTRACT_VERSION,
            "eligible": False,
            "eligibilityReason": "ENTRY_NOT_EXECUTABLE",
            "signalTimestamp": _timestamp(signal),
            "entryTimestamp": _timestamp(entry_row),
            "exitTimestamp": _timestamp(rows[exit_index]),
            "entryTradabilityReasons": entry_reasons,
            "tradabilitySource": entry_source_quality,
        }
    explicit_vwap = _number(entry_row.get("vwap"))
    entry_price = explicit_vwap if explicit_vwap and explicit_vwap > 0 else float(_number(entry_row.get("open")))
    entry_source = "next_session_vwap" if explicit_vwap and explicit_vwap > 0 else "next_session_open"
    exit_price = float(_number(rows[exit_index].get("close")))
    gross_return = _return_pct(entry_price, exit_price)
    cost = _cost_components(entry_row, costs or {})
    net_return = gross_return - cost["totalRoundTripBps"] / 100.0
    overnight = []
    intraday = []
    for current_index in range(entry_index, exit_index + 1):
        current = rows[current_index]
        previous = rows[current_index - 1]
        previous_close = float(_number(previous.get("close")))
        current_open = float(_number(current.get("open")))
        current_close = float(_number(current.get("close")))
        overnight.append(_return_pct(previous_close, current_open))
        intraday.append(_return_pct(current_open, current_close))
    highs = [float(_number(row.get("high"))) for row in window]
    lows = [float(_number(row.get("low"))) for row in window]
    target_pct = float(target_pct)
    stop_pct = abs(float(stop_pct))
    touches = _first_touch(window, entry_price, target_pct, stop_pct)
    alternate_price = float(_number(entry_row.get("close"), entry_price)) if alternate_entry == "next_session_close" else None
    return {
        "contract": LABEL_CONTRACT_VERSION,
        "eligible": True,
        "eligibilityReason": "OK",
        "signalTimestamp": _timestamp(signal),
        "entryTimestamp": _timestamp(entry_row),
        "exitTimestamp": _timestamp(rows[exit_index]),
        "signalIndex": signal_index,
        "entryIndex": entry_index,
        "exitIndex": exit_index,
        "signalPrice": float(_number(signal.get("close"))),
        "entryPrice": entry_price,
        "entrySource": entry_source,
        "exitPrice": exit_price,
        "exitSource": "horizon_close",
        "grossReturnPct": gross_return,
        "netReturnPct": net_return,
        "cost": cost,
        "overnightReturnPct": overnight,
        "intradayReturnPct": intraday,
        "mfePct": _return_pct(entry_price, max(highs)),
        "maePct": _return_pct(entry_price, min(lows)),
        "targetBarrierPct": target_pct,
        "stopBarrierPct": stop_pct,
        **touches,
        "netUpLabel": net_return > 0.0,
        "targetFirstLabel": touches["firstBarrierEvent"] == "target",
        "stopFirstLabel": touches["firstBarrierEvent"] == "stop",
        "timeoutLabel": touches["firstBarrierEvent"] == "timeout",
        "pathEligible": not touches["ambiguousBarrierOrder"],
        "delayedEntry": {
            "source": alternate_entry,
            "price": alternate_price,
            "netReturnPct": _return_pct(alternate_price, exit_price) - cost["totalRoundTripBps"] / 100.0 if alternate_price and alternate_price > 0 else None,
        },
        "tradabilitySource": entry_source_quality,
        "entryTradabilityReasons": entry_reasons,
    }


def build_symbol_labels(
    rows: list[dict[str, Any]],
    horizon: int,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    labels = []
    for index in range(max(0, len(rows) - horizon)):
        label = build_atomic_label(rows, index, horizon, **kwargs)
        if label is not None:
            labels.append(label)
    return labels


def _mean(values: list[float]) -> float | None:
    clean = [value for value in values if math.isfinite(value)]
    return sum(clean) / len(clean) if clean else None


def build_panel_labels(
    items: list[dict[str, Any]],
    horizon: int,
    *,
    min_sector_breadth: int = 10,
    min_cross_section_breadth: int = 100,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    """Add leave-one-out market/sector residual and cross-sectional labels."""
    output = []
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        for label in build_symbol_labels(item.get("candles") or [], horizon, **kwargs):
            if not label.get("eligible"):
                continue
            row = {"market": str(item.get("market") or "").upper(), "symbol": item.get("symbol"), "sector": item.get("sector"), **label}
            grouped[str(label.get("entryTimestamp"))].append(row)
    for day, group in grouped.items():
        market_values = [float(_number(row.get("netReturnPct"), 0.0)) for row in group]
        market_average = _mean(market_values)
        by_sector: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in group:
            if row.get("sector"):
                by_sector[str(row["sector"])].append(row)
        for row in group:
            peers = [other for other in group if other.get("symbol") != row.get("symbol")]
            peer_market = _mean([float(_number(other.get("netReturnPct"), 0.0)) for other in peers])
            row["marketResidualReturnPct"] = row["netReturnPct"] - (peer_market if peer_market is not None else market_average or 0.0)
            row["marketResidualUpLabel"] = row["marketResidualReturnPct"] > 0.0
            sector_peers = [other for other in by_sector.get(str(row.get("sector")), []) if other.get("symbol") != row.get("symbol")]
            if len(by_sector.get(str(row.get("sector")), [])) >= min_sector_breadth and sector_peers:
                sector_average = _mean([float(_number(other.get("netReturnPct"), 0.0)) for other in sector_peers]) or 0.0
                row["sectorResidualReturnPct"] = row["netReturnPct"] - sector_average
                row["sectorResidualUpLabel"] = row["sectorResidualReturnPct"] > 0.0
                row["sectorResidualEligible"] = True
            else:
                row["sectorResidualReturnPct"] = None
                row["sectorResidualUpLabel"] = None
                row["sectorResidualEligible"] = False
            row["crossSectionEligible"] = len(group) >= min_cross_section_breadth
            if row["crossSectionEligible"]:
                ordered = sorted(group, key=lambda value: float(_number(value.get("netReturnPct"), 0.0)))
                position = next(index for index, value in enumerate(ordered) if value is row)
                row["crossSectionGrade"] = position / max(1, len(ordered) - 1)
            else:
                row["crossSectionGrade"] = None
            row["labelDate"] = day
            output.append(row)
    return output


def volatility_scaled_return(
    return_pct: float,
    prior_returns_pct: Iterable[float],
    *,
    floor_pct: float = 1.0,
) -> dict[str, Any]:
    """Scale a realized return with volatility known at the signal time only."""
    history = [float(value) for value in prior_returns_pct if _number(value) is not None and math.isfinite(float(value))]
    if len(history) < 2:
        return {
            "available": False,
            "value": None,
            "volatilityPct": None,
            "reason": "At least two pre-signal returns are required.",
        }
    average = sum(history) / len(history)
    variance = sum((value - average) ** 2 for value in history) / (len(history) - 1)
    volatility = max(float(floor_pct), math.sqrt(max(0.0, variance)))
    realized = float(return_pct)
    return {
        "available": True,
        "value": realized / volatility,
        "returnPct": realized,
        "volatilityPct": volatility,
        "historyCount": len(history),
        "historyIsPreSignal": True,
        "floorPct": floor_pct,
    }


def event_car_label(
    event: dict[str, Any],
    *,
    event_return_pct: float,
    benchmark_return_pct: float,
    horizon: int,
) -> dict[str, Any]:
    """Create an event CAR using an event's first-publication timestamp."""
    available_at = event.get("available_at") or event.get("availableAt") or event.get("publishedAt")
    event_time = event.get("event_time") or event.get("eventTime")
    if not available_at or not event_time:
        return {
            "available": False,
            "label": None,
            "reason": "event_time and available_at are required for PIT CAR.",
            "horizon": horizon,
        }
    try:
        if str(available_at) < str(event_time):
            return {
                "available": False,
                "label": None,
                "reason": "available_at cannot precede event_time.",
                "horizon": horizon,
            }
    except TypeError:
        return {"available": False, "label": None, "reason": "Invalid event timestamps.", "horizon": horizon}
    return {
        "available": True,
        "eventTime": event_time,
        "availableAt": available_at,
        "horizon": horizon,
        "eventReturnPct": event_return_pct,
        "benchmarkReturnPct": benchmark_return_pct,
        "carPct": event_return_pct - benchmark_return_pct,
        "label": event_return_pct - benchmark_return_pct > 0.0,
    }


def purged_walk_forward_splits(
    dates: Iterable[str],
    *,
    horizon: int,
    n_splits: int = 5,
    embargo_days: int = 5,
    min_train_dates: int = 20,
    min_test_dates: int = 5,
) -> list[dict[str, Any]]:
    ordered = sorted({str(value) for value in dates if value})
    if horizon <= 0:
        raise ValueError("horizon must be positive")
    splits = []
    if len(ordered) < min_train_dates + min_test_dates:
        return splits
    separation = max(horizon, embargo_days)
    first_test_start = min_train_dates + separation
    available_test = len(ordered) - first_test_start
    test_size = max(min_test_dates, available_test // max(1, n_splits))
    for fold in range(n_splits):
        test_start = first_test_start + fold * test_size
        test_end = min(len(ordered), test_start + test_size)
        if test_end - test_start < min_test_dates:
            break
        train_end = max(0, test_start - max(horizon, embargo_days))
        train = ordered[:train_end]
        test = ordered[test_start:test_end]
        if len(train) < min_train_dates:
            continue
        splits.append({
            "fold": fold,
            "trainDates": train,
            "testDates": test,
            "purgeDays": horizon,
            "embargoDays": embargo_days,
            "trainEndBeforeTestStart": train[-1] < test[0],
            "overlap": bool(set(train) & set(test)),
        })
    return splits


__all__ = [
    "HORIZONS",
    "LABEL_CONTRACT_VERSION",
    "build_atomic_label",
    "build_panel_labels",
    "build_symbol_labels",
    "event_car_label",
    "purged_walk_forward_splits",
    "volatility_scaled_return",
]
