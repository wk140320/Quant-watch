"""Deterministic continuous-learning governance contracts."""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable


EVOLUTION_CONTRACT_SCHEMA = "continuous-learning-governance-v2"
STATES = ("TODO", "RUNNING", "EVIDENCE_READY", "ACCEPTED", "REJECTED", "BLOCKED_PIVOT", "CANCELLED")
ALLOWED_TRANSITIONS = {
    "TODO": {"RUNNING", "CANCELLED"},
    "RUNNING": {"EVIDENCE_READY", "REJECTED", "BLOCKED_PIVOT", "CANCELLED"},
    "EVIDENCE_READY": {"ACCEPTED", "REJECTED", "BLOCKED_PIVOT"},
    "ACCEPTED": set(),
    "REJECTED": {"RUNNING", "BLOCKED_PIVOT"},
    "BLOCKED_PIVOT": {"RUNNING"},
    "CANCELLED": set(),
}


def _hash(value: Any, length: int = 32) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()[:length]


def transition_task(task: dict[str, Any], target: str, *, evidence_id: str | None = None, reason: str | None = None) -> dict[str, Any]:
    current = str(task.get("status") or "TODO").upper()
    target = str(target or "").upper()
    if current not in STATES or target not in STATES or target not in ALLOWED_TRANSITIONS[current]:
        raise ValueError(f"invalid_task_transition:{current}->{target}")
    updated = {**task, "status": target, "updatedAt": datetime.now(timezone.utc).isoformat()}
    if evidence_id:
        updated["evidenceId"] = evidence_id
    if reason:
        updated["reason"] = reason
    return updated


def dependency_gate(task: dict[str, Any], tasks: dict[str, dict[str, Any]] | Iterable[dict[str, Any]]) -> dict[str, Any]:
    if isinstance(tasks, dict):
        by_id = tasks
    else:
        by_id = {str(row.get("id")): row for row in tasks if isinstance(row, dict) and row.get("id")}
    dependencies = [str(value) for value in task.get("dependencies", task.get("dependsOn", [])) or []]
    missing = [value for value in dependencies if value not in by_id]
    not_ready = [value for value in dependencies if value in by_id and str(by_id[value].get("status") or "TODO").upper() != "ACCEPTED"]
    return {"schema": "dependency-lock-v1", "taskId": task.get("id"), "unlocked": not missing and not not_ready, "missing": missing, "notAccepted": not_ready, "policy": "all dependencies must be ACCEPTED before RUNNING"}


def failure_evidence(*, root_cause: str, attempt: int, evidence_id: str, next_action: str, task_id: str | None = None) -> dict[str, Any]:
    if not str(root_cause).strip() or int(attempt) < 1 or not str(evidence_id).strip() or not str(next_action).strip():
        raise ValueError("failure_evidence_requires_root_cause_attempt_evidence_and_next_action")
    return {"schema": "failure-evidence-v2", "taskId": task_id, "rootCause": str(root_cause), "attempt": int(attempt), "evidenceId": str(evidence_id), "nextAction": str(next_action), "createdAt": datetime.now(timezone.utc).isoformat()}


def repeated_root_cause_action(records: Iterable[dict[str, Any]], root_cause: str, *, threshold: int = 3) -> dict[str, Any]:
    matches = [row for row in records if isinstance(row, dict) and str(row.get("rootCause") or "") == str(root_cause)]
    count = len(matches)
    return {"schema": "root-cause-pivot-v1", "rootCause": root_cause, "attempts": count, "threshold": threshold, "action": "BLOCKED_PIVOT" if count >= threshold else "REWORK", "reason": "same root cause reached the maximum retry count" if count >= threshold else "retry budget remains"}


def new_evidence_required(previous: dict[str, Any] | None, *, snapshot_id: str | None, changed_hypothesis: str | None) -> dict[str, Any]:
    previous = previous or {}
    new_snapshot = bool(snapshot_id and str(snapshot_id) != str(previous.get("snapshotId") or ""))
    new_hypothesis = bool(changed_hypothesis and str(changed_hypothesis) != str(previous.get("changedHypothesis") or ""))
    return {"schema": "new-evidence-trigger-v1", "shouldRun": new_snapshot or new_hypothesis, "newSnapshot": new_snapshot, "newHypothesis": new_hypothesis, "reason": "new snapshot or changed hypothesis" if new_snapshot or new_hypothesis else "same evidence and same hypothesis; do not refit"}


def champion_replacement(candidate: dict[str, Any], champion: dict[str, Any] | None, *, tolerance: float = 0.0) -> dict[str, Any]:
    reasons: list[str] = []
    if not candidate or str(candidate.get("status") or "").upper() in {"NO_MODEL", "PARTIAL", "REJECTED", "BLOCKED"}:
        reasons.append("candidate_not_complete")
    if candidate.get("strictOof") is not True:
        reasons.append("strict_oof_not_proven")
    if candidate.get("trainingBlocked") is True:
        reasons.append("candidate_training_blocked")
    if champion and str(candidate.get("comparisonKey") or "") != str(champion.get("comparisonKey") or ""):
        reasons.append("comparison_key_mismatch")
    candidate_metrics = candidate.get("metrics") if isinstance(candidate.get("metrics"), dict) else {}
    champion_metrics = (champion or {}).get("metrics") if isinstance((champion or {}).get("metrics"), dict) else {}
    for key in ("balancedAccuracyPct", "brierSkill", "topDecileNetReturn"):
        if key in champion_metrics and _finite(candidate_metrics.get(key)) < _finite(champion_metrics.get(key)) - tolerance:
            reasons.append(f"noninferiority_failed:{key}")
    return {"schema": "champion-replacement-v2", "replace": not reasons, "reasons": reasons, "candidateId": candidate.get("modelVersion") or candidate.get("candidateId"), "incumbentId": (champion or {}).get("modelVersion") or (champion or {}).get("candidateId"), "policy": "same comparison key and non-inferior on every protected metric"}


def _finite(value: Any) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else -math.inf
    except (TypeError, ValueError):
        return -math.inf


def rollback_reference(champion: dict[str, Any], *, reason: str) -> dict[str, Any]:
    return {"schema": "champion-rollback-reference-v1", "modelVersion": champion.get("modelVersion"), "comparisonKey": champion.get("comparisonKey"), "dataVersion": champion.get("dataVersion"), "configHash": champion.get("configHash"), "reason": reason, "createdAt": datetime.now(timezone.utc).isoformat()}


def paper_trajectory(*, market: str, symbol: str, signal_at: str, action: str, model_version: str | None, expected_value_pct: float | None, outcome_return_pct: float | None = None, reason: str | None = None) -> dict[str, Any]:
    payload = {"market": str(market).upper(), "symbol": str(symbol).upper(), "signalAt": signal_at, "action": action, "modelVersion": model_version, "expectedValuePct": expected_value_pct, "outcomeReturnPct": outcome_return_pct, "reason": reason}
    return {"schema": "paper-trajectory-v2", "trajectoryId": _hash(payload), "createdAt": datetime.now(timezone.utc).isoformat(), **payload, "paperOnly": True, "orderExecutionEnabled": False}


def experiment_budget(records: Iterable[dict[str, Any]], *, year_month: str, max_hypotheses: int = 12, max_factor_candidates: int = 60, max_model_candidates: int = 24) -> dict[str, Any]:
    rows = [row for row in records if isinstance(row, dict) and str(row.get("createdAt") or row.get("date") or "").startswith(year_month)]
    hypotheses = len({str(row.get("changedHypothesis") or "") for row in rows if row.get("changedHypothesis")})
    factors = sum(1 for row in rows if str(row.get("family") or "") in {"factor", "alpha"})
    models = sum(1 for row in rows if str(row.get("family") or "") == "model")
    return {"schema": "experiment-budget-v1", "period": year_month, "hypotheses": hypotheses, "factorCandidates": factors, "modelCandidates": models, "passed": hypotheses <= max_hypotheses and factors <= max_factor_candidates and models <= max_model_candidates, "limits": {"hypotheses": max_hypotheses, "factorCandidates": max_factor_candidates, "modelCandidates": max_model_candidates}}


__all__ = ["ALLOWED_TRANSITIONS", "EVOLUTION_CONTRACT_SCHEMA", "STATES", "champion_replacement", "dependency_gate", "experiment_budget", "failure_evidence", "new_evidence_required", "paper_trajectory", "repeated_root_cause_action", "rollback_reference", "transition_task"]
