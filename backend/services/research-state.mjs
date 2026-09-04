const RESEARCH_STATES = Object.freeze([
  "QUEUED",
  "RUNNING",
  "EVIDENCE_READY",
  "ACCEPTED",
  "REJECTED",
]);

const RESEARCH_TRANSITIONS = Object.freeze({
  QUEUED: new Set(["RUNNING", "REJECTED"]),
  RUNNING: new Set(["EVIDENCE_READY", "REJECTED"]),
  EVIDENCE_READY: new Set(["ACCEPTED", "REJECTED"]),
  ACCEPTED: new Set(),
  REJECTED: new Set(),
});

function researchStateTransition(previousState = null, nextState = null) {
  const previous = previousState == null ? null : String(previousState).trim().toUpperCase();
  const next = String(nextState || "").trim().toUpperCase();
  const validNext = RESEARCH_STATES.includes(next);
  const allowed = validNext && (previous === null
    ? next === "QUEUED" || next === "EVIDENCE_READY" || next === "REJECTED"
    : RESEARCH_STATES.includes(previous)
      && (previous === next || RESEARCH_TRANSITIONS[previous].has(next)));
  return {
    allowed,
    previousState: previous,
    nextState: next || null,
    reason: !validNext
      ? "unknown_research_state"
      : allowed
        ? previous === next ? "same_state_evidence_observation" : "valid_research_state_transition"
        : "invalid_research_state_transition",
  };
}

function researchStateFromTraining(training = {}) {
  const status = String(training?.status || training?.trainingStatus || training?.manifest?.candidate_status || "").toUpperCase();
  if (["NO_MODEL", "BLOCKED_GATE03", "REJECTED", "REJECTED_RESEARCH_REQUEST", "FAILED", "CANCELLED"].includes(status)) return "REJECTED";
  if (["AVAILABLE", "PARTIAL", "RESEARCH", "EVIDENCE_READY", "ACCEPTED"].includes(status)) return "EVIDENCE_READY";
  return "RUNNING";
}

export { RESEARCH_STATES, researchStateFromTraining, researchStateTransition };
