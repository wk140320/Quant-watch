from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _symbol(value: Any) -> str:
    return str(value or "").strip().upper()[:40]


def _market(value: Any) -> str:
    key = str(value or "ASX").strip().upper()
    return key if key in {"ASX", "US", "CN"} else "ASX"


def _position_row(raw: dict[str, Any], default_market: str) -> dict[str, Any] | None:
    symbol = _symbol(raw.get("symbol"))
    qty = max(0.0, number(raw.get("qty") or raw.get("quantity")))
    avg_price = max(0.0, number(raw.get("avgPrice") or raw.get("avg_price")))
    current_price = max(0.0, number(raw.get("currentPrice") or raw.get("current_price"), avg_price))
    if not symbol or qty <= 0 or current_price <= 0:
        return None
    value = qty * current_price
    cost = qty * avg_price
    pnl = value - cost
    pnl_pct = pnl / cost * 100 if cost > 0 else 0.0
    return {
        "symbol": symbol,
        "market": _market(raw.get("market") or default_market),
        "sector": str(raw.get("sector") or "未分类").strip()[:100],
        "qty": round(qty, 8),
        "avg_price": round(avg_price, 8),
        "current_price": round(current_price, 8),
        "value": round(value, 2),
        "cost": round(cost, 2),
        "pnl": round(pnl, 2),
        "pnl_pct": round(pnl_pct, 3),
        "change_5d_pct": round(number(raw.get("change5d") or raw.get("change_5d_pct")), 3),
        "volatility_pct": round(max(0.0, number(raw.get("volatility") or raw.get("volatility_pct"))), 3),
        "holding_days": max(0, int(number(raw.get("holdingDays") or raw.get("holding_days")))),
    }


def _drawdown(equity_history: list[Any]) -> tuple[float, float, float]:
    values: list[float] = []
    for item in equity_history or []:
        value = number(item.get("equity") if isinstance(item, dict) else item)
        if value > 0:
            values.append(value)
    if not values:
        return 0.0, 0.0, 0.0
    peak = values[0]
    max_drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        max_drawdown = min(max_drawdown, (value / peak - 1) * 100)
    current_drawdown = (values[-1] / max(values) - 1) * 100
    return round(current_drawdown, 3), round(max_drawdown, 3), round(max(values), 2)


def assess_portfolio(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    policy = payload.get("policy") if isinstance(payload.get("policy"), dict) else {}
    total_capital = max(0.0, number(payload.get("total_capital") or payload.get("totalCapital")))
    has_available_cash = "available_cash" in payload or "availableCash" in payload
    supplied_cash = max(0.0, number(payload.get("available_cash") or payload.get("availableCash")))
    reserve_cash_pct = clamp(number(policy.get("reserve_cash_pct") or policy.get("reserveCashPct"), 15), 0, 100)
    max_position_pct = clamp(number(policy.get("max_position_pct") or policy.get("maxPositionPct"), 20), 1, 100)
    max_sector_pct = clamp(number(policy.get("max_sector_pct") or policy.get("maxSectorPct"), 35), 1, 100)
    max_gross_exposure_pct = clamp(number(policy.get("max_gross_exposure_pct") or policy.get("maxGrossExposurePct"), 100), 1, 200)
    stop_loss_pct = clamp(abs(number(policy.get("stop_loss_pct") or policy.get("stopLossPct"), 4)), 0.1, 100)
    max_drawdown_pct = clamp(abs(number(policy.get("max_drawdown_pct") or policy.get("maxDrawdownPct"), 12)), 0.1, 100)

    positions = [
        row
        for row in (_position_row(item, market) for item in payload.get("positions") or [])
        if row is not None
    ]
    invested_value = sum(row["value"] for row in positions)
    if total_capital <= 0:
        total_capital = invested_value + supplied_cash
    available_cash = supplied_cash if has_available_cash else max(0.0, total_capital - invested_value)
    reserve_cash_value = total_capital * reserve_cash_pct / 100
    available_for_new_trades = max(0.0, available_cash - reserve_cash_value)
    gross_exposure_pct = invested_value / total_capital * 100 if total_capital > 0 else 0.0
    cash_pct = available_cash / total_capital * 100 if total_capital > 0 else 0.0
    current_drawdown_pct, max_observed_drawdown_pct, peak_equity = _drawdown(payload.get("equity_history") or [])

    sector_values: dict[str, float] = defaultdict(float)
    warnings: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    for row in positions:
        row["weight_pct"] = round(row["value"] / total_capital * 100 if total_capital > 0 else 0.0, 3)
        sector_values[row["sector"]] += row["value"]
        stop_hit = row["pnl_pct"] <= -stop_loss_pct or row["change_5d_pct"] <= -stop_loss_pct
        row["stop_hit"] = stop_hit
        if row["weight_pct"] > max_position_pct:
            warnings.append({
                "code": "POSITION_CONCENTRATION",
                "symbol": row["symbol"],
                "severity": "high",
                "message": f"{row['symbol']} 权重 {row['weight_pct']:.1f}% 超过单票上限 {max_position_pct:.1f}%。",
            })
        if stop_hit:
            blockers.append({
                "code": "STOP_LOSS_BREACH",
                "symbol": row["symbol"],
                "severity": "critical",
                "message": f"{row['symbol']} 已触发 {stop_loss_pct:.1f}% 止损复核条件。",
            })
        elif row["volatility_pct"] > stop_loss_pct:
            warnings.append({
                "code": "VOLATILITY_ABOVE_STOP",
                "symbol": row["symbol"],
                "severity": "medium",
                "message": f"{row['symbol']} 波动率 {row['volatility_pct']:.1f}% 高于止损宽度 {stop_loss_pct:.1f}%。",
            })

    sector_exposure = []
    for sector, value in sorted(sector_values.items(), key=lambda item: item[1], reverse=True):
        weight = value / total_capital * 100 if total_capital > 0 else 0.0
        sector_exposure.append({"sector": sector, "value": round(value, 2), "weight_pct": round(weight, 3)})
        if weight > max_sector_pct:
            warnings.append({
                "code": "SECTOR_CONCENTRATION",
                "sector": sector,
                "severity": "high",
                "message": f"{sector} 行业敞口 {weight:.1f}% 超过上限 {max_sector_pct:.1f}%。",
            })

    if gross_exposure_pct > max_gross_exposure_pct:
        blockers.append({
            "code": "GROSS_EXPOSURE_LIMIT",
            "severity": "critical",
            "message": f"总持仓敞口 {gross_exposure_pct:.1f}% 超过上限 {max_gross_exposure_pct:.1f}%。",
        })
    if available_cash < reserve_cash_value:
        blockers.append({
            "code": "RESERVE_CASH_BREACH",
            "severity": "high",
            "message": f"可用现金低于 {reserve_cash_pct:.1f}% 储备要求。",
        })
    if abs(current_drawdown_pct) >= max_drawdown_pct or abs(max_observed_drawdown_pct) >= max_drawdown_pct:
        blockers.append({
            "code": "DRAWDOWN_LIMIT",
            "severity": "critical",
            "message": f"组合回撤已触及 {max_drawdown_pct:.1f}% 上限。",
        })

    concentration = max((row["weight_pct"] for row in positions), default=0.0)
    sector_concentration = max((row["weight_pct"] for row in sector_exposure), default=0.0)
    risk_score = 100.0
    risk_score -= max(0.0, gross_exposure_pct - 70) * 0.35
    risk_score -= max(0.0, concentration - max_position_pct) * 1.25
    risk_score -= max(0.0, sector_concentration - max_sector_pct) * 0.8
    risk_score -= len(warnings) * 4
    risk_score -= len(blockers) * 14
    risk_score -= min(22, abs(current_drawdown_pct) * 1.4)
    risk_score = clamp(risk_score, 0, 100)
    status = "blocked" if blockers else "warning" if warnings else "within-policy"

    return {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "market": market,
        "status": status,
        "new_orders_allowed": not blockers,
        "order_execution_enabled": False,
        "risk_score": round(risk_score, 1),
        "capital": {
            "total_capital": round(total_capital, 2),
            "invested_value": round(invested_value, 2),
            "available_cash": round(available_cash, 2),
            "reserve_cash_value": round(reserve_cash_value, 2),
            "available_for_new_trades": round(available_for_new_trades, 2),
            "gross_exposure_pct": round(gross_exposure_pct, 3),
            "cash_pct": round(cash_pct, 3),
            "peak_equity": peak_equity,
            "current_drawdown_pct": current_drawdown_pct,
            "max_observed_drawdown_pct": max_observed_drawdown_pct,
        },
        "policy": {
            "reserve_cash_pct": reserve_cash_pct,
            "max_position_pct": max_position_pct,
            "max_sector_pct": max_sector_pct,
            "max_gross_exposure_pct": max_gross_exposure_pct,
            "stop_loss_pct": stop_loss_pct,
            "max_drawdown_pct": max_drawdown_pct,
        },
        "positions": positions,
        "sector_exposure": sector_exposure,
        "warnings": warnings,
        "blockers": blockers,
        "notes": [
            "风险引擎只使用传入的真实持仓、价格和资金数据；缺失字段不会被模拟。",
            "所有订单执行保持关闭；评估结果仅用于研究、提醒和 Paper 意图审计。",
        ],
    }


def build_paper_order_intent(payload: dict[str, Any]) -> dict[str, Any]:
    order = payload.get("order") if isinstance(payload.get("order"), dict) else {}
    mode = str(order.get("mode") or "paper").strip().lower()
    side = str(order.get("side") or "").strip().upper()
    symbol = _symbol(order.get("symbol"))
    market = _market(order.get("market") or payload.get("market"))
    qty = number(order.get("qty") or order.get("quantity"))
    limit_price = number(order.get("limit_price") or order.get("limitPrice") or order.get("price"))
    idempotency_key = str(order.get("idempotency_key") or order.get("idempotencyKey") or "").strip()[:160]
    errors: list[str] = []
    if mode != "paper":
        errors.append("Only paper order intents are accepted; live execution is disabled.")
    if side not in {"BUY", "SELL"}:
        errors.append("Side must be BUY or SELL.")
    if not symbol:
        errors.append("Symbol is required.")
    if qty <= 0:
        errors.append("Quantity must be greater than zero.")
    if limit_price <= 0:
        errors.append("A positive reference/limit price is required.")
    if not idempotency_key:
        errors.append("An idempotency key is required.")

    risk_payload = payload.get("risk") if isinstance(payload.get("risk"), dict) else {}
    risk_payload = {**risk_payload, "market": market}
    risk_result = assess_portfolio(risk_payload)
    if side == "BUY" and not risk_result["new_orders_allowed"]:
        errors.append("Portfolio risk policy blocks new buy intents.")
    value = max(0.0, qty * limit_price)
    available = number(risk_result["capital"]["available_for_new_trades"])
    if side == "BUY" and value > available + 0.01:
        errors.append("Buy intent exceeds available cash after reserve.")
    max_trade = number(risk_result["capital"]["total_capital"]) * number(risk_result["policy"]["max_position_pct"]) / 100
    if side == "BUY" and max_trade > 0 and value > max_trade + 0.01:
        errors.append("Buy intent exceeds the configured single-position cap.")
    if side == "SELL":
        held_qty = sum(
            number(row.get("qty") or row.get("quantity"))
            for row in risk_payload.get("positions") or []
            if _symbol(row.get("symbol")) == symbol
        )
        if held_qty <= 0:
            errors.append("Sell intent has no matching position in the supplied portfolio.")
        elif qty > held_qty + 0.0000001:
            errors.append("Sell intent quantity exceeds the supplied position quantity.")

    canonical = json.dumps(
        {"market": market, "symbol": symbol, "side": side, "qty": qty, "limit_price": limit_price, "idempotency_key": idempotency_key},
        sort_keys=True,
        separators=(",", ":"),
    )
    intent_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]
    return {
        "intent_id": intent_id,
        "idempotency_key": idempotency_key,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "market": market,
        "symbol": symbol,
        "side": side,
        "qty": round(max(0.0, qty), 8),
        "limit_price": round(max(0.0, limit_price), 8),
        "notional": round(value, 2),
        "mode": "paper",
        "status": "approved-for-audit-only" if not errors else "rejected",
        "approved": not errors,
        "order_sent": False,
        "order_execution_enabled": False,
        "errors": errors,
        "risk": risk_result,
    }
