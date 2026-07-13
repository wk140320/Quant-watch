import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironment } from "./backend/config/env.mjs";
import {
  MARKET_CONFIG,
  TRAINING_UNIVERSES,
  assertValidMarketCode,
  cleanAsxCode,
  cleanCode,
  isValidMarketCode,
  normalizeAsxSymbol,
  normalizeMarketSymbol,
  safeMarket,
} from "./backend/domain/markets.mjs";
import { readJsonBody, sendJson } from "./backend/http/json.mjs";
import { serveStaticRequest } from "./backend/http/static-files.mjs";
import {
  fetchJson,
  fetchJsonPost,
  fetchJsonWithCurl,
  fetchText,
} from "./backend/providers/http.mjs";
import { createTushareAdapter } from "./backend/providers/cn/tushare.mjs";
import { createAlpacaAdapter } from "./backend/providers/us/alpaca.mjs";
import { createPythonQuantClient } from "./backend/services/python-quant.mjs";
import { createRuntimeEventHub } from "./backend/services/runtime-events.mjs";
import { createJobManager } from "./backend/services/job-manager.mjs";
import { loadModelTrajectories } from "./backend/services/model-trajectories.mjs";

const root = new URL(".", import.meta.url).pathname;
const DEFAULT_REDDIT_ENV_PATH = "/Users/wukai/Documents/9900/client-base-eclair/.env";
const envLoadSources = loadEnvironment({ root, defaultRedditEnvPath: DEFAULT_REDDIT_ENV_PATH });
const runPythonQuantCore = createPythonQuantClient({ root });
const { alpacaQuoteRows, alpacaRows, alpacaTradeRows } = createAlpacaAdapter({
  sanitizeCandleRows,
  isIntradayInterval,
});
const { tushareRows } = createTushareAdapter({ sanitizeCandleRows });

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const APP_VERSION = "2026-07-13-live-quote-training-density-v46";
const SERVER_STARTED_AT = new Date().toISOString();
const providerBackoff = new Map();
const providerKeyRuntime = new Map();
const PROVIDER_KEY_ENV = Object.freeze({
  eodhd: { primary: "EODHD_API_KEY", pool: "EODHD_API_KEYS" },
  twelvedata: { primary: "TWELVEDATA_API_KEY", pool: "TWELVEDATA_API_KEYS" },
  tiingo: { primary: "TIINGO_API_KEY", pool: "TIINGO_API_KEYS" },
});
const marketResponseCache = new Map();
const marketCandlesCache = new Map();
const quoteResponseCache = new Map();
const factorResponseCache = new Map();
const historicalBacktestCache = new Map();
const newsResponseCache = new Map();
const macroResponseCache = new Map();
const universeResponseCache = new Map();
const secFilingsCache = new Map();
const localModelTrainingCache = new Map();
const redditCacheSummaryMemory = new Map();
const snapshotBasePath = join(root, ".cache");
const backendMonitorBasePath = join(snapshotBasePath, "backend-monitor");
const backendMonitorConfigPath = join(backendMonitorBasePath, "config.json");
const backendMonitorRuntimePath = join(backendMonitorBasePath, "runtime.json");
const backendMonitorAlertPath = join(backendMonitorBasePath, "alerts.jsonl");
const backendMonitorRunRequestPath = join(backendMonitorBasePath, "manual-run-request.json");
const runtimeEvents = createRuntimeEventHub({ historyLimit: 240 });
const backgroundJobs = createJobManager({
  basePath: join(snapshotBasePath, "background-jobs"),
  publish: (type, payload) => runtimeEvents.publish(type, payload),
});
let backendMonitorTimer = null;
let backendEnrichmentTimer = null;
let backendMonitorTickRunning = false;
const backendMonitorState = {
  enabled: false,
  running: false,
  startedAt: null,
  lastTickAt: null,
  lastRunAt: null,
  lastTrainingAt: null,
  lastError: null,
  lastAlerts: [],
  lastAnalyses: [],
  lastQuotes: [],
  lastTraining: null,
};
const NEWS_DISK_CACHE_TTL_MS = Number(process.env.NEWS_DISK_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const NEWS_DISK_CACHE_CLEANUP_MS = Number(process.env.NEWS_DISK_CACHE_CLEANUP_MS || 7 * 24 * 60 * 60 * 1000);
let lastNewsDiskCleanupAt = 0;
let alphaVantageNextRequestAt = 0;

async function readServerSnapshot() {
  try {
    return sanitizeSnapshot(JSON.parse(await readFile(snapshotPathForMarket("ASX"), "utf8")), "ASX");
  } catch {
    return null;
  }
}

async function writeServerSnapshot(payload) {
  const snapshot = sanitizeSnapshot(payload, payload?.market);
  if (!snapshot) throw new Error("Snapshot has no usable real analysis rows.");
  await mkdir(snapshotBasePath, { recursive: true });
  await writeFile(snapshotPathForMarket(snapshot.market), JSON.stringify(snapshot), "utf8");
}

function compactWorkspaceSnapshot(snapshot = null) {
  if (!snapshot) return null;
  const analyses = Array.isArray(snapshot.analyses) ? snapshot.analyses : [];
  return {
    market: snapshot.market,
    updatedAt: snapshot.updatedAt || snapshot.savedAt || null,
    savedAt: snapshot.savedAt || null,
    reason: snapshot.reason || "local-snapshot",
    watchlist: Array.isArray(snapshot.watchlist) ? snapshot.watchlist : [],
    portfolio: Array.isArray(snapshot.portfolio) ? snapshot.portfolio : [],
    selected: snapshot.selected || null,
    analysisCount: analyses.length,
    analyses: analyses.slice(0, 80).map((row) => ({
      symbol: row.symbol,
      market: row.market,
      analysisAsOf: row.analysisAsOf || row.signalRefreshedAt || row.updatedAt || row.quote?.asOf || snapshot.updatedAt || snapshot.savedAt || null,
      analysisPrice: Number(row.analysisPrice || row.technicals?.close || 0) || null,
      technicals: row.technicals ? {
        close: row.technicals.close,
        change5d: row.technicals.change5d,
        trendScore: row.technicals.trendScore,
        volumeRatio: row.technicals.volumeRatio,
      } : null,
      analysis: row.analysis ? {
        action: row.analysis.action,
        confidence: row.analysis.confidence,
        projectedFinalReturn: row.analysis.projectedFinalReturn ?? row.analysis.projectedUpside,
        strategyHitProbability: row.analysis.strategyHitProbability,
        downsideConfidence: row.analysis.downsideConfidence,
      } : null,
      marketSource: row.marketSource || null,
    })),
    compact: true,
  };
}

function snapshotSymbolsForMarketOverlay(snapshot = null, market = "ASX") {
  const key = safeMarket(market || snapshot?.market);
  return [...new Set([
    ...(snapshot?.watchlist || []),
    ...(snapshot?.portfolio || []).map((row) => row?.symbol),
    ...(snapshot?.analyses || []).map((row) => row?.symbol),
  ].map((symbol) => normalizeMarketSymbol(symbol, key) || cleanCode(symbol, key)).filter(Boolean))];
}

function snapshotPathForMarket(market) {
  const key = safeMarket(market);
  return join(snapshotBasePath, key === "ASX" ? "analysis-snapshot.json" : `analysis-snapshot-${key.toLowerCase()}.json`);
}

function predictionSamplesPathForMarket(market) {
  return join(snapshotBasePath, `prediction-samples-${safeMarket(market).toLowerCase()}.json`);
}

function safeCachePart(value) {
  return String(value || "unknown").toUpperCase().replace(/[^A-Z0-9._-]+/g, "_").slice(0, 80);
}

function newsLiveCacheTtlMs() {
  return Number(process.env.NEWS_CACHE_TTL_MS || 10 * 60 * 1000);
}

function newsDiskCachePathFor(market, scope, symbol) {
  const key = safeMarket(market);
  const safeScope = ["macro", "stock", "all"].includes(String(scope || "").toLowerCase())
    ? String(scope || "").toLowerCase()
    : "all";
  const subject = safeScope === "macro" ? "MARKET" : symbol;
  return join(snapshotBasePath, "news", key.toLowerCase(), `${safeCachePart(safeScope)}-${safeCachePart(subject)}.json`);
}

function marketDateTimeParts(market = "ASX", date = new Date()) {
  const timeZone = {
    ASX: "Australia/Sydney",
    US: "America/New_York",
    CN: "Asia/Shanghai",
  }[safeMarket(market)] || "Australia/Sydney";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    timeZone,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
    minuteOfDay: Number(parts.hour || 0) * 60 + Number(parts.minute || 0),
  };
}

function newsRefreshSlotsForMarket(market = "ASX") {
  const key = safeMarket(market);
  if (key === "CN") {
    return [
      { id: "preopen", label: "开盘前 1 小时", minute: 8 * 60 + 30 },
      { id: "midday", label: "午间开盘前", minute: 13 * 60 },
      { id: "preclose", label: "收盘前 30 分钟", minute: 14 * 60 + 30 },
    ];
  }
  if (key === "US") {
    return [
      { id: "preopen", label: "开盘前 1 小时", minute: 8 * 60 + 30 },
      { id: "preclose", label: "收盘前 30 分钟", minute: 15 * 60 + 30 },
    ];
  }
  return [
    { id: "preopen", label: "开盘前 1 小时", minute: 9 * 60 },
    { id: "preclose", label: "收盘前 30 分钟", minute: 15 * 60 + 30 },
  ];
}

function newsRefreshDecision(market = "ASX", cachedAt = null) {
  const key = safeMarket(market);
  const now = marketDateTimeParts(key);
  const cached = cachedAt ? marketDateTimeParts(key, new Date(cachedAt)) : null;
  const slots = newsRefreshSlotsForMarket(key);
  const isWeekday = !["Sat", "Sun"].includes(now.weekday);
  const dueSlots = isWeekday ? slots.filter((slot) => {
    if (now.minuteOfDay < slot.minute) return false;
    if (!cached?.dateKey || cached.dateKey < now.dateKey) return true;
    if (cached.dateKey > now.dateKey) return false;
    return cached.minuteOfDay < slot.minute;
  }) : [];
  const next = slots.find((slot) => slot.minute > now.minuteOfDay) || null;
  return {
    market: key,
    localDate: now.dateKey,
    localMinute: now.minuteOfDay,
    timeZone: now.timeZone,
    cachedAt: cachedAt || null,
    due: dueSlots.length > 0,
    dueSlots,
    nextSlot: next,
    schedule: slots,
    reason: dueSlots.length
      ? `missed ${dueSlots.map((slot) => slot.label).join(" / ")} news refresh window`
      : cachedAt
        ? "local news cache is current for scheduled refresh windows"
        : "no local news cache exists",
  };
}

async function readNewsDiskCache(market, scope, symbol) {
  try {
    const path = newsDiskCachePathFor(market, scope, symbol);
    const payload = JSON.parse(await readFile(path, "utf8"));
    const cachedAtMs = Date.parse(payload.cachedAt || payload.value?.cachedAt || "");
    if (!Number.isFinite(cachedAtMs) || Date.now() - cachedAtMs > NEWS_DISK_CACHE_TTL_MS) {
      await unlink(path).catch(() => {});
      return null;
    }
    const value = payload.value || payload;
    if (!Array.isArray(value.news)) return null;
    return {
      value: {
        ...value,
        cache: "disk",
        cachedAt: payload.cachedAt || value.cachedAt,
        refreshDecision: newsRefreshDecision(market, payload.cachedAt || value.cachedAt),
      },
      cachedAtMs,
      ageMs: Date.now() - cachedAtMs,
    };
  } catch {
    return null;
  }
}

async function newsDiskCacheSummary(market = "ASX") {
  const key = safeMarket(market);
  const dir = join(snapshotBasePath, "news", key.toLowerCase());
  const rows = [];
  try {
    const files = await readdir(dir, { withFileTypes: true });
    await Promise.all(files
      .filter((file) => file.isFile() && file.name.endsWith(".json"))
      .map(async (file) => {
        const path = join(dir, file.name);
        try {
          const payload = JSON.parse(await readFile(path, "utf8"));
          const value = payload.value || payload;
          const cachedAt = payload.cachedAt || value.cachedAt || null;
          const ageMs = Date.now() - (Date.parse(cachedAt || "") || 0);
          rows.push({
            file: file.name,
            market: key,
            scope: value.scope || payload.scope || file.name.split("-")[0]?.toLowerCase() || "all",
            symbol: value.symbol || payload.symbol || "",
            cachedAt,
            ageMs: Number.isFinite(ageMs) ? ageMs : null,
            newsCount: Array.isArray(value.news) ? value.news.length : 0,
            cache: value.cache || payload.cache || "disk",
            source: value.source || "unknown",
            refreshDecision: newsRefreshDecision(key, cachedAt),
          });
        } catch {
          rows.push({ file: file.name, market: key, invalid: true });
        }
      }));
  } catch {
    return {
      market: key,
      available: false,
      rows: [],
      summary: { totalFiles: 0, newsCount: 0, latestCachedAt: null, dueCount: 0 },
    };
  }
  rows.sort((a, b) => String(b.cachedAt || "").localeCompare(String(a.cachedAt || "")));
  return {
    market: key,
    available: rows.length > 0,
    rows: rows.slice(0, 80),
    summary: {
      totalFiles: rows.length,
      newsCount: rows.reduce((sum, row) => sum + Number(row.newsCount || 0), 0),
      latestCachedAt: rows[0]?.cachedAt || null,
      dueCount: rows.filter((row) => row.refreshDecision?.due).length,
      schedule: newsRefreshSlotsForMarket(key),
    },
  };
}

async function writeNewsDiskCache(market, scope, symbol, value) {
  if (!Array.isArray(value?.news)) return;
  const key = safeMarket(market);
  const dir = join(snapshotBasePath, "news", key.toLowerCase());
  const cachedAt = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(newsDiskCachePathFor(key, scope, symbol), JSON.stringify({
    cachedAt,
    market: key,
    scope,
    symbol,
    value: {
      ...value,
      cache: "live",
      cachedAt,
      market: key,
      scope,
      symbol,
    },
  }, null, 2), "utf8");
}

async function cleanupNewsDiskCache(force = false) {
  const now = Date.now();
  if (!force && now - lastNewsDiskCleanupAt < NEWS_DISK_CACHE_CLEANUP_MS) return { checked: 0, removed: 0 };
  lastNewsDiskCleanupAt = now;
  const base = join(snapshotBasePath, "news");
  let checked = 0;
  let removed = 0;
  try {
    const marketDirs = await readdir(base, { withFileTypes: true });
    for (const marketDir of marketDirs) {
      if (!marketDir.isDirectory()) continue;
      const dir = join(base, marketDir.name);
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      await Promise.all(files
        .filter((file) => file.isFile() && file.name.endsWith(".json"))
        .map(async (file) => {
          checked += 1;
          const path = join(dir, file.name);
          try {
            const payload = JSON.parse(await readFile(path, "utf8"));
            const cachedAtMs = Date.parse(payload.cachedAt || payload.value?.cachedAt || "");
            if (!Number.isFinite(cachedAtMs) || now - cachedAtMs > NEWS_DISK_CACHE_TTL_MS) {
              await unlink(path);
              removed += 1;
            }
          } catch {
            await unlink(path).catch(() => {});
            removed += 1;
          }
        }));
    }
  } catch {
    return { checked, removed };
  }
  return { checked, removed };
}

const DEFAULT_REDDIT_PACKAGE_PATH = "/Users/wukai/Documents/9900/client-base-eclair/packages/reddit-data-access";
const REDDIT_CACHE_HIGH_MS = 3 * 24 * 60 * 60 * 1000;
const REDDIT_CACHE_MEDIUM_MS = 24 * 60 * 60 * 1000;
const REDDIT_CACHE_LOW_MS = 12 * 60 * 60 * 1000;
const REDDIT_MARKET_POOL_MEMORY_TTL_MS = 10 * 60 * 1000;
const redditResponseCache = new Map();
const redditMarketPoolCache = new Map();
const redditBackgroundQueue = [];
const redditBackgroundQueued = new Set();
const redditBackgroundState = {
  running: false,
  active: null,
  processed: 0,
  failed: 0,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: "",
};

const REDDIT_SUBREDDIT_SUBSCRIBER_PROXY = {
  wallstreetbets: 18000000,
  investing: 3500000,
  stocks: 7000000,
  StockMarket: 3000000,
  SecurityAnalysis: 300000,
  ValueInvesting: 250000,
  options: 1200000,
  finance: 2500000,
  AusFinance: 700000,
  ASX_Bets: 120000,
  AusStocks: 45000,
  fiaustralia: 250000,
  Australia: 1200000,
  ChinaStocks: 50000,
  China: 700000,
  CryptoCurrency: 9000000,
  technology: 17000000,
  economics: 450000,
};

function redditPackagePath() {
  return process.env.REDDIT_PACKAGE_PATH || DEFAULT_REDDIT_PACKAGE_PATH;
}

function redditPackageSrcPath() {
  return join(redditPackagePath(), "src");
}

function redditPythonBin() {
  const configured = process.env.REDDIT_PYTHON_BIN;
  if (configured) return configured;
  const packagePython = join(redditPackagePath(), ".venv", "bin", "python");
  if (existsSync(packagePython)) return packagePython;
  const localPython = join(root, ".venv", "bin", "python");
  return process.env.PYTHON_BIN || (existsSync(localPython) ? localPython : "python3");
}

function redditEnabled() {
  return String(process.env.REDDIT_ENABLED || "true").toLowerCase() !== "false";
}

function redditProviderConfigured() {
  return Boolean(
    redditEnabled()
    && process.env.REDDIT_CLIENT_ID
    && process.env.REDDIT_CLIENT_SECRET
    && process.env.REDDIT_USER_AGENT
    && existsSync(redditPackageSrcPath())
  );
}

function redditStatusBase() {
  const packagePath = redditPackagePath();
  const packageSrcPath = redditPackageSrcPath();
  const envPath = process.env.REDDIT_ENV_PATH || DEFAULT_REDDIT_ENV_PATH;
  const redditEnvKeys = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"];
  const redditSources = redditEnvKeys.map((key) => envLoadSources.get(key)).filter(Boolean);
  const projectEnvPaths = new Set([join(root, ".env.local"), join(root, ".env")]);
  const envSource = redditSources.length === 0
    ? "process-env"
    : redditSources.every((source) => projectEnvPaths.has(source))
      ? "current-project-env"
      : redditSources.every((source) => source === envPath)
        ? "reddit-env-path"
        : "mixed-env";
  const missing = [
    !process.env.REDDIT_CLIENT_ID ? "REDDIT_CLIENT_ID" : null,
    !process.env.REDDIT_CLIENT_SECRET ? "REDDIT_CLIENT_SECRET" : null,
    !process.env.REDDIT_USER_AGENT ? "REDDIT_USER_AGENT" : null,
    !existsSync(packageSrcPath) ? "reddit-data-access package src" : null,
  ].filter(Boolean);
  return {
    name: "reddit",
    configured: redditProviderConfigured(),
    enabled: redditEnabled(),
    packagePath,
    packageSrcPath,
    packageAvailable: existsSync(packageSrcPath),
    envSource,
    envPathConfigured: Boolean(process.env.REDDIT_ENV_PATH || existsSync(DEFAULT_REDDIT_ENV_PATH)),
    refreshMs: Number(process.env.REDDIT_REFRESH_MS || 60 * 60 * 1000),
    missing,
  };
}

function redditCachePath(market, symbol) {
  const key = safeMarket(market);
  return join(snapshotBasePath, "social", "reddit", key.toLowerCase(), `${safeCachePart(cleanCode(symbol, key))}.json`);
}

function redditMarketPoolPath(market) {
  return join(snapshotBasePath, "social", "reddit", safeMarket(market).toLowerCase(), "_market-pool.json");
}

async function readRedditMarketPoolCache(market, maxAgeMs = Number(process.env.REDDIT_REFRESH_MS || 60 * 60 * 1000)) {
  const key = safeMarket(market);
  const memory = redditMarketPoolCache.get(key);
  if (memory && Date.now() - memory.time < Math.min(maxAgeMs, REDDIT_MARKET_POOL_MEMORY_TTL_MS)) return memory.value;
  try {
    const payload = JSON.parse(await readFile(redditMarketPoolPath(key), "utf8"));
    const cachedAt = Date.parse(payload.cachedAt || payload.cache?.cachedAt || "");
    if (!cachedAt || Date.now() - cachedAt > maxAgeMs) return null;
    const value = {
      ...payload,
      posts: Array.isArray(payload.posts) ? payload.posts.slice(0, 500) : [],
      cache: {
        ...(payload.cache || {}),
        cache: "market-pool-disk",
        cachedAt: payload.cachedAt || payload.cache?.cachedAt || null,
        ageMs: Date.now() - cachedAt,
      },
    };
    redditMarketPoolCache.set(key, { time: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

async function writeRedditMarketPoolCache(market, value = {}) {
  const key = safeMarket(market);
  const dir = join(snapshotBasePath, "social", "reddit", key.toLowerCase());
  await mkdir(dir, { recursive: true });
  const cachedAt = new Date().toISOString();
  const posts = Array.isArray(value.posts) ? value.posts.map(normalizeRedditPost).filter((post) => post.id && post.title).slice(0, 500) : [];
  const payload = {
    market: key,
    source: value.source || "reddit-market-pool",
    cachedAt,
    posts,
    queries: value.queries || {},
    errors: Array.isArray(value.errors) ? value.errors.slice(0, 40) : [],
    cache: {
      ...(value.cache || {}),
      cache: "market-pool-live",
      cachedAt,
    },
  };
  await writeFile(redditMarketPoolPath(key), JSON.stringify(payload, null, 2), "utf8");
  redditMarketPoolCache.set(key, { time: Date.now(), value: payload });
  return payload;
}

async function readRedditCache(market, symbol) {
  try {
    const payload = JSON.parse(await readFile(redditCachePath(market, symbol), "utf8"));
    const now = Date.now();
    const items = Array.isArray(payload.items)
      ? payload.items.filter((item) => {
        const retainUntil = Date.parse(item.retainUntil || "");
        return !Number.isFinite(retainUntil) || retainUntil >= now;
      })
      : [];
    const visibleLimit = Math.max(10, Math.min(80, Number(process.env.REDDIT_API_ITEMS_LIMIT || 20)));
    const visibleItems = items.slice(0, visibleLimit).map(compactRedditItemForApi);
    return {
      ...payload,
      itemCount: items.length,
      items: visibleItems,
      topItems: visibleItems.slice(0, 10),
      cache: {
        ...(payload.cache || {}),
        cache: "disk",
        cachedAt: payload.cachedAt || payload.cache?.cachedAt || null,
        ageMs: now - (Date.parse(payload.cachedAt || payload.cache?.cachedAt || "") || now),
      },
    };
  } catch {
    return null;
  }
}

async function writeRedditCache(market, symbol, value) {
  const key = safeMarket(market);
  const dir = join(snapshotBasePath, "social", "reddit", key.toLowerCase());
  await mkdir(dir, { recursive: true });
  const cachedAt = new Date().toISOString();
  const payload = {
    ...value,
    market: key,
    symbol: cleanCode(symbol, key),
    cachedAt,
    cache: {
      ...(value.cache || {}),
      cache: "live",
      cachedAt,
    },
  };
  await writeFile(redditCachePath(key, symbol), JSON.stringify(payload, null, 2), "utf8");
  redditCacheSummaryMemory.clear();
  return payload;
}

async function deleteRedditCache(market, symbol) {
  await unlink(redditCachePath(market, symbol)).catch(() => {});
  redditCacheSummaryMemory.clear();
  return { ok: true, market: safeMarket(market), symbol: cleanCode(symbol, market) };
}

async function redditCacheSummary(market = null, options = {}) {
  const cacheKey = market ? safeMarket(market) : "ALL";
  const cached = redditCacheSummaryMemory.get(cacheKey);
  const ttlMs = Math.max(5_000, Number(process.env.REDDIT_STATUS_CACHE_MS || 60_000));
  if (!options.force && cached && Date.now() - cached.savedAt < ttlMs) return cached.value;
  const base = join(snapshotBasePath, "social", "reddit");
  const rows = [];
  const markets = market ? [safeMarket(market).toLowerCase()] : Object.keys(MARKET_CONFIG).map((key) => key.toLowerCase());
  await Promise.all(markets.map(async (marketDir) => {
    const dir = join(base, marketDir);
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith(".json")).map(async (file) => {
      if (file.name === "_market-pool.json") return;
      try {
        const payload = JSON.parse(await readFile(join(dir, file.name), "utf8"));
        rows.push({
          market: String(payload.market || marketDir).toUpperCase(),
          symbol: payload.symbol || file.name.replace(/\.json$/i, ""),
          cachedAt: payload.cachedAt || payload.cache?.cachedAt || null,
          count: Array.isArray(payload.items) ? payload.items.length : 0,
          topCount: Array.isArray(payload.topItems) ? payload.topItems.length : 0,
          source: payload.source || "reddit-social",
          lastError: payload.warning || "",
        });
      } catch {
        rows.push({ market: marketDir.toUpperCase(), file: file.name, invalid: true });
      }
    }));
  }));
  rows.sort((a, b) => String(b.cachedAt || "").localeCompare(String(a.cachedAt || "")));
  const value = {
    available: rows.length > 0,
    rows: rows.slice(0, 80),
    summary: {
      totalFiles: rows.length,
      itemCount: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
      latestCachedAt: rows[0]?.cachedAt || null,
    },
  };
  redditCacheSummaryMemory.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

async function redditProviderStatus(market = null, options = {}) {
  const status = redditStatusBase();
  const cache = await redditCacheSummary(market).catch(() => ({ rows: [], summary: { totalFiles: 0, itemCount: 0, latestCachedAt: null } }));
  return {
    ...status,
    cacheCount: cache.summary?.totalFiles || 0,
    itemCount: cache.summary?.itemCount || 0,
    lastCachedAt: cache.summary?.latestCachedAt || null,
    cache: options.compact ? { available: cache.available, summary: cache.summary } : cache,
    background: redditBackgroundStatus(),
  };
}

function redditSubredditsForMarket(market = "ASX") {
  const envKey = `REDDIT_SUBREDDITS_${safeMarket(market)}`;
  const configured = process.env[envKey] || process.env.REDDIT_SUBREDDITS;
  if (configured) return configured.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 12);
  if (safeMarket(market) === "US") return ["stocks", "investing", "wallstreetbets", "StockMarket", "SecurityAnalysis", "ValueInvesting"];
  if (safeMarket(market) === "CN") return ["stocks", "investing", "ChinaStocks", "China", "economics", "technology"];
  return ["AusFinance", "ASX_Bets", "AusStocks", "fiaustralia", "stocks", "investing"];
}

function redditPoolKeywordsForMarket(market = "ASX", symbols = []) {
  const key = safeMarket(market);
  const base = {
    ASX: [
      "ASX shares",
      "Australia stock market",
      "RBA rates",
      "iron ore",
      "China steel demand",
      "lithium miners",
      "LNG prices",
      "Australian banks",
      "commodity prices",
      "AUD USD",
    ],
    US: [
      "US stock market",
      "Federal Reserve rates",
      "S&P 500",
      "Nasdaq stocks",
      "AI semiconductors",
      "earnings guidance",
      "Treasury yields",
      "oil prices",
      "tariffs",
      "geopolitics stocks",
    ],
    CN: [
      "China A shares",
      "Shanghai Composite",
      "China stimulus",
      "PBOC rates",
      "property market China",
      "EV batteries China",
      "semiconductors China",
      "consumer stocks China",
      "US China tariffs",
      "RMB exchange rate",
    ],
  }[key] || [];
  const symbolTerms = (Array.isArray(symbols) ? symbols : [])
    .flatMap((symbol) => redditKeywordsForSymbol(symbol, key).slice(0, 5));
  const maxKeywords = Math.max(6, Math.min(30, Number(process.env.REDDIT_POOL_KEYWORDS_MAX || 18)));
  return [...new Set([...symbolTerms, ...base]
    .map((item) => String(item || "").replace(/["()]/g, "").trim())
    .filter((item) => item.length >= 2))]
    .slice(0, maxKeywords);
}

function redditKeywordsForSymbol(symbol, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const context = sectorContext(code, key);
  const aliases = {
    ASX: {
      BHP: "BHP Group iron ore copper mining",
      CBA: "Commonwealth Bank Australia mortgage RBA",
      NAB: "National Australia Bank mortgage RBA",
      WBC: "Westpac bank mortgage RBA",
      ANZ: "ANZ bank mortgage RBA",
      RIO: "Rio Tinto iron ore copper mining",
      FMG: "Fortescue iron ore green hydrogen",
      WDS: "Woodside Energy LNG oil gas",
      TLS: "Telstra telecom Australia",
      WOW: "Woolworths Australia supermarket",
      COL: "Coles Australia supermarket",
    },
    US: {
      NVDA: "Nvidia AI GPU data center Jensen Huang",
      AAPL: "Apple iPhone services China sales",
      MSFT: "Microsoft Azure OpenAI cloud",
      TSLA: "Tesla EV robotaxi Elon Musk",
      AMZN: "Amazon AWS ecommerce cloud",
      GOOGL: "Google Alphabet search ads Gemini AI",
      META: "Meta Facebook Instagram AI ads",
      AMD: "AMD AI GPU data center",
      JPM: "JPMorgan bank Jamie Dimon rates",
      XOM: "Exxon oil gas energy",
    },
    CN: {
      "600519": "Kweichow Moutai baijiu China consumption",
      "000858": "Wuliangye baijiu China consumption",
      "300750": "CATL battery EV lithium",
      "002594": "BYD EV battery China auto",
      "000001": "Ping An Bank China bank LPR",
      "601318": "Ping An Insurance China insurer",
    },
  }[key] || {};
  const bareCode = cleanAsxCode(code);
  const raw = [
    code,
    bareCode,
    `${code} stock`,
    `${bareCode} stock`,
    aliases[code] || aliases[bareCode],
    context.sector,
    context.peers,
    context.upstream,
    context.macro,
    MARKET_CONFIG[key].newsName,
  ];
  return [...new Set(raw
    .flatMap((item) => String(item || "").split(/\s+OR\s+/i))
    .map((item) => item.replace(/["()]/g, "").trim())
    .filter((item) => item.length >= 2)
    .slice(0, 14))];
}

function runRedditPython(payload, timeoutMs = Number(process.env.REDDIT_TIMEOUT_MS || 6500)) {
  return new Promise((resolve, reject) => {
    const python = redditPythonBin();
    const packageSrc = redditPackageSrcPath();
    const script = `
import asyncio, json, os, sys
payload = json.loads(sys.stdin.read() or "{}")
package_src = payload.get("packageSrc")
if package_src and package_src not in sys.path:
    sys.path.insert(0, package_src)
from reddit_data_access import RedditReadClient

async def main():
    async with RedditReadClient() as client:
        fetch_mode = payload.get("fetchMode") or "batch"
        if fetch_mode == "pool":
            subreddits = (payload.get("subreddits") or [])[:8]
            keywords = (payload.get("keywords") or [])[:int(payload.get("maxKeywords") or 18)]
            posts_per_source = max(1, min(25, int(payload.get("postsPerSubreddit") or 8)))
            tasks = []

            async def guarded(kind, label, coro):
                try:
                    return {"ok": True, "kind": kind, "label": label, "payload": await coro}
                except Exception as exc:
                    return {"ok": False, "kind": kind, "label": label, "error": str(exc)}

            for subreddit in subreddits:
                tasks.append(guarded("subreddit-hot", subreddit, client.get_subreddit_posts(
                    subreddit,
                    sort="hot",
                    limit=posts_per_source,
                    timeframe="day",
                )))
            for keyword in keywords:
                tasks.append(guarded("search", keyword, client.search_posts(
                    keyword,
                    subreddit="all",
                    sort="new",
                    limit=max(2, min(12, posts_per_source)),
                    timeframe="week",
                )))

            results = await asyncio.gather(*tasks)
            posts = []
            errors = []
            seen = set()
            for item in results:
                if not item.get("ok"):
                    errors.append({"kind": item.get("kind"), "label": item.get("label"), "error": item.get("error")})
                    continue
                for post in (item.get("payload") or {}).get("posts") or []:
                    post_id = str(post.get("id") or post.get("permalink") or post.get("title") or "")
                    if post_id and post_id in seen:
                        continue
                    if post_id:
                        seen.add(post_id)
                    post["source_query"] = item.get("label")
                    post["source_kind"] = item.get("kind")
                    posts.append(post)
            result = {
                "success": True,
                "function": "MARKET_POOL",
                "count": len(posts),
                "subreddits": subreddits,
                "keywords": keywords,
                "posts_per_source": posts_per_source,
                "errors": errors,
                "posts": posts,
            }
        else:
            result = await client.get_multiple_posts(
                subreddits=payload.get("subreddits") or [],
                keywords=payload.get("keywords") or [],
                posts_per_subreddit=int(payload.get("postsPerSubreddit") or 5),
            )
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))

asyncio.run(main())
`;
    const child = spawn(python, ["-c", script], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: [packageSrc, process.env.PYTHONPATH].filter(Boolean).join(":"),
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Reddit data access timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) {
        child.kill("SIGKILL");
        finish(new Error("Reddit data access response exceeded the size limit."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(new Error(`Unable to start Reddit data access: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim().split(/\n/).at(-1) || "{}");
      } catch {
        finish(new Error(`Reddit data access returned invalid JSON. ${stderr.slice(-600)}`));
        return;
      }
      if (code !== 0 || parsed.ok !== true) {
        finish(new Error(parsed.error || stderr.slice(-600) || `Reddit data access exited with code ${code}.`));
        return;
      }
      finish(null, parsed.result);
    });
    child.stdin.end(JSON.stringify({ ...payload, packageSrc }));
  });
}

async function fetchRedditMarketPool(market = "ASX", options = {}) {
  const key = safeMarket(market);
  const refreshMs = Number(process.env.REDDIT_REFRESH_MS || 60 * 60 * 1000);
  if (!options.force) {
    const cached = await readRedditMarketPoolCache(key, refreshMs);
    if (cached?.posts?.length) return cached;
  }
  const subreddits = redditSubredditsForMarket(key);
  const symbols = Array.isArray(options.symbols) ? options.symbols : [];
  const keywords = redditPoolKeywordsForMarket(key, symbols);
  const raw = await runRedditPython({
    fetchMode: "pool",
    market: key,
    subreddits,
    keywords,
    maxKeywords: Math.max(6, Math.min(30, Number(process.env.REDDIT_POOL_KEYWORDS_MAX || 18))),
    postsPerSubreddit: Math.max(3, Math.min(25, Number(options.postsPerSubreddit || process.env.REDDIT_POOL_POSTS_PER_SOURCE || 8))),
    background: true,
  }, Number(options.timeoutMs || process.env.REDDIT_BACKGROUND_TIMEOUT_MS || 20000));
  return writeRedditMarketPoolCache(key, {
    source: "reddit-market-pool",
    posts: raw.posts || [],
    queries: { subreddits, keywords },
    errors: raw.errors || [],
    cache: { refreshMs },
  });
}

function truncateRedditText(value, maxLength = 1600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function redditPostText(post = {}) {
  return truncateRedditText(`${post.title || ""} ${post.content || ""}`, 2200);
}

function normalizeRedditPost(post = {}) {
  const permalink = post.permalink
    ? String(post.permalink).startsWith("http")
      ? post.permalink
      : `https://www.reddit.com${post.permalink}`
    : "";
  return {
    id: String(post.id || post.name || ""),
    title: truncateRedditText(post.title || "", 260),
    content: truncateRedditText(post.content || post.selftext || "", 1600),
    author: String(post.author || "[unknown]"),
    subreddit: String(post.subreddit || "").replace(/^r\//i, ""),
    created_utc: Number(post.created_utc || 0),
    score: Number(post.score || 0),
    upvote_ratio: Number(post.upvote_ratio ?? 0.7),
    num_comments: Number(post.num_comments || 0),
    url: post.url || permalink,
    permalink,
    is_self: Boolean(post.is_self),
    over_18: Boolean(post.over_18),
    source_query: String(post.source_query || post.query || "").slice(0, 160),
    source_kind: String(post.source_kind || "").slice(0, 60),
  };
}

function compactRedditItemForApi(item = {}) {
  return {
    ...item,
    title: truncateRedditText(item.title || "", 220),
    content: truncateRedditText(item.content || "", 900),
    text: truncateRedditText(item.text || redditPostText(item), 1100),
  };
}

function redditSentimentScore(text) {
  const raw = String(text || "").toLowerCase();
  const positives = ["beat", "upgrade", "record", "buyback", "guidance raise", "demand", "growth", "approval", "partnership", "contract", "undervalued", "bullish", "surge", "rally", "利润增长", "订单", "回购", "增持"];
  const negatives = ["downgrade", "miss", "lawsuit", "investigation", "dilution", "offering", "default", "fraud", "ban", "recession", "bearish", "crash", "plunge", "scam", "亏损", "减持", "处罚", "暴跌"];
  let score = 0;
  positives.forEach((term) => { if (raw.includes(term)) score += 1; });
  negatives.forEach((term) => { if (raw.includes(term)) score -= 1; });
  return Math.max(-1, Math.min(1, score / 4));
}

function redditCacheTtlForItem(item = {}) {
  const impact = Number(item.impactScore || 0);
  const relevance = Number(item.relevanceScore ?? item.relevance ?? 0);
  if (impact >= 70 || relevance >= 76) return REDDIT_CACHE_HIGH_MS;
  if (impact >= 42 || relevance >= 45) return REDDIT_CACHE_MEDIUM_MS;
  return REDDIT_CACHE_LOW_MS;
}

function scoreRedditSocialPosts(posts = [], { symbol = "", market = "ASX", limit = 10 } = {}) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const context = sectorContext(code, key);
  const directTerms = [code, `${code} stock`, cleanAsxCode(code)].filter(Boolean).map((term) => term.toLowerCase());
  const sectorTerms = String(context.sector || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((term) => term.length >= 3);
  const peerTerms = String(context.peers || "").toLowerCase().split(/\s+or\s+|[^a-z0-9\u4e00-\u9fa5]+/i).filter((term) => term.length >= 2);
  const upstreamTerms = String(context.upstream || "").toLowerCase().split(/\s+or\s+|[^a-z0-9\u4e00-\u9fa5]+/i).filter((term) => term.length >= 3);
  const macroTerms = String(context.macro || "").toLowerCase().split(/\s+or\s+|[^a-z0-9\u4e00-\u9fa5]+/i).filter((term) => term.length >= 3);
  const keywordTerms = redditKeywordsForSymbol(code, key)
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((term) => term.length >= 3 && !["stock", "shares", "market"].includes(term));
  const now = Date.now();
  const normalized = posts.map(normalizeRedditPost).filter((post) => post.id && post.title && !post.over_18);
  const seen = new Set();
  const items = normalized.map((post) => {
    const text = redditPostText(post);
    const lower = text.toLowerCase();
    const sourceQuery = String(post.source_query || "").toLowerCase();
    const directHits = directTerms.filter((term) => term && lower.includes(term)).length;
    const sectorHits = sectorTerms.filter((term) => lower.includes(term)).length;
    const peerHits = peerTerms.filter((term) => lower.includes(term)).length;
    const upstreamHits = upstreamTerms.filter((term) => lower.includes(term)).length;
    const macroHits = macroTerms.filter((term) => lower.includes(term)).length;
    const keywordHits = keywordTerms.filter((term) => lower.includes(term)).length;
    const sourceQueryHits = [...sectorTerms, ...peerTerms, ...upstreamTerms, ...macroTerms, ...keywordTerms]
      .filter((term) => term && sourceQuery.includes(term)).length;
    const relevanceScore = Math.min(100, directHits * 42 + sectorHits * 10 + peerHits * 8 + upstreamHits * 7 + macroHits * 5 + keywordHits * 4 + Math.min(22, sourceQueryHits * 5));
    const subredditSubscribers = REDDIT_SUBREDDIT_SUBSCRIBER_PROXY[post.subreddit] || REDDIT_SUBREDDIT_SUBSCRIBER_PROXY[post.subreddit?.replace(/\s+/g, "")] || 50000;
    const influenceScore = Math.min(100,
      Math.log10(Math.max(1, post.score + 10)) * 18
      + Math.log10(Math.max(1, post.num_comments + 5)) * 16
      + Math.log10(Math.max(1, subredditSubscribers)) * 7
      + Math.max(0, Math.min(1, post.upvote_ratio || 0.7)) * 14
    );
    const hasExternalLink = Boolean(post.url && !/reddit\.com/i.test(post.url));
    const factSignals = [
      /\b\d+(\.\d+)?%?\b/.test(text),
      /\b(according to|reported|filing|earnings|guidance|revenue|margin|contract|regulator|source|link)\b/i.test(text),
      /财报|公告|营收|利润|订单|监管|来源|链接/.test(text),
      hasExternalLink,
    ].filter(Boolean).length;
    const hypeTerms = ["guaranteed", "moon", "100x", "pump", "short squeeze", "trust me", "insider", "can't lose", "all in", "yolo"];
    const hypeTermHits = hypeTerms.filter((term) => lower.includes(term)).length;
    const hypeSignals = Math.min(5, hypeTermHits)
      + (/稳赚|翻倍|内幕|无脑|梭哈|必涨|拉盘/.test(text) ? 1 : 0)
      + (post.upvote_ratio < 0.55 ? 1 : 0);
    const validityScore = Math.max(0, Math.min(100, 28 + Math.min(45, text.length / 5) + factSignals * 12 - hypeSignals * 15));
    const manipulationRisk = Math.max(0, Math.min(100, hypeSignals * 18 + (post.score > 800 && factSignals === 0 ? 20 : 0) + (relevanceScore < 28 && influenceScore > 68 ? 18 : 0)));
    const truthScore = Math.max(0, Math.min(100, validityScore + factSignals * 6 - manipulationRisk * 0.55));
    const sentiment = redditSentimentScore(text);
    const channel = directHits ? "direct-stock" : sectorHits || keywordHits ? "sector-industry" : upstreamHits ? "upstream-downstream" : peerHits ? "peer-competitor" : "macro-social";
    const impactScore = Math.max(0, Math.min(100, relevanceScore * 0.36 + influenceScore * 0.28 + validityScore * 0.18 + truthScore * 0.16 - manipulationRisk * 0.18));
    const signedScore = sentiment * (impactScore / 100) * (truthScore / 100) * 18 - (manipulationRisk > 60 ? 2.5 : 0);
    const createdAt = post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null;
    return {
      ...post,
      text,
      createdAt,
      subredditSubscribers,
      relation: channel,
      relevance: Number(relevanceScore.toFixed(2)),
      influence: Number(influenceScore.toFixed(2)),
      validity: Number(validityScore.toFixed(2)),
      relevanceScore: Number(relevanceScore.toFixed(2)),
      influenceScore: Number(influenceScore.toFixed(2)),
      validityScore: Number(validityScore.toFixed(2)),
      manipulationRisk: Number(manipulationRisk.toFixed(2)),
      truthScore: Number(truthScore.toFixed(2)),
      sentiment: Number(sentiment.toFixed(3)),
      impactScore: Number(impactScore.toFixed(2)),
      socialScore: Number(signedScore.toFixed(2)),
      channel,
      retainTier: impactScore >= 70 || relevanceScore >= 76 ? "high" : impactScore >= 42 || relevanceScore >= 45 ? "medium" : "low",
    };
  }).filter((item) => {
    const keyValue = item.id || item.permalink || item.title;
    if (!keyValue || seen.has(keyValue)) return false;
    seen.add(keyValue);
    return item.relevanceScore >= 12 || item.impactScore >= 25;
  }).map((item) => {
    const ttlMs = redditCacheTtlForItem(item);
    return {
      ...item,
      ttlMs,
      retainUntil: new Date(now + ttlMs).toISOString(),
    };
  }).sort((a, b) => b.impactScore - a.impactScore || Math.abs(b.socialScore) - Math.abs(a.socialScore));
  const kept = items.slice(0, 80);
  const topItems = kept.slice(0, Math.max(1, Math.min(20, Number(limit || 10))));
  const average = (values) => values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
  const score = Math.max(-15, Math.min(15, kept.reduce((sum, item) => sum + item.socialScore, 0) / Math.max(1, Math.sqrt(kept.length || 1))));
  const confidence = Math.max(0, Math.min(99, average(topItems.map((item) => item.impactScore)) * 0.62 + average(topItems.map((item) => item.truthScore)) * 0.26 + Math.min(12, topItems.length * 1.2)));
  const sentiment = average(topItems.map((item) => item.sentiment));
  const manipulationRisk = average(topItems.map((item) => item.manipulationRisk));
  const truthScore = average(topItems.map((item) => item.truthScore));
  return {
    available: kept.length > 0,
    source: "reddit-social",
    score: Number(score.toFixed(2)),
    weight: Number(Math.max(0, Math.min(1.4, confidence / 85)).toFixed(2)),
    confidence: Number(confidence.toFixed(1)),
    sentiment: Number(sentiment.toFixed(3)),
    manipulationRisk: Number(manipulationRisk.toFixed(1)),
    truthScore: Number(truthScore.toFixed(1)),
    items: kept,
    topItems,
    thesis: kept.length
      ? [`Reddit social factor scored ${kept.length} relevant posts; Top10 avg truth ${truthScore.toFixed(0)}, manipulation risk ${manipulationRisk.toFixed(0)}, sentiment ${sentiment.toFixed(2)}.`]
      : ["Reddit returned no sufficiently relevant social-media posts for this symbol/context."],
  };
}

function redditBackgroundStatus() {
  return {
    running: redditBackgroundState.running,
    active: redditBackgroundState.active,
    pending: redditBackgroundQueue.length,
    queuedKeys: redditBackgroundQueued.size,
    processed: redditBackgroundState.processed,
    failed: redditBackgroundState.failed,
    lastStartedAt: redditBackgroundState.lastStartedAt,
    lastFinishedAt: redditBackgroundState.lastFinishedAt,
    lastError: redditBackgroundState.lastError,
  };
}

function queueRedditBackgroundRefresh(market = "ASX", symbols = [], options = {}) {
  const key = safeMarket(market);
  const maxSymbols = Math.max(1, Math.min(200, Number(options.maxSymbols || process.env.REDDIT_BACKGROUND_MAX_SYMBOLS || 80)));
  const normalizedSymbols = [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => cleanCode(symbol, key))
    .filter((symbol) => isValidMarketCode(symbol, key) && !symbol.startsWith("^")))]
    .slice(0, maxSymbols);
  const poolSymbols = normalizedSymbols.slice(0, maxSymbols);
  let queued = 0;
  normalizedSymbols.forEach((symbol) => {
    const queueKey = `${key}:${symbol}`;
    if (redditBackgroundQueued.has(queueKey)) return;
    redditBackgroundQueued.add(queueKey);
    redditBackgroundQueue.push({
      key: queueKey,
      market: key,
      symbol,
      force: Boolean(options.force),
      poolSymbols,
      limit: Math.max(1, Math.min(20, Number(options.limit || 10))),
      queuedAt: new Date().toISOString(),
      reason: options.reason || "background",
    });
    queued += 1;
  });
  void processRedditBackgroundQueue();
  return {
    ok: true,
    market: key,
    requested: normalizedSymbols.length,
    queued,
    status: redditBackgroundStatus(),
  };
}

function invalidateRedditDerivedCaches(market, symbol) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const prefix = `${key}:${code}:`;
  for (const cacheKey of Array.from(redditResponseCache.keys())) {
    if (cacheKey.startsWith(prefix)) redditResponseCache.delete(cacheKey);
  }
  for (const cacheKey of Array.from(factorResponseCache.keys())) {
    if (cacheKey.startsWith(prefix)) factorResponseCache.delete(cacheKey);
  }
}

async function processRedditBackgroundQueue() {
  if (redditBackgroundState.running) return;
  redditBackgroundState.running = true;
  redditBackgroundState.lastStartedAt = new Date().toISOString();
  try {
    while (redditBackgroundQueue.length) {
      const job = redditBackgroundQueue.shift();
      redditBackgroundQueued.delete(job.key);
      redditBackgroundState.active = { market: job.market, symbol: job.symbol, reason: job.reason, startedAt: new Date().toISOString() };
      try {
        invalidateRedditDerivedCaches(job.market, job.symbol);
        await fetchRedditSocialFactor(job.symbol, job.market, {
          mode: job.force ? "refresh" : "auto",
          limit: job.limit,
          background: true,
          forcePool: Boolean(job.force),
          poolSymbols: job.poolSymbols || [],
          timeoutMs: Number(process.env.REDDIT_BACKGROUND_TIMEOUT_MS || 20000),
          postsPerSubreddit: Number(process.env.REDDIT_BACKGROUND_POSTS_PER_SUBREDDIT || process.env.REDDIT_POSTS_PER_SUBREDDIT || 6),
        });
        invalidateRedditDerivedCaches(job.market, job.symbol);
        redditBackgroundState.processed += 1;
      } catch (error) {
        redditBackgroundState.failed += 1;
        redditBackgroundState.lastError = `${job.market}:${job.symbol}: ${error.message || error}`;
      }
      if (Number(process.env.REDDIT_BACKGROUND_GAP_MS || 450) > 0) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.REDDIT_BACKGROUND_GAP_MS || 450)));
      }
    }
  } finally {
    redditBackgroundState.active = null;
    redditBackgroundState.running = false;
    redditBackgroundState.lastFinishedAt = new Date().toISOString();
  }
}

async function fetchRedditSocialFactor(symbol, market = "ASX", options = {}) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const mode = ["auto", "local", "refresh", "live"].includes(String(options.mode || "").toLowerCase())
    ? String(options.mode || "").toLowerCase()
    : "auto";
  const limit = Math.max(1, Math.min(20, Number(options.limit || 10)));
  const cacheKey = `${key}:${code}:${mode}:${limit}`;
  const forceLive = mode === "refresh" || mode === "live";
  const refreshMs = Number(process.env.REDDIT_REFRESH_MS || 60 * 60 * 1000);
  const cachedMemory = redditResponseCache.get(cacheKey);
  if (!forceLive && cachedMemory && Date.now() - cachedMemory.time < Math.min(refreshMs, 10 * 60 * 1000)) return cachedMemory.value;
  const disk = await readRedditCache(key, code);
  const diskFresh = disk?.cache?.cachedAt && Date.now() - Date.parse(disk.cache.cachedAt) < refreshMs;
  if (mode === "local" || (!forceLive && diskFresh)) {
    const value = disk || {
      available: false,
      source: "reddit-social-cache-miss",
      score: 0,
      weight: 0,
      confidence: 0,
      sentiment: 0,
      manipulationRisk: 0,
      truthScore: 0,
      items: [],
      topItems: [],
      thesis: ["No local Reddit social cache exists yet."],
      cache: { cache: "disk-miss", cachedAt: null },
    };
    redditResponseCache.set(cacheKey, { time: Date.now(), value });
    return value;
  }
  const status = redditStatusBase();
  if (!status.configured) {
    const value = disk || {
      available: false,
      source: "reddit-disabled",
      score: 0,
      weight: 0,
      confidence: 0,
      sentiment: 0,
      manipulationRisk: 0,
      truthScore: 0,
      items: [],
      topItems: [],
      thesis: [`Reddit social provider disabled or incomplete: ${status.missing.join(", ") || "not configured"}.`],
      cache: { cache: disk ? "disk-stale-fallback" : "disabled", cachedAt: disk?.cache?.cachedAt || null },
      warning: status.missing.join(", "),
    };
    redditResponseCache.set(cacheKey, { time: Date.now(), value });
    return value;
  }
  try {
    const subreddits = redditSubredditsForMarket(key);
    const keywords = redditKeywordsForSymbol(code, key);
    const poolSymbols = [code, ...(Array.isArray(options.poolSymbols) ? options.poolSymbols : [])];
    let raw;
    let queryMeta = { subreddits, keywords };
    let source = "reddit-social";
    const cachedPool = !forceLive ? await readRedditMarketPoolCache(key, refreshMs) : null;
    if (options.background || cachedPool?.posts?.length) {
      const pool = cachedPool?.posts?.length
        ? cachedPool
        : await fetchRedditMarketPool(key, {
          force: Boolean(options.forcePool),
          symbols: poolSymbols,
          timeoutMs: Number(options.timeoutMs || process.env.REDDIT_BACKGROUND_TIMEOUT_MS || 20000),
          postsPerSubreddit: Number(options.postsPerSubreddit || process.env.REDDIT_POOL_POSTS_PER_SOURCE || process.env.REDDIT_BACKGROUND_POSTS_PER_SUBREDDIT || 8),
        });
      raw = { posts: pool.posts || [], errors: pool.errors || [] };
      queryMeta = pool.queries || { subreddits, keywords: redditPoolKeywordsForMarket(key, poolSymbols) };
      source = pool.cache?.cache || pool.source || "reddit-market-pool";
    } else {
      raw = await runRedditPython({
        market: key,
        symbol: code,
        subreddits,
        keywords,
        postsPerSubreddit: Math.max(2, Math.min(10, Number(options.postsPerSubreddit || process.env.REDDIT_POSTS_PER_SUBREDDIT || 4))),
        background: Boolean(options.background),
      }, Number(options.timeoutMs || process.env.REDDIT_TIMEOUT_MS || 6500));
      source = "reddit-symbol-live";
    }
    const scored = scoreRedditSocialPosts(raw.posts || [], { symbol: code, market: key, limit });
    const value = {
      ...scored,
      market: key,
      symbol: code,
      source: scored.available ? source : `${source}-empty`,
      queries: queryMeta,
      cache: { cache: "live", cachedAt: new Date().toISOString(), refreshMs },
    };
    const written = await writeRedditCache(key, code, value);
    redditResponseCache.set(cacheKey, { time: Date.now(), value: written });
    if (redditResponseCache.size > 80) redditResponseCache.delete(redditResponseCache.keys().next().value);
    return written;
  } catch (error) {
    const value = disk ? {
      ...disk,
      cache: { ...(disk.cache || {}), cache: "disk-stale-fallback", refreshMs },
      warning: `Live Reddit unavailable; using local cache. ${error.message || error}`,
    } : {
      available: false,
      source: "reddit-social-unavailable",
      score: 0,
      weight: 0,
      confidence: 0,
      sentiment: 0,
      manipulationRisk: 0,
      truthScore: 0,
      items: [],
      topItems: [],
      thesis: [`Reddit social factor unavailable: ${error.message || error}`],
      cache: { cache: "live-error", cachedAt: null, refreshMs },
      warning: error.message || String(error),
    };
    redditResponseCache.set(cacheKey, { time: Date.now(), value });
    return value;
  }
}

function marketHistoryPathFor(market, symbol, interval = "1d") {
  const key = safeMarket(market);
  return join(snapshotBasePath, "market-history", key.toLowerCase(), `${safeCachePart(symbol)}-${safeCachePart(interval)}.json`);
}

function marketHistoryCacheLimit(interval = "1d") {
  if (interval === "1mo") return 480;
  if (interval === "1wk") return 1200;
  return 6500;
}

async function writeMarketHistoryCache(market, symbol, interval, candles = [], meta = {}) {
  if (!["1d", "1wk", "1mo"].includes(interval)) return;
  const rows = sanitizeCandleRows(candles)
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-marketHistoryCacheLimit(interval));
  if (rows.length < 2) return;
  const payload = {
    market: safeMarket(market),
    symbol: cleanCode(symbol, market),
    interval,
    source: meta.source || "market-history-cache",
    unit: meta.unit || undefined,
    closeOnly: Boolean(meta.closeOnly),
    savedAt: new Date().toISOString(),
    quote: compactPersistedQuote(meta.quote, market),
    candles: rows,
  };
  const body = JSON.stringify(payload);
  if (body.length > Number(process.env.MARKET_HISTORY_CACHE_MAX_BYTES || 8_000_000)) return;
  const path = marketHistoryPathFor(market, symbol, interval);
  await mkdir(join(snapshotBasePath, "market-history", safeMarket(market).toLowerCase()), { recursive: true });
  await writeFile(path, body, "utf8");
}

function compactPersistedQuote(quote = null, market = "ASX") {
  if (!quote || quote.unavailable || !positiveMarketNumber(quote.price)) return null;
  const key = safeMarket(market);
  return {
    symbol: normalizeMarketSymbol(quote.symbol || "", key) || quote.symbol || null,
    market: key,
    price: positiveMarketNumber(quote.price),
    previousClose: positiveMarketNumber(quote.previousClose),
    change: Number.isFinite(Number(quote.change)) ? Number(quote.change) : null,
    changePercent: Number.isFinite(Number(quote.changePercent)) ? Number(quote.changePercent) : null,
    volume: Number.isFinite(Number(quote.volume)) ? Math.max(0, Number(quote.volume)) : null,
    asOf: quote.asOf || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(quote.date || "")) ? String(quote.date) : null,
    retrievedAt: quote.retrievedAt || new Date().toISOString(),
    source: quote.source || "quote",
    delayed: quote.delayed !== false,
    timeVerified: quote.timeVerified !== false && Boolean(quote.asOf || quote.date),
    freshnessAgeMs: Number.isFinite(Number(quote.freshnessAgeMs)) ? Number(quote.freshnessAgeMs) : null,
    crossCheckStatus: quote.crossCheckStatus || null,
    crossCheckSources: Array.isArray(quote.crossCheckSources) ? quote.crossCheckSources.slice(0, 6) : [],
    warning: quote.warning || null,
  };
}

function marketOverlayFromHistoryPayload(payload = {}, market = "ASX", symbol = "", now = new Date()) {
  const key = safeMarket(market || payload.market);
  const code = normalizeMarketSymbol(symbol || payload.symbol || "", key)
    || normalizeMarketSymbol(payload.symbol || "", key)
    || cleanCode(symbol || payload.symbol || "", key);
  const rows = sanitizeCandleRows(payload.candles)
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(candleDate(row)))
    .sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const latest = rows.at(-1) || null;
  const previous = rows.length > 1 ? rows.at(-2) : null;
  const quoteCheck = sanitizeQuoteChangeAgainstCandles(code, key, rows, compactPersistedQuote(payload.quote, key), now);
  const quote = compactPersistedQuote(quoteCheck.quote, key);
  const price = positiveMarketNumber(quote?.price, positiveMarketNumber(latest?.close));
  if (!code || !price) return null;
  const previousClose = positiveMarketNumber(quote?.previousClose, positiveMarketNumber(previous?.close));
  const change = Number.isFinite(Number(quote?.change))
    ? Number(quote.change)
    : previousClose ? price - previousClose : null;
  const changePercent = Number.isFinite(Number(quote?.changePercent))
    ? Number(quote.changePercent)
    : previousClose ? change / previousClose * 100 : null;
  const retrievedAt = quote?.retrievedAt || payload.savedAt || null;
  const dataAsOf = quote
    ? quote.asOf || (quote.timeVerified ? quote.date : null) || null
    : candleDate(latest) || null;
  const verifiedDataMs = quote?.timeVerified ? Date.parse(quote.asOf || "") : NaN;
  const retrievedMs = Date.parse(retrievedAt || "");
  const marketOpen = backendMarketSession(key, now).open;
  const staleAfterMs = Number(process.env.MARKET_OVERLAY_STALE_MS || realtimeQuoteMaxAgeMs(key));
  const freshnessMs = Number.isFinite(verifiedDataMs) ? verifiedDataMs : retrievedMs;
  const stale = marketOpen && (
    !Number.isFinite(freshnessMs)
    || quote?.timeVerified === false
    || now.getTime() - freshnessMs > staleAfterMs
  );
  return {
    symbol: code,
    market: key,
    price,
    previousClose,
    change: Number.isFinite(change) ? Number(change.toFixed(4)) : null,
    changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(4)) : null,
    dataAsOf,
    retrievedAt,
    source: quote?.source || payload.source || "market-history-cache",
    delayed: quote ? quote.delayed !== false : true,
    stale,
    timeVerified: quote ? quote.timeVerified : Boolean(candleDate(latest)),
    freshnessAgeMs: quote?.freshnessAgeMs ?? (Number.isFinite(freshnessMs) ? Math.max(0, now.getTime() - freshnessMs) : null),
    crossCheckStatus: quote?.crossCheckStatus || null,
    crossCheckSources: quote?.crossCheckSources || [],
    warning: quote?.warning || null,
    latestCandle: latest ? { ...latest } : null,
    cacheSavedAt: payload.savedAt || null,
  };
}

function marketHistorySymbolCandidates(symbol, market = "ASX") {
  const key = safeMarket(market);
  const clean = cleanCode(symbol, key);
  const normalized = normalizeMarketSymbol(symbol, key);
  return [...new Set([normalized, symbol, clean].filter(Boolean))];
}

async function readLatestMarketOverlay(market, symbol) {
  const key = safeMarket(market);
  const candidates = await Promise.all(marketHistorySymbolCandidates(symbol, key).map(async (candidate) => {
    try {
      const payload = JSON.parse(await readFile(marketHistoryPathFor(key, candidate, "1d"), "utf8"));
      return marketOverlayFromHistoryPayload(payload, key, symbol);
    } catch {
      return null;
    }
  }));
  return candidates.filter(Boolean).sort((a, b) => {
    const left = Date.parse(a.retrievedAt || a.dataAsOf || "") || 0;
    const right = Date.parse(b.retrievedAt || b.dataAsOf || "") || 0;
    return right - left;
  })[0] || null;
}

async function readLatestMarketHistoryPayload(market, symbol, interval = "1d") {
  const key = safeMarket(market);
  const candidates = await Promise.all(marketHistorySymbolCandidates(symbol, key).map(async (candidate) => {
    try {
      const payload = JSON.parse(await readFile(marketHistoryPathFor(key, candidate, interval), "utf8"));
      return payload && typeof payload === "object" ? payload : null;
    } catch {
      return null;
    }
  }));
  return candidates.filter(Boolean).sort((a, b) => {
    const left = Date.parse(a.savedAt || "") || 0;
    const right = Date.parse(b.savedAt || "") || 0;
    return right - left;
  })[0] || null;
}

function invalidateMarketResponseForSymbol(market, symbol) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  for (const cacheKey of marketResponseCache.keys()) {
    const [cachedMarket, cachedSymbol] = String(cacheKey).split(":");
    if (cachedMarket === key && cleanCode(cachedSymbol, key) === code) marketResponseCache.delete(cacheKey);
  }
}

async function refreshVerifiedQuote(symbol, market = "ASX", options = {}) {
  const key = safeMarket(market);
  const normalized = normalizeMarketSymbol(symbol, key);
  assertValidMarketCode(normalized, key);
  const history = await readLatestMarketHistoryPayload(key, normalized, "1d");
  const candles = sanitizeCandleRows(history?.candles || []).sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const latest = candles.at(-1) || null;
  const quote = await fetchRealtimeQuote(normalized, key, latest?.close, {
    force: options.force !== false,
    strict: true,
    maxAgeMs: options.maxAgeMs,
  });
  if (!quote || quote.unavailable) throw new Error(quote?.warning || `No fresh verified quote for ${normalized}`);
  const checked = sanitizeQuoteChangeAgainstCandles(normalized, key, candles, quote);
  const verifiedQuote = checked.quote;
  const updatedCandles = mergeQuoteIntoCandles(candles, verifiedQuote, key)
    .sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const payload = {
    ...(history || {}),
    market: key,
    symbol: normalized,
    source: history?.source || verifiedQuote.source || "verified-realtime-quote",
    savedAt: new Date().toISOString(),
    quote: verifiedQuote,
    candles: updatedCandles,
  };
  if (updatedCandles.length >= 2) {
    await writeMarketHistoryCache(key, normalized, "1d", updatedCandles, payload).catch(() => null);
  }
  invalidateMarketResponseForSymbol(key, normalized);
  const overlay = marketOverlayFromHistoryPayload(payload, key, normalized);
  if (!overlay || overlay.stale) throw new Error(`Fresh quote for ${normalized} failed final freshness validation.`);
  const warnings = compactProviderErrors([overlay.warning, checked.warning, verifiedQuote.warning]).filter(Boolean);
  return {
    market: key,
    symbol: normalized,
    quote: verifiedQuote,
    overlay: {
      ...overlay,
      warning: warnings.join(" | ") || null,
    },
    candles: updatedCandles,
    source: verifiedQuote.source,
    warning: compactProviderErrors([checked.warning, verifiedQuote.warning]).filter(Boolean).join(" | "),
    updatedAt: new Date().toISOString(),
  };
}

async function readLatestMarketOverlays(market, symbols = [], snapshot = null) {
  const key = safeMarket(market);
  const requested = [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => normalizeMarketSymbol(symbol, key) || cleanCode(symbol, key))
    .filter(Boolean))];
  const rows = (await Promise.all(requested.map((symbol) => readLatestMarketOverlay(key, symbol)))).filter(Boolean);
  const analyses = new Map((snapshot?.analyses || []).map((row) => [cleanCode(row.symbol, key), row]));
  return rows.map((overlay) => {
    const analysis = analyses.get(cleanCode(overlay.symbol, key));
    return {
      ...overlay,
      analysisAsOf: analysis?.analysisAsOf || analysis?.signalRefreshedAt || analysis?.updatedAt || analysis?.quote?.asOf || snapshot?.updatedAt || snapshot?.savedAt || null,
      analysisPrice: Number(analysis?.analysisPrice || analysis?.technicals?.close || 0) || null,
    };
  });
}

async function fetchCachedMarketHistory(symbol, range, interval, market = "ASX", marketError = null) {
  if (!["1d", "1wk", "1mo"].includes(interval)) return null;
  try {
    const payload = JSON.parse(await readFile(marketHistoryPathFor(market, symbol, interval), "utf8"));
    const rows = sanitizeCandleRows(payload.candles)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-candleLimitForRange(range));
    if (rows.length < 2) return null;
    const latest = latestByDate(rows);
    const providerError = marketError ? compactProviderErrors([marketError.message || marketError]).join(" | ") : "";
    return {
      candles: rows,
      quote: null,
      source: `local-history-${payload.source || "cache"}`,
      unit: payload.unit || (cleanCode(symbol, market).startsWith("^") ? "points" : undefined),
      closeOnly: Boolean(payload.closeOnly),
      warning: [`Live providers unavailable; using persisted real market history${payload.savedAt ? ` from ${payload.savedAt}` : ""}.`, providerError].filter(Boolean).join(" "),
      validation: {
        ok: true,
        status: "local_real_history_fallback",
        degraded: true,
        primary: latest ? { source: payload.source || "local-history-cache", date: latest.date, close: latest.close, volume: latest.volume } : null,
        message: "Live providers were unavailable; using locally persisted real market history.",
      },
    };
  } catch {
    return null;
  }
}

function researchConfigPathForMarket(market) {
  return join(snapshotBasePath, `research-config-${safeMarket(market).toLowerCase()}.json`);
}

function modelChangeLogFilePath(market) {
  return join(snapshotBasePath, "records", `model-change-log-${safeMarket(market).toLowerCase()}.jsonl`);
}

function modelCalibrationPathForMarket(market) {
  return join(snapshotBasePath, `model-calibration-${safeMarket(market).toLowerCase()}.json`);
}

function predictionWeightModelPathForMarket(market) {
  return join(snapshotBasePath, "models", `prediction-weight-calibration-${safeMarket(market).toLowerCase()}.json`);
}

function productionModelRegistryDir(market) {
  return join(snapshotBasePath, "models", "registry", safeMarket(market).toLowerCase());
}

function productionModelRegistryIndexPath(market) {
  return join(productionModelRegistryDir(market), "index.json");
}

function factorResearchModelPath(market, symbol) {
  const key = safeMarket(market).toLowerCase();
  const code = cleanCode(symbol, safeMarket(market)).toLowerCase() || "market";
  return join(snapshotBasePath, "models", "factor-research", `${key}-${code}.json`);
}

function alphaEvolutionModelPath(market, symbol) {
  const key = safeMarket(market).toLowerCase();
  const code = cleanCode(symbol, safeMarket(market)).toLowerCase() || "market";
  return join(snapshotBasePath, "models", "factor-research", `alpha-${key}-${code}.json`);
}

function crossSectionalFactorModelPath(market) {
  return join(snapshotBasePath, "models", "factor-research", `cross-sectional-${safeMarket(market).toLowerCase()}.json`);
}

function factorEvolutionSchedulerPath() {
  return join(snapshotBasePath, "models", "factor-research", "evolution-scheduler.json");
}

function predictionRecordPathForMarket(market) {
  return join(snapshotBasePath, "records", `prediction-record-${safeMarket(market).toLowerCase()}.jsonl`);
}

async function appendModelChangeLogFile(market, event = {}) {
  await mkdir(join(snapshotBasePath, "records"), { recursive: true });
  const row = {
    market: safeMarket(market),
    event_type: event.event_type || "model-change-log",
    entity_id: event.entity_id || "",
    created_at: new Date().toISOString(),
    payload: event.payload || {},
  };
  await appendFile(modelChangeLogFilePath(market), `${JSON.stringify(row)}\n`, "utf8");
}

async function writeModelCalibrationSnapshot(market, summary = {}) {
  await mkdir(snapshotBasePath, { recursive: true });
  const payload = {
    market: safeMarket(market),
    savedAt: new Date().toISOString(),
    total: summary.total || 0,
    resolved: summary.resolved || 0,
    pending: summary.pending || 0,
    hitRate: summary.hitRate ?? summary.directionalHitRate ?? null,
    strategyHitRate: summary.strategyHitRate ?? summary.buyHitRate ?? null,
    magnitudeHitRate: summary.magnitudeHitRate ?? null,
    finalReturnHitRate: summary.finalReturnHitRate ?? null,
    maxUpsideHitRate: summary.maxUpsideHitRate ?? null,
    brierScore: summary.brierScore ?? null,
    adaptive: summary.adaptive || null,
    improvement: summary.improvement || null,
    modelStats: summary.modelStats || null,
    ensembleWeightOptimization: summary.ensembleWeightOptimization || null,
    modelZoo: summary.modelZoo || null,
    localModelDeployment: summary.localModelDeployment || null,
    localSignalModels: summary.localSignalModels || null,
    lightgbmModel: summary.lightgbmModel || null,
    tripleBarrierModel: summary.tripleBarrierModel || null,
    splitAudit: summary.splitAudit || null,
    calibrationDiagnostics: summary.calibrationDiagnostics || null,
    noTradeGate: summary.noTradeGate || null,
    deepLearningModel: summary.deepLearningModel || null,
    featureCatalog: summary.featureCatalog || null,
    modelAdjustmentPolicy: summary.modelAdjustmentPolicy || null,
    horizonStats: summary.horizonStats || summary.adaptive?.horizonStats || null,
  };
  await writeFile(modelCalibrationPathForMarket(market), JSON.stringify(payload, null, 2), "utf8");
}

async function appendAdaptiveModelAdjustmentLog(market, summary = {}) {
  const policy = summary.modelAdjustmentPolicy || {};
  const events = Array.isArray(policy.latestEvents) ? policy.latestEvents : [];
  if (!events.length) return;
  const top = events[0];
  await appendModelChangeLogFile(market, {
    event_type: "model-change-log-adaptive-micro-tuning",
    entity_id: `${safeMarket(market)}:${top.symbol || "market"}:${top.date || summary.updatedAt || new Date().toISOString()}:${top.adjustmentScale || 0}`,
    payload: {
      title: "预测结果触发动态微调",
      type: "adaptive-micro-tuning",
      market: safeMarket(market),
      framework: policy.framework,
      scaleFormula: policy.scaleFormula,
      avgAdjustmentScale: policy.avgAdjustmentScale,
      avgForecastError: policy.avgForecastError,
      latestEvents: events,
      guardrails: policy.guardrails,
    },
  });
}

async function readPredictionWeightModelSnapshot(market) {
  try {
    const payload = JSON.parse(await readFile(predictionWeightModelPathForMarket(market), "utf8"));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch {
    return null;
  }
}

async function writePredictionWeightModelSnapshot(market, summary = {}) {
  const key = safeMarket(market);
  const calibration = summary.predictionCalibration || null;
  const horizonCalibrations = Array.isArray(summary.horizonCalibrations) ? summary.horizonCalibrations : [];
  const productionTraining = summary.productionTraining || null;
  if (!calibration && !horizonCalibrations.length && !productionTraining) return null;
  await mkdir(join(snapshotBasePath, "models"), { recursive: true });
  const payload = {
    market: key,
    savedAt: new Date().toISOString(),
    framework: summary.framework || "historical-walk-forward-backtest-batch",
    range: summary.range || "5y",
    requestedSymbols: summary.requestedSymbols || [],
    trainingSymbols: summary.trainingSymbols || summary.requestedSymbols || [],
    trainingUniverse: summary.trainingUniverse || null,
    symbolCount: summary.symbolCount || 0,
    availableCount: summary.availableCount || 0,
    sampleTotal: summary.sampleTotal || 0,
    dataQuality: summary.dataQuality || null,
    metrics: summary.metrics || null,
    predictionCalibration: calibration,
    horizonCalibrations,
    productionTraining,
    modelManifest: productionTraining?.manifest || null,
    productionEligibility: productionTraining?.productionEligibility || null,
    crossSectionalFactorResearch: summary.crossSectionalFactorResearch?.savedModel || summary.crossSectionalFactorResearch || null,
    dataSources: (summary.dataSources || []).map((row) => ({
      symbol: row.symbol,
      source: row.source,
      candles: row.candles,
      warning: row.warning ? String(row.warning).slice(0, 260) : "",
    })),
    leakageControl: calibration?.leakageControl || "Historical prediction-weight calibration uses point-in-time cuts; weights are not fitted on future holdout rows.",
    note: "Stored locally so dashboard loads can read the latest prediction-weight model without retraining.",
  };
  await writeFile(predictionWeightModelPathForMarket(key), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function writeProductionModelVersionSnapshot(market, training = {}) {
  const key = safeMarket(market);
  const manifest = training?.manifest;
  const version = String(manifest?.model_version || "").trim();
  if (!version) return null;
  const directory = productionModelRegistryDir(key);
  await mkdir(directory, { recursive: true });
  const payload = {
    market: key,
    savedAt: new Date().toISOString(),
    manifest,
    dataset: training.dataset || null,
    productionEligibility: training.productionEligibility || null,
    monitoringStatus: training.monitoringStatus || null,
    modelLibraries: training.modelLibraries || null,
    horizonModels: (training.horizonModels || []).map((row) => ({
      horizon: row.horizon,
      available: row.available,
      modelVersion: row.modelVersion,
      deploymentStatus: row.deploymentStatus,
      productionEvidencePassed: row.productionEvidencePassed,
      rowCount: row.rowCount,
      oofRows: row.oofRows,
      metaTestRows: row.metaTestRows,
      eventCounts: row.eventCounts,
      models: row.models,
      weights: row.weights,
      prunedModels: row.prunedModels,
      calibrator: row.calibrator,
      metrics: row.metrics,
      expectedValue: row.expectedValue,
      foldMetrics: row.foldMetrics,
      productionChecks: row.productionChecks,
      leakageControl: row.leakageControl,
      oofArtifact: row.oofArtifact,
    })),
    rejectTradePolicy: training.rejectTradePolicy || null,
    monitoringPolicy: training.monitoringPolicy || null,
  };
  const filename = `${safeCachePart(version)}.json`;
  await writeFile(join(directory, filename), JSON.stringify(payload, null, 2), "utf8");
  let previous = { market: key, versions: [] };
  try {
    previous = JSON.parse(await readFile(productionModelRegistryIndexPath(key), "utf8"));
  } catch {
    // First model version for this market.
  }
  const entry = {
    modelVersion: version,
    savedAt: payload.savedAt,
    trainingAsOf: manifest.training_as_of || null,
    deploymentStatus: manifest.deployment_status || "research",
    eligible: Boolean(training.productionEligibility?.eligible),
    filename,
  };
  const versions = [entry, ...(Array.isArray(previous.versions) ? previous.versions : []).filter((row) => row.modelVersion !== version)].slice(0, 80);
  await writeFile(productionModelRegistryIndexPath(key), JSON.stringify({ market: key, latest: entry, versions }, null, 2), "utf8");
  return entry;
}

async function readFactorResearchModelSnapshot(market, symbol) {
  try {
    const payload = JSON.parse(await readFile(factorResearchModelPath(market, symbol), "utf8"));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch {
    return null;
  }
}

async function writeFactorResearchModelSnapshot(market, symbol, result = {}) {
  const key = safeMarket(market);
  const code = normalizeMarketSymbol(symbol, key);
  const research = result.factor_research || result.dynamic_factor_weights || result.factorResearch || null;
  if (!research || !research.available) return null;
  await mkdir(join(snapshotBasePath, "models", "factor-research"), { recursive: true });
  const liveSignal = research.live_signal || {};
  const payload = {
    market: key,
    symbol: code,
    savedAt: new Date().toISOString(),
    framework: research.framework || "dynamic-factor-admission-and-ml-weighting",
    horizonDays: research.horizon_days || result.horizon_days || null,
    sampleCount: result.sample_count || research.sample_count || null,
    candidateCount: research.candidate_count || 0,
    admittedCount: research.admitted_count || 0,
    liveSignal,
    weights: Array.isArray(research.weights) ? research.weights.slice(0, 40) : [],
    mlBacktest: research.ml_backtest || null,
    leakageControl: research.leakage_control || "Factor research uses point-in-time candles and purged chronological splits.",
    admissionRules: research.admission_rules || [],
  };
  await writeFile(factorResearchModelPath(key, code), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function writeAlphaEvolutionModelSnapshot(market, symbol, result = {}, meta = {}) {
  const key = safeMarket(market);
  const code = normalizeMarketSymbol(symbol, key);
  if (!code || !result || result.available === false) return null;
  await mkdir(join(snapshotBasePath, "models", "factor-research"), { recursive: true });
  const payload = {
    market: key,
    symbol: code,
    savedAt: new Date().toISOString(),
    framework: result.framework || "quantaalpha_inspired_local_evolution",
    horizonDays: result.horizon_days || meta.horizonDays || null,
    rowCount: result.row_count || null,
    sampleCount: result.sample_count || null,
    generations: meta.generations || null,
    population: meta.population || null,
    range: meta.range || "",
    mode: meta.mode || "light",
    trajectory: Array.isArray(result.trajectory) ? result.trajectory.slice(-12) : [],
    bestCandidates: Array.isArray(result.best_candidates) ? result.best_candidates.slice(0, 12) : [],
    advancedModels: result.advanced_models || null,
    qlibBridge: result.qlib_bridge || null,
    leakageControl: "Alpha evolution uses current/past candle-derived primitives only; future returns are labels for walk-forward fitness.",
  };
  await writeFile(alphaEvolutionModelPath(key, code), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function readCrossSectionalFactorModelSnapshot(market) {
  try {
    const payload = JSON.parse(await readFile(crossSectionalFactorModelPath(market), "utf8"));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch {
    return null;
  }
}

async function writeCrossSectionalFactorModelSnapshot(market, result = {}) {
  const key = safeMarket(market);
  if (!result || result.available === false) return null;
  await mkdir(join(snapshotBasePath, "models", "factor-research"), { recursive: true });
  const payload = {
    market: key,
    savedAt: new Date().toISOString(),
    framework: result.framework || "market-cross-sectional-factor-research",
    available: Boolean(result.available),
    horizons: result.horizons || [],
    symbolCount: result.symbol_count || result.symbolCount || 0,
    minSymbolsPerDate: result.min_symbols_per_date || result.minSymbolsPerDate || 0,
    aggregateWeights: Array.isArray(result.aggregate_weights) ? result.aggregate_weights.slice(0, 40) : [],
    horizonResults: (result.horizon_results || []).map((row) => ({
      available: Boolean(row.available),
      horizonDays: row.horizon_days,
      rowCount: row.row_count,
      dateCount: row.date_count,
      symbolCount: row.symbol_count,
      admittedCount: row.admitted_count,
      weights: (row.weights || []).slice(0, 20),
      mlBacktest: row.ml_backtest || null,
      topFactors: (row.factors || []).slice(0, 16),
      highOverlap: (row.high_overlap || []).slice(0, 16),
      reason: row.reason || "",
    })),
    leakageControl: result.leakage_control,
    admissionPolicy: result.admission_policy || [],
  };
  await writeFile(crossSectionalFactorModelPath(key), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function appendPredictionRecordFile(market, samples = []) {
  const rows = (Array.isArray(samples) ? samples : []).map((sample) => normalizePredictionSample(sample, market)).filter(Boolean);
  if (!rows.length) return;
  await mkdir(join(snapshotBasePath, "records"), { recursive: true });
  const body = rows.map((row) => JSON.stringify({ recordedAt: new Date().toISOString(), ...row })).join("\n") + "\n";
  await appendFile(predictionRecordPathForMarket(market), body, "utf8");
}

async function readServerSnapshotForMarket(market) {
  try {
    return sanitizeSnapshot(JSON.parse(await readFile(snapshotPathForMarket(market), "utf8")), market);
  } catch {
    return null;
  }
}

function sanitizeResearchConfig(payload = {}, market = "ASX") {
  const key = safeMarket(payload.market || market);
  const rawFactors = payload.factorConfig && typeof payload.factorConfig === "object" && !Array.isArray(payload.factorConfig)
    ? payload.factorConfig
    : {};
  const factorConfig = Object.fromEntries(
    Object.entries(rawFactors)
      .filter(([name]) => /^[a-z0-9_]{1,64}$/i.test(name))
      .slice(0, 120)
      .map(([name, row]) => [
        name,
        {
          enabled: row?.enabled !== false,
          weightPct: Math.max(0, Math.min(100, Number(row?.weightPct || 0))),
          note: String(row?.note || "").slice(0, 300),
        },
      ])
  );
  const strategyRevisions = (Array.isArray(payload.strategyRevisions) ? payload.strategyRevisions : [])
    .slice(-100)
    .map((row) => ({
      id: String(row?.id || `${key}:${row?.createdAt || Date.now()}`).slice(0, 160),
      createdAt: String(row?.createdAt || new Date().toISOString()).slice(0, 40),
      source: String(row?.source || "manual").slice(0, 40),
      note: String(row?.note || "").slice(0, 1200),
      strategy: row?.strategy && typeof row.strategy === "object" && !Array.isArray(row.strategy)
        ? {
          horizonDays: Math.max(1, Math.min(60, Number(row.strategy.horizonDays || 15))),
          confidence: Math.max(1, Math.min(99, Number(row.strategy.confidence || 80))),
          targetUpside: Math.max(0.1, Math.min(100, Number(row.strategy.targetUpside || 5))),
          maxPosition: Math.max(1, Math.min(100, Number(row.strategy.maxPosition || 20))),
          reserveCashPct: Math.max(0, Math.min(100, Number(row.strategy.reserveCashPct || 15))),
          stopLoss: Math.max(0.1, Math.min(100, Number(row.strategy.stopLoss || 4))),
          text: String(row.strategy.text || "").slice(0, 4000),
        }
        : null,
    }))
    .filter((row) => row.strategy);
  return {
    market: key,
    factorConfig,
    strategyRevisions,
    updatedAt: String(payload.updatedAt || new Date().toISOString()).slice(0, 40),
  };
}

async function readResearchConfig(market = "ASX") {
  try {
    return sanitizeResearchConfig(JSON.parse(await readFile(researchConfigPathForMarket(market), "utf8")), market);
  } catch {
    return sanitizeResearchConfig({ market }, market);
  }
}

async function writeResearchConfig(payload, market = "ASX") {
  const config = sanitizeResearchConfig(payload, market);
  await mkdir(snapshotBasePath, { recursive: true });
  await writeFile(researchConfigPathForMarket(config.market), JSON.stringify(config), "utf8");
  return config;
}

function universePathForMarket(market) {
  return join(snapshotBasePath, `universe-${safeMarket(market).toLowerCase()}.json`);
}

function splitCsvLine(line = "") {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      value += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value.trim());
  return cells;
}

function universeRow(symbol, name = "", market = "ASX", extra = {}) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  if (!isValidMarketCode(code, key)) return null;
  return {
    symbol: normalizeMarketSymbol(code, key),
    code,
    name: String(name || code).trim().slice(0, 160),
    market: key,
    exchange: String(extra.exchange || key).slice(0, 40),
    sector: String(extra.sector || "").slice(0, 120),
    industry: String(extra.industry || "").slice(0, 160),
    source: String(extra.source || "universe-provider").slice(0, 80),
    type: String(extra.type || "stock").slice(0, 40),
  };
}

function sanitizeUniverseRows(rows = [], market = "ASX") {
  const key = safeMarket(market);
  const byCode = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = universeRow(raw?.symbol || raw?.code, raw?.name || raw?.description, key, raw);
    if (row && !row.code.startsWith("^") && row.type !== "fund" && !byCode.has(row.code)) byCode.set(row.code, row);
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

async function readUniverseCache(market = "ASX", maxAgeMs = Number(process.env.UNIVERSE_CACHE_TTL_MS || 24 * 60 * 60 * 1000)) {
  const key = safeMarket(market);
  const memory = universeResponseCache.get(key);
  if (memory && Date.now() - memory.time < maxAgeMs) return { ...memory.value, cache: "memory" };
  try {
    const payload = JSON.parse(await readFile(universePathForMarket(key), "utf8"));
    const fetchedAt = new Date(payload.fetchedAt || 0).getTime();
    if (fetchedAt && Date.now() - fetchedAt < maxAgeMs && Array.isArray(payload.rows) && payload.rows.length) {
      const value = { ...payload, cache: "disk" };
      universeResponseCache.set(key, { time: Date.now(), value });
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

async function writeUniverseCache(payload) {
  const key = safeMarket(payload.market);
  const clean = {
    market: key,
    source: payload.source || "unknown",
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    count: Array.isArray(payload.rows) ? payload.rows.length : 0,
    rows: sanitizeUniverseRows(payload.rows || [], key),
  };
  clean.count = clean.rows.length;
  await mkdir(snapshotBasePath, { recursive: true });
  await writeFile(universePathForMarket(key), JSON.stringify(clean), "utf8");
  universeResponseCache.set(key, { time: Date.now(), value: clean });
  return clean;
}

function parseNasdaqTraderRows(text = "", market = "US") {
  return String(text).split(/\r?\n/)
    .filter((line) => line && !/^Symbol\||^File Creation Time|^Nasdaq Traded\|/i.test(line))
    .map((line) => {
      const cells = line.split("|");
      const symbol = cells[0];
      const name = cells[1];
      const testIssue = cells.includes("Y");
      const etfIndex = line.startsWith("Symbol|") ? -1 : cells.length > 7 ? 6 : -1;
      const isEtf = etfIndex >= 0 && cells[etfIndex] === "Y";
      if (testIssue || isEtf) return null;
      return universeRow(symbol, name, market, { source: "nasdaq-trader-symbol-directory", exchange: "US", type: "stock" });
    })
    .filter(Boolean);
}

async function fetchAsxUniverse() {
  const errors = [];
  try {
    const csv = await fetchText("https://www.asx.com.au/asx/research/ASXListedCompanies.csv", 12000, {
      accept: "text/csv,text/plain,*/*",
    });
    const lines = csv.split(/\r?\n/).filter(Boolean);
    const rows = lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      return universeRow(cells[1] || cells[0], cells[0], "ASX", {
        exchange: "ASX",
        industry: cells[2] || "",
        source: "asx-official-listed-companies",
      });
    }).filter(Boolean);
    if (rows.length) return writeUniverseCache({ market: "ASX", source: "asx-official-listed-companies", rows });
    errors.push("ASX official CSV returned no rows.");
  } catch (error) {
    errors.push(`ASX official CSV: ${error.message || error}`);
  }
  if (providerConfigured("eodhd")) {
    try {
      const payload = await withProviderApiKey("eodhd", {
        backoffKey: "eodhd-asx-universe",
        backoffMs: 12 * 60 * 60 * 1000,
        label: "EODHD ASX universe",
      }, async (apiKey) => {
        const endpoint = new URL("https://eodhd.com/api/exchange-symbol-list/AU");
        endpoint.searchParams.set("api_token", apiKey);
        endpoint.searchParams.set("fmt", "json");
        return fetchJson(endpoint, 12000);
      });
      const rows = (Array.isArray(payload) ? payload : []).map((row) => universeRow(row.Code || row.code, row.Name || row.name, "ASX", {
        exchange: row.Exchange || "ASX",
        source: "eodhd-exchange-symbol-list-au",
        type: row.Type || "stock",
      })).filter(Boolean);
      if (rows.length) return writeUniverseCache({ market: "ASX", source: "eodhd-exchange-symbol-list-au", rows });
      errors.push("EODHD AU symbol list returned no rows.");
    } catch (error) {
      errors.push(`EODHD AU symbol list: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(" | ") || "Unable to read ASX universe.");
}

async function fetchUsUniverse() {
  const [nasdaq, other] = await Promise.all([
    fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt", 12000, { accept: "text/plain,*/*" }),
    fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt", 12000, { accept: "text/plain,*/*" }),
  ]);
  const rows = [
    ...parseNasdaqTraderRows(nasdaq, "US"),
    ...parseNasdaqTraderRows(other, "US"),
  ];
  if (!rows.length) throw new Error("Nasdaq Trader symbol directories returned no stock rows.");
  return writeUniverseCache({ market: "US", source: "nasdaq-trader-symbol-directory", rows });
}

async function fetchCnUniverseFromTushare() {
  if (!process.env.TUSHARE_TOKEN) throw new Error("TUSHARE_TOKEN is not configured.");
  const payload = await fetchJsonPost("https://api.tushare.pro", {
    api_name: "stock_basic",
    token: process.env.TUSHARE_TOKEN,
    params: { list_status: "L" },
    fields: "ts_code,symbol,name,area,industry,market,exchange,list_status",
  }, 12000);
  if (Number(payload?.code || 0) !== 0) throw new Error(payload?.msg || `Tushare error ${payload?.code}`);
  const fields = payload?.data?.fields || [];
  const rows = (payload?.data?.items || []).map((item) => {
    const row = Object.fromEntries(fields.map((field, index) => [field, item[index]]));
    return universeRow(row.symbol, row.name, "CN", {
      exchange: row.exchange || "",
      industry: row.industry || "",
      source: "tushare-stock-basic",
    });
  }).filter(Boolean);
  if (!rows.length) throw new Error("Tushare stock_basic returned no A-share rows.");
  return writeUniverseCache({ market: "CN", source: "tushare-stock-basic", rows });
}

async function fetchCnUniverseFromEastmoney() {
  const rows = [];
  for (const fs of ["m:1+t:2,m:1+t:23", "m:0+t:6,m:0+t:80"]) {
    for (let page = 1; page <= 50; page += 1) {
      const endpoint = new URL("https://push2.eastmoney.com/api/qt/clist/get");
      endpoint.searchParams.set("pn", String(page));
      endpoint.searchParams.set("pz", "200");
      endpoint.searchParams.set("po", "1");
      endpoint.searchParams.set("np", "1");
      endpoint.searchParams.set("fltt", "2");
      endpoint.searchParams.set("invt", "2");
      endpoint.searchParams.set("fid", "f3");
      endpoint.searchParams.set("fs", fs);
      endpoint.searchParams.set("fields", "f12,f14,f13,f100,f102");
      const payload = await fetchJson(endpoint, 12000, {
        referer: "https://quote.eastmoney.com/",
      });
      const pageRows = payload?.data?.diff || [];
      if (!pageRows.length) break;
      pageRows.forEach((row) => {
        const symbol = String(row.f12 || "");
        const item = universeRow(symbol, row.f14, "CN", {
          exchange: String(row.f13 || "") === "1" ? "SH" : "SZ",
          industry: row.f100 || "",
          source: "eastmoney-a-share-clist",
        });
        if (item) rows.push(item);
      });
      const total = Number(payload?.data?.total || 0);
      if (page * 200 >= total) break;
    }
  }
  if (!rows.length) throw new Error("Eastmoney A-share list returned no rows.");
  return writeUniverseCache({ market: "CN", source: "eastmoney-a-share-clist", rows });
}

async function fetchCnUniverse() {
  const errors = [];
  try {
    return await fetchCnUniverseFromTushare();
  } catch (error) {
    errors.push(`Tushare: ${error.message || error}`);
  }
  try {
    return await fetchCnUniverseFromEastmoney();
  } catch (error) {
    errors.push(`Eastmoney: ${error.message || error}`);
  }
  throw new Error(errors.join(" | ") || "Unable to read China A-share universe.");
}

async function fetchMarketUniverse(market = "ASX", options = {}) {
  const key = safeMarket(market);
  const force = options.force === true;
  if (!force) {
    const cached = await readUniverseCache(key);
    if (cached?.rows?.length) return cached;
  }
  if (key === "ASX") return fetchAsxUniverse();
  if (key === "US") return fetchUsUniverse();
  if (key === "CN") return fetchCnUniverse();
  throw new Error(`Unsupported market universe: ${key}`);
}

function envList(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSymbolListForMarket(symbols = [], market = "ASX") {
  const key = safeMarket(market);
  return [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => normalizeMarketSymbol(symbol, key))
    .filter(Boolean))];
}

async function cachedUniverseSymbolsForTraining(market = "ASX", limit = 200) {
  const key = safeMarket(market);
  try {
    const payload = await readUniverseCache(key, Number(process.env.TRAINING_UNIVERSE_CACHE_MAX_AGE_MS || 30 * 24 * 60 * 60 * 1000));
    return sanitizeUniverseRows(payload?.rows || [], key)
      .map((row) => row.symbol)
      .filter(Boolean)
      .slice(0, Math.max(0, Number(limit || 0)));
  } catch {
    return [];
  }
}

async function expandTrainingSymbolsForMarket({ market = "ASX", symbols = [], limit, largeSample = true } = {}) {
  const key = safeMarket(market);
  const requestedSymbols = normalizeSymbolListForMarket(symbols, key);
  const desiredTarget = Number(
    process.env[`HISTORICAL_BACKTEST_TARGET_SYMBOLS_${key}`]
    || ({ US: 300, ASX: 200, CN: 500 }[key] || 200)
  );
  const defaultLimit = Number(
    process.env[`HISTORICAL_BACKTEST_SYMBOL_LIMIT_${key}`] ||
    process.env.HISTORICAL_BACKTEST_LARGE_SAMPLE_LIMIT ||
    process.env.HISTORICAL_BACKTEST_BATCH_SYMBOL_LIMIT ||
    desiredTarget
  );
  const executionCap = Math.max(3, Number(process.env.HISTORICAL_BACKTEST_FETCH_CAP || 80));
  const hardLimit = Number(process.env.HISTORICAL_BACKTEST_BATCH_MAX_SYMBOLS || 1500);
  const requestedTarget = Math.max(3, Math.min(Math.max(3, hardLimit), Number(limit || defaultLimit || desiredTarget)));
  const targetLimit = Math.min(requestedTarget, executionCap);
  const envSymbols = normalizeSymbolListForMarket([
    ...envList(`HISTORICAL_BACKTEST_SYMBOLS_${key}`),
    ...envList("HISTORICAL_BACKTEST_SYMBOLS"),
  ], key);
  const curatedSymbols = normalizeSymbolListForMarket(TRAINING_UNIVERSES[key] || [], key);
  const cachedSymbols = largeSample
    ? await cachedUniverseSymbolsForTraining(key, Math.max(targetLimit * 2, 120))
    : [];
  const merged = normalizeSymbolListForMarket([
    ...requestedSymbols,
    ...envSymbols,
    ...(largeSample ? curatedSymbols : []),
    ...cachedSymbols,
  ], key);
  const trainingSymbols = merged.slice(0, targetLimit);
  return {
    market: key,
    requestedSymbols,
    trainingSymbols,
    largeSample: largeSample !== false,
    targetLimit,
    requestedTarget,
    desiredProductionTarget: desiredTarget,
    executionCap,
    productionCoveragePct: Number((trainingSymbols.length / Math.max(1, desiredTarget) * 100).toFixed(3)),
    coverageGap: Math.max(0, desiredTarget - trainingSymbols.length),
    productionUniverseComplete: trainingSymbols.length >= desiredTarget,
    note: trainingSymbols.length >= desiredTarget
      ? "First-stage market breadth target reached."
      : "Incremental cache-first expansion is required before this universe can pass production evidence gates.",
    sourceCounts: {
      requested: requestedSymbols.length,
      env: envSymbols.length,
      curated: curatedSymbols.length,
      cachedUniverse: cachedSymbols.length,
    },
  };
}

function universePayload(payload = {}, options = {}) {
  const market = safeMarket(payload.market || options.market || "ASX");
  const search = String(options.search || "").trim().toUpperCase();
  const offset = Math.max(0, Number(options.offset || 0));
  const limit = Math.max(1, Math.min(20000, Number(options.limit || 500)));
  const rows = sanitizeUniverseRows(payload.rows || [], market);
  const filtered = search
    ? rows.filter((row) => (
      row.code.includes(search) ||
      row.symbol.includes(search) ||
      row.name.toUpperCase().includes(search) ||
      row.industry.toUpperCase().includes(search) ||
      row.sector.toUpperCase().includes(search)
    ))
    : rows;
  return {
    ok: true,
    market,
    source: payload.source || "unknown",
    fetchedAt: payload.fetchedAt || null,
    cache: payload.cache || "live",
    count: rows.length,
    filteredCount: filtered.length,
    offset,
    limit,
    rows: filtered.slice(offset, offset + limit),
  };
}

function parseMarketNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).replace(/[%,$,¥,￥,\s]/g, "").replace(/,/g, "");
  if (!raw || /^[-—N/A]+$/i.test(raw)) return null;
  const multiplier = /B$/i.test(raw) ? 1_000_000_000 : /M$/i.test(raw) ? 1_000_000 : /K$/i.test(raw) ? 1_000 : 1;
  const number = Number(raw.replace(/[BMK]$/i, ""));
  return Number.isFinite(number) ? number * multiplier : null;
}

function marketMoverRow(row = {}, market = "ASX", source = "movers") {
  const key = safeMarket(market);
  const symbol = cleanCode(row.symbol || row.code || row.f12 || row.SECURITY_CODE || row.Symbol || "", key);
  if (!isValidMarketCode(symbol, key) || symbol.startsWith("^")) return null;
  const price = parseMarketNumber(row.price ?? row.last ?? row.lastSale ?? row.lastsale ?? row.f2 ?? row.CLOSE_PRICE);
  const changePercent = parseMarketNumber(row.changePercent ?? row.change_pct ?? row.change_p ?? row.pctchange ?? row.f3 ?? row.CHANGE_RATE);
  const change = parseMarketNumber(row.change ?? row.netChange ?? row.netchange ?? row.f4 ?? row.CHANGE);
  const volume = parseMarketNumber(row.volume ?? row.f5 ?? row.VOLUME);
  return {
    symbol,
    name: String(row.name || row.companyName || row.securityName || row.f14 || row.SECURITY_NAME_ABBR || row.Symbol || symbol).slice(0, 140),
    price,
    change,
    changePercent,
    volume,
    turnoverRate: parseMarketNumber(row.turnoverRate ?? row.f8 ?? row.TURNOVERRATE),
    amount: parseMarketNumber(row.amount ?? row.f6 ?? row.AMOUNT),
    reason: String(row.reason || row.EXPLAIN || row.explain || "").slice(0, 240),
    source,
    market: key,
    asOf: new Date().toISOString(),
  };
}

function sortMoverRows(rows = [], direction = "gainers") {
  return rows
    .filter((row) => row && Number.isFinite(Number(row.changePercent)))
    .sort((a, b) => direction === "losers"
      ? Number(a.changePercent) - Number(b.changePercent)
      : Number(b.changePercent) - Number(a.changePercent));
}

async function fetchEastmoneyCnMovers(limit = 30) {
  const readSide = async (direction) => {
    const pageSize = Math.max(20, Math.min(100, limit * 2));
    const endpoint = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
    endpoint.searchParams.set("sortColumns", "CHANGE_RATE");
    endpoint.searchParams.set("sortTypes", direction === "losers" ? "1" : "-1");
    endpoint.searchParams.set("pageSize", String(pageSize));
    endpoint.searchParams.set("pageNumber", "1");
    endpoint.searchParams.set("reportName", "RPT_DMSK_TS_STOCKNEW");
    endpoint.searchParams.set("quoteColumns", "f2~01~SECURITY_CODE~CLOSE_PRICE,f8~01~SECURITY_CODE~TURNOVERRATE,f3~01~SECURITY_CODE~CHANGE_RATE,f4~01~SECURITY_CODE~CHANGE,f5~01~SECURITY_CODE~VOLUME");
    endpoint.searchParams.set("quoteType", "0");
    endpoint.searchParams.set("columns", "ALL");
    endpoint.searchParams.set("source", "WEB");
    endpoint.searchParams.set("client", "WEB");
    const payload = await fetchJson(endpoint, 12000, { referer: "https://data.eastmoney.com/" });
    const rows = payload?.result?.data || [];
    return sortMoverRows(rows.map((row) => marketMoverRow(row, "CN", "eastmoney-a-share-datacenter-ranking")), direction).slice(0, limit);
  };
  const [gainers, losers] = await Promise.all([readSide("gainers"), readSide("losers")]);
  return {
    market: "CN",
    source: "eastmoney-a-share-datacenter-ranking",
    coverage: "full-market-ranking",
    scanned: Number(gainers.length || 0) + Number(losers.length || 0),
    gainers,
    losers,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchNasdaqUsMovers(limit = 30) {
  const endpoint = new URL("https://api.nasdaq.com/api/screener/stocks");
  endpoint.searchParams.set("tableonly", "true");
  endpoint.searchParams.set("limit", "10000");
  endpoint.searchParams.set("download", "true");
  const payload = await fetchJson(endpoint, 18000, {
    "user-agent": "Mozilla/5.0",
    accept: "application/json,text/plain,*/*",
    origin: "https://www.nasdaq.com",
    referer: "https://www.nasdaq.com/market-activity/stocks/screener",
  });
  const rows = (payload?.data?.rows || [])
    .map((row) => marketMoverRow({
      symbol: row.symbol,
      name: row.name,
      price: row.lastsale,
      change: row.netchange,
      changePercent: row.pctchange,
      volume: row.volume,
    }, "US", "nasdaq-screener-stocks"))
    .filter(Boolean);
  return {
    market: "US",
    source: "nasdaq-screener-stocks",
    coverage: "full-market-screener",
    scanned: rows.length,
    gainers: sortMoverRows(rows, "gainers").slice(0, limit),
    losers: sortMoverRows(rows, "losers").slice(0, limit),
    updatedAt: new Date().toISOString(),
  };
}

async function fetchEodhdScreenerMovers(market = "ASX", limit = 30) {
  const key = safeMarket(market);
  const exchange = key === "ASX" ? "AU" : key;
  const payload = await withProviderApiKey("eodhd", {
    backoffKey: `eodhd-${key.toLowerCase()}-movers`,
    backoffMs: 12 * 60 * 60 * 1000,
    label: `EODHD ${key} movers`,
  }, async (apiKey) => {
    const endpoint = new URL(`https://eodhd.com/api/eod-bulk-last-day/${exchange}`);
    endpoint.searchParams.set("api_token", apiKey);
    endpoint.searchParams.set("fmt", "json");
    return fetchJson(endpoint, 18000);
  });
  const rows = (Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [])
    .map((row) => {
      const close = parseMarketNumber(row.close ?? row.adjusted_close ?? row.price);
      const previous = parseMarketNumber(row.previousClose ?? row.previous_close ?? row.prev_close);
      const change = parseMarketNumber(row.change ?? (close != null && previous ? close - previous : null));
      const changePercent = parseMarketNumber(row.change_p ?? row.changePercent ?? row.change_percent ?? (previous ? ((close - previous) / previous) * 100 : null));
      return marketMoverRow({
        symbol: row.code || row.symbol,
        name: row.name,
        price: close,
        change,
        changePercent,
        volume: row.volume,
      }, key, "eodhd-bulk-last-day");
    })
    .filter(Boolean);
  if (!rows.length) throw new Error("EODHD bulk last-day returned no mover rows.");
  return {
    market: key,
    source: "eodhd-bulk-last-day",
    coverage: "full-exchange-bulk-last-day",
    scanned: rows.length,
    gainers: sortMoverRows(rows, "gainers").slice(0, limit),
    losers: sortMoverRows(rows, "losers").slice(0, limit),
    updatedAt: new Date().toISOString(),
  };
}

async function scanQuoteMovers(market = "ASX", options = {}) {
  const key = safeMarket(market);
  const limit = Math.max(5, Math.min(50, Number(options.limit || 30)));
  const scanLimit = Math.max(limit * 4, Math.min(1200, Number(options.scanLimit || process.env.MOVERS_SCAN_LIMIT || (key === "ASX" ? 420 : 650))));
  const universe = await fetchMarketUniverse(key, { force: options.force === true });
  const rows = sanitizeUniverseRows(universe.rows || [], key).filter((row) => isValidMarketCode(row.symbol, key)).slice(0, scanLimit);
  const results = [];
  let index = 0;
  const concurrency = Math.max(2, Math.min(12, Number(process.env.MOVERS_SCAN_CONCURRENCY || 8)));
  async function worker() {
    for (;;) {
      const current = rows[index];
      index += 1;
      if (!current) return;
      try {
        const quote = await fetchRealtimeQuote(current.symbol, key);
        if (quote && !quote.unavailable) {
          results.push(marketMoverRow({
            symbol: current.symbol,
            name: current.name,
            price: quote.price,
            change: quote.change,
            changePercent: quote.changePercent,
            volume: quote.volume,
          }, key, `${quote.source}-universe-quote-scan`));
        }
      } catch {
        // Keep the scan moving; failures are reflected in coverage metadata.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return {
    market: key,
    source: "realtime-quote-universe-scan",
    coverage: rows.length >= (universe.rows || []).length ? "full-universe-quote-scan" : "partial-universe-quote-scan",
    scanned: rows.length,
    totalUniverse: (universe.rows || []).length,
    gainers: sortMoverRows(results, "gainers").slice(0, limit),
    losers: sortMoverRows(results, "losers").slice(0, limit),
    updatedAt: new Date().toISOString(),
  };
}

async function fetchMarketMovers(market = "ASX", options = {}) {
  const key = safeMarket(market);
  const limit = Math.max(5, Math.min(50, Number(options.limit || 30)));
  const errors = [];
  if (key === "CN") {
    try {
      return await fetchEastmoneyCnMovers(limit);
    } catch (error) {
      errors.push(`eastmoney movers: ${error.message || error}`);
    }
  }
  if (key === "US") {
    try {
      return await fetchNasdaqUsMovers(limit);
    } catch (error) {
      errors.push(`nasdaq screener: ${error.message || error}`);
    }
  }
  try {
    return await fetchEodhdScreenerMovers(key, limit);
  } catch (error) {
    errors.push(`eodhd screener: ${error.message || error}`);
  }
  const scanned = await scanQuoteMovers(key, options);
  return { ...scanned, warning: compactProviderErrors(errors).join(" | ") };
}

async function fetchCnDragonTiger(limit = 30) {
  const endpoint = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  endpoint.searchParams.set("sortColumns", "TRADE_DATE,SECURITY_CODE");
  endpoint.searchParams.set("sortTypes", "-1,1");
  endpoint.searchParams.set("pageSize", String(Math.max(20, Math.min(100, limit * 2))));
  endpoint.searchParams.set("pageNumber", "1");
  endpoint.searchParams.set("reportName", "RPT_DAILYBILLBOARD_DETAILS");
  endpoint.searchParams.set("columns", "ALL");
  endpoint.searchParams.set("source", "WEB");
  endpoint.searchParams.set("client", "WEB");
  const payload = await fetchJson(endpoint, 12000, { referer: "https://data.eastmoney.com/stock/lhb.html" });
  const rows = (payload?.result?.data || [])
    .map((row) => marketMoverRow({
      symbol: row.SECURITY_CODE,
      name: row.SECURITY_NAME_ABBR,
      price: row.CLOSE_PRICE,
      changePercent: row.CHANGE_RATE,
      amount: row.BILLBOARD_NET_AMT || row.NET_BUY_AMT || row.ACCUM_AMOUNT,
      reason: row.EXPLAIN || row.BILLBOARD_EXPLAIN,
    }, "CN", "eastmoney-daily-billboard"))
    .filter(Boolean)
    .slice(0, limit);
  return {
    market: "CN",
    available: rows.length > 0,
    source: "eastmoney-daily-billboard",
    rows,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchDragonTiger(market = "ASX", options = {}) {
  const key = safeMarket(market);
  const limit = Math.max(5, Math.min(50, Number(options.limit || 30)));
  if (key !== "CN") {
    return {
      market: key,
      available: false,
      source: "not-applicable",
      rows: [],
      warning: "Dragon Tiger ranking is an A-share market-specific disclosure list. ASX/US official equivalents are not exposed by the configured providers.",
      updatedAt: new Date().toISOString(),
    };
  }
  return fetchCnDragonTiger(limit);
}

function normalizedCodeSet(symbols = [], market = "ASX") {
  const rows = Array.isArray(symbols) ? symbols : String(symbols || "").split(",");
  return new Set(
    rows
      .map((symbol) => cleanCode(symbol, market))
      .filter((symbol) => isValidMarketCode(symbol, market))
  );
}

function sampleCode(sample, market = "ASX") {
  return cleanCode(sample?.symbol, market);
}

function isResolvedPredictionSample(sample) {
  return Boolean(sample?.outcome?.resolved || sample?.resolvedAt);
}

function mean(values = []) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function horizonBucketForDays(days) {
  const value = Number(days || 15);
  if (value <= 5) return "short";
  if (value <= 20) return "medium";
  return "long";
}

function horizonLabel(bucket) {
  return { short: "短期<=5日", medium: "中期6-20日", long: "长期>20日" }[bucket] || bucket;
}

function sampleForecastError(sample) {
  if (!sample?.outcome?.resolved) return null;
  return Number(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0) - Number(sample.outcome.forwardReturnPct || 0);
}

function sampleMagnitudeForecastError(sample) {
  if (!sample?.outcome?.resolved) return null;
  const projected = Number(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0);
  const expectedMove = Math.abs(projected);
  const observedMove = projected >= 0
    ? Number(sample.outcome.forwardReturnPct ?? 0)
    : Math.abs(Math.min(0, Number(sample.outcome.forwardReturnPct ?? 0)));
  return expectedMove - Math.max(0, observedMove);
}

function sampleMaxUpsideForecastError(sample) {
  if (!sample?.outcome?.resolved) return null;
  const projectedMax = Math.max(0, Number(sample.projectedMaxUpside ?? sample.qualityGate?.projectedMaxUpside ?? sample.projectedUpside ?? 0));
  if (projectedMax < 0.25) return null;
  return projectedMax - Math.max(0, Number(sample.outcome.maxUpsidePct ?? sample.outcome.forwardReturnPct ?? 0));
}

const BUY_ACTIONS = new Set(["STRONG_BUY", "WATCH_BUY", "LIGHT_BUY"]);
const RISK_ACTIONS = new Set(["AVOID_OR_REDUCE", "STRONG_AVOID", "CRITICAL_SELL", "SELL_REDUCE", "SELL_EXIT"]);

function sampleIsExplicitBuy(sample = {}) {
  return BUY_ACTIONS.has(sample?.action);
}

function samplePredictedDirection(sample = {}) {
  const action = String(sample?.action || "");
  if (BUY_ACTIONS.has(action)) return "upside";
  if (RISK_ACTIONS.has(action)) return "downside";
  const projected = Number(sample?.projectedUpside || 0);
  if (projected >= 0.35) return "upside";
  if (projected <= -0.35) return "downside";
  const explicit = String(sample?.direction || sample?.ensemble?.direction || "").toLowerCase();
  if (explicit === "upside" || explicit === "downside") return explicit;
  return "neutral";
}

function sampleStrategyProbabilityRaw(sample = {}) {
  const explicit = Number(sample.strategyHitProbability ?? sample.strategyConfidence);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, Math.min(99, explicit));
  const gateValue = Number(sample.qualityGate?.strategyHitProbability ?? sample.qualityGate?.historyGate?.strategyHitProbability);
  if (Number.isFinite(gateValue) && gateValue > 0) return Math.max(0, Math.min(99, gateValue));
  return null;
}

function sampleMagnitudeProbability(sample = {}) {
  const explicit = Number(sample.magnitudeHitProbability ?? sample.magnitudeConfidence ?? sample.moveHitProbability ?? sample.projectedMoveConfidence);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, Math.min(99, explicit));
  const gateValue = Number(sample.qualityGate?.magnitudeHitProbability ?? sample.qualityGate?.moveHitProbability);
  if (Number.isFinite(gateValue) && gateValue > 0) return Math.max(0, Math.min(99, gateValue));
  const projected = Math.abs(Number(sample.projectedUpside || 0));
  if (projected < 0.25) return 0;
  return clampNumber(Number(sample.predictionConfidence ?? sample.confidence ?? 0) * 0.68 - projected * 3.2 + 10, 0, 88);
}

function sampleFinalReturnProbability(sample = {}) {
  const explicit = Number(sample.finalReturnHitProbability ?? sample.finalReturnConfidence);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, Math.min(99, explicit));
  const projected = Math.abs(Number(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0));
  if (projected < 0.25) return sampleMagnitudeProbability(sample);
  return clampNumber(sampleMagnitudeProbability(sample) - Math.min(18, projected * 2.2), 0, 90);
}

function sampleMaxUpsideProbability(sample = {}) {
  const explicit = Number(sample.maxUpsideHitProbability ?? sample.maxUpsideConfidence);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, Math.min(99, explicit));
  const projectedMax = Math.max(0, Number(sample.projectedMaxUpside ?? sample.qualityGate?.projectedMaxUpside ?? sample.projectedUpside ?? 0));
  const projectedFinal = Math.abs(Number(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0));
  if (projectedMax < 0.25) return sampleMagnitudeProbability(sample);
  return clampNumber(sampleMagnitudeProbability(sample) - Math.min(14, Math.max(0, projectedMax - projectedFinal) * 2.4), 0, 90);
}

function sampleWasPositive(sample) {
  const projected = Number(sample?.projectedFinalReturn ?? sample?.projectedUpside ?? 0);
  const cycleProjected = Math.max(projected, Math.max(0, Number(sample?.projectedMaxUpside ?? sample?.qualityGate?.projectedMaxUpside ?? 0)) * 0.72);
  const target = Math.max(1, Number(sample?.targetUpside || 5));
  const confidence = Number(sample?.confidence ?? sample?.predictionConfidence ?? 0);
  const strategyProbability = sampleStrategyProbabilityRaw(sample);
  if (sampleIsExplicitBuy(sample)) return true;
  if (samplePredictedDirection(sample) !== "upside") return false;
  if (cycleProjected >= target && confidence >= 58) return true;
  return cycleProjected >= Math.max(0.8, target * 0.35)
    && confidence >= 52
    && Number(strategyProbability || 0) >= 55;
}

function sampleMissed(sample) {
  if (sample?.outcome?.resolved) return sampleWasPositive(sample) && !positiveTargetOutcomeHit(sample);
  const interim = sample?.interim || {};
  return sampleWasPositive(sample)
    && Number(interim.observedDays || 0) > 0
    && (Number(interim.maxDrawdownPct || 0) <= -0.8 || Number(interim.forwardReturnPct || 0) <= -0.6);
}

function behaviorPattern(key, label) {
  return { key, label };
}

function predictionBehaviorPatterns(sample = {}) {
  const feature = sample.featureScores || {};
  const signals = sample.signalCounts || {};
  const ensemble = sample.ensemble || {};
  const confidence = Number(sample.confidence ?? sample.rawConfidence ?? 0);
  const projectedUpside = Number(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0);
  const cycleProjected = Math.max(projectedUpside, Math.max(0, Number(sample.projectedMaxUpside ?? sample.qualityGate?.projectedMaxUpside ?? 0)) * 0.72);
  const targetUpside = Math.max(1, Number(sample.targetUpside || 5));
  const horizon = horizonBucketForDays(sample.horizonDays);
  const newsCount = Number(signals.news || 0) + Number(signals.x || 0) + Number(signals.youtube || 0);
  const factorCount = Number(signals.factors || 0);
  const trend = Number(feature.trend || 0);
  const momentum = Number(feature.momentum || 0);
  const volume = Number(feature.volume || 0);
  const factor = Number(feature.factor || 0);
  const analog = Number(feature.analogConfidence || 0);
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const positive = sampleWasPositive(sample) || cycleProjected > 0;
  const patterns = [];

  if (!positive) return patterns;
  if (confidence >= 72 && newsCount <= 1 && factorCount <= 1) {
    patterns.push(behaviorPattern("thin-evidence-high-confidence", "证据薄仍高置信"));
    patterns.push(behaviorPattern(`${horizon}-thin-evidence-high-confidence`, `${horizonLabel(horizon)}证据薄仍高置信`));
  }
  if ((trend >= 60 || momentum >= 60) && volume > 0 && volume < 52) {
    patterns.push(behaviorPattern("strong-momentum-weak-volume", "趋势/动量强但量能弱"));
    if (cycleProjected >= targetUpside) patterns.push(behaviorPattern("target-with-weak-volume", "涨幅达标但量能不足"));
  }
  if (ensemble.direction === "upside" && consensus >= 65 && volume > 0 && volume < 55) {
    patterns.push(behaviorPattern("upside-consensus-weak-volume", "模型一致看涨但量能不足"));
  }
  if (factor > 0 && factor < 45 && confidence >= 62) {
    patterns.push(behaviorPattern("factor-weak-positive", "因子偏弱仍乐观"));
  }
  if (analog > 0 && analog < 45 && cycleProjected > 0) {
    patterns.push(behaviorPattern("analog-weak-positive", "历史相似样本偏弱仍乐观"));
  }
  if (confidence >= 72 && consensus > 0 && consensus < 62) {
    patterns.push(behaviorPattern("low-consensus-high-confidence", "模型共识不足仍高置信"));
  }
  if (cycleProjected >= targetUpside * 1.25 && confidence >= 65) {
    patterns.push(behaviorPattern("aggressive-upside-target", "预估涨幅偏激进"));
    patterns.push(behaviorPattern(`${horizon}-aggressive-upside-target`, `${horizonLabel(horizon)}预估涨幅偏激进`));
  }
  if (upsideAgreement >= 65 && newsCount <= 1) {
    patterns.push(behaviorPattern("model-consensus-thin-news", "模型看涨但新闻证据薄"));
  }
  if (confidence >= 70 && cycleProjected >= targetUpside && newsCount <= 1) {
    patterns.push(behaviorPattern("target-thin-news", "达标预测但新闻证据薄"));
  }

  const seen = new Set();
  return patterns.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function sampleStrategyProbability(sample = {}) {
  const explicit = sampleStrategyProbabilityRaw(sample);
  if (explicit != null) return explicit;
  return sampleWasPositive(sample) ? Math.max(0, Math.min(99, Number(sample.confidence || 0) * 0.72)) : 0;
}

function sampleRegimeKey(sample = {}) {
  const raw = String(sample.marketRegime || sample.regimeBucket || sample.ensemble?.marketRegime?.regime || "").trim().toLowerCase();
  if (["uptrend", "bull", "risk-on"].includes(raw)) return "uptrend";
  if (["downtrend", "bear", "risk-off"].includes(raw)) return "downtrend";
  if (["volatile", "high-volatility"].includes(raw)) return "volatile";
  if (["range", "mixed", "neutral"].includes(raw)) return "range";
  return raw || "unknown";
}

function forecastErrorTypes(sample = {}) {
  const outcome = sample.outcome || {};
  const types = [];
  if (!outcome.resolved || !sampleWasPositive(sample)) return types;
  const forwardReturn = Number(outcome.forwardReturnPct || 0);
  const projected = Number(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0);
  const confidence = Number(sample.confidence || 0);
  const strategyProbability = sampleStrategyProbability(sample);
  const consensus = Number(sample.ensemble?.consensusAgreement || 0);
  const upsideAgreement = Number(sample.ensemble?.upsideAgreement || 0);
  const factorScore = Number(sample.featureScores?.factor || 0);
  const newsCount = Number(sample.signalCounts?.news || 0) + Number(sample.signalCounts?.x || 0) + Number(sample.signalCounts?.youtube || 0);

  if (outcome.stopWins) types.push("stop_first");
  if (!outcome.targetWins) types.push("target_miss");
  if (forwardReturn < 0) types.push("direction_wrong");
  if (!finalReturnOutcomeHit(sample)) types.push("final_return_miss");
  if (!maxUpsideOutcomeHit(sample)) types.push("max_upside_miss");
  if (!cycleMoveOutcomeHit(sample)) types.push("magnitude_miss");
  if (projected - forwardReturn > 1.2) types.push("over_prediction");
  if ((sampleMagnitudeForecastError(sample) || 0) > 1) types.push("magnitude_over_prediction");
  if ((sampleMaxUpsideForecastError(sample) || 0) > 1) types.push("max_upside_over_prediction");
  if (confidence >= 65 && !outcome.targetWins) types.push("high_confidence_miss");
  if (strategyProbability >= 58 && !outcome.targetWins) types.push("strategy_probability_miss");
  if (sampleFinalReturnProbability(sample) >= 58 && !finalReturnOutcomeHit(sample)) types.push("final_probability_miss");
  if (sampleMaxUpsideProbability(sample) >= 58 && !maxUpsideOutcomeHit(sample)) types.push("max_upside_probability_miss");
  if (consensus >= 62 && upsideAgreement >= 58 && !outcome.targetWins) types.push("model_consensus_false_positive");
  if (newsCount <= 1 && confidence >= 62) types.push("thin_news_evidence");
  if (factorScore < 0 && projected > 0) types.push("factor_conflict_ignored");
  const regime = sampleRegimeKey(sample);
  if ((regime === "downtrend" || regime === "volatile") && projected > 0) types.push("market_regime_conflict");
  return [...new Set(types)];
}

async function deleteServerSnapshotSymbols(market, symbols = []) {
  const key = safeMarket(market);
  const removeCodes = normalizedCodeSet(symbols, key);
  if (!removeCodes.size) return { removed: 0 };
  const snapshot = await readServerSnapshotForMarket(key);
  if (!snapshot) return { removed: 0 };
  const analyses = (snapshot.analyses || []).filter((item) => !removeCodes.has(cleanCode(item.symbol, key)));
  const watchlist = (snapshot.watchlist || []).filter((symbol) => !removeCodes.has(cleanCode(symbol, key)));
  const removed = (snapshot.analyses || []).length - analyses.length;
  if (!analyses.length) {
    await unlink(snapshotPathForMarket(key)).catch(() => {});
    return { removed };
  }
  const selected = removeCodes.has(cleanCode(snapshot.selected, key))
    ? cleanCode(watchlist[0] || analyses[0]?.symbol, key)
    : snapshot.selected;
  await writeServerSnapshot({
    ...snapshot,
    watchlist,
    analyses,
    selected,
    updatedAt: new Date().toISOString(),
    reason: "symbol-delete",
  });
  return { removed };
}

function marketFromUrl(url) {
  return safeMarket(url.searchParams.get("market") || "ASX");
}

function hasRequiredSnapshotTechnicals(technicals) {
  return ["close", "rsi", "volumeRatio", "mainForceProxy"].every((key) => Number.isFinite(Number(technicals?.[key])));
}

function hasUsableSnapshotCandles(candles) {
  return sanitizeCandleRows(candles).length > 0;
}

function isUsableSnapshotItem(item, market = "ASX") {
  const technicals = item?.technicals || item?.technical || {};
  return Boolean(
    isValidMarketCode(item?.symbol, market) &&
    item?.analysis?.action &&
    hasRequiredSnapshotTechnicals(technicals) &&
    hasUsableSnapshotCandles(item?.candles)
  );
}

function sanitizeSnapshot(payload, fallbackMarket = "ASX") {
  const market = safeMarket(payload?.market || fallbackMarket);
  const analyses = Array.isArray(payload?.analyses)
    ? payload.analyses.filter((item) => isUsableSnapshotItem(item, market))
    : [];
  if (!analyses.length) return null;
  const symbols = new Set(analyses.map((item) => cleanCode(item.symbol, market)));
  const watchlist = Array.isArray(payload.watchlist)
    ? payload.watchlist.map((item) => cleanCode(item, market)).filter((item) => isValidMarketCode(item, market))
    : [];
  if (watchlist.length && !watchlist.every((symbol) => symbols.has(symbol))) return null;
  const selected = cleanCode(payload.selected, market);
  return {
    ...payload,
    market,
    watchlist: [...new Set([...watchlist, ...symbols])],
    selected: symbols.has(selected) ? selected : cleanCode(analyses[0].symbol, market),
    analyses,
  };
}

function candleDate(row) {
  return String(row?.date || "").slice(0, 10);
}

function positiveMarketNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sanitizeCandleRow(row, options = {}) {
  const date = options.preserveTimestamp ? String(row?.date || "") : candleDate(row);
  const close = positiveMarketNumber(row?.close);
  if (!date || !close) return null;
  const open = positiveMarketNumber(row?.open, close);
  const rawHigh = positiveMarketNumber(row?.high, Math.max(open, close));
  const rawLow = positiveMarketNumber(row?.low, Math.min(open, close));
  return {
    ...row,
    date,
    open,
    high: Math.max(rawHigh, open, close),
    low: Math.min(rawLow, open, close),
    close,
    adjClose: positiveMarketNumber(row?.adjClose, close),
    volume: Math.max(0, Number(row?.volume || 0)),
  };
}

function sanitizeCandleRows(rows = [], options = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => sanitizeCandleRow(row, options)).filter(Boolean);
}

function normalizedCandles(candles = []) {
  return sanitizeCandleRows(candles)
    .map((row) => ({
      date: candleDate(row),
      close: Number(row.close),
      high: Number(row.high ?? row.close),
      low: Number(row.low ?? row.close),
    }))
    .filter((row) => row.date && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function clampFinite(value, min, max, fallback = 0) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

function indicatorEma(values = [], period = 12) {
  const rows = values.map(Number).filter(Number.isFinite);
  if (!rows.length) return [];
  const alpha = 2 / (period + 1);
  const output = [];
  let previous = rows[0];
  rows.forEach((value, index) => {
    previous = index === 0 ? value : value * alpha + previous * (1 - alpha);
    output.push(previous);
  });
  return output;
}

function indicatorSma(values = [], period = 20) {
  const rows = values.map((value) => Number(value) || 0);
  return rows.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const slice = rows.slice(start, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
  });
}

function indicatorRsi(values = [], period = 14) {
  const rows = values.map(Number).filter(Number.isFinite);
  if (rows.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let index = rows.length - period; index < rows.length; index += 1) {
    const change = rows[index] - rows[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses <= 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function indicatorMacdRows(candles = []) {
  const rows = sanitizeCandleRows(candles);
  const closes = rows.map((row) => Number(row.close || 0));
  const ema12 = indicatorEma(closes, 12);
  const ema26 = indicatorEma(closes, 26);
  const macd = ema12.map((value, index) => value - (ema26[index] || value));
  const signal = indicatorEma(macd, 9);
  const histogram = macd.map((value, index) => value - (signal[index] || value));
  return { macd, signal, histogram };
}

function computeServerTechnicals(candles = []) {
  const rows = sanitizeCandleRows(candles).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!rows.length) {
    return {
      close: 0,
      sma20: 0,
      sma50: 0,
      rsi: 50,
      macdHistogram: 0,
      volumeRatio: 1,
      change5d: 0,
      change20d: 0,
      volatility: 0,
      trendScore: 50,
      momentumScore: 50,
      volumeScore: 50,
      riskScore: 50,
      projectedUpside: 0,
      mainForceProxy: 50,
    };
  }
  const closes = rows.map((row) => Number(row.close || 0));
  const volumes = rows.map((row) => Number(row.volume || 0));
  const latest = rows.at(-1) || {};
  const close = Number(latest.close || 0);
  const sma20 = indicatorSma(closes, 20).at(-1) || close;
  const sma50 = indicatorSma(closes, 50).at(-1) || close;
  const macdHistogram = indicatorMacdRows(rows).histogram.at(-1) || 0;
  const latestRsi = indicatorRsi(closes);
  const avgVolume20 = indicatorSma(volumes, 20).at(-1) || 1;
  const volumeRatio = Number(latest.volume || 0) / Math.max(1, avgVolume20);
  const change5d = pctChange(close, closes.at(-6));
  const change20d = pctChange(close, closes.at(-21));
  const recentReturns = closes.slice(-21).map((value, index, arr) => index ? pctChange(value, arr[index - 1]) : 0);
  const volatility = Math.sqrt(recentReturns.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, recentReturns.length));
  const boundedChange5d = clampFinite(change5d, -6, 6);
  const overextensionPenalty = Math.max(0, change5d - 4) * 0.35 + Math.max(0, latestRsi - 72) * 0.12;
  const trendScore = clampFinite(50 + (close > sma20 ? 12 : -9) + (sma20 > sma50 ? 11 : -10) + clampFinite(change20d * 0.62, -9, 9), 0, 100, 50);
  const momentumScore = clampFinite(50 + macdHistogram * 92 + (latestRsi - 50) * 0.55 + boundedChange5d * 0.35 + clampFinite(change20d * 0.12, -3, 3), 0, 100, 50);
  const volumeScore = clampFinite(45 + (volumeRatio - 1) * 28, 0, 100, 50);
  const riskScore = clampFinite(82 - volatility * 8, 0, 100, 50);
  const projectedUpside = clampFinite(
    (trendScore - 50) * 0.045
      + (momentumScore - 50) * 0.035
      + (volumeScore - 50) * 0.02
      + (riskScore - 50) * 0.015
      - overextensionPenalty,
    -10,
    12,
  );
  const mainForceProxy = clampFinite(50 + (volumeRatio - 1) * 18 + macdHistogram * 70 + boundedChange5d * 0.45 - overextensionPenalty * 1.2, 0, 100, 50);
  return {
    close,
    sma20,
    sma50,
    rsi: latestRsi,
    macdHistogram,
    volumeRatio,
    change5d,
    change20d,
    volatility,
    trendScore,
    momentumScore,
    volumeScore,
    riskScore,
    projectedUpside,
    mainForceProxy,
  };
}

function serverForwardOutcome(rows, startIndex, horizon = 15, strategy = {}) {
  const entry = Number(rows[startIndex]?.close || 0);
  const targetUpside = Math.max(0.5, Number(strategy.targetUpside || 5));
  const stopLoss = Math.max(0.8, Math.abs(Number(strategy.stopLoss || 4)));
  const endIndex = Math.min(rows.length - 1, startIndex + Math.max(1, Number(horizon || 15)));
  if (!entry || startIndex >= endIndex) return { forwardReturn: 0, maxUpside: 0, maxDrawdown: 0, targetWins: false, stopWins: false, riskAdjustedReturn: 0 };
  let maxHigh = entry;
  let minLow = entry;
  let firstEvent = null;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const row = rows[index];
    const highReturn = pctChange(row.high || row.close, entry);
    const lowReturn = pctChange(row.low || row.close, entry);
    maxHigh = Math.max(maxHigh, Number(row.high || row.close));
    minLow = Math.min(minLow, Number(row.low || row.close));
    if (!firstEvent && highReturn >= targetUpside) firstEvent = "target";
    if (!firstEvent && lowReturn <= -stopLoss) firstEvent = "stop";
  }
  const forwardReturn = pctChange(rows[endIndex].close, entry);
  const maxUpside = pctChange(maxHigh, entry);
  const maxDrawdown = pctChange(minLow, entry);
  const targetWins = maxUpside >= targetUpside && (maxDrawdown > -stopLoss || firstEvent === "target");
  const stopWins = maxDrawdown <= -stopLoss && (maxUpside < targetUpside || firstEvent === "stop");
  return {
    forwardReturn,
    maxUpside,
    maxDrawdown,
    targetWins,
    stopWins,
    riskAdjustedReturn: targetWins ? Math.min(maxUpside, targetUpside) : stopWins ? -stopLoss : forwardReturn,
  };
}

function computeServerHistoricalAnalog(candles = [], lookback = 15, horizon = 15, strategy = {}) {
  const rows = sanitizeCandleRows(candles).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (rows.length < lookback * 3 + horizon) {
    return {
      count: 0,
      confidence: 0,
      averageForwardReturn: 0,
      averageFinalReturn: 0,
      averageMaxUpside: 0,
      winRate: 0,
      targetHitRate: 0,
      finalReturnHitRate: 0,
      maxUpsideHitRate: 0,
      stopRate: 0,
      downsideRate: 0,
      directionalHitRate: 0,
      strategyHitProbability: 0,
      averageRiskAdjustedReturn: 0,
      model: { sampleCount: 0, confidence: 0 },
      examples: [],
    };
  }
  const closes = rows.map((row) => Number(row.close || 0));
  const volumes = rows.map((row) => Number(row.volume || 0));
  const avgVolume = indicatorSma(volumes, 20);
  const vectorAt = (end) => {
    const out = [];
    for (let index = end - lookback + 1; index <= end; index += 1) {
      out.push(pctChange(closes[index], closes[index - 1]) / 4);
      out.push(((volumes[index] || 0) / Math.max(1, avgVolume[index] || 1) - 1) / 3);
    }
    return out.map((value) => Number.isFinite(value) ? value : 0);
  };
  const target = vectorAt(rows.length - 1);
  const distance = (a, b) => Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / Math.max(1, a.length));
  const matches = [];
  for (let end = lookback; end < rows.length - horizon - 1; end += 1) {
    const outcome = serverForwardOutcome(rows, end, horizon, strategy);
    matches.push({
      date: rows[end].date,
      distance: distance(target, vectorAt(end)),
      forwardReturn: outcome.forwardReturn,
      maxUpside: outcome.maxUpside,
      maxDrawdown: outcome.maxDrawdown,
      targetWins: outcome.targetWins,
      stopWins: outcome.stopWins,
      riskAdjustedReturn: outcome.riskAdjustedReturn,
      close: closes[end],
    });
  }
  const best = matches.sort((a, b) => a.distance - b.distance).slice(0, 10);
  if (!best.length) return computeServerHistoricalAnalog([], lookback, horizon, strategy);
  const averageForwardReturn = best.reduce((sum, item) => sum + item.forwardReturn, 0) / best.length;
  const averageMaxUpside = best.reduce((sum, item) => sum + Math.max(0, item.maxUpside), 0) / best.length;
  const averageRiskAdjustedReturn = best.reduce((sum, item) => sum + item.riskAdjustedReturn, 0) / best.length;
  const winRate = best.filter((item) => item.forwardReturn > 0).length / best.length * 100;
  const targetHitRate = best.filter((item) => item.targetWins).length / best.length * 100;
  const stopRate = best.filter((item) => item.stopWins).length / best.length * 100;
  const downsideRate = best.filter((item) => item.forwardReturn < 0 || item.stopWins).length / best.length * 100;
  const directionalHitRate = averageRiskAdjustedReturn >= 0 ? winRate : downsideRate;
  const strategyHitProbability = averageRiskAdjustedReturn >= 0 ? targetHitRate : Math.max(stopRate, downsideRate);
  const confidence = clampFinite(34 + directionalHitRate * 0.42 + strategyHitProbability * 0.12 + Math.abs(averageRiskAdjustedReturn) * 1.6 - (best[0]?.distance || 0) * 8, 0, 95);
  const finalReturnTarget = Math.abs(averageForwardReturn);
  const finalReturnHitRate = finalReturnTarget >= 0.25
    ? best.filter((item) => averageForwardReturn >= 0 ? item.forwardReturn >= finalReturnTarget * 0.88 : item.forwardReturn <= -finalReturnTarget * 0.88).length / best.length * 100
    : directionalHitRate;
  const maxUpsideHitRate = averageMaxUpside >= 0.25
    ? best.filter((item) => Math.max(0, item.maxUpside) >= averageMaxUpside * 0.88).length / best.length * 100
    : targetHitRate;
  return {
    count: best.length,
    confidence,
    averageForwardReturn,
    averageFinalReturn: averageForwardReturn,
    averageMaxUpside: Math.max(0, averageMaxUpside),
    winRate,
    targetHitRate,
    finalReturnHitRate,
    maxUpsideHitRate,
    stopRate,
    downsideRate,
    directionalHitRate,
    strategyHitProbability,
    averageRiskAdjustedReturn,
    model: { sampleCount: matches.length, confidence, predictedReturn: averageForwardReturn, predictedMaxUpside: averageMaxUpside, directionalAccuracy: directionalHitRate, targetHitAccuracy: targetHitRate, maxUpsideHitAccuracy: maxUpsideHitRate },
    examples: best.slice(0, 8),
  };
}

function zonedDateParts(date = new Date(), timeZone = "Australia/Sydney") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: map.weekday,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    date: `${map.year}-${map.month}-${map.day}`,
  };
}

function backendMarketSession(market = "ASX", now = new Date()) {
  const key = safeMarket(market);
  const timeZone = { ASX: "Australia/Sydney", US: "America/New_York", CN: "Asia/Shanghai" }[key] || "Australia/Sydney";
  const local = zonedDateParts(now, timeZone);
  const weekend = ["Sat", "Sun"].includes(local.weekday);
  const minute = local.hour * 60 + local.minute;
  const ranges = {
    ASX: [[10 * 60, 16 * 60 + 10]],
    US: [[9 * 60 + 30, 16 * 60]],
    CN: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]],
  }[key];
  const open = !weekend && ranges.some(([start, end]) => minute >= start && minute <= end);
  return { market: key, open, weekend, localTime: `${local.date} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`, timeZone, ranges };
}

function backendMonitorDefaults() {
  return {
    enabled: envBool("BACKEND_MONITOR_ENABLED", true),
    refresh: {
      quoteHoldingMs: Math.max(30_000, Number(process.env.BACKEND_MONITOR_QUOTE_HOLDING_REFRESH_MS || 60_000)),
      quoteWatchMs: Math.max(60_000, Number(process.env.BACKEND_MONITOR_QUOTE_WATCH_REFRESH_MS || 3 * 60_000)),
      holdingMs: Math.max(60_000, Number(process.env.BACKEND_MONITOR_HOLDING_REFRESH_MS || 2 * 60_000)),
      watchMs: Math.max(60_000, Number(process.env.BACKEND_MONITOR_WATCH_REFRESH_MS || 5 * 60_000)),
      trainingMs: Math.max(60_000, Number(process.env.BACKEND_MONITOR_TRAINING_REFRESH_MS || 2 * 60_000)),
      checkMs: Math.max(10_000, Number(process.env.BACKEND_MONITOR_CHECK_MS || 15_000)),
    },
    training: {
      enabled: envBool("BACKEND_MONITOR_TRAINING_ENABLED", true),
      symbolLimit: Math.max(1, Math.min(5, Number(process.env.BACKEND_MONITOR_TRAINING_SYMBOL_LIMIT || 3))),
      interval: process.env.BACKEND_MONITOR_TRAINING_INTERVAL || "5m",
      range: process.env.BACKEND_MONITOR_TRAINING_RANGE || "1mo",
    },
    notifications: {
      desktop: envBool("BACKEND_MONITOR_DESKTOP_NOTIFICATIONS", true),
      mobile: envBool("BACKEND_MONITOR_MOBILE_NOTIFICATIONS", true),
    },
    quota: backendMonitorBudgetLimits(),
  };
}

function backendMonitorBudgetLimits() {
  const marketCalls = Math.max(0, Number(process.env.BACKEND_MONITOR_DAILY_MARKET_CALL_LIMIT || 6000));
  const quoteCalls = Math.max(0, Number(process.env.BACKEND_MONITOR_DAILY_QUOTE_CALL_LIMIT || 9000));
  const trainingMarketReserve = Math.max(0, Number(process.env.BACKEND_MONITOR_TRAINING_MARKET_RESERVE || Math.round(marketCalls * 0.15)));
  const manualMarketReserve = Math.max(0, Number(process.env.BACKEND_MONITOR_MANUAL_MARKET_RESERVE || Math.round(marketCalls * 0.05)));
  const manualQuoteReserve = Math.max(0, Number(process.env.BACKEND_MONITOR_MANUAL_QUOTE_RESERVE || Math.round(quoteCalls * 0.05)));
  return {
    marketCalls,
    quoteCalls,
    factorCalls: Math.max(0, Number(process.env.BACKEND_MONITOR_DAILY_FACTOR_CALL_LIMIT || 1200)),
    aiCalls: Math.max(0, Number(process.env.BACKEND_MONITOR_DAILY_AI_CALL_LIMIT || 30)),
    trainingCalls: Math.max(0, Number(process.env.BACKEND_MONITOR_DAILY_TRAINING_CALL_LIMIT || 900)),
    notifications: Math.max(0, Number(process.env.BACKEND_MONITOR_DAILY_NOTIFICATION_LIMIT || 120)),
    trainingMarketReserve,
    manualMarketReserve,
    manualQuoteReserve,
    requestAllocation: {
      realtimeQuotesPct: 55,
      fullAnalysisPct: 25,
      minuteTrainingPct: 15,
      manualAndFailoverPct: 5,
    },
    trainingDataMix: {
      persistedHistoricalPct: Math.max(50, Math.min(95, Number(process.env.BACKEND_MONITOR_TRAINING_HISTORICAL_PCT || 70))),
      newCompletedMinuteBarsPct: Math.max(5, Math.min(50, 100 - Number(process.env.BACKEND_MONITOR_TRAINING_HISTORICAL_PCT || 70))),
    },
  };
}

function backendBudgetDate() {
  return zonedDateParts(new Date(), "Australia/Sydney").date;
}

function backendMonitorBudgetPath(date = backendBudgetDate()) {
  return join(backendMonitorBasePath, `budget-${date}.json`);
}

async function readBackendMonitorBudget(date = backendBudgetDate()) {
  try {
    const payload = JSON.parse(await readFile(backendMonitorBudgetPath(date), "utf8"));
    return payload && typeof payload === "object" ? payload : { date, used: {} };
  } catch {
    return { date, used: {} };
  }
}

async function writeBackendMonitorBudget(payload) {
  await mkdir(backendMonitorBasePath, { recursive: true });
  await writeFile(backendMonitorBudgetPath(payload.date || backendBudgetDate()), JSON.stringify(payload, null, 2), "utf8");
}

async function takeBackendMonitorBudget(bucket, units = 1, options = {}) {
  const limits = backendMonitorBudgetLimits();
  const limit = Number(limits[bucket] || 0);
  if (limit <= 0) return { ok: false, bucket, limit, used: 0, reason: `${bucket} budget disabled` };
  const budget = await readBackendMonitorBudget();
  budget.used = budget.used || {};
  const used = Number(budget.used[bucket] || 0);
  const reserve = bucket === "marketCalls"
    ? (options.manual ? 0 : Number(limits.manualMarketReserve || 0)) + (options.training ? 0 : Number(limits.trainingMarketReserve || 0))
    : bucket === "quoteCalls"
      ? options.manual ? 0 : Number(limits.manualQuoteReserve || 0)
      : 0;
  const effectiveLimit = Math.max(0, limit - reserve);
  if (used + units > effectiveLimit) {
    return { ok: false, bucket, limit, effectiveLimit, used, units, reserve, reason: `${bucket} daily budget would be exceeded` };
  }
  budget.used[bucket] = used + units;
  budget.updatedAt = new Date().toISOString();
  await writeBackendMonitorBudget(budget);
  return { ok: true, bucket, limit, effectiveLimit, used: budget.used[bucket], units, reserve };
}

function normalizeBackendHolding(holding = {}, fallbackMarket = "ASX") {
  const market = safeMarket(holding.market || fallbackMarket);
  const symbol = normalizeMarketSymbol(holding.symbol, market);
  const qty = Number(holding.qty || holding.quantity || 0);
  const avgPrice = Number(holding.avgPrice || holding.averagePrice || holding.avg_price || 0);
  if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(avgPrice) || avgPrice <= 0) return null;
  return {
    symbol,
    market,
    qty,
    avgPrice,
    entryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(holding.entryDate || "")) ? holding.entryDate : new Date().toISOString().slice(0, 10),
    source: String(holding.source || "backend-sync").slice(0, 80),
    updatedAt: holding.updatedAt || new Date().toISOString(),
  };
}

function normalizeBackendStrategy(strategy = {}) {
  return {
    horizonDays: clampFinite(strategy.horizonDays, 1, 90, 15),
    confidence: clampFinite(strategy.confidence, 1, 99, 80),
    targetUpside: clampFinite(strategy.targetUpside, 0.1, 100, 5),
    stopLoss: clampFinite(strategy.stopLoss, 0.1, 80, 4),
    maxPosition: clampFinite(strategy.maxPosition, 1, 100, 20),
    reserveCashPct: clampFinite(strategy.reserveCashPct, 0, 95, 15),
    text: String(strategy.text || "").slice(0, 1200),
  };
}

function sanitizeBackendMonitorConfig(payload = {}) {
  const defaults = backendMonitorDefaults();
  const rawMarkets = payload.markets && typeof payload.markets === "object" ? payload.markets : {};
  const watchlistsByMarket = payload.watchlistsByMarket && typeof payload.watchlistsByMarket === "object" ? payload.watchlistsByMarket : {};
  const portfolioByMarket = payload.portfolioByMarket && typeof payload.portfolioByMarket === "object" ? payload.portfolioByMarket : {};
  const flatPortfolio = Array.isArray(payload.portfolio) ? payload.portfolio : [];
  const markets = {};
  for (const market of Object.keys(MARKET_CONFIG)) {
    const raw = rawMarkets[market] || {};
    const rawWatchlist = Array.isArray(raw.watchlist) ? raw.watchlist : Array.isArray(watchlistsByMarket[market]) ? watchlistsByMarket[market] : [];
    const rawHoldings = Array.isArray(raw.portfolio)
      ? raw.portfolio
      : Array.isArray(portfolioByMarket[market])
        ? portfolioByMarket[market]
        : flatPortfolio.filter((holding) => safeMarket(holding?.market || market) === market);
    const portfolio = rawHoldings.map((holding) => normalizeBackendHolding(holding, market)).filter(Boolean);
    const holdingSymbols = portfolio.map((holding) => holding.symbol);
    const watchlist = [...new Set([
      ...holdingSymbols,
      ...rawWatchlist.map((symbol) => normalizeMarketSymbol(symbol, market)).filter(Boolean),
    ])].filter((symbol) => isValidMarketCode(symbol, market));
    markets[market] = { watchlist, portfolio };
  }
  const capitalInput = payload.capital && typeof payload.capital === "object" ? payload.capital : {};
  return {
    enabled: payload.enabled == null ? defaults.enabled : payload.enabled !== false,
    version: APP_VERSION,
    updatedAt: new Date().toISOString(),
    source: String(payload.source || "frontend-sync").slice(0, 80),
    strategy: normalizeBackendStrategy(payload.strategy || {}),
    capital: {
      baseCapital: Math.max(0, Number(capitalInput.baseCapital ?? capitalInput.totalCapital ?? 0) || 0),
      totalCapital: Math.max(0, Number(capitalInput.totalCapital ?? capitalInput.baseCapital ?? 0) || 0),
      availableCash: Math.max(0, Number(capitalInput.availableCash || 0) || 0),
      reserveCashPct: clampFinite(capitalInput.reserveCashPct, 0, 95, normalizeBackendStrategy(payload.strategy || {}).reserveCashPct),
    },
    refresh: {
      quoteHoldingMs: Math.max(30_000, Number(payload.refresh?.quoteHoldingMs || defaults.refresh.quoteHoldingMs)),
      quoteWatchMs: Math.max(60_000, Number(payload.refresh?.quoteWatchMs || defaults.refresh.quoteWatchMs)),
      holdingMs: Math.max(60_000, Number(payload.refresh?.holdingMs || defaults.refresh.holdingMs)),
      watchMs: Math.max(60_000, Number(payload.refresh?.watchMs || defaults.refresh.watchMs)),
      trainingMs: Math.max(60_000, Number(payload.refresh?.trainingMs || defaults.refresh.trainingMs)),
      checkMs: Math.max(10_000, Number(payload.refresh?.checkMs || defaults.refresh.checkMs)),
    },
    training: {
      enabled: payload.training?.enabled == null ? defaults.training.enabled : payload.training.enabled !== false,
      symbolLimit: Math.max(1, Math.min(5, Number(payload.training?.symbolLimit || defaults.training.symbolLimit))),
      interval: String(payload.training?.interval || defaults.training.interval || "5m"),
      range: String(payload.training?.range || defaults.training.range || "5d"),
    },
    notifications: {
      desktop: payload.notifications?.desktop == null ? defaults.notifications.desktop : payload.notifications.desktop !== false,
      mobile: payload.notifications?.mobile == null ? defaults.notifications.mobile : payload.notifications.mobile !== false,
    },
    markets,
  };
}

async function readBackendMonitorConfig() {
  try {
    const payload = JSON.parse(await readFile(backendMonitorConfigPath, "utf8"));
    return sanitizeBackendMonitorConfig(payload);
  } catch {
    const markets = {};
    let hasSnapshotRows = false;
    for (const market of Object.keys(MARKET_CONFIG)) {
      const snapshot = await readServerSnapshotForMarket(market).catch(() => null);
      const watchlist = Array.isArray(snapshot?.watchlist) ? snapshot.watchlist : [];
      const portfolio = Array.isArray(snapshot?.portfolio) ? snapshot.portfolio : [];
      if (watchlist.length || portfolio.length) hasSnapshotRows = true;
      markets[market] = { watchlist, portfolio };
    }
    return sanitizeBackendMonitorConfig({ source: hasSnapshotRows ? "snapshot-fallback" : "defaults", markets });
  }
}

async function writeBackendMonitorConfig(payload = {}) {
  const config = sanitizeBackendMonitorConfig(payload);
  await mkdir(backendMonitorBasePath, { recursive: true });
  await writeFile(backendMonitorConfigPath, JSON.stringify(config, null, 2), "utf8");
  return config;
}

async function readBackendMonitorRuntime() {
  try {
    const payload = JSON.parse(await readFile(backendMonitorRuntimePath, "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

async function writeBackendMonitorRuntime(runtime = {}) {
  await mkdir(backendMonitorBasePath, { recursive: true });
  await writeFile(backendMonitorRuntimePath, JSON.stringify(runtime, null, 2), "utf8");
}

async function consumeBackendMonitorRunRequest() {
  try {
    const payload = JSON.parse(await readFile(backendMonitorRunRequestPath, "utf8"));
    await unlink(backendMonitorRunRequestPath).catch(() => null);
    return payload && typeof payload === "object" ? payload : { source: "desktop-app" };
  } catch {
    return null;
  }
}

function holdingDaysFromEntry(holding = {}) {
  const entry = Date.parse(`${holding.entryDate || ""}T00:00:00Z`);
  if (!Number.isFinite(entry)) return 0;
  return Math.max(0, Math.floor((Date.now() - entry) / 86400000));
}

function backendPortfolioForMarket(config = {}, market = "ASX") {
  const key = safeMarket(market);
  return Array.isArray(config.markets?.[key]?.portfolio) ? config.markets[key].portfolio : [];
}

function backendCapitalForMarket(config = {}, market = "ASX", livePrices = new Map()) {
  const portfolio = backendPortfolioForMarket(config, market);
  const costValue = portfolio.reduce((sum, holding) => sum + Number(holding.avgPrice || 0) * Number(holding.qty || 0), 0);
  const investedValue = portfolio.reduce((sum, holding) => {
    const close = Number(livePrices.get(holding.symbol) || holding.avgPrice || 0);
    return sum + close * Number(holding.qty || 0);
  }, 0);
  const baseCapital = Number(config.capital?.baseCapital || config.capital?.totalCapital || 0);
  const unrealizedPnl = investedValue - costValue;
  const totalCapital = Math.max(0, baseCapital + unrealizedPnl);
  const reserveCashPct = Number(config.strategy?.reserveCashPct ?? config.capital?.reserveCashPct ?? 15);
  const availableCash = Math.max(0, baseCapital - costValue);
  const reservedCash = totalCapital * reserveCashPct / 100;
  return {
    baseCapital,
    totalCapital,
    investedValue,
    costValue,
    unrealizedPnl,
    investedPct: totalCapital > 0 ? investedValue / totalCapital * 100 : 0,
    availablePct: totalCapital > 0 ? Math.max(0, 100 - investedValue / totalCapital * 100) : 0,
    availableCash,
    reserveCashPct,
    reservedCash,
    availableForNewTrades: Math.max(0, availableCash - reservedCash),
  };
}

function backendDueMonitorJobs(config = {}, runtime = {}, now = Date.now()) {
  const jobs = [];
  const allowOffHours = envBool("BACKEND_MONITOR_ALLOW_OFF_HOURS_FETCH", false);
  const maxPerTick = Math.max(1, Math.min(40, Number(process.env.BACKEND_MONITOR_MAX_SYMBOLS_PER_TICK || 10)));
  for (const market of Object.keys(MARKET_CONFIG)) {
    const session = backendMarketSession(market, new Date(now));
    if (!allowOffHours && !session.open) continue;
    const marketConfig = config.markets?.[market] || {};
    const portfolio = Array.isArray(marketConfig.portfolio) ? marketConfig.portfolio : [];
    const holdings = new Map(portfolio.map((holding) => [holding.symbol, holding]));
    const watchlist = Array.isArray(marketConfig.watchlist) ? marketConfig.watchlist : [];
    for (const holding of portfolio) {
      const lastKey = `${market}:${holding.symbol}:holding`;
      const due = now - Number(runtime.lastSymbolChecks?.[lastKey] || 0) >= Number(config.refresh?.holdingMs || 5 * 60_000);
      if (due) jobs.push({ market, symbol: holding.symbol, tier: "holding", priority: 100, holding });
    }
    for (const symbol of watchlist) {
      if (holdings.has(symbol)) continue;
      const lastKey = `${market}:${symbol}:watch`;
      const due = now - Number(runtime.lastSymbolChecks?.[lastKey] || 0) >= Number(config.refresh?.watchMs || 15 * 60_000);
      if (due) jobs.push({ market, symbol, tier: "watch", priority: 40 });
    }
  }
  return jobs
    .filter((job) => isValidMarketCode(job.symbol, job.market))
    .sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol))
    .slice(0, maxPerTick);
}

function backendDueQuoteJobs(config = {}, runtime = {}, now = Date.now()) {
  const jobs = [];
  const allowOffHours = envBool("BACKEND_MONITOR_ALLOW_OFF_HOURS_FETCH", false);
  const maxPerTick = Math.max(1, Math.min(80, Number(process.env.BACKEND_MONITOR_MAX_QUOTES_PER_TICK || 24)));
  for (const market of Object.keys(MARKET_CONFIG)) {
    const session = backendMarketSession(market, new Date(now));
    if (!allowOffHours && !session.open) continue;
    const marketConfig = config.markets?.[market] || {};
    const portfolio = Array.isArray(marketConfig.portfolio) ? marketConfig.portfolio : [];
    const holdings = new Map(portfolio.map((holding) => [holding.symbol, holding]));
    const watchlist = Array.isArray(marketConfig.watchlist) ? marketConfig.watchlist : [];
    for (const holding of portfolio) {
      const lastKey = `${market}:${holding.symbol}:holding`;
      const due = now - Number(runtime.lastQuoteChecks?.[lastKey] || 0) >= Number(config.refresh?.quoteHoldingMs || 60_000);
      if (due) jobs.push({ market, symbol: holding.symbol, tier: "holding", priority: 120, holding });
    }
    for (const symbol of watchlist) {
      if (holdings.has(symbol)) continue;
      const lastKey = `${market}:${symbol}:watch`;
      const due = now - Number(runtime.lastQuoteChecks?.[lastKey] || 0) >= Number(config.refresh?.quoteWatchMs || 3 * 60_000);
      if (due) jobs.push({ market, symbol, tier: "watch", priority: 60 });
    }
  }
  return jobs
    .filter((job) => isValidMarketCode(job.symbol, job.market))
    .sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol))
    .slice(0, maxPerTick);
}

async function prepareBackendQuoteSymbol(job = {}, options = {}) {
  const market = safeMarket(job.market);
  const symbol = normalizeMarketSymbol(job.symbol, market);
  const budget = await takeBackendMonitorBudget("quoteCalls", 1, { manual: options.manual === true });
  if (!budget.ok) throw new Error(budget.reason);
  const result = await refreshVerifiedQuote(symbol, market, { force: true, maxAgeMs: options.maxAgeMs });
  return {
    market,
    symbol,
    tier: job.tier || "watch",
    quote: result.quote,
    overlay: result.overlay,
    source: result.source,
    warning: result.warning,
    updatedAt: result.updatedAt,
  };
}

function intradayModelPathForMarket(market = "ASX") {
  return join(backendMonitorBasePath, `intraday-model-${safeMarket(market).toLowerCase()}.json`);
}

function intradaySamplesPathForMarket(market = "ASX") {
  return join(backendMonitorBasePath, `intraday-samples-${safeMarket(market).toLowerCase()}.json`);
}

function intradayBarsPathForSymbol(market = "ASX", symbol = "") {
  const key = safeMarket(market);
  return join(backendMonitorBasePath, "intraday-bars", key.toLowerCase(), `${safeCachePart(cleanCode(symbol, key))}.json`);
}

async function writeIntradayBarsCache(market, symbol, candles = [], meta = {}) {
  const key = safeMarket(market);
  const rows = sanitizeCandleRows(candles, { preserveTimestamp: true })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-5000);
  if (rows.length < 5) return null;
  await mkdir(join(backendMonitorBasePath, "intraday-bars", key.toLowerCase()), { recursive: true });
  const payload = {
    market: key,
    symbol: normalizeMarketSymbol(symbol, key),
    source: meta.source || "backend-monitor-intraday",
    interval: meta.interval || "5m",
    savedAt: new Date().toISOString(),
    candles: rows,
  };
  await writeFile(intradayBarsPathForSymbol(key, symbol), JSON.stringify(payload), "utf8");
  return payload;
}

async function readIntradayBarsCache(market, symbol) {
  try {
    const payload = JSON.parse(await readFile(intradayBarsPathForSymbol(market, symbol), "utf8"));
    return sanitizeCandleRows(payload.candles || [], { preserveTimestamp: true });
  } catch {
    return [];
  }
}

async function readIntradayModel(market = "ASX") {
  try {
    return JSON.parse(await readFile(intradayModelPathForMarket(market), "utf8"));
  } catch {
    return null;
  }
}

async function readIntradaySamples(market = "ASX") {
  try {
    const payload = JSON.parse(await readFile(intradaySamplesPathForMarket(market), "utf8"));
    return Array.isArray(payload.samples) ? payload.samples : [];
  } catch {
    return [];
  }
}

function intradayFeatureVector(rows = [], index = rows.length - 1) {
  const slice = rows.slice(0, index + 1);
  const closes = slice.map((row) => Number(row.close || 0));
  const volumes = slice.map((row) => Number(row.volume || 0));
  const latest = slice.at(-1) || {};
  const close = Number(latest.close || 0);
  const macd = indicatorMacdRows(slice).histogram.at(-1) || 0;
  const avgVolume20 = indicatorSma(volumes, 20).at(-1) || 1;
  const vwapNumerator = slice.slice(-30).reduce((sum, row) => sum + Number(row.close || 0) * Number(row.volume || 0), 0);
  const vwapDenominator = slice.slice(-30).reduce((sum, row) => sum + Number(row.volume || 0), 0) || 1;
  const vwap = vwapNumerator / vwapDenominator;
  const range = Math.max(0.000001, Number(latest.high || close) - Number(latest.low || close));
  return {
    ret1: pctChange(close, closes.at(-2)) / 2,
    ret3: pctChange(close, closes.at(-4)) / 4,
    ret6: pctChange(close, closes.at(-7)) / 6,
    ret12: pctChange(close, closes.at(-13)) / 8,
    volumeRatio: ((Number(latest.volume || 0) / Math.max(1, avgVolume20)) - 1),
    rsi: (indicatorRsi(closes) - 50) / 50,
    macdPct: close > 0 ? macd / close * 100 : 0,
    vwapGap: close > 0 ? pctChange(close, vwap) / 4 : 0,
    rangePosition: ((close - Number(latest.low || close)) / range - 0.5),
  };
}

function intradaySampleRows(market, symbol, candles = [], horizonBars = 3) {
  const rows = sanitizeCandleRows(candles, { preserveTimestamp: true })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const samples = [];
  for (let index = 35; index < rows.length - horizonBars - 1; index += 1) {
    const current = rows[index];
    const future = rows[index + horizonBars];
    const close = Number(current.close || 0);
    if (!close || !future?.close) continue;
    const feature = intradayFeatureVector(rows, index);
    const returnPct = pctChange(Number(future.close || 0), close);
    samples.push({
      id: `${safeMarket(market)}:${normalizeMarketSymbol(symbol, market)}:${current.date}:${horizonBars}`,
      market: safeMarket(market),
      symbol: normalizeMarketSymbol(symbol, market),
      timestamp: current.date,
      horizonBars,
      close,
      returnPct,
      label: returnPct > 0 ? 1 : 0,
      feature,
      createdAt: new Date().toISOString(),
    });
  }
  return samples;
}

function trainIntradayLinearModel(samples = []) {
  const rows = samples.filter((sample) => sample?.feature && Number.isFinite(Number(sample.returnPct)));
  const featureNames = ["ret1", "ret3", "ret6", "ret12", "volumeRatio", "rsi", "macdPct", "vwapGap", "rangePosition"];
  if (rows.length < 40) {
    return { available: false, sampleCount: rows.length, reason: "intraday model needs at least 40 completed minute-bar samples" };
  }
  const train = rows.slice(0, Math.floor(rows.length * 0.78));
  const test = rows.slice(train.length);
  const means = {};
  const scales = {};
  featureNames.forEach((name) => {
    const values = train.map((row) => Number(row.feature[name] || 0)).filter(Number.isFinite);
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
    means[name] = mean;
    scales[name] = Math.sqrt(variance) || 1;
  });
  const weights = Object.fromEntries(featureNames.map((name) => [name, 0]));
  let intercept = 0;
  const lr = 0.018;
  const ridge = 0.004;
  const epochs = Math.max(12, Math.min(80, Math.floor(600_000 / Math.max(1, train.length))));
  const scoreRow = (row) => intercept + featureNames.reduce((sum, name) => sum + weights[name] * ((Number(row.feature[name] || 0) - means[name]) / scales[name]), 0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const row of train) {
      const pred = scoreRow(row);
      const error = pred - Number(row.returnPct || 0);
      intercept -= lr * error * 0.15;
      featureNames.forEach((name) => {
        const z = (Number(row.feature[name] || 0) - means[name]) / scales[name];
        weights[name] -= lr * (error * z + ridge * weights[name]);
      });
    }
  }
  const evaluate = (dataset) => {
    if (!dataset.length) return { count: 0, directionalAccuracy: 0, mae: 0, avgReturn: 0 };
    let hits = 0;
    let mae = 0;
    let avgReturn = 0;
    dataset.forEach((row) => {
      const pred = scoreRow(row);
      const actual = Number(row.returnPct || 0);
      if ((pred >= 0) === (actual >= 0)) hits += 1;
      mae += Math.abs(pred - actual);
      avgReturn += actual;
    });
    return {
      count: dataset.length,
      directionalAccuracy: hits / dataset.length * 100,
      mae: mae / dataset.length,
      avgReturn: avgReturn / dataset.length,
    };
  };
  return {
    available: true,
    framework: "local-minute-ridge-no-future-labels",
    sampleCount: rows.length,
    featureNames,
    means,
    scales,
    weights,
    intercept,
    epochs,
    train: evaluate(train),
    test: evaluate(test),
    updatedAt: new Date().toISOString(),
  };
}

function evaluateIntradayModel(model, feature = {}) {
  if (!model?.available || !Array.isArray(model.featureNames)) return null;
  const score = Number(model.intercept || 0) + model.featureNames.reduce((sum, name) => {
    const raw = Number(feature[name] || 0);
    const mean = Number(model.means?.[name] || 0);
    const scale = Math.max(1e-9, Number(model.scales?.[name] || 1));
    return sum + Number(model.weights?.[name] || 0) * ((raw - mean) / scale);
  }, 0);
  return score;
}

async function minuteLearningFactorFor(symbol, market = "ASX", intradayCandles = null) {
  const key = safeMarket(market);
  const model = await readIntradayModel(key);
  if (!model?.available) {
    return { available: false, source: "minute-learning-pending", score: 0, confidence: 0, thesis: ["分钟级本地模型仍在收集训练样本。"] };
  }
  let candles = intradayCandles;
  if (!candles?.length) {
    candles = await readIntradayBarsCache(key, symbol);
  }
  const rows = sanitizeCandleRows(candles || [], { preserveTimestamp: true }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (rows.length < 36) {
    return {
      available: true,
      source: "minute-learning-model-no-live-bars",
      score: 0,
      confidence: Math.max(0, Math.min(65, Number(model.test?.directionalAccuracy || 0))),
      thesis: [`分钟级模型已训练 ${model.sampleCount || 0} 个样本，但当前股票缺少足够分钟K线，暂不施加强方向。`],
      values: { model },
    };
  }
  const feature = intradayFeatureVector(rows, rows.length - 1);
  const predicted = evaluateIntradayModel(model, feature);
  const testAccuracy = Number(model.test?.directionalAccuracy || 0);
  const score = clampFinite(Number(predicted || 0) * 10, -8, 8);
  return {
    available: true,
    source: "minute-learning-local-ridge",
    score,
    weight: Math.min(8, Math.max(1, Number(model.sampleCount || 0) / 120)),
    confidence: clampFinite(35 + Math.max(0, testAccuracy - 50) * 1.2 + Math.min(10, Number(model.sampleCount || 0) / 80), 0, 78),
    thesis: [
      `分钟级学习模型：${model.sampleCount || 0} 个无未来函数样本，测试方向命中 ${testAccuracy.toFixed(0)}%，预测未来数根K线收益 ${Number(predicted || 0).toFixed(3)}%。`,
      "该因子只作为短线执行/入场 timing 辅助，不覆盖日线级策略判断。",
    ],
    values: { predictedReturnPct: Number(Number(predicted || 0).toFixed(4)), feature, modelUpdatedAt: model.updatedAt, test: model.test },
  };
}

async function runBackendIntradayTraining(config = {}, runtime = {}) {
  if (config.training?.enabled === false) return null;
  const now = Date.now();
  const last = Number(runtime.lastTrainingAt || 0);
  if (now - last < Number(config.refresh?.trainingMs || 5 * 60_000)) return null;
  const allowOffHours = envBool("BACKEND_MONITOR_ALLOW_OFF_HOURS_FETCH", false);
  const results = [];
  for (const market of Object.keys(MARKET_CONFIG)) {
    const session = backendMarketSession(market);
    if (!allowOffHours && !session.open) continue;
    const portfolio = backendPortfolioForMarket(config, market);
    const watchlist = config.markets?.[market]?.watchlist || [];
    const symbols = [...new Set([
      ...portfolio.map((holding) => holding.symbol),
      ...watchlist,
    ])].slice(0, Number(config.training?.symbolLimit || 3));
    if (!symbols.length) continue;
    const collected = [];
    for (const symbol of symbols) {
      const trainingBudget = await takeBackendMonitorBudget("trainingCalls", 1, { training: true });
      const marketBudget = await takeBackendMonitorBudget("marketCalls", 1, { training: true });
      if (!trainingBudget.ok || !marketBudget.ok) {
        results.push({ market, symbol, skipped: true, reason: trainingBudget.reason || marketBudget.reason });
        continue;
      }
      try {
        const marketData = await fetchMarketCandles(symbol, config.training?.range || "5d", config.training?.interval || "5m", market);
        await writeIntradayBarsCache(market, symbol, marketData.candles || [], { source: marketData.source, interval: config.training?.interval || "5m" }).catch(() => null);
        const samples = intradaySampleRows(market, symbol, marketData.candles || [], 3);
        collected.push(...samples);
        results.push({ market, symbol, candles: marketData.candles?.length || 0, samples: samples.length, source: marketData.source });
      } catch (error) {
        results.push({ market, symbol, error: error.message || String(error) });
      }
    }
    const previous = await readIntradaySamples(market);
    const freshById = new Map(collected.map((sample) => [sample.id, sample]));
    const historicalById = new Map(previous.filter((sample) => !freshById.has(sample.id)).map((sample) => [sample.id, sample]));
    const maxSamples = Math.max(500, Number(process.env.BACKEND_MONITOR_INTRADAY_SAMPLE_LIMIT || 50000));
    const historicalPct = backendMonitorBudgetLimits().trainingDataMix.persistedHistoricalPct;
    const freshTarget = Math.max(1, Math.floor(maxSamples * (100 - historicalPct) / 100));
    const freshRows = [...freshById.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const historicalRows = [...historicalById.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const initialFresh = freshRows.slice(0, freshTarget);
    const selectedHistorical = historicalRows.slice(0, Math.max(0, maxSamples - initialFresh.length));
    const remainingFreshCapacity = Math.max(0, maxSamples - selectedHistorical.length);
    const selectedFresh = freshRows.slice(0, remainingFreshCapacity);
    const samples = [...selectedHistorical, ...selectedFresh]
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const datasetSignature = `${samples.length}:${samples[0]?.id || ""}:${samples.at(-1)?.id || ""}`;
    const existingModel = await readIntradayModel(market);
    if (existingModel?.datasetSignature === datasetSignature) {
      results.push({ market, reusedModel: true, sampleCount: samples.length, reason: "no newly completed minute-bar sample" });
      continue;
    }
    const model = trainIntradayLinearModel(samples);
    await mkdir(backendMonitorBasePath, { recursive: true });
    await writeFile(intradaySamplesPathForMarket(market), JSON.stringify({ market, updatedAt: new Date().toISOString(), samples }, null, 2), "utf8");
    await writeFile(intradayModelPathForMarket(market), JSON.stringify({ market, ...model, datasetSignature, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    if (model.available) {
      await appendModelChangeLogFile(market, {
        event_type: "model-change-log-minute-learning",
        entity_id: `${market}:minute-learning:${new Date().toISOString()}`,
        payload: {
          title: "分钟级本地模型已后台更新",
          type: "minute-learning",
          market,
          sampleCount: model.sampleCount,
          epochs: model.epochs,
          test: model.test,
          featureNames: model.featureNames,
          guardrails: ["只使用已完成K线生成标签", "最新K线只用于推理不用于标签", "默认仅辅助加权，避免过拟合"],
        },
      }).catch(() => null);
    }
  }
  const summary = { updatedAt: new Date().toISOString(), results };
  backendMonitorState.lastTrainingAt = summary.updatedAt;
  backendMonitorState.lastTraining = summary;
  runtime.lastTrainingAt = now;
  return summary;
}

function backendAlertKey(alert = {}) {
  return `${backendBudgetDate()}:${alert.market}:${alert.type}:${alert.symbol}`;
}

async function appendBackendAlert(alert = {}) {
  await mkdir(backendMonitorBasePath, { recursive: true });
  await appendFile(backendMonitorAlertPath, `${JSON.stringify({ createdAt: new Date().toISOString(), ...alert })}\n`, "utf8");
}

async function sendDesktopNotification(title, body) {
  if (!envBool("BACKEND_MONITOR_DESKTOP_NOTIFICATIONS", true)) return { ok: false, skipped: true, reason: "desktop notifications disabled" };
  return new Promise((resolve) => {
    const script = `display notification ${JSON.stringify(String(body || "").slice(0, 260))} with title ${JSON.stringify(String(title || "Quant Watch").slice(0, 80))}`;
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.on("close", (code) => resolve({ ok: code === 0, code }));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
  });
}

async function postJsonNotification(url, payload, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.BACKEND_MONITOR_PUSH_TIMEOUT_MS || 4500));
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMobileNotification(alert = {}) {
  if (!envBool("BACKEND_MONITOR_MOBILE_NOTIFICATIONS", true)) return { ok: false, skipped: true, reason: "mobile notifications disabled" };
  const payload = {
    title: alert.title,
    body: alert.message,
    market: alert.market,
    symbol: alert.symbol,
    action: alert.action,
    severity: alert.severity,
    price: alert.price,
    generatedAt: alert.generatedAt,
  };
  const results = [];
  if (process.env.MOBILE_PUSH_WEBHOOK_URL) {
    results.push({ provider: "webhook", ...(await postJsonNotification(process.env.MOBILE_PUSH_WEBHOOK_URL, payload).catch((error) => ({ ok: false, error: error.message }))) });
  }
  if (process.env.BARK_PUSH_URL) {
    const base = process.env.BARK_PUSH_URL.replace(/\/$/, "");
    const url = `${base}/${encodeURIComponent(alert.title || "Quant Watch")}/${encodeURIComponent(alert.message || "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.BACKEND_MONITOR_PUSH_TIMEOUT_MS || 4500));
    try {
      const response = await fetch(url, { signal: controller.signal });
      results.push({ provider: "bark", ok: response.ok, status: response.status });
    } catch (error) {
      results.push({ provider: "bark", ok: false, error: error.message });
    } finally {
      clearTimeout(timer);
    }
  }
  if (process.env.PUSHPLUS_TOKEN) {
    results.push({ provider: "pushplus", ...(await postJsonNotification("https://www.pushplus.plus/send", {
      token: process.env.PUSHPLUS_TOKEN,
      title: alert.title,
      content: alert.message,
      template: "txt",
    }).catch((error) => ({ ok: false, error: error.message }))) });
  }
  if (process.env.SERVERCHAN_SENDKEY) {
    results.push({ provider: "serverchan", ...(await postJsonNotification(`https://sctapi.ftqq.com/${process.env.SERVERCHAN_SENDKEY}.send`, {
      title: alert.title,
      desp: alert.message,
    }).catch((error) => ({ ok: false, error: error.message }))) });
  }
  if (!results.length) return { ok: false, skipped: true, reason: "no mobile push provider configured" };
  return { ok: results.some((row) => row.ok), results };
}

function backendAlertFromAnalysis(result = {}, input = {}) {
  const analysis = result.analysis || {};
  const technicals = result.technicals || input.technicals || {};
  const holding = input.holding || null;
  const strategy = input.strategy || {};
  const action = String(analysis.action || "HOLD_WATCH");
  const price = Number(technicals.close || 0);
  if (["STRONG_BUY", "WATCH_BUY", "LIGHT_BUY"].includes(action)) {
    return {
      type: holding ? "ADD" : "BUY",
      severity: "buy",
      title: `${result.symbol} ${action === "STRONG_BUY" ? "强买入" : holding ? "补仓观察" : "买入提醒"}`,
      message: `后端监控触发：周期结束 ${Number(analysis.projectedFinalReturn ?? analysis.projectedUpside ?? 0).toFixed(2)}%，策略达标 ${Number(analysis.strategyHitProbability || 0).toFixed(0)}%，综合置信 ${Number(analysis.confidence || 0).toFixed(0)}%，现价 ${price.toFixed(3)}。`,
    };
  }
  if (holding && action === "CRITICAL_SELL") {
    return {
      type: "SELL_CRITICAL",
      severity: "sell",
      title: `${result.symbol} 后端卖出警报`,
      message: `后端监控触发：${result.symbol} 出现最严风险信号，现价 ${price.toFixed(3)}，均价 ${Number(holding.avgPrice || 0).toFixed(3)}，下跌风险 ${Number(analysis.downsideConfidence || 0).toFixed(0)}%。`,
    };
  }
  if (holding && price > 0 && Number(holding.avgPrice || 0) > 0) {
    const pnlPct = pctChange(price, Number(holding.avgPrice || 0));
    if (pnlPct <= -Math.abs(Number(strategy.stopLoss || 4))) {
      return {
        type: "SELL_STOP",
        severity: "sell",
        title: `${result.symbol} 止损卖出提醒`,
        message: `后端监控触发：现价 ${price.toFixed(3)}，相对均价 ${pnlPct.toFixed(2)}%，已触发 ${Number(strategy.stopLoss || 4).toFixed(1)}% 止损线。`,
      };
    }
  }
  return null;
}

async function maybeSendBackendAlert(alert = {}, runtime = {}) {
  if (!alert?.title) return null;
  const dedupeMs = Math.max(60_000, Number(process.env.BACKEND_MONITOR_ALERT_DEDUPE_MS || 2 * 60 * 60_000));
  const key = backendAlertKey(alert);
  runtime.sentAlerts = runtime.sentAlerts || {};
  const last = Number(runtime.sentAlerts[key] || 0);
  if (Date.now() - last < dedupeMs) return { skipped: true, reason: "deduped", key };
  const budget = await takeBackendMonitorBudget("notifications", 1);
  if (!budget.ok) return { skipped: true, reason: budget.reason, key };
  runtime.sentAlerts[key] = Date.now();
  const generated = { ...alert, key, generatedAt: new Date().toISOString() };
  await appendBackendAlert(generated).catch(() => null);
  const [desktop, mobile] = await Promise.all([
    sendDesktopNotification(generated.title, generated.message).catch((error) => ({ ok: false, error: error.message })),
    sendMobileNotification(generated).catch((error) => ({ ok: false, error: error.message })),
  ]);
  const sent = { ...generated, desktop, mobile };
  backendMonitorState.lastAlerts = [sent, ...(backendMonitorState.lastAlerts || [])].slice(0, 20);
  return sent;
}

async function prepareBackendMonitorSymbol(job = {}, config = {}) {
  const market = safeMarket(job.market);
  const symbol = normalizeMarketSymbol(job.symbol, market);
  const strategy = normalizeBackendStrategy(config.strategy || {});
  const marketBudget = await takeBackendMonitorBudget("marketCalls", 1);
  if (!marketBudget.ok) throw new Error(marketBudget.reason);
  let marketData;
  let marketError = null;
  try {
    marketData = await fetchMarketCandles(symbol, process.env.BACKEND_MONITOR_DAILY_RANGE || "1y", "1d", market);
  } catch (error) {
    marketError = error;
    marketData = await fetchCachedMarketHistory(symbol, process.env.BACKEND_MONITOR_DAILY_RANGE || "1y", "1d", market, error);
  }
  if (!marketData?.candles?.length) throw marketError || new Error(`No monitor candles for ${symbol}`);
  const latest = latestByDate(marketData.candles);
  let realtimeQuote = null;
  try {
    const requireFreshQuote = backendMarketSession(market).open;
    realtimeQuote = await fetchRealtimeQuote(symbol, market, latest?.close, { strict: requireFreshQuote });
    if ((!realtimeQuote || realtimeQuote.unavailable) && !requireFreshQuote) {
      realtimeQuote = marketData.quote && !marketData.quote.unavailable
        ? normalizeQuote(marketData.quote, market, latest?.close)
        : null;
    }
  } catch {
    realtimeQuote = null;
  }
  const quoteCheck = sanitizeQuoteChangeAgainstCandles(symbol, market, marketData.candles, realtimeQuote);
  realtimeQuote = quoteCheck.quote;
  const candles = mergeQuoteIntoCandles(marketData.candles, realtimeQuote, market)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  await writeMarketHistoryCache(market, symbol, "1d", candles, { ...marketData, quote: realtimeQuote }).catch(() => null);
  const predictionCandles = predictionCandlesWithQuote(candles, realtimeQuote, market);
  const technicals = {
    ...computeServerTechnicals(predictionCandles),
    livePriceOverlay: Boolean(realtimeQuote?.price),
    priceSource: realtimeQuote?.source || marketData.source || "verified-candle",
    priceAsOf: realtimeQuote?.asOf || realtimeQuote?.retrievedAt || candleDate(candles.at(-1)) || null,
    priceTimeVerified: realtimeQuote ? realtimeQuote.timeVerified !== false : true,
    priceDelayed: realtimeQuote ? realtimeQuote.delayed !== false : true,
  };
  const analog = computeServerHistoricalAnalog(predictionCandles, Number(strategy.horizonDays || 15), Number(strategy.horizonDays || 15), strategy);
  const livePrices = new Map([[symbol, technicals.close]]);
  const holding = (backendPortfolioForMarket(config, market)).find((row) => row.symbol === symbol) || null;
  const factorBudget = await takeBackendMonitorBudget("factorCalls", 1).catch((error) => ({ ok: false, reason: error.message }));
  let factorLayer = null;
  if (factorBudget.ok) {
    factorLayer = await fetchFactorLayer(symbol, strategy, market).catch((error) => ({
      factors: {
        minuteLearning: { available: false, source: "factor-layer-unavailable", score: 0, confidence: 0, thesis: [`Factor layer unavailable: ${error.message || error}`] },
      },
      warning: error.message || String(error),
    }));
  }
  const minuteFactor = await minuteLearningFactorFor(symbol, market).catch((error) => ({
    available: false,
    source: "minute-learning-unavailable",
    score: 0,
    confidence: 0,
    thesis: [`Minute learning unavailable: ${error.message || error}`],
  }));
  const factors = { ...(factorLayer?.factors || {}), minuteLearning: minuteFactor };
  const newsBundle = await fetchNewsItems(symbol, market, "all", { mode: "local" }).catch(() => ({ news: [] }));
  const calibrationSummary = await summarizePredictionSamplesWithLocalModel(await readPredictionSamples(market), market).catch(() => null);
  const input = {
    symbol,
    market,
    marketLabel: MARKET_CONFIG[market].label,
    currency: MARKET_CONFIG[market].currency,
    strategy,
    capital: backendCapitalForMarket(config, market, livePrices),
    holding: holding ? { ...holding, holdingDays: holdingDaysFromEntry(holding) } : null,
    technicals,
    analog,
    fundamentals: null,
    xPosts: [],
    youtubeItems: [],
    news: newsBundle.news || [],
    factors,
    researchConfig: {},
    marketValidation: marketData.validation || null,
    calibrationSummary,
  };
  const local = localAnalysisEnvelope(input, "backend-monitor-local");
  let analysis = local.analysis;
  let source = local.source;
  const aiEnabled = envBool("BACKEND_MONITOR_AI_ENABLED", false);
  const highImpact = ["STRONG_BUY", "WATCH_BUY", "CRITICAL_SELL", "STRONG_AVOID"].includes(analysis.action);
  if (aiEnabled && highImpact) {
    const aiBudget = await takeBackendMonitorBudget("aiCalls", 1).catch((error) => ({ ok: false, reason: error.message }));
    if (aiBudget.ok) {
      const ai = await openAiBatchAnalysis([input]).catch(() => null);
      const row = ai?.results?.[0];
      if (row?.analysis) {
        analysis = row.analysis;
        source = row.source || ai.source || "backend-monitor-ai";
      }
    }
  }
  return {
    symbol,
    market,
    tier: job.tier,
    source,
    marketSource: marketData.source,
    marketWarning: [marketData.warning, quoteCheck.warning].filter(Boolean).join(" | "),
    quote: realtimeQuote,
    candles,
    technicals,
    analog,
    factors,
    news: newsBundle.news || [],
    analysis,
    input,
    updatedAt: new Date().toISOString(),
  };
}

function paperAgentItemFromMonitorResult(result = {}) {
  const market = safeMarket(result.market);
  const session = backendMarketSession(market);
  const lastCandle = Array.isArray(result.candles) ? result.candles.at(-1) : null;
  const quote = compactPersistedQuote(result.quote, market);
  const barTs = String(quote?.asOf || quote?.retrievedAt || lastCandle?.date || result.updatedAt || "");
  const localDate = String(session.localTime || "").slice(0, 10);
  const barDate = barTs.slice(0, 10);
  const source = String(quote?.source || result.marketSource || "");
  const quoteTime = Date.parse(quote?.asOf || quote?.retrievedAt || "");
  const quoteAgeMs = Number.isFinite(quoteTime) ? Math.max(0, Date.now() - quoteTime) : Infinity;
  const freshQuote = Boolean(
    quote
    && quote.timeVerified !== false
    && quote.asOf
    && quoteAgeMs <= Number(process.env.PAPER_AGENT_QUOTE_MAX_AGE_MS || realtimeQuoteMaxAgeMs(market)),
  );
  return {
    market,
    symbol: result.symbol,
    price: Number(result.technicals?.close || lastCandle?.close || 0),
    priceTs: barTs,
    barTs,
    source,
    fresh: Boolean(session.open && (freshQuote || (barDate && localDate && barDate === localDate))),
    analysis: result.analysis || {},
    technicals: result.technicals || {},
    factors: result.factors || {},
    news: result.news || [],
    marketValidation: result.input?.marketValidation || null,
    updatedAt: result.updatedAt || new Date().toISOString(),
  };
}

async function runPaperAgentsForMonitorResults(results = [], config = {}, runtime = {}) {
  const usable = results.filter((row) => row?.symbol && !row.error);
  const groups = Map.groupBy
    ? Map.groupBy(usable, (row) => safeMarket(row.market))
    : usable.reduce((map, row) => map.set(safeMarket(row.market), [...(map.get(safeMarket(row.market)) || []), row]), new Map());
  const summaries = [];
  for (const [market, rows] of groups) {
    const session = backendMarketSession(market);
    const items = rows.map(paperAgentItemFromMonitorResult);
    const summary = await runPythonQuantCore("paper-agent-step", {
      market,
      marketOpen: session.open,
      marketBias: 0,
      strategy: normalizeBackendStrategy(config.strategy || {}),
      items,
    }, Number(process.env.PAPER_AGENT_STEP_TIMEOUT_MS || 30_000));
    summaries.push({ market, revision: summary.revision, events: summary.events || [], rejected: summary.rejected || [] });
    for (const event of summary.events || []) {
      runtimeEvents.publish("paper-agent.trade", event);
      if (config.notifications?.desktop !== false || config.notifications?.mobile !== false) {
        await maybeSendBackendAlert({
          type: event.side === "BUY" ? "PAPER_BUY" : "PAPER_SELL",
          severity: event.side === "BUY" ? "buy" : "sell",
          market,
          symbol: event.symbol,
          action: event.side,
          price: event.price,
          title: `${event.symbol} Paper Agent ${event.side === "BUY" ? "买入" : "卖出"}`,
          message: `${event.agentName} 以真实行情 ${Number(event.price || 0).toFixed(3)} 生成 Paper ${event.side} ${event.qty} 股；${event.reason}。未发送真实订单。`,
          reason: event.reason,
        }, runtime).catch(() => null);
      }
    }
  }
  return summaries;
}

function marketQuoteEventFromMonitorResult(result = {}) {
  const market = safeMarket(result.market);
  const latest = latestByDate(result.candles || []);
  const previousRows = sanitizeCandleRows(result.candles || []).sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const previous = previousRows.length > 1 ? previousRows.at(-2) : null;
  const quote = compactPersistedQuote(result.quote, market);
  const freshness = realtimeQuoteQuality(quote, market, new Date(), { strict: true, symbol: result.symbol });
  const price = positiveMarketNumber(quote?.price, positiveMarketNumber(latest?.close));
  if (!result.symbol || !price) return null;
  const previousClose = positiveMarketNumber(quote?.previousClose, positiveMarketNumber(previous?.close));
  const change = Number.isFinite(Number(quote?.change)) ? Number(quote.change) : previousClose ? price - previousClose : null;
  const changePercent = Number.isFinite(Number(quote?.changePercent))
    ? Number(quote.changePercent)
    : previousClose ? change / previousClose * 100 : null;
  return {
    market,
    symbol: normalizeMarketSymbol(result.symbol, market) || result.symbol,
    price,
    previousClose,
    change: Number.isFinite(change) ? Number(change.toFixed(4)) : null,
    changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(4)) : null,
    dataAsOf: quote ? quote.asOf || (quote.timeVerified ? quote.date : null) || null : candleDate(latest) || null,
    retrievedAt: quote?.retrievedAt || result.updatedAt || new Date().toISOString(),
    source: quote?.source || result.marketSource || "backend-monitor",
    delayed: quote ? quote.delayed !== false : true,
    stale: backendMarketSession(market).open && !freshness.usable,
    timeVerified: quote ? quote.timeVerified : Boolean(candleDate(latest)),
    freshnessAgeMs: quote?.freshnessAgeMs ?? (Number.isFinite(freshness.ageMs) ? Math.max(0, freshness.ageMs) : null),
    crossCheckStatus: quote?.crossCheckStatus || null,
    crossCheckSources: quote?.crossCheckSources || [],
    warning: quote?.warning || null,
    latestCandle: latest ? { ...latest } : null,
    analysisAsOf: result.updatedAt || null,
    analysisPrice: Number(result.technicals?.close || 0) || null,
  };
}

function snapshotAnalysisFromMonitorResult(result = {}) {
  const market = safeMarket(result.market);
  const symbol = normalizeMarketSymbol(result.symbol, market);
  if (!symbol || !result.analysis?.action || !hasRequiredSnapshotTechnicals(result.technicals) || !hasUsableSnapshotCandles(result.candles)) return null;
  const quote = compactPersistedQuote(result.quote, market);
  const analysisAsOf = result.updatedAt || new Date().toISOString();
  return {
    symbol,
    market,
    tier: result.tier || "watch",
    source: result.source || "backend-monitor-local",
    marketSource: result.marketSource || quote?.source || "backend-monitor",
    marketWarning: result.marketWarning || "",
    quote,
    candles: sanitizeCandleRows(result.candles).slice(-260),
    technicals: result.technicals,
    analog: result.analog || null,
    factors: result.factors || null,
    news: Array.isArray(result.news) ? result.news.slice(0, 20) : [],
    fundamentals: result.input?.fundamentals || null,
    xPosts: [],
    youtubeItems: [],
    analysis: result.analysis,
    marketValidation: result.input?.marketValidation || null,
    analysisAsOf,
    signalRefreshedAt: analysisAsOf,
    updatedAt: analysisAsOf,
    analysisPrice: Number(result.technicals?.close || 0) || null,
    marketDataAsOf: quote?.asOf || null,
    marketRetrievedAt: quote?.retrievedAt || analysisAsOf,
    analysisNeedsRefresh: false,
  };
}

function marketAnalysisEventFromMonitorResult(result = {}) {
  return snapshotAnalysisFromMonitorResult(result);
}

async function persistBackendMonitorSnapshots(results = []) {
  const usable = results.map(snapshotAnalysisFromMonitorResult).filter(Boolean);
  const groups = usable.reduce((map, row) => {
    const rows = map.get(row.market) || [];
    rows.push(row);
    map.set(row.market, rows);
    return map;
  }, new Map());
  for (const [market, rows] of groups) {
    const existing = await readServerSnapshotForMarket(market);
    const bySymbol = new Map((existing?.analyses || []).map((row) => [cleanCode(row.symbol, market), row]));
    rows.forEach((row) => bySymbol.set(cleanCode(row.symbol, market), row));
    const analyses = [...bySymbol.values()];
    const known = new Set(analyses.map((row) => cleanCode(row.symbol, market)));
    const existingWatchlist = (existing?.watchlist || []).filter((symbol) => known.has(cleanCode(symbol, market)));
    const watchlist = [...new Set([...existingWatchlist, ...rows.map((row) => row.symbol)])];
    await writeServerSnapshot({
      ...(existing || {}),
      market,
      watchlist,
      portfolio: existing?.portfolio || [],
      selected: known.has(cleanCode(existing?.selected, market)) ? existing.selected : rows[0]?.symbol,
      analyses,
      updatedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      reason: "backend-monitor-live-analysis",
    });
  }
}

async function runBackendQuoteRefreshJobs(config = {}, runtime = {}) {
  runtime.lastQuoteChecks = runtime.lastQuoteChecks || {};
  const jobs = backendDueQuoteJobs(config, runtime);
  const concurrency = Math.max(1, Math.min(10, Number(process.env.BACKEND_MONITOR_QUOTE_CONCURRENCY || 6)));
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      const key = `${job.market}:${job.symbol}:${job.tier}`;
      try {
        const result = await prepareBackendQuoteSymbol(job);
        results.push(result);
        if (result.overlay) runtimeEvents.publish("market.quote", result.overlay);
      } catch (error) {
        results.push({
          market: job.market,
          symbol: job.symbol,
          tier: job.tier,
          error: error.message || String(error),
          updatedAt: new Date().toISOString(),
        });
      } finally {
        runtime.lastQuoteChecks[key] = Date.now();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () => worker()));
  runtime.lastQuoteResults = results.slice(-80).map((row) => ({
    market: row.market,
    symbol: row.symbol,
    tier: row.tier,
    price: row.overlay?.price ?? row.quote?.price ?? null,
    dataAsOf: row.overlay?.dataAsOf ?? row.quote?.asOf ?? null,
    source: row.source || row.overlay?.source || null,
    crossCheckStatus: row.overlay?.crossCheckStatus || row.quote?.crossCheckStatus || null,
    error: row.error || null,
    updatedAt: row.updatedAt,
  }));
  backendMonitorState.lastQuotes = runtime.lastQuoteResults;
  return { jobs: jobs.length, results };
}

async function runBackendMonitorTick(reason = "interval") {
  if (backendMonitorTickRunning) return { skipped: true, reason: "already-running" };
  backendMonitorTickRunning = true;
  backendMonitorState.running = true;
  backendMonitorState.lastTickAt = new Date().toISOString();
  const runtime = await readBackendMonitorRuntime();
  runtime.lastSymbolChecks = runtime.lastSymbolChecks || {};
  runtime.lastQuoteChecks = runtime.lastQuoteChecks || {};
  try {
    const config = await readBackendMonitorConfig();
    backendMonitorState.enabled = Boolean(config.enabled);
    if (!config.enabled) return { skipped: true, reason: "backend monitor disabled" };
    const quoteRefresh = await runBackendQuoteRefreshJobs(config, runtime).catch((error) => {
      backendMonitorState.lastError = `quotes: ${error.message || error}`;
      return { jobs: 0, results: [] };
    });
    const training = await runBackendIntradayTraining(config, runtime).catch((error) => {
      backendMonitorState.lastError = `training: ${error.message || error}`;
      return null;
    });
    const jobs = backendDueMonitorJobs(config, runtime);
    const concurrency = Math.max(1, Math.min(6, Number(process.env.BACKEND_MONITOR_CONCURRENCY || 2)));
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        const job = jobs[cursor];
        cursor += 1;
        try {
          const result = await prepareBackendMonitorSymbol(job, config);
          results.push(result);
          runtime.lastSymbolChecks[`${job.market}:${job.symbol}:${job.tier}`] = Date.now();
          const quoteEvent = marketQuoteEventFromMonitorResult(result);
          if (quoteEvent) runtimeEvents.publish("market.quote", quoteEvent);
          const analysisEvent = marketAnalysisEventFromMonitorResult(result);
          if (analysisEvent) runtimeEvents.publish("market.analysis", analysisEvent);
          const alert = backendAlertFromAnalysis(result, result.input);
          if (alert) {
            await maybeSendBackendAlert({
              ...alert,
              market: job.market,
              symbol: result.symbol,
              action: result.analysis?.action,
              price: result.technicals?.close,
              tier: job.tier,
              reason,
            }, runtime);
          }
        } catch (error) {
          results.push({ market: job.market, symbol: job.symbol, tier: job.tier, error: error.message || String(error), updatedAt: new Date().toISOString() });
          runtime.lastSymbolChecks[`${job.market}:${job.symbol}:${job.tier}`] = Date.now();
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () => worker()));
    await persistBackendMonitorSnapshots(results).catch((error) => {
      backendMonitorState.lastError = `snapshot: ${error.message || error}`;
    });
    const paperAgents = await runPaperAgentsForMonitorResults(results, config, runtime).catch((error) => {
      backendMonitorState.lastError = `paper-agents: ${error.message || error}`;
      runtimeEvents.publish("paper-agent.error", { error: error.message || String(error) });
      return [];
    });
    runtime.lastRunAt = new Date().toISOString();
    runtime.lastReason = reason;
    runtime.lastTrainingAt = runtime.lastTrainingAt || 0;
    runtime.lastResults = results.slice(-40).map((row) => ({
      market: row.market,
      symbol: row.symbol,
      tier: row.tier,
      action: row.analysis?.action || null,
      confidence: row.analysis?.confidence ?? null,
      projectedFinalReturn: row.analysis?.projectedFinalReturn ?? row.analysis?.projectedUpside ?? null,
      price: row.technicals?.close ?? null,
      source: row.source || null,
      error: row.error || null,
      updatedAt: row.updatedAt,
    }));
    if (training) runtime.lastTrainingSummary = training;
    runtime.lastPaperAgents = paperAgents;
    await writeBackendMonitorRuntime(runtime);
    backendMonitorState.lastRunAt = runtime.lastRunAt;
    backendMonitorState.lastAnalyses = runtime.lastResults;
    backendMonitorState.lastTraining = runtime.lastTrainingSummary || backendMonitorState.lastTraining;
    backendMonitorState.lastError = null;
    runtimeEvents.publish("monitor.complete", { reason, quoteJobs: quoteRefresh.jobs, jobs: jobs.length, results: runtime.lastResults, paperAgents });
    return { ok: true, reason, quoteJobs: quoteRefresh.jobs, jobs: jobs.length, results: runtime.lastResults, training, paperAgents };
  } catch (error) {
    backendMonitorState.lastError = error.message || String(error);
    await writeBackendMonitorRuntime({ ...runtime, lastError: backendMonitorState.lastError, lastErrorAt: new Date().toISOString() }).catch(() => null);
    return { ok: false, error: backendMonitorState.lastError };
  } finally {
    backendMonitorState.running = false;
    backendMonitorTickRunning = false;
  }
}

async function runBackendMonitorScheduledTick() {
  const request = await consumeBackendMonitorRunRequest();
  if (request) return runBackendMonitorTick(request.reason || "manual-file");
  return runBackendMonitorTick("interval");
}

async function backendMonitorStatus() {
  const [config, runtime, budget] = await Promise.all([
    readBackendMonitorConfig(),
    readBackendMonitorRuntime(),
    readBackendMonitorBudget(),
  ]);
  const sessions = Object.fromEntries(Object.keys(MARKET_CONFIG).map((market) => [market, backendMarketSession(market)]));
  const due = backendDueMonitorJobs(config, runtime).length;
  const dueQuotes = backendDueQuoteJobs(config, runtime).length;
  const intradayModels = {};
  for (const market of Object.keys(MARKET_CONFIG)) {
    const model = await readIntradayModel(market);
    intradayModels[market] = model ? {
      available: Boolean(model.available),
      sampleCount: model.sampleCount || 0,
      updatedAt: model.updatedAt || null,
      test: model.test || null,
      reason: model.reason || "",
    } : { available: false, sampleCount: 0, updatedAt: null, reason: "not trained yet" };
  }
  return {
    ok: true,
    version: APP_VERSION,
    state: backendMonitorState,
    config,
    runtime: {
      lastRunAt: runtime.lastRunAt || null,
      lastTrainingAt: runtime.lastTrainingAt ? new Date(runtime.lastTrainingAt).toISOString() : null,
      lastResults: runtime.lastResults || [],
      lastQuoteResults: runtime.lastQuoteResults || [],
      lastPaperAgents: runtime.lastPaperAgents || [],
      lastEnrichmentCheckAt: runtime.lastEnrichmentCheckAt || null,
      lastError: runtime.lastError || null,
    },
    sessions,
    dueJobs: due,
    dueQuoteJobs: dueQuotes,
    budget,
    budgetLimits: backendMonitorBudgetLimits(),
    intradayModels,
    push: {
      desktopConfigured: true,
      mobileWebhookConfigured: Boolean(process.env.MOBILE_PUSH_WEBHOOK_URL),
      barkConfigured: Boolean(process.env.BARK_PUSH_URL),
      pushPlusConfigured: Boolean(process.env.PUSHPLUS_TOKEN),
      serverChanConfigured: Boolean(process.env.SERVERCHAN_SENDKEY),
    },
  };
}

async function readPredictionSamples(market = "ASX") {
  try {
    const payload = JSON.parse(await readFile(predictionSamplesPathForMarket(market), "utf8"));
    return Array.isArray(payload.samples) ? payload.samples : Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

async function writePredictionSamples(market, samples) {
  await mkdir(snapshotBasePath, { recursive: true });
  const configuredLimit = Number(process.env.PREDICTION_SAMPLE_LIMIT || 0);
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : Infinity;
  const sorted = [...samples]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const rows = Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
  await writeFile(predictionSamplesPathForMarket(market), JSON.stringify({ market: safeMarket(market), updatedAt: new Date().toISOString(), samples: rows }), "utf8");
}

function normalizePredictionSample(sample, market = "ASX") {
  const key = safeMarket(sample?.market || market);
  const symbol = normalizeMarketSymbol(sample?.symbol, key);
  const asOfDate = String(sample?.asOfDate || "").slice(0, 10);
  const close = Number(sample?.close);
  if (!symbol || !asOfDate || !Number.isFinite(close) || close <= 0) return null;
  return {
    id: sample.id || `${key}:${symbol}:${asOfDate}:${Number(sample?.horizonDays || 15)}:${Number(sample?.targetUpside || 5)}`,
    market: key,
    symbol,
    asOfDate,
    createdAt: sample.createdAt || new Date().toISOString(),
    horizonDays: Math.max(1, Math.min(90, Number(sample?.horizonDays || 15))),
    targetUpside: Number(sample?.targetUpside || 5),
    stopLoss: Number(sample?.stopLoss || 4),
    close,
    currentPrice: Number.isFinite(Number(sample?.currentPrice)) && Number(sample.currentPrice) > 0 ? Number(sample.currentPrice) : close,
    currentDate: sample?.currentDate || null,
    confidence: Math.max(0, Math.min(99, Number(sample?.confidence || 0))),
    predictionConfidence: Math.max(0, Math.min(99, Number(sample?.predictionConfidence ?? sample?.confidence ?? 0))),
    strategyConfidence: Math.max(0, Math.min(99, Number(sample?.strategyConfidence ?? sample?.strategyHitProbability ?? 0))),
    strategyHitProbability: Math.max(0, Math.min(99, Number(sample?.strategyHitProbability ?? sample?.strategyConfidence ?? 0))),
    magnitudeConfidence: Math.max(0, Math.min(99, Number(sample?.magnitudeConfidence ?? sample?.magnitudeHitProbability ?? sample?.moveHitProbability ?? sample?.projectedMoveConfidence ?? 0))),
    magnitudeHitProbability: Math.max(0, Math.min(99, Number(sample?.magnitudeHitProbability ?? sample?.magnitudeConfidence ?? sample?.moveHitProbability ?? sample?.projectedMoveConfidence ?? 0))),
    moveHitProbability: Math.max(0, Math.min(99, Number(sample?.moveHitProbability ?? sample?.magnitudeHitProbability ?? sample?.magnitudeConfidence ?? sample?.projectedMoveConfidence ?? 0))),
    rawConfidence: Math.max(0, Math.min(99, Number(sample?.rawConfidence ?? sample?.confidence ?? 0))),
    projectedUpside: Number(sample?.projectedUpside || 0),
    projectedFinalReturn: Number(sample?.projectedFinalReturn ?? sample?.projectedUpside ?? 0),
    finalReturnConfidence: Math.max(0, Math.min(99, Number(sample?.finalReturnConfidence ?? sample?.finalReturnHitProbability ?? sample?.magnitudeConfidence ?? 0))),
    finalReturnHitProbability: Math.max(0, Math.min(99, Number(sample?.finalReturnHitProbability ?? sample?.finalReturnConfidence ?? sample?.magnitudeHitProbability ?? 0))),
    projectedMaxUpside: Math.max(0, Number(sample?.projectedMaxUpside ?? sample?.qualityGate?.projectedMaxUpside ?? sample?.projectedUpside ?? 0)),
    maxUpsideConfidence: Math.max(0, Math.min(99, Number(sample?.maxUpsideConfidence ?? sample?.maxUpsideHitProbability ?? sample?.magnitudeConfidence ?? 0))),
    maxUpsideHitProbability: Math.max(0, Math.min(99, Number(sample?.maxUpsideHitProbability ?? sample?.maxUpsideConfidence ?? sample?.magnitudeHitProbability ?? 0))),
    direction: sample?.direction || null,
    action: sample?.action || "HOLD_WATCH",
    source: sample?.source || "unknown",
    featureScores: sample?.featureScores || {},
    signalCounts: sample?.signalCounts || {},
    ensemble: sample?.ensemble || null,
    calibration: sample?.calibration || null,
    strategyCalibration: sample?.strategyCalibration || null,
    marketRegime: sample?.marketRegime || sample?.ensemble?.marketRegime?.regime || null,
    regimeBucket: sampleRegimeKey(sample),
    sector: sample?.sector || sample?.fundamentals?.sector || sample?.featureScores?.sector || null,
    errorTypes: Array.isArray(sample?.errorTypes) ? sample.errorTypes : [],
    outcome: sample?.outcome || null,
    interim: sample?.interim || null,
    lastEvaluatedAt: sample?.lastEvaluatedAt || null,
    resolvedAt: sample?.resolvedAt || null,
  };
}

function evaluatePredictionOutcome(sample, candles = [], live = {}) {
  const rows = normalizedCandles(candles);
  if (!rows.length || sample?.outcome?.resolved) return sample;
  const startIndex = rows.findIndex((row) => row.date === sample.asOfDate);
  const anchorIndex = startIndex >= 0 ? startIndex : rows.findLastIndex((row) => row.date <= sample.asOfDate);
  if (anchorIndex < 0) return sample;
  const horizonDays = Number(sample.horizonDays || 15);
  let future = rows.slice(anchorIndex + 1, anchorIndex + 1 + horizonDays);
  const entry = Number(sample.close || rows[anchorIndex].close);
  const livePrice = Number(live?.currentPrice ?? live?.close ?? sample?.currentPrice);
  const liveDate = String(live?.currentDate || live?.date || sample?.currentDate || "").slice(0, 10);
  let sameDayLiveOnly = false;
  if (Number.isFinite(livePrice) && livePrice > 0 && liveDate && liveDate >= sample.asOfDate) {
    const liveRow = { date: liveDate, open: livePrice, high: livePrice, low: livePrice, close: livePrice };
    const sameDateIndex = future.findIndex((row) => row.date === liveDate);
    if (sameDateIndex >= 0) {
      const row = future[sameDateIndex];
      future[sameDateIndex] = {
        ...row,
        close: livePrice,
        high: Math.max(Number(row.high || row.close), livePrice),
        low: Math.min(Number(row.low || row.close), livePrice),
      };
    } else if (future.length < horizonDays && (liveDate > sample.asOfDate || !future.length)) {
      sameDayLiveOnly = liveDate === sample.asOfDate;
      future = [...future, liveRow].sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  if (!future.length) return sample;
  const targetPrice = entry * (1 + Number(sample.targetUpside || 5) / 100);
  const stopPrice = entry * (1 - Math.abs(Number(sample.stopLoss || 4)) / 100);
  let hitTarget = false;
  let hitStop = false;
  let targetDate = null;
  let stopDate = null;
  let firstEvent = null;
  let maxHigh = entry;
  let minLow = entry;
  for (const row of future) {
    maxHigh = Math.max(maxHigh, Number(row.high || row.close));
    minLow = Math.min(minLow, Number(row.low || row.close));
    if (!hitTarget && Number(row.high || row.close) >= targetPrice) {
      hitTarget = true;
      targetDate = row.date;
      if (!firstEvent) firstEvent = "target";
    }
    if (!hitStop && Number(row.low || row.close) <= stopPrice) {
      hitStop = true;
      stopDate = row.date;
      if (!firstEvent) firstEvent = "stop";
    }
  }
  const enoughHorizon = !sameDayLiveOnly && future.length >= horizonDays;
  const resolved = hitTarget || hitStop || enoughHorizon;
  const last = future[Math.min(future.length, horizonDays) - 1] || future.at(-1);
  const observedDays = sameDayLiveOnly ? 0.5 : future.length;
  const forwardReturnPct = ((Number(last.close) - entry) / entry) * 100;
  const maxUpsidePct = ((maxHigh - entry) / entry) * 100;
  const maxDrawdownPct = ((minLow - entry) / entry) * 100;
  const adverseReadyDays = Math.max(3, Math.ceil(horizonDays * 0.25));
  const adverseCandidate = sampleWasPositive(sample) && (maxDrawdownPct <= -1.2 || forwardReturnPct <= -1.0);
  const interim = {
    observedDays,
    forwardReturnPct,
    maxUpsidePct,
    maxDrawdownPct,
    targetProgress: Number(sample.targetUpside || 5) > 0 ? maxUpsidePct / Number(sample.targetUpside || 5) : 0,
    adverse: adverseCandidate && observedDays >= adverseReadyDays,
    earlyAdverseWatch: adverseCandidate && observedDays < adverseReadyDays,
    adverseReadyDays,
  };
  if (!resolved) return { ...sample, interim, lastEvaluatedAt: new Date().toISOString() };
  const targetWins = hitTarget && (!hitStop || firstEvent === "target");
  const stopWins = hitStop && (!hitTarget || firstEvent === "stop");
  const outcome = {
    resolved: true,
    resolvedAt: new Date().toISOString(),
    observedDays: future.length,
    hitTarget,
    hitStop,
    targetWins,
    stopWins,
    targetDate,
    stopDate,
    outcome: targetWins ? "target_hit" : stopWins ? "stop_hit" : "expired",
    forwardReturnPct: ((Number(last.close) - entry) / entry) * 100,
    maxUpsidePct: ((maxHigh - entry) / entry) * 100,
    maxDrawdownPct: ((minLow - entry) / entry) * 100,
  };
  const evaluated = { ...sample, interim, outcome, resolvedAt: outcome.resolvedAt, lastEvaluatedAt: outcome.resolvedAt };
  const errorTypes = forecastErrorTypes(evaluated);
  return { ...evaluated, errorTypes, outcome: { ...outcome, errorTypes } };
}

function positiveTargetOutcomeHit(item) {
  return Boolean(item?.outcome?.targetWins ?? item?.outcome?.hitTarget);
}

function projectedMoveOutcomeHit(item) {
  const outcome = item?.outcome || {};
  if (!outcome.resolved) return false;
  const projected = Number(item?.projectedFinalReturn ?? item?.projectedUpside ?? 0);
  const expectedMove = Math.abs(projected);
  if (expectedMove < 0.25) return directionalOutcomeHit(item);
  const tolerance = Math.max(0.15, Math.min(0.55, expectedMove * 0.12));
  if (projected >= 0) {
    return Number(outcome.forwardReturnPct ?? 0) >= expectedMove - tolerance;
  }
  return Number(outcome.forwardReturnPct ?? 0) <= -expectedMove + tolerance;
}

function finalReturnOutcomeHit(item) {
  return projectedMoveOutcomeHit(item);
}

function maxUpsideOutcomeHit(item) {
  const outcome = item?.outcome || {};
  if (!outcome.resolved) return false;
  const projectedMax = Math.max(0, Number(item?.projectedMaxUpside ?? item?.qualityGate?.projectedMaxUpside ?? item?.projectedUpside ?? 0));
  if (projectedMax < 0.25) return directionalOutcomeHit(item);
  const tolerance = Math.max(0.15, Math.min(0.55, projectedMax * 0.12));
  return Number(outcome.maxUpsidePct ?? outcome.forwardReturnPct ?? 0) >= projectedMax - tolerance;
}

function cycleMoveOutcomeHit(item) {
  return finalReturnOutcomeHit(item) || maxUpsideOutcomeHit(item);
}

function directionalOutcomeHit(item) {
  const outcome = item?.outcome || {};
  if (!outcome.resolved) return false;
  const actualReturn = Number(outcome.forwardReturnPct || 0);
  const direction = samplePredictedDirection(item);
  const target = Math.max(1, Number(item?.targetUpside || 5));
  const tolerance = Math.max(0.15, Math.min(0.65, target * 0.08));
  if (direction === "upside") return positiveTargetOutcomeHit(item) || actualReturn > tolerance;
  if (direction === "downside") return Boolean(outcome.stopWins) || actualReturn < -tolerance;
  const neutralBand = Math.max(0.45, Math.min(1.2, Math.abs(Number(item?.stopLoss || 4)) * 0.25));
  return Math.abs(actualReturn) <= neutralBand && !outcome.targetWins && !outcome.stopWins;
}

function outcomeHit(item) {
  return directionalOutcomeHit(item);
}

function summarizeSampleGroup(rows = []) {
  const resolved = rows.filter((item) => item.outcome?.resolved);
  const buyResolved = resolved.filter(sampleWasPositive);
  const misses = rows.filter(sampleMissed);
  const errors = resolved.map(sampleForecastError).filter(Number.isFinite);
  const magnitudeErrors = resolved.map(sampleMagnitudeForecastError).filter(Number.isFinite);
  const maxUpsideErrors = resolved.map(sampleMaxUpsideForecastError).filter(Number.isFinite);
  const overPredictions = errors.filter((value) => value > 0);
  const magnitudeOverPredictions = magnitudeErrors.filter((value) => value > 0);
  const maxUpsideOverPredictions = maxUpsideErrors.filter((value) => value > 0);
  const interimRows = rows.filter((item) => item.interim && !item.outcome?.resolved);
  return {
    total: rows.length,
    pending: rows.length - resolved.length,
    resolved: resolved.length,
    hitRate: resolved.length ? resolved.filter(directionalOutcomeHit).length / resolved.length * 100 : null,
    directionalHitRate: resolved.length ? resolved.filter(directionalOutcomeHit).length / resolved.length * 100 : null,
    magnitudeHitRate: resolved.length ? resolved.filter(cycleMoveOutcomeHit).length / resolved.length * 100 : null,
    finalReturnHitRate: resolved.length ? resolved.filter(finalReturnOutcomeHit).length / resolved.length * 100 : null,
    maxUpsideHitRate: resolved.length ? resolved.filter(maxUpsideOutcomeHit).length / resolved.length * 100 : null,
    buyResolved: buyResolved.length,
    buyHitRate: buyResolved.length ? buyResolved.filter(positiveTargetOutcomeHit).length / buyResolved.length * 100 : null,
    strategyHitRate: buyResolved.length ? buyResolved.filter(positiveTargetOutcomeHit).length / buyResolved.length * 100 : null,
    avgForwardReturn: mean(resolved.map((item) => item.outcome?.forwardReturnPct)),
    avgProjectedUpside: mean(rows.map((item) => item.projectedFinalReturn ?? item.projectedUpside)),
    avgProjectedMaxUpside: mean(rows.map((item) => item.projectedMaxUpside)),
    avgForecastError: mean(errors),
    avgOverPrediction: mean(overPredictions),
    avgMagnitudeError: mean(magnitudeErrors),
    avgMagnitudeOverPrediction: mean(magnitudeOverPredictions),
    avgMaxUpsideError: mean(maxUpsideErrors),
    avgMaxUpsideOverPrediction: mean(maxUpsideOverPredictions),
    avgInterimReturn: mean(interimRows.map((item) => item.interim?.forwardReturnPct)),
    avgInterimDrawdown: mean(interimRows.map((item) => item.interim?.maxDrawdownPct)),
    missCount: misses.length,
    adversePending: interimRows.filter((item) => item.interim?.adverse).length,
  };
}

function buildBehaviorPatternStats(scoped = []) {
  const byPattern = new Map();
  for (const sample of scoped.filter(sampleWasPositive)) {
    for (const pattern of predictionBehaviorPatterns(sample)) {
      const row = byPattern.get(pattern.key) || { label: pattern.label, rows: [] };
      row.rows.push(sample);
      byPattern.set(pattern.key, row);
    }
  }

  const stats = {};
  for (const [key, group] of byPattern.entries()) {
    const rows = group.rows
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 100);
    const stat = summarizeSampleGroup(rows);
    const resolvedMisses = rows.filter((item) => item.outcome?.resolved && sampleMissed(item)).length;
    const enoughEvidence = stat.resolved >= 3 || stat.missCount >= 2 || stat.adversePending >= 2;
    let confidencePenalty = 0;
    if (enoughEvidence) {
      if (stat.buyHitRate != null && stat.buyHitRate < 54) confidencePenalty += Math.min(6, (54 - Number(stat.buyHitRate)) * 0.1);
      confidencePenalty += Math.min(6, Number(resolvedMisses || 0) * 0.75 + Number(stat.adversePending || 0) * 0.85);
      if (Number(stat.avgOverPrediction || 0) > 0.8) confidencePenalty += Math.min(4, Number(stat.avgOverPrediction || 0) * 0.45);
      if (Number(stat.avgInterimReturn || 0) < -0.6) confidencePenalty += Math.min(3, Math.abs(Number(stat.avgInterimReturn || 0)) * 0.7);
    }
    confidencePenalty = Math.max(0, Math.min(10, confidencePenalty));
    const upsideShrink = confidencePenalty > 0
      ? Math.max(0.58, Math.min(1, 1 - confidencePenalty * 0.035 - Math.max(0, Number(stat.avgOverPrediction || 0)) * 0.03))
      : 1;
    if (!stat.total || (!enoughEvidence && confidencePenalty <= 0)) continue;
    stats[key] = {
      key,
      label: group.label,
      ...stat,
      resolvedMisses,
      confidencePenalty: Number(confidencePenalty.toFixed(2)),
      upsideShrink: Number(upsideShrink.toFixed(2)),
      transferScope: confidencePenalty > 0 ? "matching-pattern" : "observe-only",
    };
  }

  return Object.fromEntries(
    Object.entries(stats)
      .sort(([, a], [, b]) => Number(b.confidencePenalty || 0) - Number(a.confidencePenalty || 0) || Number(b.total || 0) - Number(a.total || 0))
      .slice(0, 24)
  );
}

function buildErrorTypeStats(scoped = []) {
  const byType = new Map();
  for (const sample of scoped) {
    const types = Array.isArray(sample.errorTypes?.length ? sample.errorTypes : sample.outcome?.errorTypes)
      ? (sample.errorTypes?.length ? sample.errorTypes : sample.outcome.errorTypes)
      : [];
    for (const type of types) {
      const rows = byType.get(type) || [];
      rows.push(sample);
      byType.set(type, rows);
    }
  }
  return Object.fromEntries([...byType.entries()]
    .map(([type, rows]) => {
      const stat = summarizeSampleGroup(rows);
      return [type, {
        type,
        label: {
          stop_first: "止损先触发",
          target_miss: "周期未达标",
          direction_wrong: "方向判断错误",
          magnitude_miss: "预估幅度未达",
          final_return_miss: "周期结束收益未达",
          max_upside_miss: "周期内最高触达未达",
          over_prediction: "涨幅高估",
          magnitude_over_prediction: "幅度高估",
          max_upside_over_prediction: "最高触达高估",
          high_confidence_miss: "高置信误判",
          strategy_probability_miss: "策略达标概率误判",
          final_probability_miss: "结束收益置信误判",
          max_upside_probability_miss: "最高触达置信误判",
          model_consensus_false_positive: "模型共识假阳性",
          thin_news_evidence: "新闻证据薄",
          factor_conflict_ignored: "因子冲突被忽略",
          market_regime_conflict: "市场环境冲突",
        }[type] || type,
        ...stat,
      }];
    })
    .sort(([, a], [, b]) => Number(b.total || 0) - Number(a.total || 0))
    .slice(0, 16));
}

function buildModelPerformanceStats(scoped = []) {
  const byModel = new Map();
  for (const sample of scoped.filter((item) => item.outcome?.resolved && item.ensemble?.models?.length)) {
    const actualReturn = Number(sample.outcome.forwardReturnPct || 0);
    for (const model of sample.ensemble.models || []) {
      if (model?.available === false || !model.name) continue;
      const projected = Number(model.projectedUpside || 0);
      if (Math.abs(projected) < 0.1) continue;
      const rows = byModel.get(model.name) || [];
      const directionHit = projected >= 0 ? actualReturn >= 0 : actualReturn < 0;
      const strategyHit = projected >= 0
        ? Boolean(sample.outcome.targetWins)
        : Boolean(sample.outcome.stopWins || actualReturn < 0 || !sample.outcome.targetWins);
      rows.push({
        directionHit,
        strategyHit,
        projected,
        actualReturn,
        confidence: Number(model.confidence || 0),
        weight: Number(model.weight || 0),
      });
      byModel.set(model.name, rows);
    }
  }
  return Object.fromEntries([...byModel.entries()]
    .map(([name, rows]) => {
      const directionalHitRate = rows.filter((row) => row.directionHit).length / rows.length * 100;
      const strategyHitRate = rows.filter((row) => row.strategyHit).length / rows.length * 100;
      const avgError = mean(rows.map((row) => row.projected - row.actualReturn));
      const multiplier = rows.length >= 5
        ? clampNumber(0.76 + (directionalHitRate - 50) * 0.012 + (strategyHitRate - 50) * 0.009 + Math.min(0.12, rows.length * 0.004), 0.45, 1.35)
        : 1;
      return [name, {
        name,
        samples: rows.length,
        directionalHitRate,
        strategyHitRate,
        avgError,
        weightMultiplier: Number(multiplier.toFixed(2)),
      }];
    })
    .sort(([, a], [, b]) => Number(b.samples || 0) - Number(a.samples || 0))
    .slice(0, 32));
}

function sampleModelWeight(model = {}) {
  const normalized = Number(model.normalizedWeight);
  if (Number.isFinite(normalized) && normalized > 0) return normalized;
  const raw = Number(model.weight);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function ensembleWeightLearningRows(scoped = []) {
  return scoped
    .filter((sample) => sample?.outcome?.resolved && Array.isArray(sample?.ensemble?.models) && sample.ensemble.models.length)
    .map((sample) => {
      const modelValues = {};
      const priorWeights = {};
      for (const model of sample.ensemble.models || []) {
        if (!model?.name || model.available === false) continue;
        const projected = Number(model.projectedUpside);
        if (!Number.isFinite(projected)) continue;
        modelValues[model.name] = clampNumber(projected, -18, 18);
        priorWeights[model.name] = sampleModelWeight(model);
      }
      const actualReturn = clampNumber(Number(sample.outcome?.forwardReturnPct || 0), -24, 24);
      const storedPrediction = clampNumber(Number(sample.ensemble?.projectedUpside ?? sample.projectedFinalReturn ?? sample.projectedUpside ?? 0), -18, 18);
      return {
        date: String(sample.outcome?.resolvedAt || sample.resolvedAt || sample.createdAt || sample.asOfDate || ""),
        symbol: sample.symbol,
        actualReturn,
        targetWins: Boolean(sample.outcome?.targetWins),
        stopWins: Boolean(sample.outcome?.stopWins),
        storedPrediction,
        modelValues,
        priorWeights,
      };
    })
    .filter((row) => Object.keys(row.modelValues).length >= 2 && Number.isFinite(row.actualReturn))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function modelNamesForWeightLearning(rows = []) {
  const stats = new Map();
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.modelValues || {})) {
      const stat = stats.get(name) || { count: 0, absSignal: 0 };
      stat.count += 1;
      stat.absSignal += Math.abs(Number(value || 0));
      stats.set(name, stat);
    }
  }
  const minCount = Math.max(6, Math.ceil(rows.length * 0.28));
  return [...stats.entries()]
    .filter(([, stat]) => stat.count >= minCount && stat.absSignal / Math.max(1, stat.count) >= 0.08)
    .sort(([, a], [, b]) => b.count - a.count || b.absSignal - a.absSignal)
    .slice(0, 14)
    .map(([name]) => name);
}

function normalizeWeights(values = []) {
  const cleaned = values.map((value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
  const total = cleaned.reduce((sum, value) => sum + value, 0);
  if (total > 0) return cleaned.map((value) => value / total);
  return cleaned.length ? cleaned.map(() => 1 / cleaned.length) : [];
}

function averagePriorVector(rows = [], names = []) {
  const sums = names.map(() => 0);
  let contributingRows = 0;
  for (const row of rows) {
    const raw = names.map((name) => Number(row.priorWeights?.[name] || 0));
    const total = raw.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) continue;
    const normalized = raw.map((value) => Math.max(0, value) / total);
    normalized.forEach((value, index) => { sums[index] += value; });
    contributingRows += 1;
  }
  if (!contributingRows) return names.map(() => 1 / Math.max(1, names.length));
  return normalizeWeights(sums.map((value) => value / contributingRows));
}

function projectToSimplex(values = []) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => b - a);
  let cumulative = 0;
  let rho = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    cumulative += sorted[index];
    const theta = (cumulative - 1) / (index + 1);
    if (sorted[index] - theta > 0) rho = index + 1;
  }
  const theta = (sorted.slice(0, rho).reduce((sum, value) => sum + value, 0) - 1) / Math.max(1, rho);
  return values.map((value) => Math.max(0, value - theta));
}

function predictionForWeightVector(row, names = [], weights = []) {
  return names.reduce((sum, name, index) => sum + Number(weights[index] || 0) * Number(row.modelValues?.[name] || 0), 0);
}

function evaluateStoredEnsembleForecast(rows = []) {
  if (!rows.length) return { samples: 0, mse: null, mae: null, directionHitRate: null, targetHitRate: null };
  const errors = rows.map((row) => Number(row.storedPrediction || 0) - Number(row.actualReturn || 0));
  const directionHits = rows.filter((row) => {
    const predicted = Number(row.storedPrediction || 0);
    return predicted >= 0 ? Number(row.actualReturn || 0) >= 0 : Number(row.actualReturn || 0) < 0;
  }).length;
  const targetRows = rows.filter((row) => Number(row.storedPrediction || 0) > 0);
  return {
    samples: rows.length,
    mse: mean(errors.map((error) => error ** 2)),
    mae: mean(errors.map((error) => Math.abs(error))),
    directionHitRate: directionHits / rows.length * 100,
    targetHitRate: targetRows.length ? targetRows.filter((row) => row.targetWins).length / targetRows.length * 100 : null,
  };
}

function evaluateWeightVector(rows = [], names = [], weights = []) {
  if (!rows.length || !names.length || !weights.length) return { samples: 0, mse: null, mae: null, directionHitRate: null, targetHitRate: null };
  const predictions = rows.map((row) => predictionForWeightVector(row, names, weights));
  const errors = rows.map((row, index) => predictions[index] - Number(row.actualReturn || 0));
  const directionHits = rows.filter((row, index) => predictions[index] >= 0 ? Number(row.actualReturn || 0) >= 0 : Number(row.actualReturn || 0) < 0).length;
  const targetRows = rows.filter((row, index) => predictions[index] > 0);
  return {
    samples: rows.length,
    mse: mean(errors.map((error) => error ** 2)),
    mae: mean(errors.map((error) => Math.abs(error))),
    directionHitRate: directionHits / rows.length * 100,
    targetHitRate: targetRows.length ? targetRows.filter((row) => row.targetWins).length / targetRows.length * 100 : null,
    avgPrediction: mean(predictions),
  };
}

function fitSimplexRidgeWeights(rows = [], names = [], prior = [], lambda = 0.06) {
  if (!rows.length || !names.length) return normalizeWeights(prior);
  let weights = normalizeWeights(prior);
  const avgSignal = mean(rows.flatMap((row) => names.map((name) => Math.abs(Number(row.modelValues?.[name] || 0)))));
  const step = 0.018 / (1 + avgSignal * avgSignal * 0.16);
  const ridge = Math.max(0.001, Number(lambda || 0.06));
  for (let iteration = 0; iteration < 900; iteration += 1) {
    const gradient = names.map((_, index) => 2 * ridge * (weights[index] - (prior[index] || 0)));
    for (const row of rows) {
      const predicted = predictionForWeightVector(row, names, weights);
      const error = predicted - Number(row.actualReturn || 0);
      names.forEach((name, index) => {
        gradient[index] += (2 / rows.length) * error * Number(row.modelValues?.[name] || 0);
      });
    }
    weights = projectToSimplex(weights.map((weight, index) => weight - step * gradient[index]));
  }
  return normalizeWeights(weights);
}

function improvementPct(candidateMse, baselineMse) {
  if (!Number.isFinite(Number(candidateMse)) || !Number.isFinite(Number(baselineMse)) || Number(baselineMse) <= 0) return null;
  return (Number(baselineMse) - Number(candidateMse)) / Number(baselineMse) * 100;
}

function buildEnsembleWeightOptimization(scoped = []) {
  const rows = ensembleWeightLearningRows(scoped);
  if (rows.length < 24) {
    return {
      status: "collecting",
      active: false,
      sampleCount: rows.length,
      minSamples: 24,
      reason: "Need at least 24 resolved ensemble samples before replacing engineering prior weights.",
    };
  }
  const names = modelNamesForWeightLearning(rows);
  if (names.length < 2) {
    return {
      status: "collecting",
      active: false,
      sampleCount: rows.length,
      minSamples: 24,
      reason: "Not enough recurrent ensemble models to optimize a stable simplex weight vector.",
    };
  }
  const trainEnd = Math.max(10, Math.floor(rows.length * 0.58));
  const validationEnd = Math.max(trainEnd + 5, Math.floor(rows.length * 0.78));
  const train = rows.slice(0, trainEnd);
  const validation = rows.slice(trainEnd, validationEnd);
  const test = rows.slice(validationEnd);
  if (validation.length < 5 || test.length < 5) {
    return {
      status: "collecting",
      active: false,
      sampleCount: rows.length,
      minSamples: 32,
      reason: "Need separate validation and untouched test windows for weight learning.",
      modelNames: names,
    };
  }
  const prior = averagePriorVector(train, names);
  const lambdas = [0.16, 0.1, 0.065, 0.04, 0.025, 0.012];
  const candidates = lambdas.map((lambda) => {
    const weights = fitSimplexRidgeWeights(train, names, prior, lambda);
    return { lambda, weights, validation: evaluateWeightVector(validation, names, weights) };
  }).sort((a, b) => Number(a.validation.mse || Infinity) - Number(b.validation.mse || Infinity));
  const selected = candidates[0];
  const deploymentPrior = averagePriorVector([...train, ...validation], names);
  const deploymentWeights = fitSimplexRidgeWeights([...train, ...validation], names, deploymentPrior, selected.lambda);
  const trainMetrics = evaluateWeightVector(train, names, deploymentWeights);
  const validationMetrics = evaluateWeightVector(validation, names, selected.weights);
  const testMetrics = evaluateWeightVector(test, names, deploymentWeights);
  const storedValidation = evaluateStoredEnsembleForecast(validation);
  const storedTest = evaluateStoredEnsembleForecast(test);
  const priorTest = evaluateWeightVector(test, names, deploymentPrior);
  const validationImprovementPct = improvementPct(validationMetrics.mse, storedValidation.mse);
  const testImprovementPct = improvementPct(testMetrics.mse, storedTest.mse);
  const directionFloorOk = storedTest.directionHitRate == null || testMetrics.directionHitRate >= Number(storedTest.directionHitRate) - 2.5;
  const targetFloorOk = storedTest.targetHitRate == null || testMetrics.targetHitRate == null || testMetrics.targetHitRate >= Number(storedTest.targetHitRate) - 4;
  const active = (
    Number(validationImprovementPct) >= 1
    && Number(testImprovementPct) >= 0.5
    && directionFloorOk
    && targetFloorOk
  );
  const samplePower = clampNumber((rows.length - 24) / 120, 0, 1);
  const deploymentBlend = active ? Number((0.35 + samplePower * 0.45).toFixed(2)) : 0;
  const weights = Object.fromEntries(names.map((name, index) => [name, Number(deploymentWeights[index].toFixed(5))]));
  const priorWeights = Object.fromEntries(names.map((name, index) => [name, Number(deploymentPrior[index].toFixed(5))]));
  return {
    status: active ? "active" : "rejected_oos",
    active,
    sampleCount: rows.length,
    modelCount: names.length,
    modelNames: names,
    selectedLambda: selected.lambda,
    deploymentBlend,
    weights,
    priorWeights,
    train: trainMetrics,
    validation: validationMetrics,
    test: testMetrics,
    baselines: {
      storedValidation,
      storedTest,
      priorTest,
    },
    validationImprovementPct: Number.isFinite(validationImprovementPct) ? Number(validationImprovementPct.toFixed(2)) : null,
    testImprovementPct: Number.isFinite(testImprovementPct) ? Number(testImprovementPct.toFixed(2)) : null,
    reason: active
      ? `Optimized simplex weights improved untouched test MSE by ${Number(testImprovementPct || 0).toFixed(1)}% versus stored ensemble.`
      : "Learned weights did not beat the stored ensemble on validation/test without weakening direction or target-hit reliability.",
  };
}

function buildRegimeStats(scoped = []) {
  const buckets = ["uptrend", "range", "downtrend", "volatile", "unknown"];
  return Object.fromEntries(buckets.map((bucket) => {
    const rows = scoped.filter((item) => sampleRegimeKey(item) === bucket);
    const stat = summarizeSampleGroup(rows);
    return [bucket, {
      label: {
        uptrend: "上升市",
        range: "震荡市",
        downtrend: "下跌市",
        volatile: "高波动",
        unknown: "未知环境",
      }[bucket],
      regime: bucket,
      ...stat,
    }];
  }).filter(([, stat]) => stat.total > 0));
}

function sampleSectorKey(sample = {}) {
  if (sample.sector) return String(sample.sector).slice(0, 80);
  const code = cleanCode(sample.symbol, sample.market || "ASX");
  return sectorContext(code, sample.market || "ASX").sector || "unknown";
}

function buildSectorStats(scoped = []) {
  const bySector = new Map();
  scoped.forEach((sample) => {
    const sector = sampleSectorKey(sample);
    const rows = bySector.get(sector) || [];
    rows.push(sample);
    bySector.set(sector, rows);
  });
  return Object.fromEntries([...bySector.entries()]
    .map(([sector, rows]) => [sector, { sector, ...summarizeSampleGroup(rows) }])
    .filter(([, stat]) => stat.total > 0)
    .sort(([, a], [, b]) => Number(b.resolved || 0) - Number(a.resolved || 0) || Number(b.total || 0) - Number(a.total || 0))
    .slice(0, 24));
}

function benchmarkHitRate(rows = [], predictor) {
  const resolved = rows.filter((item) => item.outcome?.resolved);
  if (!resolved.length) return null;
  return resolved.filter((item) => predictor(item)).length / resolved.length * 100;
}

function buildBenchmarkComparisons(scoped = []) {
  const resolved = scoped.filter((item) => item.outcome?.resolved);
  const buyResolved = resolved.filter(sampleWasPositive);
  const randomDirection = resolved.length ? 50 : null;
  const buyHoldDirection = benchmarkHitRate(resolved, (item) => Number(item.outcome?.forwardReturnPct || 0) > 0);
  const simpleMomentumDirection = benchmarkHitRate(resolved, (item) => {
    const momentum = Number(item.featureScores?.momentum ?? item.featureScores?.change5d ?? 50);
    const predictsUp = momentum >= 50;
    const actual = Number(item.outcome?.forwardReturnPct || 0);
    return predictsUp ? actual > 0 : actual <= 0;
  });
  const modelDirection = benchmarkHitRate(resolved, directionalOutcomeHit);
  const modelTarget = buyResolved.length ? buyResolved.filter(positiveTargetOutcomeHit).length / buyResolved.length * 100 : null;
  const buyHoldTarget = buyResolved.length ? buyResolved.filter((item) => Number(item.outcome?.maxUpsidePct || 0) >= Number(item.targetUpside || 5)).length / buyResolved.length * 100 : null;
  const simpleMomentumTargetRows = buyResolved.filter((item) => Number(item.featureScores?.momentum ?? 50) >= 50);
  const simpleMomentumTarget = simpleMomentumTargetRows.length
    ? simpleMomentumTargetRows.filter(positiveTargetOutcomeHit).length / simpleMomentumTargetRows.length * 100
    : null;
  const rows = [
    { id: "model", label: "当前模型", directionHitRate: modelDirection, targetHitRate: modelTarget, samples: resolved.length, note: "多模型/新闻/因子/Agent 校准后结果" },
    { id: "random", label: "随机猜测", directionHitRate: randomDirection, targetHitRate: null, samples: resolved.length, note: "方向基准固定 50%" },
    { id: "buy_hold", label: "买入持有", directionHitRate: buyHoldDirection, targetHitRate: buyHoldTarget, samples: resolved.length, note: "不择时，统计周期内自然涨跌" },
    { id: "simple_momentum", label: "简单动量", directionHitRate: simpleMomentumDirection, targetHitRate: simpleMomentumTarget, samples: resolved.length, note: "仅用动量分>=50 作为看多" },
  ];
  return rows.map((row) => ({
    ...row,
    edgeVsRandom: row.directionHitRate == null ? null : Number((row.directionHitRate - 50).toFixed(2)),
    edgeVsBuyHold: row.directionHitRate == null || buyHoldDirection == null ? null : Number((row.directionHitRate - buyHoldDirection).toFixed(2)),
  }));
}

function buildStrategyProbabilityBuckets(buyResolved = []) {
  return [
    [0, 39],
    [40, 49],
    [50, 59],
    [60, 69],
    [70, 79],
    [80, 99],
  ].map(([min, max]) => {
    const rows = buyResolved.filter((item) => {
      const probability = sampleStrategyProbability(item);
      return probability >= min && probability <= max;
    });
    const hits = rows.filter(positiveTargetOutcomeHit).length;
    const brierScore = rows.length
      ? rows.reduce((sum, item) => {
        const probability = Math.max(0, Math.min(1, sampleStrategyProbability(item) / 100));
        return sum + (probability - (positiveTargetOutcomeHit(item) ? 1 : 0)) ** 2;
      }, 0) / rows.length
      : null;
    return {
      label: `${min}-${max}`,
      min,
      max,
      count: rows.length,
      hitRate: rows.length ? hits / rows.length * 100 : null,
      avgReturn: rows.length ? rows.reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0) / rows.length : null,
      brierScore,
    };
  });
}

function buildAdaptiveCalibration(scoped = []) {
  const resolved = scoped.filter((item) => item.outcome?.resolved);
  const recent = scoped
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 120);
  const recentResolved = recent.filter((item) => item.outcome?.resolved);
  const recentPositive = recent.filter(sampleWasPositive);
  const recentPositiveResolved = recentResolved.filter(sampleWasPositive);
  const recentMisses = recent.filter(sampleMissed).length;
  const recentAdverse = recent.filter((item) => item.interim?.adverse && !item.outcome?.resolved).length;
  const buyHit = recentPositiveResolved.length ? recentPositiveResolved.filter(positiveTargetOutcomeHit).length / recentPositiveResolved.length * 100 : null;
  const overallHit = recentResolved.length ? recentResolved.filter(directionalOutcomeHit).length / recentResolved.length * 100 : null;
  const magnitudeHit = recentResolved.length ? recentResolved.filter(cycleMoveOutcomeHit).length / recentResolved.length * 100 : null;
  const finalReturnHit = recentResolved.length ? recentResolved.filter(finalReturnOutcomeHit).length / recentResolved.length * 100 : null;
  const maxUpsideHit = recentResolved.length ? recentResolved.filter(maxUpsideOutcomeHit).length / recentResolved.length * 100 : null;
  const avgForecastError = mean(recentResolved.map(sampleForecastError).filter(Number.isFinite));
  const avgOverPrediction = mean(recentResolved.map(sampleForecastError).filter((value) => Number.isFinite(value) && value > 0));
  const avgMagnitudeOverPrediction = mean(recentResolved.map(sampleMagnitudeForecastError).filter((value) => Number.isFinite(value) && value > 0));
  const avgMaxUpsideOverPrediction = mean(recentResolved.map(sampleMaxUpsideForecastError).filter((value) => Number.isFinite(value) && value > 0));

  let confidencePenalty = 0;
  if (recentResolved.length >= 8 && overallHit != null && overallHit < 50) confidencePenalty += (50 - overallHit) * 0.18;
  if (recentResolved.length >= 8 && overallHit != null && overallHit < 55) confidencePenalty += (55 - overallHit) * 0.06;
  if (recentResolved.length >= 8 && magnitudeHit != null && magnitudeHit < 50) confidencePenalty += (50 - magnitudeHit) * 0.14;
  if (recentResolved.length >= 8 && maxUpsideHit != null && maxUpsideHit < 50) confidencePenalty += (50 - maxUpsideHit) * 0.1;
  if (recentPositiveResolved.length >= 4 && buyHit != null && buyHit < 50) confidencePenalty += (50 - buyHit) * 0.25;
  if (recentPositiveResolved.length >= 4 && buyHit != null && buyHit < 58) confidencePenalty += (58 - buyHit) * 0.08;
  if (recentPositive.length >= 5) confidencePenalty += Math.min(9, recentMisses * 0.65 + recentAdverse * 0.9);
  else if (recentAdverse > 0) confidencePenalty += Math.min(3, recentAdverse * 0.55);
  if (avgForecastError != null && avgForecastError > 1) confidencePenalty += Math.min(5, avgForecastError * 0.45);
  if (avgMagnitudeOverPrediction != null && avgMagnitudeOverPrediction > 0.8) confidencePenalty += Math.min(4, avgMagnitudeOverPrediction * 0.42);
  if (avgMaxUpsideOverPrediction != null && avgMaxUpsideOverPrediction > 0.8) confidencePenalty += Math.min(3.5, avgMaxUpsideOverPrediction * 0.35);
  confidencePenalty = Math.max(0, Math.min(20, confidencePenalty));

  let upsideShrink = 1;
  if (avgOverPrediction != null && avgOverPrediction > 0.6) upsideShrink -= Math.min(0.24, avgOverPrediction * 0.035);
  if (avgMagnitudeOverPrediction != null && avgMagnitudeOverPrediction > 0.7) upsideShrink -= Math.min(0.2, avgMagnitudeOverPrediction * 0.04);
  if (avgMaxUpsideOverPrediction != null && avgMaxUpsideOverPrediction > 0.7) upsideShrink -= Math.min(0.16, avgMaxUpsideOverPrediction * 0.03);
  if (recentPositive.length >= 5) upsideShrink -= Math.min(0.28, recentMisses * 0.022 + recentAdverse * 0.03);
  if (overallHit != null && overallHit < 50) upsideShrink -= Math.min(0.16, (50 - overallHit) * 0.005);
  if (magnitudeHit != null && magnitudeHit < 50) upsideShrink -= Math.min(0.16, (50 - magnitudeHit) * 0.006);
  if (maxUpsideHit != null && maxUpsideHit < 50) upsideShrink -= Math.min(0.12, (50 - maxUpsideHit) * 0.005);
  if (buyHit != null && buyHit < 55) upsideShrink -= Math.min(0.24, (55 - buyHit) * 0.008);
  upsideShrink = Math.max(0.45, Math.min(1, upsideShrink));

  const horizonStats = Object.fromEntries(["short", "medium", "long"].map((bucket) => {
    const rows = scoped.filter((item) => horizonBucketForDays(item.horizonDays) === bucket);
    return [bucket, { label: horizonLabel(bucket), ...summarizeSampleGroup(rows) }];
  }));

  const bySymbol = new Map();
  for (const item of scoped) {
    const list = bySymbol.get(item.symbol) || [];
    list.push(item);
    bySymbol.set(item.symbol, list);
  }
  const symbolStats = {};
  for (const [symbol, rows] of bySymbol.entries()) {
    const stat = summarizeSampleGroup(rows.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 80));
    let symbolPenalty = 0;
    if (stat.resolved >= 4 && stat.hitRate != null && stat.hitRate < 50) symbolPenalty += (50 - stat.hitRate) * 0.1;
    if (stat.resolved >= 4 && stat.magnitudeHitRate != null && stat.magnitudeHitRate < 50) symbolPenalty += (50 - stat.magnitudeHitRate) * 0.12;
    if (stat.resolved >= 4 && stat.maxUpsideHitRate != null && stat.maxUpsideHitRate < 50) symbolPenalty += (50 - stat.maxUpsideHitRate) * 0.08;
    if (stat.resolved >= 3 && stat.buyHitRate != null && stat.buyHitRate < 50) symbolPenalty += (50 - stat.buyHitRate) * 0.16;
    symbolPenalty += Math.min(10, Number(stat.missCount || 0) * 1 + Number(stat.adversePending || 0) * 1.75);
    if (Number(stat.avgInterimReturn || 0) < -0.6) symbolPenalty += Math.min(4, Math.abs(Number(stat.avgInterimReturn || 0)) * 0.8);
    if (Number(stat.avgInterimDrawdown || 0) < -0.9) symbolPenalty += Math.min(4, Math.abs(Number(stat.avgInterimDrawdown || 0)) * 0.55);
    const symbolUpsideShrink = Math.max(0.42, Math.min(1, 1 - symbolPenalty * 0.04 - Math.max(0, Number(stat.avgOverPrediction || 0)) * 0.03 - Math.max(0, Number(stat.avgMagnitudeOverPrediction || 0)) * 0.035 - Math.max(0, Number(stat.avgMaxUpsideOverPrediction || 0)) * 0.025));
    symbolStats[symbol] = {
      ...stat,
      confidencePenalty: Number(Math.min(12, symbolPenalty).toFixed(2)),
      upsideShrink: Number(symbolUpsideShrink.toFixed(2)),
    };
  }

  const patternStats = buildBehaviorPatternStats(scoped);

  return {
    confidencePenalty: Number(confidencePenalty.toFixed(2)),
    upsideShrink: Number(upsideShrink.toFixed(2)),
    recentMisses,
    recentAdverse,
    recentResolved: recentResolved.length,
    buyHitRate: buyHit,
    overallHitRate: overallHit,
    directionalHitRate: overallHit,
    magnitudeHitRate: magnitudeHit,
    finalReturnHitRate: finalReturnHit,
    maxUpsideHitRate: maxUpsideHit,
    strategyHitRate: buyHit,
    avgForecastError,
    avgOverPrediction,
    avgMagnitudeOverPrediction,
    avgMaxUpsideOverPrediction,
    horizonStats,
    symbolStats,
    patternStats,
    updatedAt: new Date().toISOString(),
  };
}

function sampleEventDate(sample = {}) {
  return String(sample.outcome?.resolvedAt || sample.resolvedAt || sample.lastEvaluatedAt || sample.createdAt || "").slice(0, 10);
}

function sampleOutcomeReturn(sample = {}) {
  if (sample.outcome?.resolved) return Number(sample.outcome.forwardReturnPct);
  if (sample.interim) return Number(sample.interim.forwardReturnPct);
  return null;
}

function sampleOutcomeDrawdown(sample = {}) {
  if (sample.outcome?.resolved) return Number(sample.outcome.maxDrawdownPct);
  if (sample.interim) return Number(sample.interim.maxDrawdownPct);
  return null;
}

function sampleStatusLabel(sample = {}) {
  if (sample.outcome?.targetWins) return "目标达成";
  if (sample.outcome?.stopWins) return "止损触发";
  if (sample.outcome?.resolved && sampleWasPositive(sample) && !positiveTargetOutcomeHit(sample)) {
    return directionalOutcomeHit(sample) ? "方向对但未达标" : "周期未达标";
  }
  if (sample.outcome?.resolved) return directionalOutcomeHit(sample) ? "方向命中" : "方向未命中";
  if (sample.interim?.adverse) return "未完成逆行";
  return "等待验证";
}

function rollingLearningCurve(scoped = []) {
  const resolved = scoped
    .filter((item) => item.outcome?.resolved)
    .sort((a, b) => String(a.outcome?.resolvedAt || a.resolvedAt || a.createdAt || "").localeCompare(String(b.outcome?.resolvedAt || b.resolvedAt || b.createdAt || "")));
  return resolved.map((sample, index) => {
    const window = resolved.slice(Math.max(0, index - 19), index + 1);
    const buyWindow = window.filter(sampleWasPositive);
    const hits = window.filter(directionalOutcomeHit).length;
    const buyHits = buyWindow.filter(positiveTargetOutcomeHit).length;
    const brierScore = mean(window.map((item) => {
      const probability = Math.max(0, Math.min(1, Number(item.confidence || 0) / 100));
      return (probability - (directionalOutcomeHit(item) ? 1 : 0)) ** 2;
    }));
    return {
      date: sampleEventDate(sample),
      symbol: sample.symbol,
      samples: index + 1,
      window: window.length,
      hitRate: window.length ? hits / window.length * 100 : null,
      buyHitRate: buyWindow.length ? buyHits / buyWindow.length * 100 : null,
      avgReturn: mean(window.map((item) => Number(item.outcome?.forwardReturnPct || 0))),
      brierScore,
      avgForecastError: mean(window.map(sampleForecastError).filter(Number.isFinite)),
    };
  }).slice(-36);
}

function summarizeResolvedSegment(rows = []) {
  const positives = rows.filter(sampleWasPositive);
  const hitRate = rows.length ? rows.filter(directionalOutcomeHit).length / rows.length * 100 : null;
  const buyHitRate = positives.length ? positives.filter(positiveTargetOutcomeHit).length / positives.length * 100 : null;
  return {
    samples: rows.length,
    hitRate,
    buyHitRate,
    avgReturn: mean(rows.map((item) => Number(item.outcome?.forwardReturnPct || 0))),
    brierScore: mean(rows.map((item) => {
      const probability = Math.max(0, Math.min(1, Number(item.confidence || 0) / 100));
      return (probability - (directionalOutcomeHit(item) ? 1 : 0)) ** 2;
    })),
  };
}

function learningImprovement(scoped = []) {
  const resolved = scoped
    .filter((item) => item.outcome?.resolved)
    .sort((a, b) => String(a.outcome?.resolvedAt || a.resolvedAt || a.createdAt || "").localeCompare(String(b.outcome?.resolvedAt || b.resolvedAt || b.createdAt || "")));
  if (resolved.length < 6) {
    return {
      status: "collecting",
      message: "已开始保留旧预测并等待更多到期样本；至少 6 个已验证样本后显示阶段改善。",
      baseline: summarizeResolvedSegment(resolved),
      recent: summarizeResolvedSegment(resolved),
    };
  }
  const size = Math.max(3, Math.min(30, Math.floor(resolved.length / 2)));
  const baseline = summarizeResolvedSegment(resolved.slice(0, size));
  const recent = summarizeResolvedSegment(resolved.slice(-size));
  return {
    status: "ready",
    window: size,
    baseline,
    recent,
    hitRateDelta: baseline.hitRate == null || recent.hitRate == null ? null : Number((recent.hitRate - baseline.hitRate).toFixed(2)),
    buyHitRateDelta: baseline.buyHitRate == null || recent.buyHitRate == null ? null : Number((recent.buyHitRate - baseline.buyHitRate).toFixed(2)),
    brierDelta: baseline.brierScore == null || recent.brierScore == null ? null : Number((recent.brierScore - baseline.brierScore).toFixed(4)),
    avgReturnDelta: baseline.avgReturn == null || recent.avgReturn == null ? null : Number((recent.avgReturn - baseline.avgReturn).toFixed(2)),
  };
}

function buildLearningEvents(scoped = [], adaptive = {}) {
  return scoped
    .filter((sample) => sampleMissed(sample) || sample.interim?.adverse || (sample.outcome?.resolved && sampleWasPositive(sample) && Number(sample.outcome?.forwardReturnPct || 0) < 0))
    .sort((a, b) => String(b.outcome?.resolvedAt || b.resolvedAt || b.lastEvaluatedAt || b.createdAt || "").localeCompare(String(a.outcome?.resolvedAt || a.resolvedAt || a.lastEvaluatedAt || a.createdAt || "")))
    .slice(0, 14)
    .map((sample) => {
      const adjustment = adaptiveForecastAdjustment({ adaptive }, sample.symbol, Number(sample.horizonDays || 15), sample);
      const returnPct = sampleOutcomeReturn(sample);
      const drawdownPct = sampleOutcomeDrawdown(sample);
      const scopes = [];
      if (Number(adjustment.confidencePenalty || 0) > 0.4) scopes.push("全局/周期");
      if (Number(adjustment.symbolStats?.confidencePenalty || 0) > 0.4) scopes.push("个股");
      if (Number(adjustment.patternPenalty || 0) > 0.4) scopes.push("相似行为");
      const changes = [];
      if (Number(adjustment.confidencePenalty || 0) > 0.4) changes.push(`后续同类预测置信度扣 ${Number(adjustment.confidencePenalty).toFixed(1)}%`);
      if (Number(adjustment.upsideShrink || 1) < 0.98) changes.push(`正向涨幅预估收缩到 ${Math.round(Number(adjustment.upsideShrink || 1) * 100)}%`);
      if (adjustment.matchedPatterns?.length) changes.push(`迁移到 ${adjustment.matchedPatterns.map((row) => row.label).join("、")}`);
      if (!changes.length) changes.push("记录为观察样本，等待更多同类失败后再触发参数迁移");
      const forecastError = Number.isFinite(Number(sampleForecastError(sample))) ? Math.abs(Number(sampleForecastError(sample))) : 0;
      const missSeverity = (sampleMissed(sample) ? 1 : 0) + (sample.interim?.adverse ? 0.6 : 0) + Math.max(0, -Number(returnPct || 0)) / 8 + Math.max(0, -Number(drawdownPct || 0)) / 12;
      const adjustmentScale = clampNumber(0.02 + forecastError * 0.012 + missSeverity * 0.035, 0.02, 0.22);
      return {
        date: sampleEventDate(sample),
        symbol: sample.symbol,
        horizonDays: Number(sample.horizonDays || 15),
        projectedUpside: Number(sample.projectedUpside || 0),
        confidence: Number(sample.confidence || 0),
        actualReturn: Number.isFinite(returnPct) ? Number(returnPct.toFixed(2)) : null,
        drawdown: Number.isFinite(drawdownPct) ? Number(drawdownPct.toFixed(2)) : null,
        status: sampleStatusLabel(sample),
        transferScopes: scopes.length ? scopes : ["观察"],
        adjustmentScale: Number(adjustmentScale.toFixed(3)),
        forecastError: Number(forecastError.toFixed(2)),
        changes,
        reasons: adjustment.reasons || [],
      };
    });
}

function buildModelAdjustmentPolicy(scoped = [], adaptive = {}) {
  const events = buildLearningEvents(scoped, adaptive);
  const resolved = scoped.filter((sample) => sample.outcome?.resolved);
  const errors = resolved.map(sampleForecastError).filter(Number.isFinite).map(Math.abs);
  const avgError = errors.length ? mean(errors) : null;
  const avgScale = events.length ? mean(events.map((row) => Number(row.adjustmentScale || 0))) : 0;
  return {
    framework: "adaptive-error-scaled-micro-tuning",
    status: resolved.length >= 4 ? "active" : "collecting",
    sampleCount: resolved.length,
    eventCount: events.length,
    avgForecastError: avgError == null ? null : Number(avgError.toFixed(3)),
    avgAdjustmentScale: Number(avgScale.toFixed(3)),
    scaleFormula: "scale = clamp(0.02 + abs(forecastError)*0.012 + missSeverity*0.035, 0.02, 0.22)",
    effectFormula: "confidencePenalty/upsideShrink are adjusted by global, horizon, symbol, and matched-pattern errors; larger realized miss causes larger but capped micro-tuning.",
    guardrails: [
      "time-ordered resolved outcomes only",
      "no fixed one-size penalty",
      "scale capped at 22% to reduce overfitting",
      "pattern transfer only when similar behavior has evidence",
    ],
    latestEvents: events.slice(0, 6),
  };
}

function buildAccuracyBoostPlan(summary = {}, adaptive = {}) {
  const rows = [];
  if (Number(summary.resolved || 0) < 8) {
    rows.push({
      priority: "高",
      title: "继续累积到期样本",
      action: "保留旧预测直到周期结束，用同一预测 ID 验证目标/止损，不用新预测覆盖旧预测。",
      effect: "这是让置信度从主观分数变成可校准概率的前提。",
    });
  }
  if (summary.hitRate != null && Number(summary.hitRate) < 50) {
    rows.push({
      priority: "高",
      title: "方向准确率低于50%",
      action: "进入保守预测模式：降低低样本模型权重、提高模型共识门槛、压缩正向涨幅上限。",
      effect: "先减少错误方向的高置信输出，再逐步恢复可交易信号数量。",
    });
  }
  if (summary.magnitudeHitRate != null && Number(summary.magnitudeHitRate) < 50) {
    rows.push({
      priority: "高",
      title: "幅度达成率低于50%",
      action: "收缩预估涨跌幅，降低幅度置信度，并优先采用样本外误差较小的模型。",
      effect: "避免方向猜对但涨跌幅夸大，减少高估导致的错误买入。",
    });
  }
  if (summary.finalReturnHitRate != null && Number(summary.finalReturnHitRate) < 50) {
    rows.push({
      priority: "高",
      title: "周期结束收益命中不足",
      action: "单独收缩周期末收益预测，并降低“结束涨跌幅置信”，避免把中途机会误当成持有到期收益。",
      effect: "让收盘收益预测更保守，减少持仓周期末的高估。",
    });
  }
  if (summary.maxUpsideHitRate != null && Number(summary.maxUpsideHitRate) < 50) {
    rows.push({
      priority: "高",
      title: "最高触达命中不足",
      action: "收缩最高触达涨幅，要求更高的量能/趋势/模型一致性才能给出触达型买入提醒。",
      effect: "提升“15日内到过目标价”的可靠度。",
    });
  }
  if (summary.buyHitRate != null && Number(summary.buyHitRate) < 58) {
    rows.push({
      priority: "高",
      title: "上调买入门槛",
      action: "买入候选必须同时满足方向置信、幅度达成率、上涨一致度、共识强度和策略达标率；低于门槛只进入观察，不再推荐买入。",
      effect: "减少 WOW 这类短期反向后的低质量买入信号。",
    });
  }
  if (Number(adaptive.avgOverPrediction || 0) > 0.8) {
    rows.push({
      priority: "高",
      title: "收缩激进涨幅",
      action: `近期平均高估 ${Number(adaptive.avgOverPrediction).toFixed(2)}%，后续正向预估按 ${Math.round(Number(adaptive.upsideShrink || 1) * 100)}% 收缩。`,
      effect: "宁愿保守估计，也不让 +6% 因单日波动变成大幅急转。",
    });
  }
  const weakPatterns = Object.values(adaptive.patternStats || {})
    .filter((row) => Number(row.confidencePenalty || 0) > 0.5)
    .sort((a, b) => Number(b.confidencePenalty || 0) - Number(a.confidencePenalty || 0))
    .slice(0, 3);
  weakPatterns.forEach((row) => {
    rows.push({
      priority: "中",
      title: `压制错误模式：${row.label}`,
      action: `该模式后续扣 ${Number(row.confidencePenalty || 0).toFixed(1)}%，涨幅收缩至 ${Math.round(Number(row.upsideShrink || 1) * 100)}%。`,
      effect: "个股错误会选择性迁移到其他股票的相似信号，而不是只惩罚单只股票。",
    });
  });
  if (summary.brierScore != null && Number(summary.brierScore) > 0.24) {
    rows.push({
      priority: "中",
      title: "校准置信桶",
      action: "用 50-59、60-69、70-79 等置信桶的方向准确率反校准新预测可靠度。",
      effect: "让“方向置信度”更接近方向预测正确概率，而不是模型情绪分。",
    });
  }
  rows.push({
    priority: "中",
    title: "扩大有效数据维度",
    action: "把财报、业绩指引、分红、行业指数、同业/上下游、宏观新闻、成交量和历史相似走势同时作为投票模型。",
    effect: "提高信号覆盖率，降低单一技术指标误导。",
  });
  return rows.slice(0, 8);
}

function summarizePredictionSamples(samples = [], market = "ASX") {
  const key = safeMarket(market);
  const scoped = samples.filter((item) => safeMarket(item.market || key) === key);
  const resolved = scoped.filter((item) => item.outcome?.resolved);
  const buyResolved = resolved.filter(sampleWasPositive);
  const hitRate = resolved.length ? resolved.filter(directionalOutcomeHit).length / resolved.length * 100 : null;
  const magnitudeHitRate = resolved.length ? resolved.filter(cycleMoveOutcomeHit).length / resolved.length * 100 : null;
  const finalReturnHitRate = resolved.length ? resolved.filter(finalReturnOutcomeHit).length / resolved.length * 100 : null;
  const maxUpsideHitRate = resolved.length ? resolved.filter(maxUpsideOutcomeHit).length / resolved.length * 100 : null;
  const buyHitRate = buyResolved.length ? buyResolved.filter(positiveTargetOutcomeHit).length / buyResolved.length * 100 : null;
  const avgForwardReturn = resolved.length ? resolved.reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0) / resolved.length : null;
  const brierScore = resolved.length
    ? resolved.reduce((sum, item) => {
      const probability = Math.max(0, Math.min(1, Number(item.confidence || 0) / 100));
      const actual = directionalOutcomeHit(item) ? 1 : 0;
      return sum + (probability - actual) ** 2;
    }, 0) / resolved.length
    : null;
  const strategyBrierScore = buyResolved.length
    ? buyResolved.reduce((sum, item) => {
      const probability = Math.max(0, Math.min(1, sampleStrategyProbability(item) / 100));
      const actual = positiveTargetOutcomeHit(item) ? 1 : 0;
      return sum + (probability - actual) ** 2;
    }, 0) / buyResolved.length
    : null;
  const magnitudeBrierScore = resolved.length
    ? resolved.reduce((sum, item) => {
      const probability = Math.max(0, Math.min(1, sampleMagnitudeProbability(item) / 100));
      const actual = cycleMoveOutcomeHit(item) ? 1 : 0;
      return sum + (probability - actual) ** 2;
    }, 0) / resolved.length
    : null;
  const finalReturnBrierScore = resolved.length
    ? resolved.reduce((sum, item) => {
      const probability = Math.max(0, Math.min(1, sampleFinalReturnProbability(item) / 100));
      return sum + (probability - (finalReturnOutcomeHit(item) ? 1 : 0)) ** 2;
    }, 0) / resolved.length
    : null;
  const maxUpsideBrierScore = resolved.length
    ? resolved.reduce((sum, item) => {
      const probability = Math.max(0, Math.min(1, sampleMaxUpsideProbability(item) / 100));
      return sum + (probability - (maxUpsideOutcomeHit(item) ? 1 : 0)) ** 2;
    }, 0) / resolved.length
    : null;
  const grossProfit = resolved.filter((item) => Number(item.outcome.forwardReturnPct || 0) > 0).reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0);
  const grossLoss = Math.abs(resolved.filter((item) => Number(item.outcome.forwardReturnPct || 0) < 0).reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const profitFactorNoLosses = grossLoss === 0 && grossProfit > 0;
  const payoffRatio = (() => {
    const winners = resolved.filter((item) => Number(item.outcome.forwardReturnPct || 0) > 0);
    const losers = resolved.filter((item) => Number(item.outcome.forwardReturnPct || 0) < 0);
    if (!winners.length || !losers.length) return null;
    const avgWin = winners.reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0) / winners.length;
    const avgLoss = Math.abs(losers.reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0) / losers.length);
    return avgLoss > 0 ? avgWin / avgLoss : null;
  })();
  const maxAdverseDrawdown = resolved.length ? Math.min(...resolved.map((item) => Number(item.outcome.maxDrawdownPct || 0))) : null;
  const avgMaxDrawdown = resolved.length ? resolved.reduce((sum, item) => sum + Number(item.outcome.maxDrawdownPct || 0), 0) / resolved.length : null;
  const buckets = [
    [0, 49],
    [50, 59],
    [60, 69],
    [70, 79],
    [80, 89],
    [90, 99],
  ].map(([min, max]) => {
    const rows = resolved.filter((item) => Number(item.confidence || 0) >= min && Number(item.confidence || 0) <= max);
    const hits = rows.filter(directionalOutcomeHit).length;
    const bucketBrier = rows.length
      ? rows.reduce((sum, item) => {
        const probability = Math.max(0, Math.min(1, Number(item.confidence || 0) / 100));
        return sum + (probability - (directionalOutcomeHit(item) ? 1 : 0)) ** 2;
      }, 0) / rows.length
      : null;
    return {
      label: `${min}-${max}`,
      min,
      max,
      count: rows.length,
      hitRate: rows.length ? hits / rows.length * 100 : null,
      avgReturn: rows.length ? rows.reduce((sum, item) => sum + Number(item.outcome.forwardReturnPct || 0), 0) / rows.length : null,
      brierScore: bucketBrier,
      maxDrawdown: rows.length ? Math.min(...rows.map((item) => Number(item.outcome.maxDrawdownPct || 0))) : null,
    };
  });
  const recent = scoped
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 8);
  const adaptive = buildAdaptiveCalibration(scoped);
  const modelAdjustmentPolicy = buildModelAdjustmentPolicy(scoped, adaptive);
  const strategyBuckets = buildStrategyProbabilityBuckets(buyResolved);
  const modelStats = buildModelPerformanceStats(scoped);
  const ensembleWeightOptimization = buildEnsembleWeightOptimization(scoped);
  const regimeStats = buildRegimeStats(scoped);
  const sectorStats = buildSectorStats(scoped);
  const errorTypeStats = buildErrorTypeStats(scoped);
  const benchmarkComparisons = buildBenchmarkComparisons(scoped);
  const summaryBase = {
    total: scoped.length,
    pending: scoped.length - resolved.length,
    resolved: resolved.length,
    hitRate,
    directionalHitRate: hitRate,
    magnitudeHitRate,
    finalReturnHitRate,
    maxUpsideHitRate,
    buyResolved: buyResolved.length,
    buyHitRate,
    strategyHitRate: buyHitRate,
    avgForwardReturn,
    brierScore,
    strategyBrierScore,
    magnitudeBrierScore,
    finalReturnBrierScore,
    maxUpsideBrierScore,
  };
  return {
    market: key,
    total: scoped.length,
    pending: scoped.length - resolved.length,
    resolved: resolved.length,
    hitRate,
    directionalHitRate: hitRate,
    magnitudeHitRate,
    finalReturnHitRate,
    maxUpsideHitRate,
    buyResolved: buyResolved.length,
    buyHitRate,
    strategyHitRate: buyHitRate,
    avgForwardReturn,
    brierScore,
    strategyBrierScore,
    magnitudeBrierScore,
    finalReturnBrierScore,
    maxUpsideBrierScore,
    profitFactor,
    profitFactorNoLosses,
    payoffRatio,
    maxAdverseDrawdown,
    avgMaxDrawdown,
    grossProfit,
    grossLoss,
    buckets,
    strategyBuckets,
    modelStats,
    ensembleWeightOptimization,
    regimeStats,
    sectorStats,
    benchmarkComparisons,
    errorTypeStats,
    horizonStats: adaptive.horizonStats,
    adaptive,
    modelAdjustmentPolicy,
    learningCurve: rollingLearningCurve(scoped),
    improvement: learningImprovement(scoped),
    learningEvents: buildLearningEvents(scoped, adaptive),
    accuracyBoostPlan: buildAccuracyBoostPlan(summaryBase, adaptive),
    recent,
    updatedAt: new Date().toISOString(),
  };
}

function predictionSamplesTrainingSignature(samples = [], market = "ASX") {
  const key = safeMarket(market);
  const scoped = (Array.isArray(samples) ? samples : []).filter((item) => safeMarket(item.market || key) === key);
  const resolved = scoped.filter((item) => item.outcome?.resolved);
  const tail = scoped
    .slice()
    .sort((a, b) => String(a.outcome?.resolvedAt || a.createdAt || a.id || "").localeCompare(String(b.outcome?.resolvedAt || b.createdAt || b.id || "")))
    .slice(-8)
    .map((item) => `${item.id || ""}:${item.outcome?.resolvedAt || ""}:${item.outcome?.forwardReturnPct ?? ""}`)
    .join("|");
  return `${key}:${scoped.length}:${resolved.length}:${tail}`;
}

function attachLocalModelSuite(summary, suite) {
  if (!suite || typeof suite !== "object") return summary;
  summary.localModelDeployment = suite;
  if (suite.ensembleWeightOptimization) {
    summary.ensembleWeightOptimization = suite.ensembleWeightOptimization;
  }
  if (suite.modelZoo) {
    summary.modelZoo = suite.modelZoo;
  }
  if (suite.signalModels) {
    summary.localSignalModels = suite.signalModels;
  }
  if (suite.lightgbm) {
    summary.lightgbmModel = suite.lightgbm;
  }
  if (suite.tripleBarrier) {
    summary.tripleBarrierModel = suite.tripleBarrier;
  }
  if (suite.splitAudit) {
    summary.splitAudit = suite.splitAudit;
  }
  if (suite.calibrationDiagnostics) {
    summary.calibrationDiagnostics = suite.calibrationDiagnostics;
  }
  if (suite.noTradeGate) {
    summary.noTradeGate = suite.noTradeGate;
  }
  if (suite.deepLearning) {
    summary.deepLearningModel = suite.deepLearning;
  }
  if (suite.featureCatalog) {
    summary.featureCatalog = suite.featureCatalog;
  }
  return summary;
}

async function summarizePredictionSamplesWithLocalModel(samples = [], market = "ASX") {
  const key = safeMarket(market);
  const summary = summarizePredictionSamples(samples, key);
  summary.historicalPredictionModel = await readPredictionWeightModelSnapshot(key);
  const signature = predictionSamplesTrainingSignature(samples, key);
  const cached = localModelTrainingCache.get(key);
  const cacheTtl = Number(process.env.LOCAL_MODEL_CACHE_TTL_MS || 10 * 60 * 1000);
  if (cached?.signature === signature && Date.now() - Number(cached.time || 0) < cacheTtl) {
    return attachLocalModelSuite(summary, cached.suite);
  }
  try {
    const suite = await runPythonQuantCore(
      "local-model-train",
      { market: key, samples: Array.isArray(samples) ? samples : [] },
      Number(process.env.LOCAL_MODEL_TIMEOUT_MS || 18000),
    );
    localModelTrainingCache.set(key, { signature, time: Date.now(), suite });
    attachLocalModelSuite(summary, suite);
  } catch (error) {
    summary.localModelDeployment = {
      framework: "python-local-quant-model-suite",
      available: false,
      status: "fallback_js_calibration",
      error: error.message,
      fallback: "js-ensemble-weight-optimizer",
    };
  }
  return summary;
}

function calibrateConfidenceValue(confidence, summary) {
  const value = Math.max(0, Math.min(99, Number(confidence || 0)));
  const bucket = (summary?.buckets || []).find((item) => value >= item.min && value <= item.max && item.count >= 5 && item.hitRate != null);
  if (!bucket) {
    return {
      confidence: value,
      adjustment: 0,
      message: "Calibration has too few resolved samples for this confidence bucket.",
      sampleCount: bucket?.count || 0,
    };
  }
  const calibrated = Math.round(value * 0.65 + Number(bucket.hitRate) * 0.35);
  return {
    confidence: Math.max(0, Math.min(99, calibrated)),
    adjustment: calibrated - value,
    message: `Bucket ${bucket.label} historical hit rate ${Number(bucket.hitRate).toFixed(0)}% from ${bucket.count} resolved samples.`,
    sampleCount: bucket.count,
    bucket: bucket.label,
    hitRate: bucket.hitRate,
  };
}

function calibrateStrategyProbabilityValue(probability, summary) {
  const value = Math.max(0, Math.min(99, Number(probability || 0)));
  const bucket = (summary?.strategyBuckets || []).find((item) => value >= item.min && value <= item.max && item.count >= 5 && item.hitRate != null);
  if (!bucket) {
    return {
      probability: value,
      adjustment: 0,
      message: "Strategy target-hit calibration has too few resolved samples for this bucket.",
      sampleCount: bucket?.count || 0,
    };
  }
  const calibrated = Math.round(value * 0.55 + Number(bucket.hitRate) * 0.45);
  return {
    probability: Math.max(0, Math.min(99, calibrated)),
    adjustment: calibrated - value,
    message: `Strategy bucket ${bucket.label} actual target-hit rate ${Number(bucket.hitRate).toFixed(0)}% from ${bucket.count} resolved samples.`,
    sampleCount: bucket.count,
    bucket: bucket.label,
    hitRate: bucket.hitRate,
  };
}

function adaptiveForecastAdjustment(summary, symbol, horizonDays = 15, candidate = null) {
  const key = String(symbol || "").trim().toUpperCase();
  const adaptive = summary?.adaptive || {};
  const horizon = adaptive.horizonStats?.[horizonBucketForDays(horizonDays)] || {};
  const symbolStat = adaptive.symbolStats?.[key] || {};
  const candidatePatterns = predictionBehaviorPatterns({
    ...(candidate || {}),
    horizonDays,
  });
  const matchedPatternStats = candidatePatterns
    .map((pattern) => adaptive.patternStats?.[pattern.key])
    .filter((stat) => Number(stat?.confidencePenalty || 0) > 0)
    .sort((a, b) => Number(b.confidencePenalty || 0) - Number(a.confidencePenalty || 0))
    .slice(0, 3);
  const globalPenalty = Number(adaptive.confidencePenalty || 0);
  const horizonDirectionPenalty = horizon.resolved >= 6 && horizon.hitRate != null && horizon.hitRate < 50
    ? Math.min(7, (50 - Number(horizon.hitRate)) * 0.12)
    : 0;
  const horizonMagnitudePenalty = horizon.resolved >= 6 && horizon.magnitudeHitRate != null && Number(horizon.magnitudeHitRate) < 50
    ? Math.min(7, (50 - Number(horizon.magnitudeHitRate)) * 0.14)
    : 0;
  const horizonPenalty = horizon.resolved >= 4 && horizon.buyHitRate != null && horizon.buyHitRate < 55
    ? Math.min(8, (55 - Number(horizon.buyHitRate)) * 0.11)
    : 0;
  const horizonAdversePenalty = Number(horizon.adversePending || 0) > 0
    ? Math.min(5, Number(horizon.adversePending || 0) * 0.65 + Math.max(0, -Number(horizon.avgInterimReturn || 0)) * 0.35)
    : 0;
  const symbolPenalty = Number(symbolStat.confidencePenalty || 0);
  const patternPenalty = matchedPatternStats.reduce((sum, stat, index) => {
    const weight = index === 0 ? 1 : 0.45;
    return sum + Number(stat.confidencePenalty || 0) * weight;
  }, 0);
  const confidencePenalty = clampNumber(globalPenalty + horizonDirectionPenalty + horizonMagnitudePenalty + horizonPenalty + horizonAdversePenalty + symbolPenalty + patternPenalty, 0, 28);
  const globalShrink = Number(adaptive.upsideShrink || 1) || 1;
  const horizonDirectionShrink = horizon.resolved >= 6 && horizon.hitRate != null && horizon.hitRate < 50
    ? Math.max(0.72, 1 - (50 - Number(horizon.hitRate)) * 0.007)
    : 1;
  const horizonMagnitudeShrink = horizon.resolved >= 6 && horizon.magnitudeHitRate != null && horizon.magnitudeHitRate < 50
    ? Math.max(0.68, 1 - (50 - Number(horizon.magnitudeHitRate)) * 0.009)
    : 1;
  const horizonShrink = horizon.resolved >= 4 && Number(horizon.avgOverPrediction || 0) > 0
    ? Math.max(0.68, 1 - Number(horizon.avgOverPrediction || 0) * 0.025)
    : 1;
  const symbolShrink = Number(symbolStat.upsideShrink || 1) || 1;
  const patternShrink = matchedPatternStats.reduce((value, stat) => Math.min(value, Number(stat.upsideShrink || 1) || 1), 1);
  const upsideShrink = clampNumber(globalShrink * horizonDirectionShrink * horizonMagnitudeShrink * horizonShrink * symbolShrink * patternShrink, 0.35, 1);
  const reasons = [];
  if (globalPenalty > 0.4) reasons.push(`全局近期预测惩罚 ${globalPenalty.toFixed(1)}%`);
  if (horizonDirectionPenalty > 0.4) reasons.push(`${horizon.label || horizonLabel(horizonBucketForDays(horizonDays))} 方向准确率不足，扣 ${horizonDirectionPenalty.toFixed(1)}%`);
  if (horizonMagnitudePenalty > 0.4) reasons.push(`${horizon.label || horizonLabel(horizonBucketForDays(horizonDays))} 幅度达成率不足，扣 ${horizonMagnitudePenalty.toFixed(1)}%`);
  if (horizonPenalty > 0.4) reasons.push(`${horizon.label || horizonLabel(horizonBucketForDays(horizonDays))} 买入达标不足，扣 ${horizonPenalty.toFixed(1)}%`);
  if (horizonAdversePenalty > 0.4) reasons.push(`${horizon.label || horizonLabel(horizonBucketForDays(horizonDays))} 未到期预测已逆行，扣 ${horizonAdversePenalty.toFixed(1)}%`);
  if (symbolPenalty > 0.4) reasons.push(`${key} 近期偏差惩罚 ${symbolPenalty.toFixed(1)}%`);
  if (patternPenalty > 0.4) reasons.push(`相似预测行为惩罚 ${patternPenalty.toFixed(1)}%：${matchedPatternStats.map((stat) => stat.label).join("、")}`);
  if (upsideShrink < 0.94) reasons.push(`预估涨幅按 ${(upsideShrink * 100).toFixed(0)}% 收缩`);
  return {
    confidencePenalty: Number(confidencePenalty.toFixed(2)),
    upsideShrink: Number(upsideShrink.toFixed(2)),
    horizonBucket: horizonBucketForDays(horizonDays),
    symbolStats: symbolStat,
    patternPenalty: Number(patternPenalty.toFixed(2)),
    matchedPatterns: matchedPatternStats.map((stat) => ({
      key: stat.key,
      label: stat.label,
      confidencePenalty: stat.confidencePenalty,
      upsideShrink: stat.upsideShrink,
      total: stat.total,
      resolved: stat.resolved,
      buyHitRate: stat.buyHitRate,
      adversePending: stat.adversePending,
    })),
    reasons,
  };
}

async function updatePredictionSamples(market, incoming = [], options = {}) {
  const key = safeMarket(market);
  const cancelCodes = normalizedCodeSet(options.cancelSymbols || [], key);
  const existing = (await readPredictionSamples(key)).filter((item) => {
    const code = sampleCode(item, key);
    if (cancelCodes.has(code) && !isResolvedPredictionSample(item)) return false;
    return true;
  });
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const raw of incoming) {
    const sample = normalizePredictionSample(raw, key);
    if (!sample) continue;
    const evaluatedExisting = [...byId.values()].map((item) => (
      item.market === sample.market && item.symbol === sample.symbol
        ? evaluatePredictionOutcome(item, raw.candles || [], sample)
        : item
    ));
    byId.clear();
    evaluatedExisting.forEach((item) => byId.set(item.id, item));
    byId.set(sample.id, evaluatePredictionOutcome({ ...byId.get(sample.id), ...sample }, raw.candles || [], sample));
  }
  const samples = [...byId.values()];
  await writePredictionSamples(key, samples);
  return await summarizePredictionSamplesWithLocalModel(samples, key);
}

function backoffProvider(key, ms, reason) {
  providerBackoff.set(key, { until: Date.now() + ms, reason });
}

function providerBackoffReason(key) {
  const item = providerBackoff.get(key);
  if (!item) return "";
  if (Date.now() > item.until) {
    providerBackoff.delete(key);
    return "";
  }
  return item.reason;
}

function shouldSkipProvider(key) {
  return Boolean(providerBackoffReason(key));
}

function providerSkipError(key) {
  const reason = providerBackoffReason(key);
  return reason ? `${key}: ${reason}` : "";
}

function splitProviderKeyValues(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function providerApiKeys(provider, env = process.env) {
  const key = String(provider || "").toLowerCase();
  const config = PROVIDER_KEY_ENV[key];
  if (!config) return [];
  const values = [env[config.primary], ...splitProviderKeyValues(env[config.pool])];
  for (let index = 1; index <= 12; index += 1) {
    values.push(env[`${config.primary}_BACKUP_${index}`]);
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function providerKeyPoolStatus(provider) {
  const key = String(provider || "").toLowerCase();
  const keys = providerApiKeys(key);
  const runtime = providerKeyRuntime.get(key) || {};
  return {
    configured: keys.length > 0,
    keyCount: keys.length,
    activeKeyPosition: keys.length ? Math.min(keys.length, Number(runtime.activeIndex || 0) + 1) : 0,
    failoverOnly: true,
    lastFailoverAt: runtime.lastFailoverAt || null,
  };
}

function shouldRotateProviderKey(provider, message) {
  const value = String(message || "");
  if (String(provider).toLowerCase() === "eodhd") {
    return /HTTP\s+(401|402|403|429)|daily API requests limit|quota|rate limit|invalid api|invalid token|unauthori[sz]ed|forbidden|exceeded/i.test(value);
  }
  if (String(provider).toLowerCase() === "twelvedata") {
    return /HTTP\s+(401|402|403|429)|quota|rate limit|api credits|invalid api|invalid key|unauthori[sz]ed|forbidden|Pro or Venture|plan|permission/i.test(value);
  }
  if (String(provider).toLowerCase() === "tiingo") {
    return /HTTP\s+(401|402|403|429)|quota|rate limit|invalid token|token.*invalid|unauthori[sz]ed|forbidden|exceeded/i.test(value);
  }
  return /HTTP\s+(401|402|403|429)|quota|rate limit|unauthori[sz]ed|forbidden|exceeded/i.test(value);
}

async function withProviderApiKey(provider, options = {}, task) {
  const key = String(provider || "").toLowerCase();
  const keys = providerApiKeys(key, options.env || process.env);
  if (!keys.length) throw new Error(`${PROVIDER_KEY_ENV[key]?.primary || `${key.toUpperCase()}_API_KEY`} is required`);
  const backoffKey = String(options.backoffKey || key);
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const day = new Date().toISOString().slice(0, 10);
  const runtimeKey = String(options.runtimeKey || key);
  const previous = providerKeyRuntime.get(runtimeKey) || {};
  const runtime = previous.day === day
    ? { ...previous, blockedUntil: { ...(previous.blockedUntil || {}) } }
    : { day, activeIndex: 0, blockedUntil: {}, lastFailoverAt: previous.lastFailoverAt || null };
  const start = Math.max(0, Math.min(keys.length - 1, Number(runtime.activeIndex || 0)));
  const order = [...Array(keys.length).keys()].map((offset) => (start + offset) % keys.length);
  let attempted = 0;
  let lastError = null;
  for (const index of order) {
    if (Number(runtime.blockedUntil[index] || 0) > Date.now()) continue;
    attempted += 1;
    try {
      const result = await task(keys[index], { index, total: keys.length });
      runtime.activeIndex = index;
      runtime.lastSuccessAt = new Date().toISOString();
      providerKeyRuntime.set(runtimeKey, runtime);
      return result;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const rotate = typeof options.rotateOn === "function"
        ? options.rotateOn(message)
        : shouldRotateProviderKey(key, message);
      if (!rotate) throw error;
      const blockedMs = Math.max(60_000, Number(options.keyBackoffMs || options.backoffMs || 20 * 60_000));
      runtime.blockedUntil[index] = Date.now() + blockedMs;
      runtime.activeIndex = (index + 1) % keys.length;
      runtime.lastFailoverAt = new Date().toISOString();
      providerKeyRuntime.set(runtimeKey, runtime);
    }
  }
  const label = options.label || key.toUpperCase();
  const reason = String(options.exhaustedReason || `${label} key pool exhausted; using another real source if available.`);
  backoffProvider(backoffKey, Math.max(60_000, Number(options.backoffMs || 20 * 60_000)), reason);
  const detail = lastError ? ` ${String(lastError.message || lastError)}` : "";
  throw new Error(`${label} key pool unavailable (${attempted}/${keys.length} configured keys checked).${detail}`);
}

async function throttleAlphaVantage() {
  const minGapMs = Number(process.env.ALPHAVANTAGE_MIN_GAP_MS || 1300);
  const waitMs = Math.max(0, alphaVantageNextRequestAt - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  alphaVantageNextRequestAt = Date.now() + minGapMs;
}

function parseJsonpPayload(text) {
  const body = String(text || "").trim();
  const match = body.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  return JSON.parse(match ? match[1] : body);
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < String(line || "").length; index += 1) {
    const char = line[index];
    if (char === "\"" && line[index + 1] === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function stooqQuoteRows(csv) {
  const lines = String(csv || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function yahooCandlesToRows(payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const adjClose = result?.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  return sanitizeCandleRows(timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open?.[index] ?? null,
    high: quote.high?.[index] ?? null,
    low: quote.low?.[index] ?? null,
    close: quote.close?.[index] ?? null,
    adjClose: adjClose[index] ?? quote.close?.[index] ?? null,
    volume: quote.volume?.[index] ?? 0,
  })));
}

function twelveDataRows(payload) {
  return sanitizeCandleRows((payload?.values || []).map((row) => ({
    date: String(row.datetime).slice(0, 10),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    adjClose: Number(row.close),
    volume: Number(row.volume || 0),
  }))).reverse();
}

function eodhdRows(payload) {
  return sanitizeCandleRows((Array.isArray(payload) ? payload : []).map((row) => ({
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    adjClose: Number(row.adjusted_close ?? row.close),
    volume: Number(row.volume || 0),
  })));
}

function eodhdIntradayRows(payload) {
  return sanitizeCandleRows((Array.isArray(payload) ? payload : []).map((row) => {
    const timestamp = row.datetime || row.date || row.timestamp;
    return {
      date: timestamp ? String(timestamp).replace(" ", "T") : "",
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      adjClose: Number(row.close),
      volume: Number(row.volume || 0),
    };
  }), { preserveTimestamp: true });
}

function finnhubRows(payload, interval = "1d") {
  const timestamps = Array.isArray(payload?.t) ? payload.t : [];
  if (payload?.s && payload.s !== "ok") return [];
  return sanitizeCandleRows(timestamps.map((timestamp, index) => ({
    date: new Date(Number(timestamp || 0) * 1000).toISOString(),
    open: Number(payload.o?.[index]),
    high: Number(payload.h?.[index]),
    low: Number(payload.l?.[index]),
    close: Number(payload.c?.[index]),
    adjClose: Number(payload.c?.[index]),
    volume: Number(payload.v?.[index] || 0),
  })), { preserveTimestamp: isIntradayInterval(interval) });
}

function tiingoRows(payload, interval = "1d") {
  return sanitizeCandleRows((Array.isArray(payload) ? payload : []).map((row) => ({
    date: String(row.date || row.timestamp || ""),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    adjClose: Number(row.adjClose ?? row.close),
    volume: Number(row.volume || 0),
  })), { preserveTimestamp: isIntradayInterval(interval) });
}

function isIntradayInterval(interval) {
  return ["5m", "15m", "60m"].includes(interval);
}

function normalizeTwelveInterval(interval) {
  return {
    "5m": "5min",
    "15m": "15min",
    "60m": "1h",
    "1wk": "1week",
  }[interval] || "1day";
}

function twelveExchangeForCode(code, market = "ASX") {
  const key = safeMarket(market);
  if (key === "ASX") return process.env.TWELVEDATA_ASX_EXCHANGE || "ASX";
  if (key === "US") return process.env.TWELVEDATA_US_EXCHANGE || "";
  if (key === "CN") {
    if (/^6/.test(code)) return process.env.TWELVEDATA_CN_SH_EXCHANGE || "SSE";
    return process.env.TWELVEDATA_CN_SZ_EXCHANGE || "SZSE";
  }
  return "";
}

function eodhdExchangeForCode(code, market = "ASX") {
  const key = safeMarket(market);
  if (key === "ASX") return "AU";
  if (key === "US") return "US";
  if (key === "CN") return /^6/.test(code) ? (process.env.EODHD_CN_SH_EXCHANGE || "SHG") : (process.env.EODHD_CN_SZ_EXCHANGE || "SHE");
  return "US";
}

function eodhdTickerForCode(code, market = "ASX") {
  if (["ASX", "US"].includes(safeMarket(market))) {
    const index = usIndexProviderSymbols(code);
    if (index?.eodhd) return index.eodhd;
  }
  return `${cleanCode(code, market)}.${eodhdExchangeForCode(cleanCode(code, market), market)}`;
}

function alphaVantageSymbolForCode(code, market = "ASX") {
  const clean = cleanCode(code, market);
  if (/^(SH|SZ)\d{6}$/.test(clean)) throw new Error("Alpha Vantage does not support this CN index symbol in the current adapter.");
  if (safeMarket(market) === "CN") return /^6/.test(clean) ? `${clean}.SHH` : `${clean}.SHZ`;
  return clean;
}

function yahooSymbolForMarket(symbol, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  if (code.startsWith("^")) return code;
  if (key === "ASX") return `${code}.AX`;
  if (key === "CN") {
    if (/^SH(\d{6})$/.test(code)) return `${code.slice(2)}.SS`;
    if (/^SZ(\d{6})$/.test(code)) return `${code.slice(2)}.SZ`;
    return /^6/.test(code) ? `${code}.SS` : `${code}.SZ`;
  }
  return code;
}

function usIndexProviderSymbols(code) {
  const clean = String(code || "").trim().toUpperCase();
  return {
    "^GSPC": { yahoo: "^GSPC", stooq: "^spx", stooqQuote: "^spx", fred: "SP500", twelve: "SPX", eodhd: "GSPC.INDX", finnhub: ["^GSPC", "SPX"], tiingo: ["^GSPC", "SPX"], label: "S&P 500" },
    "^IXIC": { yahoo: "^IXIC", stooq: "^ixic", stooqQuote: "^ndq", fred: "NASDAQCOM", twelve: "IXIC", eodhd: "IXIC.INDX", finnhub: ["^IXIC", "IXIC"], tiingo: ["^IXIC", "IXIC"], label: "Nasdaq Composite" },
    "^DJI": { yahoo: "^DJI", stooq: "^dji", stooqQuote: "^dji", fred: "DJIA", twelve: "DJI", eodhd: "DJI.INDX", finnhub: ["^DJI", "DJI"], tiingo: ["^DJI", "DJI"], label: "Dow Jones" },
    "^SPX": { yahoo: "^GSPC", stooq: "^spx", fred: "SP500", twelve: "SPX", eodhd: "GSPC.INDX", finnhub: ["^GSPC", "SPX"], tiingo: ["^GSPC", "SPX"], label: "S&P 500" },
    "^COMP": { yahoo: "^IXIC", stooq: "^ixic", stooqQuote: "^ndq", fred: "NASDAQCOM", twelve: "IXIC", eodhd: "IXIC.INDX", finnhub: ["^IXIC", "IXIC"], tiingo: ["^IXIC", "IXIC"], label: "Nasdaq Composite" },
    "^AXJO": { yahoo: "^AXJO", stooq: "^axjo", twelve: "XJO", eodhd: "XJO.INDX", label: "S&P/ASX 200" },
    "^AORD": { yahoo: "^AORD", stooq: "^aord", twelve: "AORD", eodhd: "AORD.INDX", label: "All Ordinaries" },
    "^AXKO": { yahoo: "^AXKO", stooq: "^axko", twelve: "XKO", eodhd: "XKO.INDX", label: "S&P/ASX 300" },
  }[clean] || null;
}

function tencentSymbolForCn(code) {
  const clean = cleanCode(code, "CN");
  if (/^(SH|SZ)\d{6}$/.test(clean)) return clean.toLowerCase();
  return `${/^6/.test(clean) ? "sh" : "sz"}${clean}`;
}

function normalizeTencentMinuteDate(value) {
  const text = String(value || "");
  if (/^\d{12}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}`;
  }
  return text;
}

function tencentRows(rows = [], intraday = false) {
  return sanitizeCandleRows((Array.isArray(rows) ? rows : []).map((row) => ({
    date: intraday ? normalizeTencentMinuteDate(row[0]) : String(row[0] || ""),
    open: Number(row[1]),
    close: Number(row[2]),
    high: Number(row[3]),
    low: Number(row[4]),
    adjClose: Number(row[2]),
    volume: Number(row[5] || 0),
  })), { preserveTimestamp: intraday });
}

function eastmoneySecidForCn(code) {
  const clean = cleanCode(code, "CN");
  if (/^SH(\d{6})$/.test(clean)) return `1.${clean.slice(2)}`;
  if (/^SZ(\d{6})$/.test(clean)) return `0.${clean.slice(2)}`;
  return `${/^6|^5|^9/.test(clean) ? "1" : "0"}.${clean}`;
}

function eastmoneyKltForInterval(interval) {
  return {
    "5m": "5",
    "15m": "15",
    "60m": "60",
    "1wk": "102",
  }[interval] || "101";
}

function eastmoneyKlinesToRows(payload) {
  const rows = payload?.data?.klines || [];
  return sanitizeCandleRows((Array.isArray(rows) ? rows : []).map((row) => {
    const parts = String(row || "").split(",");
    return {
      date: parts[0],
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      adjClose: Number(parts[2]),
      volume: Number(parts[5] || 0) * 100,
      amount: Number(parts[6] || 0),
      turnoverRate: Number(parts[10] || 0),
    };
  }), { preserveTimestamp: true });
}

function quoteFromCandleRows(symbol, market, candles = [], source = "candle-derived-quote") {
  const key = safeMarket(market);
  const rows = sanitizeCandleRows(candles).sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const latest = rows.at(-1);
  if (!latest?.close) return null;
  const previous = rows.length > 1 ? rows.at(-2) : null;
  const previousClose = positiveMarketNumber(previous?.close);
  const price = positiveMarketNumber(latest.close);
  const change = previousClose ? price - previousClose : null;
  return normalizeQuote({
    symbol,
    price,
    previousClose,
    change,
    changePercent: previousClose ? pctChange(price, previousClose) : null,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,
    currency: MARKET_CONFIG[key].currency,
    exchange: key === "CN" ? (/^SH|^6|^5|^9/.test(cleanCode(symbol, key)) ? "SSE" : "SZSE") : key,
    asOf: /^\d{4}-\d{2}-\d{2}T/.test(candleDate(latest))
      ? new Date(candleDate(latest)).toISOString()
      : `${candleDate(latest)}T00:00:00.000Z`,
    date: candleDate(latest),
    source,
    delayed: true,
    note: "Quote derived from latest real provider candle to keep point and change in the same source family.",
  }, key);
}

function rangeStartIso(range = "9mo") {
  const days = {
    "5d": 8,
    "1mo": 40,
    "3mo": 110,
    "6mo": 210,
    "9mo": 310,
    "1y": 390,
    "2y": 760,
    "3y": 1140,
    "5y": 1900,
    "10y": 3800,
  }[range] || 310;
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function intervalMs(interval = "1d") {
  return {
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "60m": 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  }[interval] || 24 * 60 * 60_000;
}

function tradeSideByTickRule(trade, previous = null, lastSide = "neutral") {
  const price = Number(trade?.price || 0);
  const previousPrice = Number(previous?.price || 0);
  if (price > 0 && previousPrice > 0 && price > previousPrice) return "buy";
  if (price > 0 && previousPrice > 0 && price < previousPrice) return "sell";
  return lastSide === "buy" || lastSide === "sell" ? lastSide : "neutral";
}

function priceLevelKey(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;
  const decimals = value < 1 ? 4 : value < 10 ? 3 : 2;
  return value.toFixed(decimals);
}

function tradeFootprintRows(candles = [], trades = [], options = {}) {
  const interval = options.interval || "1d";
  const source = options.source || "provider-trades";
  const sortedCandles = sanitizeCandleRows(candles, { preserveTimestamp: isIntradayInterval(interval) })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const sortedTrades = (Array.isArray(trades) ? trades : [])
    .filter((row) => row?.timestamp && Number(row.price) > 0 && Number(row.size) > 0)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || Number(a.sequence || 0) - Number(b.sequence || 0));
  if (!sortedCandles.length || !sortedTrades.length) {
    return {
      candles: sortedCandles,
      summary: {
        enriched_candles: 0,
        trade_rows_used: 0,
        side_method: "tick_rule_estimate",
        source,
      },
    };
  }
  const span = intervalMs(interval);
  let tradeIndex = 0;
  let previousTrade = null;
  let lastSide = "neutral";
  const enriched = sortedCandles.map((candle, candleIndex) => {
    const start = Date.parse(candle.date);
    const nextStart = candleIndex + 1 < sortedCandles.length ? Date.parse(sortedCandles[candleIndex + 1].date) : NaN;
    const end = Number.isFinite(nextStart) && nextStart > start ? nextStart : start + span;
    if (!Number.isFinite(start)) return candle;
    while (tradeIndex < sortedTrades.length && Date.parse(sortedTrades[tradeIndex].timestamp) < start) {
      previousTrade = sortedTrades[tradeIndex];
      tradeIndex += 1;
    }
    const levels = new Map();
    let buyVolume = 0;
    let sellVolume = 0;
    let neutralVolume = 0;
    let buyTrades = 0;
    let sellTrades = 0;
    let neutralTrades = 0;
    let used = 0;
    let cursor = tradeIndex;
    while (cursor < sortedTrades.length) {
      const trade = sortedTrades[cursor];
      const ts = Date.parse(trade.timestamp);
      if (!Number.isFinite(ts) || ts >= end) break;
      if (ts >= start) {
        const side = tradeSideByTickRule(trade, previousTrade, lastSide);
        if (side === "buy" || side === "sell") lastSide = side;
        const size = Number(trade.size || 0);
        const key = priceLevelKey(trade.price);
        if (key) {
          if (!levels.has(key)) {
            levels.set(key, {
              price: Number(key),
              buyVolume: 0,
              sellVolume: 0,
              neutralVolume: 0,
              buyTrades: 0,
              sellTrades: 0,
              neutralTrades: 0,
              source,
            });
          }
          const level = levels.get(key);
          if (side === "buy") {
            level.buyVolume += size;
            level.buyTrades += 1;
            buyVolume += size;
            buyTrades += 1;
          } else if (side === "sell") {
            level.sellVolume += size;
            level.sellTrades += 1;
            sellVolume += size;
            sellTrades += 1;
          } else {
            level.neutralVolume += size;
            level.neutralTrades += 1;
            neutralVolume += size;
            neutralTrades += 1;
          }
        }
        used += 1;
      }
      previousTrade = trade;
      cursor += 1;
    }
    tradeIndex = cursor;
    if (!used) return candle;
    const priceLevels = [...levels.values()]
      .sort((a, b) => b.price - a.price)
      .map((level) => ({
        price: level.price,
        buyVolume: Number(level.buyVolume.toFixed(4)),
        sellVolume: Number(level.sellVolume.toFixed(4)),
        neutralVolume: Number(level.neutralVolume.toFixed(4)),
        buyTrades: level.buyTrades,
        sellTrades: level.sellTrades,
        neutralTrades: level.neutralTrades,
        source,
        sideMethod: "tick_rule_estimate",
      }));
    return {
      ...candle,
      buyVolume: Number(buyVolume.toFixed(4)),
      sellVolume: Number(sellVolume.toFixed(4)),
      neutralVolume: Number(neutralVolume.toFixed(4)),
      buyTrades,
      sellTrades,
      neutralTrades,
      tradeCount: used,
      priceLevels,
      orderflowSource: source,
      orderflowSideMethod: "tick_rule_estimate",
      aggressorSideAvailable: false,
    };
  });
  const enrichedRows = enriched.filter((row) => Array.isArray(row.priceLevels) && row.priceLevels.length);
  return {
    candles: enriched,
    summary: {
      enriched_candles: enrichedRows.length,
      trade_rows_used: enrichedRows.reduce((sum, row) => sum + Number(row.tradeCount || 0), 0),
      price_level_rows: enrichedRows.reduce((sum, row) => sum + row.priceLevels.length, 0),
      side_method: "tick_rule_estimate",
      aggressor_side_available: false,
      true_l2: false,
      source,
    },
  };
}

function tencentQuoteFundamentals(symbol, quote = []) {
  const context = sectorContext(symbol, "CN");
  return {
    name: quote[1] || cleanCode(symbol, "CN"),
    sector: context.sector,
    industry: context.sector,
    marketCap: Number.isFinite(Number(quote[44])) ? `${quote[44]}亿人民币` : null,
    peRatio: Number.isFinite(Number(quote[39])) ? Number(quote[39]) : null,
    forwardPE: null,
    dividendYield: null,
    eps: null,
    profitMargin: null,
    beta: null,
    turnoverRate: Number.isFinite(Number(quote[38])) ? Number(quote[38]) : null,
    priceBook: Number.isFinite(Number(quote[46])) ? Number(quote[46]) : null,
  };
}

async function fetchTencentCnFundamentals(symbol) {
  const code = cleanCode(symbol, "CN");
  const tencentSymbol = tencentSymbolForCn(code);
  const endpoint = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentSymbol},day,,,1,qfq`;
  const payload = await fetchJson(endpoint, 5000);
  const quote = payload?.data?.[tencentSymbol]?.qt?.[tencentSymbol] || [];
  if (!quote.length) throw new Error("Tencent quote returned no fundamentals row.");
  return {
    source: "tencent-finance-cn-quote",
    fundamentals: tencentQuoteFundamentals(code, quote),
  };
}

async function fetchSecUsFundamentals(symbol) {
  const bundle = await fetchSecFilings(symbol, 4);
  return {
    source: "sec-edgar-company-profile",
    fundamentals: {
      name: bundle.companyName || cleanCode(symbol, "US"),
      sector: bundle.sicDescription || sectorContext(symbol, "US").sector,
      industry: bundle.sicDescription || sectorContext(symbol, "US").sector,
      marketCap: null,
      peRatio: null,
      forwardPE: null,
      dividendYield: null,
      eps: null,
      profitMargin: null,
      beta: null,
      recentFilings: (bundle.filings || []).slice(0, 3).map((item) => `${item.form} ${item.filingDate || ""}`.trim()),
    },
  };
}

function alphaVantageRows(payload) {
  const key = Object.keys(payload || {}).find((item) => /Time Series/i.test(item));
  const rows = payload?.[key] || {};
  return sanitizeCandleRows(Object.entries(rows).map(([date, row]) => ({
    date,
    open: Number(row["1. open"]),
    high: Number(row["2. high"]),
    low: Number(row["3. low"]),
    close: Number(row["4. close"]),
    adjClose: Number(row["5. adjusted close"] || row["4. close"]),
    volume: Number(row["6. volume"] || row["5. volume"] || 0),
  }))).sort((a, b) => a.date.localeCompare(b.date));
}

function marketNumber(value) {
  const number = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function usDateToIso(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return String(value || "").slice(0, 10);
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function nasdaqRows(payload, range = "9mo") {
  const rows = payload?.data?.tradesTable?.rows || [];
  const normalized = sanitizeCandleRows((Array.isArray(rows) ? rows : []).map((row) => {
    const close = marketNumber(row.close);
    return {
      date: usDateToIso(row.date),
      open: marketNumber(row.open) ?? close,
      high: marketNumber(row.high) ?? close,
      low: marketNumber(row.low) ?? close,
      close,
      adjClose: close,
      volume: marketNumber(row.volume) ?? 0,
    };
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  return normalized.slice(-candleLimitForRange(range));
}

function stooqRows(csv, range = "9mo") {
  const rows = sanitizeCandleRows(String(csv || "").trim().split(/\r?\n/).slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(",");
    return {
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      adjClose: Number(close),
      volume: Number(volume || 0),
    };
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  return rows.slice(-candleLimitForRange(range));
}

const SATOSHIMACRO_YAHOO_MARKETS_URL = "https://satoshimacro.com/assets/data/yahoo-markets.json";

function satoshiMacroSeriesForIndex(code, market = "ASX") {
  const key = safeMarket(market);
  const clean = cleanCode(code, key);
  if (key === "ASX" && clean === "^AXJO") return { key: "asx200", label: "S&P/ASX 200" };
  return null;
}

function closeOnlyLimitForRange(range = "9mo") {
  return candleLimitForRange(range);
}

function fredIndexCloseRows(csv, seriesId, range = "9mo") {
  const lines = String(csv || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header) => String(header || "").trim());
  const dateIndex = headers.findIndex((header) => /date/i.test(header));
  const valueIndex = headers.findIndex((header) => header.toUpperCase() === String(seriesId || "").toUpperCase());
  const normalized = sanitizeCandleRows(lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const date = String(cells[dateIndex] || "").trim();
    const close = Number(String(cells[valueIndex] || "").replace(/,/g, ""));
    return {
      date,
      open: close,
      high: close,
      low: close,
      close,
      adjClose: close,
      volume: 0,
      closeOnly: true,
    };
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  return normalized.slice(-closeOnlyLimitForRange(range));
}

async function fetchFredUsIndexCloseCandles(code, range, interval) {
  if (interval !== "1d") throw new Error("FRED public cash index series is daily close-only.");
  const index = usIndexProviderSymbols(code);
  if (!index?.fred) throw new Error(`FRED has no public close-only cash index series for ${code}.`);
  const endpoint = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
  endpoint.searchParams.set("id", index.fred);
  const csv = await fetchText(endpoint, 8000, { accept: "text/csv,text/plain,*/*" });
  const candles = fredIndexCloseRows(csv, index.fred, range);
  if (!candles.length) throw new Error(`FRED returned no ${index.label} close rows.`);
  return {
    candles,
    source: `fred-us-index-${index.fred.toLowerCase()}-daily-close`,
    unit: "points",
    closeOnly: true,
    warning: `FRED public ${index.label} daily close cash-index series. No OHLC, volume, or intraday bars are inferred.`,
  };
}

function satoshiMacroCloseRows(payload, seriesKey, range = "9mo") {
  const rows = payload?.series?.[seriesKey]?.data || [];
  const normalized = sanitizeCandleRows((Array.isArray(rows) ? rows : []).map((row) => {
    const close = Number(row?.close);
    return {
      date: String(row?.date || ""),
      open: close,
      high: close,
      low: close,
      close,
      adjClose: close,
      volume: 0,
      closeOnly: true,
    };
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  return normalized.slice(-closeOnlyLimitForRange(range));
}

async function fetchSatoshiMacroIndexCloseCandles(code, range, interval, market = "ASX") {
  if (interval !== "1d") throw new Error("SatoshiMacro public snapshot is daily close-only.");
  const series = satoshiMacroSeriesForIndex(code, market);
  if (!series) throw new Error(`SatoshiMacro has no close-only cash index series for ${code}.`);
  const payload = await fetchJson(SATOSHIMACRO_YAHOO_MARKETS_URL, 8000, {
    referer: "https://satoshimacro.com/tools/crypto/markets/asx-200/",
  });
  const candles = satoshiMacroCloseRows(payload, series.key, range);
  if (!candles.length) throw new Error(`SatoshiMacro returned no ${series.label} close rows.`);
  return {
    candles,
    source: `satoshimacro-yahoo-snapshot-${series.key}-close-only`,
    unit: "points",
    closeOnly: true,
    warning: `Public no-key ${series.label} close-only history; source metadata: ${payload?.source || "Yahoo Finance public chart snapshot"}${payload?.fetched_at ? `, fetched ${payload.fetched_at}` : ""}. No OHLC/volume is inferred.`,
  };
}

function stockAnalysisHistoryRows(html, range = "9mo") {
  const text = String(html || "");
  const block = text.match(/data:\[([\s\S]*?)\],created_at/)?.[1] || "";
  const rows = sanitizeCandleRows([...block.matchAll(/\{a:([^,}]+),c:([^,}]+),h:([^,}]+),l:([^,}]+),o:([^,}]+),t:"([^"]+)",v:([^,}]+)/g)]
    .map((match) => ({
      date: match[6],
      open: Number(match[5]),
      high: Number(match[3]),
      low: Number(match[4]),
      close: Number(match[2]),
      adjClose: Number(match[1]),
      volume: Number(match[7]),
    }))
  ).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows.slice(-candleLimitForRange(range));
}

function quoteDateFromTimestamp(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return null;
  return new Date(time * 1000).toISOString().slice(0, 10);
}

function normalizeQuote(quote, market = "ASX", latestClose = null) {
  const key = safeMarket(market);
  const price = Number(quote?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const reference = Number(latestClose);
  const rawPreviousClose = Number(quote?.previousClose);
  const previousClose = Number.isFinite(rawPreviousClose) && rawPreviousClose > 0
    ? rawPreviousClose
    : Number.isFinite(reference) && reference > 0
      ? reference
      : null;
  const hasExplicitChange = quote?.change !== null && quote?.change !== undefined && quote?.change !== "";
  const hasExplicitChangePercent = quote?.changePercent !== null && quote?.changePercent !== undefined && quote?.changePercent !== "";
  const change = hasExplicitChange && Number.isFinite(Number(quote.change))
    ? Number(quote.change)
    : Number.isFinite(previousClose) && previousClose > 0
      ? price - previousClose
      : null;
  const changePercent = hasExplicitChangePercent && Number.isFinite(Number(quote.changePercent))
    ? Number(quote.changePercent)
    : Number.isFinite(change) && Number.isFinite(previousClose) && previousClose > 0
      ? change / previousClose * 100
      : null;
  if (Number.isFinite(reference) && reference > 0) {
    const diffPct = Math.abs(price - reference) / reference * 100;
    const maxDiff = Number(process.env.REALTIME_QUOTE_MAX_DIFF_PCT || 35);
    if (diffPct > maxDiff) return null;
  }
  const retrievedAt = quote?.retrievedAt || new Date().toISOString();
  const verifiedAsOf = verifiedProviderTimestamp([quote?.asOf]);
  const timeVerified = quote?.timeVerified === true
    || (quote?.timeVerified !== false && Boolean(verifiedAsOf));
  const asOf = timeVerified ? verifiedAsOf : null;
  const date = timeVerified
    ? String(quote?.date || quoteDateFromTimestamp(Date.parse(asOf || "") / 1000) || "").slice(0, 10) || null
    : null;
  return {
    symbol: normalizeMarketSymbol(quote?.symbol || "", key) || quote?.symbol || null,
    market: key,
    price,
    previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
    change: Number.isFinite(change) ? Number(change.toFixed(4)) : null,
    changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(4)) : null,
    open: positiveMarketNumber(quote?.open),
    high: positiveMarketNumber(quote?.high),
    low: positiveMarketNumber(quote?.low),
    volume: Number.isFinite(Number(quote?.volume)) ? Number(quote.volume) : null,
    currency: quote?.currency || MARKET_CONFIG[key].currency,
    exchange: quote?.exchange || null,
    asOf,
    date,
    retrievedAt,
    timeVerified,
    source: quote?.source || "quote",
    delayed: quote?.delayed !== false,
    note: quote?.note || null,
  };
}

function quoteToCandles(quote) {
  if (!quote || quote.unavailable || quote.timeVerified === false || !/^\d{4}-\d{2}-\d{2}$/.test(String(quote.date || ""))) return [];
  const price = positiveMarketNumber(quote.price);
  if (!price) return [];
  const previous = positiveMarketNumber(quote.previousClose);
  const open = positiveMarketNumber(quote.open, previous || price);
  const high = Math.max(open, positiveMarketNumber(quote.high, price), price);
  const low = Math.min(open, positiveMarketNumber(quote.low, price), price);
  return sanitizeCandleRows([{
    date: String(quote.date).slice(0, 10),
    open,
    high,
    low,
    close: price,
    adjClose: price,
    volume: Number(quote.volume || 0),
    realtime: true,
    quoteSource: quote.source,
  }]);
}

function normalizeAsxTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return new Date().toISOString();
  const withColon = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(withColon);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function validateYahooMetaForMarket(meta, requestedYahooSymbol, market = "ASX") {
  const key = safeMarket(market);
  const returnedSymbol = String(meta?.symbol || "").toUpperCase();
  const exchange = String(meta?.exchangeName || meta?.fullExchangeName || meta?.exchangeTimezoneName || "").toUpperCase();
  const currency = String(meta?.currency || "").toUpperCase();
  if (key === "ASX") {
    if (returnedSymbol && returnedSymbol !== String(requestedYahooSymbol).toUpperCase()) {
      throw new Error(`Yahoo returned ${returnedSymbol} instead of ${requestedYahooSymbol}; rejected to avoid cross-market data.`);
    }
    if (currency && currency !== "AUD") throw new Error(`Yahoo returned ${currency}, not AUD; rejected for ASX.`);
    if (exchange && !/(ASX|AUSTRALIAN|SYDNEY)/.test(exchange)) {
      throw new Error(`Yahoo exchange ${exchange} does not look like ASX.`);
    }
  }
  if (key === "US" && currency && currency !== "USD") throw new Error(`Yahoo returned ${currency}, not USD; rejected for US.`);
  if (key === "CN" && currency && !/CNY|CNH/.test(currency)) throw new Error(`Yahoo returned ${currency}, not CNY/CNH; rejected for CN.`);
}

function yahooQuoteFromPayload(payload, requestedYahooSymbol, market = "ASX") {
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta || {};
  validateYahooMetaForMarket(meta, requestedYahooSymbol, market);
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  let lastIndex = -1;
  for (let index = timestamps.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(Number(quote.close?.[index])) && Number(quote.close[index]) > 0) {
      lastIndex = index;
      break;
    }
  }
  const timestamp = lastIndex >= 0 ? Number(timestamps[lastIndex]) : Number(meta.regularMarketTime);
  const price = Number(meta.regularMarketPrice || (lastIndex >= 0 ? quote.close[lastIndex] : 0));
  const previousClose = positiveMarketNumber(meta.previousClose)
    || positiveMarketNumber(meta.regularMarketPreviousClose)
    || positiveMarketNumber(meta.chartPreviousClose);
  return normalizeQuote({
    symbol: requestedYahooSymbol,
    price,
    previousClose,
    open: lastIndex >= 0 ? quote.open?.[lastIndex] : null,
    high: lastIndex >= 0 ? quote.high?.[lastIndex] : null,
    low: lastIndex >= 0 ? quote.low?.[lastIndex] : null,
    volume: lastIndex >= 0 ? quote.volume?.[lastIndex] : null,
    currency: meta.currency,
    exchange: meta.exchangeName || meta.fullExchangeName,
    asOf: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    date: quoteDateFromTimestamp(timestamp),
    retrievedAt: new Date().toISOString(),
    timeVerified: Number.isFinite(timestamp) && timestamp > 0,
    source: `yahoo-finance-${safeMarket(market).toLowerCase()}-quote`,
    delayed: true,
  }, market);
}

function stockAnalysisQuoteFromHtml(html, code) {
  const text = String(html || "");
  const points = [...text.matchAll(/\{c:([0-9.]+),t:(\d{10})\}/g)]
    .map((match) => ({ price: Number(match[1]), timestamp: Number(match[2]) }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0 && Number.isFinite(item.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!points.length) return null;
  const latest = points.at(-1);
  const previous = points.length > 1 ? points.at(-2) : null;
  return normalizeQuote({
    symbol: code,
    price: latest.price,
    previousClose: previous?.price || null,
    currency: "AUD",
    exchange: "ASX",
    asOf: new Date(latest.timestamp * 1000).toISOString(),
    date: quoteDateFromTimestamp(latest.timestamp),
    source: "stockanalysis-asx-quote",
    delayed: true,
    note: "StockAnalysis delayed ASX quote; used only as real free quote fallback.",
  }, "ASX");
}

function asxOfficialIndexCode(code) {
  const clean = cleanCode(code, "ASX");
  return {
    "^AXJO": "XJO",
    "^AORD": "XAO",
    "^AXAO": "XAO",
    "^AXKO": "XKO",
    XJO: "XJO",
    XAO: "XAO",
    AORD: "XAO",
    XKO: "XKO",
  }[clean] || clean.replace(/^\^A?/, "");
}

function symbolForAsxOfficialIndex(code) {
  const indexCode = asxOfficialIndexCode(code);
  if (indexCode === "XAO") return "^AORD";
  if (indexCode === "XKO") return "^AXKO";
  return "^AXJO";
}

async function fetchAsxOfficialIndexQuote(code) {
  const indexCode = asxOfficialIndexCode(code);
  if (!["XJO", "XAO", "XKO"].includes(indexCode)) {
    throw new Error(`Unsupported ASX official index code: ${code}`);
  }
  const endpoint = "https://www.asx.com.au/asx/1/index-info?callback=processRealTimeIndices";
  const text = await fetchText(endpoint, 7500, {
    accept: "application/javascript,text/javascript,text/plain,*/*",
    referer: "https://www.asx.com.au/markets/trade-our-cash-market/overview/indices/real-time-indices",
  });
  const payload = parseJsonpPayload(text);
  const row = (Array.isArray(payload) ? payload : []).find((item) => String(item.index_code || "").toUpperCase() === indexCode);
  if (!row) throw new Error(`ASX official index endpoint did not return ${indexCode}.`);
  const price = Number(row.current_value);
  const previousClose = Number(row.previous_trading_day_value);
  const asOf = normalizeAsxTimestamp(row.index_date);
  const percent = Number(row.change_in_percent_raw ?? String(row.change_in_percent || "").replace("%", ""));
  const quote = normalizeQuote({
    symbol: symbolForAsxOfficialIndex(indexCode),
    price,
    previousClose,
    change: row.index_change,
    changePercent: Number.isFinite(percent) ? percent : null,
    currency: "AUD",
    exchange: "ASX",
    asOf,
    date: asOf.slice(0, 10),
    source: "asx-official-index-quote",
    delayed: false,
    note: "ASX official real-time cash index point source.",
  }, "ASX");
  if (!quote) throw new Error(`ASX official index quote for ${indexCode} had no usable point value.`);
  return quote;
}

function verifiedProviderTimestamp(values = []) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (Number.isFinite(Number(value))) {
      const numeric = Number(value);
      const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) continue;
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function asxOfficialCompanyTimestamp(data = {}) {
  return verifiedProviderTimestamp([
    data.priceLastDateTime,
    data.priceLastDate,
    data.lastTradeDateTime,
    data.lastTradeDate,
    data.priceUpdatedAt,
    data.updatedAt,
    data.timestamp,
  ]);
}

async function fetchAsxOfficialQuote(code) {
  const clean = cleanCode(code, "ASX");
  if (/^\^/.test(clean)) return fetchAsxOfficialIndexQuote(clean);
  assertValidMarketCode(clean, "ASX");
  const endpoint = `https://asx.api.markitdigital.com/asx-research/1.0/companies/${encodeURIComponent(clean)}/header`;
  const payload = await fetchJson(endpoint, 6500, {
    referer: `https://www.asx.com.au/markets/company/${encodeURIComponent(clean)}`,
  });
  const data = payload?.data || {};
  const price = Number(data.priceLast);
  const change = Number(data.priceChange);
  const previousClose = Number.isFinite(price) && Number.isFinite(change) ? price - change : null;
  const retrievedAt = new Date().toISOString();
  const asOf = asxOfficialCompanyTimestamp(data);
  const quote = normalizeQuote({
    symbol: clean,
    price,
    previousClose,
    change,
    changePercent: data.priceChangePercent,
    volume: data.volume,
    currency: "AUD",
    exchange: "ASX",
    asOf,
    date: asOf ? zonedDateParts(new Date(asOf), "Australia/Sydney").date : null,
    retrievedAt,
    timeVerified: Boolean(asOf),
    source: "asx-official-company-header",
    delayed: true,
    note: asOf
      ? "ASX/Markit official company header quote with provider timestamp."
      : "ASX/Markit official company header quote; provider did not expose a verifiable trade timestamp, so it is not merged into OHLC history.",
  }, "ASX");
  if (!quote) throw new Error(`ASX official quote for ${clean} had no usable price.`);
  return quote;
}

function stooqQuoteSymbolForMarket(code, market = "US") {
  const key = safeMarket(market);
  const clean = cleanCode(code, key);
  if (key === "US") {
    const index = usIndexProviderSymbols(clean);
    if (index?.stooqQuote || index?.stooq) return index.stooqQuote || index.stooq;
    return `${clean.toLowerCase()}.us`;
  }
  throw new Error(`Stooq quote fallback is not configured for ${key}.`);
}

async function fetchStooqQuote(code, market = "US") {
  const key = safeMarket(market);
  assertValidMarketCode(code, key);
  const endpoint = new URL("https://stooq.com/q/l/");
  endpoint.searchParams.set("s", stooqQuoteSymbolForMarket(code, key));
  endpoint.searchParams.set("f", "sd2t2ohlcvp");
  endpoint.searchParams.set("h", "");
  endpoint.searchParams.set("e", "csv");
  const csv = await fetchText(endpoint, 5500, { accept: "text/csv,text/plain,*/*" });
  if (/get your apikey|captcha/i.test(csv)) throw new Error("Stooq quote CSV requires captcha/API key.");
  const row = stooqQuoteRows(csv)[0] || {};
  const close = marketNumber(row.Close);
  if (!close || /N\/D/i.test(Object.values(row).join(" "))) throw new Error("Stooq quote returned no usable row.");
  const date = String(row.Date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const time = /^\d{2}:\d{2}/.test(String(row.Time || "")) ? String(row.Time).slice(0, 8) : "00:00:00";
  const asOf = Number.isNaN(new Date(`${date}T${time}Z`).getTime())
    ? new Date().toISOString()
    : new Date(`${date}T${time}Z`).toISOString();
  const quote = normalizeQuote({
    symbol: code,
    price: close,
    previousClose: marketNumber(row.Prev),
    open: marketNumber(row.Open),
    high: marketNumber(row.High),
    low: marketNumber(row.Low),
    volume: marketNumber(row.Volume),
    currency: "USD",
    exchange: /^\^/.test(cleanCode(code, key)) ? "US cash index" : "US",
    asOf,
    date,
    source: /^\^/.test(cleanCode(code, key)) ? "stooq-us-index-quote" : "stooq-us-quote",
    delayed: true,
    note: "Stooq delayed quote CSV; used as a real quote fallback.",
  }, key);
  if (!quote) throw new Error("Stooq quote had no usable price.");
  return quote;
}

function decodeJsString(text) {
  return decodeXml(String(text || "")
    .replace(/\\"/g, "\"")
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
}

function stockAnalysisNewsFromHtml(html, code) {
  const text = String(html || "");
  const block = text.match(/news:\{exp:"[^"]*",data:\[([\s\S]*?)\]\},uses:/)?.[1] || "";
  if (!block) return [];
  return [...block.matchAll(/\{url:"((?:\\.|[^"])*)"[\s\S]*?title:"((?:\\.|[^"])*)"[\s\S]*?text:"((?:\\.|[^"])*)"[\s\S]*?source:"((?:\\.|[^"])*)"[\s\S]*?time:"((?:\\.|[^"])*)"/g)]
    .map((match) => ({
      title: decodeJsString(match[2]),
      publisher: decodeJsString(match[4]),
      link: decodeJsString(match[1]).startsWith("http")
        ? decodeJsString(match[1])
        : `https://stockanalysis.com${decodeJsString(match[1])}`,
      publishedAt: decodeJsString(match[5]),
      description: decodeJsString(match[3]),
      channel: "direct-stock",
      impactScope: "direct-stock",
      source: "stockanalysis-asx-news",
      market: "ASX",
      relatedSymbol: cleanCode(code, "ASX"),
      impactWeight: 1,
    }))
    .filter((item) => item.title && item.link)
    .slice(0, 20);
}

function gdeltNewsRows(payload) {
  return (payload?.articles || []).map((item) => ({
    title: item.title,
    publisher: item.domain,
    link: item.url,
    publishedAt: item.seendate || null,
  })).filter((item) => item.title && item.link);
}

function secAtomPick(block, tag) {
  return decodeXml(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "");
}

function secFilingsFromAtom(xml) {
  const text = String(xml || "");
  const companyName = stripHtml(secAtomPick(text, "conformed-name"));
  const sicDescription = stripHtml(secAtomPick(text, "assigned-sic-desc"));
  const cik = stripHtml(secAtomPick(text, "cik"));
  const filings = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const block = match[1];
    const form = decodeXml(block.match(/<category\b[^>]*term=["']([^"']+)["']/i)?.[1] || secAtomPick(block, "filing-type"));
    const link = decodeXml(block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || secAtomPick(block, "filing-href")).replace(/&amp;/g, "&");
    const summary = stripHtml(secAtomPick(block, "summary"));
    const items = stripHtml(secAtomPick(block, "items-desc") || summary);
    return {
      title: stripHtml(secAtomPick(block, "title")) || form,
      form,
      formName: stripHtml(secAtomPick(block, "form-name")),
      filingDate: stripHtml(secAtomPick(block, "filing-date")) || secAtomPick(block, "updated").slice(0, 10),
      publishedAt: secAtomPick(block, "updated"),
      link,
      description: items,
      publisher: "SEC EDGAR",
      channel: "direct-stock",
      impactScope: "sec-filing",
    };
  }).filter((item) => item.form || item.title);
  return { companyName, sicDescription, cik, filings };
}

async function fetchSecFilings(symbol, limit = 10) {
  const code = cleanCode(symbol, "US");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(code)) return { filings: [] };
  const cached = secFilingsCache.get(code);
  if (cached && Date.now() - cached.time < Number(process.env.SEC_FILINGS_CACHE_TTL_MS || 30 * 60 * 1000)) return cached.value;
  const endpoint = new URL("https://www.sec.gov/cgi-bin/browse-edgar");
  endpoint.searchParams.set("action", "getcompany");
  endpoint.searchParams.set("CIK", code);
  endpoint.searchParams.set("type", "");
  endpoint.searchParams.set("dateb", "");
  endpoint.searchParams.set("owner", "exclude");
  endpoint.searchParams.set("count", String(limit));
  endpoint.searchParams.set("output", "atom");
  const xml = await fetchText(endpoint, 6000, {
    "user-agent": process.env.SEC_USER_AGENT || "GlobalQuantWatch/1.0 contact@example.com",
  });
  const value = secFilingsFromAtom(xml);
  value.filings = value.filings.slice(0, limit);
  secFilingsCache.set(code, { time: Date.now(), value });
  if (secFilingsCache.size > 80) secFilingsCache.delete(secFilingsCache.keys().next().value);
  return value;
}

function sectorContext(code, market = "ASX") {
  const key = safeMarket(market);
  if (key === "US") {
    const usMap = {
      NVDA: { sector: "AI semiconductors", peers: "AMD OR AVGO OR TSM OR Microsoft AI", upstream: "AI capex OR data center spending OR chip export controls", macro: "Federal Reserve OR tariffs OR US economy OR China restrictions" },
      AAPL: { sector: "mega-cap technology", peers: "MSFT OR GOOGL OR META OR consumer electronics", upstream: "iPhone demand OR China sales OR app store regulation", macro: "Federal Reserve OR tariffs OR US consumer spending" },
      MSFT: { sector: "software cloud AI", peers: "GOOGL OR AMZN OR NVDA OR cloud computing", upstream: "Azure growth OR enterprise software spending OR AI capex", macro: "Federal Reserve OR US economy OR antitrust regulation" },
      TSLA: { sector: "EV automotive", peers: "BYD OR GM OR Ford OR EV sales", upstream: "lithium prices OR China EV demand OR robotaxi regulation", macro: "interest rates OR tariffs OR consumer credit" },
      AMZN: { sector: "e-commerce cloud advertising", peers: "WMT OR MSFT OR GOOGL OR Shopify", upstream: "AWS demand OR consumer spending OR logistics costs", macro: "Federal Reserve OR US consumer spending OR antitrust regulation" },
      GOOGL: { sector: "internet advertising AI", peers: "META OR MSFT OR AMZN OR search advertising", upstream: "AI capex OR digital ad spending OR cloud demand", macro: "antitrust regulation OR Federal Reserve OR US economy" },
      META: { sector: "social media advertising AI", peers: "GOOGL OR SNAP OR TikTok OR digital ads", upstream: "AI capex OR ad spending OR metaverse investment", macro: "privacy regulation OR Federal Reserve OR US consumer spending" },
      AMD: { sector: "AI semiconductors", peers: "NVDA OR AVGO OR INTC OR TSM", upstream: "AI accelerator demand OR data center spending OR chip export controls", macro: "Federal Reserve OR China restrictions OR tariffs" },
      JPM: { sector: "US banks", peers: "BAC OR WFC OR GS OR Morgan Stanley", upstream: "net interest margin OR credit losses OR capital rules", macro: "Federal Reserve OR yield curve OR recession OR unemployment" },
      XOM: { sector: "oil and gas energy", peers: "CVX OR COP OR OPEC OR Brent crude", upstream: "oil prices OR LNG demand OR refinery margins", macro: "Middle East conflict OR sanctions OR energy policy OR dollar" },
    };
    return usMap[cleanCode(code, key)] || {
      sector: "US equities",
      peers: "S&P 500 OR Nasdaq OR sector peers",
      upstream: "earnings guidance OR analyst upgrades OR supply chain",
      macro: "Federal Reserve OR inflation OR tariffs OR US election OR war",
    };
  }
  if (key === "CN") {
    const cnMap = {
      "600519": { sector: "白酒消费", peers: "五粮液 OR 泸州老窖 OR 山西汾酒 OR 白酒", upstream: "高端白酒需求 OR 消费复苏 OR 渠道库存 OR 批价", macro: "消费刺激 OR 居民收入 OR 反腐 OR 食品饮料政策" },
      "000858": { sector: "白酒消费", peers: "贵州茅台 OR 泸州老窖 OR 山西汾酒 OR 白酒", upstream: "高端白酒需求 OR 消费复苏 OR 渠道库存 OR 批价", macro: "消费刺激 OR 居民收入 OR 反腐 OR 食品饮料政策" },
      "300750": { sector: "新能源电池", peers: "比亚迪 OR 亿纬锂能 OR 国轩高科 OR 动力电池", upstream: "锂价 OR 碳酸锂 OR 储能需求 OR 新能源车销量", macro: "新能源补贴 OR 出口关税 OR 欧盟电池法规 OR 特斯拉" },
      "002594": { sector: "新能源汽车", peers: "特斯拉 OR 宁德时代 OR 长安汽车 OR 吉利汽车", upstream: "动力电池 OR 锂价 OR 汽车销量 OR 出口", macro: "新能源政策 OR 消费刺激 OR 关税 OR 自动驾驶监管" },
      "000001": { sector: "银行金融", peers: "招商银行 OR 工商银行 OR 平安保险 OR 银行", upstream: "LPR OR 房地产销售 OR 信贷投放 OR 不良率", macro: "央行降准 OR 利率 OR 房地产政策 OR 经济复苏" },
      "601318": { sector: "保险金融", peers: "中国人寿 OR 中国太保 OR 新华保险 OR 银行", upstream: "长端利率 OR 权益市场 OR 保险保费 OR 投资收益", macro: "央行政策 OR 资本市场改革 OR 房地产风险 OR 消费复苏" },
    };
    const clean = cleanCode(code, key);
    if (cnMap[clean]) return cnMap[clean];
    return {
      sector: "China A-shares",
      peers: "CSI 300 OR Shanghai Composite OR Shenzhen Component",
      upstream: "China stimulus OR property market OR domestic consumption OR export demand",
      macro: "PBOC OR China policy OR US China tariffs OR RMB exchange rate",
    };
  }
  const map = {
    BHP: {
      sector: "materials",
      peers: "RIO OR FMG OR iron ore OR copper",
      upstream: "China steel demand OR commodity prices OR mining royalties",
      macro: "China stimulus OR trade war OR infrastructure spending",
    },
    RIO: {
      sector: "materials",
      peers: "BHP OR FMG OR iron ore OR aluminium OR copper",
      upstream: "China steel demand OR commodity prices OR mining royalties",
      macro: "China stimulus OR trade war OR infrastructure spending",
    },
    WDS: {
      sector: "energy",
      peers: "Santos OR STO OR oil OR LNG OR natural gas",
      upstream: "OPEC OR Brent crude OR LNG prices OR Middle East conflict",
      macro: "war OR sanctions OR energy policy OR shipping disruption",
    },
    CBA: {
      sector: "banks",
      peers: "NAB OR ANZ OR Westpac OR WBC",
      upstream: "RBA OR interest rates OR mortgage arrears OR housing market",
      macro: "inflation OR unemployment OR government budget OR bank regulation",
    },
    NAB: {
      sector: "banks",
      peers: "CBA OR ANZ OR Westpac OR WBC",
      upstream: "RBA OR interest rates OR mortgage arrears OR housing market",
      macro: "inflation OR unemployment OR government budget OR bank regulation",
    },
    ANZ: {
      sector: "banks",
      peers: "CBA OR NAB OR Westpac OR WBC",
      upstream: "RBA OR interest rates OR mortgage arrears OR housing market",
      macro: "inflation OR unemployment OR government budget OR bank regulation",
    },
  };
  return map[cleanCode(code, "ASX")] || {
    sector: "general",
    peers: "ASX 200 OR Australia shares",
    upstream: "Australia economy OR RBA OR China OR commodities",
    macro: "war OR inflation OR interest rates OR government policy",
  };
}

function dedupeNews(items) {
  const seen = new Set();
  const rows = items.filter((item) => {
    const key = item.link || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rows
    .sort((a, b) => {
      const timeA = Date.parse(a.publishedAt || a.time || "") || 0;
      const timeB = Date.parse(b.publishedAt || b.time || "") || 0;
      if (timeA !== timeB) return timeB - timeA;
      return Number(b.impactWeight || 0) - Number(a.impactWeight || 0);
    })
    .slice(0, 36);
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(text) {
  return decodeXml(String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseAuDate(value) {
  const match = String(value || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function rssRows(xml, channel) {
  return [...String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((match) => {
    const block = match[1];
    const pick = (tag) => decodeXml(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || "");
    return {
      title: pick("title"),
      publisher: channel.startsWith("rba") ? "Reserve Bank of Australia" : "Google News",
      link: pick("link"),
      publishedAt: pick("pubDate") || pick("dc:date"),
      description: pick("description"),
      channel,
    };
  }).filter((item) => item.title && item.link);
}

function channelWeight(channel = "") {
  if (/direct|stock|symbol|company/.test(channel)) return 1;
  if (/policy|central-bank|macro-policy/.test(channel)) return 0.78;
  if (/upstream|supply|industry|sector/.test(channel)) return 0.68;
  if (/peer|competitor|complement/.test(channel)) return 0.56;
  if (/macro|global|leaders|geopolitical/.test(channel)) return 0.48;
  return 0.4;
}

function newsCategoryMeta(item = {}, channel = "") {
  const text = `${item.title || ""} ${item.description || ""} ${item.publisher || ""} ${channel}`.toLowerCase();
  const tests = [
    ["earnings", "财报/公告", 1.05, /earnings|revenue|profit|guidance|dividend|buyback|sec filing|annual report|quarterly|财报|业绩|利润|营收|分红|回购|公告|减持|增持|年报|季报/],
    ["politics-policy", "政治/政策", 0.86, /government|minister|president|election|policy|regulation|regulator|congress|parliament|政府|总统|总理|部长|选举|政策|监管|改革|财政|产业政策/],
    ["geopolitics", "国际局势", 0.82, /war|missile|sanction|tariff|trade war|middle east|ukraine|russia|taiwan|south china sea|战争|制裁|关税|冲突|导弹|地缘|俄乌|中东|台海|南海/],
    ["rates-macro", "利率/宏观", 0.9, /central bank|federal reserve|fed|rba|pboc|interest rate|inflation|cpi|jobs|unemployment|yield|bond|央行|美联储|澳联储|降息|加息|利率|通胀|就业|失业|债券|收益率|汇率/],
    ["finance-credit", "金融/信用", 0.78, /bank|credit|loan|mortgage|liquidity|debt|default|property|real estate|银行|信贷|贷款|按揭|流动性|债务|违约|房地产|地产/],
    ["technology", "科技/AI", 0.74, /ai|artificial intelligence|chip|semiconductor|nvidia|data center|cloud|software|robot|人工智能|芯片|半导体|英伟达|数据中心|云计算|软件|机器人/],
    ["commodity-energy", "大宗/能源", 0.76, /oil|gas|lng|opec|coal|iron ore|copper|gold|lithium|commodity|原油|天然气|煤炭|铁矿|铜|黄金|锂|大宗|能源/],
    ["supply-chain", "上下游/供应链", 0.72, /supply chain|supplier|demand|inventory|shipping|logistics|raw material|upstream|downstream|供应链|上游|下游|需求|库存|航运|物流|原材料/],
    ["consumer-social", "消费/社会", 0.58, /consumer|retail|sales|confidence|strike|social unrest|spending|消费|零售|销售|信心|罢工|舆情|居民|收入/],
  ];
  const matched = tests.find(([, , , pattern]) => pattern.test(text));
  const channelBonus = /direct|stock|company/.test(channel) ? 0.12 : /macro|policy/.test(channel) ? 0.06 : 0;
  if (!matched) {
    return {
      category: /peer|competitor/.test(channel) ? "peer-competitor" : /sector|industry/.test(channel) ? "sector-industry" : "market-news",
      categoryLabel: /peer|competitor/.test(channel) ? "竞品/同业" : /sector|industry/.test(channel) ? "行业新闻" : "市场新闻",
      categoryScore: Number((0.42 + channelBonus).toFixed(2)),
    };
  }
  return {
    category: matched[0],
    categoryLabel: matched[1],
    categoryScore: Number(Math.min(1.2, matched[2] + channelBonus).toFixed(2)),
  };
}

function addNewsMeta(items, source, channel, market, code) {
  return (items || []).map((item) => {
    const itemChannel = item.channel || channel;
    const category = newsCategoryMeta(item, itemChannel);
    const baseWeight = channelWeight(itemChannel);
    const impactWeight = Math.max(0.15, Math.min(1.35, baseWeight * category.categoryScore));
    return {
      ...item,
      source,
      channel: itemChannel,
      impactScope: item.impactScope || itemChannel,
      impactWeight: Number(impactWeight.toFixed(2)),
      category: item.category || category.category,
      categoryLabel: item.categoryLabel || category.categoryLabel,
      categoryScore: category.categoryScore,
      market,
      relatedSymbol: code,
    };
  });
}

async function fetchEastmoneyAnnouncements(code, limit = 12) {
  const clean = cleanCode(code, "CN").replace(/^(SH|SZ)/, "");
  if (!/^\d{6}$/.test(clean)) return [];
  const endpoint = new URL("https://np-anotice-stock.eastmoney.com/api/security/ann");
  endpoint.searchParams.set("sr", "-1");
  endpoint.searchParams.set("page_size", String(limit));
  endpoint.searchParams.set("page_index", "1");
  endpoint.searchParams.set("ann_type", "A");
  endpoint.searchParams.set("client_source", "web");
  endpoint.searchParams.set("stock_list", clean);
  const payload = await fetchJson(endpoint, 4500);
  return (payload?.data?.list || []).map((item) => ({
    title: item.title_ch || item.title,
    publisher: "东方财富公告",
    link: item.art_code ? `https://data.eastmoney.com/notices/detail/${clean}/${item.art_code}.html` : "https://data.eastmoney.com/notices/",
    publishedAt: item.display_time || item.notice_date || item.sort_date,
    description: (item.columns || []).map((column) => column.column_name).filter(Boolean).join(" / "),
    channel: "direct-stock",
    impactScope: "exchange-announcement",
  })).filter((item) => item.title);
}

function marketNewsLocale(market) {
  const key = safeMarket(market);
  if (key === "US") return { hl: "en-US", gl: "US", ceid: "US:en", newsapiLanguage: "en", newsdataLanguage: "en" };
  if (key === "CN") return { hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans", newsapiLanguage: "zh", newsdataLanguage: "zh" };
  return { hl: "en-AU", gl: "AU", ceid: "AU:en", newsapiLanguage: "en", newsdataLanguage: "en" };
}

function impactQueriesFor(code, market = "ASX") {
  const key = safeMarket(market);
  const context = sectorContext(code, key);
  const marketName = MARKET_CONFIG[key].newsName;
  const macro = macroNewsQueriesFor(key);
  const stock = stockNewsQueriesFor(code, key, context, marketName);
  return [...stock, ...macro];
}

function macroNewsQueriesFor(market = "ASX") {
  const key = safeMarket(market);
  const marketName = MARKET_CONFIG[key].newsName;
  const policy = key === "US"
    ? "Federal Reserve inflation interest rates tariffs Wall Street"
    : key === "CN"
      ? "中国 央行 货币政策 刺激 A股 产业政策 出口 关税"
      : "RBA interest rates inflation Australia ASX";
  const global = "war sanctions tariffs oil China commodities Nvidia Tesla Trump Musk Jensen Huang";
  const cnGlobal = "战争 制裁 关税 原油 中国 大宗商品 英伟达 特斯拉 特朗普 马斯克 黄仁勋";
  const tech = key === "CN" ? "科技 人工智能 半导体 新能源 政策 产业链" : "technology AI semiconductors cloud data center market";
  const finance = key === "CN" ? "金融 银行 房地产 债务 利率 股市 流动性" : "banks credit yields bonds liquidity stock market financial conditions";
  const society = key === "CN" ? "社会 消费 就业 房地产 信心 风险 舆情" : "consumer confidence employment social unrest strikes regulation market sentiment";
  return [
    { channel: "macro-policy", query: `${marketName} ${policy}`, zhQuery: policy },
    { channel: "macro-tech", query: `${marketName} ${tech}`, zhQuery: tech },
    { channel: "macro-finance", query: `${marketName} ${finance}`, zhQuery: finance },
    { channel: "macro-social", query: `${marketName} ${society}`, zhQuery: society },
    { channel: "global-geopolitical", query: global, zhQuery: cnGlobal },
  ];
}

function stockNewsQueriesFor(code, market = "ASX", context = sectorContext(code, market), marketName = MARKET_CONFIG[safeMarket(market)].newsName) {
  const key = safeMarket(market);
  return [
    { channel: "direct-stock", query: `${code} ${marketName} earnings stock price`, zhQuery: `${code} 股票 财报 股价 公告` },
    { channel: "peer-competitor", query: `${context.peers} ${marketName} competitors outlook`, zhQuery: `${context.peers} 竞争 对手 行业 股价` },
    { channel: "upstream-supply-chain", query: `${context.upstream} supply demand prices`, zhQuery: `${context.upstream} 上游 下游 供应链 需求 价格` },
    { channel: "sector-industry", query: `${context.sector} ${marketName} sector industry outlook`, zhQuery: `${context.sector} 行业 景气 政策` },
  ];
}

function peerCodesFor(code, market = "ASX") {
  const key = safeMarket(market);
  if (key === "US") {
    const map = {
      NVDA: ["AMD", "AVGO", "TSM"],
      AAPL: ["MSFT", "GOOGL", "META"],
      MSFT: ["AAPL", "GOOGL", "AMZN"],
      TSLA: ["GM", "F", "NIO"],
      JPM: ["BAC", "WFC", "GS"],
      XOM: ["CVX", "COP"],
    };
    return map[cleanCode(code, key)] || [];
  }
  if (key === "CN") {
    const map = {
      "600519": ["000858", "000568"],
      "300750": ["002594", "300014"],
      "000001": ["600036", "601398"],
      "601318": ["601601", "600030"],
    };
    return map[cleanCode(code, key)] || [];
  }
  const map = {
    BHP: ["RIO", "FMG"],
    RIO: ["BHP", "FMG"],
    FMG: ["BHP", "RIO"],
    WDS: ["STO"],
    STO: ["WDS"],
    CBA: ["NAB", "ANZ", "WBC"],
    NAB: ["CBA", "ANZ", "WBC"],
    ANZ: ["CBA", "NAB", "WBC"],
    WBC: ["CBA", "NAB", "ANZ"],
  };
  return map[cleanCode(code, "ASX")] || [];
}

function pctReturn(candles, days = 20) {
  const rows = sanitizeCandleRows(candles);
  if (rows.length <= days) return 0;
  return ((rows.at(-1).close - rows.at(-1 - days).close) / rows.at(-1 - days).close) * 100;
}

function pctChange(current, previous) {
  const prev = Number(previous);
  const value = Number(current);
  if (!Number.isFinite(value) || !Number.isFinite(prev) || Math.abs(prev) < 0.000001) return 0;
  return ((value - prev) / Math.abs(prev)) * 100;
}

function sanitizeIndexQuoteChange(symbol, market, candles = [], quote = null) {
  if (!quote || quote.unavailable || !String(symbol || "").startsWith("^")) {
    return { quote, warning: "" };
  }
  const rows = sanitizeCandleRows(candles);
  if (rows.length < 2) return { quote, warning: "" };
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const previousClose = Number(previous.close);
  const latestClose = Number(latest.close);
  if (!Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(latestClose) || latestClose <= 0) {
    return { quote, warning: "" };
  }
  const candleChange = latestClose - previousClose;
  const candleChangePercent = pctChange(latestClose, previousClose);
  const quoteChangePercent = Number(quote.changePercent);
  const quotePreviousClose = Number(quote.previousClose);
  const previousCloseDiff = Number.isFinite(quotePreviousClose) && quotePreviousClose > 0
    ? Math.abs(quotePreviousClose - previousClose) / previousClose * 100
    : null;
  const changePercentDiff = Number.isFinite(quoteChangePercent)
    ? Math.abs(quoteChangePercent - candleChangePercent)
    : null;
  const quoteDate = String(quote.date || "").slice(0, 10);
  const latestDate = String(latest.date || "").slice(0, 10);
  const invalidChange = Number.isFinite(quoteChangePercent) && (
    Math.abs(quoteChangePercent) > 8
    || (quoteDate && latestDate && quoteDate !== latestDate)
  );
  const base = {
    ...quote,
    candleChange: Number(candleChange.toFixed(4)),
    candleChangePercent: Number(candleChangePercent.toFixed(4)),
  };
  if (!invalidChange) return { quote: base, warning: "" };
  const reason = quoteDate && latestDate && quoteDate !== latestDate
      ? `provider quote date ${quoteDate} does not match latest candle date ${latestDate}`
      : `provider quote changePercent ${quoteChangePercent.toFixed(4)}% is outside index sanity bounds`;
  return {
    quote: {
      ...base,
      rawPreviousClose: Number.isFinite(quotePreviousClose) ? quotePreviousClose : null,
      rawChange: Number.isFinite(Number(quote.change)) ? Number(quote.change) : null,
      rawChangePercent: Number.isFinite(quoteChangePercent) ? quoteChangePercent : null,
      previousClose: Number(previousClose.toFixed(4)),
      change: Number(candleChange.toFixed(4)),
      changePercent: Number(candleChangePercent.toFixed(4)),
      invalidChangePercent: true,
      changeSource: "real-candles",
      note: [quote.note, reason].filter(Boolean).join(" | "),
    },
    warning: `Index quote changePercent rejected: ${reason}; using adjacent real index candles for daily change.`,
  };
}

function sanitizeQuoteChangeAgainstCandles(symbol, market, candles = [], quote = null, now = new Date()) {
  if (!quote || quote.unavailable) return { quote, warning: "" };
  if (String(symbol || "").startsWith("^")) return sanitizeIndexQuoteChange(symbol, market, candles, quote);
  const rows = sanitizeCandleRows(candles).sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const latest = rows.at(-1);
  const previous = rows.length > 1 ? rows.at(-2) : null;
  const price = positiveMarketNumber(quote.price);
  if (!latest || !price) return { quote, warning: "" };

  const latestDate = candleDate(latest);
  const quoteDate = String(quote.date || "").slice(0, 10);
  if (quote.timeVerified !== false && quoteDate && latestDate && quoteDate < latestDate) {
    const fallback = quoteFromCandleRows(symbol, market, rows, `${quote.source || "quote"}-stale-fallback`);
    return {
      quote: fallback || quote,
      warning: `Realtime quote date ${quoteDate} was older than the latest real candle ${latestDate}; using the latest real candle instead.`,
    };
  }

  const currentMarketDate = zonedDateParts(now, marketTimeZone(market)).date;
  const quoteRepresentsLatestRow = quoteDate
    ? quoteDate === latestDate
    : latestDate === currentMarketDate;
  const expectedPreviousClose = positiveMarketNumber(
    quoteRepresentsLatestRow ? previous?.close : latest?.close,
  );
  if (!expectedPreviousClose) return { quote, warning: "" };

  const expectedChange = price - expectedPreviousClose;
  const expectedChangePercent = pctChange(price, expectedPreviousClose);
  const providerPreviousClose = positiveMarketNumber(quote.previousClose);
  const providerChangePercent = Number(quote.changePercent);
  const previousCloseDiff = providerPreviousClose
    ? Math.abs(providerPreviousClose - expectedPreviousClose) / expectedPreviousClose * 100
    : 0;
  const changePercentDiff = Number.isFinite(providerChangePercent)
    ? Math.abs(providerChangePercent - expectedChangePercent)
    : 0;
  const maxPreviousCloseDiff = Math.max(0.25, Number(process.env.QUOTE_PREVIOUS_CLOSE_MAX_DIFF_PCT || 3));
  const maxChangePercentDiff = Math.max(0.25, Number(process.env.QUOTE_CHANGE_MAX_DIFF_POINTS || 3));
  if (previousCloseDiff <= maxPreviousCloseDiff && changePercentDiff <= maxChangePercentDiff) {
    return { quote, warning: "" };
  }

  const reason = `provider previous close/change disagreed with adjacent real candles (${previousCloseDiff.toFixed(2)}% / ${changePercentDiff.toFixed(2)}pts)`;
  return {
    quote: {
      ...quote,
      rawPreviousClose: providerPreviousClose || null,
      rawChange: Number.isFinite(Number(quote.change)) ? Number(quote.change) : null,
      rawChangePercent: Number.isFinite(providerChangePercent) ? providerChangePercent : null,
      previousClose: Number(expectedPreviousClose.toFixed(4)),
      change: Number(expectedChange.toFixed(4)),
      changePercent: Number(expectedChangePercent.toFixed(4)),
      invalidChangePercent: true,
      changeSource: "adjacent-real-candles",
      note: [quote.note, reason].filter(Boolean).join(" | "),
    },
    warning: `Quote change fields rejected: ${reason}; price remains the latest real quote.`,
  };
}

const FACTOR_LAYER_KEYS = [
  "announcements",
  "shortInterest",
  "macro",
  "sector",
  "socialMedia",
  "minuteLearning",
  "flowOptions",
  "marketRegime",
  "relativeStrength",
  "liquidity",
  "calibration",
  "factorResearch",
];

function researchFactorValue(name, technicals = {}) {
  const close = finiteNumber(technicals.close, 0);
  const sma20 = finiteNumber(technicals.sma20, close);
  const vwapDistance = Number(technicals.vwapDistancePct);
  const rangePosition = Number(technicals.rangePosition);
  return {
    momentum_5: clampNumber(finiteNumber(technicals.change5d, 0), -10, 10),
    momentum_20: clampNumber(finiteNumber(technicals.change20d, 0) * 0.5, -10, 10),
    reversal_5: clampNumber(-finiteNumber(technicals.change5d, 0), -10, 10),
    volatility_10: clampNumber(4 - finiteNumber(technicals.volatility, 0) * 2, -10, 10),
    volume_ratio_20: clampNumber((finiteNumber(technicals.volumeRatio, 1) - 1) * 8, -10, 10),
    trend_gap_20: clampNumber(close > 0 && sma20 > 0 ? pctChange(close, sma20) * 0.7 : 0, -10, 10),
    vwap_gap: Number.isFinite(vwapDistance) ? clampNumber(vwapDistance, -10, 10) : undefined,
    range_position: Number.isFinite(rangePosition) ? clampNumber((rangePosition - 0.5) * 20, -10, 10) : undefined,
  }[name];
}

function factorSignal(factors = {}, factorConfig = {}, technicals = {}) {
  const safeFactors = factors || {};
  const config = factorConfig && typeof factorConfig === "object" && !Array.isArray(factorConfig) ? factorConfig : {};
  const configuredNames = Object.keys(config);
  const layerRows = FACTOR_LAYER_KEYS
    .map((name) => ({ name, factor: safeFactors[name], config: config[name] }))
    .filter((row) => row.factor && row.factor.available !== false);
  const activeLayerRows = layerRows.filter((row) => row.config?.enabled !== false);
  const configuredLayerWeights = activeLayerRows
    .filter((row) => row.config && Number(row.config.weightPct || 0) > 0)
    .map((row) => Number(row.config.weightPct));
  const configuredLayerWeightMean = configuredLayerWeights.length
    ? configuredLayerWeights.reduce((sum, value) => sum + value, 0) / configuredLayerWeights.length
    : 0;
  const layerScore = activeLayerRows.reduce((sum, row) => {
    const configuredWeight = Math.max(0, Number(row.config?.weightPct || 0));
    const multiplier = configuredLayerWeightMean > 0 && configuredWeight > 0
      ? configuredWeight / configuredLayerWeightMean
      : 1;
    return sum + Number(row.factor.score || 0) * multiplier;
  }, 0);
  const researchRows = configuredNames
    .filter((name) => !FACTOR_LAYER_KEYS.includes(name) && config[name]?.enabled !== false)
    .map((name) => ({ name, weight: Math.max(0, Number(config[name]?.weightPct || 0)), value: researchFactorValue(name, technicals) }))
    .filter((row) => Number.isFinite(row.value));
  const researchWeightTotal = researchRows.reduce((sum, row) => sum + row.weight, 0);
  const researchScore = researchRows.length
    ? researchRows.reduce((sum, row) => sum + row.value * (researchWeightTotal > 0 ? row.weight / researchWeightTotal : 1 / researchRows.length), 0)
    : 0;
  const configApplied = configuredNames.length > 0;
  const score = layerScore + researchScore;
  const enabledFactors = [...new Set([...activeLayerRows.map((row) => row.name), ...researchRows.map((row) => row.name)])];
  const disabledFactors = configuredNames.filter((name) => config[name]?.enabled === false);
  const unavailableConfiguredFactors = configuredNames.filter((name) => (
    config[name]?.enabled !== false
    && !enabledFactors.includes(name)
  ));
  const configuredWeightPct = Object.fromEntries(configuredNames.map((name) => [
    name,
    config[name]?.enabled === false ? 0 : Number(Number(config[name]?.weightPct || 0).toFixed(3)),
  ]));
  const factorContributions = [
    ...activeLayerRows.map((row) => {
      const configuredWeight = Math.max(0, Number(row.config?.weightPct || 0));
      const multiplier = configuredLayerWeightMean > 0 && configuredWeight > 0
        ? configuredWeight / configuredLayerWeightMean
        : 1;
      return {
        name: row.name,
        source: "live-factor-layer",
        value: Number(row.factor.score || 0),
        effectiveWeight: Number(multiplier.toFixed(4)),
        contribution: Number((Number(row.factor.score || 0) * multiplier).toFixed(4)),
      };
    }),
    ...researchRows.map((row) => {
      const normalizedWeight = researchWeightTotal > 0 ? row.weight / researchWeightTotal : 1 / researchRows.length;
      return {
        name: row.name,
        source: "saved-research-config",
        value: Number(row.value.toFixed(4)),
        effectiveWeight: Number(normalizedWeight.toFixed(4)),
        contribution: Number((row.value * normalizedWeight).toFixed(4)),
      };
    }),
  ];
  return {
    score: Math.max(-25, Math.min(25, score)),
    checked: activeLayerRows.length + researchRows.length,
    stance: score > 6 ? "supportive" : score < -6 ? "risk-off" : "mixed",
    notes: [
      ...activeLayerRows.flatMap((row) => row.factor.thesis || []),
      ...(configApplied ? [`Saved factor configuration applied: ${enabledFactors.join(", ") || "all configured factors disabled"}.`] : []),
      ...(unavailableConfiguredFactors.length ? [`Configured factors unavailable for this analysis: ${unavailableConfiguredFactors.join(", ")}.`] : []),
    ].slice(0, 8),
    configApplied,
    configScore: Number(researchScore.toFixed(3)),
    layerScore: Number(layerScore.toFixed(3)),
    enabledFactors,
    disabledFactors,
    unavailableConfiguredFactors,
    configuredWeightPct,
    factorContributions,
  };
}

function newsSignal(items, code, market = "ASX") {
  const context = sectorContext(code, market);
  const negativeTerms = [
    "war", "missile", "invasion", "sanction", "tariff", "trade war", "recession", "slowdown",
    "rate hike", "higher rates", "inflation rises", "default", "profit warning", "downgrade",
    "strike", "regulator", "investigation", "loss", "plunge", "slump", "guidance cut",
    "sec investigation", "doj investigation", "antitrust", "export controls", "late filing",
    "offering", "dilution", "class action",
    "战争", "导弹", "入侵", "制裁", "关税", "贸易战", "衰退", "放缓", "加息", "通胀上升",
    "违约", "业绩预警", "下调", "调查", "亏损", "暴跌", "下滑", "监管处罚", "立案",
    "问询函", "减持", "商誉减值", "退市风险", "业绩预亏", "利润下降",
  ];
  const positiveTerms = [
    "rate cut", "stimulus", "ceasefire", "peace deal", "upgrade", "beats expectations",
    "record profit", "buyback", "dividend increase", "demand rises", "prices rise", "approval",
    "earnings beat", "raises guidance", "ai demand", "data center demand", "share repurchase",
    "sec filing", "form 10-q", "form 10-k",
    "降息", "刺激", "停火", "和平协议", "上调", "超预期", "创纪录利润", "回购", "增持",
    "分红增加", "需求上升", "价格上涨", "获批", "政策支持", "补贴", "业绩预增",
    "中标", "订单", "股权激励", "利润增长",
  ];
  const scored = (items || []).map((item) => {
    const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
    let itemScore = 0;
    for (const term of negativeTerms) if (text.includes(term.toLowerCase())) itemScore -= 4;
    for (const term of positiveTerms) if (text.includes(term.toLowerCase())) itemScore += 4;
    if (/energy|能源/.test(context.sector) && /war|sanction|middle east|opec|brent|oil prices rise|战争|制裁|中东|欧佩克|原油上涨/.test(text)) itemScore += 3;
    if (/materials|矿|材料/.test(context.sector) && /china stimulus|steel demand|iron ore prices rise|copper prices rise|中国刺激|钢铁需求|铁矿石上涨|铜价上涨/.test(text)) itemScore += 5;
    if (/banks|银行|金融/.test(context.sector) && /rate cut|mortgage growth|housing rebound|降息|按揭增长|楼市回暖/.test(text)) itemScore += 3;
    if (/banks|银行|金融/.test(context.sector) && /mortgage arrears|higher rates|recession|unemployment rises|房贷拖欠|高利率|衰退|失业上升/.test(text)) itemScore -= 5;
    if (/AI|semiconductor|semiconductors|technology|cloud|advertising/i.test(context.sector) && /ai capex|data center|earnings beat|raises guidance|accelerator demand|cloud growth/i.test(text)) itemScore += 4;
    if (/semiconductor|technology|AI/i.test(context.sector) && /export controls|china restrictions|antitrust|doj investigation|sec investigation/i.test(text)) itemScore -= 5;
    if (/banks|US banks/i.test(context.sector) && /credit losses|deposit outflows|capital rules|yield curve inversion|recession/i.test(text)) itemScore -= 5;
    if (/energy|oil/i.test(context.sector) && /oil prices rise|brent crude rises|opec cuts|supply disruption|sanctions/i.test(text)) itemScore += 4;
    if (/新能源|电池|汽车/.test(context.sector) && /锂价下跌|电池需求|新能源车销量|储能|出口增长|特斯拉/.test(text)) itemScore += 4;
    if (/白酒|消费/.test(context.sector) && /批价上涨|消费复苏|回购|增持|分红|中秋|春节/.test(text)) itemScore += 3;
    if (/白酒|消费/.test(context.sector) && /禁酒|反腐|库存高企|批价下跌|需求疲软/.test(text)) itemScore -= 5;
    const weight = Number(item.impactWeight || channelWeight(item.channel));
    return {
      item,
      score: itemScore * weight,
      rawScore: itemScore,
      weight,
    };
  });
  const score = scored.reduce((sum, row) => sum + row.score, 0);
  const influences = scored
    .filter((row) => Math.abs(row.score) >= 2)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5)
    .map((row) => ({
      title: row.item.title,
      channel: row.item.channel,
      source: row.item.source || row.item.publisher,
      score: Number(row.score.toFixed(2)),
      weight: row.weight,
    }));
  return {
    score: Math.max(-20, Math.min(20, score)),
    stance: score > 4 ? "supportive" : score < -4 ? "risk-off" : "mixed",
    checkedItems: items.length,
    influences,
  };
}

function latestByDate(candles) {
  return sanitizeCandleRows(candles).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
}

function compareMarketSources(primary, secondary) {
  const first = latestByDate(primary.candles);
  const second = latestByDate(secondary.candles);
  if (!first || !second) {
    return {
      ok: false,
      status: "missing_latest_candle",
      message: "At least one provider did not return a latest candle.",
    };
  }

  const priceDiffPct = Math.abs(first.close - second.close) / ((first.close + second.close) / 2) * 100;
  const dateMatches = first.date === second.date;
  const volumeDiffPct = first.volume && second.volume
    ? Math.abs(first.volume - second.volume) / ((first.volume + second.volume) / 2) * 100
    : null;
  const ok = dateMatches && priceDiffPct <= Number(process.env.MARKET_PRICE_DIFF_MAX_PCT || 2);

  return {
    ok,
    status: ok ? "validated" : "conflict",
    primary: { source: primary.source, date: first.date, close: first.close, volume: first.volume },
    secondary: { source: secondary.source, date: second.date, close: second.close, volume: second.volume },
    priceDiffPct,
    volumeDiffPct,
    message: ok
      ? "EODHD and Twelve Data latest close are within the configured tolerance."
      : "Market providers disagree beyond tolerance or latest dates differ.",
  };
}

function singleSourceValidation(source, errors = []) {
  const latest = latestByDate(source.candles);
  return {
    ok: true,
    status: "degraded_single_source",
    degraded: true,
    primary: latest ? { source: source.source, date: latest.date, close: latest.close, volume: latest.volume } : null,
    errors: compactProviderErrors(errors),
    message: "Only one real market provider was available; analysis is allowed with reduced confidence.",
  };
}

function compactProviderErrors(errors = []) {
  return errors.map((error) => String(error || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/<[^|]{0,220}(?=\s*\||$)/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .replace(/Thank you for using Alpha Vantage![\s\S]*$/i, "Alpha Vantage rate/daily limit; fallback provider used.")
    .replace(/Edge:\s*Too Many Requests|HTTP 429[\s\S]*$/i, "Yahoo Finance rate limit; fallback provider used.")
    .replace(/HTTP 403[\s\S]*$/i, "Provider edge/permission block; fallback provider used.")
    .replace(/HTTP 404:\s*Stooq\s*/i, "Stooq HTTP 404/no rows")
    .replace(/HTTP 404:\s*$/i, "HTTP 404/no rows")
    .replace(/Stooq[\s\S]*?(?:captcha|verify your browser|__verify)[\s\S]*$/i, "Stooq requires browser verification/API key; fallback provider used.")
    .replace(/You may subscribe[\s\S]*$/i, "Provider plan/rate limit; fallback provider used.")
    .slice(0, 180));
}

async function fetchAlpacaUsCandles(code, range, interval) {
  if (!alpacaConfigured()) {
    throw new Error("ALPACA_API_KEY/ALPACA_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY are required");
  }
  const ticker = cleanCode(code, "US");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || ticker.startsWith("^")) {
    throw new Error(`Alpaca bars require a valid US stock ticker: ${ticker}`);
  }
  const endpoint = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars`);
  endpoint.searchParams.set("timeframe", {
    "5m": "5Min",
    "15m": "15Min",
    "60m": "1Hour",
    "1wk": "1Week",
  }[interval] || "1Day");
  endpoint.searchParams.set("start", `${rangeStartIso(range)}T00:00:00Z`);
  endpoint.searchParams.set("limit", "10000");
  endpoint.searchParams.set("adjustment", "all");
  endpoint.searchParams.set("feed", process.env.ALPACA_DATA_FEED || "iex");
  endpoint.searchParams.set("sort", "asc");
  const payload = await fetchJson(endpoint, 7000, alpacaAuthHeaders());
  const candles = alpacaRows(payload, interval);
  if (!candles.length) throw new Error(`Alpaca returned no real bars for ${ticker}.`);
  return { candles, source: `alpaca-${process.env.ALPACA_DATA_FEED || "iex"}-us-${interval}` };
}

function alpacaAuthHeaders() {
  return {
    "APCA-API-KEY-ID": alpacaApiKey(),
    "APCA-API-SECRET-KEY": alpacaApiSecret(),
  };
}

function alpacaApiKey() {
  return process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY_ID || "";
}

function alpacaApiSecret() {
  return process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || "";
}

function alpacaConfigured() {
  return Boolean(alpacaApiKey() && alpacaApiSecret());
}

async function fetchAlpacaUsTrades(code, windowMinutes = 30) {
  if (!alpacaConfigured()) {
    throw new Error("ALPACA_API_KEY/ALPACA_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY are required for real US trades.");
  }
  const ticker = cleanCode(code, "US");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || ticker.startsWith("^")) {
    throw new Error(`Alpaca trades require a valid US stock ticker: ${ticker}`);
  }
  const safeWindow = Math.max(1, Math.min(390, Number(windowMinutes) || 30));
  const limit = Math.max(100, Math.min(10000, Number(process.env.ALPACA_TRADES_LIMIT || 1000)));
  const feed = process.env.ALPACA_DATA_FEED || "iex";
  const endpoint = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/trades`);
  endpoint.searchParams.set("start", new Date(Date.now() - safeWindow * 60000).toISOString());
  endpoint.searchParams.set("limit", String(limit));
  endpoint.searchParams.set("feed", feed);
  endpoint.searchParams.set("sort", "asc");
  const payload = await fetchJson(endpoint, 7000, alpacaAuthHeaders());
  return {
    available: true,
    trades: alpacaTradeRows(payload),
    source: `alpaca-${feed}-us-trades`,
    real_trades: true,
    true_l2: false,
    aggressor_side_available: false,
    nextPageToken: payload?.next_page_token || null,
  };
}

async function fetchAlpacaUsLatestQuote(code) {
  if (!alpacaConfigured()) {
    throw new Error("ALPACA_API_KEY/ALPACA_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY are required for real US L1 quotes.");
  }
  const ticker = cleanCode(code, "US");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || ticker.startsWith("^")) {
    throw new Error(`Alpaca quotes require a valid US stock ticker: ${ticker}`);
  }
  const feed = process.env.ALPACA_DATA_FEED || "iex";
  const endpoint = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`);
  endpoint.searchParams.set("feed", feed);
  const payload = await fetchJson(endpoint, 7000, alpacaAuthHeaders());
  const quotes = alpacaQuoteRows(payload);
  if (!quotes.length) throw new Error(`Alpaca returned no real L1 quote for ${ticker}.`);
  return {
    available: true,
    quotes,
    latest: quotes.at(-1),
    source: `alpaca-${feed}-us-l1-quote`,
    real_l1: true,
    true_l2: false,
  };
}

async function fetchAlpacaUsSnapshotQuote(code) {
  if (!alpacaConfigured()) {
    throw new Error("ALPACA_API_KEY/ALPACA_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY are required for real US snapshots.");
  }
  const ticker = cleanCode(code, "US");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || ticker.startsWith("^")) {
    throw new Error(`Alpaca snapshots require a valid US stock ticker: ${ticker}`);
  }
  const feed = process.env.ALPACA_DATA_FEED || "iex";
  const endpoint = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/snapshot`);
  endpoint.searchParams.set("feed", feed);
  const payload = await fetchJson(endpoint, 7000, alpacaAuthHeaders());
  const tradePrice = positiveMarketNumber(payload?.latestTrade?.p);
  const minutePrice = positiveMarketNumber(payload?.minuteBar?.c);
  const bid = positiveMarketNumber(payload?.latestQuote?.bp);
  const ask = positiveMarketNumber(payload?.latestQuote?.ap);
  const midpoint = bid && ask ? (bid + ask) / 2 : bid || ask;
  const price = tradePrice || minutePrice || midpoint;
  if (!price) throw new Error(`Alpaca returned no usable real snapshot price for ${ticker}.`);
  const asOf = String(payload?.latestTrade?.t || payload?.minuteBar?.t || payload?.latestQuote?.t || "");
  return {
    symbol: ticker,
    market: "US",
    price,
    previousClose: positiveMarketNumber(payload?.prevDailyBar?.c),
    open: positiveMarketNumber(payload?.dailyBar?.o),
    high: positiveMarketNumber(payload?.dailyBar?.h),
    low: positiveMarketNumber(payload?.dailyBar?.l),
    volume: Number.isFinite(Number(payload?.dailyBar?.v)) ? Number(payload.dailyBar.v) : null,
    asOf: asOf || null,
    date: asOf ? asOf.slice(0, 10) : null,
    retrievedAt: new Date().toISOString(),
    timeVerified: Boolean(asOf),
    source: `alpaca-${feed}-us-snapshot`,
    delayed: false,
    note: tradePrice
      ? `Latest real trade from Alpaca ${feed.toUpperCase()} feed.`
      : minutePrice
        ? `Latest completed minute price from Alpaca ${feed.toUpperCase()} feed.`
        : `Indicative bid/ask midpoint from Alpaca ${feed.toUpperCase()} feed.`,
  };
}

async function fetchTushareCnCandles(code, range, interval) {
  if (!process.env.TUSHARE_TOKEN) throw new Error("TUSHARE_TOKEN is required");
  if (interval !== "1d") throw new Error("Tushare adapter currently exposes daily A-share candles only.");
  const clean = cleanCode(code, "CN");
  if (!/^\d{6}$/.test(clean)) throw new Error(`Tushare daily bars require a six-digit A-share code: ${clean}`);
  const tsCode = `${clean}.${/^6|^5|^9/.test(clean) ? "SH" : "SZ"}`;
  const payload = await fetchJsonPost("https://api.tushare.pro", {
    api_name: "daily",
    token: process.env.TUSHARE_TOKEN,
    params: {
      ts_code: tsCode,
      start_date: rangeStartIso(range).replace(/-/g, ""),
      end_date: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    },
    fields: "ts_code,trade_date,open,high,low,close,vol,amount",
  }, 7000);
  if (Number(payload?.code || 0) !== 0) throw new Error(payload?.msg || `Tushare error ${payload?.code}`);
  const candles = tushareRows(payload);
  if (!candles.length) throw new Error(`Tushare returned no real daily bars for ${tsCode}.`);
  return { candles, source: "tushare-cn-daily" };
}

function finnhubResolution(interval = "1d") {
  return {
    "5m": "5",
    "15m": "15",
    "60m": "60",
    "1d": "D",
    "1wk": "W",
    "1mo": "M",
  }[interval] || "D";
}

function finnhubSymbolsForCode(code, market = "US") {
  const key = safeMarket(market);
  const clean = cleanCode(code, key);
  if (clean.startsWith("^")) {
    const index = usIndexProviderSymbols(clean);
    return Array.isArray(index?.finnhub) ? index.finnhub : [];
  }
  if (key === "ASX") return [`${clean}.AX`];
  if (key === "US") return [clean];
  return [];
}

function tiingoTickersForCode(code, market = "US") {
  const key = safeMarket(market);
  const clean = cleanCode(code, key);
  if (clean.startsWith("^")) {
    const index = usIndexProviderSymbols(clean);
    return Array.isArray(index?.tiingo) ? index.tiingo : [];
  }
  if (key === "ASX") return [`${clean}.AX`, clean];
  if (key === "US") return [clean];
  return [];
}

async function fetchFinnhubCandles(code, range, interval, market = "US") {
  if (!process.env.FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY is required");
  const key = safeMarket(market);
  const backoffKey = `finnhub-${key.toLowerCase()}`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const symbols = finnhubSymbolsForCode(code, key);
  if (!symbols.length) throw new Error(`Finnhub does not support ${key} symbol ${code} in this adapter.`);
  const from = Math.floor(new Date(rangeStartIso(range)).getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  const errors = [];
  for (const symbol of symbols) {
    const endpoint = new URL("https://finnhub.io/api/v1/stock/candle");
    endpoint.searchParams.set("symbol", symbol);
    endpoint.searchParams.set("resolution", finnhubResolution(interval));
    endpoint.searchParams.set("from", String(from));
    endpoint.searchParams.set("to", String(to));
    endpoint.searchParams.set("token", process.env.FINNHUB_API_KEY);
    try {
      const payload = await fetchJson(endpoint, 7000);
      if (payload?.s && payload.s !== "ok") throw new Error(payload?.s === "no_data" ? "no_data" : payload?.s);
      const candles = finnhubRows(payload, interval);
      if (candles.length) {
        return {
          candles,
          source: `finnhub-${key.toLowerCase()}${cleanCode(code, key).startsWith("^") ? "-index" : ""}-${symbol}`,
          unit: cleanCode(code, key).startsWith("^") ? "points" : undefined,
        };
      }
      errors.push(`${symbol}: no rows`);
    } catch (error) {
      const message = String(error.message || error);
      if (/429|limit|rate|token|Forbidden|unauthorized/i.test(message)) {
        backoffProvider(backoffKey, 20 * 60 * 1000, `Finnhub ${key} skipped after rate/permission error; using another real source if available.`);
      }
      errors.push(`${symbol}: ${message}`);
    }
  }
  throw new Error(errors.join(" | ") || "Finnhub returned no candles.");
}

async function fetchTiingoCandles(code, range, interval, market = "US") {
  if (isIntradayInterval(interval)) throw new Error("Tiingo adapter currently exposes daily candles only.");
  const key = safeMarket(market);
  const backoffKey = `tiingo-${key.toLowerCase()}`;
  const tickers = tiingoTickersForCode(code, key);
  if (!tickers.length) throw new Error(`Tiingo does not support ${key} symbol ${code} in this adapter.`);
  return withProviderApiKey("tiingo", {
    backoffKey,
    backoffMs: 20 * 60 * 1000,
    label: `Tiingo ${key}`,
    exhaustedReason: `Tiingo ${key} key pool exhausted; using another real source if available.`,
  }, async (apiKey) => {
    const errors = [];
    for (const ticker of tickers) {
      const endpoint = new URL(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`);
      endpoint.searchParams.set("startDate", rangeStartIso(range));
      endpoint.searchParams.set("endDate", new Date().toISOString().slice(0, 10));
      endpoint.searchParams.set("token", apiKey);
      try {
        const payload = await fetchJson(endpoint, 7000);
        const candles = tiingoRows(payload, interval);
        if (candles.length) {
          return {
            candles,
            source: `tiingo-${key.toLowerCase()}${cleanCode(code, key).startsWith("^") ? "-index" : ""}-${ticker}`,
            unit: cleanCode(code, key).startsWith("^") ? "points" : undefined,
          };
        }
        errors.push(`${ticker}: no rows`);
      } catch (error) {
        errors.push(`${ticker}: ${String(error.message || error)}`);
      }
    }
    throw new Error(errors.join(" | ") || "Tiingo returned no candles.");
  });
}

async function fetchBaostockCnCandles(code, range, interval) {
  const startDate = rangeStartIso(range);
  const endDate = new Date().toISOString().slice(0, 10);
  const result = await runPythonQuantCore("baostock-candles", {
    market: "CN",
    symbol: cleanCode(code, "CN"),
    interval,
    start_date: startDate,
    end_date: endDate,
  }, Number(process.env.PYTHON_CORE_TIMEOUT_MS || 16000));
  const candles = sanitizeCandleRows(result.candles || [], { preserveTimestamp: isIntradayInterval(interval) });
  if (!candles.length) throw new Error(`Baostock returned no real rows for ${code}.`);
  return { candles, source: result.source || `baostock-cn-${interval}` };
}

async function fetchTwelveDataCandles(code, range, interval, market = "ASX") {
  const key = safeMarket(market);
  const backoffKey = `twelvedata-${key.toLowerCase()}`;
  return withProviderApiKey("twelvedata", {
    backoffKey,
    backoffMs: 6 * 60 * 60 * 1000,
    label: `Twelve Data ${key}`,
    exhaustedReason: `Twelve Data ${key} key pool exhausted after quota/permission checks; using another real source if available.`,
  }, async (apiKey) => {
    const endpoint = new URL("https://api.twelvedata.com/time_series");
    endpoint.searchParams.set("symbol", cleanCode(code, key));
    const exchange = twelveExchangeForCode(code, key);
    if (exchange) endpoint.searchParams.set("exchange", exchange);
    endpoint.searchParams.set("interval", normalizeTwelveInterval(interval));
    endpoint.searchParams.set("outputsize", String(isIntradayInterval(interval) ? 390 : Math.min(5000, candleLimitForRange(range))));
    endpoint.searchParams.set("apikey", apiKey);
    const payload = await fetchJson(endpoint);
    if (payload?.status === "error") throw new Error(payload.message || "Twelve Data error");
    return { candles: twelveDataRows(payload), source: `twelvedata-${key.toLowerCase()}` };
  });
}

async function fetchTwelveDataIndexCandles(code, range, interval, market = "US") {
  const key = safeMarket(market);
  const index = usIndexProviderSymbols(code);
  if (!index) throw new Error(`Unsupported ${key} cash index: ${code}`);
  const backoffKey = `twelvedata-${key.toLowerCase()}-index`;
  return withProviderApiKey("twelvedata", {
    backoffKey,
    backoffMs: 6 * 60 * 60 * 1000,
    label: `Twelve Data ${key} index`,
    exhaustedReason: `Twelve Data ${key} index key pool exhausted after quota/permission checks; using another real index source if available.`,
  }, async (apiKey) => {
    const endpoint = new URL("https://api.twelvedata.com/time_series");
    endpoint.searchParams.set("symbol", index.twelve);
    endpoint.searchParams.set("exchange", key === "ASX" ? "ASX" : "INDEX");
    endpoint.searchParams.set("interval", normalizeTwelveInterval(interval));
    endpoint.searchParams.set("outputsize", String(Math.min(5000, candleLimitForRange(range))));
    endpoint.searchParams.set("apikey", apiKey);
    const payload = await fetchJson(endpoint, 7000);
    if (payload?.status === "error") throw new Error(payload.message || "Twelve Data index error");
    const candles = twelveDataRows(payload);
    if (!candles.length) throw new Error(`Twelve Data returned no ${key} index candles.`);
    return { candles, source: `twelvedata-${key.toLowerCase()}-index-${index.twelve}`, unit: "points" };
  });
}

async function fetchEodhdCandles(code, range, interval, market = "ASX") {
  const key = safeMarket(market);
  const backoffKey = `eodhd-${key.toLowerCase()}`;
  const ticker = eodhdTickerForCode(code, key);
  return withProviderApiKey("eodhd", {
    backoffKey,
    backoffMs: 12 * 60 * 60 * 1000,
    label: `EODHD ${key}`,
    exhaustedReason: `EODHD ${key} key pool exhausted after quota/auth checks; using another real source if available.`,
  }, async (apiKey) => {
    if (isIntradayInterval(interval)) {
      const endpoint = new URL(`https://eodhd.com/api/intraday/${ticker}`);
      endpoint.searchParams.set("interval", interval);
      endpoint.searchParams.set("fmt", "json");
      endpoint.searchParams.set("api_token", apiKey);
      const payload = await fetchJson(endpoint, 7000);
      return { candles: eodhdIntradayRows(payload), source: `eodhd-${key.toLowerCase()}-${interval}` };
    }
    const endpoint = new URL(`https://eodhd.com/api/eod/${ticker}`);
    endpoint.searchParams.set("from", rangeStartIso(range));
    endpoint.searchParams.set("period", interval === "1wk" ? "w" : "d");
    endpoint.searchParams.set("fmt", "json");
    endpoint.searchParams.set("api_token", apiKey);
    const payload = await fetchJson(endpoint);
    return { candles: eodhdRows(payload), source: `eodhd-${key.toLowerCase()}` };
  });
}

async function fetchAlphaVantageCandles(code, range, interval, market = "US") {
  if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY is required");
  const key = safeMarket(market);
  if (key === "ASX") throw new Error("Alpha Vantage is not configured as an ASX source in this app.");
  const backoffKey = `alphavantage-${key.toLowerCase()}`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  await throttleAlphaVantage();
  const endpoint = new URL("https://www.alphavantage.co/query");
  endpoint.searchParams.set("symbol", alphaVantageSymbolForCode(code, key));
  endpoint.searchParams.set("apikey", process.env.ALPHAVANTAGE_API_KEY);
  endpoint.searchParams.set("outputsize", range === "1mo" ? "compact" : "full");
  if (isIntradayInterval(interval)) {
    endpoint.searchParams.set("function", "TIME_SERIES_INTRADAY");
    endpoint.searchParams.set("interval", { "5m": "5min", "15m": "15min", "60m": "60min" }[interval] || "60min");
  } else {
    endpoint.searchParams.set("function", "TIME_SERIES_DAILY_ADJUSTED");
  }
  const payload = await fetchJson(endpoint, 8000);
  if (payload.Note || payload.Information) {
    const message = payload.Note || payload.Information;
    if (/25 requests per day|free API requests|rate limit|premium/i.test(message)) {
      backoffProvider(backoffKey, /25 requests per day|free API requests/i.test(message) ? 12 * 60 * 60 * 1000 : 90 * 1000, `Alpha Vantage ${key} skipped after rate/daily limit; using another real source if available.`);
    }
    throw new Error(message);
  }
  const candles = alphaVantageRows(payload);
  return { candles, source: `alphavantage-${key.toLowerCase()}` };
}

async function fetchYahooMarketCandles(code, range, interval, market = "ASX") {
  const key = safeMarket(market);
  const backoffKey = `yahoo-${key.toLowerCase()}`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const yahooSymbol = yahooSymbolForMarket(code, key);
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
  try {
    const payload = await fetchJson(endpoint, 4500);
    const result = payload?.chart?.result?.[0];
    validateYahooMetaForMarket(result?.meta || {}, yahooSymbol, key);
    return {
      candles: yahooCandlesToRows(payload),
      quote: yahooQuoteFromPayload(payload, yahooSymbol, key),
      source: `yahoo-finance-${key.toLowerCase()}`,
    };
  } catch (error) {
    const message = String(error.message || error);
    if (/429|403|Too Many Requests|Unexpected token|not valid JSON/i.test(message)) {
      backoffProvider(backoffKey, /403/.test(message) ? 60 * 60 * 1000 : 15 * 60 * 1000, `Yahoo Finance ${key} skipped after edge/rate limit; using another real source if available.`);
    }
    throw error;
  }
}

async function fetchYahooQuote(code, market = "ASX") {
  const key = safeMarket(market);
  const backoffKey = `yahoo-${key.toLowerCase()}-quote`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const yahooSymbol = yahooSymbolForMarket(code, key);
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m&includePrePost=false`;
  try {
    const payload = await fetchJson(endpoint, 3500);
    const quote = yahooQuoteFromPayload(payload, yahooSymbol, key);
    if (!quote) throw new Error("Yahoo quote had no usable real-time price.");
    return quote;
  } catch (error) {
    const message = String(error.message || error);
    if (/429|403|Too Many Requests|Unexpected token|not valid JSON/i.test(message)) {
      backoffProvider(backoffKey, /403/.test(message) ? 60 * 60 * 1000 : 15 * 60 * 1000, `Yahoo Finance ${key} quote skipped after edge/rate limit; using another real quote source if available.`);
    }
    throw error;
  }
}

async function fetchEodhdQuote(code, market = "ASX") {
  const key = safeMarket(market);
  const backoffKey = `eodhd-${key.toLowerCase()}-quote`;
  return withProviderApiKey("eodhd", {
    backoffKey,
    backoffMs: 12 * 60 * 60 * 1000,
    label: `EODHD ${key} quote`,
    exhaustedReason: `EODHD ${key} quote key pool exhausted; using another real quote source if available.`,
  }, async (apiKey) => {
    const endpoint = new URL(`https://eodhd.com/api/real-time/${eodhdTickerForCode(code, key)}`);
    endpoint.searchParams.set("fmt", "json");
    endpoint.searchParams.set("api_token", apiKey);
    const payload = await fetchJson(endpoint, 4500);
    const timestamp = Number(payload.timestamp || 0);
    const quote = normalizeQuote({
      symbol: code,
      price: payload.close ?? payload.price,
      previousClose: payload.previousClose,
      change: payload.change,
      changePercent: payload.change_p,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      volume: payload.volume,
      currency: MARKET_CONFIG[key].currency,
      exchange: key,
      asOf: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
      date: Number.isFinite(timestamp) && timestamp > 0 ? quoteDateFromTimestamp(timestamp) : null,
      retrievedAt: new Date().toISOString(),
      timeVerified: Number.isFinite(timestamp) && timestamp > 0,
      source: `eodhd-${key.toLowerCase()}-quote`,
      delayed: true,
    }, key);
    if (!quote) throw new Error("EODHD quote had no usable price.");
    return quote;
  });
}

async function fetchTwelveDataQuote(code, market = "ASX") {
  const key = safeMarket(market);
  const backoffKey = `twelvedata-${key.toLowerCase()}-quote`;
  return withProviderApiKey("twelvedata", {
    backoffKey,
    backoffMs: 6 * 60 * 60 * 1000,
    label: `Twelve Data ${key} quote`,
    exhaustedReason: `Twelve Data ${key} quote key pool exhausted; using another real quote source if available.`,
  }, async (apiKey) => {
    const endpoint = new URL("https://api.twelvedata.com/quote");
    endpoint.searchParams.set("symbol", cleanCode(code, key));
    const exchange = twelveExchangeForCode(code, key);
    if (exchange) endpoint.searchParams.set("exchange", exchange);
    endpoint.searchParams.set("apikey", apiKey);
    const payload = await fetchJson(endpoint, 4500);
    if (payload?.status === "error") throw new Error(payload.message || "Twelve Data quote error");
    const providerTime = String(payload.datetime || "");
    const hasIntradayTime = /(?:T|\s)\d{2}:\d{2}/.test(providerTime);
    const quote = normalizeQuote({
      symbol: code,
      price: payload.close,
      previousClose: payload.previous_close,
      change: payload.change,
      changePercent: payload.percent_change,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      volume: payload.volume,
      currency: payload.currency || MARKET_CONFIG[key].currency,
      exchange: payload.exchange || exchange || key,
      asOf: hasIntradayTime ? providerTime : null,
      date: /^\d{4}-\d{2}-\d{2}/.test(providerTime) ? providerTime.slice(0, 10) : null,
      retrievedAt: new Date().toISOString(),
      timeVerified: hasIntradayTime,
      source: `twelvedata-${key.toLowerCase()}-quote`,
      delayed: true,
    }, key);
    if (!quote) throw new Error("Twelve Data quote had no usable price.");
    return quote;
  });
}

async function fetchStockAnalysisAsxCandles(code, range, interval) {
  if (interval !== "1d") throw new Error("StockAnalysis ASX fallback is daily only.");
  assertValidMarketCode(code, "ASX");
  const backoffKey = "stockanalysis-asx";
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = `https://stockanalysis.com/quote/asx/${encodeURIComponent(cleanCode(code, "ASX"))}/history/`;
  try {
    const html = await fetchText(endpoint, 6500);
    const candles = stockAnalysisHistoryRows(html, range);
    if (!candles.length) throw new Error("StockAnalysis returned no ASX historical rows.");
    return { candles, quote: stockAnalysisQuoteFromHtml(html, code), source: "stockanalysis-asx-daily" };
  } catch (error) {
    const message = String(error.message || error);
    if (/cloudflare|just a moment|403|429|captcha/i.test(message)) {
      backoffProvider(backoffKey, 60 * 60 * 1000, "StockAnalysis ASX skipped after edge/captcha limit; using another real source if available.");
    } else if (/no ASX historical rows/i.test(message)) {
      backoffProvider(backoffKey, 15 * 60 * 1000, "StockAnalysis ASX returned no historical rows; using another real source if available.");
    }
    throw error;
  }
}

async function fetchStockAnalysisAsxQuote(code) {
  assertValidMarketCode(code, "ASX");
  const backoffKey = "stockanalysis-asx-quote";
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = `https://stockanalysis.com/quote/asx/${encodeURIComponent(cleanCode(code, "ASX"))}/`;
  try {
    const html = await fetchText(endpoint, 4500);
    const quote = stockAnalysisQuoteFromHtml(html, code);
    if (!quote) throw new Error("StockAnalysis returned no quote row.");
    return quote;
  } catch (error) {
    const message = String(error.message || error);
    if (/cloudflare|just a moment|403|429|captcha/i.test(message)) {
      backoffProvider(backoffKey, 60 * 60 * 1000, "StockAnalysis ASX quote skipped after edge/captcha limit; using another quote source if available.");
    }
    throw error;
  }
}

async function fetchNasdaqUsCandles(code, range, interval) {
  if (interval !== "1d") throw new Error("Nasdaq fallback is daily only.");
  assertValidMarketCode(code, "US");
  const backoffKey = "nasdaq-us";
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const to = new Date();
  const from = new Date();
  from.setTime(new Date(`${rangeStartIso(range)}T00:00:00Z`).getTime());
  const endpoint = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(cleanCode(code, "US"))}/historical`);
  endpoint.searchParams.set("assetclass", "stocks");
  endpoint.searchParams.set("fromdate", from.toISOString().slice(0, 10));
  endpoint.searchParams.set("todate", to.toISOString().slice(0, 10));
  endpoint.searchParams.set("limit", "9999");
  try {
    const payload = await fetchJson(endpoint, 6500, {
      "user-agent": "Mozilla/5.0 Global Quant Watch",
      accept: "application/json, text/plain, */*",
      origin: "https://www.nasdaq.com",
      referer: "https://www.nasdaq.com/",
    });
    const candles = nasdaqRows(payload, range);
    if (!candles.length) throw new Error("Nasdaq returned no historical rows.");
    return { candles, source: "nasdaq-us-daily" };
  } catch (error) {
    const message = String(error.message || error);
    if (/403|429|Too Many Requests|cloudflare|captcha|not valid JSON/i.test(message)) {
      backoffProvider(backoffKey, 30 * 60 * 1000, "Nasdaq US skipped after edge/rate limit; using another real source if available.");
    }
    throw error;
  }
}

async function fetchNasdaqUsIndexCandles(code, range, interval) {
  if (interval !== "1d") throw new Error("Nasdaq index fallback is daily only.");
  const index = usIndexProviderSymbols(code);
  if (!index) throw new Error(`Unsupported US cash index: ${code}`);
  const backoffKey = "nasdaq-us-index";
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const symbolCandidates = {
    "^GSPC": ["SPX", "SP500", "INX"],
    "^SPX": ["SPX", "SP500", "INX"],
    "^IXIC": ["COMP", "IXIC"],
    "^COMP": ["COMP", "IXIC"],
    "^DJI": ["DJIA", "DJI"],
  }[cleanCode(code, "US")] || [cleanCode(code, "US").replace(/^\^/, "")];
  const to = new Date();
  const from = new Date();
  from.setTime(new Date(`${rangeStartIso(range)}T00:00:00Z`).getTime());
  const errors = [];
  for (const candidate of symbolCandidates) {
    const endpoint = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(candidate)}/historical`);
    endpoint.searchParams.set("assetclass", "index");
    endpoint.searchParams.set("fromdate", from.toISOString().slice(0, 10));
    endpoint.searchParams.set("todate", to.toISOString().slice(0, 10));
    endpoint.searchParams.set("limit", "9999");
    try {
      const payload = await fetchJson(endpoint, 6500, {
        "user-agent": "Mozilla/5.0 Global Quant Watch",
        accept: "application/json, text/plain, */*",
        origin: "https://www.nasdaq.com",
        referer: "https://www.nasdaq.com/",
      });
      const candles = nasdaqRows(payload, range);
      if (candles.length) return { candles, source: `nasdaq-us-index-${candidate}`, unit: "points" };
      errors.push(`${candidate}: no historical rows`);
    } catch (error) {
      errors.push(`${candidate}: ${error.message || error}`);
    }
  }
  if (errors.some((message) => /403|429|Too Many Requests|cloudflare|captcha|not valid JSON/i.test(message))) {
    backoffProvider(backoffKey, 30 * 60 * 1000, "Nasdaq US index skipped after edge/rate limit; using another real index source if available.");
  }
  throw new Error(errors.join(" | ") || "Nasdaq returned no US index rows.");
}

async function fetchStooqUsCandles(code, range, interval) {
  if (interval !== "1d") throw new Error("Stooq fallback is daily only.");
  assertValidMarketCode(code, "US");
  const backoffKey = "stooq-us";
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = new URL("https://stooq.com/q/d/l/");
  endpoint.searchParams.set("s", `${cleanCode(code, "US").toLowerCase()}.us`);
  endpoint.searchParams.set("i", "d");
  const csv = await fetchText(endpoint, 4500);
  if (/get your apikey|captcha/i.test(csv)) {
    backoffProvider(backoffKey, 6 * 60 * 60 * 1000, "Stooq US skipped because CSV download now requires captcha/API key.");
    throw new Error("Stooq CSV download requires captcha/API key.");
  }
  const candles = stooqRows(csv, range);
  if (!candles.length) throw new Error("Stooq returned no daily candles.");
  return { candles, source: "stooq-us-daily" };
}

async function fetchStooqIndexCandles(code, range, interval, market = "US") {
  if (interval !== "1d") throw new Error("Stooq index fallback is daily only.");
  const key = safeMarket(market);
  const index = usIndexProviderSymbols(code);
  if (!index) throw new Error(`Unsupported ${key} cash index: ${code}`);
  const backoffKey = `stooq-${key.toLowerCase()}-index`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = new URL("https://stooq.com/q/d/l/");
  endpoint.searchParams.set("s", index.stooq);
  endpoint.searchParams.set("i", "d");
  if (process.env.STOOQ_API_KEY) endpoint.searchParams.set("apikey", process.env.STOOQ_API_KEY);
  const csv = await fetchText(endpoint, 5500);
  if (/get your apikey|captcha|requires JavaScript to verify your browser|__verify/i.test(csv)) {
    backoffProvider(backoffKey, 6 * 60 * 60 * 1000, `Stooq ${key} index skipped because CSV download now requires captcha/API key.`);
    throw new Error("Stooq index CSV download requires browser verification/captcha/API key.");
  }
  const candles = stooqRows(csv, range);
  if (!candles.length) throw new Error(`Stooq returned no ${key} index candles.`);
  return { candles, source: `stooq-${key.toLowerCase()}-index-${index.stooq}`, unit: "points" };
}

async function fetchTencentCnCandles(code, range, interval) {
  const symbol = tencentSymbolForCn(code);
  if (isIntradayInterval(interval)) {
    const minute = { "5m": "m5", "15m": "m15", "60m": "m60" }[interval] || "m60";
    const count = range === "1mo" ? 320 : 640;
    const endpoint = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=${symbol},${minute},,${count}`;
    const payload = await fetchJson(endpoint, 6500);
    const rows = payload?.data?.[symbol]?.[minute] || [];
    return { candles: tencentRows(rows, true), source: `tencent-finance-cn-${interval}` };
  }

  const period = interval === "1wk" ? "week" : "day";
  const count = candleLimitForRange(range);
  const endpoint = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,,${count},qfq`;
  const payload = await fetchJson(endpoint, 6500);
  const rows = payload?.data?.[symbol]?.[`qfq${period}`] || payload?.data?.[symbol]?.[period] || [];
  return { candles: tencentRows(rows), source: `tencent-finance-cn-${period}` };
}

async function fetchEastmoneyCnCandles(code, range, interval) {
  assertValidMarketCode(code, "CN");
  const endpoint = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  endpoint.searchParams.set("secid", eastmoneySecidForCn(code));
  endpoint.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6");
  endpoint.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61");
  endpoint.searchParams.set("klt", eastmoneyKltForInterval(interval));
  endpoint.searchParams.set("fqt", "1");
  endpoint.searchParams.set("end", "20500101");
  endpoint.searchParams.set("lmt", String(isIntradayInterval(interval) ? 640 : candleLimitForRange(range)));
  const payload = await fetchJson(endpoint, 6500);
  return { candles: eastmoneyKlinesToRows(payload), source: `eastmoney-cn-${interval}` };
}

async function fetchEastmoneyCnQuote(code) {
  assertValidMarketCode(code, "CN");
  const endpoint = new URL("https://push2.eastmoney.com/api/qt/stock/get");
  endpoint.searchParams.set("secid", eastmoneySecidForCn(code));
  endpoint.searchParams.set("fields", "f43,f44,f45,f46,f47,f57,f58,f59,f60,f86,f170");
  const payload = await fetchJson(endpoint, 4500);
  const data = payload?.data || {};
  const decimals = Math.max(0, Math.min(6, Number(data.f59 ?? 2)));
  const divisor = 10 ** decimals;
  const timestamp = Number(data.f86 || 0);
  const quote = normalizeQuote({
    symbol: code,
    price: Number(data.f43) / divisor,
    previousClose: Number(data.f60) / divisor,
    changePercent: Number.isFinite(Number(data.f170)) ? Number(data.f170) / 100 : null,
    open: Number(data.f46) / divisor,
    high: Number(data.f44) / divisor,
    low: Number(data.f45) / divisor,
    volume: Number.isFinite(Number(data.f47)) ? Number(data.f47) * 100 : null,
    currency: "CNY",
    exchange: /^6|^5|^9/.test(cleanCode(code, "CN")) ? "SSE" : "SZSE",
    asOf: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    date: Number.isFinite(timestamp) && timestamp > 0 ? quoteDateFromTimestamp(timestamp) : null,
    retrievedAt: new Date().toISOString(),
    timeVerified: Number.isFinite(timestamp) && timestamp > 0,
    source: "eastmoney-cn-realtime-quote",
    delayed: true,
    note: "Eastmoney direct A-share quote with provider timestamp.",
  }, "CN");
  if (!quote) throw new Error("Eastmoney CN quote had no usable direct price.");
  return quote;
}

async function fetchTencentCnQuote(code) {
  assertValidMarketCode(code, "CN");
  const symbol = tencentSymbolForCn(code);
  const text = await fetchText(`https://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`, 4500, {
    referer: "https://gu.qq.com/",
  });
  const encoded = text.match(/="([^"]+)"/)?.[1] || "";
  const parts = encoded.split("~");
  const providerTime = String(parts[30] || "");
  const asOf = /^\d{14}$/.test(providerTime)
    ? `${providerTime.slice(0, 4)}-${providerTime.slice(4, 6)}-${providerTime.slice(6, 8)}T${providerTime.slice(8, 10)}:${providerTime.slice(10, 12)}:${providerTime.slice(12, 14)}+08:00`
    : null;
  const quote = normalizeQuote({
    symbol: code,
    price: parts[3],
    previousClose: parts[4],
    change: parts[31],
    changePercent: parts[32],
    open: parts[5],
    high: parts[33],
    low: parts[34],
    volume: Number.isFinite(Number(parts[36])) ? Number(parts[36]) * 100 : null,
    currency: "CNY",
    exchange: symbol.startsWith("sh") ? "SSE" : "SZSE",
    asOf,
    date: asOf ? asOf.slice(0, 10) : null,
    retrievedAt: new Date().toISOString(),
    timeVerified: Boolean(asOf),
    source: "tencent-finance-cn-realtime-quote",
    delayed: true,
    note: "Tencent Finance direct A-share quote with provider timestamp.",
  }, "CN");
  if (!quote) throw new Error("Tencent Finance returned no usable direct CN quote.");
  return quote;
}

function cnKeyedFallbacksEnabled() {
  return String(process.env.CN_ENABLE_KEYED_FALLBACKS || "true").toLowerCase() !== "false";
}

function cnExtraKeyedFallbacksEnabled() {
  return String(process.env.CN_ENABLE_EXTRA_KEYED_FALLBACKS || "false").toLowerCase() === "true";
}

function providerForMarket(market) {
  return String(process.env[`${safeMarket(market)}_MARKET_PROVIDER`] || process.env.MARKET_PROVIDER || "dual").toLowerCase();
}

function quoteCandidates(market, code) {
  const key = safeMarket(market);
  if (key === "ASX" && /^\^/.test(cleanCode(code, key))) {
    return [
      ["asx-official-index-quote", () => fetchAsxOfficialIndexQuote(code)],
      ["yahoo-asx-index-quote", () => fetchYahooQuote(code, key)],
      ["eodhd-asx-index-quote", () => fetchEodhdQuote(code, key)],
      ["twelvedata-asx-index-quote", () => fetchTwelveDataQuote(code, key)],
    ];
  }
  if (key === "US" && /^\^/.test(cleanCode(code, key))) {
    return [
      ["stooq-us-index-quote", () => fetchStooqQuote(code, key)],
      ["yahoo-us-index-quote", () => fetchYahooQuote(code, key)],
      ["eodhd-us-index-quote", () => fetchEodhdQuote(code, key)],
      ["twelvedata-us-index-quote", () => fetchTwelveDataQuote(code, key)],
    ];
  }
  return {
    ASX: [
      ["asx-official-quote", () => fetchAsxOfficialQuote(code)],
      ["stockanalysis-asx-quote", () => fetchStockAnalysisAsxQuote(code)],
      ["yahoo-asx-quote", () => fetchYahooQuote(code, key)],
      ["eodhd-asx-quote", () => fetchEodhdQuote(code, key)],
      ["twelvedata-asx-quote", () => fetchTwelveDataQuote(code, key)],
    ],
    US: [
      ["alpaca-us-snapshot", () => fetchAlpacaUsSnapshotQuote(code)],
      ["stooq-us-quote", () => fetchStooqQuote(code, key)],
      ["yahoo-us-quote", () => fetchYahooQuote(code, key)],
      ["eodhd-us-quote", () => fetchEodhdQuote(code, key)],
      ["twelvedata-us-quote", () => fetchTwelveDataQuote(code, key)],
    ],
    CN: [
      ["eastmoney-cn-quote", () => fetchEastmoneyCnQuote(code)],
      ["tencent-cn-quote", () => fetchTencentCnQuote(code)],
      ["yahoo-cn-quote", () => fetchYahooQuote(code, key)],
      ["twelvedata-cn-quote", () => fetchTwelveDataQuote(code, key)],
    ],
  }[key] || [];
}

function realtimeQuoteMaxAgeMs(market = "ASX") {
  const key = safeMarket(market);
  const fallback = {
    ASX: 20 * 60_000,
    US: 5 * 60_000,
    CN: 5 * 60_000,
  }[key] || 10 * 60_000;
  return Math.max(60_000, Number(process.env[`QUOTE_${key}_MAX_AGE_MS`] || process.env.QUOTE_OPEN_MARKET_MAX_AGE_MS || fallback));
}

function quoteSourcePriority(source = "") {
  const value = String(source).toLowerCase();
  if (/alpaca|asx-official|eastmoney-cn-realtime|tencent-finance-cn-realtime/.test(value)) return 100;
  if (/yahoo-finance/.test(value)) return 90;
  if (/eodhd/.test(value)) return 82;
  if (/twelvedata/.test(value)) return 76;
  if (/stockanalysis/.test(value)) return 68;
  if (/stooq/.test(value)) return 60;
  return 40;
}

function realtimeQuoteQuality(quote, market = "ASX", now = new Date(), options = {}) {
  const key = safeMarket(market);
  if (!quote || quote.unavailable || !positiveMarketNumber(quote.price)) {
    return { usable: false, reason: "no usable positive price", ageMs: Infinity, timestampMs: 0 };
  }
  const expected = normalizeMarketSymbol(options.symbol || quote.symbol || "", key);
  const actual = normalizeMarketSymbol(quote.symbol || options.symbol || "", key);
  if (expected && actual && cleanCode(expected, key) !== cleanCode(actual, key)) {
    return { usable: false, reason: `symbol mismatch ${actual} != ${expected}`, ageMs: Infinity, timestampMs: 0 };
  }
  const session = backendMarketSession(key, now);
  const timestampMs = quote.timeVerified === false ? 0 : Date.parse(quote.asOf || "");
  const ageMs = Number.isFinite(timestampMs) ? now.getTime() - timestampMs : Infinity;
  if (Number.isFinite(timestampMs) && timestampMs > now.getTime() + 2 * 60_000) {
    return { usable: false, reason: "provider timestamp is in the future", ageMs, timestampMs };
  }
  const quoteDate = String(quote.date || quote.asOf || "").slice(0, 10);
  if (quoteDate && !validMarketQuoteDate(quoteDate, key, now)) {
    return { usable: false, reason: `invalid market date ${quoteDate}`, ageMs, timestampMs };
  }
  if (options.strict && session.open) {
    if (quote.timeVerified === false || !Number.isFinite(timestampMs)) {
      return { usable: false, reason: "open-market quote has no verified provider timestamp", ageMs, timestampMs };
    }
    const maxAgeMs = Number(options.maxAgeMs || realtimeQuoteMaxAgeMs(key));
    if (ageMs > maxAgeMs) {
      return { usable: false, reason: `open-market quote is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(maxAgeMs / 1000)}s)`, ageMs, timestampMs };
    }
  }
  return {
    usable: true,
    reason: "",
    ageMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : Infinity,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.parse(quote.retrievedAt || "") || 0,
  };
}

function medianNumber(values = []) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return NaN;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function selectBestRealtimeQuote(entries = [], market = "ASX", latestClose = null, options = {}) {
  const key = safeMarket(market);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const rejected = [];
  const eligible = [];
  for (const entry of entries) {
    const source = entry?.source || entry?.quote?.source || "quote";
    const quote = normalizeQuote(entry?.quote, key, latestClose);
    if (!quote) {
      rejected.push(`${source}: invalid price payload`);
      continue;
    }
    const quality = realtimeQuoteQuality(quote, key, now, { ...options, symbol: options.symbol || quote.symbol });
    if (!quality.usable) {
      rejected.push(`${source}: ${quality.reason}`);
      continue;
    }
    eligible.push({ source, quote, ...quality, priority: quoteSourcePriority(quote.source || source) });
  }
  if (!eligible.length) return { quote: null, eligible, rejected, warning: compactProviderErrors(rejected).join(" | ") };

  const median = medianNumber(eligible.map((row) => row.quote.price));
  const maxDiffPct = Math.max(0.25, Number(process.env.QUOTE_CROSS_SOURCE_MAX_DIFF_PCT || 2));
  const consensus = Number.isFinite(median) && eligible.length >= 3
    ? eligible.filter((row) => Math.abs(Number(row.quote.price) - median) / median * 100 <= maxDiffPct)
    : eligible;
  const pool = consensus.length ? consensus : eligible;
  pool.sort((a, b) => b.timestampMs - a.timestampMs || b.priority - a.priority);
  const winner = pool[0];
  const agreeing = eligible.filter((row) => {
    const base = Number(winner.quote.price);
    return base > 0 && Math.abs(Number(row.quote.price) - base) / base * 100 <= maxDiffPct;
  });
  const conflicting = eligible.filter((row) => !agreeing.includes(row));
  const crossCheckStatus = agreeing.length >= 2 ? "confirmed" : conflicting.length ? "conflict-single-winner" : "single-source";
  const warningParts = [...rejected];
  if (conflicting.length) {
    warningParts.push(`Cross-source conflict rejected: ${conflicting.map((row) => `${row.quote.source || row.source}=${Number(row.quote.price).toFixed(4)}`).join(", ")}`);
  }
  return {
    quote: {
      ...winner.quote,
      freshnessAgeMs: Number.isFinite(winner.ageMs) ? Math.round(winner.ageMs) : null,
      crossCheckStatus,
      crossCheckSources: agreeing.map((row) => row.quote.source || row.source),
      note: [winner.quote.note, crossCheckStatus === "confirmed" ? `Price cross-checked by ${agreeing.length} real sources.` : "Only one sufficiently fresh real source was usable."].filter(Boolean).join(" "),
    },
    eligible,
    rejected,
    warning: compactProviderErrors(warningParts).join(" | "),
  };
}

async function fetchRealtimeQuote(symbol, market = "ASX", latestClose = null, options = {}) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  assertValidMarketCode(code, key);
  const cacheKey = `${key}:${code}`;
  const cached = quoteResponseCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.time < Number(process.env.QUOTE_CACHE_TTL_MS || 30000)) {
    const cachedQuality = realtimeQuoteQuality(cached.value, key, new Date(), { ...options, symbol: code });
    if (!options.strict || cachedQuality.usable) return cached.value;
  }
  const errors = [];
  const candidates = quoteCandidates(key, code);
  const runCandidate = async ([source, task]) => {
    const skipError = providerSkipError(source);
    if (skipError) {
      return { source, error: skipError };
    }
    try {
      const quote = normalizeQuote(await task(), key, latestClose);
      return quote ? { source, quote } : { source, error: `${source}: no usable quote` };
    } catch (error) {
      return { source, error: `${source}: ${error.message || error}` };
    }
  };
  const remember = (quote) => {
    quoteResponseCache.set(cacheKey, { time: Date.now(), value: quote });
    if (quoteResponseCache.size > 160) quoteResponseCache.delete(quoteResponseCache.keys().next().value);
    return quote;
  };

  if (options.strict) {
    const defaultPrimaryCount = { ASX: 4, US: 3, CN: 3 }[key] || 3;
    const primaryCount = Math.max(1, Math.min(candidates.length, Number(process.env.QUOTE_STRICT_PRIMARY_COUNT || defaultPrimaryCount)));
    const entries = [];
    const primary = await Promise.all(candidates.slice(0, primaryCount).map(runCandidate));
    primary.forEach((entry) => {
      if (entry.quote) entries.push(entry);
      else if (entry.error) errors.push(entry.error);
    });
    let selected = selectBestRealtimeQuote(entries, key, latestClose, { ...options, symbol: code });
    if (!selected.quote) {
      for (const candidate of candidates.slice(primaryCount)) {
        const entry = await runCandidate(candidate);
        if (entry.quote) entries.push(entry);
        else if (entry.error) errors.push(entry.error);
        selected = selectBestRealtimeQuote(entries, key, latestClose, { ...options, symbol: code });
        if (selected.quote) break;
      }
    }
    if (selected.quote) {
      const selectedWarnings = selected.warning ? String(selected.warning).split(" | ").filter(Boolean) : [];
      const warning = compactProviderErrors([...errors, ...selectedWarnings]).filter(Boolean).join(" | ");
      return remember({ ...selected.quote, warning: warning || null });
    }
    errors.push(selected.warning || "No sufficiently fresh verified quote passed validation.");
  } else {
    for (const candidate of candidates) {
      const entry = await runCandidate(candidate);
      if (entry.quote) return remember(entry.quote);
      if (entry.error) errors.push(entry.error);
    }
  }
  return {
    unavailable: true,
    source: "quote-unavailable",
    warning: compactProviderErrors(errors).join(" | "),
  };
}

function marketTimeZone(market = "ASX") {
  return {
    ASX: "Australia/Sydney",
    US: "America/New_York",
    CN: "Asia/Shanghai",
  }[safeMarket(market)] || "Australia/Sydney";
}

function validMarketQuoteDate(date, market = "ASX", now = new Date()) {
  const value = String(date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timeZone = marketTimeZone(market);
  const currentDate = zonedDateParts(now, timeZone).date;
  if (value > currentDate) return false;
  const noonUtc = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(noonUtc.getTime())) return false;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(noonUtc);
  return !["Sat", "Sun"].includes(weekday);
}

function mergeQuoteIntoCandles(candles = [], quote = null, market = "ASX", now = new Date()) {
  const rows = sanitizeCandleRows(candles);
  if (
    !quote
    || quote.unavailable
    || quote.timeVerified === false
    || !positiveMarketNumber(quote.price)
    || !validMarketQuoteDate(quote.date, market, now)
  ) return rows;
  const price = positiveMarketNumber(quote.price);
  const latestDate = candleDate(rows.at(-1));
  if (latestDate && String(quote.date).localeCompare(latestDate) < 0) return rows;
  const index = rows.findIndex((row) => candleDate(row) === quote.date);
  if (index >= 0) {
    const row = rows[index];
    const open = positiveMarketNumber(quote.open, positiveMarketNumber(row.open, positiveMarketNumber(row.close, price)));
    const quoteHigh = positiveMarketNumber(quote.high, price);
    const quoteLow = positiveMarketNumber(quote.low, price);
    rows[index] = {
      ...row,
      open,
      high: Math.max(positiveMarketNumber(row.high, price), quoteHigh, price, open),
      low: Math.min(positiveMarketNumber(row.low, price), quoteLow, price, open),
      close: price,
      adjClose: price,
      volume: Math.max(Number(row.volume || 0), Number(quote.volume || 0)),
      realtime: true,
      quoteSource: quote.source,
    };
    return rows;
  }
  const latest = rows.at(-1);
  if (!latest || String(quote.date).localeCompare(candleDate(latest)) <= 0) return rows;
  const open = positiveMarketNumber(quote.open, positiveMarketNumber(latest.close, price));
  const quoteHigh = positiveMarketNumber(quote.high, price);
  const quoteLow = positiveMarketNumber(quote.low, price);
  rows.push({
    date: quote.date,
    open,
    high: Math.max(open, quoteHigh, price),
    low: Math.min(open, quoteLow, price),
    close: price,
    adjClose: price,
    volume: Number(quote.volume || 0),
    realtime: true,
    quoteSource: quote.source,
  });
  return rows;
}

// Build a point-in-time model view without persisting an unverified quote as OHLC history.
function predictionCandlesWithQuote(candles = [], quote = null, market = "ASX", now = new Date()) {
  const rows = sanitizeCandleRows(candles)
    .sort((a, b) => candleDate(a).localeCompare(candleDate(b)));
  const latest = rows.at(-1);
  const normalized = normalizeQuote(quote, market, latest?.close);
  if (!latest || !normalized || normalized.unavailable || !positiveMarketNumber(normalized.price)) return rows;

  if (normalized.timeVerified !== false && validMarketQuoteDate(normalized.date, market, now)) {
    return mergeQuoteIntoCandles(rows, normalized, market, now);
  }

  const price = positiveMarketNumber(normalized.price);
  const index = rows.length - 1;
  rows[index] = {
    ...latest,
    high: Math.max(positiveMarketNumber(latest.high, price), price),
    low: Math.min(positiveMarketNumber(latest.low, price), price),
    close: price,
    adjClose: price,
    predictionOnly: true,
    predictionQuoteSource: normalized.source,
    predictionQuoteRetrievedAt: normalized.retrievedAt,
    predictionQuoteTimeVerified: false,
  };
  return rows;
}

function providerCandidates(market, code, range, interval) {
  const key = safeMarket(market);
  if (key === "ASX" && /^\^/.test(cleanCode(code, key))) {
    return [
      ["yahoo-asx-index", () => fetchYahooMarketCandles(code, range, interval, key)],
      ["stooq-asx-index", () => fetchStooqIndexCandles(code, range, interval, key)],
      ...(satoshiMacroSeriesForIndex(code, key) ? [["satoshimacro-asx-index", () => fetchSatoshiMacroIndexCloseCandles(code, range, interval, key)]] : []),
      ["eodhd-asx-index", () => fetchEodhdCandles(code, range, interval, key)],
      ["twelvedata-asx-index", () => fetchTwelveDataIndexCandles(code, range, interval, key)],
    ];
  }
  if (key === "US" && /^\^/.test(cleanCode(code, key))) {
    return [
      ["yahoo-us-index", () => fetchYahooMarketCandles(code, range, interval, key)],
      ["nasdaq-us-index", () => fetchNasdaqUsIndexCandles(code, range, interval)],
      ...(interval === "1d" ? [["fred-us-index-close", () => fetchFredUsIndexCloseCandles(code, range, interval)]] : []),
      ["stooq-us-index", () => fetchStooqIndexCandles(code, range, interval, key)],
      ["finnhub-us-index", () => fetchFinnhubCandles(code, range, interval, key)],
      ["tiingo-us-index", () => fetchTiingoCandles(code, range, interval, key)],
      ["twelvedata-us-index", () => fetchTwelveDataIndexCandles(code, range, interval, key)],
      ["eodhd-us-index", () => fetchEodhdCandles(code, range, interval, key)],
    ];
  }
  const isCnBroadIndex = /^(SH000|SZ399)\d{3}$/.test(cleanCode(code, key));
  const cnFreeCandidates = isCnBroadIndex ? [
    ["tencent-cn", () => fetchTencentCnCandles(code, range, interval)],
    ["eastmoney-cn", () => fetchEastmoneyCnCandles(code, range, interval)],
    ["baostock-cn", () => fetchBaostockCnCandles(code, range, interval)],
    ["yahoo-cn", () => fetchYahooMarketCandles(code, range, interval, key)],
  ] : [
    ["eastmoney-cn", () => fetchEastmoneyCnCandles(code, range, interval)],
    ["tencent-cn", () => fetchTencentCnCandles(code, range, interval)],
    ["baostock-cn", () => fetchBaostockCnCandles(code, range, interval)],
    ["yahoo-cn", () => fetchYahooMarketCandles(code, range, interval, key)],
  ];
  const cnTushareCandidate = ["tushare-cn", () => fetchTushareCnCandles(code, range, interval)];
  const cnAlphaCandidate = ["alphavantage-cn", () => fetchAlphaVantageCandles(code, range, interval, key)];
  const cnExtraKeyedCandidates = [
    ["alphavantage-cn", () => fetchAlphaVantageCandles(code, range, interval, key)],
    ["eodhd-cn", () => fetchEodhdCandles(code, range, interval, key)],
    ["twelvedata-cn", () => fetchTwelveDataCandles(code, range, interval, key)],
  ];
  const cnCandidates = /^(SH|SZ)\d{6}$/.test(cleanCode(code, key))
    ? cnFreeCandidates
    : [
      ...(process.env.TUSHARE_TOKEN ? [cnTushareCandidate] : []),
      ...cnFreeCandidates,
      ...(cnKeyedFallbacksEnabled() ? [cnAlphaCandidate] : []),
      ...(cnExtraKeyedFallbacksEnabled() ? cnExtraKeyedCandidates.slice(1) : []),
    ];
  const candidates = {
    ASX: [
      ...(interval === "1d" ? [["stockanalysis-asx", () => fetchStockAnalysisAsxCandles(code, range, interval)]] : []),
      ["yahoo-asx", () => fetchYahooMarketCandles(code, range, interval, key)],
      ["finnhub-asx", () => fetchFinnhubCandles(code, range, interval, key)],
      ["tiingo-asx", () => fetchTiingoCandles(code, range, interval, key)],
      ["eodhd-asx", () => fetchEodhdCandles(code, range, interval, key)],
      ["twelvedata-asx", () => fetchTwelveDataCandles(code, range, interval, key)],
    ],
    US: [
      ...(alpacaConfigured()
        ? [["alpaca-us-iex", () => fetchAlpacaUsCandles(code, range, interval)]]
        : []),
      ["nasdaq-us", () => fetchNasdaqUsCandles(code, range, interval)],
      ["yahoo-us", () => fetchYahooMarketCandles(code, range, interval, key)],
      ["finnhub-us", () => fetchFinnhubCandles(code, range, interval, key)],
      ["tiingo-us", () => fetchTiingoCandles(code, range, interval, key)],
      ["alphavantage-us", () => fetchAlphaVantageCandles(code, range, interval, key)],
      ["twelvedata-us", () => fetchTwelveDataCandles(code, range, interval, key)],
      ["eodhd-us", () => fetchEodhdCandles(code, range, interval, key)],
      ["stooq-us", () => fetchStooqUsCandles(code, range, interval)],
    ],
    CN: cnCandidates,
  }[key];
  return candidates;
}

function candleLimitForRange(range = "9mo") {
  if (range === "5d") return 8;
  if (range === "1mo") return 45;
  if (range === "3mo") return 90;
  if (range === "6mo") return 140;
  if (range === "9mo" || range === "1y") return 260;
  if (range === "2y") return 520;
  if (range === "3y") return 780;
  if (range === "5y") return 1300;
  if (range === "10y") return 2600;
  return 260;
}

function minimumProviderCoverage(range = "9mo", interval = "1d") {
  if (interval !== "1d") return 1;
  if (["2y", "3y", "5y", "10y"].includes(range)) return 180;
  return 1;
}

async function fetchSnapshotMarketCandles(symbol, range, interval, market = "ASX", marketError = null) {
  if (interval !== "1d") return null;
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const snapshot = await readServerSnapshotForMarket(key);
  const item = (snapshot?.analyses || []).find((row) => {
    const rowCode = cleanCode(row?.symbol, key);
    const normalizedRowCode = cleanCode(normalizeMarketSymbol(row?.symbol, key), key);
    return rowCode === code || normalizedRowCode === code;
  });
  const candles = sanitizeCandleRows(item?.candles)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-candleLimitForRange(range));
  if (!item || !candles.length) return null;
  const latest = latestByDate(candles);
  const source = item.marketSource || item.source || "snapshot";
  const savedAt = snapshot.savedAt || snapshot.updatedAt || item.updatedAt || "";
  const providerError = marketError ? compactProviderErrors([marketError.message || marketError]).join(" | ") : "";
  const warning = [
    `Live historical providers unavailable; using last saved real ${key} snapshot${savedAt ? ` from ${savedAt}` : ""}.`,
    providerError,
  ].filter(Boolean).join(" ");
  return {
    candles,
    quote: null,
    source: `snapshot-real-${source}`,
    snapshotSavedAt: savedAt || null,
    unit: cleanCode(symbol, key).startsWith("^") ? "points" : undefined,
    warning,
    validation: {
      ok: true,
      status: "real_snapshot_fallback",
      degraded: true,
      primary: latest ? { source, date: latest.date, close: latest.close, volume: latest.volume } : null,
      message: "Live historical providers were unavailable; using the last persisted real market snapshot.",
    },
  };
}

async function fetchMarketCandles(symbol, range, interval, market = "ASX") {
  const key = safeMarket(market);
  const provider = providerForMarket(key);
  const code = cleanCode(symbol, key);
  assertValidMarketCode(code, key);
  const cacheKey = `${key}:${code}:${range}:${interval}`;
  const cached = marketCandlesCache.get(cacheKey);
  if (cached && Date.now() - cached.time < Number(process.env.MARKET_CACHE_TTL_MS || 60000)) return cached.value;
  const remember = (value) => {
    marketCandlesCache.set(cacheKey, { time: Date.now(), value });
    if (marketCandlesCache.size > 160) marketCandlesCache.delete(marketCandlesCache.keys().next().value);
    return value;
  };

  if (provider === "dual" || provider === "crosscheck") {
    const candidates = providerCandidates(key, code, range, interval);
    const successful = [];
    const errors = [];
    const singleSourceAcceptedByPolicy = () => (
      (key === "ASX" && process.env.ASX_REQUIRE_DUAL_SOURCE !== "true")
      || (key === "US" && process.env.US_REQUIRE_DUAL_SOURCE !== "true")
      || key === "CN"
    );
    const degradedSingleSourcePayload = (source, extraErrors = []) => ({
      ...source,
      source: `${source.source}-single-source`,
      validation: singleSourceValidation(source, [...errors, ...extraErrors]),
      warning: compactProviderErrors([...errors, ...extraErrors]).length
        ? `${singleSourceAcceptedByPolicy() ? "已按数据源保护策略接受单一真实源。" : "Dual-source cross-check degraded to single real source."} ${compactProviderErrors([...errors, ...extraErrors]).join(" | ")}`
        : singleSourceAcceptedByPolicy()
          ? "已按数据源保护策略接受单一真实源。"
          : "Dual-source cross-check degraded to single real source.",
    });
    let limitedProviderCalls = 0;
    const maxLimitedProviderCalls = key === "US" ? 4 : key === "ASX" ? 2 : 1;
    const minimumCoverage = minimumProviderCoverage(range, interval);
    for (const [source, task] of candidates) {
      const skipError = providerSkipError(source);
      if (skipError) {
        errors.push(skipError);
        continue;
      }
      if (isLimitedProvider(source) && !providerConfigured(source)) {
        errors.push(`${source}: skipped because its API key is not configured`);
        continue;
      }
      if (isLimitedProvider(source) && limitedProviderCalls >= maxLimitedProviderCalls) {
        errors.push(`${source}: skipped by quota policy; ${maxLimitedProviderCalls} limited provider(s) already called for this task`);
        continue;
      }
      if (isLimitedProvider(source)) limitedProviderCalls += 1;
      try {
        const value = await task();
        if (value.candles?.length) successful.push(value);
        else errors.push(`${source}: no candles returned`);
      } catch (error) {
        errors.push(`${source}: ${error.message || error}`);
      }
      if (successful.length >= 2 && successful.some((value) => value.candles.length >= minimumCoverage)) break;
      if (key === "CN" && successful.length >= 1) break;
      if (key === "US" && process.env.US_REQUIRE_DUAL_SOURCE !== "true" && successful.length >= 1) break;
      if (
        key === "ASX"
        && process.env.ASX_REQUIRE_DUAL_SOURCE !== "true"
        && successful.some((value) => value.candles.length >= minimumCoverage)
      ) break;
    }
    if (successful.length === 0) {
      throw new Error(`Market provider failure. ${errors.join(" | ")}`);
    }
    if (successful.length === 1) {
      const source = successful[0];
      if (!source.candles.length) throw new Error(`No real candles returned from ${source.source}. ${errors.join(" | ")}`);
      return remember(degradedSingleSourcePayload(source));
    }
    const coverageOrdered = minimumCoverage > 1
      ? [...successful].sort((a, b) => b.candles.length - a.candles.length)
      : successful;
    const [primary, secondary] = coverageOrdered;
    const validation = compareMarketSources(primary, secondary);
    if (!validation.ok && process.env.MARKET_ALLOW_CONFLICT !== "true") {
      const conflictError = `${validation.message} Price diff: ${validation.priceDiffPct?.toFixed(2)}%. ${validation.primary?.source} ${validation.primary?.date} ${validation.primary?.close}; ${validation.secondary?.source} ${validation.secondary?.date} ${validation.secondary?.close}.`;
      if (singleSourceAcceptedByPolicy()) {
        const newestRealSource = [...successful].sort((a, b) => {
          const left = String(latestByDate(a.candles)?.date || "");
          const right = String(latestByDate(b.candles)?.date || "");
          return right.localeCompare(left) || b.candles.length - a.candles.length;
        })[0];
        return remember(degradedSingleSourcePayload(newestRealSource, [conflictError]));
      }
      const closeOnlySource = successful.find((source) => source.closeOnly);
      if (closeOnlySource) {
        return remember(degradedSingleSourcePayload(closeOnlySource, [conflictError]));
      }
      try {
        if (!satoshiMacroSeriesForIndex(code, key)) throw new Error(`No SatoshiMacro close-only fallback for ${code}.`);
        const closeOnlyFallback = await fetchSatoshiMacroIndexCloseCandles(code, range, interval, key);
        return remember(degradedSingleSourcePayload(closeOnlyFallback, [conflictError]));
      } catch (fallbackError) {
        errors.push(`satoshimacro-conflict-fallback: ${fallbackError.message || fallbackError}`);
      }
      throw new Error(conflictError);
    }
    return remember({ ...primary, source: `${primary.source}+${secondary.source}-crosscheck`, validation, secondary });
  }

  if (provider === "twelvedata") {
    return remember(await fetchTwelveDataCandles(code, range, interval, key));
  }

  if (provider === "eodhd") {
    return remember(await fetchEodhdCandles(code, range, interval, key));
  }

  if (provider === "alphavantage" || provider === "alpha-vantage") {
    return remember(await fetchAlphaVantageCandles(code, range, interval, key));
  }

  if (provider === "alpaca") {
    if (key !== "US") throw new Error("Alpaca is only configured as a US stock bars source.");
    return remember(await fetchAlpacaUsCandles(code, range, interval));
  }

  if (provider === "tushare") {
    if (key !== "CN") throw new Error("Tushare is only configured as a China A-share daily source.");
    return remember(await fetchTushareCnCandles(code, range, interval));
  }

  if (provider === "yahoo") {
    return remember(await fetchYahooMarketCandles(code, range, interval, key));
  }

  if (provider === "tencent" || provider === "tencent-finance") {
    if (key !== "CN") throw new Error("Tencent Finance is only configured for China A-shares.");
    return remember(await fetchTencentCnCandles(code, range, interval));
  }

  throw new Error("No real market provider configured. Set MARKET_PROVIDER or US_MARKET_PROVIDER/CN_MARKET_PROVIDER to dual, alpaca, tushare, twelvedata, eodhd, alphavantage, yahoo, or tencent with the required API access.");
}

async function quantLabMarketData(symbol, market = "ASX", range = "9mo", interval = "1d") {
  const key = safeMarket(market);
  const normalized = normalizeMarketSymbol(symbol, key);
  let marketData;
  let marketError = null;
  try {
    marketData = await fetchMarketCandles(normalized, range, interval, key);
  } catch (error) {
    marketError = error;
  }
  if (!marketData?.candles?.length) {
    marketData = await fetchSnapshotMarketCandles(normalized, range, interval, key, marketError);
  }
  if (!marketData?.candles?.length) {
    throw marketError || new Error(`No real market candles are available for ${normalized}.`);
  }
  return { market: key, symbol: normalized, ...marketData };
}

function providerConfigured(source) {
  const name = String(source || "").toLowerCase();
  if (name.includes("alpaca")) return alpacaConfigured();
  const pooledProviders = ["eodhd", "twelvedata", "tiingo"];
  const pooled = pooledProviders.find((marker) => name.includes(marker));
  if (pooled) return providerApiKeys(pooled).length > 0;
  const keyedProviders = [
    ["alphavantage", "ALPHAVANTAGE_API_KEY"],
    ["tushare", "TUSHARE_TOKEN"],
    ["alpaca", "ALPACA_API_KEY"],
    ["finnhub", "FINNHUB_API_KEY"],
    ["marketaux", "MARKETAUX_API_KEY"],
  ];
  const keyed = keyedProviders.find(([marker]) => name.includes(marker));
  return keyed ? Boolean(process.env[keyed[1]]) : true;
}

function providerCapabilityRows(candidates = []) {
  return candidates.map(([source]) => {
    const pooled = ["eodhd", "twelvedata", "tiingo"].find((marker) => String(source).toLowerCase().includes(marker));
    const keyPool = pooled ? providerKeyPoolStatus(pooled) : null;
    return {
      source,
      configured: providerConfigured(source),
      limited: isLimitedProvider(source),
      backoff: providerBackoffReason(source) || "",
      ...(keyPool ? { keyPool } : {}),
      status: !providerConfigured(source)
        ? "missing_key"
        : providerBackoffReason(source)
          ? "backoff_or_limit"
          : "candidate",
    };
  });
}

function newsProviderStatus() {
  const rows = [
    { name: "marketaux", env: "MARKETAUX_API_KEY", tier: "limited-news", backoffKey: "marketaux-news" },
    { name: "fred", env: "FRED_API_KEY", tier: "limited-macro", backoffKey: "fred" },
    { name: "newsapi", env: "NEWSAPI_KEY", tier: "limited-news", backoffKey: "newsapi" },
    { name: "newsdata", env: "NEWSDATA_API_KEY", tier: "limited-news", backoffKey: "newsdata" },
    { name: "thenewsapi", env: "THENEWSAPI_KEY", tier: "limited-news", backoffKey: "thenewsapi" },
    { name: "tianapi", env: "TIANAPI_KEY", tier: "limited-news-cn", backoffKey: "tianapi" },
    { name: "google-rss", env: null, tier: "free-rss", backoffKey: "google-rss" },
    { name: "gdelt", env: null, tier: "free-global", backoffKey: "gdelt" },
    { name: "stockanalysis-asx-news", env: null, tier: "free-asx", backoffKey: "stockanalysis-asx-news" },
    { name: "eastmoney-news", env: null, tier: "free-cn", backoffKey: "eastmoney-news" },
  ];
  const primary = String(process.env.NEWS_PRIMARY_PROVIDER || "").toLowerCase();
  return {
    primary: primary || "auto",
    providers: rows.map((row) => {
      const configured = row.env ? Boolean(process.env[row.env]) : true;
      const backoff = providerBackoffReason(row.backoffKey) || providerBackoffReason(row.name) || "";
      return {
        name: row.name,
        tier: row.tier,
        configured,
        backoff,
        status: !configured ? "missing_key" : backoff ? "backoff_or_limit" : "ready",
        primary: primary === row.name,
      };
    }),
  };
}

async function dataCapabilities(market = "ASX", symbol = "") {
  const key = safeMarket(market);
  const sample = normalizeMarketSymbol(symbol || { ASX: "BHP", US: "AAPL", CN: "600519" }[key] || "", key);
  const alpacaReady = key === "US" && alpacaConfigured();
  const localMarketData = await runPythonQuantCore("market-data-summary", { market: key, symbol: sample }).catch((error) => ({
    error: error.message || String(error),
    true_tick_available: false,
    true_l1_available: false,
    true_l2_available: false,
  }));
  const intradayProviders = providerCapabilityRows(providerCandidates(key, sample, "5d", "5m"));
  const dailyProviders = providerCapabilityRows(providerCandidates(key, sample, "9mo", "1d"));
  return {
    market: key,
    symbol: sample,
    intervals: [
      { interval: "5m", granularity: "real_intraday_bar", providers: intradayProviders },
      { interval: "15m", granularity: "real_intraday_bar", providers: providerCapabilityRows(providerCandidates(key, sample, "5d", "15m")) },
      { interval: "60m", granularity: "real_intraday_bar", providers: providerCapabilityRows(providerCandidates(key, sample, "5d", "60m")) },
      { interval: "1d", granularity: "real_daily_bar", providers: dailyProviders },
    ],
    tick: {
      available: Boolean(localMarketData.true_tick_available) || alpacaReady,
      localAvailable: Boolean(localMarketData.true_tick_available),
      configured: alpacaReady,
      configuredProvider: alpacaReady ? "alpaca-us-trades" : "",
      note: key === "US"
        ? alpacaReady
          ? "Alpaca credentials are configured. The app will verify entitlement when /api/trades or intraday feature footprint is requested. This is tick/trade data, not L2."
          : "US real trades require Alpaca credentials. This is tick/trade data, not L2."
        : `${key} real tick/trade data requires a separately authorised exchange, broker, or vendor feed.`,
    },
    l1: {
      available: Boolean(localMarketData.true_l1_available) || alpacaReady,
      localAvailable: Boolean(localMarketData.true_l1_available),
      configured: alpacaReady,
      configuredProvider: alpacaReady ? "alpaca-us-l1-quotes" : "",
      note: key === "US"
        ? alpacaReady
          ? "Alpaca credentials are configured. Latest quote entitlement is verified on demand and saved locally when returned; candle data is never promoted to L1."
          : "US L1 quotes require Alpaca credentials; candle data is never promoted to L1."
        : "L1 quotes are only marked available after authorised quote rows are recorded locally; candle data is never promoted to L1.",
    },
    l2: {
      available: Boolean(localMarketData.true_l2_available),
      note: key === "US"
        ? "Alpaca trades/quotes are not treated as L2. True depth is available only after licensed order-book rows are recorded locally."
        : "L2/depth requires a licensed order-book feed. The app will not infer L2 from OHLCV candles.",
    },
    localMarketData,
  };
}

function isLimitedProvider(source) {
  return ["eodhd", "twelvedata", "alphavantage", "tushare", "alpaca", "finnhub", "tiingo", "marketaux"]
    .some((marker) => String(source || "").toLowerCase().includes(marker));
}

async function recordAuthorizedMarketRows({ market, symbol, dataType, source, rows }) {
  if (!Array.isArray(rows) || !rows.length) return null;
  try {
    return await runPythonQuantCore("market-data-record", {
      market,
      symbol,
      data_type: dataType,
      source,
      rows,
    });
  } catch (error) {
    return {
      inserted: 0,
      error: String(error.message || error).slice(0, 240),
      note: "Authorised market data was received but local persistence failed.",
    };
  }
}

async function listAuthorizedMarketRows({ market, symbol, dataType, limit = 1000 }) {
  try {
    return await runPythonQuantCore("market-data-list", {
      market,
      symbol,
      data_type: dataType,
      limit,
    });
  } catch (error) {
    return {
      market,
      symbol,
      data_type: dataType,
      count: 0,
      rows: [],
      error: String(error.message || error).slice(0, 240),
    };
  }
}

function l1QuoteSummary(row = null, source = "", origin = "live", persistence = null) {
  if (!row) return { available: false, true_l1: false, source, origin };
  const bid = Number(row.bid_price ?? row.bidPrice ?? row.bp ?? 0);
  const ask = Number(row.ask_price ?? row.askPrice ?? row.ap ?? 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
  return {
    available: true,
    true_l1: true,
    true_l2: false,
    source,
    origin,
    timestamp: row.timestamp || row.ts || row.t || "",
    bid_price: Number.isFinite(bid) && bid > 0 ? bid : null,
    bid_size: Number(row.bid_size ?? row.bidSize ?? row.bs ?? 0) || null,
    ask_price: Number.isFinite(ask) && ask > 0 ? ask : null,
    ask_size: Number(row.ask_size ?? row.askSize ?? row.as ?? 0) || null,
    spread_pct: bid > 0 && ask > 0 && mid > 0 ? Number(((ask - bid) / mid * 100).toFixed(4)) : null,
    persisted_rows: persistence?.inserted ?? null,
    persistence_error: persistence?.error || "",
  };
}

function localTickRowsAsTrades(rows = []) {
  return rows.map((row) => ({
    timestamp: row.timestamp || row.ts || row.t || "",
    price: Number(row.price || 0),
    size: Number(row.size || 0),
    exchange: String(row.exchange || row.payload?.exchange || ""),
    trade_id: String(row.trade_id || row.payload?.trade_id || ""),
    conditions: Array.isArray(row.payload?.conditions) ? row.payload.conditions : [],
    tape: String(row.payload?.tape || ""),
    sequence: Number(row.payload?.sequence || 0),
  })).filter((row) => row.timestamp && row.price > 0 && row.size > 0);
}

async function localMarketDataBoundary(market, symbol) {
  const [summary, localL1, localL2] = await Promise.all([
    runPythonQuantCore("market-data-summary", { market, symbol }).catch(() => null),
    listAuthorizedMarketRows({ market, symbol, dataType: "l1", limit: 1 }),
    listAuthorizedMarketRows({ market, symbol, dataType: "l2", limit: 20 }),
  ]);
  return {
    summary,
    l1: l1QuoteSummary(localL1.rows?.at(-1), localL1.rows?.at(-1)?.source || "local-authorized-market-data-store", "local-cache"),
    l2: {
      available: Boolean(localL2.rows?.length),
      true_l2: Boolean(localL2.rows?.length),
      source: localL2.rows?.at(-1)?.source || "",
      origin: localL2.rows?.length ? "local-cache" : "unavailable",
      row_count: localL2.rows?.length || 0,
      latest: localL2.rows?.at(-1) || null,
      note: localL2.rows?.length
        ? "True L2 rows were replayed from the local authorised depth store."
        : "No authorised L2/depth rows are stored locally; the app will not infer L2 from trades or candles.",
    },
  };
}

async function attachUsTradeFootprint({ market, symbol, interval, candles }) {
  const key = safeMarket(market);
  const normalized = normalizeMarketSymbol(symbol, key);
  if (key !== "US" || !isIntradayInterval(interval) || !Array.isArray(candles) || !candles.length) {
    return {
      candles,
      footprint: {
        available: false,
        source: "",
        note: "Trade footprint enrichment is currently attempted only for US intraday bars.",
      },
    };
  }
  const windowMinutes = 390;
  let liveError = "";
  try {
    if (!alpacaConfigured()) {
      throw new Error("Configure ALPACA_API_KEY and ALPACA_API_SECRET to read real US trades.");
    }
    const tradeData = await fetchAlpacaUsTrades(normalized, windowMinutes);
    await recordAuthorizedMarketRows({
      market: key,
      symbol: normalized,
      dataType: "ticks",
      source: tradeData.source,
      rows: tradeData.trades,
    });
    const enriched = tradeFootprintRows(candles, tradeData.trades, { interval, source: `${tradeData.source}-tick-rule-footprint` });
    return {
      candles: enriched.candles,
      footprint: {
        available: enriched.summary.enriched_candles > 0,
        live: true,
        local_replay: false,
        window_minutes: windowMinutes,
        ...enriched.summary,
        note: "Real Alpaca trade rows were bucketed into each intraday candle; buy/sell side is tick-rule estimated, not exchange-reported aggressor side.",
      },
    };
  } catch (error) {
    liveError = String(error.message || error).slice(0, 240);
  }

  const localTicks = await listAuthorizedMarketRows({
    market: key,
    symbol: normalized,
    dataType: "ticks",
    limit: Math.max(1000, Number(process.env.ALPACA_TRADES_LIMIT || 1000)),
  });
  const localTrades = localTickRowsAsTrades(localTicks.rows || []);
  if (localTrades.length) {
    const enriched = tradeFootprintRows(candles, localTrades, { interval, source: "local-authorized-us-tick-cache-tick-rule-footprint" });
    return {
      candles: enriched.candles,
      footprint: {
        available: enriched.summary.enriched_candles > 0,
        live: false,
        local_replay: true,
        provider_error: liveError,
        ...enriched.summary,
        note: "Live Alpaca trades were unavailable; locally persisted real ticks were replayed and bucketed into intraday candles. Side is tick-rule estimated.",
      },
    };
  }
  return {
    candles,
    footprint: {
      available: false,
      live: false,
      local_replay: false,
      provider_error: liveError,
      source: "us-trade-footprint-unavailable",
      side_method: "tick_rule_estimate",
      aggressor_side_available: false,
      true_l2: false,
      note: `No real US trade rows were available to build a price-level footprint: ${liveError || "no local tick cache"}`,
    },
  };
}

async function fetchNewsItems(symbol, market = "ASX", scope = "all", options = {}) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const safeScope = ["macro", "stock", "all"].includes(String(scope || "").toLowerCase()) ? String(scope || "").toLowerCase() : "all";
  const mode = ["local", "auto", "refresh", "live"].includes(String(options.mode || "").toLowerCase())
    ? String(options.mode || "").toLowerCase()
    : "auto";
  const cacheKey = `${key}:${safeScope}:${safeScope === "macro" ? "MARKET" : code}:${mode === "local" ? "local" : "auto"}`;
  const forceLive = mode === "refresh" || mode === "live";
  const cached = newsResponseCache.get(cacheKey);
  if (!forceLive && cached && Date.now() - cached.time < Number(process.env.NEWS_CACHE_TTL_MS || 10 * 60 * 1000)) return cached.value;
  cleanupNewsDiskCache().catch(() => {});
  const diskCache = await readNewsDiskCache(key, safeScope, safeScope === "macro" ? "MARKET" : code);
  const refreshDecision = newsRefreshDecision(key, diskCache?.value?.cachedAt || null);
  if (mode === "local") {
    const value = diskCache?.value
      ? {
        ...diskCache.value,
        cache: "disk-local",
        refreshDecision,
        warning: diskCache.value.warning || "",
      }
      : {
        source: "local-news-cache-miss",
        providers: [],
        limitedProvider: null,
        news: [],
        signal: newsSignal([], code, key),
        scope: safeScope,
        cache: "disk-miss",
        refreshDecision,
        warning: "No local news cache exists for this symbol/scope.",
      };
    newsResponseCache.set(cacheKey, { time: Date.now(), value });
    return value;
  }
  if (diskCache?.value && mode === "auto" && !refreshDecision.due) {
    const value = {
      ...diskCache.value,
      cache: "disk-scheduled",
      refreshDecision,
      warning: diskCache.value.warning || "Using local persisted news until the next scheduled refresh window.",
    };
    newsResponseCache.set(cacheKey, { time: Date.now(), value });
    return value;
  }
  if (diskCache?.value && !forceLive && diskCache.ageMs < newsLiveCacheTtlMs()) {
    const value = { ...diskCache.value, refreshDecision };
    newsResponseCache.set(cacheKey, { time: Date.now(), value });
    return value;
  }
  const context = sectorContext(code, key);
  const marketName = MARKET_CONFIG[key].newsName;
  const locale = marketNewsLocale(key);
  const impactQueries = safeScope === "macro"
    ? macroNewsQueriesFor(key)
    : safeScope === "stock"
      ? stockNewsQueriesFor(code, key, context, marketName)
      : impactQueriesFor(code, key);

  const fetchGdelt = async () => {
    const results = await Promise.allSettled(impactQueries.slice(0, 5).map(async ({ query, channel }) => {
      const endpoint = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      endpoint.searchParams.set("query", query);
      endpoint.searchParams.set("mode", "ArtList");
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("maxrecords", "8");
      endpoint.searchParams.set("sort", "HybridRel");
      const payload = await fetchJson(endpoint, 4500);
      return addNewsMeta(gdeltNewsRows(payload), "gdelt", channel, key, code);
    }));
    return {
      source: "gdelt",
      news: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    };
  };

  const fetchGoogleRss = async () => {
    const results = await Promise.allSettled(impactQueries.map(async ({ query, zhQuery, channel }) => {
      const endpoint = new URL("https://news.google.com/rss/search");
      endpoint.searchParams.set("q", key === "CN" ? zhQuery : query);
      endpoint.searchParams.set("hl", locale.hl);
      endpoint.searchParams.set("gl", locale.gl);
      endpoint.searchParams.set("ceid", locale.ceid);
      const xml = await fetchText(endpoint, 3500);
      return addNewsMeta(rssRows(xml, channel), "google-news-rss", channel, key, code);
    }));
    const policyFeeds = key === "ASX" && safeScope !== "stock"
      ? await Promise.allSettled([
        fetchText("https://www.rba.gov.au/rss/rss-cb-media-releases.xml", 3500).then((xml) => addNewsMeta(rssRows(xml, "macro-policy"), "rba-rss", "macro-policy", key, code)),
        fetchText("https://www.rba.gov.au/rss/rss-cb-speeches.xml", 3500).then((xml) => addNewsMeta(rssRows(xml, "macro-policy"), "rba-rss", "macro-policy", key, code)),
      ])
      : [];
    return {
      source: "google-news-rss",
      news: dedupeNews([
        ...results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
        ...policyFeeds.flatMap((result) => result.status === "fulfilled" ? result.value : []),
      ]),
    };
  };

  const fetchNewsApi = async () => {
    if (!process.env.NEWSAPI_KEY) return { source: "newsapi-disabled", news: [] };
    const results = await Promise.allSettled(impactQueries.map(async ({ query, channel }) => {
      const endpoint = new URL("https://newsapi.org/v2/everything");
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("language", "en");
      endpoint.searchParams.set("sortBy", "publishedAt");
      endpoint.searchParams.set("pageSize", "5");
      endpoint.searchParams.set("apiKey", process.env.NEWSAPI_KEY);
      const payload = await fetchJson(endpoint, 3500);
      return addNewsMeta((payload.articles || []).map((item) => ({
        title: item.title,
        publisher: item.source?.name,
        link: item.url,
        publishedAt: item.publishedAt,
        description: item.description,
      })), "newsapi", channel, key, code);
    }));
    let news = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!news.length && safeScope !== "stock") {
      const headlineEndpoint = new URL("https://newsapi.org/v2/top-headlines");
      headlineEndpoint.searchParams.set("country", key === "US" ? "us" : key === "CN" ? "cn" : "au");
      headlineEndpoint.searchParams.set("category", "business");
      headlineEndpoint.searchParams.set("pageSize", "12");
      headlineEndpoint.searchParams.set("apiKey", process.env.NEWSAPI_KEY);
      try {
        const headlines = await fetchJson(headlineEndpoint, 3500);
        news = addNewsMeta((headlines.articles || []).map((item) => ({
          title: item.title,
          publisher: item.source?.name,
          link: item.url,
          publishedAt: item.publishedAt,
          description: item.description,
        })), "newsapi-headlines", "macro-policy", key, code);
      } catch {
        news = [];
      }
    }
    return { source: "newsapi", news };
  };

  const fetchNewsData = async () => {
    if (!process.env.NEWSDATA_API_KEY) return { source: "newsdata-disabled", news: [] };
    const results = await Promise.allSettled(impactQueries.map(async ({ query, zhQuery, channel }) => {
      const endpoint = new URL("https://newsdata.io/api/1/latest");
      endpoint.searchParams.set("apikey", process.env.NEWSDATA_API_KEY);
      endpoint.searchParams.set("q", key === "CN" ? zhQuery : query);
      endpoint.searchParams.set("language", key === "CN" ? "zh,en" : locale.newsdataLanguage);
      endpoint.searchParams.set("size", "5");
      const payload = await fetchJson(endpoint, 3500);
      return addNewsMeta((payload.results || []).map((item) => ({
        title: item.title,
        publisher: item.source_name,
        link: item.link,
        publishedAt: item.pubDate,
        description: item.description,
      })), "newsdata", channel, key, code);
    }));
    return { source: "newsdata", news: results.flatMap((result) => result.status === "fulfilled" ? result.value : []) };
  };

  const fetchTheNewsApi = async () => {
    if (!process.env.THENEWSAPI_KEY) return { source: "thenewsapi-disabled", news: [] };
    const results = await Promise.allSettled(impactQueries.map(async ({ query, channel }) => {
      const endpoint = new URL("https://api.thenewsapi.com/v1/news/all");
      endpoint.searchParams.set("api_token", process.env.THENEWSAPI_KEY);
      endpoint.searchParams.set("search", query);
      endpoint.searchParams.set("language", locale.newsapiLanguage);
      endpoint.searchParams.set("limit", "5");
      const payload = await fetchJson(endpoint, 3500);
      return addNewsMeta((payload.data || []).map((item) => ({
        title: item.title,
        publisher: item.source,
        link: item.url,
        publishedAt: item.published_at,
        description: item.description,
      })), "the-news-api", channel, key, code);
    }));
    return { source: "the-news-api", news: results.flatMap((result) => result.status === "fulfilled" ? result.value : []) };
  };

  const fetchTianApi = async () => {
    if (!process.env.TIANAPI_KEY) return { source: "tianapi-disabled", news: [] };
    const results = await Promise.allSettled(impactQueries.map(async ({ zhQuery, channel }) => {
      const endpoint = new URL("https://apis.tianapi.com/generalnews/index");
      endpoint.searchParams.set("key", process.env.TIANAPI_KEY);
      endpoint.searchParams.set("word", zhQuery.replace(/\bOR\b/gi, " ").split(/\s+/).slice(0, 6).join(" "));
      endpoint.searchParams.set("num", "6");
      const payload = await fetchJson(endpoint, 3500);
      const rows = payload?.result?.newslist || payload?.newslist || [];
      return addNewsMeta(rows.map((item) => ({
        title: item.title,
        publisher: item.source,
        link: item.url,
        publishedAt: item.ctime || item.publish_time,
        description: item.description || item.digest,
      })), "tianapi", channel, key, code);
    }));
    return { source: "tianapi", news: results.flatMap((result) => result.status === "fulfilled" ? result.value : []) };
  };

  const fetchMarketaux = async () => {
    if (!process.env.MARKETAUX_API_KEY) return { source: "marketaux-disabled", news: [] };
    const endpoint = new URL("https://api.marketaux.com/v1/news/all");
    endpoint.searchParams.set("api_token", process.env.MARKETAUX_API_KEY);
    endpoint.searchParams.set("language", "en");
    endpoint.searchParams.set("filter_entities", "true");
    endpoint.searchParams.set("limit", "10");
    if (key === "US" && safeScope !== "macro" && code) endpoint.searchParams.set("symbols", code);
    else endpoint.searchParams.set("search", impactQueries.slice(0, 2).map((item) => item.query).join(" OR "));
    const payload = await fetchJson(endpoint, 4000);
    return {
      source: "marketaux",
      news: addNewsMeta((payload.data || []).map((item) => ({
        title: item.title,
        publisher: item.source,
        link: item.url,
        publishedAt: item.published_at,
        description: item.description || item.snippet,
        channel: safeScope === "macro" ? "macro-global" : "direct-stock",
      })), "marketaux", safeScope === "macro" ? "macro-global" : "direct-stock", key, code),
    };
  };

  const fetchEastmoney = async () => {
    if (key !== "CN" || safeScope === "macro") return { source: "eastmoney-announcements-disabled", news: [] };
    const rows = await fetchEastmoneyAnnouncements(code, 12);
    return {
      source: "eastmoney-announcements",
      news: addNewsMeta(rows, "eastmoney-announcements", "direct-stock", key, code),
    };
  };

  const fetchSec = async () => {
    if (key !== "US" || safeScope === "macro") return { source: "sec-edgar-disabled", news: [] };
    const bundle = await fetchSecFilings(code, 10);
    return {
      source: "sec-edgar-filings",
      news: addNewsMeta((bundle.filings || []).map((item) => ({
        title: `${code} ${item.form}: ${item.title}`,
        publisher: "SEC EDGAR",
        link: item.link,
        publishedAt: item.publishedAt || item.filingDate,
        description: item.description || item.formName,
        channel: "direct-stock",
        impactScope: "sec-filing",
      })), "sec-edgar-filings", "direct-stock", key, code),
    };
  };

  const fetchStockAnalysisAsxNews = async () => {
    if (key !== "ASX" || safeScope === "macro") return { source: "stockanalysis-asx-news-disabled", news: [] };
    const endpoint = `https://stockanalysis.com/quote/asx/${encodeURIComponent(cleanCode(code, "ASX"))}/`;
    const html = await fetchText(endpoint, 4500);
    return {
      source: "stockanalysis-asx-news",
      news: stockAnalysisNewsFromHtml(html, code),
    };
  };

  const newsProviderPreference = String(process.env.NEWS_PRIMARY_PROVIDER || (
    key === "CN" ? "tianapi" : key === "US" ? "marketaux" : "newsapi"
  )).toLowerCase();
  const limitedNewsTasks = [
    { name: "marketaux", configured: Boolean(process.env.MARKETAUX_API_KEY), task: fetchMarketaux },
    { name: "newsapi", configured: Boolean(process.env.NEWSAPI_KEY), task: fetchNewsApi },
    { name: "newsdata", configured: Boolean(process.env.NEWSDATA_API_KEY), task: fetchNewsData },
    { name: "thenewsapi", configured: Boolean(process.env.THENEWSAPI_KEY), task: fetchTheNewsApi },
    { name: "tianapi", configured: Boolean(process.env.TIANAPI_KEY), task: fetchTianApi },
  ];
  const selectedLimitedNews = limitedNewsTasks.find((provider) => provider.name === newsProviderPreference && provider.configured)
    || limitedNewsTasks.find((provider) => provider.configured)
    || null;
  const sourceResults = await Promise.allSettled([
    fetchStockAnalysisAsxNews(),
    fetchEastmoney(),
    fetchSec(),
    selectedLimitedNews
      ? selectedLimitedNews.task()
      : Promise.resolve({ source: "limited-news-unconfigured", news: [] }),
    fetchGoogleRss(),
    fetchGdelt(),
  ]);
  const news = dedupeNews(sourceResults.flatMap((result) => result.status === "fulfilled" ? result.value.news : []));
  if (!news.length && diskCache?.value?.news?.length) {
    const fallbackValue = {
      ...diskCache.value,
      cache: "disk-stale-fallback",
      refreshDecision,
      warning: "Live news providers returned no rows; using locally persisted real news cache from the last 7 days.",
    };
    newsResponseCache.set(cacheKey, { time: Date.now(), value: fallbackValue });
    return fallbackValue;
  }
  const value = {
    source: news.length ? "multi-news" : "multi-news-empty",
    providers: sourceResults.map((result) => result.status === "fulfilled" ? result.value.source : "provider-error"),
    limitedProvider: selectedLimitedNews?.name || null,
    news,
    signal: newsSignal(news, code, key),
    scope: safeScope,
    cache: "live",
    cachedAt: new Date().toISOString(),
    refreshDecision: newsRefreshDecision(key, new Date().toISOString()),
    refreshMode: mode,
  };
  newsResponseCache.set(cacheKey, { time: Date.now(), value });
  if (news.length) writeNewsDiskCache(key, safeScope, safeScope === "macro" ? "MARKET" : code, value).catch(() => {});
  if (newsResponseCache.size > 100) newsResponseCache.delete(newsResponseCache.keys().next().value);
  return value;
}

async function fetchFundamentals(symbol, market = "ASX") {
  const key = safeMarket(market);
  if (key === "CN") {
    try {
      return await fetchTencentCnFundamentals(symbol);
    } catch (error) {
      if (!providerConfigured("eodhd")) return { source: "tencent-cn-fundamentals-unavailable", fundamentals: null, warning: error.message };
    }
  }
  if (key === "US" && !providerConfigured("eodhd")) {
    try {
      return await fetchSecUsFundamentals(symbol);
    } catch (error) {
      return { source: "sec-edgar-fundamentals-unavailable", fundamentals: null, warning: error.message };
    }
  }
  if (!providerConfigured("eodhd")) return { source: "none", fundamentals: null };
  try {
    const code = cleanCode(symbol, key);
    const payload = await withProviderApiKey("eodhd", {
      backoffKey: `eodhd-${key.toLowerCase()}-fundamentals`,
      backoffMs: 12 * 60 * 60 * 1000,
      label: `EODHD ${key} fundamentals`,
    }, async (apiKey) => {
      const endpoint = new URL(`https://eodhd.com/api/fundamentals/${eodhdTickerForCode(code, key)}`);
      endpoint.searchParams.set("api_token", apiKey);
      endpoint.searchParams.set("fmt", "json");
      return fetchJson(endpoint, 6000);
    });
    const highlights = payload?.Highlights || {};
    const valuation = payload?.Valuation || {};
    return {
      source: "eodhd-fundamentals",
      fundamentals: {
        name: payload?.General?.Name,
        sector: payload?.General?.Sector,
        industry: payload?.General?.Industry,
        marketCap: highlights.MarketCapitalization,
        peRatio: highlights.PERatio,
        forwardPE: valuation.ForwardPE,
        dividendYield: highlights.DividendYield,
        eps: highlights.EarningsShare,
        profitMargin: highlights.ProfitMargin,
        beta: highlights.Beta,
      },
    };
  } catch (error) {
    if (key === "US") {
      try {
        const fallback = await fetchSecUsFundamentals(symbol);
        return { ...fallback, warning: `EODHD fundamentals unavailable; SEC profile used. ${error.message}` };
      } catch {
        return { source: "eodhd-fundamentals-unavailable", fundamentals: null, warning: error.message };
      }
    }
    return { source: "eodhd-fundamentals-unavailable", fundamentals: null, warning: error.message };
  }
}

function asxAnnouncementRows(html) {
  return [...String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => {
    const block = match[1];
    const cells = [...block.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
    if (cells.length < 3) return null;
    const date = parseAuDate(stripHtml(cells[0]));
    const priceSensitive = /price sensitive|icon-price-sensitive|pricesens/i.test(cells[1]);
    const href = cells[2].match(/href=["']([^"']+)["']/i)?.[1] || "";
    const title = stripHtml(cells[2]).replace(/\b\d+\s+pages?\b.*$/i, "").trim();
    if (!date || !title) return null;
    return {
      date,
      priceSensitive,
      title,
      link: href.startsWith("http") ? href : `https://www.asx.com.au${href.replace(/&amp;/g, "&")}`,
    };
  }).filter(Boolean).slice(0, 12);
}

async function fetchAsxAnnouncementsFactor(symbol, market = "ASX") {
  const key = safeMarket(market);
  if (key === "US") {
    const code = cleanCode(symbol, key);
    const bundle = await fetchSecFilings(code, 12);
    const filings = bundle.filings || [];
    const text = filings.map((item) => `${item.form} ${item.title} ${item.description}`).join(" ").toLowerCase();
    let score = 0;
    const earningsReports = filings.filter((item) => /^(10-Q|10-K)$/.test(item.form)).length;
    const currentReports = filings.filter((item) => item.form === "8-K").length;
    const ownershipReports = filings.filter((item) => /13G|13D|SC 13/i.test(item.form)).length;
    if (/item 2\.02|results of operations|10-q|10-k/.test(text)) score += Math.min(5, earningsReports * 1.5 + (currentReports ? 1 : 0));
    if (/late filing|nt 10-|item 4\.02|non-reliance|going concern|bankruptcy|delisting|investigation|subpoena|class action/.test(text)) score -= 9;
    if (/s-3|s-1|424b|prospectus|offering|dilution/.test(text)) score -= 4;
    if (/share repurchase|buyback|dividend|acquisition agreement|strategic partnership/.test(text)) score += 5;
    if (ownershipReports) score += Math.min(3, ownershipReports);
    if (currentReports >= 5) score -= 1.5;
    return {
      available: filings.length > 0,
      source: "sec-edgar-filings",
      score: Math.max(-15, Math.min(15, score)),
      thesis: filings.length
        ? [`SEC filings checked ${filings.length} recent rows for ${code}; 10-K/10-Q ${earningsReports}, 8-K ${currentReports}, ownership filings ${ownershipReports}.`]
        : ["SEC EDGAR returned no recent filings."],
      items: filings,
    };
  }
  if (key === "CN") {
    const code = cleanCode(symbol, key);
    const announcements = await fetchEastmoneyAnnouncements(code, 12);
    const text = announcements.map((item) => `${item.title} ${item.description}`).join(" ");
    let score = 0;
    if (/回购|增持|分红|业绩预增|利润增长|中标|股权激励/.test(text)) score += 7;
    if (/减持|问询函|立案|处罚|退市风险|业绩预亏|利润下降|商誉减值/.test(text)) score -= 9;
    return {
      available: announcements.length > 0,
      source: "eastmoney-official-announcements",
      score: Math.max(-15, Math.min(15, score)),
      thesis: announcements.length
        ? [`东方财富公告检查 ${announcements.length} 条；公告面评分 ${score.toFixed(1)}。`]
        : ["东方财富公告源没有返回近期公告。"],
      items: announcements,
    };
  }
  if (key !== "ASX") {
    return { available: false, source: "market-announcements-unavailable", score: 0, thesis: ["Exchange-specific announcement feed is not configured for this market yet."] };
  }
  const code = cleanAsxCode(symbol);
  const endpoint = new URL("https://www.asx.com.au/asx/v2/statistics/announcements.do");
  endpoint.searchParams.set("by", "asxCode");
  endpoint.searchParams.set("asxCode", code);
  endpoint.searchParams.set("timeframe", "D");
  endpoint.searchParams.set("period", "M6");
  const html = await fetchText(endpoint, 4500);
  const announcements = asxAnnouncementRows(html);
  const text = announcements.map((item) => item.title).join(" ").toLowerCase();
  let score = 0;
  if (/profit warning|downgrade|capital raising|placement|investigation|class action|impairment|suspension/.test(text)) score -= 8;
  if (/buy-back|buyback|upgrade|guidance upgrade|record|dividend|contract|approval|takeover|acquisition/.test(text)) score += 6;
  const sensitiveCount = announcements.filter((item) => item.priceSensitive).length;
  if (sensitiveCount >= 3) score -= 2;
  return {
    available: announcements.length > 0,
    source: "asx-official-announcements",
    score: Math.max(-15, Math.min(15, score)),
    thesis: announcements.length
      ? [`ASX announcements checked: ${announcements.length} in six months, ${sensitiveCount} price-sensitive.`]
      : ["ASX announcements source returned no rows."],
    items: announcements,
  };
}

async function fetchShortInterestFactor(symbol, market = "ASX", candles = null) {
  const key = safeMarket(market);
  if (key !== "ASX") {
    const marketData = await fetchMarketCandles(symbol, "3mo", "1d", key);
    return positioningProxyFactor(marketData.candles, key);
  }
  try {
    const page = await fetchText("https://www.asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/", 4500);
    const csvLink = [...page.matchAll(/href=["']([^"']+\.(?:csv|zip|xlsx))["']/gi)]
      .map((match) => match[1])
      .find((href) => /short/i.test(href));
    if (!csvLink) throw new Error("No machine-readable short-position file link found on ASIC page.");
    return {
      available: false,
      source: "asic-short-position-page",
      score: 0,
      thesis: ["ASIC short-position page was reachable, but the current app could not identify a direct CSV/ZIP link automatically."],
      link: csvLink.startsWith("http") ? csvLink : `https://www.asic.gov.au${csvLink}`,
    };
  } catch (error) {
    const proxy = positioningProxyFactor(candles || [], key);
    if (proxy.available) {
      return {
        ...proxy,
        source: "asx-short-positioning-proxy-fallback",
        thesis: [
          `ASIC short-interest direct file unavailable, so a price-volume positioning proxy is used. ${proxy.thesis?.[0] || ""}`.trim(),
        ],
      };
    }
    return {
      available: false,
      source: "asic-short-position-unavailable",
      score: 0,
      thesis: [`ASIC short-interest factor unavailable: ${error.message}`],
    };
  }
}

function positioningProxyFactor(candles, market = "ASX") {
  const rows = sanitizeCandleRows(candles).slice(-25);
  if (rows.length < 12) {
    return { available: false, source: "positioning-proxy", score: 0, thesis: ["Not enough price-volume history for positioning proxy."] };
  }
  let signedValue = 0;
  let totalValue = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const prev = rows[index - 1].close;
    const row = rows[index];
    const turnoverValue = Number(row.close || 0) * Number(row.volume || 0);
    const direction = Math.sign(Number(row.close || 0) - Number(prev || 0));
    signedValue += turnoverValue * direction;
    totalValue += Math.abs(turnoverValue);
  }
  const pressure = totalValue ? signedValue / totalValue : 0;
  const last5 = pctReturn(rows, 5);
  const volumeRatio = Number(rows.at(-1).volume || 0) / Math.max(1, rows.slice(-20).reduce((sum, row) => sum + Number(row.volume || 0), 0) / Math.min(20, rows.length));
  const score = Math.max(-10, Math.min(10, pressure * 16 + (last5 > 0 ? 1.5 : -1.5) + (volumeRatio > 1.25 ? 2 : 0)));
  return {
    available: true,
    source: `${safeMarket(market).toLowerCase()}-price-volume-positioning-proxy`,
    score,
    thesis: [`资金/空头替代因子：近 25 日价格成交量方向压力 ${(pressure * 100).toFixed(1)}%，5 日涨跌 ${last5.toFixed(2)}%，量比 ${volumeRatio.toFixed(2)}x。`],
    values: { pressure, last5, volumeRatio },
  };
}

function eastmoneyNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchCnMarginNorthboundFactor(symbol) {
  const code = cleanCode(symbol, "CN").replace(/^(SH|SZ)/, "");
  if (!/^\d{6}$/.test(code)) {
    return { available: false, source: "eastmoney-cn-flow-invalid-code", score: 0, thesis: ["A-share margin/northbound factor needs a six-digit stock code."] };
  }

  const marginEndpoint = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  marginEndpoint.searchParams.set("reportName", "RPTA_WEB_RZRQ_GGMX");
  marginEndpoint.searchParams.set("columns", "ALL");
  marginEndpoint.searchParams.set("source", "WEB");
  marginEndpoint.searchParams.set("pageNumber", "1");
  marginEndpoint.searchParams.set("pageSize", "5");
  marginEndpoint.searchParams.set("sortColumns", "DATE");
  marginEndpoint.searchParams.set("sortTypes", "-1");
  marginEndpoint.searchParams.set("filter", `(scode=${code})`);

  const northEndpoint = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  northEndpoint.searchParams.set("reportName", "RPT_MUTUAL_HOLDSTOCKNORTH_STA");
  northEndpoint.searchParams.set("columns", "ALL");
  northEndpoint.searchParams.set("source", "WEB");
  northEndpoint.searchParams.set("pageNumber", "1");
  northEndpoint.searchParams.set("pageSize", "3");
  northEndpoint.searchParams.set("sortColumns", "TRADE_DATE");
  northEndpoint.searchParams.set("sortTypes", "-1");
  northEndpoint.searchParams.set("filter", `(SECURITY_CODE="${code}")`);

  const [marginResult, northResult] = await Promise.allSettled([
    fetchJson(marginEndpoint, 4500),
    fetchJson(northEndpoint, 4500),
  ]);
  const marginRow = marginResult.status === "fulfilled" ? marginResult.value?.result?.data?.[0] : null;
  const northRow = northResult.status === "fulfilled" ? northResult.value?.result?.data?.[0] : null;

  let score = 0;
  const thesis = [];
  const values = {};
  if (marginRow) {
    const financingNet = eastmoneyNumber(marginRow.RZJME);
    const financingNet5d = eastmoneyNumber(marginRow.RZJME5D);
    const shortNetShares = eastmoneyNumber(marginRow.RQJMG);
    const financingBalanceGrowth = eastmoneyNumber(marginRow.FIN_BALANCE_GR);
    const financingBalanceRatio = eastmoneyNumber(marginRow.RZYEZB);
    values.marginDate = marginRow.DATE;
    values.financingNet = financingNet;
    values.financingNet5d = financingNet5d;
    values.shortNetShares = shortNetShares;
    values.financingBalanceGrowth = financingBalanceGrowth;
    values.financingBalanceRatio = financingBalanceRatio;
    if (financingNet5d != null) score += Math.max(-4, Math.min(4, financingNet5d / 100_000_000));
    if (financingNet != null) score += Math.max(-2, Math.min(2, financingNet / 80_000_000));
    if (financingBalanceGrowth != null) score += Math.max(-3, Math.min(3, financingBalanceGrowth / 3));
    if (shortNetShares != null) score += Math.max(-2.5, Math.min(2.5, -shortNetShares / 1_000_000));
    if (financingBalanceRatio != null && financingBalanceRatio > 8) score -= 1.5;
    thesis.push(`融资融券：${String(marginRow.DATE || "").slice(0, 10)}，5日融资净买 ${financingNet5d == null ? "n/a" : (financingNet5d / 100_000_000).toFixed(2) + "亿"}，融资余额增速 ${financingBalanceGrowth == null ? "n/a" : financingBalanceGrowth.toFixed(2) + "%"}。`);
  }
  if (northRow) {
    const holdCap = eastmoneyNumber(northRow.HOLD_MARKET_CAP);
    const holdCapChange = eastmoneyNumber(northRow.HOLD_MARKETCAP_CHG5) ?? eastmoneyNumber(northRow.HOLD_MARKETCAP_CHG);
    const holdRatio = eastmoneyNumber(northRow.HOLD_SHARES_RATIO);
    const changeRate = eastmoneyNumber(northRow.CHANGE_RATE);
    values.northDate = northRow.TRADE_DATE;
    values.northHoldMarketCap = holdCap;
    values.northHoldMarketCapChange = holdCapChange;
    values.northHoldSharesRatio = holdRatio;
    values.northChangeRate = changeRate;
    if (holdCapChange != null) score += Math.max(-4, Math.min(4, holdCapChange / 100_000_000));
    if (changeRate != null) score += Math.max(-2, Math.min(2, changeRate / 3));
    thesis.push(`北向持股：${String(northRow.TRADE_DATE || "").slice(0, 10)}，持仓市值 ${holdCap == null ? "n/a" : (holdCap / 100_000_000).toFixed(2) + "亿"}，变动 ${holdCapChange == null ? "n/a" : (holdCapChange / 100_000_000).toFixed(2) + "亿"}。`);
  }
  if (!marginRow && !northRow) {
    const reason = [
      marginResult.status === "rejected" ? `融资融券 ${marginResult.reason?.message || marginResult.reason}` : "",
      northResult.status === "rejected" ? `北向 ${northResult.reason?.message || northResult.reason}` : "",
    ].filter(Boolean).join(" | ");
    return {
      available: false,
      source: "eastmoney-cn-flow-unavailable",
      score: 0,
      thesis: [reason || "东方财富融资融券/北向资金没有返回该股票数据。"],
    };
  }
  return {
    available: true,
    source: "eastmoney-margin-northbound",
    score: Math.max(-12, Math.min(12, score)),
    thesis,
    values,
  };
}

async function fetchUsOptionsFactor(symbol) {
  const code = cleanCode(symbol, "US");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(code)) {
    return { available: false, source: "yahoo-options-invalid-code", score: 0, thesis: ["US options factor needs a valid listed ticker."] };
  }
  const endpoint = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(code)}`;
  try {
    const payload = await fetchJson(endpoint, 4500);
    const result = payload?.optionChain?.result?.[0];
    const option = result?.options?.[0];
    const calls = Array.isArray(option?.calls) ? option.calls : [];
    const puts = Array.isArray(option?.puts) ? option.puts : [];
    const price = Number(result?.quote?.regularMarketPrice || result?.quote?.postMarketPrice || result?.quote?.previousClose || 0);
    const contracts = [...calls, ...puts].filter((contract) => Number.isFinite(Number(contract.impliedVolatility)));
    if (!contracts.length) {
      return { available: false, source: "yahoo-options-empty", score: 0, thesis: ["Yahoo options chain returned no contracts with implied volatility."] };
    }
    const nearMoney = price > 0
      ? contracts
        .map((contract) => ({ ...contract, distance: Math.abs(Number(contract.strike || 0) - price) / price }))
        .filter((contract) => contract.distance <= 0.18)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 24)
      : contracts.slice(0, 24);
    const usable = nearMoney.length ? nearMoney : contracts.slice(0, 24);
    const avgIv = usable.reduce((sum, contract) => sum + Number(contract.impliedVolatility || 0), 0) / usable.length;
    const callVolume = calls.reduce((sum, contract) => sum + Number(contract.volume || 0), 0);
    const putVolume = puts.reduce((sum, contract) => sum + Number(contract.volume || 0), 0);
    const putCallVolumeRatio = callVolume > 0 ? putVolume / callVolume : null;
    let score = 0;
    if (avgIv > 0.85) score -= 6;
    else if (avgIv > 0.55) score -= 3;
    else if (avgIv > 0 && avgIv < 0.32) score += 2;
    if (putCallVolumeRatio != null) {
      if (putCallVolumeRatio > 1.4) score -= 4;
      else if (putCallVolumeRatio < 0.75) score += 2;
    }
    return {
      available: true,
      source: "yahoo-options-chain",
      score: Math.max(-12, Math.min(12, score)),
      thesis: [`期权隐波：近价合约平均 IV ${(avgIv * 100).toFixed(1)}%，put/call 成交量比 ${putCallVolumeRatio == null ? "n/a" : putCallVolumeRatio.toFixed(2)}。`],
      values: { expirationDate: option?.expirationDate || null, price, avgIv, putCallVolumeRatio, callVolume, putVolume },
    };
  } catch (error) {
    return { available: false, source: "yahoo-options-unavailable", score: 0, thesis: [`US options IV factor unavailable: ${error.message}`] };
  }
}

async function fetchFlowOptionsFactor(symbol, market = "ASX", candles = null) {
  const key = safeMarket(market);
  if (key === "CN") return fetchCnMarginNorthboundFactor(symbol);
  if (key === "US") return fetchUsOptionsFactor(symbol);
  const proxy = positioningProxyFactor(candles || [], key);
  return proxy.available
    ? {
      ...proxy,
      source: "asx-flow-price-volume-proxy",
      thesis: [`ASX 资金流替代因子：${proxy.thesis?.[0] || "使用近 25 日价格成交量方向压力。"}`],
    }
    : {
      available: false,
      source: "flow-options-unavailable",
      score: 0,
      thesis: ["ASX-specific licensed flow/options feed is not connected and price-volume proxy lacked enough data."],
    };
}

async function fetchFredMacroFactor() {
  if (!process.env.FRED_API_KEY) {
    return { available: false, source: "fred-disabled", score: 0, thesis: ["FRED API key is not configured."] };
  }
  const cached = macroResponseCache.get("fred-us");
  if (cached && Date.now() - cached.time < Number(process.env.MACRO_CACHE_TTL_MS || 30 * 60 * 1000)) return cached.value;
  const fetchSeries = async (seriesId, limit = 14) => {
    const endpoint = new URL("https://api.stlouisfed.org/fred/series/observations");
    endpoint.searchParams.set("series_id", seriesId);
    endpoint.searchParams.set("api_key", process.env.FRED_API_KEY);
    endpoint.searchParams.set("file_type", "json");
    endpoint.searchParams.set("sort_order", "desc");
    endpoint.searchParams.set("limit", String(limit));
    const payload = await fetchJson(endpoint, 4500);
    return (payload.observations || [])
      .map((row) => ({ date: row.date, value: Number(row.value) }))
      .filter((row) => Number.isFinite(row.value));
  };
  const [rates, inflation, unemployment] = await Promise.all([
    fetchSeries("FEDFUNDS", 4),
    fetchSeries("CPIAUCSL", 14),
    fetchSeries("UNRATE", 4),
  ]);
  const latestRate = rates[0]?.value;
  const priorRate = rates[1]?.value;
  const latestCpi = inflation[0]?.value;
  const priorYearCpi = inflation[12]?.value;
  const inflationYoy = latestCpi > 0 && priorYearCpi > 0 ? (latestCpi / priorYearCpi - 1) * 100 : null;
  const latestUnemployment = unemployment[0]?.value;
  const priorUnemployment = unemployment[1]?.value;
  let score = 0;
  const thesis = [];
  if (Number.isFinite(latestRate) && Number.isFinite(priorRate)) {
    const change = latestRate - priorRate;
    score += change < -0.05 ? 4 : change > 0.05 ? -4 : 0;
    thesis.push(`FRED Fed funds ${latestRate.toFixed(2)}%, monthly change ${change.toFixed(2)}pp.`);
  }
  if (Number.isFinite(inflationYoy)) {
    score += inflationYoy <= 2.8 ? 3 : inflationYoy >= 3.8 ? -4 : 0;
    thesis.push(`FRED CPI year-over-year ${inflationYoy.toFixed(2)}%.`);
  }
  if (Number.isFinite(latestUnemployment) && Number.isFinite(priorUnemployment)) {
    const change = latestUnemployment - priorUnemployment;
    score += change > 0.2 ? -3 : change < -0.1 ? 2 : 0;
    thesis.push(`FRED unemployment ${latestUnemployment.toFixed(2)}%, monthly change ${change.toFixed(2)}pp.`);
  }
  const value = {
    available: thesis.length > 0,
    source: "fred-official-macro",
    score: Math.max(-10, Math.min(10, score)),
    thesis,
    values: {
      latestRate,
      inflationYoy,
      latestUnemployment,
      observations: {
        rateDate: rates[0]?.date || null,
        cpiDate: inflation[0]?.date || null,
        unemploymentDate: unemployment[0]?.date || null,
      },
    },
  };
  macroResponseCache.set("fred-us", { time: Date.now(), value });
  return value;
}

async function fetchMacroFactor(symbol, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const context = sectorContext(code, key);
  if (key !== "ASX") {
    let items = [];
    let source = "macro-google-news-rss";
    try {
      const endpoint = new URL("https://news.google.com/rss/search");
      endpoint.searchParams.set("q", key === "US" ? "Federal Reserve inflation rates Wall Street economy" : "PBOC China stimulus A shares economy");
      endpoint.searchParams.set("hl", key === "CN" ? "zh-CN" : "en-US");
      endpoint.searchParams.set("gl", key === "CN" ? "CN" : "US");
      endpoint.searchParams.set("ceid", key === "CN" ? "CN:zh-Hans" : "US:en");
      const xml = await fetchText(endpoint, 3500);
      items = rssRows(xml, "macro-google-news").slice(0, 12);
    } catch {
      const news = await fetchNewsItems(symbol, key);
      items = (news.news || []).filter((item) => /macro|policy|global|geopolitical/.test(item.channel || "")).slice(0, 12);
      source = "multi-news-macro-fallback";
    }
    const signal = newsSignal(items, code, key);
    const fred = key === "US"
      ? await fetchFredMacroFactor().catch((error) => ({
        available: false,
        source: "fred-unavailable",
        score: 0,
        thesis: [`FRED macro factor unavailable: ${error.message || error}`],
      }))
      : null;
    return {
      available: items.length > 0 || Boolean(fred?.available),
      source: fred?.available ? `${source}+${fred.source}` : source,
      score: Math.max(-12, Math.min(12, signal.score + Number(fred?.score || 0))),
      thesis: [
        items.length ? `Macro feed checked ${items.length} items; stance ${signal.stance}.` : "Macro feed returned no items.",
        ...(fred?.thesis || []),
      ],
      items,
      values: fred?.values || {},
    };
  }
  const feeds = await Promise.allSettled([
    fetchText("https://www.rba.gov.au/rss/rss-cb-media-releases.xml", 3000).then((xml) => rssRows(xml, "rba-media")),
    fetchText("https://www.rba.gov.au/rss/rss-cb-speeches.xml", 3000).then((xml) => rssRows(xml, "rba-speeches")),
  ]);
  const items = feeds.flatMap((result) => result.status === "fulfilled" ? result.value : []).slice(0, 12);
  const signal = newsSignal(items, code, key);
  const text = items.map((item) => `${item.title} ${item.description}`).join(" ").toLowerCase();
  let score = signal.score;
  if (context.sector === "banks" && /inflation|cash rate|monetary policy|financial stability/.test(text)) score += 1;
  return {
    available: items.length > 0,
    source: "rba-official-rss",
    score: Math.max(-12, Math.min(12, score)),
    thesis: items.length ? [`RBA macro feed checked ${items.length} items; stance ${signal.stance}.`] : ["RBA macro feeds returned no items."],
    items,
  };
}

async function fetchSectorFactor(symbol, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const context = sectorContext(code, key);
  let items = [];
  let source = "sector-google-news-rss";
  try {
    const endpoint = new URL("https://news.google.com/rss/search");
    endpoint.searchParams.set("q", `${context.upstream} ${context.macro} ${MARKET_CONFIG[key].newsName}`);
    endpoint.searchParams.set("hl", key === "CN" ? "zh-CN" : key === "US" ? "en-US" : "en-AU");
    endpoint.searchParams.set("gl", key === "CN" ? "CN" : key === "US" ? "US" : "AU");
    endpoint.searchParams.set("ceid", key === "CN" ? "CN:zh-Hans" : key === "US" ? "US:en" : "AU:en");
    const xml = await fetchText(endpoint, 3500);
    items = rssRows(xml, "sector-factor").slice(0, 10);
  } catch {
    const news = await fetchNewsItems(symbol, key);
    items = (news.news || []).filter((item) => /sector|upstream|peer|competitor/.test(item.channel || "")).slice(0, 10);
    source = "multi-news-sector-fallback";
  }
  const signal = newsSignal(items, code, key);
  return {
    available: items.length > 0,
    source,
    score: Math.max(-12, Math.min(12, signal.score)),
    thesis: items.length ? [`Sector/upstream factor checked ${items.length} items; stance ${signal.stance}.`] : ["Sector factor returned no items."],
    items,
  };
}

async function fetchYahooCandles(symbol, range = "3mo", interval = "1d") {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplits`;
  const payload = await fetchJson(endpoint, 3500);
  return yahooCandlesToRows(payload);
}

async function fetchRelativeStrengthFactor(symbol, candles, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const [benchmark, ...peers] = await Promise.allSettled([
    fetchMarketCandles(MARKET_CONFIG[key].benchmark, "3mo", "1d", key).then((marketData) => marketData.candles),
    ...peerCodesFor(code, key).slice(0, 3).map((peer) => fetchMarketCandles(peer, "3mo", "1d", key).then((market) => market.candles)),
  ]);
  const symbol20 = pctReturn(candles, 20);
  const hasBenchmark = benchmark.status === "fulfilled";
  const benchmark20 = hasBenchmark ? pctReturn(benchmark.value, 20) : null;
  const peerReturns = peers.filter((result) => result.status === "fulfilled").map((result) => pctReturn(result.value, 20));
  const peerAvg = peerReturns.length ? peerReturns.reduce((sum, value) => sum + value, 0) / peerReturns.length : 0;
  const relativeToIndex = hasBenchmark ? symbol20 - benchmark20 : null;
  const relativeToPeers = peerReturns.length ? symbol20 - peerAvg : 0;
  const scoreInput = (relativeToIndex == null ? 0 : relativeToIndex * 0.7) + (peerReturns.length ? relativeToPeers * 0.5 : 0);
  const score = Math.max(-12, Math.min(12, scoreInput));
  return {
    available: hasBenchmark || peerReturns.length > 0,
    source: key === "CN" ? "cn-benchmark-and-peer-market-data" : key === "ASX" ? "asx-stw-benchmark-and-peer-market-data" : "yahoo-benchmark-and-peer-market-data",
    score,
    thesis: [`20d return ${symbol20.toFixed(2)}%, ${relativeToIndex == null ? "benchmark unavailable" : `vs benchmark ${relativeToIndex.toFixed(2)}%`}, ${peerReturns.length ? `vs peers ${relativeToPeers.toFixed(2)}%` : "peers unavailable"}.`],
    values: { symbol20, benchmark20, peerAvg, relativeToIndex, relativeToPeers },
  };
}

function liquidityFactor(candles) {
  const rows = (candles || []).slice(-25);
  if (rows.length < 10) return { available: false, source: "daily-candles", score: 0, thesis: ["Not enough candles for liquidity factor."] };
  const latest = rows.at(-1);
  const avgDollarVolume = rows.slice(-20).reduce((sum, row) => sum + Number(row.close || 0) * Number(row.volume || 0), 0) / Math.min(20, rows.length);
  const avgRangePct = rows.slice(-20).reduce((sum, row) => sum + ((Number(row.high || 0) - Number(row.low || 0)) / Math.max(0.01, Number(row.close || 0)) * 100), 0) / Math.min(20, rows.length);
  const volumeRatio = Number(latest.volume || 0) / Math.max(1, rows.slice(-20).reduce((sum, row) => sum + Number(row.volume || 0), 0) / Math.min(20, rows.length));
  let score = 0;
  if (avgDollarVolume > 50_000_000) score += 4;
  else if (avgDollarVolume < 5_000_000) score -= 5;
  if (avgRangePct > 4) score -= 3;
  if (volumeRatio > 1.4) score += 3;
  return {
    available: true,
    source: "daily-price-volume-proxy",
    score: Math.max(-10, Math.min(10, score)),
    thesis: [`Avg dollar volume A$${(avgDollarVolume / 1_000_000).toFixed(1)}m, avg range ${avgRangePct.toFixed(2)}%, latest volume ratio ${volumeRatio.toFixed(2)}x.`],
    values: { avgDollarVolume, avgRangePct, volumeRatio },
  };
}

function strategyOutcomeWindow(rows, index, horizon = 15, targetUpside = 5, stopLoss = 4) {
  const entryIndex = index + 1;
  const entryRow = rows[entryIndex];
  const entry = Number(entryRow?.vwap || entryRow?.open || entryRow?.close || 0);
  const endIndex = Math.min(rows.length - 1, entryIndex + Math.max(1, Number(horizon || 15)) - 1);
  if (!entry || !entryRow || entryIndex > endIndex) return { targetWins: false, stopWins: false, forwardReturn: 0, maxUpside: 0, maxDrawdown: 0 };
  const target = Math.max(0.5, Number(targetUpside || 5));
  const stop = Math.max(0.8, Math.abs(Number(stopLoss || 4)));
  let maxHigh = entry;
  let minLow = entry;
  let firstEvent = null;
  for (let offset = entryIndex; offset <= endIndex; offset += 1) {
    const row = rows[offset];
    const highReturn = pctChange(row.high || row.close, entry);
    const lowReturn = pctChange(row.low || row.close, entry);
    maxHigh = Math.max(maxHigh, Number(row.high || row.close));
    minLow = Math.min(minLow, Number(row.low || row.close));
    if (!firstEvent && highReturn >= target) firstEvent = "target";
    if (!firstEvent && lowReturn <= -stop) firstEvent = "stop";
  }
  const maxUpside = pctChange(maxHigh, entry);
  const maxDrawdown = pctChange(minLow, entry);
  const hitTarget = maxUpside >= target;
  const hitStop = maxDrawdown <= -stop;
  return {
    targetWins: hitTarget && (!hitStop || firstEvent === "target"),
    stopWins: hitStop && (!hitTarget || firstEvent === "stop"),
    forwardReturn: pctChange(rows[endIndex].close, entry),
    maxUpside,
    maxDrawdown,
    signalDate: rows[index]?.date || null,
    entryDate: entryRow.date || null,
    entryPrice: entry,
    entrySource: Number(entryRow.vwap || 0) > 0 ? "next_session_vwap" : "next_session_open",
  };
}

function calibrationFactor(candles, horizon = 15, targetUpside = 5, stopLoss = 4) {
  const rows = sanitizeCandleRows(candles);
  if (rows.length < 90 + horizon) return { available: false, source: "walk-forward-local", score: 0, thesis: ["Not enough history for walk-forward calibration."] };
  let samples = 0;
  let hits = 0;
  let falseSignals = 0;
  let stopFirst = 0;
  const returns = [];
  for (let index = 55; index < rows.length - horizon - 1; index += 2) {
    const ret20 = pctReturn(rows.slice(0, index + 1), 20);
    const ret5 = pctReturn(rows.slice(0, index + 1), 5);
    const signal = ret20 > 1.5;
    if (signal) {
      const outcome = strategyOutcomeWindow(rows, index, horizon, targetUpside, stopLoss);
      samples += 1;
      returns.push(outcome.forwardReturn);
      if (outcome.targetWins) hits += 1;
      else if (outcome.stopWins) {
        falseSignals += 1;
        stopFirst += 1;
      }
      else falseSignals += 1;
      if (ret5 > targetUpside * 0.8 && outcome.stopWins) stopFirst += 0.5;
    }
  }
  const hitRate = samples ? hits / samples * 100 : 0;
  const stopRate = samples ? stopFirst / samples * 100 : 0;
  const avgReturn = mean(returns) ?? 0;
  const score = samples ? Math.max(-10, Math.min(10, (hitRate - 52) / 4 + avgReturn * 0.18 - stopRate * 0.035)) : 0;
  return {
    available: samples > 5,
    source: "walk-forward-local-calibration",
    score,
    thesis: samples > 5 ? [`Walk-forward calibration: ${hits}/${samples} comparable momentum signals reached +${targetUpside}% before stop-loss within ${horizon} days; hit rate ${hitRate.toFixed(0)}%, stop-first ${stopRate.toFixed(0)}%, avg return ${avgReturn.toFixed(2)}%.`] : ["Too few comparable signals for calibration."],
    values: { samples, hits, falseSignals, hitRate, stopRate, avgReturn },
  };
}

async function historicalBacktestForCandles({ market, symbol, candles, strategy = {}, source = "" }) {
  const key = safeMarket(market);
  const code = normalizeMarketSymbol(symbol, key);
  const horizonDays = Number(strategy.horizonDays || 15);
  const targetUpside = Number(strategy.targetUpside || 5);
  const stopLoss = Number(strategy.stopLoss || 4);
  const cacheKey = `${key}:${code}:${candles?.length || 0}:${candles?.at?.(-1)?.date || ""}:${horizonDays}:${targetUpside}:${stopLoss}`;
  const cached = historicalBacktestCache.get(cacheKey);
  if (cached && Date.now() - cached.time < Number(process.env.HISTORICAL_BACKTEST_CACHE_TTL_MS || 30 * 60 * 1000)) return cached.value;
  const result = await runPythonQuantCore("historical-backtest", {
    market: key,
    symbol: code,
    candles: sanitizeCandleRows(candles || []),
    horizon_days: horizonDays,
    target_upside: targetUpside,
    stop_loss: stopLoss,
    min_train: Number(process.env.HISTORICAL_BACKTEST_MIN_TRAIN || 120),
    step: Number(process.env.HISTORICAL_BACKTEST_STEP || 5),
    step_schedule: numberListEnv(process.env.HISTORICAL_BACKTEST_STEP_SCHEDULE, [Number(process.env.HISTORICAL_BACKTEST_STEP || 5)]),
    max_step_offsets: Number(process.env.HISTORICAL_BACKTEST_MAX_STEP_OFFSETS || 2),
    max_predictions: Number(process.env.HISTORICAL_BACKTEST_MAX_PREDICTIONS || 2200),
    retrain_interval: Number(process.env.HISTORICAL_BACKTEST_RETRAIN_INTERVAL || 60),
    max_train_window: Number(process.env.HISTORICAL_BACKTEST_TRAIN_WINDOW || 240),
    knn_window: Number(process.env.HISTORICAL_BACKTEST_KNN_WINDOW || 260),
    adaptive_labels: true,
    transaction_cost_bps: Number(process.env[`TRANSACTION_COST_BPS_${key}`] || process.env.TRANSACTION_COST_BPS || ({ US: 12, ASX: 18, CN: 20 }[key] || 18)),
  }, Number(process.env.HISTORICAL_BACKTEST_TIMEOUT_MS || 18000));
  const value = {
    ...result,
    market: key,
    symbol: code,
    marketSource: source || result.source || "historical-market-data",
  };
  historicalBacktestCache.set(cacheKey, { time: Date.now(), value });
  if (historicalBacktestCache.size > 120) historicalBacktestCache.delete(historicalBacktestCache.keys().next().value);
  return value;
}

function historicalBacktestFactor(result) {
  if (!result?.available) {
    return {
      available: false,
      source: "historical-walk-forward-unavailable",
      score: 0,
      thesis: [result?.reason || "Historical walk-forward backtest did not have enough real candles."],
      values: { samples: 0, hitRate: 0, stopRate: 0, avgReturn: 0 },
    };
  }
  const values = result.values || {};
  const samples = Number(values.samples || result.metrics?.buySignals || result.metrics?.samples || 0);
  const predictionCuts = Number(result.dataDepth?.predictionCuts || result.metrics?.samples || samples || 0);
  const hitRate = Number(values.hitRate ?? result.metrics?.targetHitRate ?? 0);
  const stopRate = Number(values.stopRate ?? result.metrics?.stopRate ?? 0);
  const avgReturn = Number(values.avgReturn ?? result.metrics?.avgForwardReturn ?? 0);
  const brier = Number(values.brierTarget ?? result.metrics?.brierTarget ?? 0);
  const dataQuality = result.dataQuality || {};
  const dataQualityScore = Number(dataQuality.avgScore || 0);
  const labelConfidence = Number(result.metrics?.avgLabelConfidence || 0);
  const labelNoiseScore = Number(result.metrics?.avgLabelNoiseScore ?? values.avgLabelNoiseScore ?? 0);
  const highNoisePct = Number(result.metrics?.highNoiseSamplePct ?? values.highNoiseSamplePct ?? 0);
  const ambiguousBarrierPct = Number(result.metrics?.ambiguousBarrierPct ?? values.ambiguousBarrierPct ?? 0);
  const qualityPenalty = dataQualityScore > 0 ? Math.max(0, 78 - dataQualityScore) * 0.05 : 0;
  const labelNoisePenalty = Math.max(0, labelNoiseScore - 42) * 0.035 + Math.max(0, highNoisePct - 18) * 0.025 + Math.max(0, ambiguousBarrierPct - 4) * 0.04;
  const coverageScore = Number(result.metrics?.avgCoverageScore ?? values.avgCoverageScore ?? 100);
  const coveragePenalty = Math.max(0, 55 - coverageScore) * 0.055;
  const regimeCalibration = result.regimeCalibration || {};
  const matchedRegime = regimeCalibration.matchedBucket || regimeCalibration.matchedCurrentRegime || {};
  const regimeSamples = Number(matchedRegime.effectiveSamples || matchedRegime.count || 0);
  const regimeTargetHit = Number(matchedRegime.targetHitRate || 0);
  const regimeStopRate = Number(matchedRegime.stopRate || 0);
  const regimeAvgReturn = Number(matchedRegime.avgReturn || 0);
  const regimePenalty = regimeSamples >= 8
    ? Math.max(0, 50 - regimeTargetHit) * 0.045 + Math.max(0, regimeStopRate - 48) * 0.035 + Math.max(0, -regimeAvgReturn) * 0.18
    : 0.45;
  const conformalCalibration = result.conformalCalibration || {};
  const conformalOverall = conformalCalibration.overall || conformalCalibration.currentRegimeSummary || {};
  const conformalCurrent = conformalCalibration.currentRegimeSummary || conformalOverall;
  const finalP80Error = Number(conformalCurrent.finalReturnAbsErrorP80 ?? conformalOverall.finalReturnAbsErrorP80 ?? values.currentRegimeP80Error ?? values.finalReturnP80Error ?? 0);
  const finalP90Error = Number(conformalCurrent.finalReturnAbsErrorP90 ?? conformalOverall.finalReturnAbsErrorP90 ?? values.finalReturnP90Error ?? 0);
  const conformalPenalty = finalP80Error > 0
    ? Math.max(0, finalP80Error - 2.4) * 0.22 + Math.max(0, finalP90Error - 4.2) * 0.12
    : 0.2;
  const statisticalReliability = result.statisticalReliability || {};
  const reliabilityTarget = statisticalReliability.target || {};
  const reliabilityStop = statisticalReliability.stop || {};
  const reliabilityDirection = statisticalReliability.direction || {};
  const reliabilityScore = Number(statisticalReliability.score ?? values.statisticalReliabilityScore ?? 0);
  const targetLowerBound = Number(reliabilityTarget.lowerBound ?? values.targetHitLowerBound ?? 0);
  const stopUpperBound = Number(reliabilityStop.upperBound ?? values.stopRateUpperBound ?? 100);
  const directionLowerBound = Number(reliabilityDirection.lowerBound ?? values.directionHitLowerBound ?? 0);
  const effectiveIndependentSamples = Number(reliabilityTarget.effectiveSamples ?? values.effectiveIndependentSamples ?? 0);
  const statisticalPenalty = statisticalReliability.available
    ? Math.max(0, 55 - targetLowerBound) * 0.05
      + Math.max(0, stopUpperBound - 54) * 0.04
      + Math.max(0, 52 - directionLowerBound) * 0.035
      + Math.max(0, 12 - effectiveIndependentSamples) * 0.08
    : 0.35;
  const predictionCalibration = result.predictionCalibration || {};
  const predictionDirection = Number(predictionCalibration.test?.directionHitRate || 0);
  const predictionLift = Number(predictionCalibration.directionLiftPct || 0);
  const predictionActive = !!predictionCalibration.active;
  const stability = predictionCalibration.stability || {};
  const stabilityScore = Number(stability.stabilityScore || 0);
  const stabilityPassed = Boolean(stability.pass);
  const predictionScore = predictionCalibration.available
    ? clampNumber(
      (predictionDirection - 50) / 3.6
        + predictionLift * 0.12
        + (predictionActive ? 1.2 : -0.6)
        + (stability.available ? (stabilityPassed ? 0.75 : -0.9) : -0.25),
      -4,
      4,
    )
    : 0;
  const score = clampNumber((hitRate - 52) / 3.2 + avgReturn * 0.28 - stopRate * 0.04 - Math.max(0, brier - 0.25) * 10 + predictionScore - qualityPenalty - labelNoisePenalty - coveragePenalty - regimePenalty - conformalPenalty - statisticalPenalty, -12, 12);
  return {
    available: predictionCuts >= 12,
    source: "historical-walk-forward-backtest",
    score,
    thesis: [
      ...(result.thesis || [
        `Historical walk-forward: ${samples} point-in-time cuts, target-hit ${hitRate.toFixed(0)}%, stop-first ${stopRate.toFixed(0)}%, avg return ${avgReturn.toFixed(2)}%.`,
      ]),
      predictionCalibration.available
        ? `Prediction-weight calibration: ${predictionCalibration.horizonLabel || ""}${predictionCalibration.horizonDays || ""}d ${predictionCalibration.status || "research"}; holdout direction ${predictionDirection.toFixed(0)}%, lift ${predictionLift.toFixed(1)}pct.`
        : "Prediction-weight calibration is still collecting historical cuts.",
      stability.available
        ? `Weight stability gate: ${stability.status || "unknown"} score ${stabilityScore.toFixed(0)}, rolling-fold direction lift ${Number(stability.avgDirectionLiftPct || 0).toFixed(1)}pct, weight drift ${Number(stability.weightDrift || 0).toFixed(2)}.`
        : "Weight stability gate is collecting multi-fold evidence.",
      dataQualityScore
        ? `Data-quality gate: ${dataQuality.grade || "batch"} score ${dataQualityScore.toFixed(1)}, degraded rows ${Number(dataQuality.degradedRowPct || 0).toFixed(1)}%, label confidence ${labelConfidence ? (labelConfidence * 100).toFixed(0) + "%" : "collecting"}.`
        : "Data-quality gate is collecting candle quality evidence.",
      `Label-noise gate: path-noise ${labelNoiseScore.toFixed(0)}/100, high-noise cuts ${highNoisePct.toFixed(1)}%, same-bar target/stop ambiguity ${ambiguousBarrierPct.toFixed(1)}%; noisy labels cannot lift historical confidence.`,
      `Sample coverage gate: average coverage ${coverageScore.toFixed(0)}/100, low-coverage cuts ${Number(result.metrics?.lowCoverageSamplePct || 0).toFixed(1)}%; OOD-like setups are down-weighted.`,
      regimeCalibration.framework
        ? `Regime bucket calibration: current ${regimeCalibration.current?.label || regimeCalibration.framework}, matched samples ${regimeSamples.toFixed(1)}, target-hit ${regimeTargetHit.toFixed(0)}%, stop-first ${regimeStopRate.toFixed(0)}%, avg return ${regimeAvgReturn.toFixed(2)}%.`
        : "Regime bucket calibration is collecting point-in-time market-state evidence.",
      conformalCalibration.framework
        ? `Conformal residual calibration: final-return P80 error ±${finalP80Error.toFixed(2)}%, P90 ±${finalP90Error.toFixed(2)}%; wide residual bands reduce high-confidence magnitude labels.`
        : "Conformal residual calibration is collecting historical prediction errors.",
      statisticalReliability.framework
        ? `Statistical reliability: ${statisticalReliability.status || "unknown"} score ${reliabilityScore.toFixed(0)}/100, target-hit lower ${targetLowerBound.toFixed(1)}%, stop upper ${stopUpperBound.toFixed(1)}%, effective independent samples ${effectiveIndependentSamples.toFixed(1)}.`
        : "Statistical reliability interval is collecting enough weighted samples.",
    ],
    values: {
      ...values,
      samples,
      hitRate,
      stopRate,
      avgReturn,
      directionHitRate: Number(values.directionHitRate ?? result.metrics?.directionHitRate ?? 0),
      brierTarget: Number(values.brierTarget ?? result.metrics?.brierTarget ?? 0),
      candleCount: result.candleCount,
      trainSamplesMedian: result.dataDepth?.trainSamplesMedian || 0,
      predictionCuts,
      buySignals: result.metrics?.buySignals || 0,
      predictionCalibrationActive: predictionActive,
      predictionCalibrationDirectionHitRate: predictionDirection,
      predictionCalibrationLiftPct: predictionLift,
      weightStabilityScore: stabilityScore,
      weightStabilityPassed: stabilityPassed,
      dataQualityScore,
      avgLabelConfidence: labelConfidence,
      avgLabelNoiseScore: labelNoiseScore,
      highNoiseSamplePct: highNoisePct,
      ambiguousBarrierPct,
      degradedRowPct: Number(dataQuality.degradedRowPct || 0),
      avgCoverageScore: coverageScore,
      lowCoverageSamplePct: Number(result.metrics?.lowCoverageSamplePct || 0),
      currentRegime: regimeCalibration.current?.bucket || values.currentRegime || null,
      currentRegimeTargetHitRate: regimeTargetHit || Number(values.currentRegimeTargetHitRate || 0),
      currentRegimeStopRate: regimeStopRate || Number(values.currentRegimeStopRate || 0),
      currentRegimeAvgReturn: regimeAvgReturn || Number(values.currentRegimeAvgReturn || 0),
      finalReturnP80Error: finalP80Error,
      finalReturnP90Error: finalP90Error,
      conformalUncertaintyScore: Number(conformalCurrent.uncertaintyScore ?? conformalOverall.uncertaintyScore ?? 0),
      statisticalReliabilityScore: reliabilityScore,
      targetHitLowerBound: targetLowerBound,
      stopRateUpperBound: stopUpperBound,
      directionHitLowerBound: directionLowerBound,
      effectiveIndependentSamples,
    },
    backtest: {
      framework: result.framework,
      dataDepth: result.dataDepth,
      metrics: result.metrics,
      benchmarks: result.benchmarks,
      model: result.model,
      dateRange: result.dateRange,
      dataQuality,
      predictionCalibration,
      regimeCalibration,
      conformalCalibration,
      statisticalReliability,
    },
  };
}

function numberListEnv(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  const rows = String(value || "").split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item > 0);
  return rows.length ? rows : fallback;
}

async function fetchBacktestCandlesForSymbol(symbol, market, range = "5y") {
  const key = safeMarket(market);
  const code = normalizeMarketSymbol(symbol, key);
  try {
    const data = await fetchMarketCandles(code, range, "1d", key);
    return { symbol: code, market: key, candles: data.candles || [], source: data.source || "market-data", warning: data.warning || "" };
  } catch (marketError) {
    const fallback = await fetchSnapshotMarketCandles(code, range, "1d", key, marketError)
      || await fetchCachedMarketHistory(code, range, "1d", key, marketError);
    if (fallback?.candles?.length) {
      return { symbol: code, market: key, candles: fallback.candles, source: fallback.source || "snapshot-or-cache", warning: fallback.warning || marketError.message };
    }
    return { symbol: code, market: key, candles: [], source: "unavailable", warning: marketError.message || String(marketError), error: marketError.message || String(marketError) };
  }
}

async function crossSectionalFactorResearchForItems({ market = "ASX", items = [], horizons = [5, 15, 30] } = {}) {
  const key = safeMarket(market);
  const usableItems = (items || [])
    .filter((item) => item?.candles?.length)
    .map((item) => {
      const code = normalizeMarketSymbol(item.symbol || "", key);
      const context = sectorContext(code, key);
      return {
        market: key,
        symbol: code,
        sector: item.sector || context.sector || "Unknown",
        source: item.source || "",
        candles: sanitizeCandleRows(item.candles || []),
      };
    })
    .filter((item) => item.symbol && item.candles.length);
  if (usableItems.length < 3) {
    return {
      available: false,
      framework: "market-cross-sectional-factor-research",
      market: key,
      reason: "Need at least three symbols with real historical candles for cross-sectional factor research.",
      symbolCount: usableItems.length,
    };
  }
  const result = await runPythonQuantCore("cross-sectional-factor-research", {
    market: key,
    items: usableItems,
    horizons,
    min_symbols: Number(process.env.CROSS_SECTION_MIN_SYMBOLS || Math.min(6, Math.max(3, Math.floor(usableItems.length * 0.45)))),
  }, Number(process.env.CROSS_SECTION_FACTOR_TIMEOUT_MS || 90000));
  const saved = await writeCrossSectionalFactorModelSnapshot(key, result).catch(() => null);
  if (saved) {
    await appendModelChangeLogFile(key, {
      event_type: "model-change-log-cross-sectional-factor-research",
      entity_id: `${key}:cross-sectional-factor:${saved.savedAt}`,
      payload: {
        title: "市场级横截面因子权重已更新",
        type: "cross-sectional-factor-research",
        market: key,
        framework: saved.framework,
        symbolCount: saved.symbolCount,
        horizons: saved.horizons,
        aggregateWeights: saved.aggregateWeights,
        leakageControl: saved.leakageControl,
      },
    }).catch(() => null);
  }
  return { ...result, savedModel: saved };
}

async function historicalBacktestBatch({ market = "ASX", symbols = [], strategy = {}, range = "", limit, largeSample = true, productionTraining = false } = {}) {
  const key = safeMarket(market);
  const resolvedRange = range || process.env[`HISTORICAL_BACKTEST_RANGE_${key}`] || process.env.HISTORICAL_BACKTEST_RANGE || ({ US: "10y", ASX: "10y", CN: "8y" }[key] || "10y");
  const trainingUniverse = await expandTrainingSymbolsForMarket({ market: key, symbols, limit, largeSample });
  const uniqueSymbols = trainingUniverse.trainingSymbols;
  const concurrency = Math.max(1, Math.min(5, Number(process.env.HISTORICAL_BACKTEST_FETCH_CONCURRENCY || 4)));
  const items = [];
  let cursor = 0;
  async function worker() {
    while (cursor < uniqueSymbols.length) {
      const current = uniqueSymbols[cursor];
      cursor += 1;
      const item = await fetchBacktestCandlesForSymbol(current, key, resolvedRange);
      items.push(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueSymbols.length) }, () => worker()));
  const strategyHorizon = Math.max(1, Number(strategy.horizonDays || 15));
  const horizons = [...new Set([
    5,
    strategyHorizon,
    Math.max(30, strategyHorizon >= 25 ? strategyHorizon : 30),
  ].map((value) => Math.max(1, Math.round(Number(value || 15)))))].slice(0, 4);
  const defaultStep = Number(process.env.HISTORICAL_BACKTEST_BATCH_STEP || process.env.HISTORICAL_BACKTEST_STEP || 4);
  const stepSchedule = numberListEnv(process.env.HISTORICAL_BACKTEST_BATCH_STEP_SCHEDULE || process.env.HISTORICAL_BACKTEST_STEP_SCHEDULE, [2, 3, 5, Math.max(1, defaultStep)]);
  const result = await runPythonQuantCore("historical-backtest-batch", {
    market: key,
    items,
    horizon_days: strategyHorizon,
    horizons,
    target_upside: Number(strategy.targetUpside || 5),
    stop_loss: Number(strategy.stopLoss || 4),
    min_train: Number(process.env.HISTORICAL_BACKTEST_MIN_TRAIN || 120),
    step: defaultStep,
    step_schedule: stepSchedule,
    max_step_offsets: Number(process.env.HISTORICAL_BACKTEST_BATCH_MAX_STEP_OFFSETS || process.env.HISTORICAL_BACKTEST_MAX_STEP_OFFSETS || 2),
    max_predictions: Number(process.env.HISTORICAL_BACKTEST_MAX_PREDICTIONS || 1400),
    retrain_interval: Number(process.env.HISTORICAL_BACKTEST_RETRAIN_INTERVAL || 60),
    max_train_window: Number(process.env.HISTORICAL_BACKTEST_TRAIN_WINDOW || 240),
    knn_window: Number(process.env.HISTORICAL_BACKTEST_KNN_WINDOW || 260),
    adaptive_labels: true,
    transaction_cost_bps: Number(process.env[`TRANSACTION_COST_BPS_${key}`] || process.env.TRANSACTION_COST_BPS || ({ US: 12, ASX: 18, CN: 20 }[key] || 18)),
    production_training: productionTraining === true,
    production_fold_count: Number(process.env.PRODUCTION_MODEL_FOLD_COUNT || 5),
    production_embargo_days: Number(process.env.PRODUCTION_MODEL_EMBARGO_DAYS || 7),
    production_min_train_dates: Number(process.env.PRODUCTION_MODEL_MIN_TRAIN_DATES || 500),
    production_test_dates: Number(process.env.PRODUCTION_MODEL_TEST_DATES || 120),
    enable_tree_models: process.env.PRODUCTION_MODEL_TREE_ENABLED !== "false",
    max_model_weight: Number(process.env.PRODUCTION_MODEL_MAX_WEIGHT || 0.35),
    max_residual_correlation: Number(process.env.PRODUCTION_MODEL_MAX_RESIDUAL_CORRELATION || 0.8),
    artifact_dir: join(snapshotBasePath, "models", "oof", key.toLowerCase()),
  }, Number(productionTraining
    ? process.env.PRODUCTION_MODEL_TIMEOUT_MS || 15 * 60 * 1000
    : process.env.HISTORICAL_BACKTEST_BATCH_TIMEOUT_MS || 180000));
  const crossSectionalFactorResearch = process.env.CROSS_SECTION_FACTOR_RESEARCH === "false"
    ? { available: false, framework: "market-cross-sectional-factor-research", reason: "Disabled by CROSS_SECTION_FACTOR_RESEARCH=false." }
    : await crossSectionalFactorResearchForItems({ market: key, items, horizons }).catch((error) => ({
      available: false,
      framework: "market-cross-sectional-factor-research",
      reason: error.message || String(error),
    }));
  const finalResult = {
    ...result,
    range: resolvedRange,
    horizons,
    crossSectionalFactorResearch,
    requestedSymbols: trainingUniverse.requestedSymbols,
    trainingSymbols: uniqueSymbols,
    trainingUniverse,
    dataSources: items.map((item) => ({
      symbol: item.symbol,
      source: item.source,
      candles: item.candles?.length || 0,
      warning: item.warning || item.error || "",
    })),
    generatedAt: new Date().toISOString(),
  };
  const productionModelRegistry = await writeProductionModelVersionSnapshot(key, finalResult.productionTraining).catch(() => null);
  if (productionModelRegistry) finalResult.productionModelRegistry = productionModelRegistry;
  const savedModel = await writePredictionWeightModelSnapshot(key, finalResult).catch(() => null);
  if (savedModel) {
    await appendModelChangeLogFile(key, {
      event_type: "model-change-log-prediction-weight-calibration",
      entity_id: `${key}:prediction-weight:${savedModel.savedAt}`,
      payload: {
        title: "历史预测权重校准已更新",
        type: "prediction-weight-calibration",
        market: key,
        sampleTotal: savedModel.sampleTotal,
        symbolCount: savedModel.symbolCount,
        horizonCalibrations: savedModel.horizonCalibrations,
        leakageControl: savedModel.leakageControl,
        productionModel: productionModelRegistry,
        productionEligibility: savedModel.productionEligibility,
      },
    }).catch(() => null);
  }
  return { ...finalResult, savedModel };
}

const factorEvolutionScheduler = {
  running: false,
  activeMode: "",
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: "",
  lastResult: null,
};

function factorEvolutionConfig() {
  const markets = envList("FACTOR_EVOLUTION_MARKETS").length
    ? envList("FACTOR_EVOLUTION_MARKETS").map(safeMarket)
    : ["ASX", "US", "CN"];
  return {
    enabled: process.env.FACTOR_EVOLUTION_AUTO_ENABLED !== "false",
    markets: [...new Set(markets)],
    lightIntervalMs: Math.max(30 * 60 * 1000, Number(process.env.FACTOR_EVOLUTION_LIGHT_INTERVAL_HOURS || 12) * 60 * 60 * 1000),
    heavyIntervalMs: Math.max(24 * 60 * 60 * 1000, Number(process.env.FACTOR_EVOLUTION_HEAVY_INTERVAL_HOURS || 168) * 60 * 60 * 1000),
    lightSymbolLimit: Math.max(1, Math.min(40, Number(process.env.FACTOR_EVOLUTION_LIGHT_SYMBOL_LIMIT || 12))),
    heavySymbolLimit: Math.max(3, Math.min(180, Number(process.env.FACTOR_EVOLUTION_HEAVY_SYMBOL_LIMIT || process.env.HISTORICAL_BACKTEST_LARGE_SAMPLE_LIMIT || 80))),
    range: process.env.FACTOR_EVOLUTION_RANGE || "5y",
    horizonDays: Math.max(1, Math.min(60, Number(process.env.FACTOR_EVOLUTION_HORIZON_DAYS || 15))),
    targetUpside: Number(process.env.FACTOR_EVOLUTION_TARGET_UPSIDE || 5),
    stopLoss: Number(process.env.FACTOR_EVOLUTION_STOP_LOSS || 4),
    lightGenerations: Math.max(1, Math.min(12, Number(process.env.FACTOR_EVOLUTION_LIGHT_GENERATIONS || 6))),
    lightPopulation: Math.max(8, Math.min(80, Number(process.env.FACTOR_EVOLUTION_LIGHT_POPULATION || 36))),
    checkIntervalMs: Math.max(60 * 1000, Number(process.env.FACTOR_EVOLUTION_CHECK_INTERVAL_MS || 10 * 60 * 1000)),
    startupDelayMs: Math.max(0, Number(process.env.FACTOR_EVOLUTION_STARTUP_DELAY_MS || 90 * 1000)),
  };
}

async function readFactorEvolutionSchedulerState() {
  try {
    const payload = JSON.parse(await readFile(factorEvolutionSchedulerPath(), "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

async function writeFactorEvolutionSchedulerState(patch = {}) {
  await mkdir(join(snapshotBasePath, "models", "factor-research"), { recursive: true });
  const previous = await readFactorEvolutionSchedulerState();
  const payload = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(factorEvolutionSchedulerPath(), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function isFactorEvolutionDue(state = {}, key = "light", intervalMs = 12 * 60 * 60 * 1000, options = {}) {
  const last = new Date(state?.[`${key}LastFinishedAt`] || state?.[`${key}LastStartedAt`] || 0).getTime();
  if (!last && options.requirePreviousRun) return false;
  return !last || Date.now() - last >= intervalMs;
}

async function runAlphaEvolutionForSymbol({ market, symbol, range, horizonDays, generations, population, mode }) {
  const key = safeMarket(market);
  const code = normalizeMarketSymbol(symbol, key);
  const marketData = await fetchBacktestCandlesForSymbol(code, key, range);
  if (!marketData.candles?.length) {
    return {
      symbol: code,
      available: false,
      reason: marketData.warning || marketData.error || "No real candles returned.",
    };
  }
  const result = await runPythonQuantCore("alpha-evolution", {
    market: key,
    symbol: code,
    candles: sanitizeCandleRows(marketData.candles || []),
    horizon_days: horizonDays,
    generations,
    population,
  }, Number(process.env.FACTOR_EVOLUTION_TIMEOUT_MS || 32000));
  const saved = await writeAlphaEvolutionModelSnapshot(key, code, result, {
    mode,
    range,
    horizonDays,
    generations,
    population,
  }).catch(() => null);
  if (saved) {
    await appendModelChangeLogFile(key, {
      event_type: "model-change-log-alpha-evolution",
      entity_id: `${key}:${code}:alpha-evolution:${saved.savedAt}`,
      payload: {
        title: "自进化 Alpha 候选已更新",
        type: "alpha-evolution",
        mode,
        market: key,
        symbol: code,
        framework: saved.framework,
        sampleCount: saved.sampleCount,
        generations,
        population,
        topCandidate: saved.bestCandidates?.[0]?.name || "",
        topFitness: saved.bestCandidates?.[0]?.fitness ?? null,
        leakageControl: saved.leakageControl,
      },
    }).catch(() => null);
  }
  return {
    symbol: code,
    available: true,
    source: marketData.source,
    candles: marketData.candles.length,
    savedAt: saved?.savedAt || null,
    topCandidate: saved?.bestCandidates?.[0]?.name || result.best_candidates?.[0]?.name || "",
    topFitness: saved?.bestCandidates?.[0]?.fitness ?? result.best_candidates?.[0]?.fitness ?? null,
  };
}

async function runFactorEvolutionCycle(mode = "light", options = {}) {
  const config = factorEvolutionConfig();
  if (factorEvolutionScheduler.running) {
    return {
      accepted: false,
      running: true,
      activeMode: factorEvolutionScheduler.activeMode,
      reason: "Factor evolution is already running.",
    };
  }
  const runMode = mode === "heavy" ? "heavy" : "light";
  factorEvolutionScheduler.running = true;
  factorEvolutionScheduler.activeMode = runMode;
  factorEvolutionScheduler.lastStartedAt = new Date().toISOString();
  factorEvolutionScheduler.lastError = "";
  await writeFactorEvolutionSchedulerState({
    [`${runMode}LastStartedAt`]: factorEvolutionScheduler.lastStartedAt,
    runningMode: runMode,
  }).catch(() => null);
  try {
    const marketResults = [];
    if (runMode === "heavy") {
      for (const market of config.markets) {
        const result = await historicalBacktestBatch({
          market,
          symbols: [],
          strategy: {
            horizonDays: config.horizonDays,
            targetUpside: config.targetUpside,
            stopLoss: config.stopLoss,
          },
          range: config.range,
          limit: Number(options.limit || config.heavySymbolLimit),
          largeSample: true,
        });
        marketResults.push({
          market,
          mode: runMode,
          symbolCount: result.symbolCount,
          availableCount: result.availableCount,
          sampleTotal: result.sampleTotal,
          crossSectionalAvailable: result.crossSectionalFactorResearch?.available !== false,
        });
      }
    } else {
      for (const market of config.markets) {
        const trainingUniverse = await expandTrainingSymbolsForMarket({
          market,
          symbols: [],
          limit: Number(options.limit || config.lightSymbolLimit),
          largeSample: true,
        });
        const symbolResults = [];
        for (const symbol of trainingUniverse.trainingSymbols) {
          try {
            symbolResults.push(await runAlphaEvolutionForSymbol({
              market,
              symbol,
              range: config.range,
              horizonDays: config.horizonDays,
              generations: Number(options.generations || config.lightGenerations),
              population: Number(options.population || config.lightPopulation),
              mode: runMode,
            }));
          } catch (error) {
            symbolResults.push({
              symbol,
              available: false,
              reason: String(error.message || error).slice(0, 280),
            });
          }
        }
        marketResults.push({
          market,
          mode: runMode,
          trainingSymbols: trainingUniverse.trainingSymbols,
          sourceCounts: trainingUniverse.sourceCounts,
          availableCount: symbolResults.filter((row) => row.available).length,
          failedCount: symbolResults.filter((row) => !row.available).length,
          symbols: symbolResults,
        });
      }
    }
    const finishedAt = new Date().toISOString();
    const summary = {
      mode: runMode,
      startedAt: factorEvolutionScheduler.lastStartedAt,
      finishedAt,
      markets: marketResults,
      config: {
        markets: config.markets,
        lightIntervalHours: Number((config.lightIntervalMs / 3600000).toFixed(2)),
        heavyIntervalHours: Number((config.heavyIntervalMs / 3600000).toFixed(2)),
        lightSymbolLimit: config.lightSymbolLimit,
        heavySymbolLimit: config.heavySymbolLimit,
        range: config.range,
        horizonDays: config.horizonDays,
      },
    };
    factorEvolutionScheduler.lastFinishedAt = finishedAt;
    factorEvolutionScheduler.lastResult = summary;
    await writeFactorEvolutionSchedulerState({
      runningMode: "",
      [`${runMode}LastFinishedAt`]: finishedAt,
      lastResult: summary,
      lastError: "",
    });
    return summary;
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    factorEvolutionScheduler.lastError = message;
    await writeFactorEvolutionSchedulerState({
      runningMode: "",
      [`${runMode}LastErrorAt`]: new Date().toISOString(),
      lastError: message,
    }).catch(() => null);
    throw error;
  } finally {
    factorEvolutionScheduler.running = false;
    factorEvolutionScheduler.activeMode = "";
  }
}

async function factorEvolutionSchedulerStatus() {
  const config = factorEvolutionConfig();
  const state = await readFactorEvolutionSchedulerState();
  return {
    enabled: config.enabled,
    running: factorEvolutionScheduler.running,
    activeMode: factorEvolutionScheduler.activeMode,
    lastStartedAt: factorEvolutionScheduler.lastStartedAt || state.lightLastStartedAt || state.heavyLastStartedAt || null,
    lastFinishedAt: factorEvolutionScheduler.lastFinishedAt || state.lightLastFinishedAt || state.heavyLastFinishedAt || null,
    lightLastFinishedAt: state.lightLastFinishedAt || null,
    heavyLastFinishedAt: state.heavyLastFinishedAt || null,
    lastError: factorEvolutionScheduler.lastError || state.lastError || "",
    lastResult: factorEvolutionScheduler.lastResult || state.lastResult || null,
    config: {
      markets: config.markets,
      lightIntervalHours: Number((config.lightIntervalMs / 3600000).toFixed(2)),
      heavyIntervalHours: Number((config.heavyIntervalMs / 3600000).toFixed(2)),
      lightSymbolLimit: config.lightSymbolLimit,
      heavySymbolLimit: config.heavySymbolLimit,
      lightGenerations: config.lightGenerations,
      lightPopulation: config.lightPopulation,
      range: config.range,
      horizonDays: config.horizonDays,
      startupDelayMs: config.startupDelayMs,
      checkIntervalMs: config.checkIntervalMs,
    },
    next: {
      lightDue: isFactorEvolutionDue(state, "light", config.lightIntervalMs),
      heavyDue: isFactorEvolutionDue(state, "heavy", config.heavyIntervalMs, {
        requirePreviousRun: process.env.FACTOR_EVOLUTION_RUN_HEAVY_ON_FIRST_START !== "true",
      }),
    },
  };
}

async function tickFactorEvolutionScheduler(reason = "timer") {
  const config = factorEvolutionConfig();
  if (!config.enabled || factorEvolutionScheduler.running) return;
  const state = await readFactorEvolutionSchedulerState();
  const heavyDue = isFactorEvolutionDue(state, "heavy", config.heavyIntervalMs, {
    requirePreviousRun: process.env.FACTOR_EVOLUTION_RUN_HEAVY_ON_FIRST_START !== "true",
  });
  const lightDue = isFactorEvolutionDue(state, "light", config.lightIntervalMs);
  if (!heavyDue && !lightDue) return;
  const mode = heavyDue ? "heavy" : "light";
  console.log(`Factor evolution scheduler running ${mode} cycle (${reason}).`);
  runFactorEvolutionCycle(mode)
    .then((result) => {
      console.log(`Factor evolution ${mode} cycle finished: ${JSON.stringify({
        markets: result.markets?.length || 0,
        finishedAt: result.finishedAt,
      })}`);
    })
    .catch((error) => {
      console.warn(`Factor evolution ${mode} cycle failed: ${error.message || error}`);
    });
}

function marketRegimeFactor(candles) {
  const rows = sanitizeCandleRows(candles);
  if (rows.length < 70) return { available: false, source: "market-regime-local", score: 0, thesis: ["Not enough candles for market regime classification."] };
  const closes = rows.map((row) => Number(row.close));
  const latest = closes.at(-1);
  const sma20Value = closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const sma50Value = closes.slice(-50).reduce((sum, value) => sum + value, 0) / 50;
  const returns = closes.slice(-21).map((value, index, arr) => index ? pctChange(value, arr[index - 1]) : 0).slice(1);
  const volatility = Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length);
  const trend = pctReturn(rows, 20);
  let regime = "range";
  let score = 0;
  if (latest > sma20Value && sma20Value > sma50Value && trend > 2) {
    regime = "uptrend";
    score += 7;
  } else if (latest < sma20Value && sma20Value < sma50Value && trend < -2) {
    regime = "downtrend";
    score -= 8;
  }
  if (volatility > 3.2) score -= 4;
  else if (volatility < 1.6 && regime === "uptrend") score += 2;
  return {
    available: true,
    source: "local-price-regime",
    score: Math.max(-12, Math.min(12, score)),
    thesis: [`Market regime ${regime}: 20d trend ${trend.toFixed(2)}%, volatility ${volatility.toFixed(2)}, close ${latest > sma20Value ? "above" : "below"} SMA20.`],
    values: { regime, trend, volatility, sma20: sma20Value, sma50: sma50Value },
  };
}

async function fetchFactorResearchFactor(symbol, strategy = {}, market = "ASX", candles = []) {
  const key = safeMarket(market);
  const code = normalizeMarketSymbol(symbol, key);
  const rows = sanitizeCandleRows(candles || []);
  if (rows.length < 90) {
    const snapshot = await readFactorResearchModelSnapshot(key, code);
    if (snapshot?.liveSignal) {
      return {
        available: true,
        source: "cached-factor-research-ml",
        score: clampNumber(Number(snapshot.liveSignal.score || 0), -12, 12),
        weight: Math.max(0, Number(snapshot.admittedCount || 0)),
        confidence: clampNumber(Number(snapshot.liveSignal.confidence || 0), 0, 86),
        thesis: [
          `Cached factor ML weights: ${snapshot.admittedCount || 0}/${snapshot.candidateCount || 0} admitted factors; score ${Number(snapshot.liveSignal.score || 0).toFixed(1)}.`,
          "Current candle depth is too short for fresh factor ML validation; using persisted local factor-research snapshot.",
        ],
        values: {
          cached: true,
          savedAt: snapshot.savedAt,
          admittedCount: snapshot.admittedCount,
          candidateCount: snapshot.candidateCount,
          components: snapshot.liveSignal.components || [],
        },
        model: snapshot,
      };
    }
    return {
      available: false,
      source: "factor-research-insufficient-history",
      score: 0,
      confidence: 0,
      thesis: [`Factor ML research requires at least 90 real daily candles; current ${rows.length}.`],
      values: { samples: rows.length },
    };
  }
  const result = await runPythonQuantCore("factor-research", {
    market: key,
    symbol: code,
    horizon_days: Math.max(1, Number(strategy.horizonDays || 15)),
    candles: rows,
  }, Number(process.env.FACTOR_RESEARCH_TIMEOUT_MS || 14000));
  const research = result.factor_research || {};
  const live = research.live_signal || {};
  const saved = await writeFactorResearchModelSnapshot(key, code, result).catch(() => null);
  if (saved) {
    await appendModelChangeLogFile(key, {
      event_type: "model-change-log-factor-research",
      entity_id: `${key}:${code}:factor-research:${saved.savedAt}`,
      payload: {
        title: "动态因子权重已更新",
        type: "factor-research-ml",
        market: key,
        symbol: code,
        framework: saved.framework,
        candidateCount: saved.candidateCount,
        admittedCount: saved.admittedCount,
        liveScore: saved.liveSignal?.score,
        holdout: saved.mlBacktest?.test || null,
        leakageControl: saved.leakageControl,
      },
    }).catch(() => null);
  }
  const crossSectional = await readCrossSectionalFactorModelSnapshot(key);
  const crossWeights = new Map((crossSectional?.aggregateWeights || []).map((row) => [row.name, Number(row.weight_pct || 0) / 100]));
  const crossComponents = (live.components || [])
    .map((component) => {
      const weight = crossWeights.get(component.name) || 0;
      const direction = component.direction === "negative" ? -1 : 1;
      const contribution = Number(component.z_value || 0) * direction * weight * 7;
      return weight > 0 ? { ...component, crossWeightPct: Number((weight * 100).toFixed(3)), crossContribution: Number(contribution.toFixed(4)) } : null;
    })
    .filter(Boolean);
  const crossScore = crossComponents.length
    ? clampNumber(crossComponents.reduce((sum, row) => sum + Number(row.crossContribution || 0), 0), -12, 12)
    : null;
  const blendedScore = crossScore == null
    ? clampNumber(Number(live.score || 0), -12, 12)
    : clampNumber(Number(live.score || 0) * 0.62 + crossScore * 0.38, -12, 12);
  const blendedConfidence = clampNumber(Number(live.confidence || 0) + (crossScore == null ? 0 : Math.min(6, crossComponents.length * 0.8)), 0, 88);
  return {
    available: Boolean(research.available),
    source: crossScore == null ? "factor-research-ml" : "factor-research-ml+cross-sectional",
    score: blendedScore,
    weight: Math.max(0, Number(research.admitted_count || 0)),
    confidence: blendedConfidence,
    thesis: [
      `Factor ML research: ${research.admitted_count || 0}/${research.candidate_count || 0} factors admitted; live stance ${live.stance || "mixed"}, score ${Number(live.score || 0).toFixed(1)}, confidence ${Number(live.confidence || 0).toFixed(0)}%.`,
      crossScore == null
        ? "Market cross-sectional factor weights are not available yet; run the 5-year historical calibration or factor research batch to enable market-level double-check."
        : `Market cross-sectional overlay: score ${crossScore.toFixed(1)} from ${crossComponents.length} shared factors; blended factor score ${blendedScore.toFixed(1)}.`,
      research.ml_backtest?.available
        ? `Holdout combo: direction ${Number(research.ml_backtest.test?.direction_hit_rate_pct || 0).toFixed(0)}%, IC ${Number(research.ml_backtest.test?.ic || 0).toFixed(3)}, lift ${Number(research.ml_backtest.direction_lift_pct || 0).toFixed(1)}pct.`
        : "Factor ML combo is still collecting enough samples for holdout validation.",
    ],
    values: {
      savedAt: saved?.savedAt || null,
      sampleCount: result.sample_count || 0,
      admittedCount: research.admitted_count || 0,
      candidateCount: research.candidate_count || 0,
      liveStance: live.stance || "mixed",
      components: live.components || [],
      crossSectional: crossSectional ? {
        savedAt: crossSectional.savedAt,
        framework: crossSectional.framework,
        symbolCount: crossSectional.symbolCount,
        aggregateWeights: crossSectional.aggregateWeights || [],
        score: crossScore,
        components: crossComponents,
      } : null,
      weights: research.weights || [],
      mlBacktest: research.ml_backtest || null,
    },
    model: saved || {
      framework: research.framework,
      weights: research.weights || [],
      mlBacktest: research.ml_backtest || null,
      leakageControl: research.leakage_control,
    },
  };
}

async function fetchFactorLayer(symbol, strategy = {}, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const cacheKey = `${key}:${code}:${strategy.horizonDays || 15}:${strategy.targetUpside || 5}`;
  const cached = factorResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.time < Number(process.env.FACTOR_CACHE_TTL_MS || 10 * 60 * 1000)) return cached.value;
  const factorBacktestRange = process.env.FACTOR_BACKTEST_RANGE || "2y";
  const marketData = await fetchMarketCandles(symbol, factorBacktestRange, "1d", key);
  const candles = marketData.candles || [];
  const results = await Promise.allSettled([
    fetchAsxAnnouncementsFactor(symbol, key),
    fetchShortInterestFactor(symbol, key, candles),
    fetchMacroFactor(symbol, key),
    fetchSectorFactor(symbol, key),
    fetchRelativeStrengthFactor(symbol, candles, key),
    fetchFlowOptionsFactor(symbol, key, candles),
    fetchRedditSocialFactor(symbol, key, { mode: "local", limit: 10 }),
    minuteLearningFactorFor(symbol, key),
    historicalBacktestForCandles({ market: key, symbol, candles, strategy, source: marketData.source }),
    fetchFactorResearchFactor(symbol, strategy, key, candles),
  ]);
  const get = (index, fallback) => results[index].status === "fulfilled" ? results[index].value : fallback(results[index].reason);
  const historicalBacktest = get(8, (error) => ({ available: false, reason: `Historical walk-forward unavailable: ${error.message || error}` }));
  const historicalCalibration = historicalBacktestFactor(historicalBacktest);
  const simpleCalibration = calibrationFactor(candles, Number(strategy.horizonDays || 15), Number(strategy.targetUpside || 5), Number(strategy.stopLoss || 4));
  const factors = {
    announcements: get(0, (error) => ({ available: false, source: "asx-announcements-unavailable", score: 0, thesis: [`ASX announcement factor unavailable: ${error.message || error}`] })),
    shortInterest: get(1, (error) => ({ available: false, source: "asic-short-unavailable", score: 0, thesis: [`ASIC short-interest factor unavailable: ${error.message || error}`] })),
    macro: get(2, (error) => ({ available: false, source: "macro-unavailable", score: 0, thesis: [`Macro factor unavailable: ${error.message || error}`] })),
    sector: get(3, (error) => ({ available: false, source: "sector-unavailable", score: 0, thesis: [`Sector factor unavailable: ${error.message || error}`] })),
    relativeStrength: get(4, (error) => ({ available: false, source: "relative-strength-unavailable", score: 0, thesis: [`Relative strength factor unavailable: ${error.message || error}`] })),
    flowOptions: get(5, (error) => ({ available: false, source: "flow-options-unavailable", score: 0, thesis: [`Flow/options factor unavailable: ${error.message || error}`] })),
    socialMedia: get(6, (error) => ({ available: false, source: "reddit-social-unavailable", score: 0, weight: 0, confidence: 0, sentiment: 0, manipulationRisk: 0, truthScore: 0, items: [], topItems: [], thesis: [`Reddit social factor unavailable: ${error.message || error}`] })),
    minuteLearning: get(7, (error) => ({ available: false, source: "minute-learning-unavailable", score: 0, confidence: 0, thesis: [`Minute learning factor unavailable: ${error.message || error}`] })),
    marketRegime: marketRegimeFactor(candles),
    liquidity: liquidityFactor(candles),
    calibration: historicalCalibration.available ? historicalCalibration : simpleCalibration,
    historicalCalibration,
    simpleCalibration,
    factorResearch: get(9, (error) => ({ available: false, source: "factor-research-unavailable", score: 0, confidence: 0, thesis: [`Factor research ML unavailable: ${error.message || error}`], values: { components: [] } })),
  };
  const signal = factorSignal(factors);
  const value = { symbol: normalizeMarketSymbol(symbol, key), market: key, source: "factor-layer", factors, signal };
  factorResponseCache.set(cacheKey, { time: Date.now(), value });
  if (factorResponseCache.size > 80) factorResponseCache.delete(factorResponseCache.keys().next().value);
  return value;
}

async function fetchXItems(symbol, market = "ASX") {
  if (!process.env.X_BEARER_TOKEN) return { source: "x-disabled", posts: [] };
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const context = sectorContext(code, key);
  const leaders = `"Jensen Huang" OR Elon Musk OR Trump OR "Donald Trump" OR "Jerome Powell" OR "Anthony Albanese" OR "Xi Jinping" OR "RBA" OR "Michele Bullock"`;
  const queries = [
    `(${code} OR ${MARKET_CONFIG[key].newsName} OR "${context.sector}") lang:en -is:retweet`,
    `(${leaders}) (markets OR economy OR AI OR chips OR tariffs OR rates OR war OR China OR energy) lang:en -is:retweet`,
    `(war OR sanctions OR tariffs OR "rate cut" OR "rate hike" OR oil OR LNG OR "iron ore" OR China OR Nvidia OR Tesla) lang:en -is:retweet`,
  ];
  const results = await Promise.allSettled(queries.map(async (query, index) => {
    const endpoint = new URL("https://api.x.com/2/tweets/search/recent");
    endpoint.searchParams.set("query", query);
    endpoint.searchParams.set("max_results", "10");
    endpoint.searchParams.set("tweet.fields", "created_at,public_metrics,author_id");
    const payload = await fetchJson(endpoint, 3000, { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` });
    return (payload.data || []).map((tweet) => ({
      text: tweet.text,
      publishedAt: tweet.created_at,
      metrics: tweet.public_metrics,
      channel: ["symbol-sector", "leaders", "macro-hot"][index],
    }));
  }));
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || result.reason).slice(0, 220));
  const posts = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return {
    source: "x-recent-search",
    warning: errors.join(" | "),
    posts: posts
      .sort((a, b) => ((b.metrics?.like_count || 0) + (b.metrics?.retweet_count || 0) * 2) - ((a.metrics?.like_count || 0) + (a.metrics?.retweet_count || 0) * 2))
      .slice(0, 20),
  };
}

async function fetchYouTubeItems(symbol, market = "ASX") {
  if (!process.env.YOUTUBE_API_KEY) return { source: "youtube-disabled", videos: [] };
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const context = sectorContext(code, key);
  const normalizeVideo = (item, channel) => ({
    title: item.snippet?.title,
    description: item.snippet?.description,
    publisher: item.snippet?.channelTitle,
    publishedAt: item.snippet?.publishedAt,
    link: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : `https://www.youtube.com/watch?v=${item.id}`,
    channel,
  });
  const searches = [
    `${code} ${MARKET_CONFIG[key].newsName}`,
    `${context.peers} ${context.upstream}`,
    `Jensen Huang Elon Musk Trump Powell RBA markets AI tariffs war`,
    `${key === "US" ? "US economy Federal Reserve Nasdaq S&P 500" : key === "CN" ? "China economy PBOC A shares CSI 300" : "Australia economy interest rates RBA ASX China commodities"}`,
  ];
  const searchResults = await Promise.allSettled(searches.map(async (query, index) => {
    const endpoint = new URL("https://www.googleapis.com/youtube/v3/search");
    endpoint.searchParams.set("part", "snippet");
    endpoint.searchParams.set("type", "video");
    endpoint.searchParams.set("order", "relevance");
    endpoint.searchParams.set("maxResults", "5");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("key", process.env.YOUTUBE_API_KEY);
    const payload = await fetchJson(endpoint, 3000);
    return (payload.items || []).map((item) => normalizeVideo(item, ["stock", "industry", "leaders", "macro"][index]));
  }));
  const popularEndpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
  popularEndpoint.searchParams.set("part", "snippet,statistics");
  popularEndpoint.searchParams.set("chart", "mostPopular");
  popularEndpoint.searchParams.set("regionCode", "AU");
  popularEndpoint.searchParams.set("maxResults", "20");
  popularEndpoint.searchParams.set("key", process.env.YOUTUBE_API_KEY);
  const popular = await fetchJson(popularEndpoint, 3000).catch(() => ({ items: [] }));
  const errors = searchResults
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || result.reason).slice(0, 220));
  const videos = dedupeNews([
    ...popular.items.map((item) => ({
      title: item.snippet?.title,
      description: item.snippet?.description,
      publisher: item.snippet?.channelTitle,
      publishedAt: item.snippet?.publishedAt,
      link: `https://www.youtube.com/watch?v=${item.id}`,
      channel: "au-trending",
    })),
    ...searchResults.flatMap((result) => result.status === "fulfilled" ? result.value : []),
  ]).slice(0, 20);
  return {
    source: "youtube-data-api",
    warning: errors.join(" | "),
    videos,
  };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ensembleModel(name, confidence, projectedUpside, weight, available, reason, values = {}) {
  return {
    name,
    confidence: Math.max(0, Math.min(99, Math.round(finiteNumber(confidence, 0)))),
    projectedUpside: Number(finiteNumber(projectedUpside, 0).toFixed(2)),
    weight,
    normalizedWeight: 0,
    available: available !== false,
    reason,
    values,
  };
}

function marketRegimeProfile(factors = {}, technicals = {}) {
  const regimeFactor = factors?.marketRegime || {};
  const values = regimeFactor.values || {};
  const trend = finiteNumber(values.trend, finiteNumber(technicals?.change20d, 0));
  const volatility = finiteNumber(values.volatility, finiteNumber(technicals?.volatility, 2));
  const score = finiteNumber(regimeFactor.score, 0);
  let regime = String(values.regime || "").toLowerCase();
  if (!regime) {
    if (score <= -6 || trend <= -3) regime = "downtrend";
    else if (volatility >= 3.4) regime = "volatile";
    else if (score >= 5 || trend >= 3) regime = "uptrend";
    else regime = "range";
  }
  if (volatility >= 3.6 && regime !== "downtrend") regime = "volatile";
  const riskLevel = regime === "downtrend" ? "high" : regime === "volatile" ? "elevated" : regime === "uptrend" ? "constructive" : "neutral";
  return {
    regime,
    riskLevel,
    score,
    trend,
    volatility,
    buyThresholdBonus: regime === "downtrend" ? 8 : regime === "volatile" ? 5 : regime === "range" ? 2 : 0,
    upsideShrink: regime === "downtrend" ? 0.72 : regime === "volatile" ? 0.82 : regime === "range" ? 0.92 : 1,
    confidenceBias: regime === "uptrend" ? 1.5 : regime === "range" ? -0.5 : regime === "volatile" ? -3 : -5,
  };
}

function marketRegimeModelView(profile, strategy = {}) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const score = finiteNumber(profile?.score, 0);
  const trend = finiteNumber(profile?.trend, 0);
  const volatility = finiteNumber(profile?.volatility, 2);
  const projected = score * 0.11 + trend * 0.08 - Math.max(0, volatility - stop * 0.55) * 0.18;
  const confidence = 52 + score * 1.7 - (profile?.regime === "volatile" ? 4 : 0);
  return ensembleModel(
    "市场环境模型",
    confidence,
    clampNumber(projected, -Math.max(stop, target), target * 0.9),
    0.1,
    true,
    `Market regime ${profile?.regime || "range"} (${profile?.riskLevel || "neutral"}): trend ${trend.toFixed(2)}%, volatility ${volatility.toFixed(2)}, regime score ${score.toFixed(1)}.`,
    { family: "market-regime", regime: profile?.regime || "range", riskLevel: profile?.riskLevel || "neutral", score, trend, volatility },
  );
}

function strategyTargetModelView({ analog, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const strategyProb = finiteNumber(analog?.strategyHitProbability ?? analog?.targetHitRate, 0);
  const stopRate = finiteNumber(analog?.stopRate, 0);
  const riskReturn = finiteNumber(analog?.averageRiskAdjustedReturn ?? analog?.averageForwardReturn, 0);
  const modelMeta = finiteNumber(analog?.model?.metaLabelProbability, 0);
  const modelTarget = finiteNumber(analog?.model?.oosTargetHitAccuracy ?? analog?.model?.targetHitAccuracy, 0);
  const sampleCount = Number(analog?.count || 0) + Number(analog?.model?.oosSampleCount || 0);
  if (sampleCount < 8 && !strategyProb && !modelMeta) {
    return ensembleModel("策略达标模型", 0, 0, 0.16, false, "Strategy target model needs resolved analog/OOS evidence.");
  }
  const blendedProb = [strategyProb, modelMeta, modelTarget].filter((value) => value > 0).reduce((sum, value, index, arr) => sum + value / arr.length, 0);
  const projected = riskReturn * 0.5 + (blendedProb - 50) * 0.055 - stopRate * 0.025;
  const confidence = 42 + blendedProb * 0.62 + Math.min(8, Math.log10(Math.max(1, sampleCount)) * 3) - Math.max(0, stopRate - 35) * 0.12;
  return ensembleModel(
    "策略达标模型",
    confidence,
    clampNumber(projected, -Math.max(stop, target), target * 1.15),
    0.18,
    true,
    `Primary strategy label: target-before-stop probability ${blendedProb.toFixed(0)}%, stop-first ${stopRate.toFixed(0)}%, risk-adjusted return ${riskReturn.toFixed(2)}%.`,
    { family: "strategy-label", strategyProb: blendedProb, analogStrategyProb: strategyProb, metaLabelProbability: modelMeta, modelTargetHitAccuracy: modelTarget, stopRate, sampleCount },
  );
}

function modelPerformanceAdjustmentFor(model, summary = {}) {
  const stat = summary?.modelStats?.[model.name];
  if (!stat || Number(stat.samples || 0) < 5) return { multiplier: 1, stat: null };
  return {
    multiplier: clampNumber(Number(stat.weightMultiplier || 1), 0.45, 1.35),
    stat,
  };
}

function regimeWeightAdjustmentForModel(model, profile = {}) {
  const family = model.values?.family || "";
  const name = String(model.name || "");
  let multiplier = 1;
  if (profile.regime === "uptrend") {
    if (/技术|突破|freqtrade|backtrader|strategy-label/i.test(`${name} ${family}`)) multiplier += 0.08;
    if (/risk|风险|hummingbot/i.test(`${name} ${family}`)) multiplier += 0.03;
  } else if (profile.regime === "range") {
    if (/突破|freqtrade/i.test(`${name} ${family}`)) multiplier -= 0.06;
    if (/风险|hummingbot|lean/i.test(`${name} ${family}`)) multiplier += 0.05;
  } else if (profile.regime === "volatile") {
    if (/突破|技术|freqtrade|backtrader/i.test(`${name} ${family}`)) multiplier -= 0.1;
    if (/风险|hummingbot|lean|market-regime/i.test(`${name} ${family}`)) multiplier += 0.1;
  } else if (profile.regime === "downtrend") {
    if (/突破|技术|freqtrade|backtrader|strategy-label/i.test(`${name} ${family}`)) multiplier -= 0.14;
    if (/风险|hummingbot|lean|market-regime/i.test(`${name} ${family}`)) multiplier += 0.12;
  }
  return clampNumber(multiplier, 0.66, 1.25);
}

function applyPerformanceAndRegimeWeights(models = [], calibrationSummary = {}, profile = {}) {
  let adjusted = 0;
  for (const model of models) {
    if (!model.available || model.weight <= 0) continue;
    const perf = modelPerformanceAdjustmentFor(model, calibrationSummary);
    const regimeMultiplier = regimeWeightAdjustmentForModel(model, profile);
    const finalMultiplier = clampNumber(perf.multiplier * regimeMultiplier, 0.45, 1.45);
    if (Math.abs(finalMultiplier - 1) > 0.015) {
      model.weight = Number((model.weight * finalMultiplier).toFixed(4));
      model.values = {
        ...(model.values || {}),
        performanceWeightMultiplier: Number(perf.multiplier.toFixed(2)),
        regimeWeightMultiplier: Number(regimeMultiplier.toFixed(2)),
        performanceSamples: perf.stat?.samples || 0,
      };
      adjusted += 1;
    }
  }
  return adjusted;
}

function predictionHorizonBucket(horizonDays = 15) {
  const days = Math.max(1, Number(horizonDays || 15));
  if (days <= 7) return "short";
  if (days <= 25) return "mid";
  return "long";
}

function localModelScopeForStrategy(calibrationSummary = {}, strategy = {}) {
  const horizonBucket = predictionHorizonBucket(strategy?.horizonDays);
  const marketSuite = calibrationSummary?.localModelDeployment || {};
  const scoped = marketSuite?.horizonSuites?.[horizonBucket];
  const usable = Boolean(
    scoped
    && Number(scoped.sampleCount || 0) >= 32
    && (scoped.signalModels || scoped.modelZoo || scoped.ensembleWeightOptimization),
  );
  return {
    horizonBucket,
    horizonDays: Math.max(1, Number(strategy?.horizonDays || 15)),
    source: usable ? "horizon_isolated" : "market_fallback",
    suite: usable ? scoped : marketSuite,
    sampleCount: Number((usable ? scoped : marketSuite)?.sampleCount || 0),
    minSamples: Number(scoped?.minSamples || 32),
    reason: usable
      ? `Using ${horizonBucket} horizon models trained only on matching resolved prediction samples.`
      : (scoped?.reason || "Matching horizon model is collecting; market-wide evidence is fallback-only."),
  };
}

function applyOptimizedEnsembleWeights(models = [], calibrationSummary = {}, strategy = {}, modelScope = null) {
  const scope = modelScope || localModelScopeForStrategy(calibrationSummary, strategy);
  const optimization = scope.suite?.ensembleWeightOptimization || calibrationSummary?.ensembleWeightOptimization || {};
  if (optimization.productionEligible !== true || !optimization.active || !optimization.weights || typeof optimization.weights !== "object") {
    return {
      applied: false,
      status: optimization.status || "unavailable",
      reason: optimization.reason || "Learned weights remain Research/Shadow-only until the explicit production evidence gate passes.",
      sampleCount: Number(optimization.sampleCount || 0),
      horizonBucket: scope.horizonBucket,
      source: scope.source,
    };
  }
  const available = models.filter((model) => model.available && Number(model.weight || 0) > 0);
  if (!available.length) {
    return { applied: false, status: "no_available_models", reason: "No available models to receive optimized weights.", horizonBucket: scope.horizonBucket, source: scope.source };
  }
  const learnedRaw = available.map((model) => Math.max(0, Number(optimization.weights[model.name] || 0)));
  const learnedTotal = learnedRaw.reduce((sum, value) => sum + value, 0);
  if (learnedTotal <= 0) {
    return {
      applied: false,
      status: "no_overlap",
      reason: "Current ensemble models do not overlap with learned weight vector.",
      sampleCount: Number(optimization.sampleCount || 0),
      horizonBucket: scope.horizonBucket,
      source: scope.source,
    };
  }
  const currentTotal = available.reduce((sum, model) => sum + Number(model.weight || 0), 0) || 1;
  const blend = clampNumber(Number(optimization.deploymentBlend || 0.45), 0.2, 0.85);
  available.forEach((model, index) => {
    const currentNormalized = Number(model.weight || 0) / currentTotal;
    const learnedNormalized = learnedRaw[index] / learnedTotal;
    const blendedNormalized = (1 - blend) * currentNormalized + blend * learnedNormalized;
    model.weight = Number((blendedNormalized * currentTotal).toFixed(5));
    model.values = {
      ...(model.values || {}),
      optimizedEnsembleWeight: Number(learnedNormalized.toFixed(5)),
      optimizedWeightBlend: blend,
    };
  });
  return {
    applied: true,
    status: optimization.status || "active",
    sampleCount: Number(optimization.sampleCount || 0),
    modelCount: Number(optimization.modelCount || Object.keys(optimization.weights || {}).length),
    deploymentBlend: blend,
    testImprovementPct: optimization.testImprovementPct ?? null,
    validationImprovementPct: optimization.validationImprovementPct ?? null,
    horizonBucket: scope.horizonBucket,
    source: scope.source,
    reason: optimization.reason || "OOS-approved learned ensemble weights applied.",
  };
}

function isExternalDoubleCheckModel(model = {}) {
  const name = String(model.name || "");
  const family = String(model.values?.family || "");
  return Boolean(model.values?.distilled)
    || /蒸馏|开源策略复核|Freqtrade|LEAN|Backtrader|Hummingbot|FinRL/i.test(name)
    || /freqtrade|lean|backtrader|hummingbot|finrl|external|open-source/i.test(family);
}

function applyExternalDoubleCheckCaps(models = []) {
  const available = models.filter((model) => model.available && Number(model.weight || 0) > 0);
  const external = available.filter(isExternalDoubleCheckModel);
  if (!external.length) {
    return {
      applied: false,
      maxExternalShare: 0.18,
      maxSingleExternalShare: 0.06,
      selfModelMinShare: 0.82,
      reason: "No external double-check models carried live weight.",
    };
  }
  const modelTotal = () => available.reduce((sum, model) => sum + Math.max(0, Number(model.weight || 0)), 0) || 1;
  const maxSingleShare = 0.06;
  let singleCapped = 0;
  for (const model of external) {
    const totalWithout = Math.max(0, modelTotal() - Math.max(0, Number(model.weight || 0)));
    const maxWeight = totalWithout > 0
      ? (maxSingleShare / Math.max(1e-9, 1 - maxSingleShare)) * totalWithout
      : Number(model.weight || 0);
    if (Number(model.weight || 0) > maxWeight) {
      model.weight = Number(maxWeight.toFixed(5));
      singleCapped += 1;
    }
  }
  const totalAfterSingle = modelTotal();
  const externalWeight = external.reduce((sum, model) => sum + Math.max(0, Number(model.weight || 0)), 0);
  const maxExternalShare = 0.18;
  let groupScale = 1;
  if (externalWeight / totalAfterSingle > maxExternalShare) {
    const internalWeight = Math.max(0, totalAfterSingle - externalWeight);
    const cappedExternalWeight = (maxExternalShare / Math.max(1e-9, 1 - maxExternalShare)) * internalWeight;
    groupScale = cappedExternalWeight / Math.max(1e-9, externalWeight);
    for (const model of external) {
      model.weight = Number((Number(model.weight || 0) * groupScale).toFixed(5));
    }
  }
  for (const model of external) {
    model.values = {
      ...(model.values || {}),
      doubleCheckOnly: true,
      doubleCheckCap: true,
      maxExternalShare,
      maxSingleExternalShare: maxSingleShare,
    };
  }
  const finalTotal = modelTotal();
  const finalExternalWeight = external.reduce((sum, model) => sum + Math.max(0, Number(model.weight || 0)), 0);
  return {
    applied: singleCapped > 0 || groupScale < 0.999,
    framework: "self-model-primary-double-check-cap",
    maxExternalShare,
    maxSingleExternalShare: maxSingleShare,
    selfModelMinShare: 1 - maxExternalShare,
    externalModelCount: external.length,
    externalShare: Number((finalExternalWeight / finalTotal * 100).toFixed(1)),
    cappedSingleCount: singleCapped,
    groupScale: Number(groupScale.toFixed(3)),
    reason: "External/open-source distilled models are capped as double-check evidence; local prediction models keep the dominant live ensemble share.",
  };
}

function fundamentalsView(fundamentals) {
  if (!fundamentals) return ensembleModel("基本面估值", 0, 0, 0.09, false, "Fundamental provider returned no usable data.");
  const pe = finiteNumber(fundamentals.peRatio, NaN);
  const forwardPe = finiteNumber(fundamentals.forwardPE, NaN);
  const dividendYieldRaw = finiteNumber(fundamentals.dividendYield, NaN);
  const dividendYield = Number.isFinite(dividendYieldRaw) && dividendYieldRaw <= 1 ? dividendYieldRaw * 100 : dividendYieldRaw;
  const profitMarginRaw = finiteNumber(fundamentals.profitMargin, NaN);
  const profitMargin = Number.isFinite(profitMarginRaw) && Math.abs(profitMarginRaw) <= 1 ? profitMarginRaw * 100 : profitMarginRaw;
  const beta = finiteNumber(fundamentals.beta, NaN);
  let score = 0;
  const reasons = [];
  if (Number.isFinite(pe) && pe > 0) {
    if (pe < 18) score += 6;
    else if (pe > 55) score -= 7;
    else if (pe > 35) score -= 3;
    reasons.push(`PE ${pe.toFixed(1)}`);
  }
  if (Number.isFinite(forwardPe) && forwardPe > 0 && Number.isFinite(pe) && pe > 0) {
    score += forwardPe < pe ? 3 : -2;
    reasons.push(`forward PE ${forwardPe.toFixed(1)}`);
  }
  if (Number.isFinite(dividendYield) && dividendYield > 0) {
    score += dividendYield >= 2 && dividendYield <= 8 ? 3 : dividendYield > 10 ? -2 : 1;
    reasons.push(`yield ${dividendYield.toFixed(1)}%`);
  }
  if (Number.isFinite(profitMargin)) {
    if (profitMargin > 18) score += 4;
    else if (profitMargin < 3) score -= 3;
    reasons.push(`margin ${profitMargin.toFixed(1)}%`);
  }
  if (Number.isFinite(beta)) {
    if (beta > 1.7) score -= 3;
    else if (beta > 0 && beta < 1.1) score += 1;
    reasons.push(`beta ${beta.toFixed(2)}`);
  }
  const hasData = reasons.length > 0;
  return ensembleModel(
    "基本面估值",
    hasData ? 50 + score * 1.8 : 0,
    hasData ? score * 0.16 : 0,
    0.09,
    hasData,
    hasData ? reasons.join(" · ") : "Fundamental data was present but did not include PE, dividend, margin, or beta.",
    { pe, forwardPe, dividendYield, profitMargin, beta, score },
  );
}

function breakoutVolatilityView(technicals, strategy = {}) {
  const trend = finiteNumber(technicals?.trendScore, 50);
  const momentum = finiteNumber(technicals?.momentumScore, 50);
  const volume = finiteNumber(technicals?.volumeRatio, 1);
  const volatility = finiteNumber(technicals?.volatility, 2);
  const change20d = finiteNumber(technicals?.change20d, 0);
  const rsiValue = finiteNumber(technicals?.rsi, 50);
  let score = 0;
  if (trend >= 62 && momentum >= 56) score += 7;
  if (volume >= 1.15 && volume <= 3.2) score += 5;
  if (change20d > 3 && change20d < 18) score += 4;
  if (rsiValue > 76) score -= 6;
  if (volatility > 4.2) score -= 5;
  const target = finiteNumber(strategy?.targetUpside, 5);
  return ensembleModel(
    "突破波动模型",
    48 + score * 2.2,
    score * 0.18 + Math.min(2.2, target * 0.22),
    0.07,
    true,
    `Breakout/volatility score ${score.toFixed(1)} from trend ${trend.toFixed(0)}, momentum ${momentum.toFixed(0)}, volume ratio ${volume.toFixed(2)}, volatility ${volatility.toFixed(2)}.`,
    { score, trend, momentum, volume, volatility, change20d, rsi: rsiValue },
  );
}

function riskRewardView(technicals, strategy = {}) {
  const projected = finiteNumber(technicals?.projectedUpside, 0);
  const volatility = Math.max(0.1, finiteNumber(technicals?.volatility, 2));
  const riskScore = finiteNumber(technicals?.riskScore, 50);
  const target = finiteNumber(strategy?.targetUpside, 5);
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const rewardRisk = projected > 0 ? projected / stop : projected / stop;
  const stability = Math.max(-8, Math.min(8, (riskScore - 50) / 4 - volatility * 0.7));
  const score = rewardRisk * 8 + stability + (projected >= target ? 4 : -2);
  return ensembleModel(
    "风险收益模型",
    50 + score * 1.9,
    projected * 0.55 + score * 0.08,
    0.08,
    true,
    `Reward/risk ${rewardRisk.toFixed(2)}, stop ${stop.toFixed(1)}%, volatility ${volatility.toFixed(2)}, risk score ${riskScore.toFixed(0)}.`,
    { rewardRisk, volatility, riskScore, score },
  );
}

function openSourceStrategyReviewView({ technicals, analog, factor, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const trend = finiteNumber(technicals?.trendScore, 50);
  const momentum = finiteNumber(technicals?.momentumScore, 50);
  const volumeScore = finiteNumber(technicals?.volumeScore, 50);
  const volumeRatio = finiteNumber(technicals?.volumeRatio, 1);
  const riskScore = finiteNumber(technicals?.riskScore, 50);
  const rsiValue = finiteNumber(technicals?.rsi, 50);
  const macdHistogram = finiteNumber(technicals?.macdHistogram, 0);
  const change5d = finiteNumber(technicals?.change5d, 0);
  const volatility = finiteNumber(technicals?.volatility, 2);
  const factorScore = finiteNumber(factor?.score, 0);
  const analogCount = Number(analog?.count || 0);
  const modelSampleCount = Number(analog?.model?.sampleCount || 0);
  const targetHitRate = finiteNumber(analog?.targetHitRate ?? analog?.winRate, 0);
  const directionalHitRate = finiteNumber(analog?.directionalHitRate ?? analog?.winRate, 0);
  const strategyHitProbability = finiteNumber(analog?.strategyHitProbability ?? analog?.targetHitRate ?? analog?.winRate, 0);
  const stopRate = finiteNumber(analog?.stopRate, 0);
  const riskAdjustedReturn = finiteNumber(analog?.averageRiskAdjustedReturn ?? analog?.averageForwardReturn, 0);
  const modelTargetHitAccuracy = finiteNumber(analog?.model?.targetHitAccuracy ?? analog?.model?.directionalAccuracy, 0);
  const modelReturn = finiteNumber(analog?.model?.predictedReturn, 0);
  const hasHistory = analogCount >= 5 || modelSampleCount >= 60;
  if (!hasHistory) {
    return ensembleModel(
      "开源策略复核",
      0,
      0,
      0.07,
      false,
      "No out-of-sample strategy history yet for Freqtrade/LEAN-style entry-risk review.",
    );
  }

  let score = 0;
  const reasons = [];
  if (trend >= 58 && momentum >= 54) {
    score += 6;
    reasons.push("trend/momentum confirmation");
  } else if (trend < 48 || momentum < 48) {
    score -= 5;
    reasons.push("trend or momentum weak");
  }
  if (volumeRatio >= 1.08 && volumeRatio <= 2.8 && volumeScore >= 50) score += 4;
  else if (volumeRatio < 0.9) {
    score -= 4;
    reasons.push("weak participation");
  }
  if (rsiValue >= 42 && rsiValue <= 68) score += 3;
  if (rsiValue > 76 || change5d > target * 1.15) {
    score -= 6;
    reasons.push("overbought/chasing risk");
  }
  if (macdHistogram > 0) score += 3;
  else score -= 2;
  if (riskScore < 42 || volatility > Math.max(3.8, stop * 0.9)) {
    score -= 5;
    reasons.push("volatility/drawdown risk");
  }
  if (analogCount >= 5) {
    score += (directionalHitRate - 50) * 0.22;
    score += (strategyHitProbability - 45) * 0.08;
    score -= stopRate * 0.08;
    if (riskAdjustedReturn > 0) score += Math.min(5, riskAdjustedReturn * 0.7);
    else score += Math.max(-5, riskAdjustedReturn * 0.8);
    reasons.push(`analog direction ${directionalHitRate.toFixed(0)}%, target-hit ${targetHitRate.toFixed(0)}%, stop-first ${stopRate.toFixed(0)}%`);
  }
  if (modelSampleCount >= 60) {
    score += (modelTargetHitAccuracy - 52) * 0.18;
    score += Math.max(-4, Math.min(4, modelReturn * 0.35));
    reasons.push(`walk-forward target accuracy ${modelTargetHitAccuracy.toFixed(0)}%`);
  }
  if (factorScore > 4) score += 2;
  if (factorScore < -4) score -= 3;

  const projectedUpside = (finiteNumber(technicals?.projectedUpside, 0) * 0.22)
    + (riskAdjustedReturn * 0.42)
    + (modelReturn * 0.28)
    + (factorScore * 0.04);
  const confidence = 48 + score * 1.55;
  return ensembleModel(
    "开源策略复核",
    confidence,
    clampNumber(projectedUpside, -Math.max(stop, target * 1.2), target * 1.35),
    0.07,
    true,
    `Freqtrade/LEAN-style review: ${reasons.slice(0, 4).join(" · ") || "neutral"}; score ${score.toFixed(1)}.`,
    { score, directionalHitRate, strategyHitProbability, targetHitRate, stopRate, modelTargetHitAccuracy, modelReturn, riskAdjustedReturn },
  );
}

function freqtradeDistilledView({ technicals, analog, factor, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const trend = finiteNumber(technicals?.trendScore, 50);
  const momentum = finiteNumber(technicals?.momentumScore, 50);
  const volumeRatio = finiteNumber(technicals?.volumeRatio, 1);
  const rsiValue = finiteNumber(technicals?.rsi, 50);
  const macdHistogram = finiteNumber(technicals?.macdHistogram, 0);
  const change5d = finiteNumber(technicals?.change5d, 0);
  const volatility = finiteNumber(technicals?.volatility, 2);
  const factorScore = finiteNumber(factor?.score, 0);
  const strategyProb = finiteNumber(analog?.strategyHitProbability ?? analog?.targetHitRate, 0);
  const stopRate = finiteNumber(analog?.stopRate, 0);
  const riskReturn = finiteNumber(analog?.averageRiskAdjustedReturn ?? analog?.averageForwardReturn, 0);
  let score = 0;
  const reasons = [];
  if (trend >= 58 && momentum >= 54 && macdHistogram > 0) {
    score += 9;
    reasons.push("entry trend+momentum+MACD");
  } else if (trend < 48 || momentum < 48) {
    score -= 7;
    reasons.push("entry filters weak");
  }
  if (volumeRatio >= 1.05 && volumeRatio <= 2.7) score += 4;
  else if (volumeRatio < 0.9 || volumeRatio > 4) score -= 4;
  if (rsiValue >= 42 && rsiValue <= 70) score += 3;
  if (rsiValue > 76 || change5d > target * 1.2) score -= 7;
  if (strategyProb >= 48) score += (strategyProb - 48) * 0.12;
  if (stopRate >= 45) score -= (stopRate - 40) * 0.12;
  if (volatility > stop * 0.9) score -= 4;
  score += Math.max(-4, Math.min(4, riskReturn * 0.55 + factorScore * 0.08));
  const projected = finiteNumber(technicals?.projectedUpside, 0) * 0.35 + riskReturn * 0.42 + factorScore * 0.04;
  return ensembleModel(
    "蒸馏-Freqtrade",
    50 + score * 1.45,
    clampNumber(projected, -Math.max(stop, target), target * 1.35),
    0.11,
    true,
    `Freqtrade-style ROI/stop/entry filters: ${reasons.join(" · ") || "neutral"}; target-hit ${strategyProb.toFixed(0)}%, stop-first ${stopRate.toFixed(0)}%.`,
    { distilled: true, family: "freqtrade", score, strategyProb, stopRate },
  );
}

function leanFrameworkDistilledView({ technicals, factor, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const trend = finiteNumber(technicals?.trendScore, 50);
  const momentum = finiteNumber(technicals?.momentumScore, 50);
  const risk = finiteNumber(technicals?.riskScore, 50);
  const volume = finiteNumber(technicals?.volumeScore, 50);
  const volatility = finiteNumber(technicals?.volatility, 2);
  const factorScore = finiteNumber(factor?.score, 0);
  const alpha = (trend - 50) * 0.32 + (momentum - 50) * 0.28 + factorScore * 0.34;
  const portfolio = (risk - 50) * 0.26 + (volume - 50) * 0.12;
  const riskControl = volatility > stop ? -7 : volatility > stop * 0.7 ? -3 : 3;
  const execution = volume >= 50 ? 2 : -3;
  const score = alpha + portfolio + riskControl + execution;
  const projected = alpha * 0.09 + portfolio * 0.04 + riskControl * 0.06;
  return ensembleModel(
    "蒸馏-LEAN风控",
    50 + score * 1.25,
    clampNumber(projected, -Math.max(stop, target), target * 1.25),
    0.1,
    true,
    `LEAN-style Alpha/Portfolio/Risk/Execution split: alpha ${alpha.toFixed(1)}, risk ${riskControl.toFixed(1)}, execution ${execution.toFixed(1)}.`,
    { distilled: true, family: "lean", score, alpha, portfolio, riskControl, execution },
  );
}

function backtraderIndicatorDistilledView({ technicals, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const close = finiteNumber(technicals?.close, 0);
  const sma20Value = finiteNumber(technicals?.sma20, close);
  const sma50Value = finiteNumber(technicals?.sma50, close);
  const rsiValue = finiteNumber(technicals?.rsi, 50);
  const macdHistogram = finiteNumber(technicals?.macdHistogram, 0);
  const volumeRatio = finiteNumber(technicals?.volumeRatio, 1);
  const change20d = finiteNumber(technicals?.change20d, 0);
  let score = 0;
  const reasons = [];
  if (close > sma20Value && sma20Value > sma50Value) {
    score += 8;
    reasons.push("close>SMA20>SMA50");
  } else if (close < sma20Value && sma20Value < sma50Value) {
    score -= 8;
    reasons.push("close<SMA20<SMA50");
  }
  if (macdHistogram > 0) score += 4;
  else score -= 4;
  if (rsiValue >= 45 && rsiValue <= 68) score += 4;
  else if (rsiValue > 75) score -= 5;
  else if (rsiValue < 38) score -= 3;
  if (volumeRatio >= 1.05) score += 2;
  if (change20d > target * 3) score -= 3;
  const projected = score * 0.16 + Math.max(-2, Math.min(2, change20d * 0.08));
  return ensembleModel(
    "蒸馏-Backtrader指标",
    50 + score * 1.65,
    clampNumber(projected, -Math.max(stop, target), target * 1.2),
    0.09,
    true,
    `Backtrader-style indicator stack: ${reasons.join(" · ") || "mixed"}; RSI ${rsiValue.toFixed(0)}, volume ${volumeRatio.toFixed(2)}x.`,
    { distilled: true, family: "backtrader", score, rsi: rsiValue, volumeRatio },
  );
}

function hummingbotExecutionDistilledView({ technicals, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const volumeRatio = finiteNumber(technicals?.volumeRatio, 1);
  const volatility = finiteNumber(technicals?.volatility, 2);
  const riskScore = finiteNumber(technicals?.riskScore, 50);
  const change5d = finiteNumber(technicals?.change5d, 0);
  const momentum = finiteNumber(technicals?.momentumScore, 50);
  let score = 0;
  if (volumeRatio >= 1 && volumeRatio <= 2.8) score += 6;
  else if (volumeRatio < 0.8) score -= 6;
  if (volatility <= stop * 0.65) score += 4;
  else if (volatility > stop) score -= 8;
  if (riskScore >= 58) score += 4;
  else if (riskScore < 42) score -= 5;
  if (Math.abs(change5d) > target * 1.3) score -= 4;
  if (momentum >= 55) score += 2;
  const projected = score * 0.12 + Math.max(-1.5, Math.min(1.5, (momentum - 50) * 0.04));
  return ensembleModel(
    "蒸馏-Hummingbot执行",
    50 + score * 1.55,
    clampNumber(projected, -Math.max(stop, target), target),
    0.07,
    true,
    `Hummingbot-style execution/liquidity review: volume ${volumeRatio.toFixed(2)}x, volatility ${volatility.toFixed(2)}, risk ${riskScore.toFixed(0)}.`,
    { distilled: true, family: "hummingbot", score, volumeRatio, volatility, riskScore },
  );
}

function finrlEnsembleDistilledView({ technicals, analog, macroSignal, factor, strategy }) {
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const modelReturn = finiteNumber(analog?.model?.predictedReturn, 0);
  const modelDirection = finiteNumber(analog?.model?.directionalAccuracy, 0);
  const analogDirection = finiteNumber(analog?.directionalHitRate ?? analog?.winRate, 0);
  const strategyProb = finiteNumber(analog?.strategyHitProbability ?? analog?.targetHitRate, 0);
  const techReturn = finiteNumber(technicals?.projectedUpside, 0);
  const macroScore = finiteNumber(macroSignal?.score, 0);
  const factorScore = finiteNumber(factor?.score, 0);
  const reward = modelReturn * 0.36 + techReturn * 0.26 + factorScore * 0.08 + macroScore * 0.05;
  const reliability = Math.max(modelDirection, analogDirection);
  const policyBonus = strategyProb >= 50 ? 4 : strategyProb >= 42 ? 1.5 : -3;
  const score = reward + (reliability - 50) * 0.16 + policyBonus;
  return ensembleModel(
    "蒸馏-FinRL集成",
    48 + score * 1.5 + Math.max(0, reliability - 55) * 0.2,
    clampNumber(reward, -Math.max(stop, target), target * 1.3),
    0.1,
    modelDirection > 0 || analogDirection > 0,
    `FinRL-style train/validate/trade ensemble: reward ${reward.toFixed(2)}, reliability ${reliability.toFixed(0)}%, policy ${strategyProb.toFixed(0)}%.`,
    { distilled: true, family: "finrl", score, reward, reliability, strategyProb },
  );
}

function metaLabelOosDistilledView({ analog, technicals, strategy }) {
  const model = analog?.model || {};
  const sampleCount = Number(model.sampleCount || 0);
  const oosSamples = Number(model.oosSampleCount || 0);
  if (sampleCount < 60 || oosSamples < 8) {
    return ensembleModel(
      "蒸馏-MetaLabel样本外",
      0,
      0,
      0.12,
      false,
      "Meta-label validation needs more walk-forward samples.",
    );
  }
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const predicted = finiteNumber(model.predictedReturn, 0);
  const directionAccuracy = finiteNumber(model.oosDirectionalAccuracy ?? model.directionalAccuracy, 0);
  const targetAccuracy = finiteNumber(model.oosTargetHitAccuracy ?? model.targetHitAccuracy, 0);
  const metaTrade = finiteNumber(model.metaLabelProbability, 0);
  const metaDirection = finiteNumber(model.metaDirectionalProbability, 0);
  const p80 = finiteNumber(model.conformalP80Error, 4);
  const p90 = finiteNumber(model.conformalP90Error, 6);
  const currentVolatility = finiteNumber(technicals?.volatility, 2);
  const uncertainty = p80 / Math.max(1, Math.abs(predicted), target * 0.35);
  let score = 0;
  score += (directionAccuracy - 50) * 0.28;
  score += (metaDirection - 50) * 0.24;
  score += (targetAccuracy - 50) * 0.12;
  score += (metaTrade - 45) * 0.1;
  score += Math.min(5, Math.abs(predicted) * 0.55);
  score -= Math.min(12, uncertainty * 5.5);
  if (p90 > Math.max(stop, target) * 1.25) score -= 4;
  if (currentVolatility > stop) score -= 3;
  const projected = predicted * clampNumber(1 - Math.min(0.45, uncertainty * 0.18), 0.55, 1);
  return ensembleModel(
    "蒸馏-MetaLabel样本外",
    50 + score * 1.45,
    clampNumber(projected, -Math.max(stop, target * 1.2), target * 1.35),
    0.12,
    true,
    `Meta-label/OOS review: direction ${directionAccuracy.toFixed(0)}%, meta-direction ${metaDirection.toFixed(0)}%, trade-label ${metaTrade.toFixed(0)}%, P80 error ${p80.toFixed(2)}%.`,
    { distilled: true, family: "meta-label", score, directionAccuracy, targetAccuracy, metaTrade, metaDirection, p80, p90, uncertainty },
  );
}

function evaluateLocalLinearHead(head, featureValues = {}) {
  if (head?.productionEligible !== true || !head?.active || !head.model?.weights || !head.model?.centers || !head.model?.scales) return null;
  const model = head.model;
  let value = finiteNumber(model.intercept, 0);
  for (const [name, weight] of Object.entries(model.weights || {})) {
    const raw = finiteNumber(featureValues[name], finiteNumber(model.centers?.[name], 0));
    const center = finiteNumber(model.centers?.[name], 0);
    const scale = Math.max(1e-9, finiteNumber(model.scales?.[name], 1));
    value += finiteNumber(weight, 0) * ((raw - center) / scale);
  }
  return Number(value.toFixed(4));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-clampNumber(Number(value || 0), -18, 18)));
}

function buildLocalModelFeatureValues({ technicals, analog, macroSignal, socialSignal, factor, strategy, preliminary = {} }) {
  const newsCount = finiteNumber(macroSignal?.checkedItems, 0);
  const socialCount = finiteNumber(socialSignal?.checkedItems, 0);
  const projectedFinalReturn = finiteNumber(preliminary.projectedFinalReturn ?? analog?.model?.predictedReturn ?? technicals?.projectedUpside, 0);
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const projectedMaxUpside = Math.max(
    0,
    finiteNumber(analog?.model?.predictedMaxUpside, 0),
    finiteNumber(analog?.averageMaxUpside, 0),
    projectedFinalReturn > 0 ? projectedFinalReturn * 1.15 : target * 0.25,
  );
  return {
    trend: finiteNumber(technicals?.trendScore, 50),
    momentum: finiteNumber(technicals?.momentumScore, 50),
    change5d: finiteNumber(technicals?.change5d, 0),
    change20d: finiteNumber(technicals?.change20d, 0),
    volumeRatio: finiteNumber(technicals?.volumeRatio, 1),
    rsi: finiteNumber(technicals?.rsi, 50),
    volume: finiteNumber(technicals?.volumeScore, 50),
    risk: finiteNumber(technicals?.riskScore, 50),
    factor: finiteNumber(factor?.score, 0),
    analogConfidence: finiteNumber(analog?.confidence, 0),
    modelConfidence: finiteNumber(analog?.model?.confidence, 0),
    newsCount,
    xCount: 0,
    youtubeCount: socialCount,
    factorCount: finiteNumber(factor?.checked, 0),
    upsideAgreement: finiteNumber(preliminary.upsideAgreement, 50),
    consensusAgreement: finiteNumber(preliminary.consensusAgreement, 50),
    predictionConfidence: finiteNumber(preliminary.confidence ?? analog?.model?.confidence ?? analog?.confidence, 50),
    strategyHitProbability: finiteNumber(analog?.strategyHitProbability ?? analog?.targetHitRate, 0),
    magnitudeHitProbability: finiteNumber(analog?.maxUpsideHitRate ?? analog?.targetHitRate, 0),
    projectedFinalReturn,
    projectedMaxUpside,
  };
}

function preliminaryModelConsensus(models = []) {
  const available = models.filter((model) => model.available && model.weight > 0);
  const totalWeight = available.reduce((sum, model) => sum + Number(model.weight || 0), 0) || 1;
  const weightedUpside = available.reduce((sum, model) => sum + Number(model.projectedUpside || 0) * (Number(model.weight || 0) / totalWeight), 0);
  const weightedConfidence = available.reduce((sum, model) => sum + Number(model.confidence || 0) * (Number(model.weight || 0) / totalWeight), 0);
  const directional = available.filter((model) => Math.abs(Number(model.projectedUpside || 0)) >= 0.15);
  const directionalWeight = directional.reduce((sum, model) => sum + Number(model.weight || 0) / totalWeight, 0) || 1;
  const upsideWeight = directional.filter((model) => Number(model.projectedUpside || 0) > 0).reduce((sum, model) => sum + Number(model.weight || 0) / totalWeight, 0);
  const downsideWeight = directional.filter((model) => Number(model.projectedUpside || 0) < 0).reduce((sum, model) => sum + Number(model.weight || 0) / totalWeight, 0);
  return {
    projectedFinalReturn: Number(weightedUpside.toFixed(3)),
    confidence: Number(weightedConfidence.toFixed(1)),
    upsideAgreement: Number((upsideWeight / directionalWeight * 100).toFixed(1)),
    consensusAgreement: Number((Math.max(upsideWeight, downsideWeight) / directionalWeight * 100).toFixed(1)),
  };
}

function localPythonSignalModelViews({ technicals, analog, macroSignal, socialSignal, factor, strategy, calibrationSummary, preliminary, modelScope = null }) {
  const scope = modelScope || localModelScopeForStrategy(calibrationSummary, strategy);
  const signalModels = scope.suite?.signalModels || calibrationSummary?.localSignalModels || {};
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const features = buildLocalModelFeatureValues({ technicals, analog, macroSignal, socialSignal, factor, strategy, preliminary });
  const views = [];
  const featurePrediction = evaluateLocalLinearHead(signalModels.featureScoreHead, features);
  if (featurePrediction != null) {
    const test = signalModels.featureScoreHead.test || {};
    const confidence = clampNumber(50 + finiteNumber(test.directionHitRate, 50) * 0.28 + finiteNumber(test.improvementPct, 0) * 0.5, 0, 92);
    views.push(ensembleModel(
      "Python-特征分模型",
      confidence,
      clampNumber(featurePrediction, -Math.max(target, 6), target * 1.35),
      0.07,
      true,
      `Local ridge head on technical/order features; OOS improvement ${finiteNumber(test.improvementPct, 0).toFixed(1)}%, direction ${finiteNumber(test.directionHitRate, 0).toFixed(0)}%.`,
      { family: "python-local", head: "feature_score_head", predictedReturn: featurePrediction, oosImprovement: finiteNumber(test.improvementPct, 0), featureValues: features, horizonBucket: scope.horizonBucket, modelScope: scope.source },
    ));
  }
  const factorPrediction = evaluateLocalLinearHead(signalModels.factorScoreHead, features);
  if (factorPrediction != null) {
    const test = signalModels.factorScoreHead.test || {};
    const confidence = clampNumber(50 + finiteNumber(test.directionHitRate, 50) * 0.28 + finiteNumber(test.improvementPct, 0) * 0.5, 0, 92);
    views.push(ensembleModel(
      "Python-因子分模型",
      confidence,
      clampNumber(factorPrediction, -Math.max(target, 6), target * 1.35),
      0.07,
      true,
      `Local ridge head on factor/news/history features; OOS improvement ${finiteNumber(test.improvementPct, 0).toFixed(1)}%, direction ${finiteNumber(test.directionHitRate, 0).toFixed(0)}%.`,
      { family: "python-local", head: "factor_score_head", predictedReturn: factorPrediction, oosImprovement: finiteNumber(test.improvementPct, 0), featureValues: features, horizonBucket: scope.horizonBucket, modelScope: scope.source },
    ));
  }
  const metaLogit = evaluateLocalLinearHead(signalModels.backtestMetaHead, features);
  if (metaLogit != null) {
    const probability = sigmoid(metaLogit) * 100;
    const test = signalModels.backtestMetaHead.test || {};
    const projected = (probability - 50) / 50 * target;
    views.push(ensembleModel(
      "Python-回测Meta模型",
      clampNumber(probability, 0, 92),
      clampNumber(projected, -target, target * 1.15),
      0.08,
      true,
      `Local logistic meta-label predicts target-before-stop ${probability.toFixed(0)}%; test Brier improvement ${finiteNumber(test.improvementPct, 0).toFixed(1)}%.`,
      { family: "python-local", head: "backtest_meta_head", targetHitProbability: Number(probability.toFixed(1)), oosImprovement: finiteNumber(test.improvementPct, 0), featureValues: features, horizonBucket: scope.horizonBucket, modelScope: scope.source },
    ));
  }
  const stopLogit = evaluateLocalLinearHead(signalModels.stopRiskHead, features);
  if (stopLogit != null) {
    const probability = sigmoid(stopLogit) * 100;
    const test = signalModels.stopRiskHead.test || {};
    const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
    views.push(ensembleModel(
      "Python-止损风险模型",
      clampNumber(probability, 0, 94),
      -clampNumber((probability / 100) * stop, 0, stop * 1.25),
      0.085,
      true,
      `Local stop-first meta model estimates stop risk ${probability.toFixed(0)}%; test Brier improvement ${finiteNumber(test.improvementPct, 0).toFixed(1)}%.`,
      { family: "python-local", head: "stop_risk_head", stopRiskProbability: Number(probability.toFixed(1)), oosImprovement: finiteNumber(test.improvementPct, 0), featureValues: features, horizonBucket: scope.horizonBucket, modelScope: scope.source },
    ));
  }
  const tradeQualityLogit = evaluateLocalLinearHead(signalModels.tradeQualityHead, features);
  if (tradeQualityLogit != null) {
    const probability = sigmoid(tradeQualityLogit) * 100;
    const test = signalModels.tradeQualityHead.test || {};
    const projected = (probability - 50) / 50 * target;
    views.push(ensembleModel(
      "Python-交易质量模型",
      clampNumber(probability, 0, 92),
      clampNumber(projected, -target, target * 1.2),
      0.075,
      true,
      `Local trade-quality model estimates target-before-stop quality ${probability.toFixed(0)}%; test Brier improvement ${finiteNumber(test.improvementPct, 0).toFixed(1)}%.`,
      { family: "python-local", head: "trade_quality_head", tradeQualityProbability: Number(probability.toFixed(1)), oosImprovement: finiteNumber(test.improvementPct, 0), featureValues: features, horizonBucket: scope.horizonBucket, modelScope: scope.source },
    ));
  }
  return views;
}

function evaluateSerializedLinearModel(model = {}, featureValues = {}) {
  if (!model?.weights || !model?.centers || !model?.scales) return null;
  let value = finiteNumber(model.intercept, 0);
  for (const [name, weight] of Object.entries(model.weights || {})) {
    const raw = finiteNumber(featureValues[name], finiteNumber(model.centers?.[name], 0));
    const center = finiteNumber(model.centers?.[name], 0);
    const scale = Math.max(1e-9, finiteNumber(model.scales?.[name], 1));
    value += finiteNumber(weight, 0) * ((raw - center) / scale);
  }
  return Number(value.toFixed(4));
}

function modelZooCommitteeView({ technicals, analog, macroSignal, socialSignal, factor, strategy, calibrationSummary, preliminary, modelScope = null }) {
  const scope = modelScope || localModelScopeForStrategy(calibrationSummary, strategy);
  const zoo = scope.suite?.modelZoo || calibrationSummary?.modelZoo || {};
  const candidates = Array.isArray(zoo.candidates) ? zoo.candidates : [];
  if (zoo.productionEligible !== true || !zoo.active || !candidates.length) {
    return ensembleModel(
      "模型委员会-OOS",
      0,
      0,
      0.12,
      false,
      zoo.reason || "Model-zoo committee remains Research/Shadow-only until its production sample and rolling-window gates pass.",
      { family: "model-zoo", status: zoo.status || "collecting", productionEligible: false, horizonBucket: scope.horizonBucket, modelScope: scope.source },
    );
  }
  const features = buildLocalModelFeatureValues({ technicals, analog, macroSignal, socialSignal, factor, strategy, preliminary });
  const weights = zoo.deploymentWeights || {};
  const target = Math.max(1, finiteNumber(strategy?.targetUpside, 5));
  const stop = Math.max(1, Math.abs(finiteNumber(strategy?.stopLoss, 4)));
  const predictions = [];
  for (const candidate of candidates) {
    const weight = finiteNumber(weights[candidate.name], finiteNumber(candidate.weight, 0));
    if (weight <= 0.01) continue;
    let predicted = null;
    if (candidate.name === "stored_ensemble") {
      predicted = finiteNumber(preliminary?.projectedFinalReturn ?? analog?.model?.predictedReturn ?? technicals?.projectedUpside, 0);
    } else if (candidate.kind === "ridge_regression" && candidate.model) {
      predicted = evaluateSerializedLinearModel(candidate.model, features);
    } else if (candidate.kind === "target_stop_logistic" && candidate.targetModel && candidate.stopModel) {
      const targetLogit = evaluateSerializedLinearModel(candidate.targetModel, features);
      const stopLogit = evaluateSerializedLinearModel(candidate.stopModel, features);
      if (targetLogit != null && stopLogit != null) {
        const targetProb = sigmoid(targetLogit);
        const stopProb = sigmoid(stopLogit);
        predicted = (targetProb - 0.5) * target * 2.25 - Math.max(0, stopProb - 0.35) * stop * 1.35 + (targetProb - stopProb) * 0.8;
      }
    } else if (candidate.name === "sequence_state_proxy") {
      const trend = (finiteNumber(features.trend, 50) - 50) / 50;
      const momentum = (finiteNumber(features.momentum, 50) - 50) / 50;
      const change5 = finiteNumber(features.change5d, 0) / 8;
      const change20 = finiteNumber(features.change20d, 0) / 18;
      const volumeAccel = finiteNumber(features.volumeAccel, 0);
      const pressure = finiteNumber(features.pressureChange, 0) + finiteNumber(features.buyPressure5, 0) * 0.7;
      const profile = -finiteNumber(features.profileDistance, 0) / 5;
      const liquidity = -Math.max(0, finiteNumber(features.liquidityShock, 0)) * 0.18;
      const agreement = (finiteNumber(features.upsideAgreement, 50) - 50) / 50;
      predicted = trend * 1.1 + momentum * 1.0 + change20 * 1.2 + change5 * 0.7 + volumeAccel * 0.42 + pressure * 0.95 + profile * 0.55 + agreement * 0.65 + liquidity;
    }
    if (predicted == null || !Number.isFinite(Number(predicted))) continue;
    predictions.push({
      name: candidate.name,
      label: candidate.label || candidate.name,
      weight,
      predicted: clampNumber(Number(predicted), -Math.max(stop, target * 1.8), target * 1.8),
      directionHitRate: finiteNumber(candidate.test?.directionHitRate, 0),
    });
  }
  if (!predictions.length) {
    return ensembleModel(
      "模型委员会-OOS",
      0,
      0,
      0.12,
      false,
      "Model-zoo is active, but no serializable candidate can be evaluated for this live symbol yet.",
      { family: "model-zoo", status: "no_serializable_candidate", horizonBucket: scope.horizonBucket, modelScope: scope.source },
    );
  }
  const totalWeight = predictions.reduce((sum, row) => sum + Math.max(0, row.weight), 0) || 1;
  const projected = predictions.reduce((sum, row) => sum + row.predicted * (row.weight / totalWeight), 0);
  const dispersion = Math.sqrt(predictions.reduce((sum, row) => sum + ((row.predicted - projected) ** 2) * (row.weight / totalWeight), 0));
  const test = zoo.test || {};
  const rejectGate = zoo.rejectGate || {};
  const acceptedLift = finiteNumber(rejectGate.acceptedDirectionHitRate, 0) - finiteNumber(rejectGate.allDirectionHitRate, 0);
  const residualPenalty = Math.max(0, finiteNumber(zoo.averageResidualCorrelation, 0) - 0.72) * 18;
  const confidence = clampNumber(
    45
      + finiteNumber(test.directionHitRate, 50) * 0.32
      + Math.max(0, finiteNumber(zoo.testImprovementVsEqualPct, 0)) * 0.42
      + Math.max(0, acceptedLift) * 0.18
      - dispersion * 2.1
      - residualPenalty,
    0,
    92,
  );
  const activeCount = predictions.filter((row) => row.weight > 0.025).length;
  return ensembleModel(
    "模型委员会-OOS",
    confidence,
    projected,
    clampNumber(0.09 + finiteNumber(zoo.deploymentBlend, 0) * 0.18, 0.08, 0.18),
    activeCount >= 2,
    `Model-zoo committee ${zoo.status}; test direction ${finiteNumber(test.directionHitRate, 0).toFixed(0)}%, MSE lift vs equal ${finiteNumber(zoo.testImprovementVsEqualPct, 0).toFixed(1)}%, dispersion ${dispersion.toFixed(2)}.`,
    {
      family: "model-zoo",
      status: zoo.status,
      activeCandidateCount: activeCount,
      deploymentBlend: finiteNumber(zoo.deploymentBlend, 0),
      projected,
      dispersion,
      rejectGate,
      residualCorrelation: finiteNumber(zoo.averageResidualCorrelation, 0),
      stability: zoo.stability || null,
      horizonBucket: scope.horizonBucket,
      modelScope: scope.source,
      candidates: predictions.slice(0, 8),
    },
  );
}

function localNoTradeEvidenceFromEnsemble(ensemble = {}) {
  const models = Array.isArray(ensemble.models) ? ensemble.models : [];
  const stopRisks = models
    .map((model) => Number(model?.values?.stopRiskProbability))
    .filter((value) => Number.isFinite(value));
  const tradeQualities = models
    .map((model) => Number(model?.values?.tradeQualityProbability ?? model?.values?.targetHitProbability))
    .filter((value) => Number.isFinite(value));
  const stopRiskProbability = stopRisks.length ? Math.max(...stopRisks) : null;
  const tradeQualityProbability = tradeQualities.length ? Math.max(...tradeQualities) : null;
  const zooRows = models.filter((model) => model?.values?.family === "model-zoo" && model.available);
  const zooRisk = zooRows.map((model) => {
    const dispersion = Number(model.values?.dispersion);
    const threshold = Number(model.values?.rejectGate?.threshold);
    if (!Number.isFinite(dispersion) || !Number.isFinite(threshold) || threshold <= 0) return null;
    return {
      dispersion,
      threshold,
      blocked: dispersion > threshold,
    };
  }).filter(Boolean);
  const modelZooBlocked = zooRisk.some((row) => row.blocked);
  const modelZooDispersion = zooRisk.length ? Math.max(...zooRisk.map((row) => row.dispersion)) : null;
  const modelZooThreshold = zooRisk.length ? Math.max(...zooRisk.map((row) => row.threshold)) : null;
  return {
    active: stopRiskProbability != null || tradeQualityProbability != null || zooRisk.length > 0,
    stopRiskProbability,
    tradeQualityProbability,
    modelZooBlocked,
    modelZooDispersion,
    modelZooThreshold,
  };
}

function rebalanceModelAgreementWeights(models = []) {
  const active = models.filter((model) => model.available && model.weight > 0 && Math.abs(Number(model.projectedUpside || 0)) >= 0.15);
  if (active.length < 3) return { majority: "mixed", agreementRatio: 0, boosted: 0 };
  const upsideCount = active.filter((model) => Number(model.projectedUpside || 0) > 0).length;
  const downsideCount = active.filter((model) => Number(model.projectedUpside || 0) < 0).length;
  const majority = upsideCount >= downsideCount ? "upside" : "downside";
  const agreementCount = majority === "upside" ? upsideCount : downsideCount;
  const agreementRatio = agreementCount / active.length;
  let boosted = 0;
  for (const model of models) {
    model.baseWeight = model.weight;
    if (!model.available || model.weight <= 0 || Math.abs(Number(model.projectedUpside || 0)) < 0.15) continue;
    const direction = Number(model.projectedUpside || 0) > 0 ? "upside" : "downside";
    if (direction === majority && agreementRatio >= 0.55) {
      const familyBoost = model.values?.family === "meta-label" ? 0.12 : model.values?.distilled ? 0.08 : 0.03;
      const uncertaintyPenalty = model.values?.family === "meta-label" && Number(model.values?.uncertainty || 0) > 1.6 ? 0.08 : 0;
      const boost = clampNumber((agreementRatio - 0.5) * 0.72 + familyBoost - uncertaintyPenalty, 0.03, 0.38);
      model.weight = Number((model.weight * (1 + boost)).toFixed(4));
      model.values = { ...(model.values || {}), agreementBoost: Number(boost.toFixed(3)) };
      boosted += 1;
    } else if (agreementRatio >= 0.68) {
      const cut = clampNumber((agreementRatio - 0.58) * 0.45, 0.02, 0.18);
      model.weight = Number((model.weight * (1 - cut)).toFixed(4));
      model.values = { ...(model.values || {}), agreementCut: Number(cut.toFixed(3)) };
    }
  }
  return { majority, agreementRatio: Number((agreementRatio * 100).toFixed(0)), boosted };
}

function buildModelEnsemble({ technicals, analog, macroSignal, socialSignal, factor, factors, fundamentals, strategy, calibrationSummary }) {
  const marketProfile = marketRegimeProfile(factors, technicals);
  const horizonModelScope = localModelScopeForStrategy(calibrationSummary, strategy);
  const techScores = [
    technicals?.trendScore,
    technicals?.momentumScore,
    technicals?.volumeScore,
    technicals?.riskScore,
  ].map((value) => finiteNumber(value, 50));
  const technicalScore = techScores.reduce((sum, value) => sum + value, 0) / techScores.length;
  const targetUpside = finiteNumber(strategy?.targetUpside, 5);
  const analogCount = Number(analog?.count || 0);
  const modelSampleCount = Number(analog?.model?.sampleCount || 0);
  const analogHitRate = finiteNumber(analog?.targetHitRate ?? analog?.winRate, 0);
  const analogDirectionHitRate = finiteNumber(analog?.directionalHitRate ?? analog?.winRate, 0);
  const analogStrategyHitProbability = finiteNumber(analog?.strategyHitProbability ?? analog?.targetHitRate ?? analog?.winRate, 0);
  const analogRiskAdjustedReturn = finiteNumber(analog?.averageRiskAdjustedReturn ?? analog?.averageForwardReturn, 0);
  const analogMaxUpside = finiteNumber(analog?.averageMaxUpside, 0);
  const analogMaxUpsideHitRate = finiteNumber(analog?.maxUpsideHitRate ?? analog?.targetHitRate ?? analog?.winRate, 0);
  const analogStopRate = finiteNumber(analog?.stopRate, 0);
  const modelTargetHitAccuracy = finiteNumber(analog?.model?.targetHitAccuracy ?? analog?.model?.directionalAccuracy, 0);
  const modelMaxUpsideHitAccuracy = finiteNumber(analog?.model?.maxUpsideHitAccuracy ?? analog?.model?.oosMaxUpsideHitAccuracy ?? analog?.model?.targetHitAccuracy, 0);
  const modelDirectionalAccuracy = finiteNumber(analog?.model?.directionalAccuracy, 0);
  const modelPredictedReturn = finiteNumber(analog?.model?.predictedReturn, 0);
  const modelPredictedMaxUpside = finiteNumber(analog?.model?.predictedMaxUpside, 0);
  const analogCoverageScore = finiteNumber(analog?.coverageScore, analogCount ? 55 : 0);
  const modelCoverageScore = finiteNumber(analog?.model?.coverageScore, modelSampleCount ? 55 : 0);
  const analogCoverageMultiplier = clampNumber(analogCoverageScore / 70, 0.32, 1.08);
  const modelCoverageMultiplier = clampNumber(modelCoverageScore / 70, 0.32, 1.08);
  const sampleCoverageScore = Math.max(analogCoverageScore, modelCoverageScore);
  const macroChecked = Number(macroSignal?.checkedItems || 0);
  const socialChecked = Number(socialSignal?.checkedItems || 0);
  const factorChecked = Number(factor?.checked || 0);
  const analogReliable = analogCount >= 5;
  const modelReliable = modelSampleCount >= 60;
  const samplePower = Math.max(
    analogReliable ? Math.min(0.45, analogCount / 18) * analogCoverageMultiplier : 0,
    modelReliable ? Math.min(0.85, modelSampleCount / 260) * modelCoverageMultiplier : 0,
  );
  const reliabilityInputs = [
    analogReliable ? { value: analogDirectionHitRate, weight: Math.min(0.45, analogCount / 18) * analogCoverageMultiplier } : null,
    modelReliable ? { value: modelDirectionalAccuracy || modelTargetHitAccuracy, weight: Math.min(0.85, modelSampleCount / 260) * modelCoverageMultiplier } : null,
  ].filter(Boolean);
  const strategyInputs = [
    analogReliable ? { value: analogStrategyHitProbability, weight: Math.min(0.45, analogCount / 18) * analogCoverageMultiplier } : null,
    modelReliable ? { value: modelTargetHitAccuracy, weight: Math.min(0.85, modelSampleCount / 260) * modelCoverageMultiplier } : null,
  ].filter(Boolean);
  const reliabilityWeight = reliabilityInputs.reduce((sum, item) => sum + item.weight, 0) || 1;
  const strategyWeight = strategyInputs.reduce((sum, item) => sum + item.weight, 0) || 1;
  const historyReliability = reliabilityInputs.length
    ? reliabilityInputs.reduce((sum, item) => sum + item.value * item.weight, 0) / reliabilityWeight
    : 0;
  const strategyHitProbability = strategyInputs.length
    ? strategyInputs.reduce((sum, item) => sum + item.value * item.weight, 0) / strategyWeight
    : 0;
  const historySupportsUpside = (
    (analogReliable && analogCoverageScore >= 45 && analogStrategyHitProbability >= 52 && analogRiskAdjustedReturn > 0 && analogStopRate <= 42)
    || (modelReliable && modelCoverageScore >= 45 && modelTargetHitAccuracy >= 56 && modelPredictedReturn > targetUpside * 0.2)
    || (analogReliable && analogCoverageScore >= 45 && analogMaxUpsideHitRate >= 56 && analogMaxUpside >= targetUpside * 0.45 && analogStopRate <= 45)
    || (modelReliable && modelCoverageScore >= 45 && modelMaxUpsideHitAccuracy >= 58 && modelPredictedMaxUpside >= targetUpside * 0.5)
  );
  const historyWarnsUpside = (
    (analogReliable && (analogCoverageScore < 35 || analogStrategyHitProbability < 38 || analogRiskAdjustedReturn < -0.45 || analogStopRate >= 48))
    || (modelReliable && (modelCoverageScore < 35 || (modelTargetHitAccuracy < 52 && modelPredictedReturn < targetUpside * 0.2)))
    || (modelReliable && modelMaxUpsideHitAccuracy < 48 && modelPredictedMaxUpside < targetUpside * 0.35)
  );
  const models = [
    strategyTargetModelView({ analog, strategy }),
    ensembleModel(
      "技术面模型",
      technicalScore,
      finiteNumber(technicals?.projectedUpside, 0),
      0.2,
      true,
      `Trend ${finiteNumber(technicals?.trendScore, 50).toFixed(0)}, momentum ${finiteNumber(technicals?.momentumScore, 50).toFixed(0)}, volume ${finiteNumber(technicals?.volumeScore, 50).toFixed(0)}, risk ${finiteNumber(technicals?.riskScore, 50).toFixed(0)}.`,
    ),
    ensembleModel(
      "历史相似模型",
      finiteNumber(analog?.confidence, 0),
      finiteNumber(analog?.averageRiskAdjustedReturn ?? analog?.averageForwardReturn, 0),
      0.22,
      analogCount > 0,
      analogCount ? `${analogCount} similar windows, directional hit rate ${analogDirectionHitRate.toFixed(0)}%, strategy target hit rate ${analogStrategyHitProbability.toFixed(0)}%, max-upside touch hit ${analogMaxUpsideHitRate.toFixed(0)}%, stop-first rate ${analogStopRate.toFixed(0)}%.` : "Not enough similar historical windows.",
      { count: analogCount, winRate: finiteNumber(analog?.winRate, 0), directionalHitRate: analogDirectionHitRate, targetHitRate: analogHitRate, strategyHitProbability: analogStrategyHitProbability, maxUpsideHitRate: analogMaxUpsideHitRate, averageMaxUpside: analogMaxUpside, stopRate: analogStopRate },
    ),
    ensembleModel(
      "自监督回测模型",
      finiteNumber(analog?.model?.confidence, 0),
      modelPredictedReturn,
      0.18,
      modelSampleCount > 0,
      modelSampleCount ? `${modelSampleCount} walk-forward samples, target-hit accuracy ${modelTargetHitAccuracy.toFixed(0)}%, max-upside hit ${modelMaxUpsideHitAccuracy.toFixed(0)}%, directional accuracy ${finiteNumber(analog?.model?.directionalAccuracy, 0).toFixed(0)}%, MAE ${finiteNumber(analog?.model?.mae, 0).toFixed(2)}%.` : "Self-supervised sample set is still too small.",
      { sampleCount: modelSampleCount, targetHitAccuracy: modelTargetHitAccuracy, maxUpsideHitAccuracy: modelMaxUpsideHitAccuracy, predictedMaxUpside: modelPredictedMaxUpside, directionalAccuracy: finiteNumber(analog?.model?.directionalAccuracy, 0), mae: finiteNumber(analog?.model?.mae, 0) },
    ),
    ensembleModel(
      "新闻社媒模型",
      50 + finiteNumber(macroSignal?.score, 0) * 1.1 + finiteNumber(socialSignal?.score, 0) * 0.75,
      finiteNumber(macroSignal?.score, 0) * 0.07 + finiteNumber(socialSignal?.score, 0) * 0.04,
      0.08,
      macroChecked + socialChecked > 0,
      macroChecked + socialChecked ? `News ${macroSignal?.stance || "mixed"}, social ${socialSignal?.stance || "mixed"}; checked ${macroChecked + socialChecked} items.` : "No fresh news/social items available.",
      { macroScore: finiteNumber(macroSignal?.score, 0), socialScore: finiteNumber(socialSignal?.score, 0), checked: macroChecked + socialChecked },
    ),
    ensembleModel(
      "因子模型",
      50 + finiteNumber(factor?.score, 0) * 1.45,
      finiteNumber(factor?.score, 0) * 0.12,
      0.16,
      factorChecked > 0,
      factorChecked ? `Factor stance ${factor?.stance || "mixed"}, score ${finiteNumber(factor?.score, 0).toFixed(1)}, groups ${factorChecked}.` : "No live factor groups available.",
      { score: finiteNumber(factor?.score, 0), checked: factorChecked },
    ),
    marketRegimeModelView(marketProfile, strategy),
    freqtradeDistilledView({ technicals, analog, factor, strategy }),
    leanFrameworkDistilledView({ technicals, factor, strategy }),
    backtraderIndicatorDistilledView({ technicals, strategy }),
    hummingbotExecutionDistilledView({ technicals, strategy }),
    finrlEnsembleDistilledView({ technicals, analog, macroSignal, factor, strategy }),
    metaLabelOosDistilledView({ analog, technicals, strategy }),
    openSourceStrategyReviewView({ technicals, analog, factor, strategy }),
    breakoutVolatilityView(technicals, strategy),
    riskRewardView(technicals, strategy),
    fundamentalsView(fundamentals),
  ];
  const localSignalViews = localPythonSignalModelViews({
    technicals,
    analog,
    macroSignal,
    socialSignal,
    factor,
    strategy,
    calibrationSummary,
    preliminary: preliminaryModelConsensus(models),
    modelScope: horizonModelScope,
  });
  if (localSignalViews.length) {
    models.push(...localSignalViews);
  }
  const zooView = modelZooCommitteeView({
    technicals,
    analog,
    macroSignal,
    socialSignal,
    factor,
    strategy,
    calibrationSummary,
    preliminary: preliminaryModelConsensus(models),
    modelScope: horizonModelScope,
  });
  if (zooView) {
    models.push(zooView);
  }
  const performanceWeightAdjusted = applyPerformanceAndRegimeWeights(models, calibrationSummary, marketProfile);
  const agreementWeighting = rebalanceModelAgreementWeights(models);
  const optimizedWeighting = applyOptimizedEnsembleWeights(models, calibrationSummary, strategy, horizonModelScope);
  const doubleCheckWeighting = applyExternalDoubleCheckCaps(models);
  const available = models.filter((model) => model.available && model.weight > 0);
  const totalWeight = available.reduce((sum, model) => sum + model.weight, 0) || 1;
  for (const model of models) {
    model.normalizedWeight = model.available && model.weight > 0 ? Number((model.weight / totalWeight).toFixed(4)) : 0;
  }
  const weightedConfidence = models.reduce((sum, model) => sum + model.confidence * model.normalizedWeight, 0);
  const weightedUpside = models.reduce((sum, model) => sum + model.projectedUpside * model.normalizedWeight, 0);
  const directional = models.filter((model) => model.normalizedWeight > 0 && Math.abs(model.projectedUpside) >= 0.15);
  const directionalWeight = directional.reduce((sum, model) => sum + model.normalizedWeight, 0) || 1;
  const upsideWeight = directional.filter((model) => model.projectedUpside > 0).reduce((sum, model) => sum + model.normalizedWeight, 0);
  const downsideWeight = directional.filter((model) => model.projectedUpside < 0).reduce((sum, model) => sum + model.normalizedWeight, 0);
  const upsideAgreement = upsideWeight / directionalWeight;
  const consensusAgreement = Math.max(upsideWeight, downsideWeight) / directionalWeight;
  const directionalStrength = Math.abs(weightedUpside);
  const targetFit = weightedUpside >= 0
    ? Math.max(-5, Math.min(7, (directionalStrength - targetUpside * 0.3) * 0.9))
    : Math.max(-4, Math.min(7, (directionalStrength - targetUpside * 0.18) * 0.9));
  const agreementAdjustment = (consensusAgreement - 0.5) * 18;
  const upsideMean = weightedUpside;
  const dispersion = Math.sqrt(models.reduce((sum, model) => sum + ((model.projectedUpside - upsideMean) ** 2) * model.normalizedWeight, 0));
  const disagreementPenalty = Math.min(9, dispersion * 1.15);
  const evidenceBonus = Math.min(5, Math.log10(Math.max(1, analogCount + modelSampleCount + macroChecked + socialChecked + factorChecked)) * 2.4);
  const confidence = Math.max(0, Math.min(99, Math.round(weightedConfidence + agreementAdjustment + targetFit + evidenceBonus - disagreementPenalty)));
  const availableModelCount = models.filter((model) => model.available && model.normalizedWeight > 0).length;
  return {
    confidence,
    projectedUpside: Number(weightedUpside.toFixed(2)),
    configuredFactorScore: Number(finiteNumber(factor?.score, 0).toFixed(3)),
    factorConfigApplied: Boolean(factor?.configApplied),
    enabledFactors: factor?.enabledFactors || [],
    availableModelCount,
    upsideAgreement: Number((upsideAgreement * 100).toFixed(0)),
    consensusAgreement: Number((consensusAgreement * 100).toFixed(0)),
    direction: upsideWeight >= downsideWeight ? "upside" : "downside",
    targetFit: Number(targetFit.toFixed(2)),
    disagreementPenalty: Number(disagreementPenalty.toFixed(2)),
    evidenceBonus: Number(evidenceBonus.toFixed(2)),
    agreementWeighting,
    optimizedWeighting,
    horizonModelScope: {
      horizonBucket: horizonModelScope.horizonBucket,
      horizonDays: horizonModelScope.horizonDays,
      source: horizonModelScope.source,
      sampleCount: horizonModelScope.sampleCount,
      minSamples: horizonModelScope.minSamples,
      reason: horizonModelScope.reason,
    },
    doubleCheckWeighting,
    weightingMethod: optimizedWeighting.applied ? "oos-optimized-simplex" : "prior-performance-regime",
    marketRegime: marketProfile,
    performanceWeightAdjusted,
    historyGate: {
      samplePower: Number(samplePower.toFixed(2)),
      reliability: Number(historyReliability.toFixed(1)),
      strategyHitProbability: Number(strategyHitProbability.toFixed(1)),
      analogDirectionalHitRate: Number(analogDirectionHitRate.toFixed(1)),
      analogTargetHitRate: Number(analogHitRate.toFixed(1)),
      analogStopRate: Number(analogStopRate.toFixed(1)),
      modelDirectionalAccuracy: Number(modelDirectionalAccuracy.toFixed(1)),
      modelTargetHitAccuracy: Number(modelTargetHitAccuracy.toFixed(1)),
      analogMaxUpside: Number(analogMaxUpside.toFixed(2)),
      analogMaxUpsideHitRate: Number(analogMaxUpsideHitRate.toFixed(1)),
      modelPredictedMaxUpside: Number(modelPredictedMaxUpside.toFixed(2)),
      modelMaxUpsideHitAccuracy: Number(modelMaxUpsideHitAccuracy.toFixed(1)),
      supportsUpside: historySupportsUpside,
      blocksUpside: historyWarnsUpside,
      modelPredictedReturn: Number(modelPredictedReturn.toFixed(2)),
      analogRiskAdjustedReturn: Number(analogRiskAdjustedReturn.toFixed(2)),
      sampleCoverageScore: Number(sampleCoverageScore.toFixed(1)),
      analogCoverageScore: Number(analogCoverageScore.toFixed(1)),
      modelCoverageScore: Number(modelCoverageScore.toFixed(1)),
    },
    models,
  };
}

function conservativeForecastCalibration({ ensemble, score, projectedUpsideRaw, targetUpside, targetConfidence, marketValidation, calibration, strategyCalibration, walkForwardCalibration, market }) {
  const availableModelCount = Number(ensemble.availableModelCount || 0);
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const disagreement = Number(ensemble.disagreementPenalty || 0);
  const evidenceBonus = Number(ensemble.evidenceBonus || 0);
  const historyGate = ensemble.historyGate || {};
  const target = Math.max(1, Number(targetUpside || 5));
  const minTradeConfidence = Math.max(Number(targetConfidence || 80), 72);
  const marketRegime = ensemble.marketRegime || {};
  const marketKey = safeMarket(market || ensemble.market || marketValidation?.market || "ASX");
  const stricterMarket = marketKey === "ASX" || marketKey === "US";
  const baseStrategyProbabilityTarget = stricterMarket ? Math.max(60, Number(targetConfidence || 80) - 7) : Math.max(55, Number(targetConfidence || 80) - 10);
  const strategyProbabilityTarget = Math.max(stricterMarket ? 60 : 55, Math.min(stricterMarket ? 76 : 68, baseStrategyProbabilityTarget)) + Number(marketRegime.buyThresholdBonus || 0);
  const historySamplePower = Number(historyGate.samplePower || 0);
  const historyReliability = Number(historyGate.reliability || 0);
  const historyCoverageScore = Number(historyGate.sampleCoverageScore || Math.max(Number(historyGate.analogCoverageScore || 0), Number(historyGate.modelCoverageScore || 0)) || 0);
  const rawStrategyHitProbability = Number(historyGate.strategyHitProbability || 0);
  const strategyHitProbability = strategyCalibration?.sampleCount >= 5
    ? Number(strategyCalibration.probability || rawStrategyHitProbability)
    : rawStrategyHitProbability;
  const historyOkForBuy = historySamplePower >= 0.25
    && strategyHitProbability >= strategyProbabilityTarget
    && historyReliability >= 52
    && !historyGate.blocksUpside;
  const walkValues = walkForwardCalibration?.values || {};
  const walkSamples = Number(walkValues.samples || 0);
  const walkHitRate = Number(walkValues.hitRate || 0);
  const walkStopRate = Number(walkValues.stopRate || 0);
  const walkAvgReturn = Number(walkValues.avgReturn || 0);
  const minWalkSamples = stricterMarket ? 12 : 8;
  const walkBacktestPassed = walkSamples >= minWalkSamples
    && walkHitRate >= Math.max(52, strategyProbabilityTarget - 8)
    && walkStopRate <= 46
    && walkAvgReturn > -0.15;
  const oosBacktestPassed = historyOkForBuy
    && historyReliability >= 52
    && strategyHitProbability >= strategyProbabilityTarget
    && historySamplePower >= 0.32;
  const positiveNeedsBacktest = Number(projectedUpsideRaw || 0) > 0;
  const backtestPassed = !positiveNeedsBacktest || walkBacktestPassed || oosBacktestPassed;
  const noTradeEvidence = localNoTradeEvidenceFromEnsemble(ensemble);
  const stopRiskLimit = stricterMarket ? 62 : 68;
  const minTradeQuality = Math.max(stricterMarket ? 55 : 50, strategyProbabilityTarget - (stricterMarket ? 8 : 10));
  const noTradeReasons = [];
  let noTradeBlocked = false;
  if (noTradeEvidence.stopRiskProbability != null && Number(noTradeEvidence.stopRiskProbability) >= stopRiskLimit) {
    noTradeBlocked = true;
    noTradeReasons.push(`本地止损风险模型过高 ${Number(noTradeEvidence.stopRiskProbability).toFixed(0)}% / 上限 ${stopRiskLimit}%`);
  }
  if (noTradeEvidence.tradeQualityProbability != null && Number(noTradeEvidence.tradeQualityProbability) < minTradeQuality) {
    noTradeBlocked = true;
    noTradeReasons.push(`本地交易质量不足 ${Number(noTradeEvidence.tradeQualityProbability).toFixed(0)}% / 要求 ${minTradeQuality.toFixed(0)}%`);
  }
  if (noTradeEvidence.modelZooBlocked) {
    noTradeBlocked = true;
    noTradeReasons.push(`模型委员会分歧过高 ${Number(noTradeEvidence.modelZooDispersion || 0).toFixed(2)} / 阈值 ${Number(noTradeEvidence.modelZooThreshold || 0).toFixed(2)}`);
  }

  let shrink = 0.68;
  if (consensus >= 82 && upsideAgreement >= 70) shrink += 0.14;
  else if (consensus >= 72 && upsideAgreement >= 62) shrink += 0.07;
  else if (consensus < 64) shrink -= 0.18;
  if (availableModelCount >= 5) shrink += 0.07;
  else if (availableModelCount < 4) shrink -= 0.12;
  if (evidenceBonus >= 3) shrink += 0.05;
  if (disagreement > 5) shrink -= Math.min(0.18, (disagreement - 5) * 0.035);
  if (marketValidation?.degraded) shrink -= 0.1;
  if (marketValidation?.shortHistory) shrink -= 0.18;
  if (historyCoverageScore > 0 && historyCoverageScore < 45 && Number(projectedUpsideRaw || 0) > 0) shrink -= 0.16;
  if (marketRegime.upsideShrink && Number(projectedUpsideRaw || 0) > 0) shrink *= Number(marketRegime.upsideShrink || 1);
  if (calibration?.sampleCount >= 5 && Number(calibration.confidence || 0) < Number(score || 0)) shrink -= 0.05;
  if (Number(projectedUpsideRaw || 0) > 0 && historySamplePower >= 0.25) {
    if (historyOkForBuy) shrink += 0.05;
    else shrink -= stricterMarket ? 0.24 : 0.18;
  }
  if (positiveNeedsBacktest && !backtestPassed) shrink -= stricterMarket ? 0.24 : 0.18;
  if (positiveNeedsBacktest && walkSamples >= minWalkSamples && walkHitRate < 50) shrink -= 0.12;
  if (positiveNeedsBacktest && walkStopRate > 48) shrink -= 0.08;
  if (positiveNeedsBacktest && noTradeBlocked) shrink -= stricterMarket ? 0.18 : 0.14;
  if (
    positiveNeedsBacktest
    && !noTradeBlocked
    && noTradeEvidence.stopRiskProbability != null
    && Number(noTradeEvidence.stopRiskProbability) >= stopRiskLimit - 6
  ) {
    shrink -= 0.07;
  }
  shrink = clampNumber(shrink, stricterMarket ? 0.36 : 0.42, 0.9);

  const positiveCap = consensus >= 82 && upsideAgreement >= 70
    ? target * 1.55
    : consensus >= 70 && upsideAgreement >= 62
      ? target * 1.25
      : target * (stricterMarket ? 0.82 : 0.95);
  const negativeCap = Math.max(4, target * 1.25);
  let projectedUpside = Number(projectedUpsideRaw || 0) * shrink;
  projectedUpside = projectedUpside >= 0
    ? Math.min(projectedUpside, positiveCap)
    : Math.max(projectedUpside, -negativeCap);

  let confidenceCap = 92;
  const reasons = [];
  if (availableModelCount < 4) {
    confidenceCap = Math.min(confidenceCap, 68);
    reasons.push("可用模型少于4个");
  }
  if (consensus < 58) {
    confidenceCap = Math.min(confidenceCap, 62);
    reasons.push("模型共识不足58%");
  } else if (consensus < 66) {
    confidenceCap = Math.min(confidenceCap, 75);
    reasons.push("模型共识不足66%");
  }
  if (disagreement > 6) {
    confidenceCap = Math.min(confidenceCap, 78);
    reasons.push("模型分歧较高");
  }
  if (marketValidation?.degraded) {
    confidenceCap = Math.min(confidenceCap, 75);
    reasons.push("行情仅单源真实数据");
  }
  if (marketValidation?.shortHistory) {
    confidenceCap = Math.min(confidenceCap, 55);
    reasons.push(`新上市/短历史：仅 ${Number(marketValidation.candleCount || 0)} 根K线，完整回测不足`);
  }
  if (marketRegime.regime === "downtrend") {
    confidenceCap = Math.min(confidenceCap, 72);
    reasons.push("市场环境为下跌趋势");
  } else if (marketRegime.regime === "volatile") {
    confidenceCap = Math.min(confidenceCap, 76);
    reasons.push("市场环境高波动");
  }
  if (!calibration || Number(calibration.sampleCount || 0) < 5) {
    confidenceCap = Math.min(confidenceCap, 84);
    reasons.push("历史校准样本仍在收集");
  }
  if (historyCoverageScore > 0 && historyCoverageScore < 45) {
    confidenceCap = Math.min(confidenceCap, 60);
    reasons.push(`历史样本覆盖不足 ${historyCoverageScore.toFixed(0)}/100`);
  }
  if (Number(projectedUpsideRaw || 0) > 0 && historySamplePower < 0.25) {
    reasons.push("样本外策略达标验证不足");
  } else if (Number(projectedUpsideRaw || 0) > 0 && !historyOkForBuy) {
    if (historyReliability > 0 && historyReliability < 45) confidenceCap = Math.min(confidenceCap, 58);
    reasons.push(`策略达标概率不足 ${strategyHitProbability ? `${strategyHitProbability.toFixed(0)}%` : "样本不足"} / 目标 ${strategyProbabilityTarget.toFixed(0)}%`);
  }
  if (positiveNeedsBacktest && !backtestPassed) {
    confidenceCap = Math.min(confidenceCap, walkSamples >= minWalkSamples ? 58 : 55);
    reasons.push(walkSamples >= minWalkSamples
      ? `本地walk-forward回测未达标：${walkHitRate.toFixed(0)}%命中、${walkStopRate.toFixed(0)}%先止损`
      : `本地walk-forward回测样本不足：${walkSamples}/${minWalkSamples}`);
  }
  if (positiveNeedsBacktest && walkSamples >= minWalkSamples && walkHitRate < 50) {
    confidenceCap = Math.min(confidenceCap, 52);
    reasons.push(`回测命中率低于50%，禁止高置信正向预测`);
  }
  if (positiveNeedsBacktest && walkStopRate > 52) {
    confidenceCap = Math.min(confidenceCap, 54);
    reasons.push(`历史同类信号先止损率过高 ${walkStopRate.toFixed(0)}%`);
  }
  if (noTradeBlocked) {
    confidenceCap = Math.min(confidenceCap, stricterMarket ? 54 : 58);
    reasons.push(...noTradeReasons);
  } else if (
    noTradeEvidence.stopRiskProbability != null
    && Number(noTradeEvidence.stopRiskProbability) >= stopRiskLimit - 6
  ) {
    confidenceCap = Math.min(confidenceCap, 66);
    reasons.push(`本地止损风险接近上限 ${Number(noTradeEvidence.stopRiskProbability).toFixed(0)}%`);
  }

  let confidenceBonus = 0;
  if (consensus >= 76 && availableModelCount >= 5 && disagreement <= 4) confidenceBonus += 2;
  if (calibration?.sampleCount >= 5 && Number(calibration.confidence || 0) >= Number(score || 0)) confidenceBonus += 1.5;
  if (historyOkForBuy && consensus >= 66) confidenceBonus += 2;
  const confidence = Math.round(Math.min(confidenceCap, Number(score || 0) + confidenceBonus));
  const minBuyConsensus = stricterMarket ? 66 : 62;
  const minBuyUpsideAgreement = stricterMarket ? 62 : 58;
  const maxBuyDisagreement = stricterMarket ? 6.8 : 7.5;
  const buyEligible = confidence >= minTradeConfidence
    && projectedUpside >= Math.max(0.8, target * 0.35)
    && consensus >= minBuyConsensus
    && upsideAgreement >= minBuyUpsideAgreement
    && availableModelCount >= 4
    && disagreement <= maxBuyDisagreement
    && strategyHitProbability >= strategyProbabilityTarget
    && historyOkForBuy
    && backtestPassed
    && (historyCoverageScore === 0 || historyCoverageScore >= 45)
    && !marketValidation?.shortHistory
    && !noTradeBlocked;

  return {
    confidence,
    projectedUpside: Number(projectedUpside.toFixed(2)),
    projectedUpsideCap: Number(positiveCap.toFixed(2)),
    shrink: Number(shrink.toFixed(2)),
    confidenceCap,
    minTradeConfidence,
    strategyProbabilityTarget: Number(strategyProbabilityTarget.toFixed(1)),
    strategyHitProbability: Number(strategyHitProbability.toFixed(1)),
    rawStrategyHitProbability: Number(rawStrategyHitProbability.toFixed(1)),
    strategyCalibration,
    buyEligible,
    blocked: !buyEligible,
    reasons,
    minBuyConsensus,
    minBuyUpsideAgreement,
    maxBuyDisagreement,
    noTradeGate: {
      active: noTradeEvidence.active,
      blocked: noTradeBlocked,
      stopRiskProbability: noTradeEvidence.stopRiskProbability == null ? null : Number(Number(noTradeEvidence.stopRiskProbability).toFixed(1)),
      tradeQualityProbability: noTradeEvidence.tradeQualityProbability == null ? null : Number(Number(noTradeEvidence.tradeQualityProbability).toFixed(1)),
      modelZooDispersion: noTradeEvidence.modelZooDispersion == null ? null : Number(Number(noTradeEvidence.modelZooDispersion).toFixed(2)),
      modelZooThreshold: noTradeEvidence.modelZooThreshold == null ? null : Number(Number(noTradeEvidence.modelZooThreshold).toFixed(2)),
      stopRiskLimit,
      minTradeQuality: Number(minTradeQuality.toFixed(1)),
      reasons: noTradeReasons,
      framework: "python-local-no-trade-meta-gate",
    },
    historyGate: {
      ...historyGate,
      okForBuy: historyOkForBuy,
      strategyHitProbability: Number(strategyHitProbability.toFixed(1)),
      rawStrategyHitProbability: Number(rawStrategyHitProbability.toFixed(1)),
      sampleCoverageScore: Number(historyCoverageScore.toFixed(1)),
    },
    backtestGate: {
      passed: backtestPassed,
      walkForwardPassed: walkBacktestPassed,
      oosPassed: oosBacktestPassed,
      samples: walkSamples,
      minSamples: minWalkSamples,
      hitRate: Number(walkHitRate.toFixed(1)),
      stopRate: Number(walkStopRate.toFixed(1)),
      avgReturn: Number(walkAvgReturn.toFixed(2)),
      requiredHitRate: Number(Math.max(52, strategyProbabilityTarget - 8).toFixed(1)),
      reason: backtestPassed ? "passed" : "positive forecast blocked until walk-forward/OOS validation improves",
      shortHistoryBlocked: Boolean(marketValidation?.shortHistory),
    },
  };
}

function directionalConfidenceMetrics(ensemble = {}, confidence = 0, projectedUpside = 0) {
  const value = clampNumber(Number(confidence || 0), 0, 99);
  const upsideAgreement = clampNumber(Number(ensemble.upsideAgreement ?? 50), 0, 100);
  const consensus = clampNumber(Number(ensemble.consensusAgreement ?? 50), 0, 100);
  const direction = Number(projectedUpside || 0) < -0.35
    ? "downside"
    : Number(projectedUpside || 0) > 0.35
      ? "upside"
      : ensemble.direction || "mixed";
  const downsideAgreement = clampNumber(100 - upsideAgreement, 0, 100);
  const upsideConfidence = direction === "upside"
    ? value
    : clampNumber(Math.round((100 - value) * 0.22 + upsideAgreement * 0.38), 0, 99);
  const downsideConfidence = direction === "downside"
    ? value
    : clampNumber(Math.round((100 - value) * 0.22 + downsideAgreement * 0.38 + Math.max(0, -Number(projectedUpside || 0)) * 4), 0, 99);
  return {
    direction,
    predictionConfidence: value,
    upsideConfidence,
    downsideConfidence,
    directionAgreement: direction === "downside" ? Math.max(downsideAgreement, consensus) : direction === "upside" ? Math.max(upsideAgreement, consensus) : consensus,
  };
}

function projectedMoveConfidenceMetrics({ projectedUpside = 0, ensemble = {}, analog = {}, confidence = 0, strategy = {}, conservative = {} }) {
  const projected = Number(projectedUpside || 0);
  const expectedMove = Math.abs(projected);
  const direction = projected < -0.35 ? "downside" : projected > 0.35 ? "upside" : "neutral";
  const consensus = clampNumber(Number(ensemble.consensusAgreement || 0), 0, 100);
  const directionAgreement = direction === "upside"
    ? clampNumber(Number(ensemble.upsideAgreement || consensus || 50), 0, 100)
    : direction === "downside"
      ? clampNumber(Math.max(100 - Number(ensemble.upsideAgreement || 50), consensus), 0, 100)
      : consensus || 50;
  const examples = Array.isArray(analog?.examples) ? analog.examples : [];
  const analogHits = expectedMove >= 0.25 && examples.length
    ? examples.filter((row) => (
      direction === "upside"
        ? Number(row.maxUpside ?? row.forwardReturn ?? 0) >= expectedMove * 0.88
        : direction === "downside"
          ? Math.abs(Number(row.maxDrawdown ?? row.forwardReturn ?? 0)) >= expectedMove * 0.88
          : Math.abs(Number(row.forwardReturn || 0)) <= Math.max(0.5, expectedMove)
    )).length / examples.length * 100
    : null;
  const model = analog?.model || {};
  const modelReturn = Number(model.predictedReturn || 0);
  const modelSameDirection = direction === "neutral" || Math.sign(modelReturn) === Math.sign(projected);
  const modelDistance = Math.abs(modelReturn - projected);
  const modelUncertainty = Number(model.conformalP80Error ?? model.mae ?? 2.5);
  const modelBase = Number(model.sampleCount || 0) > 0
    ? clampNumber(
      Number(model.confidence || 0) * 0.32
        + Number(model.directionalAccuracy || model.oosDirectionalAccuracy || 0) * 0.24
        + Number(model.targetHitAccuracy || model.oosTargetHitAccuracy || 0) * 0.12
        + (modelSameDirection ? 14 : -12)
        - modelDistance * 5.2
        - modelUncertainty * 2.1
        - Math.max(0, expectedMove - Math.abs(modelReturn)) * 2.8,
      0,
      92,
    )
    : null;
  const target = Math.max(1, Number(strategy?.targetUpside || 5));
  const strategyProbability = Number(conservative?.strategyHitProbability || ensemble.historyGate?.strategyHitProbability || analog?.strategyHitProbability || 0);
  const strategyComparable = direction === "upside" && strategyProbability > 0
    ? clampNumber(strategyProbability + (target - expectedMove) * 3.2, 0, 90)
    : null;
  const weightedInputs = [
    analogHits != null ? { value: analogHits, weight: Math.min(0.45, Math.max(0.18, examples.length / 18)) } : null,
    modelBase != null ? { value: modelBase, weight: Math.min(0.5, Math.max(0.22, Number(model.sampleCount || 0) / 420)) } : null,
    strategyComparable != null ? { value: strategyComparable, weight: expectedMove <= target * 1.15 ? 0.18 : 0.08 } : null,
    { value: Number(confidence || 0) * 0.45 + directionAgreement * 0.32, weight: 0.18 },
  ].filter(Boolean);
  const totalWeight = weightedInputs.reduce((sum, row) => sum + row.weight, 0) || 1;
  let probability = weightedInputs.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
  if (expectedMove >= target * 1.2) probability -= Math.min(12, (expectedMove - target * 1.2) * 2.6);
  if (Number(conservative?.shrink || 1) < 0.65 && expectedMove > 0) probability -= 4;
  probability = clampNumber(probability, 0, 92);
  return {
    probability: Number(probability.toFixed(1)),
    direction,
    expectedMove: Number(expectedMove.toFixed(2)),
    analogHitRate: analogHits == null ? null : Number(analogHits.toFixed(1)),
    modelMagnitudeProbability: modelBase == null ? null : Number(modelBase.toFixed(1)),
    modelUncertainty: Number((Number.isFinite(modelUncertainty) ? modelUncertainty : 0).toFixed(2)),
    modelDistance: Number(modelDistance.toFixed(2)),
    basis: examples.length ? "analog+model" : modelBase != null ? "model" : "ensemble",
  };
}

function projectedMaxUpsideConfidenceMetrics({ projectedFinalReturn = 0, ensemble = {}, analog = {}, confidence = 0, strategy = {}, conservative = {} }) {
  const target = Math.max(1, Number(strategy?.targetUpside || 5));
  const consensus = clampNumber(Number(ensemble.consensusAgreement || 0), 0, 100);
  const upsideAgreement = clampNumber(Number(ensemble.upsideAgreement || 0), 0, 100);
  const examples = Array.isArray(analog?.examples) ? analog.examples : [];
  const averageAnalogMax = finiteNumber(analog?.averageMaxUpside, examples.length ? mean(examples.map((row) => Math.max(0, Number(row.maxUpside || 0)))) : 0);
  const model = analog?.model || {};
  const modelMax = finiteNumber(model.predictedMaxUpside, 0);
  const modelAccuracy = finiteNumber(model.maxUpsideHitAccuracy ?? model.oosMaxUpsideHitAccuracy ?? model.targetHitAccuracy, 0);
  const modelUncertainty = finiteNumber(model.maxUpsideMae ?? model.conformalP80Error ?? model.mae, 2.8);
  const baseMax = Math.max(
    0,
    Number(projectedFinalReturn || 0),
    averageAnalogMax * (Number(model.sampleCount || 0) ? 0.58 : 0.75) + modelMax * (Number(model.sampleCount || 0) ? 0.42 : 0),
    target * 0.35,
  );
  const cap = target * (consensus >= 82 && upsideAgreement >= 70 ? 1.85 : consensus >= 70 && upsideAgreement >= 62 ? 1.55 : 1.22);
  const projectedMaxUpside = Number(clampNumber(baseMax, 0, Math.max(0.8, cap)).toFixed(2));
  const analogHitRate = projectedMaxUpside >= 0.25 && examples.length
    ? examples.filter((row) => Math.max(0, Number(row.maxUpside || 0)) >= projectedMaxUpside * 0.88).length / examples.length * 100
    : null;
  const modelProbability = Number(model.sampleCount || 0) > 0
    ? clampNumber(
      modelAccuracy * 0.42
        + finiteNumber(model.metaMaxUpsideProbability, 0) * 0.18
        + Number(model.confidence || 0) * 0.16
        + upsideAgreement * 0.12
        - Math.max(0, projectedMaxUpside - modelMax) * 3.2
        - modelUncertainty * 1.6,
      0,
      92,
    )
    : null;
  const strategyComparable = Number(conservative?.strategyHitProbability || ensemble.historyGate?.strategyHitProbability || analog?.strategyHitProbability || 0);
  const weightedInputs = [
    analogHitRate != null ? { value: analogHitRate, weight: Math.min(0.45, Math.max(0.18, examples.length / 18)) } : null,
    modelProbability != null ? { value: modelProbability, weight: Math.min(0.5, Math.max(0.22, Number(model.sampleCount || 0) / 420)) } : null,
    strategyComparable > 0 ? { value: clampNumber(strategyComparable + (target - projectedMaxUpside) * 2.4, 0, 90), weight: projectedMaxUpside <= target * 1.15 ? 0.18 : 0.09 } : null,
    { value: Number(confidence || 0) * 0.34 + upsideAgreement * 0.34 + consensus * 0.12, weight: 0.2 },
  ].filter(Boolean);
  const totalWeight = weightedInputs.reduce((sum, row) => sum + row.weight, 0) || 1;
  let probability = weightedInputs.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
  if (projectedMaxUpside >= target * 1.35) probability -= Math.min(10, (projectedMaxUpside - target * 1.35) * 2.5);
  if (Number(conservative?.shrink || 1) < 0.65) probability -= 3;
  probability = clampNumber(probability, 0, 92);
  return {
    projectedMaxUpside,
    probability: Number(probability.toFixed(1)),
    analogHitRate: analogHitRate == null ? null : Number(analogHitRate.toFixed(1)),
    modelProbability: modelProbability == null ? null : Number(modelProbability.toFixed(1)),
    modelUncertainty: Number(modelUncertainty.toFixed(2)),
    basis: examples.length ? "analog-max+model" : modelProbability != null ? "model-max" : "ensemble",
  };
}

function projectedMaxDownsideConfidenceMetrics({ projectedFinalReturn = 0, ensemble = {}, analog = {}, confidence = 0, strategy = {}, conservative = {} }) {
  const stop = Math.max(1, Math.abs(Number(strategy?.stopLoss || 4)));
  const consensus = clampNumber(Number(ensemble.consensusAgreement || 0), 0, 100);
  const upsideAgreement = clampNumber(Number(ensemble.upsideAgreement || 0), 0, 100);
  const downsideAgreement = clampNumber(100 - upsideAgreement, 0, 100);
  const examples = Array.isArray(analog?.examples) ? analog.examples : [];
  const averageAnalogDrawdown = Math.abs(finiteNumber(
    analog?.averageMaxDrawdown,
    examples.length ? mean(examples.map((row) => Math.min(0, Number(row.maxDrawdown || 0)))) : 0,
  ));
  const model = analog?.model || {};
  const modelDrawdown = Math.abs(finiteNumber(model.predictedMaxDrawdown, 0));
  const modelAccuracy = finiteNumber(model.maxDrawdownHitAccuracy ?? model.oosMaxDrawdownHitAccuracy ?? model.stopHitAccuracy, 0);
  const modelUncertainty = finiteNumber(model.maxDrawdownMae ?? model.conformalP80Error ?? model.mae, 2.8);
  const weightedPathDrawdown = Number(model.sampleCount || 0) && modelDrawdown > 0
    ? averageAnalogDrawdown * 0.58 + modelDrawdown * 0.42
    : averageAnalogDrawdown;
  const baseMax = Math.max(0, -Number(projectedFinalReturn || 0), weightedPathDrawdown, stop * 0.35);
  const cap = stop * (downsideAgreement >= 70 && consensus >= 76 ? 1.85 : downsideAgreement >= 55 ? 1.5 : 1.22);
  const projectedMaxDownside = Number(clampNumber(baseMax, 0, Math.max(0.8, cap)).toFixed(2));
  const analogHitRate = projectedMaxDownside >= 0.25 && examples.length
    ? examples.filter((row) => Math.abs(Math.min(0, Number(row.maxDrawdown || 0))) >= projectedMaxDownside * 0.88).length / examples.length * 100
    : null;
  const modelProbability = Number(model.sampleCount || 0) > 0 && modelDrawdown > 0
    ? clampNumber(
      modelAccuracy * 0.42
        + finiteNumber(model.metaMaxDrawdownProbability, 0) * 0.18
        + Number(model.confidence || 0) * 0.12
        + downsideAgreement * 0.16
        - Math.max(0, projectedMaxDownside - modelDrawdown) * 3.2
        - modelUncertainty * 1.6,
      0,
      92,
    )
    : null;
  const stopRiskProbability = finiteNumber(conservative?.noTradeGate?.stopRiskProbability, 0);
  const directionalRisk = Number(projectedFinalReturn || 0) < 0 ? Number(confidence || 0) : Math.max(0, 100 - Number(confidence || 0));
  const weightedInputs = [
    analogHitRate != null ? { value: analogHitRate, weight: Math.min(0.45, Math.max(0.18, examples.length / 18)) } : null,
    modelProbability != null ? { value: modelProbability, weight: Math.min(0.5, Math.max(0.22, Number(model.sampleCount || 0) / 420)) } : null,
    stopRiskProbability > 0 ? { value: stopRiskProbability, weight: 0.24 } : null,
    { value: directionalRisk * 0.5 + downsideAgreement * 0.34 + (100 - consensus) * 0.12, weight: 0.2 },
  ].filter(Boolean);
  const totalWeight = weightedInputs.reduce((sum, row) => sum + row.weight, 0) || 1;
  let probability = weightedInputs.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
  if (projectedMaxDownside >= stop * 1.2) probability -= Math.min(10, (projectedMaxDownside - stop * 1.2) * 2.5);
  if (Number(conservative?.shrink || 1) < 0.65 && Number(projectedFinalReturn || 0) >= 0) probability -= 2;
  probability = clampNumber(probability, 0, 92);
  return {
    projectedMaxDownside,
    probability: Number(probability.toFixed(1)),
    analogHitRate: analogHitRate == null ? null : Number(analogHitRate.toFixed(1)),
    modelProbability: modelProbability == null ? null : Number(modelProbability.toFixed(1)),
    modelUncertainty: Number(modelUncertainty.toFixed(2)),
    basis: examples.length ? "analog-drawdown+model" : modelProbability != null ? "model-drawdown" : "ensemble-risk",
  };
}

function localAnalysis(input) {
  const { symbol, strategy, technicals, analog, fundamentals, xPosts = [], youtubeItems = [], news = [], factors, marketValidation, holding } = input;
  const market = safeMarket(input.market || "ASX");
  const code = cleanCode(symbol, market);
  const macroSignal = newsSignal(news, code, market);
  const socialItems = [
    ...xPosts.map((post) => ({ title: post.text, description: "", channel: post.channel })),
    ...youtubeItems.map((video) => ({ title: video.title, description: video.description, channel: video.channel })),
  ];
  const socialSignal = newsSignal(socialItems, code, market);
  const factor = factorSignal(factors, input.researchConfig?.factorConfig, technicals);
  const ensemble = buildModelEnsemble({ technicals, analog, macroSignal, socialSignal, factor, factors, fundamentals, strategy, calibrationSummary: input.calibrationSummary });
  const confidencePenalty = marketValidation?.degraded ? Number(process.env.SINGLE_SOURCE_CONFIDENCE_PENALTY || 5) : 0;
  const targetConfidence = Number(strategy?.confidence || 80);
  const targetUpside = Number(strategy?.targetUpside || 5);
  const positiveAgreement = ensemble.direction === "upside" && ensemble.consensusAgreement >= 70;
  const negativeAgreement = ensemble.direction === "downside" && ensemble.consensusAgreement >= 70;
  const adaptiveCandidate = {
    action: positiveAgreement ? "WATCH_BUY" : "HOLD_WATCH",
    confidence: ensemble.confidence,
    rawConfidence: ensemble.confidence,
    projectedUpside: ensemble.projectedUpside,
    targetUpside,
    horizonDays: Number(strategy?.horizonDays || 15),
    featureScores: {
      trend: technicals.trendScore,
      momentum: technicals.momentumScore,
      volume: technicals.volumeScore,
      risk: technicals.riskScore,
      factor: factor.score,
      analogConfidence: analog?.confidence || 0,
    },
    signalCounts: {
      news: news.length,
      x: xPosts.length,
      youtube: youtubeItems.length,
      factors: factor.checked,
    },
    ensemble: {
      direction: ensemble.direction,
      upsideAgreement: ensemble.upsideAgreement,
      consensusAgreement: ensemble.consensusAgreement,
    },
  };
  const adaptive = adaptiveForecastAdjustment(input.calibrationSummary, normalizeMarketSymbol(symbol, market) || symbol, Number(strategy?.horizonDays || 15), adaptiveCandidate);
  const adaptivePenalty = Number(adaptive.confidencePenalty || 0);
  const score = Math.max(0, Math.min(99, Math.round(ensemble.confidence - confidencePenalty - adaptivePenalty)));
  const calibration = calibrateConfidenceValue(score, input.calibrationSummary);
  const strategyCalibration = calibrateStrategyProbabilityValue(ensemble.historyGate?.strategyHitProbability || 0, input.calibrationSummary);
  const projectedUpsideRaw = ensemble.projectedUpside * Number(adaptive.upsideShrink || 1);
  const preConservativeScore = calibration.sampleCount >= 5 ? calibration.confidence : score;
  const conservative = conservativeForecastCalibration({
    ensemble,
    score: preConservativeScore,
    projectedUpsideRaw: marketValidation?.degraded ? projectedUpsideRaw * 0.75 : projectedUpsideRaw,
    targetUpside,
    targetConfidence,
    marketValidation,
    calibration,
    strategyCalibration,
    walkForwardCalibration: factors?.calibration,
    market,
  });
  const calibratedScore = conservative.confidence;
  const projectedUpside = conservative.projectedUpside;
  const directional = directionalConfidenceMetrics(ensemble, calibratedScore, projectedUpside);
  const magnitude = projectedMoveConfidenceMetrics({ projectedUpside, ensemble, analog, confidence: calibratedScore, strategy, conservative });
  const maxUpside = projectedMaxUpsideConfidenceMetrics({ projectedFinalReturn: projectedUpside, ensemble, analog, confidence: calibratedScore, strategy, conservative });
  const maxDownside = projectedMaxDownsideConfidenceMetrics({ projectedFinalReturn: projectedUpside, ensemble, analog, confidence: calibratedScore, strategy, conservative });
  const cycleTargetMove = Math.max(0, projectedUpside, maxUpside.projectedMaxUpside * 0.72);
  const action = conservative.buyEligible && calibratedScore >= targetConfidence && cycleTargetMove >= targetUpside
    ? "WATCH_BUY"
    : calibratedScore <= 42
      ? "AVOID_OR_REDUCE"
      : "HOLD_WATCH";

  return {
    symbol,
    action,
    confidence: calibratedScore,
    predictionConfidence: directional.predictionConfidence,
    magnitudeConfidence: magnitude.probability,
    magnitudeHitProbability: magnitude.probability,
    moveHitProbability: magnitude.probability,
    projectedMoveConfidence: magnitude.probability,
    projectedFinalReturn: projectedUpside,
    finalReturnConfidence: magnitude.probability,
    finalReturnHitProbability: magnitude.probability,
    projectedMaxUpside: maxUpside.projectedMaxUpside,
    maxUpsideConfidence: maxUpside.probability,
    maxUpsideHitProbability: maxUpside.probability,
    projectedMaxDownside: maxDownside.projectedMaxDownside,
    maxDownsideConfidence: maxDownside.probability,
    maxDownsideHitProbability: maxDownside.probability,
    strategyConfidence: Number(conservative.strategyHitProbability || 0),
    strategyHitProbability: Number(conservative.strategyHitProbability || 0),
    upsideConfidence: directional.upsideConfidence,
    downsideConfidence: directional.downsideConfidence,
    direction: directional.direction,
    directionAgreement: directional.directionAgreement,
    rawConfidence: score,
    featureScores: adaptiveCandidate.featureScores,
    factorSignal: factor,
    calibration,
    strategyCalibration,
    ensemble: {
      ...ensemble,
      configuredFactorScore: Number(factor.score.toFixed(3)),
      factorConfigApplied: factor.configApplied,
      enabledFactors: factor.enabledFactors,
      disabledFactors: factor.disabledFactors,
      confidenceAfterDataPenalty: score,
      calibratedConfidence: calibratedScore,
      dataPenalty: confidencePenalty,
      conservativeShrink: conservative.shrink,
      confidenceCap: conservative.confidenceCap,
      adaptivePenalty,
      adaptiveUpsideShrink: adaptive.upsideShrink,
      adaptivePatternPenalty: adaptive.patternPenalty,
      adaptiveMatchedPatterns: adaptive.matchedPatterns,
      strategyProbabilityTarget: conservative.strategyProbabilityTarget,
      noTradeGate: conservative.noTradeGate,
      magnitudeHitProbability: magnitude.probability,
      magnitudeBasis: magnitude.basis,
      projectedMaxUpside: maxUpside.projectedMaxUpside,
      maxUpsideHitProbability: maxUpside.probability,
      maxUpsideBasis: maxUpside.basis,
      projectedMaxDownside: maxDownside.projectedMaxDownside,
      maxDownsideHitProbability: maxDownside.probability,
      maxDownsideBasis: maxDownside.basis,
    },
    qualityGate: {
      ...conservative,
      magnitudeHitProbability: magnitude.probability,
      magnitudeExpectedMove: magnitude.expectedMove,
      magnitudeAnalogHitRate: magnitude.analogHitRate,
      magnitudeModelProbability: magnitude.modelMagnitudeProbability,
      magnitudeModelUncertainty: magnitude.modelUncertainty,
      magnitudeBasis: magnitude.basis,
      finalReturnHitProbability: magnitude.probability,
      projectedMaxUpside: maxUpside.projectedMaxUpside,
      maxUpsideHitProbability: maxUpside.probability,
      maxUpsideAnalogHitRate: maxUpside.analogHitRate,
      maxUpsideModelProbability: maxUpside.modelProbability,
      maxUpsideModelUncertainty: maxUpside.modelUncertainty,
      maxUpsideBasis: maxUpside.basis,
      projectedMaxDownside: maxDownside.projectedMaxDownside,
      maxDownsideHitProbability: maxDownside.probability,
      maxDownsideAnalogHitRate: maxDownside.analogHitRate,
      maxDownsideModelProbability: maxDownside.modelProbability,
      maxDownsideModelUncertainty: maxDownside.modelUncertainty,
      maxDownsideBasis: maxDownside.basis,
    },
    projectedUpside,
    horizonDays: Number(strategy?.horizonDays || 15),
    thesis: [
      technicals.macdHistogram > 0 ? "MACD histogram is positive." : "MACD histogram is not yet confirming upside.",
      technicals.volumeRatio >= 1.2 ? "Volume is above recent average." : "Volume is not meaningfully above average.",
      technicals.rsi >= 45 && technicals.rsi <= 68 ? "RSI is in a constructive range." : "RSI suggests either weak momentum or crowding.",
      `Multi-model ensemble: ${ensemble.direction} consensus ${ensemble.consensusAgreement}%, upside agreement ${ensemble.upsideAgreement}%, raw target confidence ${ensemble.confidence}%.`,
      `Model cross-check: evidence bonus ${finiteNumber(ensemble.evidenceBonus, 0).toFixed(1)}%, disagreement penalty ${finiteNumber(ensemble.disagreementPenalty, 0).toFixed(1)}%.`,
      ensemble.doubleCheckWeighting?.externalModelCount
        ? `External double-check cap: open-source/distilled models are limited to ${Number(ensemble.doubleCheckWeighting.externalShare || 0).toFixed(1)}% live weight; local models remain the primary forecast driver.`
        : "External double-check cap: no external/distilled model is carrying live weight.",
      adaptive.reasons.length ? `Adaptive learning: ${adaptive.reasons.join("；")}。旧预测会保留到周期结束并持续校准短/中/长期参数。` : "Adaptive learning: no material penalty from prior forecast outcomes yet.",
      `Conservative calibration: projected upside shrink ${conservative.shrink}x, confidence cap ${conservative.confidenceCap}%, ${conservative.buyEligible ? "high-conviction gate passed" : `high-conviction gate blocked (${conservative.reasons.join("、") || "证据仍不足"})`}.`,
      conservative.noTradeGate?.active
        ? `No-Trade meta gate: ${conservative.noTradeGate.blocked ? "blocked" : "passed"}; stop-risk ${conservative.noTradeGate.stopRiskProbability == null ? "n/a" : `${Number(conservative.noTradeGate.stopRiskProbability).toFixed(0)}%`} / limit ${conservative.noTradeGate.stopRiskLimit}%, trade-quality ${conservative.noTradeGate.tradeQualityProbability == null ? "n/a" : `${Number(conservative.noTradeGate.tradeQualityProbability).toFixed(0)}%`} / required ${Number(conservative.noTradeGate.minTradeQuality || 0).toFixed(0)}%.`
        : "No-Trade meta gate: local stop-risk/trade-quality heads are still collecting samples.",
      `Backtest gate: ${conservative.backtestGate?.passed ? "passed" : "blocked"}; local walk-forward ${conservative.backtestGate?.samples || 0}/${conservative.backtestGate?.minSamples || 0} samples, hit ${Number(conservative.backtestGate?.hitRate || 0).toFixed(0)}%, stop-first ${Number(conservative.backtestGate?.stopRate || 0).toFixed(0)}%. Positive forecasts cannot become buy signals unless walk-forward/OOS validation passes.`,
      `Final-return label: expected ${projectedUpside >= 0 ? "+" : ""}${projectedUpside.toFixed(2)}% by day ${Number(strategy?.horizonDays || 15)}, final-return hit probability ${magnitude.probability.toFixed(0)}% (${magnitude.basis}).`,
      `Max-upside label: expected intraperiod high touch ${maxUpside.projectedMaxUpside.toFixed(2)}%, touch probability ${maxUpside.probability.toFixed(0)}% (${maxUpside.basis}, analog ${maxUpside.analogHitRate == null ? "n/a" : `${maxUpside.analogHitRate.toFixed(0)}%`}, model ${maxUpside.modelProbability == null ? "n/a" : `${maxUpside.modelProbability.toFixed(0)}%`}).`,
      `Max-downside label: expected intraperiod adverse touch -${maxDownside.projectedMaxDownside.toFixed(2)}%, touch probability ${maxDownside.probability.toFixed(0)}% (${maxDownside.basis}, analog ${maxDownside.analogHitRate == null ? "n/a" : `${maxDownside.analogHitRate.toFixed(0)}%`}, model ${maxDownside.modelProbability == null ? "n/a" : `${maxDownside.modelProbability.toFixed(0)}%`}).`,
      `Strategy target label: target-before-stop probability ${Number(conservative.strategyHitProbability || 0).toFixed(0)}% / required ${Number(conservative.strategyProbabilityTarget || 0).toFixed(0)}%; ${strategyCalibration?.sampleCount >= 5 ? strategyCalibration.message : "strategy probability calibration is still collecting resolved samples"}.`,
      `Market regime model: ${ensemble.marketRegime?.regime || "range"} / ${ensemble.marketRegime?.riskLevel || "neutral"}, threshold bonus ${Number(ensemble.marketRegime?.buyThresholdBonus || 0).toFixed(0)}%, upside shrink ${Math.round(Number(ensemble.marketRegime?.upsideShrink || 1) * 100)}%.`,
      positiveAgreement ? "Most available models agree on upside direction." : negativeAgreement ? "Most available models agree on downside risk." : "Forecast engines are mixed; confidence is constrained.",
      analog?.count ? `Historical analogs: ${analog.count} similar windows, average ${Number(analog.averageForwardReturn || 0).toFixed(2)}% over the strategy horizon, win rate ${Number(analog.winRate || 0).toFixed(0)}%.` : "Not enough historical analog windows were available.",
      ensemble.historyGate?.samplePower >= 0.25
        ? `Reliability split: directional reliability ${Number(ensemble.historyGate.reliability || 0).toFixed(0)}%, strategy-hit probability ${Number(ensemble.historyGate.strategyHitProbability || 0).toFixed(0)}%, analog target-hit ${Number(ensemble.historyGate.analogTargetHitRate || 0).toFixed(0)}%, analog max-upside hit ${Number(ensemble.historyGate.analogMaxUpsideHitRate || 0).toFixed(0)}%, self-supervised max-upside hit ${Number(ensemble.historyGate.modelMaxUpsideHitAccuracy || 0).toFixed(0)}%; ${ensemble.historyGate.supportsUpside ? "supports upside" : ensemble.historyGate.blocksUpside ? "blocks upside" : "neutral"}.`
        : "Strategy hit validation: not enough out-of-sample history to lift confidence.",
      `Sample coverage: ${Number(ensemble.historyGate?.sampleCoverageScore || 0).toFixed(0)}/100 (analog ${Number(ensemble.historyGate?.analogCoverageScore || 0).toFixed(0)}, model ${Number(ensemble.historyGate?.modelCoverageScore || 0).toFixed(0)}); low coverage means the current setup is treated as out-of-distribution and cannot lift buy confidence.`,
      fundamentals ? `Fundamentals checked: PE ${fundamentals.peRatio || "n/a"}, dividend yield ${fundamentals.dividendYield || "n/a"}, beta ${fundamentals.beta || "n/a"}.` : "Fundamental data was not available from the configured provider.",
      news.length ? `Macro/industry/news signal: ${macroSignal.stance}, score ${macroSignal.score}, checked ${macroSignal.checkedItems} multi-source items across direct, peer, upstream, sector, macro, and global channels.` : "No fresh macro or company news was available from the configured provider.",
      ...(macroSignal.influences || []).slice(0, 3).map((item) => `News impact ${item.channel || "mixed"} (${item.source || "source"}, weight ${item.weight}): ${item.title}`),
      xPosts.length ? `X signal: ${socialSignal.stance}, checked ${xPosts.length} posts across leaders, macro, and sector queries.` : "X recent search is not configured or returned no posts.",
      youtubeItems.length ? `YouTube signal checked ${youtubeItems.length} trending/search videos.` : "YouTube Data API is not configured or returned no videos.",
      factor.checked ? `Factor layer: ${factor.stance}, score ${factor.score}, checked ${factor.checked} live factor groups.` : "Factor layer did not have enough available inputs.",
      factor.configApplied ? `Research configuration evidence: configured score ${factor.configScore}, enabled ${factor.enabledFactors.join(", ") || "none"}, disabled ${factor.disabledFactors.join(", ") || "none"}.` : "Research factor configuration has not been applied.",
      ...factor.notes.slice(0, 3),
      calibration.sampleCount >= 5 ? `Calibration layer: raw confidence ${score}%, calibrated to ${calibratedScore}%. ${calibration.message}` : "Calibration layer is collecting resolved samples before it adjusts confidence.",
      holding ? `Portfolio focus: currently held ${holding.qty} shares at ${input.currency || MARKET_CONFIG[market].currency} ${Number(holding.avgPrice || 0).toFixed(2)}, held for ${holding.holdingDays || 0} days.` : "No current holding in this symbol.",
      marketValidation?.degraded ? "Market data is from one real provider only; confidence is penalized." : "Market data passed the configured source validation.",
    ],
    risks: [
      "This is a rules-based estimate, not financial advice.",
      "Main-force positioning is only a price-volume proxy unless you connect licensed order-flow data.",
      "Liquidity, gaps, earnings dates, and macro shocks can invalidate a 15-day setup quickly.",
    ],
  };
}

function strategyDecision(analysis, input) {
  const strategy = input.strategy || {};
  const technicals = input.technicals || {};
  const capital = input.capital || {};
  const confidence = Math.max(0, Math.min(99, Math.round(Number(analysis.confidence || 0))));
  const projectedUpside = Number(Number(analysis.projectedUpside || 0).toFixed(2));
  const projectedFinalReturn = Number(Number(analysis.projectedFinalReturn ?? projectedUpside).toFixed(2));
  const projectedMaxUpside = Math.max(0, Number(Number(analysis.projectedMaxUpside ?? analysis.qualityGate?.projectedMaxUpside ?? projectedUpside).toFixed(2)));
  const projectedMaxDownside = Math.max(0, Number(Number(analysis.projectedMaxDownside ?? analysis.qualityGate?.projectedMaxDownside ?? Math.max(0, -projectedFinalReturn)).toFixed(2)));
  const cycleTargetMove = Math.max(0, projectedFinalReturn, projectedMaxUpside * 0.72);
  const targetConfidence = Number(strategy.confidence || 80);
  const targetUpside = Number(strategy.targetUpside || 5);
  const stopLoss = Number(strategy.stopLoss || 4);
  const totalCapital = Number(capital.totalCapital || 0);
  const availableCash = Number(capital.availableCash || 0);
  const availableForNewTrades = Number(capital.availableForNewTrades ?? availableCash);
  const maxPositionPct = Number(strategy.maxPosition || 20);
  const maxTradeValue = totalCapital > 0 ? totalCapital * maxPositionPct / 100 : 0;
  const suggestedTradeValue = Math.max(0, Math.min(availableForNewTrades, maxTradeValue));
  const stopLossHit = Number(technicals.change5d || 0) <= -Math.abs(stopLoss);
  const hasCapacity = !totalCapital || suggestedTradeValue > 0;
  const qualityGate = analysis.qualityGate || {};
  const qualityBlocked = qualityGate.blocked === true || qualityGate.buyEligible === false;
  const strategyProbability = Math.max(0, Math.min(99, Number(analysis.strategyHitProbability ?? analysis.strategyConfidence ?? qualityGate.strategyHitProbability ?? qualityGate.historyGate?.strategyHitProbability ?? 0)));
  const finalReturnProbability = Math.max(0, Math.min(99, Number(analysis.finalReturnHitProbability ?? analysis.finalReturnConfidence ?? analysis.magnitudeHitProbability ?? qualityGate.finalReturnHitProbability ?? 0)));
  const maxUpsideProbability = Math.max(0, Math.min(99, Number(analysis.maxUpsideHitProbability ?? analysis.maxUpsideConfidence ?? qualityGate.maxUpsideHitProbability ?? 0)));
  const maxDownsideProbability = Math.max(0, Math.min(99, Number(analysis.maxDownsideHitProbability ?? analysis.maxDownsideConfidence ?? qualityGate.maxDownsideHitProbability ?? 0)));
  const magnitudeProbability = Math.max(
    Math.max(0, Math.min(99, Number(analysis.magnitudeHitProbability ?? analysis.magnitudeConfidence ?? analysis.moveHitProbability ?? analysis.projectedMoveConfidence ?? qualityGate.magnitudeHitProbability ?? 0))),
    finalReturnProbability,
    maxUpsideProbability,
  );
  const market = safeMarket(input.market || "ASX");
  const strictMarket = market === "ASX" || market === "US";
  const fallbackStrategyTarget = strictMarket ? Math.max(60, targetConfidence - 7) : Math.max(55, targetConfidence - 10);
  const strategyProbabilityTarget = Math.max(strictMarket ? 60 : 55, Math.min(strictMarket ? 76 : 68, Number(qualityGate.strategyProbabilityTarget || fallbackStrategyTarget || 58)));
  const magnitudeProbabilityTarget = Math.max(strictMarket ? 50 : 44, Math.min(70, targetConfidence - (strictMarket ? 24 : 30)));
  const minBuyConsensus = Number(qualityGate.minBuyConsensus || (strictMarket ? 66 : 62));
  const minBuyUpsideAgreement = Number(qualityGate.minBuyUpsideAgreement || (strictMarket ? 62 : 58));
  const maxBuyDisagreement = Number(qualityGate.maxBuyDisagreement || (strictMarket ? 6.8 : 7.5));
  const ensemble = analysis.ensemble || {};
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const disagreement = Number(ensemble.disagreementPenalty || 0);
  const marketAgreementOk = (!consensus || consensus >= minBuyConsensus)
    && (!upsideAgreement || upsideAgreement >= minBuyUpsideAgreement)
    && disagreement <= maxBuyDisagreement;
  const downsideConfidence = Math.max(0, Math.min(99, Number(analysis.downsideConfidence ?? (projectedUpside < 0 ? confidence : 0))));
  const severeDownside = projectedFinalReturn <= -Math.max(stopLoss, 4) || (downsideConfidence >= Math.max(70, targetConfidence - 5) && projectedFinalReturn <= -Math.max(2.5, stopLoss * 0.65));
  const held = Boolean(input.holding);
  const matched = !qualityBlocked && marketAgreementOk && confidence >= targetConfidence && magnitudeProbability >= magnitudeProbabilityTarget && strategyProbability >= strategyProbabilityTarget && cycleTargetMove >= targetUpside && !stopLossHit && hasCapacity;
  const strongMatched = matched && confidence >= targetConfidence + 8 && magnitudeProbability >= magnitudeProbabilityTarget + 5 && strategyProbability >= strategyProbabilityTarget + 5 && cycleTargetMove >= targetUpside * 1.12 && Number(analysis.directionAgreement || 0) >= 72;
  const lightConfidenceFloor = strictMarket ? Math.max(58, targetConfidence - 8) : Math.max(52, targetConfidence - 12);
  const lightMagnitudeFloor = strictMarket ? Math.max(44, magnitudeProbabilityTarget - 8) : Math.max(38, magnitudeProbabilityTarget - 10);
  const lightStrategyFloor = strictMarket ? Math.max(55, strategyProbabilityTarget - 6) : Math.max(45, strategyProbabilityTarget - 12);
  const lightUpsideFloor = Math.max(0.8, targetUpside * (strictMarket ? 0.65 : 0.45));
  const lightMatched = !qualityBlocked && marketAgreementOk && !matched && confidence >= lightConfidenceFloor && magnitudeProbability >= lightMagnitudeFloor && strategyProbability >= lightStrategyFloor && cycleTargetMove >= lightUpsideFloor && !stopLossHit;
  const action = held && (stopLossHit || severeDownside)
    ? "CRITICAL_SELL"
    : severeDownside
      ? "STRONG_AVOID"
      : strongMatched
        ? "STRONG_BUY"
        : matched
          ? "WATCH_BUY"
          : lightMatched
            ? "LIGHT_BUY"
              : stopLossHit || confidence <= 42 || projectedFinalReturn <= -1.2
              ? "AVOID_OR_REDUCE"
              : "HOLD_WATCH";
  const thesis = Array.isArray(analysis.thesis) ? [...analysis.thesis] : [];
  if (strongMatched) {
    thesis.unshift(`Strong buy tier: direction confidence ${confidence}%, max-upside touch confidence ${maxUpsideProbability.toFixed(0)}%, final-return confidence ${finalReturnProbability.toFixed(0)}%, strategy target-hit probability ${strategyProbability.toFixed(0)}%, and cycle target move ${cycleTargetMove.toFixed(2)}% exceed your rule with stronger model agreement.`);
  } else if (matched) {
    thesis.unshift(`Matches your rule: direction confidence ${confidence}% >= ${targetConfidence}%, max-upside touch confidence ${maxUpsideProbability.toFixed(0)}%, final-return confidence ${finalReturnProbability.toFixed(0)}%, strategy target-hit probability ${strategyProbability.toFixed(0)}% >= ${strategyProbabilityTarget.toFixed(0)}%, and cycle target move ${cycleTargetMove.toFixed(2)}% >= ${targetUpside}%.`);
  } else if (lightMatched) {
    thesis.unshift(`Light buy/watch tier: setup is positive but max-upside touch confidence ${maxUpsideProbability.toFixed(0)}% or strategy target-hit probability ${strategyProbability.toFixed(0)}% has not fully cleared the strict rule.`);
  } else {
    thesis.unshift(`Does not fully match your rule yet: direction confidence ${confidence}% / target ${targetConfidence}%, final-return confidence ${finalReturnProbability.toFixed(0)}%, max-upside confidence ${maxUpsideProbability.toFixed(0)}%, strategy target-hit ${strategyProbability.toFixed(0)}% / target ${strategyProbabilityTarget.toFixed(0)}%, cycle target move ${cycleTargetMove.toFixed(2)}% / target ${targetUpside}%.`);
  }
  if (action === "CRITICAL_SELL") thesis.unshift(`Critical sell alert: downside confidence ${downsideConfidence}% with projected move ${projectedUpside}% or stop-loss breach; review immediate sell/reduce action.`);
  if (action === "STRONG_AVOID") thesis.unshift(`Strong risk alert: downside confidence ${downsideConfidence}% and projected move ${projectedUpside}% are unfavorable.`);
  if (totalCapital) {
    thesis.unshift(`Capital check: available cash A$${availableCash.toFixed(2)}, new-trade budget after reserve A$${availableForNewTrades.toFixed(2)}, max single-position allocation A$${maxTradeValue.toFixed(2)}, suggested ticket A$${suggestedTradeValue.toFixed(2)}.`);
  }
  if (!hasCapacity) thesis.unshift("Capital check blocked buy alert: no available cash capacity under your inputs.");
  if (stopLossHit) thesis.unshift(`Risk control: 5-day move ${Number(technicals.change5d || 0).toFixed(2)}% breached the ${stopLoss}% stop-loss filter.`);
  if (qualityBlocked) thesis.unshift(`High-conviction gate blocked buy alert: ${(qualityGate.reasons || []).join("、") || "model agreement/evidence is not strong enough"}.`);

  return {
    ...analysis,
    action,
    predictionConfidence: Number(analysis.predictionConfidence ?? confidence),
    magnitudeConfidence: magnitudeProbability,
    magnitudeHitProbability: magnitudeProbability,
    moveHitProbability: magnitudeProbability,
    projectedMoveConfidence: magnitudeProbability,
    projectedFinalReturn,
    finalReturnConfidence: finalReturnProbability,
    finalReturnHitProbability: finalReturnProbability,
    projectedMaxUpside,
    maxUpsideConfidence: maxUpsideProbability,
    maxUpsideHitProbability: maxUpsideProbability,
    projectedMaxDownside,
    maxDownsideConfidence: maxDownsideProbability,
    maxDownsideHitProbability: maxDownsideProbability,
    strategyConfidence: strategyProbability,
    strategyHitProbability: strategyProbability,
    upsideConfidence: Number(analysis.upsideConfidence ?? (projectedUpside > 0 ? confidence : 0)),
    downsideConfidence,
    confidence,
    projectedUpside,
    horizonDays: Number(analysis.horizonDays || strategy.horizonDays || 15),
    thesis,
    strategyMatch: matched,
    suggestedTradeValue,
    availableCash,
  };
}

function compactNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
}

function compactText(value, limit = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function asList(value, limit = 5) {
  if (Array.isArray(value)) return value.map((item) => compactText(item, 220)).filter(Boolean).slice(0, limit);
  const text = compactText(value, 220);
  return text ? [text] : [];
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function compactSignalItems(items = [], limit = 5) {
  return items.slice(0, limit).map((item) => ({
    title: compactText(item.title || item.text, 180),
    description: compactText(item.description, 180),
    channel: compactText(item.channel || item.source || item.publisher, 60),
    source: compactText(item.source || item.publisher, 60),
    impactScope: compactText(item.impactScope || item.channel, 60),
    impactWeight: compactNumber(item.impactWeight, 2),
    publishedAt: item.publishedAt || null,
  })).filter((item) => item.title || item.description);
}

function compactAiInput(input) {
  const technicals = input.technicals || {};
  const analog = input.analog || {};
  const model = analog.model || {};
  const fundamentals = input.fundamentals || null;
  const validation = input.marketValidation || null;
  return {
    symbol: input.symbol,
    market: safeMarket(input.market || "ASX"),
    marketLabel: input.marketLabel || MARKET_CONFIG[safeMarket(input.market || "ASX")].label,
    currency: input.currency || MARKET_CONFIG[safeMarket(input.market || "ASX")].currency,
    strategy: input.strategy || {},
    capital: input.capital ? {
      totalCapital: compactNumber(input.capital.totalCapital),
      availableCash: compactNumber(input.capital.availableCash),
      availableForNewTrades: compactNumber(input.capital.availableForNewTrades),
      reservedCash: compactNumber(input.capital.reservedCash),
      investedPct: compactNumber(input.capital.investedPct),
    } : {},
    holding: input.holding ? {
      qty: compactNumber(input.holding.qty),
      avgPrice: compactNumber(input.holding.avgPrice),
      entryDate: input.holding.entryDate || null,
      holdingDays: Number(input.holding.holdingDays || 0),
    } : null,
    marketValidation: validation ? {
      status: validation.status,
      degraded: Boolean(validation.degraded),
      ok: Boolean(validation.ok),
      latest: validation.primary || null,
      message: compactText(validation.message, 180),
    } : null,
    calibrationSummary: input.calibrationSummary ? {
      total: Number(input.calibrationSummary.total || 0),
      resolved: Number(input.calibrationSummary.resolved || 0),
      hitRate: input.calibrationSummary.hitRate == null ? null : compactNumber(input.calibrationSummary.hitRate),
      magnitudeHitRate: input.calibrationSummary.magnitudeHitRate == null ? null : compactNumber(input.calibrationSummary.magnitudeHitRate),
      finalReturnHitRate: input.calibrationSummary.finalReturnHitRate == null ? null : compactNumber(input.calibrationSummary.finalReturnHitRate),
      maxUpsideHitRate: input.calibrationSummary.maxUpsideHitRate == null ? null : compactNumber(input.calibrationSummary.maxUpsideHitRate),
      buyHitRate: input.calibrationSummary.buyHitRate == null ? null : compactNumber(input.calibrationSummary.buyHitRate),
      avgForwardReturn: input.calibrationSummary.avgForwardReturn == null ? null : compactNumber(input.calibrationSummary.avgForwardReturn),
      adaptive: input.calibrationSummary.adaptive ? {
        confidencePenalty: compactNumber(input.calibrationSummary.adaptive.confidencePenalty || 0),
        upsideShrink: compactNumber(input.calibrationSummary.adaptive.upsideShrink || 1),
        magnitudeHitRate: input.calibrationSummary.adaptive.magnitudeHitRate == null ? null : compactNumber(input.calibrationSummary.adaptive.magnitudeHitRate),
        finalReturnHitRate: input.calibrationSummary.adaptive.finalReturnHitRate == null ? null : compactNumber(input.calibrationSummary.adaptive.finalReturnHitRate),
        maxUpsideHitRate: input.calibrationSummary.adaptive.maxUpsideHitRate == null ? null : compactNumber(input.calibrationSummary.adaptive.maxUpsideHitRate),
        recentMisses: Number(input.calibrationSummary.adaptive.recentMisses || 0),
        recentAdverse: Number(input.calibrationSummary.adaptive.recentAdverse || 0),
        patternStats: Object.values(input.calibrationSummary.adaptive.patternStats || {}).slice(0, 5).map((row) => ({
          label: row.label,
          confidencePenalty: compactNumber(row.confidencePenalty || 0),
          upsideShrink: compactNumber(row.upsideShrink || 1),
          buyHitRate: row.buyHitRate == null ? null : compactNumber(row.buyHitRate),
        })),
      } : null,
      learningEvents: (input.calibrationSummary.learningEvents || []).slice(0, 5).map((row) => ({
        symbol: row.symbol,
        status: row.status,
        projectedUpside: compactNumber(row.projectedUpside || 0),
        actualReturn: row.actualReturn == null ? null : compactNumber(row.actualReturn),
        changes: (row.changes || []).slice(0, 2),
      })),
      accuracyBoostPlan: (input.calibrationSummary.accuracyBoostPlan || []).slice(0, 4).map((row) => ({
        priority: row.priority,
        title: row.title,
        action: compactText(row.action, 120),
      })),
      buckets: (input.calibrationSummary.buckets || []).map((bucket) => ({
        label: bucket.label,
        count: Number(bucket.count || 0),
        hitRate: bucket.hitRate == null ? null : compactNumber(bucket.hitRate),
        avgReturn: bucket.avgReturn == null ? null : compactNumber(bucket.avgReturn),
        brierScore: bucket.brierScore == null ? null : compactNumber(bucket.brierScore, 3),
      })),
      strategyBuckets: (input.calibrationSummary.strategyBuckets || []).map((bucket) => ({
        label: bucket.label,
        count: Number(bucket.count || 0),
        hitRate: bucket.hitRate == null ? null : compactNumber(bucket.hitRate),
        brierScore: bucket.brierScore == null ? null : compactNumber(bucket.brierScore, 3),
      })),
      modelStats: Object.values(input.calibrationSummary.modelStats || {}).slice(0, 8).map((row) => ({
        name: row.name,
        samples: Number(row.samples || 0),
        directionalHitRate: row.directionalHitRate == null ? null : compactNumber(row.directionalHitRate),
        strategyHitRate: row.strategyHitRate == null ? null : compactNumber(row.strategyHitRate),
        weightMultiplier: compactNumber(row.weightMultiplier || 1),
      })),
      regimeStats: Object.values(input.calibrationSummary.regimeStats || {}).slice(0, 5).map((row) => ({
        regime: row.regime,
        total: Number(row.total || 0),
        buyHitRate: row.buyHitRate == null ? null : compactNumber(row.buyHitRate),
      })),
      errorTypes: Object.values(input.calibrationSummary.errorTypeStats || {}).slice(0, 6).map((row) => ({
        label: row.label,
        total: Number(row.total || 0),
        buyHitRate: row.buyHitRate == null ? null : compactNumber(row.buyHitRate),
      })),
    } : null,
    technicals: {
      close: compactNumber(technicals.close, 4),
      rsi: compactNumber(technicals.rsi),
      macdHistogram: compactNumber(technicals.macdHistogram, 5),
      volumeRatio: compactNumber(technicals.volumeRatio),
      change5d: compactNumber(technicals.change5d),
      change20d: compactNumber(technicals.change20d),
      volatility: compactNumber(technicals.volatility),
      mainForceProxy: compactNumber(technicals.mainForceProxy),
      trendScore: compactNumber(technicals.trendScore),
      momentumScore: compactNumber(technicals.momentumScore),
      volumeScore: compactNumber(technicals.volumeScore),
      riskScore: compactNumber(technicals.riskScore),
      rulesProjectedUpside: compactNumber(technicals.projectedUpside),
    },
    historicalAnalog: {
      count: Number(analog.count || 0),
      confidence: compactNumber(analog.confidence),
      averageForwardReturn: compactNumber(analog.averageForwardReturn),
      averageFinalReturn: compactNumber(analog.averageFinalReturn ?? analog.averageForwardReturn),
      averageMaxUpside: compactNumber(analog.averageMaxUpside),
      winRate: compactNumber(analog.winRate),
      directionalHitRate: compactNumber(analog.directionalHitRate),
      strategyHitProbability: compactNumber(analog.strategyHitProbability),
      targetHitRate: compactNumber(analog.targetHitRate),
      finalReturnHitRate: compactNumber(analog.finalReturnHitRate),
      maxUpsideHitRate: compactNumber(analog.maxUpsideHitRate),
      stopRate: compactNumber(analog.stopRate),
      averageRiskAdjustedReturn: compactNumber(analog.averageRiskAdjustedReturn),
      modelPredictedReturn: compactNumber(model.predictedReturn),
      modelPredictedMaxUpside: compactNumber(model.predictedMaxUpside),
      modelConfidence: compactNumber(model.confidence),
      modelMae: compactNumber(model.mae),
      modelMaxUpsideMae: compactNumber(model.maxUpsideMae),
      modelDirectionalAccuracy: compactNumber(model.directionalAccuracy),
      modelTargetHitAccuracy: compactNumber(model.targetHitAccuracy),
      modelMaxUpsideHitAccuracy: compactNumber(model.maxUpsideHitAccuracy),
      modelOosSamples: Number(model.oosSampleCount || 0),
      modelOosDirectionalAccuracy: compactNumber(model.oosDirectionalAccuracy),
      modelOosTargetHitAccuracy: compactNumber(model.oosTargetHitAccuracy),
      modelOosMaxUpsideHitAccuracy: compactNumber(model.oosMaxUpsideHitAccuracy),
      metaLabelProbability: compactNumber(model.metaLabelProbability),
      metaDirectionalProbability: compactNumber(model.metaDirectionalProbability),
      metaMaxUpsideProbability: compactNumber(model.metaMaxUpsideProbability),
      conformalP80Error: compactNumber(model.conformalP80Error),
      conformalP90Error: compactNumber(model.conformalP90Error),
      examples: (analog.examples || []).slice(0, 3).map((item) => ({
        date: item.date,
        forwardReturn: compactNumber(item.forwardReturn),
        maxUpside: compactNumber(item.maxUpside),
        maxDrawdown: compactNumber(item.maxDrawdown),
        targetWins: Boolean(item.targetWins),
        stopWins: Boolean(item.stopWins),
        distance: compactNumber(item.distance, 4),
      })),
    },
    fundamentals: fundamentals ? {
      name: compactText(fundamentals.name, 80),
      sector: compactText(fundamentals.sector, 80),
      industry: compactText(fundamentals.industry, 100),
      marketCap: fundamentals.marketCap,
      peRatio: fundamentals.peRatio,
      forwardPE: fundamentals.forwardPE,
      dividendYield: fundamentals.dividendYield,
      eps: fundamentals.eps,
      profitMargin: fundamentals.profitMargin,
      beta: fundamentals.beta,
    } : null,
    factors: input.factors ? {
      signal: factorSignal(input.factors, input.researchConfig?.factorConfig, technicals),
      announcements: input.factors.announcements ? {
        score: compactNumber(input.factors.announcements.score),
        available: input.factors.announcements.available,
        thesis: asList(input.factors.announcements.thesis, 2),
      } : null,
      shortInterest: input.factors.shortInterest ? {
        score: compactNumber(input.factors.shortInterest.score),
        available: input.factors.shortInterest.available,
        thesis: asList(input.factors.shortInterest.thesis, 2),
      } : null,
      relativeStrength: input.factors.relativeStrength ? {
        score: compactNumber(input.factors.relativeStrength.score),
        values: input.factors.relativeStrength.values || null,
        thesis: asList(input.factors.relativeStrength.thesis, 2),
      } : null,
      flowOptions: input.factors.flowOptions ? {
        score: compactNumber(input.factors.flowOptions.score),
        values: input.factors.flowOptions.values || null,
        thesis: asList(input.factors.flowOptions.thesis, 2),
        available: input.factors.flowOptions.available,
      } : null,
      marketRegime: input.factors.marketRegime ? {
        score: compactNumber(input.factors.marketRegime.score),
        values: input.factors.marketRegime.values || null,
        thesis: asList(input.factors.marketRegime.thesis, 2),
      } : null,
      liquidity: input.factors.liquidity ? {
        score: compactNumber(input.factors.liquidity.score),
        values: input.factors.liquidity.values || null,
        thesis: asList(input.factors.liquidity.thesis, 2),
      } : null,
      calibration: input.factors.calibration ? {
        score: compactNumber(input.factors.calibration.score),
        values: input.factors.calibration.values || null,
        thesis: asList(input.factors.calibration.thesis, 2),
      } : null,
      macro: input.factors.macro ? {
        score: compactNumber(input.factors.macro.score),
        thesis: asList(input.factors.macro.thesis, 2),
      } : null,
      sector: input.factors.sector ? {
        score: compactNumber(input.factors.sector.score),
        thesis: asList(input.factors.sector.thesis, 2),
      } : null,
      socialMedia: input.factors.socialMedia ? {
        score: compactNumber(input.factors.socialMedia.score),
        weight: compactNumber(input.factors.socialMedia.weight),
        confidence: compactNumber(input.factors.socialMedia.confidence),
        sentiment: compactNumber(input.factors.socialMedia.sentiment),
        manipulationRisk: compactNumber(input.factors.socialMedia.manipulationRisk),
        truthScore: compactNumber(input.factors.socialMedia.truthScore),
        available: input.factors.socialMedia.available,
        cache: input.factors.socialMedia.cache || null,
        thesis: asList(input.factors.socialMedia.thesis, 2),
        topItems: asList(input.factors.socialMedia.items || input.factors.socialMedia.topItems, 3).map((item) => ({
          title: compactText(item.title, 120),
          subreddit: compactText(item.subreddit, 40),
          relevance: compactNumber(item.relevance),
          impactScore: compactNumber(item.impactScore),
          socialScore: compactNumber(item.socialScore),
          truthScore: compactNumber(item.truthScore),
          manipulationRisk: compactNumber(item.manipulationRisk),
          sentiment: compactNumber(item.sentiment),
          relation: compactText(item.relation, 30),
        })),
      } : null,
    } : null,
    news: compactSignalItems(input.news || [], 6),
    x: compactSignalItems(input.xPosts || [], 4),
    youtube: compactSignalItems(input.youtubeItems || [], 4),
  };
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function externalAiEnabled() {
  return envFlag("ENABLE_OPENAI_ANALYSIS", false) || envFlag("ENABLE_DOMESTIC_AI_ANALYSIS", false);
}

function endpointFromBase(baseUrl, path = "/chat/completions") {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}${path}`;
}

function aiProviderCandidates() {
  const providers = {
    openai: {
      id: "openai",
      label: "OpenAI",
      configured: Boolean(process.env.OPENAI_API_KEY),
      type: "responses",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      apiKey: process.env.OPENAI_API_KEY,
      endpoint: "https://api.openai.com/v1/responses",
    },
    siliconflow: {
      id: "siliconflow",
      label: "硅基流动",
      configured: Boolean(process.env.SILICONFLOW_API_KEY),
      type: "openai-compatible",
      model: process.env.SILICONFLOW_MODEL || "deepseek-ai/DeepSeek-V3.2",
      apiKey: process.env.SILICONFLOW_API_KEY,
      endpoint: endpointFromBase(process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1"),
    },
    hunyuan: {
      id: "hunyuan",
      label: "腾讯混元",
      configured: Boolean(process.env.HUNYUAN_API_KEY || process.env.TENCENT_HUNYUAN_API_KEY),
      type: "openai-compatible",
      model: process.env.HUNYUAN_MODEL || process.env.TENCENT_HUNYUAN_MODEL || "deepseek-v3.2",
      apiKey: process.env.HUNYUAN_API_KEY || process.env.TENCENT_HUNYUAN_API_KEY,
      endpoint: endpointFromBase(process.env.HUNYUAN_BASE_URL || process.env.TENCENT_HUNYUAN_BASE_URL || "https://tokenhub.tencentmaas.com/v1"),
    },
  };
  return String(process.env.AI_PROVIDER_ORDER || "openai,siliconflow,hunyuan")
    .split(",")
    .map((name) => providers[name.trim().toLowerCase()])
    .filter((provider) => provider?.configured && provider.endpoint);
}

function aiProviderStatus() {
  return aiProviderCandidates().map((provider) => ({
    id: provider.id,
    label: provider.label,
    model: provider.model,
    configured: true,
    endpointConfigured: Boolean(provider.endpoint),
  }));
}

function inputToChatMessages(input) {
  return (Array.isArray(input) ? input : [{ role: "user", content: String(input || "") }]).map((message) => {
    const role = ["system", "assistant", "user"].includes(message?.role) ? message.role : "user";
    const raw = message?.content;
    const content = Array.isArray(raw)
      ? raw.map((part) => part?.text || part?.input_text || "").filter(Boolean).join("\n")
      : String(raw ?? "");
    return { role, content };
  });
}

function parseJsonFromAiText(text, providerLabel = "AI") {
  const raw = String(text || "").trim();
  if (!raw) throw new Error(`${providerLabel} returned empty output`);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
    throw new Error(`${providerLabel} returned non-JSON output`);
  }
}

async function callOpenAiResponsesJson(input, timeoutMs) {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        max_output_tokens: 1800,
        temperature: 0.2,
        text: { format: { type: "json_object" } },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
    const payload = await response.json();
    const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("");
    return { data: parseJsonFromAiText(text, "OpenAI"), provider: { id: "openai", label: "OpenAI", model } };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatibleJson(input, timeoutMs, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: inputToChatMessages(input),
        temperature: 0.2,
        max_tokens: 1800,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) throw new Error(`${provider.label} HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content || payload.output_text || "";
    return { data: parseJsonFromAiText(text, provider.label), provider };
  } finally {
    clearTimeout(timer);
  }
}

async function callExternalAiJson(input, timeoutMs) {
  if (!externalAiEnabled()) throw new Error("External AI analysis is disabled.");
  const providers = aiProviderCandidates();
  if (!providers.length) throw new Error("No external AI provider is configured.");
  const errors = [];
  for (const provider of providers) {
    try {
      if (provider.type === "responses") return await callOpenAiResponsesJson(input, timeoutMs);
      return await callOpenAiCompatibleJson(input, timeoutMs, provider);
    } catch (error) {
      errors.push(`${provider.label}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function callOpenAiJson(input, timeoutMs) {
  const result = await callExternalAiJson(input, timeoutMs);
  return result.data;
}

async function fetchAtasFeatureExtraction({ market, symbol, interval, candles, result }) {
  if (!process.env.ATAS_API_KEY) {
    return {
      available: false,
      source: "atas-disabled",
      reason: "ATAS_API_KEY is not configured.",
    };
  }
  const endpoint = process.env.ATAS_FEATURE_ENDPOINT
    || (process.env.ATAS_BASE_URL ? endpointFromBase(process.env.ATAS_BASE_URL, "/features") : "");
  if (!endpoint) {
    return {
      available: false,
      configured: true,
      source: "atas-endpoint-missing",
      reason: "ATAS key is configured, but ATAS_FEATURE_ENDPOINT or ATAS_BASE_URL is missing; no external feature request was sent.",
      expected_payload: ["OHLCV/VWAP log", "volume profile", "order-flow proxy", "true trade rows when provider supplies them"],
    };
  }
  try {
    const payload = await fetchJsonPost(endpoint, {
      market,
      symbol,
      interval,
      candles,
      summary: result?.summary || {},
      volume_profile: result?.volume_profile || {},
      data_log: Array.isArray(result?.data_log) ? result.data_log.slice(-5000) : [],
      quality: result?.quality || {},
    }, Number(process.env.ATAS_TIMEOUT_MS || 10000), {
      authorization: `Bearer ${process.env.ATAS_API_KEY}`,
      "x-api-key": process.env.ATAS_API_KEY,
    });
    return {
      available: true,
      source: "atas-feature-adapter",
      payload,
      note: "ATAS feature adapter returned external analysis; verify vendor schema before using it as a trading signal.",
    };
  } catch (error) {
    return {
      available: false,
      configured: true,
      source: "atas-feature-error",
      reason: String(error.message || error).slice(0, 260),
    };
  }
}

function localAnalysisEnvelope(input, source = "local-rules") {
  return {
    symbol: input.symbol,
    analysis: strategyDecision(localAnalysis(input), input),
    source,
  };
}

function blendAiWithBaseline(row, baseline, providerLabel = "AI文本复核") {
  const aiConfidence = Number(row.confidence);
  const aiUpside = Number(row.projectedUpside);
  let confidence = Number.isFinite(aiConfidence)
    ? clampNumber(aiConfidence * 0.62 + Number(baseline.confidence || 0) * 0.38, 0, 99)
    : Number(baseline.confidence || 0);
  let projectedUpside = Number.isFinite(aiUpside)
    ? Number((aiUpside * 0.56 + Number(baseline.projectedUpside || 0) * 0.44).toFixed(2))
    : Number(baseline.projectedUpside || 0);
  const qualityGate = baseline.qualityGate || null;
  if (qualityGate?.confidenceCap != null) confidence = Math.min(confidence, Number(qualityGate.confidenceCap));
  if (qualityGate?.projectedUpsideCap != null && projectedUpside > 0) projectedUpside = Math.min(projectedUpside, Number(qualityGate.projectedUpsideCap));
  const magnitudeDelta = Math.abs(projectedUpside - Number(baseline.projectedUpside || 0));
  const magnitudeProbability = clampNumber(
    Number(baseline.magnitudeHitProbability ?? baseline.magnitudeConfidence ?? baseline.moveHitProbability ?? baseline.projectedMoveConfidence ?? qualityGate?.magnitudeHitProbability ?? 0) - magnitudeDelta * 5.5,
    0,
    92,
  );
  const finalReturnProbability = clampNumber(
    Number(baseline.finalReturnHitProbability ?? baseline.finalReturnConfidence ?? qualityGate?.finalReturnHitProbability ?? magnitudeProbability) - magnitudeDelta * 5.8,
    0,
    92,
  );
  const projectedMaxUpside = Math.max(
    0,
    Number(baseline.projectedMaxUpside ?? qualityGate?.projectedMaxUpside ?? 0),
    projectedUpside > 0 ? projectedUpside : 0,
  );
  const maxUpsideProbability = clampNumber(
    Number(baseline.maxUpsideHitProbability ?? baseline.maxUpsideConfidence ?? qualityGate?.maxUpsideHitProbability ?? magnitudeProbability) - Math.max(0, projectedMaxUpside - Number(baseline.projectedMaxUpside ?? projectedMaxUpside)) * 3.5,
    0,
    92,
  );
  const projectedMaxDownside = Math.max(0, Number(baseline.projectedMaxDownside ?? qualityGate?.projectedMaxDownside ?? 0));
  const maxDownsideProbability = clampNumber(
    Number(baseline.maxDownsideHitProbability ?? baseline.maxDownsideConfidence ?? qualityGate?.maxDownsideHitProbability ?? 0),
    0,
    92,
  );
  const aiOverlay = Number.isFinite(aiConfidence) || Number.isFinite(aiUpside)
    ? {
      name: `${providerLabel}文本复核`,
      confidence: Math.round(Number.isFinite(aiConfidence) ? aiConfidence : confidence),
      projectedUpside: Number((Number.isFinite(aiUpside) ? aiUpside : projectedUpside).toFixed(2)),
      weight: 0,
      normalizedWeight: 0,
      available: true,
      reason: `${providerLabel} synthesis of compact news/factor/technical context; blended after local ensemble.`,
    }
    : null;
  const ensemble = baseline.ensemble ? {
    ...baseline.ensemble,
    aiOverlay,
    blendedConfidence: confidence,
    blendedProjectedUpside: projectedUpside,
    models: aiOverlay ? [...(baseline.ensemble.models || []), aiOverlay] : baseline.ensemble.models || [],
  } : null;
  const thesis = [
    ...asList(row.thesis, 4),
    `Local technical/history ensemble baseline: confidence ${Math.round(Number(baseline.confidence || 0))}%, projected upside ${Number(baseline.projectedUpside || 0).toFixed(2)}%.`,
    ...(baseline.thesis || []).slice(0, 2),
  ];
  return {
    symbol: row.symbol || baseline.symbol,
    confidence,
    predictionConfidence: baseline.predictionConfidence ?? confidence,
    magnitudeConfidence: magnitudeProbability,
    magnitudeHitProbability: magnitudeProbability,
    moveHitProbability: magnitudeProbability,
    projectedMoveConfidence: magnitudeProbability,
    projectedFinalReturn: projectedUpside,
    finalReturnConfidence: finalReturnProbability,
    finalReturnHitProbability: finalReturnProbability,
    projectedMaxUpside,
    maxUpsideConfidence: maxUpsideProbability,
    maxUpsideHitProbability: maxUpsideProbability,
    projectedMaxDownside,
    maxDownsideConfidence: maxDownsideProbability,
    maxDownsideHitProbability: maxDownsideProbability,
    strategyConfidence: baseline.strategyConfidence ?? baseline.strategyHitProbability ?? 0,
    strategyHitProbability: baseline.strategyHitProbability ?? baseline.strategyConfidence ?? 0,
    projectedUpside,
    horizonDays: row.horizonDays ?? baseline.horizonDays,
    ensemble,
    qualityGate,
    featureScores: baseline.featureScores,
    factorSignal: baseline.factorSignal,
    calibration: baseline.calibration,
    strategyCalibration: baseline.strategyCalibration,
    thesis,
    risks: asList(row.risks, 4).length ? asList(row.risks, 4) : baseline.risks?.slice(0, 5) || [],
  };
}

async function openAiAnalysis(input) {
  const baseline = localAnalysisEnvelope(input).analysis;
  if (!externalAiEnabled() || !aiProviderCandidates().length) {
    return { analysis: baseline, source: "local-rules" };
  }
  try {
    const parsed = await callExternalAiJson([
      {
        role: "system",
        content: "You are a cautious multi-market equity analyst covering ASX, US stocks, and China A-shares. Do not claim certainty. Treat confidence as directional prediction reliability. Keep final-return magnitude reliability, intraperiod max-upside touch reliability, and strategy target-hit probability separate; never bypass the local strategy gate. Respect calibrationSummary, modelStats, regimeStats, recent learning events, and adaptive penalties; avoid aggressive upside estimates after similar failed forecasts. Return compact JSON only with keys confidence, projectedUpside, horizonDays, thesis, risks. The app will apply final-return, max-upside, and strategy calibration after your estimate.",
      },
      {
        role: "user",
        content: JSON.stringify({
          ...compactAiInput(input),
          localRuleBaseline: {
            confidence: baseline.confidence,
            magnitudeHitProbability: baseline.magnitudeHitProbability,
            projectedUpside: baseline.projectedUpside,
            projectedFinalReturn: baseline.projectedFinalReturn,
            finalReturnHitProbability: baseline.finalReturnHitProbability,
            projectedMaxUpside: baseline.projectedMaxUpside,
            maxUpsideHitProbability: baseline.maxUpsideHitProbability,
            strategyHitProbability: baseline.strategyHitProbability,
            action: baseline.action,
            ensemble: baseline.ensemble ? {
              direction: baseline.ensemble.direction,
              upsideAgreement: baseline.ensemble.upsideAgreement,
              consensusAgreement: baseline.ensemble.consensusAgreement,
              models: (baseline.ensemble.models || []).map((model) => ({
                name: model.name,
                confidence: model.confidence,
                projectedUpside: model.projectedUpside,
                weight: model.normalizedWeight,
                available: model.available,
              })),
            } : null,
          },
        }),
      },
    ], Number(process.env.OPENAI_TIMEOUT_MS || 8000));
    return { analysis: strategyDecision(blendAiWithBaseline(parsed.data, baseline, parsed.provider.label), input), source: `${parsed.provider.id}-ensemble` };
  } catch (error) {
    const fallback = localAnalysis(input);
    fallback.risks = [`External AI analysis unavailable; local strategy engine used. ${error.message}`, ...(fallback.risks || [])];
    return { analysis: strategyDecision(fallback, input), source: "local-rules-ai-fallback" };
  }
}

function analysisBatchLimit() {
  return Math.max(20, Math.min(240, Number(process.env.ANALYZE_BATCH_LIMIT || 180)));
}

async function openAiBatchAnalysis(items) {
  const inputs = Array.isArray(items) ? items.filter(Boolean).slice(0, analysisBatchLimit()) : [];
  const localResults = inputs.map((input) => localAnalysisEnvelope(input));
  if (!inputs.length) return { results: [], source: "empty" };
  if (!externalAiEnabled() || !aiProviderCandidates().length) {
    return { results: localResults, source: "local-rules" };
  }

  const maxAiItems = Math.max(3, Math.min(18, Number(process.env.OPENAI_BATCH_MAX_ITEMS || 10)));
  const reviewRows = inputs
    .map((input, index) => {
      const analysis = localResults[index].analysis || {};
      const ensemble = analysis.ensemble || {};
      const action = String(analysis.action || "");
      const highImpact = Boolean(input.holding)
        || ["STRONG_BUY", "WATCH_BUY", "LIGHT_BUY", "STRONG_AVOID", "CRITICAL_SELL", "AVOID_OR_REDUCE"].includes(action)
        || Number(analysis.projectedUpside || 0) >= Number(input.strategy?.targetUpside || 5) * 0.45
        || Number(analysis.downsideConfidence || 0) >= 58
        || Number(ensemble.disagreementPenalty || 0) >= 5
        || Number(ensemble.consensusAgreement || 0) < 62;
      const priority = (input.holding ? 35 : 0)
        + Math.abs(Number(analysis.projectedUpside || 0)) * 4
        + Number(analysis.confidence || 0) * 0.18
        + Number(analysis.downsideConfidence || 0) * 0.18
        + Number(ensemble.disagreementPenalty || 0) * 2.2
        + (action.includes("BUY") || action.includes("AVOID") || action.includes("SELL") ? 12 : 0);
      return { input, local: localResults[index], index, highImpact, priority };
    })
    .filter((row) => row.highImpact)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxAiItems);

  if (!reviewRows.length) {
    return { results: localResults, source: "local-rules-no-ai-candidates" };
  }

  try {
    const parsed = await callExternalAiJson([
      {
        role: "system",
        content: "You are a fast cautious multi-market portfolio reviewer. Review only high-impact rows. Keep confidence as directional prediction reliability; keep final-return magnitude reliability, intraperiod max-upside touch reliability, and strategy target-hit probability separate in reasoning. Respect local baselines, modelStats, market regime, strategy calibration, magnitude calibration, and adaptive penalties. Return JSON only: {\"results\":[{\"symbol\":\"BHP\",\"confidence\":0-99,\"projectedUpside\":number,\"horizonDays\":number,\"thesis\":[...],\"risks\":[...]}]}. Be concise.",
      },
      {
        role: "user",
        content: JSON.stringify({
          generatedAt: new Date().toISOString(),
          skippedCount: inputs.length - reviewRows.length,
          stocks: reviewRows.map(({ input, local }) => ({
            ...compactAiInput(input),
            localRuleBaseline: {
              confidence: local.analysis.confidence,
              magnitudeHitProbability: local.analysis.magnitudeHitProbability,
              projectedUpside: local.analysis.projectedUpside,
              projectedFinalReturn: local.analysis.projectedFinalReturn,
              finalReturnHitProbability: local.analysis.finalReturnHitProbability,
              projectedMaxUpside: local.analysis.projectedMaxUpside,
              maxUpsideHitProbability: local.analysis.maxUpsideHitProbability,
              strategyHitProbability: local.analysis.strategyHitProbability,
              action: local.analysis.action,
              ensemble: local.analysis.ensemble ? {
                direction: local.analysis.ensemble.direction,
                upsideAgreement: local.analysis.ensemble.upsideAgreement,
                consensusAgreement: local.analysis.ensemble.consensusAgreement,
                strategyHitProbability: local.analysis.qualityGate?.historyGate?.strategyHitProbability,
              } : null,
            },
          })),
        }),
      },
    ], Number(process.env.OPENAI_BATCH_TIMEOUT_MS || 5500));
    const rows = Array.isArray(parsed.data.results) ? parsed.data.results : [];
    const batchMarket = safeMarket(inputs[0]?.market || "ASX");
    const bySymbol = new Map(rows.map((row) => [cleanCode(row.symbol, batchMarket), row]));
    const results = [...localResults];
    reviewRows.forEach(({ input, local, index }, reviewIndex) => {
      const row = bySymbol.get(cleanCode(input.symbol, input.market || batchMarket)) || rows[reviewIndex];
      if (!row) return;
      const baseline = local.analysis;
      const aiEstimate = blendAiWithBaseline({ ...row, symbol: input.symbol }, baseline, parsed.provider.label);
      if (!aiEstimate.thesis.length) aiEstimate.thesis = baseline.thesis?.slice(0, 5) || [];
      if (!aiEstimate.risks.length) aiEstimate.risks = baseline.risks?.slice(0, 5) || [];
      results[index] = {
        symbol: input.symbol,
        analysis: strategyDecision(aiEstimate, input),
        source: `${parsed.provider.id}-batch-ensemble`,
      };
    });
    return { results, source: `${parsed.provider.id}-batch-top-${reviewRows.length}` };
  } catch (error) {
    const results = inputs.map((input) => {
      const fallback = localAnalysis(input);
      fallback.risks = [`External AI batch analysis unavailable; local strategy engine used. ${error.message}`, ...(fallback.risks || [])];
      return {
        symbol: input.symbol,
        analysis: strategyDecision(fallback, input),
        source: "local-rules-ai-fallback",
      };
    });
    return { results, source: "local-rules-ai-fallback" };
  }
}

function localBatchAnalysis(items) {
  const inputs = Array.isArray(items) ? items.filter(Boolean).slice(0, analysisBatchLimit()) : [];
  return {
    results: inputs.map((input) => localAnalysisEnvelope(input, "local-rules-fast")),
    source: "local-rules-fast",
  };
}

async function assistantChat(payload = {}) {
  const question = String(payload.message || "").trim().slice(0, 2000);
  const context = payload.context || {};
  if (!question) return { source: "empty", message: "请输入你想讨论的策略、数据或持仓问题。", suggestions: [] };
  const localMessage = [
    "本地建议：先确认当前市场、持仓和策略阈值是否一致。",
    "如果最近买入后马上下跌，优先复核：是否触发止损、是否出现单票错误迁移模式、是否大盘风险转弱、是否成交量与MACD没有同步确认。",
    "提高可靠性的做法是减少低证据高置信交易，只接受方向置信、幅度达成率、策略达标率、成交量、历史相似样本和新闻因子同时支持的信号。",
  ].join("\n");
  if (!externalAiEnabled() || !aiProviderCandidates().length) {
    return { source: "local-rules-chat", message: localMessage, suggestions: ["补充交易周期和止损线", "刷新当前市场新闻和行情", "查看预测准确率中的错误行为模式"] };
  }
  try {
    const parsed = await callExternalAiJson([
      {
        role: "system",
        content: "You are a cautious Chinese-speaking trading strategy assistant inside a read-only quant dashboard. You do not place trades. Return JSON only: {\"message\":\"中文回答，具体但不过度承诺\",\"suggestions\":[\"...\"]}. Explain uncertainty and risk controls.",
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          generatedAt: new Date().toISOString(),
          context: {
            market: context.market,
            strategy: context.strategy,
            capital: context.capital,
            holdings: (context.holdings || []).slice(0, 20),
            watchlist: (context.watchlist || []).slice(0, 40),
            analyses: (context.analyses || []).slice(0, 30),
            accuracy: context.accuracy || null,
          },
        }),
      },
    ], Number(process.env.OPENAI_TIMEOUT_MS || 12000));
    return {
      source: `${parsed.provider.id}-chat`,
      message: String(parsed.data.message || localMessage).slice(0, 4000),
      suggestions: Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions.slice(0, 6).map((item) => String(item).slice(0, 180)) : [],
    };
  } catch (error) {
    return {
      source: "local-rules-chat-fallback",
      message: `${localMessage}\n\nAI接口暂时不可用：${error.message}`,
      suggestions: ["先降低单票仓位", "只接受强证据信号", "用预测准确率面板复盘近期错误"],
    };
  }
}

async function parsePortfolioImage(image, market = "ASX") {
  const key = safeMarket(market);
  if (!process.env.OPENAI_API_KEY || process.env.ENABLE_OPENAI_ANALYSIS !== "true") {
    throw new Error("OpenAI Vision is not enabled for screenshot import.");
  }
  const dataUrl = String(image || "");
  if (!dataUrl.startsWith("data:image/")) throw new Error("Please upload an image file.");
  if (dataUrl.length > 7_000_000) throw new Error("Image is too large; crop the holdings table and try again.");
  const parsed = await callOpenAiResponsesJson([
    {
      role: "system",
      content: `Extract ${MARKET_CONFIG[key].label} portfolio holdings from a broker screenshot. Return JSON only: {\"holdings\":[{\"symbol\":\"BHP\",\"qty\":120,\"avgPrice\":43.2,\"entryDate\":\"YYYY-MM-DD or null\"}]}. Use market-native stock codes only, no prose.`,
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Read the screenshot and extract stock code, quantity, average price, and entry/buy date if visible." },
        { type: "input_image", image_url: dataUrl },
      ],
    },
  ], Number(process.env.OPENAI_TIMEOUT_MS || 12000));
  return {
    holdings: (Array.isArray(parsed.data.holdings) ? parsed.data.holdings : []).map((item) => ({
      symbol: cleanCode(item.symbol, key),
      market: key,
      qty: Number(item.qty || item.quantity || 0),
      avgPrice: Number(item.avgPrice || item.averagePrice || item.avg_price || 0),
      entryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.entryDate || "")) ? item.entryDate : null,
    })).filter((item) => item.symbol && item.qty > 0 && item.avgPrice > 0),
    source: "openai-vision",
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/runtime/stream" && req.method === "GET") {
    runtimeEvents.subscribe(req, res, { since: url.searchParams.get("since") || 0 });
    return;
  }

  if (url.pathname === "/api/workspace/bootstrap" && req.method === "GET") {
    const market = marketFromUrl(url);
    const [snapshot, monitor, paperAgents, paperEvents] = await Promise.all([
      readServerSnapshotForMarket(market).catch(() => null),
      backendMonitorStatus().catch((error) => ({ ok: false, error: error.message || String(error) })),
      runPythonQuantCore("paper-agent-summary", { market }).catch((error) => ({ market, available: false, error: error.message || String(error), order_execution_enabled: false })),
      runPythonQuantCore("paper-agent-events", { market, limit: 30 }).catch(() => ({ market, count: 0, events: [], order_execution_enabled: false })),
    ]);
    const quoteOverlays = await readLatestMarketOverlays(
      market,
      snapshotSymbolsForMarketOverlay(snapshot, market),
      snapshot,
    ).catch(() => []);
    sendJson(res, 200, {
      ok: true,
      market,
      cachedAt: new Date().toISOString(),
      snapshot: compactWorkspaceSnapshot(snapshot),
      quoteOverlays,
      monitor,
      paperAgents,
      paperEvents,
      runtime: runtimeEvents.summary(),
      localFirst: true,
      order_execution_enabled: false,
    });
    return;
  }

  if (url.pathname === "/api/paper-agents" && req.method === "GET") {
    sendJson(res, 200, await runPythonQuantCore("paper-agent-summary", { market: marketFromUrl(url) }));
    return;
  }

  if (url.pathname === "/api/paper-agents/config" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const market = safeMarket(payload.market || marketFromUrl(url));
    const result = await runPythonQuantCore("paper-agent-config", { market, config: payload.config || payload });
    runtimeEvents.publish("paper-agent.config", { market, revision: result.revision });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/paper-agents/reset" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const market = safeMarket(payload.market || marketFromUrl(url));
    const result = await runPythonQuantCore("paper-agent-reset", { market, preserveMemory: payload.preserveMemory !== false });
    runtimeEvents.publish("paper-agent.reset", { market, revision: result.revision });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/paper-agents/migrate" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const market = safeMarket(payload.market || marketFromUrl(url));
    const result = await runPythonQuantCore("paper-agent-migrate", { ...payload, market });
    runtimeEvents.publish("paper-agent.migrated", { market, revision: result.revision, migrated: result.migrated });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/paper-agents/events" && req.method === "GET") {
    sendJson(res, 200, await runPythonQuantCore("paper-agent-events", {
      market: marketFromUrl(url),
      since: url.searchParams.get("since") || "",
      limit: Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 100))),
    }));
    return;
  }

  const jobRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobRoute && req.method === "POST") {
    const payload = await readJsonBody(req);
    sendJson(res, 202, await backgroundJobs.create(decodeURIComponent(jobRoute[1]), payload));
    return;
  }
  if (jobRoute && req.method === "GET") {
    const job = await backgroundJobs.get(decodeURIComponent(jobRoute[1]));
    sendJson(res, job ? 200 : 404, job || { error: "Background job not found." });
    return;
  }

  if (url.pathname === "/api/health") {
    const sampleCode = { ASX: "BHP", US: "AAPL", CN: "600519" };
    const markets = Object.keys(MARKET_CONFIG).reduce((acc, market) => {
      acc[market] = {
        provider: providerForMarket(market),
        candidates: providerCandidates(market, sampleCode[market], "1mo", "1d").map(([source]) => source),
      };
      return acc;
    }, {});
    const [pythonCore, reddit] = await Promise.all([
      runPythonQuantCore("health").catch((error) => ({
        ok: false,
        service: "quant-core-python",
        error: error.message || String(error),
        order_execution_enabled: false,
      })),
      redditProviderStatus(null, { compact: true }).catch((error) => ({
        available: false,
        configured: false,
        enabled: redditEnabled(),
        provider: "reddit-social",
        lastError: error.message || String(error),
      })),
    ]);
    sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      startedAt: SERVER_STARTED_AT,
      markets,
      pythonCore,
      reddit,
      externalAi: {
        enabled: externalAiEnabled(),
        providers: aiProviderStatus(),
      },
      atas: {
        configured: Boolean(process.env.ATAS_API_KEY),
        endpointConfigured: Boolean(process.env.ATAS_FEATURE_ENDPOINT || process.env.ATAS_BASE_URL),
      },
      cnKeyedFallbacksEnabled: cnKeyedFallbacksEnabled(),
      cnExtraKeyedFallbacksEnabled: cnExtraKeyedFallbacksEnabled(),
    });
    return;
  }

  if (url.pathname === "/api/provider-budget" && req.method === "GET") {
    const market = marketFromUrl(url);
    const sampleCode = normalizeMarketSymbol(url.searchParams.get("symbol") || { ASX: "BHP", US: "AAPL", CN: "600519" }[market], market);
    const candidates = providerCandidates(market, sampleCode, "9mo", "1d").map(([source]) => source);
    const configured = Object.fromEntries(candidates.map((source) => [source, providerConfigured(source)]));
    sendJson(res, 200, await runPythonQuantCore("provider-budget", { market, candidates, configured }));
    return;
  }

  if (url.pathname === "/api/news-provider-status" && req.method === "GET") {
    sendJson(res, 200, newsProviderStatus());
    return;
  }

  if (url.pathname === "/api/social/reddit/status" && req.method === "GET") {
    sendJson(res, 200, await redditProviderStatus());
    return;
  }

  if (url.pathname === "/api/data-health" && req.method === "GET") {
    const market = marketFromUrl(url);
    const sampleCode = normalizeMarketSymbol(url.searchParams.get("symbol") || { ASX: "BHP", US: "AAPL", CN: "600519" }[market], market);
    const providerRows = providerCandidates(market, sampleCode, "9mo", "1d");
    const candidates = providerRows.map(([source]) => source);
    const configured = Object.fromEntries(candidates.map((source) => [source, providerConfigured(source)]));
    const [budget, capabilities, newsCache, redditStatus] = await Promise.all([
      runPythonQuantCore("provider-budget", { market, candidates, configured }).catch((error) => ({ error: error.message, providers: [], policy: {} })),
      dataCapabilities(market, sampleCode).catch((error) => ({ error: error.message })),
      newsDiskCacheSummary(market),
      redditProviderStatus(market, { compact: true }),
    ]);
    const capabilityBySource = new Map(providerCapabilityRows(providerRows).map((row) => [row.source, row]));
    const marketProviders = (budget.providers || []).map((row) => ({
      ...row,
      ...(capabilityBySource.get(row.name || row.source) || {}),
    }));
    sendJson(res, 200, {
      ok: true,
      market,
      symbol: sampleCode,
      updatedAt: new Date().toISOString(),
      marketProviders,
      providerPolicy: budget.policy || {},
      capabilities,
      newsProviders: newsProviderStatus().providers || [],
      newsPrimary: newsProviderStatus().primary || process.env.NEWS_PRIMARY_PROVIDER || "auto",
      newsCache,
      socialProviders: [redditStatus],
      redditSocial: redditStatus,
      refreshSchedule: newsRefreshDecision(market, newsCache.summary?.latestCachedAt || null),
      cachePolicy: {
        localFirst: true,
        diskTtlDays: Math.round(NEWS_DISK_CACHE_TTL_MS / 86400000),
        cleanupEveryDays: Math.round(NEWS_DISK_CACHE_CLEANUP_MS / 86400000),
        autoRefreshWindows: newsRefreshSlotsForMarket(market),
      },
    });
    return;
  }

  if (url.pathname === "/api/backend-monitor/status" && req.method === "GET") {
    sendJson(res, 200, await backendMonitorStatus());
    return;
  }

  if (url.pathname === "/api/model-trajectories" && req.method === "GET") {
    const market = marketFromUrl(url);
    const limit = Math.max(30, Math.min(500, Number(url.searchParams.get("limit") || 180)));
    sendJson(res, 200, await loadModelTrajectories({ snapshotBasePath, market, limit }));
    return;
  }

  if (url.pathname === "/api/backend-monitor/config") {
    if (req.method === "GET") {
      sendJson(res, 200, await readBackendMonitorConfig());
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      sendJson(res, 200, await writeBackendMonitorConfig(payload));
      return;
    }
  }

  if (url.pathname === "/api/backend-monitor/run" && req.method === "POST") {
    sendJson(res, 202, await runBackendMonitorTick("manual-api"));
    return;
  }

  if (url.pathname === "/api/qlib-readiness" && req.method === "GET") {
    sendJson(res, 200, await runPythonQuantCore("qlib-readiness"));
    return;
  }

  if (url.pathname === "/api/data-capabilities" && req.method === "GET") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    sendJson(res, 200, await dataCapabilities(market, symbol));
    return;
  }

  if (url.pathname === "/api/universe" && req.method === "GET") {
    const market = marketFromUrl(url);
    const force = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
    const payload = await fetchMarketUniverse(market, { force });
    sendJson(res, 200, universePayload(payload, {
      market,
      limit: url.searchParams.get("limit") || 500,
      offset: url.searchParams.get("offset") || 0,
      search: url.searchParams.get("search") || "",
    }));
    return;
  }

  if (url.pathname === "/api/market-movers" && req.method === "GET") {
    const market = marketFromUrl(url);
    const force = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
    const limit = Math.max(5, Math.min(50, Number(url.searchParams.get("limit") || 30)));
    const requestedScanLimit = Number(url.searchParams.get("scanLimit") || process.env.MOVERS_SCAN_LIMIT || 0);
    const scanLimit = Number.isFinite(requestedScanLimit) && requestedScanLimit > 0
      ? Math.max(limit * 4, Math.min(2000, requestedScanLimit))
      : undefined;
    const [movers, dragonTiger] = await Promise.all([
      fetchMarketMovers(market, { force, limit, scanLimit }),
      fetchDragonTiger(market, { limit }).catch((error) => ({
        market,
        available: false,
        source: "dragon-tiger-unavailable",
        rows: [],
        warning: error.message || String(error),
        updatedAt: new Date().toISOString(),
      })),
    ]);
    sendJson(res, 200, { ...movers, dragonTiger });
    return;
  }

  if (url.pathname === "/api/features" && req.method === "GET") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const range = url.searchParams.get("range") || "9mo";
    const interval = url.searchParams.get("interval") || "1d";
    const marketData = await quantLabMarketData(symbol, market, range, interval);
    const footprint = await attachUsTradeFootprint({
      market,
      symbol,
      interval,
      candles: marketData.candles,
    });
    const result = await runPythonQuantCore("feature-analysis", {
      market,
      symbol,
      interval,
      source: footprint.footprint?.available ? `${marketData.source}+${footprint.footprint.source}` : marketData.source,
      candles: footprint.candles,
    });
    const atas = await fetchAtasFeatureExtraction({ market, symbol, interval, candles: footprint.candles, result });
    sendJson(res, 200, {
      ...result,
      atas,
      trade_footprint: footprint.footprint,
      validation: marketData.validation || null,
      warning: marketData.warning || "",
      snapshotSavedAt: marketData.snapshotSavedAt || null,
    });
    return;
  }

  if (url.pathname === "/api/trades" && req.method === "GET") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const windowMinutes = Math.max(1, Math.min(390, Number(url.searchParams.get("windowMinutes") || 30)));
    if (market !== "US") {
      sendJson(res, 200, {
        available: false,
        market,
        symbol,
        true_tick: false,
        true_l2: false,
        aggressor_side_available: false,
        reason: `${market} real tick/trade data requires a separately authorised or licensed feed; candle proxies are not returned as trades.`,
      });
      return;
    }
    let liveError = null;
    let l1 = { available: false, true_l1: false, true_l2: false, source: "", origin: "unavailable" };
    let l2 = { available: false, true_l2: false, source: "", origin: "unavailable", note: "No authorised L2/depth rows are stored locally." };
    try {
      if (!alpacaConfigured()) {
        throw new Error("Configure ALPACA_API_KEY and ALPACA_API_SECRET to read real US trades and L1 quotes.");
      }
      const quoteData = await fetchAlpacaUsLatestQuote(symbol).catch((error) => ({
        available: false,
        error: String(error.message || error).slice(0, 240),
      }));
      if (quoteData.available) {
        const quotePersistence = await recordAuthorizedMarketRows({
          market,
          symbol,
          dataType: "l1",
          source: quoteData.source,
          rows: quoteData.quotes,
        });
        l1 = l1QuoteSummary(quoteData.latest, quoteData.source, "live", quotePersistence);
      }
      const tradeData = await fetchAlpacaUsTrades(symbol, windowMinutes);
      const tickPersistence = await recordAuthorizedMarketRows({
        market,
        symbol,
        dataType: "ticks",
        source: tradeData.source,
        rows: tradeData.trades,
      });
      const localBoundary = await localMarketDataBoundary(market, symbol);
      if (!l1.available && localBoundary.l1.available) l1 = localBoundary.l1;
      l2 = localBoundary.l2;
      const result = await runPythonQuantCore("trade-analysis", {
        market,
        symbol,
        source: tradeData.source,
        trades: tradeData.trades,
      });
      sendJson(res, 200, {
        ...result,
        window_minutes: windowMinutes,
        next_page_token: tradeData.nextPageToken,
        local_replay: false,
        persistence: {
          ticks: tickPersistence,
          l1,
        },
        l1_quote: l1,
        l2_depth: l2,
        data_boundary: [
          "Trades are real provider-reported ticks and are persisted locally for replay.",
          "L1 quotes are persisted only when Alpaca returns bid/ask rows.",
          "True L2/depth is not inferred from trades, quotes, or candles.",
        ],
      });
      return;
    } catch (error) {
      liveError = String(error.message || error).slice(0, 240);
    }

    const [localTicks, localBoundary] = await Promise.all([
      listAuthorizedMarketRows({ market, symbol, dataType: "ticks", limit: Math.max(200, Number(process.env.ALPACA_TRADES_LIMIT || 1000)) }),
      localMarketDataBoundary(market, symbol),
    ]);
    const localTrades = localTickRowsAsTrades(localTicks.rows || []);
    if (localTrades.length) {
      const result = await runPythonQuantCore("trade-analysis", {
        market,
        symbol,
        source: "local-authorized-us-tick-cache",
        trades: localTrades,
      });
      sendJson(res, 200, {
        ...result,
        window_minutes: windowMinutes,
        source: "local-authorized-us-tick-cache",
        local_replay: true,
        provider_error: liveError,
        l1_quote: localBoundary.l1,
        l2_depth: localBoundary.l2,
        data_boundary: [
          "Live Alpaca trades were unavailable; this analysis replays locally persisted real ticks.",
          "Cached ticks remain real provider-reported trades, not simulated data.",
          "True L2/depth is not inferred from trades, quotes, or candles.",
        ],
      });
      return;
    }

    sendJson(res, 200, {
      available: false,
      market,
      symbol,
      true_tick: false,
      true_l1: Boolean(localBoundary.l1?.available),
      true_l2: Boolean(localBoundary.l2?.available),
      aggressor_side_available: false,
      local_replay: false,
      l1_quote: localBoundary.l1,
      l2_depth: localBoundary.l2,
      reason: `Real US trade provider unavailable and no local authorised tick cache exists: ${liveError || "unknown provider error"}`,
    });
    return;
  }

  if (url.pathname === "/api/factor-lab" && req.method === "GET") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const horizonDays = Math.max(1, Math.min(60, Number(url.searchParams.get("horizonDays") || 15)));
    const marketData = await quantLabMarketData(symbol, market, process.env.FACTOR_LAB_RANGE || "5y", "1d");
    const result = await runPythonQuantCore("factor-lab", {
      market,
      symbol,
      horizon_days: horizonDays,
      candles: marketData.candles,
    });
    const savedFactorResearch = await writeFactorResearchModelSnapshot(market, symbol, result).catch(() => null);
    if (savedFactorResearch) {
      await appendModelChangeLogFile(market, {
        event_type: "model-change-log-factor-research",
        entity_id: `${market}:${symbol}:factor-lab:${savedFactorResearch.savedAt}`,
        payload: {
          title: "因子实验室更新动态权重",
          type: "factor-research-ml",
          market,
          symbol,
          framework: savedFactorResearch.framework,
          sampleCount: savedFactorResearch.sampleCount,
          candidateCount: savedFactorResearch.candidateCount,
          admittedCount: savedFactorResearch.admittedCount,
          liveScore: savedFactorResearch.liveSignal?.score,
          holdout: savedFactorResearch.mlBacktest?.test || null,
          leakageControl: savedFactorResearch.leakageControl,
        },
      }).catch(() => null);
    }
    sendJson(res, 200, {
      ...result,
      source: marketData.source,
      validation: marketData.validation || null,
      warning: marketData.warning || "",
      snapshotSavedAt: marketData.snapshotSavedAt || null,
      savedFactorResearch,
    });
    return;
  }

  if (url.pathname === "/api/ibkr/readiness" && req.method === "POST") {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await runPythonQuantCore("ibkr-readiness", {
      host: payload.host || process.env.IBKR_HOST || "127.0.0.1",
      port: Number(payload.port || process.env.IBKR_PAPER_PORT || 7497),
      client_id: Number(payload.clientId || process.env.IBKR_CLIENT_ID || 17),
    }));
    return;
  }

  if (url.pathname === "/api/risk-assessment" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const market = safeMarket(payload.market || "ASX");
    const result = await runPythonQuantCore("risk-assessment", { ...payload, market });
    if (payload.persist !== false) {
      await runPythonQuantCore("event-append", {
        market,
        event_type: "risk-assessment",
        entity_id: `${market}:${result.evaluated_at}`,
        payload: result,
      }).catch(() => null);
    }
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/order-intents") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      sendJson(res, 200, await runPythonQuantCore("order-intent-list", {
        market,
        limit: Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50))),
      }));
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      sendJson(res, 200, await runPythonQuantCore("order-intent", { ...payload, market }));
      return;
    }
  }

  if (url.pathname === "/api/control-plane" && req.method === "GET") {
    const market = marketFromUrl(url);
    sendJson(res, 200, await runPythonQuantCore("control-plane-summary", { market }));
    return;
  }

  if (url.pathname === "/api/market-data") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    if (req.method === "GET") {
      const wantsRows = ["1", "true", "yes"].includes(String(url.searchParams.get("rows") || "").toLowerCase());
      if (wantsRows) {
        sendJson(res, 200, await runPythonQuantCore("market-data-list", {
          market,
          symbol,
          data_type: url.searchParams.get("dataType") || url.searchParams.get("kind") || "ticks",
          limit: Math.max(1, Math.min(10000, Number(url.searchParams.get("limit") || 1000))),
        }));
        return;
      }
      sendJson(res, 200, await runPythonQuantCore("market-data-summary", { market, symbol }));
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      sendJson(res, 200, await runPythonQuantCore("market-data-record", {
        ...payload,
        market,
        symbol: symbol || normalizeMarketSymbol(payload.symbol || "", market),
      }));
      return;
    }
  }

  if (url.pathname === "/api/events") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      sendJson(res, 200, await runPythonQuantCore("event-list", {
        market,
        event_type: url.searchParams.get("eventType") || "",
        limit: Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 100))),
      }));
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      const result = await runPythonQuantCore("event-append", { ...payload, market });
      if (/^model-change-log/.test(String(payload.event_type || ""))) {
        await appendModelChangeLogFile(market, payload).catch(() => null);
      }
      sendJson(res, 200, result);
      return;
    }
  }

  if (url.pathname === "/api/research-config") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      sendJson(res, 200, await readResearchConfig(market));
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      const config = await writeResearchConfig({ ...payload, market, updatedAt: new Date().toISOString() }, market);
      await runPythonQuantCore("event-append", {
        market,
        event_type: "research-config",
        entity_id: `${market}:${config.updatedAt}`,
        payload: config,
      }).catch(() => null);
      sendJson(res, 200, config);
      return;
    }
  }

  if (url.pathname === "/api/accuracy") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      const samples = await readPredictionSamples(market);
      sendJson(res, 200, await summarizePredictionSamplesWithLocalModel(samples, market));
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      await appendPredictionRecordFile(market, Array.isArray(payload.samples) ? payload.samples : []).catch(() => null);
      const summary = await updatePredictionSamples(market, Array.isArray(payload.samples) ? payload.samples : [], {
        activeSymbols: payload.activeSymbols,
        cancelSymbols: payload.cancelSymbols,
      });
      await writeModelCalibrationSnapshot(market, summary).catch(() => null);
      await appendAdaptiveModelAdjustmentLog(market, summary).catch(() => null);
      sendJson(res, 200, summary);
      return;
    }
    if (req.method === "DELETE") {
      const symbols = url.searchParams.get("symbols") || url.searchParams.get("symbol") || "";
      const summary = await updatePredictionSamples(market, [], { cancelSymbols: symbols.split(",") });
      await writeModelCalibrationSnapshot(market, summary).catch(() => null);
      sendJson(res, 200, summary);
      return;
    }
  }

  if (url.pathname === "/api/snapshot") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      const snapshot = await readServerSnapshotForMarket(market);
      if (!snapshot) {
        sendJson(res, 404, { error: "No server snapshot saved yet." });
        return;
      }
      const quoteOverlays = await readLatestMarketOverlays(
        market,
        snapshotSymbolsForMarketOverlay(snapshot, market),
        snapshot,
      ).catch(() => []);
      sendJson(res, 200, { ...snapshot, quoteOverlays });
      return;
    }
    if (req.method === "POST") {
      const payload = await readJsonBody(req, { maxBytes: Number(process.env.SNAPSHOT_JSON_BODY_LIMIT_BYTES || 8 * 1024 * 1024) });
      const snapshot = sanitizeSnapshot({ ...payload, market }, market);
      if (!snapshot) {
        sendJson(res, 400, { error: "Snapshot requires at least one usable real analysis row with candles and technical fields." });
        return;
      }
      await writeServerSnapshot({ ...snapshot, savedAt: new Date().toISOString() });
      sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
      return;
    }
    if (req.method === "DELETE") {
      const symbols = url.searchParams.get("symbols") || url.searchParams.get("symbol") || "";
      const result = await deleteServerSnapshotSymbols(market, symbols.split(","));
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
  }

  if (url.pathname === "/api/quotes/batch" && req.method === "POST") {
    const payload = await readJsonBody(req, { maxBytes: 256 * 1024 });
    const market = safeMarket(payload.market || marketFromUrl(url));
    const symbols = [...new Set((Array.isArray(payload.symbols) ? payload.symbols : [])
      .map((symbol) => normalizeMarketSymbol(symbol, market))
      .filter((symbol) => symbol && isValidMarketCode(symbol, market)))]
      .slice(0, Math.max(1, Math.min(80, Number(process.env.MANUAL_QUOTE_BATCH_LIMIT || 80))));
    if (!symbols.length) {
      sendJson(res, 400, { error: "At least one valid market-native symbol is required." });
      return;
    }
    const overlays = [];
    const errors = [];
    const concurrency = Math.max(1, Math.min(10, Number(process.env.MANUAL_QUOTE_CONCURRENCY || 6)));
    let cursor = 0;
    async function worker() {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor];
        cursor += 1;
        try {
          const result = await prepareBackendQuoteSymbol({ market, symbol, tier: "manual" }, { manual: true });
          overlays.push(result.overlay);
          runtimeEvents.publish("market.quote", result.overlay);
        } catch (error) {
          errors.push({ symbol, error: error.message || String(error) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()));
    overlays.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
    sendJson(res, 200, {
      ok: overlays.length > 0,
      market,
      requested: symbols.length,
      updated: overlays.length,
      failed: errors.length,
      refreshedAt: new Date().toISOString(),
      overlays,
      errors,
      strictFreshness: true,
      maxOpenMarketAgeMs: realtimeQuoteMaxAgeMs(market),
    });
    return;
  }

  if (url.pathname.startsWith("/api/market/")) {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(decodeURIComponent(url.pathname.split("/").pop()), market);
    const range = url.searchParams.get("range") || "6mo";
    const interval = url.searchParams.get("interval") || "1d";
    const forceFresh = url.searchParams.get("fresh") === "1";
    const cacheKey = `${market}:${symbol}:${range}:${interval}`;
    const cached = marketResponseCache.get(cacheKey);
    if (!forceFresh && cached && Date.now() - cached.time < Number(process.env.MARKET_CACHE_TTL_MS || 60000)) {
      sendJson(res, 200, cached.value);
      return;
    }
    const isCashIndex = /^\^/.test(cleanCode(symbol, market));
    const indexQuotePromise = isCashIndex
      ? fetchRealtimeQuote(symbol, market, null, { force: forceFresh, strict: forceFresh }).catch((error) => ({ unavailable: true, warning: error.message || String(error) }))
      : null;
    let marketData;
    let marketError = null;
    try {
      marketData = await fetchMarketCandles(symbol, range, interval, market);
    } catch (error) {
      marketError = error;
    }
    if (!marketData || !marketData.candles?.length) {
      marketData = await fetchSnapshotMarketCandles(symbol, range, interval, market, marketError);
    }
    if (!marketData || !marketData.candles?.length) {
      marketData = await fetchCachedMarketHistory(symbol, range, interval, market, marketError);
    }
    if ((!marketData || !marketData.candles?.length) && isCashIndex) {
      const quoteFallback = await indexQuotePromise;
      const quoteCandles = quoteToCandles(quoteFallback);
      if (quoteCandles.length) {
        const historyWarning = marketError
          ? `Historical index candles unavailable; showing real cash index point only. ${compactProviderErrors([marketError.message || marketError]).join(" | ")}`
          : "Historical index candles unavailable; showing real cash index point only.";
        marketData = {
          candles: quoteCandles,
          quote: quoteFallback,
          source: `${quoteFallback.source}-quote-only`,
          quoteOnly: true,
          unit: "points",
          warning: historyWarning,
          validation: {
            ok: true,
            status: "real_quote_only",
            degraded: true,
            primary: { source: quoteFallback.source, date: quoteFallback.date, close: quoteFallback.price, volume: quoteFallback.volume },
            message: "Real cash index quote was available, but historical candles were unavailable.",
          },
        };
      }
    }
    if (!marketData) throw marketError || new Error(`No real market data returned for ${symbol}`);
    if (!marketData.candles.length) throw new Error(`No real candles returned for ${symbol} from ${marketData.source}`);
    const latest = latestByDate(marketData.candles);
    let realtimeQuote;
    try {
      const sameSourceCandleQuote = market === "CN"
        ? quoteFromCandleRows(symbol, market, marketData.candles, `${marketData.source || "cn-real"}-latest-quote`)
        : null;
      const requireFreshQuote = forceFresh || backendMarketSession(market).open;
      const liveQuote = isCashIndex && indexQuotePromise
        ? await indexQuotePromise
        : await fetchRealtimeQuote(symbol, market, latest?.close, { force: forceFresh, strict: requireFreshQuote });
      realtimeQuote = liveQuote && !liveQuote.unavailable
        ? liveQuote
        : (!forceFresh ? sameSourceCandleQuote : null)
          || (!forceFresh && marketData.quote && !marketData.quote.unavailable
            ? normalizeQuote(marketData.quote, market, latest?.close)
            : liveQuote);
    } catch (error) {
      realtimeQuote = { unavailable: true, warning: error.message || String(error) };
    }
    const quoteCheck = sanitizeQuoteChangeAgainstCandles(symbol, market, marketData.candles, realtimeQuote);
    realtimeQuote = quoteCheck.quote;
    const candles = mergeQuoteIntoCandles(marketData.candles, realtimeQuote, market);
    writeMarketHistoryCache(market, symbol, interval, candles, { ...marketData, quote: realtimeQuote }).catch(() => {});
    const quoteWarning = realtimeQuote?.unavailable && realtimeQuote.warning ? `Realtime quote unavailable. ${realtimeQuote.warning}` : "";
    const payload = {
      symbol,
      market,
      ...marketData,
      candles,
      quote: realtimeQuote?.unavailable ? null : realtimeQuote,
      retrievedAt: realtimeQuote?.retrievedAt || new Date().toISOString(),
      quoteWarning,
      warning: [marketData.warning, quoteWarning, quoteCheck.warning].filter(Boolean).join(" | "),
    };
    marketResponseCache.set(cacheKey, { time: Date.now(), value: payload });
    if (marketResponseCache.size > 120) marketResponseCache.delete(marketResponseCache.keys().next().value);
    sendJson(res, 200, payload);
    return;
  }

  if (url.pathname === "/api/news") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const scope = url.searchParams.get("scope") || "all";
    const mode = url.searchParams.get("mode") || "auto";
    const news = await fetchNewsItems(symbol, market, scope, { mode });
    sendJson(res, 200, { symbol, market, ...news });
    return;
  }

  if (url.pathname === "/api/social/reddit" && req.method === "GET") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const mode = url.searchParams.get("mode") || "auto";
    const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") || 10)));
    const factor = await fetchRedditSocialFactor(symbol, market, { mode, limit });
    sendJson(res, 200, { symbol, market, ...factor });
    return;
  }

  if (url.pathname === "/api/social/reddit/background" && req.method === "GET") {
    const market = marketFromUrl(url);
    const rawSymbols = String(url.searchParams.get("symbols") || url.searchParams.get("symbol") || "");
    const symbols = rawSymbols
      ? rawSymbols.split(",").map((item) => item.trim()).filter(Boolean)
      : MARKET_CONFIG[market].defaultSymbols || [];
    const force = ["1", "true", "yes", "refresh"].includes(String(url.searchParams.get("force") || "").toLowerCase());
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") || 10)));
    const maxSymbols = Math.max(1, Math.min(200, Number(url.searchParams.get("maxSymbols") || process.env.REDDIT_BACKGROUND_MAX_SYMBOLS || 80)));
    const result = queueRedditBackgroundRefresh(market, symbols, {
      force,
      limit,
      maxSymbols,
      reason: url.searchParams.get("reason") || "api",
    });
    sendJson(res, 202, result);
    return;
  }

  if (url.pathname === "/api/social/reddit/cache" && req.method === "DELETE") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const deleted = await deleteRedditCache(market, symbol);
    invalidateRedditDerivedCaches(market, symbol);
    sendJson(res, 200, { ok: true, market, symbol, deleted });
    return;
  }

  if (url.pathname === "/api/fundamentals") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    sendJson(res, 200, { symbol, market, ...(await fetchFundamentals(symbol, market)) });
    return;
  }

  if (url.pathname === "/api/factors") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const strategy = {
      horizonDays: Number(url.searchParams.get("horizonDays") || 15),
      targetUpside: Number(url.searchParams.get("targetUpside") || 5),
      stopLoss: Number(url.searchParams.get("stopLoss") || 4),
    };
    sendJson(res, 200, await fetchFactorLayer(symbol, strategy, market));
    return;
  }

  if (url.pathname === "/api/historical-backtest" && req.method === "GET") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    const range = url.searchParams.get("range") || "5y";
    const strategy = {
      horizonDays: Number(url.searchParams.get("horizonDays") || 15),
      targetUpside: Number(url.searchParams.get("targetUpside") || 5),
      stopLoss: Number(url.searchParams.get("stopLoss") || 4),
    };
    const marketData = await fetchBacktestCandlesForSymbol(symbol, market, range);
    const result = await historicalBacktestForCandles({
      market,
      symbol,
      candles: marketData.candles,
      strategy,
      source: marketData.source,
    });
    sendJson(res, 200, { ...result, range, dataSource: marketData });
    return;
  }

  if (url.pathname === "/api/historical-backtest-batch" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const market = safeMarket(payload.market || marketFromUrl(url));
    const strategy = {
      horizonDays: Number(payload.horizonDays || payload.strategy?.horizonDays || 15),
      targetUpside: Number(payload.targetUpside || payload.strategy?.targetUpside || 5),
      stopLoss: Number(payload.stopLoss || payload.strategy?.stopLoss || 4),
    };
    sendJson(res, 200, await historicalBacktestBatch({
      market,
      symbols: payload.symbols || [],
      strategy,
      range: payload.range || "",
      limit: payload.limit,
      largeSample: payload.largeSample !== false,
      productionTraining: payload.productionTraining === true,
    }));
    return;
  }

  if (url.pathname === "/api/factor-evolution/status" && req.method === "GET") {
    sendJson(res, 200, await factorEvolutionSchedulerStatus());
    return;
  }

  if (url.pathname === "/api/factor-evolution/run" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const mode = String(payload.mode || "light").toLowerCase() === "heavy" ? "heavy" : "light";
    sendJson(res, 202, await runFactorEvolutionCycle(mode, {
      limit: payload.limit,
      generations: payload.generations,
      population: payload.population,
    }));
    return;
  }

  if (url.pathname === "/api/factor-research-batch" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const market = safeMarket(payload.market || marketFromUrl(url));
    const trainingUniverse = await expandTrainingSymbolsForMarket({
      market,
      symbols: payload.symbols || [],
      limit: payload.limit || process.env.FACTOR_RESEARCH_BATCH_SYMBOL_LIMIT || process.env.HISTORICAL_BACKTEST_LARGE_SAMPLE_LIMIT || 80,
      largeSample: payload.largeSample !== false,
    });
    const symbols = trainingUniverse.trainingSymbols;
    const range = payload.range || process.env.FACTOR_RESEARCH_BATCH_RANGE || "5y";
    const concurrency = Math.max(1, Math.min(5, Number(process.env.HISTORICAL_BACKTEST_FETCH_CONCURRENCY || 4)));
    const items = [];
    let cursor = 0;
    async function worker() {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor];
        cursor += 1;
        items.push(await fetchBacktestCandlesForSymbol(symbol, market, range));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()));
    const horizons = Array.isArray(payload.horizons) && payload.horizons.length
      ? payload.horizons.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : [5, Number(payload.horizonDays || 15), 30];
    sendJson(res, 200, {
      ...(await crossSectionalFactorResearchForItems({ market, items, horizons })),
      range,
      requestedSymbols: trainingUniverse.requestedSymbols,
      trainingSymbols: symbols,
      trainingUniverse,
      dataSources: items.map((item) => ({ symbol: item.symbol, source: item.source, candles: item.candles?.length || 0, warning: item.warning || item.error || "" })),
    });
    return;
  }

  if (url.pathname === "/api/x") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    sendJson(res, 200, { symbol, market, ...(await fetchXItems(symbol, market)) });
    return;
  }

  if (url.pathname === "/api/youtube") {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(url.searchParams.get("symbol") || "", market);
    sendJson(res, 200, { symbol, market, ...(await fetchYouTubeItems(symbol, market)) });
    return;
  }

  if (url.pathname === "/api/analyze" && req.method === "POST") {
    const input = await readJsonBody(req);
    sendJson(res, 200, await openAiAnalysis(input));
    return;
  }

  if (url.pathname === "/api/analyze-batch" && req.method === "POST") {
    const payload = await readJsonBody(req);
    sendJson(res, 200, payload.localOnly ? localBatchAnalysis(payload.items || []) : await openAiBatchAnalysis(payload.items || []));
    return;
  }

  if (url.pathname === "/api/assistant-chat" && req.method === "POST") {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await assistantChat(payload));
    return;
  }

  if (url.pathname === "/api/portfolio-image" && req.method === "POST") {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await parsePortfolioImage(payload.image, payload.market));
    return;
  }

  sendJson(res, 404, { error: "Unknown API route." });
}

backgroundJobs.register("monitor", async () => runBackendMonitorTick("background-job"));
backgroundJobs.register("training", async (payload, update) => {
  const config = await readBackendMonitorConfig();
  const runtime = await readBackendMonitorRuntime();
  await update(0.2, { phase: "loading-local-bars" });
  const result = await runBackendIntradayTraining(config, runtime);
  await writeBackendMonitorRuntime(runtime);
  await update(0.95, { phase: "persisted-model" });
  return result;
});
backgroundJobs.register("backtest", async (payload, update) => {
  await update(0.1, { phase: "loading-point-in-time-history" });
  const result = await historicalBacktestBatch({
    market: safeMarket(payload.market || "ASX"),
    symbols: payload.symbols || [],
    strategy: normalizeBackendStrategy(payload.strategy || payload),
    range: payload.range || "",
    limit: payload.limit,
    largeSample: payload.largeSample !== false,
    productionTraining: payload.productionTraining !== false,
  });
  await update(0.95, { phase: "persisting-evidence" });
  return result;
});
backgroundJobs.register("news", async (payload, update) => {
  const market = safeMarket(payload.market || "ASX");
  const config = await readBackendMonitorConfig();
  const configured = config.markets?.[market] || {};
  const symbols = [...new Set((payload.symbols || [...(configured.portfolio || []).map((row) => row.symbol), ...(configured.watchlist || [])])
    .map((symbol) => normalizeMarketSymbol(symbol, market)).filter((symbol) => isValidMarketCode(symbol, market)))].slice(0, 80);
  const results = [];
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index];
    try {
      const value = await fetchNewsItems(symbol, market, "all", { mode: payload.force ? "refresh" : "auto" });
      results.push({ symbol, source: value.source, count: value.news?.length || 0, warning: value.warning || "" });
    } catch (error) {
      results.push({ symbol, error: error.message || String(error) });
    }
    await update((index + 1) / Math.max(1, symbols.length) * 0.9, { symbol, completed: index + 1, total: symbols.length });
  }
  return { market, symbols: results, refreshedAt: new Date().toISOString() };
});
backgroundJobs.register("reddit", async (payload, update) => {
  const market = safeMarket(payload.market || "ASX");
  const config = await readBackendMonitorConfig();
  const configured = config.markets?.[market] || {};
  const symbols = [...new Set((payload.symbols || [...(configured.portfolio || []).map((row) => row.symbol), ...(configured.watchlist || [])])
    .map((symbol) => normalizeMarketSymbol(symbol, market)).filter((symbol) => isValidMarketCode(symbol, market) && !symbol.startsWith("^")))].slice(0, 80);
  const results = [];
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index];
    try {
      const value = await fetchRedditSocialFactor(symbol, market, { mode: payload.force ? "refresh" : "auto", background: true, limit: 10, timeoutMs: 20_000 });
      results.push({ symbol, available: value.available !== false, score: value.score || 0, count: value.items?.length || 0 });
    } catch (error) {
      results.push({ symbol, available: false, error: error.message || String(error) });
    }
    await update((index + 1) / Math.max(1, symbols.length) * 0.9, { symbol, completed: index + 1, total: symbols.length });
  }
  return { market, symbols: results, refreshedAt: new Date().toISOString() };
});

async function runBackendEnrichmentSchedulerTick() {
  const config = await readBackendMonitorConfig();
  if (!config.enabled) return { skipped: true, reason: "backend monitor disabled" };
  const runtime = await readBackendMonitorRuntime();
  runtime.lastRedditWarmupByMarket = runtime.lastRedditWarmupByMarket || {};
  runtime.lastNewsScheduleByMarket = runtime.lastNewsScheduleByMarket || {};
  const queued = [];
  for (const market of Object.keys(MARKET_CONFIG)) {
    const cache = await newsDiskCacheSummary(market).catch(() => ({ summary: {} }));
    const decision = newsRefreshDecision(market, cache.summary?.latestCachedAt || null);
    const slotKey = `${decision.slot?.id || decision.reason || "none"}:${zonedDateParts(new Date(), backendMarketSession(market).timeZone).date}`;
    if (decision.due && runtime.lastNewsScheduleByMarket[market] !== slotKey) {
      const job = await backgroundJobs.create("news", { market, force: true, reason: "scheduled-window" });
      runtime.lastNewsScheduleByMarket[market] = slotKey;
      queued.push(job.id);
    }
    const redditEveryMs = Math.max(30 * 60_000, Number(process.env.REDDIT_REFRESH_MS || 60 * 60_000));
    if (Date.now() - Number(runtime.lastRedditWarmupByMarket[market] || 0) >= redditEveryMs) {
      const job = await backgroundJobs.create("reddit", { market, force: false, reason: "scheduled-cache-warmup" });
      runtime.lastRedditWarmupByMarket[market] = Date.now();
      queued.push(job.id);
    }
  }
  runtime.lastEnrichmentCheckAt = new Date().toISOString();
  await writeBackendMonitorRuntime(runtime);
  return { queued };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStaticRequest(req, res, url, { root });
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    sendJson(res, status, { error: error.message || "Server error." });
  }
});

cleanupNewsDiskCache(true).catch((error) => {
  console.warn(`News disk cache cleanup skipped: ${error.message}`);
});
const newsCleanupTimer = setInterval(() => {
  cleanupNewsDiskCache(true).catch((error) => {
    console.warn(`News disk cache cleanup skipped: ${error.message}`);
  });
}, NEWS_DISK_CACHE_CLEANUP_MS);
newsCleanupTimer.unref?.();

function startBackendMonitorScheduler() {
  const defaults = backendMonitorDefaults();
  if (!defaults.enabled) {
    backendMonitorState.enabled = false;
    return;
  }
  backendMonitorState.enabled = true;
  backendMonitorState.startedAt = new Date().toISOString();
  const startupDelayMs = Math.max(15_000, Number(process.env.BACKEND_MONITOR_STARTUP_DELAY_MS || 45_000));
  const startupTimer = setTimeout(() => {
    runBackendMonitorTick("startup").catch((error) => {
      backendMonitorState.lastError = error.message || String(error);
      console.warn(`Backend monitor startup tick skipped: ${backendMonitorState.lastError}`);
    });
  }, startupDelayMs);
  startupTimer.unref?.();
  backendMonitorTimer = setInterval(() => {
    runBackendMonitorScheduledTick().catch((error) => {
      backendMonitorState.lastError = error.message || String(error);
      console.warn(`Backend monitor interval tick skipped: ${backendMonitorState.lastError}`);
    });
  }, defaults.refresh.checkMs);
  backendMonitorTimer.unref?.();
  const enrichmentCheckMs = Math.max(60_000, Number(process.env.BACKEND_ENRICHMENT_CHECK_MS || 15 * 60_000));
  const enrichmentStartupTimer = setTimeout(() => {
    runBackendEnrichmentSchedulerTick().catch((error) => {
      runtimeEvents.publish("enrichment.error", { error: error.message || String(error) });
    });
  }, Math.max(20_000, Number(process.env.BACKEND_ENRICHMENT_STARTUP_DELAY_MS || 70_000)));
  enrichmentStartupTimer.unref?.();
  backendEnrichmentTimer = setInterval(() => {
    runBackendEnrichmentSchedulerTick().catch((error) => {
      runtimeEvents.publish("enrichment.error", { error: error.message || String(error) });
    });
  }, enrichmentCheckMs);
  backendEnrichmentTimer.unref?.();
}

if (process.env.SERVER_DISABLE_LISTEN !== "true") {
  const evolutionConfig = factorEvolutionConfig();
  if (evolutionConfig.enabled) {
    const startupTimer = setTimeout(() => {
      tickFactorEvolutionScheduler("startup").catch((error) => {
        console.warn(`Factor evolution scheduler startup check skipped: ${error.message || error}`);
      });
    }, evolutionConfig.startupDelayMs);
    startupTimer.unref?.();
    const evolutionTimer = setInterval(() => {
      tickFactorEvolutionScheduler("interval").catch((error) => {
        console.warn(`Factor evolution scheduler interval check skipped: ${error.message || error}`);
      });
    }, evolutionConfig.checkIntervalMs);
    evolutionTimer.unref?.();
  }
  startBackendMonitorScheduler();
  server.listen(port, host, () => {
    console.log(`Global Quant Watch running at http://${host}:${port}`);
  });
}

export {
  aiProviderStatus,
  alpacaQuoteRows,
  alpacaRows,
  alpacaTradeRows,
  factorSignal,
  analysisBatchLimit,
  isLimitedProvider,
  localBatchAnalysis,
  localModelScopeForStrategy,
  providerConfigured,
  runPythonQuantCore,
  sanitizeResearchConfig,
  sanitizeUniverseRows,
  scoreRedditSocialPosts,
  redditCacheTtlForItem,
  redditProviderStatus,
  fetchRedditSocialFactor,
  historicalBacktestFactor,
  backendMarketSession,
  backendDueQuoteJobs,
  backendMonitorBudgetLimits,
  backendMonitorStatus,
  loadModelTrajectories,
  computeServerTechnicals,
  marketAnalysisEventFromMonitorResult,
  marketOverlayFromHistoryPayload,
  marketQuoteEventFromMonitorResult,
  mergeQuoteIntoCandles,
  predictionCandlesWithQuote,
  projectedMaxDownsideConfidenceMetrics,
  normalizeQuote,
  realtimeQuoteQuality,
  selectBestRealtimeQuote,
  sanitizeQuoteChangeAgainstCandles,
  validMarketQuoteDate,
  verifiedProviderTimestamp,
  intradaySampleRows,
  minuteLearningFactorFor,
  providerApiKeys,
  providerKeyPoolStatus,
  withProviderApiKey,
  sanitizeBackendMonitorConfig,
  trainIntradayLinearModel,
  stockAnalysisHistoryRows,
  tradeFootprintRows,
  tushareRows,
  universePayload,
};
