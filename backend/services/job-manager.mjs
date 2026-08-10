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
  const pending = [];
  const maxConcurrent = Math.max(1, Math.min(8, Number(options.maxConcurrent || process.env.BACKGROUND_JOB_CONCURRENCY || 2)));
  const heavyTypes = new Set(["backtest", "historical-backtest-symbol", "factor-lab", "factor-evolution", "model-report"]);
  const maxHeavyConcurrent = Math.max(1, Math.min(2, Number(process.env.BACKGROUND_HEAVY_JOB_CONCURRENCY || 1)));
  const maxQueue = Math.max(maxConcurrent, Math.min(500, Number(options.maxQueue || process.env.BACKGROUND_JOB_QUEUE_LIMIT || 48)));
  let activeCount = 0;
  let activeHeavyCount = 0;
  if (!basePath) throw new Error("Job manager requires a persistence directory.");

  const pathFor = (id) => join(basePath, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

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

  async function list(filters = {}) {
    const type = filters.type ? String(filters.type) : null;
    const market = filters.market ? String(filters.market).toUpperCase() : null;
    const limit = Math.max(1, Math.min(500, Number(filters.limit || 100)));
    let files = [];
    try {
      files = (await readdir(basePath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .filter((entry) => !type || entry.name.startsWith(`${type.replace(/[^a-zA-Z0-9-]/g, "-")}-`))
        .map((entry) => entry.name);
    } catch {
      return { count: 0, jobs: [] };
    }
    const timestampFromFilename = (filename) => Number(filename.match(/-(\d{13})-[a-zA-Z0-9]{8}\.json$/)?.[1] || 0);
    files.sort((left, right) => timestampFromFilename(right) - timestampFromFilename(left) || right.localeCompare(left));
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
      finishedAt: job.finishedAt,
      heartbeatAt: job.heartbeatAt,
      resultSummary: job.result && typeof job.result === "object" ? {
        available: job.result.available,
        framework: job.result.framework,
        market: job.result.market,
        productionEligible: job.result.productionEligibility?.eligible ?? job.result.productionEligible,
      } : null,
    });
    const rows = [];
    for (const filename of files) {
      if (rows.length >= limit) break;
      try {
        const job = JSON.parse(await readFile(join(basePath, filename), "utf8"));
        if (type && job.type !== type) continue;
        if (market && String(job.market || "").toUpperCase() !== market) continue;
        if (job.status === "running" && !running.has(job.id)) {
          job.status = "failed";
          job.error = job.error || "Training job was interrupted by a backend restart.";
          job.failureCategory = "interrupted";
          job.updatedAt = new Date().toISOString();
          await saveBestEffort(job, "restart-reconciliation");
        }
        rows.push(compact(job));
      } catch {
        // Corrupt job files remain isolated and do not block the job list.
      }
    }
    rows.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
    return { count: rows.length, jobs: rows };
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
    let repaired = 0;
    let resumed = 0;
    for (const filename of files) {
      try {
        const job = JSON.parse(await readFile(join(basePath, filename), "utf8"));
        if (!["running", "queued"].includes(job.status)) continue;
        const maxAttempts = Math.max(Number(job.maxAttempts || 1), job.type === "backtest" ? 3 : 2);
        const restartBudgetExhausted = job.resumedAfterRestart === true
          && Number(job.attempt || 1) >= maxAttempts;
        const resumable = !restartBudgetExhausted
          && Number(job.runtimeVersion || 0) >= 2
          && [
            "backtest",
            "historical-backtest-symbol",
            "factor-lab",
            "factor-evolution",
            "model-report",
            "agent-replay",
            "pit-enrichment",
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
          job.payload = { ...(job.payload || {}), resume: true, trainingRunId: job.trainingRunId };
          job.updatedAt = new Date().toISOString();
          job.heartbeatAt = job.updatedAt;
          running.set(job.id, job);
          pending.push(job);
          await saveBestEffort(job, "startup-resume");
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
    if (resumed) pump();
    if (repaired) publish("job.reconciled", { scanned: files.length, repaired, resumed });
    return { scanned: files.length, repaired, resumed };
  }

  function isRunning(id) {
    const job = running.get(id);
    return Boolean(job && ["queued", "running"].includes(job.status));
  }

  function register(type, handler) {
    handlers.set(String(type), handler);
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
      job.queueWaitMs = Math.max(0, Date.now() - new Date(job.createdAt).getTime());
      await save(job, "running");
      publish("job.running", { id: job.id, type: job.type, market: job.market, queueWaitMs: job.queueWaitMs });
      const update = async (progress, detail = {}) => {
        if (controller.signal.aborted) {
          throw Object.assign(new Error("Background job was cancelled."), { code: "JOB_CANCELLED" });
        }
        job.progress = Math.max(job.progress, Math.min(0.98, Number(progress || 0)));
        job.updatedAt = new Date().toISOString();
        job.heartbeatAt = job.updatedAt;
        job.detail = detail;
        await save(job, "progress");
        publish("job.progress", { id: job.id, type: job.type, progress: job.progress, detail });
      };
      const checkpoint = async (name, value = {}) => {
        const key = String(name || "checkpoint").replace(/[^a-zA-Z0-9_-]/g, "_");
        job.checkpoints = job.checkpoints || {};
        job.checkpoints[key] = {
          ...(job.checkpoints[key] || {}),
          ...value,
          completedAt: new Date().toISOString(),
        };
        job.updatedAt = new Date().toISOString();
        job.heartbeatAt = job.updatedAt;
        await save(job, "checkpoint");
        publish("job.checkpoint", { id: job.id, type: job.type, market: job.market, name: key });
        return job.checkpoints[key];
      };
      heartbeatTimer = setInterval(() => {
        job.heartbeatAt = new Date().toISOString();
        job.updatedAt = job.heartbeatAt;
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
      job.error = null;
      job.failureCategory = null;
      job.progress = 1;
      job.updatedAt = new Date().toISOString();
      job.heartbeatAt = job.updatedAt;
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
      job.failureCategory = error?.code === "JOB_CANCELLED" ? "cancelled" : failureCategory(error);
      job.updatedAt = new Date().toISOString();
      job.heartbeatAt = job.updatedAt;
      if (job.failureCategory === "cancelled") {
        job.status = "cancelled";
        job.finishedAt = job.updatedAt;
        await saveBestEffort(job, "cancelled");
        publish("job.cancelled", { id: job.id, type: job.type, market: job.market });
        await onTerminal({ ...job }).catch(() => null);
        return;
      }
      const retryable = ["timeout", "interrupted", "resource_exhaustion"].includes(job.failureCategory);
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
      activeCount = Math.max(0, activeCount - 1);
      if (heavyTypes.has(job.type)) activeHeavyCount = Math.max(0, activeHeavyCount - 1);
      if (!requeued) running.delete(job.id);
      pump();
    }
  }

  function pump() {
    while (activeCount < maxConcurrent && pending.length) {
      const runnableIndex = pending.findIndex((candidate) => (
        !heavyTypes.has(candidate.type) || activeHeavyCount < maxHeavyConcurrent
      ));
      if (runnableIndex < 0) break;
      const [job] = pending.splice(runnableIndex, 1);
      activeCount += 1;
      if (heavyTypes.has(job.type)) activeHeavyCount += 1;
      job.startedAt = new Date().toISOString();
      setTimeout(() => {
        void execute(job);
      }, 0).unref?.();
    }
  }

  async function create(type, payload = {}) {
    const handler = handlers.get(String(type));
    if (!handler) throw Object.assign(new Error(`Unsupported background job type: ${type}`), { statusCode: 400 });
    const signature = jobSignature(type, payload);
    const duplicate = [...running.values()].find((job) => (
      job.signature === signature && ["queued", "running"].includes(job.status)
    ));
    if (duplicate) return { ...duplicate, deduplicated: true };
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
    job.cancelRequestedAt = new Date().toISOString();
    job.updatedAt = job.cancelRequestedAt;
    await saveBestEffort(job, "cancel-requested");
    return job;
  }

  function status() {
    return {
      active: activeCount,
      queued: pending.length,
      maxConcurrent,
      activeHeavy: activeHeavyCount,
      maxHeavyConcurrent,
      maxQueue,
      running: [...running.values()]
        .filter((job) => job.status === "running")
        .map((job) => ({ id: job.id, type: job.type, market: job.market, progress: job.progress })),
    };
  }

  return { cancel, create, get, isRunning, list, reconcile, register, status };
}

export { createJobManager };
