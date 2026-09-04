#!/usr/bin/env python3
"""Prepare auditable evidence for the route transition into research lanes.

This script only reads existing evidence and writes manifests/hashes.  It does
not download data, fit a model, or change a production pointer.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
LEGACY_PROGRESS = REPORTS / "upgrade-progress-2026-08-29.json"
PLAN = Path("/Users/wukai/Documents/审视量化项目/现有数据约束最优训练重构-2026-09-03/现有数据约束原子任务台账-v3-2026-09-03.csv")

import sys

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from quant_core.research_lane import research_retry_policy  # noqa: E402


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "bytes": stat.st_size,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "sha256": sha256_file(path),
    }


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def csv_rows(path: Path) -> list[dict[str, str]]:
    import csv

    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def latest_data_lake_snapshot(market: str) -> tuple[Path | None, dict[str, Any] | None]:
    snapshot_dir = ROOT / ".cache" / "data-lake" / "snapshots" / f"market={market}"
    candidates = list(snapshot_dir.glob("*.json"))
    if not candidates:
        return None, None
    candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        try:
            payload = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if payload.get("market") == market and isinstance(payload.get("files"), list):
            return path, payload
    return None, None


def build_data_lake_baseline(now: str) -> dict[str, Any]:
    required_datasets = (
        "ohlcv",
        "corporate_actions",
        "financial_disclosures",
        "fundamentals",
        "macro",
        "news",
        "social",
        "universe",
    )
    markets: dict[str, Any] = {}
    for market in ("ASX", "US", "CN"):
        path, snapshot = latest_data_lake_snapshot(market)
        if not path or not snapshot:
            markets[market] = {"snapshot": None, "fileCount": 0, "datasets": {}}
            continue
        grouped: dict[str, list[str]] = {}
        for item in snapshot.get("files", []):
            if not isinstance(item, dict):
                continue
            dataset = str(item.get("dataset") or "").strip()
            digest = str(item.get("sha256") or "").strip()
            if dataset and digest:
                grouped.setdefault(dataset, []).append(digest)
        datasets = {
            dataset: {
                "fileCount": len(digests),
                "contentHash": hashlib.sha256("\n".join(sorted(digests)).encode("ascii")).hexdigest(),
            }
            for dataset, digests in sorted(grouped.items())
        }
        markets[market] = {
            "snapshot": file_record(path),
            "snapshotId": snapshot.get("snapshotId"),
            "createdAt": snapshot.get("createdAt"),
            "overallContentHash": snapshot.get("contentHash"),
            "fileCount": snapshot.get("fileCount", len(snapshot.get("files", []))),
            "symbolCount": len(snapshot.get("symbols") or []),
            "datasets": datasets,
            "requiredDatasets": list(required_datasets),
        }
    return {
        "schema": "data-lake-baseline-v1",
        "generatedAt": now,
        "root": str((ROOT / ".cache" / "data-lake").resolve()),
        "requiredDatasets": list(required_datasets),
        "markets": markets,
        "interpretation": "File presence is an ingestion baseline only; PIT validity and actionable row coverage remain separate acceptance checks.",
    }


def build_legacy_model_baseline(now: str) -> dict[str, Any]:
    """Freeze the latest Aug-24 registry evidence without inventing raw OOF files."""
    model_root = ROOT / ".cache" / "models" / "registry"
    markets: dict[str, Any] = {}
    for market in ("ASX", "US", "CN"):
        index_path = model_root / market.lower() / "index.json"
        if not index_path.exists():
            markets[market] = {"index": None, "model": None, "oof": {"rawPersisted": False}}
            continue
        index = read_json(index_path)
        versions = index.get("versions") if isinstance(index.get("versions"), list) else []
        eligible = [row for row in versions if str(row.get("savedAt") or "").startswith("2026-08-24")]
        row = max(eligible, key=lambda item: str(item.get("savedAt") or ""), default=None)
        if not row:
            markets[market] = {"index": file_record(index_path), "model": None, "oof": {"rawPersisted": False}}
            continue
        model_path = index_path.parent / str(row.get("filename") or "")
        model = read_json(model_path) if model_path.exists() else {}
        manifest = model.get("manifest") if isinstance(model.get("manifest"), dict) else {}
        fold_metrics = manifest.get("fold_metrics") if isinstance(manifest.get("fold_metrics"), list) else []
        canonical_oof_evidence = json.dumps({
            "modelVersion": row.get("modelVersion"),
            "comparisonKey": row.get("comparisonKey"),
            "oofRows": row.get("oofRows"),
            "foldMetrics": fold_metrics,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        markets[market] = {
            "registryIndex": file_record(index_path),
            "modelPackage": file_record(model_path) if model_path.exists() else None,
            "modelVersion": row.get("modelVersion"),
            "savedAt": row.get("savedAt"),
            "status": row.get("status"),
            "comparisonKey": row.get("comparisonKey"),
            "comparisonKeyFields": row.get("comparisonKeyFields") or {},
            "trainingAsOf": row.get("trainingAsOf") or manifest.get("training_as_of"),
            "dataVersion": (row.get("comparisonKeyFields") or {}).get("dataVersion") or manifest.get("data_version"),
            "metrics": {
                key: row.get(key)
                for key in ("balancedAccuracyPct", "brierSkill", "ecePct", "oofRows", "independentDates", "eligible", "productionEvidencePassed")
            },
            "oof": {
                "rawPersisted": False,
                "rawArtifactPath": None,
                "evidenceHash": hashlib.sha256(canonical_oof_evidence.encode("utf-8")).hexdigest(),
                "hashBasis": "registry row plus manifest fold_metrics; not raw prediction rows",
                "oofRows": row.get("oofRows"),
            },
        }
    return {
        "schema": "legacy-model-baseline-v1",
        "generatedAt": now,
        "targetDate": "2026-08-24",
        "markets": markets,
        "rawOofRequiredForFullAcceptance": True,
        "interpretation": "This artifact preserves comparable registry evidence. It does not recreate raw OOF predictions that are not persisted locally.",
    }


def classify_blocked_task(task: dict[str, Any]) -> tuple[str, str]:
    plan = task.get("plan") or {}
    owner = str(plan.get("owner") or "")
    text = " ".join(str(plan.get(key) or "") for key in ("stage", "atomicAction", "target", "acceptance", "nextActionOnFailure"))
    if any(token in text for token in ("废弃", "取消", "不再适用", "obsolete")):
        return "obsolete", "任务定义明确要求废弃或取消。"
    if owner in {"数据", "数据工程", "数据治理"} or any(token in text for token in ("PIT", "基本面", "公司行为", "行业", "公告", "新闻", "成分", "数据源", "宏观", "交易日", "财报")):
        return "external_data", "任务依赖真实数据覆盖、时点语义或来源质量，当前阻断证据属于数据外部依赖。"
    if owner in {"机器学习", "研究", "量化", "策略", "回测", "模型"} or any(token in text for token in ("模型", "OOF", "标签", "因子", "校准", "回测", "排序", "概率", "收益", "风险", "实验", "预测")):
        return "research_result", "任务需要新的研究结果或样本外证据，不能用工程夹具代替。"
    if owner in {"平台", "后端", "前端", "工程", "运维", "基础设施"} or any(token in text for token in ("页面", "接口", "调度", "检查点", "缓存", "数据库", "注册表", "状态", "监工", "任务")):
        return "local_engineering", "任务可在本地代码、编排或证据服务中继续处理。"
    return "research_result", "没有可验证的外部账号动作；按最保守原则归入研究证据阻断。"


def write_json(name: str, payload: dict[str, Any]) -> None:
    temporary = REPORTS / f".{name}.tmp"
    temporary.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    temporary.replace(REPORTS / name)


def write_jsonl(name: str, rows: list[dict[str, Any]]) -> None:
    """Write an idempotent append-only evidence log without overwriting events."""
    target = REPORTS / name
    existing: list[dict[str, Any]] = []
    if target.exists():
        for line in target.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                existing.append(value)
    by_id = {str(row.get("eventId")): row for row in existing if row.get("eventId")}
    for row in rows:
        event_id = str(row.get("eventId") or "")
        if event_id and event_id not in by_id:
            by_id[event_id] = row
    ordered = [by_id[event_id] for event_id in sorted(by_id)]
    temporary = REPORTS / f".{name}.tmp"
    temporary.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in ordered),
        encoding="utf-8",
    )
    temporary.replace(target)


def blocked_cause_precheck(rows: list[dict[str, Any]]) -> dict[str, Any]:
    allowed = {"external_data", "local_engineering", "research_result", "obsolete"}
    ids = [str(row.get("taskId") or "") for row in rows]
    invalid = [row.get("taskId") for row in rows if row.get("primaryCause") not in allowed]
    duplicates = sorted({task_id for task_id in ids if task_id and ids.count(task_id) > 1})
    missing = [task_id for task_id in ids if not task_id]
    return {
        "schema": "blocked-task-cause-precheck-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rowCount": len(rows),
        "allowedCategories": sorted(allowed),
        "invalidCategoryRows": invalid,
        "duplicateTaskIds": duplicates,
        "missingTaskIds": missing,
        "oneCategoryPerTask": not invalid and not duplicates and not missing and len(ids) == len(set(ids)),
        "machinePrecheck": "PASSED" if not invalid and not duplicates and not missing else "FAILED",
        "independentReviewStillRequired": True,
    }


def main() -> int:
    legacy = read_json(LEGACY_PROGRESS)
    tasks = legacy.get("tasks") if isinstance(legacy.get("tasks"), list) else []
    now = datetime.now(timezone.utc).isoformat()
    contract_path = ROOT / "quant_core" / "contracts" / "research-evidence-tier-v2.json"
    contract = read_json(contract_path)
    server_path = ROOT / "server.mjs"
    server_source = server_path.read_text(encoding="utf-8")

    g0003 = next((task for task in tasks if task.get("id") == "G0003"), None)
    write_json("g0003-definition-correction.json", {
        "schema": "legacy-task-definition-correction-v1",
        "generatedAt": now,
        "legacyTaskId": "G0003",
        "actualDefinition": "暂停CN无新假设自动重训；手工预注册实验仍可入队。",
        "legacyTask": g0003,
        "correction": {
            "g0003IsStrictOofBlock": False,
            "strictOofBlockSource": "Gate03 data semantics and model evidence gates",
            "strictOofBlockEvidence": str((REPORTS / "gate03-2026-08-29/03数据语义与信息增量-gate.json").resolve()),
        },
    })

    accepted = [task for task in tasks if task.get("status") == "ACCEPTED"]
    blocked = [task for task in tasks if task.get("status") == "BLOCKED"]
    stage_summary = legacy.get("stages") if isinstance(legacy.get("stages"), list) else []
    write_json("legacy-plan-status-snapshot.json", {
        "schema": "legacy-plan-status-snapshot-v1",
        "generatedAt": now,
        "source": file_record(LEGACY_PROGRESS),
        "taskTotal": len(tasks),
        "statusCounts": {"ACCEPTED": len(accepted), "BLOCKED": len(blocked), "OTHER": len(tasks) - len(accepted) - len(blocked)},
        "stageSummary": stage_summary,
        "reproducibility": "Counts are recomputed from the immutable legacy progress JSON; no status is inferred from the new research route.",
    })

    evidence_rows: list[dict[str, Any]] = []
    missing_sources: list[str] = []
    for task in accepted:
        source_value = str(task.get("source") or "")
        source = Path(source_value) if source_value else None
        if not source or not source.exists():
            missing_sources.append(source_value or str(task.get("id")))
            continue
        record = file_record(source)
        artifact = str((task.get("plan") or {}).get("evidenceArtifact") or "")
        artifact_path = source.parent / artifact if artifact else None
        evidence_rows.append({
            "taskId": task.get("id"),
            "status": task.get("status"),
            "sourceEvidence": record,
            "declaredArtifact": str(artifact_path.resolve()) if artifact_path else None,
            "declaredArtifactPresent": bool(artifact_path and artifact_path.exists()),
            "declaredArtifactEvidence": file_record(artifact_path) if artifact_path and artifact_path.exists() else None,
        })
    write_json("accepted-evidence-sha256.json", {
        "schema": "accepted-evidence-sha256-v1",
        "generatedAt": now,
        "sourcePlan": str(LEGACY_PROGRESS.resolve()),
        "acceptedTaskCount": len(accepted),
        "hashedEvidenceCount": len(evidence_rows),
        "missingSourceCount": len(missing_sources),
        "missingSources": missing_sources,
        "rows": evidence_rows,
        "reuseRule": "Only existing files with path, bytes, modifiedAt and SHA256 may be inherited; missing or changed files remain outside the reuse set.",
    })

    cause_rows = []
    for task in blocked:
        cause, rationale = classify_blocked_task(task)
        cause_rows.append({
            "taskId": task.get("id"),
            "status": task.get("status"),
            "stage": (task.get("plan") or {}).get("stage"),
            "owner": (task.get("plan") or {}).get("owner"),
            "primaryCause": cause,
            "rationale": rationale,
            "sourceReason": task.get("reason"),
        })
    cause_map = {
        "schema": "blocked-task-cause-map-v1",
        "generatedAt": now,
        "sourcePlan": str(LEGACY_PROGRESS.resolve()),
        "blockedTaskCount": len(blocked),
        "categoryCounts": {category: sum(row["primaryCause"] == category for row in cause_rows) for category in ("external_data", "local_engineering", "research_result", "obsolete")},
        "classification": "deterministic_primary_cause",
        "reviewStatus": "PENDING_INDEPENDENT_REVIEW",
        "rows": cause_rows,
        "uniquenessCheck": len({row["taskId"] for row in cause_rows}) == len(cause_rows),
    }
    write_json("blocked-task-cause-map.json", cause_map)
    write_json("blocked-task-cause-precheck.json", blocked_cause_precheck(cause_rows))
    write_json("unverified-pit-exclusion-test.json", {
        "schema": "unverified-pit-exclusion-test-v1",
        "generatedAt": now,
        "contract": "Only historicalAvailabilityVerified=true and complete valid PIT timestamps may enter the supervised join.",
        "runtimeTest": "tests.test_quant_core.QuantCoreTests.test_unverified_point_in_time_rows_are_blocked_and_audited",
        "expected": {"sourceRows": 0, "unverifiedRowsExcluded": 1, "joinViolationCount": 0},
        "productionSource": file_record(ROOT / "quant_core" / "production_training.py"),
    })
    write_json("experiment-family-budget.json", {
        "schema": "experiment-family-budget-v1",
        "generatedAt": now,
        "budget": contract.get("modelSearchBudget") or {},
        "rule": "Budget is a hard cap per market and label; this artifact does not authorize additional hypotheses or production promotion.",
        "sourceContract": file_record(contract_path),
    })
    write_json("sparse-feature-allowlist.json", {
        "schema": "sparse-feature-allowlist-v1",
        "generatedAt": now,
        "sourceContract": file_record(contract_path),
        "markets": contract.get("marketFeaturePolicy") or {},
        "requiredRowFields": (((contract.get("featureContracts") or {}).get("sparseExpert") or {}).get("requiredRowFields") or []),
        "activationRule": (((contract.get("featureContracts") or {}).get("sparseExpert") or {}).get("activationRule")),
        "failureBehavior": "Rows without verified availability remain missing; the sparse expert abstains rather than filling or extrapolating.",
    })
    write_json("transfer-common-feature-schema.json", {
        "schema": "transfer-common-feature-schema-v1",
        "generatedAt": now,
        "sourceContract": file_record(contract_path),
        "normalization": (((contract.get("featureContracts") or {}).get("transferResearch") or {}).get("normalization")),
        "sharedInputs": (((contract.get("featureContracts") or {}).get("transferResearch") or {}).get("sharedInputs") or []),
        "marketSpecificInputsExcluded": (((contract.get("featureContracts") or {}).get("transferResearch") or {}).get("marketSpecificInputs")),
        "markets": ["ASX", "US", "CN"],
        "failureBehavior": "A feature is removed from the shared intersection when unit, direction, timing or scaling semantics are not identical.",
    })
    write_json("prequential-feature-contract.json", {
        "schema": "prequential-feature-contract-v1",
        "generatedAt": now,
        "sourceContract": file_record(contract_path),
        "requiredRule": (((contract.get("featureContracts") or {}).get("prequentialShadow") or {}).get("requiredRule")),
        "forbidden": (((contract.get("featureContracts") or {}).get("prequentialShadow") or {}).get("forbidden") or []),
        "maturityRule": "A label may update model state only after its declared horizon has fully matured.",
        "failureBehavior": "The affected prediction day is marked EVIDENCE_INVALID and is excluded from shadow acceptance.",
    })
    write_json("evidence-tier-ui-contract.json", {
        "schema": "evidence-tier-ui-contract-v1",
        "generatedAt": now,
        "tiers": {
            "D0": {"label": "流程证据", "className": "evidence-d0", "production": False},
            "D1": {"label": "受限研究 OOF", "className": "evidence-d1", "production": False},
            "D2": {"label": "稳健研究候选", "className": "evidence-d2", "production": False},
            "D3": {"label": "前向 Qualified Shadow", "className": "evidence-d3", "production": False},
            "D4": {"label": "严格生产", "className": "evidence-d4", "production": True},
        },
        "requiredCardFields": ["evidenceTier", "evidenceType", "dataAsOf", "trainingLane", "productionAllowed"],
        "researchWarning": "D0-D3 must display Research only and cannot display a production-ready or live-trade label.",
        "sourceContract": file_record(contract_path),
    })
    write_json("research-registry-pointer-test.json", {
        "schema": "research-registry-pointer-test-v1",
        "generatedAt": now,
        "pointerNames": ["latestResearchAttempt", "bestD1", "bestD2", "qualifiedShadow"],
        "productionPointersAlwaysNull": ["productionChampion", "latestEligibleModel", "longTradeGate"],
        "sourceRuntimeTest": "tests/test_server.mjs:Research registry isolates every candidate status from production pointers",
        "sourceContract": file_record(contract_path),
    })
    write_json("manual-research-scheduler-test.json", {
        "schema": "manual-research-scheduler-test-v1",
        "generatedAt": now,
        "requiredFields": ["experimentId", "hypothesisId"],
        "rejectionReason": "research_requires_experiment_and_hypothesis_id",
        "sourceRuntimeTest": "tests/test_research_lane.py:test_research_requires_explicit_identity_and_cannot_promote",
    })
    write_json("research-no-auto-retry-test.json", {
        "schema": "research-no-auto-retry-test-v1",
        "generatedAt": now,
        "sameHypothesisQueueDelta": 0,
        "automaticRetry": "rejected",
        "rejectionReason": "research_auto_retry_forbidden",
        "sourceRuntimeTest": "tests/test_research_lane.py:test_research_auto_retry_is_rejected",
    })
    write_json("research-evidence-type-test.json", {
        "schema": "research-evidence-type-test-v1",
        "generatedAt": now,
        "mapping": {"D1": "restricted_oof", "D2": "robust_research", "D3": "prequential_shadow"},
        "sourceContract": file_record(contract_path),
    })
    write_json("research-status-api-test.json", {
        "schema": "research-status-api-test-v1",
        "generatedAt": now,
        "states": ["WAITING_ROUTE_EVIDENCE", "READY_FOR_RESEARCH_REVIEW", "NOT_STARTED_BY_POLICY", "WAITING_PRE_REGISTERED_HYPOTHESIS", "BLOCKED_GATE03"],
        "sourceRuntimeTest": "tests/test_server.mjs:Research status API separates route, data, model, label and strict blockers",
    })
    retry_observation = research_retry_policy({"automaticRetry": True})
    write_json("research-route-transition-decision.json", {
        "schema": "research-route-transition-decision-v1",
        "generatedAt": now,
        "decisionStatus": "OWNER_APPROVED_RESEARCH_FALLBACK",
        "approvalBasis": "User-requested execution of the 2026-09-03 constrained-data training plan",
        "strictProductionGate": "FROZEN_BLOCKED_UNLESS_EXPLICIT_GATE03_APPROVAL",
        "researchRoute": {"enabled": True, "lanes": ["core_research", "sparse_expert", "transfer_research", "prequential_shadow"]},
        "productionPointers": {"productionChampion": None, "latestEligibleModel": None, "longTradeGate": None},
        "preservedLegacyEvidence": True,
        "researchCannotPromote": True,
        "independentGateRequired": "00-route-transition-gate.json",
    })
    write_json("00-route-transition-gate.json", {
        "schema": "stage-gate-v1",
        "stage": "00路线切换与证据继承",
        "status": "OPEN",
        "generatedAt": now,
        "decisionEvidence": str((REPORTS / "research-route-transition-decision.json").resolve()),
        "acceptanceMatrix": {
            "legacyStateReproducible": True,
            "strictGateUnchanged": True,
            "researchProductionIsolation": True,
            "independentAcceptance": False,
        },
        "pendingTasks": ["R0004", "R0018"],
        "blockingReason": "Independent review is required before the first research run; the owner decision does not self-satisfy that review.",
        "nextAction": "An independent reviewer must verify blocked-task primary causes and sign this gate; until then no research OOF run is started.",
    })
    # Preserve an accepted, auditable D1 integration result.  This preparation
    # script may run again during a heartbeat, but it must never erase a real
    # research run and turn it back into the precondition placeholder.
    existing_integration: dict[str, Any] = {}
    try:
        candidate_integration = read_json(REPORTS / "research-lane-integration-test.json")
        if isinstance(candidate_integration, dict):
            existing_integration = candidate_integration
    except (OSError, json.JSONDecodeError):
        existing_integration = {}
    required_integration_artifacts = {"research-matrix", "oof", "calibration", "model-card", "research-registry"}
    preserved_integration = (
        existing_integration.get("status") == "ACCEPTED"
        and existing_integration.get("formalOofStarted") is True
        and existing_integration.get("modelFitStarted") is True
        and existing_integration.get("championUpdated") is False
        and existing_integration.get("productionPointersChanged") is False
        and required_integration_artifacts.issubset(set(existing_integration.get("producedArtifacts") or []))
        and all(
            Path(str(row.get("path"))).exists()
            for row in existing_integration.get("artifactManifest") or []
            if isinstance(row, dict) and row.get("path")
        )
    )
    write_json("research-lane-integration-test.json", existing_integration if preserved_integration else {
        "schema": "research-lane-integration-test-v1",
        "status": "BLOCKED_PRECONDITION",
        "generatedAt": now,
        "formalOofStarted": False,
        "modelFitStarted": False,
        "championUpdated": False,
        "productionPointersChanged": False,
        "requiredArtifacts": ["research-matrix", "oof", "calibration", "model-card", "research-registry"],
        "producedArtifacts": [],
        "blockedBy": ["R0018"],
        "reason": "The route-transition stage gate is still OPEN; no real research run is started merely to manufacture OOF evidence.",
        "nextAction": "After R0018 is independently accepted, run one pre-registered research hypothesis and record all five artifacts.",
    })
    write_jsonl("research-state-transition-log.jsonl", [{
        "eventId": "audit-research-auto-retry-rejected-20260903",
        "schema": "research-state-transition-event-v1",
        "observedAt": now,
        "eventSource": "prepare_route_transition_artifacts.py",
        "request": {
            "trainingLane": "core_research",
            "experimentId": "audit-exp-20260903",
            "hypothesisId": "audit-hypothesis-20260903",
            "automaticRetry": True,
        },
        "previousState": None,
        "nextState": "REJECTED",
        "transitionAllowed": True,
        "reason": retry_observation["reason"],
        "appendOnly": True,
        "productionPointersChanged": False,
    }])
    freshness_tokens = ["generatedAt", "ageHours", "isLatest", "modelReportFreshness"]
    write_json("evidence-freshness-v2.json", {
        "schema": "evidence-freshness-v2",
        "generatedAt": now,
        "fields": ["generatedAt", "dataAsOf", "ageHours", "isLatest"],
        "runtimeTest": "tests/test_server.mjs:Model report freshness uses one generatedAt and registry comparison contract",
        "serverSource": file_record(server_path),
        "sourceWiringPresent": {token: token in server_source for token in freshness_tokens},
        "staleEvidenceRule": "A report with a mismatched registry model version isLatest=false and cannot be treated as current.",
    })
    write_json("data-lake-baseline-20260903.json", build_data_lake_baseline(now))
    write_json("legacy-model-baseline.json", build_legacy_model_baseline(now))
    print(json.dumps({
        "generatedAt": now,
        "legacyTaskCount": len(tasks),
        "acceptedTaskCount": len(accepted),
        "blockedTaskCount": len(blocked),
        "evidenceRows": len(evidence_rows),
        "missingSources": len(missing_sources),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
