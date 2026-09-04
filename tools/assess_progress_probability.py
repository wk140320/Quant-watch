#!/usr/bin/env python3
"""Create an evidence-backed decision for the strict lane and fallback lane.

The probability fields are operational decision bands, not statistical claims
about future returns.  They are intentionally conservative: repeated source
failures and an incomplete strict PIT panel can trigger a research fallback,
but can never lower the production gate or manufacture OOF evidence.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
GATE_PATH = REPORTS / "gate03-2026-08-29" / "03数据语义与信息增量-gate.json"
ASX_AUDIT_PATH = REPORTS / "asx-numeric-pit-audit.json"
READINESS_PATH = REPORTS / "data-readiness-ceiling-2026-09-01.json"
FETCH_PATH = REPORTS / "asx-report-fetch-20260901.json"
OUT_PATH = REPORTS / "progress-probability-20260902.json"
FALLBACK_PATH = REPORTS / "research-fallback-activation-20260902.json"


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def file_hash(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed == parsed and abs(parsed) != float("inf") else fallback


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{__import__('os').getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    generated_at = datetime.now(timezone.utc).isoformat()
    gate = read_json(GATE_PATH)
    asx_audit = read_json(ASX_AUDIT_PATH)
    readiness = read_json(READINESS_PATH)
    fetch = read_json(FETCH_PATH)
    market_baseline = readiness.get("marketBaseline") or {}
    asx_gate = (gate.get("markets") or {}).get("ASX") or {}

    cumulative_attempts = int(fetch.get("cumulativeCandidateCount") or 0)
    cumulative_accepted = int(fetch.get("cumulativeAccepted") or 0)
    asx_strict_pct = number(asx_audit.get("trainingUniverseStrictNumericCoveragePct"))
    strict_lane_blocked = gate.get("nextPhasePermitted") is not True
    no_model_fit = gate.get("modelFitStarted") is False

    # This is a policy band based on observed operational evidence.  It is not
    # a probability model and must not be presented as expected return odds.
    asx_path_lt5 = (
        cumulative_attempts >= 20
        and cumulative_accepted == 0
        and asx_strict_pct < 5.0
        and strict_lane_blocked
    )
    strict_all_market_lt5 = strict_lane_blocked and no_model_fit

    assessment = {
        "schema": "progress-probability-decision-v1",
        "generatedAt": generated_at,
        "estimateType": "operational-decision-band",
        "warning": "Bands are not statistical forecasts of returns or model accuracy; they only decide whether to keep retrying the current data path.",
        "evidence": {
            "gate03": str(GATE_PATH),
            "asxNumericPitAudit": str(ASX_AUDIT_PATH),
            "dataReadinessCeiling": str(READINESS_PATH),
            "asxFetchReceipt": str(FETCH_PATH),
            "sha256": {
                "gate03": file_hash(GATE_PATH),
                "asxNumericPitAudit": file_hash(ASX_AUDIT_PATH),
                "dataReadinessCeiling": file_hash(READINESS_PATH),
                "asxFetchReceipt": file_hash(FETCH_PATH),
            },
        },
        "currentState": {
            "gate03Passed": int(gate.get("passedCount") or 0),
            "gate03Blocked": int(gate.get("blockedCount") or 0),
            "strictNextPhasePermitted": gate.get("nextPhasePermitted") is True,
            "modelFitStarted": gate.get("modelFitStarted"),
            "asxOfficialPdfAttempts": cumulative_attempts,
            "asxOfficialPdfAccepted": cumulative_accepted,
            "asxStrictNumericCoveragePct": asx_strict_pct,
            "asxStrictNumericSymbols": int(asx_audit.get("strictNumericSymbols") or 0),
            "asxTrainingUniverseDenominator": int(asx_audit.get("trainingUniverseDenominator") or 0),
            "asxUnverifiedPitRows": int(asx_gate.get("pitUnverifiedRowCount") or 0),
            "asxMissingTimestampRows": int(asx_gate.get("pitMissingRequiredTimestampRows") or 0),
        },
        "decision": {
            "asxStrictPITCompletionBandUnderCurrentFreeSourcePath": "<5%" if asx_path_lt5 else "not-low",
            "threeMarketStrictProductionPathBandWithoutNewEvidence": "<5%" if strict_all_market_lt5 else "not-low",
            "triggeredThreshold": "<5% operational band reached for ASX core PIT and unchanged strict lane",
            "action": "ACTIVATE_RESEARCH_FALLBACK" if asx_path_lt5 and strict_all_market_lt5 else "CONTINUE_STRICT_LANE",
            "interpretation": "The strict lane remains frozen. The fallback lane is research-only and cannot create a long gate, Champion, or Production model.",
        },
        "marketComparison": {
            market: {
                "dataCoveragePct": baseline.get("pitFundamentalsTrainingUniversePct"),
                "historyMissingOrShortSymbols": baseline.get("historyMissingOrShortSymbols"),
                "remainingRoundsLowerBound": baseline.get("remainingRoundsLowerBound"),
                "immediatelyActionableRounds": baseline.get("immediatelyActionableRounds"),
                "dataProgressInterpretation": (
                    "Core structured PIT remains source-dependent; current free-source retry path is below the decision threshold."
                    if market == "ASX"
                    else "Local semantic cleanup and verified-subset research remain possible; predictive improvement is unproven."
                ),
            }
            for market, baseline in market_baseline.items()
        },
        "progressEvents": [
            {
                "event": "asx_endpoint_recovers",
                "condition": "A new ASX official HTTPS PDF is returned and passes hash, report-period and publication-time validation.",
                "effect": "Increase strict numeric rows/symbols, then rerun the data audit; no automatic promotion.",
                "likelihoodBand": "low under current endpoint behavior",
            },
            {
                "event": "authorized_archive_is_provided",
                "condition": "User supplies an authorized as-reported historical filing archive or a provider with filing-time timestamps.",
                "effect": "Potentially material ASX coverage increase; parser acceptance and PIT ordering remain mandatory.",
                "likelihoodBand": "external-dependent",
            },
            {
                "event": "fallback_research_baseline_runs",
                "condition": "Use frozen verified rows only, omit unavailable fundamental columns, and label the result Research/Shadow.",
                "effect": "Produces a comparable attainable benchmark without changing strict production gates.",
                "likelihoodBand": "locally actionable",
            },
            {
                "event": "no_source_change",
                "condition": "Endpoint failures continue and no new authorized archive arrives.",
                "effect": "Further identical retries are diagnostic-only; do not count them as data progress.",
                "likelihoodBand": "current observed state",
            },
        ],
        "blockingReasons": list(gate.get("blockingReasons") or []) + [
            "ASX strict numeric PIT is concentrated in 14 symbols and only 4% of the 350-symbol training universe.",
            "The latest 45 official-PDF candidates produced zero strict accepted documents; the latest failures were DNS errors or non-PDF responses.",
            "ASX current identity/event coverage cannot substitute for filing-time numeric fundamentals.",
            "Gate03 has not permitted model fitting, so predictive success cannot be inferred from the current snapshot.",
        ],
    }

    fallback = {
        "schema": "research-fallback-activation-v1",
        "generatedAt": generated_at,
        "status": "ACTIVE_RESEARCH_ONLY",
        "activationReason": "The operational probability band for completing the strict ASX PIT path under the unchanged free-source route is below 5%.",
        "strictLane": {
            "status": "FROZEN",
            "productionGateChanged": False,
            "formalOofAllowed": False,
            "longTradeGateAllowed": False,
            "championUpdateAllowed": False,
        },
        "researchLane": {
            "status": "ACTIVE",
            "promotionEligible": False,
            "purpose": "Reachable benchmark for verified data only; never relabel as full-market strict OOF.",
            "dataPolicy": {
                "includeOnly": [
                    "historicalAvailabilityVerified=true",
                    "valid event/available/first-seen/ingested ordering",
                    "frozen market, symbol, feature and label identities",
                ],
                "exclude": [
                    "unverified PIT rows",
                    "future or ambiguous timestamps",
                    "synthetic or inferred fundamentals",
                    "forced fallback probabilities or forced positive ranks",
                ],
                "asxFundamentals": "Use only the strict verified subset; omit missing fundamental columns rather than fill them with observed zeros.",
            },
            "tasks": [
                "cost_adjusted_net_up_classifier",
                "date_grouped_top_k_ranker",
                "downside_risk_and_abstention_gate",
            ],
            "horizonsTradingDays": [10, 20],
            "researchAcceptance": {
                "minimumIndependentDates": 30,
                "minimumSignals": 300,
                "balancedAccuracyPctAtLeast": 52.0,
                "brierSkillStrictlyAbove": 0.0,
                "ecePctAtMost": 8.0,
                "top10HitRatePctAtLeast": 52.0,
                "costAfterExpectedValueStrictlyAbove": 0.0,
                "positiveRollingFoldCountAtLeast": 3,
                "noTradeWhenExpectedNetEvNonPositive": True,
            },
            "nonPromotionRules": [
                "Research thresholds are not production thresholds.",
                "No Research result may activate longTradeGate or overwrite a Champion.",
                "A new lockbox and one changed hypothesis are required for each comparable experiment.",
                "Any result with unresolved PIT ambiguity is NO_MODEL, not a degraded model.",
            ],
        },
        "reentryConditions": [
            "At least one new real ASX official PDF is accepted and written to financial_disclosures and fundamentals.",
            "Gate03 is rerun with updated evidence and permits the strict lane.",
            "Strict calibration, Top-K, cost-after-EV and rolling stability gates pass on untouched evidence.",
        ],
        "evidence": assessment["evidence"],
    }
    write_json(OUT_PATH, assessment)
    write_json(FALLBACK_PATH, fallback)
    print(json.dumps({
        "assessment": str(OUT_PATH),
        "fallback": str(FALLBACK_PATH),
        "action": assessment["decision"]["action"],
        "asxStrictPITBand": assessment["decision"]["asxStrictPITCompletionBandUnderCurrentFreeSourcePath"],
        "threeMarketStrictBand": assessment["decision"]["threeMarketStrictProductionPathBandWithoutNewEvidence"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
