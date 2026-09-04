import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !["trainingRunId", "reason", "source", "operatorNote"].includes(key))
      .map((key) => [key, stableValue(value[key])]),
  );
}

function jobSignature(type, payload = {}) {
  return createHash("sha256")
    .update(`${String(type)}:${JSON.stringify(stableValue(payload))}`)
    .digest("hex");
}

function createJobManager(options = {}) {
  const basePath = options.basePath;
  const publish = typeof options.publish === "function" ? options.publish : () => {};
  const onTerminal = typeof options.onTerminal === "function" ? options.onTerminal : async () => {};
  const onPersist = typeof options.onPersist === "function" ? options.onPersist : async () => {};
  const handlers = new Map();
  const running = new Map();
  const controllers = new Map();
  const pauseGates = new Map();
  const pending = [];
  let maxConcurrent = Math.max(1, Math.min(8, Number(options.maxConcurrent || process.env.BACKGROUND_JOB_CONCURRENCY || 2)));
  const dataHeavyTypes = new Set(["history-backfill", "pit-enrichment", "corporate-action-backfill", "cn-corporate-action-backfill"]);
  const researchHeavyTypes = new Set(["backtest", "historical-backtest-symbol", "factor-lab", "factor-research", "factor-evolution", "model-report"]);
  const heavyTypes = new Set([...dataHeavyTypes, ...researchHeavyTypes]);
  let maxHeavyConcurrent = Math.max(1, Math.min(3, Number(options.maxHeavyConcurrent || process.env.BACKGROUND_HEAVY_JOB_CONCURRENCY || 1)));
  let maxDataHeavyConcurrent = Math.max(1, Math.min(2, Number(options.maxDataHeavyConcurrent || process.env.BACKGROUND_DATA_HEAVY_JOB_CONCURRENCY || 1)));
  let maxResearchHeavyConcurrent = Math.max(1, Math.min(2, Number(options.maxResearchHeavyConcurrent || process.env.BACKGROUND_RESEARCH_HEAVY_JOB_CONCURRENCY || 1)));
  const progressWatchdogMs = Math.max(
    60_000,
    Number(options.progressWatchdogMs || process.env.BACKGROUND_SUBSTANTIVE_PROGRESS_STALE_MS || 15 * 60_000),
  );
  const maxQueue = Math.max(maxConcurrent, Math.min(500, Number(options.maxQueue || process.env.BACKGROUND_JOB_QUEUE_LIMIT || 48)));
  const persistedReadTimeoutMs = Math.max(
    500,
    Number(options.persistedReadTimeoutMs || process.env.BACKGROUND_PERSISTED_READ_TIMEOUT_MS || 2_000),
  );
  const startupReconcileWindowMs = Math.max(
    60 * 60_000,
    Number(options.startupReconcileWindowMs || process.env.BACKGROUND_STARTUP_RECONCILE_WINDOW_MS || 7 * 24 * 60 * 60_000),
  );
  const staleQueueAgeMs = Math.max(
    60_000,
    Number(options.staleQueueAgeMs || process.env.BACKGROUND_STALE_QUEUE_AGE_MS || 24 * 60 * 60 * 1000),
  );
  const orphanQueueAgeMs = Math.max(
    60_000,
    Number(options.orphanQueueAgeMs || process.env.BACKGROUND_ORPHAN_QUEUE_AGE_MS || 5 * 60_000),
  );
  // Do not resurrect thousands of historical queued artifacts after a
  // restart. They remain on disk for audit/listing, while only a bounded
  // recent window is eligible to consume the live worker queue.
  const maxStartupRecoveredQueued = Math.max(1, Math.min(maxQueue, Number(options.maxStartupRecoveredQueued || process.env.BACKGROUND_STARTUP_RECOVERY_QUEUE || maxQueue)));
  let activeCount = 0;
  let activeHeavyCount = 0;
  let activeDataHeavyCount = 0;
  let activeResearchHeavyCount = 0;
  let shuttingDown = false;
  if (!basePath) throw new Error("Job manager requires a persistence directory.");

  const pathFor = (id) => join(basePath, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  async function readPersistedJob(filename) {
    const controller = new AbortController();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`Persisted job read timed out: ${filename}`), { code: "PERSISTED_JOB_READ_TIMEOUT" }));
        }, persistedReadTimeoutMs);
        timer.unref?.();
      });
      const source = readFile(join(basePath, filename), { encoding: "utf8", signal: controller.signal });
      const raw = await Promise.race([source, timeout]);
      if (!String(raw || "").trim()) {
        throw Object.assign(new Error(`Persisted job artifact is unavailable: ${filename}`), { code: "PERSISTED_JOB_UNAVAILABLE" });
      }
      return JSON.parse(raw);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function save(job, phase = "update") {
    await mkdir(basePath, { recursive: true });
    await writeFile(pathFor(job.id), JSON.stringify(job, null, 2), "utf8");
    await onPersist({ ...job }, { phase, trajectory: ["queued", "checkpoint", "complete", "failure", "cancelled", "retry"].includes(phase) });
    return job;
  }

  async function saveBestEffort(job, phase = "update") {
    try {
      await save(job, phase);
      return true;
    } catch (error) {
      publish("job.persistence_error", {
        id: job.id,
        type: job.type,
        market: job.market,
        phase,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  async function findPersistedActiveDuplicate(type, signature) {
    let files = [];
    try {
      files = (await readdir(basePath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith(`${String(type).replace(/[^a-zA-Z0-9-]/g, "-")}-`) && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch {
      return null;
    }
    const timestampFromFilename = (filename) => Number(filename.match(/-(\d{13,})(?:-[a-zA-Z0-9]{8})?\.json$/)?.[1] || 0);
    files.sort((left, right) => timestampFromFilename(right) - timestampFromFilename(left) || right.localeCompare(left));
    // Active duplicates are necessarily recent. Bound the scan so a long-lived
    // archive does not make every scheduler submission expensive.
    for (const filename of files.slice(0, 200)) {
      try {
        const job = JSON.parse(await readFile(join(basePath, filename), "utf8"));
        if (job?.signature === signature && ["queued", "running"].includes(job.status)) return job;
      } catch {
        // A partially written artifact is ignored; the creating process will
        // either finish it or expose a normal persistence error.
      }
    }
    return null;
  }

  async function get(id) {
    if (running.has(id)) return running.get(id);
    try {
      return JSON.parse(await readFile(pathFor(id), "utf8"));
    } catch {
      return null;
    }
  }

  function failureCategory(error) {
    const text = String(error?.message || error || "").toLowerCase();
    if (
      error?.code === "PYTHON_CORE_QUEUE_TIMEOUT"
      || text.includes("queue wait exceeded")
      || text.includes("python core queue timeout")
    ) return "resource_exhaustion";
    if (text.includes("timed out") || text.includes("timeout")) return "timeout";
    if (
      text.includes("restart")
      || text.includes("interrupted")
      || text.includes("client closed")
      || text.includes("client is closed")
      || text.includes("worker closed")
      || text.includes("worker exited")
    ) return "interrupted";
    if (text.includes("quota") || text.includes("rate limit") || text.includes("429")) return "provider_quota";
    if (text.includes("memory") || text.includes("heap") || text.includes("killed")) return "resource_exhaustion";
    if (text.includes("data") || text.includes("sample") || text.includes("history")) return "data_evidence";
    return "training_runtime";
  }

  function queuedAgeMs(job, now = Date.now()) {
    const createdAt = Date.parse(job?.createdAt || "");
    return Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;
  }

  function isStaleQueued(job, now = Date.now()) {
    return job?.status === "queued" && queuedAgeMs(job, now) >= staleQueueAgeMs;
  }

  function isDetachedQueued(job) {
    return job?.status === "queued"
      && !running.has(job.id)
      && !pending.some((entry) => entry.id === job.id);
  }

  function shouldDeferStaleQueue(job, now = Date.now(), options = {}) {
    // A queued job that is still owned by this manager may legitimately wait
    // behind a live lane. A queued artifact that is absent from both the
    // in-memory queue and running map is different: no worker can ever pick it
    // up, so leaving it as queued makes the task center report phantom work.
    if (isDetachedQueued(job)) {
      if (options.allowDetachedDataRecovery === true) return false;
      return queuedAgeMs(job, now) >= Math.min(staleQueueAgeMs, orphanQueueAgeMs);
    }
    if (!isStaleQueued(job, now)) return false;
    // A resumable job remains live while this manager owns it; its checkpoint
    // path must not be deferred merely because it has waited in the queue.
    return job?.payload?.resume !== true;
  }

  async function deferStaleQueuedJob(job, reason = "queue-stale") {
    const pendingIndex = pending.findIndex((entry) => entry.id === job.id);
    if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
    if (running.has(job.id) && job.status === "queued") running.delete(job.id);
    const now = new Date().toISOString();
    job.status = "deferred";
    job.error = `任务在队列中超过 ${Math.round(staleQueueAgeMs / 3_600_000)} 小时，已暂停自动执行；可从最近任务手动重新启动。`;
    job.failureCategory = "queue_stale";
    job.staleAt = now;
    job.deferredAt = now;
    job.updatedAt = now;
    job.queuePosition = null;
    await saveBestEffort(job, reason);
    if (pendingIndex >= 0) await persistQueuePositions();
    publish("job.deferred", {
      id: job.id,
      type: job.type,
      market: job.market,
      failureCategory: job.failureCategory,
      queueAgeMs: queuedAgeMs(job, Date.parse(now)),
    });
    return job;
  }

  async function list(filters = {}) {
    const type = filters.type ? String(filters.type) : null;
    const market = filters.market ? String(filters.market).toUpperCase() : null;
    const updatedSince = filters.updatedSince ? Date.parse(filters.updatedSince) : null;
    const limit = Math.max(1, Math.min(500, Number(filters.limit || 100)));
    const offset = Math.max(0, Math.min(100_000, Number(filters.offset || 0)));
    const readOnly = filters.readOnly === true;
    let files = [];
    try {
      files = (await readdir(basePath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .filter((entry) => !type || entry.name.startsWith(`${type.replace(/[^a-zA-Z0-9-]/g, "-")}-`))
        .map((entry) => entry.name);
    } catch {
      return { count: 0, jobs: [] };
    }
    const timestampFromFilename = (filename) => Number(filename.match(/-(\d{13,})(?:-[a-zA-Z0-9]{8})?\.json$/)?.[1] || 0);
    files.sort((left, right) => timestampFromFilename(right) - timestampFromFilename(left) || right.localeCompare(left));
    // The task center usually asks for a recent window.  The directory also
    // contains years of immutable audit artifacts, so opening every JSON file
    // for each poll makes a small status request scale with the whole archive.
    // Filenames carry the creation timestamp; keep a two-day safety window for
    // recently updated older jobs and always retain jobs that are live in this
    // process.  The normal unfiltered history endpoint keeps its old behavior.
    if (Number.isFinite(updatedSince)) {
      const safetyWindowMs = 2 * 24 * 60 * 60 * 1000;
      const liveFileNames = new Set([...running.keys()].map((id) => pathFor(id).split("/").pop()));
      files = files.filter((filename) => {
        const createdAt = timestampFromFilename(filename);
        return createdAt >= updatedSince - safetyWindowMs || liveFileNames.has(filename);
      });
    }
    const candidateCount = files.length;
    // The task center is polled frequently. Only parse the requested page;
    // the immutable archive stays on disk for evidence import and audit.
    files = files.slice(offset, offset + Math.min(limit * 2, 1_000));
    const compact = (job) => ({
      id: job.id,
      type: job.type,
      market: job.market,
      status: job.status,
      progress: job.progress,
      detail: job.detail,
      error: job.error,
      failureCategory: job.failureCategory,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      trainingRunId: job.trainingRunId,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      progressAt: job.progressAt,
      finishedAt: job.finishedAt,
      heartbeatAt: job.heartbeatAt,
      queuePosition: job.queuePosition ?? null,
      queueAgeMs: queuedAgeMs(job),
      stale: job.status === "deferred" && job.failureCategory === "queue_stale",
      staleAt: job.staleAt || null,
      dispatchReason: job.dispatchReason || null,
      pauseRequested: job.pauseRequested === true,
      pausedAt: job.pausedAt || null,
      restartedFrom: job.restartedFrom || null,
      stagnation: job.stagnation || null,
      resultSummary: job.result && typeof job.result === "object" ? {
        available: job.result.available,
        framework: job.result.framework,
        market: job.result.market,
        productionEligible: job.result.productionEligibility?.eligible ?? job.result.productionEligible,
        // Keep bounded, decision-useful diagnostics in the task center.  The
        // immutable job file still contains the full per-symbol evidence;
        // polling must not copy the whole result into every response.
        historyDiagnostics: job.result.historyDiagnostics || null,
      } : null,
    });
    const rows = [];
    const pageSize = 24;
    for (let start = 0; start < files.length && rows.length < limit; start += pageSize) {
      const batch = files.slice(start, start + pageSize);
      const decoded = await Promise.all(batch.map(async (filename) => {
        try {
          return await readPersistedJob(filename);
        } catch {
          return null;
        }
      }));
      for (const job of decoded) {
        if (!job || rows.length >= limit) continue;
        if (type && job.type !== type) continue;
        if (market && String(job.market || "").toUpperCase() !== market) continue;
        const jobUpdatedAt = Date.parse(job.updatedAt || job.createdAt || "");
        if (Number.isFinite(updatedSince) && (!Number.isFinite(jobUpdatedAt) || jobUpdatedAt < updatedSince)) continue;
        if (!readOnly && shouldDeferStaleQueue(job)) await deferStaleQueuedJob(job, "queue-stale-list");
        if (!readOnly && job.status === "running" && !running.has(job.id)) {
          job.status = "failed";
          job.error = job.error || "Training job was interrupted by a backend restart.";
          job.failureCategory = "interrupted";
          job.updatedAt = new Date().toISOString();
          await saveBestEffort(job, "restart-reconciliation");
        }
        rows.push(compact(job));
      }
    }
    rows.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
    return {
      count: rows.length,
      totalCandidates: candidateCount,
      offset,
      hasMore: offset + files.length < candidateCount,
      jobs: rows,
    };
  }

  async function reconcile() {
    let files = [];
    try {
      files = (await readdir(basePath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch {
      return { scanned: 0, repaired: 0 };
    }
    const timestampFromFilename = (filename) => Number(filename.match(/-(\d{13})-[a-zA-Z0-9]{8}\.json$/)?.[1] || 0);
    const recoveryPriority = (filename) => (
      /^(?:history-backfill|pit-enrichment|corporate-action-backfill|cn-corporate-action-backfill)-/.test(filename) ? 0
        : /^backtest-/.test(filename) ? 1 : 2
    );
    files.sort((left, right) => recoveryPriority(left) - recoveryPriority(right)
      || timestampFromFilename(right) - timestampFromFilename(left)
      || right.localeCompare(left));
    let repaired = 0;
    let resumed = 0;
    let recoveredQueued = 0;
    const startupCutoff = Date.now() - startupReconcileWindowMs;
    for (const filename of files) {
      const filenameTimestamp = timestampFromFilename(filename);
      const recoveryFile = /^(?:history-backfill|pit-enrichment|corporate-action-backfill|cn-corporate-action-backfill)-/.test(filename);
      // Terminal history is immutable audit material and does not need to be
      // parsed during every restart. Keep recent work and data-recovery files
      // eligible; the evidence importer handles the full archive separately.
      if (filenameTimestamp && filenameTimestamp < startupCutoff && !recoveryFile) continue;
      try {
        const job = await readPersistedJob(filename);
        if (!["running", "queued"].includes(job.status)) continue;
        if (shouldDeferStaleQueue(job, Date.now(), { allowDetachedDataRecovery: true })) {
          await deferStaleQueuedJob(job, "startup-queue-stale");
          repaired += 1;
          continue;
        }
        // A persisted queued job has not acquired a worker. A backend restart
        // restores it to the queue without consuming its runtime retry budget;
        // otherwise PIT/backfill work can exhaust a backtest before fold one.
        if (job.status === "queued" && handlers.has(String(job.type))) {
          if (recoveredQueued >= maxStartupRecoveredQueued) {
            job.status = "deferred";
            job.error = "历史队列超过启动恢复上限；保留审计记录，等待新的手动/调度任务。";
            job.failureCategory = "queue_backpressure";
            job.deferredAt = new Date().toISOString();
            job.updatedAt = job.deferredAt;
            await saveBestEffort(job, "startup-queue-deferred");
            repaired += 1;
            continue;
          }
          job.runtimeVersion = Math.max(3, Number(job.runtimeVersion || 0));
          job.maxAttempts = Math.max(Number(job.maxAttempts || 1), [
            "backtest",
            "history-backfill",
            "pit-enrichment",
            "corporate-action-backfill",
            "cn-corporate-action-backfill",
          ].includes(String(job.type)) ? 3 : 2);
          job.error = null;
          job.failureCategory = null;
          job.payload = { ...(job.payload || {}), resume: true, trainingRunId: job.trainingRunId };
          job.updatedAt = new Date().toISOString();
          job.heartbeatAt = job.updatedAt;
          job.progressAt = job.updatedAt;
          running.set(job.id, job);
          pending.push(job);
          recoveredQueued += 1;
          await saveBestEffort(job, "startup-queue-recovery");
          repaired += 1;
          resumed += 1;
          continue;
        }
        const restartBudgetFloor = [
          "backtest",
          "history-backfill",
          "pit-enrichment",
          "corporate-action-backfill",
          "cn-corporate-action-backfill",
        ].includes(String(job.type)) ? 3 : 2;
        const maxAttempts = Math.max(Number(job.maxAttempts || 1), restartBudgetFloor);
        const checkpointRecoveryAvailable = ["backtest", "historical-backtest-symbol"].includes(String(job.type))
          && job.payload?.resume === true
          && Object.keys(job.checkpoints || {}).some((name) => String(name).startsWith("oof-"))
          && Number(job.restartRecoveryCount || 0) < 2;
        const supervisorBacktestWithoutFoldEvidence = String(job.type) === "backtest"
          && Boolean(job.payload?.supervisorContext)
          && !Object.keys(job.checkpoints || {}).some((name) => String(name).startsWith("oof-"));
        if (supervisorBacktestWithoutFoldEvidence) {
          job.status = "failed";
          job.error = "Supervisor training was interrupted before any OOF fold completed; automatic restart is disabled until an operator changes the plan or explicitly restarts it.";
          job.failureCategory = "interrupted_supervisor_requires_review";
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
          job.heartbeatAt = job.finishedAt;
          await saveBestEffort(job, "startup-supervisor-review-required");
          repaired += 1;
          continue;
        }
        const restartBudgetExhausted = job.resumedAfterRestart === true
          && Number(job.attempt || 1) >= maxAttempts
          && !checkpointRecoveryAvailable;
        const resumable = !restartBudgetExhausted
          && Number(job.runtimeVersion || 0) >= 2
          && [
            "backtest",
            "historical-backtest-symbol",
            "history-backfill",
            "factor-lab",
            "factor-evolution",
            "model-report",
            "agent-replay",
            "pit-enrichment",
            "corporate-action-backfill",
            "cn-corporate-action-backfill",
          ].includes(String(job.type))
          && handlers.has(String(job.type));
        if (resumable) {
          const previousRuntimeVersion = Number(job.runtimeVersion || 0);
          job.migratedFromRuntimeVersion = job.migratedFromRuntimeVersion || previousRuntimeVersion;
          job.runtimeVersion = 3;
          job.maxAttempts = maxAttempts;
          job.attempt = Math.min(job.maxAttempts, Number(job.attempt || 1) + 1);
          job.status = "queued";
          job.progress = Math.min(Number(job.progress || 0), 0.1);
          job.error = null;
          job.failureCategory = null;
          job.resumedAfterRestart = true;
          if (checkpointRecoveryAvailable) job.restartRecoveryCount = Number(job.restartRecoveryCount || 0) + 1;
          job.payload = { ...(job.payload || {}), resume: true, trainingRunId: job.trainingRunId };
          job.updatedAt = new Date().toISOString();
          job.heartbeatAt = job.updatedAt;
          job.progressAt = job.updatedAt;
          running.set(job.id, job);
          pending.push(job);
          await saveBestEffort(job, "startup-resume");
          pump();
          resumed += 1;
        } else {
          job.status = "failed";
          job.error = restartBudgetExhausted
            ? "Background job exhausted its restart budget; persisted fold checkpoints remain available to a new training run."
            : "Background job was interrupted before the backend completed it.";
          job.failureCategory = restartBudgetExhausted ? "restart_budget_exhausted" : "interrupted";
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
          job.heartbeatAt = job.finishedAt;
          await saveBestEffort(job, "startup-reconciliation");
        }
        repaired += 1;
      } catch {
        // A damaged task file is isolated and cannot block startup.
      }
    }
    if (resumed) {
      pump();
      // Startup reconciliation can finish before the persisted resource profile
      // has reapplied its capacity. Wake the queue once more after that turn.
      setTimeout(pump, 25).unref?.();
    }
    if (repaired) publish("job.reconciled", { scanned: files.length, repaired, resumed });
    return { scanned: files.length, repaired, resumed };
  }

  function isRunning(id) {
    const job = running.get(id);
    return Boolean(job && ["queued", "running", "pausing", "paused"].includes(job.status));
  }

  function register(type, handler) {
    handlers.set(String(type), handler);
  }

  function queuePosition(job) {
    const index = pending.findIndex((entry) => entry.id === job.id);
    return index >= 0 ? index + 1 : null;
  }

  async function persistQueuePositions() {
    await Promise.all(pending.map(async (job, index) => {
      job.queuePosition = index + 1;
      job.updatedAt = new Date().toISOString();
      await saveBestEffort(job, "queue-reordered");
    }));
  }

  function openPauseGate(id) {
    if (!pauseGates.has(id)) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      pauseGates.set(id, { promise, release });
    }
    return pauseGates.get(id);
  }

  function releasePauseGate(id) {
    const gate = pauseGates.get(id);
    if (gate) {
      gate.release();
      pauseGates.delete(id);
    }
  }

  async function waitIfPaused(job, controller) {
    if (!job.pauseRequested) return;
    const gate = openPauseGate(job.id);
    job.status = "paused";
    job.pausedAt = new Date().toISOString();
    job.updatedAt = job.pausedAt;
    job.heartbeatAt = job.pausedAt;
    await saveBestEffort(job, "paused");
    publish("job.paused", { id: job.id, type: job.type, market: job.market, reason: "pause-requested" });
    await gate.promise;
    if (controller.signal.aborted) {
      throw Object.assign(new Error("Background job was cancelled."), { code: "JOB_CANCELLED" });
    }
    job.pauseRequested = false;
    job.status = "running";
    job.pausedAt = null;
    job.updatedAt = new Date().toISOString();
    job.heartbeatAt = job.updatedAt;
    await saveBestEffort(job, "resumed");
    publish("job.resumed", { id: job.id, type: job.type, market: job.market });
  }

  async function execute(job) {
    const handler = handlers.get(job.type);
    const controller = new AbortController();
    controllers.set(job.id, controller);
    let heartbeatTimer = null;
    let requeued = false;
    try {
      job.status = "running";
      job.error = null;
      job.failureCategory = null;
      delete job.finishedAt;
      job.progress = 0.05;
      job.updatedAt = new Date().toISOString();
      job.heartbeatAt = job.updatedAt;
      job.progressAt = job.updatedAt;
      job.queueWaitMs = Math.max(0, Date.now() - new Date(job.createdAt).getTime());
      await save(job, "running");
      publish("job.running", { id: job.id, type: job.type, market: job.market, queueWaitMs: job.queueWaitMs });
      const update = async (progress, detail = {}) => {
        await waitIfPaused(job, controller);
        if (controller.signal.aborted) {
          throw Object.assign(new Error("Background job was cancelled."), { code: "JOB_CANCELLED" });
        }
        const nextProgress = Math.max(job.progress, Math.min(0.98, Number(progress || 0)));
        const previousDetail = JSON.stringify(job.detail ?? null);
        const nextDetail = JSON.stringify(detail ?? null);
        const substantiveProgress = nextProgress > Number(job.progress || 0) + 1e-9 || previousDetail !== nextDetail || !job.progressAt;
        job.progress = nextProgress;
        const updatedAt = new Date().toISOString();
        job.updatedAt = updatedAt;
        job.heartbeatAt = job.updatedAt;
        if (substantiveProgress) {
          if (job.stagnation && !job.stagnation.resolvedAt) {
            job.stagnation = { ...job.stagnation, resolvedAt: updatedAt };
            publish("job.progress_stagnation_recovered", {
              id: job.id,
              type: job.type,
              market: job.market,
              detectedAt: job.stagnation.detectedAt,
              recoveredAt: updatedAt,
            });
          }
          job.progressAt = updatedAt;
        }
        job.detail = detail;
        await save(job, "progress");
        publish("job.progress", { id: job.id, type: job.type, progress: job.progress, detail });
      };
      const checkpoint = async (name, value = {}) => {
        await waitIfPaused(job, controller);
        const key = String(name || "checkpoint").replace(/[^a-zA-Z0-9_-]/g, "_");
        job.checkpoints = job.checkpoints || {};
        job.checkpoints[key] = {
          ...(job.checkpoints[key] || {}),
          ...value,
          completedAt: new Date().toISOString(),
        };
        job.updatedAt = new Date().toISOString();
        job.heartbeatAt = job.updatedAt;
        job.progressAt = job.updatedAt;
        if (job.stagnation && !job.stagnation.resolvedAt) {
          job.stagnation = { ...job.stagnation, resolvedAt: job.updatedAt };
          publish("job.progress_stagnation_recovered", {
            id: job.id,
            type: job.type,
            market: job.market,
            detectedAt: job.stagnation.detectedAt,
            recoveredAt: job.updatedAt,
          });
        }
        await save(job, "checkpoint");
        publish("job.checkpoint", { id: job.id, type: job.type, market: job.market, name: key });
        return job.checkpoints[key];
      };
      heartbeatTimer = setInterval(() => {
        const heartbeatAt = new Date().toISOString();
        job.heartbeatAt = heartbeatAt;
        job.updatedAt = job.heartbeatAt;
        const progressAtMs = Date.parse(job.progressAt || "");
        const progressAgeMs = Number.isFinite(progressAtMs) ? Date.now() - progressAtMs : progressWatchdogMs;
        if (progressAgeMs >= progressWatchdogMs && (!job.stagnation || job.stagnation.resolvedAt)) {
          const category = dataHeavyTypes.has(job.type)
            ? "data-source-or-data-quality"
            : researchHeavyTypes.has(job.type)
              ? "compute-or-model-resource"
              : "task-or-parameter-design";
          job.stagnation = {
            detectedAt: heartbeatAt,
            progressAgeMs: Math.max(0, progressAgeMs),
            category,
            action: "diagnose-before-retry",
          };
          publish("job.progress_stalled", {
            id: job.id,
            type: job.type,
            market: job.market,
            category,
            progressAgeMs: Math.max(0, progressAgeMs),
            action: "diagnose-before-retry",
          });
          void saveBestEffort(job, "progress-stagnation-detected");
          return;
        }
        void saveBestEffort(job, "heartbeat");
      }, 10_000);
      heartbeatTimer.unref?.();
      job.result = await handler(job.payload, update, {
        signal: controller.signal,
        job,
        checkpoint,
        checkpoints: job.checkpoints || {},
      });
      if (controller.signal.aborted) {
        throw Object.assign(new Error("Background job was cancelled."), { code: "JOB_CANCELLED" });
      }
      job.status = "complete";
      job.pauseRequested = false;
      job.error = null;
      job.failureCategory = null;
      job.progress = 1;
      job.updatedAt = new Date().toISOString();
      job.heartbeatAt = job.updatedAt;
      job.progressAt = job.updatedAt;
      job.runTimeMs = Math.max(0, Date.now() - new Date(job.startedAt || job.createdAt).getTime());
      await save(job, "complete");
      publish("job.complete", { id: job.id, type: job.type, market: job.market, runTimeMs: job.runTimeMs });
      await onTerminal({ ...job }).catch((error) => publish("job.terminal_callback_error", {
        id: job.id,
        type: job.type,
        market: job.market,
        error: error?.message || String(error),
      }));
    } catch (error) {
      job.error = error.message || String(error);
      // Keep a bounded diagnostic for local recovery. The UI continues to use
      // the short error message, while the supervisor can identify the exact
      // failing stage instead of retrying an opaque "key is not defined".
      job.errorStack = String(error?.stack || "").slice(0, 2400) || null;
      job.failureCategory = error?.code === "JOB_CANCELLED" ? "cancelled" : failureCategory(error);
      job.updatedAt = new Date().toISOString();
      job.heartbeatAt = job.updatedAt;
      job.progressAt = job.updatedAt;
      // A planned backend restart is not a failed training attempt. Preserve
      // the same durable job id and attempt so a short service restart cannot
      // turn a healthy queue into a series of apparent retries.
      if (shuttingDown && job.shutdownResume === true) {
        job.status = "queued";
        job.error = null;
        job.failureCategory = null;
        job.finishedAt = null;
        job.payload = { ...(job.payload || {}), resume: true, trainingRunId: job.trainingRunId };
        requeued = true;
        await saveBestEffort(job, "shutdown-queue-preserved");
        return;
      }
      if (job.failureCategory === "cancelled") {
        releasePauseGate(job.id);
        job.status = "cancelled";
        job.finishedAt = job.updatedAt;
        await saveBestEffort(job, "cancelled");
        publish("job.cancelled", { id: job.id, type: job.type, market: job.market });
        await onTerminal({ ...job }).catch(() => null);
        return;
      }
      const retryable = !shuttingDown && ["timeout", "interrupted", "resource_exhaustion"].includes(job.failureCategory);
      if (retryable && Number(job.attempt || 1) < Number(job.maxAttempts || 1)) {
        job.attempt = Number(job.attempt || 1) + 1;
        job.payload = {
          ...job.payload,
          rework: {
            ...(job.payload?.rework || {}),
            reason: job.failureCategory,
            previousAttempt: job.attempt - 1,
            resourceScale: Math.min(2.5, 1 + (job.attempt - 1) * 0.5),
            requestedAt: new Date().toISOString(),
          },
        };
        job.status = "queued";
        job.progress = Math.min(Number(job.progress || 0), 0.10);
        job.nextRetryAt = new Date(Date.now() + 1_000).toISOString();
        requeued = true;
        await saveBestEffort(job, "retry");
        publish("job.retrying", {
          id: job.id,
          type: job.type,
          market: job.market,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          failureCategory: job.failureCategory,
        });
        setTimeout(() => {
          pending.push(job);
          pump();
        }, 1_000).unref?.();
      } else {
        job.status = "failed";
        await saveBestEffort(job, "failure");
        publish("job.failed", { id: job.id, type: job.type, market: job.market, error: job.error });
        await onTerminal({ ...job }).catch(() => null);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      controllers.delete(job.id);
      releasePauseGate(job.id);
      activeCount = Math.max(0, activeCount - 1);
      if (heavyTypes.has(job.type)) activeHeavyCount = Math.max(0, activeHeavyCount - 1);
      if (dataHeavyTypes.has(job.type)) activeDataHeavyCount = Math.max(0, activeDataHeavyCount - 1);
      if (researchHeavyTypes.has(job.type)) activeResearchHeavyCount = Math.max(0, activeResearchHeavyCount - 1);
      if (!requeued) running.delete(job.id);
      pump();
    }
  }

  function pump() {
    while (activeCount < maxConcurrent && pending.length) {
      const nowMs = Date.now();
      const researchWaiting = pending.some((candidate) => (
        researchHeavyTypes.has(candidate.type)
        && nowMs - Date.parse(candidate.createdAt || nowMs) >= 15 * 60 * 1000
      ));
      const priorityFor = (candidate) => {
        if (candidate.payload?.supervisorContext?.priority === "manual" || candidate.payload?.priority === "manual") return -1;
        // Filling verified history and PIT layers is a prerequisite for every
        // useful training result.  Prefer those resumable collection jobs over
        // a new model run whenever they share the constrained heavy worker.
        // This intentionally does not pre-empt a running job; it only makes
        // the next available slot advance the data foundation first.
        let base = 1;
        if (["pit-enrichment", "history-backfill", "corporate-action-backfill", "cn-corporate-action-backfill"].includes(candidate.type)) base = 0;
        else if (["data-lake-migrate", "historical-backtest-symbol"].includes(candidate.type)) base = 1;
        else if (["backtest", "factor-lab", "factor-research", "factor-evolution", "model-report"].includes(candidate.type)) base = 2;
        const ageMinutes = Math.max(0, (nowMs - Date.parse(candidate.createdAt || nowMs)) / 60000);
        const agingBoost = Math.min(3, ageMinutes / 10);
        // Once research has waited 15 minutes it receives one reserved
        // dispatch opportunity. This prevents a continuous PIT queue from
        // starving OOF/factor work, while still keeping fresh data jobs first.
        if (researchWaiting && researchHeavyTypes.has(candidate.type)) return base - 3;
        return base - agingBoost;
      };
      let runnableIndex = -1;
      let runnablePriority = Number.POSITIVE_INFINITY;
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        if (heavyTypes.has(candidate.type) && activeHeavyCount >= maxHeavyConcurrent) continue;
        // The Python client has separate ingest and research lanes. Keep one
        // bounded data job moving while a distinct OOF/factor job runs, rather
        // than making every evidence request wait behind PIT collection.
        if (dataHeavyTypes.has(candidate.type) && activeDataHeavyCount >= maxDataHeavyConcurrent) continue;
        if (researchHeavyTypes.has(candidate.type) && activeResearchHeavyCount >= maxResearchHeavyConcurrent) continue;
        const priority = priorityFor(candidate);
        if (priority < runnablePriority) {
          runnableIndex = index;
          runnablePriority = priority;
        }
      }
      if (runnableIndex < 0) break;
      const [job] = pending.splice(runnableIndex, 1);
      job.queueAgeMs = Math.max(0, nowMs - Date.parse(job.createdAt || nowMs));
      job.dispatchReason = researchWaiting && researchHeavyTypes.has(job.type)
        ? "research-aging-reservation"
        : "priority-and-aging";
      activeCount += 1;
      if (heavyTypes.has(job.type)) activeHeavyCount += 1;
      if (dataHeavyTypes.has(job.type)) activeDataHeavyCount += 1;
      if (researchHeavyTypes.has(job.type)) activeResearchHeavyCount += 1;
      job.startedAt = new Date().toISOString();
      setTimeout(() => {
        void execute(job);
      }, 0).unref?.();
    }
  }

  // A queued job can survive a restart or a failed worker handoff without a
  // new event reaching the manager. Keep a low-cost wake-up loop so the queue
  // cannot remain visually queued forever; the loop only calls pump when work
  // is pending and is unref'ed so it never keeps the process alive by itself.
  const queueWakeTimer = setInterval(() => {
    if (!shuttingDown && pending.length) pump();
  }, Math.max(500, Number(process.env.BACKGROUND_QUEUE_WAKE_MS || 1_000)));
  queueWakeTimer.unref?.();

async function create(type, payload = {}) {
    if (shuttingDown) {
      throw Object.assign(new Error("Background job manager is shutting down."), { code: "JOB_MANAGER_CLOSED" });
    }
    const handler = handlers.get(String(type));
    if (!handler) throw Object.assign(new Error(`Unsupported background job type: ${type}`), { statusCode: 400 });
    const signature = jobSignature(type, payload);
    const duplicate = [...running.values()].find((job) => (
      job.signature === signature && ["queued", "running"].includes(job.status)
    ));
    if (duplicate) return { ...duplicate, deduplicated: true };
    const persistedDuplicate = await findPersistedActiveDuplicate(type, signature);
    if (persistedDuplicate) return { ...persistedDuplicate, deduplicated: true };
    if (pending.length + activeCount >= maxQueue) {
      throw Object.assign(
        new Error("Background research queue is full; wait for active training work to finish before retrying."),
        { statusCode: 503, code: "BACKGROUND_JOB_BACKPRESSURE", retryAfterSeconds: 5 },
      );
    }
    const now = new Date().toISOString();
    const job = {
      id: `${String(type).replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      type: String(type),
      signature,
      runtimeVersion: 3,
      market: payload.market || null,
      status: "queued",
      progress: 0,
      trainingRunId: payload.trainingRunId || `${String(payload.market || "global").toLowerCase()}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      heartbeatAt: now,
      progressAt: now,
      createdAt: now,
      updatedAt: now,
      payload,
      attempt: 1,
      maxAttempts: Math.max(1, Math.min(3, Number(
        payload.maxAttempts
        || (String(type) === "backtest"
          ? process.env.BACKTEST_JOB_ATTEMPTS || 3
          : String(type) === "factor-lab" ? process.env.FACTOR_LAB_JOB_ATTEMPTS || 2 : 1)
      ))),
      result: null,
      error: null,
      checkpoints: {},
      queuePosition: pending.length + 1,
      pauseRequested: false,
      pausedAt: null,
    };
    running.set(job.id, job);
    pending.push(job);
    await save(job, "queued");
    publish("job.queued", {
      id: job.id,
      type: job.type,
      market: job.market,
      queuePosition: pending.length,
      capacity: maxConcurrent,
    });
    pump();
    return job;
  }

  async function cancel(id) {
    const job = await get(id);
    if (!job) return null;
    if (!["queued", "running"].includes(job.status)) return job;
    const pendingIndex = pending.findIndex((entry) => entry.id === id);
    if (pendingIndex >= 0) {
      pending.splice(pendingIndex, 1);
      running.delete(id);
      job.status = "cancelled";
      job.error = "Background job was cancelled before execution.";
      job.failureCategory = "cancelled";
      job.updatedAt = new Date().toISOString();
      job.finishedAt = job.updatedAt;
      await saveBestEffort(job, "cancelled-while-queued");
      publish("job.cancelled", { id: job.id, type: job.type, market: job.market });
      await onTerminal({ ...job }).catch(() => null);
      await persistQueuePositions();
      return job;
    }
    if (!running.has(id)) {
      job.status = "cancelled";
      job.error = "Persisted background job was cancelled after its original runtime ended.";
      job.failureCategory = "cancelled";
      job.updatedAt = new Date().toISOString();
      job.finishedAt = job.updatedAt;
      await saveBestEffort(job, "cancelled-after-restart");
      publish("job.cancelled", { id: job.id, type: job.type, market: job.market });
      await onTerminal({ ...job }).catch(() => null);
      return job;
    }
    controllers.get(id)?.abort();
    releasePauseGate(id);
    job.cancelRequestedAt = new Date().toISOString();
    job.updatedAt = job.cancelRequestedAt;
    await saveBestEffort(job, "cancel-requested");
    return job;
  }

  async function start(id) {
    const job = await get(id);
    if (!job) return null;
    if (job.status === "paused") {
      running.set(id, job);
      job.pauseRequested = false;
      job.pausedAt = null;
      job.status = "queued";
      job.nextRetryAt = null;
      pending.push(job);
    }
    const index = pending.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      const [selected] = pending.splice(index, 1);
      selected.payload = {
        ...(selected.payload || {}),
        supervisorContext: { ...(selected.payload?.supervisorContext || {}), priority: "manual" },
      };
      selected.status = "queued";
      selected.startedManuallyAt = new Date().toISOString();
      pending.unshift(selected);
      await saveBestEffort(selected, "manual-start");
      await persistQueuePositions();
      publish("job.manual_start", { id: selected.id, type: selected.type, market: selected.market });
      pump();
      return selected;
    }
    if (["running", "pausing"].includes(job.status)) return job;
    return job;
  }

  async function restart(id) {
    const job = await get(id);
    if (!job) return null;
    if (["queued", "running", "pausing", "paused"].includes(job.status)) return job;
    const payload = { ...(job.payload || {}) };
    delete payload.trainingRunId;
    payload.restartOf = job.id;
    payload.restartRequestedAt = new Date().toISOString();
    payload.rework = {
      ...(payload.rework || {}),
      sourceJobId: job.id,
      previousStatus: job.status,
      previousFailureCategory: job.failureCategory || null,
      previousError: job.error || null,
      requestedAt: payload.restartRequestedAt,
      manual: true,
    };
    const next = await create(job.type, payload);
    next.restartedFrom = job.id;
    next.restartReason = job.error || job.failureCategory || "manual-restart";
    await saveBestEffort(next, "manual-restart");
    publish("job.restarted", {
      id: next.id,
      restartedFrom: job.id,
      type: next.type,
      market: next.market,
    });
    return next;
  }

  async function pause(id) {
    const job = await get(id);
    if (!job) return null;
    const index = pending.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      pending.splice(index, 1);
      job.status = "paused";
      job.pauseRequested = false;
      job.pausedAt = new Date().toISOString();
      job.updatedAt = job.pausedAt;
      job.heartbeatAt = job.pausedAt;
      await saveBestEffort(job, "paused-while-queued");
      await persistQueuePositions();
      publish("job.paused", { id: job.id, type: job.type, market: job.market, reason: "queued-task" });
      return job;
    }
    if (job.status === "running") {
      job.pauseRequested = true;
      job.pauseRequestedAt = new Date().toISOString();
      job.updatedAt = job.pauseRequestedAt;
      await saveBestEffort(job, "pause-requested");
      publish("job.pause_requested", { id: job.id, type: job.type, market: job.market });
    }
    return job;
  }

  async function resume(id) {
    const job = await get(id);
    if (!job) return null;
    if (job.status === "running" && job.pauseRequested) {
      job.pauseRequested = false;
      releasePauseGate(id);
      await saveBestEffort(job, "resume-requested");
      publish("job.resume_requested", { id: job.id, type: job.type, market: job.market });
      return job;
    }
    if (job.status !== "paused") return job;
    running.set(id, job);
    job.status = "queued";
    job.pauseRequested = false;
    job.pausedAt = null;
    job.updatedAt = new Date().toISOString();
    job.heartbeatAt = job.updatedAt;
    pending.push(job);
    await saveBestEffort(job, "resumed-to-queue");
    await persistQueuePositions();
    publish("job.resumed", { id: job.id, type: job.type, market: job.market });
    pump();
    return job;
  }

  async function reorder(id, directionOrOptions = "up") {
    const index = pending.findIndex((entry) => entry.id === id);
    if (index < 0) return await get(id);
    const hasPosition = directionOrOptions && typeof directionOrOptions === "object" && Number.isFinite(Number(directionOrOptions.position));
    const target = hasPosition
      ? Math.max(0, Math.min(pending.length - 1, Math.trunc(Number(directionOrOptions.position))))
      : index + (String(directionOrOptions).toLowerCase() === "down" ? 1 : -1);
    if (target < 0 || target >= pending.length) return pending[index];
    const [selected] = pending.splice(index, 1);
    pending.splice(target, 0, selected);
    await persistQueuePositions();
    publish("job.reordered", { id, direction: hasPosition ? "move" : directionOrOptions, queuePosition: target + 1 });
    return selected;
  }

  function status() {
    return {
      active: activeCount,
      queued: pending.length,
      maxConcurrent,
      activeHeavy: activeHeavyCount,
      maxHeavyConcurrent,
      activeDataHeavy: activeDataHeavyCount,
      maxDataHeavyConcurrent,
      activeResearchHeavy: activeResearchHeavyCount,
      maxResearchHeavyConcurrent,
      maxQueue,
      pending: pending.map((job, index) => ({ id: job.id, type: job.type, market: job.market, status: job.status, queuePosition: index + 1 })),
      running: [...running.values()]
        .filter((job) => ["running", "pausing", "paused"].includes(job.status))
        .map((job) => ({ id: job.id, type: job.type, market: job.market, progress: job.progress })),
    };
  }

  function configurePolicy(policy = {}) {
    if (policy.maxConcurrent != null) {
      maxConcurrent = Math.max(1, Math.min(8, Number(policy.maxConcurrent) || 1));
    }
    if (policy.maxHeavyConcurrent != null) {
      maxHeavyConcurrent = Math.max(1, Math.min(3, Number(policy.maxHeavyConcurrent) || 1));
    }
    if (policy.maxDataHeavyConcurrent != null) {
      maxDataHeavyConcurrent = Math.max(1, Math.min(2, Number(policy.maxDataHeavyConcurrent) || 1));
    }
    if (policy.maxResearchHeavyConcurrent != null) {
      maxResearchHeavyConcurrent = Math.max(1, Math.min(2, Number(policy.maxResearchHeavyConcurrent) || 1));
    }
    pump();
    return status();
  }

  async function shutdown(reason = "Backend is stopping; job can be resumed after restart.") {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(queueWakeTimer);
    const now = new Date().toISOString();
    const queued = pending.splice(0);
    const queuedIds = new Set(queued.map((job) => job.id));
    for (const job of queued) {
      // Keep queued work queued across a planned restart. It has not entered
      // execution and therefore must not consume an attempt or look like a
      // failed retry in the task center.
      job.shutdownResume = true;
      job.status = "queued";
      job.error = null;
      job.failureCategory = null;
      job.finishedAt = null;
      job.updatedAt = now;
      job.heartbeatAt = now;
      job.progressAt = job.progressAt || now;
      await saveBestEffort(job, "shutdown-queue-preserved");
    }
    for (const job of running.values()) {
      if (queuedIds.has(job.id)) continue;
      job.shutdownRequestedAt = now;
      job.shutdownResume = true;
      job.status = "queued";
      job.error = null;
      job.failureCategory = null;
      job.finishedAt = null;
      job.payload = { ...(job.payload || {}), resume: true, trainingRunId: job.trainingRunId };
      job.updatedAt = now;
      job.heartbeatAt = now;
      await saveBestEffort(job, "shutdown-queue-preserved");
    }
    for (const controller of controllers.values()) controller.abort();
  }

  return { cancel, configurePolicy, create, get, isRunning, list, pause, reorder, restart, resume, start, reconcile, register, shutdown, status };
}

export { createJobManager };
