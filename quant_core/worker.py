from __future__ import annotations

import json
import importlib.util
import socket
import sys
import traceback
from pathlib import Path
from typing import Any

from alpha_mining import analyze_alpha_evolution
from artifact_maintenance import cleanup_training_artifacts
from data_lake import audit as audit_data_lake
from data_lake import backfill_local_pit_caches
from data_lake import migrate_asx_financial_disclosures
from data_lake import read_rows as read_data_lake_rows
from data_lake import read_panel as read_data_lake_panel
from data_lake import read_pit_panel as read_data_lake_pit_panel
from data_lake import verified_pit_coverage as data_lake_verified_pit_coverage
from data_lake import summary as data_lake_summary
from data_lake import upsert as upsert_data_lake
from data_lake import upsert_panel as upsert_data_lake_panel
from data_lake import upsert_pit_batches, upsert_pit_records
from data_semantics import audit_lake as audit_pit_data_lake
from calibration_contracts import (
    adaptive_conformal_interval,
    calibration_diagnostics,
    choose_calibrator,
    chronological_calibration_split,
    no_trade_gate,
)
from evolution_contracts import (
    champion_replacement,
    dependency_gate,
    experiment_budget,
    failure_evidence,
    new_evidence_required,
    paper_trajectory,
    repeated_root_cause_action,
    rollback_reference,
    transition_task,
)
from factor_research import evaluate_factor, factor_card, factor_pool_audit
from model_contracts import candidate_admission, family_contract, qualified_family_models
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
from pit_ingest import backfill_baostock_corporate_actions
from production_training import model_library_status, recover_oof_artifacts, train_market_multitask
from provider_budget import provider_plan
from rqdata_provider import fetch_candles as fetch_rqdata_candles, status as rqdata_status
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


def _legacy_module_available(module: str) -> bool:
    """Keep optional research packages visible without blocking health checks."""
    legacy_root = Path(__file__).resolve().parents[1] / ".venv" / "lib"
    return any(
        (site_packages / module).exists()
        for site_packages in legacy_root.glob("python*/site-packages")
    )


def qlib_readiness() -> dict[str, Any]:
    qlib_spec = importlib.util.find_spec("qlib")
    lightgbm_spec = importlib.util.find_spec("lightgbm")
    torch_spec = importlib.util.find_spec("torch")
    qlib_in_current = qlib_spec is not None
    torch_in_current = torch_spec is not None
    qlib_in_legacy = not qlib_in_current and _legacy_module_available("qlib")
    torch_in_legacy = not torch_in_current and _legacy_module_available("torch")
    installed = qlib_in_current or qlib_in_legacy
    lightgbm_installed = lightgbm_spec is not None
    torch_installed = torch_in_current or torch_in_legacy
    # The production worker uses the isolated native runtime directly. Qlib
    # remains an optional research adapter and may live in the legacy venv.
    lightgbm_ready = lightgbm_installed
    sequence_ready = torch_installed
    return {
        "available": installed,
        "package": "Microsoft Qlib",
        "qlib_installed": installed,
        "lightgbm_installed": lightgbm_installed,
        "torch_installed": torch_installed,
        "qlib_runtime": "native-ml" if qlib_in_current else ("legacy-venv" if qlib_in_legacy else None),
        "torch_runtime": "native-ml" if torch_in_current else ("legacy-venv" if torch_in_legacy else None),
        "models": [
            {
                "id": "lightgbm",
                "label": "LightGBM",
                "ready": lightgbm_ready,
                "status": "ready" if lightgbm_ready else "missing_lightgbm",
                "reason": "ready" if lightgbm_ready else "缺 LightGBM",
                "use": "tabular factors after six-gate quality audit and walk-forward split",
            },
            {
                "id": "lstm",
                "label": "LSTM",
                "ready": sequence_ready,
                "status": "ready" if sequence_ready else "missing_torch",
                "reason": "ready" if sequence_ready else "缺 PyTorch",
                "use": "time-series sequence factors; scaler fitted on train window only",
            },
            {
                "id": "transformer",
                "label": "Transformer",
                "ready": sequence_ready,
                "status": "ready" if sequence_ready else "missing_torch",
                "reason": "ready" if sequence_ready else "缺 PyTorch",
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
            "Native ML runtime is ready; Qlib research adapter is available from the legacy environment."
            if installed and qlib_in_legacy and not qlib_in_current
            else "Qlib is importable; model adapters can be enabled after data handler configuration."
            if installed
            else "Qlib is not installed; current factor lab continues with the built-in walk-forward engine."
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
                "point-in-time-data-semantics-audit",
                "factor-card-and-redundancy-audit",
                "model-family-evidence-contract",
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
    if operation == "ml-readiness":
        return model_library_status()
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
    if operation == "baostock-corporate-actions":
        return backfill_baostock_corporate_actions(payload)
    if operation == "rqdata-status":
        return rqdata_status(payload)
    if operation == "rqdata-candles":
        return fetch_rqdata_candles(payload)
    if operation == "data-lake-upsert":
        return upsert_data_lake(payload)
    if operation == "data-lake-read":
        return read_data_lake_rows(payload)
    if operation == "data-lake-panel-read":
        return read_data_lake_panel(payload)
    if operation == "data-lake-pit-read":
        return read_data_lake_pit_panel(payload)
    if operation == "data-lake-pit-coverage":
        return data_lake_verified_pit_coverage(payload)
    if operation == "data-lake-panel-upsert":
        return upsert_data_lake_panel(payload)
    if operation == "data-lake-summary":
        return data_lake_summary(payload)
    if operation == "data-lake-audit":
        return audit_data_lake(payload)
    if operation == "data-lake-semantic-audit":
        return audit_pit_data_lake(payload)
    if operation == "factor-card":
        return factor_card(
            str(payload.get("name") or ""),
            source_version=str(payload.get("source_version") or payload.get("sourceVersion") or "unbound"),
            feature_schema=str(payload.get("feature_schema") or payload.get("featureSchema") or "factor-panel-v2"),
        )
    if operation == "factor-evaluate":
        return evaluate_factor(
            payload.get("rows") or [],
            str(payload.get("name") or payload.get("factor") or ""),
            value_key=payload.get("value_key", payload.get("valueKey")),
            label_key=str(payload.get("label_key") or payload.get("labelKey") or "label"),
            min_breadth=int(payload.get("min_breadth", payload.get("minBreadth", 10)) or 10),
        )
    if operation == "factor-pool-audit":
        return factor_pool_audit(
            payload.get("rows") or [],
            payload.get("names") or payload.get("factors") or [],
            min_dates=int(payload.get("min_dates", payload.get("minDates", 120)) or 120),
            max_correlation=float(payload.get("max_correlation", payload.get("maxCorrelation", 0.65)) or 0.65),
        )
    if operation == "model-family-contract":
        return family_contract(
            str(payload.get("family") or ""),
            horizon=int(payload.get("horizon") or 5),
            feature_schema=str(payload.get("feature_schema") or payload.get("featureSchema") or "unknown"),
        )
    if operation == "model-candidate-admission":
        return candidate_admission(
            payload.get("candidate") or {},
            payload.get("null_model", payload.get("nullModel")) or {},
            family=str(payload.get("family") or (payload.get("candidate") or {}).get("family") or ""),
            min_rows=int(payload.get("min_rows", payload.get("minRows", 1_000)) or 1_000),
            min_dates=int(payload.get("min_dates", payload.get("minDates", 120)) or 120),
        )
    if operation == "qualified-family-models":
        return qualified_family_models(payload.get("candidates") or [])
    if operation == "calibration-split":
        return chronological_calibration_split(
            payload.get("rows") or [],
            fit_pct=float(payload.get("fit_pct", payload.get("fitPct", 0.55)) or 0.55),
            calibration_pct=float(payload.get("calibration_pct", payload.get("calibrationPct", 0.20)) or 0.20),
            selection_pct=float(payload.get("selection_pct", payload.get("selectionPct", 0.15)) or 0.15),
            purge_days=int(payload.get("purge_days", payload.get("purgeDays", 5)) or 5),
            embargo_days=int(payload.get("embargo_days", payload.get("embargoDays", 5)) or 5),
        )
    if operation == "calibration-diagnostics":
        return calibration_diagnostics(
            payload.get("rows") or [],
            payload.get("probabilities") or [],
            actual_key=str(payload.get("actual_key") or payload.get("actualKey") or "actualTarget"),
            date_key=str(payload.get("date_key") or payload.get("dateKey") or "date"),
            min_bucket_events=int(payload.get("min_bucket_events", payload.get("minBucketEvents", 30)) or 30),
            min_bucket_dates=int(payload.get("min_bucket_dates", payload.get("minBucketDates", 30)) or 30),
        )
    if operation == "calibrator-select":
        return choose_calibrator(
            payload.get("fit_rows", payload.get("fitRows")) or [],
            payload.get("calibration_rows", payload.get("calibrationRows")) or [],
            probability_key=str(payload.get("probability_key") or payload.get("probabilityKey") or "probability"),
            actual_key=str(payload.get("actual_key") or payload.get("actualKey") or "actualTarget"),
            date_key=str(payload.get("date_key") or payload.get("dateKey") or "date"),
        )
    if operation == "conformal-interval":
        return adaptive_conformal_interval(
            payload.get("rows") or [],
            prediction_key=str(payload.get("prediction_key") or payload.get("predictionKey") or "prediction"),
            actual_key=str(payload.get("actual_key") or payload.get("actualKey") or "actualReturn"),
            date_key=str(payload.get("date_key") or payload.get("dateKey") or "date"),
            alpha=float(payload.get("alpha", 0.20) or 0.20),
            window_dates=int(payload.get("window_dates", payload.get("windowDates", 120)) or 120),
        )
    if operation == "no-trade-gate":
        return no_trade_gate(
            probability=float(payload.get("probability", 0.0) or 0.0),
            lower_probability=payload.get("lower_probability", payload.get("lowerProbability")),
            expected_value_pct=payload.get("expected_value_pct", payload.get("expectedValuePct")),
            lower_return_pct=payload.get("lower_return_pct", payload.get("lowerReturnPct")),
            threshold=float(payload.get("threshold", 0.57) or 0.57),
            min_lower_probability=float(payload.get("min_lower_probability", payload.get("minLowerProbability", 0.50)) or 0.50),
            min_expected_value_pct=float(payload.get("min_expected_value_pct", payload.get("minExpectedValuePct", 0.0)) or 0.0),
            min_lower_return_pct=float(payload.get("min_lower_return_pct", payload.get("minLowerReturnPct", 0.0)) or 0.0),
            data_quality_ok=payload.get("data_quality_ok", payload.get("dataQualityOk", True)) is True,
            model_evidence_ok=payload.get("model_evidence_ok", payload.get("modelEvidenceOk", True)) is True,
        )
    if operation == "portfolio-cost-impact":
        from portfolio_contracts import cost_impact
        return cost_impact(
            notional=float(payload.get("notional", 0.0) or 0.0),
            average_dollar_volume=payload.get("average_dollar_volume", payload.get("averageDollarVolume")),
            participation_rate=float(payload.get("participation_rate", payload.get("participationRate", 0.10)) or 0.10),
            spread_bps=float(payload.get("spread_bps", payload.get("spreadBps", 8.0)) or 8.0),
            commission_bps=float(payload.get("commission_bps", payload.get("commissionBps", 1.0)) or 1.0),
            impact_bps=float(payload.get("impact_bps", payload.get("impactBps", 25.0)) or 25.0),
        )
    if operation == "portfolio-constraints":
        from portfolio_contracts import portfolio_constraint_audit
        return portfolio_constraint_audit(
            payload.get("positions") or [],
            equity=float(payload.get("equity", 0.0) or 0.0),
            cash=float(payload.get("cash", 0.0) or 0.0),
            max_positions=int(payload.get("max_positions", payload.get("maxPositions", 6)) or 6),
            max_position_pct=float(payload.get("max_position_pct", payload.get("maxPositionPct", 0.12)) or 0.12),
            max_sector_pct=float(payload.get("max_sector_pct", payload.get("maxSectorPct", 0.25)) or 0.25),
            min_cash_pct=float(payload.get("min_cash_pct", payload.get("minCashPct", 0.25)) or 0.25),
        )
    if operation == "paper-backtest":
        from portfolio_contracts import run_executable_paper_backtest
        return run_executable_paper_backtest(
            payload.get("rows") or [],
            initial_cash=float(payload.get("initial_cash", payload.get("initialCash", 100_000.0)) or 100_000.0),
            max_position_pct=float(payload.get("max_position_pct", payload.get("maxPositionPct", 0.12)) or 0.12),
            min_cash_pct=float(payload.get("min_cash_pct", payload.get("minCashPct", 0.25)) or 0.25),
        )
    if operation == "evolution-transition":
        return transition_task(payload.get("task") or {}, str(payload.get("target") or payload.get("status") or ""), evidence_id=payload.get("evidence_id", payload.get("evidenceId")), reason=payload.get("reason"))
    if operation == "evolution-dependency-gate":
        return dependency_gate(payload.get("task") or {}, payload.get("tasks") or [])
    if operation == "evolution-failure-evidence":
        return failure_evidence(root_cause=str(payload.get("root_cause") or payload.get("rootCause") or ""), attempt=int(payload.get("attempt") or 0), evidence_id=str(payload.get("evidence_id") or payload.get("evidenceId") or ""), next_action=str(payload.get("next_action") or payload.get("nextAction") or ""), task_id=payload.get("task_id", payload.get("taskId")))
    if operation == "evolution-pivot":
        return repeated_root_cause_action(payload.get("records") or [], str(payload.get("root_cause") or payload.get("rootCause") or ""), threshold=int(payload.get("threshold", 3) or 3))
    if operation == "evolution-new-evidence":
        return new_evidence_required(payload.get("previous") or {}, snapshot_id=payload.get("snapshot_id", payload.get("snapshotId")), changed_hypothesis=payload.get("changed_hypothesis", payload.get("changedHypothesis")))
    if operation == "evolution-champion-replacement":
        return champion_replacement(payload.get("candidate") or {}, payload.get("champion"), tolerance=float(payload.get("tolerance", 0.0) or 0.0))
    if operation == "evolution-rollback-reference":
        return rollback_reference(payload.get("champion") or {}, reason=str(payload.get("reason") or "manual rollback"))
    if operation == "evolution-paper-trajectory":
        return paper_trajectory(market=str(payload.get("market") or "ASX"), symbol=str(payload.get("symbol") or ""), signal_at=str(payload.get("signal_at") or payload.get("signalAt") or ""), action=str(payload.get("action") or "NO_TRADE"), model_version=payload.get("model_version", payload.get("modelVersion")), expected_value_pct=payload.get("expected_value_pct", payload.get("expectedValuePct")), outcome_return_pct=payload.get("outcome_return_pct", payload.get("outcomeReturnPct")), reason=payload.get("reason"))
    if operation == "evolution-budget":
        return experiment_budget(payload.get("records") or [], year_month=str(payload.get("year_month") or payload.get("yearMonth") or ""), max_hypotheses=int(payload.get("max_hypotheses", payload.get("maxHypotheses", 12)) or 12), max_factor_candidates=int(payload.get("max_factor_candidates", payload.get("maxFactorCandidates", 60)) or 60), max_model_candidates=int(payload.get("max_model_candidates", payload.get("maxModelCandidates", 24)) or 24))
    if operation == "data-lake-pit-upsert":
        return upsert_pit_records(payload)
    if operation == "data-lake-pit-batch-upsert":
        return upsert_pit_batches(payload)
    if operation == "data-lake-backfill-local-caches":
        return backfill_local_pit_caches(payload)
    if operation == "data-lake-migrate-asx-financial-disclosures":
        return migrate_asx_financial_disclosures(payload)
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
