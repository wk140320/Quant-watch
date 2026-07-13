from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def default_db_path() -> Path:
    configured = os.environ.get("QUANT_DB_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path(__file__).resolve().parents[1] / ".cache" / "quant-control-plane.sqlite3").resolve()


@contextmanager
def _connect(path: str | Path | None = None):
    db_path = Path(path).expanduser().resolve() if path else default_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          market TEXT NOT NULL,
          event_type TEXT NOT NULL,
          entity_id TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_market_type_time
          ON events(market, event_type, created_at DESC);
        CREATE TABLE IF NOT EXISTS order_intents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          market TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_order_intents_market_time
          ON order_intents(market, created_at DESC);
        CREATE TABLE IF NOT EXISTS market_ticks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          market TEXT NOT NULL,
          symbol TEXT NOT NULL,
          ts TEXT NOT NULL,
          price REAL NOT NULL,
          size REAL NOT NULL,
          exchange TEXT,
          trade_id TEXT,
          source TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_time
          ON market_ticks(market, symbol, ts DESC);
        CREATE TABLE IF NOT EXISTS market_l1_quotes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          market TEXT NOT NULL,
          symbol TEXT NOT NULL,
          ts TEXT NOT NULL,
          bid_price REAL,
          bid_size REAL,
          ask_price REAL,
          ask_size REAL,
          source TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_market_l1_symbol_time
          ON market_l1_quotes(market, symbol, ts DESC);
        CREATE TABLE IF NOT EXISTS market_l2_depth (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          market TEXT NOT NULL,
          symbol TEXT NOT NULL,
          ts TEXT NOT NULL,
          side TEXT NOT NULL,
          price REAL,
          size REAL,
          level INTEGER,
          venue TEXT,
          source TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_market_l2_symbol_time
          ON market_l2_depth(market, symbol, ts DESC);
        CREATE TABLE IF NOT EXISTS paper_agent_state (
          market TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          migration_id TEXT,
          config_json TEXT NOT NULL,
          ledger_json TEXT NOT NULL,
          memory_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paper_agent_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          market TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          bar_ts TEXT NOT NULL,
          event_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          price REAL,
          quantity REAL,
          pnl_pct REAL,
          source TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_paper_agent_events_market_time
          ON paper_agent_events(market, id DESC);
        CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          job_type TEXT NOT NULL,
          market TEXT,
          status TEXT NOT NULL,
          progress REAL NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          result_json TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_background_jobs_status_time
          ON background_jobs(status, updated_at DESC);
        """
    )
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _num(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _decode(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    if "payload_json" in result:
        result["payload"] = json.loads(result.pop("payload_json"))
    return result


def append_event(payload: dict[str, Any]) -> dict[str, Any]:
    created_at = str(payload.get("created_at") or datetime.now(timezone.utc).isoformat())[:40]
    market = str(payload.get("market") or "ASX").upper()[:12]
    event_type = str(payload.get("event_type") or payload.get("eventType") or "generic")[:80]
    entity_id = str(payload.get("entity_id") or payload.get("entityId") or "")[:160] or None
    body = payload.get("payload") if isinstance(payload.get("payload"), (dict, list)) else {}
    with _connect(payload.get("db_path")) as connection:
        cursor = connection.execute(
            "INSERT INTO events(created_at, market, event_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?)",
            (created_at, market, event_type, entity_id, _json(body)),
        )
    return {
        "id": cursor.lastrowid,
        "created_at": created_at,
        "market": market,
        "event_type": event_type,
        "entity_id": entity_id,
        "payload": body,
    }


def list_events(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "").upper()[:12]
    event_type = str(payload.get("event_type") or payload.get("eventType") or "")[:80]
    limit = max(1, min(500, int(payload.get("limit") or 100)))
    clauses: list[str] = []
    params: list[Any] = []
    if market:
        clauses.append("market = ?")
        params.append(market)
    if event_type:
        clauses.append("event_type = ?")
        params.append(event_type)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)
    with _connect(payload.get("db_path")) as connection:
        rows = connection.execute(
            f"SELECT id, created_at, market, event_type, entity_id, payload_json FROM events {where} ORDER BY id DESC LIMIT ?",
            params,
        ).fetchall()
    return {"events": [_decode(row) for row in rows], "count": len(rows)}


def record_order_intent(intent: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    with _connect(db_path) as connection:
        existing = connection.execute(
            "SELECT id, created_at, market, intent_id, idempotency_key, status, payload_json FROM order_intents WHERE idempotency_key = ?",
            (intent["idempotency_key"],),
        ).fetchone()
        if existing:
            return {**_decode(existing), "duplicate": True}
        cursor = connection.execute(
            "INSERT INTO order_intents(created_at, market, intent_id, idempotency_key, status, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
            (
                intent["created_at"],
                intent["market"],
                intent["intent_id"],
                intent["idempotency_key"],
                intent["status"],
                _json(intent),
            ),
        )
    return {
        "id": cursor.lastrowid,
        "created_at": intent["created_at"],
        "market": intent["market"],
        "intent_id": intent["intent_id"],
        "idempotency_key": intent["idempotency_key"],
        "status": intent["status"],
        "payload": intent,
        "duplicate": False,
    }


def list_order_intents(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "").upper()[:12]
    limit = max(1, min(500, int(payload.get("limit") or 100)))
    where = "WHERE market = ?" if market else ""
    params: list[Any] = [market] if market else []
    params.append(limit)
    with _connect(payload.get("db_path")) as connection:
        rows = connection.execute(
            f"SELECT id, created_at, market, intent_id, idempotency_key, status, payload_json FROM order_intents {where} ORDER BY id DESC LIMIT ?",
            params,
        ).fetchall()
    return {"order_intents": [_decode(row) for row in rows], "count": len(rows)}


def control_plane_summary(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "").upper()[:12]
    where = "WHERE market = ?" if market else ""
    params: tuple[Any, ...] = (market,) if market else ()
    with _connect(payload.get("db_path")) as connection:
        event_count = connection.execute(f"SELECT COUNT(*) FROM events {where}", params).fetchone()[0]
        order_count = connection.execute(f"SELECT COUNT(*) FROM order_intents {where}", params).fetchone()[0]
        latest_event = connection.execute(
            f"SELECT id, created_at, market, event_type, entity_id, payload_json FROM events {where} ORDER BY id DESC LIMIT 1",
            params,
        ).fetchone()
        latest_order = connection.execute(
            f"SELECT id, created_at, market, intent_id, idempotency_key, status, payload_json FROM order_intents {where} ORDER BY id DESC LIMIT 1",
            params,
        ).fetchone()
    return {
        "market": market or "ALL",
        "database": str(Path(payload.get("db_path")).resolve()) if payload.get("db_path") else str(default_db_path()),
        "event_count": event_count,
        "order_intent_count": order_count,
        "latest_event": _decode(latest_event) if latest_event else None,
        "latest_order_intent": _decode(latest_order) if latest_order else None,
        "order_execution_enabled": False,
    }


def record_market_rows(payload: dict[str, Any]) -> dict[str, Any]:
    data_type = str(payload.get("data_type") or payload.get("dataType") or payload.get("kind") or "").lower()
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    market = str(payload.get("market") or "US").upper()[:12]
    symbol = str(payload.get("symbol") or "").upper()[:32]
    source = str(payload.get("source") or "authorized-provider")[:120]
    created_at = str(payload.get("created_at") or datetime.now(timezone.utc).isoformat())[:40]
    if data_type not in {"ticks", "l1", "l2"}:
        raise ValueError("market data type must be one of ticks, l1, or l2.")
    if not symbol:
        raise ValueError("symbol is required.")

    inserted = 0
    with _connect(payload.get("db_path")) as connection:
        if data_type == "ticks":
            for row in rows:
                price = _num(row.get("price") or row.get("p"))
                size = _num(row.get("size") or row.get("s"))
                ts = str(row.get("timestamp") or row.get("ts") or row.get("t") or created_at)[:80]
                trade_id = str(row.get("trade_id") or row.get("id") or row.get("i") or "")[:120] or None
                if price <= 0 or size <= 0:
                    continue
                existing = connection.execute(
                    """
                    SELECT 1 FROM market_ticks
                    WHERE market = ? AND symbol = ? AND ts = ? AND COALESCE(trade_id, '') = ? AND source = ?
                    LIMIT 1
                    """,
                    (market, symbol, ts, trade_id or "", source),
                ).fetchone()
                if existing:
                    continue
                connection.execute(
                    """
                    INSERT INTO market_ticks(created_at, market, symbol, ts, price, size, exchange, trade_id, source, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        created_at,
                        market,
                        symbol,
                        ts,
                        price,
                        size,
                        str(row.get("exchange") or row.get("x") or "")[:40] or None,
                        trade_id,
                        source,
                        _json(row),
                    ),
                )
                inserted += 1
        elif data_type == "l1":
            for row in rows:
                ts = str(row.get("timestamp") or row.get("ts") or row.get("t") or created_at)[:80]
                bid_price = _num(row.get("bid_price") or row.get("bidPrice") or row.get("bp"), 0.0)
                ask_price = _num(row.get("ask_price") or row.get("askPrice") or row.get("ap"), 0.0)
                if bid_price <= 0 and ask_price <= 0:
                    continue
                bid_size = _num(row.get("bid_size") or row.get("bidSize") or row.get("bs"), 0.0) or None
                ask_size = _num(row.get("ask_size") or row.get("askSize") or row.get("as"), 0.0) or None
                existing = connection.execute(
                    """
                    SELECT 1 FROM market_l1_quotes
                    WHERE market = ? AND symbol = ? AND ts = ? AND COALESCE(bid_price, 0) = ?
                      AND COALESCE(ask_price, 0) = ? AND source = ?
                    LIMIT 1
                    """,
                    (market, symbol, ts, bid_price or 0.0, ask_price or 0.0, source),
                ).fetchone()
                if existing:
                    continue
                connection.execute(
                    """
                    INSERT INTO market_l1_quotes(created_at, market, symbol, ts, bid_price, bid_size, ask_price, ask_size, source, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        created_at,
                        market,
                        symbol,
                        ts,
                        bid_price or None,
                        bid_size,
                        ask_price or None,
                        ask_size,
                        source,
                        _json(row),
                    ),
                )
                inserted += 1
        else:
            for row in rows:
                ts = str(row.get("timestamp") or row.get("ts") or row.get("t") or created_at)[:80]
                side = str(row.get("side") or row.get("s") or "").lower()
                if side not in {"bid", "ask"}:
                    continue
                price = _num(row.get("price") or row.get("p"), 0.0) or None
                size = _num(row.get("size") or row.get("qty") or row.get("q"), 0.0) or None
                level = int(_num(row.get("level"), 0.0)) if row.get("level") is not None else None
                venue = str(row.get("venue") or row.get("exchange") or "")[:40] or None
                existing = connection.execute(
                    """
                    SELECT 1 FROM market_l2_depth
                    WHERE market = ? AND symbol = ? AND ts = ? AND side = ? AND COALESCE(price, 0) = ?
                      AND COALESCE(level, -1) = ? AND COALESCE(venue, '') = ? AND source = ?
                    LIMIT 1
                    """,
                    (market, symbol, ts, side, price or 0.0, level if level is not None else -1, venue or "", source),
                ).fetchone()
                if existing:
                    continue
                connection.execute(
                    """
                    INSERT INTO market_l2_depth(created_at, market, symbol, ts, side, price, size, level, venue, source, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        created_at,
                        market,
                        symbol,
                        ts,
                        side,
                        price,
                        size,
                        level,
                        venue,
                        source,
                        _json(row),
                    ),
                )
                inserted += 1

    return {
        "market": market,
        "symbol": symbol,
        "data_type": data_type,
        "inserted": inserted,
        "source": source,
        "true_tick": data_type == "ticks" and inserted > 0,
        "true_l1": data_type == "l1" and inserted > 0,
        "true_l2": data_type == "l2" and inserted > 0,
        "note": "Rows are persisted only when supplied by an authorised real-data feed; no synthetic tick/L1/L2 rows are generated.",
    }


def market_data_summary(payload: dict[str, Any]) -> dict[str, Any]:
    market = str(payload.get("market") or "").upper()[:12]
    symbol = str(payload.get("symbol") or "").upper()[:32]
    clauses = []
    params: list[Any] = []
    if market:
        clauses.append("market = ?")
        params.append(market)
    if symbol:
        clauses.append("symbol = ?")
        params.append(symbol)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with _connect(payload.get("db_path")) as connection:
        tick_count = connection.execute(f"SELECT COUNT(*) FROM market_ticks {where}", params).fetchone()[0]
        l1_count = connection.execute(f"SELECT COUNT(*) FROM market_l1_quotes {where}", params).fetchone()[0]
        l2_count = connection.execute(f"SELECT COUNT(*) FROM market_l2_depth {where}", params).fetchone()[0]
        latest_tick = connection.execute(
            f"SELECT ts, price, size, source FROM market_ticks {where} ORDER BY ts DESC LIMIT 1",
            params,
        ).fetchone()
        latest_l1 = connection.execute(
            f"SELECT ts, bid_price, ask_price, source FROM market_l1_quotes {where} ORDER BY ts DESC LIMIT 1",
            params,
        ).fetchone()
        latest_l2 = connection.execute(
            f"SELECT ts, side, price, size, source FROM market_l2_depth {where} ORDER BY ts DESC LIMIT 1",
            params,
        ).fetchone()
    return {
        "market": market or "ALL",
        "symbol": symbol or "ALL",
        "database": str(Path(payload.get("db_path")).resolve()) if payload.get("db_path") else str(default_db_path()),
        "tick_count": tick_count,
        "l1_quote_count": l1_count,
        "l2_depth_count": l2_count,
        "true_tick_available": tick_count > 0,
        "true_l1_available": l1_count > 0,
        "true_l2_available": l2_count > 0,
        "latest_tick": dict(latest_tick) if latest_tick else None,
        "latest_l1": dict(latest_l1) if latest_l1 else None,
        "latest_l2": dict(latest_l2) if latest_l2 else None,
        "note": "True tick/L1/L2 availability means authorised rows were locally recorded; absence is reported explicitly and not replaced with simulated data.",
    }


def list_market_rows(payload: dict[str, Any]) -> dict[str, Any]:
    data_type = str(payload.get("data_type") or payload.get("dataType") or payload.get("kind") or "ticks").lower()
    market = str(payload.get("market") or "").upper()[:12]
    symbol = str(payload.get("symbol") or "").upper()[:32]
    limit = max(1, min(10000, int(payload.get("limit") or 1000)))
    if data_type not in {"ticks", "l1", "l2"}:
        raise ValueError("market data type must be one of ticks, l1, or l2.")
    if not market or not symbol:
        raise ValueError("market and symbol are required.")

    table = {
        "ticks": "market_ticks",
        "l1": "market_l1_quotes",
        "l2": "market_l2_depth",
    }[data_type]
    columns = {
        "ticks": "created_at, ts, price, size, exchange, trade_id, source, payload_json",
        "l1": "created_at, ts, bid_price, bid_size, ask_price, ask_size, source, payload_json",
        "l2": "created_at, ts, side, price, size, level, venue, source, payload_json",
    }[data_type]
    with _connect(payload.get("db_path")) as connection:
        rows = connection.execute(
            f"""
            SELECT {columns}
            FROM {table}
            WHERE market = ? AND symbol = ?
            ORDER BY ts DESC, id DESC
            LIMIT ?
            """,
            (market, symbol, limit),
        ).fetchall()

    normalized: list[dict[str, Any]] = []
    for row in reversed(rows):
        item = dict(row)
        payload_json = item.pop("payload_json", "{}")
        try:
            item["payload"] = json.loads(payload_json)
        except json.JSONDecodeError:
            item["payload"] = {}
        if data_type == "ticks":
            item["timestamp"] = item.pop("ts")
        elif data_type == "l1":
            item["timestamp"] = item.pop("ts")
        else:
            item["timestamp"] = item.pop("ts")
        normalized.append(item)

    return {
        "market": market,
        "symbol": symbol,
        "data_type": data_type,
        "count": len(normalized),
        "rows": normalized,
        "source": "local-authorized-market-data-store",
        "true_tick": data_type == "ticks" and bool(normalized),
        "true_l1": data_type == "l1" and bool(normalized),
        "true_l2": data_type == "l2" and bool(normalized),
        "note": "Rows are replayed from locally persisted authorised provider data; no synthetic rows are generated.",
    }
