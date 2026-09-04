"""Research/production lane policy for the constrained-data training plan.

The research lane is deliberately explicit.  It can produce auditable
research evidence while Gate03 is closed, but it cannot create a production
candidate, update a Champion, or activate a real long-trade gate.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


CONTRACT_PATH = Path(__file__).resolve().parent / "contracts" / "research-evidence-tier-v2.json"
ALLOWED_LANES = (
    "core_research",
    "sparse_expert",
    "transfer_research",
    "prequential_shadow",
    "strict_production",
)
RESEARCH_LANES = frozenset(ALLOWED_LANES[:-1])
LANE_TO_EVIDENCE_TIER = {
    "core_research": "D1",
    "sparse_expert": "D1",
    "transfer_research": "D1",
    "prequential_shadow": "D3",
    "strict_production": "D4",
}
EVIDENCE_TYPES = {
    "D1": "restricted_oof",
    "D2": "robust_research",
    "D3": "prequential_shadow",
    "D4": "strict_production",
}
SEARCH_BUDGET_KEYS = ("familiesPerLabel", "configsPerFamily", "seedsForFinalists", "deepArchitectures")


class ResearchLaneError(ValueError):
    """Raised when a training request violates the lane contract."""


def _canonical_hash(value: Any, length: int = 64) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:length]


def load_research_contract(path: str | Path | None = None) -> tuple[dict[str, Any], str]:
    contract_path = Path(path).expanduser().resolve() if path else CONTRACT_PATH
    try:
        body = contract_path.read_bytes()
        contract = json.loads(body.decode("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ResearchLaneError(f"research_contract_unavailable:{contract_path}") from exc
    required = {"schema", "lanes", "researchEvidence", "strictLane", "nonPromotionRules"}
    missing = sorted(required.difference(contract))
    if missing:
        raise ResearchLaneError(f"research_contract_missing:{','.join(missing)}")
    if contract.get("schema") != "research-evidence-tier-v2":
        raise ResearchLaneError("research_contract_schema_mismatch")
    lane_ids = [str(row.get("id") or "") for row in contract.get("lanes") or [] if isinstance(row, dict)]
    if tuple(lane_ids) != ALLOWED_LANES:
        raise ResearchLaneError("research_contract_lane_ids_mismatch")
    return contract, hashlib.sha256(body).hexdigest()


def resolve_training_lane(payload: dict[str, Any] | None) -> dict[str, Any]:
    payload = payload or {}
    raw = payload.get("trainingLane", payload.get("training_lane"))
    explicit = raw is not None and str(raw).strip() != ""
    lane = str(raw or "strict_production").strip().lower()
    if lane not in ALLOWED_LANES:
        raise ResearchLaneError(f"unknown_training_lane:{lane}")
    contract, contract_hash = load_research_contract()
    return {
        "lane": lane,
        "explicit": explicit,
        "researchOnly": lane in RESEARCH_LANES,
        "evidenceTier": LANE_TO_EVIDENCE_TIER[lane],
        "evidenceType": EVIDENCE_TYPES[LANE_TO_EVIDENCE_TIER[lane]],
        "contractSchema": contract["schema"],
        "contractHash": contract_hash,
        "strictGateFrozen": contract["strictLane"].get("productionGateChanged") is False,
        "searchBudget": dict(contract.get("modelSearchBudget") or {}),
    }


def validate_training_request(
    payload: dict[str, Any] | None,
    *,
    hypothesis_contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    policy = resolve_training_lane(payload)
    payload = payload or {}
    if policy["researchOnly"] and not policy["explicit"]:
        return {**policy, "allowed": False, "reason": "research_training_lane_must_be_explicit"}
    if policy["researchOnly"]:
        retry_policy = research_retry_policy(payload)
        if not retry_policy["allowed"]:
            return {**policy, "allowed": False, "reason": retry_policy["reason"]}
        experiment_id = str(payload.get("experimentId", payload.get("experiment_id", "")) or "").strip()
        hypothesis_id = str(payload.get("hypothesisId", payload.get("hypothesis_id", "")) or "").strip()
        if not experiment_id or not hypothesis_id:
            return {**policy, "allowed": False, "reason": "research_requires_experiment_and_hypothesis_id"}
        if hypothesis_contract and not hypothesis_contract.get("valid"):
            return {**policy, "allowed": False, "reason": str(hypothesis_contract.get("rejectionReason") or "invalid_experiment_hypothesis")}
        requested_budget = payload.get("searchBudget", payload.get("search_budget"))
        if isinstance(requested_budget, dict):
            for key in SEARCH_BUDGET_KEYS:
                if key not in requested_budget or requested_budget[key] is None:
                    continue
                try:
                    value = int(requested_budget[key])
                    maximum = int(policy["searchBudget"].get(key))
                except (TypeError, ValueError):
                    return {**policy, "allowed": False, "reason": f"invalid_research_search_budget:{key}"}
                if value < 1 or value > maximum:
                    return {**policy, "allowed": False, "reason": f"research_search_budget_exceeded:{key}"}
        return {
            **policy,
            "allowed": True,
            "reason": "Gate03 strict block may be bypassed only for explicitly identified research evidence.",
            "promotionEligible": False,
            "autoPromotionAllowed": False,
            "championUpdateAllowed": False,
            "longTradeGateAllowed": False,
        }
    approved = bool(
        payload.get("strictGate03Approved", payload.get("strict_gate03_approved", payload.get("gate03NextPhasePermitted", False)))
    )
    if not approved:
        return {
            **policy,
            "allowed": False,
            "reason": "strict_production_blocked_by_gate03",
            "promotionEligible": False,
            "autoPromotionAllowed": False,
            "championUpdateAllowed": False,
            "longTradeGateAllowed": False,
        }
    return {
        **policy,
        "allowed": True,
        "reason": "strict_production_gate03_approved",
        "promotionEligible": True,
        "autoPromotionAllowed": False,
        "championUpdateAllowed": True,
        "longTradeGateAllowed": True,
    }


def research_retry_policy(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Research candidates require a new explicit hypothesis for a retry."""
    payload = payload or {}
    automatic = payload.get("automaticRetry", payload.get("automatic_retry", False)) is True
    if automatic:
        return {
            "allowed": False,
            "reason": "research_auto_retry_forbidden",
            "sameHypothesisQueueDelta": 0,
        }
    return {
        "allowed": True,
        "reason": "manual_or_new_hypothesis_required",
        "sameHypothesisQueueDelta": 0,
    }


def default_horizons(payload: dict[str, Any] | None, lane: str) -> list[int]:
    payload = payload or {}
    raw = payload.get("horizons", payload.get("horizon_days", payload.get("horizonDays")))
    if raw is not None:
        values = raw if isinstance(raw, list) else [raw]
        normalized = sorted({max(1, min(60, int(float(value)))) for value in values if value is not None and str(value).strip()})
        if normalized:
            return normalized
    return [10, 20] if lane in RESEARCH_LANES else [5, 15, 30]


def adaptive_fold_count(independent_dates: int) -> int:
    dates = int(independent_dates or 0)
    if dates >= 120:
        return 5
    if dates >= 60:
        return 4
    if dates >= 30:
        return 3
    return 0


def evidence_tier(
    *,
    independent_dates: int,
    signal_count: int,
    balanced_accuracy_pct: float | None,
    brier_skill: float | None,
    ece_pct: float | None,
    top10_hit_rate_pct: float | None,
    top10_ci_lower_pct: float | None = None,
    net_ev: float | None = None,
    positive_folds: int = 0,
    max_drawdown_pct: float | None = None,
) -> dict[str, Any]:
    """Classify evidence conservatively; this function never returns D4."""
    dates = int(independent_dates or 0)
    signals = int(signal_count or 0)
    ba = float(balanced_accuracy_pct) if balanced_accuracy_pct is not None else float("nan")
    bss = float(brier_skill) if brier_skill is not None else float("nan")
    ece = float(ece_pct) if ece_pct is not None else float("nan")
    top10 = float(top10_hit_rate_pct) if top10_hit_rate_pct is not None else float("nan")
    ci_lower = float(top10_ci_lower_pct) if top10_ci_lower_pct is not None else float("nan")
    ev = float(net_ev) if net_ev is not None else float("nan")
    dd = float(max_drawdown_pct) if max_drawdown_pct is not None else float("nan")

    d3 = (
        dates >= 60 and signals >= 300 and ba >= 54.0 and bss >= 0.005 and ece <= 5.0
        and top10 >= 55.0 and ci_lower > 50.0 and ev > 0 and positive_folds >= 3
        and dd <= 15.0
    )
    d2 = (
        dates >= 60 and signals >= 300 and ba >= 54.0 and bss >= 0.005 and ece <= 6.0
        and top10 >= 55.0 and ci_lower > 50.0 and ev > 0 and positive_folds >= 3
        and dd <= 20.0
    )
    d1 = (
        dates >= 30 and signals >= 300 and ba >= 52.0 and bss > 0.0 and ece <= 8.0
        and top10 >= 52.0 and ev > 0 and positive_folds >= 2
    )
    tier = "D3" if d3 else "D2" if d2 else "D1" if d1 else "D0"
    return {
        "tier": tier,
        "evidenceType": EVIDENCE_TYPES.get(tier, "research_diagnostic"),
        "promotionEligible": False,
        "independentDates": dates,
        "signalCount": signals,
        "positiveFolds": int(positive_folds or 0),
        "checks": {
            "minimumDatesD1": dates >= 30,
            "minimumSignalsD1": signals >= 300,
            "balancedAccuracyD1": ba >= 52.0,
            "brierSkillD1": bss > 0.0,
            "eceD1": ece <= 8.0,
            "top10D1": top10 >= 52.0,
            "netEvD1": ev > 0,
            "positiveFoldsD1": int(positive_folds or 0) >= 2,
            "robustD2": d2,
            "shadowD3": d3,
        },
    }


def research_artifact_root(
    root: str | Path | None,
    *,
    market: str,
    lane: str,
    hypothesis_id: str,
    data_version: str | None,
    run_id: str,
) -> Path:
    def safe(value: Any, fallback: str) -> str:
        text = str(value or fallback).strip()
        return re.sub(r"[^A-Za-z0-9_.-]+", "_", text)[:96] or fallback

    base = Path(root or ".cache/models/research").expanduser().resolve()
    return base / safe(market, "market") / safe(lane, "lane") / safe(hypothesis_id, "hypothesis") / safe(data_version, "data") / safe(run_id, "run")


def research_lockbox_fields(
    *,
    lane: str,
    universe_hash: str | None,
    label_hash: str | None,
    feature_hash: str | None,
    cost_hash: str | None,
    split_hash: str | None,
) -> dict[str, Any]:
    return {
        "trainingLane": lane,
        "universeHash": universe_hash,
        "labelHash": label_hash,
        "featureHash": feature_hash,
        "costHash": cost_hash,
        "splitHash": split_hash,
        "laneHash": _canonical_hash({"lane": lane, "universeHash": universe_hash, "labelHash": label_hash, "featureHash": feature_hash, "costHash": cost_hash, "splitHash": split_hash}, 32),
    }
