from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MARKETS = {"ASX", "US", "CN"}
PIT_DATASETS = {
    "corporate_actions", "financial_disclosures", "fundamentals", "macro", "news", "social", "universe",
}
ROW_FIELDS = [
    "key", "market", "exchange", "symbol", "timestamp", "date", "interval",
    "open", "high", "low", "close", "volume", "amount", "turnover_rate",
    "source", "available_at", "adjustment", "saved_at",
]
OHLCV_SCHEMA_VERSION = "ohlcv-v2-interval-content-hash"
PIT_SCHEMA_VERSION = "pit-v2-first-seen-verified-content-hash"


def _stable_hash(value: Any, length: int = 32) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:length]


def _root(payload: dict[str, Any]) -> Path:
    configured = payload.get("root") or os.environ.get("QUANT_DATA_LAKE_PATH")
    if configured:
        return Path(str(configured)).expanduser().resolve()
    return (Path(__file__).resolve().parents[1] / ".cache" / "data-lake").resolve()


def _market(value: Any) -> str:
    market = str(value or "ASX").upper()
    if market not in MARKETS:
        raise ValueError(f"Unsupported market for data lake: {market}")
    return market


def _symbol(value: Any, market: str) -> str:
    symbol = str(value or "").strip().upper()
    if market == "ASX":
        symbol = symbol[:-3] if symbol.endswith(".AX") else symbol
    if market == "CN":
        symbol = symbol.replace(".", "")
        if re.fullmatch(r"(?:SH|SZ)\d{6}", symbol):
            symbol = symbol[2:]
    if (
        not symbol
        or len(symbol) > 32
        or symbol in {".", ".."}
        or ".." in symbol
        or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-^" for char in symbol)
    ):
        raise ValueError(f"Invalid {market} symbol for data lake: {symbol}")
    if market in {"ASX", "US"} and re.fullmatch(r"\d{6}", symbol):
        raise ValueError(f"Cross-market China A-share symbol rejected from {market} data lake: {symbol}")
    if market == "CN" and not re.fullmatch(r"\d{6}", symbol):
        raise ValueError(f"Cross-market symbol rejected from CN data lake: {symbol}")
    return symbol


def _exchange(market: str, symbol: str, value: Any = None) -> str:
    explicit = str(value or "").strip().upper()
    if explicit:
        return explicit[:16]
    if market == "ASX":
        return "ASX"
    if market == "CN":
        return "SSE" if symbol.startswith(("5", "6", "9", "SH")) else "SZSE"
    return "US"


def _canonical_allowed_symbol(value: Any, market: str) -> str:
    raw = str(value or "").strip().upper()
    if market == "ASX" and raw.endswith(".AX"):
        raw = raw[:-3]
    if market == "CN":
        raw = raw.replace(".", "")
        if re.fullmatch(r"(?:SH|SZ)\d{6}", raw):
            raw = raw[2:]
    return raw


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _ohlcv_validation_reason(row: dict[str, Any]) -> str | None:
    prices = {name: _number(row.get(name)) for name in ("open", "high", "low", "close")}
    if prices["close"] is None or prices["close"] <= 0:
        return "non_positive_close"
    present = [value for value in prices.values() if value is not None]
    if any(value <= 0 for value in present):
        return "non_positive_price"
    high = prices["high"]
    low = prices["low"]
    if high is not None and low is not None and high < low:
        return "high_below_low"
    if high is not None and any(high + 1e-12 < value for value in (prices["open"], prices["close"]) if value is not None):
        return "high_below_open_or_close"
    if low is not None and any(low - 1e-12 > value for value in (prices["open"], prices["close"]) if value is not None):
        return "low_above_open_or_close"
    volume = _number(row.get("volume"))
    if volume is not None and volume < 0:
        return "negative_volume"
    return None


def _row_content_identity(row: dict[str, Any]) -> list[Any]:
    return [OHLCV_SCHEMA_VERSION, *[row.get(field) for field in ROW_FIELDS if field != "saved_at"]]


def _normalise_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    market = _market(payload.get("market"))
    symbol = _symbol(payload.get("symbol"), market)
    exchange = _exchange(market, symbol, payload.get("exchange"))
    interval = str(payload.get("interval") or "1d")[:12]
    source = str(payload.get("source") or "unknown")[:120]
    available_at = str(payload.get("available_at") or payload.get("availableAt") or datetime.now(timezone.utc).isoformat())[:40]
    saved_at = datetime.now(timezone.utc).isoformat()
    rows: list[dict[str, Any]] = []
    for item in payload.get("candles") or []:
        timestamp = str(item.get("timestamp") or item.get("date") or "")[:40]
        date = timestamp[:10]
        raw_close = _number(item.get("close"))
        adjusted_close = _number(item.get("adjClose", item.get("adjustedClose")))
        close = adjusted_close if adjusted_close is not None and adjusted_close > 0 else raw_close
        if len(date) != 10 or close is None or close <= 0:
            continue
        scale = close / raw_close if raw_close is not None and raw_close > 0 else 1.0
        adjustment = str(payload.get("adjustment") or "provider-adjusted")[:32]
        if adjusted_close is not None and adjusted_close > 0 and raw_close is not None and raw_close > 0 \
                and abs(adjusted_close - raw_close) / raw_close > 1e-8:
            adjustment = "split-dividend-adjusted"
        def adjusted_price(name: str) -> float | None:
            value = _number(item.get(name))
            return value * scale if value is not None else None
        key = f"{market}:{exchange}:{symbol}:{interval}:{timestamp}"
        rows.append({
            "key": key,
            "market": market,
            "exchange": exchange,
            "symbol": symbol,
            "timestamp": timestamp,
            "date": date,
            "interval": interval,
            "open": adjusted_price("open"),
            "high": adjusted_price("high"),
            "low": adjusted_price("low"),
            "close": close,
            "volume": _number(item.get("volume")),
            "amount": _number(item.get("amount")),
            "turnover_rate": _number(item.get("turnoverRate", item.get("turnover_rate"))),
            "source": source,
            "available_at": str(item.get("available_at") or item.get("availableAt") or available_at)[:40],
            "adjustment": adjustment,
            "saved_at": saved_at,
        })
    return rows


def _partition(root: Path, market: str, exchange: str, interval: str, symbol: str) -> Path:
    safe_interval = "".join(char for char in interval if char.isalnum() or char in "_-") or "1d"
    safe_exchange = "".join(char for char in exchange if char.isalnum() or char in "_-^") or market
    return root / "ohlcv" / f"market={market}" / f"exchange={safe_exchange}" / f"interval={safe_interval}" / f"symbol={symbol}" / "data.parquet"


def _legacy_partition(root: Path, market: str, interval: str, symbol: str) -> Path:
    safe_interval = "".join(char for char in interval if char.isalnum() or char in "_-") or "1d"
    return root / "ohlcv" / f"market={market}" / f"interval={safe_interval}" / f"symbol={symbol}" / "data.parquet"


def _write_catalog(root: Path) -> bool:
    try:
        import duckdb  # type: ignore
    except ImportError:
        return False
    database = root / "quant.duckdb"
    pattern = str(root / "ohlcv" / "market=*" / "exchange=*" / "interval=*" / "symbol=*" / "data.parquet").replace("'", "''")
    connection = duckdb.connect(str(database))
    try:
        connection.execute(f"CREATE OR REPLACE VIEW ohlcv AS SELECT * FROM read_parquet('{pattern}', union_by_name=true)")
    except Exception:
        connection.execute("CREATE TABLE IF NOT EXISTS ohlcv_empty(key VARCHAR)")
    finally:
        connection.close()
    return True


def upsert(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    normalized_rows = _normalise_rows(payload)
    rejected_rows = [
        {**row, "quarantine_reason": reason}
        for row in normalized_rows
        if (reason := _ohlcv_validation_reason(row)) is not None
    ]
    rows = [row for row in normalized_rows if _ohlcv_validation_reason(row) is None]
    market = _market(payload.get("market"))
    symbol = _symbol(payload.get("symbol"), market)
    exchange = _exchange(market, symbol, payload.get("exchange"))
    interval = str(payload.get("interval") or "1d")
    root = _root(payload)
    target = _partition(root, market, exchange, interval, symbol)
    legacy = _legacy_partition(root, market, interval, symbol)
    target.parent.mkdir(parents=True, exist_ok=True)
    escaped_target = str(target).replace("'", "''")
    connection = duckdb.connect()
    incoming_path: Path | None = None
    temporary = target.with_suffix(f".{os.getpid()}.tmp.parquet")
    try:
        connection.execute("""
            CREATE TABLE lake_rows(
              key VARCHAR PRIMARY KEY, market VARCHAR, exchange VARCHAR, symbol VARCHAR,
              timestamp VARCHAR, date VARCHAR, interval VARCHAR, open DOUBLE, high DOUBLE,
              low DOUBLE, close DOUBLE, volume DOUBLE, amount DOUBLE, turnover_rate DOUBLE,
              source VARCHAR, available_at VARCHAR, adjustment VARCHAR, saved_at VARCHAR
            )
        """)
        existing_count = 0
        existing_source = target if target.exists() else legacy if legacy.exists() else None
        if existing_source:
            escaped_existing = str(existing_source).replace("'", "''")
            connection.execute(f"""
                INSERT OR REPLACE INTO lake_rows
                SELECT concat(market, ':', coalesce(exchange, market), ':', symbol, ':', interval, ':', timestamp) AS key,
                  market, coalesce(exchange, market) AS exchange, symbol, timestamp, date, interval,
                  open, high, low, close, volume, amount, turnover_rate, source, available_at, adjustment, saved_at
                FROM read_parquet('{escaped_existing}', union_by_name=true)
                WHERE close > 0
                  AND (open IS NULL OR open > 0) AND (high IS NULL OR high > 0) AND (low IS NULL OR low > 0)
                  AND (high IS NULL OR low IS NULL OR high >= low)
                  AND (high IS NULL OR open IS NULL OR high >= open)
                  AND (high IS NULL OR close IS NULL OR high >= close)
                  AND (low IS NULL OR open IS NULL OR low <= open)
                  AND (low IS NULL OR close IS NULL OR low <= close)
                  AND (volume IS NULL OR volume >= 0)
            """)
            existing_count = int(connection.execute("SELECT count(*) FROM lake_rows").fetchone()[0])
        if rows:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".ndjson",
                prefix="ohlcv-incoming-",
                dir=target.parent,
                delete=False,
            ) as stream:
                incoming_path = Path(stream.name)
                for row in rows:
                    stream.write(json.dumps({field: row.get(field) for field in ROW_FIELDS}, ensure_ascii=False, separators=(",", ":")))
                    stream.write("\n")
            escaped_incoming = str(incoming_path).replace("'", "''")
            connection.execute(f"""
                CREATE TEMP TABLE incoming_lake_rows AS
                SELECT * FROM read_json_auto(
                    '{escaped_incoming}',
                    format='newline_delimited',
                    columns={{
                        key: 'VARCHAR', market: 'VARCHAR', exchange: 'VARCHAR', symbol: 'VARCHAR',
                        timestamp: 'VARCHAR', date: 'VARCHAR', interval: 'VARCHAR', open: 'DOUBLE',
                        high: 'DOUBLE', low: 'DOUBLE', close: 'DOUBLE', volume: 'DOUBLE',
                        amount: 'DOUBLE', turnover_rate: 'DOUBLE', source: 'VARCHAR',
                        available_at: 'VARCHAR', adjustment: 'VARCHAR', saved_at: 'VARCHAR'
                    }}
                )
            """)
            connection.execute("INSERT OR REPLACE INTO lake_rows SELECT * FROM incoming_lake_rows")
        ordered_count = int(connection.execute("SELECT count(*) FROM lake_rows").fetchone()[0])
        escaped_temporary = str(temporary).replace("'", "''")
        connection.execute(f"COPY (SELECT * FROM lake_rows ORDER BY timestamp) TO '{escaped_temporary}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        signature_rows = connection.execute("SELECT * FROM lake_rows ORDER BY timestamp, key").fetchall()
        first_last = connection.execute("SELECT min(timestamp), max(timestamp) FROM lake_rows").fetchone()
    finally:
        connection.close()
        if incoming_path:
            incoming_path.unlink(missing_ok=True)
    temporary.replace(target)
    if rejected_rows:
        quarantine = root / "quarantine" / "ohlcv-invalid" / f"market={market}" / f"exchange={exchange}" / f"interval={interval}" / f"symbol={symbol}" / "rows.ndjson"
        quarantine.parent.mkdir(parents=True, exist_ok=True)
        with quarantine.open("a", encoding="utf-8") as stream:
            for row in rejected_rows:
                stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), default=str) + "\n")
    catalog_ready = _write_catalog(root) if payload.get("refresh_catalog", payload.get("refreshCatalog", True)) is not False else (root / "quant.duckdb").exists()
    signature = _stable_hash({
        "schema": OHLCV_SCHEMA_VERSION,
        "rows": [list(row[:-1]) for row in signature_rows],
    }, 64)
    return {
        "available": True,
        "market": market,
        "symbol": symbol,
        "exchange": exchange,
        "interval": interval,
        "inserted": max(0, ordered_count - existing_count),
        "rows": ordered_count,
        "first": first_last[0] if ordered_count else None,
        "last": first_last[1] if ordered_count else None,
        "data_version": signature,
        "schema_version": OHLCV_SCHEMA_VERSION,
        "quarantined": len(rejected_rows),
        "parquet": str(target),
        "duckdb": catalog_ready,
        "qlib_compatible": True,
    }


def read_rows(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    market = _market(payload.get("market"))
    symbol = _symbol(payload.get("symbol"), market)
    exchange = _exchange(market, symbol, payload.get("exchange"))
    interval = str(payload.get("interval") or "1d")
    root = _root(payload)
    target = _partition(root, market, exchange, interval, symbol)
    if not target.exists():
        target = _legacy_partition(root, market, interval, symbol)
    if not target.exists():
        return {"available": False, "market": market, "symbol": symbol, "interval": interval, "candles": [], "rows": 0}
    limit = max(1, min(20_000, int(payload.get("limit") or 6_500)))
    escaped_target = str(target).replace("'", "''")
    connection = duckdb.connect()
    cursor = connection.execute(f"SELECT * FROM read_parquet('{escaped_target}') ORDER BY timestamp DESC LIMIT {limit}")
    columns = [description[0] for description in cursor.description]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    connection.close()
    rows.reverse()
    candles = [{
        "date": row.get("timestamp"),
        "open": row.get("open"),
        "high": row.get("high"),
        "low": row.get("low"),
        "close": row.get("close"),
        "volume": row.get("volume"),
        "amount": row.get("amount"),
        "turnoverRate": row.get("turnover_rate"),
        "available_at": row.get("available_at"),
        "adjustment": row.get("adjustment"),
    } for row in rows]
    return {
        "available": True,
        "market": market,
        "symbol": symbol,
        "exchange": exchange,
        "interval": interval,
        "source": "local-parquet-data-lake",
        "adjustment": (
            "split-dividend-adjusted"
            if any(row.get("adjustment") == "split-dividend-adjusted" for row in rows)
            else next((row.get("adjustment") for row in reversed(rows) if row.get("adjustment")), "unknown")
        ),
        "rows": len(candles),
        "dataVersion": _stable_hash({
            "schema": OHLCV_SCHEMA_VERSION,
            "rows": [_row_content_identity(row) for row in rows],
        }, 64),
        "candles": candles,
    }


def read_panel(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    interval = str(payload.get("interval") or "1d")
    min_rows = max(1, min(20_000, int(payload.get("min_rows", payload.get("minRows", 1)) or 1)))
    items = []
    failures = []
    for raw_symbol in payload.get("symbols") or []:
        try:
            symbol = _symbol(raw_symbol, market)
            result = read_rows({
                "root": payload.get("root"),
                "market": market,
                "exchange": _exchange(market, symbol),
                "symbol": symbol,
                "interval": interval,
                "limit": payload.get("limit") or 6_500,
            })
            if result.get("available") and int(result.get("rows") or 0) >= min_rows:
                candles = result.get("candles") or []
                items.append({
                    "market": market,
                    "exchange": result.get("exchange"),
                    "symbol": symbol,
                    "source": "local-parquet-data-lake",
                    "adjustment": result.get("adjustment") or "unknown",
                    "corporateActionAdjusted": result.get("adjustment") == "split-dividend-adjusted",
                    "rows": len(candles),
                    "first": candles[0].get("date") if candles else None,
                    "last": candles[-1].get("date") if candles else None,
                    "candles": candles,
                })
        except Exception as exc:  # noqa: BLE001 - one damaged partition must not block the panel.
            failures.append({"symbol": str(raw_symbol), "error": str(exc)})
    return {
        "available": bool(items),
        "market": market,
        "interval": interval,
        "requested": len(payload.get("symbols") or []),
        "availableCount": len(items),
        "minRows": min_rows,
        "items": items,
        "failures": failures,
    }


def upsert_panel(payload: dict[str, Any]) -> dict[str, Any]:
    market = _market(payload.get("market"))
    interval = str(payload.get("interval") or "1d")
    results = []
    failures = []
    for item in payload.get("items") or []:
        try:
            symbol = _symbol(item.get("symbol"), market)
            results.append(upsert({
                "root": payload.get("root"),
                "market": market,
                "exchange": item.get("exchange") or _exchange(market, symbol),
                "symbol": symbol,
                "interval": interval,
                "source": item.get("source") or payload.get("source") or "historical-training-panel",
                "available_at": item.get("available_at") or item.get("availableAt") or payload.get("available_at") or payload.get("availableAt"),
                "adjustment": item.get("adjustment") or payload.get("adjustment") or "provider-adjusted",
                "candles": item.get("candles") or [],
                "refresh_catalog": False,
            }))
        except Exception as exc:  # noqa: BLE001 - one invalid symbol remains isolated.
            failures.append({"symbol": str(item.get("symbol") or ""), "error": str(exc)})
    root = _root(payload)
    catalog_ready = _write_catalog(root) if results else (root / "quant.duckdb").exists()
    return {
        "available": bool(results),
        "market": market,
        "interval": interval,
        "partitions": len(results),
        "inserted": sum(int(row.get("inserted") or 0) for row in results),
        "rows": sum(int(row.get("rows") or 0) for row in results),
        "failures": failures,
        "duckdb": catalog_ready,
        "items": [{key: row.get(key) for key in ("symbol", "exchange", "inserted", "rows", "first", "last", "data_version")} for row in results],
    }


def summary(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    root = _root(payload)
    market_filter = str(payload.get("market") or "").upper()
    files = list((root / "ohlcv").glob("market=*/exchange=*/interval=*/symbol=*/data.parquet")) if (root / "ohlcv").exists() else []
    if not files and (root / "ohlcv").exists():
        files = list((root / "ohlcv").glob("market=*/interval=*/symbol=*/data.parquet"))
    rows: list[dict[str, Any]] = []
    catalog_ready = _write_catalog(root) if files else (root / "quant.duckdb").exists()
    if files:
        pattern = (
            str(root / "ohlcv" / "market=*" / "exchange=*" / "interval=*" / "symbol=*" / "data.parquet")
            if any("exchange=" in str(path) for path in files)
            else str(root / "ohlcv" / "market=*" / "interval=*" / "symbol=*" / "data.parquet")
        ).replace("'", "''")
        escaped_market_filter = market_filter.replace("'", "''")
        connection = duckdb.connect()
        try:
            query = f"""
                SELECT market, coalesce(exchange, market) AS exchange, interval, symbol, count(*) AS rows
                FROM read_parquet('{pattern}', union_by_name=true)
                WHERE ('{escaped_market_filter}' = '' OR market = '{escaped_market_filter}')
                GROUP BY market, coalesce(exchange, market), interval, symbol
                ORDER BY market, coalesce(exchange, market), interval, symbol
            """
            result = connection.execute(query)
            rows = [
                {"market": market, "exchange": exchange, "interval": interval, "symbol": symbol, "rows": int(count)}
                for market, exchange, interval, symbol, count in result.fetchall()
            ]
        finally:
            connection.close()
    daily_symbol_counts = {
        market: len({row["symbol"] for row in rows if row["market"] == market and row["interval"] == "1d"})
        for market in MARKETS
    }
    pit_summary: dict[str, dict[str, Any]] = {}
    for dataset in sorted(PIT_DATASETS):
        pit_files = list((root / dataset).glob("market=*/exchange=*/symbol=*/data.parquet"))
        dataset_rows = 0
        market_rows = {market: 0 for market in MARKETS}
        verified_market_rows = {market: 0 for market in MARKETS}
        market_symbols = {market: 0 for market in MARKETS}
        verified_market_symbols = {market: 0 for market in MARKETS}
        if pit_files:
            pattern = str(root / dataset / "market=*" / "exchange=*" / "symbol=*" / "data.parquet").replace("'", "''")
            connection = duckdb.connect()
            try:
                result = connection.execute(f"""
                    SELECT market, count(*),
                      sum(CASE WHEN try_cast(json_extract(payload_json, '$.historicalAvailabilityVerified') AS BOOLEAN) = true
                        AND coalesce(try_cast(json_extract(payload_json, '$.historicalAvailabilityUnverified') AS BOOLEAN), false) = false
                      THEN 1 ELSE 0 END),
                      count(DISTINCT coalesce(nullif(json_extract_string(payload_json, '$.symbol'), ''), symbol)),
                      count(DISTINCT CASE WHEN try_cast(json_extract(payload_json, '$.historicalAvailabilityVerified') AS BOOLEAN) = true
                        AND coalesce(try_cast(json_extract(payload_json, '$.historicalAvailabilityUnverified') AS BOOLEAN), false) = false
                      THEN coalesce(nullif(json_extract_string(payload_json, '$.symbol'), ''), symbol) ELSE NULL END)
                    FROM read_parquet('{pattern}', union_by_name=true) GROUP BY market
                """).fetchall()
                verified_rows = 0
                for pit_market, count, verified, symbol_count, verified_symbol_count in result:
                    if pit_market in market_rows:
                        market_rows[pit_market] = int(count)
                        verified_market_rows[pit_market] = int(verified or 0)
                        market_symbols[pit_market] = int(symbol_count or 0)
                        verified_market_symbols[pit_market] = int(verified_symbol_count or 0)
                        dataset_rows += int(count)
                        verified_rows += int(verified or 0)
            finally:
                connection.close()
        pit_summary[dataset] = {
            "partitions": len(pit_files),
            "rows": dataset_rows,
            "markets": market_rows,
            "verifiedRows": verified_rows if pit_files else 0,
            "verifiedPct": round((verified_rows if pit_files else 0) / max(1, dataset_rows) * 100.0, 4),
            "verifiedMarkets": verified_market_rows,
            "verifiedMarketPct": {
                market: round(verified_market_rows[market] / max(1, market_rows[market]) * 100.0, 4)
                for market in MARKETS
            },
            "symbols": market_symbols,
            "verifiedSymbols": verified_market_symbols,
            "verifiedSymbolPct": {
                market: round(verified_market_symbols[market] / max(1, market_symbols[market]) * 100.0, 4)
                for market in MARKETS
            },
            "trainingUniverseCoveragePct": {
                market: round(min(1.0, verified_market_symbols[market] / max(1, daily_symbol_counts[market])) * 100.0, 4)
                for market in MARKETS
            },
            "pointInTime": True,
            "requiredTimestamp": "available_at",
        }
    return {
        "available": True,
        "root": str(root),
        "partitions": len(rows),
        "rows": sum(int(row["rows"]) for row in rows),
        "markets": {market: sum(int(row["rows"]) for row in rows if row["market"] == market) for market in MARKETS},
        "dailySymbols": daily_symbol_counts,
        "items": rows[:2_000],
        "pitDatasets": pit_summary,
        "pitRows": sum(int(item["rows"]) for item in pit_summary.values()),
        "duckdb": catalog_ready,
        "parquet": True,
        "qlib_compatible": True,
    }


def _source_market_consistent(source: str, market: str) -> bool:
    clean = str(source or "").lower()
    if not clean:
        return False
    if market == "ASX" and any(token in clean for token in ("alpaca", "nasdaq-us", "tiingo-us", "-us-")):
        return False
    if market == "US" and any(token in clean for token in ("stockanalysis-asx", "tiingo-asx", "eodhd-asx", "yahoo-asx", "-asx-")):
        return False
    if market == "CN" and not any(token in clean for token in ("cn", "tushare", "baostock", "tencent", "eastmoney", "sina")):
        return False
    return True


def _inspect_audit_partition(path: Path, connection: Any = None) -> tuple[list[tuple[Any, ...]], list[str]]:
    """Return data identities and provenance sources without treating source changes as identity changes."""
    import duckdb  # type: ignore

    owns_connection = connection is None
    connection = connection or duckdb.connect()
    try:
        escaped_path = str(path).replace("'", "''")
        identities = connection.execute(
            f"SELECT market, exchange, symbol, count(*) FROM read_parquet('{escaped_path}') GROUP BY ALL"
        ).fetchall()
        sources = [
            str(row[0] or "")
            for row in connection.execute(
                f"SELECT DISTINCT source FROM read_parquet('{escaped_path}') ORDER BY source"
            ).fetchall()
        ]
        return identities, sources
    finally:
        if owns_connection:
            connection.close()


def _repair_ohlcv_partition(path: Path, connection: Any, quarantine_root: Path) -> dict[str, int]:
    escaped = str(path).replace("'", "''")
    invalid_predicate = """
      close IS NULL OR close <= 0
      OR (open IS NOT NULL AND open <= 0) OR (high IS NOT NULL AND high <= 0) OR (low IS NOT NULL AND low <= 0)
      OR (high IS NOT NULL AND low IS NOT NULL AND high < low)
      OR (high IS NOT NULL AND open IS NOT NULL AND high < open)
      OR (high IS NOT NULL AND close IS NOT NULL AND high < close)
      OR (low IS NOT NULL AND open IS NOT NULL AND low > open)
      OR (low IS NOT NULL AND close IS NOT NULL AND low > close)
      OR (volume IS NOT NULL AND volume < 0)
    """
    invalid_count = int(connection.execute(
        f"SELECT count(*) FROM read_parquet('{escaped}', union_by_name=true) WHERE {invalid_predicate}"
    ).fetchone()[0])
    duplicate_count = int(connection.execute(f"""
        SELECT coalesce(sum(rows - 1), 0) FROM (
          SELECT count(*) AS rows
          FROM read_parquet('{escaped}', union_by_name=true)
          GROUP BY market, coalesce(exchange, market), symbol, interval, timestamp
          HAVING count(*) > 1
        )
    """).fetchone()[0])
    old_key_count = int(connection.execute(f"""
        SELECT count(*) FROM read_parquet('{escaped}', union_by_name=true)
        WHERE key <> concat(market, ':', coalesce(exchange, market), ':', symbol, ':', interval, ':', timestamp)
    """).fetchone()[0])
    if not invalid_count and not duplicate_count and not old_key_count:
        return {"invalid": 0, "duplicates": 0, "keysMigrated": 0}
    if invalid_count:
        parts = list(path.parts)
        relative = Path(*parts[parts.index("ohlcv") + 1:]) if "ohlcv" in parts else Path(path.name)
        quarantine = quarantine_root / relative
        quarantine.parent.mkdir(parents=True, exist_ok=True)
        escaped_quarantine = str(quarantine).replace("'", "''")
        connection.execute(f"COPY (SELECT * FROM read_parquet('{escaped}', union_by_name=true) WHERE {invalid_predicate}) TO '{escaped_quarantine}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    temporary = path.with_suffix(f".{os.getpid()}.quality.tmp.parquet")
    escaped_temporary = str(temporary).replace("'", "''")
    connection.execute(f"""
        COPY (
          WITH ranked AS (
            SELECT *, row_number() OVER (
              PARTITION BY market, coalesce(exchange, market), symbol, interval, timestamp
              ORDER BY saved_at DESC NULLS LAST, available_at DESC NULLS LAST
            ) AS row_order
            FROM read_parquet('{escaped}', union_by_name=true)
            WHERE NOT ({invalid_predicate})
          )
          SELECT concat(market, ':', coalesce(exchange, market), ':', symbol, ':', interval, ':', timestamp) AS key,
            market, coalesce(exchange, market) AS exchange, symbol, timestamp, date, interval,
            open, high, low, close, volume, amount, turnover_rate, source, available_at, adjustment, saved_at
          FROM ranked WHERE row_order = 1 ORDER BY timestamp
        ) TO '{escaped_temporary}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    temporary.replace(path)
    return {"invalid": invalid_count, "duplicates": duplicate_count, "keysMigrated": old_key_count}


def audit(payload: dict[str, Any]) -> dict[str, Any]:
    """Migrate trusted legacy OHLCV partitions and quarantine unverifiable rows."""
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    root = _root(payload)
    raw_allowed = payload.get("allowed_symbols") or payload.get("allowedSymbols") or {}
    allowed_by_market = {
        market: {_canonical_allowed_symbol(symbol, market) for symbol in symbols}
        for market, symbols in raw_allowed.items()
        if market in MARKETS and isinstance(symbols, list)
    }
    legacy_files = list((root / "ohlcv").glob("market=*/interval=*/symbol=*/data.parquet"))
    partitioned_files = list((root / "ohlcv").glob("market=*/exchange=*/interval=*/symbol=*/data.parquet"))
    migrated = []
    verified = []
    recovered = []
    quarantined = []
    failed = []
    quality_repair = {"invalid": 0, "duplicates": 0, "keysMigrated": 0}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    audit_connection = duckdb.connect()
    for path in [*legacy_files, *partitioned_files]:
        try:
            grouped, sources = _inspect_audit_partition(path, audit_connection)
            if not grouped:
                raise ValueError("empty partition")
            if len(grouped) != 1:
                destination = root / "quarantine" / f"audit={stamp}" / path.relative_to(root)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(destination))
                quarantined.append({"market": "mixed", "symbol": "mixed", "source": "mixed", "rows": sum(int(row[-1]) for row in grouped), "path": str(destination), "reason": "mixed partition identities"})
                continue
            row = grouped[0]
            market, exchange, raw_symbol, count = row
            market = _market(market)
            symbol = _symbol(raw_symbol, market)
            expected_exchange = _exchange(market, symbol, exchange)
            allowed = allowed_by_market.get(market)
            source = "+".join(sources)
            trusted = all(_source_market_consistent(item, market) for item in sources) and (not allowed or symbol in allowed or symbol.startswith("^"))
            interval = path.parent.parent.name.split("=", 1)[-1]
            if not trusted:
                destination = root / "quarantine" / f"audit={stamp}" / path.relative_to(root)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(destination))
                quarantined.append({"market": market, "symbol": symbol, "source": source, "rows": int(count), "path": str(destination)})
                continue
            destination = _partition(root, market, expected_exchange, interval, symbol)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.resolve() == path.resolve():
                if payload.get("repair_quality", payload.get("repairQuality", True)) is not False:
                    repaired = _repair_ohlcv_partition(
                        destination,
                        audit_connection,
                        root / "quarantine" / f"quality={stamp}",
                    )
                    for name, value in repaired.items():
                        quality_repair[name] += int(value)
                verified.append({"market": market, "exchange": expected_exchange, "symbol": symbol, "source": source, "rows": int(count), "path": str(destination), "verified": True})
            elif destination.exists():
                archived = root / "quarantine" / f"duplicate={stamp}" / path.relative_to(root)
                archived.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(archived))
            else:
                shutil.move(str(path), str(destination))
                if payload.get("repair_quality", payload.get("repairQuality", True)) is not False:
                    repaired = _repair_ohlcv_partition(
                        destination,
                        audit_connection,
                        root / "quarantine" / f"quality={stamp}",
                    )
                    for name, value in repaired.items():
                        quality_repair[name] += int(value)
                migrated.append({"market": market, "exchange": expected_exchange, "symbol": symbol, "source": source, "rows": int(count), "path": str(destination), "verified": True})
        except Exception as exc:  # noqa: BLE001 - one corrupt partition must not stop the audit.
            failed.append({"path": str(path), "error": str(exc)})

    if payload.get("recover_quarantine", payload.get("recoverQuarantine", True)) is not False:
        recoverable_files = list((root / "quarantine").glob("audit=*/ohlcv/market=*/exchange=*/interval=*/symbol=*/data.parquet"))
        for path in recoverable_files:
            try:
                grouped, sources = _inspect_audit_partition(path, audit_connection)
                if len(grouped) != 1:
                    continue
                market, exchange, raw_symbol, count = grouped[0]
                market = _market(market)
                symbol = _symbol(raw_symbol, market)
                expected_exchange = _exchange(market, symbol, exchange)
                allowed = allowed_by_market.get(market)
                trusted = all(_source_market_consistent(item, market) for item in sources) and (not allowed or symbol in allowed or symbol.startswith("^"))
                destination = _partition(root, market, expected_exchange, path.parent.parent.name.split("=", 1)[-1], symbol)
                if not trusted or destination.exists():
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(destination))
                recovered.append({
                    "market": market,
                    "exchange": expected_exchange,
                    "symbol": symbol,
                    "source": "+".join(sources),
                    "rows": int(count),
                    "path": str(destination),
                    "verified": True,
                })
            except Exception as exc:  # noqa: BLE001 - leave unverifiable quarantine content untouched.
                failed.append({"path": str(path), "error": f"quarantine recovery: {exc}"})
    audit_connection.close()
    _write_catalog(root)
    return {
        "available": True,
        "auditedAt": datetime.now(timezone.utc).isoformat(),
        "migrated": len(migrated),
        "verified": len(verified),
        "recovered": len(recovered),
        "quarantined": len(quarantined),
        "invalidRowsQuarantined": quality_repair["invalid"],
        "duplicateRowsRemoved": quality_repair["duplicates"],
        "intervalKeysMigrated": quality_repair["keysMigrated"],
        "failed": len(failed),
        "migratedItems": migrated,
        "verifiedItems": verified,
        "recoveredItems": recovered,
        "quarantinedItems": quarantined,
        "failures": failed,
    }


def upsert_pit_records(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    dataset = str(payload.get("dataset") or "").lower()
    if dataset not in PIT_DATASETS:
        raise ValueError(f"Unsupported PIT dataset: {dataset}")
    market = _market(payload.get("market"))
    default_symbol = "000000" if market == "CN" else "MARKET"
    symbol = _symbol(payload.get("symbol") or default_symbol, market)
    exchange = _exchange(market, symbol, payload.get("exchange"))
    source = str(payload.get("source") or "unknown")[:120]
    saved_at = datetime.now(timezone.utc).isoformat()
    rows: list[dict[str, str]] = []
    for raw in payload.get("records") or []:
        if not isinstance(raw, dict):
            continue
        available_at = str(raw.get("available_at") or raw.get("availableAt") or "")[:40]
        event_time = str(raw.get("event_time") or raw.get("eventTime") or raw.get("publishedAt") or raw.get("date") or "")[:40]
        if not available_at or not event_time:
            continue
        revision = str(raw.get("revision") or raw.get("version") or "initial")[:40]
        first_seen_at = str(raw.get("first_seen_at") or raw.get("firstSeenAt") or available_at)[:40]
        verified = bool(raw.get("historicalAvailabilityVerified") is True) and not bool(raw.get("historicalAvailabilityUnverified"))
        normalized_raw = {
            **raw,
            "event_time": event_time,
            "available_at": available_at,
            "first_seen_at": first_seen_at,
            "revision": revision,
            "historicalAvailabilityVerified": verified,
            "historicalAvailabilityVerificationMethod": str(
                raw.get("historicalAvailabilityVerificationMethod")
                or raw.get("verificationMethod")
                or ("source-published-timestamp" if verified else "unverified")
            )[:120],
        }
        identity = str(raw.get("id") or raw.get("url") or _stable_hash(raw, 32))[:240]
        record_key = f"{dataset}:{market}:{exchange}:{symbol}:{identity}:{available_at}:{revision}"
        rows.append({
            "record_key": record_key,
            "dataset": dataset,
            "market": market,
            "exchange": exchange,
            "symbol": symbol,
            "event_time": event_time,
            "available_at": available_at,
            "revision": revision,
            "source": source,
            "payload_json": json.dumps(normalized_raw, ensure_ascii=False, separators=(",", ":"), default=str),
            "saved_at": saved_at,
        })
    root = _root(payload)
    target = root / dataset / f"market={market}" / f"exchange={exchange}" / f"symbol={symbol}" / "data.parquet"
    target.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect()
    incoming_path: Path | None = None
    temporary = target.with_suffix(f".{os.getpid()}.tmp.parquet")
    try:
        connection.execute("CREATE TABLE pit_rows(record_key VARCHAR PRIMARY KEY, dataset VARCHAR, market VARCHAR, exchange VARCHAR, symbol VARCHAR, event_time VARCHAR, available_at VARCHAR, revision VARCHAR, source VARCHAR, payload_json VARCHAR, saved_at VARCHAR)")
        if target.exists():
            escaped_target = str(target).replace("'", "''")
            connection.execute(f"INSERT OR REPLACE INTO pit_rows SELECT * FROM read_parquet('{escaped_target}')")
        if rows:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                suffix=".ndjson",
                prefix="pit-incoming-",
                dir=target.parent,
                delete=False,
            ) as stream:
                incoming_path = Path(stream.name)
                for row in rows:
                    stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
                    stream.write("\n")
            escaped_incoming = str(incoming_path).replace("'", "''")
            connection.execute(f"""
                CREATE TEMP TABLE incoming AS
                SELECT * FROM read_json_auto(
                    '{escaped_incoming}',
                    format='newline_delimited',
                    columns={{
                        record_key: 'VARCHAR', dataset: 'VARCHAR', market: 'VARCHAR',
                        exchange: 'VARCHAR', symbol: 'VARCHAR', event_time: 'VARCHAR',
                        available_at: 'VARCHAR', revision: 'VARCHAR', source: 'VARCHAR',
                        payload_json: 'VARCHAR', saved_at: 'VARCHAR'
                    }}
                )
            """)
            connection.execute("INSERT OR REPLACE INTO pit_rows SELECT * FROM incoming")
        escaped_temporary = str(temporary).replace("'", "''")
        connection.execute(f"COPY (SELECT * FROM pit_rows ORDER BY available_at, event_time) TO '{escaped_temporary}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        count = int(connection.execute("SELECT count(*) FROM pit_rows").fetchone()[0])
    finally:
        connection.close()
        if incoming_path:
            incoming_path.unlink(missing_ok=True)
    temporary.replace(target)
    return {"available": True, "dataset": dataset, "market": market, "exchange": exchange, "symbol": symbol, "inserted": len(rows), "rows": count, "parquet": str(target)}


def upsert_pit_batches(payload: dict[str, Any]) -> dict[str, Any]:
    grouped: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
    for batch in payload.get("batches") or []:
        if not isinstance(batch, dict):
            continue
        merged = {**payload, **batch, "batches": None}
        dataset = str(merged.get("dataset") or "").lower()
        market = _market(merged.get("market"))
        default_symbol = "000000" if market == "CN" else "MARKET"
        symbol = _symbol(merged.get("symbol") or default_symbol, market)
        exchange = _exchange(market, symbol, merged.get("exchange"))
        source = str(merged.get("source") or "unknown")[:120]
        key = (dataset, market, exchange, symbol, source)
        if key not in grouped:
            grouped[key] = {**merged, "records": []}
        grouped[key]["records"].extend(merged.get("records") or [])
    results = [upsert_pit_records(batch) for batch in grouped.values()]
    return {
        "available": True,
        "batches": len(results),
        "inserted": sum(int(row.get("inserted") or 0) for row in results),
        "results": results,
    }


ASX_FINANCIAL_DISCLOSURE_PATTERN = re.compile(
    r"\b(annual report|annual financial report|half[- ]year(?:ly)? report|half[- ]year results|"
    r"preliminary final report|appendix 4[de]|quarterly (?:activities|cash flow|report)|"
    r"financial statements?|financial results?|full year results?|earnings release)\b",
    re.IGNORECASE,
)


def migrate_asx_financial_disclosures(payload: dict[str, Any]) -> dict[str, Any]:
    """Classify dated ASX exchange filings without pretending they contain numeric statements."""
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    root = _root(payload)
    source_root = root / "news" / "market=ASX"
    limit = max(1, min(100_000, int(payload.get("limit") or 5_000)))
    batches: list[dict[str, Any]] = []
    scanned = 0
    matched = 0
    symbols: set[str] = set()
    connection = duckdb.connect()
    try:
        for path in sorted(source_root.glob("exchange=*/symbol=*/data.parquet")):
            if matched >= limit:
                break
            escaped_path = str(path).replace("'", "''")
            rows = connection.execute(
                f"SELECT symbol, source, payload_json FROM read_parquet('{escaped_path}') ORDER BY available_at"
            ).fetchall()
            records: list[dict[str, Any]] = []
            source = "asx-official-financial-disclosures"
            symbol = ""
            for raw_symbol, raw_source, payload_json in rows:
                scanned += 1
                try:
                    record = json.loads(payload_json or "{}")
                except json.JSONDecodeError:
                    continue
                title = str(record.get("title") or record.get("headline") or "").strip()
                source_text = str(raw_source or record.get("source") or "").lower()
                if (
                    record.get("historicalAvailabilityVerified") is not True
                    or record.get("historicalAvailabilityUnverified") is True
                    or "asx" not in source_text
                    or not ASX_FINANCIAL_DISCLOSURE_PATTERN.search(title)
                ):
                    continue
                symbol = _symbol(raw_symbol, "ASX")
                values = record.get("values") if isinstance(record.get("values"), dict) else {}
                records.append({
                    **record,
                    "id": str(record.get("id") or record.get("link") or _stable_hash(record, 32)),
                    "disclosureType": "exchange-filed-financial-report",
                    "historicalAvailabilityVerified": True,
                    "historicalAvailabilityVerificationMethod": "asx-official-announcement-published-time",
                    "values": {
                        **values,
                        "earningsEvent": 1.0,
                        "sourceQuality": 1.0,
                        "eventRelevance": max(0.9, _normalized_score(values.get("eventRelevance"), 0.0)),
                    },
                })
                matched += 1
                symbols.add(symbol)
                if matched >= limit:
                    break
            if records and symbol:
                batches.append({
                    "dataset": "financial_disclosures",
                    "market": "ASX",
                    "symbol": symbol,
                    "source": source,
                    "records": records,
                })
    finally:
        connection.close()
    saved = upsert_pit_batches({"root": str(root), "batches": batches}) if batches else {
        "batches": 0, "inserted": 0,
    }
    return {
        "available": bool(batches),
        "market": "ASX",
        "scanned": scanned,
        "matched": matched,
        "symbols": len(symbols),
        "batches": int(saved.get("batches") or 0),
        "inserted": int(saved.get("inserted") or 0),
        "note": "Official dated disclosures are event evidence, not a substitute for structured numeric statements.",
    }


def _sentiment_value(raw: Any) -> float:
    if isinstance(raw, (int, float)):
        return max(-1.0, min(1.0, float(raw) / (100.0 if abs(float(raw)) > 1.0 else 1.0)))
    text = str(raw or "").strip().lower()
    if text in {"positive", "bullish", "利好", "看多"}:
        return 1.0
    if text in {"negative", "bearish", "利空", "看空"}:
        return -1.0
    return 0.0


def _normalized_score(raw: Any, fallback: float = 0.0) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return fallback
    if abs(value) > 1.0:
        value /= 100.0
    return max(-1.0, min(1.0, value))


def _contains_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


MACRO_FEATURE_NAMES = (
    "macroRatesImpulse",
    "macroInflationImpulse",
    "macroLaborImpulse",
    "macroGrowthImpulse",
    "macroVolatilityImpulse",
    "macroCreditImpulse",
    "macroYieldCurveImpulse",
    "macroFxImpulse",
    "macroCommodityImpulse",
    "macroDataCoverage",
)


def _pit_feature_values(dataset: str, raw: dict[str, Any], source: Any = None) -> dict[str, Any]:
    values = raw.get("values") if isinstance(raw.get("values"), dict) else raw
    title = str(raw.get("title") or raw.get("headline") or raw.get("summary") or "").lower()
    source_text = str(source or raw.get("source") or raw.get("provider") or "").lower()
    official_exchange = dataset in {"news", "financial_disclosures"} and _contains_any(source_text, ("asx", "exchange-announcement"))
    macro_terms = (
        "rate hike", "inflation", "war", "tariff", "sanction", "central bank",
        "geopolitical", "recession", "利率", "通胀", "战争", "制裁", "衰退",
    )
    positive_terms = (
        "guidance raised", "guidance upgrade", "upgraded", "record revenue", "record profit",
        "profit rises", "earnings beat", "strong growth", "contract awarded", "contract win",
        "approved", "approval granted", "grant awarded", "buy-back", "buyback", "dividend increase",
        "high-grade", "commences production", "production commenced", "successful", "milestone achieved",
        "上调指引", "业绩增长", "中标", "获批", "回购", "增派股息",
    )
    negative_terms = (
        "guidance lowered", "guidance downgrade", "downgraded", "profit warning", "earnings miss",
        "impairment", "default", "insolvency", "administration", "delay", "cancelled", "canceled",
        "investigation", "litigation", "class action", "trading suspension", "trading halt",
        "production halt", "weak trading", "revenue decline", "loss widens", "breach",
        "下调指引", "业绩预警", "亏损扩大", "调查", "诉讼", "停牌", "违约",
    )
    dilution_terms = (
        "placement", "entitlement offer", "rights issue", "capital raising", "capital raise",
        "issue of shares", "application for quotation of securities", "unquoted securities",
        "convertible note", "share purchase plan", "securities issued", "配股", "增发", "可转债",
    )
    regulatory_terms = (
        "regulatory", "asic", "accc", "court", "legal proceedings", "investigation", "litigation",
        "class action", "compliance breach", "show cause", "penalty", "fine", "监管", "调查", "诉讼", "处罚",
    )
    earnings_terms = (
        "earnings", "results", "statutory accounts", "annual report", "half year report",
        "quarterly activities", "cash flow report", "trading update", "guidance", "revenue", "profit",
        "业绩", "财报", "年报", "季报", "营收", "利润", "指引",
    )
    capital_allocation_positive_terms = (
        "buy-back", "buyback", "dividend", "distribution", "special dividend", "capital return", "回购", "股息", "分红",
    )
    capital_allocation_negative_terms = dilution_terms
    operational_terms = (
        "contract", "order", "project", "production", "drilling", "resource", "reserve", "study",
        "approval", "licence", "license", "customer", "patent", "trial", "development", "acquisition",
        "divestment", "disposal", "合作", "项目", "订单", "产量", "资源量", "获批", "收购", "出售",
    )
    administrative_terms = (
        "director's interest", "directors interest", "substantial holding", "substantial holder",
        "unquoted securities", "application for quotation", "cessation of securities", "securities on issue",
        "notice of meeting", "proxy form", "change of address", "notification regarding", "appendix 3",
        "董事权益", "股东大会通知",
    )
    positive = _contains_any(title, positive_terms)
    negative = _contains_any(title, negative_terms)
    dilution = _contains_any(title, dilution_terms)
    regulatory = _contains_any(title, regulatory_terms)
    earnings = _contains_any(title, earnings_terms)
    capital_positive = _contains_any(title, capital_allocation_positive_terms)
    capital_negative = _contains_any(title, capital_allocation_negative_terms)
    operational = _contains_any(title, operational_terms)
    administrative = _contains_any(title, administrative_terms)
    if dataset in {"fundamentals", "financial_disclosures"}:
        margin = _normalized_score(values.get("profitMargin"), 0.0)
        growth = _normalized_score(values.get("earningsGrowth", values.get("revenueGrowth")), 0.0)
        quality = max(-1.0, min(1.0, margin * 0.55 + growth * 0.45))
    else:
        quality = 0.0
    source_default = 1.0 if official_exchange or dataset in {"fundamentals", "financial_disclosures", "macro"} else 0.55 if dataset == "news" else 0.45
    truth = _normalized_score(raw.get("truthScore", raw.get("sourceQuality", raw.get("credibility"))), source_default)
    relevance_default = 1.0 if official_exchange else 0.35 if dataset == "news" else 0.75
    if administrative:
        relevance_default = min(relevance_default, 0.30)
    relevance = _normalized_score(raw.get("relevance", raw.get("relevanceScore")), relevance_default)
    novelty_default = 0.80 if official_exchange and not administrative else 0.15 if administrative else 0.35
    novelty = _normalized_score(raw.get("novelty", raw.get("noveltyScore")), novelty_default)
    announcement = 1.0 if (official_exchange and not administrative) or earnings or operational else 0.15 if administrative else 0.0
    macro_risk = -1.0 if any(term in title for term in macro_terms) else 0.0
    inferred_sentiment = 1.0 if positive and not negative else -1.0 if negative and not positive else 0.0
    explicit_sentiment = _sentiment_value(raw.get("sentiment", raw.get("sentimentScore")))
    event_sentiment = explicit_sentiment if abs(explicit_sentiment) > 1e-12 else inferred_sentiment
    event_intensity = 0.0
    if dataset == "macro":
        event_intensity = 0.35
    elif official_exchange:
        event_intensity = 0.20 if administrative else min(1.0, 0.45 + 0.15 * sum((earnings, operational, dilution, regulatory)))
    elif title:
        event_intensity = 0.30 + 0.15 * sum((earnings, operational, dilution, regulatory))
    output = {
        "__eventId": str(raw.get("id") or raw.get("link") or raw.get("url") or ""),
        "eventSentiment": event_sentiment,
        "eventRelevance": relevance,
        "eventNovelty": novelty,
        "announcementScore": announcement,
        "fundamentalQuality": quality,
        "macroRisk": macro_risk,
        "sourceQuality": truth,
        "freshnessScore": 1.0,
        "positiveCatalyst": 1.0 if positive else 0.0,
        "negativeCatalyst": 1.0 if negative else 0.0,
        "dilutionRisk": 1.0 if dilution else 0.0,
        "regulatoryRisk": 1.0 if regulatory else 0.0,
        "earningsEvent": 1.0 if earnings else 0.0,
        "capitalAllocation": 1.0 if capital_positive and not capital_negative else -1.0 if capital_negative and not capital_positive else 0.0,
        "operationalMomentum": inferred_sentiment if operational else 0.0,
        "eventIntensity": event_intensity,
    }
    if dataset == "macro":
        output["__seriesId"] = str(raw.get("seriesId") or values.get("seriesId") or "UNKNOWN")
        for name in MACRO_FEATURE_NAMES:
            output[name] = _normalized_score(values.get(name), 0.0)
    for name in output:
        if name in values and not name.startswith("__"):
            output[name] = _normalized_score(values.get(name), output[name])
    return output


def read_pit_panel(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import duckdb  # type: ignore
    except ImportError as exc:
        raise RuntimeError("duckdb is required for the Parquet data lake") from exc
    root = _root(payload)
    market = _market(payload.get("market"))
    symbols = {_symbol(symbol, market) for symbol in payload.get("symbols") or [] if str(symbol or "").strip()}
    datasets = [str(value).lower() for value in payload.get("datasets") or ("financial_disclosures", "news", "social", "fundamentals", "macro", "corporate_actions", "universe") if str(value).lower() in PIT_DATASETS]
    limit_per_symbol = max(1, min(2_000, int(payload.get("limit_per_symbol", payload.get("limitPerSymbol", 400)) or 400)))
    broadcast_market_wide = payload.get("broadcast_market_wide", payload.get("broadcastMarketWide", True)) is not False
    verified_only = payload.get("verified_only", payload.get("verifiedOnly", False)) is True
    items: dict[str, dict[str, list[dict[str, Any]]]] = {
        symbol: {"features": [], "universe": [], "actions": []} for symbol in symbols
    }
    market_features: list[dict[str, Any]] = []
    source_counts: dict[str, int] = {}
    connection = duckdb.connect()
    try:
        for dataset in datasets:
            files = list((root / dataset / f"market={market}").glob("exchange=*/symbol=*/data.parquet"))
            for path in files:
                partition_symbol = path.parent.name.split("=", 1)[-1]
                market_wide_partition = dataset in {"macro", "universe"} and partition_symbol in {"MARKET", "000000"}
                if symbols and partition_symbol not in symbols and not market_wide_partition:
                    continue
                query_limit = limit_per_symbol * max(1, len(symbols)) if market_wide_partition else limit_per_symbol
                escaped_path = str(path).replace("'", "''")
                verified_filter = """
                    WHERE json_extract_string(payload_json, '$.historicalAvailabilityVerified') = 'true'
                      AND coalesce(json_extract_string(payload_json, '$.historicalAvailabilityUnverified'), 'false') != 'true'
                """ if verified_only else ""
                query = f"SELECT symbol,event_time,available_at,revision,source,payload_json FROM read_parquet('{escaped_path}') {verified_filter} ORDER BY available_at DESC LIMIT {query_limit}"
                for symbol, event_time, available_at, revision, source, payload_json in connection.execute(query).fetchall():
                    try:
                        raw = json.loads(payload_json or "{}")
                    except json.JSONDecodeError:
                        continue
                    target_symbols = [symbol]
                    if dataset == "macro" and market_wide_partition:
                        target_symbols = sorted(symbols) if symbols else [symbol]
                    elif dataset == "universe":
                        try:
                            target_symbols = [_symbol(raw.get("symbol") or raw.get("code"), market)]
                        except ValueError:
                            continue
                    common = {
                        "id": str(raw.get("id") or raw.get("link") or raw.get("url") or ""),
                        "dataset": dataset,
                        "event_time": event_time,
                        "available_at": available_at,
                        "revision": revision,
                        "source": source,
                        "historicalAvailabilityVerified": bool(raw.get("historicalAvailabilityVerified") is True)
                            and not bool(raw.get("historicalAvailabilityUnverified")),
                    }
                    if dataset == "macro" and market_wide_partition and not broadcast_market_wide:
                        market_features.append({**common, "values": _pit_feature_values(dataset, raw, source)})
                        source_counts[dataset] = source_counts.get(dataset, 0) + 1
                        continue
                    for target_symbol in target_symbols:
                        if symbols and target_symbol not in symbols:
                            continue
                        bucket = items.setdefault(target_symbol, {"features": [], "universe": [], "actions": []})
                        if dataset in {"news", "social", "fundamentals", "financial_disclosures", "macro"}:
                            bucket["features"].append({**common, "values": _pit_feature_values(dataset, raw, source)})
                        elif dataset == "universe":
                            event_type = raw.get("eventType") or raw.get("type")
                            bucket["universe"].append({
                                **common,
                                "listed": None if str(event_type or "").lower() == "coverage" else raw.get("listed", raw.get("status", "active") not in {"delisted", "inactive"}),
                                "exchange": raw.get("exchange"),
                                "eventType": event_type,
                                "coverageKind": raw.get("coverageKind"),
                                "coverageStart": raw.get("coverageStart"),
                                "coverageEnd": raw.get("coverageEnd"),
                            })
                        elif dataset == "corporate_actions":
                            bucket["actions"].append({
                                **common,
                                "eventType": raw.get("eventType") or raw.get("type"),
                                "amount": raw.get("amount"),
                                "numerator": raw.get("numerator"),
                                "denominator": raw.get("denominator"),
                                "coverageStart": raw.get("coverageStart"),
                                "coverageEnd": raw.get("coverageEnd"),
                            })
                        source_counts[dataset] = source_counts.get(dataset, 0) + 1
    finally:
        connection.close()
    market_feature_limit = max(limit_per_symbol, min(100_000, limit_per_symbol * max(1, len(symbols))))
    return {
        "available": True,
        "market": market,
        "verifiedOnly": verified_only,
        "items": [
            {
                "symbol": symbol,
                "pointInTimeFeatures": sorted(rows["features"], key=lambda row: str(row.get("available_at") or ""))[-limit_per_symbol:],
                "universeHistory": sorted(rows["universe"], key=lambda row: str(row.get("available_at") or ""))[-limit_per_symbol:],
                "corporateActions": sorted(rows["actions"], key=lambda row: str(row.get("available_at") or ""))[-limit_per_symbol:],
                "coverage": {
                    "features": len(rows["features"]),
                    "universe": len(rows["universe"]),
                    "corporateActions": len(rows["actions"]),
                    "verifiedUniverse": sum(1 for row in rows["universe"] if row.get("historicalAvailabilityVerified")),
                    "verifiedCorporateActions": sum(1 for row in rows["actions"] if row.get("historicalAvailabilityVerified")),
                },
            }
            for symbol, rows in sorted(items.items())
        ],
        "marketPointInTimeFeatures": sorted(
            market_features,
            key=lambda row: str(row.get("available_at") or ""),
        )[-market_feature_limit:],
        "sourceCounts": source_counts,
        "rows": len(market_features) + sum(sum(len(values) for values in rows.values()) for rows in items.values()),
        "dataVersion": _stable_hash({
            "schema": PIT_SCHEMA_VERSION,
            "market": market,
            "sources": source_counts,
            "marketFeatures": [
                (row.get("event_time"), row.get("available_at"), row.get("revision"), row.get("source"), row.get("historicalAvailabilityVerified"), row.get("values"))
                for row in market_features
            ],
            "items": {
                symbol: {
                    name: [(row.get("event_time"), row.get("available_at"), row.get("revision"), row.get("source"), row.get("historicalAvailabilityVerified"), row.get("values"), row.get("listed"), row.get("eventType")) for row in values]
                    for name, values in rows.items()
                }
                for symbol, rows in items.items()
            },
        }, 24),
    }


def backfill_local_pit_caches(payload: dict[str, Any]) -> dict[str, Any]:
    project_root = Path(str(payload.get("project_root") or payload.get("projectRoot") or Path(__file__).resolve().parents[1])).expanduser().resolve()
    limit = max(1, min(5_000, int(payload.get("limit") or 1_500)))
    state_path = _root(payload) / "pit-cache-backfill-state.json"
    try:
        state = json.loads(state_path.read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        state = {"schema": 1, "files": {}}
    state_files = state.get("files") if isinstance(state.get("files"), dict) else {}
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    quarantined: list[dict[str, Any]] = []

    unchanged = 0

    def ingest_file(path: Path, dataset: str) -> bool:
        nonlocal unchanged
        identity = str(path.resolve())
        fingerprint = f"{path.stat().st_mtime_ns}:{path.stat().st_size}"
        if state_files.get(identity) == fingerprint:
            unchanged += 1
            return False
        try:
            document = json.loads(path.read_text("utf-8"))
            market = _market(document.get("market") or path.parent.name)
            symbol = document.get("symbol") or ("000000" if market == "CN" else "MARKET")
            cached_at = str(
                document.get("cachedAt")
                or (document.get("cache") or {}).get("cachedAt")
                or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            )
            if dataset == "news":
                value = document.get("value") or document
                source = value.get("source") or "local-news-cache"
                items = value.get("news") or []
                records = [{
                    **item,
                    "id": item.get("id") or item.get("link") or _stable_hash(item, 32),
                    "event_time": item.get("publishedAt") or item.get("date") or cached_at,
                    "available_at": item.get("publishedAt") or item.get("date") or cached_at,
                    "historicalAvailabilityVerified": bool(item.get("publishedAt") or item.get("date")),
                } for item in items if isinstance(item, dict)]
            else:
                source = document.get("source") or "local-reddit-cache"
                items = document.get("items") or document.get("topItems") or []
                records = [{
                    **item,
                    "id": item.get("id") or item.get("permalink") or _stable_hash(item, 32),
                    "event_time": item.get("publishedAt") or item.get("createdAt") or item.get("created_at") or cached_at,
                    "available_at": item.get("publishedAt") or item.get("createdAt") or item.get("created_at") or cached_at,
                    "historicalAvailabilityVerified": bool(item.get("publishedAt") or item.get("createdAt") or item.get("created_at")),
                } for item in items if isinstance(item, dict)]
            if not records:
                state_files[identity] = fingerprint
                return False
            result = upsert_pit_records({
                "root": payload.get("root"),
                "dataset": dataset,
                "market": market,
                "symbol": symbol,
                "source": source,
                "records": records,
            })
            results.append({"dataset": dataset, "market": market, "symbol": result["symbol"], "inserted": result["inserted"], "rows": result["rows"]})
            state_files[identity] = fingerprint
            return True
        except Exception as exc:  # noqa: BLE001 - one damaged cache cannot block the migration.
            row = {"path": str(path), "dataset": dataset, "error": str(exc)}
            if "Cross-market" in str(exc):
                quarantined.append(row)
            else:
                failures.append(row)
            return False

    sources = (
        (project_root / ".cache" / "news", "news"),
        (project_root / ".cache" / "social" / "reddit", "social"),
    )
    processed = 0
    for directory, dataset in sources:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*/*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            if processed >= limit:
                break
            ingest_file(path, dataset)
            processed += 1
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_state = state_path.with_suffix(f".{os.getpid()}.tmp")
    temporary_state.write_text(json.dumps({
        "schema": 1,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "files": state_files,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")), "utf-8")
    temporary_state.replace(state_path)
    return {
        "available": True,
        "processedFiles": processed,
        "persistedPartitions": len(results),
        "insertedRows": sum(int(row.get("inserted") or 0) for row in results),
        "skippedUnchanged": unchanged,
        "quarantined": len(quarantined),
        "quarantinedItems": quarantined[:80],
        "failed": len(failures),
        "failures": failures[:40],
        "summary": summary({"root": payload.get("root")}),
    }
