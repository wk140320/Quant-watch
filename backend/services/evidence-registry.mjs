import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(gunzipCallback);

const FAMILY_BY_JOB = Object.freeze({
  backtest: "training",
  training: "minute",
  "historical-backtest-symbol": "training",
  "factor-lab": "factor",
  "factor-research": "factor",
  "factor-evolution": "alpha",
  "calibration-audit": "calibration",
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
    sampleCount: result.sampleCount ?? (Array.isArray(result.markets)
      ? result.markets.reduce((sum, row) => sum + Number(row?.evolution?.sampleCount || row?.sampleTotal || 0), 0)
      : undefined),
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
      weights: row.weights,
      directionWeights: row.directionWeights,
      rankingMetrics: row.rankingMetrics,
      expectedValue: row.expectedValue,
      longTradeExpectedValue: row.longTradeExpectedValue,
      longTradeGate: row.longTradeGate,
      selectiveRankingHead: row.selectiveRankingHead,
      highConfidenceFalsePositiveRiskHead: row.highConfidenceFalsePositiveRiskHead,
      positiveFoldCount: row.positiveFoldCount,
      foldCount: Array.isArray(row.foldMetrics) ? row.foldMetrics.length : 0,
      oofRows: row.oofRows,
      metaTestRows: row.metaTestRows,
    })),
    marketEvidence: Array.isArray(result.markets) ? result.markets.map((row) => ({
      market: row.market,
      availableCount: row.availableCount,
      sampleTotal: row.sampleTotal,
      researchAvailable: row.research?.available !== false,
      evolution: row.evolution ? {
        attempted: row.evolution.attempted,
        completed: row.evolution.completed,
        failed: row.evolution.failed,
        sampleCount: row.evolution.sampleCount,
      } : null,
    })) : [],
  };
}

function createEvidenceRegistry({ dbPath, jobsPath } = {}) {
  if (!dbPath) throw new Error("Evidence registry requires a SQLite path.");
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dataset_snapshots (
      snapshot_id TEXT PRIMARY KEY, market TEXT, data_version TEXT NOT NULL,
      content_hash TEXT, universe_version TEXT, feature_schema_hash TEXT,
      label_definition TEXT, created_at TEXT NOT NULL, source_json TEXT NOT NULL,
      audit_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_market_time
      ON dataset_snapshots(market, created_at DESC);
    CREATE TABLE IF NOT EXISTS experiment_runs (
      experiment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, family TEXT NOT NULL,
      market TEXT, status TEXT NOT NULL, comparison_key TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      config_json TEXT NOT NULL, result_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_experiment_runs_market_family_time
      ON experiment_runs(market, family, updated_at DESC);
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      job_type TEXT NOT NULL, market TEXT, status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0, payload_json TEXT NOT NULL,
      metadata_json TEXT,
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
  // Older local databases predate the lightweight task metadata column.  Keep
  // the migration idempotent so a restart can upgrade an existing workspace
  // without touching the immutable task JSON archive.
  try { database.exec("ALTER TABLE background_jobs ADD COLUMN metadata_json TEXT"); } catch {}
  database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(1, new Date().toISOString());

  const upsertJob = database.prepare(`
    INSERT INTO background_jobs(id,created_at,updated_at,job_type,market,status,progress,payload_json,metadata_json,result_json,error)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status,
      progress=excluded.progress,result_json=excluded.result_json,error=excluded.error,
      payload_json=excluded.payload_json,metadata_json=excluded.metadata_json
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
  const upsertSnapshot = database.prepare(`
    INSERT INTO dataset_snapshots(
      snapshot_id,market,data_version,content_hash,universe_version,feature_schema_hash,
      label_definition,created_at,source_json,audit_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_id) DO UPDATE SET
      content_hash=excluded.content_hash,
      source_json=excluded.source_json,
      audit_json=excluded.audit_json
  `);
  const upsertExperiment = database.prepare(`
    INSERT INTO experiment_runs(
      experiment_id,run_id,family,market,status,comparison_key,created_at,updated_at,
      config_json,result_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(experiment_id) DO UPDATE SET
      status=excluded.status,updated_at=excluded.updated_at,
      result_json=excluded.result_json
  `);
  const importState = {
    status: "idle",
    discovered: 0,
    skipped: 0,
    scanned: 0,
    imported: 0,
    unavailable: 0,
    failed: 0,
    updatedAt: null,
    error: null,
  };
  const manifestImportState = {
    status: "idle",
    discovered: 0,
    imported: 0,
    unavailable: 0,
    failed: 0,
    updatedAt: null,
    error: null,
  };

  function persistDerivedEvidence({
    parentJob,
    suffix,
    family,
    market,
    status = "complete",
    metricName = null,
    metricValue = null,
    evidence = {},
    modelVersion = null,
    dataVersion = null,
  }) {
    const recordedAt = String(parentJob.updatedAt || new Date().toISOString());
    const runId = `${String(parentJob.trainingRunId || parentJob.id)}:${suffix}`;
    const normalizedMarket = market ? String(market).toUpperCase() : null;
    upsertRun.run(
      runId,
      String(parentJob.id),
      family,
      normalizedMarket,
      status,
      String(parentJob.createdAt || recordedAt),
      recordedAt,
      dataVersion,
      modelVersion,
      status === "failed" ? parentJob.failureCategory || "derived_evidence" : null,
      json({ parentRunId: String(parentJob.trainingRunId || parentJob.id), result: evidence }),
    );
    const trajectoryId = createHash("sha256")
      .update(`${parentJob.id}:${suffix}:${status}:${recordedAt}`)
      .digest("hex");
    insertTrajectory.run(
      trajectoryId,
      runId,
      family,
      normalizedMarket,
      recordedAt,
      status,
      status === "complete" ? 1 : Number(parentJob.progress || 0),
      metricName,
      Number.isFinite(Number(metricValue)) ? Number(metricValue) : null,
      json({ parentRunId: String(parentJob.trainingRunId || parentJob.id), result: evidence }),
    );
  }

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
          reject(Object.assign(new Error(`Legacy evidence artifact is unavailable or timed out: ${name}`), {
            code: "LEGACY_ARTIFACT_UNAVAILABLE",
          }));
        }, 2_000);
        timeoutId.unref?.();
      });
      const source = readFile(join(jobsPath, name), {
        encoding: "utf8",
        signal: controller.signal,
      });
      const raw = await Promise.race([source, timeout]);
      if (!String(raw || "").trim()) {
        throw Object.assign(new Error(`Legacy evidence artifact is currently unavailable: ${name}`), {
          code: "LEGACY_ARTIFACT_UNAVAILABLE",
        });
      }
      return JSON.parse(raw);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function persistJob(job, { trajectory = false } = {}) {
    const family = FAMILY_BY_JOB[String(job.type)] || "operations";
    const runId = String(job.trainingRunId || job.id);
    const summary = resultSummary(job.result);
    const production = job.result?.productionTraining || job.result?.production_training || null;
    const manifest = production?.manifest || job.result?.manifest || null;
    const dataVersion = job.payload?.dataVersion || summary?.dataVersion || manifest?.data_version || manifest?.dataVersion || null;
    // Older artifacts often carried a data version but no separate snapshot
    // id. Keep those records in the evidence layer under a deterministic id
    // instead of silently dropping their dataset lineage.
    const snapshotId = manifest?.snapshot_id || manifest?.snapshotId || (dataVersion
      ? `derived:${String(job.market || manifest?.market || "global").toUpperCase()}:${dataVersion}`
      : null);
    if (snapshotId && dataVersion) {
      upsertSnapshot.run(
        String(snapshotId), job.market ? String(job.market).toUpperCase() : manifest?.market || null,
        String(dataVersion), manifest?.snapshot_content_hash || manifest?.snapshotContentHash || null,
        manifest?.universe_version || manifest?.universeVersion || null,
        manifest?.feature_schema_hash || manifest?.featureSchemaHash || null,
        manifest?.label_definition || manifest?.labelDefinition || null,
        String(job.updatedAt || new Date().toISOString()),
        json({ sources: production?.dataset?.sources || job.result?.sources || [] }),
        json({
          pointInTimeCoveragePct: production?.dataset?.pointInTimeCoveragePct ?? null,
          pointInTimeJoinViolationCount: production?.dataset?.pointInTimeJoinViolationCount ?? null,
          crossMarketRowsExcluded: production?.dataset?.crossMarketRowsExcluded ?? null,
          duplicateRowsExcluded: production?.dataset?.duplicateRowsExcluded ?? null,
        }),
      );
    }
    const experimentId = `${runId}:experiment`;
    upsertExperiment.run(
      experimentId, runId, family, job.market ? String(job.market).toUpperCase() : null,
      String(job.status || "unknown"), manifest?.comparison_key || manifest?.comparisonKey || null,
      String(job.createdAt || job.updatedAt || new Date().toISOString()),
      String(job.updatedAt || new Date().toISOString()),
      json({ plan: job.payload || {}, trainingFingerprint: manifest?.training_fingerprint || manifest?.trainingFingerprint || null }),
      json({ result: summary, failureCategory: job.failureCategory || null, error: job.error || null }),
    );
    upsertJob.run(
      String(job.id), String(job.createdAt || job.updatedAt || new Date().toISOString()),
      String(job.updatedAt || new Date().toISOString()), String(job.type || "unknown"),
      job.market ? String(job.market).toUpperCase() : null, String(job.status || "unknown"),
      Number(job.progress || 0), json(job.payload || {}), json({
        detail: job.detail || null,
        createdAt: job.createdAt || null,
        startedAt: job.startedAt || null,
        updatedAt: job.updatedAt || null,
        progressAt: job.progressAt || null,
        finishedAt: job.finishedAt || null,
        heartbeatAt: job.heartbeatAt || null,
        queuePosition: job.queuePosition ?? null,
        attempt: job.attempt || 1,
        maxAttempts: job.maxAttempts || null,
        trainingRunId: job.trainingRunId || null,
        failureCategory: job.failureCategory || null,
        pauseRequested: job.pauseRequested === true,
        pausedAt: job.pausedAt || null,
        restartedFrom: job.restartedFrom || null,
        stagnation: job.stagnation || null,
        checkpoints: job.checkpoints && typeof job.checkpoints === "object"
          ? Object.fromEntries(Object.entries(job.checkpoints).slice(-24))
          : {},
      }), json(summary), job.error ? String(job.error) : null,
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
    if (["complete", "failed", "cancelled"].includes(String(job.status)) && String(job.type) === "backtest") {
      for (const row of summary?.horizons || []) {
        const direction = row.directionMetrics || {};
        persistDerivedEvidence({
          parentJob: job,
          suffix: `calibration-${Number(row.horizon || 0)}d`,
          family: "calibration",
          market: job.market,
          status: String(job.status),
          metricName: "brierSkillScore",
          metricValue: direction.brierSkillScore,
          modelVersion: row.modelVersion || summary?.modelVersion || null,
          dataVersion: summary?.dataVersion || null,
          evidence: {
            framework: "strict-oof-constrained-stacking-calibration",
            horizon: row.horizon,
            available: row.available === true,
            productionEvidencePassed: row.productionEvidencePassed === true,
            oofRows: row.oofRows || 0,
            metaTestRows: row.metaTestRows || 0,
            weights: row.weights || {},
            directionWeights: row.directionWeights || {},
            metrics: row.metrics || {},
            directionMetrics: direction,
            rankingMetrics: row.rankingMetrics || {},
            expectedValue: row.expectedValue || {},
            positiveFoldCount: row.positiveFoldCount || 0,
            foldCount: row.foldCount || 0,
          },
        });
      }
    }
    if (["complete", "failed", "cancelled"].includes(String(job.status)) && String(job.type) === "factor-evolution") {
      for (const row of job.result?.markets || []) {
        const research = row?.research || {};
        persistDerivedEvidence({
          parentJob: job,
          suffix: `factor-research-${String(row?.market || "unknown").toLowerCase()}`,
          family: "factor",
          market: row?.market,
          status: String(job.status),
          metricName: "symbolCount",
          metricValue: research.symbolCount ?? row.availableCount ?? row.symbolCount,
          dataVersion: research.dataVersion || null,
          evidence: {
            framework: research.framework || "market-cross-sectional-factor-research",
            available: research.available !== false,
            reason: research.reason || null,
            symbolCount: research.symbolCount ?? row.availableCount ?? row.symbolCount ?? 0,
            sampleTotal: row.sampleTotal || 0,
            horizons: research.horizons || [],
            aggregateWeights: research.savedModel?.aggregateWeights || research.aggregateWeights || {},
          },
        });
      }
    }
  }

  async function repairMissingActiveJobs(discoveredNames = []) {
    const activeRows = database.prepare(`
      SELECT id,metadata_json FROM background_jobs
      WHERE status IN ('running','queued','paused','pausing')
    `).all();
    if (!activeRows.length) return 0;
    const knownFiles = new Set(discoveredNames);
    const markUnavailable = database.prepare(`
      UPDATE background_jobs
      SET status='failed', updated_at=?, error=?, metadata_json=?
      WHERE id=? AND status IN ('running','queued','paused','pausing')
    `);
    let repaired = 0;
    for (const row of activeRows) {
      const filename = `${String(row.id)}.json`;
      let available = knownFiles.has(filename);
      if (available) {
        try {
          available = (await stat(join(jobsPath, filename))).size > 0;
        } catch {
          available = false;
        }
      }
      if (available) continue;
      const now = new Date().toISOString();
      let metadata = {};
      try { metadata = JSON.parse(row.metadata_json || "{}"); } catch {}
      markUnavailable.run(
        now,
        "Persisted task artifact is missing or empty; excluded from the active queue during startup reconciliation.",
        json({
          ...metadata,
          failureCategory: "persisted_artifact_unavailable",
          repairedAt: now,
          repairReason: "missing-or-empty-job-artifact",
        }),
        String(row.id),
      );
      repaired += 1;
    }
    return repaired;
  }

  async function importJobs({ force = false } = {}) {
    if (!jobsPath) return { scanned: 0, imported: 0, unavailable: 0, failed: 0 };
    const discovered = (await readdir(jobsPath).catch(() => [])).filter((name) => name.endsWith(".json"));
    const allNames = discovered.filter((name) => LEARNING_JOB_PREFIXES.some((prefix) => name.startsWith(prefix)));
    const repairedMissingActive = await repairMissingActiveJobs(discovered);
    const indexedCount = Number(database.prepare("SELECT COUNT(*) AS count FROM background_jobs").get()?.count || 0);
    const indexedMaxUpdatedAt = Date.parse(String(database.prepare("SELECT MAX(updated_at) AS value FROM background_jobs").get()?.value || ""));
    const filenameTimestamp = (name) => Number(name.match(/-(\d{13,})(?:-[a-zA-Z0-9]{8})?\.json$/)?.[1] || 0);
    const newestCreatedAt = allNames.reduce((max, name) => Math.max(max, filenameTimestamp(name)), 0);
    const incrementalCutoff = Number.isFinite(indexedMaxUpdatedAt) ? indexedMaxUpdatedAt - 60_000 : 0;
    const names = !force && indexedCount > 0
      ? allNames.filter((name) => filenameTimestamp(name) >= incrementalCutoff)
      : allNames;
    const canSkipImport = !force
      && indexedCount > 0
      && indexedCount >= allNames.length
      && (!newestCreatedAt || !Number.isFinite(indexedMaxUpdatedAt) || newestCreatedAt <= indexedMaxUpdatedAt + 2_000);
    if (canSkipImport) {
      const result = {
        discovered: discovered.length,
        skipped: discovered.length - allNames.length,
        scanned: 0,
        imported: 0,
        unavailable: 0,
        failed: 0,
        repairedMissingActive,
        skippedImport: true,
        reason: "existing-evidence-index",
      };
      Object.assign(importState, {
        status: "skipped",
        discovered: result.discovered,
        skipped: result.skipped,
        scanned: 0,
        imported: 0,
        unavailable: 0,
        failed: 0,
        updatedAt: new Date().toISOString(),
        error: null,
      });
      return result;
    }
    database.exec("DELETE FROM learning_trajectory WHERE family = 'operations'; DELETE FROM learning_runs WHERE family = 'operations';");
    let imported = 0;
    let unavailable = 0;
    let failed = 0;
    Object.assign(importState, {
      status: "running",
      discovered: discovered.length,
      skipped: discovered.length - names.length,
      scanned: names.length,
      imported: 0,
      unavailable: 0,
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
          } catch (error) {
            if (error?.code === "LEGACY_ARTIFACT_UNAVAILABLE") unavailable += 1;
            else failed += 1;
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
          unavailable,
          failed,
          updatedAt: new Date().toISOString(),
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      Object.assign(importState, { status: "complete", imported, unavailable, failed, updatedAt: new Date().toISOString() });
      return { discovered: discovered.length, skipped: discovered.length - allNames.length, scanned: names.length, imported, unavailable, failed, repairedMissingActive };
    } catch (error) {
      Object.assign(importState, {
        status: "failed",
        imported,
        unavailable,
        failed: failed + 1,
        updatedAt: new Date().toISOString(),
        error: error.message || String(error),
      });
      throw error;
    }
  }

  async function collectManifestFiles(root, output = []) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await collectManifestFiles(path, output);
      else if (entry.isFile() && entry.name === "manifest.json.gz") output.push(path);
    }
    return output;
  }

  async function importModelManifests({ modelsPath } = {}) {
    if (!modelsPath) return { discovered: 0, imported: 0, unavailable: 0, failed: 0 };
    const files = await collectManifestFiles(modelsPath);
    Object.assign(manifestImportState, {
      status: "running",
      discovered: files.length,
      imported: 0,
      unavailable: 0,
      failed: 0,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    for (const file of files) {
      try {
        const payload = JSON.parse((await gunzip(await readFile(file))).toString("utf8"));
        const definition = payload?.definition || {};
        const market = String(definition.market || "").toUpperCase();
        const horizon = Number(definition.horizon || 0);
        const signature = String(payload.signature || "");
        if (!["ASX", "US", "CN"].includes(market) || !signature || !horizon) {
          manifestImportState.failed += 1;
          continue;
        }
        const symbols = Array.isArray(definition.symbols) ? definition.symbols : [];
        const rowContentHash = definition.rowContentHash || definition.trainingSourceHash || signature;
        const dataVersion = `manifest:${market}:${horizon}:${rowContentHash}`;
        const snapshotId = `manifest:${market}:${horizon}:${signature}`;
        const featureSchemaHash = createHash("sha256")
          .update(json(definition.featureSchema || []))
          .digest("hex");
        const universeVersion = createHash("sha256")
          .update(json(symbols.slice().sort()))
          .digest("hex");
        const recordedAt = String(payload.createdAt || new Date().toISOString());
        upsertSnapshot.run(
          snapshotId,
          market,
          dataVersion,
          String(definition.rowContentHash || definition.trainingSourceHash || ""),
          universeVersion,
          featureSchemaHash,
          String(definition.schema || "oof-manifest"),
          recordedAt,
          json({ source: "model-manifest", path: file, signature }),
          json({
            rows: Number(definition.rows || 0),
            dateCount: Number(definition.dateCount || 0),
            symbolCount: symbols.length,
            folds: Array.isArray(definition.folds) ? definition.folds.length : 0,
            treeModels: definition.treeModels === true,
            sklearnModels: definition.sklearnModels === true,
          }),
        );
        const runId = `manifest:${market}:${horizon}:${signature}`;
        upsertRun.run(
          runId,
          runId,
          "training",
          market,
          "manifest_imported",
          recordedAt,
          recordedAt,
          dataVersion,
          null,
          null,
          json({ source: "model-manifest", path: file, definition }),
        );
        insertTrajectory.run(
          createHash("sha256").update(`${runId}:manifest_imported`).digest("hex"),
          runId,
          "training",
          market,
          recordedAt,
          "manifest_imported",
          1,
          "rows",
          Number(definition.rows || 0),
          json({ source: "model-manifest", path: file, horizon, dataVersion, snapshotId }),
        );
        manifestImportState.imported += 1;
      } catch (error) {
        if (error?.code === "ENOENT" || /empty|timed out|unavailable|dataless/i.test(String(error?.message || error))) {
          manifestImportState.unavailable += 1;
        } else {
          manifestImportState.failed += 1;
        }
      }
      manifestImportState.updatedAt = new Date().toISOString();
    }
    manifestImportState.status = "complete";
    return { ...manifestImportState };
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
    return { available: true, import: { ...importState }, manifestImport: { ...manifestImportState }, count: rows.length, rows, counts };
  }

  function snapshots({ market = "", limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (market) { clauses.push("market = ?"); params.push(String(market).toUpperCase()); }
    params.push(Math.max(1, Math.min(1000, Number(limit || 100))));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = database.prepare(`
      SELECT snapshot_id,data_version,market,content_hash,universe_version,feature_schema_hash,
        label_definition,created_at,source_json,audit_json
      FROM dataset_snapshots ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...params).map((row) => ({
      snapshotId: row.snapshot_id,
      dataVersion: row.data_version,
      market: row.market,
      contentHash: row.content_hash,
      universeVersion: row.universe_version,
      featureSchemaHash: row.feature_schema_hash,
      labelDefinition: row.label_definition,
      createdAt: row.created_at,
      sources: JSON.parse(row.source_json || "[]"),
      audit: JSON.parse(row.audit_json || "{}"),
    }));
    return { available: true, count: rows.length, rows };
  }

  function experiments({ market = "", family = "", limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (market) { clauses.push("market = ?"); params.push(String(market).toUpperCase()); }
    if (family) { clauses.push("family = ?"); params.push(String(family)); }
    params.push(Math.max(1, Math.min(1000, Number(limit || 100))));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = database.prepare(`
      SELECT experiment_id,run_id,family,market,status,comparison_key,created_at,updated_at,config_json,result_json
      FROM experiment_runs ${where} ORDER BY updated_at DESC LIMIT ?
    `).all(...params).map((row) => ({
      experimentId: row.experiment_id,
      runId: row.run_id,
      family: row.family,
      market: row.market,
      status: row.status,
      comparisonKey: row.comparison_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config: JSON.parse(row.config_json || "{}"),
      result: JSON.parse(row.result_json || "{}"),
    }));
    return { available: true, count: rows.length, rows };
  }

  function backgroundJobs({ id = "", market = "", type = "", updatedSince = null, limit = 80, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (id) { clauses.push("id = ?"); params.push(String(id)); }
    if (market) { clauses.push("market = ?"); params.push(String(market).toUpperCase()); }
    if (type) { clauses.push("job_type = ?"); params.push(String(type)); }
    if (updatedSince) { clauses.push("updated_at >= ?"); params.push(String(updatedSince)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 80)));
    const safeOffset = Math.max(0, Math.min(100_000, Number(offset || 0)));
    const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM background_jobs ${where}`).get(...params)?.count || 0);
    const rows = database.prepare(`
      SELECT id,created_at,updated_at,job_type,market,status,progress,metadata_json,result_json,error
      FROM background_jobs ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset).map((row) => {
      const metadata = JSON.parse(row.metadata_json || "{}") || {};
      const summary = JSON.parse(row.result_json || "null");
      return {
        id: row.id,
        type: row.job_type,
        market: row.market,
        status: row.status,
        progress: Number(row.progress || 0),
        detail: metadata.detail || null,
        error: row.error || null,
        failureCategory: metadata.failureCategory || null,
        attempt: metadata.attempt || 1,
        maxAttempts: metadata.maxAttempts || null,
        trainingRunId: metadata.trainingRunId || null,
        createdAt: metadata.createdAt || row.created_at,
        startedAt: metadata.startedAt || null,
        updatedAt: metadata.updatedAt || row.updated_at,
        progressAt: metadata.progressAt || null,
        finishedAt: metadata.finishedAt || null,
        heartbeatAt: metadata.heartbeatAt || null,
        queuePosition: metadata.queuePosition ?? null,
        pauseRequested: metadata.pauseRequested === true,
        pausedAt: metadata.pausedAt || null,
        restartedFrom: metadata.restartedFrom || null,
        stagnation: metadata.stagnation || null,
        checkpoints: metadata.checkpoints && typeof metadata.checkpoints === "object" ? metadata.checkpoints : {},
        resultSummary: summary && typeof summary === "object" ? {
          available: summary.available,
          framework: summary.framework,
          market: summary.market,
          productionEligible: summary.productionEligible ?? summary.productionEligibility?.eligible,
        } : null,
      };
    });
    return { available: true, count: rows.length, totalCandidates: total, offset: safeOffset, hasMore: safeOffset + rows.length < total, jobs: rows };
  }

  function close() { database.close(); }
  return { close, importJobs, importModelManifests, persistJob, trajectories, snapshots, experiments, backgroundJobs };
}

export { createEvidenceRegistry };
