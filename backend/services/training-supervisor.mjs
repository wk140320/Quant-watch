import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const DEFAULT_MARKETS = ["ASX", "US", "CN"];
const DEFAULT_REVIEWERS = ["openai", "siliconflow", "hunyuan"];
const DEFAULT_THRESHOLDS = Object.freeze({
  minRows: 50_000,
  minSymbols: 100,
  minHorizonModels: 3,
  minOofRows: 1_000,
  minMetaTestRows: 1_000,
  minIndependentTestDates: 120,
  minTargetEvents: 500,
  minStopEvents: 500,
  minFolds: 5,
  minPositiveFolds: 4,
  minBrierSkill: 0,
  maxEcePct: 5,
  minCalibrationSlope: 0.8,
  maxCalibrationSlope: 1.2,
  minProbabilityBucketEvents: 30,
  minTopDecileLift: 0,
  minExpectedValuePct: 0,
});

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, number(value, minimum)));
}

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function compactError(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 500);
}

function compactOperatorNote(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function trainingResult(result = {}) {
  return result?.productionTraining || result?.result?.productionTraining || null;
}

function addCheck(checks, id, label, passed, detail, options = {}) {
  checks.push({
    id,
    label,
    passed: Boolean(passed),
    blocking: options.blocking !== false,
    value: options.value ?? null,
    threshold: options.threshold ?? null,
    detail: String(detail || ""),
  });
}

function evaluateTrainingResult(result = {}, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || options) };
  const training = trainingResult(result);
  const dataset = training?.dataset || {};
  const models = Array.isArray(training?.horizonModels) ? training.horizonModels : [];
  const availableModels = models.filter((model) => model?.available);
  const checks = [];

  addCheck(checks, "training_output", "训练产物完整", Boolean(training?.available && training?.manifest?.model_version), training ? "已生成版本化训练产物。" : "没有返回 productionTraining。", { value: training?.manifest?.model_version || null });
  addCheck(checks, "dataset_rows", "市场级样本量", number(dataset.rawRows) >= thresholds.minRows, `原始训练行 ${number(dataset.rawRows)}，要求不少于 ${thresholds.minRows}。`, { value: number(dataset.rawRows), threshold: thresholds.minRows });
  addCheck(checks, "symbol_breadth", "股票横截面宽度", number(dataset.symbolCount) >= thresholds.minSymbols, `覆盖 ${number(dataset.symbolCount)} 只股票，要求不少于 ${thresholds.minSymbols}。`, { value: number(dataset.symbolCount), threshold: thresholds.minSymbols });
  addCheck(checks, "point_in_time", "Point-in-time 无泄漏", number(dataset.pointInTimeJoinViolationCount) === 0, `未来时点连接违规 ${number(dataset.pointInTimeJoinViolationCount)} 条。`, { value: number(dataset.pointInTimeJoinViolationCount), threshold: 0 });
  addCheck(
    checks,
    "sample_isolation",
    "跨市场与重复样本隔离",
    number(dataset.crossMarketRowsExcluded) === 0 && number(dataset.duplicateRowsExcluded) === 0,
    `跨市场隔离 ${number(dataset.crossMarketRowsExcluded)} 条；重复隔离 ${number(dataset.duplicateRowsExcluded)} 条。出现污染即阻断本轮晋升。`,
    { value: number(dataset.crossMarketRowsExcluded) + number(dataset.duplicateRowsExcluded), threshold: 0 },
  );
  addCheck(checks, "horizon_models", "短中长期模型可用", availableModels.length >= thresholds.minHorizonModels, `可用周期模型 ${availableModels.length}/${models.length || 0}，要求至少 ${thresholds.minHorizonModels} 个。`, { value: availableModels.length, threshold: thresholds.minHorizonModels });

  if (availableModels.length) {
    const oofPassed = availableModels.every((model) => number(model.oofRows) >= thresholds.minOofRows && number(model.metaTestRows) >= thresholds.minMetaTestRows);
    addCheck(checks, "oof_depth", "严格样本外深度", oofPassed, availableModels.map((model) => `${model.horizon}d OOF ${number(model.oofRows)} / 独立测试 ${number(model.metaTestRows)}`).join("；"), { threshold: `${thresholds.minOofRows}/${thresholds.minMetaTestRows}` });

    const eventPassed = availableModels.every((model) => number(model.eventCounts?.target) >= thresholds.minTargetEvents && number(model.eventCounts?.stop) >= thresholds.minStopEvents);
    addCheck(checks, "event_support", "目标/止损事件支持", eventPassed, availableModels.map((model) => `${model.horizon}d 目标 ${number(model.eventCounts?.target)} / 止损 ${number(model.eventCounts?.stop)}`).join("；"), { threshold: `${thresholds.minTargetEvents}/${thresholds.minStopEvents}` });

    const datePassed = availableModels.every((model) => number(model.metrics?.testDates) >= thresholds.minIndependentTestDates);
    addCheck(checks, "independent_dates", "独立测试日期", datePassed, availableModels.map((model) => `${model.horizon}d ${number(model.metrics?.testDates)} 日`).join("；"), { threshold: thresholds.minIndependentTestDates });

    const foldsPassed = availableModels.every((model) => (model.foldMetrics || []).length >= thresholds.minFolds && number(model.positiveFoldCount) >= thresholds.minPositiveFolds);
    addCheck(checks, "rolling_folds", "滚动窗口稳定性", foldsPassed, availableModels.map((model) => `${model.horizon}d ${(model.foldMetrics || []).length} 折 / 正向 ${number(model.positiveFoldCount)}`).join("；"), { threshold: `${thresholds.minFolds}/${thresholds.minPositiveFolds}` });

    const brierPassed = availableModels.every((model) => number(model.metrics?.brierSkillScore, -1) > thresholds.minBrierSkill);
    addCheck(checks, "brier_skill", "Brier Skill 为正", brierPassed, availableModels.map((model) => `${model.horizon}d ${number(model.metrics?.brierSkillScore, -1).toFixed(4)}`).join("；"), { threshold: `>${thresholds.minBrierSkill}` });

    const ecePassed = availableModels.every((model) => number(model.metrics?.ecePct, 100) <= thresholds.maxEcePct);
    addCheck(checks, "calibration_ece", "概率校准 ECE", ecePassed, availableModels.map((model) => `${model.horizon}d ${number(model.metrics?.ecePct, 100).toFixed(2)}%`).join("；"), { threshold: `<=${thresholds.maxEcePct}%` });

    const slopePassed = availableModels.every((model) => thresholds.minCalibrationSlope <= number(model.metrics?.calibrationSlope, -1) && number(model.metrics?.calibrationSlope, -1) <= thresholds.maxCalibrationSlope);
    addCheck(checks, "calibration_slope", "概率校准斜率", slopePassed, availableModels.map((model) => `${model.horizon}d ${number(model.metrics?.calibrationSlope, -1).toFixed(3)}`).join("；"), { threshold: `${thresholds.minCalibrationSlope}-${thresholds.maxCalibrationSlope}` });

    const bucketPassed = availableModels.every((model) => number(model.metrics?.probabilityBucketMinCount) >= thresholds.minProbabilityBucketEvents);
    addCheck(checks, "probability_bucket_support", "概率桶独立事件", bucketPassed, availableModels.map((model) => `${model.horizon}d 最小桶 ${number(model.metrics?.probabilityBucketMinCount)}`).join("；"), { threshold: thresholds.minProbabilityBucketEvents });

    const topKPassed = availableModels.every((model) => number(model.rankingMetrics?.topDecileLift) > thresholds.minTopDecileLift);
    addCheck(checks, "top_k_lift", "Top-K 超额收益", topKPassed, availableModels.map((model) => `${model.horizon}d ${number(model.rankingMetrics?.topDecileLift).toFixed(4)}`).join("；"), { threshold: `>${thresholds.minTopDecileLift}` });

    const evPassed = availableModels.every((model) => number(model.expectedValue?.expectedValuePct) > thresholds.minExpectedValuePct);
    addCheck(checks, "expected_value", "成本后期望值", evPassed, availableModels.map((model) => `${model.horizon}d ${number(model.expectedValue?.expectedValuePct).toFixed(4)}%`).join("；"), { threshold: `>${thresholds.minExpectedValuePct}%` });

    const driftPassed = availableModels.every((model) => (model.foldMetrics || []).every((fold) => number(fold.featureDrift?.maxPsi, 0) <= 0.40));
    addCheck(checks, "feature_drift", "特征漂移", driftPassed, "所有滚动窗口最大 PSI 必须不高于 0.40。", { threshold: "<=0.40" });

    const leakagePassed = availableModels.every((model) => {
      const control = model.leakageControl || {};
      const entry = String(control.entry || "").toLowerCase();
      const nextSessionEntry = /next[-_ ]?(session|day)|t\s*\+\s*1|次日/.test(entry);
      return nextSessionEntry
        && number(control.purge, 0) >= number(model.horizon, 0)
        && number(control.embargo, 0) > 0;
    });
    addCheck(checks, "leakage_controls", "Purge/Embargo/次日入场", leakagePassed, "每个周期都必须保留不短于预测周期的 purge、正数 embargo，并明确使用 next-session/T+1 VWAP/open 入场。", { threshold: "all horizons" });
  }

  const monitoringHealthy = training?.monitoringStatus?.status !== "degraded";
  addCheck(checks, "monitoring_status", "自动降级检查", monitoringHealthy, (training?.monitoringStatus?.reasons || []).join("；") || "没有触发自动降级。", { value: training?.monitoringStatus?.status || "missing" });
  addCheck(checks, "production_data", "生产级数据完整度", training?.productionEligibility?.dataReady === true, training?.productionEligibility?.reason || "生产数据门槛尚未全部满足。", { blocking: false, value: Boolean(training?.productionEligibility?.dataReady) });

  const blocking = checks.filter((check) => check.blocking);
  const failed = blocking.filter((check) => !check.passed);
  const passedCount = blocking.length - failed.length;
  const score = blocking.length ? Math.round(passedCount / blocking.length * 100) : 0;
  const productionEligible = training?.productionEligibility?.eligible === true;
  return {
    passed: blocking.length > 0 && failed.length === 0,
    score,
    acceptanceLevel: productionEligible ? "production_evidence" : "shadow_research",
    modelVersion: training?.manifest?.model_version || null,
    deploymentStatus: training?.manifest?.deployment_status || "research",
    productionEligible,
    checks,
    failedChecks: failed.map((check) => check.id),
    summary: {
      rawRows: number(dataset.rawRows),
      symbolCount: number(dataset.symbolCount),
      pointInTimeCoveragePct: number(dataset.pointInTimeCoveragePct),
      pointInTimeJoinViolationCount: number(dataset.pointInTimeJoinViolationCount),
      horizons: availableModels.map((model) => ({
        horizon: model.horizon,
        oofRows: number(model.oofRows),
        metaTestRows: number(model.metaTestRows),
        brierSkillScore: number(model.metrics?.brierSkillScore, -1),
        ecePct: number(model.metrics?.ecePct, 100),
        topDecileLift: number(model.rankingMetrics?.topDecileLift),
        expectedValuePct: number(model.expectedValue?.expectedValuePct),
        maxPsi: Math.max(0, ...(model.foldMetrics || []).map((fold) => number(fold.featureDrift?.maxPsi))),
      })),
    },
  };
}

function normalizeReviewer(review = {}, fallback = {}) {
  const verdict = ["accept", "rework", "needs_data"].includes(String(review.verdict || "").toLowerCase())
    ? String(review.verdict).toLowerCase()
    : "rework";
  return {
    provider: String(review.provider || fallback.provider || "unknown"),
    label: String(review.label || fallback.label || review.provider || "AI reviewer"),
    model: String(review.model || fallback.model || ""),
    available: review.available !== false,
    disabled: review.disabled === true,
    verdict,
    score: clamp(review.score, 0, 100),
    rationale: String(review.rationale || review.summary || "没有返回审核说明。").slice(0, 800),
    blockingIssues: Array.isArray(review.blockingIssues) ? review.blockingIssues.map((item) => String(item).slice(0, 240)).slice(0, 8) : [],
    recommendedActions: Array.isArray(review.recommendedActions) ? review.recommendedActions.map((item) => String(item).toLowerCase()).slice(0, 8) : [],
    error: review.error ? compactError(review.error) : null,
    reviewedAt: review.reviewedAt || iso(),
  };
}

function reviewerConsensus(reviews = [], minimumApprovals = 2) {
  const available = reviews.filter((review) => review.available !== false && !review.error);
  const accepts = available.filter((review) => review.verdict === "accept").length;
  const reworks = available.filter((review) => review.verdict === "rework").length;
  const needsData = available.filter((review) => review.verdict === "needs_data").length;
  return {
    accepted: accepts >= minimumApprovals && accepts > reworks,
    minimumApprovals,
    configured: reviews.length,
    available: available.length,
    accepts,
    reworks,
    needsData,
    score: available.length ? Math.round(available.reduce((sum, review) => sum + review.score, 0) / available.length) : 0,
  };
}

function yearsFromRange(range) {
  const match = String(range || "").match(/^(\d+)y$/i);
  return match ? Math.max(1, Number(match[1])) : 5;
}

function adaptTrainingPlan(previous = {}, evaluation = {}, reviews = [], options = {}) {
  const failed = new Set(evaluation.failedChecks || []);
  const actions = new Set(reviews.flatMap((review) => review.recommendedActions || []));
  const maxSymbols = Math.max(20, number(options.maxSymbols, 500));
  const next = {
    ...previous,
    revision: number(previous.revision) + 1,
    reason: "supervisor-rework",
  };
  if (failed.has("dataset_rows") || failed.has("symbol_breadth") || failed.has("horizon_models") || actions.has("expand_universe")) {
    next.limit = Math.min(maxSymbols, Math.max(number(previous.limit, 40) + 20, Math.ceil(number(previous.limit, 40) * 1.35)));
  }
  if (failed.has("dataset_rows") || failed.has("oof_depth") || failed.has("event_support") || actions.has("extend_history")) {
    next.range = `${Math.min(20, yearsFromRange(previous.range) + 2)}y`;
  }
  if (failed.has("brier_skill") || failed.has("calibration_ece") || failed.has("top_k_lift") || failed.has("expected_value") || actions.has("tighten_weight_cap")) {
    next.maxModelWeight = Number(Math.max(0.20, number(previous.maxModelWeight, 0.35) - 0.03).toFixed(2));
    next.maxResidualCorrelation = Number(Math.max(0.60, number(previous.maxResidualCorrelation, 0.80) - 0.05).toFixed(2));
    next.foldCount = Math.min(8, Math.max(5, number(previous.foldCount, 5) + 1));
  }
  if (failed.has("feature_drift") || actions.has("prune_correlated_models")) {
    next.maxResidualCorrelation = Number(Math.max(0.60, number(previous.maxResidualCorrelation, 0.80) - 0.08).toFixed(2));
    next.maxModelWeight = Number(Math.max(0.20, number(previous.maxModelWeight, 0.35) - 0.04).toFixed(2));
  }
  if (actions.has("increase_fold_count")) next.foldCount = Math.min(8, Math.max(5, number(previous.foldCount, 5) + 1));
  next.testDates = Math.max(120, number(previous.testDates, 120));
  next.minTrainDates = Math.max(500, number(previous.minTrainDates, 500));
  next.embargoDays = Math.max(7, number(previous.embargoDays, 7));
  return next;
}

function createTrainingSupervisor(options = {}) {
  if (!options.basePath) throw new Error("Training supervisor requires a persistence directory.");
  if (typeof options.createTrainingJob !== "function" || typeof options.getJob !== "function") {
    throw new Error("Training supervisor requires createTrainingJob and getJob callbacks.");
  }
  const markets = Array.isArray(options.markets) && options.markets.length ? options.markets : DEFAULT_MARKETS;
  const reviewerIds = Array.isArray(options.reviewerIds) && options.reviewerIds.length ? options.reviewerIds : DEFAULT_REVIEWERS;
  const config = {
    enabled: options.config?.enabled !== false,
    maxAttempts: Math.max(1, Math.min(8, number(options.config?.maxAttempts, 3))),
    cadenceMs: Math.max(60_000, number(options.config?.cadenceMs, 24 * 60 * 60_000)),
    retryDelayMs: Math.max(1_000, number(options.config?.retryDelayMs, 60_000)),
    attentionRetryMs: Math.max(60_000, number(options.config?.attentionRetryMs, 6 * 60 * 60_000)),
    startupDelayMs: Math.max(0, number(options.config?.startupDelayMs, 120_000)),
    maxJobAgeMs: Math.max(60_000, number(options.config?.maxJobAgeMs, 30 * 60_000)),
    minAiApprovals: Math.max(1, Math.min(3, number(options.config?.minAiApprovals, 2))),
    baseSymbolLimit: Math.max(10, number(options.config?.baseSymbolLimit, 100)),
    maxSymbols: Math.max(20, number(options.config?.maxSymbols, 500)),
    ranges: { ASX: "10y", US: "10y", CN: "8y", ...(options.config?.ranges || {}) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(options.config?.thresholds || {}) },
  };
  const statePath = join(options.basePath, "state.json");
  const auditPath = join(options.basePath, "events.jsonl");
  let loaded = null;
  let serialized = Promise.resolve();

  function marketDefault(market, index = 0) {
    return {
      market,
      enabled: true,
      status: "idle",
      cycleId: null,
      attempt: 0,
      maxAttempts: config.maxAttempts,
      activeJobId: null,
      currentPlan: null,
      evaluation: null,
      reviewers: [],
      consensus: null,
      lastError: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastAcceptedAt: null,
      nextActionAt: null,
      nextCycleAt: iso(Date.now() + config.startupDelayMs + index * 60_000),
      history: [],
    };
  }

  async function readState() {
    if (loaded) return loaded;
    try {
      loaded = JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      loaded = { version: 1, enabled: config.enabled, updatedAt: iso(), markets: {}, reviewersEnabled: {} };
    }
    loaded.markets ||= {};
    loaded.reviewersEnabled = Object.fromEntries(reviewerIds.map((reviewer) => [reviewer, loaded.reviewersEnabled?.[reviewer] !== false]));
    markets.forEach((market, index) => {
      loaded.markets[market] = { ...marketDefault(market, index), ...(loaded.markets[market] || {}), market };
    });
    if (loaded.enabled == null) loaded.enabled = config.enabled;
    return loaded;
  }

  async function saveState() {
    const state = await readState();
    state.updatedAt = iso();
    await mkdir(options.basePath, { recursive: true });
    const temporary = `${statePath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, statePath);
    return state;
  }

  async function record(marketState, type, payload = {}) {
    const event = {
      id: randomUUID(),
      type,
      market: marketState.market,
      cycleId: marketState.cycleId,
      attempt: marketState.attempt,
      createdAt: iso(),
      ...payload,
    };
    marketState.history = [event, ...(marketState.history || [])].slice(0, 100);
    await mkdir(options.basePath, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify(event)}\n`, "utf8");
    options.publish?.(`training-supervisor.${type}`, event);
    await options.log?.(marketState.market, event).catch?.(() => null);
    return event;
  }

  async function notify(marketState, type, title, message, severity = "info") {
    return options.notify?.({
      type,
      title,
      message,
      severity,
      market: marketState.market,
      symbol: "MODEL",
      action: marketState.status,
      cycleId: marketState.cycleId,
      attempt: marketState.attempt,
    }).catch?.(() => null);
  }

  async function recordReviewerVerdicts(marketState, reviews = [], stage = "result-review") {
    for (const review of reviews) {
      await record(marketState, "reviewer-verdict", {
        stage,
        provider: review.provider,
        label: review.label,
        model: review.model,
        available: review.available,
        disabled: review.disabled === true,
        verdict: review.verdict,
        score: review.score,
        rationale: review.rationale,
        blockingIssues: review.blockingIssues,
        recommendedActions: review.recommendedActions,
        error: review.error,
        reviewedAt: review.reviewedAt,
      });
    }
  }

  async function recordOperatorAction(marketState, action, payload = {}) {
    return record(marketState, "operator-action", {
      action: String(action || "manual-action").slice(0, 80),
      source: String(payload.source || "manual-ui").slice(0, 80),
      operatorNote: compactOperatorNote(payload.operatorNote),
      outcome: String(payload.outcome || "recorded").slice(0, 80),
      changes: Array.isArray(payload.changes) ? payload.changes.slice(0, 12) : [],
      jobId: payload.jobId || null,
    });
  }

  function basePlan(market) {
    return {
      revision: 0,
      reason: "supervisor-cycle",
      range: config.ranges[market] || "10y",
      limit: config.baseSymbolLimit,
      largeSample: true,
      productionTraining: true,
      foldCount: 5,
      embargoDays: 7,
      minTrainDates: 500,
      testDates: 120,
      maxModelWeight: 0.35,
      maxResidualCorrelation: 0.80,
    };
  }

  function anotherMarketRunning(state, market) {
    return Object.values(state.markets).some((row) => row.market !== market && ["training", "reviewing"].includes(row.status));
  }

  async function launchAttempt(state, marketState, reason) {
    if (anotherMarketRunning(state, marketState.market)) {
      marketState.status = "queued";
      marketState.nextActionAt = iso(Date.now() + config.retryDelayMs);
      await record(marketState, "queued", { reason: "another-market-running" });
      await saveState();
      return marketState;
    }
    marketState.status = "training";
    marketState.lastStartedAt = iso();
    marketState.nextActionAt = null;
    marketState.lastError = null;
    try {
      const job = await options.createTrainingJob(marketState.market, marketState.currentPlan, {
        cycleId: marketState.cycleId,
        attempt: marketState.attempt,
        reason,
      });
      marketState.activeJobId = job.id;
      await record(marketState, "job-started", { jobId: job.id, plan: marketState.currentPlan, reason });
      await saveState();
      return marketState;
    } catch (error) {
      return handleFailure(state, marketState, `Unable to create training job: ${compactError(error)}`, { stage: "job-create" });
    }
  }

  async function scheduleRework(state, marketState, reason, reviews = []) {
    marketState.activeJobId = null;
    marketState.lastError = reason;
    marketState.reviewers = reviews;
    if (marketState.attempt < marketState.maxAttempts) {
      marketState.currentPlan = adaptTrainingPlan(marketState.currentPlan, marketState.evaluation || {}, reviews, { maxSymbols: config.maxSymbols });
      marketState.status = "rework_scheduled";
      marketState.nextActionAt = iso(Date.now() + config.retryDelayMs);
      await record(marketState, "rework", { reason, nextPlan: marketState.currentPlan, nextActionAt: marketState.nextActionAt });
      await notify(marketState, `TRAINING_REWORK_${marketState.attempt}`, `${marketState.market} 模型训练需要返工`, `第 ${marketState.attempt}/${marketState.maxAttempts} 次未通过：${reason}。监工已自动安排下一轮。`, "warning");
    } else {
      marketState.status = "needs_attention";
      marketState.nextActionAt = null;
      marketState.nextCycleAt = iso(Date.now() + config.attentionRetryMs);
      await record(marketState, "attention", { reason, nextCycleAt: marketState.nextCycleAt });
      await notify(marketState, "TRAINING_NEEDS_ATTENTION", `${marketState.market} 模型训练需要你协助`, `连续 ${marketState.maxAttempts} 次训练仍未通过：${reason}。系统会保留证据并在冷却后再试，你也可以手动推动。`, "error");
    }
    await saveState();
    return marketState;
  }

  async function handleFailure(state, marketState, reason, context = {}) {
    marketState.evaluation = {
      passed: false,
      score: 0,
      failedChecks: [context.stage || "training_job"],
      checks: [{ id: context.stage || "training_job", label: "训练任务执行", passed: false, blocking: true, detail: reason }],
      summary: {},
    };
    let reviews = [];
    try {
      reviews = (await options.review?.({ market: marketState.market, result: null, evaluation: marketState.evaluation, context: { ...context, reason, reviewerEnabled: state.reviewersEnabled } })) || [];
      reviews = reviews.map((review) => normalizeReviewer(review));
    } catch {
      reviews = [];
    }
    await recordReviewerVerdicts(marketState, reviews, "training-failure");
    return scheduleRework(state, marketState, reason, reviews);
  }

  async function handleComplete(state, marketState, job) {
    marketState.status = "reviewing";
    marketState.evaluation = evaluateTrainingResult(job.result || {}, { thresholds: config.thresholds });
    await record(marketState, "review-started", { jobId: job.id, evaluation: marketState.evaluation });
    await saveState();
    let reviews = [];
    try {
      reviews = (await options.review?.({ market: marketState.market, result: job.result, evaluation: marketState.evaluation, context: { jobId: job.id, cycleId: marketState.cycleId, attempt: marketState.attempt, reviewerEnabled: state.reviewersEnabled } })) || [];
      reviews = reviews.map((review) => normalizeReviewer(review));
    } catch (error) {
      reviews = [normalizeReviewer({ provider: "review-system", label: "AI 审核系统", available: false, verdict: "rework", error: compactError(error), rationale: "AI 审核调用失败。" })];
    }
    await recordReviewerVerdicts(marketState, reviews, "result-review");
    marketState.reviewers = reviews;
    marketState.consensus = reviewerConsensus(reviews, config.minAiApprovals);
    const accepted = marketState.evaluation.passed && marketState.consensus.accepted;
    await record(marketState, "review-complete", { jobId: job.id, evaluation: marketState.evaluation, reviewers: reviews, consensus: marketState.consensus, accepted });
    if (!accepted) {
      const failedLabels = marketState.evaluation.checks.filter((check) => check.blocking && !check.passed).map((check) => check.label);
      const reviewReason = marketState.consensus.available < config.minAiApprovals
        ? `AI 监工可用 ${marketState.consensus.available}/${config.minAiApprovals}`
        : `AI 验收 ${marketState.consensus.accepts} 票通过、${marketState.consensus.reworks} 票返工`;
      return scheduleRework(state, marketState, [...failedLabels, reviewReason].filter(Boolean).join("；") || "验收未通过", reviews);
    }
    marketState.status = "accepted";
    marketState.activeJobId = null;
    marketState.lastError = null;
    marketState.lastCompletedAt = iso();
    marketState.lastAcceptedAt = marketState.lastCompletedAt;
    marketState.nextActionAt = null;
    marketState.nextCycleAt = iso(Date.now() + config.cadenceMs);
    await record(marketState, "accepted", {
      jobId: job.id,
      modelVersion: marketState.evaluation.modelVersion,
      acceptanceLevel: marketState.evaluation.acceptanceLevel,
      score: marketState.evaluation.score,
      consensus: marketState.consensus,
      nextCycleAt: marketState.nextCycleAt,
    });
    await notify(marketState, "TRAINING_ACCEPTED", `${marketState.market} 模型训练已通过`, `版本 ${marketState.evaluation.modelVersion || "未命名"} 已完成 OOF 与三方审核，硬门槛 ${marketState.evaluation.score}/100，AI 审核 ${marketState.consensus.accepts} 票通过。`, "success");
    await saveState();
    return marketState;
  }

  async function startCycle(state, marketState, reason = "scheduled") {
    marketState.cycleId = `${marketState.market}-${Date.now()}-${randomUUID().slice(0, 6)}`;
    marketState.attempt = 1;
    marketState.maxAttempts = config.maxAttempts;
    marketState.currentPlan = basePlan(marketState.market);
    marketState.evaluation = null;
    marketState.reviewers = [];
    marketState.consensus = null;
    marketState.lastError = null;
    marketState.lastCompletedAt = null;
    await record(marketState, "cycle-started", { reason, plan: marketState.currentPlan });
    return launchAttempt(state, marketState, reason);
  }

  async function tickInternal(reason = "interval") {
    const state = await readState();
    if (!state.enabled) return { skipped: true, reason: "training supervisor disabled", state };
    const now = Date.now();

    for (const marketState of Object.values(state.markets)) {
      if (!["training", "reviewing"].includes(marketState.status) || !marketState.activeJobId) continue;
      const job = await options.getJob(marketState.activeJobId);
      const jobAge = now - new Date(job?.updatedAt || marketState.lastStartedAt || 0).getTime();
      if (!job || !Number.isFinite(jobAge) || jobAge > config.maxJobAgeMs) {
        return handleFailure(state, marketState, `训练 Job 丢失或超过 ${Math.round(config.maxJobAgeMs / 60000)} 分钟无进展。`, { stage: "job-stale", jobId: marketState.activeJobId });
      }
      if (job.status === "failed") return handleFailure(state, marketState, job.error || "Training job failed.", { stage: "job-failed", jobId: job.id });
      if (job.status === "complete") return handleComplete(state, marketState, job);
      return { ok: true, active: true, market: marketState.market, jobId: job.id, status: job.status, progress: job.progress };
    }

    for (const marketState of Object.values(state.markets)) {
      if (!marketState.enabled) continue;
      const nextAction = new Date(marketState.nextActionAt || 0).getTime();
      if (["queued", "rework_scheduled"].includes(marketState.status) && (!nextAction || nextAction <= now)) {
        if (marketState.status === "rework_scheduled") marketState.attempt += 1;
        return launchAttempt(state, marketState, marketState.status === "queued" ? "queued" : "automatic-rework");
      }
    }

    for (const marketState of Object.values(state.markets)) {
      if (!marketState.enabled) continue;
      const nextCycle = new Date(marketState.nextCycleAt || 0).getTime();
      if (["idle", "accepted", "needs_attention"].includes(marketState.status) && (!nextCycle || nextCycle <= now)) {
        return startCycle(state, marketState, reason);
      }
    }
    return { ok: true, active: false, reason: "nothing-due", state };
  }

  function serializedCall(task) {
    const next = serialized.then(task, task);
    serialized = next.catch(() => null);
    return next;
  }

  async function triggerInternal(payload = {}) {
    const state = await readState();
    const market = markets.includes(String(payload.market || "").toUpperCase()) ? String(payload.market).toUpperCase() : markets[0];
    const marketState = state.markets[market];
    marketState.enabled = true;
    state.enabled = true;
    if (["training", "reviewing"].includes(marketState.status)) {
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "already-running" });
      await saveState();
      return { accepted: false, reason: "already-running", market, state: marketState };
    }
    if (anotherMarketRunning(state, market)) {
      marketState.status = "queued";
      marketState.cycleId = marketState.cycleId || `${market}-${Date.now()}-${randomUUID().slice(0, 6)}`;
      marketState.attempt = 1;
      marketState.currentPlan = marketState.currentPlan || basePlan(market);
      marketState.nextActionAt = iso();
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "queued" });
      await record(marketState, "queued", { reason: payload.reason || "manual", manual: true });
      await saveState();
      return { accepted: true, queued: true, market, state: marketState };
    }
    if (marketState.status === "rework_scheduled" && marketState.currentPlan) {
      marketState.attempt = Math.min(marketState.maxAttempts, Math.max(1, number(marketState.attempt, 0) + 1));
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "rework-started" });
      await launchAttempt(state, marketState, "manual-rework");
      return { accepted: true, queued: false, rework: true, market, state: marketState };
    }
    await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "started" });
    await startCycle(state, marketState, payload.reason || "manual");
    return { accepted: true, queued: false, market, state: marketState };
  }

  async function configureInternal(payload = {}) {
    const state = await readState();
    const market = markets.includes(String(payload.market || "").toUpperCase()) ? String(payload.market).toUpperCase() : markets[0];
    const marketState = state.markets[market];
    const changes = [];
    if (payload.enabled != null) {
      const next = payload.enabled !== false;
      if (state.enabled !== next) changes.push({ field: "supervisor.enabled", from: state.enabled !== false, to: next });
      state.enabled = next;
    }
    if (payload.reviewers && typeof payload.reviewers === "object") {
      reviewerIds.forEach((reviewer) => {
        if (payload.reviewers[reviewer] == null) return;
        const next = payload.reviewers[reviewer] !== false;
        if (state.reviewersEnabled[reviewer] !== next) changes.push({ field: `reviewer.${reviewer}`, from: state.reviewersEnabled[reviewer] !== false, to: next });
        state.reviewersEnabled[reviewer] = next;
      });
    }
    const reviewer = String(payload.reviewer || "").toLowerCase();
    if (reviewerIds.includes(reviewer) && payload.reviewerEnabled != null) {
      const next = payload.reviewerEnabled !== false;
      if (state.reviewersEnabled[reviewer] !== next) changes.push({ field: `reviewer.${reviewer}`, from: state.reviewersEnabled[reviewer] !== false, to: next });
      state.reviewersEnabled[reviewer] = next;
    }
    if (payload.market && state.markets[String(payload.market).toUpperCase()] && payload.marketEnabled != null) {
      const selected = state.markets[String(payload.market).toUpperCase()];
      const next = payload.marketEnabled !== false;
      if (selected.enabled !== next) changes.push({ field: `market.${selected.market}.enabled`, from: selected.enabled !== false, to: next });
      selected.enabled = next;
    }
    if (changes.length) await recordOperatorAction(marketState, "configuration-changed", { ...payload, changes, outcome: "saved" });
    await saveState();
    return publicStatus(state, payload.market);
  }

  async function reviewLatestInternal(payload = {}) {
    const state = await readState();
    const market = markets.includes(String(payload.market || "").toUpperCase()) ? String(payload.market).toUpperCase() : markets[0];
    const marketState = state.markets[market];
    if (["training", "reviewing"].includes(marketState.status)) {
      await recordOperatorAction(marketState, "review-latest", { ...payload, outcome: "already-running" });
      await saveState();
      return { accepted: false, reason: "already-running", market, state: marketState };
    }
    const latestJobEvent = (marketState.history || []).find((event) => event.jobId && ["review-complete", "review-started", "job-started"].includes(event.type));
    const job = latestJobEvent?.jobId ? await options.getJob(latestJobEvent.jobId) : null;
    if (!job || job.status !== "complete" || !job.result) {
      await recordOperatorAction(marketState, "review-latest", { ...payload, outcome: "no-complete-job", jobId: latestJobEvent?.jobId || null });
      await saveState();
      return { accepted: false, reason: "no-complete-job", market, state: marketState };
    }
    state.enabled = true;
    marketState.enabled = true;
    marketState.status = "reviewing";
    marketState.activeJobId = job.id;
    marketState.lastError = null;
    await recordOperatorAction(marketState, "review-latest", { ...payload, outcome: "started", jobId: job.id });
    await saveState();
    const reviewed = await handleComplete(state, marketState, job);
    return { accepted: true, market, jobId: job.id, state: reviewed };
  }

  function publicStatus(state, market = null) {
    const selected = market ? state.markets?.[String(market).toUpperCase()] : null;
    return {
      available: true,
      enabled: state.enabled !== false,
      reviewersEnabled: { ...(state.reviewersEnabled || {}) },
      updatedAt: state.updatedAt,
      config: {
        maxAttempts: config.maxAttempts,
        cadenceMs: config.cadenceMs,
        retryDelayMs: config.retryDelayMs,
        attentionRetryMs: config.attentionRetryMs,
        minAiApprovals: config.minAiApprovals,
        thresholds: config.thresholds,
      },
      market: selected || null,
      markets: Object.fromEntries(Object.entries(state.markets || {}).map(([key, value]) => [key, value])),
    };
  }

  async function logsInternal(filters = {}) {
    const market = filters.market ? String(filters.market).toUpperCase() : null;
    const provider = filters.provider ? String(filters.provider).toLowerCase() : null;
    const limit = Math.max(1, Math.min(500, number(filters.limit, 120)));
    try {
      const rows = String(await readFile(auditPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((event) => !market || event.market === market)
        .filter((event) => !provider || String(event.provider || "system").toLowerCase() === provider)
        .reverse()
        .slice(0, limit);
      return { available: true, market, provider, count: rows.length, events: rows };
    } catch {
      return { available: true, market, provider, count: 0, events: [] };
    }
  }

  return {
    configure: (payload) => serializedCall(() => configureInternal(payload)),
    logs: (filters) => logsInternal(filters),
    reviewLatest: (payload) => serializedCall(() => reviewLatestInternal(payload)),
    status: async (market = null) => publicStatus(await readState(), market),
    tick: (reason) => serializedCall(() => tickInternal(reason)),
    trigger: (payload) => serializedCall(() => triggerInternal(payload)),
  };
}

export {
  adaptTrainingPlan,
  createTrainingSupervisor,
  evaluateTrainingResult,
  reviewerConsensus,
};
