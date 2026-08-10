import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPythonQuantClient } from "../backend/services/python-quant.mjs";
import { createRuntimeEventHub } from "../backend/services/runtime-events.mjs";
import { createJobManager } from "../backend/services/job-manager.mjs";
import { createEvidenceRegistry } from "../backend/services/evidence-registry.mjs";
import { safeReportId } from "../backend/services/model-reports.mjs";
import { evidenceMetrics, isBetterChallenger, promotionDecision } from "../backend/services/learning-progress.mjs";
import {
  adaptTrainingPlan,
  createTrainingSupervisor,
  evaluateTrainingResult,
  reviewerConsensus,
} from "../backend/services/training-supervisor.mjs";
import {
  buildModelTrajectoryPayload,
  dedupeModelEvents,
  normalizeModelEvent,
} from "../backend/services/model-trajectories.mjs";
import { createAlpacaAdapter } from "../backend/providers/us/alpaca.mjs";
import {
  cleanCode,
  isValidMarketCode,
  normalizeMarketSymbol,
  safeMarket,
} from "../backend/domain/markets.mjs";
import { readJsonBody, sendJson } from "../backend/http/json.mjs";
import {
  normalizeEastmoneyPitRecords,
  normalizeFmpHistoricalUniverseRecords,
  normalizeFmpSymbolChangeRecords,
  normalizeFredVintageRecords,
  normalizeOpenFigiMappings,
  normalizeSecPitRecords,
  normalizeSimfinPitRecords,
  normalizeTusharePitRecords,
} from "../backend/services/pit-sources.mjs";

function requestFrom(chunks, headers = {}) {
  const request = Readable.from(chunks);
  request.headers = headers;
  return request;
}

test("Official PIT normalizers preserve first-availability timestamps", () => {
  const sec = normalizeSecPitRecords("AAPL", {
    filings: { recent: {
      accessionNumber: ["0001"], acceptanceDateTime: ["2025-02-01T21:00:00Z"], filingDate: ["2025-02-01"],
    } },
  }, {
    facts: { "us-gaap": {
      Revenues: { units: { USD: [{ accn: "0001", form: "10-Q", end: "2024-12-31", filed: "2025-02-01", val: 100 }] } },
      NetIncomeLoss: { units: { USD: [{ accn: "0001", form: "10-Q", end: "2024-12-31", filed: "2025-02-01", val: 20 }] } },
    } },
  });
  assert.equal(sec[0].available_at, "2025-02-01T21:00:00.000Z");
  assert.equal(sec[0].values.profitMargin, 0.2);
  assert.equal(sec[0].historicalAvailabilityVerified, true);

  const tushare = normalizeTusharePitRecords("600000", {
    code: 0,
    data: {
      fields: ["ann_date", "end_date", "netprofit_margin", "netprofit_yoy", "or_yoy"],
      items: [["20250430", "20241231", 12, 8, 6]],
    },
  });
  assert.equal(tushare[0].available_at, "2025-04-30T23:59:59Z");
  assert.equal(tushare[0].values.profitMargin, 0.12);

  const fred = normalizeFredVintageRecords("UNRATE", [
    { date: "2025-01-01", realtime_start: "2025-02-07", value: "4.0" },
    { date: "2025-02-01", realtime_start: "2025-03-07", value: "4.2" },
  ]);
  assert.equal(fred[1].available_at, "2025-03-07T00:00:00Z");
  assert.ok(fred[1].values.macroRisk < 0);
});

test("Eastmoney PIT fundamentals use the later publication or revision timestamp", () => {
  const rows = normalizeEastmoneyPitRecords("600000", {
    result: { data: [{
      REPORT_DATE: "2025-03-31 00:00:00",
      NOTICE_DATE: "2025-04-30 00:00:00",
      UPDATE_DATE: "2026-04-30 00:00:00",
      XSJLL: 20,
      PARENTNETPROFITTZ: 8,
      TOTALOPERATEREVETZ: 6,
      ROEJQ: 4,
      ZCFZL: 45,
    }] },
  });
  assert.equal(rows[0].available_at, "2026-04-30T23:59:59Z");
  assert.equal(rows[0].values.profitMargin, 0.2);
  assert.equal(rows[0].values.debtToAssets, 0.45);
  assert.equal(rows[0].historicalAvailabilityVerified, true);
});

test("Supplemental PIT sources preserve publication, listing, and identifier semantics", () => {
  const simfin = normalizeSimfinPitRecords("AAPL", [{
    simfinId: 111052,
    reportDate: "2024-12-31",
    publishDate: "2025-02-15",
    fiscalYear: 2024,
    period: "fy",
    revenue: 1_000,
    netIncome: 100,
    totalAssets: 2_000,
    totalLiabilities: 800,
  }]);
  assert.equal(simfin.length, 1);
  assert.equal(simfin[0].available_at, "2025-02-15T00:00:00.000Z");
  assert.equal(simfin[0].event_time, "2024-12-31T00:00:00.000Z");
  assert.equal(simfin[0].values.profitMargin, 0.1);
  assert.equal(simfin[0].historicalAvailabilityVerified, true);

  const simfinCompact = normalizeSimfinPitRecords("AAPL", [{
    id: 111052,
    ticker: "AAPL",
    currency: "USD",
    statements: [{
      statement: "PL",
      columns: ["Report Date", "Publish Date", "Fiscal Year", "Period", "Revenue", "Net Income"],
      data: [["2024-12-31", "2025-02-15", 2024, "FY", 1_000, 100]],
    }],
  }]);
  assert.equal(simfinCompact.length, 1);
  assert.equal(simfinCompact[0].statement, "PL");
  assert.equal(simfinCompact[0].values.revenue, 1_000);
  assert.equal(simfinCompact[0].available_at, "2025-02-15T00:00:00.000Z");

  const delisted = normalizeFmpHistoricalUniverseRecords([{
    symbol: "OLD",
    companyName: "Old Company",
    exchange: "NASDAQ",
    ipoDate: "2001-01-02",
    delistedDate: "2024-05-06",
  }]);
  assert.equal(delisted.length, 2);
  assert.equal(delisted[0].status, "active");
  assert.equal(delisted[1].status, "delisted");
  assert.equal(delisted[1].historicalAvailabilityVerified, true);

  const changed = normalizeFmpSymbolChangeRecords([{
    oldSymbol: "OLD",
    newSymbol: "NEW",
    date: "2023-08-09",
  }]);
  assert.equal(changed[0].previousSymbol, "OLD");
  assert.equal(changed[0].symbol, "NEW");

  const mappings = normalizeOpenFigiMappings(["AAPL"], [{ data: [{
    figi: "BBG000B9XRY4",
    compositeFIGI: "BBG000B9Y5X2",
    ticker: "AAPL",
    marketSector: "Equity",
    exchCode: "US",
  }] }], "US", "2026-08-10T00:00:00.000Z");
  assert.equal(mappings[0].identifierMappingVerified, true);
  assert.equal(mappings[0].historicalAvailabilityVerified, false);
  assert.equal(mappings[0].historicalAvailabilityUnverified, true);
});

test("JSON transport parses chunked request bodies", async () => {
  const request = requestFrom([Buffer.from('{"market":'), Buffer.from('"US","limit":10}')]);
  assert.deepEqual(await readJsonBody(request), { market: "US", limit: 10 });
});

test("JSON transport rejects malformed and oversized request bodies", async () => {
  await assert.rejects(
    readJsonBody(requestFrom(["{broken"])),
    (error) => error.statusCode === 400 && /valid JSON/.test(error.message),
  );
  await assert.rejects(
    readJsonBody(requestFrom(["123456789"]), { maxBytes: 8 }),
    (error) => error.statusCode === 413 && /exceeds/.test(error.message),
  );
  await assert.rejects(
    readJsonBody(requestFrom([], { "content-length": "20" }), { maxBytes: 8 }),
    (error) => error.statusCode === 413,
  );
});

test("JSON responses are non-cacheable and protected from MIME sniffing", () => {
  const response = {
    headers: null,
    status: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  sendJson(response, 200, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test("Python quant client requires an explicit application root", () => {
  assert.throws(() => createPythonQuantClient(), /application root/);
});

test("Python quant client reuses persistent workers and isolates factor and research capacity", async () => {
  const client = createPythonQuantClient({
    root: join(import.meta.dirname, ".."),
    interactiveWorkers: 1,
    factorWorkers: 1,
    researchWorkers: 1,
    idleTimeoutMs: 0,
  });
  try {
    const [first, second] = await Promise.all([
      client("health", {}, 10_000),
      client("qlib-readiness", {}, 10_000),
    ]);
    assert.equal(first.service, "quant-core-python");
    assert.equal(typeof second.available, "boolean");
    const status = client.status();
    assert.equal(status.interactive.capacity, 1);
    assert.equal(status.factor.capacity, 1);
    assert.equal(status.research.capacity, 1);
    assert.equal(status.interactive.workers, 1);
    const factor = await client("factor-lab", {
      market: "ASX",
      symbol: "TEST",
      horizon_days: 5,
      candles: Array.from({ length: 90 }, (_, index) => ({
        date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1000 + index,
      })),
      include_alpha_evolution: false,
    }, 10_000);
    assert.equal(factor.symbol, "TEST");
    assert.equal(client.status().factor.workers, 1);
  } finally {
    client.close();
  }
});

test("Model report identifiers reject path traversal", () => {
  assert.equal(safeReportId("model-training-report-20260728-abcd1234"), "model-training-report-20260728-abcd1234");
  assert.throws(() => safeReportId("../../.env"), /Invalid model report id/);
  assert.throws(() => safeReportId("short"), /Invalid model report id/);
});

test("Backend market contract isolates exchange symbols", () => {
  assert.equal(safeMarket("US"), "US");
  assert.equal(safeMarket("UNKNOWN"), "ASX");
  assert.equal(cleanCode("BHP.AX", "ASX"), "BHP");
  assert.equal(normalizeMarketSymbol("BHP", "ASX"), "BHP.AX");
  assert.equal(normalizeMarketSymbol("AAPL", "ASX"), "");
  assert.equal(normalizeMarketSymbol("CBA", "US"), "");
  assert.equal(isValidMarketCode("600519", "CN"), true);
  assert.equal(normalizeMarketSymbol("000001.SS", "CN"), "SH000001");
});

test("Alpaca adapter preserves the normalized candle contract", () => {
  let receivedOptions = null;
  const adapter = createAlpacaAdapter({
    isIntradayInterval: (interval) => interval === "5m",
    sanitizeCandleRows: (rows, options) => {
      receivedOptions = options;
      return rows;
    },
  });
  const rows = adapter.alpacaRows({ bars: [{ t: "2026-01-01T10:00:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 100, n: 8, vw: 10.4 }] }, "5m");
  assert.equal(rows[0].tradeCount, 8);
  assert.equal(rows[0].providerVwap, 10.4);
  assert.deepEqual(receivedOptions, { preserveTimestamp: true });
});

test("Runtime event hub retains bounded local event history", () => {
  const hub = createRuntimeEventHub({ historyLimit: 20 });
  hub.publish("paper-agent.trade", { symbol: "AAPL", order_execution_enabled: false });
  const summary = hub.summary();
  assert.equal(summary.clients, 0);
  assert.equal(summary.lastEventId, 1);
  assert.equal(summary.recent[0].payload.order_execution_enabled, false);
  assert.deepEqual(hub.summary({ recentLimit: 0 }).recent, []);
});

test("Background jobs persist completion without blocking the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-"));
  try {
    const manager = createJobManager({ basePath: directory });
    manager.register("unit", async (payload, update) => {
      await update(0.5, { phase: "half" });
      return { value: payload.value * 2 };
    });
    const queued = await manager.create("unit", { value: 21 });
    assert.equal(queued.status, "queued");
    assert.equal(manager.isRunning(queued.id), true);
    let completed = null;
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await manager.get(queued.id);
      if (completed?.status === "complete") break;
    }
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.result?.value, 42);
    assert.equal(manager.isRunning(queued.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Background jobs single-flight duplicate work and cancel active research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-cancel-"));
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    manager.register("slow", async (_payload, update, context) => {
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (context.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" });
        await update((index + 1) / 25, { index });
      }
      return { ok: true };
    });
    const first = await manager.create("slow", { market: "ASX", symbols: ["BHP"] });
    const duplicate = await manager.create("slow", { symbols: ["BHP"], market: "ASX" });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.deduplicated, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await manager.cancel(first.id);
    let final = null;
    for (let index = 0; index < 40; index += 1) {
      final = await manager.get(first.id);
      if (final?.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(final.status, "cancelled");
    assert.equal(final.failureCategory, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Background jobs enforce bounded concurrency and retry transient factor failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-bounded-"));
  let active = 0;
  let peak = 0;
  const attempts = new Map();
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1, maxQueue: 4 });
    manager.register("factor-lab", async (payload) => {
      active += 1;
      peak = Math.max(peak, active);
      const count = (attempts.get(payload.value) || 0) + 1;
      attempts.set(payload.value, count);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      if (payload.value === 1 && count === 1) throw new Error("factor evaluation timed out");
      return { value: payload.value };
    });
    const first = await manager.create("factor-lab", { value: 1, maxAttempts: 2 });
    const second = await manager.create("factor-lab", { value: 2, maxAttempts: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const completedFirst = await manager.get(first.id);
    assert.equal(completedFirst.status, "complete");
    assert.equal(completedFirst.error, null);
    assert.equal(completedFirst.failureCategory, null);
    assert.equal((await manager.get(second.id)).status, "complete");
    assert.equal(attempts.get(1), 2);
    assert.equal(peak, 1);
    assert.equal(manager.status().maxConcurrent, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime V3 resumes a closed Python worker as an interrupted training attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-worker-restart-"));
  let attempts = 0;
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    manager.register("backtest", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Python quant core client closed.");
      return { resumed: true };
    });
    const job = await manager.create("backtest", { market: "ASX", maxAttempts: 2 });
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    const completed = await manager.get(job.id);
    assert.equal(completed.status, "complete");
    assert.equal(completed.result.resumed, true);
    assert.equal(completed.attempt, 2);
    assert.equal(completed.error, null);
    assert.equal(completed.failureCategory, null);
    assert.equal(completed.payload.rework.reason, "interrupted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Background job list exposes heartbeat and reconciles persisted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-list-"));
  try {
    const manager = createJobManager({ basePath: directory });
    manager.register("unit", async (_payload, update) => {
      await update(0.6, { phase: "evaluation" });
      return { ok: true };
    });
    const queued = await manager.create("unit", { market: "US" });
    let completed = null;
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await manager.get(queued.id);
      if (completed?.status === "complete") break;
    }
    const listed = await manager.list({ market: "US", type: "unit" });
    assert.equal(listed.count, 1);
    assert.equal(listed.jobs[0].status, "complete");
    assert.ok(listed.jobs[0].heartbeatAt);
    assert.ok(listed.jobs[0].trainingRunId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Restart reconciliation stops jobs that exhausted their recovery budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-restart-budget-"));
  let handlerCalls = 0;
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    manager.register("backtest", async () => {
      handlerCalls += 1;
      return { shouldNotRun: true };
    });
    const persisted = {
      id: "backtest-exhausted",
      type: "backtest",
      market: "CN",
      status: "running",
      runtimeVersion: 3,
      attempt: 3,
      maxAttempts: 3,
      resumedAfterRestart: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:05:00.000Z",
      payload: { market: "CN", resume: true },
    };
    await writeFile(join(directory, "backtest-exhausted.json"), JSON.stringify(persisted), "utf8");
    const reconciled = await manager.reconcile();
    const final = await manager.get(persisted.id);
    assert.equal(reconciled.repaired, 1);
    assert.equal(reconciled.resumed, 0);
    assert.equal(final.status, "failed");
    assert.equal(final.failureCategory, "restart_budget_exhausted");
    assert.equal(handlerCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Persisted queued work can be cancelled after its original runtime ended", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-stale-cancel-"));
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    const persisted = {
      id: "reddit-stale",
      type: "reddit",
      market: "US",
      status: "queued",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      payload: { market: "US" },
    };
    await writeFile(join(directory, "reddit-stale.json"), JSON.stringify(persisted), "utf8");
    const cancelled = await manager.cancel(persisted.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failureCategory, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function acceptedTrainingFixture() {
  const horizonModel = (horizon) => ({
    available: true,
    horizon,
    oofRows: 1200,
    metaTestRows: 1200,
    eventCounts: { target: 620, stop: 540, timeout: 240 },
    metrics: {
      testDates: 140,
      brierSkillScore: 0.08,
      ecePct: 3.4,
      calibrationSlope: 1.02,
      probabilityBucketMinCount: 62,
    },
    rankingMetrics: { topDecileLift: 0.021 },
    expectedValue: { expectedValuePct: 0.62 },
    foldMetrics: [
      { fold: 1, positive: true, featureDrift: { maxPsi: 0.12 } },
      { fold: 2, positive: true, featureDrift: { maxPsi: 0.17 } },
      { fold: 3, positive: true, featureDrift: { maxPsi: 0.11 } },
      { fold: 4, positive: true, featureDrift: { maxPsi: 0.15 } },
      { fold: 5, positive: false, featureDrift: { maxPsi: 0.19 } },
    ],
    positiveFoldCount: 4,
    leakageControl: { purge: horizon, embargo: 7, entry: "next-session VWAP/open" },
  });
  return {
    market: "ASX",
    productionTraining: {
      available: true,
      dataset: {
        rawRows: 85000,
        symbolCount: 160,
        pointInTimeCoveragePct: 82,
        pointInTimeJoinViolationCount: 0,
        duplicateRowsExcluded: 0,
        crossMarketRowsExcluded: 0,
      },
      horizonModels: [horizonModel(5), horizonModel(15), horizonModel(30)],
      manifest: { model_version: "asx-multitask-test", deployment_status: "shadow" },
      productionEligibility: { dataReady: true, eligible: true },
      monitoringStatus: { status: "healthy", reasons: [] },
    },
  };
}

test("Training supervisor deterministic gate accepts strong OOF evidence and rejects leakage", () => {
  const accepted = evaluateTrainingResult(acceptedTrainingFixture());
  assert.equal(accepted.passed, true);
  assert.equal(accepted.score, 100);
  const leaked = acceptedTrainingFixture();
  leaked.productionTraining.dataset.pointInTimeJoinViolationCount = 2;
  leaked.productionTraining.horizonModels[1].leakageControl.entry = "same-session close";
  const rejected = evaluateTrainingResult(leaked);
  assert.equal(rejected.passed, false);
  assert.ok(rejected.failedChecks.includes("point_in_time"));
  assert.ok(rejected.failedChecks.includes("leakage_controls"));
});

test("Learning progress computes deduplicated observational metrics", () => {
  const samples = [
    { predictionId: "a", direction: "upside", confidence: 70, outcome: { resolved: true, forwardReturnPct: 2 } },
    { predictionId: "a", direction: "upside", confidence: 70, outcome: { resolved: true, forwardReturnPct: 2 } },
    { predictionId: "b", direction: "downside", confidence: 80, outcome: { resolved: true, forwardReturnPct: -1 } },
    { predictionId: "c", direction: "upside", confidence: 60, outcome: { resolved: true, forwardReturnPct: -1 } },
  ];
  const metrics = evidenceMetrics(samples);
  assert.equal(metrics.confusion.tp, 1);
  assert.equal(metrics.confusion.tn, 1);
  assert.equal(metrics.confusion.fp, 1);
  assert.equal(metrics.accuracyPct, 2 / 3 * 100);
});

test("Learning promotion rejects observational evidence and accepts a strict improved challenger", () => {
  const base = {
    status: "complete",
    evidenceType: "strict_oof",
    blockers: [],
    samples: { oofRows: 1500, independentDates: 140 },
    metrics: { accuracyPct: 60, brierSkill: 0.08, ecePct: 3, topDecileAccuracyPct: 62, topDecileCi95: { low: 53 } },
    folds: Array.from({ length: 5 }, (_, index) => ({ positive: index < 4 })),
  };
  assert.equal(promotionDecision({ ...base, evidenceType: "live_observational" }, null).promoted, false);
  assert.equal(promotionDecision({ ...base, metrics: { ...base.metrics, accuracyPct: 62 } }, { metrics: { accuracyPct: 60 } }).promoted, true);
});

test("Learning progress retains the strongest strict OOF challenger instead of the newest run", () => {
  const strong = {
    status: "complete", evidenceType: "strict_oof", createdAt: "2026-07-01T00:00:00Z",
    samples: { oofRows: 5000, independentDates: 180 },
    metrics: { balancedAccuracyPct: 57, brierSkill: 0.08, ecePct: 3 },
  };
  const newerButWorse = {
    ...strong, createdAt: "2026-08-01T00:00:00Z",
    metrics: { balancedAccuracyPct: 53, brierSkill: -0.02, ecePct: 8 },
  };
  assert.equal(isBetterChallenger(newerButWorse, strong), false);
  assert.equal(isBetterChallenger(strong, newerButWorse), true);
});

test("Training supervisor requires independent approvals and only tightens rework plans", () => {
  const consensus = reviewerConsensus([
    { available: true, verdict: "accept", score: 84 },
    { available: true, verdict: "accept", score: 79 },
    { available: true, verdict: "rework", score: 52 },
  ], 2);
  assert.equal(consensus.accepted, true);
  const next = adaptTrainingPlan(
    { revision: 0, limit: 40, range: "5y", foldCount: 5, maxModelWeight: 0.35, maxResidualCorrelation: 0.8 },
    { failedChecks: ["dataset_rows", "calibration_ece", "feature_drift"] },
    [{ recommendedActions: ["expand_universe", "tighten_weight_cap"] }],
    { maxSymbols: 180 },
  );
  assert.ok(next.limit > 40);
  assert.equal(next.range, "7y");
  assert.ok(next.foldCount > 5);
  assert.ok(next.maxModelWeight < 0.35);
  assert.ok(next.maxResidualCorrelation < 0.8);
});

test("Training supervisor persists a successful reviewed cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-"));
  const jobs = new Map();
  const notices = [];
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, minAiApprovals: 2, retryDelayMs: 1000 },
      async createTrainingJob(market, plan) {
        const job = { id: `job-${market}`, status: "queued", progress: 0, updatedAt: new Date().toISOString(), market, plan };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
      async review() {
        return [
          { provider: "openai", label: "OpenAI", available: true, verdict: "accept", score: 88, rationale: "OOF evidence passed." },
          { provider: "siliconflow", label: "SiliconFlow", available: true, verdict: "accept", score: 82, rationale: "No threshold relaxation." },
          { provider: "hunyuan", label: "Hunyuan", available: true, verdict: "rework", score: 68, rationale: "Keep monitoring drift." },
        ];
      },
      async notify(alert) {
        notices.push(alert);
      },
    });
    const triggered = await supervisor.trigger({ market: "ASX", reason: "unit-test" });
    assert.equal(triggered.accepted, true);
    const running = await supervisor.status("ASX");
    assert.equal(running.market.status, "training");
    jobs.set(running.market.activeJobId, {
      ...jobs.get(running.market.activeJobId),
      status: "complete",
      progress: 1,
      result: acceptedTrainingFixture(),
      updatedAt: new Date().toISOString(),
    });
    await supervisor.tick("unit-test-complete");
    const completed = await supervisor.status("ASX");
    assert.equal(completed.market.status, "accepted");
    assert.equal(completed.market.consensus.accepts, 2);
    assert.equal(completed.market.evaluation.passed, true);
    assert.equal(notices.at(-1)?.type, "TRAINING_ACCEPTED");
    const reviewedAgain = await supervisor.reviewLatest({ market: "ASX", source: "unit-test", operatorNote: "manual evidence recheck" });
    assert.equal(reviewedAgain.accepted, true);
    assert.equal((await supervisor.status("ASX")).market.status, "accepted");
    const operatorLogs = await supervisor.logs({ market: "ASX", limit: 20 });
    assert.equal(operatorLogs.events.find((event) => event.type === "operator-action" && event.action === "review-latest")?.operatorNote, "manual evidence recheck");
    const reviewerLogs = await supervisor.logs({ market: "ASX", provider: "openai", limit: 10 });
    assert.equal(reviewerLogs.events[0]?.type, "reviewer-verdict");
    assert.equal(reviewerLogs.events[0]?.verdict, "accept");
    await supervisor.configure({ market: "ASX", reviewer: "hunyuan", reviewerEnabled: false, source: "unit-test", operatorNote: "pause exhausted reviewer" });
    assert.equal((await supervisor.status("ASX")).reviewersEnabled.hunyuan, false);
    const configLogs = await supervisor.logs({ market: "ASX", limit: 20 });
    const configEvent = configLogs.events.find((event) => event.type === "operator-action" && event.action === "configuration-changed");
    assert.equal(configEvent?.operatorNote, "pause exhausted reviewer");
    assert.deepEqual(configEvent?.changes?.[0], { field: "reviewer.hunyuan", from: true, to: false });

    const restored = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      createTrainingJob: async () => { throw new Error("not expected"); },
      getJob: async () => null,
    });
    assert.equal((await restored.status("ASX")).market.status, "accepted");
    assert.equal((await restored.status("ASX")).reviewersEnabled.hunyuan, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor keeps deterministic success in Shadow when AI quota is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-no-ai-"));
  const jobs = new Map();
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, minAiApprovals: 2, autoCycleEnabled: false },
      async createTrainingJob(market) {
        const job = { id: `job-${market}`, status: "queued", updatedAt: new Date().toISOString(), market };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
      async review() {
        return [
          { provider: "openai", available: false, error: "quota", verdict: "rework" },
          { provider: "siliconflow", available: false, error: "quota", verdict: "rework" },
        ];
      },
    });
    await supervisor.trigger({ market: "ASX", reason: "unit-test" });
    const running = await supervisor.status("ASX");
    jobs.set(running.market.activeJobId, {
      ...jobs.get(running.market.activeJobId),
      status: "complete",
      progress: 1,
      result: acceptedTrainingFixture(),
      updatedAt: new Date().toISOString(),
    });
    await supervisor.tick("unit-test-complete");
    const completed = await supervisor.status("ASX");
    assert.equal(completed.market.status, "awaiting_optional_review");
    assert.equal(completed.market.evaluation.passed, true);
    assert.equal(completed.market.activeJobId, null);
    assert.equal(completed.market.nextCycleAt, null);
    await supervisor.tick("no-autocycle");
    assert.equal((await supervisor.status("ASX")).market.status, "awaiting_optional_review");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor does not spend AI review calls on deterministic rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-hard-fail-"));
  const jobs = new Map();
  let reviewCalls = 0;
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["US"],
      config: { startupDelayMs: 0, maxAttempts: 1, autoCycleEnabled: false },
      async createTrainingJob() {
        const job = { id: "job-hard-fail", status: "queued", updatedAt: new Date().toISOString() };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
      async review() {
        reviewCalls += 1;
        return [];
      },
    });
    await supervisor.trigger({ market: "US", reason: "unit-test" });
    const running = await supervisor.status("US");
    const rejected = acceptedTrainingFixture();
    rejected.productionTraining.dataset.rawRows = 20;
    jobs.set(running.market.activeJobId, {
      ...jobs.get(running.market.activeJobId),
      status: "complete",
      progress: 1,
      result: rejected,
      updatedAt: new Date().toISOString(),
    });
    await supervisor.tick("unit-test-complete");
    const completed = await supervisor.status("US");
    assert.equal(reviewCalls, 0);
    assert.equal(completed.market.status, "completed_not_promoted");
    assert.equal(completed.market.lastCompletedAt != null, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor schedules bounded automatic rework after a failed job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-failure-"));
  const jobs = new Map();
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["US"],
      config: { startupDelayMs: 0, maxAttempts: 3, retryDelayMs: 1000 },
      async createTrainingJob() {
        const job = { id: "job-failed", status: "failed", error: "training process exited", updatedAt: new Date().toISOString() };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
      async review() {
        return [{ provider: "siliconflow", available: true, verdict: "rework", score: 20, recommendedActions: ["inspect_data_quality"] }];
      },
    });
    await supervisor.trigger({ market: "US", reason: "unit-test" });
    await supervisor.tick("unit-test-failure");
    const status = await supervisor.status("US");
    assert.equal(status.market.status, "rework_scheduled");
    assert.equal(status.market.attempt, 1);
    assert.match(status.market.lastError, /training process exited/);
    assert.ok(status.market.nextActionAt);
    const revisedPlan = status.market.currentPlan;
    const manualRework = await supervisor.trigger({ market: "US", source: "unit-test", operatorNote: "retry revised plan" });
    assert.equal(manualRework.rework, true);
    const retried = await supervisor.status("US");
    assert.equal(retried.market.status, "training");
    assert.equal(retried.market.attempt, 2);
    assert.equal(retried.market.currentPlan.revision, revisedPlan.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Model trajectory normalizes explainable factor evidence", () => {
  const event = normalizeModelEvent({
    market: "ASX",
    event_type: "model-change-log-factor-research",
    entity_id: "ASX:BHP:factor",
    created_at: "2026-07-13T10:00:00Z",
    payload: {
      title: "动态因子权重已更新",
      symbol: "BHP.AX",
      framework: "purged-factor-research",
      candidateCount: 24,
      admittedCount: 6,
      holdout: { samples: 240, direction_hit_rate_pct: 56.4, ic: 0.08, rank_ic: 0.11 },
      leakageControl: "features at t, labels after t",
    },
  });
  assert.equal(event.family, "factor");
  assert.equal(event.metrics.sampleCount, 240);
  assert.equal(event.metrics.primaryMetric.value, 56.4);
  assert.equal(event.guardrails[0].label, "未来函数隔离");
  assert.equal(event.impact, "improved");
});

test("Model trajectory deduplicates repeated writes and exposes pipeline state", () => {
  const row = {
    market: "US",
    event_type: "model-change-log-minute-learning",
    entity_id: "US:minute:1",
    created_at: "2026-07-13T10:00:00Z",
    payload: {
      title: "分钟模型已更新",
      sampleCount: 1200,
      test: { directionalAccuracy: 53.2, mae: 0.42 },
      guardrails: ["chronological split"],
    },
  };
  const normalized = [normalizeModelEvent(row), normalizeModelEvent(row)];
  assert.equal(dedupeModelEvents(normalized).length, 1);
  const payload = buildModelTrajectoryPayload({
    market: "US",
    records: [row, row],
    intradaySnapshot: { available: true, sampleCount: 1200, updatedAt: row.created_at },
  });
  assert.equal(payload.families.length, 7);
  assert.equal(payload.families.find((family) => family.id === "training").status.code, "research");
  assert.equal(payload.families.find((family) => family.id === "intraday").status.code, "ready");
  assert.equal(payload.summary.eventCount, 1);
  assert.equal(payload.pipeline.find((stage) => stage.id === "base").state, "ready");
});

test("Compact model trajectory bounds initial event payloads", () => {
  const records = Array.from({ length: 40 }, (_, index) => ({
    market: "US",
    event_type: "model-change-log-minute-learning",
    entity_id: `US:minute:${index}`,
    created_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    payload: { title: `分钟模型 ${index}`, sampleCount: 1000 + index, test: { directionalAccuracy: 50 + index / 10 } },
  }));
  const payload = buildModelTrajectoryPayload({ market: "US", records, compact: true, limit: 240 });
  assert.equal(payload.families.length, 7);
  assert.equal(payload.families.find((family) => family.id === "intraday").events.length, 6);
  assert.equal(payload.timeline.length, 0);
});

test("Evidence registry indexes failed and completed runs without turning failures into zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-"));
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath: join(directory, "jobs") });
  try {
    registry.persistJob({
      id: "factor-evolution-1", type: "factor-evolution", market: "ASX",
      trainingRunId: "run-alpha-1", status: "failed", progress: 0.42,
      createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:01:00Z",
      payload: { mode: "light" }, failureCategory: "timeout", error: "worker timeout",
    }, { trajectory: true });
    const result = registry.trajectories({ market: "ASX", family: "alpha" });
    assert.equal(result.count, 1);
    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].evidence.failureCategory, "timeout");
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evidence registry fans global Alpha runs into each market and classifies minute training", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-fanout-"));
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath: join(directory, "jobs") });
  try {
    registry.persistJob({
      id: "factor-evolution-global", type: "factor-evolution", market: null,
      status: "complete", progress: 1,
      createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:02:00Z",
      payload: { mode: "light" }, result: { markets: [{ market: "ASX" }, { market: "US" }, { market: "CN" }] },
    }, { trajectory: true });
    registry.persistJob({
      id: "training-minute-us", type: "training", market: "US",
      status: "complete", progress: 1,
      createdAt: "2026-08-10T01:00:00Z", updatedAt: "2026-08-10T01:02:00Z",
      payload: {}, result: { available: true, sampleCount: 200 },
    }, { trajectory: true });
    assert.equal(registry.trajectories({ market: "ASX", family: "alpha" }).count, 1);
    assert.equal(registry.trajectories({ market: "CN", family: "alpha" }).count, 1);
    assert.equal(registry.trajectories({ market: "US", family: "minute" }).count, 1);
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
