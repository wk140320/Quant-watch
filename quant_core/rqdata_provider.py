from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from data_lake import upsert as upsert_data_lake


DEFAULT_EXPIRES_AT = "2026-09-13T23:59:59+08:00"


def _project_root(payload: dict[str, Any]) -> Path:
    configured = payload.get("project_root") or payload.get("projectRoot")
    return Path(str(configured)).expanduser().resolve() if configured else Path(__file__).resolve().parents[1]


def _load_local_env(root: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for filename in (".env.local", ".env"):
        path = root / filename
        if not path.exists():
            continue
        try:
            for raw in path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"'")
                if key and key not in values:
                    values[key] = value
        except OSError:
            continue
    return values


def _settings(payload: dict[str, Any]) -> dict[str, Any]:
    root = _project_root(payload)
    file_env = _load_local_env(root)
    env = {**file_env, **os.environ}
    expires_at = str(env.get("RQDATA_EXPIRES_AT") or DEFAULT_EXPIRES_AT).strip()
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
    except ValueError:
        expiry = datetime.fromisoformat(DEFAULT_EXPIRES_AT)
    now = datetime.now(timezone.utc)
    enabled = str(env.get("RQDATA_ENABLED", "false")).lower() not in {"0", "false", "no", "off"}
    license_key = str(env.get("RQSDK_LICENSE") or env.get("RQDATA_LICENSE_KEY") or "").strip()
    helper_python = str(env.get("RQDATA_PYTHON_BIN") or "").strip()
    if helper_python:
        helper_path = Path(helper_python).expanduser()
        if not helper_path.is_absolute():
            helper_path = (root / helper_path).resolve()
        helper_python = str(helper_path) if helper_path.exists() else ""
    return {
        "root": root,
        "enabled": enabled,
        "configured": bool(license_key),
        "license_key": license_key,
        "expires_at": expiry.isoformat(),
        "expired": now >= expiry,
        "remaining_days": max(0, (expiry - now).total_seconds() / 86400),
        "python_package": importlib.util.find_spec("rqdatac") is not None,
        "python_runtime": sys.executable,
        "helper_python": helper_python,
    }


def _disabled(settings: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "enabled": settings["enabled"],
        "configured": settings["configured"],
        "expired": settings["expired"],
        "expiresAt": settings["expires_at"],
        "remainingDays": round(settings["remaining_days"], 3),
        "source": "rqdata",
        "runtime": settings.get("python_runtime"),
        "helperPython": settings.get("helper_python") or None,
        "pythonPackage": bool(settings.get("python_package")),
        "reason": reason,
    }


def _run_dedicated_runtime(settings: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
    """Use the licensed RQData environment without loading it into the ML worker.

    The production worker intentionally uses a small native environment because
    importing the legacy RQSDK/torch/OpenMP stack into that process can crash it.
    RQData is therefore an isolated, JSON-only helper call.  No credentials are
    placed in the payload or returned to Node.
    """
    helper = settings.get("helper_python")
    if not helper or settings.get("python_package"):
        return None
    timeout = max(10, min(180, int(os.environ.get("RQDATA_HELPER_TIMEOUT_SEC", "90"))))
    request = dict(payload)
    request["operation"] = str(payload.get("operation") or "status")
    request["project_root"] = str(settings["root"])
    env = {**os.environ, "RQDATA_HELPER_PROCESS": "1"}
    try:
        completed = subprocess.run(
            [helper, "-m", "quant_core.rqdata_helper"],
            cwd=str(settings["root"]),
            input=json.dumps(request),
            text=True,
            capture_output=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {**_disabled(settings, "RQData dedicated runtime failed to start or timed out"), "error": str(exc)}
    try:
        response = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return {**_disabled(settings, "RQData dedicated runtime returned invalid JSON"), "error": completed.stderr[-1000:]}
    if completed.returncode != 0 or response.get("ok") is not True:
        return {
            **_disabled(settings, "RQData dedicated runtime returned an error"),
            "error": response.get("error") or completed.stderr[-1000:] or f"exit {completed.returncode}",
        }
    result = response.get("result")
    return result if isinstance(result, dict) else {**_disabled(settings, "RQData dedicated runtime returned no result")}


def _init(settings: dict[str, Any]):
    if not settings["python_package"]:
        raise RuntimeError("rqdatac is not installed")
    if not settings["enabled"]:
        return None, _disabled(settings, "RQData is disabled by configuration")
    if not settings["configured"]:
        return None, _disabled(settings, "RQSDK license is not configured")
    if settings["expired"]:
        return None, _disabled(settings, "RQSDK license has expired; no request was sent")
    import rqdatac  # type: ignore
    from rqsdk.license_helper import format_rqdatac_uri  # type: ignore

    uri = format_rqdatac_uri(settings["license_key"])
    rqdatac.init(uri=uri, timeout=60, connect_timeout=10, lazy=False)
    return rqdatac, None


def _code(value: Any) -> str:
    raw = "".join(char for char in str(value or "") if char.isdigit())[-6:]
    if len(raw) != 6:
        raise ValueError(f"Invalid A-share code: {value}")
    return raw


def _order_book_id(code: str) -> str:
    return f"{code}.XSHG" if code.startswith(("5", "6", "9")) else f"{code}.XSHE"


def _date_text(value: Any) -> str:
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        return value.date().isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return str(value)[:10]


def _rows_from_frame(frame: Any, code: str, interval: str, adjustment: str) -> list[dict[str, Any]]:
    if frame is None or getattr(frame, "empty", True):
        return []
    rows: list[dict[str, Any]] = []
    data = frame.reset_index()
    columns = {str(column).lower(): column for column in data.columns}
    date_column = next((columns[name] for name in ("date", "datetime", "index") if name in columns), data.columns[0])
    def value(row: Any, *names: str) -> Any:
        for name in names:
            if name in columns:
                return row[columns[name]]
        return None
    for _, row in data.iterrows():
        timestamp = _date_text(row[date_column])
        if len(timestamp) < 10:
            continue
        close = value(row, "close")
        if close is None:
            continue
        rows.append({
            "date": timestamp,
            "open": value(row, "open"),
            "high": value(row, "high"),
            "low": value(row, "low"),
            "close": close,
            "volume": value(row, "volume"),
            "amount": value(row, "total_turnover", "turnover"),
            "prev_close": value(row, "prev_close"),
            "adjustment": adjustment,
        })
    return rows


def _rows_by_symbol(frame: Any, fallback_code: str, interval: str, adjustment: str) -> dict[str, list[dict[str, Any]]]:
    if frame is None or getattr(frame, "empty", True):
        return {}
    data = frame.reset_index()
    columns = {str(column).lower(): column for column in data.columns}
    code_column = columns.get("order_book_id") or columns.get("symbol")
    if code_column is None:
        return {fallback_code: _rows_from_frame(frame, fallback_code, interval, adjustment)}
    output: dict[str, list[dict[str, Any]]] = {}
    for raw_code, group in data.groupby(code_column):
        code = _code(str(raw_code))
        output[code] = _rows_from_frame(group.set_index(columns.get("date") or columns.get("datetime") or data.columns[0]), code, interval, adjustment)
    return output


def _sync_legacy_market_history_cache(
    settings: dict[str, Any],
    code: str,
    interval: str,
    candles: list[dict[str, Any]],
    *,
    source: str,
) -> bool:
    """Mirror durable RQData rows into the fast per-symbol history index.

    The Node backfill/status path still reads this compact index for quick
    history-depth decisions.  Keeping the mirror here makes a successful
    RQData ingest immediately visible to backtests without weakening the
    Parquet data-lake source of truth.
    """
    if not candles or str(interval or "1d").lower() != "1d":
        return False
    try:
        cache_dir = settings["root"] / ".cache" / "market-history" / "cn"
        cache_dir.mkdir(parents=True, exist_ok=True)
        path = cache_dir / f"{code.upper()}-1D.json"
        existing: dict[str, Any] = {}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = loaded
            except (OSError, json.JSONDecodeError):
                existing = {}
        by_date: dict[str, dict[str, Any]] = {}
        for row in existing.get("candles") or []:
            if isinstance(row, dict) and str(row.get("date") or row.get("timestamp") or "")[:10]:
                by_date[str(row.get("date") or row.get("timestamp"))[:10]] = row
        for row in candles:
            if isinstance(row, dict):
                date_text = str(row.get("date") or row.get("timestamp") or "")[:10]
                if len(date_text) == 10:
                    by_date[date_text] = row
        rows = [by_date[key] for key in sorted(by_date)][-6500:]
        payload = {
            "market": "CN",
            "symbol": code.upper(),
            "exchange": "SSE" if code.startswith(("5", "6", "9")) else "SZSE",
            "interval": "1d",
            "source": source,
            "savedAt": datetime.now(timezone.utc).isoformat(),
            "quote": existing.get("quote"),
            "candles": rows,
        }
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8")
        os.replace(temporary, path)
        return True
    except (OSError, TypeError, ValueError):
        return False


def status(payload: dict[str, Any]) -> dict[str, Any]:
    settings = _settings(payload)
    if not settings["python_package"]:
        dedicated = _run_dedicated_runtime(settings, {"operation": "status", "project_root": str(settings["root"])})
        if dedicated is not None:
            return {**dedicated, "runtime": "dedicated-rqdata", "helperPython": settings.get("helper_python")}
        return _disabled(settings, "rqdatac is not installed")
    if not settings["enabled"] or not settings["configured"] or settings["expired"]:
        return _disabled(settings, "RQData is unavailable under the local configuration")
    try:
        rqdatac, disabled = _init(settings)
        if disabled:
            return disabled
        quota = rqdatac.user.get_quota()
        return {
            "available": True,
            "enabled": True,
            "configured": True,
            "expired": False,
            "expiresAt": settings["expires_at"],
            "remainingDays": round(settings["remaining_days"], 3),
            "source": "rqdata",
            "quota": {key: value for key, value in dict(quota or {}).items() if key not in {"license", "password"}},
        }
    except Exception as exc:
        return {**_disabled(settings, "RQData status request failed"), "error": str(exc)}


def fetch_candles(payload: dict[str, Any]) -> dict[str, Any]:
    settings = _settings(payload)
    if not settings["python_package"]:
        dedicated = _run_dedicated_runtime(settings, {**payload, "operation": "candles", "project_root": str(settings["root"])})
        if dedicated is not None:
            return {**dedicated, "runtime": "dedicated-rqdata", "helperPython": settings.get("helper_python")}
    rqdatac, disabled = _init(settings)
    if disabled:
        return disabled
    market = str(payload.get("market") or "CN").upper()
    if market != "CN":
        return _disabled(settings, "RQData integration is restricted to CN to prevent cross-market contamination")
    interval = str(payload.get("interval") or payload.get("frequency") or "1d")
    symbols = list(dict.fromkeys(_code(value) for value in payload.get("symbols") or payload.get("symbol") or []))
    if not symbols:
        return {"available": False, "source": "rqdata", "reason": "No CN symbols were provided"}
    limit = max(1, min(550, int(payload.get("limit") or len(symbols))))
    symbols = symbols[:limit]
    end_date = str(payload.get("end_date") or payload.get("endDate") or date.today().isoformat())[:10]
    start_date = str(payload.get("start_date") or payload.get("startDate") or "2010-01-01")[:10]
    adjustment = str(payload.get("adjust_type") or payload.get("adjustType") or "pre")
    results: list[dict[str, Any]] = []
    inserted = 0
    failed = 0
    batch_size = max(1, min(25, int(payload.get("batch_size") or payload.get("batchSize") or 20)))
    for batch_start in range(0, len(symbols), batch_size):
        batch = symbols[batch_start:batch_start + batch_size]
        try:
            frame = rqdatac.get_price(
                [_order_book_id(code) for code in batch],
                start_date=start_date,
                end_date=end_date,
                frequency=interval,
                fields=["open", "high", "low", "close", "volume", "total_turnover", "prev_close"],
                adjust_type=adjustment,
                skip_suspended=False,
                expect_df=True,
                market="cn",
            )
            rows_by_symbol = _rows_by_symbol(frame, batch[0], interval, f"rqdata-{adjustment}-adjusted")
            for code in batch:
                candles = rows_by_symbol.get(code, [])
                if candles:
                    saved = upsert_data_lake({
                        "root": str(settings["root"] / ".cache" / "data-lake"),
                        "market": "CN",
                        "exchange": "SSE" if code.startswith(("5", "6", "9")) else "SZSE",
                        "symbol": code,
                        "interval": interval,
                        "source": f"rqdata-cn-{interval}",
                        "available_at": datetime.now(timezone.utc).isoformat(),
                        "adjustment": f"rqdata-{adjustment}-adjusted",
                        "candles": candles,
                        "refresh_catalog": False,
                    })
                    inserted += int(saved.get("inserted") or 0)
                    history_cache_synced = _sync_legacy_market_history_cache(
                        settings,
                        code,
                        interval,
                        candles,
                        source=f"rqdata-cn-{interval}",
                    )
                else:
                    history_cache_synced = False
                results.append({
                    "symbol": code,
                    "rows": len(candles),
                    "available": bool(candles),
                    "historyCacheSynced": history_cache_synced,
                })
        except Exception as exc:
            failed += 1
            results.extend({"symbol": code, "rows": 0, "available": False, "error": str(exc)} for code in batch)
    return {
        "available": any(row["available"] for row in results),
        "source": "rqdata",
        "market": "CN",
        "interval": interval,
        "startDate": start_date,
        "endDate": end_date,
        "adjustType": adjustment,
        "checked": len(results),
        "succeeded": sum(1 for row in results if row["available"]),
        "failed": failed,
        "inserted": inserted,
        "expiresAt": settings["expires_at"],
        "results": results,
    }
