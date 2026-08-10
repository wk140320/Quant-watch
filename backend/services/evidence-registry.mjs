import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const FAMILY_BY_JOB = Object.freeze({
  backtest: "training",
  training: "minute",
  "historical-backtest-symbol": "training",
  "factor-lab": "factor",
  "factor-evolution": "alpha",
  "agent-replay": "agent",
  "intraday-training": "minute",
  "model-report": "acceptance",
  "learning-evaluation": "acceptance",
  "pit-enrichment": "data",
  "pit-cache-backfill": "data",
  "history-backfill": "data",
  "data-lake-migrate": "data",
});
const LEARNING_JOB_PREFIXES = Object.freeze(Object.keys(FAMILY_BY_JOB).map((type) => `${type}-`));

function json(value) {
  return JSON.stringify(value ?? null, (_key, item) => (
    typeof item === "number" && !Number.isFinite(item) ? null : item
  ));
}

function resultSummary(result) {
  if (!result || typeof result !== "object") return null;
  const production = result.productionTraining || result.production_training || {};
  return {
    available: result.available,
    framework: result.framework,
    market: result.market,
    updated: result.updated,
    sampleCount: result.sampleCount,
    updatedAt: result.updatedAt,
    strictOofRows: result.strictOofRows,
    independentDates: result.independentDates,
    modelVersion: result.modelVersion || production.manifest?.model_version,
    productionEligible: result.productionEligible ?? result.productionEligibility?.eligible,
    dataVersion: result.dataVersion || result.dataset?.dataVersion || production.dataset?.dataVersion,
    horizons: (production.horizonModels || result.horizonModels || []).map((row) => ({
      horizon: row.horizon,
      available: row.available,
      modelVersion: row.modelVersion,
      productionEvidencePassed: row.productionEvidencePassed,
      metrics: row.metrics,
      directionMetrics: row.directionMetrics,
    })),
  };
}

function createEvidenceRegistry({ dbPath, jobsPath } = {}) {
  if (!dbPath) throw new Error("Evidence registry requires a SQLite path.");
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      job_type TEXT NOT NULL, market TEXT, status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0, payload_json TEXT NOT NULL,
      result_json TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status_time
      ON background_jobs(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS learning_runs (
      run_id TEXT PRIMARY KEY, job_id TEXT, family TEXT NOT NULL, market TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      data_version TEXT, model_version TEXT, failure_category TEXT,
      summary_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_runs_market_family_time
      ON learning_runs(market, family, updated_at DESC);
    CREATE TABLE IF NOT EXISTS learning_trajectory (
      trajectory_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, family TEXT NOT NULL,
      market TEXT, recorded_at TEXT NOT NULL, status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0, metric_name TEXT, metric_value REAL,
      evidence_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_trajectory_market_family_time
      ON learning_trajectory(market, family, recorded_at DESC);
    CREATE TABLE IF NOT EXISTS learning_artifacts (
      artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, artifact_type TEXT NOT NULL,
      path TEXT, content_hash TEXT, created_at TEXT NOT NULL, metadata_json TEXT NOT NULL
    );
  `);

  const upsertJob = database.prepare(`
    INSERT INTO background_jobs(id,created_at,updated_at,job_type,market,status,progress,payload_json,result_json,error)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status,
      progress=excluded.progress,result_json=excluded.result_json,error=excluded.error,
      payload_json=excluded.payload_json
  `);
  const upsertRun = database.prepare(`
    INSERT INTO learning_runs(run_id,job_id,family,market,status,created_at,updated_at,data_version,model_version,failure_category,summary_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,
      data_version=coalesce(excluded.data_version,learning_runs.data_version),
      model_version=coalesce(excluded.model_version,learning_runs.model_version),
      failure_category=excluded.failure_category,summary_json=excluded.summary_json
  `);
  const insertTrajectory = database.prepare(`
    INSERT OR IGNORE INTO learning_trajectory(
      trajectory_id,run_id,family,market,recorded_at,status,progress,metric_name,metric_value,evidence_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `);
  const importState = {
    status: "idle",
    discovered: 0,
    skipped: 0,
    scanned: 0,
    imported: 0,
    failed: 0,
    updatedAt: null,
    error: null,
  };

  async function beginBatchTransaction() {
    let lastError = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        database.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        lastError = error;
        if (!/locked|busy/i.test(String(error?.message || error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 200 + attempt * 150)));
      }
    }
    throw lastError || new Error("Evidence registry remained locked during legacy import.");
  }

  async function readLegacyJob(name) {
    const controller = new AbortController();
    let timeoutId = null;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(`Legacy evidence read timed out: ${name}`));
        }, 2_000);
        timeoutId.unref?.();
      });
      const source = readFile(join(jobsPath, name), {
        encoding: "utf8",
        signal: controller.signal,
      });
      return JSON.parse(await Promise.race([source, timeout]));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function persistJob(job, { trajectory = false } = {}) {
    const family = FAMILY_BY_JOB[String(job.type)] || "operations";
    const runId = String(job.trainingRunId || job.id);
    const summary = resultSummary(job.result);
    upsertJob.run(
      String(job.id), String(job.createdAt || job.updatedAt || new Date().toISOString()),
      String(job.updatedAt || new Date().toISOString()), String(job.type || "unknown"),
      job.market ? String(job.market).toUpperCase() : null, String(job.status || "unknown"),
      Number(job.progress || 0), json(job.payload || {}), json(summary), job.error ? String(job.error) : null,
    );
    upsertRun.run(
      runId, String(job.id), family, job.market ? String(job.market).toUpperCase() : null,
      String(job.status || "unknown"), String(job.createdAt || job.updatedAt || new Date().toISOString()),
      String(job.updatedAt || new Date().toISOString()),
      job.payload?.dataVersion || summary?.dataVersion || null,
      summary?.modelVersion || null, job.failureCategory || null,
      json({ detail: job.detail || null, result: summary, error: job.error || null, attempt: job.attempt || 1 }),
    );
    if (trajectory || ["complete", "failed", "cancelled"].includes(String(job.status))) {
      const evidence = { detail: job.detail || null, result: summary, error: job.error || null, failureCategory: job.failureCategory || null };
      const trajectoryId = createHash("sha256").update(`${job.id}:${job.status}:${job.updatedAt}:${job.progress}`).digest("hex");
      insertTrajectory.run(
        trajectoryId, runId, family, job.market ? String(job.market).toUpperCase() : null,
        String(job.updatedAt || new Date().toISOString()), String(job.status || "unknown"),
        Number(job.progress || 0), null, null, json(evidence),
      );
    }
    const resultMarkets = Array.isArray(job.result?.markets)
      ? job.result.markets.map((row) => String(row?.market || row || "").toUpperCase())
      : [];
    const payloadMarkets = Array.isArray(job.payload?.markets)
      ? job.payload.markets.map((value) => String(value || "").toUpperCase())
      : [];
    const inferredMarkets = job.type === "factor-evolution" && !job.market ? ["ASX", "US", "CN"] : [];
    const relatedMarkets = (job.market ? [] : [...new Set([...resultMarkets, ...payloadMarkets, ...inferredMarkets])])
      .filter((value) => ["ASX", "US", "CN"].includes(value));
    for (const relatedMarket of relatedMarkets) {
      const marketRunId = `${runId}:${relatedMarket}`;
      upsertRun.run(
        marketRunId, String(job.id), family, relatedMarket,
        String(job.status || "unknown"), String(job.createdAt || job.updatedAt || new Date().toISOString()),
        String(job.updatedAt || new Date().toISOString()),
        job.payload?.dataVersion || summary?.dataVersion || null,
        summary?.modelVersion || null, job.failureCategory || null,
        json({ parentRunId: runId, detail: job.detail || null, result: summary, error: job.error || null, attempt: job.attempt || 1 }),
      );
      if (trajectory || ["complete", "failed", "cancelled"].includes(String(job.status))) {
        const trajectoryId = createHash("sha256").update(`${job.id}:${relatedMarket}:${job.status}:${job.updatedAt}:${job.progress}`).digest("hex");
        insertTrajectory.run(
          trajectoryId, marketRunId, family, relatedMarket,
          String(job.updatedAt || new Date().toISOString()), String(job.status || "unknown"),
          Number(job.progress || 0), null, null,
          json({ parentRunId: runId, detail: job.detail || null, result: summary, error: job.error || null, failureCategory: job.failureCategory || null }),
        );
      }
    }
  }

  async function importJobs() {
    if (!jobsPath) return { scanned: 0, imported: 0, failed: 0 };
    database.exec("DELETE FROM learning_trajectory WHERE family = 'operations'; DELETE FROM learning_runs WHERE family = 'operations';");
    const discovered = (await readdir(jobsPath).catch(() => [])).filter((name) => name.endsWith(".json"));
    const names = discovered.filter((name) => LEARNING_JOB_PREFIXES.some((prefix) => name.startsWith(prefix)));
    let imported = 0;
    let failed = 0;
    Object.assign(importState, {
      status: "running",
      discovered: discovered.length,
      skipped: discovered.length - names.length,
      scanned: names.length,
      imported: 0,
      failed: 0,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    const batchSize = 96;
    try {
      for (let offset = 0; offset < names.length; offset += batchSize) {
        const batch = names.slice(offset, offset + batchSize);
        // Read outside the SQLite transaction so startup imports never lock the
        // live evidence API while waiting on thousands of legacy files.
        const decoded = await Promise.all(batch.map(async (name) => {
          try {
            return await readLegacyJob(name);
          } catch {
            failed += 1;
            return null;
          }
        }));
        await beginBatchTransaction();
        try {
          for (const job of decoded) {
            if (!job) continue;
            try {
              persistJob(job, { trajectory: true });
              imported += 1;
            } catch {
              failed += 1;
            }
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        Object.assign(importState, {
          imported,
          failed,
          updatedAt: new Date().toISOString(),
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      Object.assign(importState, { status: "complete", imported, failed, updatedAt: new Date().toISOString() });
      return { discovered: discovered.length, skipped: discovered.length - names.length, scanned: names.length, imported, failed };
    } catch (error) {
      Object.assign(importState, {
        status: "failed",
        imported,
        failed: failed + 1,
        updatedAt: new Date().toISOString(),
        error: error.message || String(error),
      });
      throw error;
    }
  }

  function trajectories({ market = "", family = "", limit = 500 } = {}) {
    const clauses = [];
    const params = [];
    if (market) { clauses.push("market = ?"); params.push(String(market).toUpperCase()); }
    if (family) { clauses.push("family = ?"); params.push(String(family)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(5000, Number(limit || 500))));
    const rows = database.prepare(`
      SELECT trajectory_id,run_id,family,market,recorded_at,status,progress,metric_name,metric_value,evidence_json
      FROM learning_trajectory ${where} ORDER BY recorded_at DESC LIMIT ?
    `).all(...params).map((row) => ({
      id: row.trajectory_id, runId: row.run_id, family: row.family, market: row.market,
      recordedAt: row.recorded_at, status: row.status, progress: row.progress,
      metricName: row.metric_name, metricValue: row.metric_value,
      evidence: JSON.parse(row.evidence_json || "{}"),
    }));
    const counts = database.prepare(`
      SELECT family,status,count(*) AS count FROM learning_runs ${where}
      GROUP BY family,status ORDER BY family,status
    `).all(...params.slice(0, -1));
    return { available: true, import: { ...importState }, count: rows.length, rows, counts };
  }

  function close() { database.close(); }
  return { close, importJobs, persistJob, trajectories };
}

export { createEvidenceRegistry };
