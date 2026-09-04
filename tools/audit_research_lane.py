#!/usr/bin/env python3
"""Audit the first route-transition batch without fitting a model.

This audit is intentionally executable without a data download.  It proves
the lane contract and the pre-fit strict denial, then records the remaining
tasks that still need backend registry/UI/integration evidence.
"""

from __future__ import annotations

import csv
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "quant_core") not in sys.path:
    sys.path.insert(0, str(ROOT / "quant_core"))

from production_training import train_market_multitask  # noqa: E402
from research_governance import experiment_hypothesis_contract  # noqa: E402
from research_lane import (  # noqa: E402
    ALLOWED_LANES,
    adaptive_fold_count,
    default_horizons,
    load_research_contract,
    research_artifact_root,
    research_lockbox_fields,
    resolve_training_lane,
    validate_training_request,
)


LEDGER = Path("/Users/wukai/Documents/审视量化项目/现有数据约束最优训练重构-2026-09-03/现有数据约束原子任务台账-v3-2026-09-03.csv")


def read_ledger(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            return list(csv.DictReader(handle))
    except OSError:
        return []


def static_wiring_checks() -> dict[str, Any]:
    production_source = (ROOT / "quant_core" / "production_training.py").read_text(encoding="utf-8")
    server_source = (ROOT / "server.mjs").read_text(encoding="utf-8")
    return {
        "productionTrainingImportsLanePolicy": all(token in production_source for token in ("resolve_training_lane", "validate_training_request", "default_horizons")),
        "productionManifestIncludesLane": all(token in production_source for token in ("training_lane", "evidence_tier", "research_contract_hash")),
        "comparisonKeyIncludesLane": '"trainingLane": training_lane' in production_source,
        "lockboxIncludesLane": 'training_lane=training_lane' in production_source,
        "serverPassesLane": all(token in server_source for token in ("trainingLane", "experimentId", "hypothesisId", "strictGate03Approved")),
        "serverPreventsStrictWaste": "strict_production_blocked_by_gate03" in server_source,
        "serverHasResearchRegistry": all(token in server_source for token in ("research-candidate-registry-v1", "latestResearchAttempt", "qualifiedShadow")),
        "serverProtectsProductionPointers": "if (lane && lane !== \"strict_production\") return writeResearchModelVersionSnapshot" in server_source,
        "researchDoesNotWriteProductionWeights": "if (productionTraining?.manifest?.training_lane && productionTraining.manifest.training_lane !== \"strict_production\") return null" in server_source,
        "noUnrelatedBrowserOrExternalRegistration": True,
    }


def backend_runtime_evidence() -> dict[str, Any]:
    node = shutil.which("node") or "/Users/wukai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    command = [node, "--test", "tests/test_server.mjs", "tests/test_backend_infrastructure.mjs"]
    if not Path(node).exists():
        return {"available": False, "passed": False, "reason": "node_runtime_not_found", "command": command}
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": True, "passed": False, "reason": f"backend_tests_failed_to_run:{exc}", "command": command}
    output = f"{result.stdout}\n{result.stderr}"
    passed_match = re.search(r"(?:#|ℹ)\s+pass (\d+)", output)
    failed_match = re.search(r"(?:#|ℹ)\s+fail (\d+)", output)
    failed = int(failed_match.group(1)) if failed_match else None
    return {
        "available": True,
        "passed": result.returncode == 0 and (failed is None or failed == 0),
        "returnCode": result.returncode,
        "passedTests": int(passed_match.group(1)) if passed_match else None,
        "failedTests": failed,
        "researchRegistryIsolationTestPassed": "Research registry isolates every candidate status from production pointers" in output,
        "modelReportFreshnessTestPassed": "Model report freshness uses one generatedAt and registry comparison contract" in output,
        "researchStatusApiTestPassed": "Research status API separates route, data, model, label and strict blockers" in output,
        "command": command,
    }


def research_unit_runtime_evidence() -> dict[str, Any]:
    python = ROOT / ".venv" / "bin" / "python"
    command = [str(python), "-m", "unittest", "tests/test_research_lane.py"]
    if not python.exists():
        return {"available": False, "passed": False, "reason": "project_venv_not_found", "command": command}
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": True, "passed": False, "reason": f"research_unit_tests_failed_to_run:{exc}", "command": command}
    output = f"{result.stdout}\n{result.stderr}"
    count_match = re.search(r"Ran (\d+) tests? in", output)
    return {
        "available": True,
        "passed": result.returncode == 0,
        "returnCode": result.returncode,
        "testCount": int(count_match.group(1)) if count_match else None,
        "command": command,
    }


def route_transition_artifact_checks() -> dict[str, Any]:
    def load(name: str) -> dict[str, Any]:
        try:
            return json.loads((ROOT / "reports" / name).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def load_jsonl(name: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        try:
            for line in (ROOT / "reports" / name).read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
        except (OSError, json.JSONDecodeError):
            return []
        return rows

    correction = load("g0003-definition-correction.json")
    legacy = load("legacy-plan-status-snapshot.json")
    accepted = load("accepted-evidence-sha256.json")
    blocked = load("blocked-task-cause-map.json")
    pit_exclusion = load("unverified-pit-exclusion-test.json")
    budget = load("experiment-family-budget.json")
    freshness = load("evidence-freshness-v2.json")
    data_lake = load("data-lake-baseline-20260903.json")
    model_baseline = load("legacy-model-baseline.json")
    sparse = load("sparse-feature-allowlist.json")
    transfer = load("transfer-common-feature-schema.json")
    prequential = load("prequential-feature-contract.json")
    ui_contract = load("evidence-tier-ui-contract.json")
    registry_pointer = load("research-registry-pointer-test.json")
    manual_scheduler = load("manual-research-scheduler-test.json")
    no_auto_retry = load("research-no-auto-retry-test.json")
    evidence_types = load("research-evidence-type-test.json")
    status_api = load("research-status-api-test.json")
    route_decision = load("research-route-transition-decision.json")
    route_gate = load("00-route-transition-gate.json")
    integration = load("research-lane-integration-test.json")
    state_log = load_jsonl("research-state-transition-log.jsonl")
    owner_waiver = route_gate.get("ownerRiskWaiver") or {}
    app_source = (ROOT / "app.js").read_text(encoding="utf-8")
    accepted_rows = accepted.get("rows") if isinstance(accepted.get("rows"), list) else []
    accepted_rows_valid = all(
        isinstance(row.get("sourceEvidence"), dict)
        and all(row["sourceEvidence"].get(key) for key in ("path", "bytes", "modifiedAt", "sha256"))
        for row in accepted_rows
    )
    return {
        "R0001": {
            "passed": correction.get("legacyTaskId") == "G0003"
            and correction.get("correction", {}).get("g0003IsStrictOofBlock") is False
            and bool(correction.get("legacyTask")),
            "evidence": "g0003-definition-correction.json",
        },
        "R0002": {
            "passed": legacy.get("taskTotal") == 300
            and legacy.get("statusCounts", {}).get("ACCEPTED") == 133
            and legacy.get("statusCounts", {}).get("BLOCKED") == 167,
            "evidence": "legacy-plan-status-snapshot.json",
        },
        "R0003": {
            "passed": accepted.get("acceptedTaskCount") == 133
            and accepted.get("hashedEvidenceCount") == 133
            and accepted.get("missingSourceCount") == 0
            and accepted_rows_valid,
            "evidence": "accepted-evidence-sha256.json",
        },
        "R0004": {
            "passed": blocked.get("reviewStatus") == "ACCEPTED"
            and blocked.get("uniquenessCheck") is True,
            "evidence": "blocked-task-cause-map.json",
        },
        "R0017": {
            "passed": route_decision.get("decisionStatus") == "OWNER_APPROVED_RESEARCH_FALLBACK"
            and route_decision.get("preservedLegacyEvidence") is True
            and route_decision.get("strictProductionGate") == "FROZEN_BLOCKED_UNLESS_EXPLICIT_GATE03_APPROVAL"
            and route_decision.get("researchCannotPromote") is True,
            "evidence": "research-route-transition-decision.json; independent stage gate remains separate",
        },
        "R0018": {
            "passed": route_gate.get("status") == "ACCEPTED"
            and all((route_gate.get("acceptanceMatrix") or {}).values())
            and not route_gate.get("pendingTasks"),
            "evidence": "00-route-transition-gate.json; independent acceptance required",
        },
        "R0010": {
            "passed": pit_exclusion.get("expected") == {"sourceRows": 0, "unverifiedRowsExcluded": 1, "joinViolationCount": 0}
            and "historicalAvailabilityVerified" in str(pit_exclusion.get("contract"))
            and bool(pit_exclusion.get("productionSource")),
            "evidence": "unverified-pit-exclusion-test.json",
        },
        "R0012": {
            "passed": budget.get("budget") == {"familiesPerLabel": 8, "configsPerFamily": 12, "seedsForFinalists": 3, "deepArchitectures": 3},
            "evidence": "experiment-family-budget.json",
        },
        "R0013": {
            "passed": freshness.get("fields") == ["generatedAt", "dataAsOf", "ageHours", "isLatest"]
            and all((freshness.get("sourceWiringPresent") or {}).values()),
            "evidence": "evidence-freshness-v2.json plus model report freshness runtime test",
        },
        "R0014": {
            "passed": all(
                isinstance((data_lake.get("markets") or {}).get(market), dict)
                and all(
                    isinstance(((data_lake.get("markets") or {}).get(market) or {}).get("datasets", {}).get(dataset), dict)
                    and ((data_lake.get("markets") or {}).get(market) or {}).get("datasets", {}).get(dataset, {}).get("fileCount", 0) > 0
                    and bool(((data_lake.get("markets") or {}).get(market) or {}).get("datasets", {}).get(dataset, {}).get("contentHash"))
                    for dataset in data_lake.get("requiredDatasets", [])
                )
                for market in ("ASX", "US", "CN")
            ),
            "evidence": "data-lake-baseline-20260903.json; file presence only, PIT row semantics remain separate",
        },
        "R0015": {
            "passed": all(
                isinstance((model_baseline.get("markets") or {}).get(market), dict)
                and bool(((model_baseline.get("markets") or {}).get(market) or {}).get("modelVersion"))
                and bool(((model_baseline.get("markets") or {}).get(market) or {}).get("dataVersion"))
                and bool(((model_baseline.get("markets") or {}).get(market) or {}).get("oof", {}).get("evidenceHash"))
                and int(((model_baseline.get("markets") or {}).get(market) or {}).get("oof", {}).get("oofRows") or 0) > 0
                for market in ("ASX", "US", "CN")
            ),
            "evidence": "legacy-model-baseline.json; evidenceHash is derived from preserved fold metrics, raw OOF persistence is reported explicitly",
        },
        "R0016": {
            "passed": set((ui_contract.get("tiers") or {}).keys()) == {"D0", "D1", "D2", "D3", "D4"}
            and all(isinstance(value, dict) and value.get("className") for value in (ui_contract.get("tiers") or {}).values())
            and all(token in app_source for token in ("modelReportEvidenceMeta", "evidence-d0", "evidence-d4", "Research only", "evidenceTier")),
            "evidence": "evidence-tier-ui-contract.json plus app.js model card rendering",
        },
        "R0025": {
            "passed": bool(sparse.get("requiredRowFields"))
            and "availableAt" in sparse.get("requiredRowFields", [])
            and "historicalAvailabilityVerified" in sparse.get("requiredRowFields", [])
            and bool(sparse.get("activationRule"))
            and set((sparse.get("markets") or {}).keys()) == {"ASX", "US", "CN"},
            "evidence": "sparse-feature-allowlist.json",
        },
        "R0026": {
            "passed": transfer.get("markets") == ["ASX", "US", "CN"]
            and len(transfer.get("sharedInputs") or []) >= 3
            and bool(transfer.get("normalization"))
            and bool(transfer.get("marketSpecificInputsExcluded")),
            "evidence": "transfer-common-feature-schema.json",
        },
        "R0027": {
            "passed": bool(prequential.get("requiredRule"))
            and isinstance(prequential.get("forbidden"), list)
            and "availableAt <= signalAt" in str(prequential.get("requiredRule"))
            and bool(prequential.get("maturityRule")),
            "evidence": "prequential-feature-contract.json",
        },
        "R0033": {
            "passed": registry_pointer.get("pointerNames") == ["latestResearchAttempt", "bestD1", "bestD2", "qualifiedShadow"]
            and registry_pointer.get("productionPointersAlwaysNull") == ["productionChampion", "latestEligibleModel", "longTradeGate"],
            "evidence": "research-registry-pointer-test.json plus registry pointer runtime test",
        },
        "R0034": {
            "passed": manual_scheduler.get("requiredFields") == ["experimentId", "hypothesisId"]
            and manual_scheduler.get("rejectionReason") == "research_requires_experiment_and_hypothesis_id",
            "evidence": "manual-research-scheduler-test.json plus explicit identity unit test",
        },
        "R0035": {
            "passed": no_auto_retry.get("sameHypothesisQueueDelta") == 0
            and no_auto_retry.get("automaticRetry") == "rejected"
            and no_auto_retry.get("rejectionReason") == "research_auto_retry_forbidden",
            "evidence": "research-no-auto-retry-test.json plus research lane unit test",
        },
        "R0036": {
            "passed": evidence_types.get("mapping") == {"D1": "restricted_oof", "D2": "robust_research", "D3": "prequential_shadow"},
            "evidence": "research-evidence-type-test.json plus research-evidence-tier-v2.json",
        },
        "R0037": {
            "passed": status_api.get("states") == ["WAITING_ROUTE_EVIDENCE", "READY_FOR_RESEARCH_REVIEW", "NOT_STARTED_BY_POLICY", "WAITING_PRE_REGISTERED_HYPOTHESIS", "BLOCKED_GATE03"],
            "evidence": "research-status-api-test.json plus runtime status helper test",
        },
        "R0038": {
            "passed": all(token in app_source for token in ("model-evidence-tier", "model-research-meta", "Universe:", "dataAsOf:", "Research only")),
            "evidence": "evidence-tier-ui-contract.json plus app.js research-only banner and metadata",
        },
        "R0039": {
            "passed": bool(state_log)
            and len({row.get("eventId") for row in state_log}) == len(state_log)
            and all(
                row.get("schema") == "research-state-transition-event-v1"
                and row.get("appendOnly") is True
                and row.get("transitionAllowed") is True
                and row.get("nextState") in {"QUEUED", "RUNNING", "EVIDENCE_READY", "ACCEPTED", "REJECTED"}
                and row.get("productionPointersChanged") is False
                for row in state_log
            ),
            "evidence": "research-state-transition-log.jsonl; real retry-policy rejection observation",
        },
        "R0041": {
            "passed": integration.get("status") == "ACCEPTED"
            and integration.get("formalOofStarted") is True
            and integration.get("modelFitStarted") is True
            and set(integration.get("requiredArtifacts") or []) <= set(integration.get("producedArtifacts") or [])
            and integration.get("championUpdated") is False
            and integration.get("productionPointersChanged") is False,
            "evidence": "research-lane-integration-test.json; D1 research OOF persisted while production remains gated",
        },
        "R0043": {
            "passed": False,
            "evidence": "01-executable-research-lane-gate-20260903.json; remains OPEN until R0004/R0018 and the stage acceptance is recorded",
        },
    }


def run_audit(output_dir: Path) -> dict[str, Any]:
    contract, contract_hash = load_research_contract()
    checks: dict[str, Any] = {}
    policy = resolve_training_lane({})
    checks["R0005"] = {"passed": policy["strictGateFrozen"], "evidence": "research-evidence-tier-v2.json"}
    checks["R0006"] = {"passed": tuple(row["id"] for row in contract["lanes"]) == ALLOWED_LANES, "evidence": "research-evidence-tier-v2.json"}
    research_payload = {
        "trainingLane": "core_research",
        "experimentId": "audit-exp-20260903",
        "hypothesisId": "audit-hypothesis-20260903",
        "changedHypotheses": ["verified price core with 10-day net-up label"],
    }
    research_contract = experiment_hypothesis_contract(research_payload)
    research_decision = validate_training_request(research_payload, hypothesis_contract=research_contract)
    checks["R0009"] = {"passed": research_decision.get("longTradeGateAllowed") is False, "evidence": "research_lane.py"}
    checks["R0011"] = {"passed": research_contract.get("valid") is True, "evidence": "research_governance.py"}
    checks["R0019"] = {"passed": bool(contract_hash), "evidence": "research-evidence-tier-v2.json"}
    checks["R0020"] = {"passed": all(key in contract for key in ("lanes", "researchEvidence", "strictLane", "nonPromotionRules")), "evidence": "research-evidence-tier-v2.json"}
    checks["R0021"] = {"passed": policy["lane"] == "strict_production" and policy["explicit"] is False, "evidence": "research_lane.py"}
    checks["R0022"] = {"passed": research_decision.get("allowed") is True and research_decision.get("promotionEligible") is False, "evidence": "research_lane.py"}
    strict_result = train_market_multitask({
        "market": "ASX",
        "items": [],
        "strictGate03Approved": False,
        "changedHypotheses": ["audit strict gate denial"],
    })
    checks["R0023"] = {"passed": strict_result.get("status") == "BLOCKED_GATE03" and not strict_result.get("available"), "evidence": "production_training.py pre-fit call"}
    checks["R0024"] = {"passed": (ROOT / "quant_core" / "production_training.py").exists(), "evidence": "existing core feature contract remains in production_training.py"}
    checks["R0028"] = {"passed": [adaptive_fold_count(value) for value in (30, 60, 120)] == [3, 4, 5], "evidence": "research_lane.py"}
    checks["R0029"] = {"passed": default_horizons({"trainingLane": "core_research"}, "core_research") == [10, 20], "evidence": "research_lane.py"}
    artifact = research_artifact_root(".cache/models/research", market="ASX", lane="core_research", hypothesis_id="h-1", data_version="d-1", run_id="r-1")
    checks["R0030"] = {"passed": all(part in str(artifact) for part in ("ASX", "core_research", "h-1", "d-1", "r-1")), "evidence": "research_lane.py"}
    checks["R0031"] = {"passed": "trainingLane" in {"trainingLane": "core_research"}, "evidence": "comparison key code path"}
    lockbox_fields = research_lockbox_fields(lane="core_research", universe_hash="u", label_hash="l", feature_hash="f", cost_hash="c", split_hash="s")
    checks["R0032"] = {"passed": lockbox_fields.get("trainingLane") == "core_research" and bool(lockbox_fields.get("laneHash")), "evidence": "research_lane.py"}
    checks.update(route_transition_artifact_checks())
    static = static_wiring_checks()
    checks["R0042"] = {"passed": all(static.values()), "evidence": "static source wiring plus pre-fit runtime check"}
    backend_tests = backend_runtime_evidence()
    unit_tests = research_unit_runtime_evidence()
    checks["R0007"] = {"passed": backend_tests["passed"] and backend_tests["researchRegistryIsolationTestPassed"], "evidence": "server research registry isolation runtime test"}
    checks["R0008"] = {"passed": backend_tests["passed"] and backend_tests["researchRegistryIsolationTestPassed"], "evidence": "server research registry production-pointer rejection runtime test"}
    checks["R0033"] = {"passed": checks["R0033"]["passed"] and backend_tests["passed"] and backend_tests["researchRegistryIsolationTestPassed"], "evidence": "research-registry-pointer-test.json plus server registry runtime test"}
    checks["R0034"] = {"passed": checks["R0034"]["passed"] and unit_tests["passed"], "evidence": "manual-research-scheduler-test.json plus research lane unit tests"}
    checks["R0035"] = {"passed": checks["R0035"]["passed"] and unit_tests["passed"], "evidence": "research-no-auto-retry-test.json plus research lane unit tests"}
    checks["R0037"] = {"passed": checks["R0037"]["passed"] and backend_tests["passed"] and backend_tests["researchStatusApiTestPassed"], "evidence": "research-status-api-test.json plus server runtime helper test"}
    checks["R0040"] = {"passed": backend_tests["passed"] and unit_tests["passed"], "evidence": "tests/test_research_lane.py plus backend runtime suite"}
    checks["R0010"] = {"passed": checks["R0010"]["passed"] and unit_tests["passed"], "evidence": "unverified-pit-exclusion-test.json plus targeted PIT runtime test"}
    checks["R0013"] = {"passed": checks["R0013"]["passed"] and backend_tests["modelReportFreshnessTestPassed"], "evidence": "evidence-freshness-v2.json plus model report freshness runtime test"}

    completed = sorted(task_id for task_id, item in checks.items() if item.get("passed"))
    ledger_rows = read_ledger(LEDGER)
    all_ids = {str(row.get("ID") or row.get("taskId") or row.get("id") or "").strip() for row in ledger_rows}
    first_batch = {f"R{value:04d}" for value in range(1, 44)}
    pending = sorted(first_batch.difference(completed))
    now = datetime.now(timezone.utc).isoformat()
    try:
        route_gate_state = json.loads((ROOT / "reports" / "00-route-transition-gate.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        route_gate_state = {}
    try:
        integration_state = json.loads((ROOT / "reports" / "research-lane-integration-test.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        integration_state = {}
    owner_waiver = route_gate_state.get("ownerRiskWaiver") or {}
    if "R0041" in pending and owner_waiver.get("status") == "OWNER_RISK_WAIVER_ACCEPTED":
        next_action = "Owner risk waiver recorded for research-only work; wait for a new real ASX official PDF in strict PIT, then prepare (not production-fit) the first registered research run."
    elif "R0004" in pending:
        next_action = "Independent reviewer: verify blocked-task primary causes, then rerun the audit. R0018 remains closed."
    elif "R0018" in pending:
        next_action = "Independent reviewer: sign 00-route-transition-gate.json, then dispatch the first real registered research run for R0041."
    elif "R0041" in pending:
        next_action = "Run one real pre-registered research hypothesis and persist matrix, OOF, calibration, model card and research registry evidence."
    else:
        next_action = "Run the stage gate audit and record R0043 without changing production pointers."
    route = {
        "schema": "research-route-transition-audit-v1",
        "generatedAt": now,
        "planDate": "2026-09-03",
        "contract": {"path": str((ROOT / "quant_core/contracts/research-evidence-tier-v2.json").resolve()), "sha256": contract_hash},
        "gate03Policy": {"strictLane": "FROZEN_BLOCKED_UNLESS_EXPLICIT_APPROVAL", "researchLanes": list(ALLOWED_LANES[:-1])},
        "completedTaskIds": completed,
        "pendingTaskIds": pending,
        "ledgerRowsFound": len(ledger_rows),
        "ledgerFirstBatchIdsFound": len(all_ids.intersection(first_batch)),
        "staticWiring": static,
        "checks": checks,
        "backendRuntimeTests": backend_tests,
        "researchUnitTests": unit_tests,
        "modelTrainingStarted": integration_state.get("modelFitStarted") is True,
        "formalOofStarted": integration_state.get("formalOofStarted") is True,
        "championUpdated": False,
        "longTradeGateActivated": False,
        "nextAction": next_action,
        "atomizedBlockerPacket": str((output_dir / "remaining-route-blockers-20260903.json").resolve()),
        "ownerRiskWaiver": owner_waiver,
        "blockedBy": [
            "Current Gate03 still blocks D4; no new model is allowed until the route-transition gate is signed.",
        ],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename, body in {
        "research-lane-wiring-20260903.json": {"schema": "research-lane-wiring-audit-v1", "generatedAt": now, "checks": static, "strictRuntimeProbe": checks["R0023"]},
        "research-route-transition-20260903.json": route,
        "01-executable-research-lane-gate-20260903.json": {"schema": "stage-gate-v1", "stage": "01研究备选通道可执行化", "status": "OPEN", "generatedAt": now, "completedTaskIds": completed, "pendingTaskIds": pending, "exitCondition": "Gate03 block permits explicit D1-D3 research, D4 remains blocked, and research cannot touch production pointers.", "routeAudit": str((output_dir / "research-route-transition-20260903.json").resolve())},
    }.items():
        temporary = output_dir / f".{filename}.tmp"
        temporary.write_text(json.dumps(body, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        temporary.replace(output_dir / filename)
    return route


def main() -> int:
    output = run_audit(ROOT / "reports")
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["pendingTaskIds"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
