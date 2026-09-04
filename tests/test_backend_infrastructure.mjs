import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPythonQuantClient } from "../backend/services/python-quant.mjs";
import { createRuntimeEventHub } from "../backend/services/runtime-events.mjs";
import { createJobManager } from "../backend/services/job-manager.mjs";
import { createEvidenceRegistry } from "../backend/services/evidence-registry.mjs";
import { createTrainingResourceService } from "../backend/services/training-resources.mjs";
import { buildTaskDiagnostics, classifyTaskHealth } from "../backend/services/task-diagnostics.mjs";
import { safeReportId } from "../backend/services/model-reports.mjs";
import { candidateEvidenceSemantics, createLearningProgressService, evidenceMetrics, isBetterChallenger, pointFromTrainingJob, promotionDecision } from "../backend/services/learning-progress.mjs";
import {
  adaptTrainingPlan,
  createTrainingSupervisor,
  deterministicGateDecision,
  evaluateTrainingResult,
} from "../backend/services/training-supervisor.mjs";
import {
  buildPromotionEvidenceV3,
  validatePromotionEvidenceV3,
} from "../backend/services/promotion-evidence.mjs";
import {
  buildModelTrajectoryPayload,
  dedupeModelEvents,
  normalizeModelEvent,
} from "../backend/services/model-trajectories.mjs";
import { createAlpacaAdapter } from "../backend/providers/us/alpaca.mjs";
import { createEastmoneyCorporateActionAdapter } from "../backend/providers/cn/eastmoney.mjs";
import {
  cleanCode,
  isValidMarketCode,
  normalizeMarketSymbol,
  safeMarket,
} from "../backend/domain/markets.mjs";
import { readJsonBody, sendJson } from "../backend/http/json.mjs";
import {
  normalizeCorporateActionRecords,
  normalizeEastmoneyPitRecords,
  normalizeEodhdCompanyUniverseRecords,
  normalizeEodhdFinancialPitRecords,
  normalizeFmpHistoricalUniverseRecords,
  normalizeFmpStatementPitRecords,
  normalizeFmpSymbolChangeRecords,
  normalizeFredVintageRecords,
  normalizeGrowthWithValuePitRecords,
  normalizeOpenFigiMappings,
  normalizeSecDisclosureRecords,
  normalizeSecPitRecords,
  normalizeSimfinPitRecords,
  normalizeStockMarketApiPitRecords,
  normalizeTusharePitRecords,
} from "../backend/services/pit-sources.mjs";
import {
  buildPitGapReport,
  normalizeBlsMacroRecords,
  normalizeCninfoAnnouncementRecords,
  publicPitSourceCatalog,
} from "../backend/services/free-pit-sources.mjs";

function requestFrom(chunks, headers = {}) {
  const request = Readable.from(chunks);
  request.headers = headers;
  return request;
}

test("Task diagnostics separates live work, queue waits, and stale jobs", () => {
  const now = Date.parse("2026-08-16T00:00:00.000Z");
  const running = {
    id: "backtest-live",
    type: "backtest",
    market: "ASX",
    status: "running",
    progress: 0.71,
    createdAt: "2026-08-15T23:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    heartbeatAt: "2026-08-16T00:00:00.000Z",
    progressAt: "2026-08-15T23:58:00.000Z",
    detail: { phase: "oof-fold-training", completedFoldCheckpoints: 4, expectedFoldCheckpoints: 7, completed: 2, total: 7 },
    checkpoints: { fold1: { completedAt: "2026-08-15T23:40:00.000Z" } },
  };
  const queued = {
    id: "backtest-queued",
    type: "backtest",
    market: "US",
    status: "queued",
    progress: 0,
    createdAt: "2026-08-15T23:30:00.000Z",
    updatedAt: "2026-08-15T23:59:00.000Z",
    heartbeatAt: "2026-08-15T23:59:00.000Z",
  };
  const stale = {
    id: "backtest-stale",
    type: "backtest",
    market: "CN",
    status: "running",
    progress: 0.2,
    createdAt: "2026-08-15T20:00:00.000Z",
    updatedAt: "2026-08-15T23:00:00.000Z",
    heartbeatAt: "2026-08-15T23:00:00.000Z",
  };
  assert.equal(classifyTaskHealth(running, { now, activeBlockers: [] }).health, "healthy-running");
  assert.equal(classifyTaskHealth(stale, { now, activeBlockers: [] }).state, "stalled");
  const report = buildTaskDiagnostics([running, queued, stale], { now });
  assert.equal(report.summary.running, 1);
  assert.equal(report.summary.stalled, 1);
  assert.equal(report.summary.queued, 1);
  assert.equal(report.jobs.find((job) => job.id === "backtest-live").checkpoint.remaining, 3);
  assert.equal(report.jobs.find((job) => job.id === "backtest-live").checkpoint.phaseCompleted, 2);
  assert.equal(report.jobs.find((job) => job.id === "backtest-live").checkpoint.phaseRemaining, 5);
  assert.match(report.jobs.find((job) => job.id === "backtest-queued").recommendation, /无需重复提交/);
});

test("Task diagnostics treats an evidence-gated rework pause as actionable, not stalled", () => {
  const result = classifyTaskHealth({
    id: "supervisor-US-rework",
    type: "training-supervisor",
    market: "US",
    status: "queued",
    supervisorState: "rework_scheduled",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    detail: { phase: "等待返工调度", nextActionAt: null },
  }, { now: Date.parse("2026-08-17T00:00:00.000Z") });
  assert.equal(result.state, "queued");
  assert.equal(result.health, "awaiting-manual-rework");
  assert.equal(result.isStalled, false);
});

test("Task diagnostics marks heartbeat-only work for diagnosis instead of retry", () => {
  const now = Date.parse("2026-08-16T00:00:00.000Z");
  const result = classifyTaskHealth({
    id: "data-stuck-with-heartbeat",
    type: "pit-enrichment",
    market: "ASX",
    status: "running",
    createdAt: "2026-08-15T20:00:00.000Z",
    heartbeatAt: "2026-08-16T00:00:00.000Z",
    progressAt: "2026-08-15T23:35:00.000Z",
    stagnation: {
      detectedAt: "2026-08-15T23:50:00.000Z",
      progressAgeMs: 1_200_000,
      category: "data-source-or-data-quality",
      action: "diagnose-before-retry",
    },
  }, { now, progressStaleAfterMs: 15 * 60_000 });
  assert.equal(result.state, "running");
  assert.equal(result.health, "running-needs-diagnosis");
  assert.equal(result.needsDiagnosis, true);
  assert.equal(result.isStalled, false);
  assert.match(result.recommendation, /不要重复提交/);
});

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

  const secDisclosures = normalizeSecDisclosureRecords("AAPL", [{
    form: "10-Q",
    accessionNumber: "0000000000-26-000001",
    filingDate: "2026-05-01",
    reportDate: "2026-03-31",
    acceptanceDateTime: "2026-05-01T20:01:02Z",
  }]);
  assert.equal(secDisclosures.length, 1);
  assert.equal(secDisclosures[0].available_at, "2026-05-01T20:01:02.000Z");
  assert.equal(secDisclosures[0].historicalAvailabilityVerified, true);

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
  assert.ok(fred[1].values.macroLaborImpulse < 0);
  assert.equal(fred[1].values.macroDataCoverage, 1);

  const aud = normalizeFredVintageRecords("DEXUSAL", [
    { date: "2025-01-01", realtime_start: "2025-01-02", value: "0.62" },
    { date: "2025-01-02", realtime_start: "2025-01-03", value: "0.64" },
  ]);
  assert.ok(aud[1].values.macroFxImpulse > 0);
  assert.equal(aud[1].values.eventSentiment, 0);

  const vix = normalizeFredVintageRecords("VIXCLS", [
    { date: "2025-01-02", value: "18.0" },
    { date: "2025-01-03", value: "20.0" },
  ], { conservativeMarketClose: true });
  assert.equal(vix[1].available_at, "2025-01-04T00:00:00.000Z");
  assert.equal(vix[1].historicalAvailabilityMethod, "conservative-next-utc-day-market-observation");
  assert.ok(vix[1].values.macroVolatilityImpulse < 0);

  const australianInflation = normalizeFredVintageRecords("CPALTT01AUQ659N", [
    { date: "2024-10-01", realtime_start: "2025-01-29", value: "2.4" },
    { date: "2025-01-01", realtime_start: "2025-04-30", value: "3.0" },
  ]);
  assert.equal(australianInflation[1].available_at, "2025-04-30T00:00:00Z");
  assert.ok(australianInflation[1].values.macroInflationImpulse < 0);

  const australianGrowth = normalizeFredVintageRecords("AUSGDPRQPSMEI", [
    { date: "2024-10-01", realtime_start: "2025-03-05", value: "1.2" },
    { date: "2025-01-01", realtime_start: "2025-06-04", value: "2.0" },
  ]);
  assert.ok(australianGrowth[1].values.macroGrowthImpulse > 0);

  const fmp = normalizeFmpStatementPitRecords("AAPL", [{
    date: "2025-03-31",
    fillingDate: "2025-05-02",
    acceptedDate: "2025-05-02T16:03:00Z",
    period: "Q2",
    calendarYear: "2025",
    revenue: 100,
    netIncome: 20,
    totalAssets: 300,
    totalLiabilities: 120,
  }], { statement: "income" });
  assert.equal(fmp.length, 1);
  assert.equal(fmp[0].available_at, "2025-05-02T16:03:00.000Z");
  assert.equal(fmp[0].historicalAvailabilityVerified, true);
  assert.equal(fmp[0].values.profitMargin, 0.2);

  const noFilingTime = normalizeFmpStatementPitRecords("AAPL", [{
    date: "2025-03-31", revenue: 100, netIncome: 20,
  }], { statement: "income" });
  assert.equal(noFilingTime.length, 0);

  const growthWithValue = normalizeGrowthWithValuePitRecords("BHP", [{
    fiscal_year: 2024,
    period_end: "2024-06-30",
    revenue: 1000,
    net_income: 120,
  }], { retrievedAt: "2025-01-01T00:00:00Z" });
  assert.equal(growthWithValue.length, 1);
  assert.equal(growthWithValue[0].historicalAvailabilityVerified, false);
  assert.equal(growthWithValue[0].historicalAvailabilityUnverified, true);

  const stockMarketApi = normalizeStockMarketApiPitRecords("BHP", {
    financials: [{
      fiscal_year: 2024,
      period_type: "FY",
      period_end: "2024-06-30",
      revenue: 1000,
      net_income: 120,
    }],
  }, {
    filings: [{ filing_date: "2024-08-20", form_type: "annual", description: "Annual Report 2024" }],
    retrievedAt: "2025-01-01T00:00:00Z",
  });
  assert.equal(stockMarketApi.length, 1);
  assert.equal(stockMarketApi[0].historicalAvailabilityVerified, true);
  assert.equal(stockMarketApi[0].available_at, "2024-08-20T00:00:00.000Z");
});

test("Free public PIT sources distinguish strict events from Shadow series", () => {
  const bls = normalizeBlsMacroRecords("US", {
    Results: { series: [{ seriesID: "LNS14000000", data: [{ year: "2025", period: "M01", value: "4.0" }] }] },
  }, { retrievedAt: "2025-02-10T00:00:00Z" });
  assert.equal(bls.length, 1);
  assert.equal(bls[0].historicalAvailabilityVerified, false);
  assert.match(bls[0].warning, /Shadow-only/);

  const cninfo = normalizeCninfoAnnouncementRecords("600000", {
    announcements: [{
      announcementId: "abc",
      secCode: "600000",
      announcementTitle: "2024年年度报告",
      announcementTime: Date.parse("2025-04-30T18:00:00Z"),
      adjunctUrl: "2025-04-30/abc.PDF",
    }],
  });
  assert.equal(cninfo.length, 1);
  assert.equal(cninfo[0].historicalAvailabilityVerified, true);
  assert.equal(cninfo[0].sourceProvider, "cninfo-official-disclosure");

  const catalog = publicPitSourceCatalog();
  assert.ok(catalog.some((row) => row.name === "cninfo-official-disclosure" && row.pit === "strict-event"));
  assert.ok(catalog.some((row) => row.name === "bls-public-api-shadow" && row.pit === "shadow-only"));
  assert.ok(catalog.some((row) => row.name === "growthwithvalue-asx-financials"));
  assert.ok(catalog.some((row) => row.name === "stockmarketapi-ai-asx-financials"));
  assert.ok(catalog.some((row) => row.name === "asx-equity-stocks" && row.pit === "not-pit"));
  assert.ok(catalog.some((row) => row.name === "asx-official-reports-archive" && row.pit === "strict-event"));
  assert.ok(catalog.every((row) => row.officialUrl && Array.isArray(row.fields)));

  const gap = buildPitGapReport({
    market: "US",
    coverage: {
      fundamentals: {
        verifiedMarketPct: { US: 74.5 },
        trainingUniverseCoveragePct: { US: 74.5 },
      },
    },
    providerStatus: [{ name: "sec", configured: true, status: "ready" }],
  });
  const fundamentalGap = gap.definitions.find((row) => row.id === "pit_fundamentals");
  assert.equal(gap.strictOofReady, false);
  assert.equal(fundamentalGap.meetsMinimum, false);
  assert.equal(fundamentalGap.sourceRows.find((row) => row.name === "sec-edgar").configured, true);
  assert.ok(fundamentalGap.missingFields.includes("available_at"));

  const pendingGap = buildPitGapReport({ market: "ASX", coverageAvailable: false });
  assert.equal(pendingGap.definitions[0].coveragePct, null);
  assert.equal(pendingGap.definitions[0].action, "await_data_audit_snapshot_before_scoring_gap");
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

test("Corporate actions and listing histories preserve conservative availability", () => {
  const actions = normalizeCorporateActionRecords("BHP", [{
    exDate: "2025-03-06",
    declarationDate: "2025-02-18",
    recordDate: "2025-03-07",
    paymentDate: "2025-03-27",
    amount: 0.5,
  }], { provider: "test-dividends", eventType: "dividend" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].available_at, "2025-02-18T23:59:59Z");
  assert.equal(actions[0].event_time, "2025-03-06T00:00:00Z");
  assert.equal(actions[0].historicalAvailabilityVerified, true);

  const universe = normalizeEodhdCompanyUniverseRecords("BHP", {
    General: { Name: "BHP Group", Exchange: "AU", IPODate: "1987-01-01" },
  }, { market: "ASX" });
  assert.equal(universe.length, 1);
  assert.equal(universe[0].available_at, "1987-01-01T00:00:00Z");
  assert.equal(universe[0].historicalAvailabilityVerified, true);
});

test("Eastmoney corporate-action adapter preserves public publication and ex-date semantics", async () => {
  const adapter = createEastmoneyCorporateActionAdapter({
    fetchJson: async () => ({ success: true, code: 0, result: { data: [{
      SECURITY_CODE: "000001",
      REPORT_DATE: "2025-03-31 00:00:00",
      PUBLISH_DATE: "2025-04-30 00:00:00",
      EQUITY_RECORD_DATE: "2025-05-09 00:00:00",
      EX_DIVIDEND_DATE: "2025-05-12 00:00:00",
      PRETAX_BONUS_RMB: "0.20",
      BONUS_RATIO: "10.0",
    }] } }),
    normalizeCorporateActionRecords,
  });
  const rows = await adapter.fetchCorporateActions("000001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_time, "2025-05-12T00:00:00Z");
  assert.equal(rows[0].available_at, "2025-04-30T23:59:59Z");
  assert.equal(rows[0].values.recordDate, "2025-05-09");
  assert.equal(rows[0].values.amount, 0.2);
  assert.equal(rows[0].historicalAvailabilityVerified, true);
  assert.equal(rows[0].sourceProvider, "eastmoney-cn-corporate-actions");
});

test("EODHD financial statements require a real filing timestamp for PIT training", () => {
  const rows = normalizeEodhdFinancialPitRecords("BHP", {
    Financials: {
      Income_Statement: {
        quarterly: {
          "2025-03-31": { date: "2025-03-31", filing_date: "2025-05-02", totalRevenue: "1200" },
          "2025-06-30": { date: "2025-06-30", totalRevenue: "1300" },
        },
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_time, "2025-03-31T23:59:59Z");
  assert.equal(rows[0].available_at, "2025-05-02T23:59:59Z");
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
  const fixedBody = Buffer.from('{"market":"ASX"}');
  const fixedRequest = requestFrom([fixedBody], { "content-length": String(fixedBody.length) });
  assert.deepEqual(await readJsonBody(fixedRequest), { market: "ASX" });
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

test("Background job history applies the time window before the result limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-history-"));
  try {
    const manager = createJobManager({ basePath: directory });
    const baseRecord = (id, updatedAt) => ({
      id,
      type: "history",
      market: "ASX",
      status: "complete",
      progress: 1,
      createdAt: updatedAt,
      updatedAt,
      result: { ok: true },
    });
    await writeFile(join(directory, "history-old-0000000000000.json"), JSON.stringify(baseRecord("history-old", "2020-01-01T00:00:00.000Z")), "utf8");
    const recent = "history-recent";
    await writeFile(join(directory, "history-recent-9999999999999.json"), JSON.stringify(baseRecord(recent, "2026-08-17T00:00:00.000Z")), "utf8");
    const rows = await manager.list({ limit: 1, updatedSince: "2025-01-01T00:00:00.000Z" });
    assert.equal(rows.jobs.length, 1);
    assert.equal(rows.jobs[0].id, recent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stale queued work is deferred instead of being reported as live queue state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-stale-queue-"));
  try {
    const manager = createJobManager({ basePath: directory, staleQueueAgeMs: 1_000 });
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    const persisted = {
      id: "unit-stale-queue",
      type: "unit",
      market: "US",
      status: "queued",
      progress: 0,
      createdAt,
      updatedAt: createdAt,
      heartbeatAt: createdAt,
      payload: { market: "US" },
    };
    await writeFile(join(directory, "unit-stale-queue.json"), JSON.stringify(persisted), "utf8");
    const listed = await manager.list({ type: "unit", market: "US" });
    assert.equal(listed.count, 1);
    assert.equal(listed.jobs[0].status, "deferred");
    assert.equal(listed.jobs[0].failureCategory, "queue_stale");
    assert.equal(listed.jobs[0].stale, true);
    assert.equal((await manager.get(persisted.id)).status, "deferred");
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

test("Background jobs deduplicate an active persisted job across manager instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-persisted-dedupe-"));
  try {
    const handler = async (_payload, update, context) => {
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (context.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" });
        await update((index + 1) / 12, { index });
      }
      return { ok: true };
    };
    const firstManager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    const secondManager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    firstManager.register("persisted", handler);
    secondManager.register("persisted", handler);
    const first = await firstManager.create("persisted", { market: "ASX", symbols: ["BHP"] });
    const duplicate = await secondManager.create("persisted", { symbols: ["BHP"], market: "ASX" });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.deduplicated, true);
    await firstManager.cancel(first.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Background queue supports pause, resume and explicit ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-controls-"));
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    manager.register("controlled", async (_payload, update, context) => {
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (context.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" });
        await update((index + 1) / 10, { phase: `step-${index + 1}` });
      }
      return { ok: true };
    });
    const first = await manager.create("controlled", { id: "first" });
    const second = await manager.create("controlled", { id: "second" });
    const third = await manager.create("controlled", { id: "third" });
    await new Promise((resolve) => setTimeout(resolve, 16));
    assert.equal((await manager.get(first.id))?.status, "running");
    assert.equal((await manager.pause(second.id))?.status, "paused");
    assert.equal((await manager.get(second.id))?.status, "paused");
    await manager.resume(second.id);
    assert.equal((await manager.get(second.id))?.status, "queued");
    await manager.reorder(third.id, "up");
    const queue = manager.status().pending;
    assert.deepEqual(queue.map((item) => item.id), [third.id, second.id]);
    await manager.start(second.id);
    assert.equal((await manager.get(second.id))?.status, "queued");
    assert.equal(manager.status().pending[0].id, second.id);
    await manager.cancel(second.id);
    assert.equal((await manager.get(second.id))?.status, "cancelled");
    await manager.cancel(first.id);
    await manager.cancel(third.id);
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

test("Failed background jobs can be restarted as a new audited attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-manual-restart-"));
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    manager.register("restartable", async () => {
      throw new Error("deliberate training failure");
    });
    const original = await manager.create("restartable", { market: "US" });
    let failed = null;
    for (let index = 0; index < 20; index += 1) {
      failed = await manager.get(original.id);
      if (failed?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(failed?.status, "failed");
    const restarted = await manager.restart(original.id);
    assert.ok(restarted?.id);
    assert.notEqual(restarted.id, original.id);
    assert.equal(restarted.restartedFrom, original.id);
    assert.equal(restarted.payload.restartOf, original.id);
    for (let index = 0; index < 20; index += 1) {
      const retry = await manager.get(restarted.id);
      if (retry?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await manager.shutdown("test cleanup");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Verified data replenishment runs before queued model training", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-data-priority-"));
  let releaseGate = null;
  const started = [];
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1, maxHeavyConcurrent: 1 });
    manager.register("hold", async () => {
      started.push("hold");
      await new Promise((resolve) => { releaseGate = resolve; });
      return { released: true };
    });
    manager.register("backtest", async () => {
      started.push("backtest");
      return { trained: true };
    });
    manager.register("pit-enrichment", async () => {
      started.push("pit-enrichment");
      return { persisted: true };
    });
    const hold = await manager.create("hold", { market: "US" });
    for (let index = 0; index < 20 && !releaseGate; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const training = await manager.create("backtest", { market: "US" });
    const pit = await manager.create("pit-enrichment", { market: "US" });
    releaseGate();
    let complete = null;
    for (let index = 0; index < 40; index += 1) {
      complete = await Promise.all([hold, training, pit].map((job) => manager.get(job.id)));
      if (complete.every((job) => job?.status === "complete")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(started, ["hold", "pit-enrichment", "backtest"]);
    assert.ok(complete.every((job) => job?.status === "complete"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Balanced policy lets one data job and one research job progress in parallel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-split-lanes-"));
  const started = [];
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const manager = createJobManager({
      basePath: directory,
      maxConcurrent: 2,
      maxHeavyConcurrent: 2,
      maxDataHeavyConcurrent: 1,
      maxResearchHeavyConcurrent: 1,
    });
    const waitForRelease = async (name) => {
      started.push(name);
      await gate;
      return { name };
    };
    manager.register("pit-enrichment", () => waitForRelease("pit"));
    manager.register("backtest", () => waitForRelease("backtest"));
    const pit = await manager.create("pit-enrichment", { market: "US" });
    const research = await manager.create("backtest", { market: "US" });
    for (let index = 0; index < 30 && started.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual([...started].sort(), ["backtest", "pit"]);
    assert.equal(manager.status().activeDataHeavy, 1);
    assert.equal(manager.status().activeResearchHeavy, 1);
    release();
    for (let index = 0; index < 40; index += 1) {
      const completed = await Promise.all([pit, research].map((job) => manager.get(job.id)));
      if (completed.every((job) => job?.status === "complete")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await manager.get(pit.id)).status, "complete");
    assert.equal((await manager.get(research.id)).status, "complete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training resource profiles persist and reconfigure background capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-training-resources-"));
  try {
    const manager = createJobManager({ basePath: join(directory, "jobs"), maxConcurrent: 1 });
    const resources = createTrainingResourceService({
      configPath: join(directory, "profile.json"),
      applyPolicy: (profile) => manager.configurePolicy(profile.jobs),
    });
    await resources.ready;
    const deep = await resources.set("deep");
    assert.equal(deep.selected, "deep");
    assert.equal(manager.status().maxConcurrent, 3);
    assert.equal(manager.status().maxHeavyConcurrent, 2);
    assert.equal(manager.status().maxDataHeavyConcurrent, 1);
    assert.equal(manager.status().maxResearchHeavyConcurrent, 1);
    assert.equal(deep.profile.data.historyBatch, 120);
    assert.equal(deep.profile.data.officialPitBatch, 30);
    const plan = resources.trainingPlan("weekly", { limit: 900, foldCount: 9 });
    assert.equal(plan.limit, 450);
    assert.equal(plan.foldCount, 8);
    assert.equal(plan.treeThreads, 4);
    const profilePlan = resources.trainingPlan("weekly");
    assert.equal(profilePlan.foldCount, 7);
    const restored = createTrainingResourceService({ configPath: join(directory, "profile.json") });
    assert.equal((await restored.get()).selected, "deep");
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

test("Detached queued data work is deferred instead of reported as phantom queue state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-orphan-queue-"));
  try {
    const manager = createJobManager({ basePath: directory, orphanQueueAgeMs: 60_000 });
    manager.register("history-backfill", async () => ({ complete: 1 }));
    const persisted = {
      id: "history-backfill-detached",
      type: "history-backfill",
      market: "CN",
      status: "queued",
      runtimeVersion: 3,
      attempt: 1,
      maxAttempts: 1,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      payload: { market: "CN", symbols: ["000001"] },
      checkpoints: {},
    };
    await writeFile(join(directory, "history-backfill-detached.json"), JSON.stringify(persisted), "utf8");
    const listed = await manager.list({ type: "history-backfill", market: "CN" });
    assert.equal(listed.count, 1);
    assert.equal(listed.jobs[0].status, "deferred");
    assert.equal(listed.jobs[0].failureCategory, "queue_stale");
    assert.equal(listed.jobs[0].stale, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Restart reconciliation resumes queued history backfill without a manual profile toggle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-history-resume-"));
  try {
    const manager = createJobManager({ basePath: directory, maxConcurrent: 1 });
    manager.register("history-backfill", async (_payload, update, context) => {
      await update(0.7, { phase: "history-backfill" });
      await context.checkpoint("symbol-AAPL", { rows: 2500, source: "unit-source" });
      return { complete: 1 };
    });
    const persisted = {
      id: "history-backfill-resume",
      type: "history-backfill",
      market: "US",
      status: "queued",
      runtimeVersion: 3,
      attempt: 1,
      maxAttempts: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      payload: { market: "US", symbols: ["AAPL"] },
      checkpoints: {},
    };
    await writeFile(join(directory, "history-backfill-resume.json"), JSON.stringify(persisted), "utf8");
    const reconciled = await manager.reconcile();
    let final = null;
    for (let index = 0; index < 40; index += 1) {
      final = await manager.get(persisted.id);
      if (final?.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reconciled.resumed, 1);
    assert.equal(final?.status, "complete");
    assert.equal(final?.result?.complete, 1);
    assert.equal(final?.checkpoints?.["symbol-AAPL"]?.rows, 2500);
    assert.equal(final?.attempt, 1);
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

test("Restart reconciliation does not auto-resume supervisor backtests without a completed OOF fold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-supervisor-review-"));
  try {
    const manager = createJobManager({ basePath: directory });
    manager.register("backtest", async () => ({ ok: true }));
    const now = new Date().toISOString();
    const persisted = {
      id: "backtest-supervisor-interrupted",
      type: "backtest",
      market: "ASX",
      status: "running",
      runtimeVersion: 3,
      attempt: 1,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      checkpoints: { "data-audit": { status: "complete" } },
      payload: {
        resume: true,
        supervisorContext: { cycleId: "ASX-unit", reason: "verified-data-version-changed" },
      },
    };
    await writeFile(join(directory, `${persisted.id}.json`), JSON.stringify(persisted), "utf8");
    const reconciled = await manager.reconcile();
    const recovered = await manager.get(persisted.id);
    assert.equal(reconciled.repaired, 1);
    assert.equal(reconciled.resumed, 0);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.failureCategory, "interrupted_supervisor_requires_review");
    assert.match(recovered.error, /before any OOF fold completed/i);
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
      accuracyPct: 61.5,
      balancedAccuracyPct: 58.2,
      brierSkillScore: 0.08,
      ecePct: 2.4,
      calibrationSlope: 1.02,
      probabilityBucketMinCount: 62,
      probabilityBucketMinIndependentDates: 42,
      probabilityResolutionPassed: true,
    },
    directionMetrics: {
      testDates: 140,
      accuracyPct: 61.5,
      balancedAccuracyPct: 58.2,
      brierSkillScore: 0.08,
      ecePct: 2.4,
      calibrationSlope: 1.02,
      probabilityBucketMinCount: 62,
      probabilityBucketMinIndependentDates: 42,
      probabilityResolutionPassed: true,
    },
    directionThresholdMetrics: {
      available: true,
      threshold: 0.47,
      abstainMargin: 0.01,
      coveragePct: 76.2,
      balancedAccuracyPct: 58.2,
      matthewsCorrelation: 0.16,
      relativeMajorityAccuracyPct: 1.5,
    },
    rankingMetrics: { topDecileLift: 0.021, top10DirectionHitRatePct: 62.1 },
    expectedValue: { expectedValuePct: 0.62 },
    longTradeExpectedValue: { available: true, expectedValuePct: 0.62 },
    productionChecks: { immutableDatasetManifest: true, pointInTimeCoverage: true, companyActions: true },
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
        panelSampling: {
          rankingComputedBeforeSampling: true,
          eligiblePanelRows: 85000,
          sampledPanelRows: 85000,
          skippedPanelRows: 0,
          rankingUniverseDates: 180,
        },
        outerCrossSectionRowConservation: {
          passed: true,
          completeDailyCrossSection: true,
          eligibleRows: 85000,
          evaluatedRows: 85000,
          auditedExcludedRows: 0,
          sampledRows: 85000,
          skippedRows: 0,
        },
      },
      horizonModels: [horizonModel(5), horizonModel(15), horizonModel(30)],
      manifest: {
        model_version: "asx-multitask-test",
        data_version: "asx-test-data-v1",
        deployment_status: "shadow",
        candidate_status: "AVAILABLE",
        lockbox_created_before_fit: true,
        comparison_key: "asx-comparison-test-v1",
        comparison_key_fields: {
          market: "ASX",
          horizon: 5,
          dataVersion: "asx-test-data-v1",
          featureSchemaHash: "features-test-v1",
          universeVersion: "asx-universe-test-v1",
          labelDefinition: "next-session-triple-barrier-v2",
          transactionCostBps: 12,
          splitPolicy: "purged-walk-forward-v1",
          foldCount: 5,
          embargoDays: 7,
          testSetSignature: "asx-lockbox-test-v1",
        },
      },
      researchLockbox: {
        lockboxId: "lockbox-asx-test-v1",
        status: "consumed",
        createdBeforeFit: true,
        accessCount: 1,
        openedByCandidateId: "candidate-asx-test-v1",
        consumedByCandidateId: "candidate-asx-test-v1",
        evaluationOutcome: "accepted",
      },
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

test("Promotion evidence V3 requires a one-read accepted lockbox", () => {
  const fixture = acceptedTrainingFixture().productionTraining;
  const evaluation = evaluateTrainingResult({ productionTraining: fixture });
  const evidence = buildPromotionEvidenceV3({
    market: "ASX",
    cycleId: "cycle-test",
    attempt: 1,
    jobId: "job-test",
    evaluation,
    context: {
      dataVersion: fixture.manifest.data_version,
      comparisonKey: fixture.manifest.comparison_key,
      comparisonKeyFields: fixture.manifest.comparison_key_fields,
      candidateStatus: fixture.manifest.candidate_status,
      kernelDecision: fixture.productionEligibility,
      kernelChecks: evaluation.kernelChecks,
      kernelFailedChecks: evaluation.kernelFailedChecks,
      lockbox: fixture.researchLockbox,
      lockboxCreatedBeforeFit: true,
    },
  });
  assert.equal(validatePromotionEvidenceV3(evidence, { market: "ASX" }).valid, true);

  const untouched = buildPromotionEvidenceV3({
    market: "ASX",
    cycleId: "cycle-test",
    attempt: 1,
    jobId: "job-test",
    evaluation,
    context: {
      dataVersion: fixture.manifest.data_version,
      comparisonKey: fixture.manifest.comparison_key,
      comparisonKeyFields: fixture.manifest.comparison_key_fields,
      candidateStatus: fixture.manifest.candidate_status,
      kernelDecision: fixture.productionEligibility,
      kernelChecks: evaluation.kernelChecks,
      kernelFailedChecks: evaluation.kernelFailedChecks,
      lockbox: { ...fixture.researchLockbox, status: "frozen_untouched", evaluationOutcome: null },
      lockboxCreatedBeforeFit: true,
    },
  });
  assert.equal(validatePromotionEvidenceV3(untouched, { market: "ASX" }).reason, "promotion_evidence_lockbox_not_accepted_once");
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

test("Learning progress never labels a partial model family as promotion eligible", () => {
  const base = {
    status: "complete",
    evidenceType: "strict_oof",
    candidateStatus: "PARTIAL",
    modelFamilyStatus: { direction: "NO_MODEL", ranking: "AVAILABLE" },
    blockers: [],
    samples: { oofRows: 1500, independentDates: 140 },
    metrics: { accuracyPct: 62, brierSkill: 0.08, ecePct: 3, topDecileAccuracyPct: 62, topDecileCi95: { low: 53 } },
    folds: Array.from({ length: 5 }, () => ({ positive: true })),
  };
  const decision = promotionDecision(base, null);
  assert.equal(decision.promoted, false);
  assert.match(decision.blockers.join(" | "), /PARTIAL|核心模型族/);
});

test("Learning progress maps candidate outcomes to non-interchangeable evidence semantics", () => {
  assert.equal(candidateEvidenceSemantics({}, {}, "PARTIAL").evidenceType, "partial_oof_attempt");
  assert.equal(candidateEvidenceSemantics({}, {}, "NO_MODEL").evidenceType, "no_model_attempt");
  assert.equal(candidateEvidenceSemantics({ available: true }, {}, "AVAILABLE").evidenceType, "strict_oof");
  const eligible = candidateEvidenceSemantics(
    { available: true, predictiveModelProduced: true, productionEvidencePassed: true },
    { productionEligibility: { eligible: true } },
    "AVAILABLE",
  );
  assert.equal(eligible.evidenceType, "eligible_strict_oof");
  assert.equal(eligible.promotionEligible, true);
});

test("Learning progress keeps attempt, eligible, research and comparable pointers separate", async () => {
  const base = await mkdtemp(join(tmpdir(), "global-quant-pointer-contract-"));
  try {
    const service = createLearningProgressService({
      basePath: join(base, "progress"),
      jobsPath: join(base, "jobs"),
      predictionPathFor: (market) => join(base, `${market}.json`),
    });
    await service.recordPoint("ASX", {
      id: "strict-a", market: "ASX", createdAt: "2026-08-01T00:00:00Z", status: "complete",
      evidenceType: "strict_oof", candidateStatus: "AVAILABLE", artifactProduced: true,
      predictiveModelProduced: true, promotionEligible: false,
      samples: { oofRows: 1500, independentDates: 140 },
      metrics: { balancedAccuracyPct: 56, brierSkill: 0.02, ecePct: 3 },
    });
    await service.recordPoint("ASX", {
      id: "partial-b", market: "ASX", createdAt: "2026-08-02T00:00:00Z", status: "complete",
      evidenceType: "partial_oof_attempt", candidateStatus: "PARTIAL", artifactProduced: true,
      predictiveModelProduced: false, promotionEligible: false, samples: {}, metrics: {},
    });
    const snapshot = await service.snapshot("ASX");
    assert.equal(snapshot.latestAttempt?.id, "partial-b");
    assert.equal(snapshot.latestEligibleModel, null);
    assert.equal(snapshot.bestResearchArtifact?.id, "strict-a");
    assert.equal(snapshot.bestComparablePredictiveCandidate?.id, "strict-a");
    assert.equal(snapshot.champion, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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

test("Learning progress imports new strict OOF evidence even when legacy observations already exist", async () => {
  const base = await mkdtemp(join(tmpdir(), "global-quant-learning-"));
  const jobsPath = join(base, "jobs");
  const progressPath = join(base, "progress");
  await mkdir(jobsPath, { recursive: true });
  const job = {
    id: "backtest-strict-new",
    type: "backtest",
    market: "ASX",
    status: "complete",
    createdAt: "2026-08-13T01:00:00.000Z",
    updatedAt: "2026-08-13T02:00:00.000Z",
    result: { productionTraining: {
      dataset: { rawRows: 60_000, effectiveRows: 55_000, symbolCount: 120 },
      horizonModels: [{
        horizon: 5,
        available: true,
        modelVersion: "asx-5d-new",
        oofRows: 1_500,
        eventCounts: { target: 600, stop: 650 },
        metrics: { testDates: 140, accuracyPct: 59, brierSkillScore: 0.02, ecePct: 3, selectiveTop10AccuracyPct: 60 },
        directionMetrics: { testDates: 140, accuracyPct: 58, balancedAccuracyPct: 56, precisionPct: 55, recallPct: 54, f1Pct: 54, brier: 0.23, brierSkillScore: 0.02, ecePct: 3, selectiveTop10AccuracyPct: 60 },
        rankingMetrics: { top10DirectionHitRatePct: 60, top10TargetFirstRatePct: 58 },
        foldMetrics: Array.from({ length: 5 }, (_, fold) => ({ fold, positive: true, directionAccuracyPct: 58 })),
      }],
    } },
  };
  await writeFile(join(jobsPath, `${job.id}.json`), JSON.stringify(job), "utf8");
  const service = createLearningProgressService({
    basePath: progressPath,
    jobsPath,
    predictionPathFor: (market) => join(base, `${market}.json`),
  });
  await service.recordPoint("ASX", {
    id: "legacy-observation",
    market: "ASX",
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "complete",
    evidenceType: "live_observational",
    samples: {},
    metrics: {},
    blockers: ["observational evidence"],
  });
  const snapshot = await service.snapshot("ASX");
  assert.equal(snapshot.latestStrictRun?.sourceJobId, job.id);
  assert.equal(snapshot.latestRun?.sourceJobId, job.id);
  assert.ok(snapshot.curves.fixed.some((point) => point.sourceJobId === job.id));
  await rm(base, { recursive: true, force: true });
});

test("Learning progress reports actual fitted rows when legacy dataset summaries omit effectiveRows", () => {
  const point = pointFromTrainingJob({
    id: "backtest-row-contract",
    type: "backtest",
    market: "US",
    status: "complete",
    updatedAt: "2026-08-23T00:00:00.000Z",
    result: { productionTraining: {
      dataset: {
        rawRows: 774_387,
        symbolCount: 396,
        panelSampling: { eligiblePanelRows: 774_444, sampledPanelRows: 774_387 },
      },
      horizonModels: [{
        horizon: 5,
        available: true,
        status: "PARTIAL",
        rowCount: 774_387,
        oofRows: 225_661,
        directionMetrics: { testDates: 198, balancedAccuracyPct: 50.27 },
      }],
    } },
  });
  assert.equal(point.samples.eligibleRows, 774_444);
  assert.equal(point.samples.effectiveRows, 774_387);
  assert.equal(point.samples.fittedRows, 774_387);
  assert.equal(point.samples.oofRows, 225_661);
  assert.equal(point.candidateStatus, "PARTIAL");
  assert.equal(point.evidenceType, "partial_oof_attempt");
  assert.equal(point.promotionEligible, false);
});

test("Training gate is deterministic and only tightens rework plans", () => {
  const decision = deterministicGateDecision({ passed: true, score: 84, failedChecks: [] });
  assert.equal(decision.mode, "deterministic_only");
  assert.equal(decision.accepted, true);
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

test("Training supervisor keeps later markets queued while an earlier OOF job runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-queue-fairness-"));
  const jobs = new Map();
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX", "CN"],
      config: { startupDelayMs: 0, retryDelayMs: 10, autoCycleEnabled: false },
      async createTrainingJob(market, plan) {
        const job = { id: `job-${market}`, status: "queued", progress: 0, updatedAt: new Date().toISOString(), market, plan };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
    });

    await supervisor.trigger({ market: "ASX", reason: "unit-test", changedHypothesis: "queue-asx" });
    const asx = await supervisor.status("ASX");
    jobs.set(asx.market.activeJobId, { ...jobs.get(asx.market.activeJobId), status: "running", updatedAt: new Date().toISOString() });
    await supervisor.trigger({ market: "CN", reason: "unit-test", changedHypothesis: "queue-cn" });

    const before = await supervisor.status("CN");
    assert.equal(before.market.status, "queued");
    assert.equal(before.market.activeJobId, null);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await supervisor.tick("queue-fairness");
    const after = await supervisor.status("CN");
    assert.equal(after.market.status, "queued");
    assert.equal(after.market.activeJobId, null);
    assert.ok(new Date(after.market.nextActionAt).getTime() > Date.now() - 5);
    assert.equal(jobs.has("job-CN"), false);
    assert.equal(after.market.history[0]?.reason, "another-market-running");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor clears an orphan queue state when no job or automatic schedule exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-orphan-queue-"));
  try {
    await writeFile(join(directory, "state.json"), JSON.stringify({
      version: 2,
      enabled: true,
      updatedAt: "2026-08-23T00:00:00.000Z",
      markets: {
        US: {
          market: "US",
          enabled: true,
          status: "queued",
          activeJobId: null,
          manualQueued: false,
          nextActionAt: null,
          history: [],
        },
      },
    }), "utf8");
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["US"],
      config: { autoCycleEnabled: false, autoReworkEnabled: false },
      async createTrainingJob() { return { id: "unexpected" }; },
      async getJob() { return null; },
    });
    const status = await supervisor.status("US");
    assert.equal(status.market.status, "completed_not_promoted");
    assert.equal(status.market.activeJobId, null);
    assert.match(status.market.lastError, /孤立排队状态已对账/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training gate persists a successful deterministic cycle without calling AI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-"));
  const jobs = new Map();
  const notices = [];
  let reviewCalls = 0;
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, retryDelayMs: 1000 },
      async createTrainingJob(market, plan) {
        const job = { id: `job-${market}`, status: "queued", progress: 0, updatedAt: new Date().toISOString(), market, plan };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
      async review() {
        reviewCalls += 1;
        throw new Error("AI quota must never be consulted by the training gate");
      },
      async notify(alert) {
        notices.push(alert);
      },
    });
    const triggered = await supervisor.trigger({ market: "ASX", reason: "unit-test", changedHypothesis: "deterministic-cycle" });
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
    assert.equal(completed.market.gateDecision.mode, "deterministic_only");
    assert.equal(completed.market.gateDecision.accepted, true);
    assert.equal(completed.market.evaluation.passed, true);
    assert.equal(completed.aiReviewEnabled, false);
    assert.equal(reviewCalls, 0);
    assert.equal(notices.at(-1)?.type, "TRAINING_ACCEPTED");
    const reviewedAgain = await supervisor.reviewLatest({ market: "ASX", source: "unit-test", operatorNote: "manual evidence recheck" });
    assert.equal(reviewedAgain.accepted, true);
    assert.equal((await supervisor.status("ASX")).market.status, "accepted");
    const operatorLogs = await supervisor.logs({ market: "ASX", limit: 20 });
    assert.equal(operatorLogs.events.find((event) => event.type === "operator-action" && event.action === "review-latest")?.operatorNote, "manual evidence recheck");
    await supervisor.configure({ market: "ASX", marketEnabled: false, source: "unit-test", operatorNote: "pause market schedule" });
    assert.equal((await supervisor.status("ASX")).market.enabled, false);
    const configLogs = await supervisor.logs({ market: "ASX", limit: 20 });
    const configEvent = configLogs.events.find((event) => event.type === "operator-action" && event.action === "configuration-changed");
    assert.equal(configEvent?.operatorNote, "pause market schedule");
    assert.deepEqual(configEvent?.changes?.[0], { field: "market.ASX.enabled", from: true, to: false });

    const restored = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      createTrainingJob: async () => { throw new Error("not expected"); },
      getJob: async () => null,
    });
    assert.equal((await restored.status("ASX")).market.status, "accepted");
    assert.equal((await restored.status("ASX")).market.enabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training gate accepts deterministic success without consulting AI quota", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-no-ai-"));
  const jobs = new Map();
  let reviewCalls = 0;
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, autoCycleEnabled: false },
      async createTrainingJob(market) {
        const job = { id: `job-${market}`, status: "queued", updatedAt: new Date().toISOString(), market };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
      async review() {
        reviewCalls += 1;
        throw new Error("quota exhausted");
      },
    });
    await supervisor.trigger({ market: "ASX", reason: "unit-test", changedHypothesis: "deterministic-no-ai" });
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
    assert.equal(completed.market.status, "accepted");
    assert.equal(completed.market.evaluation.passed, true);
    assert.equal(completed.market.gateDecision.accepted, true);
    assert.equal(completed.market.activeJobId, null);
    assert.equal(reviewCalls, 0);
    await supervisor.tick("no-autocycle");
    assert.equal((await supervisor.status("ASX")).market.status, "accepted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor rehydrates a compact completed job before evaluation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-job-hydration-"));
  let compactJob = null;
  let fullJob = null;
  let hydrationCalls = 0;
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, autoCycleEnabled: false },
      async createTrainingJob(market) {
        compactJob = { id: `job-${market}`, status: "queued", updatedAt: new Date().toISOString(), market };
        return compactJob;
      },
      async getJob(id, options = {}) {
        if (id !== compactJob?.id) return null;
        if (options.includeResult === true) {
          hydrationCalls += 1;
          return fullJob;
        }
        return compactJob;
      },
    });
    await supervisor.trigger({ market: "ASX", reason: "unit-test", changedHypothesis: "rehydrate-completed-job" });
    compactJob = {
      ...compactJob,
      status: "complete",
      progress: 1,
      resultSummary: { available: true, market: "ASX" },
      updatedAt: new Date().toISOString(),
    };
    fullJob = { ...compactJob, result: acceptedTrainingFixture() };

    await supervisor.tick("compact-job-complete");
    const completed = await supervisor.status("ASX");
    assert.equal(hydrationCalls, 1);
    assert.equal(completed.market.status, "accepted");
    assert.equal(completed.market.evaluation.passed, true);
    assert.ok(completed.market.evaluation.summary.rawRows >= 50_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training gate migrates legacy AI-quota waits from deterministic evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-migrate-ai-"));
  try {
    await writeFile(join(directory, "state.json"), JSON.stringify({
      version: 1,
      enabled: true,
      updatedAt: new Date().toISOString(),
      reviewersEnabled: { openai: true, siliconflow: true, hunyuan: true },
      markets: {
        ASX: {
          market: "ASX",
          enabled: true,
          status: "awaiting_optional_review",
          cycleId: "legacy-cycle",
          attempt: 1,
          activeJobId: null,
          lastCompletedAt: "2026-08-14T00:00:00.000Z",
          lastError: "AI 监工可用 0/2",
          evaluation: { passed: true, score: 100, failedChecks: [], modelVersion: "asx-legacy-pass" },
          reviewers: [],
          consensus: { accepted: false, minimumApprovals: 2, available: 0 },
          history: [],
        },
      },
    }), "utf8");
    const create = () => createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { autoCycleEnabled: false },
      async createTrainingJob() {
        throw new Error("not expected");
      },
      async getJob() {
        return null;
      },
    });
    const migrated = await create().status("ASX");
    assert.equal(migrated.market.status, "completed_not_promoted");
    assert.match(migrated.market.lastError, /PromotionEvidence/);
    assert.equal(migrated.market.gateDecision.mode, "deterministic_only");
    assert.equal(migrated.market.gateDecision.accepted, false);
    assert.equal(Object.hasOwn(migrated.market, "reviewers"), false);
    assert.equal(Object.hasOwn(migrated, "reviewersEnabled"), false);
    assert.equal((await create().status("ASX")).market.status, "completed_not_promoted");
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
    await supervisor.trigger({ market: "US", reason: "unit-test", changedHypothesis: "deterministic-rejection" });
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
    await supervisor.trigger({ market: "US", reason: "unit-test", changedHypothesis: "runtime-rework" });
    await supervisor.tick("unit-test-failure");
    const status = await supervisor.status("US");
    assert.equal(status.market.status, "rework_scheduled");
    assert.equal(status.market.attempt, 1);
    assert.match(status.market.lastError, /training process exited/);
    assert.ok(status.market.nextActionAt);
    const revisedPlan = status.market.currentPlan;
    const manualRework = await supervisor.trigger({ market: "US", source: "unit-test", operatorNote: "retry revised plan", changedHypothesis: "runtime-rework-revised" });
    assert.equal(manualRework.rework, true);
    const retried = await supervisor.status("US");
    assert.equal(retried.market.status, "training");
    assert.equal(retried.market.attempt, 2);
    assert.equal(retried.market.currentPlan.revision, revisedPlan.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor does not auto-refit an evidence-only rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-evidence-reject-"));
  const jobs = new Map();
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, retryDelayMs: 10, maxAttempts: 3, autoCycleEnabled: false },
      async createTrainingJob(market) {
        const job = { id: `job-${market}`, status: "queued", updatedAt: new Date().toISOString(), market };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) { return jobs.get(id) || null; },
    });
    await supervisor.trigger({ market: "ASX", mode: "full", reason: "evidence-test", changedHypothesis: "evidence-only-rejection" });
    const running = await supervisor.status("ASX");
    const rejected = acceptedTrainingFixture();
    rejected.productionTraining.horizonModels[0].productionChecks.companyActions = false;
    jobs.set(running.market.activeJobId, {
      ...jobs.get(running.market.activeJobId),
      status: "complete",
      result: rejected,
      updatedAt: new Date().toISOString(),
    });
    await supervisor.tick("evidence-rejection");
    const final = await supervisor.status("ASX");
    assert.equal(final.market.status, "completed_not_promoted");
    assert.equal(final.market.nextActionAt, null);
    assert.equal(final.market.history[0]?.type, "evidence-rejected-awaiting-new-evidence");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor does not mark a queued persisted job stale while another data task owns the worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-queued-"));
  const jobs = new Map();
  let creates = 0;
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, maxJobAgeMs: 60_000, maxQueuedJobAgeMs: 6 * 60 * 60_000, retryDelayMs: 1000 },
      async createTrainingJob() {
        creates += 1;
        const job = {
          id: `job-queued-${creates}`,
          status: "queued",
          progress: 0,
          updatedAt: new Date(Date.now() - 75 * 60_000).toISOString(),
        };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
    });
    await supervisor.trigger({ market: "ASX", reason: "unit-test", changedHypothesis: "queued-data-worker" });
    await supervisor.tick("queued-behind-ingest");
    const status = await supervisor.status("ASX");
    assert.equal(status.market.status, "training");
    assert.equal(status.market.activeJobId, "job-queued-1");
    assert.equal(creates, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor status keeps cross-market history bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-status-"));
  try {
    const history = (market) => Array.from({ length: 20 }, (_, index) => ({ id: `${market}-${index}` }));
    await writeFile(join(directory, "state.json"), JSON.stringify({
      version: 1,
      enabled: true,
      updatedAt: new Date().toISOString(),
      reviewersEnabled: {},
      markets: {
        ASX: { market: "ASX", history: history("asx") },
        US: { market: "US", history: history("us") },
      },
    }), "utf8");
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX", "US"],
      config: { startupDelayMs: 0, autoCycleEnabled: false },
      async createTrainingJob() {
        return { id: "job-status", status: "queued", updatedAt: new Date().toISOString() };
      },
      async getJob() {
        return null;
      },
    });
    const compact = await supervisor.status("ASX");
    assert.equal(compact.market.history.length, 12);
    assert.equal(compact.markets.ASX.history.length, 12);
    assert.equal(compact.markets.US.history.length, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Training supervisor releases a cancelled job into bounded rework", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-supervisor-cancelled-"));
  const jobs = new Map();
  try {
    const supervisor = createTrainingSupervisor({
      basePath: directory,
      markets: ["ASX"],
      config: { startupDelayMs: 0, maxAttempts: 3, retryDelayMs: 1000 },
      async createTrainingJob() {
        const job = { id: "job-cancelled", status: "cancelled", error: "operator cancelled stale matrix", updatedAt: new Date().toISOString() };
        jobs.set(job.id, job);
        return job;
      },
      async getJob(id) {
        return jobs.get(id) || null;
      },
    });
    await supervisor.trigger({ market: "ASX", reason: "unit-test", changedHypothesis: "cancelled-job-rework" });
    await supervisor.tick("unit-test-cancelled");
    const status = await supervisor.status("ASX");
    assert.equal(status.market.status, "rework_scheduled");
    assert.equal(status.market.activeJobId, null);
    assert.match(status.market.lastError, /operator cancelled stale matrix/);
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

test("Evidence registry serves task-center metadata without opening the large result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-task-index-"));
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath: join(directory, "jobs") });
  try {
    registry.persistJob({
      id: "backtest-indexed", type: "backtest", market: "CN", trainingRunId: "run-indexed",
      status: "running", progress: 0.6, createdAt: "2026-08-10T03:00:00Z", updatedAt: "2026-08-10T03:01:00Z",
      detail: { phase: "oof-fold-training", completed: 3, total: 5 },
      checkpoints: { "oof-fold-1": { completedAt: "2026-08-10T03:00:30Z" } },
      payload: { mode: "weekly" }, result: { largePayload: "x".repeat(100_000) },
    });
    const page = registry.backgroundJobs({ id: "backtest-indexed", limit: 1 });
    assert.equal(page.count, 1);
    assert.equal(page.jobs[0].detail.phase, "oof-fold-training");
    assert.equal(page.jobs[0].checkpoints["oof-fold-1"].completedAt, "2026-08-10T03:00:30Z");
    assert.equal(page.jobs[0].resultSummary.available, undefined);
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

test("Evidence registry derives calibration and factor research trajectories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-derived-"));
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath: join(directory, "jobs") });
  try {
    registry.persistJob({
      id: "backtest-calibration", type: "backtest", market: "ASX", trainingRunId: "run-calibration",
      status: "complete", progress: 1, createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T00:10:00Z",
      payload: {}, result: { productionTraining: { manifest: { model_version: "asx-v1", data_version: "data-v1" }, horizonModels: [{
        horizon: 5, available: true, oofRows: 7000, metaTestRows: 2000, weights: { target: 0.35 },
        directionWeights: { ridge: 0.35 }, directionMetrics: { brierSkillScore: 0.03 }, foldMetrics: [{}, {}, {}, {}, {}],
      }] } },
    }, { trajectory: true });
    registry.persistJob({
      id: "factor-evolution-derived", type: "factor-evolution", market: null,
      status: "complete", progress: 1, createdAt: "2026-08-10T01:00:00Z", updatedAt: "2026-08-10T01:10:00Z",
      payload: {}, result: { markets: [{ market: "ASX", availableCount: 36, research: { available: true, symbolCount: 36 } }] },
    }, { trajectory: true });
    const calibration = registry.trajectories({ market: "ASX", family: "calibration" });
    const factor = registry.trajectories({ market: "ASX", family: "factor" });
    assert.equal(calibration.count, 1);
    assert.equal(calibration.rows[0].metricName, "brierSkillScore");
    assert.equal(calibration.rows[0].evidence.result.oofRows, 7000);
    assert.equal(factor.count, 1);
    assert.equal(factor.rows[0].evidence.result.symbolCount, 36);
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evidence registry records immutable dataset snapshots and experiment identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-snapshots-"));
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath: join(directory, "jobs") });
  try {
    registry.persistJob({
      id: "backtest-snapshot", type: "backtest", market: "US", trainingRunId: "run-snapshot",
      status: "complete", progress: 1, createdAt: "2026-08-10T02:00:00Z", updatedAt: "2026-08-10T02:10:00Z",
      payload: { dataVersion: "us-data-v3" },
      result: { productionTraining: {
        dataset: { pointInTimeCoveragePct: 91, pointInTimeJoinViolationCount: 0, sources: ["sec"] },
        manifest: {
          model_version: "us-v3", data_version: "us-data-v3", snapshot_id: "snapshot-us-v3",
          snapshot_content_hash: "hash-v3", universe_version: "universe-us-v3",
          feature_schema_hash: "features-us-v3", label_definition: "next-session-v2",
          comparison_key: "comparison-us-v3", training_fingerprint: "fingerprint-v3",
        },
        horizonModels: [],
      } },
    }, { trajectory: true });
    const snapshots = registry.snapshots({ market: "US" });
    assert.equal(snapshots.count, 1);
    assert.equal(snapshots.rows[0].dataVersion, "us-data-v3");
    assert.equal(snapshots.rows[0].audit.pointInTimeCoveragePct, 91);
    const experiments = registry.experiments({ market: "US", family: "training" });
    assert.equal(experiments.count, 1);
    assert.equal(experiments.rows[0].comparisonKey, "comparison-us-v3");
    assert.equal(experiments.rows[0].config.trainingFingerprint, "fingerprint-v3");

    registry.persistJob({
      id: "backtest-derived-snapshot", type: "backtest", market: "ASX", trainingRunId: "run-derived",
      status: "complete", progress: 1, createdAt: "2026-08-10T03:00:00Z", updatedAt: "2026-08-10T03:10:00Z",
      payload: { dataVersion: "asx-data-derived-v1" },
      result: { productionTraining: {
        dataset: { pointInTimeCoveragePct: 70, pointInTimeJoinViolationCount: 0 },
        manifest: { data_version: "asx-data-derived-v1", comparison_key: "comparison-asx-derived-v1" },
      } },
    }, { trajectory: true });
    const derived = registry.snapshots({ market: "ASX" });
    assert.equal(derived.count, 1);
    assert.equal(derived.rows[0].snapshotId, "derived:ASX:asx-data-derived-v1");
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evidence import distinguishes unavailable dataless artifacts from malformed jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-import-"));
  const jobsPath = join(directory, "jobs");
  await mkdir(jobsPath, { recursive: true });
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath });
  try {
    await writeFile(join(jobsPath, "backtest-dataless.json"), "", "utf8");
    await writeFile(join(jobsPath, "backtest-malformed.json"), "{", "utf8");
    const result = await registry.importJobs();
    assert.equal(result.scanned, 2);
    assert.equal(result.imported, 0);
    assert.equal(result.unavailable, 1);
    assert.equal(result.failed, 1);
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evidence import reuses an existing index and retires empty active artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-evidence-index-reuse-"));
  const jobsPath = join(directory, "jobs");
  await mkdir(jobsPath, { recursive: true });
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath });
  try {
    const validId = "backtest-1788000000000-abcd1234";
    const emptyId = "history-backfill-1788000000001-efgh5678";
    await writeFile(join(jobsPath, `${validId}.json`), JSON.stringify({
      id: validId, type: "backtest", market: "US", status: "complete", progress: 1,
      createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:01:00.000Z",
      payload: {}, result: { available: true },
    }), "utf8");
    await writeFile(join(jobsPath, `${emptyId}.json`), "", "utf8");
    registry.persistJob({
      id: validId, type: "backtest", market: "US", status: "complete", progress: 1,
      createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:01:00.000Z",
      payload: {}, result: { available: true },
    });
    registry.persistJob({
      id: emptyId, type: "history-backfill", market: "ASX", status: "running", progress: 0.5,
      createdAt: "2026-08-29T00:02:00.000Z", updatedAt: "2026-08-29T00:03:00.000Z",
      payload: {}, result: null,
    });
    const result = await registry.importJobs();
    assert.equal(result.skippedImport, true);
    assert.equal(result.scanned, 0);
    assert.equal(result.repairedMissingActive, 1);
    const rows = registry.backgroundJobs({ limit: 10 }).jobs;
    assert.equal(rows.find((row) => row.id === emptyId)?.status, "failed");
    assert.equal(rows.find((row) => row.id === validId)?.status, "complete");
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Model manifests restore dataset snapshots without claiming production eligibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-manifest-import-"));
  const modelsPath = join(directory, "models");
  const manifestPath = join(modelsPath, "oof", "US", "checkpoints", "run-1");
  await mkdir(manifestPath, { recursive: true });
  const registry = createEvidenceRegistry({ dbPath: join(directory, "evidence.sqlite3"), jobsPath: join(directory, "jobs") });
  try {
    await writeFile(join(manifestPath, "manifest.json.gz"), gzipSync(JSON.stringify({
      signature: "manifest-test-v1",
      createdAt: "2026-08-20T00:00:00.000Z",
      definition: {
        schema: "oof-manifest-v1",
        market: "US",
        horizon: 5,
        rows: 120000,
        dateCount: 180,
        symbols: ["AAPL", "MSFT"],
        folds: [{ index: 1 }],
        rowContentHash: "rows-hash-v1",
        featureSchema: ["change5", "volumeRatio"],
        treeModels: true,
        sklearnModels: true,
      },
    })), "utf8");
    const result = await registry.importModelManifests({ modelsPath });
    assert.equal(result.imported, 1);
    const snapshots = registry.snapshots({ market: "US" });
    assert.equal(snapshots.count, 1);
    assert.equal(snapshots.rows[0].dataVersion, "manifest:US:5:rows-hash-v1");
    const trajectories = registry.trajectories({ market: "US", family: "training" });
    assert.equal(trajectories.rows[0].status, "manifest_imported");
  } finally {
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
