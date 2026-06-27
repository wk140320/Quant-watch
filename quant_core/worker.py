from __future__ import annotations

import json
import importlib.util
import socket
import sys
from typing import Any

from alpha_mining import analyze_alpha_evolution
from features import analyze_factors, analyze_features
from historical_backtest import batch_historical_backtest, run_historical_backtest
from local_model import train_local_model_suite
from provider_budget import provider_plan
from risk import assess_portfolio, build_paper_order_intent
from store import append_event, control_plane_summary, list_events, list_market_rows, list_order_intents, market_data_summary, record_market_rows, record_order_intent
from trades import analyze_trades


def ibkr_readiness(payload: dict[str, Any]) -> dict[str, Any]:
    host = str(payload.get("host") or "127.0.0.1").strip()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("IBKR readiness checks are restricted to the local machine.")
    port = int(payload.get("port") or 7497)
    if port < 1 or port > 65535:
        raise ValueError("Invalid IBKR port.")
    connected = False
    error = None
    try:
        with socket.create_connection((host, port), timeout=0.7):
            connected = True
    except OSError as exc:
        error = str(exc)
    return {
        "host": host,
        "port": port,
        "connected": connected,
        "mode": "paper-readiness-only",
        "order_execution_enabled": False,
        "message": "IB Gateway/TWS local port is reachable." if connected else "IB Gateway/TWS local port is not reachable.",
        "error": error,
    }


def qlib_readiness() -> dict[str, Any]:
    qlib_spec = importlib.util.find_spec("qlib")
    lightgbm_spec = importlib.util.find_spec("lightgbm")
    torch_spec = importlib.util.find_spec("torch")
    installed = qlib_spec is not None
    lightgbm_installed = lightgbm_spec is not None
    torch_installed = torch_spec is not None
    lightgbm_ready = installed and lightgbm_installed
    sequence_ready = installed and torch_installed
    return {
        "available": installed,
        "package": "Microsoft Qlib",
        "qlib_installed": installed,
        "lightgbm_installed": lightgbm_installed,
        "torch_installed": torch_installed,
        "models": [
            {
                "id": "lightgbm",
                "label": "LightGBM",
                "ready": lightgbm_ready,
                "status": "ready" if lightgbm_ready else ("missing_qlib" if not installed else "missing_lightgbm"),
                "reason": "ready" if lightgbm_ready else ("缺 Qlib" if not installed else "缺 LightGBM"),
                "use": "tabular factors after six-gate quality audit and walk-forward split",
            },
            {
                "id": "lstm",
                "label": "LSTM",
                "ready": sequence_ready,
                "status": "ready" if sequence_ready else ("missing_qlib" if not installed else "missing_torch"),
                "reason": "ready" if sequence_ready else ("缺 Qlib" if not installed else "缺 PyTorch"),
                "use": "time-series sequence factors; scaler fitted on train window only",
            },
            {
                "id": "transformer",
                "label": "Transformer",
                "ready": sequence_ready,
                "status": "ready" if sequence_ready else ("missing_qlib" if not installed else "missing_torch"),
                "reason": "ready" if sequence_ready else ("缺 Qlib" if not installed else "缺 PyTorch"),
                "use": "multi-factor temporal attention; purged/embargoed labels required",
            },
        ],
        "factor_gate_required": [
            "dimensionless",
            "richness",
            "no_future_leakage",
            "missing_values",
            "outliers",
            "standardization",
        ],
        "message": (
            "Qlib is importable; model adapters can be enabled after data handler configuration."
            if installed
            else "Qlib is not installed in this Python environment; current factor lab continues with the built-in walk-forward engine."
        ),
    }


def baostock_symbol(code: str) -> str:
    clean = str(code or "").strip().upper()
    if clean.startswith("SH") and len(clean) == 8:
        return f"sh.{clean[2:]}"
    if clean.startswith("SZ") and len(clean) == 8:
        return f"sz.{clean[2:]}"
    if not clean.isdigit() or len(clean) != 6:
        raise ValueError(f"Baostock requires a six-digit China A-share code: {clean}")
    return f"{'sh' if clean.startswith(('6', '5', '9')) else 'sz'}.{clean}"


def baostock_frequency(interval: str) -> str:
    return {
        "5m": "5",
        "15m": "15",
        "60m": "60",
        "1d": "d",
        "1wk": "w",
        "1mo": "m",
    }.get(str(interval or "1d"), "d")


def baostock_candles(payload: dict[str, Any]) -> dict[str, Any]:
    spec = importlib.util.find_spec("baostock")
    if spec is None:
        raise ValueError("baostock is not installed in the active Python environment.")
    import baostock as bs  # type: ignore

    code = baostock_symbol(str(payload.get("symbol") or ""))
    interval = str(payload.get("interval") or "1d")
    frequency = baostock_frequency(interval)
    start_date = str(payload.get("start_date") or "")
    end_date = str(payload.get("end_date") or "")
    if not start_date or not end_date:
        raise ValueError("baostock-candles requires start_date and end_date.")
    fields = "date,open,high,low,close,volume,amount,turn,pctChg"
    if frequency in {"5", "15", "30", "60"}:
        fields = "date,time,open,high,low,close,volume,amount,turn,pctChg"
    login = bs.login()
    if getattr(login, "error_code", "0") != "0":
        raise ValueError(getattr(login, "error_msg", "baostock login failed"))
    rows: list[dict[str, Any]] = []
    try:
        rs = bs.query_history_k_data_plus(
            code,
            fields,
            start_date=start_date,
            end_date=end_date,
            frequency=frequency,
            adjustflag="2",
        )
        if getattr(rs, "error_code", "0") != "0":
            raise ValueError(getattr(rs, "error_msg", "baostock query failed"))
        columns = list(getattr(rs, "fields", []) or fields.split(","))
        while rs.next():
            raw = dict(zip(columns, rs.get_row_data()))
            time_value = str(raw.get("time") or "")
            timestamp = str(raw.get("date") or "")
            if time_value and len(time_value) >= 12:
                timestamp = f"{time_value[:4]}-{time_value[4:6]}-{time_value[6:8]}T{time_value[8:10]}:{time_value[10:12]}"
            rows.append({
                "date": timestamp,
                "open": float(raw.get("open") or 0),
                "high": float(raw.get("high") or 0),
                "low": float(raw.get("low") or 0),
                "close": float(raw.get("close") or 0),
                "volume": float(raw.get("volume") or 0),
                "amount": float(raw.get("amount") or 0),
                "turnoverRate": float(raw.get("turn") or 0),
                "pctChg": float(raw.get("pctChg") or 0),
            })
    finally:
        bs.logout()
    return {
        "market": "CN",
        "symbol": code,
        "interval": interval,
        "source": f"baostock-cn-{frequency}",
        "candles": rows,
    }


def dispatch(payload: dict[str, Any]) -> dict[str, Any]:
    operation = str(payload.get("operation") or "health")
    if operation == "health":
        return {
            "ok": True,
            "service": "quant-core-python",
            "capabilities": [
                "feature-analysis",
                "factor-lab",
                "trade-analysis",
                "provider-budget",
                "risk-assessment",
                "paper-order-intent-audit",
                "sqlite-event-store",
                "local-market-data-store",
                "local-market-data-replay",
                "historical-walk-forward-backtest",
                "ibkr-readiness",
                "qlib-readiness",
                "alpha-evolution",
                "local-model-suite",
            ],
            "order_execution_enabled": False,
        }
    if operation == "feature-analysis":
        return analyze_features(
            payload.get("candles") or [],
            market=str(payload.get("market") or "ASX"),
            symbol=str(payload.get("symbol") or ""),
            source=str(payload.get("source") or ""),
            interval=str(payload.get("interval") or "1d"),
        )
    if operation == "factor-lab":
        result = analyze_factors(
            payload.get("candles") or [],
            horizon=int(payload.get("horizon_days") or 15),
            market=str(payload.get("market") or "ASX"),
            symbol=str(payload.get("symbol") or ""),
        )
        try:
            result["alpha_evolution"] = analyze_alpha_evolution(
                payload.get("candles") or [],
                horizon=int(payload.get("horizon_days") or 15),
                market=str(payload.get("market") or "ASX"),
                symbol=str(payload.get("symbol") or ""),
            )
        except Exception as exc:  # noqa: BLE001 - factor lab should still render base IC tables.
            result["alpha_evolution"] = {
                "available": False,
                "error": str(exc),
                "framework": "quantaalpha_inspired_local_evolution",
            }
        return result
    if operation == "alpha-evolution":
        return analyze_alpha_evolution(
            payload.get("candles") or [],
            horizon=int(payload.get("horizon_days") or 15),
            market=str(payload.get("market") or "ASX"),
            symbol=str(payload.get("symbol") or ""),
            generations=int(payload.get("generations") or 4),
            population=int(payload.get("population") or 24),
        )
    if operation == "local-model-train":
        return train_local_model_suite(
            payload.get("samples") or [],
            market=str(payload.get("market") or "ASX"),
        )
    if operation == "historical-backtest":
        return run_historical_backtest(
            payload.get("candles") or [],
            market=str(payload.get("market") or "ASX"),
            symbol=str(payload.get("symbol") or ""),
            horizon=int(payload.get("horizon_days") or payload.get("horizonDays") or 15),
            target_upside=float(payload.get("target_upside", payload.get("targetUpside", 5)) or 5),
            stop_loss=float(payload.get("stop_loss", payload.get("stopLoss", 4)) or 4),
            min_train=int(payload.get("min_train", payload.get("minTrain", 120)) or 120),
            step=int(payload.get("step") or 1),
            max_predictions=int(payload.get("max_predictions", payload.get("maxPredictions", 2000)) or 2000),
            retrain_interval=int(payload.get("retrain_interval", payload.get("retrainInterval", 60)) or 60),
            max_train_window=int(payload.get("max_train_window", payload.get("maxTrainWindow", 240)) or 240),
            knn_window=int(payload.get("knn_window", payload.get("knnWindow", 260)) or 260),
        )
    if operation == "historical-backtest-batch":
        return batch_historical_backtest(payload)
    if operation == "trade-analysis":
        return analyze_trades(
            payload.get("trades") or [],
            market=str(payload.get("market") or "US"),
            symbol=str(payload.get("symbol") or ""),
            source=str(payload.get("source") or ""),
        )
    if operation == "provider-budget":
        return provider_plan(
            str(payload.get("market") or "ASX"),
            [str(item) for item in payload.get("candidates") or []],
            payload.get("configured") or {},
        )
    if operation == "ibkr-readiness":
        return ibkr_readiness(payload)
    if operation == "qlib-readiness":
        return qlib_readiness()
    if operation == "baostock-candles":
        return baostock_candles(payload)
    if operation == "risk-assessment":
        return assess_portfolio(payload)
    if operation == "event-append":
        return append_event(payload)
    if operation == "event-list":
        return list_events(payload)
    if operation == "order-intent":
        intent = build_paper_order_intent(payload)
        return record_order_intent(intent, payload.get("db_path"))
    if operation == "order-intent-list":
        return list_order_intents(payload)
    if operation == "control-plane-summary":
        return control_plane_summary(payload)
    if operation == "market-data-record":
        return record_market_rows(payload)
    if operation == "market-data-summary":
        return market_data_summary(payload)
    if operation == "market-data-list":
        return list_market_rows(payload)
    raise ValueError(f"Unknown Python quant core operation: {operation}")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = dispatch(payload)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
