from __future__ import annotations

import json
import importlib.util
import socket
import sys
import traceback
from typing import Any

from alpha_mining import analyze_alpha_evolution
from artifact_maintenance import cleanup_training_artifacts
from data_lake import audit as audit_data_lake
from data_lake import backfill_local_pit_caches
from data_lake import read_rows as read_data_lake_rows
from data_lake import read_panel as read_data_lake_panel
from data_lake import read_pit_panel as read_data_lake_pit_panel
from data_lake import summary as data_lake_summary
from data_lake import upsert as upsert_data_lake
from data_lake import upsert_panel as upsert_data_lake_panel
from data_lake import upsert_pit_batches, upsert_pit_records
from features import analyze_cross_sectional_factors, analyze_factors, analyze_features
from historical_backtest import batch_historical_backtest, run_historical_backtest
from local_model import train_local_model_suite
from model_reporting import generate_model_report
from paper_agents import configure as configure_paper_agents
from paper_agents import list_agent_events, load_state as load_paper_agent_state
from paper_agents import list_generations as list_paper_agent_generations
from paper_agents import migrate as migrate_paper_agents
from paper_agents import replay_oof as replay_paper_agents
from paper_agents import reset as reset_paper_agents
from paper_agents import step as step_paper_agents
from paper_agents import upgrade_generation as upgrade_paper_agent_generation
from production_training import recover_oof_artifacts, train_market_multitask
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
                "market-level-multitask-oof-training",
                "ibkr-readiness",
                "qlib-readiness",
                "alpha-evolution",
                "local-model-suite",
                "persistent-paper-agents",
                "parquet-duckdb-data-lake",
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
        if result.get("available") is False:
            result["alpha_evolution"] = {
                "available": False,
                "deferred": False,
                "framework": "quantaalpha_inspired_local_evolution",
                "reason": "Alpha evolution is disabled until the real-candle evidence threshold is met.",
            }
            return result
        if payload.get("include_alpha_evolution", True) is False:
            result["alpha_evolution"] = {
                "available": False,
                "deferred": True,
                "framework": "quantaalpha_inspired_local_evolution",
                "reason": "Alpha evolution is executed as a separate background stage.",
            }
            return result
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
    if operation == "factor-research":
        result = analyze_factors(
            payload.get("candles") or [],
            horizon=int(payload.get("horizon_days") or 15),
            market=str(payload.get("market") or "ASX"),
            symbol=str(payload.get("symbol") or ""),
        )
        research = result.get("factor_research") or {}
        return {
            "market": result.get("market"),
            "symbol": result.get("symbol"),
            "horizon_days": result.get("horizon_days"),
            "sample_count": result.get("sample_count"),
            "framework": research.get("framework", "dynamic-factor-admission-and-ml-weighting"),
            "factor_research": research,
            "top_factors": result.get("factors", [])[:12],
            "quality_gate": result.get("quality_gate"),
        }
    if operation == "cross-sectional-factor-research":
        return analyze_cross_sectional_factors(
            payload.get("items") or [],
            market=str(payload.get("market") or "ASX"),
            horizons=payload.get("horizons") or payload.get("horizon_days") or payload.get("horizonDays") or [5, 15, 30],
            min_symbols=int(payload.get("min_symbols", payload.get("minSymbols", 4)) or 4),
        )
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
            step_schedule=payload.get("step_schedule", payload.get("stepSchedule", payload.get("steps"))),
            max_step_offsets=int(payload.get("max_step_offsets", payload.get("maxStepOffsets", 1)) or 1),
            max_predictions=int(payload.get("max_predictions", payload.get("maxPredictions", 2000)) or 2000),
            retrain_interval=int(payload.get("retrain_interval", payload.get("retrainInterval", 60)) or 60),
            max_train_window=int(payload.get("max_train_window", payload.get("maxTrainWindow", 240)) or 240),
            knn_window=int(payload.get("knn_window", payload.get("knnWindow", 260)) or 260),
            adaptive_labels=payload.get("adaptive_labels", payload.get("adaptiveLabels", True)) is not False,
            transaction_cost_bps=float(payload.get("transaction_cost_bps", payload.get("transactionCostBps", 0)) or 0),
        )
    if operation == "historical-backtest-batch":
        result = batch_historical_backtest(payload)
        if payload.get("production_training", payload.get("productionTraining", False)) is True:
            result["productionTraining"] = train_market_multitask(payload)
        return result
    if operation == "production-model-train":
        return train_market_multitask(payload)
    if operation == "model-report-generate":
        return generate_model_report(
            root=payload.get("root"),
            markets=payload.get("markets"),
            output_dir=payload.get("output_dir", payload.get("outputDir")),
        )
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
    if operation == "data-lake-upsert":
        return upsert_data_lake(payload)
    if operation == "data-lake-read":
        return read_data_lake_rows(payload)
    if operation == "data-lake-panel-read":
        return read_data_lake_panel(payload)
    if operation == "data-lake-pit-read":
        return read_data_lake_pit_panel(payload)
    if operation == "data-lake-panel-upsert":
        return upsert_data_lake_panel(payload)
    if operation == "data-lake-summary":
        return data_lake_summary(payload)
    if operation == "data-lake-audit":
        return audit_data_lake(payload)
    if operation == "data-lake-pit-upsert":
        return upsert_pit_records(payload)
    if operation == "data-lake-pit-batch-upsert":
        return upsert_pit_batches(payload)
    if operation == "data-lake-backfill-local-caches":
        return backfill_local_pit_caches(payload)
    if operation == "training-artifact-maintenance":
        return cleanup_training_artifacts(payload)
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
    if operation == "paper-agent-summary":
        return load_paper_agent_state(str(payload.get("market") or "ASX"), payload.get("db_path"))
    if operation == "paper-agent-config":
        return configure_paper_agents(payload)
    if operation == "paper-agent-reset":
        return reset_paper_agents(payload)
    if operation == "paper-agent-migrate":
        return migrate_paper_agents(payload)
    if operation == "paper-agent-step":
        return step_paper_agents(payload)
    if operation == "paper-agent-events":
        return list_agent_events(payload)
    if operation == "paper-agent-generations":
        return list_paper_agent_generations(payload)
    if operation == "paper-agent-upgrade-generation":
        return upgrade_paper_agent_generation(payload)
    if operation == "paper-agent-replay":
        return replay_paper_agents(payload)
    if operation == "production-model-recover-oof":
        return recover_oof_artifacts(payload)
    raise ValueError(f"Unknown Python quant core operation: {operation}")


def response_for(payload: dict[str, Any], request_id: str | None = None) -> dict[str, Any]:
    try:
        result = dispatch(payload)
        response = {"ok": True, "result": result}
    except Exception as exc:
        response = {
            "ok": False,
            "error": str(exc),
            "error_type": type(exc).__name__,
        }
        if "--debug-errors" in sys.argv:
            response["traceback"] = traceback.format_exc(limit=8)
    if request_id is not None:
        response["request_id"] = request_id
    return response


def persistent_main() -> None:
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        request_id: str | None = None
        try:
            payload = json.loads(text)
            request_id = str(payload.pop("__request_id", "") or "")
            response = response_for(payload, request_id)
        except Exception as exc:
            response = {
                "ok": False,
                "request_id": request_id,
                "error": f"Invalid persistent worker request: {exc}",
                "error_type": type(exc).__name__,
            }
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> None:
    if "--persistent" in sys.argv:
        persistent_main()
        return
    payload = json.load(sys.stdin)
    response = response_for(payload)
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    if response.get("ok") is not True:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
