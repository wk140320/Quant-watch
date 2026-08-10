from __future__ import annotations

import hashlib
import gzip
import json
import math
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
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


def _default_agent(agent_id: str, name: str, style: str, aggressiveness: float, capital: float, market: str, generation_id: str = "generation_v2") -> dict[str, Any]:
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
        "learning": {
            "aggressiveness": aggressiveness,
            "confidenceBias": 0.0,
            "symbolBias": {},
            "policy": {"available": False, "productionEligible": False, "source": "strict-oof-required"},
        },
        "stats": {"wins": 0, "losses": 0, "trades": 0, "closedTrades": 0},
        "generationId": generation_id,
        "lossStreak": 0,
        "riskScale": 1.0,
        "paused": False,
        "dailyTurnover": {"date": "", "notional": 0.0},
        "peakEquity": capital,
        "rewardLedger": [],
    }


def default_state(market: str = "ASX", initial_capital: float | None = None) -> dict[str, Any]:
    key = _market(market)
    capital = max(1.0, _number(initial_capital, _default_capital(key)))
    return {
        "market": key,
        "updatedAt": _now(),
        "revision": 0,
        "migrationId": None,
        "config": {
            "initialCapital": capital,
            "enabled": True,
            "generationId": "generation_v2",
            "stage": "shadow",
            "maxPositions": 6,
            "maxPositionPct": 0.12,
            "maxSectorPct": 0.25,
            "minCashPct": 0.25,
            "maxDailyTurnoverPct": 0.30,
            "learningPolicy": "weekly_oof_replay",
            "requireStrictOof": True,
            "paused": False,
        },
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
        "policy": learning.get("policy") if isinstance(learning.get("policy"), dict) else fallback["learning"]["policy"],
        "regimePolicies": learning.get("regimePolicies") if isinstance(learning.get("regimePolicies"), dict) else {},
    }
    stats = row.get("stats") if isinstance(row.get("stats"), dict) else {}
    row["stats"] = {name: int(max(0, _number(stats.get(name), 0))) for name in ("wins", "losses", "trades", "closedTrades")}
    row["generationId"] = str(row.get("generationId") or fallback.get("generationId") or "generation_v2")[:40]
    row["lossStreak"] = int(max(0, _number(row.get("lossStreak"), 0)))
    row["riskScale"] = _clamp(row.get("riskScale", 1), 0.25, 1.0)
    row["paused"] = row.get("paused") is True
    turnover = row.get("dailyTurnover") if isinstance(row.get("dailyTurnover"), dict) else {}
    row["dailyTurnover"] = {"date": str(turnover.get("date") or "")[:10], "notional": max(0.0, _number(turnover.get("notional"), 0))}
    row["peakEquity"] = max(_number(row.get("peakEquity"), row.get("equity")), _number(row.get("equity")))
    row["rewardLedger"] = list(row.get("rewardLedger") or [])[:240]
    for name in ("cash", "initialCapital", "equity", "previousEquity", "positionValue", "returnPct"):
        row[name] = _number(row.get(name), fallback.get(name, 0.0))
    return row


def _normalise_state(state: dict[str, Any], market: str) -> dict[str, Any]:
    key = _market(market)
    config = state.get("config") if isinstance(state.get("config"), dict) else {}
    capital = max(1.0, _number(config.get("initialCapital"), _default_capital(key)))
    has_existing_activity = int(max(0, _number(state.get("revision"), 0))) > 0
    generation_id = str(config.get("generationId") or ("generation_v1" if has_existing_activity else "generation_v2"))[:40]
    defaults = default_state(key, capital)
    defaults["config"]["generationId"] = generation_id
    for agent in defaults["ledger"]["agents"]:
        agent["generationId"] = generation_id
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
        "config": {
            "initialCapital": capital,
            "enabled": config.get("enabled") is not False,
            "generationId": generation_id,
            "stage": str(config.get("stage") or ("archived" if generation_id == "generation_v1" else "shadow"))[:24],
            "maxPositions": int(_clamp(config.get("maxPositions", 6), 1, 20)),
            "maxPositionPct": _clamp(config.get("maxPositionPct", 0.12), 0.01, 0.50),
            "maxSectorPct": _clamp(config.get("maxSectorPct", 0.25), 0.05, 1.0),
            "minCashPct": _clamp(config.get("minCashPct", 0.25), 0.0, 0.90),
            "maxDailyTurnoverPct": _clamp(config.get("maxDailyTurnoverPct", 0.30), 0.01, 2.0),
            "learningPolicy": str(config.get("learningPolicy") or "weekly_oof_replay")[:60],
            "requireStrictOof": config.get("requireStrictOof") is not False,
            "paused": config.get("paused") is True,
        },
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
    if "paused" in config:
        state["config"]["paused"] = config.get("paused") is True
    if "requireStrictOof" in config:
        state["config"]["requireStrictOof"] = config.get("requireStrictOof") is not False
    for name, low, high in (
        ("maxPositions", 1, 20),
        ("maxPositionPct", 0.01, 0.50),
        ("maxSectorPct", 0.05, 1.0),
        ("minCashPct", 0.0, 0.90),
        ("maxDailyTurnoverPct", 0.01, 2.0),
    ):
        if name in config:
            state["config"][name] = int(_clamp(config.get(name), low, high)) if name == "maxPositions" else _clamp(config.get(name), low, high)
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
    replacement["config"].update({name: value for name, value in current["config"].items() if name != "initialCapital"})
    for agent in replacement["ledger"]["agents"]:
        agent["generationId"] = replacement["config"].get("generationId", "generation_v2")
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


def _generation_summary(state: dict[str, Any]) -> dict[str, Any]:
    agents = state.get("ledger", {}).get("agents", [])
    initial = sum(_number(agent.get("initialCapital")) for agent in agents)
    equity = sum(_number(agent.get("equity")) for agent in agents)
    return {
        "generationId": state.get("config", {}).get("generationId"),
        "stage": state.get("config", {}).get("stage"),
        "agentCount": len(agents),
        "initialCapital": round(initial, 2),
        "equity": round(equity, 2),
        "returnPct": round((equity / initial - 1) * 100, 4) if initial > 0 else 0.0,
        "closedTrades": sum(int(_number(agent.get("stats", {}).get("closedTrades"))) for agent in agents),
        "wins": sum(int(_number(agent.get("stats", {}).get("wins"))) for agent in agents),
        "losses": sum(int(_number(agent.get("stats", {}).get("losses"))) for agent in agents),
        "positionCount": sum(len(agent.get("positions") or {}) for agent in agents),
    }


def upgrade_generation(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    db_path = payload.get("db_path")
    current = load_state(market, db_path)
    generation_id = str(current.get("config", {}).get("generationId") or "generation_v1")
    if generation_id == "generation_v2":
        return {**current, "upgraded": False, "reason": "generation_v2 already active"}
    archived_at = _now()
    summary = _generation_summary(current)
    with _connect(db_path) as connection:
        connection.execute(
            """
            INSERT OR IGNORE INTO paper_agent_archives(market, generation_id, archived_at, state_json, summary_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (market, generation_id or "generation_v1", archived_at, _json(current), _json(summary)),
        )
    replacement = default_state(market, current.get("config", {}).get("initialCapital"))
    replacement["memory"]["archives"] = [{
        "generationId": generation_id or "generation_v1",
        "archivedAt": archived_at,
        "summary": summary,
        "readOnly": True,
    }]
    replacement["memory"]["lossLessons"] = list(current.get("memory", {}).get("lossLessons") or [])[:120]
    replacement["memory"]["previousGenerationSummary"] = summary
    saved = save_state(replacement, db_path)
    return {**saved, "upgraded": True, "archivedGeneration": summary}


def list_generations(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    current = load_state(market, payload.get("db_path"))
    with _connect(payload.get("db_path")) as connection:
        rows = connection.execute(
            "SELECT generation_id, archived_at, summary_json FROM paper_agent_archives WHERE market = ? ORDER BY archived_at DESC",
            (market,),
        ).fetchall()
    archives = [{
        "generationId": row["generation_id"],
        "archivedAt": row["archived_at"],
        "summary": json.loads(row["summary_json"]),
        "readOnly": True,
    } for row in rows]
    current_summary = _generation_summary(current)
    constraint_audits = [
        _constraint_audit(agent, current.get("config") or {})
        for agent in current.get("ledger", {}).get("agents", [])
    ]
    constraint_violations = sum(len(row.get("violations") or []) for row in constraint_audits)
    closed = int(current_summary.get("closedTrades") or 0)
    wins = int(current_summary.get("wins") or 0)
    return {
        "market": market,
        "current": {
            **current_summary,
            "updatedAt": current.get("updatedAt"),
            "winRatePct": round(wins / closed * 100, 2) if closed else None,
            "constraintCompliance": {
                "compliant": constraint_violations == 0,
                "violations": constraint_violations,
                "agentsFrozen": sum(1 for row in constraint_audits if row.get("newBuysFrozen")),
                "remediation": "freeze-and-gradual-exit" if constraint_violations else "none",
                "agents": constraint_audits,
            },
            "promotionEligible": False,
            "promotionBlockers": [
                *([] if closed >= 200 else [f"平仓交易 {closed}/200"]),
                "需要至少120个独立测试日期",
                "需要成本后超额为正、Profit Factor>1.2且最大回撤<10%",
            ],
        },
        "archives": archives,
        "order_execution_enabled": False,
    }


def _oof_identity(row: dict[str, Any], market: str) -> str:
    explicit = str(row.get("predictionId") or row.get("id") or "").strip()
    if explicit:
        return explicit
    raw = ":".join([
        market,
        str(row.get("symbol") or "").upper(),
        str(row.get("signalAt") or row.get("asOfDate") or row.get("date") or ""),
        str(int(_number(row.get("horizon"), 0))),
        str(row.get("fold") or ""),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _load_strict_oof(payload: dict[str, Any], market: str) -> tuple[list[dict[str, Any]], list[str]]:
    rows = []
    sources = []
    for row in payload.get("samples") or []:
        if not isinstance(row, dict):
            continue
        if row.get("strictOof") is True or str(row.get("evidenceType") or "") == "strict_oof":
            rows.append(dict(row))
    artifact_text = str(payload.get("artifact_dir") or payload.get("artifactDir") or "").strip()
    if artifact_text:
        directory = Path(artifact_text).expanduser().resolve()
        horizons = {int(_number(value)) for value in payload.get("horizons") or [5] if int(_number(value)) > 0}
        latest_by_horizon: dict[int, Path] = {}
        for path in directory.glob("*.jsonl.gz"):
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    first = json.loads(next(handle))
                horizon = int(_number(first.get("horizon")))
                if horizon not in horizons:
                    continue
                previous = latest_by_horizon.get(horizon)
                if previous is None or path.stat().st_mtime > previous.stat().st_mtime:
                    latest_by_horizon[horizon] = path
            except (OSError, StopIteration, ValueError, TypeError):
                continue
        for path in latest_by_horizon.values():
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    for line in handle:
                        row = json.loads(line)
                        row["strictOof"] = True
                        row["evidenceType"] = "strict_oof"
                        rows.append(row)
                sources.append(str(path))
            except (OSError, ValueError, TypeError):
                continue
    unique: dict[str, dict[str, Any]] = {}
    for row in rows:
        if str(row.get("market") or market).upper() != market:
            continue
        identity = _oof_identity(row, market)
        row["predictionId"] = identity
        row["signalAt"] = str(row.get("signalAt") or row.get("asOfDate") or row.get("date") or "")
        if row["signalAt"] and row.get("actualReturn") is not None:
            unique.setdefault(identity, row)
    return list(unique.values()), sources


def _arm_signal(style: str, row: dict[str, Any]) -> float | None:
    def probability(name: str) -> float | None:
        value = row.get(name)
        if value is None:
            return None
        return _clamp(value, 0, 1)

    ridge = probability("ridgePrediction")
    ranker = probability("rankerPrediction")
    elastic = probability("elasticPrediction")
    direction = probability("directionProbability")
    ridge_direction = probability("ridgeDirectionPrediction")
    elastic_direction = probability("elasticDirectionPrediction")
    tree_direction = probability("treeDirectionPrediction")
    event = probability("eventPrediction")
    target = probability("targetProbability")
    stop = probability("stopProbability")
    quantile = probability("quantilePrediction")
    if style == "reversion":
        return elastic_direction if elastic_direction is not None else direction if direction is not None else elastic if elastic is not None else quantile
    if style == "breakout":
        return tree_direction if tree_direction is not None else direction if direction is not None else ranker
    if style == "news-flow":
        return event
    if style == "risk-balanced":
        path_signal = _clamp(0.5 + (target - stop) * 0.5, 0, 1) if target is not None and stop is not None else None
        if direction is not None and path_signal is not None:
            return _clamp(direction * 0.55 + path_signal * 0.45, 0, 1)
        return direction if direction is not None else path_signal
    return direction if direction is not None else ridge_direction if ridge_direction is not None else ridge


def _regime_key(row: dict[str, Any]) -> str:
    raw = str(row.get("regime") or row.get("marketRegime") or "all").strip().lower().replace(" ", "_")
    return raw if raw in {"trend_up", "risk_off", "range", "high_volatility"} else "all"


def _wilson_lower(wins: int, trades: int, z: float = 1.96) -> float:
    if trades <= 0:
        return 0.0
    rate = wins / trades
    denominator = 1 + z * z / trades
    center = rate + z * z / (2 * trades)
    margin = z * math.sqrt((rate * (1 - rate) + z * z / (4 * trades)) / trades)
    return max(0.0, (center - margin) / denominator)


def _fit_arm_policy(style: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    observations = [(signal, row) for row in rows if (signal := _arm_signal(style, row)) is not None]

    def observed_date(item: tuple[float, dict[str, Any]]) -> str:
        return str(item[1].get("signalAt") or item[1].get("date") or "")[:10]

    distinct_dates = sorted({observed_date(item) for item in observations if observed_date(item)})
    if len(observations) < 1_000 or len(distinct_dates) < 120:
        return {
            "available": False,
            "productionEligible": False,
            "style": style,
            "observations": len(observations),
            "independentDates": len(distinct_dates),
            "reason": "Strict OOF requires 1,000 observations and 120 independent dates before policy selection.",
        }
    split_index = max(1, int(len(distinct_dates) * 0.65))
    selection_dates = set(distinct_dates[:split_index])
    embargo = 12
    evaluation_dates = set(distinct_dates[min(len(distinct_dates), split_index + embargo):])
    selection_observations = [item for item in observations if observed_date(item) in selection_dates]
    evaluation_observations = [item for item in observations if observed_date(item) in evaluation_dates]

    def summarize(selected: list[tuple[float, dict[str, Any]]], threshold: float) -> dict[str, Any] | None:
        chosen = [(signal, row) for signal, row in selected if signal >= threshold]
        dates = {observed_date(item) for item in chosen}
        returns = [_number(row.get("actualReturn")) for _, row in chosen]
        if len(returns) < 30 or len(dates) < 20:
            return None
        wins = sum(1 for value in returns if value > 0)
        gross_profit = sum(value for value in returns if value > 0)
        gross_loss = abs(sum(value for value in returns if value < 0))
        mean_return = sum(returns) / len(returns)
        downside = math.sqrt(sum(min(0.0, value) ** 2 for value in returns) / len(returns))
        low_quality = sum(max(0.0, 80.0 - _number(row.get("dataQuality"), 100.0)) / 80.0 for _, row in chosen) / len(chosen)
        turnover_penalty = _number(chosen[0][1].get("transactionCostBps"), 18.0) / 100.0
        return {
            "threshold": threshold,
            "trades": len(returns),
            "independentDates": len(dates),
            "wins": wins,
            "winRate": wins / len(returns),
            "winRate95Lower": _wilson_lower(wins, len(returns)),
            "meanNetReturnPct": mean_return,
            "profitFactor": gross_profit / max(1e-9, gross_loss),
            "downsideDeviationPct": downside,
            "objective": mean_return - downside * 0.18 - turnover_penalty * 0.25 - low_quality * 0.20,
        }

    candidates = []
    for threshold_pct in range(50, 76, 2):
        threshold = threshold_pct / 100
        candidate = summarize(selection_observations, threshold)
        if candidate:
            candidates.append(candidate)
    if not candidates:
        return {"available": False, "productionEligible": False, "style": style, "reason": "No threshold has enough strict OOF observations."}
    selected_policy = max(candidates, key=lambda row: (row["objective"], row["profitFactor"], row["trades"]))
    best = summarize(evaluation_observations, selected_policy["threshold"])
    if best is None:
        return {
            "available": False,
            "productionEligible": False,
            "style": style,
            "threshold": selected_policy["threshold"],
            "selectionEvidence": selected_policy,
            "reason": "The untouched policy evaluation window has fewer than 30 trades or 20 dates.",
        }
    evidence_eligible = best["independentDates"] >= 120
    production_eligible = (
        evidence_eligible
        and best["trades"] >= 200
        and best["profitFactor"] > 1.20
        and best["meanNetReturnPct"] > 0
        and best["winRate"] > 0.55
        and best["winRate95Lower"] > 0.50
    )
    return {
        **best,
        "available": evidence_eligible,
        "productionEligible": production_eligible,
        "style": style,
        "source": "strict-oof-purged-selection-and-holdout-contextual-bandit",
        "observations": len(observations),
        "selectionRows": len(selection_observations),
        "evaluationRows": len(evaluation_observations),
        "selectionEvidence": selected_policy,
        "purgeEmbargoDates": embargo,
        "posterior": {"alpha": 1 + best["wins"], "beta": 1 + best["trades"] - best["wins"]},
        "evaluatedAt": _now(),
        "blockers": [
            *([] if evidence_eligible else ["strict OOF requires 1,000 observations and 120 independent dates"]),
            *([] if best["trades"] >= 200 else ["fewer than 200 replay trades"]),
            *([] if best["profitFactor"] > 1.20 else ["Profit Factor <= 1.20"]),
            *([] if best["winRate"] > 0.55 else ["win rate <= 55%"]),
            *([] if best["winRate95Lower"] > 0.50 else ["95% win-rate lower bound <= 50%"]),
            *([] if best["meanNetReturnPct"] > 0 else ["mean cost-adjusted return <= 0"]),
        ],
    }


def replay_oof(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    state = load_state(market, payload.get("db_path"))
    oof, sources = _load_strict_oof(payload, market)
    dates = {str(row.get("signalAt") or "")[:10] for row in oof if row.get("signalAt")}
    policies = {style: _fit_arm_policy(style, oof) for _, _, style, _ in AGENT_DEFINITIONS}
    regime_policies: dict[str, dict[str, dict[str, Any]]] = {}
    for regime in sorted({_regime_key(row) for row in oof if _regime_key(row) != "all"}):
        regime_rows = [row for row in oof if _regime_key(row) == regime]
        regime_policies[regime] = {
            style: _fit_arm_policy(style, regime_rows)
            for _, _, style, _ in AGENT_DEFINITIONS
        }
    selectors = {}
    for regime, policy_book in {"all": policies, **regime_policies}.items():
        ranked = []
        for style, policy in policy_book.items():
            posterior = policy.get("posterior") or {}
            alpha = max(1.0, _number(posterior.get("alpha"), 1.0))
            beta = max(1.0, _number(posterior.get("beta"), 1.0))
            ranked.append({
                "style": style,
                "posteriorMean": alpha / (alpha + beta),
                "objective": _number(policy.get("objective")),
                "productionEligible": policy.get("productionEligible") is True,
            })
        ranked.sort(key=lambda row: (row["productionEligible"], row["posteriorMean"], row["objective"]), reverse=True)
        selectors[regime] = {
            "selectedStyle": ranked[0]["style"] if ranked and ranked[0]["productionEligible"] else None,
            "ranking": ranked,
            "method": "context-conditioned-beta-posterior",
        }
    updated = False
    for agent in state["ledger"]["agents"]:
        policy = policies.get(str(agent.get("style"))) or {"available": False, "productionEligible": False}
        agent["learning"]["policy"] = policy
        agent["learning"]["regimePolicies"] = {
            regime: policy_book.get(str(agent.get("style"))) or {"available": False, "productionEligible": False}
            for regime, policy_book in regime_policies.items()
        }
        updated = updated or policy.get("available") is True
    state["memory"]["strategyBook"] = policies
    state["memory"]["contextualStrategyBook"] = regime_policies
    state["memory"]["strategySelector"] = selectors
    result = {
        "market": market,
        "generationId": state.get("config", {}).get("generationId"),
        "available": len(oof) >= 1_000 and len(dates) >= 120,
        "updated": updated,
        "inputRows": len(payload.get("samples") or []),
        "strictOofRows": len(oof),
        "independentDates": len(dates),
        "artifactSources": sources,
        "policy": "contextual-bandit-weekly-strict-oof-only",
        "policies": policies,
        "regimePolicies": regime_policies,
        "strategySelector": selectors,
        "reason": "" if updated else "Strict OOF evidence was evaluated, but no Agent policy passed the minimum evidence gate.",
    }
    state["memory"]["lastReplay"] = {**result, "evaluatedAt": _now()}
    state["memory"]["totalReplayTrades"] = len(oof)
    save_state(state, payload.get("db_path"))
    return {**result, "order_execution_enabled": False}


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


def _event_key(market: str, generation_id: str, agent_id: str, symbol: str, bar_ts: str, event_type: str) -> str:
    raw = f"{market}:{generation_id}:{agent_id}:{symbol}:{bar_ts}:{event_type}"
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


def _constraint_audit(agent: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    equity = max(1.0, _number(agent.get("equity")))
    positions = agent.get("positions") if isinstance(agent.get("positions"), dict) else {}
    values = {
        symbol: _number(position.get("qty")) * _number(position.get("lastPrice"), position.get("avgPrice"))
        for symbol, position in positions.items()
    }
    sector_values: dict[str, float] = {}
    for symbol, position in positions.items():
        sector = str(position.get("sector") or "Unknown")
        sector_values[sector] = sector_values.get(sector, 0.0) + values.get(symbol, 0.0)
    violations = []
    if len(positions) > int(config.get("maxPositions", 6)):
        violations.append({"type": "max_positions", "actual": len(positions), "limit": int(config.get("maxPositions", 6))})
    max_position_pct = _number(config.get("maxPositionPct"), 0.12)
    for symbol, value in values.items():
        if value / equity > max_position_pct + 1e-9:
            violations.append({"type": "single_position", "symbol": symbol, "actualPct": value / equity, "limitPct": max_position_pct})
    max_sector_pct = _number(config.get("maxSectorPct"), 0.25)
    for sector, value in sector_values.items():
        if value / equity > max_sector_pct + 1e-9:
            violations.append({"type": "sector", "sector": sector, "actualPct": value / equity, "limitPct": max_sector_pct})
    cash_pct = _number(agent.get("cash")) / equity
    min_cash_pct = _number(config.get("minCashPct"), 0.25)
    if cash_pct + 1e-9 < min_cash_pct:
        violations.append({"type": "cash_reserve", "actualPct": cash_pct, "limitPct": min_cash_pct})
    return {
        "compliant": not violations,
        "checkedAt": _now(),
        "positionCount": len(positions),
        "cashPct": round(cash_pct, 6),
        "sectorExposurePct": {sector: round(value / equity, 6) for sector, value in sector_values.items()},
        "positionExposurePct": {symbol: round(value / equity, 6) for symbol, value in values.items()},
        "violations": violations,
        "newBuysFrozen": bool(violations),
        "remediation": "freeze-and-gradual-exit" if violations else "none",
    }


def _behavior_policy_context(state: dict[str, Any], agent: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    selector = (state.get("memory", {}).get("strategySelector") or {}).get(_regime_key({**item, **_analysis(item)}))
    selector = selector or (state.get("memory", {}).get("strategySelector") or {}).get("all") or {}
    ranking = selector.get("ranking") if isinstance(selector.get("ranking"), list) else []
    eligible = [row for row in ranking if row.get("productionEligible") is True]
    denominator = sum(max(1e-6, _number(row.get("posteriorMean"), 0.0)) for row in eligible)
    selected = next((row for row in eligible if str(row.get("style")) == str(agent.get("style"))), None)
    probability = max(1e-6, _number(selected.get("posteriorMean"), 0.0)) / denominator if selected and denominator > 0 else 0.0
    return {
        "method": selector.get("method") or "context-conditioned-beta-posterior",
        "regime": _regime_key({**item, **_analysis(item)}),
        "selectedStyle": selector.get("selectedStyle"),
        "agentStyle": agent.get("style"),
        "behaviorProbability": round(probability, 8),
        "policyVersion": str((agent.get("learning") or {}).get("policy", {}).get("evaluatedAt") or "untrained"),
    }


def _policy_for_item(agent: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    learning = agent.get("learning") or {}
    regime_policy = (learning.get("regimePolicies") or {}).get(_regime_key({**item, **_analysis(item)})) or {}
    return regime_policy if regime_policy.get("productionEligible") is True else learning.get("policy") or {}


def _threshold(agent: dict[str, Any], item: dict[str, Any] | None = None) -> float:
    policy = _policy_for_item(agent, item or {})
    if policy.get("productionEligible") is True and _number(policy.get("threshold")) > 0:
        return _clamp(_number(policy.get("threshold")) * 100, 50, 78)
    return _clamp(STYLE_ENTRY.get(agent.get("style"), 58) - _number((agent.get("learning") or {}).get("confidenceBias"))*0.35, 49, 68)


def _strict_oof_trade_gate(state: dict[str, Any], agent: dict[str, Any], item: dict[str, Any]) -> tuple[bool, str]:
    if state.get("config", {}).get("requireStrictOof") is not True:
        return True, "strict OOF gate disabled by explicit configuration"
    policy = _policy_for_item(agent, item)
    if policy.get("productionEligible") is not True:
        return False, "Agent policy has not passed strict OOF replay evidence."
    selector = (state.get("memory", {}).get("strategySelector") or {}).get(_regime_key({**item, **_analysis(item)}))
    selector = selector or (state.get("memory", {}).get("strategySelector") or {}).get("all") or {}
    selected_style = str(selector.get("selectedStyle") or "")
    if selected_style and selected_style != str(agent.get("style") or ""):
        return False, f"Contextual bandit selected {selected_style} for the current regime."
    analysis = _analysis(item)
    quality_gate = analysis.get("qualityGate") if isinstance(analysis.get("qualityGate"), dict) else {}
    production = quality_gate.get("productionEligibility") if isinstance(quality_gate.get("productionEligibility"), dict) else {}
    model_evidence = analysis.get("modelEvidence") if isinstance(analysis.get("modelEvidence"), dict) else {}
    strict_current_model = (
        analysis.get("productionEvidencePassed") is True
        or production.get("eligible") is True
        or model_evidence.get("strictOofEligible") is True
    )
    if not strict_current_model:
        return False, "Current prediction is not backed by a production-eligible strict OOF model."
    return True, "strict OOF policy and current-model evidence passed"


def _reward_components(agent: dict[str, Any], previous_equity: float, valid_items: list[dict[str, Any]]) -> dict[str, float]:
    equity = max(1.0, _number(agent.get("equity")))
    raw_return = (equity - previous_equity) / max(1.0, previous_equity) * 100
    previous_peak = max(previous_equity, _number(agent.get("peakEquity"), previous_equity))
    peak = max(previous_peak, equity)
    previous_drawdown = max(0.0, (previous_peak - previous_equity) / max(1.0, previous_peak) * 100)
    drawdown = max(0.0, (peak - equity) / max(1.0, peak) * 100)
    drawdown_penalty = max(0.0, drawdown - previous_drawdown) * 0.55
    turnover_pct = _number(agent.get("dailyTurnover", {}).get("notional")) / equity * 100
    turnover_penalty = turnover_pct * 0.08
    position_values = [
        _number(position.get("qty")) * _number(position.get("lastPrice"), position.get("avgPrice"))
        for position in (agent.get("positions") or {}).values()
    ]
    concentration_pct = max(position_values, default=0.0) / equity * 100
    concentration_penalty = max(0.0, concentration_pct - 12.0) * 0.10
    degraded_count = sum(1 for item in valid_items if (item.get("marketValidation") or {}).get("degraded") is True)
    degradation_penalty = degraded_count / max(1, len(valid_items)) * 0.12
    reward = raw_return - drawdown_penalty - turnover_penalty - concentration_penalty - degradation_penalty
    agent["peakEquity"] = peak
    return {
        "rawReturnPct": round(raw_return, 6),
        "drawdownPenaltyPct": round(drawdown_penalty, 6),
        "turnoverPenaltyPct": round(turnover_penalty, 6),
        "concentrationPenaltyPct": round(concentration_penalty, 6),
        "dataDegradationPenaltyPct": round(degradation_penalty, 6),
        "rewardPct": round(reward, 6),
    }


def _trade_event(agent: dict[str, Any], item: dict[str, Any], event_type: str, qty: float, price: float, reason: str, cost_model: dict[str, Any], pnl_pct: float = 0.0, policy_context: dict[str, Any] | None = None) -> dict[str, Any]:
    market = _market(item.get("market"))
    bar_ts = str(item.get("barTs") or item.get("priceTs") or item.get("updatedAt") or "")
    return {
        "createdAt": _now(), "market": market, "agentId": agent["id"], "agentName": agent["name"], "generationId": agent.get("generationId", "generation_v2"),
        "symbol": str(item.get("symbol") or "").upper(), "barTs": bar_ts, "type": event_type,
        "side": "BUY" if event_type == "paper-buy" else "SELL", "qty": qty, "price": price,
        "pnlPct": pnl_pct, "reason": reason, "slippagePct": _number(cost_model.get("totalPct")), "costModel": cost_model, "source": item.get("source"),
        "policyContext": policy_context or {},
        "idempotencyKey": _event_key(market, str(agent.get("generationId") or "generation_v2"), agent["id"], str(item.get("symbol") or "").upper(), bar_ts, event_type),
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
    no_trade: list[dict[str, str]] = []
    with _connect(payload.get("db_path")) as connection:
        for agent in state["ledger"]["agents"]:
            today = datetime.now(timezone.utc).date().isoformat()
            if agent.get("dailyTurnover", {}).get("date") != today:
                agent["dailyTurnover"] = {"date": today, "notional": 0.0}
            previous_equity = _number(agent.get("equity"), _number(agent.get("initialCapital")))
            _mark(agent, prices)
            sold_symbols: set[str] = set()
            initial_constraint_audit = _constraint_audit(agent, state["config"])
            constraint_freeze = not initial_constraint_audit["compliant"]
            if constraint_freeze:
                daily_limit = max(0.0, _number(agent.get("equity")) * _number(state["config"].get("maxDailyTurnoverPct"), 0.30))
                candidates = sorted(
                    [
                        (symbol, position, by_symbol.get(symbol))
                        for symbol, position in agent["positions"].items()
                        if by_symbol.get(symbol)
                    ],
                    key=lambda row: (
                        _number(row[1].get("entryScore"), decision_score(agent, row[2], market_bias)),
                        0 if (row[2].get("marketValidation") or {}).get("degraded") else 1,
                        str(row[1].get("openedAt") or ""),
                    ),
                )
                for symbol, position, item in candidates:
                    audit_now = _constraint_audit(agent, state["config"])
                    if audit_now["compliant"]:
                        break
                    price = _number(item.get("price"))
                    held_qty = _number(position.get("qty"))
                    if price <= 0 or held_qty <= 0:
                        continue
                    turnover_remaining = max(0.0, daily_limit - _number(agent.get("dailyTurnover", {}).get("notional")))
                    max_qty_by_turnover = math.floor(turnover_remaining / price)
                    if max_qty_by_turnover <= 0:
                        break
                    equity = max(1.0, _number(agent.get("equity")))
                    position_value = held_qty * price
                    required_notional = 0.0
                    if len(agent["positions"]) > int(state["config"].get("maxPositions", 6)):
                        required_notional = position_value
                    required_notional = max(required_notional, position_value - equity * _number(state["config"].get("maxPositionPct"), 0.12))
                    sector = str(position.get("sector") or "Unknown")
                    sector_value = sum(
                        _number(row.get("qty")) * _number(row.get("lastPrice"), row.get("avgPrice"))
                        for row in agent["positions"].values() if str(row.get("sector") or "Unknown") == sector
                    )
                    required_notional = max(required_notional, sector_value - equity * _number(state["config"].get("maxSectorPct"), 0.25))
                    required_notional = max(required_notional, equity * _number(state["config"].get("minCashPct"), 0.25) - _number(agent.get("cash")))
                    qty = min(held_qty, max_qty_by_turnover, max(1, math.ceil(max(0.0, required_notional) / price)))
                    gross = qty * price
                    cost_model = _cost_model(market, item, gross)
                    net = gross * (1 - _number(cost_model.get("totalPct")) / 100)
                    original_cost_basis = _number(position.get("costBasis"), held_qty * _number(position.get("avgPrice")))
                    sold_cost_basis = original_cost_basis * qty / max(1e-12, held_qty)
                    realised = (net - sold_cost_basis) / max(1e-12, sold_cost_basis) * 100
                    event = _trade_event(
                        agent, item, "paper-sell", qty, price, "constraint-migration-gradual-exit",
                        cost_model, realised, _behavior_policy_context(state, agent, item),
                    )
                    if not _record_event(connection, event):
                        continue
                    agent["cash"] = _number(agent.get("cash")) + net
                    remaining_qty = held_qty - qty
                    if remaining_qty <= 1e-9:
                        del agent["positions"][symbol]
                        agent["stats"]["closedTrades"] += 1
                        agent["stats"]["wins" if realised > 0 else "losses"] += 1
                    else:
                        position["qty"] = remaining_qty
                        position["costBasis"] = max(0.0, original_cost_basis - sold_cost_basis)
                    agent["dailyTurnover"]["notional"] = _number(agent["dailyTurnover"].get("notional")) + gross
                    agent["stats"]["trades"] += 1
                    agent["trades"] = [event, *agent["trades"]][:120]
                    emitted.append(event)
                    sold_symbols.add(symbol)
                    _mark(agent, prices)
            agent["constraintAudit"] = _constraint_audit(agent, state["config"])
            agent["constraintAudit"]["migrationTriggeredThisTick"] = constraint_freeze
            for symbol, position in list(agent["positions"].items()):
                if symbol in sold_symbols:
                    continue
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
                event = _trade_event(agent, item, "paper-sell", qty, price, reason, cost_model, realised, _behavior_policy_context(state, agent, item))
                if not _record_event(connection, event):
                    continue
                agent["cash"] = _number(agent.get("cash")) + net
                del agent["positions"][symbol]
                agent["dailyTurnover"]["notional"] = _number(agent["dailyTurnover"].get("notional")) + gross
                agent["stats"]["trades"] += 1
                agent["stats"]["closedTrades"] += 1
                agent["stats"]["wins" if realised > 0 else "losses"] += 1
                agent["trades"] = [event, *agent["trades"]][:120]
                emitted.append(event)
                sold_symbols.add(symbol)
                if realised > 0:
                    agent["lossStreak"] = 0
                else:
                    agent["lossStreak"] = int(agent.get("lossStreak") or 0) + 1
                    if agent["lossStreak"] >= 5:
                        agent["paused"] = True
                        agent["riskScale"] = 0.25
                    elif agent["lossStreak"] >= 3:
                        agent["riskScale"] = 0.5
                if realised < 0:
                    state["memory"]["lossLessons"] = [{"time": event["createdAt"], "agentId": agent["id"], "symbol": symbol, "pnlPct": realised, "reason": reason, "lesson": "提高同类入场的量能、新闻和因子确认，并降低该股票偏置。"}, *state["memory"]["lossLessons"]][:120]
            for item in valid:
                if state["config"].get("paused") is True or agent.get("paused") is True:
                    continue
                if constraint_freeze:
                    no_trade.append({"agentId": str(agent.get("id")), "symbol": item["symbol"], "reason": "Agent has legacy positions outside current risk constraints; new buys are frozen during gradual remediation."})
                    continue
                if item["symbol"] in sold_symbols or str(_analysis(item).get("action")) == "ERROR":
                    continue
                gate_passed, gate_reason = _strict_oof_trade_gate(state, agent, item)
                if not gate_passed:
                    no_trade.append({"agentId": str(agent.get("id")), "symbol": item["symbol"], "reason": gate_reason})
                    continue
                score = decision_score(agent, item, market_bias)
                if score < _threshold(agent, item):
                    continue
                price = item["price"]
                cash_pct, equity_pct, max_pct = STYLE_SIZING[agent["style"]]
                current = agent["positions"].get(item["symbol"])
                if current is None and len(agent["positions"]) >= int(state["config"].get("maxPositions", 6)):
                    continue
                current_value = _number(current.get("qty") if current else 0)*price
                equity = max(1.0, _number(agent.get("equity")))
                max_value = min(equity * _number(state["config"].get("maxPositionPct"), 0.12), max(equity*max_pct, _number(agent.get("initialCapital"))*min(0.06, max_pct)))
                reserve_cash = equity * _number(state["config"].get("minCashPct"), 0.25)
                daily_limit = equity * _number(state["config"].get("maxDailyTurnoverPct"), 0.30)
                turnover_remaining = max(0.0, daily_limit - _number(agent.get("dailyTurnover", {}).get("notional")))
                sector = str(item.get("sector") or _analysis(item).get("sector") or "Unknown")
                sector_value = sum(
                    _number(position.get("qty")) * _number(position.get("lastPrice"), _number(position.get("avgPrice")))
                    for position in agent["positions"].values()
                    if str(position.get("sector") or "Unknown") == sector
                )
                sector_remaining = max(0.0, equity * _number(state["config"].get("maxSectorPct"), 0.25) - sector_value)
                ticket = min(
                    max(0.0, _number(agent.get("cash")) - reserve_cash),
                    _number(agent.get("cash"))*cash_pct,
                    equity*equity_pct*_number(agent["learning"].get("aggressiveness"), 1)*_number(agent.get("riskScale"), 1),
                    max_value-current_value,
                    turnover_remaining,
                    sector_remaining,
                )
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
                event = _trade_event(agent, item, "paper-buy", qty, price, f"score {score:.1f} / threshold {_threshold(agent, item):.1f}", cost_model, policy_context=_behavior_policy_context(state, agent, item))
                if not _record_event(connection, event):
                    continue
                gross = qty*price
                cost = gross*cost_pct/100
                if current:
                    total_qty = _number(current.get("qty"))+qty
                    current["costBasis"] = _number(current.get("costBasis"), _number(current.get("avgPrice"))*_number(current.get("qty"))) + gross + cost
                    current.update({"qty": total_qty, "avgPrice": current["costBasis"]/total_qty, "lastPrice": price, "costPaid": _number(current.get("costPaid"))+cost})
                else:
                    agent["positions"][item["symbol"]] = {"qty": qty, "avgPrice": (gross+cost)/qty, "lastPrice": price, "openedAt": _now(), "costBasis": gross+cost, "costPaid": cost, "entryCostPct": cost_pct, "sector": sector, "entryScore": score, "entryDataQuality": _number(item.get("dataQuality"), 0)}
                agent["cash"] = _number(agent.get("cash"))-gross-cost
                agent["dailyTurnover"]["notional"] = _number(agent["dailyTurnover"].get("notional")) + gross
                agent["stats"]["trades"] += 1
                agent["trades"] = [event, *agent["trades"]][:120]
                emitted.append(event)
            _mark(agent, prices)
            agent["constraintAudit"] = _constraint_audit(agent, state["config"])
            agent["constraintAudit"]["migrationTriggeredThisTick"] = constraint_freeze
            reward = _reward_components(agent, previous_equity, valid)
            agent["lastRewardPct"] = reward["rewardPct"]
            agent["lastReward"] = reward
            agent["rewardLedger"] = [{"at": _now(), **reward}, *list(agent.get("rewardLedger") or [])][:240]
            agent["previousEquity"] = agent["equity"]
    state["memory"]["totalPaperTrades"] = sum(int(agent["stats"]["trades"]) for agent in state["ledger"]["agents"])
    saved = save_state(state, payload.get("db_path"))
    return {
        **saved,
        "events": emitted,
        "acceptedSymbols": [item["symbol"] for item in valid],
        "rejected": rejected,
        "noTrade": no_trade[:300],
        "order_execution_enabled": False,
    }


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
