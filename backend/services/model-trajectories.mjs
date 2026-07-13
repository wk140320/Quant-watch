import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FAMILY_DEFINITIONS = Object.freeze({
  calibration: {
    id: "calibration",
    name: "预测权重校准",
    shortName: "权重校准",
    stage: "OOF 与校准",
    description: "使用严格样本外预测学习方法权重，并与等权和动量基准对照。",
    order: 1,
  },
  factor: {
    id: "factor",
    name: "因子研究模型",
    shortName: "因子研究",
    stage: "特征与因子",
    description: "验证候选因子的样本外方向命中、IC、Rank IC 和准入结果。",
    order: 2,
  },
  alpha: {
    id: "alpha",
    name: "Alpha 进化模型",
    shortName: "Alpha 进化",
    stage: "候选生成",
    description: "在防泄漏约束下进化候选表达式，并记录适应度与样本证据。",
    order: 3,
  },
  intraday: {
    id: "intraday",
    name: "分钟学习模型",
    shortName: "分钟学习",
    stage: "分钟结构",
    description: "学习分钟级价格、成交量和微观结构，作为日内 Challenger。",
    order: 4,
  },
  adaptive: {
    id: "adaptive",
    name: "误差驱动微调",
    shortName: "动态微调",
    stage: "预测反馈",
    description: "根据已揭晓结果缩放误差惩罚，并限制单次调整幅度。",
    order: 5,
  },
  agent: {
    id: "agent",
    name: "Paper Agent 学习",
    shortName: "Agent 学习",
    stage: "纸面执行",
    description: "用纸面成交复盘策略偏置，不触发真实券商订单。",
    order: 6,
  },
});

const EVENT_FAMILY = Object.freeze({
  "model-change-log-prediction-weight-calibration": "calibration",
  "model-change-log-cross-sectional-factor-research": "factor",
  "model-change-log-factor-research": "factor",
  "model-change-log-alpha-evolution": "alpha",
  "model-change-log-minute-learning": "intraday",
  "model-change-log-adaptive-micro-tuning": "adaptive",
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values = []) {
  const numbers = values.map(finiteNumber).filter((value) => value !== null);
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function familyForRow(row = {}) {
  if (EVENT_FAMILY[row.event_type]) return EVENT_FAMILY[row.event_type];
  const type = String(row.payload?.type || "").toLowerCase();
  if (type.includes("factor")) return "factor";
  if (type.includes("alpha")) return "alpha";
  if (type.includes("minute") || type.includes("intraday")) return "intraday";
  if (type.includes("calibrat") || type.includes("weight")) return "calibration";
  if (type.includes("tuning") || type.includes("adjust")) return "adaptive";
  return "agent";
}

function horizonSummary(payload = {}) {
  const horizons = Array.isArray(payload.horizonCalibrations) ? payload.horizonCalibrations : [];
  if (!horizons.length) return null;
  const direction = average(horizons.map((row) => row?.test?.directionHitRate));
  const magnitude = average(horizons.map((row) => row?.test?.magnitudeHitRate));
  const baseline = average(horizons.map((row) => row?.baselines?.equalWeightDirectionHitRate));
  const stability = average(horizons.map((row) => row?.stability?.avgStabilityScore));
  return compactObject({ direction, magnitude, baseline, stability });
}

function agentScore(payload = {}, key = "after") {
  const strategies = Array.isArray(payload?.[key]?.bestStrategies) ? payload[key].bestStrategies : [];
  return average(strategies.map((row) => row?.score));
}

function eventMetrics(row = {}, family = familyForRow(row)) {
  const payload = row.payload || {};
  const holdout = payload.holdout || {};
  const test = payload.test || {};
  const horizons = horizonSummary(payload) || {};
  const latest = Array.isArray(payload.latestEvents) ? payload.latestEvents[0] || {} : {};
  const afterScore = agentScore(payload, "after");
  const beforeScore = agentScore(payload, "before");
  const metrics = compactObject({
    sampleCount: finiteNumber(payload.sampleCount ?? payload.sampleTotal ?? holdout.samples ?? payload.details?.sampleCount),
    symbolCount: finiteNumber(payload.symbolCount ?? payload.details?.symbols?.length),
    directionalAccuracy: finiteNumber(test.directionalAccuracy ?? test.directionHitRate ?? holdout.direction_hit_rate_pct ?? horizons.direction),
    magnitudeAccuracy: finiteNumber(test.magnitudeHitRate ?? horizons.magnitude),
    equalWeightAccuracy: finiteNumber(payload.baselines?.equalWeightDirectionHitRate ?? horizons.baseline),
    mae: finiteNumber(test.mae ?? holdout.mae),
    rmse: finiteNumber(test.rmse ?? holdout.rmse),
    brier: finiteNumber(test.brierScore ?? payload.brierScore),
    ece: finiteNumber(test.ece ?? test.expectedCalibrationError ?? payload.ece),
    ic: finiteNumber(holdout.ic ?? test.ic),
    rankIc: finiteNumber(holdout.rank_ic ?? test.rankIc),
    fitness: finiteNumber(payload.topFitness),
    adjustmentScale: finiteNumber(latest.adjustmentScale ?? payload.avgAdjustmentScale),
    forecastError: finiteNumber(latest.forecastError ?? payload.avgForecastError),
    candidateCount: finiteNumber(payload.candidateCount ?? payload.population),
    admittedCount: finiteNumber(payload.admittedCount),
    generations: finiteNumber(payload.generations),
    beforeScore,
    afterScore,
  });

  if (family === "calibration") {
    metrics.primaryMetric = {
      label: "样本外方向命中",
      value: metrics.directionalAccuracy,
      unit: "%",
    };
  } else if (family === "factor") {
    metrics.primaryMetric = metrics.directionalAccuracy !== null && metrics.directionalAccuracy !== undefined
      ? { label: "Holdout 方向命中", value: metrics.directionalAccuracy, unit: "%" }
      : { label: "因子实时得分", value: finiteNumber(payload.liveScore), unit: "" };
  } else if (family === "alpha") {
    metrics.primaryMetric = { label: "候选适应度", value: metrics.fitness, unit: "" };
  } else if (family === "intraday") {
    metrics.primaryMetric = { label: "测试方向命中", value: metrics.directionalAccuracy, unit: "%" };
  } else if (family === "adaptive") {
    metrics.primaryMetric = {
      label: "平均调整幅度",
      value: metrics.adjustmentScale === null ? null : metrics.adjustmentScale * 100,
      unit: "%",
    };
  } else {
    metrics.primaryMetric = { label: "策略综合分", value: afterScore, unit: "" };
  }
  return metrics;
}

function eventGuardrails(payload = {}) {
  const checks = Array.isArray(payload.overfitGuard?.checks)
    ? payload.overfitGuard.checks.map((row) => ({
      label: row.label || "防过拟合检查",
      pass: row.pass !== false,
      note: row.note || "",
    }))
    : [];
  const guards = Array.isArray(payload.guardrails) ? payload.guardrails : [];
  for (const guard of guards) {
    checks.push({ label: String(guard), pass: true, note: "" });
  }
  if (payload.leakageControl) {
    checks.push({ label: "未来函数隔离", pass: true, note: String(payload.leakageControl) });
  }
  return checks.slice(0, 8);
}

function eventChanges(payload = {}, family = "agent") {
  const latest = Array.isArray(payload.latestEvents) ? payload.latestEvents[0] || {} : {};
  if (Array.isArray(latest.changes) && latest.changes.length) return latest.changes.slice(0, 6).map(String);
  if (family === "factor") {
    return [
      payload.admittedCount !== undefined
        ? `${Number(payload.candidateCount || 0)} 个候选中准入 ${Number(payload.admittedCount || 0)} 个`
        : `${Number(payload.symbolCount || 0)} 只股票完成横截面权重更新`,
    ];
  }
  if (family === "alpha") {
    return [`${payload.topCandidate || "候选因子"} 在 ${Number(payload.generations || 0)} 代进化后成为当前最优`];
  }
  if (family === "calibration") {
    return [`${Number(payload.sampleTotal || 0)} 条历史预测重新完成样本外权重校准`];
  }
  if (family === "intraday") {
    return [`分钟模型使用 ${Number(payload.sampleCount || 0)} 条已完成样本更新`];
  }
  if (payload.summary) return [String(payload.summary)];
  return [];
}

function eventReasons(payload = {}) {
  const latest = Array.isArray(payload.latestEvents) ? payload.latestEvents[0] || {} : {};
  if (Array.isArray(latest.reasons) && latest.reasons.length) return latest.reasons.slice(0, 6).map(String);
  const reasons = [];
  if (payload.summary) reasons.push(String(payload.summary));
  if (payload.framework) reasons.push(`框架：${payload.framework}`);
  if (payload.leakageControl) reasons.push(String(payload.leakageControl));
  return reasons.slice(0, 6);
}

function eventImpact(family, metrics = {}) {
  if (family === "calibration" && metrics.directionalAccuracy !== null && metrics.equalWeightAccuracy !== null) {
    return metrics.directionalAccuracy >= metrics.equalWeightAccuracy ? "improved" : "degraded";
  }
  if (family === "factor" && metrics.directionalAccuracy !== null && metrics.directionalAccuracy !== undefined) {
    return metrics.directionalAccuracy >= 50 ? "improved" : "degraded";
  }
  if (family === "intraday" && metrics.directionalAccuracy !== null && metrics.directionalAccuracy !== undefined) {
    return metrics.directionalAccuracy >= 50 ? "improved" : "watch";
  }
  if (family === "agent" && metrics.beforeScore !== null && metrics.afterScore !== null) {
    return metrics.afterScore > metrics.beforeScore ? "improved" : metrics.afterScore < metrics.beforeScore ? "degraded" : "neutral";
  }
  return "neutral";
}

function normalizeModelEvent(row = {}) {
  const family = familyForRow(row);
  const payload = row.payload || {};
  const metrics = eventMetrics(row, family);
  const createdAt = row.created_at || payload.createdAt || payload.updatedAt || null;
  return {
    id: row.entity_id || payload.id || `${family}:${createdAt || "unknown"}`,
    market: row.market || payload.market || "ASX",
    family,
    stage: FAMILY_DEFINITIONS[family].stage,
    eventType: row.event_type || payload.type || "model-change-log",
    createdAt,
    title: payload.title || FAMILY_DEFINITIONS[family].name,
    summary: payload.summary || payload.reason || FAMILY_DEFINITIONS[family].description,
    entity: payload.symbol || row.entity_id || "market",
    framework: payload.framework || payload.type || "local-model",
    status: payload.status || (family === "agent" ? "paper" : "research"),
    impact: eventImpact(family, metrics),
    metrics,
    changes: eventChanges(payload, family),
    reasons: eventReasons(payload),
    guardrails: eventGuardrails(payload),
    formula: payload.scaleFormula || payload.formula || null,
    rawType: payload.type || null,
  };
}

function eventSignature(event = {}) {
  return [
    event.family,
    event.id,
    event.title,
    event.entity,
    event.metrics?.primaryMetric?.value ?? "",
  ].join("|");
}

function dedupeModelEvents(events = []) {
  const seen = new Set();
  const result = [];
  const sorted = [...events].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const event of sorted) {
    const signature = eventSignature(event);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(event);
  }
  return result;
}

function latestHorizonWeights(events = []) {
  const source = events.find((event) => event.family === "calibration");
  if (!source?._payload?.horizonCalibrations) return [];
  return source._payload.horizonCalibrations.map((row) => ({
    horizonDays: finiteNumber(row.horizonDays),
    label: row.horizonLabel || `${row.horizonDays || "--"} 日`,
    status: row.active ? "active" : row.status || "research_only",
    sampleCount: finiteNumber(row.sampleCount),
    directionHitRate: finiteNumber(row.test?.directionHitRate),
    equalWeightDirectionHitRate: finiteNumber(row.baselines?.equalWeightDirectionHitRate),
    weights: Object.entries(row.optimizedWeights || {})
      .map(([name, value]) => ({ name, value: finiteNumber(value) }))
      .filter((entry) => entry.value !== null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
  }));
}

function modelStatus(family, latest = null, intradaySnapshot = null) {
  if (family === "intraday") {
    return intradaySnapshot?.available
      ? { code: "ready", label: "已就绪", tone: "good" }
      : { code: "collecting", label: "采样中", tone: "warn" };
  }
  if (family === "adaptive") return { code: "guarded", label: "护栏微调", tone: "gold" };
  if (family === "agent") return { code: "paper", label: "Paper", tone: "blue" };
  if (latest?.status === "active") return { code: "active", label: "已激活", tone: "good" };
  return { code: "research", label: "研究中", tone: "muted" };
}

function buildModelFamily(family, events = [], intradaySnapshot = null) {
  const definition = FAMILY_DEFINITIONS[family];
  const ordered = [...events].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const latest = ordered.at(-1) || null;
  const primaryPoints = ordered
    .map((event) => ({
      at: event.createdAt,
      value: finiteNumber(event.metrics?.primaryMetric?.value),
      label: event.metrics?.primaryMetric?.label || "评估指标",
      unit: event.metrics?.primaryMetric?.unit || "",
      impact: event.impact,
      eventId: event.id,
    }))
    .filter((point) => point.at && point.value !== null)
    .slice(-48);
  const status = modelStatus(family, latest, intradaySnapshot);
  return {
    ...definition,
    status,
    updatedAt: latest?.createdAt || intradaySnapshot?.updatedAt || null,
    eventCount: events.length,
    latest,
    primaryMetric: latest?.metrics?.primaryMetric || null,
    sampleCount: latest?.metrics?.sampleCount ?? intradaySnapshot?.sampleCount ?? 0,
    trajectory: primaryPoints,
    events: [...events].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 80),
  };
}

function pipelineStages({ families = [], calibration = null, predictionWeights = null } = {}) {
  const byId = new Map(families.map((family) => [family.id, family]));
  const noTradeGate = calibration?.noTradeGate || null;
  const rows = [
    ["data", "Point-in-time 数据", "行情、财报与事件按当时可见时间进入样本", Boolean(predictionWeights?.dataQuality || predictionWeights?.sampleTotal)],
    ["feature", "特征与因子", "候选因子经过缺失值、极端值、标准化与未来函数检查", Boolean(byId.get("factor")?.eventCount)],
    ["base", "基础模型", "树模型、线性基线与分钟 Challenger 生成独立预测", Boolean(byId.get("intraday")?.eventCount || calibration?.localSignalModels)],
    ["oof", "样本外预测", "只保存 Purged Walk-forward 的 OOF 结果供后续学习", Boolean(byId.get("calibration")?.eventCount)],
    ["stack", "受约束集成", "同源模型限制总权重，研究模型不足时向先验收缩", Boolean(predictionWeights?.predictionCalibration || predictionWeights?.horizonCalibrations?.length)],
    ["calibrate", "概率校准", "按市场与周期校准概率，跟踪 Brier 与可靠性", Boolean(calibration?.calibrationDiagnostics || calibration?.brierScore !== null)],
    ["gate", "拒绝交易闸门", "数据过期、漂移或概率证据不足时保持现金", Boolean(noTradeGate)],
  ];
  return rows.map(([id, name, detail, available], index) => ({
    id,
    name,
    detail,
    available,
    state: available ? "ready" : "pending",
    order: index + 1,
  }));
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJsonLines(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function buildModelTrajectoryPayload({
  market = "ASX",
  records = [],
  calibration = null,
  predictionWeights = null,
  intradaySnapshot = null,
  limit = 180,
} = {}) {
  const normalized = records.map((row) => {
    const event = normalizeModelEvent(row);
    Object.defineProperty(event, "_payload", { value: row.payload || {}, enumerable: false });
    return event;
  });
  const allEvents = dedupeModelEvents(normalized);
  const timelineLimit = clamp(Number(limit) || 180, 30, 500);
  const grouped = Object.fromEntries(Object.keys(FAMILY_DEFINITIONS).map((family) => [family, []]));
  for (const event of allEvents) grouped[event.family].push(event);
  const families = Object.keys(FAMILY_DEFINITIONS)
    .map((family) => buildModelFamily(family, grouped[family], family === "intraday" ? intradaySnapshot : null))
    .filter((family) => family.eventCount || (family.id === "intraday" && intradaySnapshot))
    .sort((a, b) => a.order - b.order);
  const lastChangeAt = allEvents[0]?.createdAt || calibration?.savedAt || predictionWeights?.savedAt || intradaySnapshot?.updatedAt || null;
  const guardedEvents = allEvents.filter((event) => event.guardrails.length);
  const latestTime = Date.now();
  const changes24h = allEvents.filter((event) => {
    const time = Date.parse(event.createdAt || "");
    return Number.isFinite(time) && latestTime - time <= 24 * 60 * 60 * 1000;
  }).length;

  const horizonWeights = latestHorizonWeights(normalized);
  return {
    ok: true,
    market,
    generatedAt: new Date().toISOString(),
    summary: {
      modelCount: families.length,
      rawEventCount: records.length,
      eventCount: allEvents.length,
      changes24h,
      lastChangeAt,
      guardrailCoveragePct: allEvents.length ? Math.round(guardedEvents.length / allEvents.length * 100) : 0,
      predictionSamples: finiteNumber(predictionWeights?.sampleTotal ?? calibration?.total) || 0,
      resolvedPredictions: finiteNumber(calibration?.resolved) || 0,
      hitRate: finiteNumber(calibration?.hitRate),
      brierScore: finiteNumber(calibration?.brierScore),
    },
    calibration: calibration ? {
      savedAt: calibration.savedAt || null,
      total: finiteNumber(calibration.total) || 0,
      resolved: finiteNumber(calibration.resolved) || 0,
      pending: finiteNumber(calibration.pending) || 0,
      hitRate: finiteNumber(calibration.hitRate),
      strategyHitRate: finiteNumber(calibration.strategyHitRate),
      magnitudeHitRate: finiteNumber(calibration.magnitudeHitRate),
      brierScore: finiteNumber(calibration.brierScore),
      noTradeGate: calibration.noTradeGate || null,
    } : null,
    families,
    timeline: allEvents.slice(0, timelineLimit),
    horizonWeights,
    pipeline: pipelineStages({ families, calibration, predictionWeights }),
  };
}

async function loadModelTrajectories({ snapshotBasePath, market = "ASX", limit = 180 } = {}) {
  if (!snapshotBasePath) throw new Error("snapshotBasePath is required");
  const key = String(market || "ASX").toUpperCase();
  const slug = key.toLowerCase();
  const [records, calibration, predictionWeights, intradaySnapshot] = await Promise.all([
    readJsonLines(join(snapshotBasePath, "records", `model-change-log-${slug}.jsonl`)),
    readJson(join(snapshotBasePath, `model-calibration-${slug}.json`)),
    readJson(join(snapshotBasePath, "models", `prediction-weight-calibration-${slug}.json`)),
    readJson(join(snapshotBasePath, "backend-monitor", `intraday-model-${slug}.json`)),
  ]);
  return buildModelTrajectoryPayload({
    market: key,
    records,
    calibration,
    predictionWeights,
    intradaySnapshot,
    limit,
  });
}

export {
  FAMILY_DEFINITIONS,
  buildModelTrajectoryPayload,
  dedupeModelEvents,
  loadModelTrajectories,
  normalizeModelEvent,
};
