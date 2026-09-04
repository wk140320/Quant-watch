import gzip
import json
import sys
import tempfile
import unittest
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

import production_training  # noqa: E402

from alpha_mining import analyze_alpha_evolution  # noqa: E402
from asx_report_ingest import ingest_asx_financial_report, parse_asx_financial_report  # noqa: E402
from data_quality import assess_candle_quality  # noqa: E402
from data_lake import (  # noqa: E402
    audit as audit_data_lake,
    create_training_snapshot,
    migrate_asx_financial_disclosures,
    read_panel as read_data_lake_panel,
    read_pit_panel as read_data_lake_pit_panel,
    read_rows as read_data_lake_rows,
    summary as data_lake_summary,
    upsert as upsert_data_lake,
    upsert_panel as upsert_data_lake_panel,
    upsert_pit_batches,
    upsert_pit_records,
    verified_pit_coverage as data_lake_verified_pit_coverage,
)
from features import analyze_cross_sectional_factors, analyze_factors, analyze_features  # noqa: E402
from historical_backtest import adaptive_barriers, outcome_window, run_historical_backtest  # noqa: E402
from local_model import split_audit, split_supervised_rows, train_local_model_suite  # noqa: E402
from model_reporting import (  # noqa: E402
    _job_header,
    _job_summary,
    block_bootstrap_ci,
    build_report_evidence,
    classification_metrics,
    factor_model_reports,
    market_report,
    prediction_id,
    quantile_metrics,
    rank_metrics,
    read_oof_rows,
)
from metrics_contract import (  # noqa: E402
    classification_metrics as strict_classification_metrics,
    metric_contract_manifest,
    paired_block_bootstrap,
    paired_comparison,
    positive_fold_contract,
    ranking_metrics as strict_ranking_metrics,
    turnover_and_cost,
)
from label_contracts import (  # noqa: E402
    LABEL_CONTRACT_VERSION,
    build_atomic_label,
    build_panel_labels,
    event_car_label,
    purged_walk_forward_splits,
    volatility_scaled_return,
)
from paper_agents import configure as configure_paper_agents, list_agent_events, list_generations as list_paper_agent_generations, load_state as load_paper_agent_state, migrate as migrate_paper_agents, replay_oof as replay_paper_agents, save_state as save_paper_agent_state, step as step_paper_agents, upgrade_generation as upgrade_paper_agent_generation  # noqa: E402
from pit_ingest import normalize_baostock_adjust_factors  # noqa: E402
from pit_contract import fundamental_coverage_layers, parse_pit_timestamp  # noqa: E402
from data_semantics import (  # noqa: E402
    audit_pit_records,
    cluster_events,
    compare_source_rows,
    missingness_matrix,
    revision_chain_audit,
    source_quality_audit,
    validate_adjustment_windows,
    validate_trading_dates,
)
from factor_research import FACTOR_DEFINITIONS, evaluate_factor, factor_card, factor_pool_audit  # noqa: E402
from model_contracts import candidate_admission, choose_shallowest_one, family_contract, qualified_family_models  # noqa: E402
from calibration_contracts import adaptive_conformal_interval, calibration_diagnostics, choose_calibrator, chronological_calibration_split, no_trade_gate  # noqa: E402
from evolution_contracts import champion_replacement, dependency_gate, failure_evidence, new_evidence_required, repeated_root_cause_action, transition_task  # noqa: E402
from portfolio_contracts import cost_impact, paper_signal_decision, portfolio_constraint_audit, run_executable_paper_backtest  # noqa: E402
from provider_budget import provider_plan  # noqa: E402
from production_training import _combine_company_market_point_in_time, _date_level_regime_predictions, _event_fold_predictions, _fallback_baseline_predictions, _fold_checkpoint_context, _fold_oof_predictions, _load_latest_eligible_dataset_cache, _point_in_time_features_from_prepared, _prepare_point_in_time_candidates, _rank_cross_section, _save_dataset_cache, _sector_semantics_audit, _select_label_tournament_candidate, _training_feature_family_gate, _training_feature_profile_gate, _training_stable_feature_panel, brier_skilled_models, build_market_dataset, calibration_metrics, diagnostic_bucket_summary, expert_ensemble_audit, fit_constrained_stack, fit_false_positive_risk_head, fit_long_trade_gate, fit_nested_direction_threshold, fit_probability_calibrator, fit_selective_ranking_head, frozen_oof_test_membership, hydrate_verified_pit_from_data_lake, label_noise_sensitivity, label_prevalence_report, label_tournament_summary, moving_block_bootstrap_ci, point_in_time_features, purged_walk_forward_folds, rank_ic_summary, recover_oof_artifacts, run_label_tournament_oof, select_robust_direction_models, thresholded_direction_metrics, verified_pit_coverage  # noqa: E402
from research_governance import consume_lockbox, create_lockbox, evaluate_lockbox_once, experiment_hypothesis_contract, open_lockbox, record_experiment  # noqa: E402
from risk import assess_portfolio, build_paper_order_intent  # noqa: E402
from store import append_event, control_plane_summary, list_events, list_market_rows, market_data_summary, record_market_rows, record_order_intent  # noqa: E402
from trades import analyze_trades  # noqa: E402
from worker import dispatch  # noqa: E402
from quant_client import ApiClient, parse_position, risk_payload  # noqa: E402


def candles(count=140):
    rows = []
    close = 100.0
    for index in range(count):
        drift = 0.35 if index % 9 < 6 else -0.25
        close = max(1, close + drift)
        rows.append(
            {
                "date": f"2026-01-{index + 1:03d}",
                "open": close - drift * 0.4,
                "high": close + 0.8,
                "low": close - 0.9,
                "close": close,
                "volume": 1000 + index * 12,
            }
        )
    return rows


def panel_candles(count=220, drift=0.08, phase=0):
    rows = []
    close = 45.0 + phase * 3
    for index in range(count):
        cycle = ((index + phase * 3) % 17 - 8) * 0.035
        pulse = 0.22 if (index + phase) % 31 < 5 else -0.06 if (index + phase) % 29 < 4 else 0.0
        close = max(1, close + drift + cycle + pulse)
        spread = 0.55 + (phase % 3) * 0.05
        rows.append(
            {
                "date": f"2025-{(index // 28) % 12 + 1:02d}-{(index % 28) + 1:02d}",
                "open": close - (drift + cycle) * 0.45,
                "high": close + spread,
                "low": close - spread * 0.9,
                "close": close,
                "volume": 1200 + index * (8 + phase) + (phase % 4) * 150,
            }
        )
    return rows


def panel_items(count=220):
    rows = []
    sectors = ["Tech", "Materials", "Banks", "Energy", "Tech", "Healthcare"]
    for index, symbol in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]):
        rows.append(
            {
                "symbol": symbol,
                "sector": sectors[index],
                "source": "unit",
                "candles": panel_candles(count, drift=0.03 + index * 0.018, phase=index),
            }
        )
    return rows


def prediction_samples(count=48):
    pattern = [-3.0, -1.8, -0.7, 0.4, 1.1, 2.2, 3.1, 4.0, 1.6, -0.4, 2.7, -2.4]
    rows = []
    for index in range(count):
        signal_date = date(2026, 1, 2) + timedelta(days=index)
        resolved_date = signal_date + timedelta(days=15)
        actual = pattern[index % len(pattern)] + (0.03 if index % 2 == 0 else -0.02)
        target_wins = actual >= 2.0
        stop_wins = actual <= -2.0
        trend = max(5, min(95, 50 + actual * 8))
        momentum = max(5, min(95, 50 + actual * 7))
        rows.append(
            {
                "id": f"unit-{index}",
                "market": "US",
                "symbol": "UNIT",
                "createdAt": f"{signal_date.isoformat()}T09:{index % 60:02d}:00Z",
                "asOfDate": signal_date.isoformat(),
                "action": "WATCH_BUY" if target_wins else "HOLD_WATCH",
                "confidence": 62 if target_wins else 44,
                "predictionConfidence": 62 if target_wins else 44,
                "strategyHitProbability": 70 if target_wins else 28,
                "magnitudeHitProbability": 68 if target_wins else 34,
                "projectedFinalReturn": -actual * 0.5,
                "projectedMaxUpside": max(0.2, actual + 1.0),
                "targetUpside": 2,
                "featureScores": {
                    "trend": trend,
                    "momentum": momentum,
                    "change5d": actual * 0.55,
                    "change20d": actual * 1.3,
                    "volumeRatio": 1.0 + max(0, actual) * 0.08,
                    "rsi": max(25, min(80, 50 + actual * 4)),
                    "volume": 52 + max(0, actual) * 4,
                    "risk": 55 - max(0, -actual) * 5,
                    "factor": actual * 3,
                    "analogConfidence": 55 + actual * 4,
                    "modelConfidence": 55 + actual * 4,
                },
                "signalCounts": {"news": 2 if abs(actual) > 1 else 0, "x": 0, "youtube": 0, "factors": 3},
                "ensemble": {
                    "projectedUpside": -actual * 0.55,
                    "upsideAgreement": 70 if actual > 0 else 35,
                    "consensusAgreement": 68,
                    "models": [
                        {"name": "Good ML", "available": True, "projectedUpside": actual * 0.96, "weight": 0.34, "normalizedWeight": 0.34},
                        {"name": "Bad ML", "available": True, "projectedUpside": -actual * 0.9, "weight": 0.33, "normalizedWeight": 0.33},
                        {"name": "Flat ML", "available": True, "projectedUpside": 0.1, "weight": 0.33, "normalizedWeight": 0.33},
                    ],
                },
                "outcome": {
                    "resolved": True,
                    "resolvedAt": f"{resolved_date.isoformat()}T09:{index % 60:02d}:00Z",
                    "forwardReturnPct": actual,
                    "maxUpsidePct": max(0, actual + 0.8),
                    "maxDrawdownPct": min(0, actual - 1.2),
                    "targetWins": target_wins,
                    "stopWins": stop_wins,
                },
            }
        )
    return rows


class QuantCoreTests(unittest.TestCase):
    def test_asx_report_parser_requires_official_dated_source_and_preserves_numeric_facts(self):
        report = """
        Annual Report for the year ended 30 June 2025
        A$ million
        Revenue                         1,200.0  1,000.0
        Profit after tax                  240.0    200.0
        Total assets                     8,500.0  8,000.0
        Total liabilities                3,400.0  3,200.0
        Net cash provided by operating activities  310.0  280.0
        Basic earnings per share            0.24     0.20
        """
        candidate = parse_asx_financial_report(
            "BHP.AX",
            report,
            source_url="https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
            report_period_end="2025-06-30",
            published_at="2025-08-01T08:00:00+10:00",
        )
        self.assertTrue(candidate["accepted"])
        self.assertTrue(candidate["strictPit"])
        self.assertEqual(candidate["symbol"], "BHP")
        self.assertEqual(candidate["values"]["revenue"], 1_200_000_000.0)
        self.assertAlmostEqual(candidate["values"]["revenueGrowth"], 0.2)
        self.assertEqual(candidate["values"]["net_income"], 240_000_000.0)
        self.assertRegex(candidate["documentSha256"], r"^[0-9a-f]{64}$")

    def test_asx_report_parser_rejects_missing_publication_metadata_without_writing_pit(self):
        candidate = parse_asx_financial_report(
            "BHP",
            "Annual Report\nRevenue 100 90",
            source_url="https://www.asx.com.au/asxpdf/example.pdf",
            report_period_end="2025-06-30",
            published_at="",
        )
        self.assertFalse(candidate["accepted"])
        self.assertFalse(candidate["strictPit"])
        self.assertFalse(candidate["required"]["publishedAt"])

    def test_asx_report_parser_accepts_period_stated_in_report_body(self):
        candidate = parse_asx_financial_report(
            "BHP",
            "Annual Report for the year ended 30 June 2025\nA$ million\nRevenue 100 90",
            source_url="https://www.asx.com.au/asxpdf/example.pdf",
            report_period_end=None,
            published_at="2025-08-01T08:00:00+10:00",
        )
        self.assertTrue(candidate["accepted"])
        self.assertEqual(candidate["event_time"], "2025-06-30T00:00:00+00:00")
        self.assertIn("periodEnd:extracted-from-explicit-report-body", candidate["warnings"])

    def test_asx_report_ingest_writes_explicit_pit_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "lake"
            result = ingest_asx_financial_report({
                "root": str(root),
                "symbol": "BHP",
                "text": "Annual Report\nA$ million\nRevenue 1,200 1,000\nProfit after tax 240 200",
                "source_url": "https://www.asx.com.au/asxpdf/example.pdf",
                "report_period_end": "2025-06-30",
                "published_at": "2025-08-01T08:00:00+10:00",
            })
            self.assertTrue(result["accepted"])
            self.assertEqual(result["saved"]["inserted"], 1)
            panel = read_data_lake_pit_panel({
                "root": str(root),
                "market": "ASX",
                "symbol": "BHP",
                "symbols": ["BHP"],
                "dataset": "financial_disclosures",
                "datasets": ["financial_disclosures"],
                "verified_only": True,
            })
            feature_rows = panel["items"][0]["pointInTimeFeatures"]
            self.assertEqual(len(feature_rows), 1)
            self.assertTrue(feature_rows[0]["historicalAvailabilityVerified"])
            self.assertEqual(feature_rows[0]["rawValues"]["revenue"], 1_200_000_000.0)
            self.assertAlmostEqual(feature_rows[0]["values"]["fundamentalRevenueGrowth"], 0.2)

    def test_baostock_adjust_factors_include_verified_non_feature_coverage_receipt(self):
        records = normalize_baostock_adjust_factors(
            "600000",
            ["code", "dividOperateDate", "foreAdjustFactor", "backAdjustFactor", "adjustFactor"],
            [["sh.600000", "2020-06-01", "1.2", "0.8", "1.0"]],
            start_date="2010-01-01",
            end_date="2026-08-11",
        )
        self.assertEqual(records[0]["eventType"], "adjustment-factor")
        self.assertEqual(records[0]["available_at"], "2020-06-01")
        self.assertTrue(records[0]["historicalAvailabilityVerified"])
        self.assertEqual(records[-1]["eventType"], "coverage")
        self.assertEqual(records[-1]["coverageStart"], "2010-01-01")
        self.assertEqual(records[-1]["coverageEnd"], "2026-08-11")

    def test_corporate_action_coverage_receipt_covers_range_without_future_event(self):
        receipt = {
            "eventType": "coverage",
            "event_time": "2000-01-01",
            "available_at": "2000-01-01",
            "coverageStart": "2000-01-01",
            "coverageEnd": "2026-08-11",
            "historicalAvailabilityVerified": True,
        }
        covered = verified_pit_coverage([receipt], "2019-06-03", "CN")
        outside = verified_pit_coverage([receipt], "1999-06-03", "CN")
        self.assertTrue(covered["covered"])
        self.assertFalse(outside["covered"])

    def test_feature_analysis_uses_real_rows(self):
        result = analyze_features(candles(), market="US", symbol="TEST", source="unit", interval="1d")
        self.assertEqual(result["row_count"], 140)
        self.assertTrue(result["quality"]["proxy_only"])
        self.assertFalse(result["true_l2"])
        self.assertGreater(len(result["volume_profile"]["buckets"]), 5)
        self.assertGreater(len(result["data_log"]), 10)
        self.assertIn("structure", result)
        self.assertIn("bollinger", result["structure"])
        self.assertIn("fibonacci", result["structure"])
        self.assertIn("fvg", result["structure"])
        self.assertIn("ict", result["structure"])
        self.assertIn("wyckoff", result["structure"])
        self.assertIn("orderflow_proxy", result["structure"])

    def test_trade_count_does_not_claim_tick_or_l2(self):
        rows = candles()
        for row in rows:
            row["trade_count"] = 100
        result = analyze_features(rows, market="US", symbol="TEST", source="alpaca-iex", interval="5m")
        self.assertEqual(result["granularity"], "intraday-candle-with-trade-count")
        self.assertTrue(result["quality"]["proxy_only"])
        self.assertFalse(result["true_l2"])

    def test_tick_footprint_features_keep_price_levels_without_claiming_l2(self):
        rows = candles(24)
        for index, row in enumerate(rows):
            row["date"] = f"2026-06-01T14:{30 + index:02d}:00.000Z"
            row["priceLevels"] = [
                {"price": row["close"] + 0.01, "buyVolume": 40 + index, "sellVolume": 8, "buyTrades": 3, "sellTrades": 1, "sideMethod": "tick_rule_estimate"},
                {"price": row["close"] - 0.01, "buyVolume": 5, "sellVolume": 30 + index, "buyTrades": 1, "sellTrades": 2, "sideMethod": "tick_rule_estimate"},
            ]
            row["buyVolume"] = 45 + index
            row["sellVolume"] = 38 + index
            row["buyTrades"] = 4
            row["sellTrades"] = 3
            row["tradeCount"] = 7
            row["orderflowSource"] = "alpaca-iex-us-trades-tick-rule-footprint"
            row["orderflowSideMethod"] = "tick_rule_estimate"
        result = analyze_features(rows, market="US", symbol="TEST", source="alpaca-iex-us-trades", interval="5m")
        self.assertFalse(result["quality"]["proxy_only"])
        self.assertTrue(result["quality"]["true_tick_footprint"])
        self.assertFalse(result["quality"]["aggressor_side_available"])
        self.assertFalse(result["true_l2"])
        self.assertEqual(result["quality"]["side_method"], "tick_rule_estimate")
        self.assertGreater(len(result["data_log"][0]["price_levels"]), 1)
        self.assertEqual(result["data_log"][0]["orderflow_side_method"], "tick_rule_estimate")

    def test_real_trade_analysis_never_claims_l2_or_aggressor_side(self):
        result = analyze_trades(
            [
                {"t": "2026-06-01T14:30:00.000Z", "p": 100, "s": 10, "x": "V", "i": 1},
                {"t": "2026-06-01T14:30:01.000Z", "p": 100.1, "s": 30, "x": "V", "i": 2},
                {"t": "2026-06-01T14:30:02.000Z", "p": 99.9, "s": 5, "x": "D", "i": 3},
            ],
            market="US",
            symbol="TEST",
            source="alpaca-iex-us-trades",
        )
        self.assertTrue(result["available"])
        self.assertTrue(result["true_tick"])
        self.assertFalse(result["true_l2"])
        self.assertFalse(result["aggressor_side_available"])
        self.assertEqual(result["row_count"], 3)

    def test_factor_lab_has_walk_forward_scores(self):
        result = analyze_factors(candles(180), horizon=10, symbol="TEST", market="US")
        self.assertTrue(result["available"])
        self.assertEqual(result["status"], "ready")
        self.assertGreater(result["sample_count"], 60)
        self.assertGreater(len(result["factors"]), 4)
        self.assertIn("momentum_5", result["correlation_matrix"])
        self.assertIn("future_window_vwap_return", result["labels"])
        self.assertIn("future_vwap_ic", result["factors"][0])
        self.assertIn("quality_gate", result)
        self.assertGreater(result["quality_gate"]["factor_count"], 4)
        self.assertIn("quality_gate", result["factors"][0])
        self.assertEqual(result["factors"][0]["quality_gate"]["total"], 6)
        self.assertIn("dimensionless", result["factors"][0]["quality_gate"]["checks"])
        self.assertIn("series", result)
        self.assertGreater(len(result["series"]["rows"]), 20)
        self.assertIn("momentum_5", result["series"]["factor_names"])
        self.assertIn("volume_accel_5_20", result["series"]["factor_names"])
        self.assertIn("volume_profile_closeness", result["series"]["factor_names"])
        self.assertIn("future_return_pct", result["series"]["rows"][0])
        self.assertIn("factors", result["series"]["rows"][0])
        self.assertEqual(result["validation"]["status"], "ready")
        self.assertGreater(len(result["validation"]["checkpoints"]), 0)
        self.assertGreaterEqual(result["validation"]["purge_samples"], 10)
        self.assertEqual(result["training_controls"]["status"], "ready")
        self.assertGreaterEqual(result["training_controls"]["gradient_accumulation_batches"], 2)
        self.assertLessEqual(result["training_controls"]["gradient_accumulation_batches"], 4)
        self.assertIsNotNone(result["training_controls"]["best_checkpoint"])
        self.assertGreater(result["training_controls"]["test_samples"], 0)
        factor_names = {row["name"] for row in result["factor_library"]}
        self.assertIn("bollinger_percent_b", factor_names)
        self.assertIn("fvg_pressure", factor_names)
        self.assertIn("wyckoff_phase_score", factor_names)
        self.assertIn("factor_research", result)
        research = result["factor_research"]
        self.assertEqual(research["framework"], "dynamic-factor-admission-and-ml-weighting")
        self.assertGreater(research["candidate_count"], 10)
        self.assertEqual(
            len(research["weights"]) > 0,
            research["admitted_count"] > 0,
        )
        self.assertTrue(all(row["status"] == "admitted" for row in research["weights"]))
        self.assertIn("ml_backtest", research)
        self.assertIn("leakage_control", research)
        self.assertIn("admission_status", result["factors"][0])
        self.assertIn("dynamic_weight_pct", result["factors"][0])

    def test_factor_lab_returns_stable_insufficient_evidence_result(self):
        result = analyze_factors(candles(48), horizon=15, symbol="SHORT", market="ASX")
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], "insufficient_data")
        self.assertEqual(result["sample_audit"]["real_rows"], 48)
        self.assertEqual(result["sample_audit"]["required_rows"], 70)
        self.assertEqual(result["sample_audit"]["synthetic_rows"], 0)
        self.assertFalse(result["sample_audit"]["model_training_allowed"])
        self.assertFalse(result["factor_research"]["ml_backtest"]["active"])
        self.assertEqual(result["factor_research"]["weights"], [])
        self.assertEqual(result["factors"], [])

    def test_factor_lab_worker_skips_evolution_for_insufficient_evidence(self):
        result = dispatch({
            "operation": "factor-lab",
            "market": "ASX",
            "symbol": "SHORT",
            "horizon_days": 15,
            "candles": candles(55),
            "include_alpha_evolution": True,
        })
        self.assertFalse(result["available"])
        self.assertFalse(result["alpha_evolution"]["available"])
        self.assertIn("evidence threshold", result["alpha_evolution"]["reason"])

    def test_alpha_evolution_generates_audited_candidates(self):
        result = analyze_alpha_evolution(candles(180), horizon=10, symbol="TEST", market="US")
        self.assertEqual(result["framework"], "quantaalpha_inspired_local_evolution")
        self.assertGreaterEqual(len(result["best_candidates"]), 5)
        self.assertGreaterEqual(len(result["trajectory"]), 2)
        self.assertIn("gbm", result["advanced_models"])
        self.assertIn("regime", result["advanced_models"])
        self.assertIn("volatility", result["advanced_models"])
        first = result["best_candidates"][0]
        self.assertIn("expression", first)
        self.assertIn("quality_gate", first)
        self.assertIn("validation_ic", first)
        self.assertIn("generalization_score", first)
        self.assertIn("overfit_penalty", first)
        self.assertIn("overfit_flag", first)
        self.assertIn("fdr_q_value", first)
        self.assertIn("promotion_checks", first)
        self.assertIn(first["promotion_status"], {"research_candidate", "rejected_oos"})
        self.assertNotIn("_values", first)

    def test_cross_sectional_factor_research_generates_market_weights(self):
        result = analyze_cross_sectional_factors(panel_items(230), market="US", horizons=[5, 10, 30], min_symbols=4)
        self.assertTrue(result["available"])
        self.assertEqual(result["framework"], "market-cross-sectional-factor-research")
        self.assertEqual(result["aggregate_weights"], [])
        available = [row for row in result["horizon_results"] if row["available"]]
        self.assertGreaterEqual(len(available), 2)
        first = available[0]
        self.assertIn("ml_backtest", first)
        self.assertIn("weights", first)
        self.assertEqual(first["admitted_count"], 0)
        self.assertGreater(first["research_candidate_count"], 0)
        self.assertIn("leakage_control", result)

    def test_qlib_readiness_operation_is_optional(self):
        result = dispatch({"operation": "qlib-readiness"})
        self.assertIn("available", result)
        self.assertIn("models", result)
        self.assertEqual({row["id"] for row in result["models"]}, {"lightgbm", "lstm", "transformer"})
        self.assertIn("dimensionless", result["factor_gate_required"])

    def test_local_model_suite_learns_oos_weights_and_signal_heads(self):
        result = train_local_model_suite(prediction_samples(), market="US")
        weights = result["ensembleWeightOptimization"]["weights"]
        self.assertIn("Good ML", weights)
        self.assertIn("Bad ML", weights)
        self.assertGreater(weights["Good ML"], weights["Bad ML"])
        self.assertIn("featureScoreHead", result["signalModels"])
        self.assertIn("factorScoreHead", result["signalModels"])
        self.assertIn("backtestMetaHead", result["signalModels"])
        self.assertIn("stopRiskHead", result["signalModels"])
        self.assertIn("tradeQualityHead", result["signalModels"])
        self.assertIn("tripleBarrier", result["signalModels"])
        self.assertGreater(result["signalModels"]["tripleBarrier"]["targetRate"], 0)
        feature_head = result["signalModels"]["featureScoreHead"]
        self.assertEqual(feature_head["model"]["featureCount"], 19)
        self.assertFalse(feature_head["productionEligible"])
        self.assertFalse(feature_head["active"])
        self.assertIn("buyPressure5", feature_head["featureNames"])
        self.assertIn("profileDistance", feature_head["featureNames"])
        self.assertIn("volumeAccel", feature_head["featureNames"])
        self.assertEqual(result["splitAudit"]["method"], "signal-date-grouped-purged-walk-forward-embargo")
        self.assertEqual(result["splitAudit"]["dateOverlapCount"], 0)
        self.assertGreater(result["splitAudit"]["testSamples"], 0)
        self.assertIn("target", result["calibrationDiagnostics"])
        self.assertIn("stop", result["calibrationDiagnostics"])
        self.assertEqual(result["noTradeGate"]["framework"], "no-trade-quality-gate")
        self.assertGreater(result["noTradeGate"]["sampleCount"], 0)
        self.assertEqual(result["signalModels"]["splitAudit"]["method"], "signal-date-grouped-purged-walk-forward-embargo")
        self.assertIn("noTradeGate", result["signalModels"])
        self.assertIn("lightgbm", result)
        self.assertIn("tripleBarrier", result)
        self.assertIn("modelZoo", result)
        self.assertEqual(result["modelZoo"]["framework"], "python-local-model-zoo-committee")
        self.assertGreaterEqual(result["modelZoo"]["candidateCount"], 4)
        self.assertIn("rejectGate", result["modelZoo"])
        self.assertIn("stability", result["modelZoo"])
        self.assertIn("deploymentWeights", result["modelZoo"])
        self.assertFalse(result["modelZoo"]["productionEligible"])
        self.assertFalse(result["modelZoo"]["active"])
        self.assertIn("productionGate", result["modelZoo"])
        self.assertGreaterEqual(result["modelZoo"]["productionGate"]["required"]["testRows"], 150)
        self.assertIn("doubleCheckPolicy", result["modelZoo"])
        self.assertGreaterEqual(result["modelZoo"]["doubleCheckPolicy"]["selfModelMinShare"], 0.8)
        self.assertIn("horizonSuites", result)
        self.assertEqual(result["horizonSuites"]["mid"]["horizonScope"], "mid")
        self.assertEqual(result["horizonSuites"]["mid"]["sampleCount"], len(prediction_samples()))
        self.assertEqual(result["horizonPolicy"]["framework"], "horizon-isolated-local-model-deployment")
        self.assertEqual(result["deploymentStatus"], "research_or_shadow_only")
        self.assertFalse(result["productionEligible"])

    def test_historical_backtest_uses_point_in_time_slices(self):
        result = run_historical_backtest(
            candles(260),
            market="US",
            symbol="UNIT",
            horizon=10,
            target_upside=2,
            stop_loss=3,
            min_train=80,
            step=2,
        )
        self.assertTrue(result["available"])
        self.assertEqual(result["framework"], "historical-walk-forward-backtest")
        self.assertGreater(result["metrics"]["samples"], 20)
        self.assertGreater(result["dataDepth"]["trainSamplesMedian"], 70)
        self.assertIn("benchmarks", result)
        self.assertIn("leakageControl", result["model"])
        self.assertIn("values", result)
        self.assertIn("hitRate", result["values"])
        self.assertIn("dataQuality", result)
        self.assertIn("effectivePredictionCuts", result["dataDepth"])
        self.assertIn("avgLabelConfidence", result["metrics"])
        self.assertIn("stability", result["predictionCalibration"])
        self.assertEqual(result["predictionCalibration"]["stability"]["framework"], "purged-walk-forward-weight-stability")
        self.assertIn("avgCoverageScore", result["metrics"])
        self.assertIn("lowCoverageSamplePct", result["metrics"])
        self.assertIn("coverageScore", result["recentPredictions"][-1])
        self.assertIn("regimeCalibration", result)
        self.assertEqual(result["regimeCalibration"]["framework"], "point-in-time-regime-bucket-calibration")
        self.assertIn("regimeBucket", result["recentPredictions"][-1])
        self.assertIn("conformalCalibration", result)
        self.assertEqual(result["conformalCalibration"]["framework"], "conformal-residual-calibration")
        self.assertIn("finalReturnAbsErrorP80", result["conformalCalibration"]["overall"])
        self.assertIn("avgLabelNoiseScore", result["metrics"])
        self.assertIn("labelNoiseScore", result["recentPredictions"][-1])
        self.assertIn("ambiguousBarrierPct", result["values"])
        self.assertIn("statisticalReliability", result)
        self.assertEqual(result["statisticalReliability"]["framework"], "weighted-wilson-backtest-reliability")
        self.assertIn("lowerBound", result["statisticalReliability"]["target"])
        self.assertIn("targetHitLowerBound", result["values"])

    def test_data_quality_gate_downweights_suspicious_candles_and_labels(self):
        rows = candles(260)
        rows[100]["close"] = rows[99]["close"] * 1.55
        rows[100]["high"] = rows[100]["close"] * 1.01
        rows[100]["low"] = rows[100]["close"] * 0.99
        rows[101]["volume"] = 0
        quality = assess_candle_quality(rows)
        self.assertIn("possible_split_or_provider_jump", quality["issueCounts"])
        self.assertGreater(quality["degradedRowPct"], 0)
        result = run_historical_backtest(
            rows,
            market="US",
            symbol="UNIT",
            horizon=10,
            target_upside=2,
            stop_loss=3,
            min_train=80,
            step=3,
        )
        self.assertTrue(result["available"])
        self.assertEqual(result["dataQuality"]["framework"], "point-in-time-candle-quality-gate")
        self.assertLess(result["metrics"]["effectiveSamples"], result["metrics"]["samples"])
        self.assertGreater(result["dataQuality"]["issueCounts"]["possible_split_or_provider_jump"], 0)

    def test_same_bar_target_and_stop_is_order_ambiguous_not_target_win(self):
        rows = [
            {"date": "2026-01-01", "open": 100, "high": 101, "low": 99, "close": 100, "volume": 1000},
            {"date": "2026-01-02", "open": 100, "high": 106, "low": 95, "close": 101, "volume": 1200},
            {"date": "2026-01-03", "open": 101, "high": 102, "low": 100, "close": 101, "volume": 1100},
        ]
        outcome = outcome_window(rows, 0, 2, target_upside=5, stop_loss=4)
        self.assertTrue(outcome["hitTarget"])
        self.assertTrue(outcome["hitStop"])
        self.assertTrue(outcome["ambiguousBarrierOrder"])
        self.assertEqual(outcome["firstBarrierEvent"], "ambiguous")
        self.assertFalse(outcome["targetWins"])
        self.assertFalse(outcome["stopWins"])

    def test_historical_label_enters_on_next_session_not_signal_close(self):
        rows = [
            {"date": "2026-01-01", "open": 99, "high": 101, "low": 98, "close": 100, "volume": 1000},
            {"date": "2026-01-02", "open": 110, "high": 112, "low": 108, "close": 111, "volume": 1200},
            {"date": "2026-01-03", "open": 111, "high": 114, "low": 109, "close": 113, "volume": 1100},
        ]
        outcome = outcome_window(rows, 0, 2, target_upside=5, stop_loss=4)
        self.assertEqual(outcome["entryPrice"], 110)
        self.assertEqual(outcome["entryDate"], "2026-01-02")
        self.assertEqual(outcome["entrySource"], "next_session_open")
        self.assertAlmostEqual(outcome["grossForwardReturn"], (113 / 110 - 1) * 100, places=6)

    def test_adaptive_barriers_scale_with_realized_volatility(self):
        quiet = panel_candles(120, drift=0.01, phase=0)
        volatile = panel_candles(120, drift=0.01, phase=0)
        for index, row in enumerate(volatile):
            row["high"] = row["close"] + 2.5 + (index % 3)
            row["low"] = row["close"] - 2.5 - (index % 2)
        quiet_barriers = adaptive_barriers(quiet, 90, 15, 5, 4)
        volatile_barriers = adaptive_barriers(volatile, 90, 15, 5, 4)
        self.assertGreater(volatile_barriers["targetPct"], quiet_barriers["targetPct"])
        self.assertGreater(volatile_barriers["stopPct"], quiet_barriers["stopPct"])

    def test_point_in_time_join_excludes_future_rows_without_counting_a_leak(self):
        item = {
            "pointInTimeFeatures": [
                {"event_time": "2025-02-01T08:00:00Z", "available_at": "2025-02-01T08:00:00Z", "historicalAvailabilityVerified": True, "values": {"eventSentiment": 0.7}},
                {"event_time": "2025-05-01T08:00:00Z", "available_at": "2025-05-01T08:00:00Z", "historicalAvailabilityVerified": True, "values": {"eventSentiment": -0.9}},
            ]
        }
        joined = point_in_time_features(item, "2025-03-01", "US")
        self.assertEqual(joined["sourceRows"], 1)
        self.assertEqual(joined["futureRowsExcluded"], 1)
        self.assertEqual(joined["joinViolationCount"], 0)
        self.assertGreater(joined["values"]["eventSentiment"], 0)

    def test_point_in_time_join_aggregates_event_sequence_instead_of_overwriting(self):
        joined = point_in_time_features({
            "pointInTimeFeatures": [
                {
                    "dataset": "news",
                    "event_time": "2025-02-20T08:00:00Z",
                    "available_at": "2025-02-20T08:00:00Z",
                    "historicalAvailabilityVerified": True,
                    "values": {
                        "eventSentiment": 0.8,
                        "eventRelevance": 1.0,
                        "sourceQuality": 1.0,
                        "positiveCatalyst": 1.0,
                        "eventIntensity": 0.8,
                    },
                },
                {
                    "dataset": "news",
                    "event_time": "2025-02-25T08:00:00Z",
                    "available_at": "2025-02-25T08:00:00Z",
                    "historicalAvailabilityVerified": True,
                    "values": {
                        "eventSentiment": -0.6,
                        "eventRelevance": 1.0,
                        "sourceQuality": 1.0,
                        "negativeCatalyst": 1.0,
                        "eventIntensity": 0.8,
                    },
                },
            ],
        }, "2025-03-01", "US")
        self.assertEqual(joined["sourceRows"], 2)
        self.assertGreater(joined["values"]["positiveCatalyst"], 0.0)
        self.assertGreater(joined["values"]["negativeCatalyst"], 0.0)
        self.assertGreater(joined["values"]["eventIntensity"], 0.0)
        self.assertEqual(joined["aggregationSchema"], "pit-event-aggregation-v8-date-cached-market-company-split")
        self.assertEqual(joined["companySourceRows"], 2)

    def test_unverified_point_in_time_rows_are_blocked_and_audited(self):
        joined = point_in_time_features({
            "pointInTimeFeatures": [{
                "event_time": "2025-02-01T08:00:00Z",
                "available_at": "2025-02-01T08:00:00Z",
                "historicalAvailabilityVerified": False,
                "values": {"eventSentiment": 1.0},
            }],
        }, "2025-03-01", "US")
        self.assertEqual(joined["sourceRows"], 0)
        self.assertEqual(joined["unverifiedRowsExcluded"], 1)
        self.assertEqual(joined["joinViolationCount"], 0)
        self.assertEqual(joined["excludedViolationCount"], 1)
        self.assertEqual(joined["values"]["eventSentiment"], 0.0)

    def test_pit_fundamental_dimensions_are_not_silently_zeroed(self):
        joined = point_in_time_features({
            "pointInTimeFeatures": [{
                "dataset": "fundamentals",
                "event_time": "2025-02-01T08:00:00Z",
                "available_at": "2025-02-01T08:00:00Z",
                "historicalAvailabilityVerified": True,
                "values": {"revenueGrowth": 0.20, "roe": 0.15},
            }],
        }, "2025-03-01", "US")
        self.assertAlmostEqual(joined["values"]["fundamentalRevenueGrowth"], 0.20)
        self.assertAlmostEqual(joined["values"]["fundamentalRoe"], 0.15)

    def test_training_snapshot_is_content_addressed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "ohlcv" / "market=US" / "exchange=US" / "interval=1d" / "symbol=AAPL"
            target.mkdir(parents=True)
            data = target / "data.parquet"
            data.write_bytes(b"v1")
            first = create_training_snapshot({"root": directory, "market": "US"})
            self.assertEqual(first["fileCount"], 1)
            data.write_bytes(b"v2")
            second = create_training_snapshot({"root": directory, "market": "US"})
            self.assertNotEqual(first["snapshotId"], second["snapshotId"])
            self.assertNotEqual(first["contentHash"], second["contentHash"])

    def test_company_and_market_pit_can_be_aggregated_separately_without_changing_time_boundary(self):
        company_bundle = _prepare_point_in_time_candidates({
            "pointInTimeFeatures": [{
                "dataset": "news",
                "event_time": "2025-02-01T08:00:00Z",
                "available_at": "2025-02-01T08:00:00Z",
                "historicalAvailabilityVerified": True,
                "values": {"eventSentiment": 0.8, "eventRelevance": 1.0, "sourceQuality": 1.0},
            }],
        })
        market_bundle = _prepare_point_in_time_candidates({}, [{
            "dataset": "macro",
            "event_time": "2025-02-01T00:00:00Z",
            "available_at": "2025-02-02T00:00:00Z",
            "historicalAvailabilityVerified": True,
            "values": {
                "macroRisk": -0.6,
                "macroVolatilityImpulse": -0.7,
                "macroDataCoverage": 1.0,
                "sourceQuality": 1.0,
                "__seriesId": "VIXCLS",
            },
        }])
        company = _point_in_time_features_from_prepared(company_bundle, "2025-03-01", "US")
        market = _point_in_time_features_from_prepared(market_bundle, "2025-03-01", "US")
        joined = _combine_company_market_point_in_time(company, market)
        self.assertGreater(joined["values"]["eventSentiment"], 0.0)
        self.assertLess(joined["values"]["macroRisk"], 0.0)
        self.assertLess(joined["values"]["macroVolatilityImpulse"], 0.0)
        self.assertEqual(joined["values"]["macroDataCoverage"], 1.0)
        self.assertEqual(joined["companySourceRows"], 1)
        self.assertEqual(joined["marketSourceRows"], 1)
        self.assertEqual(joined["sourceRows"], 2)
        self.assertEqual(joined["joinViolationCount"], 0)

    def test_cross_sectional_rank_label_prioritizes_path_then_return_tiebreak(self):
        rows = [
            {"date": "2025-01-02", "horizon": 5, "symbol": "LOSS", "actualReturn": -4.0, "actualTarget": 0.0, "actualStop": 1.0, "actualDirection": 0.0, "feature": {}, "crossSectionRaw": {}, "x": []},
            {"date": "2025-01-02", "horizon": 5, "symbol": "FLAT", "actualReturn": 0.2, "actualTarget": 0.0, "actualStop": 0.0, "actualDirection": 1.0, "feature": {}, "crossSectionRaw": {}, "x": []},
            {"date": "2025-01-02", "horizon": 5, "symbol": "WIN", "actualReturn": 6.0, "actualTarget": 1.0, "actualStop": 0.0, "actualDirection": 1.0, "feature": {}, "crossSectionRaw": {}, "x": []},
        ]
        _rank_cross_section(rows)
        by_symbol = {row["symbol"]: row for row in rows}
        self.assertEqual(by_symbol["LOSS"]["rankRelevance"], 0.0)
        self.assertEqual(by_symbol["WIN"]["rankRelevance"], 11.0)
        self.assertGreater(by_symbol["WIN"]["rankRelevance"], by_symbol["FLAT"]["rankRelevance"])
        self.assertGreater(by_symbol["FLAT"]["rankRelevance"], by_symbol["LOSS"]["rankRelevance"])
        self.assertEqual(by_symbol["WIN"]["returnRank"], 1.0)

    def test_rank_metrics_use_oof_relevance_and_do_not_double_charge_cost(self):
        rows = []
        for day in ("2026-01-01", "2026-01-02"):
            for index in range(10):
                gross = 1.0 if index < 3 else -0.5
                rows.append({
                    "date": day,
                    "symbol": str(index),
                    "market": "ASX",
                    "rankerPrediction": 1.0 - index / 10.0,
                    "actualReturn": gross - 0.18,
                    "actualGrossReturn": gross,
                    "actualReturnIsNet": True,
                    "transactionCostBps": 18.0,
                    "actualTarget": 1.0 if index == 0 else 0.0,
                    "actualStop": 1.0 if index >= 3 else 0.0,
                    "actualDirection": 1.0 if gross - 0.18 > 0 else 0.0,
                    "netUpLabel": 1.0 if gross - 0.18 > 0 else 0.0,
                    "sectorResidualUp": 1.0 if index < 3 else 0.0,
                    "topDecilePositive": 1.0 if index == 0 else 0.0,
                })
        result = rank_ic_summary(rows)
        self.assertEqual(result["ndcgAtK"], 1.0)
        self.assertEqual(result["topDecileNetReturn"], 0.82)
        self.assertGreater(result["top10DirectionLiftPct"], 0.0)
        self.assertEqual(result["costModel"], "actualReturn is net of round-trip transactionCostBps; legacy gross rows are adjusted once")

    def test_rank_metrics_require_real_date_level_relevance_for_ndcg(self):
        rows = []
        for day in range(30):
            current = (date(2025, 1, 1) + timedelta(days=day)).isoformat()
            for index in range(5):
                rows.append({
                    "date": current,
                    "symbol": f"S{day}-{index}",
                    "market": "ASX",
                    "rankerPrediction": 1.0 - index / 10.0,
                    "actualReturn": 2.0 if index == 0 else 0.5 if index == 1 else -0.5,
                    "actualTarget": 1.0 if index == 0 else 0.0,
                    "actualStop": 1.0 if index >= 3 else 0.0,
                    "actualDirection": 1.0 if index < 2 else 0.0,
                })
        result = rank_ic_summary(rows)
        self.assertTrue(result["ndcgAvailable"])
        self.assertEqual(result["ndcgDateCount"], 30)
        self.assertAlmostEqual(result["ndcgAtK"], 1.0)

        reversed_rows = [
            {**row, "rankerPrediction": 0.1 + index / 10.0}
            for index, row in enumerate(rows)
        ]
        reversed_result = rank_ic_summary(reversed_rows)
        self.assertTrue(reversed_result["ndcgAvailable"])
        self.assertLess(reversed_result["ndcgAtK"], result["ndcgAtK"])
    def test_cross_sectional_features_include_same_day_sector_and_tradability_context(self):
        rows = [
            {
                "date": "2025-01-02", "horizon": 5, "symbol": symbol,
                "sector": "Tech" if index < 3 else "Banks",
                "actualReturn": float(index), "actualTarget": 1.0 if index >= 4 else 0.0,
                "actualStop": 0.0, "actualDirection": 1.0 if index >= 3 else 0.0,
                "feature": {}, "x": [],
                "crossSectionRaw": {
                    "change5": float(index - 2), "change20": float(index - 2) * 2.0,
                    "volumeRatio": 1.0 + index / 10.0, "volatility": 2.0,
                    "dollarLiquidity": 10.0 + index, "trendQuality": float(index),
                    "pressureChange": float(index), "profileDistance": float(index),
                },
            }
            for index, symbol in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"])
        ]
        _rank_cross_section(rows)
        # Nine market ranks plus six sector slots are appended. A sector with
        # fewer than ten names is deliberately neutral under the new semantic
        # audit rather than being presented as reliable residual evidence.
        self.assertEqual(len(rows[0]["x"]), 15)
        self.assertAlmostEqual(rows[0]["x"][-4], 0.0)
        self.assertAlmostEqual(rows[5]["x"][-4], 0.0)
        self.assertIsNone(rows[0]["sectorResidualUp"])
        self.assertFalse(_sector_semantics_audit(rows)["eligible"])

    def test_direction_labels_are_sign_first_and_label_tournament_is_auditable(self):
        rows = []
        for index, symbol in enumerate(["LOSS", "SMALL", "BIG", "SECTOR"]):
            rows.append({
                "date": "2025-01-02", "horizon": 5, "symbol": symbol,
                "sector": "Tech" if symbol != "SECTOR" else "Banks",
                "actualReturn": [-2.0, 0.2, 4.0, 1.0][index],
                "actualTarget": 1.0 if symbol == "BIG" else 0.0,
                "actualStop": 1.0 if symbol == "LOSS" else 0.0,
                "actualDirection": 1.0 if index else 0.0,
                "targetBarrierPct": 3.0,
                "feature": {}, "crossSectionRaw": {}, "x": [],
            })
        _rank_cross_section(rows)
        by_symbol = {row["symbol"]: row for row in rows}
        self.assertEqual(by_symbol["LOSS"]["netUpLabel"], 0)
        self.assertEqual(by_symbol["SMALL"]["netUpLabel"], 1)
        self.assertIn("sectorResidualUp", by_symbol["SMALL"])
        tournament = label_tournament_summary(rows)
        self.assertEqual(tournament["schema"], "label-tournament-v1-sign-first-cost-aware")
        self.assertEqual(tournament["contracts"]["net_up"]["rows"], 4)
        self.assertEqual(tournament["contracts"]["top_decile_positive"]["positiveRows"], 1)

    def test_label_prevalence_is_monthly_and_cost_noise_can_block_production(self):
        rows = [
            {
                "date": "2024-01-15" if index < 600 else "2024-02-15",
                "market": "ASX",
                "actualGrossReturn": 0.15,
                "actualReturn": 0.05,
                "actualDirection": 1.0,
                "netUpLabel": 1.0,
                "actualTarget": 0.0,
                "actualStop": 0.0,
                "transactionCostBps": 10.0,
            }
            for index in range(1_200)
        ]
        prevalence = label_prevalence_report(rows)
        sensitivity = label_noise_sensitivity(rows)
        self.assertEqual(prevalence["monthCount"], 2)
        self.assertEqual(prevalence["months"][0]["netUpRatePct"], 100.0)
        self.assertTrue(sensitivity["available"])
        self.assertEqual(sensitivity["doubleCostFlipRatePct"], 100.0)
        self.assertTrue(sensitivity["unstable"])
        self.assertFalse(sensitivity["executionDelaySensitivity"]["available"])

    def test_expert_ensemble_audit_rejects_single_family_collapse(self):
        rows = [
            {"actualDirection": float(index % 2), "ridgeDirectionPrediction": 0.55, "elasticDirectionPrediction": 0.56}
            for index in range(20)
        ]
        audit = expert_ensemble_audit(
            rows,
            ["ridgeDirectionPrediction", "elasticDirectionPrediction"],
            [0.5, 0.5],
            actual_key="actualDirection",
        )
        self.assertTrue(audit["singleModelCollapse"])
        self.assertFalse(audit["productionEligible"])
        self.assertIn("linear_direction", audit["activeFamilies"])

    def test_local_model_split_keeps_each_signal_date_in_one_partition(self):
        rows = [
            {"date": (date(2024, 1, 1) + timedelta(days=day)).isoformat(), "symbol": f"S{symbol}"}
            for day in range(80) for symbol in range(5)
        ]
        train, validation, test = split_supervised_rows(rows)
        train_dates = {row["date"] for row in train}
        validation_dates = {row["date"] for row in validation}
        test_dates = {row["date"] for row in test}
        self.assertFalse(train_dates & validation_dates)
        self.assertFalse(train_dates & test_dates)
        self.assertFalse(validation_dates & test_dates)
        self.assertEqual(split_audit(rows)["dateOverlapCount"], 0)

    def test_market_dataset_and_purged_folds_keep_training_before_test(self):
        dataset = build_market_dataset(panel_items(230), market="US", horizons=[5], target_upside=3, stop_loss=3)
        self.assertGreater(dataset["summary"]["rawRows"], 500)
        self.assertEqual(dataset["summary"]["pointInTimeJoinViolationCount"], 0)
        self.assertIn("xsMomentum5Rank", dataset["summary"]["activeFeatureNames"])
        self.assertIn("logDollarVolume20", dataset["summary"]["activeFeatureNames"])
        self.assertIn("sectorRelativeMomentum5", dataset["summary"]["activeFeatureNames"])
        self.assertIn("actualDirection", dataset["rows"][0])
        self.assertEqual(len(dataset["rows"][0]["x"]), dataset["summary"]["activeFeatureCount"])
        self.assertGreater(dataset["rows"][0]["averageDollarVolume20"], 0.0)
        self.assertGreaterEqual(dataset["rows"][0]["dollarVolumeStability20"], 0.0)
        conservation = dataset["summary"]["outerCrossSectionRowConservation"]
        self.assertTrue(conservation["passed"])
        self.assertTrue(conservation["completeDailyCrossSection"])
        self.assertEqual(
            conservation["eligibleRows"],
            conservation["evaluatedRows"] + conservation["auditedExcludedRows"],
        )
        self.assertEqual(conservation["sampledRows"], conservation["evaluatedRows"])
        self.assertEqual(conservation["skippedRows"], 0)
        folds = purged_walk_forward_folds(dataset["rows"], horizon=5, fold_count=3, embargo_days=7, min_train_dates=70, test_dates=25)
        self.assertGreaterEqual(len(folds), 2)
        dates = sorted({row["date"] for row in dataset["rows"]})
        for fold in folds:
            train_index = dates.index(fold["trainEnd"])
            test_index = dates.index(fold["testStart"])
            self.assertGreaterEqual(test_index - train_index - 1, 12)

    def test_frozen_oof_signature_tracks_actual_test_membership(self):
        rows = [
            {"date": (date(2024, 1, 1) + timedelta(days=day)).isoformat(), "symbol": symbol}
            for day in range(100)
            for symbol in ("AAA", "BBB")
        ]
        first = frozen_oof_test_membership(
            rows,
            horizon=5,
            fold_count=3,
            embargo_days=7,
            min_train_dates=40,
            test_dates=12,
        )
        changed = [dict(row) for row in rows]
        changed[-1]["symbol"] = "CCC"
        second = frozen_oof_test_membership(
            changed,
            horizon=5,
            fold_count=3,
            embargo_days=7,
            min_train_dates=40,
            test_dates=12,
        )
        self.assertEqual(first["schema"], "frozen-oof-test-membership-v1")
        self.assertGreater(first["rowCount"], 0)
        self.assertTrue(first["trainMembershipHash"])
        self.assertTrue(first["testMembershipHash"])
        self.assertTrue(first["universeMembershipHash"])
        self.assertTrue(first["splitHash"])
        self.assertNotEqual(first["signature"], second["signature"])

    def test_market_dataset_date_stratified_sampling_keeps_cross_sections_bounded(self):
        full = build_market_dataset(panel_items(230), market="US", horizons=[5], target_upside=3, stop_loss=3)
        sampled = build_market_dataset(
            panel_items(230),
            market="US",
            horizons=[5],
            target_upside=3,
            stop_loss=3,
            panel_max_symbols=2,
            panel_date_stride=2,
        )
        sampling = sampled["summary"]["panelSampling"]
        by_day = defaultdict(list)
        for row in sampled["rows"]:
            by_day[row["date"]].append(row["symbol"])
        self.assertTrue(sampling["enabled"])
        self.assertLess(len(sampled["rows"]), len(full["rows"]))
        self.assertEqual(sampling["sampledPanelRows"], len(sampled["rows"]))
        self.assertEqual(sampling["eligiblePanelRows"], len(full["rows"]))
        self.assertTrue(all(len(set(symbols)) <= 2 for symbols in by_day.values()))

    def test_adjusted_prices_do_not_claim_verified_corporate_action_history(self):
        adjusted_only = panel_items(120)
        for item in adjusted_only:
            item["corporateActionAdjusted"] = True
            for index, candle in enumerate(item["candles"]):
                candle["date"] = (date(2024, 1, 2) + timedelta(days=index)).isoformat()
        dataset = build_market_dataset(adjusted_only, market="US", horizons=[5], target_upside=3, stop_loss=3)
        self.assertEqual(dataset["summary"]["adjustedPriceCoveragePct"], 100.0)
        self.assertEqual(dataset["summary"]["corporateActionCoveragePct"], 0.0)

        with_verified_history = panel_items(120)
        for item in with_verified_history:
            item["corporateActionAdjusted"] = True
            for index, candle in enumerate(item["candles"]):
                candle["date"] = (date(2024, 1, 2) + timedelta(days=index)).isoformat()
            item["corporateActions"] = [{
                "event_time": "2024-01-01T00:00:00Z",
                "available_at": "2024-01-01T00:00:00Z",
                "historicalAvailabilityVerified": True,
            }]
        verified = build_market_dataset(with_verified_history, market="US", horizons=[5], target_upside=3, stop_loss=3)
        self.assertEqual(verified["summary"]["adjustedPriceCoveragePct"], 100.0)
        self.assertEqual(verified["summary"]["corporateActionCoveragePct"], 100.0)

    def test_event_fold_predicts_each_oof_row_without_batch_shape_error(self):
        train = [
            {
                "eventCoverage": 1.0,
                "eventActionable": 1.0,
                "eventX": [1.0, index / 2_100.0, (index % 7) / 7.0],
                "actualTarget": 1.0 if index % 3 else 0.0,
                "trainingWeight": 1.0,
            }
            for index in range(2_100)
        ]
        test = [
            {"eventCoverage": 1.0, "eventActionable": 1.0, "eventX": [1.0, index / 20.0, (index % 5) / 5.0]}
            for index in range(20)
        ]
        predictions = _event_fold_predictions(train, test)
        self.assertEqual(len(predictions), len(test))
        self.assertTrue(all(0.0 <= value <= 1.0 for value in predictions))

        insufficient = _event_fold_predictions(train[:700], test)
        self.assertIsNone(insufficient)

    def test_market_dataset_quarantines_cross_market_and_duplicate_rows(self):
        items = panel_items(120)
        items[0]["market"] = "US"
        cross_market = {**items[1], "market": "ASX", "symbol": "BHP"}
        duplicate = {**items[0], "candles": [dict(row) for row in items[0]["candles"]]}
        dataset = build_market_dataset(
            [*items, cross_market, duplicate],
            market="US",
            horizons=[5],
            target_upside=3,
            stop_loss=3,
        )
        self.assertEqual(dataset["summary"]["crossMarketRowsExcluded"], 1)
        self.assertGreater(dataset["summary"]["duplicateRowsExcluded"], 0)
        identities = {
            (row["market"], row["symbol"], row["date"], row["horizon"])
            for row in dataset["rows"]
        }
        self.assertEqual(len(identities), len(dataset["rows"]))

    def test_model_reporting_metrics_use_strict_oof_rows(self):
        rows = []
        for index in range(40):
            actual = 1 if index % 2 == 0 else 0
            rows.append({
                "market": "US",
                "symbol": f"S{index % 8}",
                "date": f"2026-01-{index // 8 + 1:02d}",
                "actualTarget": actual,
                "ensembleProbability": 0.88 if actual else 0.12,
                "actualReturn": 2.0 if actual else -1.5,
                "rankerPrediction": 0.8 if actual else 0.2,
                "quantileP10": -2.0,
                "quantileP50": 1.5 if actual else -1.0,
                "quantileP90": 3.0,
            })
        metrics = classification_metrics(rows, "ensembleProbability")
        self.assertEqual(metrics["accuracyPct"], 100)
        self.assertEqual(metrics["precisionPct"], 100)
        self.assertEqual(metrics["recallPct"], 100)
        self.assertEqual(metrics["f1Pct"], 100)
        self.assertGreater(metrics["brierSkillScore"], 0)
        self.assertLess(metrics["ecePct"], 15)
        self.assertTrue(rank_metrics(rows)["available"])
        self.assertTrue(quantile_metrics(rows)["available"])
        interval = block_bootstrap_ci(
            rows,
            lambda sample: classification_metrics(sample, "ensembleProbability")["accuracyPct"],
            samples=100,
            seed=7,
        )
        self.assertTrue(interval["available"])
        self.assertEqual(interval["low"], 100)
        self.assertEqual(interval["high"], 100)

    def test_metric_contract_returns_null_for_single_class_balanced_accuracy(self):
        rows = [
            {"date": f"2026-01-{index + 1:02d}", "p": 0.8, "y": 1}
            for index in range(12)
        ]
        metrics = strict_classification_metrics(rows, "p", "y", baseline_probability=0.5)
        self.assertIsNone(metrics["balancedAccuracyPct"])
        self.assertIsNone(metrics["mcc"])
        self.assertEqual(metrics["metricStatus"], "PARTIAL_SINGLE_CLASS")
        self.assertIn("balancedAccuracyPct", metrics["undefinedMetrics"])

    def test_metric_contract_brier_skill_uses_training_prevalence(self):
        rows = [
            {"date": f"2026-01-{index + 1:02d}", "p": 0.9 if index % 2 == 0 else 0.1, "y": 1 - (index % 2)}
            for index in range(20)
        ]
        metrics = strict_classification_metrics(rows, "p", "y", baseline_probability=0.5)
        self.assertEqual(metrics["baselineSource"], "explicit-frozen-training-prevalence")
        explicit = strict_classification_metrics(rows, "p", "y", baseline_rows=[{"y": 1}] * 3 + [{"y": 0}] * 7)
        self.assertEqual(explicit["baselineSource"], "training-window-prevalence")
        self.assertGreater(explicit["brierSkillScore"], 0)
        self.assertEqual(len(explicit["reliabilityCurve"]), 2)

    def test_metric_contract_ranking_excludes_narrow_dates_and_keeps_ndcg_nonzero(self):
        rows = []
        for day in range(6):
            for symbol in range(35):
                value = (symbol + 1) / 35
                rows.append({
                    "date": f"2026-02-{day + 1:02d}",
                    "symbol": f"S{symbol}",
                    "score": value,
                    "actualReturn": value,
                })
        rows.extend({"date": "2026-03-01", "symbol": f"N{idx}", "score": idx, "actualReturn": idx} for idx in range(5))
        metrics = strict_ranking_metrics(rows, "score", min_symbols_per_date=30)
        self.assertEqual(metrics["excludedSmallDates"], 1)
        self.assertEqual(metrics["rankIcIndependentDates"], 6)
        self.assertIsNotNone(metrics["ndcgAt10"])
        self.assertGreater(metrics["ndcgAt10"], 0.99)
        self.assertEqual(metrics["top10DirectionHitRatePct"], 100)

    def test_metric_contract_paired_comparison_refuses_incomparable_panels(self):
        candidate = [{"market": "ASX", "symbol": "AAA", "date": str(index), "actualReturn": 1} for index in range(9)]
        baseline = [{"market": "ASX", "symbol": "AAA", "date": str(index), "actualReturn": 0} for index in range(20)]
        comparison = paired_comparison(candidate, baseline, identity_keys=("market", "symbol", "date"))
        self.assertFalse(comparison["available"])
        self.assertEqual(comparison["status"], "INCOMPARABLE")
        self.assertNotIn("differenceMean", comparison)

    def test_metric_contract_bootstrap_has_frozen_block_lengths_and_minimum_repetitions(self):
        result = paired_block_bootstrap([(f"2026-01-{index + 1:02d}", 0.01 * index) for index in range(25)])
        self.assertTrue(result["available"])
        self.assertEqual(result["primaryBlockDays"], 10)
        self.assertTrue(all(row["repetitions"] >= 600 for row in result["blocks"].values()))
        self.assertTrue(all(key in result["blocks"] for key in ("5", "10", "20")))

    def test_metric_contract_turnover_and_positive_fold_are_explicit(self):
        turnover = turnover_and_cost({"AAA": 0.5}, {"AAA": 0.25, "BBB": 0.25}, commission_bps=10, impact_bps=5)
        self.assertEqual(turnover["oneWayTurnoverPct"], 50)
        self.assertEqual(turnover["estimatedCostPct"], 0.075)
        self.assertFalse(positive_fold_contract(balanced_accuracy_pct=None, brier_skill_score=0.1, top10_net_lift_pct=0.2)["positive"])

    def test_metric_contract_manifest_is_versioned_and_defines_missing_policy(self):
        manifest = metric_contract_manifest()
        self.assertEqual(manifest["schema"], "metric-contract-5d-v2")
        self.assertTrue(manifest["undefinedMetricPolicy"]["neverUseZeroAsMissing"])
        self.assertEqual(manifest["confidenceIntervals"]["primaryBlockDays"], 10)

    def test_label_contract_uses_next_session_entry_and_persists_atomic_time_axis(self):
        rows = [
            {"date": f"2026-03-{index + 1:02d}", "open": 100 + index, "high": 102 + index, "low": 99 + index, "close": 101 + index, "volume": 1000}
            for index in range(8)
        ]
        label = build_atomic_label(rows, 0, 5, costs={"commissionBps": 5, "spreadBps": 2})
        self.assertEqual(label["contract"], LABEL_CONTRACT_VERSION)
        self.assertEqual(label["entryTimestamp"], "2026-03-02")
        self.assertEqual(label["entrySource"], "next_session_open")
        self.assertEqual(label["exitTimestamp"], "2026-03-06")
        self.assertEqual(len(label["overnightReturnPct"]), 5)
        self.assertEqual(len(label["intradayReturnPct"]), 5)
        self.assertEqual(label["cost"]["totalRoundTripBps"], 7)
        self.assertEqual(label["netUpLabel"], label["netReturnPct"] > 0)

    def test_label_contract_excludes_ambiguous_path_but_keeps_direction_label(self):
        rows = [
            {"date": f"2026-04-{index + 1:02d}", "open": 100, "high": 110 if index == 1 else 102, "low": 90 if index == 1 else 99, "close": 100, "volume": 1000}
            for index in range(7)
        ]
        label = build_atomic_label(rows, 0, 5, target_pct=5, stop_pct=5)
        self.assertTrue(label["ambiguousBarrierOrder"])
        self.assertFalse(label["pathEligible"])
        self.assertIn(label["firstBarrierEvent"], {"ambiguous", "timeout"})
        self.assertIn("netUpLabel", label)

    def test_label_panel_uses_leave_one_out_market_and_breadth_gated_sector_residual(self):
        items = []
        for index in range(12):
            rows = [
                {"date": f"2026-05-{day + 1:02d}", "open": 100 + index + day, "high": 102 + index + day, "low": 99 + index + day, "close": 101 + index + day, "volume": 1000}
                for day in range(8)
            ]
            items.append({"market": "ASX", "symbol": f"S{index:02d}", "sector": "Banks", "candles": rows})
        labels = build_panel_labels(items, 1, min_sector_breadth=10, min_cross_section_breadth=10)
        self.assertTrue(labels)
        self.assertTrue(all(row["market"] == "ASX" for row in labels))
        self.assertTrue(all(row["sectorResidualEligible"] for row in labels))
        self.assertTrue(all(row["crossSectionEligible"] for row in labels))
        self.assertTrue(all(row["marketResidualReturnPct"] is not None for row in labels))

    def test_label_contract_purged_walk_forward_has_no_date_overlap(self):
        dates = [f"2026-06-{index + 1:02d}" for index in range(80)]
        splits = purged_walk_forward_splits(dates, horizon=5, embargo_days=7, n_splits=5, min_train_dates=20, min_test_dates=8)
        self.assertGreaterEqual(len(splits), 5)
        self.assertTrue(all(row["overlap"] is False for row in splits))
        self.assertTrue(all(row["trainEndBeforeTestStart"] for row in splits))
        self.assertTrue(all(row["trainDates"][-1] < row["testDates"][0] for row in splits))

    def test_label_contract_volatility_scale_uses_only_pre_signal_history(self):
        result = volatility_scaled_return(2.0, [-1.0, 0.0, 1.0, 2.0], floor_pct=0.1)
        self.assertTrue(result["available"])
        self.assertTrue(result["historyIsPreSignal"])
        self.assertEqual(result["historyCount"], 4)
        self.assertGreater(result["value"], 0)
        self.assertFalse(volatility_scaled_return(2.0, [1.0])["available"])

    def test_label_contract_event_car_requires_first_publication_time(self):
        event = {"event_time": "2026-07-01T00:00:00Z", "available_at": "2026-07-02T00:00:00Z"}
        result = event_car_label(event, event_return_pct=3.0, benchmark_return_pct=1.0, horizon=3)
        self.assertTrue(result["available"])
        self.assertEqual(result["carPct"], 2.0)
        self.assertTrue(event_car_label({"event_time": "2026-07-01T00:00:00Z"}, event_return_pct=1, benchmark_return_pct=1, horizon=1)["available"] is False)

    def test_model_report_promotion_has_no_external_ai_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry_dir = root / ".cache" / "models" / "registry" / "us"
            registry_dir.mkdir(parents=True)
            registry = {
                "manifest": {"model_version": "us-deterministic-test", "deployment_status": "research"},
                "dataset": {},
                "horizonModels": [{"horizon": 5, "available": False, "reason": "fixture without OOF"}],
                "productionEligibility": {"eligible": False, "reason": "fixture"},
            }
            (registry_dir / "registry.json").write_text(json.dumps(registry), "utf-8")
            (registry_dir / "index.json").write_text(json.dumps({"latest": {"filename": "registry.json"}}), "utf-8")
            report = market_report(root, "US")
            gate_ids = {
                check["id"]
                for model in report["models"]
                for check in model.get("hardGate", {}).get("checks", [])
            }
            self.assertNotIn("ai_supervisor_consensus", gate_ids)
            self.assertFalse(any(model.get("family") == "ai_supervisor" for model in report["models"]))
            self.assertNotIn("aiSupervisorApprovals", report["counts"])

    def test_model_report_job_summary_reads_bounded_headers_from_large_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs = root / ".cache" / "background-jobs"
            jobs.mkdir(parents=True)
            complete = jobs / "backtest-large.json"
            complete.write_text(
                '{"id":"backtest-large","type":"backtest","runtimeVersion":3,'
                '"market":"CN","status":"complete","createdAt":"2026-08-10T00:00:00Z",'
                '"updatedAt":"2026-08-10T00:01:00Z","result":{"rows":"'
                + ("x" * 2_000_000)
                + '"}}',
                "utf-8",
            )
            failed = jobs / "backtest-failed.json"
            failed.write_text(
                '{"id":"backtest-failed","type":"backtest","runtimeVersion":3,'
                '"market":"CN","status":"failed","failureCategory":"oof_training",'
                '"createdAt":"2026-08-10T00:02:00Z","updatedAt":"2026-08-10T00:03:00Z"}',
                "utf-8",
            )
            self.assertEqual(_job_header(complete)["status"], "complete")
            summary = _job_summary(root)
            self.assertEqual(summary["total"], 2)
            self.assertEqual(summary["status"]["complete"], 1)
            self.assertEqual(summary["failureCategories"]["oof_training"], 1)

    def test_direction_reporting_uses_final_return_label_not_target_path(self):
        rows = [
            {
                "date": f"2026-02-{index + 1:02d}",
                "actualTarget": 0,
                "actualDirection": 1 if index % 2 == 0 else 0,
                "directionProbability": 0.8 if index % 2 == 0 else 0.2,
                "actualReturn": 1.0 if index % 2 == 0 else -1.0,
            }
            for index in range(20)
        ]
        metrics = classification_metrics(rows, "directionProbability", "actualDirection")
        self.assertEqual(metrics["balancedAccuracyPct"], 100)
        self.assertGreater(metrics["brierSkillScore"], 0)

    def test_reporting_auc_handles_tied_scores_with_rank_statistic(self):
        rows = [
            {"date": "2026-03-01", "actualDirection": 0, "directionProbability": 0.1},
            {"date": "2026-03-02", "actualDirection": 1, "directionProbability": 0.2},
            {"date": "2026-03-03", "actualDirection": 0, "directionProbability": 0.2},
            {"date": "2026-03-04", "actualDirection": 1, "directionProbability": 0.9},
        ]
        metrics = classification_metrics(rows, "directionProbability", "actualDirection")
        self.assertEqual(metrics["rocAuc"], 0.875)

    def test_prediction_id_is_stable_and_versioned(self):
        row = {
            "market": "US",
            "symbol": "AAPL",
            "signalAt": "2026-01-05T21:00:00Z",
            "horizon": 15,
        }
        manifest = {
            "label_definition": "triple-barrier-v2",
            "feature_schema_hash": "features-v4",
            "model_version": "us-15d-v1",
        }
        first = prediction_id(row, manifest)
        self.assertEqual(first, prediction_id(dict(row), dict(manifest)))
        self.assertNotEqual(first, prediction_id(row, {**manifest, "model_version": "us-15d-v2"}))

    def test_oof_reader_deduplicates_and_quarantines_cross_market_rows(self):
        manifest = {
            "label_definition": "triple-barrier-v2",
            "feature_schema_hash": "features-v4",
            "model_version": "us-15d-v1",
        }
        valid = {
            "market": "US",
            "symbol": "AAPL",
            "date": "2026-01-05",
            "signalAt": "2026-01-05T21:00:00Z",
            "availableAt": "2026-01-05T20:00:00Z",
            "horizon": 15,
            "actualTarget": 1,
            "ensembleProbability": 0.7,
        }
        cross_market = {**valid, "market": "ASX", "symbol": "BHP"}
        future = {
            **valid,
            "symbol": "MSFT",
            "availableAt": "2026-01-06T01:00:00Z",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "oof.jsonl.gz"
            with gzip.open(path, "wt", encoding="utf-8") as stream:
                for row in (valid, dict(valid), cross_market, future):
                    stream.write(json.dumps(row) + "\n")
            clean, audit = read_oof_rows(path, manifest, "US")
        self.assertEqual(len(clean), 2)
        self.assertEqual(audit["duplicateRows"], 1)
        self.assertEqual(audit["crossMarketRows"], 1)
        self.assertEqual(audit["futureAvailabilityRows"], 1)

    def test_report_evidence_is_honest_when_registries_are_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            evidence = build_report_evidence(Path(temp_dir), ["ASX", "US", "CN"])
        self.assertFalse(evidence["productionReady"])
        self.assertEqual(len(evidence["markets"]), 3)
        self.assertTrue(all(not market["registryAvailable"] for market in evidence["markets"]))
        self.assertTrue(all("no market-level registry" in blocker for blocker in evidence["blockers"]))

    def test_model_report_quarantines_legacy_factor_admission(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            directory = root / ".cache" / "models" / "factor-research"
            directory.mkdir(parents=True)
            (directory / "asx-bhp.json").write_text(json.dumps({
                "market": "ASX",
                "symbol": "BHP.AX",
                "sampleCount": 500,
                "candidateCount": 12,
                "admittedCount": 7,
                "mlBacktest": {"active": True},
            }), "utf-8")
            report = factor_model_reports(root, "ASX")[0]
        self.assertEqual(report["status"], "quarantined")
        self.assertTrue(report["legacyQuarantined"])
        self.assertEqual(report["reportedAdmittedCount"], 7)
        self.assertEqual(report["admittedCount"], 0)
        self.assertFalse(report["eligibleForLiveWeight"])

    def test_worker_generates_json_html_and_word_model_report(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            result = dispatch({
                "operation": "model-report-generate",
                "root": temp_dir,
                "markets": ["US"],
            })
            self.assertTrue(Path(result["jsonPath"]).exists())
            self.assertTrue(Path(result["htmlPath"]).exists())
            self.assertTrue(Path(result["docxPath"]).exists())
            self.assertTrue(Path(result["permanentDocxPath"]).exists())
            self.assertFalse(result["evidence"]["productionReady"])

    def test_constrained_stack_is_non_negative_normalized_and_capped(self):
        rows = []
        for index in range(120):
            actual = 1.0 if index % 4 in {0, 1} else 0.0
            rows.append({
                "actualTarget": actual,
                "evaluationWeight": 1.0,
                "a": 0.78 if actual else 0.22,
                "b": 0.68 if actual else 0.32,
                "c": 0.58 if actual else 0.42,
            })
        weights = fit_constrained_stack(rows, ["a", "b", "c"], cap=0.4)
        self.assertAlmostEqual(sum(weights), 1.0, places=7)
        self.assertTrue(all(0 <= value <= 0.400001 for value in weights))

    def test_meta_stack_rejects_models_worse_than_the_class_prior(self):
        rows = [
            {
                "actualTarget": target,
                "evaluationWeight": 1.0,
                "good": 0.8 if target else 0.2,
                "bad": 0.1 if target else 0.9,
            }
            for target in ([0, 1] * 80)
        ]
        kept, rejected = brier_skilled_models(rows, ["good", "bad"])
        self.assertEqual(kept, ["good"])
        self.assertEqual(rejected[0]["model"], "bad")

    def test_meta_stack_returns_null_when_every_candidate_is_worse_than_prior(self):
        rows = [
            {
                "actualTarget": target,
                "evaluationWeight": 1.0,
                "badA": 0.9 if target == 0 else 0.1,
                "badB": 0.8 if target == 0 else 0.2,
            }
            for target in ([0, 1] * 80)
        ]
        kept, rejected = brier_skilled_models(rows, ["badA", "badB"])
        self.assertEqual(kept, [])
        self.assertEqual({row["model"] for row in rejected}, {"badA", "badB"})
        self.assertTrue(all("negative-meta-train-brier-skill" in row["because"] for row in rejected))

    def test_null_feature_profile_propagates_without_fitting_a_fallback(self):
        fold = {
            "fold": 1,
            "train": [{"date": "2024-01-01", "symbol": "AAA", "x": [1.0]}],
            "test": [{"date": "2024-01-02", "symbol": "AAA", "x": [1.0]}],
        }
        with patch.object(production_training, "_training_stable_feature_panel", return_value=(fold["train"], fold["test"], {})), \
                patch.object(production_training, "_training_feature_family_gate", return_value=(fold["train"], fold["test"], {})), \
                patch.object(production_training, "_training_feature_profile_gate", return_value=(fold["train"], fold["test"], {"selectedProfile": "null/no-model", "nullReason": "unit-test-null"})):
            predictions, metadata = _fold_oof_predictions(
                fold,
                enable_tree_models=True,
                enable_sklearn_models=True,
                config={},
            )
        self.assertEqual(predictions, [])
        self.assertEqual(metadata["status"], "NO_MODEL")
        self.assertEqual(metadata["candidateStatus"], "NO_MODEL")
        self.assertEqual(metadata["nullModelContractVersion"], "no-model-propagation-v2")

    def test_linear_direction_null_does_not_discard_independent_tree_direction_evidence(self):
        train = []
        test = []
        for day_index in range(12):
            day = (date(2023, 1, 1) + timedelta(days=day_index)).isoformat()
            for symbol_index in range(4):
                row = {
                    "date": day,
                    "symbol": f"AAA{symbol_index}",
                    "market": "ASX",
                    "horizon": 5,
                    "x": [0.1, 0.2],
                    "featureNames": ["change5", "volumeRatio"],
                    "actualTarget": float((day_index + symbol_index) % 2 == 0),
                    "actualStop": float((day_index + symbol_index) % 3 == 0),
                    "actualTimeout": 0.0,
                    "actualDirection": float((day_index + symbol_index) % 2 == 0),
                    "actualReturn": 0.5 if (day_index + symbol_index) % 2 == 0 else -0.25,
                    "actualGrossReturn": 0.6 if (day_index + symbol_index) % 2 == 0 else -0.2,
                    "actualReturnIsNet": True,
                    "targetBarrierPct": 5.0,
                    "stopBarrierPct": 4.0,
                    "regime": "normal",
                    "sector": "materials",
                    "dataQualityScore": 1.0,
                    "evaluationWeight": 1.0,
                    "transactionCostBps": 18.0,
                    "entrySource": "next-session-open",
                }
                (train if day_index < 9 else test).append(row)
        baseline = {
            "baselineReturn": [0.02 for _ in test],
            "direction": [0.7 for _ in test],
            "elasticDirection": [0.65 for _ in test],
            "target": [0.6 for _ in test],
            "elasticTarget": [0.58 for _ in test],
            "stop": [0.2 for _ in test],
            "timeout": [0.2 for _ in test],
            "rank": [float(index) for index in range(len(test))],
            "family": "test-baseline",
            "trainingRows": len(train),
            "fullTrainingRows": len(train),
        }
        tree = {
            "target": [0.62 for _ in test],
            "challengerTarget": [0.61 for _ in test],
            "stop": [0.18 for _ in test],
            "timeout": [0.2 for _ in test],
            "rank": [float(index + 1) for index in range(len(test))],
            "directionRank": [float(index + 1) for index in range(len(test))],
            "direction": [0.72 for _ in test],
            "quantiles": [
                [-0.5 for _ in test],
                [0.2 for _ in test],
                [0.8 for _ in test],
            ],
            "family": "test-tree",
            "trainingPolicy": {"sampledTrainingRows": len(train), "fitRows": len(train), "validationRows": 4},
        }
        with patch.object(production_training, "_training_stable_feature_panel", return_value=(train, test, {})), \
                patch.object(production_training, "_training_feature_family_gate", return_value=(train, test, {})), \
                patch.object(production_training, "_training_feature_profile_gate", return_value=(train, test, {"selectedProfile": "null/no-model", "nullReason": "direction-only-test-null"})), \
                patch.object(production_training, "_sklearn_baseline_predictions", return_value=baseline), \
                patch.object(production_training, "_tree_fold_predictions", return_value=tree), \
                patch.object(production_training, "_event_fold_predictions", return_value=None), \
                patch.object(production_training, "_date_level_regime_predictions", return_value=None):
            predictions, metadata = _fold_oof_predictions(
                {
                    "fold": 1,
                    "train": train,
                    "test": test,
                    "trainDates": sorted({row["date"] for row in train}),
                    "testDates": sorted({row["date"] for row in test}),
                    "trainEnd": max(row["date"] for row in train),
                    "testStart": min(row["date"] for row in test),
                    "testEnd": max(row["date"] for row in test),
                    "purgeDays": 5,
                    "embargoDays": 7,
                },
                enable_tree_models=True,
                enable_sklearn_models=True,
                config={},
            )
        self.assertEqual(len(predictions), len(test))
        self.assertEqual(metadata["status"], "COMPLETE")
        self.assertEqual(metadata["candidateStatus"], "AVAILABLE")
        self.assertEqual(metadata["directionModelStatus"], "RESEARCH_CANDIDATE")
        self.assertEqual(metadata["directionFamilyGate"]["linear"], "NO_MODEL")
        self.assertEqual(metadata["directionFamilyGate"]["tree"], "RESEARCH_CANDIDATE")
        self.assertTrue(all(row["ridgeDirectionPrediction"] is None for row in predictions))
        self.assertTrue(all(row["treeDirectionPrediction"] is not None for row in predictions))
        self.assertTrue(all(row["rankerPrediction"] is not None for row in predictions))

    def test_direction_selection_returns_null_when_all_inner_windows_are_worse_than_prior(self):
        rows = []
        for day_index in range(360):
            for symbol_index in range(5):
                actual = float((day_index + symbol_index) % 2 == 0)
                rows.append({
                    "date": (date(2021, 1, 1) + timedelta(days=day_index)).isoformat(),
                    "actualDirection": actual,
                    "evaluationWeight": 1.0,
                    "invertedDirection": 0.02 if actual else 0.98,
                })
        selected, rejected, audit = select_robust_direction_models(rows, ["invertedDirection"])
        self.assertEqual(selected, [])
        self.assertEqual(audit["status"], "NO_MODEL")
        self.assertEqual(rejected[0]["because"], "no-model-beats-null-across-required-windows")

    def test_isotonic_requires_independent_dates_not_only_many_stock_rows(self):
        probabilities = [0.35, 0.65] * 2500
        actuals = [0.0, 1.0] * 2500
        calibrator = fit_probability_calibrator(probabilities, actuals, independent_dates=60)
        self.assertEqual(calibrator["method"], "shrinkage")
        self.assertLessEqual(calibrator["alpha"], 0.5)

    def test_large_isotonic_calibration_uses_bounded_pure_python_pav(self):
        probabilities = [0.20, 0.40, 0.60, 0.80] * 1500
        actuals = [0.0, 0.0, 1.0, 1.0] * 1500
        calibrator = fit_probability_calibrator(probabilities, actuals, independent_dates=180)
        self.assertEqual(calibrator["method"], "isotonic")
        self.assertEqual(calibrator["implementation"], "pure-python-pool-adjacent-violators")
        self.assertLessEqual(calibrator["blocks"], 4)
        self.assertEqual(calibrator["inputRows"], 6000)

    def test_calibrator_method_is_selected_on_chronological_holdout(self):
        probabilities = []
        actuals = []
        dates = []
        for day in range(50):
            current = (date(2020, 1, 1) + timedelta(days=day)).isoformat()
            for index in range(20):
                actual = 1.0 if index % 2 else 0.0
                probabilities.append(0.72 if actual else 0.28)
                actuals.append(actual)
                dates.append(current)
        calibrator = fit_probability_calibrator(
            probabilities,
            actuals,
            independent_dates=50,
            dates=dates,
        )
        self.assertIn(calibrator["method"], {"identity", "shrinkage", "platt"})
        self.assertEqual(calibrator["selection"]["validationDates"], 10)
        self.assertEqual(calibrator["selection"]["validationRows"], 200)
        self.assertIn(calibrator["selection"]["selectedMethod"], {"identity", "shrinkage", "platt"})

    def test_direction_metrics_report_selective_high_confidence_accuracy(self):
        rows = []
        probabilities = []
        for index in range(1000):
            actual = 1.0 if index % 2 else 0.0
            confident = index < 100
            probability = (0.92 if actual else 0.08) if confident else (0.51 if actual else 0.49)
            rows.append({
                "date": (date(2020, 1, 1) + timedelta(days=index // 5)).isoformat(),
                "actualDirection": actual,
                "actualReturn": 1.0 if actual else -1.0,
                "evaluationWeight": 1.0,
            })
            probabilities.append(probability)
        metrics = calibration_metrics(rows, probabilities, actual_key="actualDirection")
        self.assertEqual(metrics["selectiveTop10CoveragePct"], 10.0)
        self.assertEqual(metrics["selectiveTop10AccuracyPct"], 100.0)
        self.assertGreater(metrics["selectiveTop10Accuracy95LowerPct"], 90.0)

    def test_brier_baseline_probability_is_fixed_by_training_window(self):
        rows = [
            {
                "date": (date(2024, 1, 1) + timedelta(days=index)).isoformat(),
                "actualDirection": 1.0 if index < 8 else 0.0,
                "actualReturn": 1.0 if index < 8 else -1.0,
                "evaluationWeight": 1.0,
            }
            for index in range(10)
        ]
        first = calibration_metrics(
            rows,
            [0.55 for _ in rows],
            actual_key="actualDirection",
            baseline_probability=0.42,
        )
        inverted = [{**row, "actualDirection": 1.0 - row["actualDirection"]} for row in rows]
        second = calibration_metrics(
            inverted,
            [0.55 for _ in inverted],
            actual_key="actualDirection",
            baseline_probability=0.42,
        )
        self.assertEqual(first["baselineProbability"], 0.42)
        self.assertEqual(second["baselineProbability"], 0.42)
        self.assertEqual(first["baselineSource"], "training-window-prevalence")

    def test_nested_direction_threshold_is_train_only_and_reports_no_trade_coverage(self):
        rows = []
        probabilities = []
        for day in range(24):
            current = (date(2022, 1, 1) + timedelta(days=day)).isoformat()
            for symbol in range(10):
                positive = symbol < 6
                probability = 0.58 if positive else 0.44
                rows.append({
                    "date": current,
                    "symbol": f"S{symbol}",
                    "actualDirection": 1.0 if positive else 0.0,
                })
                probabilities.append(probability)
        selection = fit_nested_direction_threshold(rows, probabilities, horizon=5)
        self.assertTrue(selection["available"])
        self.assertGreaterEqual(selection["validationBlocks"], 3)
        self.assertGreater(selection["candidateCount"], 0)
        holdout_metrics = thresholded_direction_metrics(
            rows,
            probabilities,
            threshold=selection["selectedThreshold"],
            abstain_margin=selection["abstainMargin"],
        )
        self.assertGreaterEqual(holdout_metrics["coveragePct"], 50.0)
        self.assertIn("relativeMajorityAccuracyPct", holdout_metrics)
        self.assertIn("matthewsCorrelation", holdout_metrics)

    def test_false_positive_risk_head_uses_inner_validation_and_never_raises_scores(self):
        train_rows = []
        train_probabilities = []
        for index in range(720):
            high = index % 4 == 0
            false_positive = high and index % 8 == 0
            actual = 0.0 if false_positive else 1.0 if high else float(index % 2)
            train_rows.append({
                "date": (date(2018, 1, 1) + timedelta(days=index)).isoformat(),
                "x": [1.0 if false_positive else 0.0, index % 7 / 7],
                "actualDirection": actual,
                "actualReturn": 1.0 if actual else -1.0,
                "liquidityWeight": 1.0,
                "dataQuality": 0.9,
                "evaluationWeight": 1.0,
            })
            train_probabilities.append(0.9 if high else 0.45)
        test_rows = []
        test_probabilities = []
        for index in range(160):
            high = index % 4 == 0
            false_positive = high and index % 8 == 0
            actual = 0.0 if false_positive else 1.0 if high else float(index % 2)
            test_rows.append({
                "date": (date(2024, 1, 1) + timedelta(days=index)).isoformat(),
                "x": [1.0 if false_positive else 0.0, index % 7 / 7],
                "actualDirection": actual,
                "actualReturn": 1.0 if actual else -1.0,
                "liquidityWeight": 1.0,
                "dataQuality": 0.9,
                "evaluationWeight": 1.0,
            })
            test_probabilities.append(0.9 if high else 0.45)
        result = fit_false_positive_risk_head(train_rows, test_rows, train_probabilities, test_probabilities)
        self.assertTrue(result["available"])
        self.assertEqual(result["innerPurgeDates"], 12)
        self.assertTrue(all(adjusted <= original + 1e-12 for adjusted, original in zip(result["probabilities"], test_probabilities)))
        self.assertIn("inner validation", result["reason"].lower())

    def test_false_positive_diagnostics_use_the_persisted_compact_feature_vector(self):
        rows = []
        probabilities = []
        for index in range(100):
            high = index >= 90
            actual = 0.0 if index % 2 == 0 else 1.0
            rows.append({
                "date": (date(2025, 1, 1) + timedelta(days=index // 5)).isoformat(),
                "symbol": f"S{index}",
                "actualDirection": actual,
                "actualReturn": 1.0 if actual else -1.0,
                "liquidityWeight": 1.0,
                "dataQuality": 100.0,
                "regime": "range",
                "sector": "general",
                "falsePositiveFeatures": [2.0 if high and not actual else 0.25, 0.0],
            })
            probabilities.append(0.9 + index / 10_000 if high else 0.2 + index / 1_000)
        result = diagnostic_bucket_summary(rows, probabilities)
        library = result["highConfidenceFalsePositiveLibrary"]
        self.assertGreater(library["falsePositiveCount"], 0)
        self.assertTrue(library["featureDeltas"])
        self.assertEqual(library["featureDeltas"][0]["feature"], "change5")

    def test_selective_ranking_head_uses_inner_dates_and_leaves_final_test_untouched(self):
        def make_rows(start: date, days: int):
            rows = []
            direction = []
            target = []
            for day in range(days):
                current = (start + timedelta(days=day)).isoformat()
                for symbol in range(20):
                    positive = symbol < 6
                    probability = 0.90 if positive else 0.10
                    rows.append({
                        "date": current,
                        "symbol": f"S{symbol:02d}",
                        "rankerPrediction": (symbol + 1) / 20,
                        "pathSafetyPrediction": probability,
                        "stopProbability": 1.0 - probability,
                        "quantileP50": 2.0 if positive else -1.0,
                        "baselineReturn": 1.5 if positive else -0.8,
                        "liquidityWeight": 1.0,
                        "actualDirection": 1.0 if positive else 0.0,
                        "actualTarget": 1.0 if positive else 0.0,
                        "actualStop": 0.0 if positive else 1.0,
                        "actualReturn": 2.0 if positive else -1.0,
                        "evaluationWeight": 1.0,
                    })
                    direction.append(probability)
                    target.append(probability)
            return rows, direction, target

        train_rows, train_direction, train_target = make_rows(date(2023, 1, 1), 120)
        test_rows, test_direction, test_target = make_rows(date(2025, 1, 1), 40)
        result = fit_selective_ranking_head(
            train_rows,
            test_rows,
            train_direction,
            test_direction,
            train_target,
            test_target,
        )
        self.assertTrue(result["available"])
        self.assertTrue(result["active"])
        self.assertNotEqual(result["selected"], "rank-only")
        self.assertEqual(result["innerPurgeDates"], 12)
        self.assertEqual(len(result["scores"]), len(test_rows))
        first_day_scores = result["scores"][:20]
        self.assertGreater(min(first_day_scores[:6]), max(first_day_scores[6:]))

    def test_selective_ranking_head_can_abstain_when_no_candidate_beats_null(self):
        rows = []
        probabilities = []
        for day in range(120):
            current = (date(2023, 1, 1) + timedelta(days=day)).isoformat()
            for symbol in range(20):
                positive = (day + symbol) % 2 == 0
                rows.append({
                    "date": current,
                    "symbol": f"S{symbol:02d}",
                    "rankerPrediction": (symbol + 1) / 20,
                    "pathSafetyPrediction": 0.5,
                    "stopProbability": 0.5,
                    "quantileP50": 0.0,
                    "baselineReturn": 0.0,
                    "liquidityWeight": 1.0,
                    "dollarVolumeStability20": 1.0,
                    "actualDirection": 1.0 if positive else 0.0,
                    "actualTarget": 1.0 if positive else 0.0,
                    "actualStop": 0.0 if positive else 1.0,
                    "actualReturn": 1.0 if positive else -1.0,
                    "evaluationWeight": 1.0,
                })
                probabilities.append(0.5)
        result = fit_selective_ranking_head(
            rows,
            rows[:800],
            probabilities,
            probabilities[:800],
            probabilities,
            probabilities[:800],
        )
        self.assertTrue(result["available"])
        self.assertFalse(result["modelEligible"])
        self.assertEqual(result["selected"], "null/no-model")

    def test_selective_ranking_head_may_correct_orientation_using_inner_oof_only(self):
        def make_rows(start: date, days: int):
            rows = []
            neutral = []
            for day in range(days):
                current = (start + timedelta(days=day)).isoformat()
                for symbol in range(20):
                    positive = symbol < 5
                    rows.append({
                        "date": current,
                        "symbol": f"S{symbol:02d}",
                        # Deliberately reversed so only the preregistered
                        # inner-OOF orientation candidate can recover it.
                        "rankerPrediction": (symbol + 1) / 20,
                        "pathSafetyPrediction": 0.5,
                        "stopProbability": 0.5,
                        "quantileP50": 0.0,
                        "baselineReturn": 0.0,
                        "liquidityWeight": 1.0,
                        "dollarVolumeStability20": 1.0,
                        "actualDirection": 1.0 if positive else 0.0,
                        "actualTarget": 1.0 if positive else 0.0,
                        "actualStop": 0.0 if positive else 1.0,
                        "actualReturn": 2.0 if positive else -1.0,
                        "evaluationWeight": 1.0,
                    })
                    neutral.append(0.5)
            return rows, neutral

        train, train_neutral = make_rows(date(2023, 1, 1), 120)
        test, test_neutral = make_rows(date(2025, 1, 1), 40)
        result = fit_selective_ranking_head(
            train,
            test,
            train_neutral,
            test_neutral,
            train_neutral,
            test_neutral,
        )
        self.assertTrue(result["modelEligible"])
        self.assertIn("inverted", result["selected"])
        first_day_scores = result["scores"][:20]
        self.assertGreater(min(first_day_scores[:5]), max(first_day_scores[5:]))

    def test_long_trade_gate_learns_threshold_without_reading_test_labels(self):
        def make_rows(start: date, days: int):
            rows = []
            direction = []
            target = []
            for day in range(days):
                current = (start + timedelta(days=day)).isoformat()
                for symbol in range(4):
                    eligible = symbol < 2
                    success = not eligible or (day + symbol) % 5 < 3
                    rows.append({
                        "date": current,
                        "fold": day // 40 + 1,
                        "actualDirection": 1.0 if success else 0.0,
                        "actualTarget": 1.0 if eligible and success else 0.0,
                        "actualStop": 1.0 if eligible and not success else 0.0,
                        "actualTimeout": 0.0,
                        "actualReturn": 1.5 if success else -0.5,
                        "actualGrossReturn": 1.5 if success else -0.5,
                        "targetBarrierPct": 5.0,
                        "stopBarrierPct": 4.0,
                        "stopProbability": 0.25,
                        "timeoutProbability": 0.15,
                        "transactionCostBps": 18.0,
                    })
                    direction.append(0.57 if eligible else 0.45)
                    target.append(0.60 if eligible else 0.30)
            return rows, direction, target

        train, train_direction, train_target = make_rows(date(2022, 1, 1), 160)
        test, test_direction, test_target = make_rows(date(2025, 1, 1), 100)
        result = fit_long_trade_gate(train, test, train_direction, test_direction, train_target, test_target)
        self.assertTrue(result["active"])
        self.assertGreaterEqual(result["testEvidence"]["directionHitRatePct"], 57.0)
        self.assertGreater(result["testEvidence"]["meanNetReturnPct"], 0)

        inverted_test = [{**row, "actualDirection": 1.0 - row["actualDirection"]} for row in test]
        inverted = fit_long_trade_gate(train, inverted_test, train_direction, test_direction, train_target, test_target)
        self.assertEqual(result["threshold"], inverted["threshold"])
        self.assertNotEqual(result["testEvidence"]["directionHitRatePct"], inverted["testEvidence"]["directionHitRatePct"])
        self.assertFalse(inverted["active"])
        self.assertEqual(inverted["eligibleIndexes"], [])
        self.assertIn("failed untouched holdout", inverted["reason"])

    def test_training_feature_family_gate_uses_inner_dates_not_heldout_labels(self):
        names = [
            "bias", "change5", "change20", "volumeRatio", "volatility", "gap", "closeLocation", "buyPressure5",
            "macroRatesImpulse", "macroVolatilityImpulse",
        ]
        train = []
        for day_index in range(300):
            signal_day = (date(2022, 1, 1) + timedelta(days=day_index)).isoformat()
            for symbol_index in range(6):
                actual = 1.0 if (day_index + symbol_index) % 2 == 0 else 0.0
                signal = 1.0 if actual else -1.0
                macro = signal if day_index < 240 else -signal
                train.append({
                    "date": signal_day,
                    "symbol": f"S{symbol_index}",
                    "featureNames": names,
                    "x": [signal, signal * 0.8, signal * 0.6, 0.2, 0.1, 0.0, signal * 0.3, signal * 0.4, macro, macro],
                    "actualDirection": actual,
                    "actualReturn": 1.0 if actual else -1.0,
                })
        test = [
            {**row, "date": (date(2025, 1, 1) + timedelta(days=index // 6)).isoformat()}
            for index, row in enumerate(train[:120])
        ]
        projected_train, projected_test, audit = _training_feature_family_gate(train, test)
        self.assertTrue(audit["available"])
        self.assertIn("macro_regime", audit["excludedFamilies"])
        self.assertNotIn("macroRatesImpulse", projected_train[0]["featureNames"])
        self.assertIn("specialist", audit["macroPolicy"].lower())

        inverted_test = [{**row, "actualDirection": 1.0 - row["actualDirection"]} for row in test]
        _, inverted_projection, inverted_audit = _training_feature_family_gate(train, inverted_test)
        self.assertEqual(audit["excludedFamilies"], inverted_audit["excludedFamilies"])
        self.assertEqual(projected_test[0]["featureNames"], inverted_projection[0]["featureNames"])

    def test_stability_gate_uses_worst_adjacent_training_window(self):
        names = ["bias", "change1", "change3", "change5", "change10", "change20", "rsi", "macroFxImpulse", "volumeRatio"]
        train = []
        for day_index in range(240):
            block = day_index // 60
            for symbol_index in range(5):
                stable = (symbol_index - 2) / 3
                drifting = stable + block * 8.0
                train.append({
                    "date": (date(2021, 1, 1) + timedelta(days=day_index)).isoformat(),
                    "symbol": f"S{symbol_index}",
                    "featureNames": names,
                    "x": [1.0, stable, stable, stable, stable, stable, stable, drifting, stable],
                    "actualDirection": float((day_index + symbol_index) % 2 == 0),
                    "actualReturn": stable,
                })
        test = [{**row, "date": (date(2025, 1, 1) + timedelta(days=index // 5)).isoformat()} for index, row in enumerate(train[:100])]
        projected_train, projected_test, audit = _training_stable_feature_panel(train, test)
        self.assertTrue(audit["available"])
        self.assertFalse(audit["selectionUsesHeldOutFold"])
        self.assertIn("macroFxImpulse", audit["excludedFeatures"])
        self.assertNotIn("macroFxImpulse", projected_train[0]["featureNames"])
        self.assertEqual(projected_train[0]["featureNames"], projected_test[0]["featureNames"])
        self.assertGreaterEqual(len(audit["trainingStabilityWindows"]), 3)

    def test_feature_profile_gate_uses_nested_training_windows_only(self):
        names = [
            "bias", "change1", "change3", "change5", "change10", "change20", "volumeRatio", "rsi",
            "macdHist", "smaGap", "volatility", "rangePosition", "gap", "bodyPosition", "closeLocation",
            "trueRange", "buyPressure5", "pressureChange", "volumeAccel", "volumeTrend", "profileDistance",
            "profileSkew", "profilePocDistance", "profileImbalance", "liquidityShock", "trendQuality",
            "reversalPressure", "eventSentiment", "eventRelevance", "eventNovelty", "announcementScore",
            "fundamentalQuality", "sourceQuality", "freshnessScore", "positiveCatalyst", "negativeCatalyst",
            "dilutionRisk", "regulatoryRisk", "earningsEvent", "capitalAllocation", "operationalMomentum",
            "eventIntensity", "companyEventCoverage", "companyEventFreshness", "xsMomentum5Rank",
            "xsMomentum20Rank", "xsVolumeRatioRank", "xsLowVolatilityRank", "xsLiquidityRank",
            "xsTrendQualityRank", "xsPressureChangeRank", "xsVwapDistanceRank", "marketBreadth5",
        ]
        train = []
        for day_index in range(540):
            for symbol_index in range(5):
                actual = float((day_index + symbol_index) % 3 != 0)
                signal = 1.0 if actual else -1.0
                values = []
                for feature_index, name in enumerate(names):
                    if name in {"change5", "change20", "buyPressure5", "xsMomentum5Rank"}:
                        values.append(signal * (0.8 + feature_index / 1000))
                    elif name.startswith("event") or name in {"positiveCatalyst", "negativeCatalyst"}:
                        values.append(-signal if day_index > 420 else signal)
                    else:
                        values.append(((day_index + symbol_index + feature_index) % 11 - 5) / 10)
                train.append({
                    "date": (date(2020, 1, 1) + timedelta(days=day_index)).isoformat(),
                    "symbol": f"S{symbol_index}",
                    "featureNames": names,
                    "x": values,
                    "actualDirection": actual,
                    "actualReturn": signal,
                    "evaluationWeight": 1.0,
                })
        test = [{**row, "date": (date(2025, 1, 1) + timedelta(days=index // 5)).isoformat()} for index, row in enumerate(train[:200])]
        projected_train, projected_test, audit = _training_feature_profile_gate(train, test)
        self.assertTrue(audit["available"])
        self.assertFalse(audit["selectionUsesHeldOutFold"])
        self.assertEqual(audit["familyScope"], "linear-direction-only")
        self.assertGreaterEqual(len(audit["windows"]), 2)
        self.assertIn(audit["selectedProfile"], {row["profile"] for row in audit["comparisons"]})
        self.assertEqual(projected_train[0]["featureNames"], projected_test[0]["featureNames"])

        inverted_test = [{**row, "actualDirection": 1.0 - row["actualDirection"]} for row in test]
        _, inverted_projection, inverted_audit = _training_feature_profile_gate(train, inverted_test)
        self.assertEqual(audit["selectedProfile"], inverted_audit["selectedProfile"])
        self.assertEqual(projected_test[0]["featureNames"], inverted_projection[0]["featureNames"])

    def test_direction_model_selection_does_not_force_two_model_equal_weights(self):
        rows = []
        for day_index in range(360):
            for symbol_index in range(5):
                actual = float((day_index + symbol_index) % 2 == 0)
                rows.append({
                    "date": (date(2021, 1, 1) + timedelta(days=day_index)).isoformat(),
                    "actualDirection": actual,
                    "evaluationWeight": 1.0,
                    "stableDirection": 0.74 if actual else 0.26,
                    "flatDirection": 0.5,
                })
        selected, rejected, audit = select_robust_direction_models(
            rows,
            ["stableDirection", "flatDirection"],
        )
        self.assertTrue(audit["available"])
        self.assertFalse(audit["selectionUsesHeldOutMetaTest"])
        self.assertEqual(selected, ["stableDirection"])
        self.assertEqual(rejected[0]["model"], "flatDirection")

    def test_date_level_regime_model_uses_current_cross_section_only(self):
        names = [
            "change5", "change20", "volatility", "volumeRatio",
            "xsMomentum5Rank", "xsMomentum20Rank", "xsLowVolatilityRank", "marketBreadth5",
        ]
        train = []
        for day in range(300):
            positive = day % 4 in {0, 1, 2}
            breadth = 0.8 if positive else -0.8
            for symbol in range(8):
                train.append({
                    "date": f"2024-{day // 28 + 1:02d}-{day % 28 + 1:02d}",
                    "symbol": f"S{symbol}",
                    "featureNames": names,
                    "x": [breadth, breadth, 0.2, 1.0, 0.5, 0.5, 0.5, breadth],
                    "actualReturn": 1.0 if positive else -1.0,
                })
        test = [{
            "date": "2030-01-02",
            "symbol": f"T{symbol}",
            "featureNames": names,
            "x": [0.8, 0.8, 0.2, 1.0, 0.5, 0.5, 0.5, 0.8],
        } for symbol in range(6)]
        probabilities = _date_level_regime_predictions(train, test)
        self.assertEqual(len(probabilities), len(test))
        self.assertTrue(all(value > 0.5 for value in probabilities))

    def test_python_baseline_fallback_returns_one_prediction_per_test_row(self):
        train = []
        for index in range(80):
            target = 1.0 if index % 2 else 0.0
            train.append({
                "x": [1.0, index / 80],
                "actualReturn": target - 0.5,
                "actualTarget": target,
                "actualStop": 1.0 - target,
                "actualTimeout": 0.0,
                "actualDirection": target,
                "returnRank": index / 80,
                "trainingWeight": 1.0,
            })
        result = _fallback_baseline_predictions(train, train[-7:])
        self.assertTrue(all(len(result[key]) == 7 for key in [
            "baselineReturn", "direction", "elasticDirection", "target", "elasticTarget", "stop", "timeout", "rank",
        ]))
        self.assertEqual(result["trainingRows"], len(train))
        self.assertEqual(result["fullTrainingRows"], len(train))

    def test_fold_checkpoint_signature_tracks_values_code_dependencies_and_configuration(self):
        rows = [{
            "date": "2024-01-02", "symbol": "AAA", "x": [0.1, 0.2],
            "actualTarget": 1.0, "actualStop": 0.0, "actualTimeout": 0.0,
            "actualDirection": 1.0, "actualReturn": 2.0, "trainingWeight": 1.0,
            "featureNames": ["one", "two"],
        }]
        folds = [{"fold": 0, "train": rows, "test": rows, "trainStart": "2024-01-02", "trainEnd": "2024-01-02", "testStart": "2024-01-03", "testEnd": "2024-01-03"}]
        with tempfile.TemporaryDirectory() as directory:
            config = {"checkpointDir": directory, "foldCount": 5, "embargoDays": 7, "minTrainDates": 500, "testDates": 120}
            original = _fold_checkpoint_context(rows, folds, market="US", horizon=5, config=config)
            changed_rows = [{**rows[0], "x": [0.1, 0.25]}]
            changed = _fold_checkpoint_context(changed_rows, folds, market="US", horizon=5, config=config)
            changed_config = _fold_checkpoint_context(rows, folds, market="US", horizon=5, config={**config, "embargoDays": 10})
            changed_class_balance = _fold_checkpoint_context(
                rows,
                folds,
                market="US",
                horizon=5,
                config={**config, "treeClassBalance": "Balanced"},
            )
        self.assertNotEqual(original["signature"], changed["signature"])
        self.assertNotEqual(original["signature"], changed_config["signature"])
        self.assertNotEqual(original["signature"], changed_class_balance["signature"])
        self.assertEqual(changed_class_balance["payload"]["modelConfiguration"]["treeClassBalance"], "Balanced")
        self.assertIn("trainingSourceHash", original["payload"])
        self.assertIn("dependencyVersions", original["payload"])

    def test_worker_trains_market_multitask_candidate_and_persists_oof(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = {
                "operation": "production-model-train",
                "market": "US",
                "items": panel_items(240),
                "horizons": [5],
                "target_upside": 3,
                "stop_loss": 3,
                "production_fold_count": 3,
                "production_min_train_dates": 75,
                "production_test_dates": 30,
                "production_embargo_days": 7,
                "enable_tree_models": False,
                "job_type": "model_experiment",
                "changed_hypothesis": "gate00_execution_and_evidence_semantics",
                "artifact_dir": temp_dir,
                "checkpoint_dir": temp_dir,
            }
            result = dispatch(payload)
            self.assertTrue(result["available"])
            self.assertEqual(result["framework"], "market-level-multitask-oof-calibrated-stack")
            model = result["horizonModels"][0]
            self.assertTrue(model["available"])
            self.assertIn("elasticPrediction", model["models"] + [row.get("model") for row in model["prunedModels"]])
            self.assertIn("directionMetrics", model)
            self.assertIn("directionProbability", model["oofSchema"])
            self.assertTrue(model["directionModels"])
            self.assertEqual(model["leakageControl"]["entry"], "next-session VWAP/open")
            self.assertFalse(result["productionEligibility"]["eligible"])
            self.assertTrue(result["manifest"]["lockbox_created_before_fit"])
            self.assertTrue(result["manifest"]["comparison_key"])
            self.assertEqual(result["manifest"]["lockbox_id"], result["researchLockbox"]["lockboxId"])
            self.assertEqual(result["researchLockbox"]["status"], "consumed")
            self.assertEqual(result["researchLockbox"]["accessCount"], 1)
            self.assertEqual(result["researchLockbox"]["evaluationOutcome"], "rejected")
            artifact = model["oofArtifact"]
            self.assertIsNotNone(artifact)
            artifact_path = Path(temp_dir) / artifact["filename"]
            self.assertTrue(artifact_path.exists())
            self.assertTrue(result["manifest"]["training_run_id"])
            with gzip.open(artifact_path, "rt", encoding="utf-8") as stream:
                first_oof = json.loads(next(stream))
            self.assertEqual(len(first_oof["predictionId"]), 32)
            self.assertEqual(first_oof["modelVersion"], model["modelVersion"])
            self.assertGreater(first_oof["entryTimestamp"], first_oof["signalTimestamp"])
            self.assertGreater(first_oof["entryPrice"], 0)
            self.assertIn(first_oof["entrySource"], {"next_session_open", "next_session_vwap"})
            self.assertIn("path", first_oof["eligibleMask"])
            self.assertTrue(model["foldMetricReconciliation"]["reconciled"])
            self.assertLessEqual(model["foldMetricReconciliation"]["balancedAccuracyDifference"], 0.000001)
            self.assertLessEqual(model["foldMetricReconciliation"]["brierSkillDifference"], 0.000001)
            self.assertFalse(model["thresholdMetricContract"]["interchangeable"])
            self.assertFalse(model["top10MetricContract"]["interchangeable"])
            self.assertEqual(model["perHeadDenominators"]["schema"], "per-head-eligible-mask-v1")
            repeated = dispatch(payload)["horizonModels"][0]
            self.assertFalse(repeated["available"])
            self.assertEqual(repeated["status"], "NO_MODEL")
            self.assertIn("lockbox has already been consumed", repeated["reason"])

    def test_worker_dispatch_exposes_local_model_train(self):
        result = dispatch({"operation": "local-model-train", "market": "US", "samples": prediction_samples()})
        self.assertEqual(result["framework"], "python-local-quant-model-suite")
        self.assertIn("ensembleWeightOptimization", result)
        self.assertIn("signalModels", result)
        self.assertIn("lightgbm", result)
        self.assertIn("modelZoo", result)

    def test_worker_dispatch_exposes_factor_research(self):
        result = dispatch({
            "operation": "factor-research",
            "market": "US",
            "symbol": "UNIT",
            "candles": candles(190),
            "horizon_days": 10,
        })
        self.assertEqual(result["framework"], "dynamic-factor-admission-and-ml-weighting")
        self.assertIn("factor_research", result)
        self.assertGreater(result["factor_research"]["candidate_count"], 10)
        self.assertIn("live_signal", result["factor_research"])

    def test_factor_lab_can_defer_alpha_evolution_to_background_stage(self):
        result = dispatch({
            "operation": "factor-lab",
            "market": "ASX",
            "symbol": "BHP",
            "horizon_days": 15,
            "candles": candles(140),
            "include_alpha_evolution": False,
        })
        self.assertGreater(result["sample_count"], 50)
        self.assertTrue(result["alpha_evolution"]["deferred"])
        self.assertFalse(result["alpha_evolution"]["available"])
        self.assertIn("quality_gate", result)

    def test_worker_dispatch_exposes_cross_sectional_factor_research(self):
        result = dispatch({
            "operation": "cross-sectional-factor-research",
            "market": "US",
            "items": panel_items(220),
            "horizons": [5, 10],
            "min_symbols": 4,
        })
        self.assertTrue(result["available"])
        self.assertEqual(result["aggregate_weights"], [])
        self.assertTrue(all(row.get("admitted_count") == 0 for row in result["horizon_results"] if row.get("available")))
        self.assertEqual(result["framework"], "market-cross-sectional-factor-research")

    def test_worker_dispatch_exposes_historical_backtest(self):
        result = dispatch({
            "operation": "historical-backtest",
            "market": "US",
            "symbol": "UNIT",
            "candles": candles(240),
            "horizon_days": 10,
            "target_upside": 2,
            "stop_loss": 3,
            "min_train": 80,
            "step": 3,
        })
        self.assertTrue(result["available"])
        self.assertGreater(result["metrics"]["samples"], 10)
        self.assertIn("predictionCalibration", result)
        self.assertEqual(result["predictionCalibration"]["framework"], "prediction-method-weight-calibration")
        self.assertIn(result["predictionCalibration"]["horizonBucket"], {"short", "mid", "long"})

    def test_historical_backtest_uses_multi_step_sampling_without_leakage(self):
        sparse = run_historical_backtest(
            candles(260),
            market="US",
            symbol="UNIT",
            horizon=10,
            target_upside=2,
            stop_loss=3,
            min_train=80,
            step=5,
            max_predictions=500,
        )
        expanded = run_historical_backtest(
            candles(260),
            market="US",
            symbol="UNIT",
            horizon=10,
            target_upside=2,
            stop_loss=3,
            min_train=80,
            step=5,
            step_schedule=[2, 3, 5],
            max_step_offsets=2,
            max_predictions=500,
        )
        self.assertTrue(expanded["available"])
        self.assertGreater(expanded["metrics"]["samples"], sparse["metrics"]["samples"])
        self.assertIn("slicePlan", expanded["dataDepth"])
        self.assertEqual(expanded["dataDepth"]["leakageAudit"]["rule"], "train_row.index + horizon <= prediction_index - embargo")

    def test_worker_dispatch_exposes_multi_horizon_prediction_weight_calibration(self):
        result = dispatch({
            "operation": "historical-backtest-batch",
            "market": "US",
            "items": [
                {"market": "US", "symbol": "AAA", "candles": candles(260)},
                {"market": "US", "symbol": "BBB", "candles": candles(280)},
            ],
            "horizon_days": 10,
            "horizons": [5, 10, 30],
            "target_upside": 2,
            "stop_loss": 3,
            "min_train": 80,
            "step": 5,
            "step_schedule": [2, 3, 5],
            "max_step_offsets": 2,
            "max_predictions": 240,
        })
        self.assertTrue(result["available"])
        self.assertIn("predictionCalibration", result)
        self.assertGreaterEqual(len(result["horizonCalibrations"]), 2)
        self.assertIn("sampling", result)
        self.assertIn("dataQuality", result)
        self.assertEqual(result["dataQuality"]["framework"], "batch-point-in-time-candle-quality-gate")
        self.assertIn("avgLabelConfidence", result["metrics"])
        self.assertIn("avgCoverageScore", result["metrics"])
        self.assertIn("lowCoverageSamplePct", result["metrics"])
        self.assertIn("regimeCalibration", result)
        self.assertEqual(result["regimeCalibration"]["framework"], "aggregate-point-in-time-regime-bucket-calibration")
        self.assertIn("conformalCalibration", result)
        self.assertEqual(result["conformalCalibration"]["framework"], "aggregate-conformal-residual-calibration")
        self.assertIn("finalReturnAbsErrorP80", result["conformalCalibration"]["overall"])
        self.assertIn("avgLabelNoiseScore", result["metrics"])
        self.assertIn("highNoiseSamplePct", result["metrics"])
        self.assertIn("statisticalReliability", result)
        self.assertEqual(result["statisticalReliability"]["framework"], "aggregate-weighted-wilson-backtest-reliability")
        self.assertIn("targetHitLowerBound", result["metrics"])
        self.assertIn("stability", result["predictionCalibration"])
        self.assertEqual(result["predictionCalibration"]["stability"]["framework"], "aggregate-purged-walk-forward-weight-stability")
        for row in result["horizonCalibrations"]:
            self.assertIn("optimizedWeights", row)
            self.assertIn("stability", row)
            self.assertGreater(row["sampleCount"], 0)

    def test_provider_plan_limits_limited_sources(self):
        result = provider_plan("US", ["nasdaq-us", "eodhd-us", "twelvedata-us", "stooq-us"])
        self.assertEqual(result["policy"]["limited_source_cap_per_task"], 4)
        self.assertEqual(result["policy"]["support"]["tier"], "free_support")
        self.assertEqual(
            provider_plan("ASX", ["stockanalysis-asx", "finnhub-asx", "tiingo-asx"])["policy"]["limited_source_cap_per_task"],
            2,
        )
        self.assertEqual(
            provider_plan("CN", ["tushare-cn", "eastmoney-cn", "baostock-cn"])["policy"]["limited_source_cap_per_task"],
            1,
        )

    def test_risk_engine_blocks_stop_and_reserve_breaches(self):
        result = assess_portfolio(
            {
                "market": "ASX",
                "totalCapital": 10000,
                "availableCash": 500,
                "positions": [
                    {
                        "symbol": "BHP",
                        "qty": 180,
                        "avgPrice": 50,
                        "currentPrice": 45,
                        "sector": "Materials",
                        "change5d": -6,
                    }
                ],
                "policy": {"reserveCashPct": 15, "maxPositionPct": 30, "stopLossPct": 4},
            }
        )
        self.assertEqual(result["status"], "blocked")
        self.assertFalse(result["new_orders_allowed"])
        self.assertTrue(any(row["code"] == "STOP_LOSS_BREACH" for row in result["blockers"]))
        self.assertTrue(any(row["code"] == "RESERVE_CASH_BREACH" for row in result["blockers"]))

    def test_live_order_intent_is_rejected(self):
        intent = build_paper_order_intent(
            {
                "market": "US",
                "order": {
                    "mode": "live",
                    "side": "BUY",
                    "symbol": "AAPL",
                    "qty": 1,
                    "price": 200,
                    "idempotencyKey": "test-live",
                },
                "risk": {"totalCapital": 10000, "availableCash": 10000, "positions": []},
            }
        )
        self.assertFalse(intent["approved"])
        self.assertFalse(intent["order_sent"])
        self.assertFalse(intent["order_execution_enabled"])

    def test_sell_intent_cannot_exceed_position(self):
        intent = build_paper_order_intent(
            {
                "market": "US",
                "order": {
                    "mode": "paper",
                    "side": "SELL",
                    "symbol": "AAPL",
                    "qty": 12,
                    "price": 200,
                    "idempotencyKey": "sell-too-many",
                },
                "risk": {
                    "totalCapital": 10000,
                    "availableCash": 8000,
                    "positions": [{"symbol": "AAPL", "qty": 10, "avgPrice": 180, "currentPrice": 200}],
                },
            }
        )
        self.assertFalse(intent["approved"])
        self.assertTrue(any("exceeds" in error for error in intent["errors"]))

    def test_sqlite_control_plane_is_persistent_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "control.sqlite3")
            event = append_event(
                {
                    "db_path": db_path,
                    "market": "CN",
                    "event_type": "strategy-revision",
                    "entity_id": "rev-1",
                    "payload": {"note": "test"},
                }
            )
            self.assertGreater(event["id"], 0)
            rows = list_events({"db_path": db_path, "market": "CN"})
            self.assertEqual(rows["count"], 1)
            intent = build_paper_order_intent(
                {
                    "market": "CN",
                    "order": {
                        "mode": "paper",
                        "side": "BUY",
                        "symbol": "600519",
                        "qty": 1,
                        "price": 100,
                        "idempotencyKey": "same-order",
                    },
                    "risk": {"totalCapital": 10000, "availableCash": 10000, "positions": []},
                }
            )
            first = record_order_intent(intent, db_path)
            second = record_order_intent(intent, db_path)
            self.assertFalse(first["duplicate"])
            self.assertTrue(second["duplicate"])
            summary = control_plane_summary({"db_path": db_path, "market": "CN"})
            self.assertEqual(summary["event_count"], 1)
            self.assertEqual(summary["order_intent_count"], 1)

    def test_market_data_store_records_authorized_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "market.sqlite3")
            tick = record_market_rows(
                {
                    "db_path": db_path,
                    "market": "US",
                    "symbol": "AAPL",
                    "data_type": "ticks",
                    "source": "unit-authorized-feed",
                    "rows": [{"timestamp": "2026-06-01T14:30:00Z", "price": 200.1, "size": 10, "exchange": "XNAS"}],
                }
            )
            self.assertEqual(tick["inserted"], 1)
            quote = record_market_rows(
                {
                    "db_path": db_path,
                    "market": "US",
                    "symbol": "AAPL",
                    "data_type": "l1",
                    "source": "unit-authorized-feed",
                    "rows": [{"timestamp": "2026-06-01T14:30:01Z", "bid_price": 200, "bid_size": 20, "ask_price": 200.2, "ask_size": 25}],
                }
            )
            self.assertEqual(quote["inserted"], 1)
            depth = record_market_rows(
                {
                    "db_path": db_path,
                    "market": "US",
                    "symbol": "AAPL",
                    "data_type": "l2",
                    "source": "unit-authorized-feed",
                    "rows": [{"timestamp": "2026-06-01T14:30:02Z", "side": "bid", "price": 199.9, "size": 30, "level": 1}],
                }
            )
            self.assertEqual(depth["inserted"], 1)
            summary = market_data_summary({"db_path": db_path, "market": "US", "symbol": "AAPL"})
            self.assertTrue(summary["true_tick_available"])
            self.assertTrue(summary["true_l1_available"])
            self.assertTrue(summary["true_l2_available"])
            self.assertEqual(summary["tick_count"], 1)
            self.assertEqual(summary["l1_quote_count"], 1)
            self.assertEqual(summary["l2_depth_count"], 1)
            duplicate = record_market_rows(
                {
                    "db_path": db_path,
                    "market": "US",
                    "symbol": "AAPL",
                    "data_type": "ticks",
                    "source": "unit-authorized-feed",
                    "rows": [{"timestamp": "2026-06-01T14:30:00Z", "price": 200.1, "size": 10, "exchange": "XNAS"}],
                }
            )
            self.assertEqual(duplicate["inserted"], 0)
            replay = list_market_rows({"db_path": db_path, "market": "US", "symbol": "AAPL", "data_type": "ticks"})
            self.assertEqual(replay["count"], 1)
            self.assertTrue(replay["true_tick"])
            self.assertEqual(replay["rows"][0]["timestamp"], "2026-06-01T14:30:00Z")
            self.assertEqual(replay["rows"][0]["price"], 200.1)

    def test_python_client_builds_risk_payload(self):
        position = parse_position("AAPL:10:180:200:Technology")
        self.assertEqual(position["symbol"], "AAPL")
        args = type(
            "Args",
            (),
            {
                "market": "US",
                "total_capital": 10000,
                "available_cash": 8000,
                "position": [position],
                "reserve_cash_pct": 15,
                "max_position_pct": 30,
                "max_sector_pct": 50,
                "stop_loss_pct": 4,
            },
        )()
        payload = risk_payload(args)
        self.assertEqual(payload["market"], "US")
        self.assertEqual(payload["positions"][0]["currentPrice"], 200)
        self.assertEqual(payload["policy"]["maxPositionPct"], 30)

    def test_paper_agents_persist_and_dedupe_real_bar(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            configure_paper_agents({"db_path": db_path, "market": "US", "config": {"requireStrictOof": False}})
            item = {
                "market": "US",
                "symbol": "AAPL",
                "price": 200.0,
                "barTs": "2026-07-13T14:35:00Z",
                "source": "alpaca-us-real-bars",
                "fresh": True,
                "analysis": {
                    "action": "WATCH_BUY",
                    "confidence": 91,
                    "projectedFinalReturn": 8,
                    "projectedMaxUpside": 11,
                    "strategyHitProbability": 84,
                    "finalReturnProbability": 76,
                    "maxUpsideProbability": 88,
                    "downsideConfidence": 18,
                },
                "technicals": {"close": 200, "trendScore": 82, "riskScore": 78, "rsi": 61, "volumeRatio": 1.8, "change5d": 4.1},
                "factors": {"quality": {"available": True, "score": 28}},
                "news": [{"title": "verified product launch"}],
            }
            first = step_paper_agents({"db_path": db_path, "market": "US", "marketOpen": True, "items": [item]})
            self.assertTrue(first["events"])
            self.assertTrue(all(event["order_execution_enabled"] is False for event in first["events"]))
            self.assertTrue(all(event["costModel"]["method"].startswith("commission+") for event in first["events"]))
            self.assertTrue(all(event["costModel"]["totalPct"] >= event["costModel"]["commissionPct"] for event in first["events"]))
            second = step_paper_agents({"db_path": db_path, "market": "US", "marketOpen": True, "items": [item]})
            self.assertEqual(second["events"], [])
            saved = load_paper_agent_state("US", db_path)
            self.assertGreater(sum(len(agent["positions"]) for agent in saved["ledger"]["agents"]), 0)
            events = list_agent_events({"db_path": db_path, "market": "US"})
            self.assertEqual(events["count"], len(first["events"]))

    def test_paper_agents_reject_closed_stale_and_simulated_prices(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            base = {"market": "ASX", "symbol": "BHP", "price": 45, "barTs": "2026-07-13T01:00:00Z", "analysis": {"confidence": 99}}
            closed = step_paper_agents({"db_path": db_path, "market": "ASX", "marketOpen": False, "items": [{**base, "source": "eodhd-asx-real", "fresh": True}]})
            simulated = step_paper_agents({"db_path": db_path, "market": "ASX", "marketOpen": True, "items": [{**base, "source": "simulated-fixture", "fresh": True}]})
            stale = step_paper_agents({"db_path": db_path, "market": "ASX", "marketOpen": True, "items": [{**base, "source": "eodhd-asx-real", "fresh": False}]})
            self.assertFalse(closed["events"])
            self.assertFalse(simulated["events"])
            self.assertFalse(stale["events"])

    def test_paper_agent_browser_migration_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            payload = {
                "db_path": db_path,
                "market": "US",
                "migrationId": "browser-agent-v1-test",
                "agentConfigByMarket": {"US": {"initialCapital": 25000}},
                "agentMemoryByMarket": {"US": {"strategyBook": {"trend": {"trades": 42}}, "archives": [{"reason": "cycle"}], "totalReplayTrades": 42}},
            }
            first = migrate_paper_agents(payload)
            second = migrate_paper_agents(payload)
            self.assertTrue(first["migrated"])
            self.assertTrue(second["duplicate"])
            self.assertEqual(second["config"]["initialCapital"], 25000)
            self.assertEqual(second["memory"]["strategyBook"]["trend"]["trades"], 42)
            self.assertEqual(len(second["memory"]["archives"]), 1)

    def test_paper_agent_empty_browser_migration_cannot_erase_backend_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            configure_paper_agents({"db_path": db_path, "market": "US", "config": {"requireStrictOof": False}})
            item = {
                "market": "US", "symbol": "AAPL", "price": 200.0,
                "barTs": "2026-07-13T14:35:00Z", "source": "alpaca-us-real-bars", "fresh": True,
                "analysis": {"action": "WATCH_BUY", "confidence": 94, "projectedFinalReturn": 9, "projectedMaxUpside": 12, "strategyHitProbability": 88, "finalReturnProbability": 81, "maxUpsideProbability": 90, "downsideConfidence": 15},
                "technicals": {"close": 200, "trendScore": 84, "riskScore": 80, "rsi": 62, "volumeRatio": 1.9, "change5d": 4.6},
                "factors": {"quality": {"available": True, "score": 30}}, "news": [{"title": "verified launch"}],
            }
            step_paper_agents({"db_path": db_path, "market": "US", "marketOpen": True, "items": [item]})
            before = load_paper_agent_state("US", db_path)
            migrated = migrate_paper_agents({
                "db_path": db_path, "market": "US", "migrationId": "empty-browser-v2",
                "agentLedgerByMarket": {"US": {"market": "US", "agents": []}},
                "agentMemoryByMarket": {"US": {}},
            })
            self.assertEqual(sum(len(agent["trades"]) for agent in migrated["ledger"]["agents"]), sum(len(agent["trades"]) for agent in before["ledger"]["agents"]))
            self.assertEqual(sum(len(agent["positions"]) for agent in migrated["ledger"]["agents"]), sum(len(agent["positions"]) for agent in before["ledger"]["agents"]))

    def test_paper_agent_same_marker_accepts_a_strictly_richer_browser_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            marker = "browser-v3-recovery"
            first = migrate_paper_agents({"db_path": db_path, "market": "ASX", "migrationId": marker})
            richer_agent = first["ledger"]["agents"][0]
            richer_agent["trades"] = [{"id": "restored-trade", "symbol": "CPU.AX", "side": "BUY"}]
            richer_agent["positions"] = {"CPU.AX": {"qty": 10, "avgPrice": 25}}
            recovered = migrate_paper_agents({
                "db_path": db_path,
                "market": "ASX",
                "migrationId": marker,
                "agentLedgerByMarket": {"ASX": first["ledger"]},
            })
            self.assertTrue(recovered["migrated"])
            self.assertFalse(recovered["duplicate"])
            self.assertEqual(sum(len(agent["trades"]) for agent in recovered["ledger"]["agents"]), 1)
            self.assertEqual(sum(len(agent["positions"]) for agent in recovered["ledger"]["agents"]), 1)

    def test_paper_agent_capital_update_preserves_trades_and_positions(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            configure_paper_agents({"db_path": db_path, "market": "US", "config": {"requireStrictOof": False}})
            item = {
                "market": "US", "symbol": "AAPL", "price": 200.0,
                "barTs": "2026-07-13T14:35:00Z", "source": "alpaca-us-real-bars", "fresh": True,
                "analysis": {"action": "WATCH_BUY", "confidence": 94, "projectedFinalReturn": 9, "projectedMaxUpside": 12, "strategyHitProbability": 88, "finalReturnProbability": 81, "maxUpsideProbability": 90, "downsideConfidence": 15},
                "technicals": {"close": 200, "trendScore": 84, "riskScore": 80, "rsi": 62, "volumeRatio": 1.9, "change5d": 4.6},
                "factors": {"quality": {"available": True, "score": 30}}, "news": [{"title": "verified launch"}],
            }
            step_paper_agents({"db_path": db_path, "market": "US", "marketOpen": True, "items": [item]})
            before = load_paper_agent_state("US", db_path)
            updated = configure_paper_agents({"db_path": db_path, "market": "US", "config": {"initialCapital": 25000}})
            self.assertEqual(updated["config"]["initialCapital"], 25000)
            self.assertEqual(sum(len(agent["trades"]) for agent in updated["ledger"]["agents"]), sum(len(agent["trades"]) for agent in before["ledger"]["agents"]))
            self.assertEqual(sum(len(agent["positions"]) for agent in updated["ledger"]["agents"]), sum(len(agent["positions"]) for agent in before["ledger"]["agents"]))

    def test_data_lake_keeps_markets_isolated_and_deduplicates_candles(self):
        with tempfile.TemporaryDirectory() as directory:
            base = {
                "root": directory,
                "symbol": "CAR",
                "interval": "1d",
                "source": "unit-real",
                "candles": [
                    {"date": "2026-07-01", "open": 10, "high": 11, "low": 9, "close": 10.5, "volume": 1000},
                    {"date": "2026-07-02", "open": 10.5, "high": 12, "low": 10, "close": 11.5, "volume": 1200},
                ],
            }
            first = upsert_data_lake({**base, "market": "ASX"})
            second = upsert_data_lake({**base, "market": "ASX"})
            upsert_data_lake({**base, "market": "US"})
            self.assertEqual(first["rows"], 2)
            self.assertEqual(second["rows"], 2)
            self.assertEqual(read_data_lake_rows({"root": directory, "market": "ASX", "symbol": "CAR"})["rows"], 2)
            evidence = data_lake_summary({"root": directory})
            self.assertEqual(evidence["markets"]["ASX"], 2)
            self.assertEqual(evidence["markets"]["US"], 2)
            with self.assertRaisesRegex(ValueError, "Cross-market"):
                upsert_data_lake({**base, "market": "ASX", "symbol": "600900"})

    def test_data_lake_interval_key_content_version_and_invalid_ohlc_quarantine(self):
        with tempfile.TemporaryDirectory() as directory:
            base = {
                "root": directory, "market": "US", "symbol": "AAPL", "source": "unit-us",
                "candles": [{"date": "2026-07-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 1000}],
            }
            daily = upsert_data_lake({**base, "interval": "1d"})
            weekly = upsert_data_lake({**base, "interval": "1wk"})
            self.assertNotEqual(daily["data_version"], weekly["data_version"])
            changed = upsert_data_lake({**base, "interval": "1d", "candles": [{**base["candles"][0], "close": 101.5}]})
            self.assertNotEqual(daily["data_version"], changed["data_version"])
            invalid = upsert_data_lake({
                **base, "interval": "1d",
                "candles": [{"date": "2026-07-02", "open": 100, "high": 98, "low": 99, "close": 101, "volume": 1000}],
            })
            self.assertEqual(invalid["quarantined"], 1)
            self.assertEqual(read_data_lake_rows({"root": directory, "market": "US", "symbol": "AAPL", "interval": "1d"})["rows"], 1)

    def test_data_lake_panel_reuses_complete_history_and_keeps_exchange_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            panel = upsert_data_lake_panel({
                "root": directory,
                "market": "ASX",
                "interval": "1d",
                "items": [
                    {"symbol": "BHP.AX", "source": "unit-asx", "candles": candles(90)},
                    {"symbol": "CBA.AX", "source": "unit-asx", "candles": candles(75)},
                ],
            })
            self.assertTrue(panel["available"])
            self.assertEqual(panel["partitions"], 2)
            reused = read_data_lake_panel({
                "root": directory,
                "market": "ASX",
                "symbols": ["BHP.AX", "CBA.AX"],
                "interval": "1d",
                "min_rows": 80,
            })
            self.assertEqual(reused["availableCount"], 1)
            self.assertEqual(reused["items"][0]["symbol"], "BHP")
            self.assertEqual(reused["items"][0]["exchange"], "ASX")

    def test_data_lake_scales_ohlc_to_adjusted_close_without_losing_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_data_lake({
                "root": directory, "market": "US", "symbol": "AAPL", "source": "unit-adjusted", "interval": "1d",
                "candles": [{"date": "2020-08-28", "open": 100, "high": 104, "low": 98, "close": 102, "adjClose": 51, "volume": 1000}],
            })
            result = read_data_lake_rows({"root": directory, "market": "US", "symbol": "AAPL"})
            self.assertEqual(result["adjustment"], "split-dividend-adjusted")
            self.assertAlmostEqual(result["candles"][0]["close"], 51)
            self.assertAlmostEqual(result["candles"][0]["open"], 50)
            self.assertAlmostEqual(result["candles"][0]["high"], 52)

    def test_data_lake_audit_quarantines_cross_market_new_partitions(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_data_lake({
                "root": directory, "market": "ASX", "symbol": "AAPL", "source": "alpaca-us-iex", "interval": "1d",
                "candles": [{"date": "2026-07-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 1000}],
            })
            result = audit_data_lake({"root": directory, "allowed_symbols": {"ASX": ["BHP"], "US": ["AAPL"], "CN": []}})
            self.assertEqual(result["quarantined"], 1)
            self.assertFalse(read_data_lake_rows({"root": directory, "market": "ASX", "symbol": "AAPL"})["available"])

    def test_data_lake_audit_reports_verified_partitions_without_false_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_data_lake({
                "root": directory, "market": "ASX", "symbol": "BHP", "source": "unit-asx", "interval": "1d",
                "candles": [{"date": "2026-07-01", "open": 40, "high": 42, "low": 39, "close": 41, "volume": 1000}],
            })
            result = audit_data_lake({"root": directory, "allowed_symbols": {"ASX": ["BHP"], "US": [], "CN": []}})
            self.assertEqual(result["verified"], 1)
            self.assertEqual(result["migrated"], 0)
            self.assertEqual(result["quarantined"], 0)
            self.assertEqual(result["verifiedItems"][0]["symbol"], "BHP")

    def test_data_lake_audit_accepts_multiple_real_sources_for_one_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            base = {
                "root": directory, "market": "ASX", "symbol": "BHP", "interval": "1d",
                "candles": [{"date": "2026-07-01", "open": 40, "high": 42, "low": 39, "close": 41, "volume": 1000}],
            }
            upsert_data_lake({**base, "source": "yahoo-finance-asx-single-source"})
            upsert_data_lake({**base, "source": "stockanalysis-asx-daily-single-source"})
            result = audit_data_lake({"root": directory, "allowed_symbols": {"ASX": ["BHP"], "US": [], "CN": []}})
            self.assertEqual(result["verified"], 1)
            self.assertEqual(result["quarantined"], 0)

    def test_data_lake_audit_recovers_verified_multi_source_quarantine(self):
        with tempfile.TemporaryDirectory() as directory:
            saved = upsert_data_lake({
                "root": directory, "market": "ASX", "symbol": "BHP", "source": "yahoo-finance-asx-single-source", "interval": "1d",
                "candles": [{"date": "2026-07-01", "open": 40, "high": 42, "low": 39, "close": 41, "volume": 1000}],
            })
            current = Path(saved["parquet"])
            root = Path(directory).resolve()
            quarantine = root / "quarantine" / "audit=old" / current.relative_to(root)
            quarantine.parent.mkdir(parents=True, exist_ok=True)
            current.rename(quarantine)
            result = audit_data_lake({"root": directory, "allowed_symbols": {"ASX": ["BHP"], "US": [], "CN": []}})
            self.assertEqual(result["recovered"], 1)
            self.assertTrue(read_data_lake_rows({"root": directory, "market": "ASX", "symbol": "BHP"})["available"])

    def test_data_lake_pit_records_require_availability_time_and_exchange_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            result = upsert_pit_records({
                "root": directory,
                "dataset": "fundamentals",
                "market": "CN",
                "symbol": "SH000001",
                "exchange": "SSE",
                "source": "unit-exchange-filing",
                "records": [
                    {"id": "valid", "event_time": "2026-07-01", "available_at": "2026-07-02T01:00:00Z", "historicalAvailabilityVerified": True, "value": 1},
                    {"id": "future-unknown", "event_time": "2026-07-03", "value": 2},
                ],
            })
            self.assertEqual(result["rows"], 1)
            self.assertIn("exchange=SSE", result["parquet"])
            self.assertIn("symbol=000001", result["parquet"])
            lake = data_lake_summary({"root": directory})
            self.assertEqual(lake["pitRows"], 1)
            self.assertEqual(lake["pitDatasets"]["fundamentals"]["markets"]["CN"], 1)
            self.assertEqual(lake["pitDatasets"]["fundamentals"]["verifiedSymbols"]["CN"], 1)
            self.assertEqual(lake["pitDatasets"]["fundamentals"]["trainingUniverseCoveragePct"]["CN"], 100.0)
            self.assertEqual(lake["pitDatasets"]["news"]["rows"], 0)

    def test_data_lake_pit_write_preserves_conservative_timestamp_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            result = upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "US",
                "symbol": "AAPL",
                "source": "unit-date-only-source",
                "records": [{
                    "id": "date-only-news",
                    "date": "2025-01-02",
                    "title": "Date-only source record",
                    "historicalAvailabilityVerified": False,
                }],
            })
            self.assertEqual(result["rows"], 1)
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "US",
                "symbols": ["AAPL"],
                "datasets": ["news"],
            })
            row = panel["items"][0]["pointInTimeFeatures"][0]
            self.assertTrue(row["pitTimestampFallbackUsed"])
            self.assertIn("published_at", row["pitTimestampFallbackFields"])
            self.assertFalse(row["historicalAvailabilityVerified"])

    def test_data_lake_pit_write_keeps_related_entities_but_collapses_true_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            base = {
                "event_time": "2025-01-02T00:00:00Z",
                "available_at": "2025-01-02T00:00:00Z",
                "first_seen_at": "2025-01-02T00:00:01Z",
                "ingested_at": "2025-01-02T01:00:00Z",
                "historicalAvailabilityVerified": True,
                "link": "https://example.test/event",
            }
            result = upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "US",
                "symbol": "MARKET",
                "source": "multi-news",
                "records": [
                    {**base, "relatedSymbol": "AAA", "title": "one"},
                    {**base, "relatedSymbol": "BBB", "title": "two"},
                    {**base, "relatedSymbol": "AAA", "title": "duplicate"},
                ],
            })
            self.assertEqual(result["rows"], 2)
            self.assertEqual(result["duplicateRowsCollapsed"], 1)

    def test_asx_official_financial_disclosures_are_classified_without_fabricating_numeric_statements(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_data_lake({
                "root": directory,
                "market": "ASX",
                "symbol": "BHP",
                "source": "yahoo-finance-asx-single-source",
                "interval": "1d",
                "candles": [{"date": "2025-08-21", "open": 40, "high": 42, "low": 39, "close": 41, "volume": 1000}],
            })
            upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "ASX",
                "symbol": "BHP",
                "source": "asx-official-historical-announcements",
                "records": [{
                    "id": "bhp-annual-report-2025",
                    "title": "Annual Report 2025",
                    "event_time": "2025-08-20T06:00:00Z",
                    "available_at": "2025-08-20T06:00:00Z",
                    "historicalAvailabilityVerified": True,
                    "values": {"earningsEvent": 1, "sourceQuality": 1},
                }],
            })
            result = migrate_asx_financial_disclosures({"root": directory})
            self.assertEqual(result["symbols"], 1)
            lake = data_lake_summary({"root": directory})
            self.assertEqual(lake["pitDatasets"]["financial_disclosures"]["verifiedSymbols"]["ASX"], 1)
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "ASX",
                "symbols": ["BHP"],
                "datasets": ["financial_disclosures"],
                "verified_only": True,
            })
            feature = panel["items"][0]["pointInTimeFeatures"][0]
            self.assertEqual(feature["dataset"], "financial_disclosures")
            self.assertNotIn("revenue", feature["values"])

    def test_data_lake_accepts_valid_us_share_class_symbols_without_allowing_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            result = upsert_pit_records({
                "root": directory,
                "dataset": "fundamentals",
                "market": "US",
                "symbol": "CIG.C",
                "source": "unit-share-class",
                "records": [{
                    "id": "filing-1",
                    "event_time": "2025-03-31",
                    "available_at": "2025-05-01T00:00:00Z",
                    "values": {"profitMargin": 0.1},
                }],
            })
            self.assertEqual(result["rows"], 1)
            self.assertIn("symbol=CIG.C", result["parquet"])
            with self.assertRaisesRegex(ValueError, "Invalid US symbol"):
                upsert_pit_records({
                    "root": directory,
                    "dataset": "fundamentals",
                    "market": "US",
                    "symbol": "..",
                    "source": "unit-invalid",
                    "records": [],
                })

    def test_data_lake_bulk_pit_upsert_deduplicates_without_row_by_row_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            records = [
                {
                    "id": f"filing-{index}",
                    "event_time": f"2024-{index % 12 + 1:02d}-{index % 27 + 1:02d}",
                    "available_at": f"2025-{index % 12 + 1:02d}-{index % 27 + 1:02d}T01:00:00Z",
                    "historicalAvailabilityVerified": True,
                    "values": {"profitMargin": (index % 30) / 100},
                }
                for index in range(2_000)
            ]
            first = upsert_pit_batches({
                "root": directory,
                "batches": [
                    {"dataset": "fundamentals", "market": "US", "symbol": "AAPL", "source": "unit-sec", "records": records[:1_000]},
                    {"dataset": "fundamentals", "market": "US", "symbol": "AAPL", "source": "unit-sec", "records": records[1_000:]},
                ],
            })
            second = upsert_pit_records({
                "root": directory,
                "dataset": "fundamentals",
                "market": "US",
                "symbol": "AAPL",
                "source": "unit-sec",
                "records": records,
            })
            self.assertEqual(first["batches"], 1)
            self.assertEqual(first["inserted"], 2_000)
            self.assertEqual(second["rows"], 2_000)

    def test_data_lake_pit_panel_returns_point_in_time_model_features(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "US",
                "symbol": "AAPL",
                "source": "unit-news",
                "records": [{
                    "id": "earnings",
                    "event_time": "2026-06-01T10:00:00Z",
                    "available_at": "2026-06-01T10:05:00Z",
                    "title": "AAPL earnings guidance raised",
                    "sentiment": "positive",
                    "relevance": 90,
                    "truthScore": 80,
                    "historicalAvailabilityVerified": True,
                }],
            })
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "US",
                "symbols": ["AAPL"],
            })
            self.assertEqual(panel["rows"], 1)
            feature = panel["items"][0]["pointInTimeFeatures"][0]
            self.assertEqual(feature["values"]["eventSentiment"], 1.0)
            self.assertEqual(feature["values"]["announcementScore"], 1.0)
            self.assertEqual(feature["values"]["positiveCatalyst"], 1.0)
            verified_panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "US",
                "symbols": ["AAPL"],
                "datasets": ["news"],
                "verified_only": True,
            })
            self.assertTrue(verified_panel["verifiedOnly"])
            self.assertEqual(len(verified_panel["items"][0]["pointInTimeFeatures"]), 1)
            self.assertTrue(verified_panel["items"][0]["pointInTimeFeatures"][0]["historicalAvailabilityVerified"])

            hydrated, market_features, audit = hydrate_verified_pit_from_data_lake(
                [{"market": "US", "symbol": "AAPL", "candles": candles(80)}],
                market="US",
                root=directory,
                limit_per_symbol=20,
            )
            self.assertEqual(market_features, [])
            self.assertEqual(audit["transport"], "python-local-parquet")
            self.assertEqual(audit["coveredSymbols"], 1)
            self.assertTrue(hydrated[0]["pointInTimeFeatures"])
            self.assertEqual(hydrated[0]["pitDataVersion"], audit["dataVersion"])

    def test_data_lake_verified_pit_coverage_reads_only_requested_symbol_partitions(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "US",
                "symbol": "AAPL",
                "source": "unit-news",
                "records": [{
                    "id": "aapl-verified",
                    "event_time": "2026-06-01T10:00:00Z",
                    "available_at": "2026-06-01T10:05:00Z",
                    "historicalAvailabilityVerified": True,
                }],
            })
            upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "US",
                "symbol": "MSFT",
                "source": "unit-news",
                "records": [{
                    "id": "msft-unverified",
                    "event_time": "2026-06-01T10:00:00Z",
                    "available_at": "2026-06-01T10:05:00Z",
                    "historicalAvailabilityVerified": False,
                }],
            })
            coverage = data_lake_verified_pit_coverage({
                "root": directory,
                "market": "US",
                "symbols": ["AAPL", "MSFT", "NVDA"],
                "datasets": ["news"],
            })
            self.assertEqual(coverage["symbols"], ["AAPL"])
            self.assertEqual(coverage["byDataset"]["news"], ["AAPL"])
            self.assertEqual(coverage["files"], 2)
            upsert_pit_records({
                "root": directory,
                "dataset": "universe",
                "market": "US",
                "symbol": "MARKET",
                "source": "unit-historical-universe",
                "records": [{
                    "id": "msft-listing",
                    "symbol": "MSFT",
                    "event_time": "2020-01-01T00:00:00Z",
                    "available_at": "2020-01-01T00:00:00Z",
                    "historicalAvailabilityVerified": True,
                }],
            })
            universe_coverage = data_lake_verified_pit_coverage({
                "root": directory,
                "market": "US",
                "symbols": ["AAPL", "MSFT"],
                "datasets": ["universe"],
            })
            self.assertEqual(universe_coverage["symbols"], ["MSFT"])

    def test_data_lake_pit_panel_normalizes_numeric_cn_partition_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_pit_records({
                "root": directory,
                "dataset": "financial_disclosures",
                "market": "CN",
                "symbol": "300014",
                "source": "unit-cninfo",
                "records": [{
                    "id": "cninfo-300014",
                    "title": "2025年年度报告",
                    "event_time": "2026-04-01",
                    "available_at": "2026-04-01T10:00:00Z",
                    "historicalAvailabilityVerified": True,
                }],
            })
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "CN",
                "symbols": ["300014"],
                "datasets": ["financial_disclosures"],
                "verified_only": True,
            })
            item = next(row for row in panel["items"] if row["symbol"] == "300014")
            self.assertEqual(len(item["pointInTimeFeatures"]), 1)
            self.assertTrue(item["pointInTimeFeatures"][0]["historicalAvailabilityVerified"])

    def test_universe_coverage_receipt_preserves_range_without_claiming_listing_event(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_pit_records({
                "root": directory,
                "dataset": "universe",
                "market": "ASX",
                "symbol": "ABC",
                "source": "asx-official-historical-announcements",
                "records": [{
                    "id": "coverage",
                    "symbol": "ABC.AX",
                    "event_time": "2012-01-01",
                    "available_at": "2012-01-01",
                    "eventType": "coverage",
                    "coverageKind": "official-announcement-range-plus-observed-trading-history",
                    "coverageStart": "2012-01-01",
                    "coverageEnd": "2026-08-11",
                    "historicalAvailabilityVerified": True,
                }],
            })
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "ASX",
                "symbols": ["ABC"],
                "datasets": ["universe"],
                "verified_only": True,
            })
            record = panel["items"][0]["universeHistory"][0]
            self.assertIsNone(record["listed"])
            self.assertEqual(record["eventType"], "coverage")
            self.assertTrue(verified_pit_coverage([record], "2019-01-02", "ASX")["covered"])

    def test_data_lake_classifies_official_dilution_and_regulatory_events(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_pit_records({
                "root": directory,
                "dataset": "news",
                "market": "ASX",
                "symbol": "ABC",
                "source": "asx-announcements-historical",
                "records": [{
                    "id": "placement",
                    "event_time": "2026-05-01T00:00:00Z",
                    "available_at": "2026-05-01T00:05:00Z",
                    "title": "Trading Halt - Capital Raising Placement and ASIC Investigation",
                    "historicalAvailabilityVerified": True,
                }],
            })
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "ASX",
                "symbols": ["ABC"],
                "datasets": ["news"],
                "verified_only": True,
            })
            feature = panel["items"][0]["pointInTimeFeatures"][0]["values"]
            self.assertEqual(feature["dilutionRisk"], 1.0)
            self.assertEqual(feature["regulatoryRisk"], 1.0)
            self.assertEqual(feature["negativeCatalyst"], 1.0)
            self.assertEqual(feature["sourceQuality"], 1.0)

    def test_market_wide_macro_pit_is_batched_and_replicated_without_future_values(self):
        with tempfile.TemporaryDirectory() as directory:
            result = upsert_pit_batches({
                "root": directory,
                "batches": [{
                    "dataset": "macro", "market": "US", "symbol": "MARKET", "source": "unit-alfred",
                    "records": [{
                        "id": "CPI:2026-01", "seriesId": "CPIAUCSL", "event_time": "2026-01-01T23:59:59Z",
                        "available_at": "2026-01-15T13:30:00Z", "historicalAvailabilityVerified": True,
                        "values": {
                            "macroRisk": -0.7,
                            "macroInflationImpulse": -0.65,
                            "macroDataCoverage": 1.0,
                            "eventSentiment": -0.6,
                            "sourceQuality": 1.0,
                        },
                    }],
                }],
            })
            self.assertEqual(result["batches"], 1)
            panel = read_data_lake_pit_panel({
                "root": directory, "market": "US", "symbols": ["AAPL", "MSFT"], "datasets": ["macro"],
            })
            by_symbol = {row["symbol"]: row for row in panel["items"]}
            self.assertEqual(by_symbol["AAPL"]["pointInTimeFeatures"][0]["values"]["macroRisk"], -0.7)
            self.assertEqual(by_symbol["AAPL"]["pointInTimeFeatures"][0]["values"]["macroInflationImpulse"], -0.65)
            self.assertEqual(by_symbol["AAPL"]["pointInTimeFeatures"][0]["values"]["__seriesId"], "CPIAUCSL")
            self.assertEqual(by_symbol["MSFT"]["pointInTimeFeatures"][0]["values"]["sourceQuality"], 1.0)

            compact = read_data_lake_pit_panel({
                "root": directory,
                "market": "US",
                "symbols": ["AAPL", "MSFT"],
                "datasets": ["macro"],
                "broadcast_market_wide": False,
            })
            self.assertEqual(len(compact["marketPointInTimeFeatures"]), 1)
            self.assertTrue(all(not row["pointInTimeFeatures"] for row in compact["items"]))
            joined = point_in_time_features(
                {},
                "2026-02-01",
                "US",
                compact["marketPointInTimeFeatures"],
            )
            self.assertEqual(joined["sourceRows"], 1)
            self.assertEqual(joined["companySourceRows"], 0)
            self.assertEqual(joined["marketSourceRows"], 1)
            self.assertLess(joined["values"]["macroRisk"], 0)
            self.assertLess(joined["values"]["macroInflationImpulse"], 0)
            self.assertEqual(joined["values"]["macroDataCoverage"], 1.0)
            dataset = build_market_dataset(
                [
                    {"market": "US", "symbol": "AAPL", "candles": panel_candles(90, phase=1)},
                    {"market": "US", "symbol": "MSFT", "candles": panel_candles(90, phase=2)},
                ],
                market="US",
                horizons=[5],
                market_point_in_time_features=compact["marketPointInTimeFeatures"],
            )
            self.assertTrue(dataset["summary"]["eventFeaturesEnabled"])
            self.assertTrue(dataset["summary"]["marketPointInTimeFeaturesAvailable"])
            self.assertEqual(dataset["summary"]["eventItemCoveragePct"], 0)
            self.assertTrue(all(row["eventCoverage"] == 0.0 for row in dataset["rows"]))
            self.assertTrue(all(row.get("marketEventCoverage", 0.0) == 0.0 for row in dataset["rows"]))

    def test_market_wide_pit_limit_scales_with_training_cross_section(self):
        with tempfile.TemporaryDirectory() as directory:
            records = []
            for index in range(6):
                records.append({
                    "id": f"VIX:{index}",
                    "seriesId": "VIXCLS",
                    "event_time": f"2025-01-{index + 1:02d}T00:00:00Z",
                    "available_at": f"2025-01-{index + 2:02d}T00:00:00Z",
                    "historicalAvailabilityVerified": True,
                    "values": {"macroVolatilityImpulse": -0.1 * index, "macroDataCoverage": 1.0},
                })
            upsert_pit_records({
                "root": directory,
                "dataset": "macro",
                "market": "ASX",
                "symbol": "MARKET",
                "source": "unit-alfred",
                "records": records,
            })
            panel = read_data_lake_pit_panel({
                "root": directory,
                "market": "ASX",
                "symbols": ["AAA", "BBB"],
                "datasets": ["macro"],
                "broadcast_market_wide": False,
                "verified_only": True,
                "limit_per_symbol": 2,
            })
            self.assertEqual(len(panel["marketPointInTimeFeatures"]), 4)
            self.assertEqual(panel["marketPointInTimeFeatures"][-1]["values"]["__seriesId"], "VIXCLS")

    def test_market_wide_universe_pit_routes_to_symbols_and_unverified_rows_do_not_backfill(self):
        with tempfile.TemporaryDirectory() as directory:
            upsert_pit_records({
                "root": directory, "dataset": "universe", "market": "US", "source": "unit-universe",
                "records": [
                    {"id": "AAPL", "symbol": "AAPL", "event_time": "2020-01-02", "available_at": "2020-01-02T20:00:00Z", "historicalAvailabilityVerified": True},
                    {"id": "MSFT", "symbol": "MSFT", "event_time": "2026-07-01", "available_at": "2026-07-01T20:00:00Z", "historicalAvailabilityUnverified": True},
                ],
            })
            panel = read_data_lake_pit_panel({"root": directory, "market": "US", "symbols": ["AAPL", "MSFT"], "datasets": ["universe"]})
            by_symbol = {row["symbol"]: row for row in panel["items"]}
            self.assertEqual(by_symbol["AAPL"]["coverage"]["verifiedUniverse"], 1)
            self.assertEqual(by_symbol["MSFT"]["coverage"]["verifiedUniverse"], 0)
            self.assertTrue(verified_pit_coverage(by_symbol["AAPL"]["universeHistory"], "2020-01-03", "US")["covered"])
            self.assertFalse(verified_pit_coverage(by_symbol["MSFT"]["universeHistory"], "2020-01-03", "US")["covered"])

    def test_orphaned_oof_artifact_is_recovered_as_research_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "asx-5d-test-oof.jsonl.gz"
            with gzip.open(target, "wt", encoding="utf-8") as handle:
                for index in range(180):
                    day = f"2025-{index // 28 + 1:02d}-{index % 28 + 1:02d}"
                    for symbol_index, symbol in enumerate(("BHP.AX", "CBA.AX")):
                        actual = 1.0 if (index + symbol_index) % 3 else 0.0
                        probability = 0.64 if actual else 0.36
                        handle.write(json.dumps({
                            "market": "ASX", "symbol": symbol, "date": day, "horizon": 5,
                            "fold": index % 5 + 1, "actualTarget": actual, "actualStop": 1.0 - actual,
                            "actualTimeout": 0.0, "actualReturn": 2.0 if actual else -1.0,
                            "ridgePrediction": probability, "elasticPrediction": probability * 0.98,
                            "pathSafetyPrediction": probability, "quantilePrediction": probability * 0.96,
                            "rankerPrediction": probability, "dataQuality": 100,
                        }) + "\n")
            recovered = recover_oof_artifacts({"market": "ASX", "artifact_dir": directory})
            self.assertTrue(recovered["available"])
            self.assertTrue(recovered["horizonModels"][0]["available"])
            self.assertFalse(recovered["productionEligibility"]["eligible"])
            self.assertTrue(recovered["horizonModels"][0]["oofArtifact"]["recovered"])

    def test_paper_agents_default_to_no_trade_without_strict_oof_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            result = step_paper_agents({
                "db_path": db_path,
                "market": "US",
                "marketOpen": True,
                "items": [{
                    "market": "US", "symbol": "AAPL", "price": 200,
                    "barTs": "2026-07-13T14:35:00Z", "source": "alpaca-us-real-bars", "fresh": True,
                    "analysis": {"action": "WATCH_BUY", "confidence": 99, "projectedFinalReturn": 12},
                    "technicals": {"close": 200, "trendScore": 90, "volumeRatio": 2.0},
                }],
            })
            self.assertEqual(result["events"], [])
            self.assertTrue(result["noTrade"])

    def test_paper_agent_legacy_constraint_violation_freezes_buys_and_gradually_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            state = load_paper_agent_state("US", db_path)
            state["config"]["requireStrictOof"] = False
            agent = state["ledger"]["agents"][0]
            symbols = [f"S{index}" for index in range(7)]
            agent["cash"] = 9300.0
            agent["positions"] = {
                symbol: {"qty": 1, "avgPrice": 100, "lastPrice": 100, "costBasis": 100, "sector": f"Sector{index}", "entryScore": 40 + index}
                for index, symbol in enumerate(symbols)
            }
            agent["equity"] = 10000.0
            save_paper_agent_state(state, db_path)
            items = [{
                "market": "US", "symbol": symbol, "price": 100,
                "barTs": "2026-07-13T14:40:00Z", "source": "alpaca-us-real-bars", "fresh": True,
                "analysis": {"confidence": 0, "projectedFinalReturn": -1},
                "technicals": {"close": 100, "trendScore": 20, "volumeRatio": 1.0},
            } for symbol in symbols]
            result = step_paper_agents({"db_path": db_path, "market": "US", "marketOpen": True, "items": items})
            self.assertTrue(result["events"])
            self.assertTrue(all(event["side"] == "SELL" for event in result["events"]))
            self.assertTrue(any(event["reason"] == "constraint-migration-gradual-exit" for event in result["events"]))
            self.assertTrue(all("behaviorProbability" in event["policyContext"] for event in result["events"]))
            generations = list_paper_agent_generations({"db_path": db_path, "market": "US"})
            self.assertIn("constraintCompliance", generations["current"])

    def test_paper_agent_generation_archives_v1_and_blocks_non_oof_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            legacy = load_paper_agent_state("ASX", db_path)
            legacy["config"]["generationId"] = "generation_v1"
            for agent in legacy["ledger"]["agents"]:
                agent["generationId"] = "generation_v1"
            save_paper_agent_state(legacy, db_path)
            upgraded = upgrade_paper_agent_generation({"db_path": db_path, "market": "ASX"})
            self.assertTrue(upgraded["upgraded"])
            self.assertEqual(upgraded["config"]["generationId"], "generation_v2")
            generations = list_paper_agent_generations({"db_path": db_path, "market": "ASX"})
            self.assertEqual(generations["archives"][0]["generationId"], "generation_v1")
            replay = replay_paper_agents({
                "db_path": db_path,
                "market": "ASX",
                "samples": [{"predictionId": str(index), "signalAt": "2026-07-01", "outcome": {"resolved": True}} for index in range(150)],
            })
            self.assertFalse(replay["updated"])
            self.assertEqual(replay["strictOofRows"], 0)

    def test_paper_agent_replay_learns_strict_oof_contextual_selector(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            samples = []
            for day in range(400):
                for symbol_index in range(10):
                    win = symbol_index % 2 == 0
                    probability = 0.82 if win else 0.18
                    samples.append({
                        "predictionId": f"{day}:{symbol_index}",
                        "strictOof": True,
                        "market": "US",
                        "symbol": f"S{symbol_index}",
                        "signalAt": (date(2024, 1, 1) + timedelta(days=day)).isoformat(),
                        "horizon": 5,
                        "actualReturn": 2.0 if win else -1.0,
                        "directionProbability": probability,
                        "ridgeDirectionPrediction": probability,
                        "elasticDirectionPrediction": probability,
                        "treeDirectionPrediction": probability,
                        "targetProbability": probability,
                        "stopProbability": 1 - probability,
                        "eventPrediction": probability,
                        "dataQuality": 100,
                        "regime": "trend_up" if day % 2 == 0 else "risk_off",
                    })
            replay = replay_paper_agents({"db_path": db_path, "market": "US", "samples": samples})
            self.assertTrue(replay["updated"])
            self.assertEqual(replay["strictOofRows"], 4000)
            self.assertTrue(replay["strategySelector"]["all"]["selectedStyle"])
            self.assertEqual(replay["strategySelector"]["all"]["method"], "context-conditioned-beta-posterior")

    def test_paper_agent_policy_cannot_pass_by_overfitting_selection_window(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "agents.sqlite3")
            samples = []
            for day in range(400):
                evaluation_period = day >= 272
                for symbol_index in range(10):
                    high_signal = symbol_index < 5
                    win = (not evaluation_period and high_signal) or (evaluation_period and not high_signal)
                    probability = 0.82 if high_signal else 0.18
                    samples.append({
                        "predictionId": f"holdout:{day}:{symbol_index}",
                        "strictOof": True,
                        "market": "US",
                        "symbol": f"Q{symbol_index}",
                        "signalAt": (date(2024, 1, 1) + timedelta(days=day)).isoformat(),
                        "horizon": 5,
                        "actualReturn": 2.0 if win else -2.0,
                        "directionProbability": probability,
                        "ridgeDirectionPrediction": probability,
                        "elasticDirectionPrediction": probability,
                        "treeDirectionPrediction": probability,
                        "targetProbability": probability,
                        "stopProbability": 1 - probability,
                        "dataQuality": 100,
                    })
            replay = replay_paper_agents({"db_path": db_path, "market": "US", "samples": samples})
            self.assertIsNone(replay["strategySelector"]["all"]["selectedStyle"])
            self.assertFalse(replay["policies"]["momentum"]["productionEligible"])
            self.assertIn("selectionEvidence", replay["policies"]["momentum"])

    def test_resume_skips_feature_matrix_created_before_pit_join(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stale_path = root / "datasets" / "cn-5d-stale.json.gz"
            fresh_path = root / "datasets" / "cn-5d-fresh.json.gz"
            base_summary = {
                "symbolCount": 50,
                "dateCount": 600,
                "pointInTimeCoveragePct": 0.0,
            }
            rows = [{"symbol": "000001", "date": "2024-01-02", "horizon": 5}]
            _save_dataset_cache(stale_path, {"rows": rows, "summary": dict(base_summary)}, market="CN", horizon=5)
            dataset, path = _load_latest_eligible_dataset_cache(
                root,
                market="CN",
                horizon=5,
                min_symbols=50,
                min_dates=500,
                require_pit_version=True,
            )
            self.assertIsNone(dataset)
            self.assertIsNone(path)

            _save_dataset_cache(fresh_path, {
                "rows": rows,
                "summary": {**base_summary, "pitDataVersion": "pit-version-1"},
            }, market="CN", horizon=5)
            dataset, path = _load_latest_eligible_dataset_cache(
                root,
                market="CN",
                horizon=5,
                min_symbols=50,
                min_dates=500,
                require_pit_version=True,
            )
            self.assertIsNotNone(dataset)
            self.assertEqual(path, fresh_path.resolve())

    def test_resume_skips_feature_matrix_from_old_event_aggregation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "datasets" / "asx-5d-old-events.json.gz"
            path.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(path, "wt", encoding="utf-8") as handle:
                json.dump({
                    "schema": "market-feature-matrix-v9",
                    "eventAggregationSchema": "pit-event-aggregation-v2",
                    "market": "ASX",
                    "horizon": 5,
                    "dataset": {
                        "rows": [{"symbol": "BHP", "date": "2024-01-02", "horizon": 5}],
                        "summary": {"symbolCount": 200, "dateCount": 600, "pitDataVersion": "pit-1"},
                    },
                }, handle)
            dataset, selected = _load_latest_eligible_dataset_cache(
                directory,
                market="ASX",
                horizon=5,
                min_symbols=100,
                min_dates=500,
                require_pit_version=True,
            )
            self.assertIsNone(dataset)
            self.assertIsNone(selected)

    def test_moving_block_bootstrap_is_date_ordered_and_deterministic(self):
        values = [0.45, 0.50, 0.55, 0.40, 0.60, 0.52, 0.48, 0.58, 0.43, 0.57, 0.51, 0.49]
        first = moving_block_bootstrap_ci(values, repetitions=120)
        second = moving_block_bootstrap_ci(values, repetitions=120)
        self.assertTrue(first["available"])
        self.assertEqual(first, second)
        self.assertEqual(first["primaryBlockLength"], 10)
        self.assertEqual(set(first["blocks"]), {"5", "10", "20"})
        self.assertEqual(first["blocks"]["20"]["effectiveBlockLength"], len(values))
        self.assertLessEqual(first["blocks"]["10"]["low"], first["blocks"]["10"]["high"])
        self.assertLessEqual(first["blocks"]["10"]["low"], first["blocks"]["10"]["mean"])
        self.assertGreaterEqual(first["blocks"]["10"]["high"], first["blocks"]["10"]["mean"])

    def test_live_lockbox_is_content_addressed_and_experiment_log_is_append_only(self):
        with tempfile.TemporaryDirectory() as directory:
            first = create_lockbox(
                market="ASX",
                data_version="data-v1",
                feature_schema_hash="features-v1",
                universe_version="universe-v1",
                label_definition="label-v1",
                test_set_signature="test-v1",
                source_versions=["source-b", "source-a"],
                root=directory,
                independent_test_dates=120,
                row_count=50_000,
            )
            second = create_lockbox(
                market="ASX",
                data_version="data-v1",
                feature_schema_hash="features-v1",
                universe_version="universe-v1",
                label_definition="label-v1",
                test_set_signature="test-v1",
                source_versions=["source-a", "source-b"],
                root=directory,
                independent_test_dates=120,
                row_count=50_000,
            )
            self.assertEqual(first["lockboxId"], second["lockboxId"])
            self.assertEqual(first["status"], "frozen_untouched")
            record_experiment(directory, {"experimentId": "experiment-1", "family": "label", "status": "failed"})
            record_experiment(directory, {"experimentId": "experiment-1", "family": "label", "status": "failed"})
            log = Path(directory) / "experiments" / "experiments.jsonl"
            self.assertEqual(len(log.read_text(encoding="utf-8").splitlines()), 1)

    def test_lockbox_state_machine_is_one_way_and_candidate_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            frozen = create_lockbox(
                market="US",
                data_version="data-v1",
                feature_schema_hash="features-v1",
                universe_version="universe-v1",
                label_definition="label-v1",
                test_set_signature="test-v1",
                root=directory,
            )
            opened = open_lockbox(frozen, candidate_id="candidate-a", root=directory)
            self.assertEqual(opened["status"], "opened")
            self.assertEqual(opened["accessCount"], 1)
            with self.assertRaisesRegex(ValueError, "lockbox_cannot_open_from_opened"):
                open_lockbox(opened, candidate_id="candidate-a", root=directory)
            with self.assertRaisesRegex(ValueError, "lockbox_candidate_mismatch"):
                consume_lockbox(opened, candidate_id="candidate-b", outcome="rejected", root=directory)
            consumed = consume_lockbox(opened, candidate_id="candidate-a", outcome="accepted", root=directory)
            self.assertEqual(consumed["status"], "consumed")
            self.assertEqual(consumed["evaluationOutcome"], "accepted")
            with self.assertRaisesRegex(ValueError, "lockbox_cannot_open_from_consumed"):
                open_lockbox(consumed, candidate_id="candidate-a", root=directory)
            with self.assertRaisesRegex(ValueError, "lockbox_cannot_consume_from_consumed"):
                consume_lockbox(consumed, candidate_id="candidate-a", outcome="accepted", root=directory)

    def test_failed_final_evaluation_still_consumes_lockbox(self):
        with tempfile.TemporaryDirectory() as directory:
            frozen = create_lockbox(
                market="ASX",
                data_version="data-v1",
                feature_schema_hash="features-v1",
                universe_version="universe-v1",
                label_definition="label-v1",
                test_set_signature="test-v1",
                root=directory,
            )

            def failing_evaluator(_lockbox):
                raise RuntimeError("evaluation failed")

            with self.assertRaisesRegex(RuntimeError, "evaluation failed"):
                evaluate_lockbox_once(
                    frozen,
                    candidate_id="candidate-failed",
                    evaluator=failing_evaluator,
                    root=directory,
                )
            persisted = json.loads(Path(frozen["path"]).read_text(encoding="utf-8"))
            self.assertEqual(persisted["status"], "consumed")
            self.assertEqual(persisted["evaluationOutcome"], "failed")

    def test_experiment_ledger_rejects_multiple_changed_hypotheses(self):
        contract = experiment_hypothesis_contract({"changedHypotheses": ["label", "features"]})
        self.assertFalse(contract["valid"])
        with tempfile.TemporaryDirectory() as directory:
            recorded = record_experiment(
                directory,
                {
                    "family": "direction",
                    "status": "completed",
                    "promotionEligible": True,
                    "changedHypotheses": ["label", "features"],
                },
            )
            self.assertEqual(recorded["status"], "rejected_governance")
            self.assertFalse(recorded["promotionEligible"])
            self.assertEqual(recorded["governanceViolation"], "multiple_changed_hypotheses_are_not_comparable")

    def test_model_experiment_requires_one_hypothesis_and_evidence_refresh_requires_zero(self):
        missing = experiment_hypothesis_contract({"jobType": "model_experiment"})
        self.assertFalse(missing["valid"])
        self.assertEqual(missing["hypothesisCount"], 0)
        self.assertTrue(missing["mayReadLockbox"])
        refresh = experiment_hypothesis_contract({"jobType": "evidence_refresh"})
        self.assertTrue(refresh["valid"])
        self.assertFalse(refresh["mayFitModel"])
        self.assertFalse(refresh["mayReadLockbox"])
        self.assertFalse(refresh["mayUpdateChallenger"])
        invalid_refresh = experiment_hypothesis_contract({
            "jobType": "evidence_refresh",
            "changedHypothesis": "must-not-fit",
        })
        self.assertFalse(invalid_refresh["valid"])

    def test_label_tournament_stays_research_only_without_support(self):
        result = run_label_tournament_oof(
            [{"date": "2025-01-01", "symbol": "AAA", "x": [0.0], "actualDirection": 0.0}],
            market="ASX",
            horizon=5,
            config={},
        )
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], "evidence_insufficient")
        self.assertEqual(result["selection"], "null/no-model")

    def test_label_tournament_gate_requires_four_of_five_complete_positive_folds(self):
        weak = {
            "label": "net_up",
            "available": True,
            "foldCount": 5,
            "commonPanelCoveragePct": 100.0,
            "positiveFolds": 3,
            "balancedAccuracyPct": 55.0,
            "brierSkillScore": 0.02,
            "topDecileLift": 0.03,
            "objective": 10.0,
        }
        selected, audited, required = _select_label_tournament_candidate([weak], expected_folds=5)
        self.assertIsNone(selected)
        self.assertEqual(required, 4)
        self.assertFalse(audited[0]["selectionEligible"])
        self.assertIn("positive_fold_gate_failed", audited[0]["rejectionReasons"])

    def test_label_tournament_gate_keeps_sparse_event_car_as_specialist(self):
        general = {
            "label": "market_residual_up",
            "available": True,
            "foldCount": 5,
            "commonPanelCoveragePct": 99.0,
            "positiveFolds": 4,
            "balancedAccuracyPct": 55.0,
            "brierSkillScore": 0.02,
            "topDecileLift": 0.03,
            "objective": 8.0,
        }
        event = {
            **general,
            "label": "event_car_positive",
            "specialistOnly": True,
            "objective": 20.0,
        }
        selected, audited, required = _select_label_tournament_candidate([general, event], expected_folds=5)
        self.assertEqual(required, 4)
        self.assertEqual(selected["label"], "market_residual_up")
        event_audit = next(row for row in audited if row["label"] == "event_car_positive")
        self.assertFalse(event_audit["selectionEligible"])
        self.assertIn("specialist_task_not_comparable_to_general_label_tournament", event_audit["rejectionReasons"])

    def test_fundamental_coverage_is_counted_per_row_not_as_dataset_boolean(self):
        rows = [
            {
                "dataset": "fundamentals",
                "event_time": "2025-01-01T00:00:00Z",
                "available_at": "2025-01-02T00:00:00Z",
                "historicalAvailabilityVerified": True,
                "values": {"revenueGrowth": 0.12},
            },
            {
                "dataset": "fundamentals",
                "event_time": "2025-01-01T00:00:00Z",
                "available_at": "2025-01-02T00:00:00Z",
                "historicalAvailabilityVerified": False,
                "values": {"revenueGrowth": 0.0},
            },
        ]
        result = fundamental_coverage_layers(rows, ["fundamentalRevenueGrowth"])
        self.assertEqual(result["source"], 2)
        self.assertEqual(result["verified"], 1)
        self.assertEqual(result["nonNull"], 2)
        self.assertEqual(result["nonZero"], 1)
        self.assertEqual(result["actionable"], 1)

    def test_pit_semantics_conserves_rows_and_rejects_future_or_unverified_records(self):
        base = {
            "dataset": "fundamentals",
            "market": "US",
            "exchange": "US",
            "symbol": "AAPL",
            "event_time": "2025-01-01T00:00:00Z",
            "available_at": "2025-01-02T00:00:00Z",
            "first_seen_at": "2025-01-02T00:00:01Z",
            "ingested_at": "2025-01-03T00:00:00Z",
            "revision": "v1",
            "source": "sec-us-companyfacts",
            "id": "aapl-2025-01",
            "historicalAvailabilityVerified": True,
        }
        result = audit_pit_records([
            base,
            dict(base),
            {**base, "id": "bad", "available_at": "2024-12-31T00:00:00Z"},
            {**base, "id": "unverified", "historicalAvailabilityVerified": False},
        ], market="US")
        self.assertTrue(result["rowConservation"])
        self.assertEqual(result["rawRows"], 4)
        self.assertEqual(result["duplicateRows"], 1)
        self.assertEqual(result["acceptedRows"], 1)
        self.assertEqual(result["quarantinedRows"], 2)
        self.assertGreater(result["pitViolations"], 0)

    def test_pit_parser_accepts_rfc2822_news_timestamp(self):
        parsed = parse_pit_timestamp("Fri, 17 Jul 2026 07:00:00 GMT")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.isoformat(), "2026-07-17T07:00:00+00:00")

    def test_period_end_is_not_mistaken_for_publication_time(self):
        base = {
            "dataset": "financial_disclosures",
            "market": "US",
            "exchange": "US",
            "symbol": "AAPL",
            "event_time": "2025-01-01T23:59:59Z",
            "available_at": "2025-01-01T12:00:00Z",
            "first_seen_at": "2025-01-01T12:00:01Z",
            "ingested_at": "2025-01-01T12:00:02Z",
            "revision": "filing-1",
            "source": "sec-edgar-filing-history-pit",
            "id": "filing-1",
            "reportDate": "2025-01-01",
            "historicalAvailabilityVerified": True,
        }
        result = audit_pit_records([base], market="US")
        self.assertEqual(result["pitViolations"], 0)
        self.assertEqual(result["acceptedRows"], 1)

    def test_generic_multi_market_sources_are_not_marked_as_cross_market(self):
        row = {
            "dataset": "news",
            "market": "CN",
            "exchange": "SSE",
            "symbol": "000001",
            "event_time": "2025-01-02T00:00:00Z",
            "available_at": "2025-01-02T01:00:00Z",
            "first_seen_at": "2025-01-02T01:00:01Z",
            "ingested_at": "2025-01-02T02:00:00Z",
            "revision": "v1",
            "source": "multi-news",
            "id": "event-1",
            "historicalAvailabilityVerified": True,
        }
        result = audit_pit_records([row], market="CN")
        self.assertEqual(result["acceptedRows"], 1)
        self.assertEqual(result["issueCounts"].get("source_market_mismatch", 0), 0)

    def test_news_identity_keeps_related_symbol(self):
        base = {
            "dataset": "news",
            "market": "US",
            "exchange": "US",
            "symbol": "MARKET",
            "event_time": "2025-01-02T00:00:00Z",
            "available_at": "2025-01-02T00:00:00Z",
            "first_seen_at": "2025-01-02T00:00:01Z",
            "ingested_at": "2025-01-02T01:00:00Z",
            "revision": "initial",
            "source": "multi-news",
            "link": "https://example.test/event",
            "historicalAvailabilityVerified": True,
        }
        result = audit_pit_records([
            {**base, "relatedSymbol": "AAA"},
            {**base, "relatedSymbol": "BBB"},
        ], market="US")
        self.assertEqual(result["acceptedRows"], 2)
        self.assertEqual(result["duplicateRows"], 0)

    def test_source_conflicts_require_an_explicit_disposition(self):
        rows = [
            {"market": "ASX", "exchange": "ASX", "symbol": "BHP", "interval": "1d", "timestamp": "2025-01-01", "source": "source-a", "close": 100, "volume": 1000},
            {"market": "ASX", "exchange": "ASX", "symbol": "BHP", "interval": "1d", "timestamp": "2025-01-01", "source": "source-b", "close": 102, "volume": 1400},
        ]
        result = compare_source_rows(rows)
        self.assertEqual(result["conflictCount"], 1)
        self.assertEqual(result["unresolvedConflictCount"], 1)
        self.assertFalse(result["passed"])
        rows[1]["conflictDisposition"] = "retain-source-a-and-quarantine-source-b"
        result = compare_source_rows(rows)
        self.assertTrue(result["passed"])

    def test_adjustment_identity_and_event_dedupe_are_auditable(self):
        adjustment = validate_adjustment_windows([
            {"id": "ok", "rawPrice": 10, "adjustmentFactor": 1.2, "adjustedPrice": 12},
            {"id": "bad", "rawPrice": 10, "adjustmentFactor": 1.2, "adjustedPrice": 12.1},
        ])
        self.assertEqual(adjustment["checked"], 2)
        self.assertEqual(adjustment["failed"], 1)
        events = cluster_events([
            {"id": "one", "symbol": "BHP", "title": "BHP raises guidance", "url": "https://example.test/a", "available_at": "2025-01-02T00:00:00Z", "source": "a"},
            {"id": "two", "symbol": "BHP", "title": "BHP raises guidance", "url": "https://example.test/a", "available_at": "2025-01-03T00:00:00Z", "source": "b"},
        ])
        self.assertEqual(events["rawEvents"], 2)
        self.assertEqual(events["clusterCount"], 1)
        self.assertEqual(events["dedupeReduction"], 1)

    def test_trading_date_audit_does_not_invent_exchange_holidays(self):
        result = validate_trading_dates(["2025-01-03", "2025-01-04"], market="ASX")
        self.assertEqual(result["weekendOrInvalid"], 1)
        self.assertFalse(result["passed"])
        self.assertFalse(result["holidayCalendarVerified"])

    def test_missingness_and_revision_audits_keep_denominators_explicit(self):
        records = [
            {"market": "CN", "event_time": "2025-01-01", "id": "x", "values": {"roe": 0.1}, "sourceQuality": 1},
            {"market": "CN", "event_time": "2025-01-02", "id": "y", "values": {}, "sourceQuality": None},
        ]
        matrix = missingness_matrix(records, fields=["roe"], expected_rows={"CN:2025": 2})
        self.assertTrue(matrix["denominatorComplete"])
        self.assertEqual(matrix["buckets"][0]["expectedRows"], 2)
        self.assertEqual(matrix["buckets"][0]["missing"]["roe"], 1)
        revisions = revision_chain_audit([
            {"dataset": "fundamentals", "market": "CN", "exchange": "SSE", "symbol": "600000", "event_time": "2024-12-31", "id": "x", "revision": "v1", "available_at": "2025-01-10"},
            {"dataset": "fundamentals", "market": "CN", "exchange": "SSE", "symbol": "600000", "event_time": "2024-12-31", "id": "x", "revision": "v2", "available_at": "2025-02-10"},
        ])
        self.assertTrue(revisions["passed"])
        quality = source_quality_audit(records)
        self.assertEqual(quality["missingQualityRows"], 1)
        self.assertFalse(quality["passed"])

    def test_factor_cards_are_versioned_and_do_not_claim_production_without_oos_evidence(self):
        card = factor_card("5日动量", source_version="fixture-v1")
        self.assertEqual(card["schema"], "factor-card-v2-pit-panel")
        self.assertTrue(card["formulaHash"])
        self.assertIn("available_at", card["pointInTimeRule"])
        rows = []
        for day in range(15):
            for symbol in range(12):
                rows.append({"date": f"2025-01-{day + 1:02d}", "pitEligible": True, "factors": {"x": symbol + day / 100}, "x": symbol + day / 100, "label": 0.01 if symbol >= 6 else -0.01})
        result = evaluate_factor(rows, "x", min_breadth=10)
        self.assertEqual(result["eligibleDates"], 15)
        self.assertEqual(result["status"], "insufficient_dates")

    def test_factor_pool_quarantines_redundant_or_sparse_factors(self):
        rows = []
        for day in range(12):
            for symbol in range(10):
                value = symbol + day / 100
                rows.append({"date": f"2025-01-{day + 1:02d}", "pitEligible": True, "factors": {"a": value, "b": value}, "label": 0.02 if symbol > 5 else -0.01})
        result = factor_pool_audit(rows, ["a", "b"], min_dates=120)
        self.assertEqual(result["admitted"], [])
        self.assertEqual(len(result["redundancy"]), 1)
        self.assertEqual(set(result["rejectedOrWatchlist"]), {"a", "b"})

    def test_model_family_contract_rejects_null_and_requires_strict_oof(self):
        self.assertEqual(family_contract("catboost_yetirank")["task"], "ranking")
        result = candidate_admission({"family": "elasticnet_logistic", "status": "NO_MODEL", "oofRows": 0}, {}, family="elasticnet_logistic")
        self.assertFalse(result["eligible"])
        self.assertIn("candidate_is_null_or_failed", result["reasons"])
        self.assertIn("strict_oof_not_proven", result["reasons"])

    def test_model_selection_uses_one_standard_error_and_empty_family_is_valid(self):
        selected = choose_shallowest_one([
            {"id": "deep", "selectionScore": 0.10, "standardError": 0.02, "complexity": 6},
            {"id": "shallow", "selectionScore": 0.115, "standardError": 0.02, "complexity": 2},
        ])
        self.assertEqual(selected["id"], "shallow")
        result = qualified_family_models([])
        self.assertEqual(result["selected"], {})
        self.assertTrue(result["emptyIsValid"])

    def test_calibration_split_separates_lockbox_and_purge_dates(self):
        rows = [{"date": f"2025-01-{day:02d}", "probability": 0.55, "actualTarget": day % 2} for day in range(1, 31)]
        result = chronological_calibration_split(rows, purge_days=2, embargo_days=2)
        self.assertTrue(result["available"])
        self.assertTrue(set(result["fitDates"]).isdisjoint(result["calibrationDates"]))
        self.assertTrue(set(result["lockboxDates"]).isdisjoint(result["selectionDates"]))
        self.assertGreaterEqual(len(result["purgedDates"]), 2)

    def test_calibration_requires_real_bucket_support(self):
        rows = [{"date": f"2025-01-{day:02d}", "actualTarget": day % 2} for day in range(1, 21)]
        result = calibration_diagnostics(rows, [0.5] * len(rows))
        self.assertFalse(result["resolutionPassed"])
        self.assertEqual(result["occupiedBuckets"], 1)
        self.assertFalse(no_trade_gate(probability=.61, lower_probability=.55, expected_value_pct=.2, lower_return_pct=.1, data_quality_ok=True, model_evidence_ok=False)["trade"])

    def test_calibrator_selection_does_not_read_lockbox(self):
        fit = [{"date": f"2025-01-{day:02d}", "probability": 0.45 + (day % 4) * .03, "actualTarget": day % 2} for day in range(1, 31)]
        calibration = [{"date": f"2025-03-{day:02d}", "probability": 0.46 + (day % 3) * .04, "actualTarget": (day + 1) % 2} for day in range(1, 11)]
        result = choose_calibrator(fit, calibration)
        self.assertFalse(result["selection"]["usesLockbox"])
        self.assertNotIn("lockbox", result["selection"])

    def test_evolution_state_machine_and_pivot_are_monotone(self):
        running = transition_task({"id": "G1", "status": "TODO"}, "RUNNING")
        evidence = transition_task(running, "EVIDENCE_READY", evidence_id="ev1")
        self.assertEqual(evidence["evidenceId"], "ev1")
        with self.assertRaises(ValueError):
            transition_task(evidence, "TODO")
        failure = failure_evidence(root_cause="native-runtime", attempt=1, evidence_id="ev1", next_action="rebuild-worker", task_id="G1")
        self.assertEqual(repeated_root_cause_action([failure, {**failure, "attempt": 2}, {**failure, "attempt": 3}], "native-runtime")["action"], "BLOCKED_PIVOT")
        self.assertFalse(new_evidence_required({"snapshotId": "s1", "changedHypothesis": "h1"}, snapshot_id="s1", changed_hypothesis="h1")["shouldRun"])

    def test_champion_replacement_requires_comparable_noninferior_candidate(self):
        incumbent = {"modelVersion": "old", "comparisonKey": "same", "metrics": {"balancedAccuracyPct": 55, "brierSkill": .01, "topDecileNetReturn": .1}}
        candidate = {"modelVersion": "new", "comparisonKey": "same", "status": "AVAILABLE", "strictOof": True, "metrics": {"balancedAccuracyPct": 56, "brierSkill": .02, "topDecileNetReturn": .1}}
        self.assertTrue(champion_replacement(candidate, incumbent)["replace"])
        self.assertFalse(champion_replacement({**candidate, "comparisonKey": "other"}, incumbent)["replace"])
        self.assertFalse(dependency_gate({"id": "G2", "dependencies": ["G1"]}, [{"id": "G1", "status": "RUNNING"}])["unlocked"])

    def test_portfolio_contracts_enforce_cash_cost_and_no_trade(self):
        cost = cost_impact(notional=20_000, average_dollar_volume=10_000)
        self.assertTrue(cost["capacityWarning"])
        audit = portfolio_constraint_audit([{"symbol": "A", "sector": "tech", "marketValue": 80}], equity=100, cash=20, max_position_pct=.5, min_cash_pct=.25)
        self.assertFalse(audit["compliant"])
        signal = {"modelEvidenceOk": True, "dataQualityOk": True, "marketOpen": True, "fresh": True, "expectedValuePct": .4, "probability": .61, "threshold": .57}
        self.assertEqual(paper_signal_decision(signal)["action"], "BUY")
        result = run_executable_paper_backtest([{**signal, "symbol": "A", "signalDate": "2025-01-01", "entryPrice": 10, "exitPrice": 11, "averageDollarVolume": 100_000}], initial_cash=1000)
        self.assertTrue(result["paperOnly"])
        self.assertFalse(result["orderExecutionEnabled"])

    def test_python_client_request_encodes_json_and_query(self):
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self):
                return b'{"ok":true}'

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["method"] = request.get_method()
            captured["body"] = request.data.decode("utf-8")
            captured["timeout"] = timeout
            captured["content_type"] = request.get_header("Content-type")
            return FakeResponse()

        with patch("urllib.request.urlopen", fake_urlopen):
            result = ApiClient("http://127.0.0.1:8787", timeout=7).request(
                "POST",
                "/api/risk-assessment",
                {"market": "US"},
                {"positions": []},
            )
        self.assertTrue(result["ok"])
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["body"], '{"positions": []}')
        self.assertEqual(captured["timeout"], 7)
        self.assertEqual(captured["content_type"], "application/json")
        self.assertIn("market=US", captured["url"])


if __name__ == "__main__":
    unittest.main()
