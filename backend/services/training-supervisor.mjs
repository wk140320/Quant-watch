import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildPromotionEvidenceV3, validatePromotionEvidenceV3 } from "./promotion-evidence.mjs";

const DEFAULT_MARKETS = ["ASX", "US", "CN"];
const DEFAULT_THRESHOLDS = Object.freeze({
  minRows: 50_000,
  minSymbols: 100,
  minHorizonModels: 1,
  minOofRows: 1_000,
  minMetaTestRows: 1_000,
  minIndependentTestDates: 120,
  minTargetEvents: 500,
  minStopEvents: 500,
  minFolds: 5,
  minPositiveFolds: 4,
  minAccuracyPct: 60,
  minBalancedAccuracyPct: 57,
  minDirectionMcc: 0,
  minRelativeMajorityAccuracyPct: 0,
  minThresholdCoveragePct: 50,
  minTop10DirectionHitRatePct: 60,
  minBrierSkill: 0.02,
  maxEcePct: 3,
  minCalibrationSlope: 0.8,
  maxCalibrationSlope: 1.2,
  minProbabilityBucketEvents: 30,
  minProbabilityBucketIndependentDates: 30,
  minTopDecileLift: 0,
  minExpectedValuePct: 0,
});

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function boundedSideEffect(promise, timeoutMs = 1_000) {
  if (!promise || typeof promise.then !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), Math.max(100, Number(timeoutMs) || 1_000));
    timer.unref?.();
    Promise.resolve(promise).then(finish, () => finish(null));
  });
}

function trainingResult(result = {}) {
  return result?.productionTraining || result?.result?.productionTraining || null;
}

function primaryDirectionMetrics(model = {}) {
  return model?.directionMetrics || model?.metrics || {};
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
  const fiveDayModels = models.filter((model) => model?.available && Number(model?.horizon) === 5);
  const availableModels = fiveDayModels.length ? fiveDayModels : models.filter((model) => model?.available);
  const checks = [];
  const kernelChecksByModel = Object.fromEntries(availableModels.map((model) => [
    `${Number(model.horizon || 0)}d`, model?.productionChecks && typeof model.productionChecks === "object"
      ? model.productionChecks
      : null,
  ]));
  const kernelEvidenceAvailable = availableModels.length > 0
    && availableModels.every((model) => model?.productionChecks && typeof model.productionChecks === "object" && Object.keys(model.productionChecks).length > 0);
  const kernelFailedChecks = Object.entries(kernelChecksByModel).flatMap(([horizon, value]) => value
    ? Object.entries(value).filter(([, passed]) => passed !== true).map(([key]) => `${horizon}.${key}`)
    : [`${horizon}.missing`]);
  const kernelDecision = training?.productionEligibility || null;
  const kernelPassed = kernelEvidenceAvailable
    && kernelDecision?.eligible === true
    && kernelFailedChecks.length === 0;

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
  const panelSampling = dataset.panelSampling || {};
  const conservation = dataset.outerCrossSectionRowConservation || {};
  const outerCrossSectionPassed = conservation.passed === true
    && conservation.completeDailyCrossSection === true
    && number(conservation.eligibleRows) > 0
    && number(conservation.eligibleRows) === number(conservation.evaluatedRows) + number(conservation.auditedExcludedRows)
    && number(conservation.sampledRows) === number(conservation.evaluatedRows)
    && number(conservation.skippedRows) === 0;
  addCheck(
    checks,
    "outer_cross_section",
    "外层 OOF 完整横截面",
    outerCrossSectionPassed,
    outerCrossSectionPassed
      ? `外层评估 ${number(conservation.evaluatedRows)} 行，审计排除 ${number(conservation.auditedExcludedRows)} 行；逐行守恒。`
      : "外层 OOF 仍存在按股票/日期抽样或缺少完整横截面审计，不能晋级。",
    { threshold: "eligible rows = evaluated rows; skipped = 0" },
  );
  addCheck(checks, "horizon_models", "5日主模型可用", availableModels.length >= thresholds.minHorizonModels, `可用5日主模型 ${availableModels.length} 个；15/30日保持 Research 收集证据。`, { value: availableModels.length, threshold: thresholds.minHorizonModels });
  addCheck(
    checks,
    "kernel_production_checks",
    "模型内核生产门",
    kernelPassed,
    kernelPassed
      ? "Python 模型内核、数据完整度与生产资格使用同一份核心门控。"
      : `内核门未通过：${kernelEvidenceAvailable ? kernelFailedChecks.slice(0, 8).join("、") : "缺少 productionChecks 证据"}。`,
    { threshold: "core-production-checks-v2" },
  );

  if (availableModels.length) {
    const oofPassed = availableModels.every((model) => number(model.oofRows) >= thresholds.minOofRows && number(model.metaTestRows) >= thresholds.minMetaTestRows);
    addCheck(checks, "oof_depth", "严格样本外深度", oofPassed, availableModels.map((model) => `${model.horizon}d OOF ${number(model.oofRows)} / 独立测试 ${number(model.metaTestRows)}`).join("；"), { threshold: `${thresholds.minOofRows}/${thresholds.minMetaTestRows}` });

    const eventPassed = availableModels.every((model) => number(model.eventCounts?.target) >= thresholds.minTargetEvents && number(model.eventCounts?.stop) >= thresholds.minStopEvents);
    addCheck(checks, "event_support", "目标/止损事件支持", eventPassed, availableModels.map((model) => `${model.horizon}d 目标 ${number(model.eventCounts?.target)} / 止损 ${number(model.eventCounts?.stop)}`).join("；"), { threshold: `${thresholds.minTargetEvents}/${thresholds.minStopEvents}` });

    const datePassed = availableModels.every((model) => number(primaryDirectionMetrics(model).testDates) >= thresholds.minIndependentTestDates);
    addCheck(checks, "independent_dates", "独立测试日期", datePassed, availableModels.map((model) => `${model.horizon}d ${number(primaryDirectionMetrics(model).testDates)} 日`).join("；"), { threshold: thresholds.minIndependentTestDates });

    const foldsPassed = availableModels.every((model) => (model.foldMetrics || []).length >= thresholds.minFolds && number(model.positiveFoldCount) >= thresholds.minPositiveFolds);
    addCheck(checks, "rolling_folds", "滚动窗口稳定性", foldsPassed, availableModels.map((model) => `${model.horizon}d ${(model.foldMetrics || []).length} 折 / 正向 ${number(model.positiveFoldCount)}`).join("；"), { threshold: `${thresholds.minFolds}/${thresholds.minPositiveFolds}` });

    const brierPassed = availableModels.every((model) => number(primaryDirectionMetrics(model).brierSkillScore, -1) > thresholds.minBrierSkill);
    addCheck(checks, "brier_skill", "方向 Brier Skill 为正", brierPassed, availableModels.map((model) => `${model.horizon}d ${number(primaryDirectionMetrics(model).brierSkillScore, -1).toFixed(4)}`).join("；"), { threshold: `>${thresholds.minBrierSkill}` });

    // Accuracy remains visible for audit, but cannot promote a model: a
    // majority-class predictor can look accurate while having no skill.
    const accuracyPassed = availableModels.every((model) => number(primaryDirectionMetrics(model).accuracyPct, 0) >= thresholds.minAccuracyPct);
    addCheck(checks, "direction_accuracy", "全量方向准确率（参考）", accuracyPassed, availableModels.map((model) => `${model.horizon}d ${number(primaryDirectionMetrics(model).accuracyPct, 0).toFixed(2)}%`).join("；"), { blocking: false, threshold: `参考 >=${thresholds.minAccuracyPct}%` });

    const thresholdMetrics = (model) => model.directionThresholdMetrics || {};
    const thresholdSelectionPassed = availableModels.every((model) => thresholdMetrics(model).available === true);
    addCheck(checks, "direction_threshold_selection", "样本外阈值选择", thresholdSelectionPassed, availableModels.map((model) => `${model.horizon}d ${thresholdMetrics(model).available === true ? `阈值 ${number(thresholdMetrics(model).threshold, 0.5).toFixed(2)}` : "未生成嵌套阈值证据"}`).join("；"), { threshold: "meta-train-only" });

    const balancedAccuracyPassed = availableModels.every((model) => number(thresholdMetrics(model).balancedAccuracyPct, 0) >= thresholds.minBalancedAccuracyPct);
    addCheck(checks, "balanced_accuracy", "阈值后方向 Balanced Accuracy", balancedAccuracyPassed, availableModels.map((model) => `${model.horizon}d ${number(thresholdMetrics(model).balancedAccuracyPct, 0).toFixed(2)}%`).join("；"), { threshold: `>=${thresholds.minBalancedAccuracyPct}%` });

    const mccPassed = availableModels.every((model) => number(thresholdMetrics(model).matthewsCorrelation, -1) >= thresholds.minDirectionMcc);
    addCheck(checks, "direction_mcc", "阈值后 MCC", mccPassed, availableModels.map((model) => `${model.horizon}d ${number(thresholdMetrics(model).matthewsCorrelation, -1).toFixed(4)}`).join("；"), { threshold: `>=${thresholds.minDirectionMcc}` });

    const relativeMajorityPassed = availableModels.every((model) => number(thresholdMetrics(model).relativeMajorityAccuracyPct, -100) >= thresholds.minRelativeMajorityAccuracyPct);
    addCheck(checks, "relative_majority_accuracy", "相对多数类基准提升", relativeMajorityPassed, availableModels.map((model) => `${model.horizon}d ${number(thresholdMetrics(model).relativeMajorityAccuracyPct, -100).toFixed(2)}pp`).join("；"), { threshold: `>=${thresholds.minRelativeMajorityAccuracyPct}pp` });

    const thresholdCoveragePassed = availableModels.every((model) => number(thresholdMetrics(model).coveragePct, 0) >= thresholds.minThresholdCoveragePct);
    addCheck(checks, "direction_threshold_coverage", "阈值后有效覆盖率", thresholdCoveragePassed, availableModels.map((model) => `${model.horizon}d ${number(thresholdMetrics(model).coveragePct, 0).toFixed(2)}%`).join("；"), { threshold: `>=${thresholds.minThresholdCoveragePct}%` });

    const ecePassed = availableModels.every((model) => number(primaryDirectionMetrics(model).ecePct, 100) <= thresholds.maxEcePct);
    addCheck(checks, "calibration_ece", "方向概率校准 ECE", ecePassed, availableModels.map((model) => `${model.horizon}d ${number(primaryDirectionMetrics(model).ecePct, 100).toFixed(2)}%`).join("；"), { threshold: `<=${thresholds.maxEcePct}%` });

    const slopePassed = availableModels.every((model) => thresholds.minCalibrationSlope <= number(primaryDirectionMetrics(model).calibrationSlope, -1) && number(primaryDirectionMetrics(model).calibrationSlope, -1) <= thresholds.maxCalibrationSlope);
    addCheck(checks, "calibration_slope", "方向概率校准斜率", slopePassed, availableModels.map((model) => `${model.horizon}d ${number(primaryDirectionMetrics(model).calibrationSlope, -1).toFixed(3)}`).join("；"), { threshold: `${thresholds.minCalibrationSlope}-${thresholds.maxCalibrationSlope}` });

    const bucketPassed = availableModels.every((model) => {
      const metrics = primaryDirectionMetrics(model);
      return metrics.probabilityResolutionPassed === true
        && number(metrics.probabilityBucketMinCount) >= thresholds.minProbabilityBucketEvents
        && number(metrics.probabilityBucketMinIndependentDates) >= thresholds.minProbabilityBucketIndependentDates;
    });
    addCheck(
      checks,
      "probability_bucket_support",
      "方向概率桶独立事件",
      bucketPassed,
      availableModels.map((model) => {
        const metrics = primaryDirectionMetrics(model);
        return `${model.horizon}d 最小桶 ${number(metrics.probabilityBucketMinCount)} 行 / ${number(metrics.probabilityBucketMinIndependentDates)} 个独立日期`;
      }).join("；"),
      { threshold: `${thresholds.minProbabilityBucketEvents} 行 / ${thresholds.minProbabilityBucketIndependentDates} 日` },
    );

    const ranking = (model) => model.rankingMetrics || model.ranking || {};
    const topKPassed = availableModels.every((model) => number(ranking(model).topDecileLift ?? ranking(model).topDecileLiftPct) > thresholds.minTopDecileLift);
    addCheck(checks, "top_k_lift", "Top-K 超额收益", topKPassed, availableModels.map((model) => `${model.horizon}d ${number(ranking(model).topDecileLift ?? ranking(model).topDecileLiftPct).toFixed(4)}`).join("；"), { threshold: `>${thresholds.minTopDecileLift}` });

    const top10DirectionPassed = availableModels.every((model) => number(ranking(model).top10DirectionHitRatePct, 0) >= thresholds.minTop10DirectionHitRatePct);
    addCheck(checks, "top10_direction", "Top 10% 方向命中率", top10DirectionPassed, availableModels.map((model) => `${model.horizon}d ${number(ranking(model).top10DirectionHitRatePct, 0).toFixed(2)}%`).join("；"), { threshold: `>=${thresholds.minTop10DirectionHitRatePct}%` });

    const evPassed = availableModels.every((model) => (
      model.longTradeExpectedValue?.available === true
      && number(model.longTradeExpectedValue?.expectedValuePct, -1) > thresholds.minExpectedValuePct
    ));
    addCheck(checks, "expected_value", "成本后期望值", evPassed, availableModels.map((model) => {
      const evidence = model.longTradeExpectedValue;
      if (evidence?.available !== true) return `${model.horizon}d evidence unavailable (eligible-long required)`;
      return `${model.horizon}d ${number(evidence.expectedValuePct, -1).toFixed(4)}% (eligible-long)`;
    }).join("；"), { threshold: `>${thresholds.minExpectedValuePct}%` });

    const driftPassed = availableModels.every((model) => (model.foldMetrics || []).every((fold) => number(fold.featureDrift?.maxPsi, 0) <= 0.40));
    addCheck(checks, "feature_drift", "特征漂移", driftPassed, "所有滚动窗口最大 PSI 必须不高于 0.40。", { threshold: "<=0.40" });

    const leakagePassed = models.filter((model) => model?.available).every((model) => {
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
    kernelChecks: kernelChecksByModel,
    kernelFailedChecks,
    kernelEligible: kernelPassed,
    checks,
    failedChecks: failed.map((check) => check.id),
    summary: {
      rawRows: number(dataset.rawRows),
      symbolCount: number(dataset.symbolCount),
      pointInTimeCoveragePct: number(dataset.pointInTimeCoveragePct),
      pointInTimeJoinViolationCount: number(dataset.pointInTimeJoinViolationCount),
      pointInTimeExcludedViolationCount: number(dataset.pointInTimeExcludedViolationCount),
      horizons: availableModels.map((model) => ({
        horizon: model.horizon,
        oofRows: number(model.oofRows),
        metaTestRows: number(model.metaTestRows),
        brierSkillScore: number(primaryDirectionMetrics(model).brierSkillScore, -1),
        ecePct: number(primaryDirectionMetrics(model).ecePct, 100),
        rawDirectionAccuracyPct: number(primaryDirectionMetrics(model).accuracyPct, 0),
        thresholdDirectionBalancedAccuracyPct: number((model.directionThresholdMetrics || {}).balancedAccuracyPct, 0),
        thresholdDirectionMcc: number((model.directionThresholdMetrics || {}).matthewsCorrelation, -1),
        thresholdDirectionCoveragePct: number((model.directionThresholdMetrics || {}).coveragePct, 0),
        topDecileLift: number((model.rankingMetrics || model.ranking || {}).topDecileLift, 0),
        top10DirectionHitRatePct: number((model.rankingMetrics || model.ranking || {}).top10DirectionHitRatePct, 0),
        expectedValuePct: model.longTradeExpectedValue?.available === true
          ? number(model.longTradeExpectedValue?.expectedValuePct)
          : null,
        expectedValueSource: model.longTradeExpectedValue?.available === true ? "eligible-long" : "missing-eligible-long-evidence",
        maxPsi: Math.max(0, ...(model.foldMetrics || []).map((fold) => number(fold.featureDrift?.maxPsi))),
      })),
    },
  };
}

function deterministicGateDecision(evaluation = {}, options = {}) {
  const evidence = evaluation.promotionEvidence || {};
  const evidenceRequired = options.requireEvidence === true;
  const evidenceValidation = evidenceRequired
    ? validatePromotionEvidenceV3(evidence, { modelVersion: evaluation.modelVersion, market: options.market })
    : { valid: true, reason: "evidence_not_required" };
  return {
    mode: "deterministic_only",
    accepted: evaluation.passed === true && (!evidenceRequired || evidenceValidation.valid),
    score: number(evaluation.score),
    failedChecks: Array.isArray(evaluation.failedChecks) ? [...evaluation.failedChecks] : [],
    promotionEvidenceId: evidence.evidenceId || null,
    promotionDecision: evidence.decision || "hold_shadow",
    evidenceValidation,
    decidedAt: iso(),
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
  // Runtime failure is not model evidence. Recover from fold checkpoints with
  // a smaller resource envelope instead of replaying the same long job.
  const runtimeFailure = ["job-failed", "job-stale", "job-queue-stale", "training_job", "training_runtime"]
    .some((key) => failed.has(key));
  if (runtimeFailure) {
    next.resume = true;
    // A native wheel crash is an execution failure, not model evidence. Keep
    // the next attempt alive on the pure-Python baseline until a separate
    // environment health check proves the native challenger is importable.
    next.enableTreeModels = false;
    next.enableSklearnModels = false;
    next.nativeModelPolicy = "safe-python-baseline";
    next.treeThreads = Math.min(2, Math.max(1, number(previous.treeThreads, 2) - 1));
    next.treeIterations = Math.min(60, Math.max(40, number(previous.treeIterations, 72) - 12));
    next.treeMaxRows = Math.min(30_000, Math.max(20_000, number(previous.treeMaxRows, 40_000)));
    next.baselineMaxRows = Math.min(4_000, Math.max(2_000, number(previous.baselineMaxRows, 6_000)));
    next.quantileMaxRows = Math.min(4_000, Math.max(2_000, number(previous.quantileMaxRows, 6_000)));
    next.runtimeRecovery = "fold-checkpoint-resume-single-thread";
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
  const config = {
    enabled: options.config?.enabled !== false,
    autoCycleEnabled: options.config?.autoCycleEnabled === true,
    // D0-D5: do not refit an unchanged hypothesis automatically. Manual runs
    // remain available through the supervisor endpoint.
    autoReworkEnabled: options.config?.autoReworkEnabled !== false,
    maxAttempts: Math.max(1, Math.min(8, number(options.config?.maxAttempts, 3))),
    cadenceMs: Math.max(60_000, number(options.config?.cadenceMs, 24 * 60 * 60_000)),
    retryDelayMs: Math.max(1_000, number(options.config?.retryDelayMs, 60_000)),
    attentionRetryMs: Math.max(60_000, number(options.config?.attentionRetryMs, 6 * 60 * 60_000)),
    startupDelayMs: Math.max(0, number(options.config?.startupDelayMs, 120_000)),
    maxJobAgeMs: Math.max(60_000, number(options.config?.maxJobAgeMs, 30 * 60_000)),
    // A job that is waiting in the persisted job queue has not started a Python
    // worker yet, so its updatedAt is not a heartbeat. Treating it as stale
    // created duplicate rework jobs during PIT/backfill runs.
    maxQueuedJobAgeMs: Math.max(60_000, number(options.config?.maxQueuedJobAgeMs, 6 * 60 * 60_000)),
    baseSymbolLimit: Math.max(10, number(options.config?.baseSymbolLimit, 100)),
    maxSymbols: Math.max(20, number(options.config?.maxSymbols, 500)),
    ranges: { ASX: "10y", US: "10y", CN: "8y", ...(options.config?.ranges || {}) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(options.config?.thresholds || {}) },
  };
  const statePath = join(options.basePath, "state.json");
  const auditPath = join(options.basePath, "events.jsonl");
  const evidenceRoot = join(options.basePath, "promotion-evidence");
  let loaded = null;
  let serialized = Promise.resolve();

  async function persistPromotionEvidence(marketState, evaluation, context = {}) {
    const evidence = buildPromotionEvidenceV3({
      market: marketState.market,
      cycleId: marketState.cycleId,
      attempt: marketState.attempt,
      jobId: context.jobId || marketState.activeJobId || null,
      evaluation,
      context,
    });
    const evidenceId = evidence.evidenceId;
    const directory = join(evidenceRoot, String(marketState.market).toLowerCase());
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${evidenceId}.json`);
    try {
      await readFile(path, "utf8");
    } catch {
      const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, JSON.stringify(evidence, null, 2), "utf8");
      await rename(temporary, path);
    }
    const latestPath = join(directory, "latest.json");
    const latestTemporary = `${latestPath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(latestTemporary, JSON.stringify(evidence, null, 2), "utf8");
    await rename(latestTemporary, latestPath);
    return evidence;
  }

  function marketDefault(market, index = 0) {
    return {
      market,
      enabled: true,
      queueOrder: index,
      manualPaused: false,
      status: "idle",
      cycleId: null,
      attempt: 0,
      maxAttempts: config.maxAttempts,
      manualQueued: false,
      activeJobId: null,
      currentPlan: null,
      evaluation: null,
      gateDecision: null,
      lastError: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastAcceptedAt: null,
      lastDataVersion: null,
      lastCompletedPlanSignature: null,
      nextActionAt: null,
      nextCycleAt: config.autoCycleEnabled
        ? iso(Date.now() + config.startupDelayMs + index * 60_000)
        : null,
      history: [],
    };
  }

  async function readState() {
    if (loaded) return loaded;
    let migrated = false;
    try {
      // The status endpoint and startup scheduler can be the first two callers.
      // Initialize this small local control-plane snapshot atomically so both
      // cannot start competing async reads and migrations of the same file.
      loaded = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      loaded = { version: 2, enabled: config.enabled, updatedAt: iso(), markets: {} };
    }
    loaded.markets ||= {};
    markets.forEach((market, index) => {
      const previous = loaded.markets[market] || {};
      const legacyAiBlocked = previous.evaluation?.passed === true && (
        previous.status === "awaiting_optional_review"
        || (["rework_scheduled", "completed_not_promoted"].includes(previous.status) && /^AI (?:监工|验收|审核)/.test(String(previous.lastError || "")))
      );
      const current = { ...marketDefault(market, index), ...previous, market };
      if (!Number.isFinite(Number(current.queueOrder))) current.queueOrder = index;
      current.manualPaused = current.manualPaused === true;
      // PromotionEvidence v2 is historical evidence only.  Do not let a
      // persisted v2 acceptance survive the v3 contract migration; the
      // immutable file remains available for audit, but the live gate must be
      // recomputed from a v3 artifact.
      const promotionEvidenceVersion = Number(current.evaluation?.promotionEvidence?.schemaVersion || 0);
      if (current.evaluation?.promotionEvidence && promotionEvidenceVersion < 3) {
        const priorStatus = current.status;
        const legacyEvaluation = {
          ...current.evaluation,
          passed: false,
          failedChecks: [...new Set([...(current.evaluation.failedChecks || []), "promotion_evidence_v3_missing"])],
          candidateStatus: "NO_MODEL",
        };
        current.evaluation = {
          ...current.evaluation,
          passed: false,
          failedChecks: legacyEvaluation.failedChecks,
          promotionEvidence: buildPromotionEvidenceV3({
            market,
            cycleId: current.cycleId,
            attempt: current.attempt,
            jobId: current.activeJobId,
            evaluation: legacyEvaluation,
            context: {
              candidateStatus: "NO_MODEL",
              dataVersion: current.evaluation.dataVersion || null,
              planSignature: current.currentPlan ? JSON.stringify(current.currentPlan) : null,
            },
          }),
        };
        current.gateDecision = deterministicGateDecision(current.evaluation, { requireEvidence: true, market });
        if (current.gateDecision.accepted === true || priorStatus === "accepted") {
          current.status = "completed_not_promoted";
          current.activeJobId = null;
          current.lastError = "旧 PromotionEvidence v2 已降级为历史证据；等待 v3 样本外重验收。";
          current.nextActionAt = null;
          current.nextCycleAt = null;
        }
        migrated = true;
      }
      // Recover persisted native-runtime failures once. The previous attempts
      // died before producing model evidence, so they must not consume the
      // next safe-baseline run or leave the market permanently completed.
      const nativeRuntimeFailure = /SIGBUS|SIGSEGV|native wheel|原生/.test(String(current.lastError || ""));
      const staleRecoveryFailure = /key is not defined/.test(String(current.lastError || ""))
        && current.nativeRecoveryQueued !== true;
      const restartCancellation = /Python quant core request was cancelled|backend restart|服务重启/.test(String(current.lastError || ""))
        && Number(current.recoveryRetryCount || 0) < 2;
      if ((nativeRuntimeFailure || staleRecoveryFailure || restartCancellation)
        && current.currentPlan
        && !["training", "evaluating", "reviewing"].includes(current.status)) {
        current.currentPlan = {
          ...current.currentPlan,
          enableTreeModels: false,
          enableSklearnModels: false,
          nativeModelPolicy: "safe-python-baseline",
          resume: true,
          runtimeRecovery: "native-import-isolated-safe-baseline",
          treeThreads: 1,
          treeIterations: 40,
          treeMaxRows: 20_000,
          baselineMaxRows: 2_000,
          quantileMaxRows: 2_000,
        };
        if (["completed_not_promoted", "idle", "accepted"].includes(current.status)) {
          current.status = "rework_scheduled";
          current.attempt = Math.max(0, Math.min(number(current.maxAttempts, 3) - 1, number(current.attempt, 0)));
        }
        current.nextActionAt = iso();
        current.nativeRecoveryQueued = true;
        if (restartCancellation) current.recoveryRetryCount = Number(current.recoveryRetryCount || 0) + 1;
        migrated = true;
      }
      if (legacyAiBlocked && current.evaluation?.promotionEvidence?.decision === "promote_candidate") {
        const priorStatus = current.status;
        current.status = "accepted";
        current.activeJobId = null;
        current.lastError = null;
        current.lastAcceptedAt = current.lastCompletedAt || current.lastAcceptedAt || iso();
        current.nextActionAt = null;
        current.nextCycleAt = config.autoCycleEnabled ? iso(Date.now() + config.cadenceMs) : null;
        current.gateDecision = deterministicGateDecision(current.evaluation, { requireEvidence: true, market });
        current.history = [{
          id: randomUUID(),
          type: "legacy-ai-review-retired",
          market,
          cycleId: current.cycleId,
          attempt: current.attempt,
          createdAt: iso(),
          priorStatus,
          accepted: true,
          reason: "外部 AI 审核已退出训练晋级链路；沿用已通过的固定样本外证据。",
        }, ...(current.history || [])].slice(0, 100);
        migrated = true;
      }
      if (legacyAiBlocked && current.evaluation?.promotionEvidence?.decision !== "promote_candidate") {
        current.status = "completed_not_promoted";
        current.activeJobId = null;
        current.lastError = "旧训练状态缺少不可变 PromotionEvidence；已降级为 Shadow，等待重新验收。";
        current.nextActionAt = null;
        current.nextCycleAt = null;
        migrated = true;
      }
      if (current.evaluation && !current.gateDecision) {
        current.gateDecision = deterministicGateDecision(current.evaluation, { requireEvidence: true, market });
        migrated = true;
      }
      if (Object.hasOwn(current, "reviewers") || Object.hasOwn(current, "consensus")) migrated = true;
      current.manualQueued = current.manualQueued === true;
      if (!config.autoReworkEnabled && current.status === "rework_scheduled" && current.nextActionAt) {
        current.nextActionAt = null;
        current.lastError ||= "自动返工已暂停：等待新增数据、改变方案或手动启动。";
        migrated = true;
      }
      delete current.reviewers;
      delete current.consensus;
      loaded.markets[market] = current;
    });
    const hasLiveMarket = Object.values(loaded.markets).some((row) =>
      row?.activeJobId && ["training", "evaluating", "reviewing"].includes(row.status));
    if (!hasLiveMarket && !config.autoCycleEnabled && !config.autoReworkEnabled) {
      for (const current of Object.values(loaded.markets)) {
        if (current.status !== "queued" || current.activeJobId || current.manualQueued === true) continue;
        current.status = "completed_not_promoted";
        current.nextActionAt = null;
        current.nextCycleAt = null;
        current.lastError ||= "孤立排队状态已对账：当前没有实际训练 Job，等待新数据或人工启动。";
        migrated = true;
      }
    }
    if (Object.hasOwn(loaded, "reviewersEnabled")) migrated = true;
    delete loaded.reviewersEnabled;
    if (loaded.version !== 2) migrated = true;
    loaded.version = 2;
    if (loaded.enabled == null) loaded.enabled = config.enabled;
    if (migrated) {
      loaded.updatedAt = iso();
      await mkdir(options.basePath, { recursive: true });
      const temporary = `${statePath}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, JSON.stringify(loaded, null, 2), "utf8");
      await rename(temporary, statePath);
    }
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
    // Audit persistence is valuable but must never be able to stop the
    // scheduler. macOS background processes can temporarily lose permission
    // to append to compressed files under Documents; the durable state and
    // in-memory history remain sufficient to continue queueing work.
    try {
      await mkdir(options.basePath, { recursive: true });
      await appendFile(auditPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      event.auditPersistError = String(error?.message || error).slice(0, 240);
    }
    options.publish?.(`training-supervisor.${type}`, event);
    await boundedSideEffect(options.log?.(marketState.market, event), 1_000);
    return event;
  }

  async function notify(marketState, type, title, message, severity = "info") {
    return boundedSideEffect(options.notify?.({
      type,
      title,
      message,
      severity,
      market: marketState.market,
      symbol: "MODEL",
      action: marketState.status,
      cycleId: marketState.cycleId,
      attempt: marketState.attempt,
    }), 1_000);
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
      // The isolated .ml-venv is the default production challenger runtime.
      // A failed native probe can still force a safe baseline, but a stale
      // recovery flag must not permanently hide healthy CatBoost/LightGBM/
      // sklearn wheels from every later cycle.
      enableTreeModels: true,
      enableSklearnModels: true,
      nativeModelPolicy: "native-ml-isolated",
    };
  }

  function anotherMarketRunning(state, market) {
    return Object.values(state.markets).some((row) => row.market !== market && ["training", "evaluating", "reviewing"].includes(row.status));
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
    marketState.manualPaused = false;
    marketState.lastStartedAt = iso();
    marketState.nextActionAt = null;
    marketState.lastError = null;
    try {
      const job = await options.createTrainingJob(marketState.market, marketState.currentPlan, {
        cycleId: marketState.cycleId,
        attempt: marketState.attempt,
        reason,
        priority: /^manual|manual-ui|manual-rework/i.test(String(reason || "")) ? "manual" : "normal",
      });
      marketState.activeJobId = job.id;
      await record(marketState, "job-started", { jobId: job.id, plan: marketState.currentPlan, reason });
      await saveState();
      return marketState;
    } catch (error) {
      return handleFailure(state, marketState, `Unable to create training job: ${compactError(error)}`, { stage: "job-create" });
    }
  }

  async function scheduleRework(state, marketState, reason, options = {}) {
    marketState.activeJobId = null;
    marketState.lastError = reason;
    const runtimeFailure = options.runtimeFailure === true;
    if (!runtimeFailure) {
      marketState.status = "completed_not_promoted";
      marketState.nextActionAt = null;
      marketState.nextCycleAt = null;
      marketState.manualQueued = false;
      await record(marketState, "evidence-rejected-awaiting-new-evidence", {
        reason,
        failureClass: options.failureClass || "evidence",
        nextAction: "等待新增数据、改变标签/特征假设或手动启动新的验证周期",
      });
      await notify(marketState, "TRAINING_EVIDENCE_REJECTED", `${marketState.market} 证据未达标`, `本轮训练已完成但未通过固定样本外门控：${reason}。不会用相同数据自动重复拟合；等待新增数据、新假设或手动启动。`, "warning");
      await saveState();
      return marketState;
    }
    if (marketState.attempt < marketState.maxAttempts) {
      marketState.currentPlan = adaptTrainingPlan(marketState.currentPlan, marketState.evaluation || {}, [], { maxSymbols: config.maxSymbols });
      marketState.status = "rework_scheduled";
      marketState.nextActionAt = config.autoReworkEnabled ? iso(Date.now() + config.retryDelayMs) : null;
      marketState.manualQueued = false;
      await record(marketState, "rework", { reason, nextPlan: marketState.currentPlan, nextActionAt: marketState.nextActionAt });
      await notify(marketState, `TRAINING_REWORK_${marketState.attempt}`, `${marketState.market} 模型训练需要返工`, config.autoReworkEnabled
        ? `第 ${marketState.attempt}/${marketState.maxAttempts} 次未通过：${reason}。训练门禁已自动安排下一轮。`
        : `第 ${marketState.attempt}/${marketState.maxAttempts} 次未通过：${reason}。已暂停相同假设的自动返工，等待新增数据、改变方案或手动启动。`, "warning");
    } else {
      marketState.status = "completed_not_promoted";
      marketState.nextActionAt = null;
      marketState.nextCycleAt = config.autoCycleEnabled ? iso(Date.now() + config.attentionRetryMs) : null;
      await record(marketState, "completed-not-promoted", { reason, nextCycleAt: marketState.nextCycleAt });
      await notify(marketState, "TRAINING_COMPLETED_NOT_PROMOTED", `${marketState.market} 训练完成但未晋级`, `连续 ${marketState.maxAttempts} 个候选均已完成训练，但没有通过固定样本外门槛：${reason}。旧 Champion 未被覆盖；等待新增数据、计划中的周训练或手动返工。`, "warning");
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
    marketState.evaluation.promotionEvidence = await persistPromotionEvidence(marketState, marketState.evaluation, {
      jobId: context.jobId || marketState.activeJobId,
      dataVersion: null,
      planSignature: JSON.stringify(marketState.currentPlan || {}),
    });
    return scheduleRework(state, marketState, reason, { runtimeFailure: true, failureClass: context.stage || "training_job" });
  }

  async function handleComplete(state, marketState, job, context = {}) {
    marketState.status = "evaluating";
    let evidenceJob = job;
    let training = trainingResult(evidenceJob?.result || {});
    // The task centre keeps a compact SQLite index for fast listing. A
    // completed-job callback may therefore carry only resultSummary even
    // though the immutable JSON artifact contains the full training result.
    // Rehydrate once before evaluating so a successful OOF run can never be
    // converted into a false zero-sample rejection.
    if (!training && evidenceJob?.id) {
      const hydrated = await options.getJob(evidenceJob.id, { includeResult: true });
      if (trainingResult(hydrated?.result || {})) {
        evidenceJob = hydrated;
        training = trainingResult(evidenceJob.result || {});
      }
    }
    const dataVersion = training?.manifest?.data_version || null;
    const planSignature = JSON.stringify(marketState.currentPlan || {});
    const repeatedEvidence = context.recheck !== true && Boolean(
      dataVersion
      && marketState.lastDataVersion === dataVersion
      && marketState.lastCompletedPlanSignature === planSignature
    );
    marketState.evaluation = evaluateTrainingResult(evidenceJob?.result || {}, { thresholds: config.thresholds });
    marketState.evaluation.promotionEvidence = await persistPromotionEvidence(marketState, marketState.evaluation, {
      jobId: evidenceJob.id,
      dataVersion,
      planSignature,
      testSetSignature: dataVersion && marketState.evaluation.modelVersion
        ? `${dataVersion}:${marketState.evaluation.modelVersion}`
        : null,
      kernelDecision: training?.productionEligibility || null,
      kernelChecks: marketState.evaluation.kernelChecks,
      kernelFailedChecks: marketState.evaluation.kernelFailedChecks,
      lockbox: training?.researchLockbox || null,
      lockboxCreatedBeforeFit: training?.manifest?.lockbox_created_before_fit === true
        || training?.manifest?.lockboxCreatedBeforeFit === true,
      comparisonKey: training?.manifest?.comparison_key || training?.manifest?.comparisonKey || null,
      comparisonKeyFields: training?.manifest?.comparison_key_fields || training?.manifest?.comparisonKeyFields || null,
      candidateStatus: training?.manifest?.candidate_status || training?.manifest?.candidateStatus || null,
      comparison: training?.comparisonEvidence || training?.pairwiseComparison || null,
    });
    marketState.lastCompletedAt = iso();
    marketState.gateDecision = deterministicGateDecision(marketState.evaluation, { requireEvidence: true, market: marketState.market });
    await record(marketState, "gate-evaluation-started", {
      jobId: evidenceJob.id,
      evaluation: marketState.evaluation,
      gateDecision: marketState.gateDecision,
      dataVersion,
      repeatedEvidence,
      recheck: context.recheck === true,
    });
    marketState.lastDataVersion = dataVersion || marketState.lastDataVersion;
    marketState.lastCompletedPlanSignature = planSignature;
    await saveState();
    if (repeatedEvidence) {
      marketState.status = "completed_not_promoted";
      marketState.activeJobId = null;
      marketState.lastError = "训练数据版本与参数均未变化；已停止重复拟合。";
      marketState.nextActionAt = null;
      marketState.nextCycleAt = config.autoCycleEnabled ? iso(Date.now() + config.attentionRetryMs) : null;
      await record(marketState, "unchanged-data", {
        jobId: evidenceJob.id,
        dataVersion,
        reason: marketState.lastError,
      });
      await notify(marketState, "TRAINING_UNCHANGED_DATA", `${marketState.market} 未重复训练`, "本轮数据版本与训练方案均未变化，候选未晋级，也不会安排相同返工。等待新增已解析标签或新的 PIT 数据。", "info");
      await saveState();
      return marketState;
    }
    if (!marketState.evaluation.passed) {
      const failedLabels = marketState.evaluation.checks
        .filter((check) => check.blocking && !check.passed)
        .map((check) => check.label);
      await record(marketState, "gate-evaluation-complete", {
        jobId: evidenceJob.id,
        evaluation: marketState.evaluation,
        gateDecision: marketState.gateDecision,
        accepted: false,
        reviewMode: "deterministic_only",
      });
      return scheduleRework(
        state,
        marketState,
        failedLabels.join("；") || "固定样本外验收未通过",
        { runtimeFailure: false, failureClass: "evidence" },
      );
    }
    await record(marketState, "gate-evaluation-complete", {
      jobId: job.id,
      evaluation: marketState.evaluation,
      gateDecision: marketState.gateDecision,
      accepted: true,
      reviewMode: "deterministic_only",
    });
    marketState.status = "accepted";
    marketState.activeJobId = null;
    marketState.lastError = null;
    marketState.lastAcceptedAt = marketState.lastCompletedAt;
    marketState.nextActionAt = null;
    marketState.nextCycleAt = iso(Date.now() + config.cadenceMs);
    await record(marketState, "accepted", {
      jobId: job.id,
      modelVersion: marketState.evaluation.modelVersion,
      acceptanceLevel: marketState.evaluation.acceptanceLevel,
      score: marketState.evaluation.score,
      gateDecision: marketState.gateDecision,
      nextCycleAt: marketState.nextCycleAt,
    });
    await notify(marketState, "TRAINING_ACCEPTED", `${marketState.market} 模型训练已通过`, `版本 ${marketState.evaluation.modelVersion || "未命名"} 已通过固定 OOF、PIT、校准、漂移与成本后收益门槛，得分 ${marketState.evaluation.score}/100。`, "success");
    await saveState();
    return marketState;
  }

  async function startCycle(state, marketState, reason = "scheduled", planOverrides = {}) {
    marketState.cycleId = `${marketState.market}-${Date.now()}-${randomUUID().slice(0, 6)}`;
    marketState.attempt = 1;
    marketState.maxAttempts = config.maxAttempts;
    marketState.currentPlan = { ...basePlan(marketState.market), ...planOverrides };
    marketState.evaluation = null;
    marketState.gateDecision = null;
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
      if (!["training", "evaluating", "reviewing"].includes(marketState.status) || !marketState.activeJobId) continue;
      const job = await options.getJob(marketState.activeJobId);
      const jobAge = now - new Date(job?.updatedAt || marketState.lastStartedAt || 0).getTime();
      if (!job || !Number.isFinite(jobAge)) {
        await handleFailure(state, marketState, `训练 Job 丢失或超过 ${Math.round(config.maxJobAgeMs / 60000)} 分钟无进展。`, { stage: "job-stale", jobId: marketState.activeJobId });
        continue;
      }
      if (job.status === "queued") {
        if (jobAge > config.maxQueuedJobAgeMs) {
          await handleFailure(state, marketState, `训练 Job 在队列中等待超过 ${Math.round(config.maxQueuedJobAgeMs / 60000)} 分钟。`, { stage: "job-queue-stale", jobId: job.id });
          continue;
        }
        continue;
      }
      if (jobAge > config.maxJobAgeMs) {
        await handleFailure(state, marketState, `训练 Job 丢失或超过 ${Math.round(config.maxJobAgeMs / 60000)} 分钟无进展。`, { stage: "job-stale", jobId: marketState.activeJobId });
        continue;
      }
      if (["failed", "cancelled"].includes(job.status)) {
        await handleFailure(
          state,
          marketState,
          job.error || (job.status === "cancelled" ? "Training job was cancelled." : "Training job failed."),
          { stage: job.status === "cancelled" ? "job-cancelled" : "job-failed", jobId: job.id },
        );
        continue;
      }
      if (job.status === "complete") {
        await handleComplete(state, marketState, job);
      }
    }

    for (const marketState of Object.values(state.markets)) {
      if (!marketState.enabled) continue;
      if (marketState.manualPaused === true || marketState.status === "paused") continue;
      // Keep the queue durable while another market owns the heavy worker.
      // The old early return above prevented later markets from being
      // reconsidered after a long OOF run. Re-arm the wake-up time instead of
      // leaving a stale queued state that looked abandoned in the UI.
      if (anotherMarketRunning(state, marketState.market)) {
        const nextAction = new Date(marketState.nextActionAt || 0).getTime();
        if (["queued", "rework_scheduled"].includes(marketState.status) && (!nextAction || nextAction <= now)) {
          marketState.nextActionAt = iso(now + config.retryDelayMs);
          await record(marketState, "queued", { reason: "another-market-running", blockedBy: Object.values(state.markets).find((row) => row.market !== marketState.market && ["training", "evaluating", "reviewing"].includes(row.status))?.market || null, nextActionAt: marketState.nextActionAt });
          await saveState();
        }
        continue;
      }
      const nextAction = new Date(marketState.nextActionAt || 0).getTime();
      const manuallyQueued = marketState.manualQueued === true;
      const autoReworkAllowed = config.autoReworkEnabled && marketState.status === "rework_scheduled";
      const queueLaunchAllowed = marketState.status === "queued" && (config.autoReworkEnabled || manuallyQueued);
      if ((queueLaunchAllowed || autoReworkAllowed) && (!nextAction || nextAction <= now)) {
        if (marketState.status === "rework_scheduled") marketState.attempt += 1;
        marketState.manualQueued = false;
        return launchAttempt(state, marketState, marketState.status === "queued" ? "queued" : "automatic-rework");
      }
    }

    for (const marketState of Object.values(state.markets).sort((left, right) => number(left.queueOrder, 0) - number(right.queueOrder, 0))) {
      if (!marketState.enabled) continue;
      if (marketState.manualPaused === true || marketState.status === "paused") continue;
      const nextCycle = new Date(marketState.nextCycleAt || 0).getTime();
      // A completed-but-rejected run is an evidence decision, not a cadence
      // trigger. Re-running it on the same frozen data manufactures training
      // counts and can starve the other markets. New data, a changed
      // hypothesis, or an explicit manual request must re-arm the cycle.
      if (config.autoCycleEnabled && ["idle", "accepted"].includes(marketState.status) && (!nextCycle || nextCycle <= now)) {
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
    marketState.manualPaused = false;
    state.enabled = true;
    if (["training", "evaluating", "reviewing"].includes(marketState.status)) {
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "already-running" });
      await saveState();
      return { accepted: false, reason: "already-running", market, state: marketState };
    }
    const requestedMode = ["evaluate", "incremental", "weekly", "full"].includes(String(payload.mode || "").toLowerCase())
      ? String(payload.mode).toLowerCase()
      : "weekly";
    const changedHypothesis = String(payload.changedHypothesis || payload.changed_hypothesis || "").trim();
    if (requestedMode === "evaluate") {
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "redirect-evidence-refresh" });
      await saveState();
      return { accepted: false, reason: "use-evidence-refresh-job", market, state: marketState };
    }
    if (!changedHypothesis) {
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "rejected-governance" });
      await saveState();
      return { accepted: false, reason: "changedHypothesis-required", market, state: marketState };
    }
    const requestedPlan = {
      ...basePlan(market),
      trainingMode: requestedMode,
      mode: requestedMode,
      resume: payload.resume === true,
      jobType: "model_experiment",
      changedHypothesis,
      ...(requestedMode === "incremental" ? { limit: Math.min(120, config.baseSymbolLimit), foldCount: 3, testDates: 60 } : {}),
      ...(requestedMode === "full" ? { limit: config.maxSymbols, range: config.ranges[market] || "10y", foldCount: 5, testDates: 120 } : {}),
    };
    if (anotherMarketRunning(state, market)) {
      marketState.status = "queued";
      marketState.cycleId = marketState.cycleId || `${market}-${Date.now()}-${randomUUID().slice(0, 6)}`;
      marketState.attempt = 1;
      marketState.currentPlan = requestedPlan;
      marketState.nextActionAt = iso();
      marketState.manualQueued = true;
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "queued" });
      await record(marketState, "queued", { reason: payload.reason || "manual", manual: true });
      await saveState();
      return { accepted: true, queued: true, market, state: marketState };
    }
    if (marketState.status === "rework_scheduled" && marketState.currentPlan) {
      marketState.currentPlan = { ...marketState.currentPlan, jobType: "model_experiment", changedHypothesis };
      marketState.attempt = Math.min(marketState.maxAttempts, Math.max(1, number(marketState.attempt, 0) + 1));
      marketState.manualQueued = false;
      await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "rework-started" });
      await launchAttempt(state, marketState, "manual-rework");
      return { accepted: true, queued: false, rework: true, market, state: marketState };
    }
    await recordOperatorAction(marketState, "run-requested", { ...payload, outcome: "started" });
    await startCycle(state, marketState, payload.reason || "manual", {
      trainingMode: requestedMode,
      mode: requestedMode,
      jobType: "model_experiment",
      changedHypothesis,
      ...(requestedMode === "incremental" ? { limit: Math.min(120, config.baseSymbolLimit), foldCount: 3, testDates: 60 } : {}),
      ...(requestedMode === "full" ? { limit: config.maxSymbols, range: config.ranges[market] || "10y", foldCount: 5, testDates: 120 } : {}),
    });
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

  async function controlInternal(payload = {}) {
    const state = await readState();
    const market = markets.includes(String(payload.market || "").toUpperCase()) ? String(payload.market).toUpperCase() : markets[0];
    const marketState = state.markets[market];
    const action = String(payload.action || "").toLowerCase();
    if (!marketState) return { accepted: false, reason: "unknown-market", market };
    if (["pause", "暂停"].includes(action)) {
      marketState.manualPaused = true;
      marketState.manualQueued = false;
      marketState.nextActionAt = null;
      if (["queued", "rework_scheduled"].includes(marketState.status)) marketState.status = "paused";
      await recordOperatorAction(marketState, "queue-paused", { ...payload, outcome: "paused" });
      await saveState();
      return { accepted: true, action: "pause", market, state: marketState };
    }
    if (["resume", "start", "开始", "恢复"].includes(action)) {
      marketState.manualPaused = false;
      if (["paused", "rework_scheduled"].includes(marketState.status) && marketState.currentPlan) {
        await recordOperatorAction(marketState, "queue-resumed", { ...payload, outcome: "rework-start-requested" });
        await saveState();
        return triggerInternal({
          market,
          mode: marketState.currentPlan.trainingMode || marketState.currentPlan.mode || "weekly",
          reason: "manual-rework",
          source: payload.source || "task-center",
          resume: true,
        });
      }
      marketState.manualQueued = true;
      if (marketState.status === "paused") marketState.status = "queued";
      marketState.nextActionAt = iso();
      await recordOperatorAction(marketState, "queue-resumed", { ...payload, outcome: "queued" });
      await saveState();
      await tickInternal("manual-task-center-start");
      return { accepted: true, action: "resume", market, state: marketState };
    }
    if (["cancel", "取消"].includes(action)) {
      marketState.manualPaused = false;
      marketState.manualQueued = false;
      marketState.nextActionAt = null;
      marketState.activeJobId = null;
      marketState.status = "completed_not_promoted";
      await recordOperatorAction(marketState, "queue-cancelled", { ...payload, outcome: "cancelled" });
      await saveState();
      return { accepted: true, action: "cancel", market, state: marketState };
    }
    if (["up", "down", "move", "上移", "下移"].includes(action)) {
      const ordered = markets.slice().sort((left, right) => number(state.markets[left]?.queueOrder, markets.indexOf(left)) - number(state.markets[right]?.queueOrder, markets.indexOf(right)));
      const index = ordered.indexOf(market);
      const requestedPosition = Number(payload.position);
      const target = action === "move" && Number.isFinite(requestedPosition)
        ? Math.max(0, Math.min(ordered.length - 1, Math.trunc(requestedPosition)))
        : index + (["down", "下移"].includes(action) ? 1 : -1);
      if (index >= 0 && target >= 0 && target < ordered.length) {
        const other = ordered[target];
        if (action === "move") {
          ordered.splice(index, 1);
          ordered.splice(target, 0, market);
          ordered.forEach((key, order) => { state.markets[key].queueOrder = order; });
        } else {
          const currentOrder = state.markets[market].queueOrder;
          state.markets[market].queueOrder = state.markets[other].queueOrder;
          state.markets[other].queueOrder = currentOrder;
        }
        await recordOperatorAction(marketState, "queue-reordered", { ...payload, outcome: "reordered", changes: [{ market, other, direction: action }] });
        await saveState();
      }
      return { accepted: true, action, market, order: markets.slice().sort((left, right) => number(state.markets[left]?.queueOrder, markets.indexOf(left)) - number(state.markets[right]?.queueOrder, markets.indexOf(right))).map((key) => ({ market: key, queueOrder: state.markets[key].queueOrder })), state: marketState };
    }
    return { accepted: false, reason: "unsupported-action", action, market, state: marketState };
  }

  async function reviewLatestInternal(payload = {}) {
    const state = await readState();
    const market = markets.includes(String(payload.market || "").toUpperCase()) ? String(payload.market).toUpperCase() : markets[0];
    const marketState = state.markets[market];
    const requestedJobId = String(payload.jobId || "").trim();
    if (requestedJobId) {
      const requestedJob = await options.getJob(requestedJobId);
      if (!requestedJob || requestedJob.status !== "complete" || !requestedJob.result) {
        await recordOperatorAction(marketState, "review-job", { ...payload, outcome: "no-complete-job", jobId: requestedJobId });
        await saveState();
        return { accepted: false, reason: "no-complete-job", market, jobId: requestedJobId, state: marketState };
      }
      // Explicit artifact reconciliation is intentionally separate from the
      // latest-event lookup. It lets a durable completed job be re-verified
      // after a later cancelled duplicate overwrote the visible supervisor
      // pointer, without retraining or changing any metric.
      state.enabled = true;
      marketState.enabled = true;
      marketState.status = "evaluating";
      marketState.activeJobId = requestedJob.id;
      marketState.lastError = null;
      await recordOperatorAction(marketState, "review-job", { ...payload, outcome: "started", jobId: requestedJob.id });
      await saveState();
      const reviewed = await handleComplete(state, marketState, requestedJob, { recheck: true });
      return { accepted: true, market, jobId: requestedJob.id, state: reviewed, reconciled: true };
    }
    if (["training", "evaluating", "reviewing"].includes(marketState.status)) {
      // A restart can leave the persisted supervisor state one tick behind a
      // completed background job. Reconcile the durable job before reporting
      // "already running", otherwise a finished report can never be reviewed.
      const activeJob = marketState.activeJobId ? await options.getJob(marketState.activeJobId) : null;
      if (activeJob?.status === "complete" && activeJob.result) {
        marketState.status = "evaluating";
        const reviewed = await handleComplete(state, marketState, activeJob, { recheck: true });
        return { accepted: true, market, jobId: activeJob.id, state: reviewed, reconciled: true };
      }
      await recordOperatorAction(marketState, "review-latest", { ...payload, outcome: "already-running" });
      await saveState();
      return { accepted: false, reason: "already-running", market, state: marketState };
    }
    const latestJobEvent = (marketState.history || []).find((event) => event.jobId && ["gate-evaluation-complete", "gate-evaluation-started", "review-complete", "review-started", "job-started"].includes(event.type));
    const job = latestJobEvent?.jobId ? await options.getJob(latestJobEvent.jobId) : null;
    if (!job || job.status !== "complete" || !job.result) {
      await recordOperatorAction(marketState, "review-latest", { ...payload, outcome: "no-complete-job", jobId: latestJobEvent?.jobId || null });
      await saveState();
      return { accepted: false, reason: "no-complete-job", market, state: marketState };
    }
    state.enabled = true;
    marketState.enabled = true;
    marketState.status = "evaluating";
    marketState.activeJobId = job.id;
    marketState.lastError = null;
    await recordOperatorAction(marketState, "review-latest", { ...payload, outcome: "started", jobId: job.id });
    await saveState();
    const reviewed = await handleComplete(state, marketState, job, { recheck: true });
    return { accepted: true, market, jobId: job.id, state: reviewed };
  }

  function publicStatus(state, market = null) {
    const selected = market ? state.markets?.[String(market).toUpperCase()] : null;
    const compactEvent = (event) => {
      const evaluation = event?.evaluation;
      return {
        id: event?.id,
        type: event?.type,
        market: event?.market,
        cycleId: event?.cycleId,
        attempt: event?.attempt,
        createdAt: event?.createdAt,
        jobId: event?.jobId || null,
        stage: event?.stage || null,
        provider: event?.provider || null,
        label: event?.label || null,
        model: event?.model || null,
        available: event?.available,
        disabled: event?.disabled,
        verdict: event?.verdict || null,
        score: event?.score ?? null,
        accepted: event?.accepted,
        action: event?.action || null,
        outcome: event?.outcome || null,
        operatorNote: compactOperatorNote(event?.operatorNote),
        reason: event?.reason ? compactError(event.reason) : "",
        rationale: event?.rationale ? compactError(event.rationale) : "",
        error: event?.error ? compactError(event.error) : "",
        blockingIssues: Array.isArray(event?.blockingIssues) ? event.blockingIssues.slice(0, 4).map(compactError) : [],
        recommendedActions: Array.isArray(event?.recommendedActions) ? event.recommendedActions.slice(0, 8) : [],
        nextActionAt: event?.nextActionAt || null,
        nextCycleAt: event?.nextCycleAt || null,
        modelVersion: event?.modelVersion || null,
        dataVersion: event?.dataVersion || null,
        repeatedEvidence: event?.repeatedEvidence === true,
        evaluation: evaluation ? {
          passed: evaluation.passed === true,
          score: evaluation.score ?? null,
          acceptanceLevel: evaluation.acceptanceLevel || null,
          modelVersion: evaluation.modelVersion || null,
          deploymentStatus: evaluation.deploymentStatus || null,
          promotionEvidence: evaluation.promotionEvidence ? {
            evidenceId: evaluation.promotionEvidence.evidenceId || null,
            decision: evaluation.promotionEvidence.decision || "hold_shadow",
            accepted: evaluation.promotionEvidence.accepted === true,
            generatedAt: evaluation.promotionEvidence.generatedAt || null,
          } : null,
          failedChecks: (evaluation.failedChecks || []).slice(0, 12),
          checks: (evaluation.checks || []).map((check) => ({
            id: check.id,
            label: check.label,
            passed: check.passed === true,
            blocking: check.blocking !== false,
          })).slice(0, 24),
          summary: evaluation.summary || {},
        } : null,
      };
    };
    const compactMarket = (value) => {
      const orphanQueue = value?.status === "queued"
        && !value?.activeJobId
        && value?.manualQueued !== true
        && !config.autoCycleEnabled
        && !config.autoReworkEnabled;
      return {
      ...value,
      ...(orphanQueue ? {
        status: "completed_not_promoted",
        nextActionAt: null,
        nextCycleAt: null,
        lastError: value.lastError || "孤立排队状态已对账：当前没有实际训练 Job，等待新数据或人工启动。",
      } : {}),
      // Detailed event payloads and full gate reports belong to the paged logs
      // endpoint. Keeping this state summary bounded prevents a strategy-page
      // poll from serializing every historical evaluation for every market.
      history: (value?.history || []).slice(0, 12).map(compactEvent),
    };
    };
    return {
      available: true,
      enabled: state.enabled !== false,
      reviewMode: "deterministic_only",
      aiReviewEnabled: false,
      updatedAt: state.updatedAt,
      config: {
        maxAttempts: config.maxAttempts,
        autoCycleEnabled: config.autoCycleEnabled,
        autoReworkEnabled: config.autoReworkEnabled,
        cadenceMs: config.cadenceMs,
        retryDelayMs: config.retryDelayMs,
        attentionRetryMs: config.attentionRetryMs,
        thresholds: config.thresholds,
      },
      market: selected ? compactMarket(selected) : null,
      markets: Object.fromEntries(Object.entries(state.markets || {}).map(([key, value]) => [key, compactMarket(value)])),
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
    control: (payload) => serializedCall(() => controlInternal(payload)),
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
  deterministicGateDecision,
  evaluateTrainingResult,
};
