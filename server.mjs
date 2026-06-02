import { createServer } from "node:http";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname;

function loadLocalEnv() {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const APP_VERSION = "2026-06-03-final-max-confidence-v34";
const SERVER_STARTED_AT = new Date().toISOString();
const providerBackoff = new Map();
const marketResponseCache = new Map();
const marketCandlesCache = new Map();
const quoteResponseCache = new Map();
const factorResponseCache = new Map();
const newsResponseCache = new Map();
const secFilingsCache = new Map();
const snapshotBasePath = join(root, ".cache");
let alphaVantageNextRequestAt = 0;

const MARKET_CONFIG = {
  ASX: {
    code: "ASX",
    label: "ASX",
    currency: "AUD",
    newsName: "ASX Australia shares",
    benchmark: "^AXJO",
  },
  US: {
    code: "US",
    label: "US equities",
    currency: "USD",
    newsName: "US stock market Wall Street",
    benchmark: "^GSPC",
  },
  CN: {
    code: "CN",
    label: "China A-shares",
    currency: "CNY",
    newsName: "China A shares Shanghai Shenzhen",
    benchmark: "SH000001",
  },
};

const OBVIOUS_US_SYMBOLS = new Set([
  "AAPL", "MSFT", "NVDA", "TSLA", "GOOG", "GOOGL", "META", "AMZN", "AMD", "AVGO",
  "INTC", "NFLX", "ORCL", "CRM", "ADBE", "JPM", "BAC", "WFC", "GS", "MS", "XOM",
  "CVX", "COP", "SPY", "QQQ", "DIA", "IWM",
]);

const OBVIOUS_ASX_ONLY_SYMBOLS = new Set([
  "CBA", "NAB", "ANZ", "WBC", "WDS", "FMG", "WES", "WOW", "TLS", "COL", "MQG",
  "QBE", "REA", "COH", "SHL", "CPU", "ORG", "APA", "SCG", "NST", "S32", "MIN",
  "PLS", "LYC", "SEK", "PME", "STW", "VAS", "IOZ",
]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

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

function safeMarket(value) {
  return MARKET_CONFIG[value] ? value : "ASX";
}

function snapshotPathForMarket(market) {
  const key = safeMarket(market);
  return join(snapshotBasePath, key === "ASX" ? "analysis-snapshot.json" : `analysis-snapshot-${key.toLowerCase()}.json`);
}

function predictionSamplesPathForMarket(market) {
  return join(snapshotBasePath, `prediction-samples-${safeMarket(market).toLowerCase()}.json`);
}

async function readServerSnapshotForMarket(market) {
  try {
    return sanitizeSnapshot(JSON.parse(await readFile(snapshotPathForMarket(market), "utf8")), market);
  } catch {
    return null;
  }
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

function cleanCode(symbol, market = "ASX") {
  const key = safeMarket(market);
  const clean = String(symbol || "").trim().toUpperCase();
  if (key === "ASX") return clean.replace(/\.A[UX]$/, "");
  if (key === "CN") {
    const suffixMatch = clean.match(/^(\d{6})\.(SS|SH|SHH|SZ|SHE|SHZ)$/);
    if (suffixMatch && /^000|^399/.test(suffixMatch[1])) {
      return `${/^(SS|SH|SHH)$/.test(suffixMatch[2]) ? "SH" : "SZ"}${suffixMatch[1]}`;
    }
    const noSuffix = clean.replace(/\.(SS|SH|SHH|SZ|SHE|SHZ)$/, "");
    if (/^(SH000|SZ399)\d{3}$/.test(noSuffix)) return noSuffix;
    return noSuffix.replace(/^(SH|SZ)(?=\d{6}$)/, "");
  }
  return clean.replace(/\s+/g, "");
}

function isValidMarketCode(symbol, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  if (!code) return false;
  if (key === "CN") return /^\d{6}$/.test(code) || /^(SH000|SZ399)\d{3}$/.test(code);
  if (key === "US") {
    if (/\.A[UX]$/.test(code) || OBVIOUS_ASX_ONLY_SYMBOLS.has(code)) return false;
    if (/^\^[A-Z0-9.]{2,12}$/.test(code)) return true;
    return /^[A-Z][A-Z0-9.-]{0,9}$/.test(code);
  }
  if (/^\^[A-Z0-9.]{2,12}$/.test(code)) return true;
  if (OBVIOUS_US_SYMBOLS.has(code)) return false;
  return /^[A-Z0-9]{2,6}$/.test(code);
}

function assertValidMarketCode(symbol, market = "ASX") {
  if (!isValidMarketCode(symbol, market)) {
    throw new Error(`Invalid ${safeMarket(market)} symbol: ${String(symbol || "").trim() || "(empty)"}`);
  }
}

function normalizeMarketSymbol(symbol, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  if (!code) return "";
  if (!isValidMarketCode(code, key)) return "";
  if (code.startsWith("^")) return code;
  if (key === "ASX") return `${code}.AX`;
  return code;
}

function normalizeAsxSymbol(symbol) {
  return normalizeMarketSymbol(symbol, "ASX");
}

function cleanAsxCode(symbol) {
  return cleanCode(symbol, "ASX");
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
  const limit = Number(process.env.PREDICTION_SAMPLE_LIMIT || 3000);
  const rows = [...samples]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, limit);
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
  const interim = {
    observedDays: sameDayLiveOnly ? 0.5 : future.length,
    forwardReturnPct: ((Number(last.close) - entry) / entry) * 100,
    maxUpsidePct: ((maxHigh - entry) / entry) * 100,
    maxDrawdownPct: ((minLow - entry) / entry) * 100,
    targetProgress: Number(sample.targetUpside || 5) > 0 ? (((maxHigh - entry) / entry) * 100) / Number(sample.targetUpside || 5) : 0,
    adverse: sampleWasPositive(sample) && (((minLow - entry) / entry) * 100 <= -0.8 || ((Number(last.close) - entry) / entry) * 100 <= -0.6),
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
        changes,
        reasons: adjustment.reasons || [],
      };
    });
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
  const strategyBuckets = buildStrategyProbabilityBuckets(buyResolved);
  const modelStats = buildModelPerformanceStats(scoped);
  const regimeStats = buildRegimeStats(scoped);
  const errorTypeStats = buildErrorTypeStats(scoped);
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
    regimeStats,
    errorTypeStats,
    horizonStats: adaptive.horizonStats,
    adaptive,
    learningCurve: rollingLearningCurve(scoped),
    improvement: learningImprovement(scoped),
    learningEvents: buildLearningEvents(scoped, adaptive),
    accuracyBoostPlan: buildAccuracyBoostPlan(summaryBase, adaptive),
    recent,
    updatedAt: new Date().toISOString(),
  };
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
  return summarizePredictionSamples(samples, key);
}

async function fetchJson(url, timeoutMs = 10000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 Global Quant Watch",
        accept: "application/json,text/plain,*/*",
        ...extraHeaders,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      const safeText = text.slice(0, 180).replace(/[A-Za-z0-9_-]{16,}/g, "[redacted]");
      throw new Error(`HTTP ${response.status}: ${safeText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
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

async function throttleAlphaVantage() {
  const minGapMs = Number(process.env.ALPHAVANTAGE_MIN_GAP_MS || 1300);
  const waitMs = Math.max(0, alphaVantageNextRequestAt - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  alphaVantageNextRequestAt = Date.now() + minGapMs;
}

async function fetchText(url, timeoutMs = 10000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 Global Quant Watch",
        accept: "application/rss+xml,text/xml,text/plain,*/*",
        ...extraHeaders,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
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
    "^GSPC": { yahoo: "^GSPC", stooq: "^spx", stooqQuote: "^spx", twelve: "SPX", eodhd: "GSPC.INDX", label: "S&P 500" },
    "^IXIC": { yahoo: "^IXIC", stooq: "^ixic", stooqQuote: "^ndq", twelve: "IXIC", eodhd: "IXIC.INDX", label: "Nasdaq Composite" },
    "^DJI": { yahoo: "^DJI", stooq: "^dji", stooqQuote: "^dji", twelve: "DJI", eodhd: "DJI.INDX", label: "Dow Jones" },
    "^SPX": { yahoo: "^GSPC", stooq: "^spx", twelve: "SPX", eodhd: "GSPC.INDX", label: "S&P 500" },
    "^COMP": { yahoo: "^IXIC", stooq: "^ixic", stooqQuote: "^ndq", twelve: "IXIC", eodhd: "IXIC.INDX", label: "Nasdaq Composite" },
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
  const count = range === "1mo" ? 45 : range === "3mo" ? 90 : 260;
  return normalized.slice(-count);
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
  const count = range === "1mo" ? 45 : range === "3mo" ? 90 : 260;
  return rows.slice(-count);
}

function stockAnalysisHistoryRows(html, range = "9mo") {
  const text = String(html || "");
  const block = text.match(/data:\[(\{a:[\s\S]*?\})\],created_at/)?.[1] || "";
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
  const count = range === "1mo" ? 45 : range === "3mo" ? 90 : 260;
  return rows.slice(-count);
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
    asOf: quote?.asOf || new Date().toISOString(),
    date: String(quote?.date || quoteDateFromTimestamp(Date.parse(quote?.asOf || "") / 1000) || new Date().toISOString().slice(0, 10)).slice(0, 10),
    source: quote?.source || "quote",
    delayed: quote?.delayed !== false,
    note: quote?.note || null,
  };
}

function quoteToCandles(quote) {
  if (!quote || quote.unavailable) return [];
  const price = positiveMarketNumber(quote.price);
  if (!price) return [];
  const previous = positiveMarketNumber(quote.previousClose);
  const open = positiveMarketNumber(quote.open, previous || price);
  const high = Math.max(open, positiveMarketNumber(quote.high, price), price);
  const low = Math.min(open, positiveMarketNumber(quote.low, price), price);
  return sanitizeCandleRows([{
    date: String(quote.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
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
  return normalizeQuote({
    symbol: requestedYahooSymbol,
    price,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    open: lastIndex >= 0 ? quote.open?.[lastIndex] : null,
    high: lastIndex >= 0 ? quote.high?.[lastIndex] : null,
    low: lastIndex >= 0 ? quote.low?.[lastIndex] : null,
    volume: lastIndex >= 0 ? quote.volume?.[lastIndex] : null,
    currency: meta.currency,
    exchange: meta.exchangeName || meta.fullExchangeName,
    asOf: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    date: quoteDateFromTimestamp(timestamp),
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
  const quote = normalizeQuote({
    symbol: clean,
    price,
    previousClose,
    change,
    changePercent: data.priceChangePercent,
    volume: data.volume,
    currency: "AUD",
    exchange: "ASX",
    asOf: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    source: "asx-official-company-header",
    delayed: true,
    note: "ASX/Markit official company header quote.",
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

function addNewsMeta(items, source, channel, market, code) {
  return (items || []).map((item) => ({
    ...item,
    source,
    channel: item.channel || channel,
    impactScope: item.impactScope || channel,
    impactWeight: Number(channelWeight(item.channel || channel).toFixed(2)),
    market,
    relatedSymbol: code,
  }));
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

function factorSignal(factors = {}) {
  const safeFactors = factors || {};
  const rows = [
    safeFactors.announcements,
    safeFactors.shortInterest,
    safeFactors.macro,
    safeFactors.sector,
    safeFactors.flowOptions,
    safeFactors.marketRegime,
    safeFactors.relativeStrength,
    safeFactors.liquidity,
    safeFactors.calibration,
  ].filter(Boolean);
  const available = rows.filter((row) => row.available !== false);
  const score = available.reduce((sum, row) => sum + Number(row.score || 0), 0);
  return {
    score: Math.max(-25, Math.min(25, score)),
    checked: available.length,
    stance: score > 6 ? "supportive" : score < -6 ? "risk-off" : "mixed",
    notes: available.flatMap((row) => row.thesis || []).slice(0, 8),
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
    .replace(/Thank you for using Alpha Vantage![\s\S]*$/i, "Alpha Vantage rate/daily limit; fallback provider used.")
    .replace(/Edge:\s*Too Many Requests|HTTP 429[\s\S]*$/i, "Yahoo Finance rate limit; fallback provider used.")
    .replace(/HTTP 403[\s\S]*$/i, "Provider edge/permission block; fallback provider used.")
    .replace(/You may subscribe[\s\S]*$/i, "Provider plan/rate limit; fallback provider used.")
    .slice(0, 180));
}

async function fetchTwelveDataCandles(code, range, interval, market = "ASX") {
  if (!process.env.TWELVEDATA_API_KEY) throw new Error("TWELVEDATA_API_KEY is required");
  const key = safeMarket(market);
  const backoffKey = `twelvedata-${key.toLowerCase()}`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = new URL("https://api.twelvedata.com/time_series");
  endpoint.searchParams.set("symbol", cleanCode(code, key));
  const exchange = twelveExchangeForCode(code, key);
  if (exchange) endpoint.searchParams.set("exchange", exchange);
  endpoint.searchParams.set("interval", normalizeTwelveInterval(interval));
  endpoint.searchParams.set("outputsize", isIntradayInterval(interval) ? "390" : range === "1mo" ? "45" : "220");
  endpoint.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
  try {
    const payload = await fetchJson(endpoint);
    if (payload?.status === "error") throw new Error(payload.message || "Twelve Data error");
    return { candles: twelveDataRows(payload), source: `twelvedata-${key.toLowerCase()}` };
  } catch (error) {
    const message = String(error.message || error);
    if (/Pro|Venture|404|plan/i.test(message)) {
      backoffProvider(backoffKey, 6 * 60 * 60 * 1000, `Twelve Data ${key} skipped after plan/permission error; using another real source if available.`);
    }
    throw error;
  }
}

async function fetchTwelveDataIndexCandles(code, range, interval, market = "US") {
  if (!process.env.TWELVEDATA_API_KEY) throw new Error("TWELVEDATA_API_KEY is required");
  const key = safeMarket(market);
  const index = usIndexProviderSymbols(code);
  if (!index) throw new Error(`Unsupported ${key} cash index: ${code}`);
  const backoffKey = `twelvedata-${key.toLowerCase()}-index`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = new URL("https://api.twelvedata.com/time_series");
  endpoint.searchParams.set("symbol", index.twelve);
  endpoint.searchParams.set("exchange", key === "ASX" ? "ASX" : "INDEX");
  endpoint.searchParams.set("interval", normalizeTwelveInterval(interval));
  endpoint.searchParams.set("outputsize", range === "1mo" ? "45" : "260");
  endpoint.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
  try {
    const payload = await fetchJson(endpoint, 7000);
    if (payload?.status === "error") throw new Error(payload.message || "Twelve Data index error");
    const candles = twelveDataRows(payload);
    if (!candles.length) throw new Error(`Twelve Data returned no ${key} index candles.`);
    return { candles, source: `twelvedata-${key.toLowerCase()}-index-${index.twelve}`, unit: "points" };
  } catch (error) {
    const message = String(error.message || error);
    if (/Pro|Venture|404|plan|permission/i.test(message)) {
      backoffProvider(backoffKey, 6 * 60 * 60 * 1000, `Twelve Data ${key} index skipped after plan/permission error; using another real index source if available.`);
    }
    throw error;
  }
}

async function fetchEodhdCandles(code, range, interval, market = "ASX") {
  if (!process.env.EODHD_API_KEY) throw new Error("EODHD_API_KEY is required");
  const key = safeMarket(market);
  const backoffKey = `eodhd-${key.toLowerCase()}`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const ticker = eodhdTickerForCode(code, key);
  try {
    if (isIntradayInterval(interval)) {
      const endpoint = new URL(`https://eodhd.com/api/intraday/${ticker}`);
      endpoint.searchParams.set("interval", interval);
      endpoint.searchParams.set("fmt", "json");
      endpoint.searchParams.set("api_token", process.env.EODHD_API_KEY);
      const payload = await fetchJson(endpoint, 7000);
      return { candles: eodhdIntradayRows(payload), source: `eodhd-${key.toLowerCase()}-${interval}` };
    }
    const months = range === "1mo" ? 2 : 10;
    const from = new Date();
    from.setMonth(from.getMonth() - months);
    const endpoint = new URL(`https://eodhd.com/api/eod/${ticker}`);
    endpoint.searchParams.set("from", from.toISOString().slice(0, 10));
    endpoint.searchParams.set("period", interval === "1wk" ? "w" : "d");
    endpoint.searchParams.set("fmt", "json");
    endpoint.searchParams.set("api_token", process.env.EODHD_API_KEY);
    const payload = await fetchJson(endpoint);
    return { candles: eodhdRows(payload), source: `eodhd-${key.toLowerCase()}` };
  } catch (error) {
    const message = String(error.message || error);
    if (/402|daily API requests limit|exceeded/i.test(message)) {
      backoffProvider(backoffKey, 12 * 60 * 60 * 1000, `EODHD ${key} skipped after daily API limit; using another real source if available.`);
    }
    throw error;
  }
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
  if (!process.env.EODHD_API_KEY) throw new Error("EODHD_API_KEY is required");
  const key = safeMarket(market);
  const backoffKey = `eodhd-${key.toLowerCase()}-quote`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = new URL(`https://eodhd.com/api/real-time/${eodhdTickerForCode(code, key)}`);
  endpoint.searchParams.set("fmt", "json");
  endpoint.searchParams.set("api_token", process.env.EODHD_API_KEY);
  try {
    const payload = await fetchJson(endpoint, 4500);
    const timestamp = Number(payload.timestamp || payload.gmtoffset || 0);
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
      asOf: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
      date: Number.isFinite(timestamp) && timestamp > 0 ? quoteDateFromTimestamp(timestamp) : new Date().toISOString().slice(0, 10),
      source: `eodhd-${key.toLowerCase()}-quote`,
      delayed: false,
    }, key);
    if (!quote) throw new Error("EODHD quote had no usable price.");
    return quote;
  } catch (error) {
    const message = String(error.message || error);
    if (/402|daily API requests limit|exceeded/i.test(message)) {
      backoffProvider(backoffKey, 12 * 60 * 60 * 1000, `EODHD ${key} quote skipped after daily API limit; using another real quote source if available.`);
    }
    throw error;
  }
}

async function fetchTwelveDataQuote(code, market = "ASX") {
  if (!process.env.TWELVEDATA_API_KEY) throw new Error("TWELVEDATA_API_KEY is required");
  const key = safeMarket(market);
  const backoffKey = `twelvedata-${key.toLowerCase()}-quote`;
  const backoff = providerBackoffReason(backoffKey);
  if (backoff) throw new Error(backoff);
  const endpoint = new URL("https://api.twelvedata.com/quote");
  endpoint.searchParams.set("symbol", cleanCode(code, key));
  const exchange = twelveExchangeForCode(code, key);
  if (exchange) endpoint.searchParams.set("exchange", exchange);
  endpoint.searchParams.set("apikey", process.env.TWELVEDATA_API_KEY);
  try {
    const payload = await fetchJson(endpoint, 4500);
    if (payload?.status === "error") throw new Error(payload.message || "Twelve Data quote error");
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
      asOf: payload.datetime || new Date().toISOString(),
      date: String(payload.datetime || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
      source: `twelvedata-${key.toLowerCase()}-quote`,
      delayed: false,
    }, key);
    if (!quote) throw new Error("Twelve Data quote had no usable price.");
    return quote;
  } catch (error) {
    const message = String(error.message || error);
    if (/Pro|Venture|404|plan/i.test(message)) {
      backoffProvider(backoffKey, 6 * 60 * 60 * 1000, `Twelve Data ${key} quote skipped after plan/permission error; using another real quote source if available.`);
    }
    throw error;
  }
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
  from.setMonth(from.getMonth() - (range === "1mo" ? 3 : range === "3mo" ? 6 : 16));
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
  from.setMonth(from.getMonth() - (range === "1mo" ? 3 : range === "3mo" ? 6 : 16));
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
  if (/get your apikey|captcha/i.test(csv)) {
    backoffProvider(backoffKey, 6 * 60 * 60 * 1000, `Stooq ${key} index skipped because CSV download now requires captcha/API key.`);
    throw new Error("Stooq index CSV download requires captcha/API key.");
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
  const count = range === "1mo" ? 45 : range === "3mo" ? 90 : 260;
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
  endpoint.searchParams.set("lmt", range === "1mo" ? "45" : range === "3mo" ? "90" : isIntradayInterval(interval) ? "640" : "260");
  const payload = await fetchJson(endpoint, 6500);
  return { candles: eastmoneyKlinesToRows(payload), source: `eastmoney-cn-${interval}` };
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
      ["stooq-us-quote", () => fetchStooqQuote(code, key)],
      ["yahoo-us-quote", () => fetchYahooQuote(code, key)],
      ["eodhd-us-quote", () => fetchEodhdQuote(code, key)],
      ["twelvedata-us-quote", () => fetchTwelveDataQuote(code, key)],
    ],
    CN: [
      ["yahoo-cn-quote", () => fetchYahooQuote(code, key)],
      ["twelvedata-cn-quote", () => fetchTwelveDataQuote(code, key)],
    ],
  }[key] || [];
}

async function fetchRealtimeQuote(symbol, market = "ASX", latestClose = null) {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  assertValidMarketCode(code, key);
  const cacheKey = `${key}:${code}`;
  const cached = quoteResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.time < Number(process.env.QUOTE_CACHE_TTL_MS || 30000)) return cached.value;
  const errors = [];
  for (const [source, task] of quoteCandidates(key, code)) {
    const skipError = providerSkipError(source);
    if (skipError) {
      errors.push(skipError);
      continue;
    }
    try {
      const quote = normalizeQuote(await task(), key, latestClose);
      if (quote) {
        quoteResponseCache.set(cacheKey, { time: Date.now(), value: quote });
        if (quoteResponseCache.size > 160) quoteResponseCache.delete(quoteResponseCache.keys().next().value);
        return quote;
      }
      errors.push(`${source}: no usable quote`);
    } catch (error) {
      errors.push(`${source}: ${error.message || error}`);
    }
  }
  return {
    unavailable: true,
    source: "quote-unavailable",
    warning: compactProviderErrors(errors).join(" | "),
  };
}

function mergeQuoteIntoCandles(candles = [], quote = null) {
  const rows = sanitizeCandleRows(candles);
  if (!quote || quote.unavailable || !positiveMarketNumber(quote.price) || !quote.date) return rows;
  const price = positiveMarketNumber(quote.price);
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

function providerCandidates(market, code, range, interval) {
  const key = safeMarket(market);
  if (key === "ASX" && /^\^/.test(cleanCode(code, key))) {
    return [
      ["twelvedata-asx-index", () => fetchTwelveDataIndexCandles(code, range, interval, key)],
      ["eodhd-asx-index", () => fetchEodhdCandles(code, range, interval, key)],
      ["stooq-asx-index", () => fetchStooqIndexCandles(code, range, interval, key)],
      ["yahoo-asx-index", () => fetchYahooMarketCandles(code, range, interval, key)],
    ];
  }
  if (key === "US" && /^\^/.test(cleanCode(code, key))) {
    return [
      ["nasdaq-us-index", () => fetchNasdaqUsIndexCandles(code, range, interval)],
      ["twelvedata-us-index", () => fetchTwelveDataIndexCandles(code, range, interval, key)],
      ["eodhd-us-index", () => fetchEodhdCandles(code, range, interval, key)],
      ["stooq-us-index", () => fetchStooqIndexCandles(code, range, interval, key)],
      ["yahoo-us-index", () => fetchYahooMarketCandles(code, range, interval, key)],
    ];
  }
  const cnFreeCandidates = [
    ["eastmoney-cn", () => fetchEastmoneyCnCandles(code, range, interval)],
    ["tencent-cn", () => fetchTencentCnCandles(code, range, interval)],
    ["yahoo-cn", () => fetchYahooMarketCandles(code, range, interval, key)],
  ];
  const cnAlphaCandidate = ["alphavantage-cn", () => fetchAlphaVantageCandles(code, range, interval, key)];
  const cnExtraKeyedCandidates = [
    ["alphavantage-cn", () => fetchAlphaVantageCandles(code, range, interval, key)],
    ["eodhd-cn", () => fetchEodhdCandles(code, range, interval, key)],
    ["twelvedata-cn", () => fetchTwelveDataCandles(code, range, interval, key)],
  ];
  const cnCandidates = /^(SH|SZ)\d{6}$/.test(cleanCode(code, key))
    ? cnFreeCandidates
    : [
      ...cnFreeCandidates,
      ...(cnKeyedFallbacksEnabled() ? [cnAlphaCandidate] : []),
      ...(cnExtraKeyedFallbacksEnabled() ? cnExtraKeyedCandidates.slice(1) : []),
    ];
  const candidates = {
    ASX: [
      ["stockanalysis-asx", () => fetchStockAnalysisAsxCandles(code, range, interval)],
      ["yahoo-asx", () => fetchYahooMarketCandles(code, range, interval, key)],
      ["eodhd-asx", () => fetchEodhdCandles(code, range, interval, key)],
      ["twelvedata-asx", () => fetchTwelveDataCandles(code, range, interval, key)],
    ],
    US: [
      ["nasdaq-us", () => fetchNasdaqUsCandles(code, range, interval)],
      ["yahoo-us", () => fetchYahooMarketCandles(code, range, interval, key)],
      ["eodhd-us", () => fetchEodhdCandles(code, range, interval, key)],
      ["twelvedata-us", () => fetchTwelveDataCandles(code, range, interval, key)],
      ["stooq-us", () => fetchStooqUsCandles(code, range, interval)],
      ["alphavantage-us", () => fetchAlphaVantageCandles(code, range, interval, key)],
    ],
    CN: cnCandidates,
  }[key];
  return candidates;
}

function candleLimitForRange(range = "9mo") {
  if (range === "5d") return 8;
  if (range === "1mo") return 45;
  if (range === "3mo") return 90;
  return 260;
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
    for (const [source, task] of candidates) {
      const skipError = providerSkipError(source);
      if (skipError) {
        errors.push(skipError);
        continue;
      }
      try {
        const value = await task();
        if (value.candles?.length) successful.push(value);
        else errors.push(`${source}: no candles returned`);
      } catch (error) {
        errors.push(`${source}: ${error.message || error}`);
      }
      if (successful.length >= 2) break;
      if (key === "CN" && successful.length >= 1) break;
      if (key === "US" && process.env.US_REQUIRE_DUAL_SOURCE !== "true" && successful.length >= 1) break;
    }
    if (successful.length === 0) {
      throw new Error(`Market provider failure. ${errors.join(" | ")}`);
    }
    if (successful.length === 1) {
      const source = successful[0];
      if (!source.candles.length) throw new Error(`No real candles returned from ${source.source}. ${errors.join(" | ")}`);
      return remember({
        ...source,
        source: `${source.source}-single-source`,
        validation: singleSourceValidation(source, errors),
        warning: compactProviderErrors(errors).length
          ? `Dual-source cross-check degraded to single real source. ${compactProviderErrors(errors).join(" | ")}`
          : "Dual-source cross-check degraded to single real source.",
      });
    }
    const [primary, secondary] = successful;
    const validation = compareMarketSources(primary, secondary);
    if (!validation.ok && process.env.MARKET_ALLOW_CONFLICT !== "true") {
      throw new Error(`${validation.message} Price diff: ${validation.priceDiffPct?.toFixed(2)}%. EODHD ${validation.primary?.date} ${validation.primary?.close}; Twelve Data ${validation.secondary?.date} ${validation.secondary?.close}.`);
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

  if (provider === "yahoo") {
    return remember(await fetchYahooMarketCandles(code, range, interval, key));
  }

  if (provider === "tencent" || provider === "tencent-finance") {
    if (key !== "CN") throw new Error("Tencent Finance is only configured for China A-shares.");
    return remember(await fetchTencentCnCandles(code, range, interval));
  }

  throw new Error("No real market provider configured. Set MARKET_PROVIDER or US_MARKET_PROVIDER/CN_MARKET_PROVIDER to dual, twelvedata, eodhd, alphavantage, yahoo, or tencent with the required API access.");
}

async function fetchNewsItems(symbol, market = "ASX", scope = "all") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const safeScope = ["macro", "stock", "all"].includes(String(scope || "").toLowerCase()) ? String(scope || "").toLowerCase() : "all";
  const cacheKey = `${key}:${safeScope}:${safeScope === "macro" ? "MARKET" : code}`;
  const cached = newsResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.time < Number(process.env.NEWS_CACHE_TTL_MS || 10 * 60 * 1000)) return cached.value;
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

  const sourceResults = await Promise.allSettled([
    fetchStockAnalysisAsxNews(),
    fetchEastmoney(),
    fetchSec(),
    fetchNewsApi(),
    fetchNewsData(),
    fetchTheNewsApi(),
    fetchTianApi(),
    fetchGoogleRss(),
    fetchGdelt(),
  ]);
  const news = dedupeNews(sourceResults.flatMap((result) => result.status === "fulfilled" ? result.value.news : []));
  const value = {
    source: news.length ? "multi-news" : "multi-news-empty",
    providers: sourceResults.map((result) => result.status === "fulfilled" ? result.value.source : "provider-error"),
    news,
    signal: newsSignal(news, code, key),
    scope: safeScope,
  };
  newsResponseCache.set(cacheKey, { time: Date.now(), value });
  if (newsResponseCache.size > 100) newsResponseCache.delete(newsResponseCache.keys().next().value);
  return value;
}

async function fetchFundamentals(symbol, market = "ASX") {
  const key = safeMarket(market);
  if (key === "CN") {
    try {
      return await fetchTencentCnFundamentals(symbol);
    } catch (error) {
      if (!process.env.EODHD_API_KEY) return { source: "tencent-cn-fundamentals-unavailable", fundamentals: null, warning: error.message };
    }
  }
  if (key === "US" && !process.env.EODHD_API_KEY) {
    try {
      return await fetchSecUsFundamentals(symbol);
    } catch (error) {
      return { source: "sec-edgar-fundamentals-unavailable", fundamentals: null, warning: error.message };
    }
  }
  if (!process.env.EODHD_API_KEY) return { source: "none", fundamentals: null };
  try {
    const code = cleanCode(symbol, key);
    const endpoint = new URL(`https://eodhd.com/api/fundamentals/${eodhdTickerForCode(code, key)}`);
    endpoint.searchParams.set("api_token", process.env.EODHD_API_KEY);
    endpoint.searchParams.set("fmt", "json");
    const payload = await fetchJson(endpoint, 6000);
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
    return {
      available: items.length > 0,
      source,
      score: Math.max(-12, Math.min(12, signal.score)),
      thesis: items.length ? [`Macro feed checked ${items.length} items; stance ${signal.stance}.`] : ["Macro feed returned no items."],
      items,
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
  const entry = Number(rows[index]?.close || 0);
  const endIndex = Math.min(rows.length - 1, index + Math.max(1, Number(horizon || 15)));
  if (!entry || index >= endIndex) return { targetWins: false, stopWins: false, forwardReturn: 0, maxUpside: 0, maxDrawdown: 0 };
  const target = Math.max(0.5, Number(targetUpside || 5));
  const stop = Math.max(0.8, Math.abs(Number(stopLoss || 4)));
  let maxHigh = entry;
  let minLow = entry;
  let firstEvent = null;
  for (let offset = index + 1; offset <= endIndex; offset += 1) {
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

async function fetchFactorLayer(symbol, strategy = {}, market = "ASX") {
  const key = safeMarket(market);
  const code = cleanCode(symbol, key);
  const cacheKey = `${key}:${code}:${strategy.horizonDays || 15}:${strategy.targetUpside || 5}`;
  const cached = factorResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.time < Number(process.env.FACTOR_CACHE_TTL_MS || 10 * 60 * 1000)) return cached.value;
  const marketData = await fetchMarketCandles(symbol, "9mo", "1d", key);
  const candles = marketData.candles || [];
  const results = await Promise.allSettled([
    fetchAsxAnnouncementsFactor(symbol, key),
    fetchShortInterestFactor(symbol, key, candles),
    fetchMacroFactor(symbol, key),
    fetchSectorFactor(symbol, key),
    fetchRelativeStrengthFactor(symbol, candles, key),
    fetchFlowOptionsFactor(symbol, key, candles),
  ]);
  const get = (index, fallback) => results[index].status === "fulfilled" ? results[index].value : fallback(results[index].reason);
  const factors = {
    announcements: get(0, (error) => ({ available: false, source: "asx-announcements-unavailable", score: 0, thesis: [`ASX announcement factor unavailable: ${error.message || error}`] })),
    shortInterest: get(1, (error) => ({ available: false, source: "asic-short-unavailable", score: 0, thesis: [`ASIC short-interest factor unavailable: ${error.message || error}`] })),
    macro: get(2, (error) => ({ available: false, source: "macro-unavailable", score: 0, thesis: [`Macro factor unavailable: ${error.message || error}`] })),
    sector: get(3, (error) => ({ available: false, source: "sector-unavailable", score: 0, thesis: [`Sector factor unavailable: ${error.message || error}`] })),
    relativeStrength: get(4, (error) => ({ available: false, source: "relative-strength-unavailable", score: 0, thesis: [`Relative strength factor unavailable: ${error.message || error}`] })),
    flowOptions: get(5, (error) => ({ available: false, source: "flow-options-unavailable", score: 0, thesis: [`Flow/options factor unavailable: ${error.message || error}`] })),
    marketRegime: marketRegimeFactor(candles),
    liquidity: liquidityFactor(candles),
    calibration: calibrationFactor(candles, Number(strategy.horizonDays || 15), Number(strategy.targetUpside || 5), Number(strategy.stopLoss || 4)),
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
  const macroChecked = Number(macroSignal?.checkedItems || 0);
  const socialChecked = Number(socialSignal?.checkedItems || 0);
  const factorChecked = Number(factor?.checked || 0);
  const analogReliable = analogCount >= 5;
  const modelReliable = modelSampleCount >= 60;
  const samplePower = Math.max(
    analogReliable ? Math.min(0.45, analogCount / 18) : 0,
    modelReliable ? Math.min(0.85, modelSampleCount / 260) : 0,
  );
  const reliabilityInputs = [
    analogReliable ? { value: analogDirectionHitRate, weight: Math.min(0.45, analogCount / 18) } : null,
    modelReliable ? { value: modelDirectionalAccuracy || modelTargetHitAccuracy, weight: Math.min(0.85, modelSampleCount / 260) } : null,
  ].filter(Boolean);
  const strategyInputs = [
    analogReliable ? { value: analogStrategyHitProbability, weight: Math.min(0.45, analogCount / 18) } : null,
    modelReliable ? { value: modelTargetHitAccuracy, weight: Math.min(0.85, modelSampleCount / 260) } : null,
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
    (analogReliable && analogStrategyHitProbability >= 52 && analogRiskAdjustedReturn > 0 && analogStopRate <= 42)
    || (modelReliable && modelTargetHitAccuracy >= 56 && modelPredictedReturn > targetUpside * 0.2)
    || (analogReliable && analogMaxUpsideHitRate >= 56 && analogMaxUpside >= targetUpside * 0.45 && analogStopRate <= 45)
    || (modelReliable && modelMaxUpsideHitAccuracy >= 58 && modelPredictedMaxUpside >= targetUpside * 0.5)
  );
  const historyWarnsUpside = (
    (analogReliable && (analogStrategyHitProbability < 38 || analogRiskAdjustedReturn < -0.45 || analogStopRate >= 48))
    || (modelReliable && modelTargetHitAccuracy < 52 && modelPredictedReturn < targetUpside * 0.2)
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
  const performanceWeightAdjusted = applyPerformanceAndRegimeWeights(models, calibrationSummary, marketProfile);
  const agreementWeighting = rebalanceModelAgreementWeights(models);
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
    availableModelCount,
    upsideAgreement: Number((upsideAgreement * 100).toFixed(0)),
    consensusAgreement: Number((consensusAgreement * 100).toFixed(0)),
    direction: upsideWeight >= downsideWeight ? "upside" : "downside",
    targetFit: Number(targetFit.toFixed(2)),
    disagreementPenalty: Number(disagreementPenalty.toFixed(2)),
    evidenceBonus: Number(evidenceBonus.toFixed(2)),
    agreementWeighting,
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
    },
    models,
  };
}

function conservativeForecastCalibration({ ensemble, score, projectedUpsideRaw, targetUpside, targetConfidence, marketValidation, calibration, strategyCalibration, market }) {
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
  const rawStrategyHitProbability = Number(historyGate.strategyHitProbability || 0);
  const strategyHitProbability = strategyCalibration?.sampleCount >= 5
    ? Number(strategyCalibration.probability || rawStrategyHitProbability)
    : rawStrategyHitProbability;
  const historyOkForBuy = historySamplePower >= 0.25
    && strategyHitProbability >= strategyProbabilityTarget
    && historyReliability >= 52
    && !historyGate.blocksUpside;

  let shrink = 0.68;
  if (consensus >= 82 && upsideAgreement >= 70) shrink += 0.14;
  else if (consensus >= 72 && upsideAgreement >= 62) shrink += 0.07;
  else if (consensus < 64) shrink -= 0.18;
  if (availableModelCount >= 5) shrink += 0.07;
  else if (availableModelCount < 4) shrink -= 0.12;
  if (evidenceBonus >= 3) shrink += 0.05;
  if (disagreement > 5) shrink -= Math.min(0.18, (disagreement - 5) * 0.035);
  if (marketValidation?.degraded) shrink -= 0.1;
  if (marketRegime.upsideShrink && Number(projectedUpsideRaw || 0) > 0) shrink *= Number(marketRegime.upsideShrink || 1);
  if (calibration?.sampleCount >= 5 && Number(calibration.confidence || 0) < Number(score || 0)) shrink -= 0.05;
  if (Number(projectedUpsideRaw || 0) > 0 && historySamplePower >= 0.25) {
    if (historyOkForBuy) shrink += 0.05;
    else shrink -= stricterMarket ? 0.24 : 0.18;
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
  if (Number(projectedUpsideRaw || 0) > 0 && historySamplePower < 0.25) {
    reasons.push("样本外策略达标验证不足");
  } else if (Number(projectedUpsideRaw || 0) > 0 && !historyOkForBuy) {
    if (historyReliability > 0 && historyReliability < 45) confidenceCap = Math.min(confidenceCap, 58);
    reasons.push(`策略达标概率不足 ${strategyHitProbability ? `${strategyHitProbability.toFixed(0)}%` : "样本不足"} / 目标 ${strategyProbabilityTarget.toFixed(0)}%`);
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
    && historyOkForBuy;

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
    historyGate: {
      ...historyGate,
      okForBuy: historyOkForBuy,
      strategyHitProbability: Number(strategyHitProbability.toFixed(1)),
      rawStrategyHitProbability: Number(rawStrategyHitProbability.toFixed(1)),
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
  const factor = factorSignal(factors);
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
    market,
  });
  const calibratedScore = conservative.confidence;
  const projectedUpside = conservative.projectedUpside;
  const directional = directionalConfidenceMetrics(ensemble, calibratedScore, projectedUpside);
  const magnitude = projectedMoveConfidenceMetrics({ projectedUpside, ensemble, analog, confidence: calibratedScore, strategy, conservative });
  const maxUpside = projectedMaxUpsideConfidenceMetrics({ projectedFinalReturn: projectedUpside, ensemble, analog, confidence: calibratedScore, strategy, conservative });
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
    strategyConfidence: Number(conservative.strategyHitProbability || 0),
    strategyHitProbability: Number(conservative.strategyHitProbability || 0),
    upsideConfidence: directional.upsideConfidence,
    downsideConfidence: directional.downsideConfidence,
    direction: directional.direction,
    directionAgreement: directional.directionAgreement,
    rawConfidence: score,
    calibration,
    strategyCalibration,
    ensemble: {
      ...ensemble,
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
      magnitudeHitProbability: magnitude.probability,
      magnitudeBasis: magnitude.basis,
      projectedMaxUpside: maxUpside.projectedMaxUpside,
      maxUpsideHitProbability: maxUpside.probability,
      maxUpsideBasis: maxUpside.basis,
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
    },
    projectedUpside,
    horizonDays: Number(strategy?.horizonDays || 15),
    thesis: [
      technicals.macdHistogram > 0 ? "MACD histogram is positive." : "MACD histogram is not yet confirming upside.",
      technicals.volumeRatio >= 1.2 ? "Volume is above recent average." : "Volume is not meaningfully above average.",
      technicals.rsi >= 45 && technicals.rsi <= 68 ? "RSI is in a constructive range." : "RSI suggests either weak momentum or crowding.",
      `Multi-model ensemble: ${ensemble.direction} consensus ${ensemble.consensusAgreement}%, upside agreement ${ensemble.upsideAgreement}%, raw target confidence ${ensemble.confidence}%.`,
      `Model cross-check: evidence bonus ${finiteNumber(ensemble.evidenceBonus, 0).toFixed(1)}%, disagreement penalty ${finiteNumber(ensemble.disagreementPenalty, 0).toFixed(1)}%.`,
      adaptive.reasons.length ? `Adaptive learning: ${adaptive.reasons.join("；")}。旧预测会保留到周期结束并持续校准短/中/长期参数。` : "Adaptive learning: no material penalty from prior forecast outcomes yet.",
      `Conservative calibration: projected upside shrink ${conservative.shrink}x, confidence cap ${conservative.confidenceCap}%, ${conservative.buyEligible ? "high-conviction gate passed" : `high-conviction gate blocked (${conservative.reasons.join("、") || "证据仍不足"})`}.`,
      `Final-return label: expected ${projectedUpside >= 0 ? "+" : ""}${projectedUpside.toFixed(2)}% by day ${Number(strategy?.horizonDays || 15)}, final-return hit probability ${magnitude.probability.toFixed(0)}% (${magnitude.basis}).`,
      `Max-upside label: expected intraperiod high touch ${maxUpside.projectedMaxUpside.toFixed(2)}%, touch probability ${maxUpside.probability.toFixed(0)}% (${maxUpside.basis}, analog ${maxUpside.analogHitRate == null ? "n/a" : `${maxUpside.analogHitRate.toFixed(0)}%`}, model ${maxUpside.modelProbability == null ? "n/a" : `${maxUpside.modelProbability.toFixed(0)}%`}).`,
      `Strategy target label: target-before-stop probability ${Number(conservative.strategyHitProbability || 0).toFixed(0)}% / required ${Number(conservative.strategyProbabilityTarget || 0).toFixed(0)}%; ${strategyCalibration?.sampleCount >= 5 ? strategyCalibration.message : "strategy probability calibration is still collecting resolved samples"}.`,
      `Market regime model: ${ensemble.marketRegime?.regime || "range"} / ${ensemble.marketRegime?.riskLevel || "neutral"}, threshold bonus ${Number(ensemble.marketRegime?.buyThresholdBonus || 0).toFixed(0)}%, upside shrink ${Math.round(Number(ensemble.marketRegime?.upsideShrink || 1) * 100)}%.`,
      positiveAgreement ? "Most available models agree on upside direction." : negativeAgreement ? "Most available models agree on downside risk." : "Forecast engines are mixed; confidence is constrained.",
      analog?.count ? `Historical analogs: ${analog.count} similar windows, average ${Number(analog.averageForwardReturn || 0).toFixed(2)}% over the strategy horizon, win rate ${Number(analog.winRate || 0).toFixed(0)}%.` : "Not enough historical analog windows were available.",
      ensemble.historyGate?.samplePower >= 0.25
        ? `Reliability split: directional reliability ${Number(ensemble.historyGate.reliability || 0).toFixed(0)}%, strategy-hit probability ${Number(ensemble.historyGate.strategyHitProbability || 0).toFixed(0)}%, analog target-hit ${Number(ensemble.historyGate.analogTargetHitRate || 0).toFixed(0)}%, analog max-upside hit ${Number(ensemble.historyGate.analogMaxUpsideHitRate || 0).toFixed(0)}%, self-supervised max-upside hit ${Number(ensemble.historyGate.modelMaxUpsideHitAccuracy || 0).toFixed(0)}%; ${ensemble.historyGate.supportsUpside ? "supports upside" : ensemble.historyGate.blocksUpside ? "blocks upside" : "neutral"}.`
        : "Strategy hit validation: not enough out-of-sample history to lift confidence.",
      fundamentals ? `Fundamentals checked: PE ${fundamentals.peRatio || "n/a"}, dividend yield ${fundamentals.dividendYield || "n/a"}, beta ${fundamentals.beta || "n/a"}.` : "Fundamental data was not available from the configured provider.",
      news.length ? `Macro/industry/news signal: ${macroSignal.stance}, score ${macroSignal.score}, checked ${macroSignal.checkedItems} multi-source items across direct, peer, upstream, sector, macro, and global channels.` : "No fresh macro or company news was available from the configured provider.",
      ...(macroSignal.influences || []).slice(0, 3).map((item) => `News impact ${item.channel || "mixed"} (${item.source || "source"}, weight ${item.weight}): ${item.title}`),
      xPosts.length ? `X signal: ${socialSignal.stance}, checked ${xPosts.length} posts across leaders, macro, and sector queries.` : "X recent search is not configured or returned no posts.",
      youtubeItems.length ? `YouTube signal checked ${youtubeItems.length} trending/search videos.` : "YouTube Data API is not configured or returned no videos.",
      factor.checked ? `Factor layer: ${factor.stance}, score ${factor.score}, checked ${factor.checked} live factor groups.` : "Factor layer did not have enough available inputs.",
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
      signal: factorSignal(input.factors),
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
    } : null,
    news: compactSignalItems(input.news || [], 6),
    x: compactSignalItems(input.xPosts || [], 4),
    youtube: compactSignalItems(input.youtubeItems || [], 4),
  };
}

async function callOpenAiJson(input, timeoutMs) {
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
    if (!text) throw new Error("OpenAI returned empty output");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function localAnalysisEnvelope(input, source = "local-rules") {
  return {
    symbol: input.symbol,
    analysis: strategyDecision(localAnalysis(input), input),
    source,
  };
}

function blendAiWithBaseline(row, baseline) {
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
  const aiOverlay = Number.isFinite(aiConfidence) || Number.isFinite(aiUpside)
    ? {
      name: "OpenAI文本复核",
      confidence: Math.round(Number.isFinite(aiConfidence) ? aiConfidence : confidence),
      projectedUpside: Number((Number.isFinite(aiUpside) ? aiUpside : projectedUpside).toFixed(2)),
      weight: 0,
      normalizedWeight: 0,
      available: true,
      reason: "AI synthesis of compact news/factor/technical context; blended after local ensemble.",
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
    strategyConfidence: baseline.strategyConfidence ?? baseline.strategyHitProbability ?? 0,
    strategyHitProbability: baseline.strategyHitProbability ?? baseline.strategyConfidence ?? 0,
    projectedUpside,
    horizonDays: row.horizonDays ?? baseline.horizonDays,
    ensemble,
    qualityGate,
    calibration: baseline.calibration,
    strategyCalibration: baseline.strategyCalibration,
    thesis,
    risks: asList(row.risks, 4).length ? asList(row.risks, 4) : baseline.risks?.slice(0, 5) || [],
  };
}

async function openAiAnalysis(input) {
  const baseline = localAnalysisEnvelope(input).analysis;
  if (!process.env.OPENAI_API_KEY || process.env.ENABLE_OPENAI_ANALYSIS !== "true") {
    return { analysis: baseline, source: "local-rules" };
  }
  try {
    const parsed = await callOpenAiJson([
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
    return { analysis: strategyDecision(blendAiWithBaseline(parsed, baseline), input), source: "openai-ensemble" };
  } catch (error) {
    const fallback = localAnalysis(input);
    fallback.risks = [`OpenAI analysis unavailable; local strategy engine used. ${error.message}`, ...(fallback.risks || [])];
    return { analysis: strategyDecision(fallback, input), source: "local-rules-openai-fallback" };
  }
}

async function openAiBatchAnalysis(items) {
  const inputs = Array.isArray(items) ? items.filter(Boolean).slice(0, 40) : [];
  const localResults = inputs.map((input) => localAnalysisEnvelope(input));
  if (!inputs.length) return { results: [], source: "empty" };
  if (!process.env.OPENAI_API_KEY || process.env.ENABLE_OPENAI_ANALYSIS !== "true") {
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
    const parsed = await callOpenAiJson([
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
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    const batchMarket = safeMarket(inputs[0]?.market || "ASX");
    const bySymbol = new Map(rows.map((row) => [cleanCode(row.symbol, batchMarket), row]));
    const results = [...localResults];
    reviewRows.forEach(({ input, local, index }, reviewIndex) => {
      const row = bySymbol.get(cleanCode(input.symbol, input.market || batchMarket)) || rows[reviewIndex];
      if (!row) return;
      const baseline = local.analysis;
      const aiEstimate = blendAiWithBaseline({ ...row, symbol: input.symbol }, baseline);
      if (!aiEstimate.thesis.length) aiEstimate.thesis = baseline.thesis?.slice(0, 5) || [];
      if (!aiEstimate.risks.length) aiEstimate.risks = baseline.risks?.slice(0, 5) || [];
      results[index] = {
        symbol: input.symbol,
        analysis: strategyDecision(aiEstimate, input),
        source: "openai-batch-ensemble",
      };
    });
    return { results, source: `openai-batch-top-${reviewRows.length}` };
  } catch (error) {
    const results = inputs.map((input) => {
      const fallback = localAnalysis(input);
      fallback.risks = [`OpenAI batch analysis unavailable; local strategy engine used. ${error.message}`, ...(fallback.risks || [])];
      return {
        symbol: input.symbol,
        analysis: strategyDecision(fallback, input),
        source: "local-rules-openai-fallback",
      };
    });
    return { results, source: "local-rules-openai-fallback" };
  }
}

function localBatchAnalysis(items) {
  const inputs = Array.isArray(items) ? items.filter(Boolean).slice(0, 40) : [];
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
  if (!process.env.OPENAI_API_KEY) {
    return { source: "local-rules-chat", message: localMessage, suggestions: ["补充交易周期和止损线", "刷新当前市场新闻和行情", "查看预测准确率中的错误行为模式"] };
  }
  try {
    const parsed = await callOpenAiJson([
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
      source: "openai-chat",
      message: String(parsed.message || localMessage).slice(0, 4000),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 6).map((item) => String(item).slice(0, 180)) : [],
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
  const parsed = await callOpenAiJson([
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
    holdings: (Array.isArray(parsed.holdings) ? parsed.holdings : []).map((item) => ({
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
  if (url.pathname === "/api/health") {
    const sampleCode = { ASX: "BHP", US: "AAPL", CN: "600519" };
    const markets = Object.keys(MARKET_CONFIG).reduce((acc, market) => {
      acc[market] = {
        provider: providerForMarket(market),
        candidates: providerCandidates(market, sampleCode[market], "1mo", "1d").map(([source]) => source),
      };
      return acc;
    }, {});
    sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      startedAt: SERVER_STARTED_AT,
      markets,
      cnKeyedFallbacksEnabled: cnKeyedFallbacksEnabled(),
      cnExtraKeyedFallbacksEnabled: cnExtraKeyedFallbacksEnabled(),
    });
    return;
  }

  if (url.pathname === "/api/accuracy") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      const samples = await readPredictionSamples(market);
      sendJson(res, 200, summarizePredictionSamples(samples, market));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");
      const summary = await updatePredictionSamples(market, Array.isArray(payload.samples) ? payload.samples : [], {
        activeSymbols: payload.activeSymbols,
        cancelSymbols: payload.cancelSymbols,
      });
      sendJson(res, 200, summary);
      return;
    }
    if (req.method === "DELETE") {
      const symbols = url.searchParams.get("symbols") || url.searchParams.get("symbol") || "";
      const summary = await updatePredictionSamples(market, [], { cancelSymbols: symbols.split(",") });
      sendJson(res, 200, summary);
      return;
    }
  }

  if (url.pathname === "/api/snapshot") {
    const market = marketFromUrl(url);
    if (req.method === "GET") {
      const snapshot = await readServerSnapshotForMarket(market);
      sendJson(res, snapshot ? 200 : 404, snapshot || { error: "No server snapshot saved yet." });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");
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

  if (url.pathname.startsWith("/api/market/")) {
    const market = marketFromUrl(url);
    const symbol = normalizeMarketSymbol(decodeURIComponent(url.pathname.split("/").pop()), market);
    const range = url.searchParams.get("range") || "6mo";
    const interval = url.searchParams.get("interval") || "1d";
    const cacheKey = `${market}:${symbol}:${range}:${interval}`;
    const cached = marketResponseCache.get(cacheKey);
    if (cached && Date.now() - cached.time < Number(process.env.MARKET_CACHE_TTL_MS || 60000)) {
      sendJson(res, 200, cached.value);
      return;
    }
    const isCashIndex = /^\^/.test(cleanCode(symbol, market));
    const indexQuotePromise = isCashIndex
      ? fetchRealtimeQuote(symbol, market).catch((error) => ({ unavailable: true, warning: error.message || String(error) }))
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
      realtimeQuote = marketData.quote && !marketData.quote.unavailable
        ? normalizeQuote(marketData.quote, market, latest?.close)
        : indexQuotePromise
          ? await indexQuotePromise
          : await fetchRealtimeQuote(symbol, market, latest?.close);
    } catch (error) {
      realtimeQuote = { unavailable: true, warning: error.message || String(error) };
    }
    const candles = mergeQuoteIntoCandles(marketData.candles, realtimeQuote);
    const quoteWarning = realtimeQuote?.unavailable && realtimeQuote.warning ? `Realtime quote unavailable. ${realtimeQuote.warning}` : "";
    const payload = {
      symbol,
      market,
      ...marketData,
      candles,
      quote: realtimeQuote?.unavailable ? null : realtimeQuote,
      quoteWarning,
      warning: [marketData.warning, quoteWarning].filter(Boolean).join(" | "),
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
    const news = await fetchNewsItems(symbol, market, scope);
    sendJson(res, 200, { symbol, market, ...news });
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
    };
    sendJson(res, 200, await fetchFactorLayer(symbol, strategy, market));
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
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}");
    sendJson(res, 200, await openAiAnalysis(input));
    return;
  }

  if (url.pathname === "/api/analyze-batch" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    sendJson(res, 200, payload.localOnly ? localBatchAnalysis(payload.items || []) : await openAiBatchAnalysis(payload.items || []));
    return;
  }

  if (url.pathname === "/api/assistant-chat" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    sendJson(res, 200, await assistantChat(payload));
    return;
  }

  if (url.pathname === "/api/portfolio-image" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}");
    sendJson(res, 200, await parsePortfolioImage(payload.image, payload.market));
    return;
  }

  sendJson(res, 404, { error: "Unknown API route." });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === "/app.js" && req.headers["sec-fetch-dest"] === "document") {
      res.writeHead(302, {
        location: "/",
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, safePath);
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    sendJson(res, 500, { error: error.message || "Server error." });
  }
});

server.listen(port, host, () => {
  console.log(`Global Quant Watch running at http://${host}:${port}`);
});
