"""Paper-portfolio risk and executable backtest contracts.

This module contains no broker integration.  It is intentionally conservative:
invalid prices, stale data, or an unavailable model produce no trade.  The
backtest consumes only already-created signal rows and never manufactures a
signal for an empty day.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Iterable


PORTFOLIO_CONTRACT_SCHEMA = "portfolio-execution-contract-v2-paper-only"


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _clamp(value: Any, low: float, high: float, fallback: float = 0.0) -> float:
    return max(low, min(high, _number(value, fallback)))


def cost_impact(
    *,
    notional: float,
    average_dollar_volume: float | None,
    participation_rate: float = 0.10,
    spread_bps: float = 8.0,
    commission_bps: float = 1.0,
    impact_bps: float = 25.0,
) -> dict[str, Any]:
    """Estimate a transparent, monotone market-impact cost in basis points."""
    amount = max(0.0, _number(notional))
    liquidity = max(1.0, _number(average_dollar_volume, 0.0))
    participation = amount / liquidity
    rate = max(0.001, _number(participation_rate, 0.10))
    excess = max(0.0, participation / rate - 1.0)
    impact = max(0.0, _number(impact_bps, 25.0)) * math.sqrt(excess) if excess else 0.0
    total = max(0.0, _number(spread_bps, 8.0) / 2.0 + _number(commission_bps, 1.0) + impact)
    return {
        "schema": "transaction-cost-model-v2",
        "notional": amount,
        "averageDollarVolume": _number(average_dollar_volume, 0.0) if average_dollar_volume is not None else None,
        "participationRate": rate,
        "participationPct": participation * 100.0,
        "spreadBps": _number(spread_bps, 8.0),
        "commissionBps": _number(commission_bps, 1.0),
        "impactBps": impact,
        "totalBps": total,
        "totalPct": total / 100.0,
        "capacityWarning": participation > rate,
    }


def portfolio_constraint_audit(
    positions: Iterable[dict[str, Any]],
    *,
    equity: float,
    cash: float,
    max_positions: int = 6,
    max_position_pct: float = 0.12,
    max_sector_pct: float = 0.25,
    min_cash_pct: float = 0.25,
) -> dict[str, Any]:
    rows = [row for row in positions if isinstance(row, dict)]
    total_equity = max(1e-9, _number(equity))
    values = {str(row.get("symbol") or "").upper(): max(0.0, _number(row.get("marketValue"))) for row in rows if row.get("symbol")}
    sectors: dict[str, float] = defaultdict(float)
    for row in rows:
        symbol = str(row.get("symbol") or "").upper()
        sectors[str(row.get("sector") or "Unknown")] += values.get(symbol, 0.0)
    violations: list[dict[str, Any]] = []
    if len(values) > int(max_positions):
        violations.append({"type": "max_positions", "actual": len(values), "limit": int(max_positions)})
    for symbol, value in values.items():
        exposure = value / total_equity
        if exposure > max_position_pct + 1e-12:
            violations.append({"type": "single_position", "symbol": symbol, "actualPct": exposure, "limitPct": max_position_pct})
    for sector, value in sectors.items():
        exposure = value / total_equity
        if exposure > max_sector_pct + 1e-12:
            violations.append({"type": "sector", "sector": sector, "actualPct": exposure, "limitPct": max_sector_pct})
    cash_pct = max(0.0, _number(cash)) / total_equity
    if cash_pct + 1e-12 < min_cash_pct:
        violations.append({"type": "cash_reserve", "actualPct": cash_pct, "limitPct": min_cash_pct})
    return {
        "schema": PORTFOLIO_CONTRACT_SCHEMA,
        "compliant": not violations,
        "positionCount": len(values),
        "cashPct": cash_pct,
        "positionExposurePct": {symbol: value / total_equity for symbol, value in values.items()},
        "sectorExposurePct": {sector: value / total_equity for sector, value in sectors.items()},
        "violations": violations,
        "newBuysAllowed": not violations,
        "remediation": "freeze-and-gradual-exit" if violations else "none",
    }


def volatility_scale(
    *,
    forecast_volatility: float | None,
    target_volatility: float = 0.15,
    minimum: float = 0.25,
    maximum: float = 1.0,
) -> dict[str, Any]:
    forecast = max(0.0, _number(forecast_volatility, 0.0))
    target = max(1e-6, _number(target_volatility, 0.15))
    scale = maximum if forecast <= 0 else _clamp(target / forecast, minimum, maximum, maximum)
    return {"schema": "portfolio-volatility-scale-v1", "forecastVolatility": forecast_volatility, "targetVolatility": target, "scale": scale, "available": forecast > 0}


def paper_signal_decision(signal: dict[str, Any], *, min_expected_value_pct: float = 0.0) -> dict[str, Any]:
    """Translate one model signal into BUY/NO_TRADE without executing it."""
    if not isinstance(signal, dict):
        return {"action": "NO_TRADE", "reasons": ["invalid_signal"], "paperOnly": True}
    reasons: list[str] = []
    if signal.get("modelEvidenceOk") is not True:
        reasons.append("strict_oof_evidence_missing")
    if signal.get("dataQualityOk") is not True:
        reasons.append("data_quality_failed")
    if signal.get("marketOpen") is not True:
        reasons.append("market_closed")
    if signal.get("fresh") is not True:
        reasons.append("quote_stale_or_unverified")
    if _number(signal.get("expectedValuePct"), -1.0) <= min_expected_value_pct:
        reasons.append("cost_adjusted_expected_value_not_positive")
    if _number(signal.get("probability"), 0.0) < _number(signal.get("threshold"), 0.57):
        reasons.append("probability_below_threshold")
    return {"schema": "paper-signal-decision-v2", "action": "BUY" if not reasons else "NO_TRADE", "reasons": reasons, "paperOnly": True, "orderExecutionEnabled": False}


def run_executable_paper_backtest(
    rows: Iterable[dict[str, Any]],
    *,
    initial_cash: float = 100_000.0,
    max_position_pct: float = 0.12,
    min_cash_pct: float = 0.25,
) -> dict[str, Any]:
    """Replay precomputed next-session signals with cash and cost constraints."""
    ordered = sorted([row for row in rows if isinstance(row, dict)], key=lambda row: (str(row.get("signalDate") or row.get("date") or ""), str(row.get("symbol") or "")))
    cash = max(0.0, _number(initial_cash, 100_000.0))
    positions: dict[str, dict[str, float]] = {}
    equity_curve: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    no_trade: list[dict[str, Any]] = []
    for row in ordered:
        symbol = str(row.get("symbol") or "").upper()
        entry = _number(row.get("entryPrice"), 0.0)
        exit_price = _number(row.get("exitPrice"), 0.0)
        if not symbol or entry <= 0 or exit_price <= 0:
            no_trade.append({"symbol": symbol, "date": row.get("signalDate") or row.get("date"), "reason": "missing_executable_price"})
            continue
        decision = paper_signal_decision(row, min_expected_value_pct=0.0)
        if decision["action"] != "BUY":
            no_trade.append({"symbol": symbol, "date": row.get("signalDate") or row.get("date"), "reason": decision["reasons"]})
            continue
        current_equity = cash + sum(position["qty"] * position["entryPrice"] for position in positions.values())
        capacity = max(0.0, current_equity * (1.0 - min_cash_pct))
        notional = min(capacity, current_equity * max_position_pct)
        qty = math.floor(notional / entry)
        if qty <= 0:
            no_trade.append({"symbol": symbol, "date": row.get("signalDate") or row.get("date"), "reason": "cash_or_position_capacity"})
            continue
        cost = cost_impact(notional=qty * entry, average_dollar_volume=row.get("averageDollarVolume"))
        entry_cost = qty * entry * cost["totalPct"]
        gross = qty * (exit_price - entry)
        exit_cost = qty * exit_price * cost["totalPct"]
        net = gross - entry_cost - exit_cost
        cash -= qty * entry + entry_cost
        cash += qty * exit_price - exit_cost
        trades.append({"symbol": symbol, "signalDate": row.get("signalDate") or row.get("date"), "entryPrice": entry, "exitPrice": exit_price, "qty": qty, "grossPnl": gross, "netPnl": net, "cost": entry_cost + exit_cost, "paperOnly": True})
        equity_curve.append({"date": row.get("exitDate") or row.get("date"), "equity": cash, "cash": cash, "positions": 0})
    returns = [trade["netPnl"] / max(1e-9, _number(initial_cash, 100_000.0)) for trade in trades]
    winning = [value for value in returns if value > 0]
    losing = [value for value in returns if value < 0]
    profit_factor = sum(winning) / abs(sum(losing)) if losing else (float("inf") if winning else None)
    return {
        "schema": PORTFOLIO_CONTRACT_SCHEMA,
        "paperOnly": True,
        "orderExecutionEnabled": False,
        "initialCash": initial_cash,
        "finalCash": cash,
        "netReturnPct": (cash / max(1e-9, initial_cash) - 1.0) * 100.0,
        "tradeCount": len(trades),
        "winRatePct": len(winning) / max(1, len(returns)) * 100.0,
        "profitFactor": profit_factor,
        "trades": trades,
        "noTrade": no_trade,
        "equityCurve": equity_curve,
        "policy": "Only precomputed next-session executable signals may enter; no signal is invented for missing or rejected rows.",
    }


__all__ = ["PORTFOLIO_CONTRACT_SCHEMA", "cost_impact", "paper_signal_decision", "portfolio_constraint_audit", "run_executable_paper_backtest", "volatility_scale"]
