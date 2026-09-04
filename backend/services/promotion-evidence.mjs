import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function hashEvidence(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex").slice(0, 32);
}

function failedKernelChecks(value, prefix = "") {
  if (!value || typeof value !== "object") return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) return failedKernelChecks(child, path);
    return child === true ? [] : [path];
  });
}

function buildPromotionEvidenceV2({ market, cycleId, attempt, jobId, evaluation = {}, context = {} } = {}) {
  const checks = Array.isArray(evaluation.checks) ? evaluation.checks : [];
  const failedChecks = Array.isArray(evaluation.failedChecks) ? [...evaluation.failedChecks] : [];
  const body = {
    schemaVersion: 2,
    contract: "single-promotion-evidence-v2",
    immutable: true,
    market: String(market || "").toUpperCase() || null,
    cycleId: cycleId || null,
    attempt: Number(attempt || 0),
    jobId: jobId || null,
    generatedAt: new Date().toISOString(),
    modelVersion: evaluation.modelVersion || null,
    dataVersion: context.dataVersion || null,
    planSignature: context.planSignature || null,
    testSetSignature: context.testSetSignature || null,
    decision: evaluation.passed === true ? "promote_candidate" : "hold_shadow",
    accepted: evaluation.passed === true,
    score: Number(evaluation.score || 0),
    failedChecks,
    checks,
    kernelDecision: context.kernelDecision || evaluation.productionEligibility || null,
    kernelChecks: context.kernelChecks || evaluation.kernelChecks || null,
    lockbox: context.lockbox || evaluation.researchLockbox || null,
    kernelFailedChecks: context.kernelFailedChecks || evaluation.kernelFailedChecks || [],
    kernelContract: "core-production-checks-v2",
    longTradeGate: context.longTradeGate || evaluation.longTradeGate || null,
    summary: evaluation.summary || {},
  };
  return { ...body, evidenceHash: hashEvidence(body), evidenceId: hashEvidence({ ...body, contract: "evidence-id" }) };
}

function validatePromotionEvidenceV2(evidence, { modelVersion = null, market = null } = {}) {
  if (!evidence || Number(evidence.schemaVersion) !== 2 || evidence.contract !== "single-promotion-evidence-v2") {
    return { valid: false, reason: "promotion_evidence_v2_missing" };
  }
  const { evidenceHash, evidenceId, ...body } = evidence;
  if (!evidenceHash || hashEvidence(body) !== evidenceHash) {
    return { valid: false, reason: "promotion_evidence_hash_mismatch" };
  }
  if (market && String(evidence.market).toUpperCase() !== String(market).toUpperCase()) {
    return { valid: false, reason: "promotion_evidence_market_mismatch" };
  }
  if (modelVersion && evidence.modelVersion && evidence.modelVersion !== modelVersion) {
    return { valid: false, reason: "promotion_evidence_model_mismatch" };
  }
  if (!evidence.kernelChecks || typeof evidence.kernelChecks !== "object" || Array.isArray(evidence.kernelChecks)) {
    return { valid: false, reason: "promotion_evidence_kernel_missing" };
  }
  const kernelFailed = failedKernelChecks(evidence.kernelChecks);
  if (kernelFailed.length || (evidence.kernelFailedChecks || []).length || evidence.kernelDecision?.eligible !== true) {
    return { valid: false, reason: "promotion_evidence_kernel_mismatch" };
  }
  if (evidence.kernelDecision?.requiresLockbox === true) {
    if (!evidence.lockbox || evidence.lockbox.status !== "frozen_untouched" || !evidence.lockbox.lockboxId) {
      return { valid: false, reason: "promotion_evidence_lockbox_missing" };
    }
  }
  if (evidence.decision !== "promote_candidate" || evidence.accepted !== true || (evidence.failedChecks || []).length) {
    return { valid: false, reason: "promotion_evidence_not_accepted" };
  }
  return { valid: true, reason: "promotion_evidence_valid", evidenceId: evidence.evidenceId || null };
}

function buildPromotionEvidenceV3({ market, cycleId, attempt, jobId, evaluation = {}, context = {} } = {}) {
  const checks = Array.isArray(evaluation.checks) ? evaluation.checks : [];
  const failedChecks = Array.isArray(evaluation.failedChecks) ? [...evaluation.failedChecks] : [];
  const comparisonKey = String(context.comparisonKey || evaluation.comparisonKey || "").trim() || null;
  const comparisonKeyFields = context.comparisonKeyFields || evaluation.comparisonKeyFields || null;
  const lockbox = context.lockbox || evaluation.researchLockbox || null;
  const lockboxCreatedBeforeFit = context.lockboxCreatedBeforeFit === true
    || evaluation.lockboxCreatedBeforeFit === true
    || lockbox?.createdBeforeFit === true;
  const candidateStatus = String(
    context.candidateStatus || evaluation.candidateStatus || (evaluation.passed === true ? "AVAILABLE" : "NO_MODEL"),
  ).toUpperCase();
  const comparison = context.comparison || evaluation.comparison || null;
  const body = {
    schemaVersion: 3,
    contract: "single-promotion-evidence-v3",
    immutable: true,
    market: String(market || "").toUpperCase() || null,
    cycleId: cycleId || null,
    attempt: Number(attempt || 0),
    jobId: jobId || null,
    generatedAt: new Date().toISOString(),
    modelVersion: evaluation.modelVersion || null,
    candidateStatus,
    dataVersion: context.dataVersion || null,
    planSignature: context.planSignature || null,
    testSetSignature: context.testSetSignature || null,
    comparisonKey,
    comparisonKeyFields,
    decision: evaluation.passed === true ? "promote_candidate" : "hold_shadow",
    accepted: evaluation.passed === true,
    score: Number(evaluation.score || 0),
    failedChecks,
    checks,
    kernelDecision: context.kernelDecision || evaluation.productionEligibility || null,
    kernelChecks: context.kernelChecks || evaluation.kernelChecks || null,
    lockbox,
    lockboxCreatedBeforeFit,
    kernelFailedChecks: context.kernelFailedChecks || evaluation.kernelFailedChecks || [],
    kernelContract: "core-production-checks-v2",
    longTradeGate: context.longTradeGate || evaluation.longTradeGate || null,
    comparison,
    nonInferiorToChampion: comparison?.nonInferior === true,
    summary: evaluation.summary || {},
  };
  return { ...body, evidenceHash: hashEvidence(body), evidenceId: hashEvidence({ ...body, contract: "evidence-id" }) };
}

function validatePromotionEvidenceV3(evidence, { modelVersion = null, market = null, requireNonInferiority = false } = {}) {
  if (!evidence || Number(evidence.schemaVersion) !== 3 || evidence.contract !== "single-promotion-evidence-v3") {
    return { valid: false, reason: "promotion_evidence_v3_missing" };
  }
  const { evidenceHash, evidenceId, ...body } = evidence;
  if (!evidenceHash || hashEvidence(body) !== evidenceHash) {
    return { valid: false, reason: "promotion_evidence_hash_mismatch" };
  }
  if (market && String(evidence.market).toUpperCase() !== String(market).toUpperCase()) {
    return { valid: false, reason: "promotion_evidence_market_mismatch" };
  }
  if (modelVersion && evidence.modelVersion && evidence.modelVersion !== modelVersion) {
    return { valid: false, reason: "promotion_evidence_model_mismatch" };
  }
  if (!evidence.comparisonKey || !evidence.comparisonKeyFields || typeof evidence.comparisonKeyFields !== "object") {
    return { valid: false, reason: "promotion_evidence_comparison_key_missing" };
  }
  if (evidence.candidateStatus === "NO_MODEL" || !evidence.modelVersion) {
    return { valid: false, reason: "promotion_evidence_no_model" };
  }
  if (evidence.lockboxCreatedBeforeFit !== true) {
    return { valid: false, reason: "promotion_evidence_lockbox_created_after_fit" };
  }
  if (!evidence.lockbox || !evidence.lockbox.lockboxId) {
    return { valid: false, reason: "promotion_evidence_lockbox_missing" };
  }
  if (
    evidence.lockbox.status !== "consumed"
    || evidence.lockbox.evaluationOutcome !== "accepted"
    || Number(evidence.lockbox.accessCount) !== 1
    || !evidence.lockbox.consumedByCandidateId
  ) {
    return { valid: false, reason: "promotion_evidence_lockbox_not_accepted_once" };
  }
  if (!evidence.kernelChecks || typeof evidence.kernelChecks !== "object" || Array.isArray(evidence.kernelChecks)) {
    return { valid: false, reason: "promotion_evidence_kernel_missing" };
  }
  const kernelFailed = failedKernelChecks(evidence.kernelChecks);
  if (kernelFailed.length || (evidence.kernelFailedChecks || []).length || evidence.kernelDecision?.eligible !== true) {
    return { valid: false, reason: "promotion_evidence_kernel_mismatch" };
  }
  if (evidence.decision !== "promote_candidate" || evidence.accepted !== true || (evidence.failedChecks || []).length) {
    return { valid: false, reason: "promotion_evidence_not_accepted" };
  }
  if (requireNonInferiority && evidence.nonInferiorToChampion !== true) {
    return { valid: false, reason: "promotion_evidence_non_inferiority_missing" };
  }
  return { valid: true, reason: "promotion_evidence_v3_valid", evidenceId: evidence.evidenceId || evidenceId || null };
}

export {
  buildPromotionEvidenceV2,
  buildPromotionEvidenceV3,
  hashEvidence,
  validatePromotionEvidenceV2,
  validatePromotionEvidenceV3,
};
