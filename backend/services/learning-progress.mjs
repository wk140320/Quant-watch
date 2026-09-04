import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARKETS = Object.freeze(["ASX", "US", "CN"]);
const TERMINAL = new Set(["complete", "failed", "cancelled"]);

function marketCode(value) {
  const market = String(value || "ASX").toUpperCase();
  return MARKETS.includes(market) ? market : "ASX";
}

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

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return { low: 0, high: 0 };
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { low: clamp((center - spread) * 100, 0, 100), high: clamp((center + spread) * 100, 0, 100) };
}

function outcomeReturn(sample = {}) {
  const value = sample?.outcome?.forwardReturnPct ?? sample?.outcome?.finalReturnPct ?? sample?.actualReturn;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function resolvedSample(sample = {}) {
  return sample?.outcome?.resolved === true && outcomeReturn(sample) !== null;
}

function predictionProbability(sample = {}) {
  const confidence = clamp(sample.predictionConfidence ?? sample.confidence ?? 50, 0, 100) / 100;
  return String(sample.direction || "upside").toLowerCase() === "downside" ? 1 - confidence : confidence;
}

function sampleDate(sample = {}) {
  return String(sample.signalAt || sample.asOfDate || sample.createdAt || "").slice(0, 10);
}

function evidenceMetrics(samples = []) {
  const unique = new Map();
  for (const sample of samples.filter(resolvedSample)) {
    const key = String(sample.predictionId || sample.id || `${sample.market}:${sample.symbol}:${sampleDate(sample)}:${sample.horizonDays || 0}`);
    if (!unique.has(key)) unique.set(key, sample);
  }
  const rows = [...unique.values()];
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let brier = 0;
  const buckets = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, actual: 0 }));
  for (const sample of rows) {
    const actual = outcomeReturn(sample) >= 0 ? 1 : 0;
    const probability = predictionProbability(sample);
    const predicted = probability >= 0.5 ? 1 : 0;
    if (predicted && actual) tp += 1;
    else if (!predicted && !actual) tn += 1;
    else if (predicted) fp += 1;
    else fn += 1;
    brier += (probability - actual) ** 2;
    const bucket = buckets[Math.min(9, Math.floor(probability * 10))];
    bucket.count += 1;
    bucket.probability += probability;
    bucket.actual += actual;
  }
  const total = rows.length;
  const correct = tp + tn;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const specificity = tn + fp ? tn / (tn + fp) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const baseRate = total ? (tp + fn) / total : 0;
  const baseBrier = total ? rows.reduce((sum, sample) => sum + (baseRate - (outcomeReturn(sample) >= 0 ? 1 : 0)) ** 2, 0) / total : 0;
  const averageBrier = total ? brier / total : 0;
  const ece = total ? buckets.reduce((sum, bucket) => {
    if (!bucket.count) return sum;
    return sum + bucket.count / total * Math.abs(bucket.probability / bucket.count - bucket.actual / bucket.count);
  }, 0) : 0;
  const ranked = rows.slice().sort((left, right) => predictionProbability(right) - predictionProbability(left));
  const topCount = Math.max(0, Math.ceil(total * 0.1));
  const top = ranked.slice(0, topCount);
  const topHits = top.filter((sample) => outcomeReturn(sample) >= 0).length;
  return {
    accuracyPct: total ? correct / total * 100 : null,
    balancedAccuracyPct: total ? (recall + specificity) / 2 * 100 : null,
    precisionPct: total ? precision * 100 : null,
    recallPct: total ? recall * 100 : null,
    f1Pct: total ? f1 * 100 : null,
    brier: total ? averageBrier : null,
    brierSkill: total && baseBrier > 0 ? 1 - averageBrier / baseBrier : null,
    ecePct: total ? ece * 100 : null,
    topDecileAccuracyPct: top.length ? topHits / top.length * 100 : null,
    topDecileCount: top.length,
    topDecileCi95: wilson(topHits, top.length),
    accuracyCi95: wilson(correct, total),
    confusion: { tp, tn, fp, fn },
  };
}

function trainingArtifact(job = {}) {
  return job?.result?.productionTraining || job?.result?.result?.productionTraining || null;
}

function candidateStatusClass(value) {
  const status = String(value || "NO_MODEL").toUpperCase();
  if (status === "ELIGIBLE" || status === "PRODUCTION_ELIGIBLE") return "ELIGIBLE";
  if (status.startsWith("PARTIAL")) return "PARTIAL";
  if (status === "AVAILABLE") return "AVAILABLE";
  if (status.includes("NO_MODEL")) return "NO_MODEL";
  if (status.includes("INSUFFICIENT")) return "EVIDENCE_INSUFFICIENT";
  return status;
}

function candidateEvidenceSemantics(model = {}, training = {}, candidateStatus = "NO_MODEL") {
  const statusClass = candidateStatusClass(candidateStatus);
  const families = model?.modelFamilyStatus || training?.manifest?.model_family_status || {};
  const familyAvailable = (name) => String(families?.[name] || "").toUpperCase() === "AVAILABLE";
  const artifactProduced = Boolean(training && (training.manifest || model || training.dataset));
  const predictiveModelProduced = Boolean(
    model?.predictiveModelProduced === true
    || (familyAvailable("direction") && model?.available !== false),
  );
  const tradeModelProduced = Boolean(
    model?.tradeModelProduced === true
    || (predictiveModelProduced && familyAvailable("ranking") && model?.longTradeGate?.active === true),
  );
  const promotionEligible = Boolean(model?.productionEvidencePassed === true || statusClass === "ELIGIBLE");
  const evidenceType = statusClass === "PARTIAL"
    ? "partial_oof_attempt"
    : statusClass === "NO_MODEL" || statusClass === "EVIDENCE_INSUFFICIENT"
      ? "no_model_attempt"
      : promotionEligible
        ? "eligible_strict_oof"
        : "strict_oof";
  return { statusClass, evidenceType, artifactProduced, predictiveModelProduced, tradeModelProduced, promotionEligible };
}

function isStrictOofEvidence(point = {}) {
  return ["strict_oof", "eligible_strict_oof"].includes(String(point.evidenceType || ""));
}

function fiveDayModel(training = {}) {
  return (training?.horizonModels || []).find((model) => Number(model?.horizon) === 5) || null;
}

function pointFromTrainingJob(job = {}) {
  const training = trainingArtifact(job);
  const model = fiveDayModel(training);
  const candidateStatus = String(
    model?.status
      || model?.trainingStatus
      || training?.manifest?.candidate_status
      || training?.manifest?.candidateStatus
      || (model?.available ? "AVAILABLE" : "NO_MODEL"),
  ).toUpperCase();
  const semantics = candidateEvidenceSemantics(model, training, candidateStatus);
  const dataset = training?.dataset || {};
  const panelSampling = dataset.panelSampling || {};
  const pathMetrics = model?.metrics || {};
  const metrics = model?.directionMetrics || pathMetrics;
  const accuracy = metrics.directionAccuracyPct ?? metrics.accuracyPct ?? metrics.accuracy;
  const foldMetrics = Array.isArray(model?.foldMetrics) ? model.foldMetrics : [];
  const point = {
    id: `run-${job.id}`,
    sourceJobId: job.id,
    trainingRunId: job.trainingRunId || job.id,
    modelVersion: training?.manifest?.model_version || null,
    market: marketCode(job.market || job.payload?.market),
    horizon: 5,
    mode: job.payload?.mode || job.payload?.trainingMode || "weekly",
    createdAt: job.updatedAt || job.createdAt || iso(),
    status: job.status,
    runtimeVersion: number(job.runtimeVersion, 1),
    evidenceType: semantics.evidenceType,
    // `available` means that some strict OOF evidence exists.  It is not a
    // promotion decision: partial/no-model candidates must remain visible as
    // attempts without being presented as eligible models.
    attemptRecorded: true,
    artifactProduced: semantics.artifactProduced,
    predictiveModelProduced: semantics.predictiveModelProduced,
    tradeModelProduced: semantics.tradeModelProduced,
    promotionEligible: semantics.promotionEligible,
    candidateStatus,
    modelFamilyStatus: model?.modelFamilyStatus || training?.manifest?.model_family_status || {},
    datasetSignature: training?.manifest?.data_version || job.signature || null,
    samples: {
      rawRows: number(dataset.rawRows),
      eligibleRows: number(dataset.eligibleRows ?? panelSampling.eligiblePanelRows ?? dataset.rawRows),
      effectiveRows: number(
        dataset.effectiveRows
        ?? dataset.fittedRows
        ?? panelSampling.sampledPanelRows
        ?? model?.rowCount
        ?? dataset.validRows,
      ),
      fittedRows: number(dataset.fittedRows ?? model?.rowCount ?? panelSampling.sampledPanelRows),
      oofRows: number(model?.oofRows),
      independentDates: number(metrics.testDates || pathMetrics.testDates),
      targetEvents: number(model?.eventCounts?.target),
      stopEvents: number(model?.eventCounts?.stop),
      symbolCount: number(dataset.symbolCount),
    },
    metrics: {
      accuracyPct: Number.isFinite(Number(accuracy)) ? number(accuracy) : null,
      balancedAccuracyPct: Number.isFinite(Number(metrics.balancedAccuracyPct)) ? number(metrics.balancedAccuracyPct) : null,
      precisionPct: Number.isFinite(Number(metrics.precisionPct)) ? number(metrics.precisionPct) : null,
      recallPct: Number.isFinite(Number(metrics.recallPct)) ? number(metrics.recallPct) : null,
      f1Pct: Number.isFinite(Number(metrics.f1Pct)) ? number(metrics.f1Pct) : null,
      brier: Number.isFinite(Number(metrics.brier)) ? number(metrics.brier) : null,
      brierSkill: Number.isFinite(Number(metrics.brierSkillScore)) ? number(metrics.brierSkillScore) : null,
      ecePct: Number.isFinite(Number(metrics.ecePct)) ? number(metrics.ecePct) : null,
      topDecileAccuracyPct: Number.isFinite(Number(model?.rankingMetrics?.top10DirectionHitRatePct))
        ? number(model.rankingMetrics.top10DirectionHitRatePct)
        : Number.isFinite(Number(metrics.selectiveTop10AccuracyPct))
          ? number(metrics.selectiveTop10AccuracyPct)
          : null,
      topDecileTargetFirstPct: Number.isFinite(Number(model?.rankingMetrics?.top10TargetFirstRatePct))
        ? number(model.rankingMetrics.top10TargetFirstRatePct)
        : Number.isFinite(Number(metrics.topDecileTargetRate))
          ? number(metrics.topDecileTargetRate)
          : null,
    },
    folds: foldMetrics.map((fold) => ({
      id: fold.fold ?? fold.id ?? null,
      accuracyPct: fold.directionBalancedAccuracyPct ?? fold.directionAccuracyPct ?? fold.accuracyPct ?? null,
      positive: fold.positive === true || number(fold.netReturnPct) > 0,
    })),
    blockers: [],
    promotion: null,
    failureCategory: job.failureCategory || null,
    error: job.error || null,
  };
  if (!training) point.blockers.push("没有形成生产训练产物");
  if (!model?.available) point.blockers.push("5日模型没有严格 OOF 预测");
  if (["NO_MODEL", "PARTIAL", "EVIDENCE_INSUFFICIENT"].includes(semantics.statusClass)) {
    point.blockers.push(`候选状态为 ${candidateStatus}，不能作为晋级模型`);
  }
  if (point.samples.oofRows < 1_000) point.blockers.push(`OOF ${point.samples.oofRows}/1000`);
  if (point.samples.independentDates < 120) point.blockers.push(`独立测试日 ${point.samples.independentDates}/120`);
  return point;
}

function promotionDecision(candidate, champion) {
  const blockers = [...(candidate.blockers || [])];
  const metrics = candidate.metrics || {};
  const samples = candidate.samples || {};
  if (candidate.status !== "complete") blockers.push(`训练状态为 ${candidate.status}`);
  if (!isStrictOofEvidence(candidate)) blockers.push("仅严格 OOF 训练可晋级");
  if (["NO_MODEL", "PARTIAL", "EVIDENCE_INSUFFICIENT"].includes(String(candidate.candidateStatus || "").toUpperCase())) {
    blockers.push(`候选状态 ${candidate.candidateStatus} 不允许晋级`);
  }
  if (Object.values(candidate.modelFamilyStatus || {}).some((status) => {
    const value = status && typeof status === "object" ? status.status : status;
    return ["NO_MODEL", "PARTIAL", "EVIDENCE_INSUFFICIENT"].includes(String(value || "").toUpperCase());
  })) {
    blockers.push("至少一个核心模型族没有有效 OOF 专家");
  }
  if (samples.oofRows < 1_000) blockers.push("OOF 测试样本不足 1000");
  if (samples.independentDates < 120) blockers.push("独立测试日期不足 120");
  if (!(number(metrics.brierSkill, -1) > 0)) blockers.push("Brier Skill 未大于 0");
  if (!(number(metrics.ecePct, 100) <= 5)) blockers.push("ECE 高于 5%");
  const folds = candidate.folds || [];
  if (folds.length < 5 || folds.filter((fold) => fold.positive).length < 4) blockers.push("未达到 5 折中至少 4 折为正");
  if (champion && number(metrics.accuracyPct, -1) < number(champion.metrics?.accuracyPct, 0) + 1) blockers.push("固定测试集准确率提升不足 1 个百分点");
  if (number(metrics.topDecileAccuracyPct, -1) < 57) blockers.push("高置信 Top 10% 命中率低于 57%");
  if (metrics.topDecileCi95 && number(metrics.topDecileCi95.low) <= 50) blockers.push("高置信命中率 95% 区间下界未超过 50%");
  return {
    promoted: blockers.length === 0,
    comparedWith: champion?.modelVersion || champion?.trainingRunId || null,
    blockers: [...new Set(blockers)],
    decidedAt: iso(),
  };
}

function challengerQuality(point = {}) {
  const metrics = point.metrics || {};
  const samples = point.samples || {};
  const strict = isStrictOofEvidence(point) && point.status === "complete" && point.predictiveModelProduced === true ? 1 : 0;
  return [
    strict,
    number(metrics.brierSkill, -10),
    number(metrics.balancedAccuracyPct ?? metrics.accuracyPct, -1) / 100,
    -number(metrics.ecePct, 100) / 100,
    Math.min(1, number(samples.independentDates) / 120),
    Math.min(1, number(samples.oofRows) / 1_000),
  ];
}

function isBetterChallenger(candidate, incumbent) {
  if (!incumbent) return true;
  const left = challengerQuality(candidate);
  const right = challengerQuality(incumbent);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return String(candidate.createdAt || "") > String(incumbent.createdAt || "");
}

function defaultState(market) {
  return {
    schemaVersion: 3,
    market,
    updatedAt: null,
    champion: null,
    latestAttempt: null,
    latestEligibleModel: null,
    latestRun: null,
    frozenBaseline: null,
    bestResearchArtifact: null,
    bestComparablePredictiveCandidate: null,
    bestChallenger: null,
    // Kept as a read-compatible alias for older frontends.
    challenger: null,
    points: [],
    importedJobs: [],
    frozenTest: { status: "provisional", reason: "尚未形成至少120个独立测试日期的固定测试集。" },
    schedule: {
      minuteCollectionMs: 120_000,
      minuteTrainingNewBars: 200,
      dailyCalibrationMinResolved: 20,
      weeklyTrainingMinResolved: 100,
      weeklyTrainingMinDates: 5,
      monthlyFullTraining: true,
      driftPsiTrigger: 0.25,
      emergencyEcePct: 10,
    },
  };
}

function createLearningProgressService(options = {}) {
  const basePath = options.basePath;
  const jobsPath = options.jobsPath;
  const predictionPathFor = options.predictionPathFor;
  const jobIndex = typeof options.jobIndex === "function" ? options.jobIndex : null;
  const publish = typeof options.publish === "function" ? options.publish : () => {};
  if (!basePath || !jobsPath || typeof predictionPathFor !== "function") throw new Error("Learning progress service requires persistence paths.");
  const memory = new Map();
  const backgroundImports = new Map();
  const observationRefreshes = new Map();

  const pathFor = (market) => join(basePath, `${marketCode(market).toLowerCase()}.json`);

  async function load(market) {
    const key = marketCode(market);
    if (memory.has(key)) return memory.get(key);
    const state = await readFile(pathFor(key), "utf8").then(JSON.parse).catch(() => defaultState(key));
    const normalized = { ...defaultState(key), ...state, market: key };
    const normalizePoint = (point) => {
      if (!point || typeof point !== "object") return point;
      const semantics = candidateEvidenceSemantics(
        {
          available: point.predictiveModelProduced === true || point.evidenceType === "strict_oof",
          productionEvidencePassed: point?.promotion?.promoted === true,
          modelFamilyStatus: point.modelFamilyStatus || {},
          longTradeGate: { active: point.tradeModelProduced === true },
        },
        { manifest: {}, dataset: point.samples || {} },
        point.candidateStatus || "NO_MODEL",
      );
      const samples = { ...(point.samples || {}) };
      if (number(samples.effectiveRows) <= 0 && number(samples.rawRows) > 0) {
        samples.effectiveRows = number(samples.fittedRows || samples.rawRows);
        samples.fittedRows = number(samples.fittedRows || samples.effectiveRows);
        samples.eligibleRows = number(samples.eligibleRows || samples.rawRows);
        samples.countSource = "legacy-derived-from-raw-rows";
      }
      return {
        ...point,
        evidenceType: semantics.evidenceType,
        attemptRecorded: true,
        artifactProduced: point.artifactProduced ?? semantics.artifactProduced,
        predictiveModelProduced: point.predictiveModelProduced ?? semantics.predictiveModelProduced,
        tradeModelProduced: point.tradeModelProduced ?? semantics.tradeModelProduced,
        samples,
        // Repair the old ambiguous flag on read. Promotion is determined only
        // by the immutable promotion decision, never by model availability.
        promotionEligible: point?.promotion?.promoted === true,
        candidateStatus: point.candidateStatus
          || (point?.promotion?.promoted === true ? "ELIGIBLE" : "REJECTED_LEGACY"),
      };
    };
    normalized.points = (Array.isArray(normalized.points) ? normalized.points : []).map(normalizePoint);
    normalized.latestRun = normalizePoint(normalized.latestRun);
    normalized.latestAttempt = normalizePoint(normalized.latestAttempt);
    normalized.latestEligibleModel = normalizePoint(normalized.latestEligibleModel);
    normalized.latestStrictRun = normalizePoint(normalized.latestStrictRun);
    normalized.bestChallenger = normalizePoint(normalized.bestChallenger);
    normalized.bestResearchArtifact = normalizePoint(normalized.bestResearchArtifact);
    normalized.bestComparablePredictiveCandidate = normalizePoint(normalized.bestComparablePredictiveCandidate);
    normalized.champion = normalizePoint(normalized.champion);
    normalized.bestResearchArtifact = normalized.bestResearchArtifact || normalized.bestChallenger || normalized.challenger || null;
    normalized.bestComparablePredictiveCandidate = normalized.bestComparablePredictiveCandidate
      || (normalized.bestResearchArtifact?.predictiveModelProduced === true ? normalized.bestResearchArtifact : null);
    normalized.bestChallenger = normalized.bestComparablePredictiveCandidate;
    normalized.challenger = normalized.bestComparablePredictiveCandidate;
    normalized.latestAttempt = normalized.latestAttempt || normalized.latestRun || normalized.points?.at?.(-1) || null;
    normalized.latestRun = normalized.latestRun || normalized.points?.at?.(-1) || null;
    memory.set(key, normalized);
    return memory.get(key);
  }

  async function save(state) {
    state.updatedAt = iso();
    await mkdir(basePath, { recursive: true });
    const target = pathFor(state.market);
    const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, target);
    memory.set(state.market, state);
    return state;
  }

  async function readPredictionSamples(market) {
    return readFile(predictionPathFor(market), "utf8")
      .then((text) => JSON.parse(text).samples || [])
      .catch(() => []);
  }

  async function observationalPoint(market) {
    const samples = await readPredictionSamples(market);
    const resolved = samples.filter(resolvedSample);
    const five = resolved.filter((sample) => Number(sample.horizonDays) === 5);
    const selected = five.length ? five : resolved;
    const dates = new Set(selected.map(sampleDate).filter(Boolean));
    const metrics = evidenceMetrics(selected);
    const digestRows = selected.map((sample) => JSON.stringify({
      id: String(sample.predictionId || sample.id || ""),
      resolvedAt: sample.resolvedAt || sample.outcome?.resolvedAt || null,
      entryPrice: sample.outcome?.entryPrice ?? null,
      entryDate: sample.outcome?.entryDate ?? null,
      outcome: sample.outcome?.firstEvent || sample.outcome?.label || null,
      returnPct: outcomeReturn(sample),
    })).sort();
    const digest = createHash("sha256").update(digestRows.join("|")).digest("hex").slice(0, 16);
    return {
      id: `observed-${marketCode(market).toLowerCase()}-${digest}`,
      market: marketCode(market),
      horizon: five.length ? 5 : null,
      createdAt: iso(),
      mode: "evaluate",
      status: "complete",
      evidenceType: five.length ? "live_observational" : "legacy_mixed_horizon",
      promotionEligible: false,
      datasetSignature: digest,
      samples: {
        rawRows: samples.length,
        resolvedRows: selected.length,
        uniquePredictions: selected.length,
        independentDates: dates.size,
      },
      metrics,
      blockers: five.length ? ["实时观察证据不能替代固定 OOF 测试"] : ["尚无已解析的5日预测；当前仅展示旧周期观察数据", "实时观察证据不能替代固定 OOF 测试"],
      promotion: { promoted: false, blockers: ["observational evidence"] },
    };
  }

  function emptyObservationalPoint(market) {
    const key = marketCode(market);
    return {
      id: `observed-${key.toLowerCase()}-empty`,
      market: key,
      horizon: null,
      createdAt: iso(),
      mode: "evaluate",
      status: "complete",
      evidenceType: "live_observational",
      promotionEligible: false,
      datasetSignature: null,
      samples: { rawRows: 0, resolvedRows: 0, uniquePredictions: 0, independentDates: 0 },
      metrics: evidenceMetrics([]),
      blockers: ["尚无已解析的5日预测"],
      promotion: { promoted: false, blockers: ["observational evidence unavailable"] },
    };
  }

  function scheduleBackgroundRefresh(key, state) {
    if (!jobIndex || backgroundImports.has(key)) return;
    const importPromise = importJobs(key, { scanLimit: 100 })
      .catch(() => state)
      .finally(() => backgroundImports.delete(key));
    backgroundImports.set(key, importPromise);
  }

  function scheduleObservationRefresh(key) {
    if (observationRefreshes.has(key)) return;
    const refresh = observationalPoint(key)
      .then((point) => {
        memory.set(`${key}:observed`, point);
        return point;
      })
      .catch(() => emptyObservationalPoint(key))
      .finally(() => observationRefreshes.delete(key));
    observationRefreshes.set(key, refresh);
  }

  async function recordPoint(market, point) {
    const state = await load(market);
    if (state.points.some((row) => row.id === point.id || (point.sourceJobId && row.sourceJobId === point.sourceJobId))) return state;
    const decision = promotionDecision(point, state.champion);
    point.promotion = decision;
    point.promotionEligible = decision.promoted === true;
    state.latestAttempt = point;
    state.latestRun = point;
    if (point.artifactProduced === true && isBetterChallenger(point, state.bestResearchArtifact)) {
      state.bestResearchArtifact = point;
    }
    if (decision.promoted) {
      state.champion = point;
      state.latestEligibleModel = point;
    } else if (isStrictOofEvidence(point) && point.predictiveModelProduced === true) {
      if (!state.frozenBaseline) {
        state.frozenBaseline = {
          ...point,
          frozenAt: iso(),
          purpose: "Immutable first strict-OOF comparison baseline",
        };
        state.frozenTest = {
          status: point.samples?.independentDates >= 120 ? "frozen" : "provisional",
          frozenAt: iso(),
          trainingRunId: point.trainingRunId || null,
          datasetSignature: point.datasetSignature || null,
          independentDates: number(point.samples?.independentDates),
          reason: point.samples?.independentDates >= 120
            ? "首个满足独立日期要求的严格 OOF 基线已冻结。"
            : "严格 OOF 基线已记录，但独立测试日期尚未达到120。",
        };
      }
      if (isBetterChallenger(point, state.bestComparablePredictiveCandidate)) state.bestComparablePredictiveCandidate = point;
    }
    state.bestChallenger = state.bestComparablePredictiveCandidate;
    state.challenger = state.bestComparablePredictiveCandidate;
    state.points.push(point);
    state.points = state.points.slice(-1_000);
    if (point.sourceJobId) state.importedJobs = [...new Set([...(state.importedJobs || []), point.sourceJobId])].slice(-5_000);
    await save(state);
    publish(decision.promoted ? "learning.model_promoted" : "learning.training_recorded", {
      market: state.market,
      trainingRunId: point.trainingRunId || null,
      modelVersion: point.modelVersion || null,
      promoted: decision.promoted,
      blockers: decision.blockers,
    });
    return state;
  }

  async function recordJob(job = {}) {
    if (job.type !== "backtest" || !TERMINAL.has(job.status)) return null;
    return recordPoint(job.market || job.payload?.market, pointFromTrainingJob(job));
  }

  async function evaluate(market, options = {}) {
    const point = await observationalPoint(market);
    point.mode = options.mode || "evaluate";
    point.reason = options.reason || "scheduled-evaluation";
    return recordPoint(market, point);
  }

  async function importJobs(market, options = {}) {
    const key = marketCode(market);
    const state = await load(key);
    const scanLimit = Math.max(1, Math.min(100, Number(options.scanLimit || 24)));
    let files = [];
    try {
      files = (await readdir(jobsPath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith("backtest-") && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
    } catch {
      return state;
    }
    let scanned = 0;
    for (const filename of files) {
      const jobId = filename.slice(0, -5);
      if ((state.importedJobs || []).includes(jobId)) continue;
      if (scanned >= scanLimit) break;
      scanned += 1;
      try {
        const job = JSON.parse(await readFile(join(jobsPath, filename), "utf8"));
        if (job.type !== "backtest" || marketCode(job.market || job.payload?.market) !== key || !TERMINAL.has(job.status)) continue;
        if ((state.importedJobs || []).includes(job.id)) continue;
        await recordJob(job);
      } catch {
        // Damaged job evidence is isolated and never blocks the progress view.
      }
    }
    return load(key);
  }

  function jobReliability(state) {
    const rows = (state.points || []).filter((point) => point.sourceJobId);
    const summarize = (items) => {
      const terminal = items.filter((job) => TERMINAL.has(job.status));
      const complete = terminal.filter((job) => job.status === "complete").length;
      const failed = terminal.filter((job) => job.status === "failed").length;
      return {
        total: items.length,
        terminal: terminal.length,
        complete,
        failed,
        successPct: terminal.length ? complete / terminal.length * 100 : null,
      };
    };
    const allTime = summarize(rows);
    const currentRuntime = summarize(rows.filter((job) => Number(job.runtimeVersion || 0) >= 3));
    return {
      ...currentRuntime,
      runtimeVersion: 3,
      currentRuntime,
      allTime,
      evidenceWindow: "persisted-learning-points",
      bounded: true,
    };
  }

  async function snapshot(market) {
    const key = marketCode(market);
    // Production serves a local-first progress view.  The evidence index is
    // updated in the background, so a large archived OOF file can never hold
    // the page request open.  Small unit-test fixtures without an index keep
    // the original synchronous import semantics.
    if (jobIndex) {
      const state = await load(key);
      scheduleBackgroundRefresh(key, state);
      scheduleObservationRefresh(key);
      const observed = memory.get(`${key}:observed`) || state.latestObservation || emptyObservationalPoint(key);
      const points = state.points
        .slice(-1_000)
        .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
        .slice(-180);
      const fixed = points.filter(isStrictOofEvidence);
      const rolling = points.filter((point) => point.evidenceType.includes("observational") || point.evidenceType === "legacy_mixed_horizon");
      if (!rolling.some((point) => point.id === observed.id)) rolling.push(observed);
      const latestStrictRun = fixed.at(-1) || null;
      return {
        available: true,
        market: key,
        updatedAt: state.updatedAt,
        champion: state.champion,
        latestAttempt: state.latestAttempt,
        latestEligibleModel: state.latestEligibleModel,
        bestResearchArtifact: state.bestResearchArtifact,
        bestComparablePredictiveCandidate: state.bestComparablePredictiveCandidate,
        latestRun: latestStrictRun || state.latestRun,
        latestStrictRun,
        latestObservation: observed,
        observed,
        curves: { fixed, rolling: rolling.slice(-180) },
        schedule: state.schedule,
        frozenTest: state.frozenTest,
        jobReliability: jobReliability(state),
        blockers: [
          ...(state.champion ? [] : ["尚无满足硬门槛的5日 Champion"]),
          ...(observed.samples.independentDates < 120 ? [`当前仅 ${observed.samples.independentDates} 个独立已解析日期`] : []),
          ...(jobReliability(state).terminal >= 5 && jobReliability(state).successPct < 95 ? ["Runtime V3 训练任务成功率尚未达到 95%"] : []),
        ],
        order_execution_enabled: false,
        refresh: { mode: "background-index", pendingJobsImport: backgroundImports.has(key), pendingObservation: observationRefreshes.has(key) },
      };
    }
    // Completed OOF artifacts are immutable evidence. Import a bounded batch on
    // every read so that a later observational tick can never hide a newer
    // strict training run merely because legacy points already exist.
    let state = await load(key);
    state = await importJobs(key, { scanLimit: 100 });
    const observed = await observationalPoint(key);
    const reliability = jobReliability(state);
    const points = state.points
      .slice(-1_000)
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
      .slice(-180);
    const fixed = points.filter(isStrictOofEvidence);
    const rolling = points.filter((point) => point.evidenceType.includes("observational") || point.evidenceType === "legacy_mixed_horizon");
    if (!rolling.some((point) => point.id === observed.id)) rolling.push(observed);
    const latestStrictRun = fixed.at(-1) || null;
    return {
      available: true,
      market: key,
      updatedAt: state.updatedAt,
      champion: state.champion,
      latestAttempt: state.latestAttempt,
      latestEligibleModel: state.latestEligibleModel,
      // Existing clients read latestRun; make it the latest comparable OOF
      // run when one exists, while retaining the observation separately.
      latestRun: latestStrictRun || state.latestRun,
      latestStrictRun,
      latestObservation: observed,
      frozenBaseline: state.frozenBaseline,
      bestResearchArtifact: state.bestResearchArtifact,
      bestComparablePredictiveCandidate: state.bestComparablePredictiveCandidate,
      bestChallenger: state.bestComparablePredictiveCandidate,
      challenger: state.bestComparablePredictiveCandidate,
      observed,
      curves: {
        fixed,
        rolling: rolling.slice(-180),
      },
      schedule: state.schedule,
      frozenTest: state.frozenTest,
      jobReliability: reliability,
      blockers: [
        ...(state.champion ? [] : ["尚无满足硬门槛的5日 Champion"]),
        ...(observed.samples.independentDates < 120 ? [`当前仅 ${observed.samples.independentDates} 个独立已解析日期`] : []),
        ...(reliability.terminal >= 5 && reliability.successPct < 95 ? ["Runtime V3 训练任务成功率尚未达到 95%"] : []),
      ],
      order_execution_enabled: false,
    };
  }

  return { evaluate, load, recordJob, recordPoint, snapshot };
}

export { candidateEvidenceSemantics, createLearningProgressService, evidenceMetrics, isBetterChallenger, pointFromTrainingJob, promotionDecision };
