#!/usr/bin/env python3
"""Build one honest progress index from immutable stage-gate artifacts."""

from __future__ import annotations

import json
import csv
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT_ROOT = ROOT / "reports"
OUT = REPORT_ROOT / "upgrade-progress-2026-08-29.json"
TASK_LEDGER = Path("/Users/wukai/Documents/审视量化项目/三市场预测成功率原子级深化审计-2026-08-28/预测成功率原子任务台账-v2-2026-08-29.csv")


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def read_task_ledger() -> dict[str, dict]:
    """Load the human-authored atomic plan without changing its evidence state."""
    try:
        with TASK_LEDGER.open(encoding="utf-8-sig", newline="") as handle:
            rows = csv.DictReader(handle)
            return {str(row.get("ID") or ""): row for row in rows if row.get("ID")}
    except (OSError, UnicodeError):
        return {}


def main() -> int:
    ledger = read_task_ledger()
    stage_paths = sorted(REPORT_ROOT.glob("gate*-2026-08-29/*gate.json"))
    gate00 = REPORT_ROOT / "gate00-2026-08-29" / "gate00-acceptance.json"
    if gate00.exists():
        stage_paths.insert(0, gate00)
    stages = []
    task_map: dict[str, dict] = {}
    for path in stage_paths:
        report = read_json(path)
        if not report.get("stage") and not isinstance(report.get("taskResults"), dict):
            continue
        tasks = report.get("tasks") if isinstance(report.get("tasks"), list) else []
        if not tasks and isinstance(report.get("taskResults"), dict):
            tasks = [
                {"id": task_id, "status": "ACCEPTED" if passed else "BLOCKED", "contractFixturePassed": bool(passed), "realDataPassed": bool(passed), "reason": None if passed else "stage gate failed"}
                for task_id, passed in sorted(report["taskResults"].items())
            ]
        if report.get("taskId") and report.get("taskId") not in {task.get("id") for task in tasks}:
            tasks.append({"id": str(report["taskId"]), "status": "ACCEPTED" if report.get("passed") is True else "BLOCKED", "contractFixturePassed": report.get("passed") is True, "realDataPassed": report.get("passed") is True, "reason": None if report.get("passed") is True else "stage gate failed"})
        for task in tasks:
            if isinstance(task, dict) and task.get("id"):
                task_map[str(task["id"])] = {**task, "source": str(path)}
        passed_count = int(report.get("passedCount") or report.get("completedTasks") or sum(1 for task in tasks if task.get("status") == "ACCEPTED"))
        total_count = int(report.get("totalTasks") or len(tasks))
        stages.append({"stage": report.get("stage") or report.get("taskId") or path.parent.name, "taskRange": report.get("taskRange"), "passed": passed_count, "blocked": max(0, total_count - passed_count), "nextPhasePermitted": report.get("nextPhasePermitted") is True, "source": str(path), "generatedAt": report.get("generatedAt")})
    for task_id, task in task_map.items():
        plan = ledger.get(task_id) or {}
        task["plan"] = {
            "priority": plan.get("优先级"),
            "stage": plan.get("阶段"),
            "market": plan.get("市场"),
            "dependencies": [item for item in str(plan.get("依赖") or "").split(";") if item and item != "无"],
            "owner": plan.get("责任角色"),
            "target": plan.get("目标模块或数据"),
            "atomicAction": plan.get("单一原子动作"),
            "evidenceArtifact": plan.get("唯一证据产物"),
            "acceptance": plan.get("验收尺度"),
            "nextActionOnFailure": plan.get("未通过后的唯一下一动作"),
            "repeatLimit": plan.get("最大重复规则"),
        }
    accepted = sum(row.get("status") == "ACCEPTED" for row in task_map.values())
    blocked = sum(row.get("status") == "BLOCKED" for row in task_map.values())
    contract_implemented = sum(bool(row.get("contractFixturePassed")) for row in task_map.values())
    strict_evidence_accepted = sum(
        row.get("status") == "ACCEPTED"
        and bool(row.get("realDataPassed"))
        and not bool(row.get("contractFixturePassed"))
        for row in task_map.values()
    )
    todo = max(0, 300 - len(task_map))
    payload = {
        "schema": "upgrade-progress-v2",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "taskTotal": 300,
        "taskObserved": len(task_map),
        "acceptedContractOrEvidence": accepted,
        "contractImplemented": contract_implemented,
        "contractImplementationPct": round(contract_implemented / 300 * 100.0, 3),
        "strictEvidenceAccepted": strict_evidence_accepted,
        "blockedByRealEvidence": blocked,
        "notYetRegistered": todo,
        "completionPct": round(accepted / 300 * 100.0, 3),
        "realProductionEligibleMarkets": [],
        "productionPolicy": "Contract acceptance is not market promotion. A market may be Production only after strict OOF, lockbox, cost-after-return and forward Paper evidence pass.",
        "stages": stages,
        "tasks": sorted(task_map.values(), key=lambda row: row.get("id")),
        "honesty": {"fixtureEvidenceCannotPromote": True, "noFakeMetrics": True, "futureObservationRequired": True},
    }
    payload["atomicPlan"] = {
        "schema": "atomic-upgrade-plan-v1",
        "source": str(TASK_LEDGER),
        "taskCount": len(ledger),
        "blockedByStage": {
            stage["stage"]: stage["blocked"]
            for stage in stages
            if stage["blocked"]
        },
        "nextActions": [
            {
                "id": task_id,
                "priority": task.get("plan", {}).get("priority"),
                "dependencies": task.get("plan", {}).get("dependencies", []),
                "action": task.get("plan", {}).get("atomicAction"),
                "evidenceArtifact": task.get("plan", {}).get("evidenceArtifact"),
                "currentReason": task.get("reason"),
            }
            for task_id, task in sorted(task_map.items())
            if task.get("status") == "BLOCKED"
            and not any(
                dependency and task_map.get(dependency, {}).get("status") != "ACCEPTED"
                for dependency in task.get("plan", {}).get("dependencies", [])
            )
        ][:24],
        "policy": "先执行无未完成依赖的最高优先级原子任务；真实证据阻断不能用fixture替代。",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    semantic_gate = read_json(REPORT_ROOT / "gate03-2026-08-29" / "03数据语义与信息增量-gate.json")
    semantic = semantic_gate.get("semanticAudit") if isinstance(semantic_gate.get("semanticAudit"), dict) else {}
    pit_inventory_path = REPORT_ROOT / "pit-gap-2026-08-29" / "source-inventory.json"
    pit_inventory = read_json(pit_inventory_path)
    pit_totals = pit_inventory.get("totals") if isinstance(pit_inventory.get("totals"), dict) else {}
    pit_items = pit_inventory.get("items") if isinstance(pit_inventory.get("items"), list) else []
    pit_actions = {
        str(action): sum(1 for item in pit_items if item.get("action") == action)
        for action in ("accepted-source", "adapter-repair", "evidence-review", "archive-source-needed", "shadow-only")
    }
    auto_blockers = []
    if int(semantic.get("duplicateRows") or 0):
        auto_blockers.append({"kind": "local", "id": "pit-duplicates", "count": int(semantic.get("duplicateRows") or 0), "action": "运行可回滚 PIT 去重并保留隔离清单"})
    if int(semantic.get("verifiedPitViolations") or 0):
        auto_blockers.append({"kind": "local", "id": "verified-pit-time", "count": int(semantic.get("verifiedPitViolations") or 0), "action": "隔离或修复已验证记录的时间关系"})
    total_missing_timestamps = int(semantic.get("missingRequiredTimestampRows") or 0)
    verified_missing_timestamps = int(semantic.get("verifiedMissingRequiredTimestampRows") or 0)
    if verified_missing_timestamps:
        auto_blockers.append({"kind": "data", "id": "pit-timestamps", "count": verified_missing_timestamps, "action": "补齐已验证记录的真实 first_seen_at/ingested_at；不可用推断时间冒充验证"})
    elif total_missing_timestamps:
        auto_blockers.append({"kind": "data", "id": "shadow-timestamp-backlog", "count": total_missing_timestamps, "action": "保留未验证记录在 Shadow；只有拿到真实 first_seen_at/ingested_at 才能转入正式 OOF"})
    if int(semantic.get("unverifiedRows") or 0):
        auto_blockers.append({"kind": "data", "id": "historical-availability", "count": int(semantic.get("unverifiedRows") or 0), "action": "补充可验证历史来源或留在 Shadow，禁止进入正式 OOF"})
    if pit_actions.get("adapter-repair"):
        auto_blockers.append({"kind": "code", "id": "pit-adapter-repair", "count": pit_actions["adapter-repair"], "action": "先修适配器，要求新写入记录保留真实 first_seen_at、ingested_at 和验证方法"})
    if pit_actions.get("archive-source-needed"):
        auto_blockers.append({"kind": "data", "id": "pit-archive-source", "count": pit_actions["archive-source-needed"], "action": "补充有历史发布时间/申报时间的可回放归档；没有证据的记录继续 Shadow"})
    if pit_actions.get("shadow-only"):
        auto_blockers.append({"kind": "data", "id": "pit-shadow-only", "count": pit_actions["shadow-only"], "action": "社媒和实时抓取记录只用于 Shadow，不能通过补账号直接升级为正式 OOF"})
    payload["autoAdvance"] = {
        "schema": "upgrade-auto-advance-v1",
        "mode": "ready" if semantic_gate.get("nextPhasePermitted") is True else "blocked-by-evidence",
        "modelFitStarted": bool(semantic_gate.get("modelFitStarted")),
        "nextPhasePermitted": bool(semantic_gate.get("nextPhasePermitted")),
        "nextBlockers": auto_blockers,
        "pitGapInventory": {
            "path": str(pit_inventory_path) if pit_inventory else None,
            "generatedAt": pit_inventory.get("generatedAt") if pit_inventory else None,
            "rows": int(pit_totals.get("rows") or 0),
            "verifiedRows": int(pit_totals.get("verifiedRows") or 0),
            "unverifiedRows": int(pit_totals.get("unverifiedRows") or 0),
            "sourceActions": pit_actions,
            "policy": "unverified rows remain Shadow and never enter formal OOF",
        },
        "blockerDecomposition": {
            "code": ["pit-adapter-repair"],
            "data": ["pit-timestamps", "historical-availability", "pit-archive-source", "pit-shadow-only"],
            "jobs": ["resume-only-after-gate03"],
            "externalAccount": ["user-handoff-required-for-new-account-password-verification-or-api-key"],
        },
        "localActions": [
            "读取 pit-gap source-inventory，按来源逐项修复或明确留在 Shadow",
            "优先重跑全量审计，检查新增数据是否真的改善 verified 覆盖",
            "只在新的不可变快照上构建特征和 OOF",
            "训练失败或无提升时保留旧版本并生成返工原因",
        ],
        "userHandoffOnly": [
            "创建外部账户或输入密码、验证码",
            "生成、显示或提交新的 API Key/OAuth 凭据",
            "需要付费计划、第三方同意或人工审核的外部数据授权",
        ],
        "safety": {
            "noSyntheticData": True,
            "noForcedModelFallback": True,
            "orderExecutionEnabled": False,
            "heartbeatMinutes": 30,
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    print(json.dumps({"acceptedContractOrEvidence": accepted, "blockedByRealEvidence": blocked, "notYetRegistered": todo, "completionPct": payload["completionPct"], "output": str(OUT)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
