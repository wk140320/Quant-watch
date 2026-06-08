import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from alpha_mining import analyze_alpha_evolution  # noqa: E402
from features import analyze_factors, analyze_features  # noqa: E402
from provider_budget import provider_plan  # noqa: E402
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

    def test_qlib_readiness_operation_is_optional(self):
        result = dispatch({"operation": "qlib-readiness"})
        self.assertIn("available", result)
        self.assertIn("models", result)
        self.assertEqual({row["id"] for row in result["models"]}, {"lightgbm", "lstm", "transformer"})
        self.assertIn("dimensionless", result["factor_gate_required"])

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
