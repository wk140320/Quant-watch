#!/usr/bin/env python3
"""Expand blocked upgrade tasks into auditable, executable microtasks.

This is a planning/evidence index, not a bypass for real-data gates.  It keeps
contract work, source-dependent work, and future-observation work separate so
the UI can explain what the local worker can do immediately.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PROGRESS = ROOT / "reports" / "upgrade-progress-2026-08-29.json"
OUT_JSON = ROOT / "reports" / "microtask-plan-2026-08-29.json"
OUT_MD = ROOT / "reports" / "microtask-plan-2026-08-29.md"


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _kind_for_stage(stage: str, action: str, original_id: str) -> str:
    text = f"{stage} {action}"
    if original_id in {"G0289", "G0293", "G0297"} or "60交易日" in text or "300个可执行信号" in text:
        return "WAITING_FUTURE"
    if any(token in text for token in ("历史成分", "公司行为", "财务", "公告", "PIT", "行业", "证券类型", "数据湖", "数据语义", "宏观")):
        return "SOURCE_OR_LOCAL_DATA"
    if any(token in text for token in ("实验", "OOF", "回测", "Top10", "锁箱", "校准", "因子", "模型")):
        return "AUTOMATIC_AFTER_PREREQUISITES"
    return "AUTOMATIC"


def _steps(task: dict[str, Any]) -> list[dict[str, str]]:
    task_id = str(task.get("id"))
    plan = task.get("plan") or {}
    stage = str(plan.get("stage") or "")
    action = str(plan.get("atomicAction") or "")
    kind = _kind_for_stage(stage, action, task_id)
    if stage == "03数据语义与信息增量":
        return [
            ("scope", "锁定市场、数据集、时间范围和当前数据版本", "AUTOMATIC", "数据范围快照"),
            ("normalize", "统一字段、四类时间、市场身份和来源标志", "AUTOMATIC", "规范化分区"),
            ("ingest", "使用已配置合法来源做增量写入；缺源则登记缺口", kind, "来源写入收据"),
            ("audit", "执行全量或分区审计，记录接受、重复、隔离和未来时间记录", "AUTOMATIC_AFTER_PREREQUISITES", "数据审计 JSON"),
            ("accept", "按原任务验收尺度生成 ACCEPTED 或 BLOCKED，不改变原始数据", "AUTOMATIC", str(plan.get("evidenceArtifact") or "阶段证据")),
        ]
    if stage == "04因子原子化与去冗余":
        return [
            ("card", "冻结公式、经济假设、延迟、缺失和失效条件", "AUTOMATIC", "FactorCard"),
            ("compute", "只用信号日前可见数据计算因子，保留缺失标志", "AUTOMATIC_AFTER_PREREQUISITES", "因子列与覆盖报告"),
            ("oos", "按日期分组执行 Purged OOF，计算 RankIC、Top-K 和成本后收益", "AUTOMATIC_AFTER_PREREQUISITES", "因子 OOF 证据"),
            ("controls", "执行相关、VIF、PSI、FDR、Deflated Sharpe、PBO 和符号稳定检查", "AUTOMATIC_AFTER_PREREQUISITES", "去冗余图与多重检验报告"),
            ("decision", "通过条件增量才入池，否则保留 watchlist 或 EMPTY_FACTOR_POOL", "AUTOMATIC", str(plan.get("evidenceArtifact") or "因子决策")),
        ]
    if stage == "05任务化模型与结构":
        return [
            ("readiness", "检查完整面板、类别支持、训练阻断和 ComparisonKey", "AUTOMATIC", "模型就绪审计"),
            ("fit", "按模型族和折训练，逐折保存实际拟合行与检查点", "AUTOMATIC_AFTER_PREREQUISITES", "折级模型产物"),
            ("oof", "只保存严格样本外预测，并按家族与 null 基线比较", "AUTOMATIC_AFTER_PREREQUISITES", "OOF 预测表"),
            ("select", "复杂模型只有在外层增益和稳定性通过时才保留", "AUTOMATIC", "家族选择证据"),
            ("publish", "每个家族最多发布一个候选；无证据则发布 NO_MODEL", "AUTOMATIC", str(plan.get("evidenceArtifact") or "模型候选清单")),
        ]
    if stage == "06校准、置信与拒绝交易":
        return [
            ("split", "冻结 fit、calibration、selection、lockbox 四段时间窗", "AUTOMATIC", "校准时间分割"),
            ("fit", "只在 calibration 窗拟合 Platt、Isotonic 或 Temperature", "AUTOMATIC_AFTER_PREREQUISITES", "校准器"),
            ("diagnose", "计算 Brier、Brier Skill、ECE、斜率、分辨率和概率桶支持", "AUTOMATIC", "校准诊断"),
            ("abstain", "用选择窗确定 No-Trade，不足证据时拒绝交易", "AUTOMATIC", "拒绝交易策略"),
            ("accept", "校准和分辨率同时通过才允许进入交易集成", "AUTOMATIC", str(plan.get("evidenceArtifact") or "校准阶段门")),
        ]
    if stage == "08三市场单变量突破实验":
        return [
            ("register", "登记唯一 changedHypothesis、标签、成本和比较键", "AUTOMATIC", "实验注册"),
            ("lock", "锁定共同面板、外层时间窗和最终锁箱，禁止提前读取", "AUTOMATIC_AFTER_PREREQUISITES", "实验锁箱"),
            ("run", "运行对应市场的单变量 OOF 实验，不用内层成绩替代外层", "AUTOMATIC_AFTER_PREREQUISITES", "实验 OOF"),
            ("measure", "计算聚合、折级、Top10、Brier、EV、漂移和区间指标", "AUTOMATIC", "实验指标"),
            ("decide", "只允许 ADMITTED 或 REJECTED；失败假设保留在账本", "AUTOMATIC", str(plan.get("evidenceArtifact") or "实验裁决")),
        ]
    if stage == "10离线晋级与前向验收":
        return [
            ("offline", "检查离线门、唯一 lockbox、数据/特征/成本哈希和可执行信号", "AUTOMATIC_AFTER_PREREQUISITES", "离线候选证据"),
            ("shadow", "仅部署到只读 Shadow/Paper 环境，真实订单数必须为零", "AUTOMATIC", "Shadow 部署收据"),
            ("observe", "按真实完成交易日记录信号、执行价格、成本、拒绝和结果", "WAITING_FUTURE" if kind == "WAITING_FUTURE" else "AUTOMATIC", "前向 Paper 轨迹"),
            ("monitor", "滚动计算命中、BSS、ECE、净 EV、回撤、容量和漂移", "AUTOMATIC", "前向监控"),
            ("promote", "离线与前向同时通过才可成为 Champion，否则维持 Shadow/Research", "AUTOMATIC", str(plan.get("evidenceArtifact") or "晋级裁决")),
        ]
    return [
        ("prepare", "读取依赖和最新证据版本", "AUTOMATIC", "任务准备收据"),
        ("execute", action, kind, str(plan.get("evidenceArtifact") or "任务产物")),
        ("audit", "记录成功、失败、阻断原因和下一动作", "AUTOMATIC", "不可变任务日志"),
    ]


def main() -> int:
    progress = read_json(PROGRESS)
    blocked = [task for task in progress.get("tasks") or [] if task.get("status") == "BLOCKED"]
    groups = []
    microtasks = []
    for task in blocked:
        task_id = str(task.get("id"))
        plan = task.get("plan") or {}
        dependencies = list(plan.get("dependencies") or [])
        root_reason = str(task.get("reason") or "真实证据未满足")
        group_steps = []
        for index, (suffix, action, owner, artifact) in enumerate(_steps(task), start=1):
            micro_id = f"{task_id}.{index:02d}"
            status = "BLOCKED"
            if suffix in {"card", "split", "prepare", "register", "scope", "readiness"} and task.get("contractFixturePassed"):
                status = "CONTRACT_READY"
            if suffix == "observe" and owner == "WAITING_FUTURE":
                status = "WAITING_FUTURE"
            item = {
                "id": micro_id,
                "parentTask": task_id,
                "sequence": index,
                "action": action,
                "owner": owner,
                "status": status,
                "dependencies": dependencies + ([f"{task_id}.{index - 1:02d}"] if index > 1 else []),
                "evidenceArtifact": artifact,
                "acceptance": str(plan.get("acceptance") or "见原子任务验收尺度"),
                "blockReason": root_reason if status in {"BLOCKED", "WAITING_FUTURE"} else None,
                "userAction": "仅在合法来源需要登录、密钥或验证码时由用户完成；不通过重复注册绕过额度。" if owner == "SOURCE_OR_LOCAL_DATA" else None,
            }
            group_steps.append(item)
            microtasks.append(item)
        groups.append({
            "taskId": task_id,
            "stage": plan.get("stage"),
            "market": plan.get("market"),
            "priority": plan.get("priority"),
            "rootReason": root_reason,
            "dependencies": dependencies,
            "atomicAction": plan.get("atomicAction"),
            "evidenceArtifact": plan.get("evidenceArtifact"),
            "microtasks": group_steps,
        })
    counts = {}
    for item in microtasks:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    payload = {
        "schema": "atomic-microtask-plan-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceProgress": str(PROGRESS),
        "policy": {
            "automatic": "本地代码、数据湖、审计、训练、报告和确定性门禁由后台自动执行。",
            "manual": "仅在合法数据源要求账号、密钥、验证码或条款确认时需要用户操作。",
            "future": "60/120 个交易日的 Shadow/Paper 证据只能随真实市场时间积累，不能被脚本生成。",
            "safety": "继续保持 Paper-only 和 No-Trade；被阻断任务不能通过样例数据晋级。",
        },
        "summary": {
            "blockedParentTasks": len(blocked),
            "microtaskCount": len(microtasks),
            "statusCounts": counts,
            "nextRunnableParents": [
                task["taskId"] for task in groups
                if not any(dependency and dependency not in {row.get("id") for row in progress.get("tasks") or [] if row.get("status") == "ACCEPTED"} for dependency in task["dependencies"])
            ][:24],
        },
        "groups": groups,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    lines = [
        "# 阻断任务微任务计划（2026-08-29）",
        "",
        f"当前包含 {len(blocked)} 个阻断原任务，拆分为 {len(microtasks)} 个微任务。该文件是执行索引，不会把样例证据当成真实市场通过。",
        "",
        "## 执行边界",
        "- 本地代码、数据湖、审计、训练、报告和确定性门禁：后台自动执行。",
        "- 合法数据源登录、API 密钥、验证码或条款确认：只有确实需要时由用户完成。",
        "- Shadow/Paper 的真实交易日积累：自动记录，但必须等待市场时间，不能生成。",
        "",
        "## 微任务状态",
    ]
    for status, count in sorted(counts.items()):
        lines.append(f"- {status}: {count}")
    lines.extend(["", "## 阶段分布"])
    stage_counts: dict[str, int] = {}
    for group in groups:
        stage_counts[str(group.get("stage") or "unknown")] = stage_counts.get(str(group.get("stage") or "unknown"), 0) + len(group["microtasks"])
    for stage, count in stage_counts.items():
        lines.append(f"- {stage}: {count}")
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"blockedParentTasks": len(blocked), "microtaskCount": len(microtasks), "statusCounts": counts, "json": str(OUT_JSON), "markdown": str(OUT_MD)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
