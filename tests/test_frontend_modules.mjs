import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

await import("../frontend/domain/market.js");
await import("../frontend/charts/math.js");
await import("../frontend/runtime/http.js");
await import("../frontend/runtime/storage.js");

const market = globalThis.QuantMarket;
const chart = globalThis.QuantChartMath;
const http = globalThis.QuantHttp;
const storageRuntime = globalThis.QuantStorage;

test("Market domain normalizes native symbols and rejects known cross-market leakage", () => {
  assert.equal(market.normalizeSymbolForMarket("600519.SH", "CN"), "600519");
  assert.equal(market.normalizeSymbolForMarket("AAPL", "US"), "AAPL");
  assert.equal(market.normalizeSymbolForMarket("AAPL", "ASX"), "");
  assert.equal(market.normalizeSymbolForMarket("CBA", "US"), "");
  assert.equal(market.normalizeSymbolForMarket("BHP.AX", "ASX"), "BHP");
});

test("Market domain keeps watchlists isolated and deduplicated", () => {
  assert.deepEqual(
    market.normalizeWatchlistItemsForMarket(["AAPL", "AAPL", "CBA", "SPCX"], "US"),
    ["AAPL", "SPCX"],
  );
  assert.deepEqual(
    market.normalizeWatchlistItemsForMarket(["BHP", "NVDA", "CBA"], "ASX"),
    ["BHP", "CBA"],
  );
});

test("Market domain quarantines ASX snapshot symbols from the US watchlist", () => {
  const origins = { US: { BRG: "snapshot", SFR: "snapshot", AAPL: "default", CPU: "snapshot" } };
  assert.deepEqual(
    market.normalizeWatchlistItemsForMarket(["BRG", "SFR", "AAPL", "CPU"], "US", origins, "saved"),
    ["AAPL"],
  );
  assert.deepEqual(
    market.normalizeWatchlistItemsForMarket([{ symbol: "BRG", source: "manual" }], "US", origins, "saved"),
    ["BRG"],
  );
});

test("HTTP runtime produces stable local and provider error messages", () => {
  assert.match(http.normalizeApiErrorMessage("Failed to fetch", "/api/health", { network: true }), /8787/);
  assert.match(http.normalizeApiErrorMessage("The quota has been exceeded"), /额度已用尽/);
  assert.match(http.normalizeApiErrorMessage("Load failed"), /真实数据源请求失败/);
});

test("Storage runtime isolates invalid and oversized browser cache values", () => {
  const values = new Map();
  const target = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const storage = storageRuntime.createSafeStorage(target);
  assert.equal(storage.writeJson("valid", { market: "US" }), true);
  assert.deepEqual(storage.readJson("valid", {}), { market: "US" });
  storage.setItem("broken", "{bad");
  assert.deepEqual(storage.readJson("broken", { fallback: true }), { fallback: true });
  assert.equal(storage.getItem("broken"), null);
  storage.setItem("large", "x".repeat(20));
  assert.equal(storage.readJson("large", "fallback", { maxChars: 8 }), "fallback");
});

test("Chart math keeps technical series and coordinates finite", () => {
  assert.deepEqual(chart.sma([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);
  assert.ok(Math.abs(chart.ema([1, 2, 3], 2)[2] - 2.5555555556) < 1e-8);
  assert.deepEqual(chart.chartBounds([], 0.1), { min: -1, max: 1 });
  assert.equal(chart.xFor(1, 3, 100, 10, 10), 50);
  assert.equal(chart.yFor(50, 0, 100, 120, 10, 10), 60);
});

test("Chart overlays derive Bollinger and Fibonacci values without future rows", () => {
  const candles = [
    { open: 10, high: 11, low: 9, close: 10 },
    { open: 10, high: 13, low: 10, close: 12 },
    { open: 12, high: 14, low: 11, close: 13 },
  ];
  const bollinger = chart.bollingerChartSeries(candles, 2, 2);
  assert.equal(bollinger.middle.length, candles.length);
  assert.ok(bollinger.upper[2] > bollinger.middle[2]);
  const fibonacci = chart.fibonacciChartLevels(candles, 3);
  assert.equal(fibonacci.length, 5);
  assert.equal(fibonacci[0].direction, "upswing");
});

test("Homepage boot stays lightweight and defers the full workspace", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scriptSources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1].split("?")[0]);
  assert.ok(scriptSources.includes("/frontend/runtime/shell-bootstrap.js"));
  assert.ok(scriptSources.includes("/frontend/runtime/storage.js"));
  assert.ok(!scriptSources.includes("/app.js"));
  assert.ok(!scriptSources.includes("/frontend/charts/math.js"));
  assert.ok(!scriptSources.includes("/frontend/runtime/http.js"));
  assert.ok((html.match(/data-quant-page="dashboard"[^>]*hidden/g) || []).length >= 1);
  assert.match(html, /class="[^"]*ai-picker-board[^"]*" data-quant-page="regime" hidden/);
  assert.match(html, /class="[^"]*simulation-capital-summary[^"]*" data-quant-page="simulation" id="portfolioSummary" hidden/);
  const sizes = await Promise.all(scriptSources.map(async (source) => (
    (await stat(new URL(`..${source}`, import.meta.url))).size
  )));
  assert.ok(sizes.reduce((sum, value) => sum + value, 0) < 100_000);
});

test("Visual workspaces keep research layouts and local artwork available", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const visualCss = await readFile(new URL("../frontend/styles/visual-workspaces.css", import.meta.url), "utf8");
  assert.match(html, /frontend\/styles\/visual-workspaces\.css/);
  assert.match(html, /class="home-visual-gallery/);
  assert.match(visualCss, /workspace-market-texture-v1\.jpg/);
  assert.match(visualCss, /workspace-model-texture-v1\.jpg/);
  assert.match(visualCss, /"accuracy accuracy accuracy accuracy accuracy accuracy accuracy accuracy accuracy accuracy accuracy accuracy"/);
  assert.match(visualCss, /"feature-controls feature-controls feature-controls/);
  await Promise.all([
    stat(new URL("../assets/images/workspace-market-texture-v1.jpg", import.meta.url)),
    stat(new URL("../assets/images/workspace-model-texture-v1.jpg", import.meta.url)),
  ]);
});

test("Frontend refreshes strict quote overlays before byte-bounded model batches", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /\/api\/quotes\/batch/);
  assert.match(source, /function quoteOverlayTimestamp/);
  assert.match(source, /function analysisRequestChunks/);
  assert.match(source, /maxBytes \|\| 1_250_000/);
  assert.match(source, /applyStoredQuoteOverlays\(marketKey\)/);
});

test("Market selection and dense research views avoid cramped horizontal panels", async () => {
  const [html, shell, source, visualCss] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../frontend/runtime/shell-bootstrap.js", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/styles/quiet-gold-flow.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /aria-haspopup="menu"/);
  assert.equal((html.match(/data-market-select=/g) || []).length, 3);
  assert.match(shell, /setMarketMenuOpen/);
  assert.match(shell, /document\.body\.appendChild\(marketMenu\)/);
  assert.match(shell, /positionMarketMenu/);
  assert.match(source, /class="learning-tablist" role="tablist"/);
  assert.equal((source.match(/data-learning-panel=/g) || []).length, 3);
  assert.match(source, /<div class="chart-tools">[\s\S]*chart-overlay-popover[\s\S]*expandChart/);
  assert.match(visualCss, /\.learning-tab-panel[\s\S]*overflow-x: clip/);
  assert.match(visualCss, /\.chart-tools \.chart-overlay-popover/);
  assert.match(visualCss, /\.market-menu\s*\{[\s\S]*position: fixed/);
});

test("Workspace rendering skips hidden dashboards and defers secondary simulation work", async () => {
  const [html, source, runtime, performanceCss] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/runtime/ui-runtime.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/styles/performance.css", import.meta.url), "utf8"),
  ]);
  const bootSource = source.slice(source.indexOf("function boot()"), source.indexOf("boot();"));
  assert.match(source, /function mainRenderPartsForPage/);
  assert.match(source, /visibleParts\.has\("cards"\)/);
  assert.match(source, /deferWorkspaceStep\(next, workspaceToken, "加载风险评估"/);
  assert.doesNotMatch(bootSource, /safeUiStep\("渲染基础股票卡片", renderCards\)/);
  assert.doesNotMatch(bootSource, /safeUiStep\("渲染基础持仓概览", renderPortfolioSummary\)/);
  assert.match(runtime, /const clipped = itemRect\.left/);
  assert.match(html, /frontend\/styles\/performance\.css/);
  assert.match(performanceCss, /content-visibility: auto/);
});
