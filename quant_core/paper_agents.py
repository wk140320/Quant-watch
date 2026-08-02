from __future__ import annotations

import hashlib
import json
import math
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from store import _connect, _json


AGENT_DEFINITIONS = (
    ("momentum", "趋势 Agent", "momentum", 1.0),
    ("reversion", "回撤 Agent", "reversion", 0.85),
    ("breakout", "突破训练 Agent", "breakout", 1.12),
    ("news-flow", "新闻资金流 Agent", "news-flow", 0.95),
    ("risk-balanced", "稳健配置 Agent", "risk-balanced", 0.72),
)

STYLE_ENTRY = {"momentum": 60.0, "reversion": 56.0, "breakout": 53.0, "news-flow": 55.0, "risk-balanced": 62.0}
STYLE_EXIT = {"momentum": 46.0, "reversion": 43.0, "breakout": 47.0, "news-flow": 45.0, "risk-balanced": 52.0}
STYLE_SIZING = {
    "momentum": (0.18, 0.045, 0.16),
    "reversion": (0.14, 0.034, 0.12),
    "breakout": (0.12, 0.028, 0.09),
    "news-flow": (0.15, 0.036, 0.13),
    "risk-balanced": (0.10, 0.026, 0.08),
}
STYLE_STOP = {"momentum": 1.0, "reversion": 0.78, "breakout": 0.72, "news-flow": 0.85, "risk-balanced": 0.68}
STYLE_TAKE = {"momentum": 0.55, "reversion": 0.48, "breakout": 0.42, "news-flow": 0.55, "risk-balanced": 0.70}
STYLE_HOLD = {"momentum": 0.85, "reversion": 0.52, "breakout": 0.42, "news-flow": 0.62, "risk-balanced": 0.82}
REAL_SOURCE_DENY = ("simulated", "synthetic", "mock", "demo", "fixture", "proxy-price")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _market(value: Any) -> str:
    key = str(value or "ASX").upper()
    return key if key in {"ASX", "US", "CN"} else "ASX"


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def _clamp(value: Any, low: float, high: float) -> float:
    return max(low, min(high, _number(value)))


def _default_capital(market: str) -> float:
    return 100000.0 if market == "CN" else 10000.0


def _default_agent(agent_id: str, name: str, style: str, aggressiveness: float, capital: float, market: str) -> dict[str, Any]:
    return {
        "id": agent_id,
        "name": f"{market} {name}",
        "style": style,
        "cash": capital,
        "initialCapital": capital,
        "equity": capital,
        "previousEquity": capital,
        "positionValue": 0.0,
        "returnPct": 0.0,
        "positions": {},
        "trades": [],
        "learning": {"aggressiveness": aggressiveness, "confidenceBias": 0.0, "symbolBias": {}},
        "stats": {"wins": 0, "losses": 0, "trades": 0, "closedTrades": 0},
    }


def default_state(market: str = "ASX", initial_capital: float | None = None) -> dict[str, Any]:
    key = _market(market)
    capital = max(1.0, _number(initial_capital, _default_capital(key)))
    return {
        "market": key,
        "updatedAt": _now(),
        "revision": 0,
        "migrationId": None,
        "config": {"initialCapital": capital, "enabled": True},
        "ledger": {
            "market": key,
            "updatedAt": _now(),
            "agents": [_default_agent(*definition, capital, key) for definition in AGENT_DEFINITIONS],
        },
        "memory": {
            "market": key,
            "updatedAt": _now(),
            "archives": [],
            "agents": {},
            "strategyBook": {},
            "symbolBias": {},
            "transferCandidates": [],
            "lossLessons": [],
            "totalReplayTrades": 0,
            "totalPaperTrades": 0,
        },
        "order_execution_enabled": False,
    }


def _normalise_agent(agent: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    row = {**fallback, **(agent or {})}
    row["positions"] = row.get("positions") if isinstance(row.get("positions"), dict) else {}
    row["trades"] = row.get("trades") if isinstance(row.get("trades"), list) else []
    learning = row.get("learning") if isinstance(row.get("learning"), dict) else {}
    row["learning"] = {
        "aggressiveness": _clamp(learning.get("aggressiveness", fallback["learning"]["aggressiveness"]), 0.55, 1.45),
        "confidenceBias": _clamp(learning.get("confidenceBias", 0), -5, 5),
        "symbolBias": learning.get("symbolBias") if isinstance(learning.get("symbolBias"), dict) else {},
    }
    stats = row.get("stats") if isinstance(row.get("stats"), dict) else {}
    row["stats"] = {name: int(max(0, _number(stats.get(name), 0))) for name in ("wins", "losses", "trades", "closedTrades")}
    for name in ("cash", "initialCapital", "equity", "previousEquity", "positionValue", "returnPct"):
        row[name] = _number(row.get(name), fallback.get(name, 0.0))
    return row


def _normalise_state(state: dict[str, Any], market: str) -> dict[str, Any]:
    key = _market(market)
    config = state.get("config") if isinstance(state.get("config"), dict) else {}
    capital = max(1.0, _number(config.get("initialCapital"), _default_capital(key)))
    defaults = default_state(key, capital)
    ledger = state.get("ledger") if isinstance(state.get("ledger"), dict) else {}
    incoming_agents = ledger.get("agents") if isinstance(ledger.get("agents"), list) else []
    by_id = {str(row.get("id")): row for row in incoming_agents if isinstance(row, dict)}
    agents = [_normalise_agent(by_id.get(fallback["id"], {}), fallback) for fallback in defaults["ledger"]["agents"]]
    memory = state.get("memory") if isinstance(state.get("memory"), dict) else {}
    normalized_memory = deepcopy(memory)
    normalized_memory.update({
        "market": key,
        "updatedAt": str(memory.get("updatedAt") or _now()),
        "archives": memory.get("archives") if isinstance(memory.get("archives"), list) else [],
        "agents": memory.get("agents") if isinstance(memory.get("agents"), dict) else {},
        "strategyBook": memory.get("strategyBook") if isinstance(memory.get("strategyBook"), dict) else {},
        "symbolBias": memory.get("symbolBias") if isinstance(memory.get("symbolBias"), dict) else {},
        "transferCandidates": memory.get("transferCandidates") if isinstance(memory.get("transferCandidates"), list) else [],
        "lossLessons": memory.get("lossLessons") if isinstance(memory.get("lossLessons"), list) else [],
        "totalReplayTrades": int(max(0, _number(memory.get("totalReplayTrades"), 0))),
        "totalPaperTrades": int(max(0, _number(memory.get("totalPaperTrades"), 0))),
    })
    return {
        "market": key,
        "updatedAt": str(state.get("updatedAt") or _now()),
        "revision": int(max(0, _number(state.get("revision"), 0))),
        "migrationId": state.get("migrationId"),
        "config": {"initialCapital": capital, "enabled": config.get("enabled") is not False},
        "ledger": {"market": key, "updatedAt": str(ledger.get("updatedAt") or _now()), "agents": agents},
        "memory": normalized_memory,
        "order_execution_enabled": False,
    }


def load_state(market: str = "ASX", db_path: str | None = None) -> dict[str, Any]:
    key = _market(market)
    with _connect(db_path) as connection:
        row = connection.execute(
            "SELECT updated_at, revision, migration_id, config_json, ledger_json, memory_json FROM paper_agent_state WHERE market = ?",
            (key,),
        ).fetchone()
    if not row:
        state = default_state(key)
        save_state(state, db_path)
        return state
    return _normalise_state({
        "market": key,
        "updatedAt": row["updated_at"],
        "revision": row["revision"],
        "migrationId": row["migration_id"],
        "config": json.loads(row["config_json"]),
        "ledger": json.loads(row["ledger_json"]),
        "memory": json.loads(row["memory_json"]),
    }, key)


def save_state(state: dict[str, Any], db_path: str | None = None) -> dict[str, Any]:
    key = _market(state.get("market"))
    row = _normalise_state(state, key)
    row["updatedAt"] = _now()
    row["ledger"]["updatedAt"] = row["updatedAt"]
    row["memory"]["updatedAt"] = row["updatedAt"]
    with _connect(db_path) as connection:
        existing = connection.execute("SELECT revision FROM paper_agent_state WHERE market = ?", (key,)).fetchone()
        row["revision"] = max(int(existing["revision"]) if existing else 0, int(row.get("revision") or 0)) + 1
        connection.execute(
            """
            INSERT INTO paper_agent_state(market, updated_at, revision, migration_id, config_json, ledger_json, memory_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(market) DO UPDATE SET updated_at=excluded.updated_at, revision=excluded.revision,
              migration_id=excluded.migration_id, config_json=excluded.config_json,
              ledger_json=excluded.ledger_json, memory_json=excluded.memory_json
            """,
            (key, row["updatedAt"], row["revision"], row.get("migrationId"), _json(row["config"]), _json(row["ledger"]), _json(row["memory"])),
        )
    return row


def configure(payload: dict[str, Any]) -> dict[str, Any]:
    state = load_state(payload.get("market"), payload.get("db_path"))
    config = payload.get("config") if isinstance(payload.get("config"), dict) else payload
    if "enabled" in config:
        state["config"]["enabled"] = config.get("enabled") is not False
    if _number(config.get("initialCapital"), 0) > 0:
        next_capital = _number(config.get("initialCapital"))
        state["config"]["initialCapital"] = next_capital
        for agent in state["ledger"]["agents"]:
            previous_capital = max(1.0, _number(agent.get("initialCapital"), next_capital))
            cash_adjustment = next_capital - previous_capital
            agent["initialCapital"] = next_capital
            agent["cash"] = max(0.0, _number(agent.get("cash")) + cash_adjustment)
            agent["positionValue"] = max(0.0, _number(agent.get("positionValue")))
            agent["equity"] = agent["cash"] + agent["positionValue"]
            agent["previousEquity"] = agent["equity"]
            agent["returnPct"] = (agent["equity"] / next_capital - 1.0) * 100.0
    return save_state(state, payload.get("db_path"))


def reset(payload: dict[str, Any]) -> dict[str, Any]:
    current = load_state(payload.get("market"), payload.get("db_path"))
    replacement = default_state(current["market"], current["config"]["initialCapital"])
    replacement["memory"] = current["memory"] if payload.get("preserveMemory", True) else replacement["memory"]
    replacement["migrationId"] = current.get("migrationId")
    return save_state(replacement, payload.get("db_path"))


def _agent_activity(agent: dict[str, Any]) -> tuple[int, int, int]:
    trades = len(agent.get("trades")) if isinstance(agent.get("trades"), list) else 0
    positions = len(agent.get("positions")) if isinstance(agent.get("positions"), dict) else 0
    stats = agent.get("stats") if isinstance(agent.get("stats"), dict) else {}
    recorded = int(max(0, _number(stats.get("trades"), 0)))
    return trades, positions, recorded


def _merge_migrated_ledger(current: dict[str, Any], incoming: Any) -> dict[str, Any]:
    if not isinstance(incoming, dict):
        return current
    current_agents = current.get("agents") if isinstance(current.get("agents"), list) else []
    incoming_agents = incoming.get("agents") if isinstance(incoming.get("agents"), list) else []
    current_by_id = {str(agent.get("id")): agent for agent in current_agents if isinstance(agent, dict)}
    incoming_by_id = {str(agent.get("id")): agent for agent in incoming_agents if isinstance(agent, dict)}
    merged = []
    for agent_id in dict.fromkeys([*current_by_id, *incoming_by_id]):
        existing = current_by_id.get(agent_id)
        candidate = incoming_by_id.get(agent_id)
        if existing is None:
            merged.append(candidate)
        elif candidate is None:
            merged.append(existing)
        else:
            existing_score = _agent_activity(existing)
            candidate_score = _agent_activity(candidate)
            merged.append(candidate if candidate_score > existing_score else existing)
    if not merged:
        return current
    return {
        **incoming,
        **current,
        "updatedAt": max(str(current.get("updatedAt") or ""), str(incoming.get("updatedAt") or "")) or _now(),
        "agents": merged,
    }


def _merge_unique_rows(primary: Any, secondary: Any) -> list[Any]:
    rows = []
    seen = set()
    for value in [*(primary if isinstance(primary, list) else []), *(secondary if isinstance(secondary, list) else [])]:
        marker = hashlib.sha256(_json(value).encode("utf-8")).hexdigest()
        if marker in seen:
            continue
        seen.add(marker)
        rows.append(value)
    return rows


def _merge_migrated_memory(current: dict[str, Any], incoming: Any) -> dict[str, Any]:
    if not isinstance(incoming, dict):
        return current
    merged = {**incoming, **current}
    for name in ("agents", "strategyBook", "symbolBias"):
        incoming_map = incoming.get(name) if isinstance(incoming.get(name), dict) else {}
        current_map = current.get(name) if isinstance(current.get(name), dict) else {}
        merged[name] = {**incoming_map, **current_map}
    for name in ("archives", "transferCandidates", "lossLessons"):
        merged[name] = _merge_unique_rows(current.get(name), incoming.get(name))
    for name in ("totalReplayTrades", "totalPaperTrades"):
        merged[name] = int(max(_number(current.get(name), 0), _number(incoming.get(name), 0)))
    merged["updatedAt"] = max(str(current.get("updatedAt") or ""), str(incoming.get("updatedAt") or "")) or _now()
    return merged


def _memory_activity(memory: Any) -> int:
    if not isinstance(memory, dict):
        return 0
    list_count = sum(len(memory.get(name)) for name in ("archives", "transferCandidates", "lossLessons") if isinstance(memory.get(name), list))
    map_count = sum(len(memory.get(name)) for name in ("agents", "strategyBook", "symbolBias") if isinstance(memory.get(name), dict))
    counters = int(max(_number(memory.get("totalReplayTrades"), 0), _number(memory.get("totalPaperTrades"), 0)))
    return list_count + map_count + counters


def migrate(payload: dict[str, Any]) -> dict[str, Any]:
    key = _market(payload.get("market"))
    migration_id = str(payload.get("migrationId") or "browser-agent-v1")[:160]
    current = load_state(key, payload.get("db_path"))
    config_by_market = payload.get("agentConfigByMarket") if isinstance(payload.get("agentConfigByMarket"), dict) else {}
    ledger_by_market = payload.get("agentLedgerByMarket") if isinstance(payload.get("agentLedgerByMarket"), dict) else {}
    memory_by_market = payload.get("agentMemoryByMarket") if isinstance(payload.get("agentMemoryByMarket"), dict) else {}
    incoming_ledger = ledger_by_market.get(key)
    merged_ledger = _merge_migrated_ledger(current["ledger"], incoming_ledger)
    current_activity = sum(sum(_agent_activity(agent)) for agent in current["ledger"].get("agents", []))
    incoming_activity = sum(sum(_agent_activity(agent)) for agent in (incoming_ledger or {}).get("agents", []) if isinstance(agent, dict)) if isinstance(incoming_ledger, dict) else 0
    incoming_memory = memory_by_market.get(key)
    if current.get("migrationId") == migration_id and incoming_activity <= current_activity and _memory_activity(incoming_memory) <= _memory_activity(current["memory"]):
        return {**current, "migrated": False, "duplicate": True}
    incoming_config = config_by_market.get(key) if isinstance(config_by_market.get(key), dict) else None
    candidate = {
        "market": key,
        "config": current["config"] if current_activity > incoming_activity else incoming_config or current["config"],
        "ledger": merged_ledger,
        "memory": _merge_migrated_memory(current["memory"], incoming_memory),
        "migrationId": migration_id,
        "revision": current["revision"],
    }
    saved = save_state(candidate, payload.get("db_path"))
    return {**saved, "migrated": True, "duplicate": False}


def _analysis(item: dict[str, Any]) -> dict[str, Any]:
    return item.get("analysis") if isinstance(item.get("analysis"), dict) else {}


def _technicals(item: dict[str, Any]) -> dict[str, Any]:
    return item.get("technicals") if isinstance(item.get("technicals"), dict) else {}


def _probability(analysis: dict[str, Any], *names: str, fallback: float = 50.0) -> float:
    for name in names:
        if name in analysis:
            return _clamp(analysis.get(name), 0, 100)
    return fallback


def _factor_score(item: dict[str, Any]) -> float:
    factors = item.get("factors") if isinstance(item.get("factors"), dict) else {}
    values = [_number(row.get("score")) for row in factors.values() if isinstance(row, dict) and row.get("available") is not False]
    return sum(values) / len(values) if values else 0.0


def _evidence(item: dict[str, Any]) -> float:
    analysis = _analysis(item)
    technicals = _technicals(item)
    news_count = len(item.get("news") or [])
    factor_count = len([row for row in (item.get("factors") or {}).values() if isinstance(row, dict) and row.get("available") is not False])
    return _clamp(34 + min(16, news_count * 2.2) + min(14, factor_count * 3.2) + _factor_score(item) * 0.22 + max(0, _number(analysis.get("confidence")) - 55) * 0.22 + max(0, _number(technicals.get("volumeRatio"), 1) - 1) * 4, 0, 100)


def decision_score(agent: dict[str, Any], item: dict[str, Any], market_bias: float = 0.0) -> float:
    analysis = _analysis(item)
    technicals = _technicals(item)
    confidence = _number(analysis.get("confidence"), 50)
    final_return = _number(analysis.get("projectedFinalReturn", analysis.get("projectedUpside")), 0)
    max_upside = _number(analysis.get("projectedMaxUpside", analysis.get("projectedUpside")), 0)
    downside = _number(analysis.get("downsideConfidence"), 50)
    trend = _number(technicals.get("trendScore"), 50)
    risk = _number(technicals.get("riskScore"), 50)
    rsi = _number(technicals.get("rsi"), 50)
    volume = _number(technicals.get("volumeRatio"), 1)
    change5d = _number(technicals.get("change5d"), 0)
    learning = agent.get("learning") or {}
    learned = _number((learning.get("symbolBias") or {}).get(item.get("symbol"))) + _number(learning.get("confidenceBias"))
    evidence = _evidence(item)
    target_prob = _probability(analysis, "strategyHitProbability", "targetProbability")
    final_prob = _probability(analysis, "finalReturnProbability", "upProbability")
    max_prob = _probability(analysis, "maxUpsideProbability", "touchProbability")
    style = agent.get("style")
    if style == "reversion":
        return _clamp(46 + (50-rsi)*0.75 + max_upside*2.4 + (confidence-55)*0.22 + market_bias*0.55 + evidence*0.08 + learned, 0, 100)
    if style == "breakout":
        return _clamp(35 + (confidence-48)*0.42 + max_upside*3.1 + (trend-48)*0.22 + (volume-1)*11 + max(0, change5d)*0.45 + max_prob*0.08 + market_bias*0.7 + learned, 0, 100)
    if style == "news-flow":
        return _clamp(34 + evidence*0.34 + _factor_score(item)*0.2 + target_prob*0.12 + final_return*2.6 + (trend-50)*0.12 + market_bias*0.55 + learned, 0, 100)
    if style == "risk-balanced":
        return _clamp(28 + confidence*0.24 + target_prob*0.18 + final_prob*0.1 + (risk-45)*0.28 + max(0, trend-50)*0.14 + evidence*0.08 - max(0, downside-45)*0.18 + learned*0.6, 0, 100)
    return _clamp(38 + (confidence-50)*0.5 + final_return*3.2 + max_upside*1.1 + (trend-50)*0.24 + (volume-1)*8 + evidence*0.08 + market_bias*0.9 + learned, 0, 100)


def _cost_model(market: str, item: dict[str, Any], notional: float = 0.0) -> dict[str, Any]:
    technicals = _technicals(item)
    price = max(0.0000001, _number(item.get("price"), _number(technicals.get("close"), 1)))
    commission_pct = {"ASX": 0.08, "US": 0.045, "CN": 0.07}[market]
    bid = _number(item.get("bid"), _number((item.get("l1") or {}).get("bid")))
    ask = _number(item.get("ask"), _number((item.get("l1") or {}).get("ask")))
    explicit_spread = _number(item.get("spreadPct"), _number(technicals.get("spreadPct")))
    if explicit_spread > 0:
        spread_pct = explicit_spread / 2
    elif bid > 0 and ask >= bid:
        spread_pct = (ask - bid) / max(0.0000001, (ask + bid) / 2) * 50
    else:
        spread_pct = {"ASX": 0.055, "US": 0.025, "CN": 0.045}[market]

    volume_ratio = max(0.05, _number(technicals.get("volumeRatio"), 1))
    atr_pct = abs(_number(technicals.get("atrPct"), _number(item.get("atrPct"), 1.2)))
    volatility_slippage_pct = min(0.45, 0.012 + atr_pct * 0.012 + max(0, 0.9-volume_ratio) * 0.08)
    degraded_pct = 0.025 if (item.get("marketValidation") or {}).get("degraded") else 0.0

    average_dollar_volume = _number(
        item.get("averageDollarVolume"),
        _number(technicals.get("averageDollarVolume"), _number(technicals.get("averageVolume20")) * price),
    )
    max_participation = {"ASX": 0.01, "US": 0.005, "CN": 0.008}[market]
    participation = notional / average_dollar_volume if notional > 0 and average_dollar_volume > 0 else 0.0
    impact_pct = min(0.8, (0.055 + atr_pct * 0.008) * math.sqrt(max(0.0, participation)))
    max_trade_notional = average_dollar_volume * max_participation if average_dollar_volume > 0 else None
    capacity_blocked = bool(max_trade_notional is not None and notional > max_trade_notional * 1.05)
    total_pct = commission_pct + spread_pct + volatility_slippage_pct + impact_pct + degraded_pct
    return {
        "totalPct": round(total_pct, 4),
        "commissionPct": round(commission_pct, 4),
        "halfSpreadPct": round(spread_pct, 4),
        "volatilitySlippagePct": round(volatility_slippage_pct, 4),
        "marketImpactPct": round(impact_pct, 4),
        "degradedDataPenaltyPct": round(degraded_pct, 4),
        "participationRatePct": round(participation * 100, 5),
        "averageDollarVolume": round(average_dollar_volume, 2) if average_dollar_volume > 0 else None,
        "maxTradeNotional": round(max_trade_notional, 2) if max_trade_notional is not None else None,
        "capacityBlocked": capacity_blocked,
        "method": "commission+half-spread+volatility-slippage+sqrt-impact",
    }


def _cost_pct(market: str, item: dict[str, Any], notional: float = 0.0) -> float:
    return _number(_cost_model(market, item, notional).get("totalPct"))


def _source_is_real(source: str) -> bool:
    clean = str(source or "").strip().lower()
    return bool(clean) and not any(token in clean for token in REAL_SOURCE_DENY)


def _event_key(market: str, agent_id: str, symbol: str, bar_ts: str, event_type: str) -> str:
    raw = f"{market}:{agent_id}:{symbol}:{bar_ts}:{event_type}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _record_event(connection: Any, event: dict[str, Any]) -> bool:
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO paper_agent_events(created_at, market, agent_id, symbol, bar_ts, event_type,
          idempotency_key, price, quantity, pnl_pct, source, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (event["createdAt"], event["market"], event["agentId"], event["symbol"], event["barTs"], event["type"],
         event["idempotencyKey"], event.get("price"), event.get("qty"), event.get("pnlPct"), event.get("source"), _json(event)),
    )
    return cursor.rowcount > 0


def _mark(agent: dict[str, Any], prices: dict[str, float]) -> None:
    position_value = 0.0
    for symbol, position in agent["positions"].items():
        price = _number(prices.get(symbol), _number(position.get("lastPrice"), _number(position.get("avgPrice"))))
        position["lastPrice"] = price
        position_value += price * _number(position.get("qty"))
    agent["positionValue"] = round(position_value, 2)
    agent["equity"] = round(_number(agent.get("cash")) + position_value, 2)
    agent["returnPct"] = ((_number(agent.get("equity")) - _number(agent.get("initialCapital"))) / max(1, _number(agent.get("initialCapital")))) * 100


def _threshold(agent: dict[str, Any]) -> float:
    return _clamp(STYLE_ENTRY.get(agent.get("style"), 58) - _number((agent.get("learning") or {}).get("confidenceBias"))*0.35, 49, 68)


def _trade_event(agent: dict[str, Any], item: dict[str, Any], event_type: str, qty: float, price: float, reason: str, cost_model: dict[str, Any], pnl_pct: float = 0.0) -> dict[str, Any]:
    market = _market(item.get("market"))
    bar_ts = str(item.get("barTs") or item.get("priceTs") or item.get("updatedAt") or "")
    return {
        "createdAt": _now(), "market": market, "agentId": agent["id"], "agentName": agent["name"],
        "symbol": str(item.get("symbol") or "").upper(), "barTs": bar_ts, "type": event_type,
        "side": "BUY" if event_type == "paper-buy" else "SELL", "qty": qty, "price": price,
        "pnlPct": pnl_pct, "reason": reason, "slippagePct": _number(cost_model.get("totalPct")), "costModel": cost_model, "source": item.get("source"),
        "idempotencyKey": _event_key(market, agent["id"], str(item.get("symbol") or "").upper(), bar_ts, event_type),
        "order_execution_enabled": False, "orderSent": False,
    }


def step(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    state = load_state(market, payload.get("db_path"))
    if not state["config"].get("enabled", True):
        return {**state, "events": [], "skipped": True, "reason": "paper agents disabled"}
    market_open = payload.get("marketOpen") is True
    items = [dict(row, market=market) for row in payload.get("items") or [] if isinstance(row, dict)]
    valid: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for item in items:
        symbol = str(item.get("symbol") or "").upper()
        price = _number(item.get("price"), _number(_technicals(item).get("close")))
        source = str(item.get("source") or item.get("marketSource") or "")
        bar_ts = str(item.get("barTs") or item.get("priceTs") or item.get("updatedAt") or "")
        if not market_open:
            rejected.append({"symbol": symbol, "reason": "market closed"})
        elif not symbol or price <= 0 or not bar_ts:
            rejected.append({"symbol": symbol, "reason": "missing real price/bar timestamp"})
        elif not _source_is_real(source) or item.get("fresh") is False:
            rejected.append({"symbol": symbol, "reason": "stale or non-real source"})
        else:
            item.update({"symbol": symbol, "price": price, "source": source, "barTs": bar_ts})
            valid.append(item)
    prices = {item["symbol"]: item["price"] for item in valid}
    by_symbol = {item["symbol"]: item for item in valid}
    strategy = payload.get("strategy") if isinstance(payload.get("strategy"), dict) else {}
    horizon = max(1.0, _number(strategy.get("horizonDays"), 15))
    target = max(0.5, _number(strategy.get("targetUpside"), 5))
    stop = max(0.5, abs(_number(strategy.get("stopLoss"), 4)))
    market_bias = _number(payload.get("marketBias"), 0)
    emitted: list[dict[str, Any]] = []
    with _connect(payload.get("db_path")) as connection:
        for agent in state["ledger"]["agents"]:
            previous_equity = _number(agent.get("equity"), _number(agent.get("initialCapital")))
            _mark(agent, prices)
            sold_symbols: set[str] = set()
            for symbol, position in list(agent["positions"].items()):
                item = by_symbol.get(symbol)
                if not item:
                    continue
                price = item["price"]
                pnl_pct = (price - _number(position.get("avgPrice"))) / max(0.0000001, _number(position.get("avgPrice"))) * 100
                opened = datetime.fromisoformat(str(position.get("openedAt") or _now()).replace("Z", "+00:00"))
                held_days = max(0.0, (datetime.now(timezone.utc) - opened.astimezone(timezone.utc)).total_seconds()/86400)
                score = decision_score(agent, item, market_bias)
                stop_line = stop * STYLE_STOP.get(agent["style"], 1)
                take_line = max(0.9, target * STYLE_TAKE.get(agent["style"], 0.55))
                reason = None
                if pnl_pct <= -stop_line:
                    reason = "stop"
                elif pnl_pct >= take_line:
                    reason = "take-profit"
                elif score < STYLE_EXIT.get(agent["style"], 46):
                    reason = "signal-exit"
                elif held_days > horizon * STYLE_HOLD.get(agent["style"], 0.75):
                    reason = "time-exit"
                if not reason:
                    continue
                qty = _number(position.get("qty"))
                gross = qty * price
                cost_model = _cost_model(market, item, gross)
                cost_pct = _number(cost_model.get("totalPct"))
                net = gross * (1-cost_pct/100)
                cost_basis = _number(position.get("costBasis"), qty*_number(position.get("avgPrice")))
                realised = (net-cost_basis)/max(0.0000001, cost_basis)*100
                event = _trade_event(agent, item, "paper-sell", qty, price, reason, cost_model, realised)
                if not _record_event(connection, event):
                    continue
                agent["cash"] = _number(agent.get("cash")) + net
                del agent["positions"][symbol]
                agent["learning"]["symbolBias"][symbol] = _clamp(_number(agent["learning"]["symbolBias"].get(symbol)) + (0.9 if realised > 0 else -1.25), -6, 6)
                agent["stats"]["trades"] += 1
                agent["stats"]["closedTrades"] += 1
                agent["stats"]["wins" if realised > 0 else "losses"] += 1
                agent["trades"] = [event, *agent["trades"]][:120]
                emitted.append(event)
                sold_symbols.add(symbol)
                if realised < 0:
                    state["memory"]["lossLessons"] = [{"time": event["createdAt"], "agentId": agent["id"], "symbol": symbol, "pnlPct": realised, "reason": reason, "lesson": "提高同类入场的量能、新闻和因子确认，并降低该股票偏置。"}, *state["memory"]["lossLessons"]][:120]
            for item in valid:
                if item["symbol"] in sold_symbols or str(_analysis(item).get("action")) == "ERROR":
                    continue
                score = decision_score(agent, item, market_bias)
                if score < _threshold(agent):
                    continue
                price = item["price"]
                cash_pct, equity_pct, max_pct = STYLE_SIZING[agent["style"]]
                current = agent["positions"].get(item["symbol"])
                current_value = _number(current.get("qty") if current else 0)*price
                max_value = max(_number(agent.get("equity"))*max_pct, _number(agent.get("initialCapital"))*min(0.06, max_pct))
                ticket = min(_number(agent.get("cash"))*cash_pct, _number(agent.get("equity"))*equity_pct*_number(agent["learning"].get("aggressiveness"), 1), max_value-current_value)
                preliminary_cost = _cost_model(market, item, max(0.0, ticket))
                max_trade_notional = _number(preliminary_cost.get("maxTradeNotional"), 0)
                if max_trade_notional > 0:
                    ticket = min(ticket, max_trade_notional)
                cost_model = _cost_model(market, item, max(0.0, ticket))
                cost_pct = _number(cost_model.get("totalPct"))
                gross_per_share = price*(1+cost_pct/100)
                if _number(agent.get("cash")) < gross_per_share:
                    continue
                qty = math.floor(ticket/gross_per_share)
                if qty <= 0:
                    continue
                cost_model = _cost_model(market, item, qty*price)
                event = _trade_event(agent, item, "paper-buy", qty, price, f"score {score:.1f} / threshold {_threshold(agent):.1f}", cost_model)
                if not _record_event(connection, event):
                    continue
                gross = qty*price
                cost = gross*cost_pct/100
                if current:
                    total_qty = _number(current.get("qty"))+qty
                    current["costBasis"] = _number(current.get("costBasis"), _number(current.get("avgPrice"))*_number(current.get("qty"))) + gross + cost
                    current.update({"qty": total_qty, "avgPrice": current["costBasis"]/total_qty, "lastPrice": price, "costPaid": _number(current.get("costPaid"))+cost})
                else:
                    agent["positions"][item["symbol"]] = {"qty": qty, "avgPrice": (gross+cost)/qty, "lastPrice": price, "openedAt": _now(), "costBasis": gross+cost, "costPaid": cost, "entryCostPct": cost_pct}
                agent["cash"] = _number(agent.get("cash"))-gross-cost
                agent["stats"]["trades"] += 1
                agent["trades"] = [event, *agent["trades"]][:120]
                emitted.append(event)
            _mark(agent, prices)
            reward = (_number(agent.get("equity"))-previous_equity)/max(1, previous_equity)*100
            agent["learning"]["aggressiveness"] = _clamp(_number(agent["learning"].get("aggressiveness"), 1) + (0.015 if reward > 0 else -0.025 if reward < -0.15 else 0), 0.55, 1.35)
            agent["learning"]["confidenceBias"] = _clamp(_number(agent["learning"].get("confidenceBias")) + (0.08 if reward > 0 else -0.12 if reward < -0.15 else 0), -4, 4)
            agent["previousEquity"] = agent["equity"]
    state["memory"]["totalPaperTrades"] = sum(int(agent["stats"]["trades"]) for agent in state["ledger"]["agents"])
    saved = save_state(state, payload.get("db_path"))
    return {**saved, "events": emitted, "acceptedSymbols": [item["symbol"] for item in valid], "rejected": rejected, "order_execution_enabled": False}


def list_agent_events(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    limit = max(1, min(1000, int(_number(payload.get("limit"), 100))))
    since = str(payload.get("since") or "")
    params: list[Any] = [market]
    where = "market = ?"
    if since:
        where += " AND created_at > ?"
        params.append(since)
    params.append(limit)
    with _connect(payload.get("db_path")) as connection:
        rows = connection.execute(f"SELECT payload_json FROM paper_agent_events WHERE {where} ORDER BY id DESC LIMIT ?", params).fetchall()
    events = [json.loads(row["payload_json"]) for row in rows]
    return {"market": market, "count": len(events), "events": events, "order_execution_enabled": False}
