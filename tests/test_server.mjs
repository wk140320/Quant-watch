import assert from "node:assert/strict";
import test from "node:test";

process.env.SERVER_DISABLE_LISTEN = "true";

const {
  alpacaQuoteRows,
  alpacaRows,
  alpacaTradeRows,
  aiProviderStatus,
  analysisBatchLimit,
  factorSignal,
  isLimitedProvider,
  localBatchAnalysis,
  providerConfigured,
  redditCacheTtlForItem,
  redditProviderStatus,
  runPythonQuantCore,
  sanitizeResearchConfig,
  sanitizeUniverseRows,
  scoreRedditSocialPosts,
  fetchRedditSocialFactor,
  backendMarketSession,
  backendMonitorBudgetLimits,
  computeServerTechnicals,
  intradaySampleRows,
  sanitizeBackendMonitorConfig,
  trainIntradayLinearModel,
  stockAnalysisHistoryRows,
  tradeFootprintRows,
  tushareRows,
  universePayload,
} = await import("../server.mjs");

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
    const status = await redditProviderStatus("US");
    assert.equal(status.enabled, false);
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

test("Backend monitor config persists holdings at 5m and watchlist at 15m cadence", () => {
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
  assert.equal(config.refresh.holdingMs, 5 * 60 * 1000);
  assert.equal(config.refresh.watchMs, 15 * 60 * 1000);
  assert.ok(config.markets.ASX.watchlist.includes("CPU.AX"));
  assert.ok(config.markets.ASX.watchlist.includes("BHP.AX"));
  assert.ok(!config.markets.ASX.watchlist.includes("AAPL"));
  assert.equal(config.markets.US.portfolio[0].symbol, "AAPL");
  assert.equal(config.training.symbolLimit, 3);
});

test("Backend market session recognises regular market hours", () => {
  const asxOpen = backendMarketSession("ASX", new Date("2026-07-03T02:00:00Z"));
  const asxClosed = backendMarketSession("ASX", new Date("2026-07-03T08:00:00Z"));
  assert.equal(asxOpen.open, true);
  assert.equal(asxClosed.open, false);
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
  assert.ok(limits.marketCalls > limits.trainingMarketReserve);
  assert.ok(limits.trainingCalls > 0);
});
