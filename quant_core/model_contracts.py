"""Model-family contracts and evidence-only candidate admission.

This module is deliberately model-agnostic.  Fitting implementations may be
provided by sklearn, CatBoost or LightGBM, but none of them can be selected by
the existence of a prediction array alone.  A candidate must beat its family
null on comparable OOF data and satisfy the evidence contract.
"""

from __future__ import annotations

import math
from typing import Any, Iterable


MODEL_FAMILY_CONTRACT_SCHEMA = "model-family-contract-v2"

MODEL_FAMILIES: dict[str, dict[str, Any]] = {
    "null": {"task": "direction", "label": "actualDirection", "primaryMetric": "brierSkill", "role": "permanent-baseline", "maxComplexity": 0},
    "elasticnet_logistic": {"task": "direction", "label": "actualDirection", "primaryMetric": "brierSkill", "role": "champion-candidate", "maxComplexity": 2},
    "catboost_classifier": {"task": "path", "label": "targetFirst", "primaryMetric": "brierSkill", "role": "challenger", "maxComplexity": 4},
    "random_forest": {"task": "path", "label": "targetFirst", "primaryMetric": "brierSkill", "role": "challenger", "maxComplexity": 4},
    "ipca": {"task": "latent_return", "label": "actualReturn", "primaryMetric": "rankIc", "role": "challenger", "maxComplexity": 3},
    "catboost_yetirank": {"task": "ranking", "label": "rankRelevance", "primaryMetric": "ndcgAt10", "role": "ranking-challenger", "maxComplexity": 4},
    "lightgbm_lambdarank": {"task": "ranking", "label": "rankRelevance", "primaryMetric": "ndcgAt10", "role": "ranking-challenger", "maxComplexity": 4},
    "quantile_gbm": {"task": "return_interval", "label": "actualReturn", "primaryMetric": "pinballLoss", "metricDirection": "lower_is_better", "role": "return-challenger", "maxComplexity": 4},
    "hurdle": {"task": "conditional_return", "label": "positiveNetReturn", "primaryMetric": "brierSkill", "role": "specialist", "maxComplexity": 3},
    "competing_risk": {"task": "path", "label": "pathOutcome", "primaryMetric": "brierSkill", "role": "risk-specialist", "maxComplexity": 3},
    "sparse_event": {"task": "event", "label": "eventOutcome", "primaryMetric": "brierSkill", "role": "sparse-specialist", "maxComplexity": 2},
    "regime_gate": {"task": "regime", "label": "regimeOutcome", "primaryMetric": "brierSkill", "role": "risk-gate-only", "maxComplexity": 2},
    "gru_tcn": {"task": "sequence", "label": "actualReturn", "primaryMetric": "rankIc", "role": "late-challenger", "maxComplexity": 3},
}


def family_contract(family: str, *, horizon: int = 5, feature_schema: str = "unknown") -> dict[str, Any]:
    name = str(family or "").strip().lower()
    definition = MODEL_FAMILIES.get(name)
    if definition is None:
        raise ValueError(f"unknown_model_family:{family}")
    return {
        "schema": MODEL_FAMILY_CONTRACT_SCHEMA,
        "family": name,
        **definition,
        "horizon": int(horizon),
        "featureSchema": feature_schema,
        "nullPolicy": "null/no-model is a valid result; no fallback prediction may be relabeled as this family",
        "fitPolicy": "fit only on purged time-ordered train rows; scaler and hyperparameters are inner-window only",
        "selectionPolicy": "compare against same-family null on identical OOF rows before admission",
        "productionPolicy": "Research/Shadow until all hard evidence gates pass",
        "metricDirection": definition.get("metricDirection", "higher_is_better"),
    }


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _metric(candidate: dict[str, Any], key: str) -> float | None:
    value = candidate.get(key)
    if value is None and isinstance(candidate.get("metrics"), dict):
        value = candidate["metrics"].get(key)
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def candidate_admission(candidate: dict[str, Any], null: dict[str, Any] | None, *, family: str, min_rows: int = 1_000, min_dates: int = 120) -> dict[str, Any]:
    """Return an auditable admission decision; never force the best loser."""
    candidate = candidate or {}
    contract = family_contract(family)
    reasons: list[str] = []
    if not candidate or str(candidate.get("status") or "").lower() in {"null", "no_model", "blocked", "failed"}:
        reasons.append("candidate_is_null_or_failed")
    if candidate.get("trainingBlocked", candidate.get("training_blocked")) is True or candidate.get("dataQualityBlocked", candidate.get("data_quality_blocked")) is True:
        reasons.append("candidate_training_blocked")
    comparison_key = candidate.get("comparisonKey", candidate.get("comparison_key"))
    if str(comparison_key or "") == "":
        reasons.append("comparison_key_missing")
    rows = int(candidate.get("oofRows") or candidate.get("rows") or 0)
    dates = int(candidate.get("independentDates") or candidate.get("testDates") or 0)
    if rows < min_rows:
        reasons.append("insufficient_oof_rows")
    if dates < min_dates:
        reasons.append("insufficient_independent_dates")
    primary = contract["primaryMetric"]
    candidate_metric = _metric(candidate, primary)
    null_metric = _metric(null or {}, primary)
    if candidate_metric is None:
        reasons.append("primary_metric_missing")
    elif null_metric is not None:
        direction = str(contract.get("metricDirection") or "higher_is_better")
        improves = candidate_metric < null_metric if direction == "lower_is_better" else candidate_metric > null_metric
        if not improves:
            reasons.append("not_better_than_family_null")
    if candidate.get("comparable") is False:
        reasons.append("incomparable_oof")
    strict_oof = candidate.get("strictOof", candidate.get("strict_oof"))
    if strict_oof is not True:
        reasons.append("strict_oof_not_proven")
    return {
        "schema": "model-candidate-admission-v2",
        "family": family,
        "primaryMetric": primary,
        "candidateId": candidate.get("candidateId") or candidate.get("modelVersion"),
        "eligible": not reasons,
        "reasons": reasons,
        "candidateMetric": candidate_metric,
        "nullMetric": null_metric,
        "oofRows": rows,
        "independentDates": dates,
        "contract": contract,
    }


def choose_shallowest_one_se(candidates: Iterable[dict[str, Any]], *, score_key: str = "selectionScore", complexity_key: str = "complexity") -> dict[str, Any] | None:
    """Choose the shallowest candidate within one standard error of the best."""
    rows = [row for row in candidates if isinstance(row, dict) and _metric(row, score_key) is not None]
    if not rows:
        return None
    best = min(rows, key=lambda row: _number(row.get(score_key), math.inf))
    best_score = _number(best.get(score_key), math.inf)
    se = max(0.0, _number(best.get("standardError", best.get("scoreSe")), 0.0))
    eligible = [row for row in rows if _number(row.get(score_key), math.inf) <= best_score + se]
    return min(eligible, key=lambda row: (_number(row.get(complexity_key), math.inf), _number(row.get(score_key), math.inf)))


def qualified_family_models(candidates: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Keep at most one independently-qualified model per family."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    audits = []
    for row in candidates:
        if not isinstance(row, dict):
            continue
        family = str(row.get("family") or "unknown")
        audit = candidate_admission(row, row.get("nullModel") if isinstance(row.get("nullModel"), dict) else None, family=family)
        audits.append(audit)
        if audit["eligible"]:
            grouped.setdefault(family, []).append(row)
    selected = {family: choose_shallowest_one(rows) or rows[0] for family, rows in grouped.items()}
    return {
        "schema": "qualified-family-models-v2",
        "selected": selected,
        "qualifiedFamilies": sorted(selected),
        "audits": audits,
        "emptyIsValid": True,
        "productionEligible": False,
    }


choose_shallowest_one = choose_shallowest_one_se


__all__ = ["MODEL_FAMILIES", "MODEL_FAMILY_CONTRACT_SCHEMA", "candidate_admission", "choose_shallowest_one", "choose_shallowest_one_se", "family_contract", "qualified_family_models"]
