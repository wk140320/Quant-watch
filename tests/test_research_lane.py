import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from research_governance import experiment_hypothesis_contract  # noqa: E402
from research_lane import (  # noqa: E402
    ALLOWED_LANES,
    adaptive_fold_count,
    default_horizons,
    evidence_tier,
    load_research_contract,
    research_artifact_root,
    research_lockbox_fields,
    resolve_training_lane,
    research_retry_policy,
    validate_training_request,
)


class ResearchLaneContractTests(unittest.TestCase):
    def test_contract_has_five_ordered_lanes(self):
        contract, digest = load_research_contract()
        self.assertEqual(tuple(row["id"] for row in contract["lanes"]), ALLOWED_LANES)
        self.assertEqual(len(digest), 64)

    def test_default_is_strict_and_gate03_blocks_it(self):
        policy = resolve_training_lane({})
        self.assertEqual(policy["lane"], "strict_production")
        self.assertFalse(policy["explicit"])
        decision = validate_training_request({}, hypothesis_contract=experiment_hypothesis_contract({"changedHypotheses": ["baseline"]}))
        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["reason"], "strict_production_blocked_by_gate03")

    def test_research_requires_explicit_identity_and_cannot_promote(self):
        missing = validate_training_request({"trainingLane": "core_research"})
        self.assertFalse(missing["allowed"])
        self.assertEqual(missing["reason"], "research_requires_experiment_and_hypothesis_id")
        payload = {
            "trainingLane": "core_research",
            "experimentId": "exp-001",
            "hypothesisId": "h-001",
            "changedHypotheses": ["10-day net-up label"],
        }
        decision = validate_training_request(payload, hypothesis_contract=experiment_hypothesis_contract(payload))
        self.assertTrue(decision["allowed"])
        self.assertFalse(decision["promotionEligible"])
        self.assertFalse(decision["championUpdateAllowed"])
        self.assertFalse(decision["longTradeGateAllowed"])

    def test_research_defaults_and_adaptive_fold_policy(self):
        self.assertEqual(default_horizons({"trainingLane": "core_research"}, "core_research"), [10, 20])
        self.assertEqual(default_horizons({}, "strict_production"), [5, 15, 30])
        self.assertEqual(adaptive_fold_count(29), 0)
        self.assertEqual(adaptive_fold_count(30), 3)
        self.assertEqual(adaptive_fold_count(60), 4)
        self.assertEqual(adaptive_fold_count(120), 5)

    def test_research_search_budget_is_hard_capped(self):
        payload = {
            "trainingLane": "core_research",
            "experimentId": "exp-budget",
            "hypothesisId": "h-budget",
            "changedHypotheses": ["bounded search"],
        }
        contract = experiment_hypothesis_contract(payload)
        accepted = validate_training_request({
            **payload,
            "searchBudget": {"familiesPerLabel": 8, "configsPerFamily": 12, "seedsForFinalists": 3, "deepArchitectures": 3},
        }, hypothesis_contract=contract)
        self.assertTrue(accepted["allowed"])
        rejected = validate_training_request({
            **payload,
            "searchBudget": {"familiesPerLabel": 9},
        }, hypothesis_contract=contract)
        self.assertFalse(rejected["allowed"])
        self.assertEqual(rejected["reason"], "research_search_budget_exceeded:familiesPerLabel")

    def test_research_auto_retry_is_rejected(self):
        payload = {
            "trainingLane": "core_research",
            "experimentId": "exp-retry",
            "hypothesisId": "h-retry",
            "changedHypotheses": ["same hypothesis"],
            "automaticRetry": True,
        }
        self.assertFalse(research_retry_policy(payload)["allowed"])
        decision = validate_training_request(payload, hypothesis_contract=experiment_hypothesis_contract(payload))
        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["reason"], "research_auto_retry_forbidden")

    def test_evidence_tier_is_research_only(self):
        result = evidence_tier(
            independent_dates=30,
            signal_count=300,
            balanced_accuracy_pct=52.0,
            brier_skill=0.001,
            ece_pct=8.0,
            top10_hit_rate_pct=52.0,
            net_ev=0.01,
            positive_folds=2,
        )
        self.assertEqual(result["tier"], "D1")
        self.assertFalse(result["promotionEligible"])

    def test_artifact_and_lockbox_identity_include_lane(self):
        path = research_artifact_root(
            ".cache/models/research",
            market="ASX",
            lane="core_research",
            hypothesis_id="h/001",
            data_version="data-v1",
            run_id="run-1",
        )
        self.assertIn("core_research", str(path))
        self.assertIn("h_001", str(path))
        fields = research_lockbox_fields(
            lane="core_research",
            universe_hash="u",
            label_hash="l",
            feature_hash="f",
            cost_hash="c",
            split_hash="s",
        )
        self.assertEqual(fields["trainingLane"], "core_research")
        self.assertEqual(len(fields["laneHash"]), 32)


if __name__ == "__main__":
    unittest.main()
