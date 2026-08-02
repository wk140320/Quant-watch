import assert from "node:assert/strict";
import test from "node:test";

process.env.SERVER_DISABLE_LISTEN = "true";

const {
  alpacaQuoteRows,
  alpacaRows,
  alpacaSnapshotQuoteFromPayload,
  alpacaTradeRows,
  aiProviderStatus,
  analysisBatchLimit,
  factorSignal,
  isLimitedProvider,
  localBatchAnalysis,
  localModelScopeForStrategy,
  providerApiKeys,
  providerConfigured,
  providerKeyPoolStatus,
  withProviderApiKey,
  redditCacheTtlForItem,
  redditProviderStatus,
  runPythonQuantCore,
  sanitizeResearchConfig,
  sanitizeUniverseRows,
  scoreRedditSocialPosts,
  fetchRedditSocialFactor,
  factorLabInputSignature,
  mergeRealCandleSources,
  historicalBacktestFactor,
  backendMarketSession,
  backendDueQuoteJobs,
  backendMonitorBudgetLimits,
  computeServerTechnicals,
  compactWorkspaceSnapshot,
  marketAnalysisEventFromMonitorResult,
  marketOverlayFromHistoryPayload,
  mergeServerSnapshots,
  mergeQuoteIntoCandles,
  normalizePredictionSample,
  summarizePredictionSamples,
  directionalOutcomeHit,
  pathOutcomeHit,
  intervalTouchOutcomeHit,
  predictionCandlesWithQuote,
  projectedMaxDownsideConfidenceMetrics,
  normalizeQuote,
  officialUniverseContainsSymbol,
  realtimeQuoteQuality,
  recentVerifiedOverlayBatch,
  selectBestRealtimeQuote,
  sanitizeQuoteChangeAgainstCandles,
  validMarketQuoteDate,
  verifiedProviderTimestamp,
  intradaySampleRows,
  sanitizeBackendMonitorConfig,
  trainIntradayLinearModel,
  stockAnalysisHistoryRows,
  tradeFootprintRows,
  tencentCnQuoteFromEncoded,
  tushareRows,
  universePayload,
} = await import("../server.mjs");

const {
  cacheControlFor,
  resolvedStaticPath,
} = await import("../backend/http/static-files.mjs");

test("Versioned static assets are immutable while HTML remains fresh", () => {
  assert.equal(cacheControlFor(new URL("http://local/frontend/styles/shell.css?v=1"), "/app/frontend/styles/shell.css"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor(new URL("http://local/"), "/app/index.html"), "no-store");
});

test("Factor lab cache signatures invalidate when the latest real bar changes", () => {
  const rows = [
    { date: "2026-07-27", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
    { date: "2026-07-28", open: 10.5, high: 12, low: 10, close: 11.2, volume: 1200 },
  ];
  const first = factorLabInputSignature("ASX", "BHP", 15, rows);
  const same = factorLabInputSignature("ASX", "BHP.AX", 15, rows);
  const changed = factorLabInputSignature("ASX", "BHP", 15, [
    rows[0],
    { ...rows[1], close: 11.3 },
  ]);
  assert.equal(first, same);
  assert.match(first, /^factor-lab-evidence-v2\|/);
  assert.notEqual(first, changed);
});

test("Factor lab history merges only unique real candle dates with live rows taking precedence", () => {
  const merged = mergeRealCandleSources([
    {
      source: "snapshot-real",
      role: "snapshot",
      candles: [
        { date: "2026-07-25", open: 10, high: 11, low: 9, close: 10, volume: 100 },
        { date: "2026-07-26", open: 10, high: 11, low: 9, close: 10.5, volume: 110 },
      ],
    },
    {
      source: "market-history-cache",
      role: "persistent-cache",
      candles: [
        { date: "2026-07-26", open: 10.4, high: 11, low: 10, close: 10.7, volume: 120 },
        { date: "2026-07-27", open: 10.7, high: 12, low: 10.5, close: 11.5, volume: 130 },
      ],
    },
    {
      source: "live-provider",
      role: "live-provider",
      candles: [
        { date: "2026-07-27", open: 10.8, high: 12, low: 10.6, close: 11.8, volume: 150 },
        { date: "2026-07-28", open: 11.8, high: 12.2, low: 11.4, close: 12, volume: 160 },
      ],
    },
  ], 20);
  assert.equal(merged.candles.length, 4);
  assert.deepEqual(merged.candles.map((row) => row.date), [
    "2026-07-25",
    "2026-07-26",
    "2026-07-27",
    "2026-07-28",
  ]);
  assert.equal(merged.candles.find((row) => row.date === "2026-07-27").close, 11.8);
  assert.deepEqual(merged.sources, ["snapshot-real", "market-history-cache", "live-provider"]);
});

test("Prediction evidence rejects cross-market rows and deduplicates immutable decisions", () => {
  const base = {
    market: "US",
    symbol: "AAPL",
    asOfDate: "2026-07-01",
    signalAt: "2026-07-01T20:00:00Z",
    close: 200,
    horizonDays: 5,
    targetUpside: 5,
    stopLoss: 4,
    modelVersion: "us-model-v1",
    featureSchemaHash: "features-v2",
    direction: "upside",
    confidence: 70,
  };
  assert.equal(normalizePredictionSample(base, "ASX"), null);
  const first = normalizePredictionSample(base, "US");
  const duplicate = normalizePredictionSample({ ...base, id: "legacy-random-id", createdAt: "2026-07-02T00:00:00Z" }, "US");
  assert.equal(first.predictionId, duplicate.predictionId);
  const summary = summarizePredictionSamples([
    { ...first, outcome: { resolved: true, forwardReturnPct: -1, targetWins: true, stopWins: false, hitTarget: true, hitStop: false } },
    { ...duplicate, outcome: { resolved: true, forwardReturnPct: -1, targetWins: true, stopWins: false, hitTarget: true, hitStop: false } },
  ], "US");
  assert.equal(summary.rawTotal, 2);
  assert.equal(summary.uniqueDecisions, 1);
  assert.equal(summary.independentDates, 1);
});

test("Prediction report separates final direction, barrier path, and interval touch", () => {
  const sample = {
    direction: "upside",
    targetUpside: 5,
    stopLoss: 4,
    outcome: {
      resolved: true,
      forwardReturnPct: -1.2,
      targetWins: true,
      stopWins: false,
      hitTarget: true,
      hitStop: true,
    },
  };
  assert.equal(directionalOutcomeHit(sample), false);
  assert.equal(pathOutcomeHit(sample), true);
  assert.equal(intervalTouchOutcomeHit(sample), true);
});

test("Workspace bootstrap keeps valid candles while dropping heavy factor internals", () => {
  const heavy = Array.from({ length: 5000 }, (_, index) => ({ index, value: index / 10 }));
  const snapshot = compactWorkspaceSnapshot({
    market: "US",
    watchlist: ["AAPL"],
    analyses: [{
      symbol: "AAPL",
      market: "US",
      candles: Array.from({ length: 60 }, (_, index) => ({ date: `2026-05-${String((index % 28) + 1).padStart(2, "0")}`, open: 100, high: 102, low: 99, close: 101, volume: 1000, orderflow: heavy })),
      technicals: { close: 101, rsi: 55, volumeRatio: 1.2, mainForceProxy: 52 },
      analysis: { action: "HOLD_WATCH", confidence: 61, thesis: ["test"] },
      factors: { factorResearch: { available: true, score: 3, thesis: ["useful"], backtestRows: heavy } },
    }],
  });
  assert.equal(snapshot.analyses[0].candles.length, 48);
  assert.equal(snapshot.analyses[0].technicals.rsi, 55);
  assert.equal(snapshot.analyses[0].factors.factorResearch.score, 3);
  assert.equal("backtestRows" in snapshot.analyses[0].factors.factorResearch, false);
  assert.ok(JSON.stringify(snapshot).length < 50000);
});

test("Concurrent snapshot saves preserve newly added symbols and the newest analysis", () => {
  const analysis = (symbol, analysisAsOf, close) => ({
    symbol,
    market: "ASX",
    analysisAsOf,
    candles: [{ date: "2026-07-17", open: close, high: close, low: close, close, volume: 1000 }],
    technicals: { close, rsi: 50, volumeRatio: 1, mainForceProxy: 50 },
    analysis: { action: "HOLD_WATCH", confidence: 50 },
  });
  const merged = mergeServerSnapshots({
    market: "ASX",
    updatedAt: "2026-07-20T09:30:00.000Z",
    watchlist: ["WBT", "CBA"],
    selected: "WBT",
    analyses: [
      analysis("WBT", "2026-07-20T09:29:00.000Z", 5.41),
      analysis("CBA", "2026-07-20T09:28:00.000Z", 171.2),
    ],
  }, {
    market: "ASX",
    updatedAt: "2026-07-20T09:31:00.000Z",
    watchlist: ["CBA", "BHP"],
    selected: "BHP",
    analyses: [
      analysis("CBA", "2026-07-20T09:20:00.000Z", 170),
      analysis("BHP", "2026-07-20T09:31:00.000Z", 57.54),
    ],
  }, "ASX");
  assert.deepEqual(new Set(merged.watchlist), new Set(["WBT", "CBA", "BHP"]));
  assert.equal(merged.analyses.find((item) => item.symbol === "CBA").technicals.close, 171.2);
  assert.equal(merged.selected, "BHP");
});

test("Static file resolution stays inside the application root", () => {
  assert.equal(resolvedStaticPath("/tmp/quant-watch", "/frontend/styles/shell.css"), "/tmp/quant-watch/frontend/styles/shell.css");
  assert.throws(() => resolvedStaticPath("/tmp/quant-watch", "/../../etc/passwd"), /outside the application root/);
});

test("Alpaca bars preserve real trade count without changing source capability", () => {
  const rows = alpacaRows({
    bars: [
      { t: "2026-06-01T14:30:00Z", o: 100, h: 102, l: 99, c: 101, v: 4000, n: 320, vw: 100.7 },
    ],
  }, "5m");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tradeCount, 320);
  assert.equal(rows[0].date, "2026-06-01T14:30:00Z");
});

test("Alpaca trades preserve provider-reported trade fields", () => {
  const rows = alpacaTradeRows({
    trades: [
      { t: "2026-06-01T14:30:01.000Z", p: 101.25, s: 20, x: "V", c: ["@"], i: 22, z: "C", q: 2 },
      { t: "2026-06-01T14:30:00.000Z", p: 101.2, s: 10, x: "D", c: [], i: 21, z: "C", q: 1 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].trade_id, "21");
  assert.equal(rows[1].exchange, "V");
  assert.deepEqual(rows[1].conditions, ["@"]);
  assert.equal(rows[1].size, 20);
});

test("Alpaca quotes preserve real bid and ask fields", () => {
  const rows = alpacaQuoteRows({
    quote: { t: "2026-06-01T14:30:03.000Z", bp: 101.2, bs: 8, ap: 101.3, as: 9, bx: "V", ax: "D", c: ["R"], z: "C" },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bid_price, 101.2);
  assert.equal(rows[0].ask_size, 9);
  assert.deepEqual(rows[0].conditions, ["R"]);
});

test("Alpaca batch snapshot rows preserve provider time and previous close", () => {
  const quote = alpacaSnapshotQuoteFromPayload("AAPL", {
    latestTrade: { p: 212.34, t: "2026-07-16T19:59:58.000Z" },
    latestQuote: { bp: 212.32, ap: 212.35, t: "2026-07-16T19:59:59.000Z" },
    dailyBar: { o: 210, h: 213, l: 209.5, v: 1234567 },
    prevDailyBar: { c: 209.8 },
  }, "iex");
  assert.equal(quote.symbol, "AAPL");
  assert.equal(quote.price, 212.34);
  assert.equal(quote.previousClose, 209.8);
  assert.equal(quote.asOf, "2026-07-16T19:59:58.000Z");
  assert.equal(quote.timeVerified, true);
});

test("Tencent batch quote rows preserve exchange time and lot volume", () => {
  const parts = Array.from({ length: 40 }, () => "");
  parts[3] = "12.34";
  parts[4] = "12.10";
  parts[5] = "12.15";
  parts[30] = "20260717145958";
  parts[31] = "0.24";
  parts[32] = "1.98";
  parts[33] = "12.50";
  parts[34] = "12.00";
  parts[36] = "12345";
  const quote = tencentCnQuoteFromEncoded("600519", parts.join("~"));
  assert.equal(quote.price, 12.34);
  assert.equal(quote.previousClose, 12.1);
  assert.equal(quote.volume, 1234500);
  assert.equal(quote.asOf, "2026-07-17T06:59:58.000Z");
  assert.equal(quote.exchange, "SSE");
});

test("Repeated quote batches reuse only very recent verified real overlays", () => {
  const nowMs = Date.parse("2026-07-17T06:00:00.000Z");
  const recent = recentVerifiedOverlayBatch([
    { symbol: "AAPL", market: "US", price: 210, source: "alpaca-iex-us-snapshot", retrievedAt: "2026-07-17T05:59:55.000Z", stale: false },
    { symbol: "MSFT", market: "US", price: 500, source: "alpaca-iex-us-snapshot", retrievedAt: "2026-07-17T05:59:54.000Z", stale: false },
  ], ["AAPL", "MSFT"], "US", { nowMs, maxAgeMs: 12_000 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].symbol, "AAPL");
  assert.equal(recentVerifiedOverlayBatch([
    { symbol: "AAPL", market: "US", price: 210, retrievedAt: "2026-07-17T05:59:30.000Z", stale: false },
  ], ["AAPL"], "US", { nowMs, maxAgeMs: 12_000 }), null);
  assert.equal(recentVerifiedOverlayBatch([
    { symbol: "AAPL", market: "US", price: 210, retrievedAt: "2026-07-17T05:59:59.000Z", stale: true },
  ], ["AAPL"], "US", { nowMs, maxAgeMs: 12_000 }), null);
});

test("US trade footprint buckets real ticks into candle price levels without claiming L2", () => {
  const candles = alpacaRows({
    bars: [
      { t: "2026-06-01T14:30:00.000Z", o: 100, h: 101, l: 99.8, c: 100.5, v: 1000, n: 4, vw: 100.4 },
      { t: "2026-06-01T14:35:00.000Z", o: 100.5, h: 101.2, l: 100.4, c: 101, v: 1200, n: 2, vw: 100.8 },
    ],
  }, "5m");
  const trades = alpacaTradeRows({
    trades: [
      { t: "2026-06-01T14:30:01.000Z", p: 100.1, s: 10, x: "V", i: 1, q: 1 },
      { t: "2026-06-01T14:30:05.000Z", p: 100.2, s: 20, x: "V", i: 2, q: 2 },
      { t: "2026-06-01T14:30:10.000Z", p: 100.15, s: 5, x: "D", i: 3, q: 3 },
      { t: "2026-06-01T14:35:03.000Z", p: 100.8, s: 12, x: "V", i: 4, q: 4 },
    ],
  });
  const result = tradeFootprintRows(candles, trades, { interval: "5m", source: "alpaca-iex-us-trades" });
  assert.equal(result.summary.enriched_candles, 2);
  assert.equal(result.summary.trade_rows_used, 4);
  assert.equal(result.summary.true_l2, false);
  assert.equal(result.summary.aggressor_side_available, false);
  assert.equal(result.summary.side_method, "tick_rule_estimate");
  assert.ok(result.candles[0].priceLevels.length >= 2);
  assert.equal(result.candles[0].orderflowSideMethod, "tick_rule_estimate");
  assert.ok(result.candles[0].buyVolume > 0);
  assert.ok(result.candles[0].sellVolume > 0);
});

test("StockAnalysis ASX parser reads nested Svelte data payloads", () => {
  const rows = stockAnalysisHistoryRows(`
    <script>kit.start(app, element, {
      data: [{}, {}, {type:"data",data:{data:{id:29199,symbol:"ASX-CBA",source:"spg",data:[
        {a:160.9,c:160.9,h:164.48,l:160,o:164.48,t:"2026-06-05",v:2362781,ch:-1.73},
        {a:163.73,c:163.73,h:164.89,l:161.7,o:164.86,t:"2026-06-04",v:1378064,ch:-.63}
      ],created_at:"2025-03-06 15:16:31",updated_at:"2026-06-05 22:57:41"}}}]
    });</script>
  `, "1mo");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, "2026-06-04");
  assert.equal(rows[0].close, 163.73);
  assert.equal(rows[1].volume, 2362781);
});

test("Tushare daily response maps fields and lot volume", () => {
  const rows = tushareRows({
    data: {
      fields: ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"],
      items: [["600519.SH", "20260601", 1500, 1530, 1490, 1520, 123.4, 19000]],
    },
  });
  assert.equal(rows[0].date, "2026-06-01");
  assert.equal(rows[0].volume, 12340);
  assert.equal(rows[0].amount, 19000000);
});

test("Research configuration is market-isolated and clamped", () => {
  const config = sanitizeResearchConfig({
    market: "US",
    factorConfig: { momentum_20: { enabled: true, weightPct: 140 } },
    strategyRevisions: [{ strategy: { horizonDays: 90, confidence: 120, targetUpside: 5 } }],
  }, "US");
  assert.equal(config.market, "US");
  assert.equal(config.factorConfig.momentum_20.weightPct, 100);
  assert.equal(config.strategyRevisions[0].strategy.horizonDays, 60);
  assert.equal(config.strategyRevisions[0].strategy.confidence, 99);
});

test("Universe rows are market-normalized, deduplicated, and pageable", () => {
  const rows = sanitizeUniverseRows([
    { symbol: "BHP.AX", name: "BHP Group", industry: "Materials" },
    { code: "BHP", name: "Duplicate BHP" },
    { symbol: "AAPL", name: "Wrong market" },
    { symbol: "", name: "Empty" },
  ], "ASX");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "BHP.AX");
  assert.equal(rows[0].code, "BHP");
  const payload = universePayload({ market: "ASX", source: "unit", rows }, { limit: 1, search: "BHP" });
  assert.equal(payload.count, 1);
  assert.equal(payload.filteredCount, 1);
  assert.equal(payload.rows[0].name, "BHP Group");
});

test("ASX official universe validation rejects cross-exchange AUX mappings", () => {
  const rows = [
    { code: "BHP", symbol: "BHP.AX" },
    { code: "CBA", symbol: "CBA.AX" },
  ];
  assert.equal(officialUniverseContainsSymbol(rows, "BHP.AX", "ASX"), true);
  assert.equal(officialUniverseContainsSymbol(rows, "AUX.AX", "ASX"), false);
});

test("Quota classifier recognises limited providers", () => {
  assert.equal(isLimitedProvider("alpaca-us-iex"), true);
  assert.equal(isLimitedProvider("eastmoney-cn"), false);
});

test("Alpaca official env aliases are recognised as configured", () => {
  const previousKey = process.env.ALPACA_API_KEY;
  const previousSecret = process.env.ALPACA_API_SECRET;
  const previousApcaKey = process.env.APCA_API_KEY_ID;
  const previousApcaSecret = process.env.APCA_API_SECRET_KEY;
  delete process.env.ALPACA_API_KEY;
  delete process.env.ALPACA_API_SECRET;
  process.env.APCA_API_KEY_ID = "test-apca-key";
  process.env.APCA_API_SECRET_KEY = "test-apca-secret";
  try {
    assert.equal(providerConfigured("alpaca-us-iex"), true);
  } finally {
    if (previousKey === undefined) delete process.env.ALPACA_API_KEY;
    else process.env.ALPACA_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.ALPACA_API_SECRET;
    else process.env.ALPACA_API_SECRET = previousSecret;
    if (previousApcaKey === undefined) delete process.env.APCA_API_KEY_ID;
    else process.env.APCA_API_KEY_ID = previousApcaKey;
    if (previousApcaSecret === undefined) delete process.env.APCA_API_SECRET_KEY;
    else process.env.APCA_API_SECRET_KEY = previousApcaSecret;
  }
});

test("External AI provider status is ordered and redacted", () => {
  const oldOrder = process.env.AI_PROVIDER_ORDER;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  const oldSilicon = process.env.SILICONFLOW_API_KEY;
  const oldHunyuan = process.env.HUNYUAN_API_KEY;
  process.env.AI_PROVIDER_ORDER = "openai,siliconflow,hunyuan";
  process.env.OPENAI_API_KEY = "";
  process.env.SILICONFLOW_API_KEY = "test-silicon";
  process.env.HUNYUAN_API_KEY = "test-hunyuan";
  const providers = aiProviderStatus();
  assert.deepEqual(providers.map((provider) => provider.id), ["siliconflow", "hunyuan"]);
  assert.ok(providers.every((provider) => provider.configured));
  assert.ok(!JSON.stringify(providers).includes("test-silicon"));
  assert.ok(!JSON.stringify(providers).includes("test-hunyuan"));
  if (oldOrder === undefined) delete process.env.AI_PROVIDER_ORDER;
  else process.env.AI_PROVIDER_ORDER = oldOrder;
  if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenAi;
  if (oldSilicon === undefined) delete process.env.SILICONFLOW_API_KEY;
  else process.env.SILICONFLOW_API_KEY = oldSilicon;
  if (oldHunyuan === undefined) delete process.env.HUNYUAN_API_KEY;
  else process.env.HUNYUAN_API_KEY = oldHunyuan;
});

test("Local batch analysis handles pools beyond the old forty symbol cap", () => {
  const items = Array.from({ length: 55 }, (_, index) => ({
    symbol: `T${String(index).padStart(2, "0")}`,
    market: "US",
    strategy: { horizonDays: 15, targetUpside: 5, confidence: 75, stopLoss: 4 },
    technicals: {
      close: 100 + index,
      sma20: 99 + index,
      sma50: 98 + index,
      rsi: 55,
      volumeRatio: 1.2,
      mainForceProxy: 52,
      trendScore: 60,
      momentumScore: 58,
      volumeScore: 57,
      riskScore: 35,
      change5d: 1.2,
      change20d: 3.4,
      volatility: 2.1,
      projectedUpside: 2.8,
    },
    analog: { confidence: 52, similarCount: 8 },
    news: [],
    xPosts: [],
    youtubeItems: [],
    factors: null,
    fundamentals: null,
  }));
  const result = localBatchAnalysis(items);
  assert.ok(analysisBatchLimit() >= items.length);
  assert.equal(result.results.length, items.length);
  assert.ok(result.results.every((row) => row.symbol && row.analysis?.action));
});

test("Horizon-isolated local models override market-wide fallback only with enough samples", () => {
  const summary = {
    localModelDeployment: {
      sampleCount: 210,
      horizonSuites: {
        short: { sampleCount: 27, status: "collecting", reason: "short collecting" },
        mid: { sampleCount: 88, signalModels: { featureScoreHead: { active: true } } },
        long: { sampleCount: 65, modelZoo: { active: true } },
      },
    },
  };
  const mid = localModelScopeForStrategy(summary, { horizonDays: 15 });
  assert.equal(mid.horizonBucket, "mid");
  assert.equal(mid.source, "horizon_isolated");
  assert.equal(mid.sampleCount, 88);
  const short = localModelScopeForStrategy(summary, { horizonDays: 5 });
  assert.equal(short.horizonBucket, "short");
  assert.equal(short.source, "market_fallback");
  assert.equal(short.sampleCount, 210);
});

test("Node service can call the Python quant core", async () => {
  const health = await runPythonQuantCore("health");
  assert.equal(health.ok, true);
  assert.equal(health.order_execution_enabled, false);
});

test("Node service can call the Python portfolio risk engine", async () => {
  const risk = await runPythonQuantCore("risk-assessment", {
    market: "US",
    totalCapital: 10000,
    availableCash: 8000,
    positions: [{ symbol: "AAPL", qty: 10, avgPrice: 180, currentPrice: 200, sector: "Technology" }],
    policy: { maxPositionPct: 15 },
  });
  assert.equal(risk.market, "US");
  assert.equal(risk.order_execution_enabled, false);
  assert.ok(risk.warnings.some((row) => row.code === "POSITION_CONCENTRATION"));
});

test("Saved factor configuration changes the decision factor signal", () => {
  const factors = {
    macro: { available: true, score: 2, thesis: ["macro"] },
    sector: { available: true, score: -3, thesis: ["sector"] },
  };
  const technicals = {
    close: 110,
    sma20: 100,
    change5d: 8,
    change20d: 12,
    volatility: 1.2,
    volumeRatio: 1.5,
  };
  const momentum = factorSignal(factors, {
    momentum_5: { enabled: true, weightPct: 100 },
    reversal_5: { enabled: false, weightPct: 0 },
  }, technicals);
  const reversal = factorSignal(factors, {
    momentum_5: { enabled: false, weightPct: 0 },
    reversal_5: { enabled: true, weightPct: 100 },
  }, technicals);
  assert.equal(momentum.configApplied, true);
  assert.deepEqual(momentum.disabledFactors, ["reversal_5"]);
  assert.ok(momentum.score > reversal.score);
  assert.ok(momentum.enabledFactors.includes("momentum_5"));
  assert.ok(!momentum.enabledFactors.includes("reversal_5"));
});

test("Maximum downside confidence uses historical adverse paths without inventing a positive return label", () => {
  const result = projectedMaxDownsideConfidenceMetrics({
    projectedFinalReturn: 1.2,
    ensemble: { consensusAgreement: 72, upsideAgreement: 64 },
    analog: {
      examples: [
        { maxDrawdown: -1.4 },
        { maxDrawdown: -2.1 },
        { maxDrawdown: -3.2 },
        { maxDrawdown: -2.6 },
      ],
    },
    confidence: 63,
    strategy: { stopLoss: 4 },
    conservative: { shrink: 0.82, noTradeGate: { stopRiskProbability: 28 } },
  });
  assert.ok(result.projectedMaxDownside > 0);
  assert.ok(result.projectedMaxDownside <= 4.88);
  assert.ok(result.probability >= 0 && result.probability <= 92);
  assert.match(result.basis, /analog-drawdown/);
});

test("Reddit social scoring rewards relevant fact-backed engagement", () => {
  const result = scoreRedditSocialPosts([
    {
      id: "bhp-fact",
      title: "BHP iron ore demand and China stimulus: 6% shipment growth",
      content: "According to the latest filing and earnings call, revenue margin improved 3.2% while China infrastructure demand is recovering.",
      subreddit: "AusFinance",
      created_utc: 1780000000,
      score: 420,
      upvote_ratio: 0.89,
      num_comments: 74,
      url: "https://example.com/bhp-filing",
      permalink: "/r/AusFinance/comments/bhp_fact",
    },
  ], { market: "ASX", symbol: "BHP", limit: 10 });
  assert.equal(result.available, true);
  assert.ok(result.score > 0);
  assert.ok(result.confidence > 35);
  assert.ok(result.topItems[0].truthScore > 60);
  assert.equal(result.topItems[0].relation, "direct-stock");
});

test("Reddit social scoring does not overrate unrelated viral posts", () => {
  const result = scoreRedditSocialPosts([
    {
      id: "viral-unrelated",
      title: "A viral post about gaming laptops with no company link",
      content: "This has many comments but discusses a consumer gadget launch with no connection to the target company or its supply chain.",
      subreddit: "technology",
      created_utc: 1780000000,
      score: 20000,
      upvote_ratio: 0.96,
      num_comments: 5400,
      url: "https://example.com/viral",
      permalink: "/r/technology/comments/viral",
    },
  ], { market: "US", symbol: "NVDA", limit: 10 });
  assert.ok(Math.abs(result.score) < 1);
  if (result.topItems[0]) assert.ok(result.topItems[0].relevanceScore < 20);
});

test("Reddit social scoring penalizes manipulation-style hype", () => {
  const result = scoreRedditSocialPosts([
    {
      id: "tsla-pump",
      title: "TSLA guaranteed 100x pump moon all in",
      content: "Trust me insider short squeeze cannot lose yolo. No source, no numbers, no filing.",
      subreddit: "wallstreetbets",
      created_utc: 1780000000,
      score: 1500,
      upvote_ratio: 0.51,
      num_comments: 620,
      url: "https://www.reddit.com/r/wallstreetbets/comments/tsla_pump",
      permalink: "/r/wallstreetbets/comments/tsla_pump",
    },
  ], { market: "US", symbol: "TSLA", limit: 10 });
  assert.equal(result.available, true);
  assert.ok(result.topItems[0].manipulationRisk >= 65);
  assert.ok(result.topItems[0].truthScore < 55);
  assert.ok(result.score <= 0);
});

test("Reddit cache TTL stratifies high, medium, and low impact items", () => {
  const high = redditCacheTtlForItem({ impactScore: 72, relevanceScore: 30 });
  const medium = redditCacheTtlForItem({ impactScore: 45, relevanceScore: 30 });
  const low = redditCacheTtlForItem({ impactScore: 15, relevanceScore: 20 });
  assert.ok(high > medium);
  assert.ok(medium > low);
  assert.equal(high, 3 * 24 * 60 * 60 * 1000);
  assert.equal(medium, 24 * 60 * 60 * 1000);
  assert.equal(low, 12 * 60 * 60 * 1000);
});

test("Reddit disabled status and factor fallback do not throw", async () => {
  const previous = process.env.REDDIT_ENABLED;
  process.env.REDDIT_ENABLED = "false";
  try {
    const status = await redditProviderStatus("US", { compact: true });
    assert.equal(status.enabled, false);
    assert.equal(Array.isArray(status.cache?.rows), false);
    assert.ok(status.cache?.summary);
    assert.equal(status.configured, false);
    const factor = await fetchRedditSocialFactor("ZZZUNIT", "US", { mode: "refresh", limit: 10 });
    assert.equal(factor.available, false);
    assert.equal(factor.score, 0);
    assert.ok(/disabled|incomplete/i.test(factor.thesis[0]));
  } finally {
    if (previous === undefined) delete process.env.REDDIT_ENABLED;
    else process.env.REDDIT_ENABLED = previous;
  }
});

test("Backend monitor config separates high-frequency quotes from full analysis", () => {
  const config = sanitizeBackendMonitorConfig({
    strategy: { horizonDays: 15, confidence: 80, targetUpside: 5, stopLoss: 4, maxPosition: 20 },
    capital: { baseCapital: 5000 },
    markets: {
      ASX: {
        watchlist: ["BHP", "CPU", "AAPL"],
        portfolio: [{ symbol: "CPU", market: "ASX", qty: 20, avgPrice: 18.5, entryDate: "2026-07-01" }],
      },
      US: {
        watchlist: ["AAPL", "MSFT"],
        portfolio: [{ symbol: "AAPL", market: "US", qty: 2, avgPrice: 200 }],
      },
    },
  });
  assert.equal(config.refresh.quoteHoldingMs, 60 * 1000);
  assert.equal(config.refresh.quoteWatchMs, 3 * 60 * 1000);
  assert.equal(config.refresh.holdingMs, 2 * 60 * 1000);
  assert.equal(config.refresh.watchMs, 5 * 60 * 1000);
  assert.ok(config.markets.ASX.watchlist.includes("CPU.AX"));
  assert.ok(config.markets.ASX.watchlist.includes("BHP.AX"));
  assert.ok(!config.markets.ASX.watchlist.includes("AAPL"));
  assert.equal(config.markets.US.portfolio[0].symbol, "AAPL");
  assert.equal(config.training.symbolLimit, 3);
});

test("Quote scheduler prioritizes holdings without waiting for full analysis cadence", () => {
  const config = sanitizeBackendMonitorConfig({
    markets: {
      ASX: {
        watchlist: ["BHP", "CPU"],
        portfolio: [{ symbol: "CPU", qty: 10, avgPrice: 20 }],
      },
    },
  });
  const now = Date.parse("2026-07-13T04:00:00.000Z");
  const jobs = backendDueQuoteJobs(config, { lastQuoteChecks: {} }, now);
  assert.equal(jobs[0].symbol, "CPU.AX");
  assert.equal(jobs[0].tier, "holding");
  assert.ok(jobs.some((job) => job.symbol === "BHP.AX" && job.tier === "watch"));
});

test("Backend market session recognises regular market hours", () => {
  const asxOpen = backendMarketSession("ASX", new Date("2026-07-03T02:00:00Z"));
  const asxClosed = backendMarketSession("ASX", new Date("2026-07-03T08:00:00Z"));
  assert.equal(asxOpen.open, true);
  assert.equal(asxClosed.open, false);
});

test("Latest market history overlay wins over an older analysis snapshot price", () => {
  const overlay = marketOverlayFromHistoryPayload({
    market: "ASX",
    symbol: "CAR",
    source: "stockanalysis-asx-daily-single-source",
    savedAt: "2026-07-13T04:41:32.571Z",
    candles: [
      { date: "2026-07-10", open: 26.12, high: 26.56, low: 26.01, close: 26.37, volume: 557286 },
      { date: "2026-07-13", open: 26.37, high: 26.37, low: 25.79, close: 25.79, volume: 244029 },
    ],
  }, "ASX", "CAR", new Date("2026-07-13T04:45:00.000Z"));
  assert.equal(overlay.symbol, "CAR.AX");
  assert.equal(overlay.price, 25.79);
  assert.equal(overlay.previousClose, 26.37);
  assert.equal(overlay.dataAsOf, "2026-07-13");
  assert.equal(overlay.retrievedAt, "2026-07-13T04:41:32.571Z");
});

test("Stock quote keeps the latest real price but rejects a mismatched provider previous close", () => {
  const check = sanitizeQuoteChangeAgainstCandles("CAR", "ASX", [
    { date: "2026-07-10", open: 26.12, high: 26.56, low: 26.01, close: 26.37, volume: 557286 },
    { date: "2026-07-13", open: 26.22, high: 26.33, low: 25.76, close: 25.96, volume: 727701 },
  ], {
    symbol: "CAR.AX",
    price: 25.96,
    previousClose: 34.58,
    change: -8.62,
    changePercent: -24.9277,
    asOf: "2026-07-13T06:00:00.000Z",
    date: "2026-07-13",
    retrievedAt: "2026-07-13T07:16:00.000Z",
    timeVerified: true,
    source: "yahoo-finance-asx-quote",
  }, new Date("2026-07-13T07:19:00.000Z"));
  assert.equal(check.quote.price, 25.96);
  assert.equal(check.quote.previousClose, 26.37);
  assert.equal(check.quote.change, -0.41);
  assert.equal(check.quote.changePercent, -1.5548);
  assert.equal(check.quote.changeSource, "adjacent-real-candles");
  assert.match(check.warning, /price remains the latest real quote/i);
});

test("Unverified ASX company quote remains displayable but cannot create a candle", () => {
  const quote = normalizeQuote({
    symbol: "CAR",
    price: 25.9,
    previousClose: 26.37,
    retrievedAt: "2026-07-13T04:50:00.000Z",
    timeVerified: false,
    source: "asx-official-company-header",
  }, "ASX");
  assert.equal(quote.price, 25.9);
  assert.equal(quote.asOf, null);
  assert.equal(quote.date, null);
  assert.equal(quote.timeVerified, false);
  const candles = mergeQuoteIntoCandles([
    { date: "2026-07-10", open: 26.12, high: 26.56, low: 26.01, close: 26.37, volume: 557286 },
  ], quote, "ASX", new Date("2026-07-13T04:50:00.000Z"));
  assert.equal(candles.length, 1);
  assert.equal(candles[0].close, 26.37);
});

test("Unverified real quote updates the point-in-time model view without polluting stored candles", () => {
  const base = [
    { date: "2026-07-10", open: 26.12, high: 26.56, low: 26.01, close: 26.37, volume: 557286 },
  ];
  const quote = normalizeQuote({
    symbol: "CAR",
    price: 25.9,
    previousClose: 26.37,
    retrievedAt: "2026-07-13T04:50:00.000Z",
    timeVerified: false,
    source: "asx-official-company-header",
  }, "ASX", 26.37);
  const modelRows = predictionCandlesWithQuote(base, quote, "ASX", new Date("2026-07-13T04:50:00.000Z"));
  assert.equal(base[0].close, 26.37);
  assert.equal(modelRows.length, 1);
  assert.equal(modelRows[0].close, 25.9);
  assert.equal(modelRows[0].predictionOnly, true);
});

test("Backend live analysis event carries the current model price while retaining verified history", () => {
  const event = marketAnalysisEventFromMonitorResult({
    market: "ASX",
    symbol: "CAR.AX",
    tier: "watch",
    source: "backend-monitor-local",
    marketSource: "stockanalysis-asx-daily",
    quote: {
      symbol: "CAR.AX",
      market: "ASX",
      price: 25.9,
      previousClose: 26.37,
      retrievedAt: "2026-07-13T04:50:00.000Z",
      timeVerified: false,
      source: "asx-official-company-header",
      delayed: true,
    },
    candles: [{ date: "2026-07-10", open: 26.12, high: 26.56, low: 26.01, close: 26.37, volume: 557286 }],
    technicals: { close: 25.9, rsi: 48, volumeRatio: 1.1, mainForceProxy: 51 },
    analysis: { action: "HOLD", confidence: 57 },
    updatedAt: "2026-07-13T04:50:02.000Z",
  });
  assert.equal(event.analysisPrice, 25.9);
  assert.equal(event.analysisAsOf, "2026-07-13T04:50:02.000Z");
  assert.equal(event.candles.at(-1).close, 26.37);
  assert.equal(event.analysisNeedsRefresh, false);
});

test("Quote-to-candle merge rejects weekends and future dates", () => {
  const base = [{ date: "2026-07-10", open: 26.12, high: 26.56, low: 26.01, close: 26.37, volume: 557286 }];
  const now = new Date("2026-07-13T04:50:00.000Z");
  assert.equal(validMarketQuoteDate("2026-07-12", "ASX", now), false);
  assert.equal(validMarketQuoteDate("2026-07-14", "ASX", now), false);
  assert.equal(validMarketQuoteDate("2026-07-13", "ASX", now), true);
  const weekend = mergeQuoteIntoCandles(base, { price: 26.1, date: "2026-07-12", timeVerified: true }, "ASX", now);
  const future = mergeQuoteIntoCandles(base, { price: 26.1, date: "2026-07-14", timeVerified: true }, "ASX", now);
  const valid = mergeQuoteIntoCandles(base, { price: 25.79, date: "2026-07-13", timeVerified: true, source: "unit" }, "ASX", now);
  assert.equal(weekend.length, 1);
  assert.equal(future.length, 1);
  assert.equal(valid.length, 2);
  assert.equal(valid.at(-1).close, 25.79);
});

test("Provider timestamp parser accepts explicit ISO or epoch values only", () => {
  assert.equal(verifiedProviderTimestamp(["13/07/2026 14:50"]), null);
  assert.equal(verifiedProviderTimestamp(["2026-07-13T04:50:00Z"]), "2026-07-13T04:50:00.000Z");
  assert.equal(verifiedProviderTimestamp([1783918200]), "2026-07-13T04:50:00.000Z");
});

test("Strict quote selection chooses the freshest cross-checked price and rejects stale outliers", () => {
  const now = new Date("2026-07-13T05:00:00.000Z");
  const selected = selectBestRealtimeQuote([
    {
      source: "old-source",
      quote: { symbol: "CAR", price: 26.37, asOf: "2026-07-13T02:30:00.000Z", timeVerified: true, source: "old-source" },
    },
    {
      source: "source-a",
      quote: { symbol: "CAR", price: 25.9, asOf: "2026-07-13T04:58:00.000Z", timeVerified: true, source: "source-a" },
    },
    {
      source: "source-b",
      quote: { symbol: "CAR", price: 25.91, asOf: "2026-07-13T04:59:00.000Z", timeVerified: true, source: "source-b" },
    },
    {
      source: "bad-outlier",
      quote: { symbol: "CAR", price: 31.2, asOf: "2026-07-13T04:59:30.000Z", timeVerified: true, source: "bad-outlier" },
    },
  ], "ASX", 26.37, { strict: true, symbol: "CAR", now });
  assert.equal(selected.quote.price, 25.91);
  assert.equal(selected.quote.crossCheckStatus, "confirmed");
  assert.deepEqual(selected.quote.crossCheckSources.sort(), ["source-a", "source-b"]);
  assert.match(selected.warning, /old|conflict/i);
});

test("Open-market strict freshness rejects retrieval-time-only quotes", () => {
  const quality = realtimeQuoteQuality({
    symbol: "CAR",
    price: 25.9,
    retrievedAt: "2026-07-13T05:00:00.000Z",
    timeVerified: false,
  }, "ASX", new Date("2026-07-13T05:00:00.000Z"), { strict: true, symbol: "CAR" });
  assert.equal(quality.usable, false);
  assert.match(quality.reason, /verified provider timestamp/i);
});

test("Fresh ASX official retrieval-time quote is displayable for strict refresh without becoming a candle", () => {
  const now = new Date("2026-07-13T05:00:30.000Z");
  const quote = normalizeQuote({
    symbol: "MIN",
    price: 56.93,
    previousClose: 58.3,
    retrievedAt: "2026-07-13T05:00:00.000Z",
    timeVerified: false,
    retrievalTimeTrusted: true,
    source: "asx-official-company-header",
  }, "ASX", 58.3);
  const quality = realtimeQuoteQuality(quote, "ASX", now, { strict: true, symbol: "MIN" });
  assert.equal(quality.usable, true);
  assert.equal(quality.retrievalTimeTrusted, true);
  const candles = mergeQuoteIntoCandles([
    { date: "2026-07-10", open: 58, high: 59, low: 57, close: 58.3, volume: 1000 },
  ], quote, "ASX", now);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].close, 58.3);
  const predictionRows = predictionCandlesWithQuote(candles, quote, "ASX", now);
  assert.equal(predictionRows.at(-1).close, 56.93);
  assert.equal(predictionRows.at(-1).predictionOnly, true);
});

test("Backend technicals and intraday model train from completed minute bars", () => {
  const candles = Array.from({ length: 90 }, (_, index) => {
    const close = 100 + Math.sin(index / 5) * 1.5 + index * 0.03;
    return {
      date: `2026-07-03T${String(10 + Math.floor(index / 12)).padStart(2, "0")}:${String((index % 12) * 5).padStart(2, "0")}:00+10:00`,
      open: close - 0.1,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume: 10000 + index * 80,
    };
  });
  const technicals = computeServerTechnicals(candles);
  assert.ok(technicals.close > 0);
  assert.ok(Number.isFinite(technicals.rsi));
  const samples = intradaySampleRows("ASX", "CPU", candles, 3);
  assert.ok(samples.length > 40);
  assert.ok(samples.every((sample) => sample.timestamp < candles.at(-3).date));
  const model = trainIntradayLinearModel(samples);
  assert.equal(model.available, true);
  assert.ok(model.sampleCount >= samples.length);
  assert.ok(model.test.count > 0);
});

test("Backend monitor budget defaults reserve quota for minute training", () => {
  const limits = backendMonitorBudgetLimits();
  assert.ok(limits.quoteCalls > limits.manualQuoteReserve);
  assert.ok(limits.marketCalls > limits.trainingMarketReserve);
  assert.ok(limits.marketCalls > limits.trainingMarketReserve + limits.manualMarketReserve);
  assert.ok(limits.trainingCalls > 0);
  assert.equal(Object.values(limits.requestAllocation).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(Object.values(limits.trainingDataMix).reduce((sum, value) => sum + value, 0), 100);
});

test("Historical backtest factor exposes finite conformal errors", () => {
  const factor = historicalBacktestFactor({
    available: true,
    dataDepth: { predictionCuts: 120 },
    metrics: { samples: 120, targetHitRate: 58, stopRate: 31, avgForwardReturn: 1.4 },
    conformalCalibration: {
      framework: "walk-forward-conformal",
      overall: { finalReturnAbsErrorP80: 2.6, finalReturnAbsErrorP90: 4.8 },
    },
  });
  assert.equal(factor.values.finalReturnP80Error, 2.6);
  assert.equal(factor.values.finalReturnP90Error, 4.8);
});

test("Provider key pools preserve primary-first failover order and remove duplicates", () => {
  const env = {
    TIINGO_API_KEY: "primary-key",
    TIINGO_API_KEYS: "backup-one, backup-two backup-one",
    TIINGO_API_KEY_BACKUP_1: "backup-three",
  };
  assert.deepEqual(providerApiKeys("tiingo", env), ["primary-key", "backup-one", "backup-two", "backup-three"]);
  assert.deepEqual(providerApiKeys("unknown", env), []);
  const status = providerKeyPoolStatus("tiingo");
  assert.equal(typeof status.keyCount, "number");
  assert.equal(status.failoverOnly, true);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "keys"), false);
});

test("Provider key pool advances in order only after quota-style failures", async () => {
  const attempts = [];
  const result = await withProviderApiKey("tiingo", {
    env: { TIINGO_API_KEY: "primary", TIINGO_API_KEYS: "backup-one,backup-two" },
    runtimeKey: "tiingo-unit-order",
    backoffKey: "tiingo-unit-order",
    keyBackoffMs: 1000,
    backoffMs: 1000,
  }, async (key) => {
    attempts.push(key);
    if (key !== "backup-two") throw new Error("HTTP 429: rate limit");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(attempts, ["primary", "backup-one", "backup-two"]);
});
