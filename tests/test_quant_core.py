import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from alpha_mining import analyze_alpha_evolution  # noqa: E402
from data_quality import assess_candle_quality  # noqa: E402
from features import analyze_cross_sectional_factors, analyze_factors, analyze_features  # noqa: E402
from historical_backtest import adaptive_barriers, outcome_window, run_historical_backtest  # noqa: E402
from local_model import train_local_model_suite  # noqa: E402
from paper_agents import configure as configure_paper_agents, list_agent_events, load_state as load_paper_agent_state, migrate as migrate_paper_agents, step as step_paper_agents  # noqa: E402
from provider_budget import provider_plan  # noqa: E402
from production_training import build_market_dataset, fit_constrained_stack, point_in_time_features, purged_walk_forward_folds  # noqa: E402
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
                "createdAt": f"2026-03-{(index % 28) + 1:02d}T09:{index % 60:02d}:00Z",
                "asOfDate": f"2026-03-{(index % 28) + 1:02d}",
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
                    "resolvedAt": f"2026-04-{(index % 28) + 1:02d}T09:{index % 60:02d}:00Z",
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
        self.assertGreater(len(research["weights"]), 0)
        self.assertIn("ml_backtest", research)
        self.assertIn("leakage_control", research)
        self.assertIn("admission_status", result["factors"][0])
        self.assertIn("dynamic_weight_pct", result["factors"][0])

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
        self.assertNotIn("_values", first)

    def test_cross_sectional_factor_research_generates_market_weights(self):
        result = analyze_cross_sectional_factors(panel_items(230), market="US", horizons=[5, 10, 30], min_symbols=4)
        self.assertTrue(result["available"])
        self.assertEqual(result["framework"], "market-cross-sectional-factor-research")
        self.assertGreater(len(result["aggregate_weights"]), 0)
        available = [row for row in result["horizon_results"] if row["available"]]
        self.assertGreaterEqual(len(available), 2)
        first = available[0]
        self.assertIn("ml_backtest", first)
        self.assertIn("weights", first)
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
        self.assertEqual(result["splitAudit"]["method"], "purged_walk_forward_embargo")
        self.assertGreater(result["splitAudit"]["testSamples"], 0)
        self.assertIn("target", result["calibrationDiagnostics"])
        self.assertIn("stop", result["calibrationDiagnostics"])
        self.assertEqual(result["noTradeGate"]["framework"], "no-trade-quality-gate")
        self.assertGreater(result["noTradeGate"]["sampleCount"], 0)
        self.assertEqual(result["signalModels"]["splitAudit"]["method"], "purged_walk_forward_embargo")
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
                {"available_at": "2025-02-01T08:00:00Z", "values": {"eventSentiment": 0.7}},
                {"available_at": "2025-05-01T08:00:00Z", "values": {"eventSentiment": -0.9}},
            ]
        }
        joined = point_in_time_features(item, "2025-03-01", "US")
        self.assertEqual(joined["sourceRows"], 1)
        self.assertEqual(joined["futureRowsExcluded"], 1)
        self.assertEqual(joined["joinViolationCount"], 0)
        self.assertGreater(joined["values"]["eventSentiment"], 0)

    def test_market_dataset_and_purged_folds_keep_training_before_test(self):
        dataset = build_market_dataset(panel_items(230), market="US", horizons=[5], target_upside=3, stop_loss=3)
        self.assertGreater(dataset["summary"]["rawRows"], 500)
        self.assertEqual(dataset["summary"]["pointInTimeJoinViolationCount"], 0)
        folds = purged_walk_forward_folds(dataset["rows"], horizon=5, fold_count=3, embargo_days=7, min_train_dates=70, test_dates=25)
        self.assertGreaterEqual(len(folds), 2)
        dates = sorted({row["date"] for row in dataset["rows"]})
        for fold in folds:
            train_index = dates.index(fold["trainEnd"])
            test_index = dates.index(fold["testStart"])
            self.assertGreaterEqual(test_index - train_index - 1, 12)

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

    def test_worker_trains_market_multitask_candidate_and_persists_oof(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            result = dispatch({
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
            })
            self.assertTrue(result["available"])
            self.assertEqual(result["framework"], "market-level-multitask-oof-calibrated-stack")
            model = result["horizonModels"][0]
            self.assertTrue(model["available"])
            self.assertIn("elasticPrediction", model["models"] + [row.get("model") for row in model["prunedModels"]])
            self.assertEqual(model["leakageControl"]["entry"], "next-session VWAP/open")
            self.assertFalse(result["productionEligibility"]["eligible"])
            artifact = model["oofArtifact"]
            self.assertIsNotNone(artifact)
            self.assertTrue((Path(temp_dir) / artifact["filename"]).exists())

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
        self.assertGreater(len(result["aggregate_weights"]), 0)
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
