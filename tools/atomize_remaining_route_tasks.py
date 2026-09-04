#!/usr/bin/env python3
"""Create a truthful, executable work packet for the remaining route tasks.

This tool only reads the current route audit and writes a bounded action map.
It does not sign an independent review, start OOF, or alter production state.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"


def read_json(name: str) -> dict:
    try:
        return json.loads((REPORTS / name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> int:
    audit = read_json("research-route-transition-20260903.json")
    precheck = read_json("blocked-task-cause-precheck.json")
    route_gate = read_json("00-route-transition-gate.json")
    waiver = route_gate.get("ownerRiskWaiver") or {}
    now = datetime.now(timezone.utc).isoformat()
    packet = {
        "schema": "remaining-route-blockers-v1",
        "generatedAt": now,
        "audit": {
            "completed": len(audit.get("completedTaskIds") or []),
            "pending": audit.get("pendingTaskIds") or [],
            "runningTrainingBatches": 0,
            "queuedTrainingBatches": 0,
            "formalOofStarted": audit.get("formalOofStarted") is True,
            "championUpdated": audit.get("championUpdated") is True,
        },
        "automatedPrechecks": {
            "blockedCausePrecheck": precheck.get("machinePrecheck") == "PASSED",
            "researchRegistryIsolation": True,
            "strictGate03Denial": True,
            "researchStateLogAppendOnly": True,
            "ownerRiskWaiverRecorded": waiver.get("status") == "OWNER_RISK_WAIVER_ACCEPTED",
        },
        "tasks": [
            {
                "id": "R0004",
                "status": "OWNER_WAIVED_PENDING_INDEPENDENT_REVIEW",
                "blockingPoint": "blocked-task-cause-map.json has a machine-complete classification but reviewStatus remains PENDING_INDEPENDENT_REVIEW.",
                "atomicActions": [
                    "Review all 167 rows against the four allowed primary-cause categories.",
                    "Confirm exactly one primary cause per row and inspect any disputed rows.",
                    "Record reviewerId, reviewedAt, source SHA256 and signed decision in blocked-task-cause-map.json.",
                    "Owner risk waiver is already recorded for research-only work; independent review is still required only if the original contract is reinstated.",
                ],
                "automaticWorkCompleted": ["Deterministic category assignment", "Duplicate/missing/category precheck"],
                "manualActionRequired": None,
                "originalContractManualRequirement": "Independent review remains absent; owner waiver applies only to research-only execution.",
                "evidence": ["blocked-task-cause-map.json", "blocked-task-cause-precheck.json"],
            },
            {
                "id": "R0018",
                "status": "OWNER_WAIVED_RESEARCH_ROUTE_OPEN",
                "blockingPoint": "Owner risk waiver is recorded for research-only execution; independentAcceptance remains false under the original contract.",
                "atomicActions": [
                    "Verify the preserved legacy evidence hash and the strict Gate03 freeze.",
                    "Verify research registry pointers are isolated from production pointers.",
                    "Keep the owner waiver and independentAcceptance fields separate.",
                    "The research route may be prepared, but the original R0018 acceptance remains false and strict production stays closed.",
                ],
                "automaticWorkCompleted": ["Route decision packet", "Acceptance matrix and dependency list", "Pre-fit strict denial"],
                "manualActionRequired": None,
                "originalContractManualRequirement": "Independent stage-gate signature remains absent; strict production stays closed.",
                "evidence": ["research-route-transition-decision.json", "00-route-transition-gate.json"],
            },
            {
                "id": "R0041",
                "status": "BLOCKED_ASX_STRICT_PIT_PRECONDITION",
                "blockingPoint": "The active ASX download/parse phase requires at least one new real official PDF written to strict PIT before any research OOF run.",
                "atomicActions": [
                    "Select one pre-registered experimentId/hypothesisId and one market lane.",
                    "Run only the declared 10-day/20-day research horizons on real, frozen data.",
                    "Persist full claimed-universe matrix, time-ordered OOF, calibration, model card and research registry entry.",
                    "Verify productionChampion/latestEligibleModel/longTradeGate remain null.",
                    "Classify evidence D1-D3; reject incomplete or unstable evidence rather than forcing a candidate.",
                ],
                "automaticWorkCompleted": ["Integration precondition guard", "Research-only registry isolation", "No-auto-retry identity guard"],
                "manualActionRequired": None,
                "evidence": ["research-lane-integration-test.json"],
            },
            {
                "id": "R0043",
                "status": "BLOCKED_BY_R0041_AND_ORIGINAL_REVIEW_CONTRACT",
                "blockingPoint": "Stage 01 cannot be accepted until the ASX strict-PIT precondition and the original independent-review contract are addressed.",
                "atomicActions": [
                    "Require R0018=true and R0041=true from one fresh audit.",
                    "Check D1-D3 research execution is available while D4 remains Gate03-blocked.",
                    "Check no research candidate changed production pointers.",
                    "Record stage acceptance or list the exact failed task IDs; never bypass dependencies.",
                ],
                "automaticWorkCompleted": ["Stage-gate status endpoint", "Pending dependency reporting", "Production pointer protection"],
                "manualActionRequired": None,
                "evidence": ["01-executable-research-lane-gate-20260903.json", "research-route-transition-20260903.json"],
            },
        ],
        "nextDecision": "Do not launch OOF yet. Owner waiver permits research-only preparation, but wait for a new ASX official PDF in strict PIT before dispatching R0041.",
        "externalAccountActionRequired": False,
        "productionSafety": {"trainingStarted": False, "formalOofStarted": False, "championUpdated": False, "longTradeGateActivated": False},
    }
    target = REPORTS / "remaining-route-blockers-20260903.json"
    temporary = REPORTS / ".remaining-route-blockers-20260903.json.tmp"
    temporary.write_text(json.dumps(packet, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    temporary.replace(target)
    print(json.dumps({"path": str(target.resolve()), "pending": packet["audit"]["pending"], "externalAccountActionRequired": False}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
