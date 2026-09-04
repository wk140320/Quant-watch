import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_OUTPUT_LIMIT = 12_000_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const FACTOR_OPERATIONS = new Set([
  "alpha-evolution",
  "cross-sectional-factor-research",
  "factor-lab",
  "factor-research",
]);
const LOW_PRIORITY_OPERATIONS = new Set([
  "historical-backtest",
  "historical-backtest-batch",
  "local-model-train",
  "production-model-train",
  "production-model-recover-oof",
  // Report rendering reads large OOF artifacts and writes DOCX/HTML. Keep it
  // on the bounded research lane so it cannot block interactive analysis.
  "model-report-generate",
]);
const DATA_OPERATIONS = new Set([
  "data-lake-upsert",
  "data-lake-read",
  "data-lake-panel-read",
  "data-lake-panel-upsert",
  "data-lake-summary",
  "data-lake-pit-upsert",
  "data-lake-pit-batch-upsert",
  "data-lake-pit-read",
  "data-lake-pit-coverage",
  "data-lake-backfill-local-caches",
  "baostock-corporate-actions",
  "rqdata-status",
  "rqdata-candles",
]);
const DATA_WRITE_OPERATIONS = new Set([
  "data-lake-upsert",
  "data-lake-panel-upsert",
  "data-lake-pit-upsert",
  "data-lake-pit-batch-upsert",
  "data-lake-backfill-local-caches",
  "rqdata-candles",
]);
const MAINTENANCE_OPERATIONS = new Set([
  "data-lake-audit",
  "training-artifact-maintenance",
]);

function taskPriority(operation) {
  const name = String(operation || "");
  // A collected PIT record has no value until it is durably written.  Give
  // write operations precedence over read-only audit/status work in the shared
  // ingest lane, while keeping the ordering stable within the same class.
  if (name === "data-lake-pit-batch-upsert") return 0;
  if (["data-lake-pit-upsert", "data-lake-upsert", "data-lake-panel-upsert"].includes(name)) return 1;
  if (["data-lake-summary", "data-lake-pit-read", "data-lake-pit-coverage", "data-lake-read", "data-lake-panel-read"].includes(name)) return 3;
  return 2;
}

function positiveInteger(value, fallback, minimum = 1, maximum = 32) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.round(parsed)))
    : fallback;
}

function createPythonQuantClient(options = {}) {
  const root = options.root;
  if (!root) throw new Error("Python quant client requires an application root.");
  const workerPath = options.workerPath || join(root, "quant_core", "worker.py");
  const localPython = options.localPython || join(root, ".venv", "bin", "python");
  const nativePython = options.nativePython || process.env.QUANT_ML_PYTHON_BIN || join(root, ".ml-venv", "bin", "python");
  const useNativeRuntime = String(process.env.QUANT_USE_NATIVE_ML || "true").toLowerCase() !== "false";
  // Keep the old environment as an explicit fallback. The isolated runtime
  // prevents incompatible OpenMP/BLAS wheels from being loaded together.
  const python = options.python
    || (useNativeRuntime && existsSync(nativePython) ? nativePython : null)
    || process.env.PYTHON_BIN
    || (existsSync(localPython) ? localPython : "python3");
  const persistent = options.persistent ?? process.env.PYTHON_CORE_PERSISTENT !== "false";
  const outputLimit = Number(options.outputLimit || DEFAULT_OUTPUT_LIMIT);
  const idleTimeoutMs = Number(options.idleTimeoutMs ?? process.env.PYTHON_CORE_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS);
  const lanes = {
    interactive: {
      name: "interactive",
      size: positiveInteger(options.interactiveWorkers ?? process.env.PYTHON_CORE_INTERACTIVE_WORKERS, 2, 1, 6),
      maxQueue: positiveInteger(options.interactiveQueueLimit ?? process.env.PYTHON_CORE_INTERACTIVE_QUEUE_LIMIT, 96, 1, 500),
      queue: [],
      workers: [],
    },
    factor: {
      name: "factor",
      size: positiveInteger(options.factorWorkers ?? process.env.PYTHON_CORE_FACTOR_WORKERS, 1, 1, 2),
      maxQueue: positiveInteger(options.factorQueueLimit ?? process.env.PYTHON_CORE_FACTOR_QUEUE_LIMIT, 12, 1, 100),
      queue: [],
      workers: [],
    },
    research: {
      name: "research",
      size: positiveInteger(options.researchWorkers ?? process.env.PYTHON_CORE_RESEARCH_WORKERS, 1, 1, 3),
      maxQueue: positiveInteger(options.researchQueueLimit ?? process.env.PYTHON_CORE_RESEARCH_QUEUE_LIMIT, 12, 1, 100),
      queue: [],
      workers: [],
    },
    ingest: {
      name: "ingest",
      size: positiveInteger(options.ingestWorkers ?? process.env.PYTHON_CORE_INGEST_WORKERS, 1, 1, 2),
      maxQueue: positiveInteger(options.ingestQueueLimit ?? process.env.PYTHON_CORE_INGEST_QUEUE_LIMIT, 96, 1, 500),
      queue: [],
      workers: [],
    },
    maintenance: {
      name: "maintenance",
      size: positiveInteger(options.maintenanceWorkers ?? process.env.PYTHON_CORE_MAINTENANCE_WORKERS, 1, 1, 2),
      maxQueue: positiveInteger(options.maintenanceQueueLimit ?? process.env.PYTHON_CORE_MAINTENANCE_QUEUE_LIMIT, 8, 1, 50),
      queue: [],
      workers: [],
    },
  };
  let closed = false;

  function laneFor(operation) {
    // PIT writes are serialized in the ingest lane. Read-only data audits and
    // coverage scans use maintenance so they cannot make already-collected
    // filings wait behind expensive Parquet reads.
    if (DATA_WRITE_OPERATIONS.has(String(operation))) return lanes.ingest;
    if (MAINTENANCE_OPERATIONS.has(String(operation))) return lanes.maintenance;
    if (DATA_OPERATIONS.has(String(operation))) return lanes.maintenance;
    if (FACTOR_OPERATIONS.has(String(operation))) return lanes.factor;
    return LOW_PRIORITY_OPERATIONS.has(String(operation)) ? lanes.research : lanes.interactive;
  }

  function oneShot(operation, payload, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      const lowerPriority = (LOW_PRIORITY_OPERATIONS.has(String(operation)) || FACTOR_OPERATIONS.has(String(operation)))
        && existsSync("/usr/bin/nice");
      const command = lowerPriority ? "/usr/bin/nice" : python;
      const args = lowerPriority ? ["-n", "10", python, workerPath] : [workerPath];
      const child = spawn(command, args, {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1",
          OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || "1",
          MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || "1",
          VECLIB_MAXIMUM_THREADS: process.env.VECLIB_MAXIMUM_THREADS || "1",
          NUMEXPR_MAX_THREADS: process.env.NUMEXPR_MAX_THREADS || "1",
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || join(root, ".cache", "matplotlib"),
        },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener?.("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(Object.assign(new Error("Python quant core request was cancelled."), { code: "JOB_CANCELLED" }));
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener?.("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`Python quant core timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > outputLimit) {
          child.kill("SIGKILL");
          finish(new Error("Python quant core response exceeded the size limit."));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("error", (error) => {
        if (error?.code !== "EPIPE") finish(new Error(`Python quant core stdout failed: ${error.message}`));
      });
      child.stderr.on("error", (error) => {
        if (error?.code !== "EPIPE") finish(new Error(`Python quant core stderr failed: ${error.message}`));
      });
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") finish(new Error(`Unable to send request to Python quant core: ${error.message}`));
      });
      child.on("error", (error) => finish(new Error(`Unable to start Python quant core: ${error.message}`)));
      child.on("close", (code) => {
        if (settled) return;
        let parsed;
        try {
          parsed = JSON.parse(stdout || "{}");
        } catch {
          finish(new Error(`Python quant core returned invalid JSON. ${stderr.slice(-600)}`));
          return;
        }
        if (code !== 0 || parsed.ok !== true) {
          finish(new Error(parsed.error || stderr.slice(-600) || `Python quant core exited with code ${code}.`));
          return;
        }
        finish(null, parsed.result);
      });
      child.stdin.end(JSON.stringify({ operation, ...payload }));
    });
  }

  function rejectTask(task, error) {
    if (!task || task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    clearTimeout(task.queueTimer);
    task.cleanup?.();
    task.reject(error);
  }

  function resolveTask(task, value) {
    if (!task || task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    clearTimeout(task.queueTimer);
    task.cleanup?.();
    task.resolve(value);
  }

  function stopWorker(worker, reason = null) {
    if (!worker) return;
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
    const active = worker.active;
    worker.active = null;
    worker.stopping = true;
    if (active && reason) rejectTask(active, reason);
    try {
      worker.child?.kill("SIGKILL");
    } catch {
      // The process may already have exited between timeout and cleanup.
    }
  }

  function scheduleIdleStop(worker) {
    clearTimeout(worker.idleTimer);
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || worker.active || worker.lane.queue.length) return;
    worker.idleTimer = setTimeout(() => {
      if (!worker.active && !worker.lane.queue.length) stopWorker(worker);
    }, idleTimeoutMs);
    worker.idleTimer.unref?.();
  }

  function dispatchLane(lane) {
    if (closed) return;
    for (let index = 0; index < lane.size && lane.queue.length; index += 1) {
      let worker = lane.workers[index];
      if (!worker || worker.exited) {
        worker = spawnPersistentWorker(lane, index);
        lane.workers[index] = worker;
      }
      if (worker.active || worker.stopping) continue;
      const task = lane.queue.shift();
      worker.active = task;
      clearTimeout(worker.idleTimer);
      clearTimeout(task.queueTimer);
      task.queueTimer = null;
      task.startedAt = Date.now();
      task.timer = setTimeout(() => {
        const error = Object.assign(
          new Error(`Python quant core ${task.operation} timed out after ${task.timeoutMs}ms in the ${lane.name} worker lane.`),
          { code: "PYTHON_CORE_TIMEOUT", lane: lane.name, operation: task.operation },
        );
        stopWorker(worker, error);
      }, task.timeoutMs);
      try {
        worker.child.stdin.write(`${JSON.stringify({
          __request_id: task.id,
          operation: task.operation,
          ...task.payload,
        })}\n`);
      } catch (error) {
        stopWorker(worker, new Error(`Unable to send request to persistent Python quant core: ${error.message}`));
      }
    }
  }

  function handleWorkerLine(worker, line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      worker.diagnostics = `${worker.diagnostics}${line}\n`.slice(-1_200);
      return;
    }
    const task = worker.active;
    if (!task || String(parsed.request_id || "") !== task.id) {
      worker.diagnostics = `${worker.diagnostics}Unexpected response ${String(parsed.request_id || "without id")}\n`.slice(-1_200);
      return;
    }
    worker.active = null;
    if (parsed.ok === true) {
      resolveTask(task, parsed.result);
    } else {
      rejectTask(task, Object.assign(
        new Error(parsed.error || `Python quant core ${task.operation} failed.`),
        {
          code: "PYTHON_CORE_ERROR",
          lane: worker.lane.name,
          operation: task.operation,
          pythonErrorType: parsed.error_type,
        },
      ));
    }
    dispatchLane(worker.lane);
    scheduleIdleStop(worker);
  }

  function spawnPersistentWorker(lane, index) {
    const lowerPriority = lane.name !== "interactive" && existsSync("/usr/bin/nice");
    const command = lowerPriority ? "/usr/bin/nice" : python;
    const args = lowerPriority
      ? ["-n", "10", python, workerPath, "--persistent"]
      : [workerPath, "--persistent"];
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1",
        OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || "1",
        MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || "1",
        VECLIB_MAXIMUM_THREADS: process.env.VECLIB_MAXIMUM_THREADS || "1",
        NUMEXPR_MAX_THREADS: process.env.NUMEXPR_MAX_THREADS || "1",
        PYTHONUNBUFFERED: "1",
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || join(root, ".cache", "matplotlib"),
      },
    });
    child.unref?.();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
    const worker = {
      index,
      lane,
      child,
      active: null,
      buffer: "",
      stderr: "",
      diagnostics: "",
      idleTimer: null,
      stopping: false,
      exited: false,
    };
    child.stdout.on("data", (chunk) => {
      worker.buffer += chunk.toString();
      if (worker.buffer.length > outputLimit) {
        stopWorker(worker, new Error("Persistent Python quant core response exceeded the size limit."));
        return;
      }
      let newline = worker.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = worker.buffer.slice(0, newline).trim();
        worker.buffer = worker.buffer.slice(newline + 1);
        if (line) handleWorkerLine(worker, line);
        newline = worker.buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      worker.stderr = `${worker.stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") stopWorker(worker, new Error(`Persistent Python quant core stdin failed: ${error.message}`));
    });
    child.on("error", (error) => {
      stopWorker(worker, new Error(`Unable to start persistent Python quant core: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      worker.exited = true;
      worker.stopping = false;
      clearTimeout(worker.idleTimer);
      const active = worker.active;
      worker.active = null;
      if (active) {
        rejectTask(active, new Error(
          `Persistent Python quant core exited during ${active.operation} (${signal || code}). ${worker.stderr.slice(-600)}`,
        ));
      }
      if (lane.workers[index] === worker) lane.workers[index] = null;
      dispatchLane(lane);
    });
    return worker;
  }

  function runPythonQuantCore(
    operation,
    payload = {},
    timeoutMs = Number(process.env.PYTHON_CORE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    options = {},
  ) {
    if (!persistent) return oneShot(operation, payload, timeoutMs, options);
    if (closed) return Promise.reject(new Error("Python quant core client is closed."));
    if (options.signal?.aborted) {
      return Promise.reject(Object.assign(new Error("Python quant core request was cancelled."), { code: "JOB_CANCELLED" }));
    }
    const lane = laneFor(operation);
    const queuedAndRunning = lane.queue.length + lane.workers.filter((worker) => worker?.active).length;
    if (queuedAndRunning >= lane.maxQueue + lane.size) {
      return Promise.reject(Object.assign(
        new Error(`Python ${lane.name} queue is full; retry after active work completes.`),
        { statusCode: 503, code: "PYTHON_CORE_BACKPRESSURE", lane: lane.name, retryAfterSeconds: 5 },
      ));
    }
    return new Promise((resolve, reject) => {
      const task = {
        id: randomUUID(),
        operation: String(operation),
        payload,
        timeoutMs: Math.max(250, Number(timeoutMs || DEFAULT_TIMEOUT_MS)),
        queuedAt: Date.now(),
        resolve,
        reject,
        timer: null,
        queueTimer: null,
        settled: false,
        cleanup: null,
      };
      const onAbort = () => {
        const queuedIndex = lane.queue.findIndex((entry) => entry.id === task.id);
        const cancelled = Object.assign(new Error("Python quant core request was cancelled."), { code: "JOB_CANCELLED" });
        if (queuedIndex >= 0) {
          lane.queue.splice(queuedIndex, 1);
          rejectTask(task, cancelled);
          return;
        }
        const worker = lane.workers.find((entry) => entry?.active?.id === task.id);
        if (worker) stopWorker(worker, cancelled);
      };
      task.cleanup = () => options.signal?.removeEventListener?.("abort", onAbort);
      options.signal?.addEventListener?.("abort", onAbort, { once: true });
      task.priority = taskPriority(task.operation);
      const queuedAfter = lane.queue.findIndex((candidate) => Number(candidate.priority ?? taskPriority(candidate.operation)) > task.priority);
      if (queuedAfter < 0) lane.queue.push(task);
      else lane.queue.splice(queuedAfter, 0, task);
      const defaultQueueTimeoutMs = lane.name === "research"
        ? 30 * 60_000
        : lane.name === "ingest" || lane.name === "maintenance"
          ? 3 * 60_000
          : 5 * 60_000;
      const priorityWriteTimeout = task.operation === "data-lake-pit-batch-upsert"
        ? 12 * 60_000
        : defaultQueueTimeoutMs;
      const configuredQueueTimeout = Number(process.env[`PYTHON_CORE_${lane.name.toUpperCase()}_QUEUE_TIMEOUT_MS`] || 0);
      const queueTimeoutMs = task.operation === "data-lake-pit-batch-upsert"
        ? Math.max(priorityWriteTimeout, configuredQueueTimeout || 0)
        : Math.max(5_000, configuredQueueTimeout || defaultQueueTimeoutMs);
      task.queueTimer = setTimeout(() => {
        const queuedIndex = lane.queue.findIndex((entry) => entry.id === task.id);
        if (queuedIndex < 0) return;
        lane.queue.splice(queuedIndex, 1);
        rejectTask(task, Object.assign(
          new Error(`Python ${lane.name} queue wait exceeded ${queueTimeoutMs}ms before ${task.operation} could start.`),
          { code: "PYTHON_CORE_QUEUE_TIMEOUT", lane: lane.name, operation: task.operation },
        ));
      }, queueTimeoutMs);
      task.queueTimer.unref?.();
      dispatchLane(lane);
    });
  }

  runPythonQuantCore.status = () => Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [
    name,
    {
      workers: lane.workers.filter(Boolean).length,
      busy: lane.workers.filter((worker) => worker?.active).length,
      queued: lane.queue.length,
      capacity: lane.size,
      queueLimit: lane.maxQueue,
      operations: lane.workers.filter((worker) => worker?.active).map((worker) => worker.active.operation),
    },
  ]));
  runPythonQuantCore.close = () => {
    closed = true;
    for (const lane of Object.values(lanes)) {
      const error = new Error("Python quant core client closed.");
      lane.queue.splice(0).forEach((task) => rejectTask(task, error));
      lane.workers.filter(Boolean).forEach((worker) => stopWorker(worker, error));
    }
  };
  return runPythonQuantCore;
}

export { createPythonQuantClient };
