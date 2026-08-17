import gzip
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from alpha_mining import analyze_alpha_evolution  # noqa: E402
from data_quality import assess_candle_quality  # noqa: E402
from data_lake import (  # noqa: E402
    audit as audit_data_lake,
    migrate_asx_financial_disclosures,
    read_panel as read_data_lake_panel,
    read_pit_panel as read_data_lake_pit_panel,
    read_rows as read_data_lake_rows,
    summary as data_lake_summary,
    upsert as upsert_data_lake,
    upsert_panel as upsert_data_lake_panel,
    upsert_pit_batches,
    upsert_pit_records,
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
    prediction_id,
    quantile_metrics,
    rank_metrics,
    read_oof_rows,
)
from paper_agents import configure as configure_paper_agents, list_agent_events, list_generations as list_paper_agent_generations, load_state as load_paper_agent_state, migrate as migrate_paper_agents, replay_oof as replay_paper_agents, save_state as save_paper_agent_state, step as step_paper_agents, upgrade_generation as upgrade_paper_agent_generation  # noqa: E402
from pit_ingest import normalize_baostock_adjust_factors  # noqa: E402
from provider_budget import provider_plan  # noqa: E402
from production_training import _combine_company_market_point_in_time, _date_level_regime_predictions, _event_fold_predictions, _fallback_baseline_predictions, _fold_checkpoint_context, _load_latest_eligible_dataset_cache, _point_in_time_features_from_prepared, _prepare_point_in_time_candidates, _rank_cross_section, _save_dataset_cache, _training_feature_family_gate, _training_feature_profile_gate, _training_stable_feature_panel, brier_skilled_models, build_market_dataset, calibration_metrics, diagnostic_bucket_summary, fit_constrained_stack, fit_false_positive_risk_head, fit_long_trade_gate, fit_probability_calibrator, fit_selective_ranking_head, hydrate_verified_pit_from_data_lake, point_in_time_features, purged_walk_forward_folds, recover_oof_artifacts, select_robust_direction_models, verified_pit_coverage  # noqa: E402
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
        self.assertIn("actualDirection", dataset["rows"][0])
        self.assertEqual(len(dataset["rows"][0]["x"]), dataset["summary"]["activeFeatureCount"])
        folds = purged_walk_forward_folds(dataset["rows"], horizon=5, fold_count=3, embargo_days=7, min_train_dates=70, test_dates=25)
        self.assertGreaterEqual(len(folds), 2)
        dates = sorted({row["date"] for row in dataset["rows"]})
        for fold in folds:
            train_index = dates.index(fold["trainEnd"])
            test_index = dates.index(fold["testStart"])
            self.assertGreaterEqual(test_index - train_index - 1, 12)

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
                "eventX": [1.0, index / 2_100.0, (index % 7) / 7.0],
                "actualTarget": 1.0 if index % 3 else 0.0,
                "trainingWeight": 1.0,
            }
            for index in range(2_100)
        ]
        test = [
            {"eventCoverage": 1.0, "eventX": [1.0, index / 20.0, (index % 5) / 5.0]}
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
            artifact = model["oofArtifact"]
            self.assertIsNotNone(artifact)
            artifact_path = Path(temp_dir) / artifact["filename"]
            self.assertTrue(artifact_path.exists())
            self.assertTrue(result["manifest"]["training_run_id"])
            with gzip.open(artifact_path, "rt", encoding="utf-8") as stream:
                first_oof = json.loads(next(stream))
            self.assertEqual(len(first_oof["predictionId"]), 32)
            self.assertEqual(first_oof["modelVersion"], model["modelVersion"])
            resumed = dispatch(payload)["horizonModels"][0]
            self.assertEqual(resumed["foldCheckpoint"]["resumedFolds"], 3)

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
