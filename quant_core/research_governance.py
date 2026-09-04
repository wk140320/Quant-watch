"""Deterministic research governance for frozen tests and experiment history.

This module deliberately contains no model fitting.  It creates immutable
identifiers and append-only records so a later experiment cannot silently
replace a test set, a label definition, or a failed candidate.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOCKBOX_SCHEMA = "research-lockbox-v1"
EXPERIMENT_SCHEMA = "research-experiment-record-v1"
LOCKBOX_STATES = ("frozen_untouched", "opened", "consumed")


def canonical_hash(value: Any, length: int = 32) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:length]


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, default=str), encoding="utf-8")
    temporary.replace(path)


def experiment_hypothesis_contract(record: dict[str, Any]) -> dict[str, Any]:
    """Normalize the one-experiment/one-hypothesis research contract."""
    job_type = str(record.get("jobType", record.get("job_type", "model_experiment")) or "model_experiment").strip().lower()
    raw = record.get("changedHypotheses", record.get("changed_hypotheses", record.get("changedHypothesis", record.get("changed_hypothesis"))))
    values = raw if isinstance(raw, (list, tuple, set)) else [raw] if raw is not None else []
    hypotheses = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in hypotheses:
            hypotheses.append(text)
    evidence_refresh = job_type == "evidence_refresh"
    valid = len(hypotheses) == (0 if evidence_refresh else 1)
    if valid:
        rejection_reason = None
    elif evidence_refresh:
        rejection_reason = "evidence_refresh_must_not_change_a_hypothesis"
    elif not hypotheses:
        rejection_reason = "model_experiment_requires_exactly_one_changed_hypothesis"
    else:
        rejection_reason = "multiple_changed_hypotheses_are_not_comparable"
    return {
        "schema": "single-changed-hypothesis-v2",
        "jobType": job_type,
        "mayFitModel": not evidence_refresh,
        "mayReadLockbox": not evidence_refresh,
        "mayUpdateChallenger": not evidence_refresh,
        "valid": valid,
        "changedHypothesis": hypotheses[0] if len(hypotheses) == 1 else None,
        "hypothesisCount": len(hypotheses),
        "rejectionReason": rejection_reason,
    }


def create_lockbox(
    *,
    market: str,
    data_version: str | None,
    feature_schema_hash: str | None,
    universe_version: str | None,
    label_definition: str,
    test_set_signature: str | None,
    source_versions: list[str] | None = None,
    root: str | None = None,
    independent_test_dates: int = 0,
    row_count: int = 0,
    training_lane: str = "strict_production",
) -> dict[str, Any]:
    """Create or reuse a content-addressed, untouched test-set lockbox."""
    market_key = str(market or "ASX").upper()
    body = {
        "schema": LOCKBOX_SCHEMA,
        "market": market_key,
        "dataVersion": data_version,
        "featureSchemaHash": feature_schema_hash,
        "universeVersion": universe_version,
        "labelDefinition": label_definition,
        "testSetSignature": test_set_signature,
        "sourceVersions": sorted({str(value) for value in (source_versions or []) if value}),
        "independentTestDates": int(independent_test_dates or 0),
        "rowCount": int(row_count or 0),
        "trainingLane": str(training_lane or "strict_production"),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "frozen_untouched",
        "selectionPolicy": "This lockbox may be read for final acceptance only; no threshold, label, feature, or weight selection may read it.",
        "replacementPolicy": "A changed dataset, label, feature schema, or universe creates a new lockbox id.",
    }
    lockbox_id = canonical_hash({key: value for key, value in body.items() if key != "createdAt"}, 32)
    body["lockboxId"] = lockbox_id
    if root:
        path = Path(root).expanduser().resolve() / "lockboxes" / market_key.lower() / f"{lockbox_id}.json"
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                if existing.get("lockboxId") == lockbox_id:
                    existing["path"] = str(path)
                    return existing
            except (OSError, ValueError, TypeError):
                pass
        body["path"] = str(path)
        _atomic_json(path, body)
    return body


def _persist_lockbox(lockbox: dict[str, Any], root: str | None = None) -> dict[str, Any]:
    path_value = str(lockbox.get("path") or "").strip()
    if not path_value and root:
        market = str(lockbox.get("market") or "ASX").lower()
        lockbox_id = str(lockbox.get("lockboxId") or "").strip()
        if lockbox_id:
            path_value = str(Path(root).expanduser().resolve() / "lockboxes" / market / f"{lockbox_id}.json")
    if path_value:
        lockbox["path"] = path_value
        _atomic_json(Path(path_value), lockbox)
    return lockbox


def open_lockbox(
    lockbox: dict[str, Any],
    *,
    candidate_id: str,
    root: str | None = None,
) -> dict[str, Any]:
    """Open a frozen test set exactly once for one immutable candidate."""
    candidate = str(candidate_id or "").strip()
    if not candidate:
        raise ValueError("candidate_id_required")
    current = str(lockbox.get("status") or "")
    if current != "frozen_untouched":
        raise ValueError(f"lockbox_cannot_open_from_{current or 'unknown'}")
    now = datetime.now(timezone.utc).isoformat()
    updated = {
        **lockbox,
        "status": "opened",
        "openedAt": now,
        "openedByCandidateId": candidate,
        "accessCount": int(lockbox.get("accessCount") or 0) + 1,
        "accessEvents": [
            *list(lockbox.get("accessEvents") or []),
            {"state": "opened", "candidateId": candidate, "at": now},
        ],
    }
    return _persist_lockbox(updated, root)


def consume_lockbox(
    lockbox: dict[str, Any],
    *,
    candidate_id: str,
    outcome: str,
    root: str | None = None,
) -> dict[str, Any]:
    """Consume an opened lockbox; consumed evidence can never be reopened."""
    candidate = str(candidate_id or "").strip()
    if str(lockbox.get("status") or "") != "opened":
        raise ValueError(f"lockbox_cannot_consume_from_{lockbox.get('status') or 'unknown'}")
    if candidate != str(lockbox.get("openedByCandidateId") or ""):
        raise ValueError("lockbox_candidate_mismatch")
    final_outcome = str(outcome or "failed").strip().lower()
    if final_outcome not in {"accepted", "rejected", "failed", "cancelled"}:
        raise ValueError("invalid_lockbox_outcome")
    now = datetime.now(timezone.utc).isoformat()
    updated = {
        **lockbox,
        "status": "consumed",
        "consumedAt": now,
        "consumedByCandidateId": candidate,
        "evaluationOutcome": final_outcome,
        "accessEvents": [
            *list(lockbox.get("accessEvents") or []),
            {"state": "consumed", "candidateId": candidate, "outcome": final_outcome, "at": now},
        ],
    }
    return _persist_lockbox(updated, root)


def evaluate_lockbox_once(
    lockbox: dict[str, Any],
    *,
    candidate_id: str,
    evaluator,
    root: str | None = None,
) -> dict[str, Any]:
    """Run one final evaluation and consume the lockbox even on failure."""
    opened = open_lockbox(lockbox, candidate_id=candidate_id, root=root)
    try:
        result = evaluator(opened)
    except BaseException:
        consume_lockbox(opened, candidate_id=candidate_id, outcome="failed", root=root)
        raise
    accepted = bool(result.get("accepted")) if isinstance(result, dict) else False
    consumed = consume_lockbox(
        opened,
        candidate_id=candidate_id,
        outcome="accepted" if accepted else "rejected",
        root=root,
    )
    return {"result": result, "lockbox": consumed}


def record_experiment(root: str | None, record: dict[str, Any]) -> dict[str, Any]:
    """Append one immutable experiment record, deduplicated by content id."""
    hypothesis_contract = experiment_hypothesis_contract(record)
    payload = {
        "schema": EXPERIMENT_SCHEMA,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **record,
        "hypothesisContract": hypothesis_contract,
    }
    if not hypothesis_contract["valid"]:
        payload["status"] = "rejected_governance"
        payload["promotionEligible"] = False
        payload["governanceViolation"] = hypothesis_contract["rejectionReason"]
    elif hypothesis_contract["jobType"] == "evidence_refresh":
        payload["promotionEligible"] = False
        payload["modelVersion"] = None
        payload["bestChallengerUpdated"] = False
    experiment_id = str(payload.get("experimentId") or canonical_hash({key: value for key, value in payload.items() if key != "createdAt"}, 32))
    payload["experimentId"] = experiment_id
    if not root:
        return payload
    path = Path(root).expanduser().resolve() / "experiments" / "experiments.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_ids: set[str] = set()
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines()[-10_000:]:
                try:
                    existing_ids.add(str(json.loads(line).get("experimentId") or ""))
                except (ValueError, TypeError):
                    continue
        except OSError:
            pass
    if experiment_id not in existing_ids:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str) + "\n")
    return payload


def lockbox_validation(evidence: dict[str, Any], lockbox: dict[str, Any] | None) -> dict[str, Any]:
    if not lockbox:
        return {"available": False, "passed": False, "reason": "lockbox_missing"}
    consumed = lockbox.get("status") == "consumed"
    opened_candidate = str(lockbox.get("openedByCandidateId") or "")
    consumed_candidate = str(lockbox.get("consumedByCandidateId") or "")
    lifecycle_checks = {
        "consumedExactlyOnce": consumed and int(lockbox.get("accessCount") or 0) == 1,
        "candidateBound": bool(opened_candidate) and opened_candidate == consumed_candidate,
        "terminalOutcome": str(lockbox.get("evaluationOutcome") or "") in {"accepted", "rejected", "failed", "cancelled"},
    }
    checks = {
        "lockboxId": bool(lockbox.get("lockboxId")),
        **lifecycle_checks,
        "dataVersion": not evidence.get("dataVersion") or evidence.get("dataVersion") == lockbox.get("dataVersion"),
        "featureSchema": not evidence.get("featureSchemaHash") or evidence.get("featureSchemaHash") == lockbox.get("featureSchemaHash"),
        "testSetSignature": not evidence.get("testSetSignature") or evidence.get("testSetSignature") == lockbox.get("testSetSignature"),
    }
    return {
        "available": True,
        "passed": all(checks.values()),
        "lockboxIntegrityPassed": all(checks.values()),
        "candidateAccepted": lockbox.get("evaluationOutcome") == "accepted",
        "lockboxId": lockbox.get("lockboxId"),
        "checks": checks,
        "reason": "ok" if all(checks.values()) else "lockbox_integrity_or_signature_mismatch",
    }
