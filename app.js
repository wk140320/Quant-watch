if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    value(index) {
      const length = this == null ? 0 : this.length >>> 0;
      let offset = Number(index) || 0;
      if (offset < 0) offset += length;
      return offset < 0 || offset >= length ? undefined : this[offset];
    },
    configurable: true,
    writable: true,
  });
}

if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, "flatMap", {
    value(callback, thisArg) {
      return Array.prototype.concat.apply([], this.map(callback, thisArg));
    },
    configurable: true,
    writable: true,
  });
}

if (!Object.fromEntries) {
  Object.fromEntries = function fromEntries(entries) {
    const result = {};
    Array.from(entries || []).forEach((entry) => {
      if (entry && entry.length >= 2) result[entry[0]] = entry[1];
    });
    return result;
  };
}

if (!Promise.allSettled) {
  Promise.allSettled = function allSettled(promises) {
    return Promise.all(Array.from(promises || []).map((promise) => (
      Promise.resolve(promise)
        .then((value) => ({ status: "fulfilled", value }))
        .catch((reason) => ({ status: "rejected", reason }))
    )));
  };
}

const safeStorage = {
  getItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      console.warn(`Unable to read safeStorage.${key}`, error);
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn(`Unable to write safeStorage.${key}`, error);
      return false;
    }
  },
  removeItem(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn(`Unable to remove safeStorage.${key}`, error);
      return false;
    }
  },
};

const BOOT_PENDING_KEY = "quantWatchBootPending";
let startupRecoveredFromPreviousCrash = false;
try {
  startupRecoveredFromPreviousCrash = safeStorage.getItem(BOOT_PENDING_KEY) === "true";
  safeStorage.setItem(BOOT_PENDING_KEY, "true");
} catch (error) {
  startupRecoveredFromPreviousCrash = false;
}
function hasStartupSafeQuery() {
  try {
    if (typeof URLSearchParams !== "undefined") return new URLSearchParams(location.search).has("safe");
  } catch (error) {
    console.warn("Unable to inspect startup query", error);
  }
  return /(?:\?|&)safe(?:=|&|$)/.test(location.search || "");
}

const STARTUP_STORAGE_CHAR_LIMIT = 240000;
const STARTUP_SAFE_MODE = startupRecoveredFromPreviousCrash || hasStartupSafeQuery();

function readJsonStorage(key, fallback, options = {}) {
  try {
    const raw = safeStorage.getItem(key);
    if (!raw) return fallback;
    const maxChars = Number(options.maxChars || STARTUP_STORAGE_CHAR_LIMIT);
    if (raw.length > maxChars) {
      console.warn(`Skipping oversized safeStorage.${key}`, { length: raw.length, maxChars });
      return fallback;
    }
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch (error) {
    console.warn(`Ignoring invalid safeStorage.${key}`, error);
    safeStorage.removeItem(key);
    return fallback;
  }
}

const MARKET_CONFIG = {
  ASX: {
    code: "ASX",
    label: "澳股",
    title: "澳股监控台",
    clockLabel: "悉尼时间",
    timezone: "Australia/Sydney",
    currency: "AUD",
    locale: "en-AU",
    defaultSymbols: ["BHP", "CBA", "WDS", "RIO"],
    symbolPlaceholder: "输入 ASX 代码，如 BHP, CBA, WDS",
    holdingPlaceholder: "BHP",
    samplePortfolio: "symbol,qty,avgPrice\nBHP,120,43.20\nCBA,20,118.50",
    indexes: [
      { symbol: "^AXJO", label: "S&P/ASX 200", note: "现金指数点位", unit: "points" },
      { symbol: "^AORD", label: "All Ordinaries", note: "现金指数点位", unit: "points" },
      { symbol: "^AXKO", label: "S&P/ASX 300", note: "现金指数点位", unit: "points" },
    ],
    open: 10 * 60,
    close: 16 * 60,
    refreshClose: 16 * 60 + 15,
  },
  US: {
    code: "US",
    label: "美股",
    title: "美股监控台",
    clockLabel: "纽约时间",
    timezone: "America/New_York",
    currency: "USD",
    locale: "en-US",
    defaultSymbols: ["AAPL", "NVDA", "MSFT", "TSLA"],
    symbolPlaceholder: "输入美股代码，如 AAPL, NVDA, MSFT",
    holdingPlaceholder: "NVDA",
    samplePortfolio: "symbol,qty,avgPrice\nAAPL,10,190.00\nNVDA,5,120.00",
    indexes: [
      { symbol: "^GSPC", label: "S&P 500", note: "现金指数点位", unit: "points" },
      { symbol: "^IXIC", label: "Nasdaq Composite", note: "现金指数点位", unit: "points" },
      { symbol: "^DJI", label: "Dow Jones", note: "现金指数点位", unit: "points" },
    ],
    open: 9 * 60 + 30,
    close: 16 * 60,
    refreshClose: 16 * 60 + 15,
  },
  CN: {
    code: "CN",
    label: "A股",
    title: "A股监控台",
    clockLabel: "北京时间",
    timezone: "Asia/Shanghai",
    currency: "CNY",
    locale: "zh-CN",
    defaultSymbols: ["600519", "300750", "000001", "601318"],
    symbolPlaceholder: "输入 A股代码，如 600519, 300750, 000001",
    holdingPlaceholder: "600519",
    samplePortfolio: "symbol,qty,avgPrice\n600519,10,1500.00\n300750,20,180.00",
    indexes: [
      { symbol: "SH000001", label: "上证指数", note: "官方指数" },
      { symbol: "SZ399001", label: "深证成指", note: "官方指数" },
      { symbol: "SZ399006", label: "创业板指", note: "官方指数" },
    ],
    open: 9 * 60 + 30,
    close: 15 * 60,
    refreshClose: 15 * 60 + 15,
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
  "PLS", "LYC", "SEK", "PME", "STW", "VAS", "IOZ", "TCL",
]);

const MARKET_UNIVERSES = {
  ASX: [
    "BHP", "CBA", "RIO", "CSL", "NAB", "WBC", "ANZ", "MQG", "WES", "WOW",
    "TLS", "FMG", "WDS", "GMG", "TCL", "QBE", "REA", "COH", "SHL", "CPU",
    "ORG", "APA", "SCG", "NST", "S32", "MIN", "PLS", "LYC", "COL", "PME",
    "ALL", "XRO", "JHX", "AMC", "CAR", "SOL", "IAG", "SUN", "SGP", "EDV",
    "TWE", "AGL", "DXS", "BSL", "QAN", "HVN", "JBH", "ALD", "VCX", "WHC",
    "STO", "RHC", "SEK", "DMP", "A2M", "IEL", "ALU", "MGR", "BXB", "NEM",
  ],
  US: [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "JPM",
    "BAC", "WFC", "GS", "XOM", "CVX", "COP", "LLY", "UNH", "V", "MA",
    "COST", "WMT", "NFLX", "CRM", "ORCL", "ADBE", "INTC", "QCOM", "KO", "PEP",
    "PLTR", "IBM", "GE", "CAT", "BA", "RTX", "NKE", "DIS", "MCD", "HD",
    "TMO", "ABBV", "MRK", "PFE", "NOW", "SHOP", "UBER", "PANW", "CRWD", "MU",
    "SMCI", "ARM", "TSM", "BABA", "SBUX", "LMT", "LIN", "ISRG", "BKNG", "TXN",
  ],
  CN: [
    "600519", "300750", "002594", "000858", "601318", "600036", "601398", "000001",
    "600900", "601899", "600276", "300760", "002475", "600030", "601012", "600309",
    "000333", "000651", "300059", "002415", "600887", "601888", "600089", "002230",
    "601888", "603259", "688981", "600031", "600050", "600406", "601668", "601857",
    "601988", "601288", "601985", "600028", "600048", "600919", "002352", "002415",
    "002714", "300124", "300274", "300308", "300347", "300498", "600438", "600660",
  ],
};

const MANUAL_WATCH_SOURCES = new Set(["manual", "holding", "csv", "text", "screenshot", "app-buy"]);
const AI_PICK_COUNT = 15;
const AI_PICK_UNIVERSE_LIMIT = 180;
const LEGACY_WRONG_MARKET_HOLDINGS = {
  US: new Set(["TCL"]),
};

function safeMarket(value) {
  return MARKET_CONFIG[value] ? value : "ASX";
}

function cleanSymbolText(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSymbolForMarket(symbol, market) {
  const key = safeMarket(market);
  const clean = cleanSymbolText(symbol);
  if (key === "CN") {
    const noSuffix = clean.replace(/\.(SS|SH|SHH|SZ|SHE|SHZ)$/, "");
    if (/^(SH000|SZ399)\d{3}$/.test(noSuffix)) return noSuffix;
    const noPrefix = noSuffix.replace(/^(SH|SZ)(?=\d{6}$)/, "");
    return /^\d{6}$/.test(noPrefix) ? noPrefix : "";
  }
  if (key === "US") {
    const value = clean.replace(/\s+/g, "");
    if (/\.A[UX]$/.test(value) || OBVIOUS_ASX_ONLY_SYMBOLS.has(value)) return "";
    if (/^\^[A-Z0-9.]{2,12}$/.test(value)) return value;
    return /^[A-Z][A-Z0-9.-]{0,9}$/.test(value) ? value : "";
  }
  const value = clean.replace(/\.A[UX]$/, "");
  if (/^\^[A-Z0-9.]{2,12}$/.test(value)) return value;
  if (OBVIOUS_US_SYMBOLS.has(value)) return "";
  return /^[A-Z0-9]{2,6}$/.test(value) ? value : "";
}

function symbolFromWatchEntry(entry) {
  if (entry && typeof entry === "object") return entry.symbol || entry.code || entry.ticker || "";
  return entry;
}

function sourceFromWatchEntry(entry, fallback = "saved") {
  if (entry && typeof entry === "object") return entry.source || fallback;
  return fallback;
}

function isManualWatchSource(source) {
  return String(source || "")
    .toLowerCase()
    .split("+")
    .some((part) => MANUAL_WATCH_SOURCES.has(part));
}

function marketUniverseSet(market) {
  return new Set((MARKET_UNIVERSES[safeMarket(market)] || []).map((item) => normalizeSymbolForMarket(item, market)).filter(Boolean));
}

function marketDefaultSet(market) {
  return new Set((MARKET_CONFIG[safeMarket(market)]?.defaultSymbols || []).map((item) => normalizeSymbolForMarket(item, market)).filter(Boolean));
}

function isMarketNativeAutoSymbol(symbol, market) {
  const key = safeMarket(market);
  const normalized = normalizeSymbolForMarket(symbol, key);
  if (!normalized) return false;
  if (normalized.startsWith("^") || /^(SH000|SZ399)\d{3}$/.test(normalized)) return true;
  if (key === "CN") return /^\d{6}$/.test(normalized);
  if (marketUniverseSet(key).has(normalized) || marketDefaultSet(key).has(normalized)) return true;
  if (key === "US") {
    const asxAuto = marketUniverseSet("ASX").has(normalized) || marketDefaultSet("ASX").has(normalized) || OBVIOUS_ASX_ONLY_SYMBOLS.has(normalized);
    return !asxAuto;
  }
  if (key === "ASX") {
    const usAuto = marketUniverseSet("US").has(normalized) || marketDefaultSet("US").has(normalized) || OBVIOUS_US_SYMBOLS.has(normalized);
    return !usAuto;
  }
  return true;
}

function allowWatchSymbolForMarket(symbol, market, source = "saved") {
  const key = safeMarket(market);
  const normalized = normalizeSymbolForMarket(symbol, key);
  if (!normalized) return "";
  if (isManualWatchSource(source)) return normalized;
  return isMarketNativeAutoSymbol(normalized, key) ? normalized : "";
}

function normalizeWatchlistItemsForMarket(symbols, market, origins = {}, fallbackSource = "saved") {
  const key = safeMarket(market);
  const originMap = origins?.[key] || {};
  const rows = Array.isArray(symbols) ? symbols : [];
  return [...new Set(rows.map((entry) => {
    const raw = symbolFromWatchEntry(entry);
    const normalized = normalizeSymbolForMarket(raw, key);
    const source = sourceFromWatchEntry(entry, originMap[normalized] || fallbackSource);
    return allowWatchSymbolForMarket(normalized || raw, key, source);
  }).filter(Boolean))];
}

function initialWatchlistForMarket(market) {
  const key = safeMarket(market);
  const saved = readJsonStorage("watchlistsByMarket", {});
  const origins = readJsonStorage("watchlistOriginsByMarket", {});
  const legacy = readJsonStorage("watchlist", null);
  const source = Array.isArray(saved[key])
    ? saved[key]
    : key === "ASX" && Array.isArray(legacy)
      ? legacy
      : MARKET_CONFIG[key].defaultSymbols;
  const fallbackSource = Array.isArray(saved[key]) ? "saved" : key === "ASX" && Array.isArray(legacy) ? "legacy" : "default";
  const normalized = normalizeWatchlistItemsForMarket(source, key, origins, fallbackSource);
  return normalized.length ? normalized : MARKET_CONFIG[key].defaultSymbols;
}

function normalizeHoldingForStorage(holding, fallbackMarket = "ASX") {
  const market = safeMarket(holding?.market || fallbackMarket);
  return {
    symbol: normalizeSymbolForMarket(holding?.symbol, market),
    market,
    qty: asNumber(holding?.qty),
    avgPrice: asNumber(holding?.avgPrice),
    entryDate: /^\d{4}-\d{2}-\d{2}$/.test(holding?.entryDate || "") ? holding.entryDate : todayIso(),
    source: holding?.source || "manual",
    marketLocked: holding?.marketLocked === true,
    explicitMarket: holding?.explicitMarket === true,
    addedAt: holding?.addedAt || new Date().toISOString(),
  };
}

const initialMarket = safeMarket(safeStorage.getItem("selectedMarket") || "ASX");
const savedPortfolio = readJsonStorage("portfolioJson", []);
const savedPortfolioByMarket = readJsonStorage("portfolioByMarket", null);
const savedWatchlistOrigins = readJsonStorage("watchlistOriginsByMarket", {});

function portfolioRowsFromStorage(byMarket, fallbackRows) {
  if (!byMarket || typeof byMarket !== "object") return Array.isArray(fallbackRows) ? fallbackRows : [];
  return Object.entries(byMarket).flatMap(([market, rows]) => (
    Array.isArray(rows)
      ? rows.map((row) => ({ ...row, market: safeMarket(row?.market || market), marketLocked: row?.marketLocked !== false }))
      : []
  ));
}

const state = {
  market: initialMarket,
  watchlistsByMarket: readJsonStorage("watchlistsByMarket", {}),
  watchlistOriginsByMarket: savedWatchlistOrigins,
  watchlist: initialWatchlistForMarket(initialMarket),
  portfolio: portfolioRowsFromStorage(savedPortfolioByMarket, savedPortfolio).map((item) => normalizeHoldingForStorage(item, item.market || "ASX")).filter((item) => item.symbol && item.qty > 0),
  analyses: new Map(),
  analysesByMarket: new Map(),
  selected: null,
  activePage: safeStorage.getItem("activeQuantPage") || "dashboard",
  chartRange: safeStorage.getItem("chartRange") || "6M",
  chartInterval: safeStorage.getItem("chartInterval") || "1d",
  chartHoverIndex: null,
  chartZoom: Number(safeStorage.getItem("chartZoom") || 1),
  chartOffset: 0,
  chartDragging: null,
  chartOverlays: readJsonStorage("chartOverlays", {
    sma20: true,
    sma50: true,
    vwap: true,
    bollinger: true,
    fib: true,
    fvg: true,
    volume: true,
    profile: true,
    orderflow: true,
    factorPrediction: true,
    macd: true,
    anomalies: true,
  }),
  chartFactorKeys: readJsonStorage("chartFactorKeys", ["momentum", "volume", "vwap", "macd"]),
  featureChart: readJsonStorage("featureChart", {
    metrics: ["close", "vwap", "volume_ratio", "imbalance_proxy"],
    zoom: 1,
    offset: 0,
  }),
  featureChartHoverIndex: null,
  featureChartDragging: null,
  factorLabChart: readJsonStorage("factorLabChart", {
    factors: [],
    zoom: 1,
    offset: 0,
  }),
  factorLabChartHoverIndex: null,
  factorLabChartDragging: null,
  chartExpanded: false,
  autoRefreshTimer: null,
  autoRefreshEnabled: safeStorage.getItem("autoRefreshEnabled") === "true",
  nextAutoRefreshAt: null,
  isRefreshing: false,
  aiRefreshToken: 0,
  clockTimer: null,
  snapshotUpdatedAt: safeStorage.getItem(`analysisSnapshotTime:${initialMarket}`) || (initialMarket === "ASX" ? safeStorage.getItem("analysisSnapshotTime") : null),
  history: Array.isArray(readJsonStorage("decisionHistory", [])) ? readJsonStorage("decisionHistory", []) : [],
  notifiedAlerts: readJsonStorage("notifiedAlerts", {}),
  notificationsEnabled: safeStorage.getItem("notificationsEnabled") === "true",
  latestAlerts: [],
  apiCache: new Map(),
  marketCache: new Map(),
  forecastCache: new Map(),
  chartDataCache: new Map(),
  chartLoading: new Set(),
  accuracySummary: null,
  marketIndexes: [],
  marketIndexSignal: null,
  marketIndexChartSymbol: safeStorage.getItem("marketIndexChartSymbol") || null,
  indexChartInterval: safeStorage.getItem("indexChartInterval") || "1d",
  indexChartRange: safeStorage.getItem("indexChartRange") || "6M",
  indexChartZoom: Number(safeStorage.getItem("indexChartZoom") || 1),
  indexChartOffset: 0,
  indexChartHoverIndex: null,
  indexChartDragging: null,
  indexChartLoading: new Set(),
  marketIndexUsedSnapshotFallback: false,
  marketIndexRefreshing: false,
  marketIndexHydrationTimer: null,
  redditWarmupTimer: null,
  redditWarmupStatus: null,
  stockPicker: { forecast: [], today: [], rejected: [], failures: [], updatedAt: null },
  marketMoversByMarket: readJsonStorage("marketMoversByMarket", {}),
  agentConfigByMarket: readJsonStorage("agentConfigByMarket", {}),
  agentLedgerByMarket: readJsonStorage("agentLedgerByMarket", {}),
  agentMemoryByMarket: readJsonStorage("agentMemoryByMarket", {}),
  researchConfigByMarket: readJsonStorage("researchConfigByMarket", {}),
  modelChangeLogByMarket: readJsonStorage("modelChangeLogByMarket", {}),
  latestFactorLab: null,
  latestRiskAssessment: null,
  runtimeSettings: readJsonStorage("runtimeSettings", {}),
  marketUniverseByMarket: readJsonStorage("marketUniverseByMarket", {}),
  universeStatusByMarket: readJsonStorage("universeStatusByMarket", {}),
  apiStatusByMarket: readJsonStorage("apiStatusByMarket", {}),
  latestFeatureAnalysis: null,
  renderQueue: {
    cards: false,
    summary: false,
    detail: false,
    indexes: false,
    agent: false,
    handle: null,
  },
  chartRedrawHandles: {},
  statusThrottle: { lastAt: 0, handle: null, message: "" },
  marketSwitchToken: 0,
};

const $ = (id) => document.getElementById(id);
const requestUiFrame = window.requestAnimationFrame
  ? (callback) => window.requestAnimationFrame(callback)
  : (callback) => setTimeout(callback, 16);
const cancelUiFrame = window.cancelAnimationFrame
  ? (handle) => window.cancelAnimationFrame(handle)
  : (handle) => clearTimeout(handle);
const requestUiIdle = window.requestIdleCallback
  ? (callback, options) => window.requestIdleCallback(callback, options)
  : (callback) => setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 32);
const cancelUiIdle = window.cancelIdleCallback
  ? (handle) => window.cancelIdleCallback(handle)
  : (handle) => clearTimeout(handle);
const WHEEL_ZOOM_IN = 1.012;
const WHEEL_ZOOM_OUT = 0.988;
const WHEEL_PAN_DIVISOR = 520;
const MODEL_CHANGE_LOG_LIMIT = 250;
const SNAPSHOT_KEY = "analysisSnapshotV2";
const DEFAULT_TECHNICALS = {
  close: 0,
  sma20: 0,
  sma50: 0,
  rsi: 50,
  macdHistogram: 0,
  volumeRatio: 0,
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
const DEFAULT_ANALYSIS = {
  action: "HOLD_WATCH",
  confidence: 0,
  predictionConfidence: 0,
  magnitudeConfidence: 0,
  magnitudeHitProbability: 0,
  moveHitProbability: 0,
  projectedMoveConfidence: 0,
  strategyConfidence: 0,
  strategyHitProbability: 0,
  upsideConfidence: 0,
  downsideConfidence: 0,
  direction: "mixed",
  directionAgreement: 0,
  rawConfidence: 0,
  strategyCalibration: null,
  projectedUpside: 0,
  projectedFinalReturn: 0,
  finalReturnConfidence: 0,
  finalReturnHitProbability: 0,
  projectedMaxUpside: 0,
  maxUpsideConfidence: 0,
  maxUpsideHitProbability: 0,
  horizonDays: 15,
  suggestedTradeValue: 0,
  calibration: null,
  thesis: [],
  risks: [],
};

function bind(id, event, handler) {
  const element = $(id);
  if (element) element.addEventListener(event, handler);
}

function compactRuntimeError(error) {
  return compactDisplayError(error?.message || String(error || "未知错误"));
}

function safeUiStep(label, task, fallback = null) {
  try {
    return task();
  } catch (error) {
    console.error(`${label} failed`, error);
    setStatus(`${label}失败：${compactRuntimeError(error)}；其余模块继续可用`);
    return fallback;
  }
}

async function safeUiStepAsync(label, task, fallback = null) {
  try {
    return await task();
  } catch (error) {
    console.error(`${label} failed`, error);
    setStatus(`${label}失败：${compactRuntimeError(error)}；其余模块继续可用`);
    return fallback;
  }
}

function runUiTask(label, task, fallback = null) {
  try {
    const result = task();
    if (result && typeof result.catch === "function") {
      return result.catch((error) => {
        console.error(`${label} failed`, error);
        setStatus(`${label}失败：${compactRuntimeError(error)}；页面保持可用`);
        return fallback;
      });
    }
    return result;
  } catch (error) {
    console.error(`${label} failed`, error);
    setStatus(`${label}失败：${compactRuntimeError(error)}；页面保持可用`);
    return fallback;
  }
}

function deferUiStep(label, task, delay = 0, options = {}) {
  setTimeout(() => {
    const runner = () => runUiTask(label, task, options.fallback ?? null);
    if (options.frame) {
      requestUiFrame(runner);
      return;
    }
    if (options.idle !== false) {
      requestUiIdle(runner, { timeout: options.timeout || 2500 });
      return;
    }
    runner();
  }, delay);
}

function setStatusThrottled(message, interval = 450) {
  const now = Date.now();
  if (now - state.statusThrottle.lastAt >= interval) {
    state.statusThrottle.lastAt = now;
    setStatus(message);
    return;
  }
  state.statusThrottle.message = message;
  if (state.statusThrottle.handle) return;
  state.statusThrottle.handle = setTimeout(() => {
    state.statusThrottle.handle = null;
    state.statusThrottle.lastAt = Date.now();
    if (state.statusThrottle.message) setStatus(state.statusThrottle.message);
    state.statusThrottle.message = "";
  }, Math.max(0, interval - (now - state.statusThrottle.lastAt)));
}

function flushMainRenderQueue() {
  const queue = state.renderQueue;
  if (queue.handle) {
    cancelUiFrame(queue.handle);
    queue.handle = null;
  }
  const pending = {
    cards: queue.cards,
    summary: queue.summary,
    detail: queue.detail,
    indexes: queue.indexes,
    agent: queue.agent,
  };
  queue.cards = false;
  queue.summary = false;
  queue.detail = false;
  queue.indexes = false;
  queue.agent = false;
  safeUiStep("批量渲染", () => {
    if (pending.cards) renderCards();
    if (pending.summary) renderPortfolioSummary();
    if (pending.indexes) renderMarketIndexPanel();
    if (pending.agent) {
      renderAgentPanel();
      renderOptimalStrategyPanel();
    }
    if (pending.detail) renderDetail();
  });
}

function queueMainRender(parts = ["cards", "summary", "detail"], options = {}) {
  const queue = state.renderQueue;
  (Array.isArray(parts) ? parts : [parts]).forEach((part) => {
    if (part && Object.prototype.hasOwnProperty.call(queue, part)) queue[part] = true;
  });
  if (options.immediate) {
    flushMainRenderQueue();
    return;
  }
  if (queue.handle) return;
  queue.handle = requestUiFrame(() => {
    queue.handle = null;
    flushMainRenderQueue();
  });
}

function renderAnalysisPanelsNow() {
  queueMainRender(["cards", "summary", "detail"], { immediate: true });
}

function scheduleChartRedraw(key, task) {
  const handleKey = String(key || "chart");
  if (state.chartRedrawHandles[handleKey]) return;
  state.chartRedrawHandles[handleKey] = requestUiFrame(() => {
    state.chartRedrawHandles[handleKey] = null;
    safeUiStep(`${handleKey} 图表重绘`, task);
  });
}

function deferMarketStep(token, label, task, delay = 0, options = {}) {
  deferUiStep(label, () => {
    if (token !== state.marketSwitchToken) return false;
    return task();
  }, delay, options);
}

function deferMarketStepAsync(token, label, task, delay = 0, options = {}) {
  deferMarketStep(token, label, async () => {
    if (token !== state.marketSwitchToken) return false;
    try {
      const result = await task();
      if (token !== state.marketSwitchToken) return false;
      return result;
    } catch (error) {
      console.error(`${label} failed`, error);
      setStatus(`${label}失败：${compactRuntimeError(error)}；页面保持可用`);
      return false;
    }
  }, delay, options);
}

function activeMarketConfig() {
  return MARKET_CONFIG[state.market] || MARKET_CONFIG.ASX;
}

function snapshotKey(market = state.market) {
  return `${SNAPSHOT_KEY}:${safeMarket(market)}`;
}

function snapshotTimeKey(market = state.market) {
  return `analysisSnapshotTime:${safeMarket(market)}`;
}

function indexSnapshotKey(market = state.market) {
  return `marketIndexSnapshot:v3:${safeMarket(market)}`;
}

function setStatus(message) {
  const status = $("status");
  if (status) status.textContent = message;
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asPositiveNumber(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function marketParts(date = new Date()) {
  const config = activeMarketConfig();
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: config.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function marketState(date = new Date()) {
  const config = activeMarketConfig();
  const parts = marketParts(date);
  const weekday = parts.weekday;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const open = config.open;
  const close = config.close;
  const refreshClose = config.refreshClose;
  const isTrading = isWeekday && minutes >= open && minutes < close;
  const canRefresh = isWeekday && minutes >= open && minutes < refreshClose;
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  return { ...parts, dateKey, minutes, isWeekday, isTrading, canRefresh, open, close, refreshClose };
}

function minutesUntilNextRefreshWindow(date = new Date()) {
  for (let minute = 1; minute <= 60 * 24 * 10; minute += 1) {
    if (marketState(new Date(date.getTime() + minute * 60000)).canRefresh) return minute;
  }
  return 180;
}

function formatSnapshotTime(iso) {
  if (!iso) return "暂无";
  const config = activeMarketConfig();
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function updateSydneyClock() {
  const stateNow = marketState();
  const config = activeMarketConfig();
  const clock = $("sydneyClock");
  const session = $("marketSession");
  const snapshot = $("snapshotTime");
  if (clock) clock.textContent = `${stateNow.hour}:${stateNow.minute}:${stateNow.second}`;
  const clockLabel = $("clockLabel");
  if (clockLabel) clockLabel.textContent = config.clockLabel;
  if (session) {
    session.textContent = stateNow.isTrading
      ? `${config.code} 交易中，可刷新真实数据`
      : stateNow.canRefresh
        ? "收盘刷新窗口，可更新收盘数据"
        : getRuntimeSettings().allowOffHoursFetch
          ? "休市中，优先快照；可手动刷新真实免费源"
          : `休市中，仅使用本地快照`;
    session.className = stateNow.canRefresh ? "market-open" : "market-closed";
  }
  if (snapshot) snapshot.textContent = snapshotsEnabled() ? `本地快照：${formatSnapshotTime(state.snapshotUpdatedAt)}` : "本地快照：已关闭";
}

function startSydneyClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  updateSydneyClock();
  state.clockTimer = setInterval(updateSydneyClock, 1000);
}

function normalizeSymbol(symbol) {
  return normalizeSymbolForMarket(symbol, state.market);
}

function watchlistOriginFor(symbol, market = state.market, fallback = "saved") {
  const key = safeMarket(market);
  const normalized = normalizeSymbolForMarket(symbol, key);
  return normalized ? state.watchlistOriginsByMarket?.[key]?.[normalized] || fallback : fallback;
}

function setWatchlistOrigin(symbol, source = "manual", market = state.market) {
  const key = safeMarket(market);
  const normalized = normalizeSymbolForMarket(symbol, key);
  if (!normalized) return "";
  state.watchlistOriginsByMarket[key] = state.watchlistOriginsByMarket[key] || {};
  state.watchlistOriginsByMarket[key][normalized] = source;
  return normalized;
}

function removeWatchlistOrigin(symbol, market = state.market) {
  const key = safeMarket(market);
  const normalized = normalizeSymbolForMarket(symbol, key);
  if (normalized && state.watchlistOriginsByMarket?.[key]) delete state.watchlistOriginsByMarket[key][normalized];
}

function addWatchSymbol(symbol, source = "manual", market = state.market, analysis = null) {
  const key = safeMarket(market);
  const normalized = allowWatchSymbolForMarket(symbol, key, source);
  if (!normalized) return "";
  if (key === state.market && !state.watchlist.includes(normalized)) state.watchlist.unshift(normalized);
  setWatchlistOrigin(normalized, source, key);
  if (analysis && key === state.market) state.analyses.set(normalized, { ...analysis, symbol: normalized, market: key });
  return normalized;
}

function sanitizeSymbolsForMarket(symbols, market = state.market, fallbackSource = "saved") {
  const key = safeMarket(market);
  return normalizeWatchlistItemsForMarket(symbols, key, state.watchlistOriginsByMarket, fallbackSource);
}

function reconcileWatchlistOrigins(market = state.market) {
  const key = safeMarket(market);
  const active = new Set(state.watchlist);
  const origins = state.watchlistOriginsByMarket[key] || {};
  state.watchlistOriginsByMarket[key] = Object.fromEntries(
    Object.entries(origins).filter(([symbol]) => active.has(normalizeSymbolForMarket(symbol, key)))
  );
  state.watchlist.forEach((symbol) => {
    const normalized = normalizeSymbolForMarket(symbol, key);
    if (normalized && !state.watchlistOriginsByMarket[key][normalized]) {
      state.watchlistOriginsByMarket[key][normalized] = marketDefaultSet(key).has(normalized) ? "default" : "saved";
    }
  });
}

function sanitizeActiveMarketState() {
  state.watchlist = sanitizeSymbolsForMarket(state.watchlist, state.market);
  reconcileWatchlistOrigins(state.market);
  state.analyses = new Map([...state.analyses.entries()]
    .map(([symbol, item]) => {
      const normalized = normalizeSymbolForMarket(item?.symbol || symbol, state.market);
      if (!normalized) return null;
      if (item?.market && safeMarket(item.market) !== state.market) return null;
      const source = watchlistOriginFor(normalized, state.market, "analysis");
      if (!allowWatchSymbolForMarket(normalized, state.market, source)) return null;
      return [normalized, { ...item, symbol: normalized, market: state.market }];
    })
    .filter(Boolean));
  state.selected = normalizeSymbolForMarket(state.selected, state.market) || state.watchlist.find((symbol) => state.analyses.has(symbol)) || state.watchlist[0] || null;
}

function textList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  const text = String(value || "").trim();
  return text ? [text] : [];
}

function normalizeTechnicals(value = {}) {
  const technicals = { ...DEFAULT_TECHNICALS, ...(value || {}) };
  Object.keys(DEFAULT_TECHNICALS).forEach((key) => {
    technicals[key] = asNumber(technicals[key], DEFAULT_TECHNICALS[key]);
  });
  return technicals;
}

function normalizeAnalysis(value = {}) {
  const analysis = { ...DEFAULT_ANALYSIS, ...(value || {}) };
  analysis.action = String(analysis.action || DEFAULT_ANALYSIS.action);
  analysis.confidence = asNumber(analysis.confidence, DEFAULT_ANALYSIS.confidence);
  analysis.projectedUpside = asNumber(analysis.projectedUpside, DEFAULT_ANALYSIS.projectedUpside);
  analysis.projectedFinalReturn = asNumber(analysis.projectedFinalReturn, analysis.projectedUpside);
  analysis.predictionConfidence = asNumber(analysis.predictionConfidence, analysis.confidence);
  analysis.magnitudeHitProbability = asNumber(analysis.magnitudeHitProbability, analysis.magnitudeConfidence || analysis.moveHitProbability || analysis.projectedMoveConfidence || analysis.qualityGate?.magnitudeHitProbability || 0);
  analysis.magnitudeConfidence = asNumber(analysis.magnitudeConfidence, analysis.magnitudeHitProbability);
  analysis.moveHitProbability = asNumber(analysis.moveHitProbability, analysis.magnitudeHitProbability);
  analysis.projectedMoveConfidence = asNumber(analysis.projectedMoveConfidence, analysis.magnitudeHitProbability);
  analysis.finalReturnHitProbability = asNumber(analysis.finalReturnHitProbability, analysis.finalReturnConfidence || analysis.magnitudeHitProbability || analysis.qualityGate?.finalReturnHitProbability || 0);
  analysis.finalReturnConfidence = asNumber(analysis.finalReturnConfidence, analysis.finalReturnHitProbability);
  analysis.projectedMaxUpside = asNumber(
    analysis.projectedMaxUpside,
    Math.max(0, analysis.projectedUpside, analysis.qualityGate?.projectedMaxUpside || 0)
  );
  analysis.maxUpsideHitProbability = asNumber(
    analysis.maxUpsideHitProbability,
    analysis.maxUpsideConfidence || analysis.qualityGate?.maxUpsideHitProbability || analysis.magnitudeHitProbability
  );
  analysis.maxUpsideConfidence = asNumber(analysis.maxUpsideConfidence, analysis.maxUpsideHitProbability);
  analysis.strategyHitProbability = asNumber(analysis.strategyHitProbability, analysis.strategyConfidence || analysis.qualityGate?.strategyHitProbability || analysis.qualityGate?.historyGate?.strategyHitProbability || 0);
  analysis.strategyConfidence = asNumber(analysis.strategyConfidence, analysis.strategyHitProbability);
  analysis.upsideConfidence = asNumber(analysis.upsideConfidence, analysis.projectedFinalReturn > 0 ? analysis.confidence : 0);
  analysis.downsideConfidence = asNumber(analysis.downsideConfidence, analysis.projectedFinalReturn < 0 ? analysis.confidence : 0);
  analysis.direction = String(analysis.direction || (analysis.projectedFinalReturn > 0 ? "upside" : analysis.projectedFinalReturn < 0 ? "downside" : "mixed"));
  analysis.directionAgreement = asNumber(analysis.directionAgreement, 0);
  analysis.rawConfidence = asNumber(analysis.rawConfidence, analysis.confidence);
  analysis.horizonDays = asNumber(analysis.horizonDays, DEFAULT_ANALYSIS.horizonDays);
  analysis.suggestedTradeValue = asNumber(analysis.suggestedTradeValue, DEFAULT_ANALYSIS.suggestedTradeValue);
  analysis.thesis = textList(analysis.thesis);
  analysis.risks = textList(analysis.risks);
  return analysis;
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.map((row) => {
    const close = asPositiveNumber(row?.close);
    if (!row?.date || !Number.isFinite(close)) return null;
    const open = asPositiveNumber(row?.open, close);
    const rawHigh = asPositiveNumber(row?.high, Math.max(open, close));
    const rawLow = asPositiveNumber(row?.low, Math.min(open, close));
    return {
      date: String(row?.date || ""),
      open,
      high: Math.max(rawHigh, open, close),
      low: Math.min(rawLow, open, close),
      close,
      adjClose: asPositiveNumber(row?.adjClose, close),
      volume: Math.max(0, asNumber(row?.volume, 0)),
      buyVolume: asNumber(row?.buyVolume ?? row?.aggressiveBuyVolume ?? row?.activeBuyVolume, NaN),
      sellVolume: asNumber(row?.sellVolume ?? row?.aggressiveSellVolume ?? row?.activeSellVolume, NaN),
      buyTrades: asNumber(row?.buyTrades ?? row?.buyCount ?? row?.aggressiveBuyTrades, NaN),
      sellTrades: asNumber(row?.sellTrades ?? row?.sellCount ?? row?.aggressiveSellTrades, NaN),
      tradeCount: asNumber(row?.tradeCount ?? row?.trades ?? row?.count, NaN),
      priceLevels: Array.isArray(row?.priceLevels)
        ? row.priceLevels
        : Array.isArray(row?.ladder)
          ? row.ladder
          : Array.isArray(row?.orderflowLevels)
            ? row.orderflowLevels
            : [],
      orderflowSource: row?.orderflowSource || row?.tradeSource || null,
      closeOnly: Boolean(row?.closeOnly),
    };
  }).filter(Boolean);
}

function hasRequiredSnapshotTechnicals(technicals) {
  return ["close", "rsi", "volumeRatio", "mainForceProxy"].every((key) => Number.isFinite(Number(technicals?.[key])));
}

function normalizeAnalysisItem(item, payloadMarket = state.market) {
  const market = safeMarket(payloadMarket);
  if (item?.market && safeMarket(item.market) !== market) return null;
  const symbol = normalizeSymbolForMarket(item?.symbol, market);
  const source = watchlistOriginFor(symbol, market, "snapshot");
  if (!allowWatchSymbolForMarket(symbol, market, source)) return null;
  const sourceTechnicals = item?.technicals || item?.technical || {};
  const sourceAnalysis = item?.analysis || {};
  const candles = normalizeCandles(item?.candles);
  if (!symbol || !sourceAnalysis.action || !candles.length || !hasRequiredSnapshotTechnicals(sourceTechnicals)) return null;
  return {
    ...item,
    symbol,
    market,
    candles,
    technicals: normalizeTechnicals(sourceTechnicals),
    analysis: normalizeAnalysis(sourceAnalysis),
    news: Array.isArray(item?.news) ? item.news : [],
    xPosts: Array.isArray(item?.xPosts) ? item.xPosts : [],
    youtubeItems: Array.isArray(item?.youtubeItems) ? item.youtubeItems : [],
    factors: item?.factors || null,
    analog: item?.analog || null,
  };
}

function normalizeSnapshotPayload(payload) {
  const payloadMarket = safeMarket(payload?.market || state.market);
  if (payloadMarket !== state.market) return null;
  const analyses = Array.isArray(payload?.analyses)
    ? payload.analyses.map((item) => normalizeAnalysisItem(item, payloadMarket)).filter(Boolean)
    : [];
  if (!analyses.length) return null;
  const symbols = new Set(analyses.map((item) => item.symbol));
  const watchlist = Array.isArray(payload.watchlist)
    ? sanitizeSymbolsForMarket(payload.watchlist, payloadMarket, "snapshot")
    : [];
  const selected = normalizeSymbolForMarket(payload.selected, payloadMarket);
  return {
    ...payload,
    market: payloadMarket,
    analyses,
    watchlist: [...new Set([...watchlist, ...symbols])],
    selected: symbols.has(selected) ? selected : analyses[0].symbol,
  };
}

function getStrategy() {
  return {
    horizonDays: asNumber($("horizonDays").value, 15),
    confidence: asNumber($("confidence").value, 80),
    targetUpside: asNumber($("targetUpside").value, 5),
    maxPosition: asNumber($("maxPosition").value, 20),
    reserveCashPct: asNumber($("reserveCashPct").value, 15),
    stopLoss: asNumber($("stopLoss").value, 4),
    text: $("strategyText").value.trim(),
  };
}

function getRuntimeSettings() {
  const saved = state.runtimeSettings || {};
  return {
    fastInitialRefresh: $("fastInitialRefresh") ? $("fastInitialRefresh").checked : saved.fastInitialRefresh !== false,
    allowOffHoursFetch: $("allowOffHoursFetch") ? $("allowOffHoursFetch").checked : saved.allowOffHoursFetch !== false,
    keepSnapshots: $("keepSnapshots") ? $("keepSnapshots").checked : saved.keepSnapshots !== false,
  };
}

function saveRuntimeSettings() {
  state.runtimeSettings = getRuntimeSettings();
  safeStorage.setItem("runtimeSettings", JSON.stringify(state.runtimeSettings));
}

function snapshotsEnabled() {
  return getRuntimeSettings().keepSnapshots;
}

function portfolioByMarketRows() {
  return Object.fromEntries(Object.keys(MARKET_CONFIG).map((market) => [
    market,
    state.portfolio
      .filter((holding) => holding.market === market)
      .map((holding) => ({ ...holding, market, marketLocked: holding.marketLocked !== false })),
  ]));
}

function holdingAllowedInMarket(holding, market = state.market) {
  const key = safeMarket(market);
  if (safeMarket(holding?.market) !== key) return false;
  const symbol = normalizeSymbolForMarket(holding?.symbol, key);
  if (!symbol) return false;
  if (LEGACY_WRONG_MARKET_HOLDINGS[key]?.has(symbol) && holding?.explicitMarket !== true) return false;
  const source = String(holding?.source || "").toLowerCase();
  const origin = watchlistOriginFor(symbol, key, "saved");
  const native = isMarketNativeAutoSymbol(symbol, key);
  const explicit = holding?.explicitMarket === true;
  if (source.split("+").some((part) => ["manual", "csv", "text", "screenshot"].includes(part))) return explicit || native;
  if (source.split("+").includes("app-buy")) {
    return native || explicit || origin === "ai-pick";
  }
  return native || explicit;
}

function sanitizePortfolioByMarket() {
  state.portfolio = mergeHoldings(state.portfolio).filter((holding) => holdingAllowedInMarket(holding, holding.market));
  return state.portfolio;
}

function activePortfolio() {
  return state.portfolio.filter((holding) => {
    return holdingAllowedInMarket(holding, state.market);
  });
}

function activeHistory() {
  return state.history.filter((item) => safeMarket(item.market || "ASX") === state.market);
}

function getCapital() {
  const baseCapital = asNumber($("totalCapital").value, 0);
  const portfolioValue = activePortfolio().reduce((sum, holding) => {
    const close = state.analyses.get(holding.symbol)?.technicals?.close || holding.avgPrice;
    return sum + close * holding.qty;
  }, 0);
  const costValue = activePortfolio().reduce((sum, holding) => sum + holding.avgPrice * holding.qty, 0);
  const unrealizedPnl = portfolioValue - costValue;
  const totalCapital = Math.max(0, baseCapital + unrealizedPnl);
  const investedValue = Math.max(0, portfolioValue);
  const investedPct = totalCapital > 0 ? clamp(investedValue / totalCapital * 100, 0, 999) : 0;
  const availablePct = Math.max(0, 100 - investedPct);
  const availableCash = Math.max(0, baseCapital - costValue);
  const reserveCashPct = asNumber($("reserveCashPct").value, 15);
  const reservedCash = totalCapital * reserveCashPct / 100;
  const availableForNewTrades = Math.max(0, availableCash - reservedCash);
  return { baseCapital, totalCapital, investedPct, availablePct, investedValue, costValue, unrealizedPnl, availableCash, reserveCashPct, reservedCash, availableForNewTrades };
}

function saveState() {
  sanitizeActiveMarketState();
  state.watchlist = sanitizeSymbolsForMarket(state.watchlist, state.market);
  reconcileWatchlistOrigins(state.market);
  state.watchlistsByMarket[state.market] = state.watchlist;
  safeStorage.setItem("selectedMarket", state.market);
  safeStorage.setItem("watchlistsByMarket", JSON.stringify(state.watchlistsByMarket));
  safeStorage.setItem("watchlistOriginsByMarket", JSON.stringify(state.watchlistOriginsByMarket));
  safeStorage.setItem("watchlist", JSON.stringify(state.watchlist));
  safeStorage.setItem("strategy", JSON.stringify(getStrategy()));
  safeStorage.setItem("capital", JSON.stringify({ ...getCapital(), baseCapital: asNumber($("totalCapital").value, 0) }));
  safeStorage.setItem(`portfolioCsv:${state.market}`, $("portfolioCsv").value);
  safeStorage.setItem("portfolioJson", JSON.stringify(state.portfolio));
  safeStorage.setItem("portfolioByMarket", JSON.stringify(portfolioByMarketRows()));
  safeStorage.setItem("chartRange", state.chartRange);
  safeStorage.setItem("chartInterval", state.chartInterval || "1d");
  safeStorage.setItem("autoRefreshEnabled", String(state.autoRefreshEnabled));
  safeStorage.setItem("refreshInterval", $("refreshInterval").value);
  safeStorage.setItem("marketUniverseByMarket", JSON.stringify(state.marketUniverseByMarket));
  safeStorage.setItem("universeStatusByMarket", JSON.stringify(state.universeStatusByMarket));
  saveRuntimeSettings();
}

function syncCapitalFields() {
  const capital = getCapital();
  if ($("holdingOccupied")) $("holdingOccupied").value = capital.investedValue.toFixed(2);
  if ($("availableCash")) $("availableCash").value = capital.availableCash.toFixed(2);
}

function loadSavedInputs() {
  const strategy = readJsonStorage("strategy", null);
  if (strategy) {
    $("horizonDays").value = strategy.horizonDays ?? 15;
    $("confidence").value = strategy.confidence ?? 80;
    $("targetUpside").value = strategy.targetUpside ?? 5;
    $("maxPosition").value = strategy.maxPosition ?? 20;
    $("reserveCashPct").value = strategy.reserveCashPct ?? 15;
    $("stopLoss").value = strategy.stopLoss ?? 4;
    $("strategyText").value = strategy.text || $("strategyText").value;
  }
  const capital = readJsonStorage("capital", null);
  if (capital) {
    $("totalCapital").value = capital.baseCapital ?? capital.totalCapital ?? 5000;
  }
  const runtimeSettings = readJsonStorage("runtimeSettings", {});
  state.runtimeSettings = runtimeSettings || {};
  if ($("fastInitialRefresh")) $("fastInitialRefresh").checked = runtimeSettings.fastInitialRefresh !== false;
  if ($("allowOffHoursFetch")) $("allowOffHoursFetch").checked = runtimeSettings.allowOffHoursFetch !== false;
  if ($("keepSnapshots")) $("keepSnapshots").checked = runtimeSettings.keepSnapshots !== false;
  const savedInterval = asNumber(safeStorage.getItem("refreshInterval"), 1800000);
  const refreshIntervals = [60000, 300000, 600000, 1800000, 3600000];
  const nearestInterval = refreshIntervals.reduce((best, value) => (
    Math.abs(value - savedInterval) < Math.abs(best - savedInterval) ? value : best
  ), 1800000);
  $("refreshInterval").value = String(nearestInterval);
  $("portfolioCsv").value = safeStorage.getItem(`portfolioCsv:${state.market}`) || holdingsToCsv(activePortfolio()) || activeMarketConfig().samplePortfolio;
  $("holdingEntryDate").value = todayIso();
  syncCapitalFields();
}

function parsePortfolio(csv) {
  const lines = String(csv || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const hasHeader = /symbol|code|股票|代码/i.test(lines[0]);
  const headers = hasHeader ? lines[0].split(/,|\t/).map((item) => item.trim().toLowerCase()) : [];
  const indexFor = (patterns, fallback) => {
    const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    return index >= 0 ? index : fallback;
  };
  const symbolIndex = indexFor([/symbol|ticker|code|代码|证券代码|股票/], 0);
  const qtyIndex = indexFor([/qty|quantity|shares|units|数量|持仓|可用/], 1);
  const avgIndex = indexFor([/avg|average|cost|price|成本|均价|买入价|持仓成本/], 2);
  const dateIndex = indexFor([/date|entry|buy|time|日期|买入日|建仓/], 3);
  const rows = hasHeader ? lines.slice(1) : lines;
  const numberValue = (value) => asNumber(String(value ?? "").replace(/[,$，\s]|AUD|USD|CNY|RMB|人民币|澳元|美元|元/gi, ""), 0);
  return rows.map((line) => {
    const parts = line.includes(",") || line.includes("\t")
      ? line.split(/,|\t/).map((item) => item.trim())
      : line.split(/\s{2,}|\s+/).map((item) => item.trim()).filter(Boolean);
    const symbol = parts[symbolIndex] ?? parts[0];
    const qty = parts[qtyIndex] ?? parts[1];
    const avgPrice = parts[avgIndex] ?? parts[2];
    const entryDate = parts[dateIndex] ?? parts[3];
    return {
      symbol: normalizeSymbolForMarket(symbol, state.market),
      market: state.market,
      qty: numberValue(qty),
      avgPrice: numberValue(avgPrice),
      entryDate: /^\d{4}-\d{2}-\d{2}$/.test(entryDate || "") ? entryDate : todayIso(),
      source: "csv",
      marketLocked: true,
      explicitMarket: true,
      addedAt: new Date().toISOString(),
    };
  }).filter((row) => row.symbol && row.qty > 0 && row.avgPrice > 0);
}

function parsePortfolioText(text) {
  const holdings = parsePortfolio(text);
  if (holdings.length) return holdings;
  const rows = [];
  const pattern = /\b([A-Z]{1,6}(?:\.[A-Z])?|\d{6})(?:\.A[UX]|\.SS|\.SH|\.SZ|\.SHH|\.SHZ|\.SHE)?\b[^\d]{0,40}([\d,，,]+(?:\.\d+)?)\D{1,40}(?:AUD|USD|CNY|RMB|\$|A\$|￥|均价|成本|avg|average|price)?\s*(\d+(?:\.\d+)?)/gi;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    rows.push({
      symbol: normalizeSymbolForMarket(String(match[1]).toUpperCase(), state.market),
      market: state.market,
      qty: asNumber(match[2].replace(/,|，/g, "")),
      avgPrice: asNumber(match[3]),
      entryDate: todayIso(),
      source: "text",
      marketLocked: true,
      explicitMarket: true,
      addedAt: new Date().toISOString(),
    });
  }
  return rows.filter((row) => row.symbol && row.qty > 0 && row.avgPrice > 0);
}

function holdingsToCsv(holdings) {
  return ["symbol,qty,avgPrice,entryDate", ...holdings.map((item) => `${item.symbol},${item.qty},${item.avgPrice},${item.entryDate || todayIso()}`)].join("\n");
}

function savePortfolio() {
  state.portfolio = sanitizePortfolioByMarket();
  $("portfolioCsv").value = holdingsToCsv(activePortfolio());
  safeStorage.setItem(`portfolioCsv:${state.market}`, $("portfolioCsv").value);
  safeStorage.setItem("portfolioJson", JSON.stringify(state.portfolio));
  safeStorage.setItem("portfolioByMarket", JSON.stringify(portfolioByMarketRows()));
  activePortfolio().forEach((holding) => {
    addWatchSymbol(holding.symbol, holding.source || "holding", holding.market || state.market);
  });
  saveState();
}

function mergeHoldings(holdings) {
  const bySymbol = new Map();
  holdings.forEach((holding) => {
    const market = safeMarket(holding.market || state.market);
    const symbol = normalizeSymbolForMarket(holding.symbol, market);
    if (!symbol || holding.qty <= 0) return;
    const key = `${market}:${symbol}`;
    const existing = bySymbol.get(key);
    const row = {
      symbol,
      market,
      qty: asNumber(holding.qty),
      avgPrice: asNumber(holding.avgPrice),
      entryDate: holding.entryDate || todayIso(),
      source: holding.source || "manual",
      marketLocked: holding.marketLocked === true,
      explicitMarket: holding.explicitMarket === true,
      addedAt: holding.addedAt || new Date().toISOString(),
    };
    if (!existing) {
      bySymbol.set(key, row);
      return;
    }
    const totalQty = existing.qty + row.qty;
    bySymbol.set(key, {
      ...existing,
      qty: totalQty,
      avgPrice: totalQty > 0 ? ((existing.avgPrice * existing.qty) + (row.avgPrice * row.qty)) / totalQty : row.avgPrice,
      entryDate: existing.entryDate <= row.entryDate ? existing.entryDate : row.entryDate,
      source: `${existing.source}+${row.source}`,
      marketLocked: existing.marketLocked === true || row.marketLocked === true,
      explicitMarket: existing.explicitMarket === true || row.explicitMarket === true,
    });
  });
  return [...bySymbol.values()];
}

function upsertHolding(holding) {
  const market = safeMarket(holding.market || state.market);
  const symbol = normalizeSymbolForMarket(holding.symbol, market);
  if (!symbol || asNumber(holding.qty) <= 0 || asNumber(holding.avgPrice) <= 0) return false;
  const index = state.portfolio.findIndex((item) => item.symbol === symbol && item.market === market);
  const row = {
    symbol,
    market,
    qty: asNumber(holding.qty),
    avgPrice: asNumber(holding.avgPrice),
    entryDate: holding.entryDate || todayIso(),
    source: holding.source || "manual",
    marketLocked: holding.marketLocked !== false,
    explicitMarket: holding.explicitMarket !== false,
    addedAt: holding.addedAt || new Date().toISOString(),
  };
  if (index >= 0) state.portfolio[index] = row;
  else state.portfolio.push(row);
  savePortfolio();
  return true;
}

function ema(values, period) {
  const alpha = 2 / (period + 1);
  const output = [];
  let previous = values[0];
  values.forEach((value, index) => {
    previous = index === 0 ? value : value * alpha + previous * (1 - alpha);
    output.push(previous);
  });
  return output;
}

function sma(values, period) {
  return values.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const slice = values.slice(start, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

function pctChange(current, previous) {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeTechnicals(candles) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return { ...DEFAULT_TECHNICALS };
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume || 0);
  const latest = rows[rows.length - 1] || {};
  const close = latest.close || 0;
  const sma20 = sma(closes, 20).at(-1) || close;
  const sma50 = sma(closes, 50).at(-1) || close;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((value, index) => value - ema26[index]);
  const signalLine = ema(macdLine, 9);
  const macdHistogram = (macdLine.at(-1) || 0) - (signalLine.at(-1) || 0);
  const latestRsi = rsi(closes);
  const avgVolume20 = sma(volumes, 20).at(-1) || 1;
  const volumeRatio = (latest.volume || 0) / avgVolume20;
  const change5d = pctChange(close, closes.at(-6));
  const change20d = pctChange(close, closes.at(-21));
  const volatility = Math.sqrt(
    closes.slice(-20).map((value, index, arr) => index ? Math.pow(pctChange(value, arr[index - 1]), 2) : 0)
      .reduce((sum, value) => sum + value, 0) / 20
  );

  const trendScore = clamp(50 + (close > sma20 ? 14 : -8) + (sma20 > sma50 ? 12 : -10) + change20d, 0, 100);
  const momentumScore = clamp(50 + macdHistogram * 120 + (latestRsi - 50) * 0.9 + change5d, 0, 100);
  const volumeScore = clamp(45 + (volumeRatio - 1) * 28, 0, 100);
  const riskScore = clamp(82 - volatility * 8, 0, 100);
  const projectedUpside = clamp((trendScore + momentumScore + volumeScore - 145) / 8, -12, 18);
  const mainForceProxy = clamp(50 + (volumeRatio - 1) * 18 + macdHistogram * 80 + change5d * 0.9, 0, 100);

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

function computeMacdSeries(candles) {
  const rows = normalizeCandles(candles);
  const closes = rows.map((row) => row.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12.map((value, index) => value - ema26[index]);
  const signal = ema(macd, 9);
  const histogram = macd.map((value, index) => value - signal[index]);
  return { macd, signal, histogram };
}

function forwardStrategyOutcome(rows, startIndex, horizon = 15, strategy = {}) {
  const entry = Number(rows[startIndex]?.close || 0);
  const targetUpside = Math.max(0.5, Number(strategy.targetUpside || 5));
  const stopLoss = Math.max(0.8, Math.abs(Number(strategy.stopLoss || 4)));
  const endIndex = Math.min(rows.length - 1, startIndex + Math.max(1, Number(horizon || 15)));
  if (!entry || startIndex >= endIndex) {
    return { forwardReturn: 0, maxUpside: 0, maxDrawdown: 0, targetWins: false, stopWins: false, hitTarget: false, hitStop: false };
  }

  let maxHigh = entry;
  let minLow = entry;
  let firstEvent = null;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const row = rows[index];
    const highReturn = pctChange(row.high || row.close, entry);
    const lowReturn = pctChange(row.low || row.close, entry);
    maxHigh = Math.max(maxHigh, row.high || row.close);
    minLow = Math.min(minLow, row.low || row.close);
    if (!firstEvent && highReturn >= targetUpside) firstEvent = "target";
    if (!firstEvent && lowReturn <= -stopLoss) firstEvent = "stop";
  }

  const forwardReturn = pctChange(rows[endIndex].close, entry);
  const maxUpside = pctChange(maxHigh, entry);
  const maxDrawdown = pctChange(minLow, entry);
  const hitTarget = maxUpside >= targetUpside;
  const hitStop = maxDrawdown <= -stopLoss;
  return {
    forwardReturn,
    maxUpside,
    maxDrawdown,
    hitTarget,
    hitStop,
    targetWins: hitTarget && (!hitStop || firstEvent === "target"),
    stopWins: hitStop && (!hitTarget || firstEvent === "stop"),
    riskAdjustedReturn: hitTarget && (!hitStop || firstEvent === "target")
      ? Math.min(maxUpside, targetUpside)
      : hitStop && (!hitTarget || firstEvent === "stop")
        ? -stopLoss
        : forwardReturn,
  };
}

function computeHistoricalAnalog(candles, lookback = 15, horizon = 15, strategy = getStrategy()) {
  const rows = normalizeCandles(candles);
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
      examples: [],
    };
  }
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume || 0);
  const avgVolume = sma(volumes, 20);
  const vectorAt = (end) => {
    const out = [];
    for (let index = end - lookback + 1; index <= end; index += 1) {
      out.push(pctChange(closes[index], closes[index - 1]) / 4);
      out.push(((volumes[index] || 0) / (avgVolume[index] || 1) - 1) / 3);
    }
    return out;
  };
  const target = vectorAt(rows.length - 1);
  const distance = (a, b) => Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / a.length);
  const matches = [];
  for (let end = lookback; end < rows.length - horizon - 1; end += 1) {
    const dist = distance(target, vectorAt(end));
    const outcome = forwardStrategyOutcome(rows, end, horizon, strategy);
    matches.push({
      date: rows[end].date,
      distance: dist,
      forwardReturn: outcome.forwardReturn,
      maxUpside: outcome.maxUpside,
      maxDrawdown: outcome.maxDrawdown,
      targetWins: outcome.targetWins,
      stopWins: outcome.stopWins,
      riskAdjustedReturn: outcome.riskAdjustedReturn,
      close: closes[end],
    });
  }
  const best = matches.sort((a, b) => a.distance - b.distance).slice(0, 8);
  const averageForwardReturn = best.reduce((sum, item) => sum + item.forwardReturn, 0) / best.length;
  const averageMaxUpside = best.reduce((sum, item) => sum + Math.max(0, item.maxUpside), 0) / best.length;
  const averageRiskAdjustedReturn = best.reduce((sum, item) => sum + item.riskAdjustedReturn, 0) / best.length;
  const winRate = best.filter((item) => item.forwardReturn > 0).length / best.length * 100;
  const targetHitRate = best.filter((item) => item.targetWins).length / best.length * 100;
  const stopRate = best.filter((item) => item.stopWins).length / best.length * 100;
  const downsideRate = best.filter((item) => item.forwardReturn < 0 || item.stopWins).length / best.length * 100;
  const directionalHitRate = averageRiskAdjustedReturn >= 0 ? winRate : downsideRate;
  const strategyHitProbability = averageRiskAdjustedReturn >= 0 ? targetHitRate : Math.max(stopRate, downsideRate);
  const confidence = clamp(34 + directionalHitRate * 0.42 + strategyHitProbability * 0.12 + Math.abs(averageRiskAdjustedReturn) * 1.6 - (best[0]?.distance || 0) * 8, 0, 95);
  const model = computeSelfSupervisedForecast(rows, horizon, strategy);
  const blendedFinalReturn = model.sampleCount
    ? averageForwardReturn * 0.6 + model.predictedReturn * 0.4
    : averageForwardReturn;
  const blendedRiskAdjustedReturn = model.sampleCount
    ? averageRiskAdjustedReturn * 0.58 + model.predictedReturn * 0.42
    : averageRiskAdjustedReturn;
  const blendedMaxUpside = model.sampleCount && Number.isFinite(Number(model.predictedMaxUpside))
    ? averageMaxUpside * 0.58 + Number(model.predictedMaxUpside || 0) * 0.42
    : averageMaxUpside;
  const finalReturnTarget = Math.abs(blendedFinalReturn);
  const finalReturnHitRate = finalReturnTarget >= 0.25
    ? best.filter((item) => blendedFinalReturn >= 0
      ? item.forwardReturn >= finalReturnTarget * 0.88
      : item.forwardReturn <= -finalReturnTarget * 0.88).length / best.length * 100
    : directionalHitRate;
  const maxUpsideHitRate = blendedMaxUpside >= 0.25
    ? best.filter((item) => Math.max(0, item.maxUpside) >= blendedMaxUpside * 0.88).length / best.length * 100
    : targetHitRate;
  const blendedConfidence = model.sampleCount
    ? clamp(confidence * 0.58 + model.confidence * 0.42, 0, 95)
    : confidence;
  return {
    count: best.length,
    confidence: blendedConfidence,
    averageForwardReturn: blendedFinalReturn,
    averageFinalReturn: blendedFinalReturn,
    averageMaxUpside: Math.max(0, blendedMaxUpside),
    winRate,
    targetHitRate,
    finalReturnHitRate,
    maxUpsideHitRate,
    stopRate,
    downsideRate,
    directionalHitRate,
    strategyHitProbability,
    averageRiskAdjustedReturn: blendedRiskAdjustedReturn,
    model,
    examples: best.slice(0, 8),
  };
}

function featureVector(candles, end) {
  const rows = normalizeCandles(candles);
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume || 0);
  const close = closes[end];
  const window = closes.slice(Math.max(0, end - 20), end + 1);
  const volatility = Math.sqrt(window.map((value, index, arr) => index ? Math.pow(pctChange(value, arr[index - 1]), 2) : 0).reduce((sum, value) => sum + value, 0) / Math.max(1, window.length));
  const sma20Value = sma(closes.slice(0, end + 1), 20).at(-1) || close;
  const sma50Value = sma(closes.slice(0, end + 1), 50).at(-1) || close;
  const avgVolume20 = sma(volumes.slice(0, end + 1), 20).at(-1) || 1;
  const macd = computeMacdSeries(rows.slice(0, end + 1));
  return [
    1,
    pctChange(close, closes[end - 1]) / 10,
    pctChange(close, closes[end - 3]) / 15,
    pctChange(close, closes[end - 5]) / 20,
    pctChange(close, closes[end - 10]) / 25,
    pctChange(close, closes[end - 20]) / 35,
    ((volumes[end] || 0) / avgVolume20 - 1) / 3,
    (rsi(closes.slice(0, end + 1)) - 50) / 50,
    ((macd.histogram.at(-1) || 0) / close) * 20,
    ((sma20Value / sma50Value) - 1) * 8,
    volatility / 5,
  ].map((value) => Number.isFinite(value) ? value : 0);
}

function computeSelfSupervisedForecast(candles, horizon, strategy = getStrategy()) {
  const rows = normalizeCandles(candles);
  if (rows.length < 95 + horizon) {
    return { sampleCount: 0, predictedReturn: 0, predictedMaxUpside: 0, confidence: 0, mae: 0, maxUpsideMae: 0, directionalAccuracy: 0, targetHitAccuracy: 0, maxUpsideHitAccuracy: 0 };
  }
  const latest = rows.at(-1) || {};
  const targetUpside = Math.max(0.5, Number(strategy.targetUpside || 5));
  const stopLoss = Math.max(0.8, Math.abs(Number(strategy.stopLoss || 4)));
  const cacheKey = `${latest.date}:${latest.close}:${latest.volume}:stacked:${horizon}:${rows.length}:${targetUpside}:${stopLoss}`;
  const cached = state.forecastCache.get(cacheKey);
  if (cached) return cached;
  const requestedHorizon = Math.max(1, Number(horizon || 15));
  const horizons = [...new Set([
    Math.max(3, Math.round(requestedHorizon * 0.5)),
    requestedHorizon,
    Math.min(45, Math.max(requestedHorizon + 3, Math.round(requestedHorizon * 1.6))),
  ])].filter((item) => item > 0);
  const featureCache = new Map();
  const vectorFor = (end) => {
    if (!featureCache.has(end)) featureCache.set(end, featureVector(rows, end));
    return featureCache.get(end);
  };
  const dot = (weights, x) => weights.reduce((sum, weight, index) => sum + weight * x[index], 0);
  const trainLinear = (trainingSamples, epochs = 20) => {
    if (!trainingSamples.length) return [];
    const weights = Array(trainingSamples[0].x.length).fill(0);
    const lr = 0.016;
    const ridge = 0.002;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (const sample of trainingSamples) {
        const pred = dot(weights, sample.x);
        const error = pred - sample.y;
        for (let index = 0; index < weights.length; index += 1) {
          weights[index] -= lr * (error * sample.x[index] + ridge * weights[index]);
        }
      }
    }
    return weights;
  };
  const samples = [];
  for (let end = 55; end < rows.length - Math.min(...horizons) - 1; end += 2) {
    const x = vectorFor(end);
    horizons.forEach((targetHorizon) => {
      if (end + targetHorizon >= rows.length) return;
      const scale = Math.sqrt(requestedHorizon / targetHorizon);
      const outcome = forwardStrategyOutcome(rows, end, targetHorizon, strategy);
      samples.push({
        end,
        x,
        y: (outcome.riskAdjustedReturn / 10) * scale,
        finalY: (outcome.forwardReturn / 10) * scale,
        maxY: (Math.max(0, outcome.maxUpside) / 10) * scale,
        targetWins: outcome.targetWins,
        forwardReturn: outcome.forwardReturn,
        maxUpside: Math.max(0, outcome.maxUpside),
      });
    });
  }
  if (!samples.length) return { sampleCount: 0, predictedReturn: 0, predictedMaxUpside: 0, confidence: 0, mae: 0, maxUpsideMae: 0, directionalAccuracy: 0, targetHitAccuracy: 0, maxUpsideHitAccuracy: 0 };

  samples.sort((a, b) => a.end - b.end);
  const purge = Math.max(2, Math.round(requestedHorizon / 2));
  const testSize = Math.max(18, Math.min(80, Math.floor(samples.length * 0.24)));
  const testStart = Math.max(1, samples.length - testSize);
  const trainSamples = samples.slice(0, Math.max(1, testStart - purge));
  const testSamples = samples.slice(testStart);
  const validationWeights = trainLinear(trainSamples.length >= 20 ? trainSamples : samples, 18);
  const finalWeightsForValidation = trainLinear((trainSamples.length >= 20 ? trainSamples : samples).map((sample) => ({ ...sample, y: sample.finalY })), 18);
  const maxWeightsForValidation = trainLinear((trainSamples.length >= 20 ? trainSamples : samples).map((sample) => ({ ...sample, y: sample.maxY })), 18);
  const validationRows = testSamples.length >= 8 ? testSamples : samples;
  const validationPredictions = validationRows.map((sample) => dot(validationWeights, sample.x) * 10);
  const validationActuals = validationRows.map((sample) => sample.y * 10);
  const validationFinalPredictions = validationRows.map((sample) => dot(finalWeightsForValidation, sample.x) * 10);
  const validationFinalActuals = validationRows.map((sample) => sample.finalY * 10);
  const validationMaxPredictions = validationRows.map((sample) => Math.max(0, dot(maxWeightsForValidation, sample.x) * 10));
  const validationMaxActuals = validationRows.map((sample) => Math.max(0, sample.maxY * 10));
  const mae = validationPredictions.reduce((sum, prediction, index) => sum + Math.abs(prediction - validationActuals[index]), 0) / validationPredictions.length;
  const finalReturnMae = validationFinalPredictions.reduce((sum, prediction, index) => sum + Math.abs(prediction - validationFinalActuals[index]), 0) / validationFinalPredictions.length;
  const maxUpsideMae = validationMaxPredictions.reduce((sum, prediction, index) => sum + Math.abs(prediction - validationMaxActuals[index]), 0) / validationMaxPredictions.length;
  const directionalAccuracy = validationPredictions.filter((prediction, index) => Math.sign(prediction) === Math.sign(validationActuals[index])).length / validationPredictions.length * 100;
  const positiveThreshold = Math.max(0.7, targetUpside * 0.35);
  const targetHitAccuracy = validationPredictions.filter((prediction, index) => (prediction >= positiveThreshold) === Boolean(validationRows[index].targetWins)).length / validationPredictions.length * 100;
  const finalReturnHitAccuracy = validationFinalPredictions.filter((prediction, index) => {
    const expectedMove = Math.abs(prediction);
    if (expectedMove < 0.25) return Math.sign(prediction) === Math.sign(validationFinalActuals[index]);
    return prediction >= 0
      ? validationFinalActuals[index] >= expectedMove * 0.82
      : validationFinalActuals[index] <= -expectedMove * 0.82;
  }).length / validationFinalPredictions.length * 100;
  const maxUpsideHitAccuracy = validationMaxPredictions.filter((prediction, index) => {
    const targetMove = Math.max(0.25, prediction * 0.82);
    return validationMaxActuals[index] >= targetMove;
  }).length / validationMaxPredictions.length * 100;
  const absoluteErrors = validationPredictions.map((prediction, index) => Math.abs(prediction - validationActuals[index])).sort((a, b) => a - b);
  const quantile = (q) => absoluteErrors[Math.min(absoluteErrors.length - 1, Math.max(0, Math.floor((absoluteErrors.length - 1) * q)))] || mae;
  const p80Error = quantile(0.8);
  const p90Error = quantile(0.9);
  const weights = trainLinear(samples, 22);
  const finalWeights = trainLinear(samples.map((sample) => ({ ...sample, y: sample.finalY })), 22);
  const maxWeights = trainLinear(samples.map((sample) => ({ ...sample, y: sample.maxY })), 22);
  const currentVector = vectorFor(rows.length - 1);
  const predictedReturn = dot(finalWeights.length ? finalWeights : weights, currentVector) * 10;
  const predictedRiskAdjustedReturn = dot(weights, currentVector) * 10;
  const predictedMaxUpside = Math.max(0, dot(maxWeights.length ? maxWeights : weights, currentVector) * 10);
  const distanceRows = samples.map((sample) => ({
    distance: Math.sqrt(sample.x.reduce((sum, value, index) => sum + (value - currentVector[index]) ** 2, 0) / sample.x.length),
    targetWins: sample.targetWins,
    forwardReturn: sample.forwardReturn,
    maxUpside: sample.maxUpside,
  })).sort((a, b) => a.distance - b.distance).slice(0, 24);
  const distanceWeightSum = distanceRows.reduce((sum, row) => sum + 1 / Math.max(0.08, row.distance), 0) || 1;
  const metaLabelProbability = distanceRows.reduce((sum, row) => sum + (row.targetWins ? 1 : 0) / Math.max(0.08, row.distance), 0) / distanceWeightSum * 100;
  const metaDirectionalProbability = distanceRows.reduce((sum, row) => sum + ((predictedReturn >= 0 ? row.forwardReturn >= 0 : row.forwardReturn < 0) ? 1 : 0) / Math.max(0.08, row.distance), 0) / distanceWeightSum * 100;
  const metaMaxUpsideProbability = distanceRows.reduce((sum, row) => sum + ((Math.max(0, row.maxUpside) >= Math.max(0.25, predictedMaxUpside * 0.82)) ? 1 : 0) / Math.max(0.08, row.distance), 0) / distanceWeightSum * 100;
  const sampleBonus = clamp(Math.log10(samples.length) * 5, 0, 14);
  const uncertaintyPenalty = clamp(p80Error * 0.9 + Math.max(0, p90Error - Math.abs(predictedReturn)) * 0.35, 0, 18);
  const confidence = clamp(30 + directionalAccuracy * 0.34 + metaDirectionalProbability * 0.18 + targetHitAccuracy * 0.08 + Math.min(8, Math.abs(predictedReturn) * 0.75) - mae * 1.25 - uncertaintyPenalty * 0.35 + sampleBonus, 0, 95);
  const result = {
    sampleCount: samples.length,
    oosSampleCount: validationRows.length,
    predictedReturn,
    predictedRiskAdjustedReturn,
    predictedMaxUpside,
    confidence,
    mae,
    finalReturnMae,
    maxUpsideMae,
    directionalAccuracy,
    targetHitAccuracy,
    finalReturnHitAccuracy,
    maxUpsideHitAccuracy,
    oosDirectionalAccuracy: directionalAccuracy,
    oosTargetHitAccuracy: targetHitAccuracy,
    oosFinalReturnHitAccuracy: finalReturnHitAccuracy,
    oosMaxUpsideHitAccuracy: maxUpsideHitAccuracy,
    metaLabelProbability,
    metaDirectionalProbability,
    metaMaxUpsideProbability,
    conformalP80Error: p80Error,
    conformalP90Error: p90Error,
    predictionInterval: {
      low80: predictedReturn - p80Error,
      high80: predictedReturn + p80Error,
      low90: predictedReturn - p90Error,
      high90: predictedReturn + p90Error,
    },
  };
  state.forecastCache.set(cacheKey, result);
  if (state.forecastCache.size > 80) state.forecastCache.delete(state.forecastCache.keys().next().value);
  return result;
}

function formatMoney(value) {
  const config = activeMarketConfig();
  return Number(value || 0).toLocaleString(config.locale, { style: "currency", currency: config.currency, maximumFractionDigits: 2 });
}

function formatIndexValue(row) {
  if (!row?.close) return "待刷新";
  if (row.unit === "points" || row.note === "官方指数" || String(row.displaySymbol || row.symbol || "").startsWith("^")) {
    return `${Number(row.close || 0).toLocaleString(activeMarketConfig().locale, { maximumFractionDigits: 2 })} 点`;
  }
  return formatMoney(row.close);
}

function formatPct(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCompactNumber(value, maximumFractionDigits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(activeMarketConfig().locale, {
    notation: Math.abs(number) >= 1000000 ? "compact" : "standard",
    maximumFractionDigits,
  });
}

function localBackendOfflineMessage(url = "") {
  return `本地后端未连接：${url || "API"}。请确认 8787 服务正在运行，然后刷新页面。`;
}

function normalizeApiErrorMessage(message, url = "", options = {}) {
  const text = String(message || "读取失败");
  if (options.network) return localBackendOfflineMessage(url);
  if (/quota has been exceeded|quota exceeded|The quota has been exceeded/i.test(text)) {
    return "外部数据源额度已用尽；已优先保留本地真实快照/缓存，稍后或更换数据源后再刷新。";
  }
  if (/Load failed|Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) {
    return `真实数据源请求失败：${text}`;
  }
  return text;
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(normalizeApiErrorMessage(error.message || error, url, { network: true }));
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(normalizeApiErrorMessage(payload.error || `请求失败：${response.status}`, url));
  return payload;
}

function normalizeResearchConfig(config = {}, market = state.market) {
  const key = safeMarket(config.market || market);
  const factorConfig = config.factorConfig && typeof config.factorConfig === "object" && !Array.isArray(config.factorConfig)
    ? config.factorConfig
    : {};
  return {
    market: key,
    factorConfig,
    strategyRevisions: Array.isArray(config.strategyRevisions) ? config.strategyRevisions.slice(-100) : [],
    updatedAt: config.updatedAt || null,
  };
}

function researchConfigForMarket(market = state.market) {
  const key = safeMarket(market);
  const config = normalizeResearchConfig(state.researchConfigByMarket[key] || {}, key);
  state.researchConfigByMarket[key] = config;
  return config;
}

function saveResearchConfigLocal(config = researchConfigForMarket()) {
  const normalized = normalizeResearchConfig(config, config.market || state.market);
  state.researchConfigByMarket[normalized.market] = normalized;
  safeStorage.setItem("researchConfigByMarket", JSON.stringify(state.researchConfigByMarket));
  return normalized;
}

async function persistResearchConfig(config = researchConfigForMarket()) {
  const normalized = saveResearchConfigLocal({ ...config, updatedAt: new Date().toISOString() });
  try {
    const saved = await requestJson(`/api/research-config?market=${encodeURIComponent(normalized.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(normalized),
    });
    saveResearchConfigLocal(saved);
    return true;
  } catch (error) {
    console.warn("Research config persisted locally but server persistence failed", error);
    return false;
  }
}

async function loadResearchConfig() {
  const local = researchConfigForMarket();
  try {
    const remote = await requestJson(`/api/research-config?market=${encodeURIComponent(state.market)}`);
    const remoteTime = new Date(remote.updatedAt || 0).getTime();
    const localTime = new Date(local.updatedAt || 0).getTime();
    saveResearchConfigLocal(remoteTime >= localTime ? remote : local);
  } catch (error) {
    console.warn("Using local research config", error);
  }
  renderFactorConfigPanel();
  renderStrategyRevisionPanel();
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function modelChangeLogForMarket(market = state.market) {
  const key = safeMarket(market);
  const rows = Array.isArray(state.modelChangeLogByMarket[key]) ? state.modelChangeLogByMarket[key] : [];
  state.modelChangeLogByMarket[key] = rows;
  return rows;
}

function saveModelChangeLog() {
  safeStorage.setItem("modelChangeLogByMarket", JSON.stringify(state.modelChangeLogByMarket));
}

function modelChangeLogEventToRow(event) {
  const row = event?.payload && typeof event.payload === "object" ? event.payload : null;
  if (!row?.id || !row?.createdAt) return null;
  return {
    ...row,
    market: safeMarket(row.market || event.market || state.market),
  };
}

function mergeModelChangeLogRows(...groups) {
  const byId = new Map();
  groups.flat().filter(Boolean).forEach((row) => {
    if (!row?.id) return;
    byId.set(row.id, row);
  });
  return [...byId.values()]
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
    .slice(0, MODEL_CHANGE_LOG_LIMIT);
}

async function persistModelChangeLogEvent(row) {
  try {
    await requestJson(`/api/events?market=${encodeURIComponent(row.market || state.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_type: "model-change-log",
        entity_id: row.id,
        payload: row,
      }),
    });
  } catch (error) {
    console.warn("Model change log persisted locally; server event log unavailable", error);
  }
}

async function recordModelChangeLogClear() {
  try {
    await requestJson(`/api/events?market=${encodeURIComponent(state.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_type: "model-change-log-clear",
        entity_id: `${state.market}:${Date.now()}`,
        payload: { market: state.market, clearedAt: new Date().toISOString() },
      }),
    });
  } catch (error) {
    console.warn("Model change log clear marker kept locally only", error);
  }
}

async function loadModelChangeLogsFromServer() {
  const payload = await requestJson(`/api/events?market=${encodeURIComponent(state.market)}&limit=500`);
  const events = Array.isArray(payload.events) ? payload.events : [];
  const clearTimes = events
    .filter((event) => event.event_type === "model-change-log-clear")
    .map((event) => new Date(event.payload?.clearedAt || event.created_at || 0).getTime())
    .filter(Number.isFinite);
  const lastClearAt = clearTimes.length ? Math.max(...clearTimes) : 0;
  return events
    .filter((event) => event.event_type === "model-change-log")
    .map(modelChangeLogEventToRow)
    .filter((row) => row && new Date(row.createdAt || 0).getTime() > lastClearAt);
}

function strategySnapshot(strategy = getStrategy()) {
  return {
    horizonDays: Number(strategy.horizonDays || 0),
    confidence: Number(strategy.confidence || 0),
    targetUpside: Number(strategy.targetUpside || 0),
    maxPosition: Number(strategy.maxPosition || 0),
    reserveCashPct: Number(strategy.reserveCashPct || 0),
    stopLoss: Number(strategy.stopLoss || 0),
    text: String(strategy.text || "").trim(),
  };
}

function strategyChanged(before, after) {
  const left = strategySnapshot(before || {});
  const right = strategySnapshot(after || {});
  return JSON.stringify(left) !== JSON.stringify(right);
}

function factorConfigChangeDetails(previous = {}, next = {}) {
  const names = [...new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])].sort();
  const changes = names.map((name) => {
    const before = previous?.[name] || {};
    const after = next?.[name] || {};
    const beforeEnabled = before.enabled !== false && Number(before.weightPct || 0) > 0;
    const afterEnabled = after.enabled !== false && Number(after.weightPct || 0) > 0;
    const beforeWeight = Number(before.weightPct || 0);
    const afterWeight = Number(after.weightPct || 0);
    if (beforeEnabled === afterEnabled && Math.abs(beforeWeight - afterWeight) < 0.05) return null;
    return {
      name,
      beforeEnabled,
      afterEnabled,
      beforeWeightPct: Number(beforeWeight.toFixed(2)),
      afterWeightPct: Number(afterWeight.toFixed(2)),
      deltaWeightPct: Number((afterWeight - beforeWeight).toFixed(2)),
    };
  }).filter(Boolean);
  const enabledRows = Object.entries(next || {}).filter(([, row]) => row.enabled !== false && Number(row.weightPct || 0) > 0);
  const weights = enabledRows.map(([, row]) => Number(row.weightPct || 0));
  return {
    changes,
    changedCount: changes.length,
    enabledCount: enabledRows.length,
    maxWeightPct: weights.length ? Number(Math.max(...weights).toFixed(2)) : 0,
    concentration: weights.length ? Number(weights.reduce((sum, weight) => sum + (weight / 100) ** 2, 0).toFixed(4)) : 0,
  };
}

function agentModelSummary(ledger = getAgentLedger()) {
  const agents = Array.isArray(ledger?.agents) ? ledger.agents : [];
  return {
    agentCount: agents.length,
    strategyCount: agents.reduce((sum, agent) => sum + Object.keys(agent.strategyBook || {}).length, 0),
    bestStrategies: agents.map((agent) => {
      const best = bestStrategyForAgent(agent);
      return {
        id: agent.id,
        name: agent.name,
        bestStrategyId: best?.id || agent.bestStrategyId || "",
        bestStrategyName: best?.name || "",
        trades: Number(best?.trades || 0),
        score: Number(best?.score || 0),
        aggressiveness: Number(agent.learning?.aggressiveness || 1),
        confidenceBias: Number(agent.learning?.confidenceBias || 0),
      };
    }),
  };
}

function modelOverfitGuardForEvent(event) {
  const checks = [
    { label: "时间隔离", pass: true, note: "日志只记录修改轨迹；预测模型仍需按时间顺序做样本外验证。" },
    { label: "不自动拔高置信", pass: true, note: "本次修改不会把训练收益直接写成实盘置信率。" },
    { label: "可回滚", pass: true, note: "保留修改前后快照，后续可按日志复盘和回滚配置。" },
  ];
  let risk = "low";
  const details = event.details || {};

  if (event.type === "factor-config") {
    if (Number(details.enabledCount || 0) < 3) {
      risk = "medium";
      checks.push({ label: "因子丰富度", pass: false, note: "启用因子少于 3 个，容易把单一噪声当信号。" });
    } else {
      checks.push({ label: "因子丰富度", pass: true, note: `${details.enabledCount} 个启用因子进入组合。` });
    }
    if (Number(details.maxWeightPct || 0) > 45) {
      risk = "medium";
      checks.push({ label: "权重集中度", pass: false, note: `最大单因子权重 ${details.maxWeightPct}% 偏高，建议用样本外验证约束。` });
    } else {
      checks.push({ label: "权重集中度", pass: true, note: `最大单因子权重 ${details.maxWeightPct || 0}%。` });
    }
    const validationReady = state.latestFactorLab?.validation?.status === "ready";
    checks.push({
      label: "样本外验证",
      pass: validationReady,
      note: validationReady ? "当前因子实验室已有 purged walk-forward 验证结果。" : "尚未检测到本轮因子实验结果，保存后应重新跑样本外验证。",
    });
    if (!validationReady && risk === "low") risk = "medium";
  }

  if (event.type === "strategy") {
    const after = strategySnapshot(event.after?.strategy || event.after || {});
    if (after.confidence < 60 || after.targetUpside > 12 || after.stopLoss > 9) {
      risk = "medium";
      checks.push({ label: "策略边界", pass: false, note: "置信门槛偏低、目标涨幅偏高或止损过宽，需防止样本内参数迎合。" });
    } else {
      checks.push({ label: "策略边界", pass: true, note: "周期、置信、目标和止损仍在相对保守区间。" });
    }
  }

  if (event.type?.startsWith("agent")) {
    const sampleCount = Number(details.sampleCount || details.rowsUsed || 0);
    if (sampleCount && sampleCount < 8) {
      risk = "medium";
      checks.push({ label: "训练样本", pass: false, note: `本次仅使用 ${sampleCount} 个样本，暂不应提升模型权重。` });
    } else {
      checks.push({ label: "训练样本", pass: true, note: sampleCount ? `本次使用 ${sampleCount} 个样本/标的做重放。` : "本次为配置或归档变更，不直接训练新权重。" });
    }
    checks.push({ label: "纸面交易隔离", pass: true, note: "Agent 学习只影响本地模拟和辅助偏置，不触发真实交易。" });
  }

  return {
    risk,
    checks,
    summary: risk === "low" ? "防过拟合检查通过；仍需等待后续样本外表现确认。" : "存在过拟合风险提示；建议降低权重或重新跑 walk-forward 验证。",
  };
}

function appendModelChangeLog(event) {
  const key = safeMarket(event.market || state.market);
  const row = {
    id: `${key}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    market: key,
    createdAt: new Date().toISOString(),
    actor: "local-user",
    type: event.type || "model",
    title: event.title || "模型修改",
    summary: event.summary || "",
    before: clonePlain(event.before || null),
    after: clonePlain(event.after || null),
    details: clonePlain(event.details || {}),
  };
  row.overfitGuard = modelOverfitGuardForEvent(row);
  const rows = modelChangeLogForMarket(key);
  rows.unshift(row);
  state.modelChangeLogByMarket[key] = rows.slice(0, MODEL_CHANGE_LOG_LIMIT);
  saveModelChangeLog();
  persistModelChangeLogEvent(row);
  return row;
}

function modelLogTypeLabel(type) {
  const labels = {
    "factor-config": "因子配置",
    strategy: "策略参数",
    "strategy-revision": "策略版本",
    "agent-capital": "Agent 本金",
    "agent-reset": "Agent 归档",
    "agent-replay": "Agent 重放训练",
    "agent-auto-training": "Agent 自动学习",
    "agent-transfer": "跨市场迁移",
  };
  return labels[type] || type || "模型";
}

function modelChangeLogCard(row) {
  const guard = row.overfitGuard || {};
  const checks = Array.isArray(guard.checks) ? guard.checks : [];
  return `
    <article class="model-log-row ${guard.risk === "medium" ? "warn" : "good"}">
      <div class="model-log-main">
        <div>
          <strong>${escapeHtml(row.title || modelLogTypeLabel(row.type))}</strong>
          <span>${escapeHtml(modelLogTypeLabel(row.type))} · ${new Date(row.createdAt).toLocaleString()} · ${escapeHtml(row.market || state.market)}</span>
        </div>
        <span class="tag ${guard.risk === "medium" ? "warn" : "good"}">${guard.risk === "medium" ? "需复核" : "低过拟合风险"}</span>
      </div>
      ${row.summary ? `<p>${escapeHtml(row.summary)}</p>` : ""}
      <div class="model-log-checks">
        ${checks.map((check) => `<span class="${check.pass ? "good" : "warn"}"><b>${escapeHtml(check.label)}</b>${escapeHtml(check.note || "")}</span>`).join("")}
      </div>
      <details>
        <summary>查看修改前后快照</summary>
        <pre>${escapeHtml(JSON.stringify({ before: row.before, after: row.after, details: row.details }, null, 2))}</pre>
      </details>
    </article>
  `;
}

function modelChangeLogListHtml(rows) {
  return rows.length
    ? rows.map(modelChangeLogCard).join("")
    : `<p class="muted">还没有模型修改日志。保存因子配置、记录策略版本、训练或重置 Agent 后会自动写入。</p>`;
}

function renderModelChangeLogModal(modal, rows, status = "") {
  const subtitle = modal.querySelector("[data-model-log-subtitle]");
  const list = modal.querySelector("[data-model-log-list]");
  const clearButton = modal.querySelector("#clearModelChangeLog");
  if (subtitle) subtitle.textContent = `本地/服务器事件库 · ${activeMarketConfig().label} ${rows.length} 条 · 每条都附带防过拟合检查${status ? ` · ${status}` : ""}`;
  if (list) list.innerHTML = modelChangeLogListHtml(rows);
  if (clearButton) clearButton.disabled = rows.length === 0;
}

async function refreshModelChangeLogModal(modal) {
  try {
    const serverRows = await loadModelChangeLogsFromServer();
    const merged = mergeModelChangeLogRows(modelChangeLogForMarket(), serverRows);
    state.modelChangeLogByMarket[state.market] = merged;
    saveModelChangeLog();
    renderModelChangeLogModal(modal, merged, "已同步");
  } catch (error) {
    renderModelChangeLogModal(modal, modelChangeLogForMarket(), "服务器事件库暂不可用，显示本地日志");
  }
}

function openModelChangeLogModal() {
  const rows = modelChangeLogForMarket();
  const modal = document.createElement("div");
  modal.className = "chart-modal model-log-modal";
  modal.innerHTML = `
    <div class="chart-modal-panel model-log-panel">
      <div class="chart-modal-head">
        <div>
          <h3>模型修改动线</h3>
          <p class="muted" data-model-log-subtitle>正在读取本地服务器事件库...</p>
        </div>
        <div class="model-log-actions">
          <button id="clearModelChangeLog" class="danger-soft" type="button" ${rows.length ? "" : "disabled"}>清空日志</button>
          <button id="closeModelChangeLog" class="secondary" type="button">关闭</button>
        </div>
      </div>
      <div class="model-log-list" data-model-log-list>
        ${modelChangeLogListHtml(rows)}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderModelChangeLogModal(modal, rows, "同步中");
  refreshModelChangeLogModal(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("#closeModelChangeLog")?.addEventListener("click", close);
  modal.querySelector("#clearModelChangeLog")?.addEventListener("click", () => {
    state.modelChangeLogByMarket[state.market] = [];
    saveModelChangeLog();
    recordModelChangeLogClear();
    renderModelChangeLogModal(modal, [], "已清空");
    setStatus(`${activeMarketConfig().label} 模型修改日志已清空`);
  });
}

function activeLabSymbol(inputId) {
  const input = $(inputId);
  const raw = input?.value || state.selected || state.watchlist[0] || activeMarketConfig().defaultSymbols[0] || "";
  const symbol = normalizeSymbol(raw);
  if (!symbol) throw new Error(`请输入有效的${activeMarketConfig().label}股票代码`);
  if (input) input.value = symbol;
  return symbol;
}

const FEATURE_METRICS = [
  ["vwap", "VWAP", "#22d3ee"],
  ["volume_ratio", "量比", "#f59e0b"],
  ["return_pct", "涨跌", "#f97316"],
  ["imbalance_proxy", "失衡", "#e879f9"],
  ["active_buy_notional", "买入额", "#22c55e"],
  ["active_sell_notional", "卖出额", "#fb7185"],
  ["close_location", "收盘位置", "#a78bfa"],
  ["notional", "成交额", "#60a5fa"],
];

function selectedFeatureMetrics() {
  const saved = Array.isArray(state.featureChart?.metrics) ? state.featureChart.metrics : [];
  const allowed = new Set(FEATURE_METRICS.map(([key]) => key));
  const selected = saved.filter((key) => allowed.has(key));
  return selected.length ? selected : ["vwap", "volume_ratio", "imbalance_proxy"];
}

function featureMetricButtons() {
  const selected = new Set(selectedFeatureMetrics());
  return FEATURE_METRICS.map(([key, label]) => (
    `<button class="overlay-btn ${selected.has(key) ? "active" : ""}" data-feature-metric="${key}" type="button">${label}</button>`
  )).join("");
}

function saveFeatureChartState() {
  safeStorage.setItem("featureChart", JSON.stringify(state.featureChart || {}));
}

const FEATURE_SIDE_LABELS = {
  active_buy: { label: "主动买入", className: "buy", description: "买方主动攻击盘口" },
  active_sell: { label: "主动卖出", className: "sell", description: "卖方主动攻击盘口" },
  passive_buy: { label: "被动买入", className: "passive-buy", description: "买方挂单承接卖压" },
  passive_sell: { label: "被动卖出", className: "passive-sell", description: "卖方挂单压制买盘" },
  neutral: { label: "中性/不确定", className: "neutral", description: "方向证据不足" },
};

function featureSideLabelMeta(label) {
  return FEATURE_SIDE_LABELS[label] || FEATURE_SIDE_LABELS.neutral;
}

function featureSideCorrectionKey(result = state.latestFeatureAnalysis) {
  const market = safeMarket(result?.market || state.market);
  const symbol = normalizeSymbol(result?.symbol || state.selected || activeMarketConfig().defaultSymbols[0] || "");
  const interval = String(result?.interval || $("featureInterval")?.value || "1d").replace(/[^a-z0-9_-]/gi, "");
  return `featureSideCorrections:${market}:${symbol}:${interval}`;
}

function readFeatureSideCorrections(result = state.latestFeatureAnalysis) {
  return readJsonStorage(featureSideCorrectionKey(result), {});
}

function writeFeatureSideCorrections(result, corrections) {
  const key = featureSideCorrectionKey(result);
  const clean = Object.fromEntries(
    Object.entries(corrections || {}).filter(([, value]) => value?.label && FEATURE_SIDE_LABELS[value.label])
  );
  if (Object.keys(clean).length) safeStorage.setItem(key, JSON.stringify(clean));
  else safeStorage.removeItem(key);
}

function featureSideRowKey(row) {
  return String(row?.date || row?.timestamp || row?.index || "");
}

function inferFeatureSideLabel(row, quality = {}) {
  const buy = Math.max(0, asNumber(row?.active_buy_notional, 0));
  const sell = Math.max(0, asNumber(row?.active_sell_notional, 0));
  const total = Math.max(1, buy + sell);
  const imbalance = Number.isFinite(Number(row?.imbalance_proxy))
    ? Number(row.imbalance_proxy)
    : clamp((buy - sell) / total, -1, 1);
  const open = asPositiveNumber(row?.open, asPositiveNumber(row?.close, 0));
  const close = asPositiveNumber(row?.close, open);
  const returnPct = Number.isFinite(Number(row?.return_pct)) ? Number(row.return_pct) : pctChange(close, open);
  const closeLocation = asNumber(row?.close_location, 0);
  const volumeRatio = Math.max(0, asNumber(row?.volume_ratio, 1));
  const method = String(row?.orderflow_side_method || "").toLowerCase();
  const reportedSide = quality.proxy_only === false || method.includes("tick") || method.includes("reported");
  const pressure = Math.abs(imbalance);
  let label = "neutral";
  let reason = "买卖差额与价格位置都不够明确。";

  if (imbalance <= -0.12 && (returnPct > 0.05 || closeLocation > 0.35)) {
    label = "passive_buy";
    reason = "卖压占优但价格收稳，疑似买方挂单承接。";
  } else if (imbalance >= 0.12 && (returnPct < -0.05 || closeLocation < -0.35)) {
    label = "passive_sell";
    reason = "买盘占优但价格走弱，疑似卖方挂单压制。";
  } else if (imbalance >= 0.14 && returnPct >= -0.25) {
    label = "active_buy";
    reason = "主动买入额占优，价格未明显回落。";
  } else if (imbalance <= -0.14 && returnPct <= 0.25) {
    label = "active_sell";
    reason = "主动卖出额占优，价格未明显反弹。";
  }

  const evidenceBoost = Math.min(0.22, pressure * 0.28)
    + Math.min(0.08, Math.max(0, volumeRatio - 1) * 0.035)
    + Math.min(0.08, Math.abs(returnPct) / 80);
  const base = reportedSide ? 0.66 : 0.48;
  const passivePenalty = label.startsWith("passive") ? 0.05 : 0;
  const neutralPenalty = label === "neutral" ? 0.16 : 0;
  const confidence = clamp(base + evidenceBoost - passivePenalty - neutralPenalty, 0.22, reportedSide ? 0.9 : 0.76);
  return {
    label,
    confidence,
    reason,
    source: reportedSide ? "AI/逐笔规则预打标" : "AI/OHLCV规则预打标",
  };
}

function featureRowsWithSideLabels(result, sourceRows = result?.data_log) {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const corrections = readFeatureSideCorrections(result);
  return rows.map((row) => {
    const rowKey = featureSideRowKey(row);
    const auto = inferFeatureSideLabel(row, result?.quality || {});
    const correction = corrections[rowKey];
    const manualLabel = correction?.label && FEATURE_SIDE_LABELS[correction.label] ? correction.label : null;
    const finalLabel = manualLabel || auto.label;
    return {
      ...row,
      side_row_key: rowKey,
      auto_side_label: auto.label,
      final_side_label: finalLabel,
      side_label_confidence: auto.confidence,
      side_label_reason: manualLabel
        ? `人工修正；原始${auto.source}为${featureSideLabelMeta(auto.label).label}。`
        : auto.reason,
      side_label_source: manualLabel ? "manual" : "auto",
      side_label_source_label: manualLabel ? "人工修正" : auto.source,
      side_label_updated_at: correction?.updatedAt || null,
    };
  });
}

function featureSideLabelSelect(row) {
  const selected = row.side_label_source === "manual" ? row.final_side_label : "auto";
  const autoLabel = featureSideLabelMeta(row.auto_side_label).label;
  const option = (value, label) => `<option value="${value}" ${selected === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  return `
    <select class="side-label-select" data-feature-side-label data-row-key="${escapeHtml(row.side_row_key || "")}">
      ${option("auto", `自动 · ${autoLabel}`)}
      ${Object.entries(FEATURE_SIDE_LABELS).map(([value, meta]) => option(value, meta.label)).join("")}
    </select>
  `;
}

function featureSideLabelBadge(row) {
  const meta = featureSideLabelMeta(row.final_side_label);
  return `
    <span class="side-label-badge ${meta.className}">${escapeHtml(meta.label)}</span>
    <small class="side-label-source ${row.side_label_source === "manual" ? "manual" : ""}">${escapeHtml(row.side_label_source_label)}</small>
  `;
}

function bindFeatureSideLabelControls(result) {
  const panel = $("featureAnalysisPanel");
  if (!panel) return;
  panel.querySelectorAll("[data-feature-side-label]").forEach((select) => {
    select.addEventListener("change", () => {
      const rowKey = select.dataset.rowKey || "";
      const corrections = readFeatureSideCorrections(result);
      if (select.value === "auto") {
        delete corrections[rowKey];
      } else {
        corrections[rowKey] = { label: select.value, updatedAt: new Date().toISOString() };
      }
      writeFeatureSideCorrections(result, corrections);
      renderFeatureAnalysis(result);
      setStatus(`${result?.symbol || "股票"} 成交方向标签已保存`);
    });
  });
  const clearButton = panel.querySelector("[data-clear-feature-side-labels]");
  if (clearButton) {
    clearButton.addEventListener("click", () => {
      writeFeatureSideCorrections(result, {});
      renderFeatureAnalysis(result);
      setStatus(`${result?.symbol || "股票"} 的人工成交方向标签已清空`);
    });
  }
}

function visibleFeatureRows(sourceRows) {
  const source = Array.isArray(sourceRows) ? sourceRows : [];
  const baseCount = source.length;
  const maxZoom = Math.max(1, baseCount / 24);
  const zoom = clamp(Number(state.featureChart?.zoom || 1), 1, maxZoom);
  state.featureChart.zoom = zoom;
  const visibleCount = Math.max(12, Math.min(baseCount, Math.round(baseCount / zoom)));
  const maxOffset = Math.max(0, baseCount - visibleCount);
  state.featureChart.offset = clamp(Math.round(Number(state.featureChart?.offset || 0)), 0, maxOffset);
  const end = source.length - state.featureChart.offset;
  const start = Math.max(0, end - visibleCount);
  return {
    rows: source.slice(start, end),
    start,
    end,
    visibleCount,
    maxOffset,
    zoom,
  };
}

function drawFeatureLine(ctx, rows, key, bounds, width, height, color, options = {}) {
  const values = rows.map((row) => Number(row[key]));
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return;
  const localBounds = bounds || chartBounds(finite, 0.08);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = options.width || 1.7;
  if (options.dash) ctx.setLineDash(options.dash);
  ctx.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const x = xFor(index, values.length, width);
    const y = yFor(value, localBounds.min, localBounds.max, height);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.restore();
}

function featureOrderflowCandles(result) {
  const rows = featureRowsWithSideLabels(result);
  return rows.map((row) => {
    const close = asPositiveNumber(row?.close);
    if (!row?.date || !Number.isFinite(close)) return null;
    const open = asPositiveNumber(row?.open, close);
    const high = Math.max(asPositiveNumber(row?.high, close), open, close);
    const low = Math.min(asPositiveNumber(row?.low, close), open, close);
    return {
      date: String(row.date),
      open,
      high,
      low,
      close,
      volume: Math.max(0, asNumber(row.volume, 0)),
      buyVolume: Math.max(0, asNumber(row.active_buy_notional, 0)),
      sellVolume: Math.max(0, asNumber(row.active_sell_notional, 0)),
      buyTrades: Math.max(0, asNumber(row.active_buy_count, 0)),
      sellTrades: Math.max(0, asNumber(row.active_sell_count, 0)),
      tradeCount: Math.max(0, asNumber(row.trade_count, 0)),
      priceLevels: Array.isArray(row.price_levels)
        ? row.price_levels
        : Array.isArray(row.priceLevels)
          ? row.priceLevels
          : [],
      orderflowSource: row.orderflow_source || row.source || "feature-data-log",
      proxy: result?.quality?.proxy_only !== false,
      finalSideLabel: row.final_side_label,
      autoSideLabel: row.auto_side_label,
      sideLabelSource: row.side_label_source,
      sideLabelConfidence: row.side_label_confidence,
    };
  }).filter(Boolean);
}

function drawFeatureOrderflowChart(result) {
  const canvas = $("featureOrderflowChart");
  if (!canvas || !result) return;
  const source = featureOrderflowCandles(result);
  if (!source.length) {
    drawLoading(canvas, "暂无订单流序列");
    return;
  }
  state.featureChart = state.featureChart || {};
  const view = visibleFeatureRows(source);
  const rows = view.rows;
  if (!rows.length) {
    drawLoading(canvas, "暂无可视订单流窗口");
    return;
  }
  const chart = setupCanvas(canvas);
  drawGrid(chart.ctx, chart.width, chart.height);
  const bounds = chartBounds(rows.flatMap((row) => [row.high, row.low]), 0.1);
  drawAxis(chart.ctx, bounds, chart.width, chart.height, (value) => value.toFixed(2));
  const plotWidth = chart.width - 62;
  const candleWidth = Math.max(4, Math.min(18, plotWidth / rows.length * 0.58));
  const flows = rows.map((row) => ({
    buyVolume: row.buyVolume,
    sellVolume: row.sellVolume,
    buyTrades: row.buyTrades,
    sellTrades: row.sellTrades,
    delta: row.buyVolume - row.sellVolume,
    proxy: row.proxy || !(row.priceLevels && row.priceLevels.length),
    hasRealVolume: result?.quality?.proxy_only === false,
    hasRealTrades: result?.quality?.proxy_only === false,
    hasReportedLevels: Array.isArray(row.priceLevels) && row.priceLevels.length > 0,
    source: row.orderflowSource,
  }));
  const ladders = rows.map((row, index) => priceLevelFlowRows(row, flows[index], 9, { allowProxy: true }));
  const hasReportedLevels = ladders.some((levels) => levels.some((level) => !level.proxy));
  const maxLevelFlow = Math.max(1, ...ladders.flatMap((levels) => levels.flatMap((level) => [level.buyVolume, level.sellVolume])));

  rows.forEach((row, index) => {
    const x = xFor(index, rows.length, chart.width);
    const yHigh = yFor(row.high, bounds.min, bounds.max, chart.height);
    const yLow = yFor(row.low, bounds.min, bounds.max, chart.height);
    const yOpen = yFor(row.open, bounds.min, bounds.max, chart.height);
    const yClose = yFor(row.close, bounds.min, bounds.max, chart.height);
    const up = row.close >= row.open;
    chart.ctx.strokeStyle = up ? "rgba(67, 224, 138, 0.72)" : "rgba(255, 101, 125, 0.72)";
    chart.ctx.fillStyle = up ? "rgba(67, 224, 138, 0.3)" : "rgba(255, 101, 125, 0.3)";
    chart.ctx.beginPath();
    chart.ctx.moveTo(x, yHigh);
    chart.ctx.lineTo(x, yLow);
    chart.ctx.stroke();
    chart.ctx.fillRect(x - candleWidth / 2, Math.min(yOpen, yClose), candleWidth, Math.max(2, Math.abs(yClose - yOpen)));
  });

  ladders.forEach((levels, index) => {
    const x = xFor(index, rows.length, chart.width);
    const halfWidth = Math.max(5, Math.min(34, candleWidth * 2.8));
    levels.forEach((level) => {
      const y = yFor(level.price, bounds.min, bounds.max, chart.height);
      const buyWidth = Math.max(1, level.buyVolume / maxLevelFlow * halfWidth);
      const sellWidth = Math.max(1, level.sellVolume / maxLevelFlow * halfWidth);
      chart.ctx.fillStyle = "rgba(67, 224, 138, 0.68)";
      chart.ctx.fillRect(x - buyWidth - 1, y - 1.6, buyWidth, 3.2);
      chart.ctx.fillStyle = "rgba(255, 101, 125, 0.68)";
      chart.ctx.fillRect(x + 1, y - 1.6, sellWidth, 3.2);
      chart.ctx.fillStyle = level.buyVolume >= level.sellVolume ? "rgba(67, 224, 138, 0.9)" : "rgba(255, 101, 125, 0.9)";
      chart.ctx.beginPath();
      chart.ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      chart.ctx.fill();
    });
  });

  chart.ctx.save();
  chart.ctx.fillStyle = hasReportedLevels ? "rgba(207, 255, 226, 0.9)" : "rgba(246, 196, 83, 0.92)";
  chart.ctx.font = "11px Inter, system-ui, sans-serif";
  chart.ctx.textAlign = "left";
  chart.ctx.fillText(
    hasReportedLevels
      ? "Real tick footprint · side by tick-rule estimate"
      : "OHLCV proxy footprint: price-level rows require tick/L1/L2 provider",
    52,
    18
  );
  chart.ctx.fillStyle = "rgba(216, 231, 248, 0.86)";
  chart.ctx.fillText(`Buy left / Sell right · Zoom ${view.zoom.toFixed(2)}x`, 52, 36);
  chart.ctx.restore();
  drawTimeAxis(chart.ctx, rows, chart.width, chart.height);

  if (state.featureChartHoverIndex != null) {
    const hoverIndex = clamp(state.featureChartHoverIndex, 0, rows.length - 1);
    drawCrosshair(chart.ctx, hoverIndex, rows.length, chart.width, chart.height);
    const row = rows[hoverIndex];
    const label = featureSideLabelMeta(row.finalSideLabel).label;
    const source = row.sideLabelSource === "manual" ? "人工" : "AI";
    const readout = $("featureOrderflowReadout");
    if (readout) {
      readout.textContent = `${row.date} · ${label}(${source}) · O ${formatCompactNumber(row.open, 4)} H ${formatCompactNumber(row.high, 4)} L ${formatCompactNumber(row.low, 4)} C ${formatCompactNumber(row.close, 4)} · Buy ${formatCompactNumber(row.buyVolume, 0)} Sell ${formatCompactNumber(row.sellVolume, 0)}${hasReportedLevels ? " · real tick levels / tick-rule side" : " · proxy levels"}`;
    }
  } else {
    const readout = $("featureOrderflowReadout");
    if (readout) readout.textContent = hasReportedLevels ? "悬停查看真实逐笔聚合的价位层级；人工标签会覆盖自动预打标" : "当前为 OHLCV 代理足迹；人工标签会覆盖 AI/规则预打标";
  }
}

function renderFeatureOverlayChart(result) {
  const canvas = $("featureOverlayChart");
  if (!canvas || !result) return;
  const allRows = featureRowsWithSideLabels(result, result.data_log);
  if (!allRows.length) {
    drawLoading(canvas, "暂无全时段特征数据");
    return;
  }
  state.featureChart = state.featureChart || {};
  state.featureChart.metrics = selectedFeatureMetrics();
  const view = visibleFeatureRows(allRows);
  const rows = view.rows;
  const chart = setupCanvas(canvas);
  drawGrid(chart.ctx, chart.width, chart.height);
  const priceBounds = chartBounds(rows.map((row) => Number(row.close)), 0.08);
  drawAxis(chart.ctx, priceBounds, chart.width, chart.height, (value) => value.toFixed(2));
  drawFeatureLine(chart.ctx, rows, "close", priceBounds, chart.width, chart.height, "#f8fafc", { width: 2.2 });
  const selected = selectedFeatureMetrics();
  selected.forEach((key) => {
    const metric = FEATURE_METRICS.find(([name]) => name === key);
    if (!metric) return;
    drawFeatureLine(chart.ctx, rows, key, null, chart.width, chart.height, metric[2], { width: 1.55 });
  });
  chart.ctx.font = "11px Inter, system-ui, sans-serif";
  chart.ctx.textAlign = "left";
  chart.ctx.fillStyle = "#f8fafc";
  chart.ctx.fillText(`Price · ${formatMoney(rows.at(-1)?.close)} · Zoom ${view.zoom.toFixed(2)}x`, 52, 18);
  selected.forEach((key, index) => {
    const metric = FEATURE_METRICS.find(([name]) => name === key);
    if (!metric) return;
    chart.ctx.fillStyle = metric[2];
    chart.ctx.fillText(metric[1], 52 + (index % 5) * 86, 36 + Math.floor(index / 5) * 15);
  });
  if (state.featureChartHoverIndex != null) {
    const hoverIndex = clamp(state.featureChartHoverIndex, 0, rows.length - 1);
    drawCrosshair(chart.ctx, hoverIndex, rows.length, chart.width, chart.height);
    const row = rows[hoverIndex];
    const readout = $("featureChartReadout");
    if (readout) {
      const metrics = selected.map((key) => {
        const metric = FEATURE_METRICS.find(([name]) => name === key);
        return `${metric?.[1] || key} ${formatCompactNumber(row[key], 3)}`;
      }).join(" · ");
      readout.textContent = `${row.date} · ${featureSideLabelMeta(row.final_side_label).label}${row.side_label_source === "manual" ? "(人工)" : "(AI)"} · 收 ${formatCompactNumber(row.close, 4)} · ${metrics}`;
    }
  }
  drawFeatureOrderflowChart(result);
  const panel = $("featureAnalysisPanel");
  if (panel && !panel.dataset.featureChartBound) {
    panel.dataset.featureChartBound = "true";
    panel.querySelectorAll("[data-feature-metric]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.featureMetric;
        const selectedNow = new Set(selectedFeatureMetrics());
        if (selectedNow.has(key)) selectedNow.delete(key);
        else selectedNow.add(key);
        state.featureChart.metrics = [...selectedNow];
        saveFeatureChartState();
        panel.querySelector("#featureMetricButtons").innerHTML = featureMetricButtons();
        panel.dataset.featureChartBound = "";
        renderFeatureOverlayChart(result);
      });
    });
    [canvas, $("featureOrderflowChart")].filter(Boolean).forEach((targetCanvas) => {
      targetCanvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
        if (sideways) {
          state.featureChart.offset = Math.max(0, Number(state.featureChart.offset || 0) + Math.round(event.deltaX / WHEEL_PAN_DIVISOR));
        } else {
          const factor = event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT;
          state.featureChart.zoom = clamp(Number(state.featureChart.zoom || 1) * factor, 1, 40);
        }
        saveFeatureChartState();
        scheduleChartRedraw("feature", () => renderFeatureOverlayChart(result));
      }, { passive: false });
      targetCanvas.addEventListener("pointerdown", (event) => {
        state.featureChartDragging = { x: event.clientX, offset: Number(state.featureChart.offset || 0) };
        targetCanvas.setPointerCapture?.(event.pointerId);
      });
      targetCanvas.addEventListener("pointermove", (event) => {
        const rect = targetCanvas.getBoundingClientRect();
        const currentRows = visibleFeatureRows(allRows).rows;
        if (state.featureChartDragging) {
          const barsPerPixel = currentRows.length / Math.max(1, rect.width - 62);
          state.featureChart.offset = Math.max(0, Math.round(state.featureChartDragging.offset - (event.clientX - state.featureChartDragging.x) * barsPerPixel));
          scheduleChartRedraw("feature", () => renderFeatureOverlayChart(result));
          return;
        }
        const ratio = clamp((event.clientX - rect.left - 48) / Math.max(1, rect.width - 62), 0, 1);
        state.featureChartHoverIndex = Math.round(ratio * (currentRows.length - 1));
        scheduleChartRedraw("feature", () => renderFeatureOverlayChart(result));
      });
      targetCanvas.addEventListener("pointerup", () => {
        state.featureChartDragging = null;
        saveFeatureChartState();
      });
      targetCanvas.addEventListener("mouseleave", () => {
        state.featureChartHoverIndex = null;
        const readout = $("featureChartReadout");
        if (readout) readout.textContent = "悬停查看全时段特征值";
        const orderflowReadout = $("featureOrderflowReadout");
        if (orderflowReadout) orderflowReadout.textContent = "悬停查看每根 K 线价位买卖层级";
        scheduleChartRedraw("feature", () => renderFeatureOverlayChart(result));
      });
    });
  }
}

function volumeProfileMiniChart(buckets, profile = {}) {
  const rows = Array.isArray(buckets) ? buckets : [];
  if (!rows.length) return `<p class="muted small-text">暂无 Volume Profile。</p>`;
  const width = 420;
  const height = Math.max(180, rows.length * 11);
  const left = 70;
  const right = 18;
  const top = 12;
  const bottom = 16;
  const maxVolume = Math.max(1, ...rows.map((row) => Number(row.volume || 0)));
  const maxShare = Math.max(1, ...rows.map((row) => Number(row.share_pct || 0)));
  const yForBucket = (index) => top + (rows.length <= 1 ? 0 : index / (rows.length - 1) * (height - top - bottom));
  const xForShare = (share) => left + (Number(share || 0) / maxShare) * (width - left - right);
  const valueArea = profile.value_area || {};
  const point = profile.point_of_control || {};
  const bars = rows.map((row, index) => {
    const y = yForBucket(rows.length - index - 1);
    const inValueArea = Number(row.mid) >= Number(valueArea.low || Infinity) && Number(row.mid) <= Number(valueArea.high || -Infinity);
    const isPoc = point.mid != null && Math.abs(Number(row.mid) - Number(point.mid)) < 0.00001;
    const barWidth = Math.max(2, (Number(row.volume || 0) / maxVolume) * (width - left - right));
    const cls = isPoc ? "poc" : inValueArea ? "value-area" : "";
    return `<rect class="${cls}" x="${left}" y="${(y - 4).toFixed(2)}" width="${barWidth.toFixed(2)}" height="8" rx="2"></rect><text x="6" y="${(y + 3).toFixed(2)}">${formatCompactNumber(row.mid, 3)}</text>`;
  }).join("");
  const linePoints = rows.map((row, index) => `${xForShare(row.share_pct).toFixed(2)},${yForBucket(rows.length - index - 1).toFixed(2)}`).join(" ");
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Volume Profile">
      <line class="profile-axis" x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"></line>
      ${bars}
      <polyline class="profile-line" points="${linePoints}"></polyline>
      ${point.mid != null ? `<text class="profile-note" x="${width - 120}" y="18">POC ${formatCompactNumber(point.mid, 3)}</text>` : ""}
      ${valueArea.low != null ? `<text class="profile-note" x="${width - 160}" y="${height - 4}">VA ${formatCompactNumber(valueArea.low, 3)}-${formatCompactNumber(valueArea.high, 3)}</text>` : ""}
    </svg>
  `;
}

function setWorkspacePage(page, options = {}) {
  const validPages = new Set(["dashboard", "features", "factors", "regime", "strategy", "simulation", "sources"]);
  const next = validPages.has(page) ? page : "dashboard";
  state.activePage = next;
  safeStorage.setItem("activeQuantPage", next);
  document.querySelectorAll("[data-quant-page]").forEach((section) => {
    section.hidden = section.dataset.quantPage !== next;
  });
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pageTarget === next);
  });
  document.querySelectorAll("[data-control-page]").forEach((panel) => {
    const pages = String(panel.dataset.controlPage || "")
      .split(/\s+/)
      .filter(Boolean);
    panel.hidden = pages.length > 0 && !pages.includes(next);
  });
  if (!options.silent) {
    const labels = {
      dashboard: "监控台",
      features: "特征分析",
      factors: "因子实验室",
      regime: "市场状态",
      strategy: "策略/Agent",
      simulation: "模拟持仓",
      sources: "数据源",
    };
    setStatus(`已打开 ${activeMarketConfig().label} · ${labels[next]}`);
  }
  if (next === "sources") {
    refreshProviderBudget(false);
    refreshDataHealth(false);
  }
  if (next === "regime") renderMarketMoversPanel();
  if (next === "simulation") {
    runRiskAssessment(false);
    loadTradingAudit(false);
  }
}

function renderFeatureAnalysis(result) {
  const panel = $("featureAnalysisPanel");
  if (!panel) return;
  state.latestFeatureAnalysis = result;
  panel.dataset.featureChartBound = "";
  const summary = result?.summary || {};
  const quality = result?.quality || {};
  const footprint = result?.trade_footprint || {};
  const profile = result?.volume_profile || {};
  const atas = result?.atas || {};
  const structure = result?.structure || {};
  const bollinger = structure.bollinger || {};
  const fibonacci = structure.fibonacci || {};
  const fvg = structure.fvg || {};
  const ict = structure.ict || {};
  const wyckoff = structure.wyckoff || {};
  const orderflow = structure.orderflow_proxy || {};
  const anomalies = Array.isArray(result?.anomaly_segments) ? result.anomaly_segments.slice(-40).reverse() : [];
  const fvgRows = Array.isArray(fvg.segments) ? fvg.segments.slice(-18).reverse() : [];
  const sweepRows = Array.isArray(ict.liquidity_sweeps) ? ict.liquidity_sweeps.slice(-18).reverse() : [];
  const fibLevels = Array.isArray(fibonacci.levels) ? fibonacci.levels : [];
  const formulas = Array.isArray(result?.formula_book) ? result.formula_book : [];
  const buckets = Array.isArray(profile.buckets) ? profile.buckets : [];
  const maxVolume = Math.max(1, ...buckets.map((bucket) => Number(bucket.volume || 0)));
  const labeledRows = featureRowsWithSideLabels(result);
  const logs = labeledRows.slice().reverse();
  const sideCorrections = readFeatureSideCorrections(result);
  const correctionCount = Object.keys(sideCorrections).length;
  const labelCounts = logs.reduce((counts, row) => {
    counts[row.final_side_label] = (counts[row.final_side_label] || 0) + 1;
    return counts;
  }, {});
  const labelSummary = Object.entries(FEATURE_SIDE_LABELS)
    .map(([key, meta]) => `<span class="feature-chip ${meta.className}">${escapeHtml(meta.label)} ${formatCompactNumber(labelCounts[key] || 0, 0)}</span>`)
    .join("");
  const profileChart = volumeProfileMiniChart(buckets, profile);
  const flowModeLabel = quality.true_tick_footprint
    ? "真实逐笔足迹"
    : quality.side_totals_available
      ? "买卖总量可用"
      : "OHLCV 主动买卖代理";
  const sideMethodLabel = quality.aggressor_side_available
    ? "交易所主动方向"
    : quality.side_method === "tick_rule_estimate"
      ? "Tick-rule方向估算"
      : quality.side_method === "reported_side_totals"
        ? "Provider买卖总量"
        : "OHLCV代理";
  const atasSection = atas.available ? `
      <section>
        <h3>ATAS 特征接口</h3>
        <p class="good-text">ATAS 已返回外部特征结果。</p>
        ${atas.expected_payload ? `<p class="muted small-text">传输：${atas.expected_payload.map((item) => escapeHtml(item)).join(" / ")}</p>` : ""}
      </section>
    ` : "";
  panel.innerHTML = `
    <div class="quant-result-head">
      <div>
        <h3>${escapeHtml(result.symbol)} · ${escapeHtml(result.interval)}</h3>
        <p class="muted small-text">来源 ${escapeHtml(result.source || "未知")} · ${formatCompactNumber(result.row_count, 0)} 条真实记录${footprint.available ? ` · footprint ${formatCompactNumber(footprint.enriched_candles, 0)} 根K线 / ${formatCompactNumber(footprint.trade_rows_used, 0)} 笔` : ""}</p>
      </div>
      <div class="tag-row">
        <span class="tag ${quality.proxy_only ? "warn" : "good"}">${flowModeLabel}</span>
        <span class="tag ${quality.aggressor_side_available ? "good" : quality.true_tick_footprint ? "warn" : "warn"}">${sideMethodLabel}</span>
        <span class="tag ${result.true_l2 ? "good" : "warn"}">${result.true_l2 ? "真实 L2" : "未接入 L2"}</span>
        <span class="tag">质量 ${formatCompactNumber(quality.score, 1)}</span>
        <span class="tag ${correctionCount ? "good" : ""}">人工修正 ${formatCompactNumber(correctionCount, 0)}</span>
      </div>
    </div>
    ${result.warning ? `<p class="quant-warning">${escapeHtml(compactDisplayError(result.warning))}</p>` : ""}
    <div class="quant-metric-grid">
      <div><span>最新收盘</span><strong>${formatMoney(summary.last_close)}</strong></div>
      <div><span>累计 VWAP</span><strong>${formatMoney(summary.cumulative_vwap)}</strong></div>
      <div><span>距 VWAP</span><strong>${formatPct(summary.vwap_distance_pct)}</strong></div>
      <div><span>ATR 14</span><strong>${formatPct(summary.atr_pct_14)}</strong></div>
      <div><span>成交量比率</span><strong>${formatCompactNumber(summary.volume_ratio_20, 2)}x</strong></div>
      <div><span>失衡代理</span><strong>${formatCompactNumber(summary.orderflow_imbalance_proxy, 3)}</strong></div>
      <div><span>流向判断</span><strong>${escapeHtml(summary.flow_stance || "—")}</strong></div>
      <div><span>Amihud 非流动性</span><strong>${formatCompactNumber(summary.amihud_illiquidity, 8)}</strong></div>
    </div>
    <div class="structure-lab-grid">
      <section>
        <h3>Bollinger</h3>
        <div class="mini-metric-list">
          <span>%B <strong>${formatCompactNumber(bollinger.percent_b, 3)}</strong></span>
          <span>带宽 <strong>${formatPct(bollinger.bandwidth_pct)}</strong></span>
          <span>挤压 <strong>${formatCompactNumber(bollinger.squeeze_score, 1)}</strong></span>
          <span>状态 <strong>${escapeHtml(bollinger.state || "—")}</strong></span>
        </div>
      </section>
      <section>
        <h3>Fibonacci</h3>
        <p class="muted small-text">${escapeHtml(fibonacci.direction || "—")} · 最近 ${formatCompactNumber(fibonacci.lookback, 0)} 根 · 最近位 ${escapeHtml(fibonacci.nearest?.label || "—")} ${formatMoney(fibonacci.nearest?.price)}</p>
        <div class="feature-chip-list compact">${fibLevels.map((row) => `<span class="feature-chip">${escapeHtml(row.label)} · ${formatCompactNumber(row.price, 4)} · ${formatPct(row.distance_pct)}</span>`).join("") || `<span class="muted small-text">暂无 Fib 结构。</span>`}</div>
      </section>
      <section>
        <h3>FVG</h3>
        <div class="mini-metric-list">
          <span>未回补 <strong>${formatCompactNumber(fvg.open_count, 0)}</strong></span>
          <span>压力 <strong>${formatCompactNumber(fvg.pressure, 3)}</strong></span>
        </div>
        <div class="feature-chip-list compact">${fvgRows.map((row) => `<span class="feature-chip ${row.type === "bullish_fvg" ? "positive" : "negative"}">${escapeHtml(row.date)} · ${escapeHtml(row.type)} · ${formatPct(row.size_pct)} · ${escapeHtml(row.status)}</span>`).join("") || `<span class="muted small-text">当前窗口未检测到 FVG。</span>`}</div>
      </section>
      <section>
        <h3>ICT Sweep</h3>
        <div class="mini-metric-list"><span>压力 <strong>${formatCompactNumber(ict.pressure, 3)}</strong></span></div>
        <div class="feature-chip-list compact">${sweepRows.map((row) => `<span class="feature-chip ${row.type === "sell_side_liquidity_sweep" ? "positive" : "negative"}">${escapeHtml(row.date)} · ${escapeHtml(row.type)} · ${formatPct(row.depth_pct)} · 量比 ${formatCompactNumber(row.volume_ratio, 2)}x</span>`).join("") || `<span class="muted small-text">当前窗口未检测到扫高/扫低回收。</span>`}</div>
      </section>
      <section>
        <h3>Wyckoff</h3>
        <div class="mini-metric-list">
          <span>阶段 <strong>${escapeHtml(wyckoff.phase || "—")}</strong></span>
          <span>置信 <strong>${formatPct(wyckoff.confidence)}</strong></span>
          <span>斜率 <strong>${formatPct(wyckoff.slope_pct)}</strong></span>
          <span>区间位置 <strong>${formatCompactNumber(wyckoff.range_position, 3)}</strong></span>
        </div>
      </section>
      <section>
        <h3>${quality.true_tick_footprint ? "Order Flow Tick Footprint" : "Order Flow Proxy"}</h3>
        <div class="mini-metric-list">
          <span>压力 <strong>${formatCompactNumber(orderflow.pressure, 3)}</strong></span>
          <span>吸收 <strong>${formatCompactNumber(orderflow.absorption_proxy, 3)}</strong></span>
          <span>Effort/Result <strong>${formatCompactNumber(orderflow.effort_vs_result, 3)}</strong></span>
          <span>窗口 <strong>${formatCompactNumber(orderflow.recent_window, 0)}</strong></span>
        </div>
      </section>
    </div>
    <div class="feature-overlay-card">
      <div class="quant-result-head">
        <div>
          <h3>特征 + 股价多维对照</h3>
          <p class="muted small-text">使用全窗口真实记录；滚轮/触控板缩放 X 轴，拖拽平移，按钮选择维度。</p>
        </div>
        <div id="featureMetricButtons" class="feature-metric-buttons">${featureMetricButtons()}</div>
      </div>
      <div id="featureChartReadout" class="chart-readout muted">悬停查看全时段特征值</div>
      <canvas id="featureOverlayChart" height="260"></canvas>
    </div>
    <div class="feature-overlay-card orderflow-footprint-card">
      <div class="quant-result-head">
        <div>
          <h3>订单流价位足迹</h3>
          <p class="muted small-text">每根 K 线显示开收高低与价位层买卖分布；美股逐笔可用时用真实 tick 聚合，方向为 tick-rule 估算；无逐笔时只显示 OHLCV 代理。</p>
        </div>
        <span class="tag ${quality.proxy_only ? "warn" : "good"}">${quality.true_tick_footprint ? "真实逐笔价位层级" : quality.proxy_only ? "代理足迹" : "买卖总量"}</span>
      </div>
      <div id="featureOrderflowReadout" class="chart-readout muted">悬停查看每根 K 线价位买卖层级</div>
      <canvas id="featureOrderflowChart" height="320"></canvas>
    </div>
    <div class="feature-diagnostic-grid">
      <section>
        <h3>异常波动段</h3>
        <div class="feature-chip-list">
          ${anomalies.map((row) => `<span class="feature-chip ${row.type === "拉升放量" ? "positive" : row.type === "下跌放量" ? "negative" : "warning"}">${escapeHtml(row.date)} · ${escapeHtml(row.type)} · ${formatPct(row.return_pct)} · 量比 ${formatCompactNumber(row.volume_ratio, 2)}x</span>`).join("") || `<p class="muted small-text">当前窗口未检测到显著拉升/下跌/异常放量段。</p>`}
        </div>
      </section>
      ${atasSection}
      <section>
        <details class="scroll-fold" open>
          <summary>特征公式库</summary>
          <div class="scroll-fold-body">
            <div class="feature-formula-list fold-scroll">${formulas.map((row) => `<div><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.formula)}</span><p>${escapeHtml(row.usage)}</p></div>`).join("")}</div>
          </div>
        </details>
      </section>
    </div>
    <div class="quant-split">
      <section>
        <h3>成交量价格分布</h3>
        <div class="volume-profile-chart">
          ${profileChart}
        </div>
        <div class="volume-profile">
          ${buckets.slice().reverse().map((bucket) => `
            <div class="volume-profile-row">
              <span>${formatCompactNumber(bucket.mid, 3)}</span>
              <div><i style="width:${Math.max(2, Number(bucket.volume || 0) / maxVolume * 100)}%"></i></div>
              <strong>${formatCompactNumber(bucket.share_pct, 1)}%</strong>
            </div>
          `).join("") || `<p class="muted">暂无价格分布。</p>`}
        </div>
      </section>
      <section>
        <h3>数据质量说明</h3>
        <ul class="quant-note-list">
          ${(quality.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
        </ul>
        <p class="muted small-text">价格控制点：${profile.point_of_control ? formatMoney(profile.point_of_control.mid) : "—"} · 70% 价值区：${profile.value_area ? `${formatMoney(profile.value_area.low)} 至 ${formatMoney(profile.value_area.high)}` : "—"}</p>
      </section>
    </div>
    <details class="scroll-fold" open>
      <summary>全窗口成交特征数据</summary>
      <div class="scroll-fold-body tall">
        <div class="side-label-toolbar">
          <div>
            <strong>成交方向标签校准</strong>
            <p class="muted small-text">AI/规则模型先预打标；你在表格中修正后会覆盖自动判断，并保存在本地浏览器。</p>
            <div class="feature-chip-list compact">${labelSummary}</div>
          </div>
          <button class="secondary mini-btn" data-clear-feature-side-labels type="button" ${correctionCount ? "" : "disabled"}>清空人工修正</button>
        </div>
        <div class="quant-table-wrap fold-scroll">
          <table class="quant-data-table feature-label-table">
            <thead><tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th><th>成交量</th><th>成交笔数</th><th>成交额</th><th>VWAP</th><th>量比</th><th>买入额${quality.proxy_only ? "代理" : "估算"}</th><th>卖出额${quality.proxy_only ? "代理" : "估算"}</th><th>买入笔数${quality.proxy_only ? "代理" : "估算"}</th><th>卖出笔数${quality.proxy_only ? "代理" : "估算"}</th><th>失衡${quality.proxy_only ? "代理" : "估算"}</th><th>最终标签</th><th>人工校准</th><th>置信/原因</th><th>方向方法</th></tr></thead>
            <tbody>${logs.map((row) => {
              const labelMeta = featureSideLabelMeta(row.final_side_label);
              return `
              <tr>
                <td>${escapeHtml(row.date)}</td>
                <td>${formatCompactNumber(row.open, 4)}</td>
                <td>${formatCompactNumber(row.high, 4)}</td>
                <td>${formatCompactNumber(row.low, 4)}</td>
                <td>${formatCompactNumber(row.close, 4)}</td>
                <td>${formatCompactNumber(row.volume, 1)}</td>
                <td>${formatCompactNumber(row.trade_count, 0)}</td>
                <td>${formatCompactNumber(row.notional, 1)}</td>
                <td>${formatCompactNumber(row.vwap, 4)}</td>
                <td>${formatCompactNumber(row.volume_ratio, 2)}x</td>
                <td>${formatCompactNumber(row.active_buy_notional, 1)}</td>
                <td>${formatCompactNumber(row.active_sell_notional, 1)}</td>
                <td>${formatCompactNumber(row.active_buy_count, 0)}</td>
                <td>${formatCompactNumber(row.active_sell_count, 0)}</td>
                <td>${formatCompactNumber(row.imbalance_proxy, 3)}</td>
                <td class="side-label-cell ${labelMeta.className}">${featureSideLabelBadge(row)}</td>
                <td>${featureSideLabelSelect(row)}</td>
                <td class="side-label-reason"><strong>${formatPct(row.side_label_confidence * 100)}</strong><br><small>${escapeHtml(row.side_label_reason)}</small></td>
                <td>${escapeHtml(row.orderflow_side_method || sideMethodLabel)}</td>
              </tr>
            `; }).join("")}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;
  bindFeatureSideLabelControls(result);
  requestAnimationFrame(() => renderFeatureOverlayChart(result));
}

async function runFeatureAnalysis() {
  const button = $("runFeatureAnalysis");
  const panel = $("featureAnalysisPanel");
  try {
    const symbol = activeLabSymbol("featureSymbol");
    const interval = $("featureInterval")?.value || "1d";
    const range = $("featureRange")?.value || "9mo";
    if (button) button.disabled = true;
    if (panel) panel.innerHTML = `<p class="muted">正在读取 ${escapeHtml(symbol)} 的真实行情并计算成交特征...</p>`;
    setStatus(`正在运行 ${symbol} 底层特征分析`);
    const query = new URLSearchParams({ market: state.market, symbol, interval, range });
    const result = await requestJson(`/api/features?${query}`);
    renderFeatureAnalysis(result);
    const flowStatus = result.quality?.true_tick_footprint
      ? "真实逐笔足迹已接入，方向为 tick-rule 估算"
      : result.true_l2
        ? "真实 L2 可用"
        : "订单流已明确标注为代理";
    setStatus(`${symbol} 特征分析完成；${flowStatus}`);
  } catch (error) {
    if (panel) panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    setStatus(`特征分析失败：${compactDisplayError(error.message)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderTradeAnalysis(result) {
  const panel = $("tradeAnalysisPanel");
  if (!panel) return;
  const l1 = result?.l1_quote || {};
  const l2 = result?.l2_depth || {};
  if (!result?.available) {
    panel.innerHTML = `
      <div class="quant-result-head">
        <div>
          <h3>${escapeHtml(result?.symbol || activeLabSymbol("featureSymbol"))} · 逐笔成交不可用</h3>
          <p class="muted small-text">${escapeHtml(result?.reason || "当前数据源未返回真实逐笔成交。")}</p>
        </div>
        <div class="tag-row">
          <span class="tag warn">无真实 Tick</span>
          <span class="tag ${l1.available ? "good" : "warn"}">${l1.available ? "本地 L1 可用" : "无 L1"}</span>
          <span class="tag ${l2.available ? "good" : "warn"}">${l2.available ? "本地 L2 可用" : "无 L2"}</span>
        </div>
      </div>
      ${(l1.available || l2.available) ? `
        <div class="quant-metric-grid">
          <div><span>L1 Bid</span><strong>${l1.bid_price == null ? "—" : formatMoney(l1.bid_price)}</strong></div>
          <div><span>L1 Ask</span><strong>${l1.ask_price == null ? "—" : formatMoney(l1.ask_price)}</strong></div>
          <div><span>L1 Spread</span><strong>${l1.spread_pct == null ? "—" : formatPct(l1.spread_pct)}</strong></div>
          <div><span>L2 深度行</span><strong>${formatCompactNumber(l2.row_count || 0, 0)}</strong></div>
        </div>
      ` : ""}
    `;
    return;
  }
  const summary = result.summary || {};
  const exchanges = Array.isArray(result.exchange_breakdown) ? result.exchange_breakdown : [];
  const trades = Array.isArray(result.trades) ? result.trades.slice().reverse().slice(0, 100) : [];
  const boundaryNotes = [
    ...(Array.isArray(result.data_boundary) ? result.data_boundary : []),
    ...(Array.isArray(result.quality?.notes) ? result.quality.notes : []),
    result.provider_error ? `实时 provider 错误：${result.provider_error}` : "",
  ].filter(Boolean);
  panel.innerHTML = `
    <div class="quant-result-head">
      <div>
        <h3>${escapeHtml(result.symbol)} · ${result.local_replay ? "本地真实逐笔回放" : `最近 ${formatCompactNumber(result.window_minutes, 0)} 分钟真实逐笔`}</h3>
        <p class="muted small-text">来源 ${escapeHtml(result.source || "未知")} · ${formatCompactNumber(result.row_count, 0)} 笔 · ${escapeHtml(summary.first_timestamp || "—")} 至 ${escapeHtml(summary.last_timestamp || "—")}</p>
      </div>
      <div class="tag-row">
        <span class="tag ${result.true_tick ? "good" : "warn"}">${result.true_tick ? "真实 Trades" : "无真实 Tick"}</span>
        <span class="tag ${result.local_replay ? "warn" : "good"}">${result.local_replay ? "本地缓存回放" : "实时读取"}</span>
        <span class="tag ${l1.available ? "good" : "warn"}">${l1.available ? "真实 L1 Quote" : "无 L1"}</span>
        <span class="tag ${l2.available ? "good" : "warn"}">${l2.available ? "真实 L2" : "未接入 L2"}</span>
        <span class="tag warn">${result.aggressor_side_available ? "主动方向可用" : "主动买卖方向不可判定"}</span>
      </div>
    </div>
    <div class="quant-metric-grid">
      <div><span>最新成交价</span><strong>${formatMoney(summary.last_price)}</strong></div>
      <div><span>逐笔 VWAP</span><strong>${formatMoney(summary.vwap)}</strong></div>
      <div><span>窗口涨跌</span><strong>${formatPct(summary.price_change_pct)}</strong></div>
      <div><span>成交笔数</span><strong>${formatCompactNumber(result.row_count, 0)}</strong></div>
      <div><span>成交股数</span><strong>${formatCompactNumber(summary.total_size, 1)}</strong></div>
      <div><span>成交额</span><strong>${formatMoney(summary.total_notional)}</strong></div>
      <div><span>每分钟成交</span><strong>${formatCompactNumber(summary.trade_rate_per_minute, 1)}</strong></div>
      <div><span>大单股数占比</span><strong>${formatPct(summary.large_trade_size_share_pct)}</strong></div>
      <div><span>L1 Bid / Ask</span><strong>${l1.available ? `${l1.bid_price == null ? "—" : formatMoney(l1.bid_price)} / ${l1.ask_price == null ? "—" : formatMoney(l1.ask_price)}` : "未返回"}</strong></div>
      <div><span>L1 Spread</span><strong>${l1.spread_pct == null ? "—" : formatPct(l1.spread_pct)}</strong></div>
      <div><span>L2 深度行</span><strong>${formatCompactNumber(l2.row_count || 0, 0)}</strong></div>
      <div><span>本地写入</span><strong>${result.persistence?.ticks?.inserted == null ? (result.local_replay ? "回放" : "—") : `${formatCompactNumber(result.persistence.ticks.inserted, 0)} tick`}</strong></div>
    </div>
    <div class="quant-split">
      <section>
        <h3>成交所分布</h3>
        <div class="quant-table-wrap">
          <table class="quant-data-table">
            <thead><tr><th>成交所</th><th>笔数</th><th>股数</th><th>成交额</th><th>股数占比</th></tr></thead>
            <tbody>${exchanges.map((row) => `
              <tr>
                <td>${escapeHtml(row.exchange || "unknown")}</td>
                <td>${formatCompactNumber(row.trades, 0)}</td>
                <td>${formatCompactNumber(row.size, 1)}</td>
                <td>${formatMoney(row.notional)}</td>
                <td>${formatPct(row.size_share_pct)}</td>
              </tr>
            `).join("") || `<tr><td colspan="5">暂无成交所分布。</td></tr>`}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>数据能力边界</h3>
        <ul class="quant-note-list">
          ${boundaryNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
        </ul>
      </section>
    </div>
    <details class="scroll-fold" open>
      <summary>逐笔成交明细</summary>
      <div class="scroll-fold-body tall">
        <div class="quant-table-wrap fold-scroll">
          <table class="quant-data-table">
            <thead><tr><th>时间</th><th>成交价</th><th>股数</th><th>成交额</th><th>成交所</th><th>条件码</th><th>成交 ID</th></tr></thead>
            <tbody>${trades.map((row) => `
              <tr>
                <td>${escapeHtml(row.timestamp)}</td>
                <td>${formatCompactNumber(row.price, 6)}</td>
                <td>${formatCompactNumber(row.size, 1)}</td>
                <td>${formatMoney(row.notional)}</td>
                <td>${escapeHtml(row.exchange || "unknown")}</td>
                <td>${escapeHtml((row.conditions || []).join(", ") || "—")}</td>
                <td>${escapeHtml(row.trade_id || "—")}</td>
              </tr>
            `).join("") || `<tr><td colspan="7">授权数据源未返回可用逐笔。</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;
}

async function runTradeAnalysis() {
  const button = $("runTradeAnalysis");
  const panel = $("tradeAnalysisPanel");
  try {
    const symbol = activeLabSymbol("featureSymbol");
    const windowMinutes = $("tradeWindowMinutes")?.value || "30";
    if (button) button.disabled = true;
    if (panel) panel.innerHTML = `<p class="muted">正在读取 ${escapeHtml(symbol)} 的真实逐笔成交...</p>`;
    setStatus(`正在读取 ${symbol} 真实逐笔成交`);
    const query = new URLSearchParams({ market: state.market, symbol, windowMinutes });
    const result = await requestJson(`/api/trades?${query}`);
    renderTradeAnalysis(result);
    setStatus(result.available ? `${symbol} 真实逐笔分析完成` : `${symbol} 当前没有授权逐笔源`);
  } catch (error) {
    if (panel) panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    setStatus(`逐笔成交读取失败：${compactDisplayError(error.message)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function factorQualityGateHtml(factor) {
  const gate = factor?.quality_gate || {};
  const checks = gate.checks || {};
  const failed = Object.entries(checks)
    .filter(([, value]) => value?.pass === false)
    .map(([key]) => key);
  const pass = gate.pass === true;
  return `
    <span class="tag ${pass ? "good" : "danger"}">${pass ? "6/6 合格" : `${gate.passed || 0}/${gate.total || 6} 待修正`}</span>
    ${failed.length ? `<small>${failed.map((key) => escapeHtml(key)).join(" / ")}</small>` : `<small>${escapeHtml(gate.standardization || "train-window zscore")}</small>`}
  `;
}

function alphaEvolutionPanelHtml(result) {
  const alpha = result?.alpha_evolution || {};
  if (alpha.available === false) {
    return `
      <div class="validation-report alpha-evolution-panel">
        <div class="quant-result-head">
          <div>
            <h3>自进化 Alpha 挖掘</h3>
            <p class="muted small-text">QuantaAlpha-inspired 本地进化框架暂未返回。</p>
          </div>
          <span class="tag warn">待运行</span>
        </div>
        <p class="quant-warning">${escapeHtml(alpha.error || "样本不足或本地模型暂不可用。")}</p>
      </div>
    `;
  }
  const candidates = Array.isArray(alpha.best_candidates) ? alpha.best_candidates : [];
  const trajectory = Array.isArray(alpha.trajectory) ? alpha.trajectory : [];
  const models = alpha.advanced_models || {};
  const regime = models.regime || {};
  const gbm = models.gbm || {};
  const vol = models.volatility || {};
  const markowitz = models.markowitz || {};
  const ta = models.tradingview_style?.latest || {};
  const qlib = alpha.qlib_bridge || {};
  return `
    <div class="validation-report alpha-evolution-panel">
      <div class="quant-result-head">
        <div>
          <h3>自进化 Alpha 挖掘</h3>
          <p class="muted small-text">${escapeHtml(alpha.framework || "local evolution")} · ${formatCompactNumber(alpha.sample_count, 0)} 个样本 · mutation/crossover 后保留低冗余候选。</p>
        </div>
        <span class="tag good">QuantaAlpha-style</span>
      </div>
      <div class="alpha-model-grid">
        <div><span>GBM 期望</span><strong>${formatPct(gbm.expected_return_pct)}</strong><small>P10/P90 ${formatPct(gbm.p10_return_pct)} / ${formatPct(gbm.p90_return_pct)}</small></div>
        <div><span>HMM 状态代理</span><strong>${escapeHtml(regime.current_regime || "—")}</strong><small>持续概率 ${formatPct(Number(regime.persistence_probability || 0) * 100)}</small></div>
        <div><span>波动率模型</span><strong>${formatPct(vol.ewma_annual_vol_pct)}</strong><small>${escapeHtml(vol.risk_state || "normal")} · Parkinson ${formatPct(vol.parkinson_annual_vol_pct)}</small></div>
        <div><span>Markowitz 风险预算</span><strong>${formatPct(markowitz.suggested_active_weight_pct)}</strong><small>${escapeHtml(markowitz.model || "single asset")}</small></div>
        <div><span>TradingView TA</span><strong>RSI ${formatCompactNumber(ta.rsi14, 1)}</strong><small>MACD ${formatCompactNumber(ta.macd_hist_pct, 4)} · ATR ${formatPct(ta.atr_pct_14)}</small></div>
        <div><span>Qlib Bridge</span><strong>${escapeHtml(qlib.status || "pending")}</strong><small>${escapeHtml((qlib.models || []).join(" / ") || "LightGBM / LSTM / Transformer")}</small></div>
      </div>
      <details class="scroll-fold" open>
        <summary>进化候选因子</summary>
        <div class="scroll-fold-body tall">
          <div class="quant-table-wrap fold-scroll">
            <table class="quant-data-table alpha-candidate-table">
              <thead><tr><th>候选因子</th><th>表达式</th><th>假设</th><th>Fitness</th><th>泛化</th><th>IC</th><th>Rank IC</th><th>验证 IC</th><th>测试 IC</th><th>稳定性</th><th>重叠</th><th>质量</th><th>最新值</th></tr></thead>
              <tbody>${candidates.map((candidate) => `
                <tr>
                  <td><strong>${escapeHtml(candidate.name)}</strong><br><small>${escapeHtml((candidate.lineage || []).join(" -> "))}</small></td>
                  <td><code>${escapeHtml(candidate.expression || "")}</code></td>
                  <td>${escapeHtml(candidate.hypothesis || "")}</td>
                  <td><strong>${formatCompactNumber(candidate.fitness, 2)}</strong></td>
                  <td><span class="tag ${candidate.overfit_flag ? "warn" : "good"}">${formatCompactNumber(candidate.generalization_score, 1)}</span></td>
                  <td class="${Number(candidate.ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(candidate.ic, 4)}</td>
                  <td class="${Number(candidate.rank_ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(candidate.rank_ic, 4)}</td>
                  <td class="${Number(candidate.validation_ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(candidate.validation_ic, 4)}</td>
                  <td class="${Number(candidate.test_ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(candidate.test_ic, 4)}</td>
                  <td>${formatCompactNumber(candidate.stability, 3)}</td>
                  <td>${formatCompactNumber(candidate.max_overlap, 3)}</td>
                  <td><span class="tag ${candidate.quality_gate?.pass ? "good" : "warn"}">${candidate.quality_gate?.passed || 0}/${candidate.quality_gate?.total || 6}</span></td>
                  <td>${formatCompactNumber(candidate.latest_value, 4)}</td>
                </tr>
              `).join("")}</tbody>
            </table>
          </div>
        </div>
      </details>
      <div class="alpha-trajectory-strip">
        ${trajectory.map((row) => `
          <div>
            <span>Gen ${formatCompactNumber(row.generation, 0)}</span>
            <strong>${escapeHtml(row.best || "—")}</strong>
            <small>${formatCompactNumber(row.best_fitness, 2)} · ${escapeHtml(row.operation || "")}</small>
          </div>
        `).join("")}
      </div>
      <ul class="quant-note-list">
        ${(alpha.principles || []).map((row) => `<li>${escapeHtml(row)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function factorLabSeriesRows(result) {
  const rows = Array.isArray(result?.series?.rows) ? result.series.rows : [];
  return rows.map((row) => {
    const close = asPositiveNumber(row?.close);
    if (!row?.date || !Number.isFinite(close)) return null;
    const open = asPositiveNumber(row?.open, close);
    const high = Math.max(asPositiveNumber(row?.high, close), open, close);
    const low = Math.min(asPositiveNumber(row?.low, close), open, close);
    return {
      date: String(row.date),
      open,
      high,
      low,
      close,
      volume: Math.max(0, asNumber(row.volume, 0)),
      futureReturnPct: asNumber(row.future_return_pct, 0),
      futureVwapReturnPct: asNumber(row.future_vwap_return_pct, 0),
      factors: row.factors && typeof row.factors === "object" ? row.factors : {},
    };
  }).filter(Boolean);
}

function factorLabFactorNames(result) {
  const fromSeries = Array.isArray(result?.series?.factor_names) ? result.series.factor_names : [];
  const fromRows = Array.isArray(result?.factors) ? result.factors.map((factor) => factor.name) : [];
  return [...new Set([...fromSeries, ...fromRows].map((name) => String(name || "").trim()).filter(Boolean))];
}

function selectedFactorLabKeys(result = state.latestFactorLab) {
  const names = factorLabFactorNames(result);
  const allowed = new Set(names);
  const saved = Array.isArray(state.factorLabChart?.factors) ? state.factorLabChart.factors.filter((key) => allowed.has(key)) : [];
  if (saved.length) return saved;
  const top = Array.isArray(result?.factors)
    ? result.factors.slice(0, 4).map((factor) => factor.name).filter((name) => allowed.has(name))
    : [];
  return top.length ? top : names.slice(0, 4);
}

function factorLabFactorButtons(result = state.latestFactorLab) {
  const selected = new Set(selectedFactorLabKeys(result));
  return factorLabFactorNames(result).map((name) => `
    <button class="factor-chip ${selected.has(name) ? "active" : ""}" data-factor-lab-factor="${escapeHtml(name)}" type="button">${escapeHtml(name)}</button>
  `).join("");
}

function saveFactorLabChartState() {
  safeStorage.setItem("factorLabChart", JSON.stringify(state.factorLabChart || {}));
}

function visibleFactorLabRows(sourceRows) {
  const source = Array.isArray(sourceRows) ? sourceRows : [];
  const baseCount = source.length;
  const maxZoom = Math.max(1, baseCount / 28);
  const zoom = clamp(Number(state.factorLabChart?.zoom || 1), 1, maxZoom);
  state.factorLabChart.zoom = zoom;
  const visibleCount = Math.max(16, Math.min(baseCount, Math.round(baseCount / zoom)));
  const maxOffset = Math.max(0, baseCount - visibleCount);
  state.factorLabChart.offset = clamp(Math.round(Number(state.factorLabChart?.offset || 0)), 0, maxOffset);
  const end = source.length - state.factorLabChart.offset;
  const start = Math.max(0, end - visibleCount);
  return {
    rows: source.slice(start, end),
    start,
    end,
    visibleCount,
    maxOffset,
    zoom,
  };
}

function zScoreLine(values, limit = 4.2) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  const avg = finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
  const variance = finite.length ? finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / finite.length : 0;
  const sigma = Math.sqrt(variance) || 1;
  return values.map((value) => clamp((Number(value || 0) - avg) / sigma, -limit, limit));
}

function pctReturnScale(rows) {
  const firstClose = rows.find((row) => row.close > 0)?.close || rows[0]?.close || 1;
  const raw = rows.flatMap((row) => [
    pctChange(row.open, firstClose),
    pctChange(row.high, firstClose),
    pctChange(row.low, firstClose),
    pctChange(row.close, firstClose),
  ]);
  const maxAbs = Math.max(1, ...raw.map((value) => Math.abs(value)));
  return { firstClose, scale: maxAbs / 3.7 };
}

function drawFactorLabCandles(ctx, rows, bounds, width, height, candleWidth) {
  if (!rows.length) return;
  const { firstClose, scale } = pctReturnScale(rows);
  rows.forEach((row, index) => {
    const x = xFor(index, rows.length, width);
    const open = clamp(pctChange(row.open, firstClose) / scale, bounds.min, bounds.max);
    const high = clamp(pctChange(row.high, firstClose) / scale, bounds.min, bounds.max);
    const low = clamp(pctChange(row.low, firstClose) / scale, bounds.min, bounds.max);
    const close = clamp(pctChange(row.close, firstClose) / scale, bounds.min, bounds.max);
    const yHigh = yFor(high, bounds.min, bounds.max, height);
    const yLow = yFor(low, bounds.min, bounds.max, height);
    const yOpen = yFor(open, bounds.min, bounds.max, height);
    const yClose = yFor(close, bounds.min, bounds.max, height);
    const up = row.close >= row.open;
    ctx.strokeStyle = up ? "rgba(67, 224, 138, 0.52)" : "rgba(255, 101, 125, 0.52)";
    ctx.fillStyle = up ? "rgba(67, 224, 138, 0.2)" : "rgba(255, 101, 125, 0.2)";
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();
    ctx.fillRect(x - candleWidth / 2, Math.min(yOpen, yClose), candleWidth, Math.max(2, Math.abs(yClose - yOpen)));
  });
}

function drawFactorLabOverlayChart(result = state.latestFactorLab) {
  const canvas = $("factorLabOverlayChart");
  if (!canvas || !result) return;
  const sourceRows = factorLabSeriesRows(result);
  if (!sourceRows.length) {
    drawLoading(canvas, "因子序列暂未返回");
    return;
  }
  state.factorLabChart = state.factorLabChart || {};
  const view = visibleFactorLabRows(sourceRows);
  const rows = view.rows;
  const chart = setupCanvas(canvas);
  drawGrid(chart.ctx, chart.width, chart.height);
  const bounds = { min: -4.6, max: 4.6 };
  drawAxis(chart.ctx, bounds, chart.width, chart.height, (value) => `${value.toFixed(0)}z`);
  const candleWidth = Math.max(3, Math.min(12, (chart.width - 62) / rows.length * 0.55));
  drawFactorLabCandles(chart.ctx, rows, bounds, chart.width, chart.height, candleWidth);

  const colors = [
    "#38bdf8", "#43e08a", "#facc15", "#e879f9", "#2fd6c9", "#ff657d",
    "#60a5fa", "#f97316", "#a78bfa", "#c4ff72",
  ];
  const priceClose = zScoreLine(rows.map((row) => row.close));
  const futureReturn = zScoreLine(rows.map((row) => row.futureReturnPct));
  const futureVwapReturn = zScoreLine(rows.map((row) => row.futureVwapReturnPct));
  drawSeriesLine(chart.ctx, priceClose, bounds, chart.width, chart.height, "#e9f6ff", 1.55);
  drawSeriesLine(chart.ctx, futureReturn, bounds, chart.width, chart.height, "#facc15", 2.05);
  chart.ctx.setLineDash([6, 5]);
  drawSeriesLine(chart.ctx, futureVwapReturn, bounds, chart.width, chart.height, "#a78bfa", 1.55);
  chart.ctx.setLineDash([]);
  selectedFactorLabKeys(result).forEach((key, index) => {
    const line = zScoreLine(rows.map((row) => row.factors?.[key]));
    chart.ctx.setLineDash(index % 2 ? [3, 5] : []);
    drawSeriesLine(chart.ctx, line, bounds, chart.width, chart.height, colors[index % colors.length], 1.45);
  });
  chart.ctx.setLineDash([]);
  chart.ctx.font = "10px Inter, system-ui, sans-serif";
  chart.ctx.textAlign = "left";
  chart.ctx.fillStyle = "#e9f6ff";
  chart.ctx.fillText("K线/收盘z", 52, 16);
  chart.ctx.fillStyle = "#facc15";
  chart.ctx.fillText(`未来${formatCompactNumber(result.horizon_days, 0)}日收益z`, 122, 16);
  chart.ctx.fillStyle = "#a78bfa";
  chart.ctx.fillText("未来VWAP收益z", 228, 16);
  selectedFactorLabKeys(result).slice(0, 7).forEach((key, index) => {
    chart.ctx.fillStyle = colors[index % colors.length];
    chart.ctx.fillText(key, 52 + (index % 4) * 128, 34 + Math.floor(index / 4) * 16);
  });
  drawTimeAxis(chart.ctx, rows, chart.width, chart.height);

  if (state.factorLabChartHoverIndex != null) {
    const hoverIndex = clamp(state.factorLabChartHoverIndex, 0, rows.length - 1);
    drawCrosshair(chart.ctx, hoverIndex, rows.length, chart.width, chart.height);
    const row = rows[hoverIndex];
    const metrics = selectedFactorLabKeys(result).slice(0, 5).map((key) => `${key} ${formatCompactNumber(row.factors?.[key], 4)}`).join(" · ");
    const readout = $("factorLabOverlayReadout");
    if (readout) {
      readout.textContent = `${row.date} · O ${formatCompactNumber(row.open, 4)} H ${formatCompactNumber(row.high, 4)} L ${formatCompactNumber(row.low, 4)} C ${formatCompactNumber(row.close, 4)} · 未来收盘 ${formatPct(row.futureReturnPct)} · 未来VWAP ${formatPct(row.futureVwapReturnPct)} · ${metrics}`;
    }
  } else {
    const readout = $("factorLabOverlayReadout");
    if (readout) readout.textContent = `滚轮缩放、拖拽平移；当前显示 ${rows.length}/${sourceRows.length} 个样本，所有因子线为可比 z-score。`;
  }

  const panel = $("factorLabPanel");
  if (panel && !panel.dataset.factorLabChartBound) {
    panel.dataset.factorLabChartBound = "true";
    panel.querySelectorAll("[data-factor-lab-factor]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.factorLabFactor;
        const selected = new Set(selectedFactorLabKeys(result));
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        state.factorLabChart.factors = [...selected];
        if (!state.factorLabChart.factors.length) state.factorLabChart.factors = [factorLabFactorNames(result)[0]].filter(Boolean);
        saveFactorLabChartState();
        const buttons = panel.querySelector("#factorLabMetricButtons");
        if (buttons) buttons.innerHTML = factorLabFactorButtons(result);
        panel.dataset.factorLabChartBound = "";
        drawFactorLabOverlayChart(result);
      });
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (sideways) {
        state.factorLabChart.offset = Math.max(0, Number(state.factorLabChart.offset || 0) + Math.round(event.deltaX / WHEEL_PAN_DIVISOR));
      } else {
        const factor = event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT;
        state.factorLabChart.zoom = clamp(Number(state.factorLabChart.zoom || 1) * factor, 1, 40);
      }
      saveFactorLabChartState();
      scheduleChartRedraw("factorLab", () => drawFactorLabOverlayChart(result));
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => {
      state.factorLabChartDragging = { x: event.clientX, offset: Number(state.factorLabChart.offset || 0) };
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const currentRows = visibleFactorLabRows(sourceRows).rows;
      if (state.factorLabChartDragging) {
        const barsPerPixel = currentRows.length / Math.max(1, rect.width - 62);
        state.factorLabChart.offset = Math.max(0, Math.round(state.factorLabChartDragging.offset - (event.clientX - state.factorLabChartDragging.x) * barsPerPixel));
        scheduleChartRedraw("factorLab", () => drawFactorLabOverlayChart(result));
        return;
      }
      const ratio = clamp((event.clientX - rect.left - 48) / Math.max(1, rect.width - 62), 0, 1);
      state.factorLabChartHoverIndex = Math.round(ratio * (currentRows.length - 1));
      scheduleChartRedraw("factorLab", () => drawFactorLabOverlayChart(result));
    });
    canvas.addEventListener("pointerup", () => {
      state.factorLabChartDragging = null;
      saveFactorLabChartState();
    });
    canvas.addEventListener("mouseleave", () => {
      state.factorLabChartHoverIndex = null;
      scheduleChartRedraw("factorLab", () => drawFactorLabOverlayChart(result));
    });
  }
}

function renderFactorLab(result) {
  const panel = $("factorLabPanel");
  if (!panel) return;
  state.latestFactorLab = result;
  const factors = Array.isArray(result?.factors) ? result.factors : [];
  const qualityGate = result?.quality_gate || {};
  const qlib = result?.qlib_readiness || {};
  const overlaps = Array.isArray(result?.high_overlap) ? result.high_overlap : [];
  const validation = result?.validation || {};
  const checkpoints = Array.isArray(validation.checkpoints) ? validation.checkpoints : [];
  const training = result?.training_controls || {};
  const trainingCheckpoints = Array.isArray(training.checkpoints) ? training.checkpoints : [];
  const correlationMatrix = result?.correlation_matrix || {};
  const correlationNames = Object.keys(correlationMatrix);
  const library = Array.isArray(result?.factor_library) ? result.factor_library : [];
  panel.innerHTML = `
    <div class="quant-result-head">
      <div>
        <h3>${escapeHtml(result.symbol)} · 未来 ${formatCompactNumber(result.horizon_days, 0)} 日标签</h3>
        <p class="muted small-text">${escapeHtml(result.method || "")} · ${formatCompactNumber(result.sample_count, 0)} 个样本 · 未来收盘均值 ${formatPct(result.labels?.future_close_return_mean_pct)} · 未来窗口 VWAP 均值 ${formatPct(result.labels?.future_window_vwap_return_mean_pct)} · 来源 ${escapeHtml(result.source || "真实行情")}</p>
      </div>
      <div class="tag-row">
        <span class="tag good">Walk-forward</span>
        <span class="tag ${qualityGate.all_pass ? "good" : "warn"}">因子闸门 ${formatCompactNumber(qualityGate.pass_count, 0)}/${formatCompactNumber(qualityGate.factor_count, 0)}</span>
        <span class="tag ${qlib.available ? "good" : "warn"}">Qlib ${qlib.available ? "ready" : "optional"}</span>
      </div>
    </div>
    ${result.warning ? `<p class="quant-warning">${escapeHtml(compactDisplayError(result.warning))}</p>` : ""}
    <div class="factor-quality-strip">
      <div>
        <span>六项因子质检</span>
        <strong>${formatPct(qualityGate.pass_rate_pct)}</strong>
        <small>${escapeHtml(qualityGate.method || "dimensionless / richness / leakage / missing / outlier / standardization")}</small>
      </div>
      <div>
        <span>Qlib 可选模型层</span>
        <strong>${qlib.available ? "已可导入" : "未安装"}</strong>
        <small>${escapeHtml(qlib.message || "Qlib readiness not checked")}</small>
      </div>
      ${(qlib.models || []).map((model) => `
        <div>
          <span>${escapeHtml(model.label)}</span>
          <strong class="${model.ready ? "good-text" : "muted"}">${model.ready ? "ready" : escapeHtml(model.reason || "缺依赖")}</strong>
          <small>${escapeHtml(model.use || "")}</small>
        </div>
      `).join("")}
    </div>
    <div class="feature-overlay-card factor-lab-overlay-card">
      <div class="quant-result-head">
        <div>
          <h3>因子 / K线 / 未来收益叠合</h3>
          <p class="muted small-text">选中单因子或多因子后，在同一张标准化折线图上对照 K 线背景和未来收益标签。</p>
        </div>
        <div id="factorLabMetricButtons" class="feature-metric-buttons factor-lab-buttons">${factorLabFactorButtons(result)}</div>
      </div>
      <div id="factorLabOverlayReadout" class="chart-readout muted">滚轮缩放、拖拽平移；悬停查看因子值与未来收益。</div>
      <canvas id="factorLabOverlayChart" height="360"></canvas>
    </div>
    ${alphaEvolutionPanelHtml(result)}
    <details class="scroll-fold" open>
      <summary>因子评分与六项闸门</summary>
      <div class="scroll-fold-body tall">
        <div class="quant-table-wrap fold-scroll">
          <table class="quant-data-table factor-lab-table">
            <thead><tr><th>因子</th><th>六项闸门</th><th>方向</th><th>评分</th><th>收盘 IC</th><th>收盘 Rank IC</th><th>窗口 VWAP IC</th><th>股价相关</th><th>预测相关</th><th>滚动 IC</th><th>正 IC 窗口</th><th>稳定性</th><th>最新值</th><th>建议权重</th></tr></thead>
            <tbody>${factors.map((factor) => `
              <tr>
                <td><strong>${escapeHtml(factor.name)}</strong><span class="factor-formula-inline">${escapeHtml(factor.formula || "")}</span></td>
                <td class="factor-gate-cell">${factorQualityGateHtml(factor)}</td>
                <td class="${factor.direction_label === "positive" ? "good-text" : "danger-text"}">${factor.direction_label === "positive" ? "Positive" : "Negative"}<br><small>${escapeHtml(factor.long_short_usage || "")}</small></td>
                <td><strong>${formatCompactNumber(factor.score, 1)}</strong></td>
                <td class="${Number(factor.ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(factor.ic, 4)}</td>
                <td class="${Number(factor.rank_ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(factor.rank_ic, 4)}</td>
                <td class="${Number(factor.future_vwap_ic) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(factor.future_vwap_ic, 4)}</td>
                <td class="${Number(factor.price_correlation) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(factor.price_correlation, 4)}</td>
                <td class="${Number(factor.prediction_correlation) >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(factor.prediction_correlation, 4)}</td>
                <td><div class="rolling-ic-spark">${(factor.rolling_ic || []).slice(-10).map((value) => `<i class="${Number(value) >= 0 ? "positive" : "negative"}" style="height:${Math.max(3, Math.min(100, Math.abs(Number(value || 0)) * 100))}%"></i>`).join("")}</div></td>
                <td>${formatPct(factor.positive_window_share_pct)}</td>
                <td>${formatCompactNumber(factor.stability, 3)}</td>
                <td>${formatCompactNumber(factor.latest_value, 4)}</td>
                <td>${formatPct(factor.suggested_weight_pct)}</td>
              </tr>
            `).join("")}</tbody>
          </table>
        </div>
      </div>
    </details>
    <div class="validation-report">
      <div class="quant-result-head">
        <div>
          <h3>Purged Walk-forward 样本外验证</h3>
          <p class="muted small-text">Purge ${formatCompactNumber(validation.purge_samples, 0)} 个样本 · Embargo ${formatCompactNumber(validation.embargo_samples, 0)} 个样本 · ${checkpoints.length} 个检查点</p>
        </div>
        <span class="tag ${validation.rollback_recommended ? "danger" : "good"}">${validation.rollback_recommended ? "建议回滚最佳检查点" : "最新检查点可保留"}</span>
      </div>
      ${checkpoints.length ? `
        <details class="scroll-fold" open>
          <summary>验证检查点明细</summary>
          <div class="scroll-fold-body">
            <div class="quant-table-wrap fold-scroll">
              <table class="quant-data-table validation-table">
                <thead><tr><th>检查点</th><th>训练样本</th><th>验证样本</th><th>验证 IC</th><th>验证 Rank IC</th><th>方向命中</th><th>评分</th></tr></thead>
                <tbody>${checkpoints.map((row) => `
                  <tr class="${row.id === validation.best_checkpoint?.id ? "best-checkpoint" : ""}">
                    <td>${escapeHtml(row.id)}${row.id === validation.best_checkpoint?.id ? " · 最佳" : ""}</td>
                    <td>${formatCompactNumber(row.train_samples, 0)}</td>
                    <td>${formatCompactNumber(row.validation_samples, 0)}</td>
                    <td>${formatCompactNumber(row.validation_ic, 4)}</td>
                    <td>${formatCompactNumber(row.validation_rank_ic, 4)}</td>
                    <td>${formatPct(row.direction_hit_rate_pct)}</td>
                    <td>${formatCompactNumber(row.score, 2)}</td>
                  </tr>
                `).join("")}</tbody>
              </table>
            </div>
          </div>
        </details>
        <p class="muted small-text">${escapeHtml(validation.recommendation || "")}</p>
      ` : `<p class="muted">样本不足，尚不能生成可靠的滚动验证检查点。</p>`}
    </div>
    <div class="validation-report">
      <div class="quant-result-head">
        <div>
          <h3>训练控制与最佳检查点回滚</h3>
          <p class="muted small-text">梯度累积 ${formatCompactNumber(training.gradient_accumulation_batches, 0)} 个小批次 · Batch ${formatCompactNumber(training.batch_size, 0)} · 优化步 ${formatCompactNumber(training.optimizer_steps, 0)} · 训练/验证/测试 ${formatCompactNumber(training.training_samples, 0)}/${formatCompactNumber(training.validation_samples, 0)}/${formatCompactNumber(training.test_samples, 0)}</p>
        </div>
        <span class="tag ${training.rollback_applied ? "warn" : "good"}">${training.rollback_applied ? `已回滚 ${escapeHtml(training.best_checkpoint?.id || "最佳检查点")}` : "保留最新最佳检查点"}</span>
      </div>
      ${training.status === "ready" ? `
        <div class="training-control-grid">
          <div><span>最佳验证评分</span><strong>${formatCompactNumber(training.best_checkpoint?.score, 3)}</strong></div>
          <div><span>最佳验证方向命中</span><strong>${formatPct(training.best_checkpoint?.validation_direction_hit_rate_pct)}</strong></div>
          <div><span>独立测试方向命中</span><strong>${formatPct(training.test?.direction_hit_rate_pct)}</strong></div>
          <div><span>独立测试 MAE</span><strong>${formatPct(training.test?.mae)}</strong></div>
          <div><span>独立测试 IC</span><strong>${formatCompactNumber(training.test?.ic, 4)}</strong></div>
          <div><span>早停耐心</span><strong>${formatCompactNumber(training.early_stopping_patience_checkpoints, 0)} 检查点</strong></div>
        </div>
        <div class="training-curve" aria-label="验证检查点评分">
          ${trainingCheckpoints.map((row) => {
            const minScore = Math.min(...trainingCheckpoints.map((item) => Number(item.score || 0)));
            const maxScore = Math.max(...trainingCheckpoints.map((item) => Number(item.score || 0)));
            const height = maxScore > minScore ? 12 + (Number(row.score || 0) - minScore) / (maxScore - minScore) * 88 : 50;
            return `<i class="${row.id === training.best_checkpoint?.id ? "best" : ""}" style="height:${Math.max(4, Math.min(100, height))}%" title="${escapeHtml(row.id)} · score ${formatCompactNumber(row.score, 3)} · hit ${formatPct(row.validation_direction_hit_rate_pct)}"></i>`;
          }).join("")}
        </div>
        <p class="muted small-text">${escapeHtml(training.method || "")}</p>
      ` : `<p class="muted">样本不足，尚不能运行带梯度累积的独立训练/验证/测试流程。</p>`}
    </div>
    <details class="scroll-fold" open>
      <summary>因子相关性矩阵</summary>
      <div class="scroll-fold-body tall">
        <div class="factor-heatmap fold-scroll">
          ${correlationNames.flatMap((left) => correlationNames.map((right) => {
            const value = Number(correlationMatrix[left]?.[right] || 0);
            const alpha = Math.min(0.95, Math.max(0.16, Math.abs(value)));
            const color = value >= 0 ? `rgba(67, 224, 138, ${alpha})` : `rgba(255, 101, 125, ${alpha})`;
            return `<span style="background:${color}" title="${escapeHtml(left)} / ${escapeHtml(right)} = ${formatCompactNumber(value, 3)}">${formatCompactNumber(value, 2)}</span>`;
          })).join("")}
        </div>
        <div class="quant-table-wrap fold-scroll">
          <table class="quant-data-table correlation-table">
            <thead><tr><th>因子</th>${correlationNames.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead>
            <tbody>${correlationNames.map((left) => `
              <tr><td>${escapeHtml(left)}</td>${correlationNames.map((right) => {
                const value = Number(correlationMatrix[left]?.[right] || 0);
                return `<td class="${Math.abs(value) >= 0.75 && left !== right ? "correlation-high" : ""}">${formatCompactNumber(value, 2)}</td>`;
              }).join("")}</tr>
            `).join("")}</tbody>
          </table>
        </div>
      </div>
    </details>
    <div class="quant-split">
      <section>
        <h3>高相关重叠</h3>
        ${overlaps.length ? `<ul class="quant-note-list">${overlaps.slice(0, 12).map((row) => `<li>${escapeHtml(row.left)} / ${escapeHtml(row.right)}：${formatCompactNumber(row.correlation, 3)}</li>`).join("")}</ul>` : `<p class="muted">当前未发现绝对相关性高于 0.75 的因子对。</p>`}
      </section>
      <section>
        <h3>防过拟合护栏</h3>
        <ul class="quant-note-list">${(result.guardrails || []).map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>
      </section>
    </div>
    <details class="scroll-fold" open>
      <summary>因子库公式与用途</summary>
      <div class="scroll-fold-body">
        <div class="factor-library-grid fold-scroll">${library.map((row) => `<div><strong>${escapeHtml(row.name)}</strong><code>${escapeHtml(row.formula)}</code><p>${escapeHtml(row.usage)}</p></div>`).join("")}</div>
      </div>
    </details>
  `;
  requestAnimationFrame(() => drawFactorLabOverlayChart(result));
  renderFactorConfigPanel(result);
}

async function runFactorLab() {
  const button = $("runFactorLab");
  const panel = $("factorLabPanel");
  try {
    const symbol = activeLabSymbol("factorLabSymbol");
    const horizonDays = $("factorLabHorizon")?.value || "15";
    if (button) button.disabled = true;
    if (panel) panel.innerHTML = `<p class="muted">正在读取 ${escapeHtml(symbol)} 的真实历史行情并进行样本外因子评估...</p>`;
    setStatus(`正在评估 ${symbol} 因子`);
    const query = new URLSearchParams({ market: state.market, symbol, horizonDays });
    const [result, qlibReadiness] = await Promise.all([
      requestJson(`/api/factor-lab?${query}`),
      requestJson("/api/qlib-readiness").catch((error) => ({ available: false, message: error.message, models: [] })),
    ]);
    result.qlib_readiness = qlibReadiness;
    renderFactorLab(result);
    setStatus(`${symbol} 因子实验完成；已生成 IC、Rank IC 和建议权重`);
  } catch (error) {
    if (panel) panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    setStatus(`因子实验失败：${compactDisplayError(error.message)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderFactorConfigPanel(result = state.latestFactorLab) {
  const panel = $("factorConfigPanel");
  if (!panel) return;
  const config = researchConfigForMarket();
  const resultFactors = Array.isArray(result?.factors) ? result.factors : [];
  const factorMap = new Map(resultFactors.map((factor) => [factor.name, factor]));
  Object.keys(config.factorConfig || {}).forEach((name) => {
    if (!factorMap.has(name)) factorMap.set(name, { name, score: null, suggested_weight_pct: config.factorConfig[name]?.weightPct || 0 });
  });
  const rows = [...factorMap.values()];
  if (!rows.length) {
    panel.innerHTML = `<p class="muted">先运行一次因子评估，再保存启用状态和权重。</p>`;
    return;
  }
  const overlaps = new Set((result?.high_overlap || []).flatMap((row) => [row.left, row.right]));
  panel.innerHTML = `
    <div class="factor-config-list">
      ${rows.map((factor) => {
        const saved = config.factorConfig?.[factor.name];
        const enabled = saved ? saved.enabled !== false : Number(factor.score || 0) >= 12;
        const weight = saved ? Number(saved.weightPct || 0) : Number(factor.suggested_weight_pct || 0);
        return `
          <label class="factor-config-row">
            <input type="checkbox" data-factor-enabled="${escapeHtml(factor.name)}" ${enabled ? "checked" : ""}>
            <strong>${escapeHtml(factor.name)}</strong>
            <span>${factor.score == null ? "已保存配置" : `评分 ${formatCompactNumber(factor.score, 1)}`}${overlaps.has(factor.name) ? " · 与其他因子高相关" : ""}</span>
            <input type="number" min="0" max="100" step="0.1" value="${formatCompactNumber(weight, 1)}" data-factor-weight="${escapeHtml(factor.name)}" aria-label="${escapeHtml(factor.name)} 权重">
            <em>%</em>
          </label>
        `;
      }).join("")}
    </div>
    <p class="muted small-text">保存时会把已启用因子的权重归一化到 100%；关闭的因子不会进入后续研究配置。</p>
  `;
}

async function saveFactorConfig() {
  const panel = $("factorConfigPanel");
  if (!panel) return;
  const config = researchConfigForMarket();
  const previous = clonePlain(config.factorConfig || {});
  const next = {};
  panel.querySelectorAll("[data-factor-enabled]").forEach((checkbox) => {
    const name = checkbox.dataset.factorEnabled;
    const weightInput = panel.querySelector(`[data-factor-weight="${CSS.escape(name)}"]`);
    next[name] = {
      enabled: checkbox.checked,
      weightPct: checkbox.checked ? Math.max(0, asNumber(weightInput?.value, 0)) : 0,
      note: "",
    };
  });
  const total = Object.values(next).reduce((sum, row) => sum + (row.enabled ? row.weightPct : 0), 0);
  if (total > 0) {
    Object.values(next).forEach((row) => {
      row.weightPct = row.enabled ? Number((row.weightPct / total * 100).toFixed(2)) : 0;
    });
  }
  config.factorConfig = next;
  const serverSaved = await persistResearchConfig(config);
  const details = factorConfigChangeDetails(previous, next);
  appendModelChangeLog({
    type: "factor-config",
    title: "因子配置已保存",
    summary: `调整 ${details.changedCount} 个因子；启用 ${details.enabledCount} 个，最大单因子权重 ${formatPct(details.maxWeightPct)}。`,
    before: { factorConfig: previous },
    after: { factorConfig: next },
    details,
  });
  renderFactorConfigPanel();
  setStatus(`因子配置已保存${serverSaved ? "到本地服务器" : "到浏览器本地；重启服务后可再次同步"}`);
}

function renderStrategyRevisionPanel() {
  const panel = $("strategyRevisionPanel");
  if (!panel) return;
  const rows = [...researchConfigForMarket().strategyRevisions].reverse();
  panel.innerHTML = rows.length ? rows.slice(0, 30).map((row) => `
    <article class="strategy-revision-row">
      <div>
        <strong>${new Date(row.createdAt).toLocaleString()}</strong>
        <span>周期 ${formatCompactNumber(row.strategy?.horizonDays, 0)} 日 · 目标 ${formatPct(row.strategy?.targetUpside)} · 要求置信 ${formatPct(row.strategy?.confidence)} · 止损 ${formatPct(row.strategy?.stopLoss)}</span>
      </div>
      <p>${escapeHtml(row.note || "未填写修改原因")}</p>
      <small>${escapeHtml(row.strategy?.text || "")}</small>
    </article>
  `).join("") : `<p class="muted">还没有保存策略版本。</p>`;
}

async function recordStrategyRevision() {
  const config = researchConfigForMarket();
  const note = $("strategyRevisionNote")?.value.trim() || "";
  const previous = config.strategyRevisions.at(-1)?.strategy || null;
  const strategy = getStrategy();
  config.strategyRevisions.push({
    id: `${state.market}:${Date.now()}`,
    createdAt: new Date().toISOString(),
    source: "manual",
    note,
    strategy,
  });
  config.strategyRevisions = config.strategyRevisions.slice(-100);
  saveState();
  const serverSaved = await persistResearchConfig(config);
  appendModelChangeLog({
    type: "strategy-revision",
    title: "策略版本已记录",
    summary: note || `记录当前策略：${strategy.horizonDays} 日、目标 ${formatPct(strategy.targetUpside)}、置信 ${formatPct(strategy.confidence)}。`,
    before: { strategy: previous },
    after: { strategy },
    details: { note, revisionCount: config.strategyRevisions.length },
  });
  if ($("strategyRevisionNote")) $("strategyRevisionNote").value = "";
  renderStrategyRevisionPanel();
  setStatus(`当前策略版本已记录${serverSaved ? "并同步到本地服务器" : "；服务器暂不可用，已保存在浏览器本地"}`);
}

function renderProviderBudget(result, capabilities = null) {
  const panel = $("providerBudgetPanel");
  if (!panel) return;
  const policy = result?.policy || {};
  const providers = Array.isArray(result?.providers) ? result.providers : [];
  const intervals = Array.isArray(capabilities?.intervals) ? capabilities.intervals : [];
  panel.innerHTML = `
    <div class="provider-plan">
      <div><span>主数据源</span><strong>${escapeHtml(policy.primary?.name || "暂无可用源")}</strong></div>
      <div><span>免费支撑源</span><strong>${escapeHtml(policy.support?.name || "暂无支撑源")}</strong></div>
      <div><span>有限额源上限</span><strong>${formatCompactNumber(policy.limited_source_cap_per_task, 0)} / 任务</strong></div>
      <div><span>逐笔成交</span><strong>${capabilities?.tick?.available ? "可用" : "未授权/未落盘"}</strong></div>
      <div><span>L1 Quote</span><strong>${capabilities?.l1?.available ? "可用" : "未授权/未落盘"}</strong></div>
      <div><span>L2 深度</span><strong>${capabilities?.l2?.available ? "可用" : "未授权/未落盘"}</strong></div>
    </div>
    ${intervals.length ? `
      <div class="provider-capability-grid">
        ${intervals.map((row) => {
          const usable = row.providers?.some((provider) => provider.configured && !provider.backoff);
          return `
            <div class="${usable ? "ready" : "blocked"}">
              <strong>${escapeHtml(row.interval)} · ${escapeHtml(row.granularity)}</strong>
              <p>${(row.providers || []).map((provider) => {
                const stateText = !provider.configured ? "缺 key" : provider.backoff ? "额度/权限阻断" : "候选";
                return `${provider.source}:${stateText}`;
              }).join(" / ")}</p>
            </div>
          `;
        }).join("")}
      </div>
    ` : ""}
    <div class="provider-list">
      ${providers.map((provider) => `
        <div>
          <span class="readiness-dot ${provider.configured ? "ready" : "blocked"}"></span>
          <strong>${escapeHtml(provider.name)}</strong>
          <span>${escapeHtml(provider.tier)} · ${provider.configured ? "已配置/免密" : "未配置"}</span>
        </div>
      `).join("")}
    </div>
    <p class="muted small-text">${escapeHtml(policy.cross_check || "")} ${escapeHtml(policy.offline || "")}</p>
    ${capabilities ? `<p class="muted small-text">逐笔：${escapeHtml(capabilities.tick?.note || "")} L2：${escapeHtml(capabilities.l2?.note || "")}</p>` : ""}
  `;
}

async function refreshProviderBudget(showStatus = true) {
  const panel = $("providerBudgetPanel");
  try {
    if (panel) panel.innerHTML = `<p class="muted">正在检查 ${escapeHtml(activeMarketConfig().label)} 数据源预算...</p>`;
    const symbol = activeLabSymbol("featureSymbol");
    const [result, capabilities] = await Promise.all([
      requestJson(`/api/provider-budget?market=${encodeURIComponent(state.market)}`),
      requestJson(`/api/data-capabilities?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`),
    ]);
    renderProviderBudget(result, capabilities);
    if (showStatus) setStatus(`${activeMarketConfig().label}数据源预算已更新`);
  } catch (error) {
    if (panel) panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    if (showStatus) setStatus(`数据源预算读取失败：${compactDisplayError(error.message)}`);
  }
}

function formatAge(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "未知";
  const minutes = Math.round(value / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function renderDataHealth(payload) {
  const panel = $("dataHealthPanel");
  if (!panel) return;
  if (!payload) {
    panel.innerHTML = `<p class="muted">尚未读取数据健康状态。</p>`;
    return;
  }
  const marketProviders = Array.isArray(payload.marketProviders) ? payload.marketProviders : [];
  const newsProviders = Array.isArray(payload.newsProviders) ? payload.newsProviders : [];
  const socialProviders = Array.isArray(payload.socialProviders) ? payload.socialProviders : (payload.redditSocial ? [payload.redditSocial] : []);
  const cacheRows = Array.isArray(payload.newsCache?.rows) ? payload.newsCache.rows : [];
  const redditCacheRows = Array.isArray(payload.redditSocial?.cache?.rows) ? payload.redditSocial.cache.rows : [];
  const redditSummary = payload.redditSocial?.cache?.summary || {};
  const cacheSummary = payload.newsCache?.summary || {};
  const schedule = payload.refreshSchedule || {};
  const monitoredRows = [...state.analyses.values()];
  const validation = monitoredRows.reduce((acc, item) => {
    if (item?.analysis?.action === "ERROR") acc.error += 1;
    else if (item?.marketValidation?.degraded) acc.single += 1;
    else if (item?.marketValidation?.ok) acc.dual += 1;
    else acc.unknown += 1;
    return acc;
  }, { dual: 0, single: 0, error: 0, unknown: 0 });
  const providerPill = (provider) => {
    const health = providerHealth(provider);
    const text = !provider.configured ? "未接入" : health === "warn" ? "额度/权限" : "可用";
    return `<span class="api-pill ${health}"><i></i><b>${escapeHtml(provider.name || provider.source || "provider")}</b><em>${escapeHtml(text)}</em></span>`;
  };
  panel.innerHTML = `
    <div class="data-health-grid">
      <div>
        <span>新闻读取策略</span>
        <strong>${payload.cachePolicy?.localFirst ? "本地优先" : "实时优先"}</strong>
        <small>自动窗口：${(payload.cachePolicy?.autoRefreshWindows || []).map((slot) => `${slot.label} ${String(Math.floor(slot.minute / 60)).padStart(2, "0")}:${String(slot.minute % 60).padStart(2, "0")}`).join(" / ") || "未配置"}</small>
      </div>
      <div>
        <span>新闻缓存</span>
        <strong>${cacheSummary.totalFiles || 0} 文件 · ${cacheSummary.newsCount || 0} 条</strong>
        <small>最近 ${cacheSummary.latestCachedAt ? `${new Date(cacheSummary.latestCachedAt).toLocaleString()} · ${formatAge(Date.now() - Date.parse(cacheSummary.latestCachedAt))}` : "暂无"}</small>
      </div>
      <div>
        <span>刷新状态</span>
        <strong>${schedule.due ? "需要抓新" : "缓存可用"}</strong>
        <small>${escapeHtml(schedule.reason || "")}</small>
      </div>
      <div>
        <span>Reddit 社媒缓存</span>
        <strong>${redditSummary.totalFiles || 0} 文件 · ${redditSummary.itemCount || 0} 条</strong>
        <small>最近 ${redditSummary.latestCachedAt ? `${new Date(redditSummary.latestCachedAt).toLocaleString()} · ${formatAge(Date.now() - Date.parse(redditSummary.latestCachedAt))}` : "暂无"}</small>
      </div>
      <div>
        <span>真实逐笔/L1/L2</span>
        <strong>${payload.capabilities?.tick?.available ? "逐笔可用" : "逐笔未授权"} / ${payload.capabilities?.l1?.available ? "L1可用" : "L1未授权"} / ${payload.capabilities?.l2?.available ? "L2可用" : "L2未授权"}</strong>
        <small>${escapeHtml(payload.capabilities?.tick?.note || payload.capabilities?.tick?.reason || "")}</small>
      </div>
      <div>
        <span>当前监控池行情</span>
        <strong>双源 ${validation.dual} · 单源 ${validation.single} · 失败 ${validation.error}</strong>
        <small>${monitoredRows.length ? `共 ${monitoredRows.length} 个分析对象，未知 ${validation.unknown}` : "当前页面还没有行情分析结果"}</small>
      </div>
    </div>
    <details class="health-details" open>
      <summary>行情源状态</summary>
      <div class="api-status-scroll">${marketProviders.slice(0, 14).map(providerPill).join("") || "<span class=\"muted\">暂无行情源状态</span>"}</div>
    </details>
    <details class="health-details" open>
      <summary>新闻源状态</summary>
      <div class="api-status-scroll">${newsProviders.slice(0, 14).map(providerPill).join("") || "<span class=\"muted\">暂无新闻源状态</span>"}</div>
    </details>
    <details class="health-details" open>
      <summary>社媒源状态</summary>
      <div class="api-status-scroll">${socialProviders.slice(0, 8).map(providerPill).join("") || "<span class=\"muted\">暂无社媒源状态</span>"}</div>
    </details>
    <details class="health-details">
      <summary>本地新闻缓存明细</summary>
      <div class="news-cache-list">
        ${cacheRows.length ? cacheRows.slice(0, 24).map((row) => `
          <div>
            <strong>${escapeHtml(row.symbol || row.file || "MARKET")} · ${escapeHtml(row.scope || "all")}</strong>
            <span>${row.newsCount || 0} 条 · ${escapeHtml(row.source || row.cache || "disk")} · ${row.cachedAt ? formatAge(Date.now() - Date.parse(row.cachedAt)) : "未知时间"}</span>
            <em>${row.refreshDecision?.due ? "到刷新窗口" : "本地可用"}</em>
          </div>
        `).join("") : `<p class="muted">当前市场还没有本地新闻缓存。</p>`}
      </div>
    </details>
    <details class="health-details">
      <summary>本地 Reddit 缓存明细</summary>
      <div class="news-cache-list">
        ${redditCacheRows.length ? redditCacheRows.slice(0, 24).map((row) => `
          <div>
            <strong>${escapeHtml(row.symbol || row.file || "UNKNOWN")}</strong>
            <span>${row.count || 0} 条 · ${escapeHtml(row.source || "reddit-social")} · ${row.cachedAt ? formatAge(Date.now() - Date.parse(row.cachedAt)) : "未知时间"}</span>
            <em>${row.invalid ? "无效缓存" : "本地可用"}</em>
          </div>
        `).join("") : `<p class="muted">当前市场还没有本地 Reddit 社媒缓存。</p>`}
      </div>
    </details>
  `;
}

async function refreshDataHealth(showStatus = true) {
  const panel = $("dataHealthPanel");
  try {
    if (panel) panel.innerHTML = `<p class="muted">正在读取 ${escapeHtml(activeMarketConfig().label)} 数据健康中心...</p>`;
    const symbol = state.selected || state.watchlist[0] || activeMarketConfig().defaultSymbols[0] || "";
    const payload = await requestJson(`/api/data-health?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`);
    renderDataHealth(payload);
    if (showStatus) setStatus(`${activeMarketConfig().label}数据健康中心已更新`);
  } catch (error) {
    if (panel) panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    if (showStatus) setStatus(`数据健康中心读取失败：${compactDisplayError(error.message)}`);
  }
}

async function refreshNewsNow() {
  const symbols = newsRefreshSymbolsForMarket(40);
  if (!symbols.length) {
    setStatus("当前没有可刷新新闻的股票，请先加入监控或刷新行情");
    return;
  }
  setStatus(`正在手动刷新 ${symbols.length} 只股票新闻；本操作会请求新闻源但不消耗 AI token...`);
  const results = await Promise.allSettled(symbols.map(async (symbol) => {
    const news = await fetchNews(symbol, "refresh");
    const item = state.analyses.get(symbol);
    if (item) {
      item.news = news;
      item.signalRefreshedAt = new Date().toISOString();
      state.analyses.set(symbol, item);
    }
    return { symbol, count: news.length };
  }));
  const ok = results.filter((row) => row.status === "fulfilled").length;
  const totalNews = results.reduce((sum, row) => sum + (row.status === "fulfilled" ? row.value.count : 0), 0);
  persistAnalysisSnapshot("manual-news-refresh");
  renderCards();
  renderDetail();
  await refreshDataHealth(false);
  setStatus(`新闻刷新完成：${ok}/${symbols.length} 只股票，写入 ${totalNews} 条本地新闻；如需重算买卖结论，请再点“刷新”。`);
}

function saveApiStatusState() {
  safeStorage.setItem("apiStatusByMarket", JSON.stringify(state.apiStatusByMarket));
}

function providerHealth(provider = {}) {
  if (!provider.configured) return "blocked";
  if (provider.endpointConfigured === false) return "warn";
  const text = `${provider.backoff || ""} ${provider.error || ""} ${provider.note || ""}`.toLowerCase();
  if (provider.backoff || /limit|quota|permission|forbidden|unauthorized|blocked|backoff|额度|权限|限制/.test(text)) return "warn";
  return "ready";
}

function capabilityHealth(capability = {}) {
  if (capability.localAvailable) return "ready";
  if (capability.configured) return "warn";
  if (capability.available) return "ready";
  const note = String(capability.note || capability.reason || "").toLowerCase();
  if (/limit|quota|permission|forbidden|unauthorized|blocked|额度|权限|限制/.test(note)) return "warn";
  return "blocked";
}

function renderApiStatusBar(payload = state.apiStatusByMarket[state.market]) {
  const bar = $("apiStatusBar");
  if (!bar) return;
  const config = activeMarketConfig();
  if (!payload) {
    bar.innerHTML = `
      <strong>API 状态</strong>
      <span class="api-status-note">${escapeHtml(config.label)} 数据源待检查</span>
      <button class="api-status-refresh" type="button" data-api-status-refresh>检查</button>
    `;
  } else {
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    const newsProviders = Array.isArray(payload.newsProviders) ? payload.newsProviders : [];
    const socialProviders = Array.isArray(payload.socialProviders) ? payload.socialProviders : [];
    const modelProviders = Array.isArray(payload.modelProviders) ? payload.modelProviders : [];
    const capabilities = payload.capabilities || {};
    const providerPills = providers.slice(0, 8).map((provider) => {
      const health = providerHealth(provider);
      const label = !provider.configured ? "未接入" : health === "warn" ? "额度/权限" : "可用";
      return `
        <span class="api-pill ${health}">
          <i></i><b>${escapeHtml(provider.name || provider.label || provider.source || "provider")}</b><em>${label}</em>
        </span>
      `;
    }).join("");
    const capabilityPills = ["l1", "tick", "l2"].map((key) => {
      const capability = capabilities[key] || {};
      const health = capabilityHealth(capability);
      const label = key === "l1" ? "L1" : key === "tick" ? "逐笔" : "L2";
      const stateLabel = capability.localAvailable
        ? "本地可用"
        : capability.configured
          ? "已配置"
          : capability.available
            ? "可用"
            : "未授权";
      return `
        <span class="api-pill ${health}" title="${escapeHtml(capability.note || capability.reason || "")}">
          <i></i><b>${label}</b><em>${escapeHtml(stateLabel)}</em>
        </span>
      `;
    }).join("");
    const newsPills = newsProviders.slice(0, 9).map((provider) => {
      const health = providerHealth(provider);
      const label = !provider.configured ? "未接入" : health === "warn" ? "额度/权限" : "可用";
      return `
        <span class="api-pill news ${health}">
          <i></i><b>${escapeHtml(provider.name || "news")}</b><em>${label}</em>
        </span>
      `;
    }).join("");
    const socialPills = socialProviders.slice(0, 4).map((provider) => {
      const health = providerHealth(provider);
      const label = !provider.enabled ? "关闭" : !provider.configured ? "未接入" : health === "warn" ? "缓存/权限" : "可用";
      return `
        <span class="api-pill social ${health}">
          <i></i><b>${escapeHtml(provider.name || "reddit")}</b><em>${escapeHtml(label)}</em>
        </span>
      `;
    }).join("");
    const modelPills = (modelProviders.length ? modelProviders : [{ name: "AI模型", configured: false, note: "未接入" }]).slice(0, 5).map((provider) => {
      const health = providerHealth(provider);
      const label = !provider.configured ? "未接入" : provider.model ? provider.model : "可用";
      return `
        <span class="api-pill model ${health}">
          <i></i><b>${escapeHtml(provider.name || provider.label || provider.id || "AI")}</b><em>${escapeHtml(label)}</em>
        </span>
      `;
    }).join("");
    bar.innerHTML = `
      <strong>${escapeHtml(config.code)} API</strong>
      <div class="api-status-scroll">${providerPills}${capabilityPills}${newsPills}${socialPills}${modelPills}</div>
      <button class="api-status-refresh" type="button" data-api-status-refresh>检查</button>
    `;
  }
  bar.querySelector("[data-api-status-refresh]")?.addEventListener("click", () => refreshApiStatusBar(true));
}

async function refreshApiStatusBar(showStatus = false) {
  const bar = $("apiStatusBar");
  try {
    if (bar && showStatus) {
      bar.querySelector(".api-status-note")?.replaceChildren(document.createTextNode("正在检查数据源..."));
    }
    const symbol = state.selected || state.watchlist[0] || activeMarketConfig().defaultSymbols[0] || "";
    const [budget, capabilities, newsStatus, health] = await Promise.all([
      requestJson(`/api/provider-budget?market=${encodeURIComponent(state.market)}`),
      requestJson(`/api/data-capabilities?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`),
      requestJson("/api/news-provider-status"),
      requestJson("/api/health"),
    ]);
    const modelProviders = Array.isArray(health?.externalAi?.providers) && health.externalAi.providers.length
      ? health.externalAi.providers.map((provider) => ({
        name: provider.label || provider.id,
        id: provider.id,
        configured: provider.configured !== false,
        model: provider.model,
        endpointConfigured: provider.endpointConfigured !== false,
      }))
      : [{ name: "AI模型", configured: false, note: health?.externalAi?.enabled ? "已启用但未发现 provider" : "未启用" }];
    const payload = {
      updatedAt: new Date().toISOString(),
      providers: budget?.providers || [],
      newsProviders: newsStatus?.providers || [],
      socialProviders: health?.reddit ? [health.reddit] : [],
      modelProviders,
      newsPrimary: newsStatus?.primary || "auto",
      policy: budget?.policy || {},
      capabilities,
    };
    state.apiStatusByMarket[state.market] = payload;
    saveApiStatusState();
    renderApiStatusBar(payload);
    if (showStatus) setStatus(`${activeMarketConfig().label} API 状态已更新`);
  } catch (error) {
    state.apiStatusByMarket[state.market] = {
      updatedAt: new Date().toISOString(),
      providers: [{ name: "server", configured: true, backoff: error.message }],
      modelProviders: [{ name: "AI模型", configured: false, backoff: error.message }],
      capabilities: {},
      error: error.message,
    };
    saveApiStatusState();
    renderApiStatusBar(state.apiStatusByMarket[state.market]);
    if (showStatus) setStatus(`API 状态读取失败：${compactDisplayError(error.message)}`);
  }
}

async function checkIbkrReadiness() {
  const button = $("checkIbkrReadiness");
  const panel = $("ibkrReadinessPanel");
  try {
    if (button) button.disabled = true;
    if (panel) panel.innerHTML = `<p class="muted">正在检查本机 IB Gateway / TWS 端口...</p>`;
    const result = await requestJson("/api/ibkr/readiness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: $("ibkrHost")?.value || "127.0.0.1",
        port: asNumber($("ibkrPort")?.value, 7497),
        clientId: asNumber($("ibkrClientId")?.value, 17),
      }),
    });
    if (panel) {
      panel.innerHTML = `
        <div class="readiness-state ${result.connected ? "ready" : "blocked"}">
          <span class="readiness-dot ${result.connected ? "ready" : "blocked"}"></span>
          <div><strong>${result.connected ? "本机接口可连接" : "本机接口未连接"}</strong><p>${escapeHtml(result.message || "")}</p></div>
        </div>
        ${result.error ? `<p class="muted small-text">${escapeHtml(result.error)}</p>` : ""}
        <p class="quant-warning">订单执行：${result.order_execution_enabled ? "已启用" : "强制关闭"}。本页不会发送订单。</p>
      `;
    }
    setStatus(result.connected ? "IBKR Paper 本机接口已就绪；订单执行仍关闭" : "IBKR Paper 本机接口当前不可达");
  } catch (error) {
    if (panel) panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    setStatus(`IBKR 就绪检查失败：${compactDisplayError(error.message)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function portfolioRiskPayload() {
  const capital = getCapital();
  const strategy = getStrategy();
  return {
    market: state.market,
    totalCapital: capital.totalCapital,
    availableCash: capital.availableCash,
    positions: activePortfolio().map((holding) => {
      const item = state.analyses.get(holding.symbol);
      const technicals = normalizeTechnicals(item?.technicals);
      return {
        symbol: holding.symbol,
        market: holding.market,
        qty: holding.qty,
        avgPrice: holding.avgPrice,
        currentPrice: technicals.close || holding.avgPrice,
        sector: item?.fundamentals?.sector || sectorOf(holding.symbol),
        change5d: technicals.change5d,
        volatility: technicals.volatility,
        holdingDays: holdingDays(holding),
      };
    }),
    policy: {
      reserveCashPct: strategy.reserveCashPct,
      maxPositionPct: strategy.maxPosition,
      maxSectorPct: asNumber($("maxSectorExposure")?.value, 35),
      maxGrossExposurePct: asNumber($("maxGrossExposure")?.value, 100),
      stopLossPct: strategy.stopLoss,
      maxDrawdownPct: asNumber($("maxPortfolioDrawdown")?.value, 12),
    },
  };
}

function renderRiskAssessment(result) {
  const panel = $("riskAssessmentPanel");
  if (!panel) return;
  const capital = result?.capital || {};
  const policy = result?.policy || {};
  const blockers = Array.isArray(result?.blockers) ? result.blockers : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const sectors = Array.isArray(result?.sector_exposure) ? result.sector_exposure : [];
  const statusClass = result?.status === "blocked" ? "danger" : result?.status === "warning" ? "warn" : "good";
  panel.innerHTML = `
    <div class="quant-result-head">
      <div>
        <h3>风险健康度 ${formatCompactNumber(result?.risk_score, 1)} / 100</h3>
        <p class="muted small-text">总敞口 ${formatPct(capital.gross_exposure_pct)} · 现金 ${formatPct(capital.cash_pct)} · 可用于新交易 ${formatMoney(capital.available_for_new_trades)} · 当前回撤 ${formatPct(capital.current_drawdown_pct)}</p>
      </div>
      <span class="tag ${statusClass}">${result?.new_orders_allowed ? "允许新增 Paper 意图" : "阻止新增买入意图"}</span>
    </div>
    <div class="risk-metric-grid">
      <div><span>持仓市值</span><strong>${formatMoney(capital.invested_value)}</strong></div>
      <div><span>现金储备要求</span><strong>${formatMoney(capital.reserve_cash_value)} / ${formatPct(policy.reserve_cash_pct)}</strong></div>
      <div><span>单票上限</span><strong>${formatPct(policy.max_position_pct)}</strong></div>
      <div><span>行业上限</span><strong>${formatPct(policy.max_sector_pct)}</strong></div>
      <div><span>最大回撤上限</span><strong>${formatPct(policy.max_drawdown_pct)}</strong></div>
      <div><span>订单执行</span><strong>强制关闭</strong></div>
    </div>
    ${blockers.length ? `<div class="risk-issue-list">${blockers.map((row) => `<div class="risk-issue danger"><strong>${escapeHtml(row.code)}</strong><span>${escapeHtml(row.message)}</span></div>`).join("")}</div>` : ""}
    ${warnings.length ? `<div class="risk-issue-list">${warnings.map((row) => `<div class="risk-issue warn"><strong>${escapeHtml(row.code)}</strong><span>${escapeHtml(row.message)}</span></div>`).join("")}</div>` : ""}
    ${!blockers.length && !warnings.length ? `<p class="quant-success">当前传入的真实持仓与资金处于策略风险边界内。</p>` : ""}
    ${sectors.length ? `<div class="risk-sector-list">${sectors.map((row) => `<span>${escapeHtml(row.sector)} <strong>${formatPct(row.weight_pct)}</strong></span>`).join("")}</div>` : `<p class="muted small-text">当前市场没有持仓行业敞口。</p>`}
  `;
}

async function runRiskAssessment(showStatus = true) {
  const button = $("runRiskAssessment");
  const panel = $("riskAssessmentPanel");
  if (!panel) return null;
  try {
    if (button) button.disabled = true;
    panel.innerHTML = `<p class="muted">Python 风险引擎正在评估当前真实持仓与资金...</p>`;
    const result = await requestJson("/api/risk-assessment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(portfolioRiskPayload()),
    });
    state.latestRiskAssessment = result;
    renderRiskAssessment(result);
    if (showStatus) setStatus(result.new_orders_allowed ? "组合风控完成：当前允许新增 Paper 意图" : "组合风控完成：新增买入意图已被阻止");
    return result;
  } catch (error) {
    panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    if (showStatus) setStatus(`组合风控失败：${compactDisplayError(error.message)}`);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderTradingAudit(orderResult = {}, summary = {}) {
  const panel = $("tradingAuditPanel");
  if (!panel) return;
  const rows = Array.isArray(orderResult.order_intents) ? orderResult.order_intents : [];
  panel.innerHTML = `
    <div class="quant-result-head">
      <div>
        <h3>SQLite 控制面</h3>
        <p class="muted small-text">当前市场事件 ${formatCompactNumber(summary.event_count, 0)} 条 · Paper 意图 ${formatCompactNumber(summary.order_intent_count, 0)} 条 · 订单执行始终关闭</p>
      </div>
      <span class="tag good">重启后保留</span>
    </div>
    <div class="audit-list">
      ${rows.length ? rows.map((row) => {
        const intent = row.payload || {};
        const statusClass = intent.approved ? "good" : "danger";
        return `
          <div class="audit-row">
            <div><strong>${escapeHtml(intent.symbol || row.intent_id || "未知意图")} · ${escapeHtml(intent.side || "")}</strong><span>${new Date(row.created_at).toLocaleString()} · ${escapeHtml(row.idempotency_key || "")}</span></div>
            <div><span>${formatCompactNumber(intent.qty, 4)} 股 · ${formatMoney(intent.limit_price)} · ${formatMoney(intent.notional)}</span><span class="tag ${statusClass}">${row.duplicate ? "幂等重复" : escapeHtml(intent.status || row.status || "")}</span></div>
          </div>
        `;
      }).join("") : `<p class="muted">当前市场还没有 Paper 订单意图记录。</p>`}
    </div>
  `;
}

async function loadTradingAudit(showStatus = true) {
  if (!$("tradingAuditPanel")) return;
  try {
    const [orders, summary] = await Promise.all([
      requestJson(`/api/order-intents?market=${encodeURIComponent(state.market)}&limit=40`),
      requestJson(`/api/control-plane?market=${encodeURIComponent(state.market)}`),
    ]);
    renderTradingAudit(orders, summary);
    if (showStatus) setStatus(`${activeMarketConfig().label}本地交易审计已更新`);
  } catch (error) {
    $("tradingAuditPanel").innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    if (showStatus) setStatus(`交易审计读取失败：${compactDisplayError(error.message)}`);
  }
}

async function submitPaperOrderIntent() {
  const panel = $("paperIntentResult");
  if (!panel) return;
  try {
    if (!$("paperIntentConfirmed")?.checked) throw new Error("请先确认这只是 Paper 审计意图");
    const symbol = normalizeSymbol($("paperIntentSymbol")?.value || state.selected || "");
    if (!symbol) throw new Error("请输入当前市场的有效股票代码");
    const side = $("paperIntentSide")?.value || "BUY";
    const qty = asNumber($("paperIntentQty")?.value, 0);
    const item = state.analyses.get(symbol);
    const price = asNumber($("paperIntentPrice")?.value, item?.technicals?.close || 0);
    const keyInput = $("paperIntentKey");
    const idempotencyKey = keyInput?.value.trim() || `${state.market}:${symbol}:${side}:${qty}:${price}:${Date.now()}`;
    if (keyInput) keyInput.value = idempotencyKey;
    panel.innerHTML = `<p class="muted">正在运行风险校验并写入本地审计库...</p>`;
    const result = await requestJson(`/api/order-intents?market=${encodeURIComponent(state.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order: { mode: "paper", market: state.market, symbol, side, qty, price, idempotencyKey },
        risk: portfolioRiskPayload(),
      }),
    });
    const intent = result.payload || {};
    const errors = Array.isArray(intent.errors) ? intent.errors : [];
    panel.innerHTML = `
      <div class="readiness-state ${intent.approved ? "ready" : "blocked"}">
        <span class="readiness-dot ${intent.approved ? "ready" : "blocked"}"></span>
        <div><strong>${result.duplicate ? "重复意图已被幂等拦截" : intent.approved ? "Paper 意图已通过并记录" : "Paper 意图已拒绝并记录"}</strong><p>${escapeHtml(intent.symbol || symbol)} · ${escapeHtml(intent.side || side)} · ${formatCompactNumber(intent.qty || qty, 4)} 股 · ${formatMoney(intent.limit_price || price)}</p></div>
      </div>
      ${errors.length ? `<ul class="quant-note-list">${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
      <p class="quant-warning">order_sent=false；不会向券商发送订单。</p>
    `;
    await loadTradingAudit(false);
    setStatus(result.duplicate ? "重复 Paper 意图已由幂等键拦截" : intent.approved ? "Paper 意图已通过风控并写入审计库" : "Paper 意图被风控拒绝并写入审计库");
  } catch (error) {
    panel.innerHTML = `<p class="quant-error">${escapeHtml(compactDisplayError(error.message))}</p>`;
    setStatus(`Paper 意图处理失败：${compactDisplayError(error.message)}`);
  }
}

function compactDisplayError(message) {
  return String(message || "读取失败")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/<[^|]{0,220}(?=\s*\||$)/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .replace(/HTTP 403[\s\S]*?(?=\||$)/gi, "Provider 403/权限限制")
    .replace(/HTTP 404:\s*Stooq\s*/gi, "Stooq HTTP 404/no rows")
    .replace(/Thank you for using Alpha Vantage![\s\S]*?(?=\||$)/gi, "Alpha Vantage 免费额度/端点限制")
    .replace(/You exceeded your daily API requests limit[\s\S]*?(?=\||$)/gi, "EODHD 日额度已用尽")
    .replace(/Single real source accepted by quota policy\.?/gi, "已按数据源保护策略接受单一真实源。")
    .replace(/Only one real market provider was available; analysis is allowed with reduced confidence\.?/gi, "仅有一个真实行情源可用，分析会降低权重。")
    .replace(/Index quote changePercent rejected:\s*/gi, "指数 quote 百分比已拒绝：")
    .replace(/provider previousClose differs from real candle previous close by ([\d.]+)%; using adjacent real index candles for daily change\.?/gi, "provider 前收盘与真实K线前收盘差异 $1%，已用相邻真实指数K线计算当日涨跌。")
    .replace(/This operation was aborted/g, "请求超时")
    .replace(/Stooq CSV download requires captcha\/API key/g, "Stooq 需要 API key/captcha")
    .replace(/Stooq[\s\S]*?(captcha|verify your browser|__verify)[\s\S]*$/gi, "Stooq 需要浏览器验证/API key")
    .replace(/quota has been exceeded|quota exceeded|The quota has been exceeded/gi, "外部数据源额度已用尽")
    .replace(/Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED|ECONNREFUSED/gi, "本地后端未连接")
    .replace(/\bLoad failed\b/gi, "真实数据源请求失败")
    .slice(0, 260);
}

function actionLabel(action) {
  return {
    STRONG_BUY: "强买入",
    WATCH_BUY: "买入观察",
    LIGHT_BUY: "轻仓关注",
    HOLD_WATCH: "继续观察",
    AVOID_OR_REDUCE: "规避/减仓",
    STRONG_AVOID: "强风险规避",
    CRITICAL_SELL: "最严卖出警报",
    BUY_ADD: "加仓记录",
    SELL_REDUCE: "减仓记录",
    SELL_EXIT: "清仓记录",
  }[action] || action || "待分析";
}

function isBuyAction(action) {
  return ["STRONG_BUY", "WATCH_BUY", "LIGHT_BUY"].includes(action);
}

function isStrictBuyAction(action) {
  return ["STRONG_BUY", "WATCH_BUY"].includes(action);
}

function isRiskAction(action) {
  return ["AVOID_OR_REDUCE", "STRONG_AVOID", "CRITICAL_SELL"].includes(action);
}

function errorLabel(kind) {
  return {
    market: "真实行情未接入",
    analysis: "分析失败",
    data: "数据不足",
  }[kind] || "处理失败";
}

function watchSourceLabel(source) {
  return {
    default: "默认池",
    legacy: "旧澳股池",
    saved: "已保存",
    manual: "手动添加",
    holding: "持仓",
    csv: "CSV持仓",
    text: "文本持仓",
    screenshot: "截图持仓",
    "app-buy": "软件买入",
    "ai-pick": "AI选股",
    gainer: "涨幅榜",
    loser: "跌幅榜",
    "dragon-tiger": "龙虎榜",
    mover: "榜单",
    universe: "股票池",
    snapshot: "快照",
    analysis: "分析结果",
  }[source] || "自选";
}

function tagClass(value, goodAt, badAt) {
  if (value >= goodAt) return "good";
  if (value <= badAt) return "danger";
  return "warn";
}

function factorTotal(factors) {
  if (!factors) return 0;
  return ["announcements", "shortInterest", "macro", "sector", "socialMedia", "flowOptions", "marketRegime", "relativeStrength", "liquidity", "calibration"]
    .reduce((sum, key) => sum + Number(factors[key]?.available === false ? 0 : factors[key]?.score || 0), 0);
}

function factorCoverageForItem(item) {
  const signal = item?.analysis?.factorSignal || item?.analysis?.ensemble;
  const liveRows = factorRows(item?.factors).filter(([, factor]) => factor && factor.available !== false);
  const checked = Number(item?.analysis?.factorSignal?.checked || item?.analysis?.factorSignal?.enabledFactors?.length || 0);
  if (checked > 0 || liveRows.length) return checked || liveRows.length;
  const technicals = normalizeTechnicals(item?.technicals);
  const hasTechnicals = Number(technicals.close) > 0 && [technicals.trendScore, technicals.momentumScore, technicals.riskScore].some((value) => Number.isFinite(Number(value)));
  return hasTechnicals || signal?.configuredFactorScore != null ? 1 : 0;
}

function technicalFactorProxy(item) {
  const technicals = normalizeTechnicals(item?.technicals);
  if (!technicals.close) return NaN;
  const trend = clamp((technicals.trendScore - 50) * 0.18, -9, 9);
  const momentum = clamp((technicals.momentumScore - 50) * 0.14, -7, 7);
  const risk = clamp((technicals.riskScore - 50) * 0.1, -5, 5);
  const volume = clamp((technicals.volumeRatio - 1) * 3.2, -4, 5);
  const macd = clamp(technicals.macdHistogram * 12, -4, 4);
  const analog = clamp((Number(item?.analog?.strategyHitProbability ?? item?.analog?.targetHitRate ?? 50) - 50) * 0.08, -4, 4);
  return clamp(trend + momentum + risk + volume + macd + analog, -25, 25);
}

function factorScoreForItem(item) {
  const analysis = normalizeAnalysis(item?.analysis);
  const liveTotal = factorTotal(item?.factors);
  const signalScore = Number(analysis.factorSignal?.score);
  if (Number.isFinite(signalScore) && (Math.abs(signalScore) > 0.001 || Number(analysis.factorSignal?.checked || 0) > 0)) return signalScore;
  const configured = Number(analysis.featureScores?.factor ?? analysis.ensemble?.configuredFactorScore);
  if (Number.isFinite(configured) && Math.abs(configured) > 0.001) return configured;
  if (Number.isFinite(liveTotal) && Math.abs(liveTotal) > 0.001) return clamp(liveTotal, -25, 25);
  const proxy = technicalFactorProxy(item);
  return Number.isFinite(proxy) ? proxy : 0;
}

function factorRows(factors) {
  if (!factors) return [];
  return [
    [state.market === "US" ? "SEC/公告" : "公告", factors.announcements],
    [state.market === "ASX" ? "空头" : "资金/空头", factors.shortInterest],
    ["宏观", factors.macro],
    ["行业", factors.sector],
    ["Reddit社媒", factors.socialMedia],
    [state.market === "US" ? "期权隐波" : state.market === "CN" ? "两融/北向" : "资金/期权", factors.flowOptions],
    ["市场状态", factors.marketRegime],
    ["相对强弱", factors.relativeStrength],
    ["流动性", factors.liquidity],
    ["回测校准", factors.calibration],
  ].filter(([, factor]) => factor);
}

async function fetchMarket(symbol) {
  const normalized = normalizeSymbol(symbol);
  const key = `market:${state.market}:${normalized}`;
  const cached = state.marketCache.get(key);
  if (cached && Date.now() - cached.time < 60 * 1000) return cached.value;
  const response = await fetch(`/api/market/${encodeURIComponent(normalized || symbol)}?market=${encodeURIComponent(state.market)}&range=9mo&interval=1d`);
  if (!response.ok) throw new Error((await response.json()).error || `无法读取 ${symbol}`);
  const value = await response.json();
  if (safeMarket(value.market || state.market) !== state.market) throw new Error(`${symbol} 返回了错误市场 ${value.market}`);
  const returnedSymbol = normalizeSymbolForMarket(value.symbol || symbol, state.market);
  if (!returnedSymbol || returnedSymbol !== normalized) throw new Error(`${symbol} 返回了跨市场或不匹配代码 ${value.symbol || ""}`);
  value.candles = normalizeCandles(value.candles);
  state.marketCache.set(key, { time: Date.now(), value });
  if (state.marketCache.size > 80) state.marketCache.delete(state.marketCache.keys().next().value);
  return value;
}

async function cachedJson(key, url, ttlMs) {
  const cached = state.apiCache.get(key);
  if (cached && Date.now() - cached.time < ttlMs) return cached.value;
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.json()).error || `请求失败: ${url}`);
  const value = await response.json();
  state.apiCache.set(key, { time: Date.now(), value });
  return value;
}

function chartFetchRange(interval) {
  return interval === "1wk" ? "2y" : interval === "1mo" ? "5y" : interval === "1d" ? "9mo" : "5d";
}

function chartDataKey(symbol, interval, market = state.market) {
  return `${market}:${symbol}:${chartFetchRange(interval)}:${interval}`;
}

async function fetchMarketChartPayload(symbol, range, interval) {
  const response = await fetch(`/api/market/${encodeURIComponent(symbol)}?market=${encodeURIComponent(state.market)}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`);
  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }
    throw new Error(payload.error || `无法读取 ${symbol} ${interval}`);
  }
  return response.json();
}

function chartFallbackReadout(cachedChart = null) {
  const note = cachedChart?.degraded && cachedChart?.actualInterval
    ? `当前显示 ${cachedChart.actualInterval} 真实日线；${cachedChart.requestedInterval || state.chartInterval} 源不可用`
    : "";
  return `${note ? `${note} · ` : ""}滚轮/触控板缩放 X 轴，拖拽平移，悬停查看 OHLC`;
}

async function fetchChartMarket(symbol, interval) {
  if (interval === "1d") return normalizeCandles(state.analyses.get(symbol)?.candles || []);
  const range = chartFetchRange(interval);
  const key = chartDataKey(symbol, interval);
  const cached = state.chartDataCache.get(key);
  if (cached && Date.now() - cached.time < 60000) return normalizeCandles(cached.candles);
  try {
    const payload = await fetchMarketChartPayload(symbol, range, interval);
    const candles = normalizeCandles(payload.candles);
    if (!candles.length) throw new Error(`无法读取 ${symbol} ${interval}`);
    state.chartDataCache.set(key, { time: Date.now(), candles, source: payload.source, warning: payload.warning, actualInterval: interval });
    return candles;
  } catch (error) {
    const originalMessage = error.message || String(error);
    let fallbackPayload = null;
    let candles = normalizeCandles(state.analyses.get(symbol)?.candles || []);
    try {
      if (!candles.length) {
        fallbackPayload = await fetchMarketChartPayload(symbol, "9mo", "1d");
        candles = normalizeCandles(fallbackPayload.candles);
      }
    } catch (fallbackError) {
      throw new Error(`${originalMessage}；日线降级也失败：${fallbackError.message || fallbackError}`);
    }
    if (!candles.length) throw error;
    state.chartDataCache.set(key, {
      time: Date.now(),
      candles,
      source: fallbackPayload?.source || state.analyses.get(symbol)?.source || "analysis-daily-real",
      warning: `${state.market} ${interval} 周期真实源未返回，已降级为 1d 真实日线。${originalMessage}${fallbackPayload?.warning ? ` | ${fallbackPayload.warning}` : ""}`,
      requestedInterval: interval,
      actualInterval: "1d",
      degraded: true,
    });
    return candles;
  }
}

function indexSignalFromRows(rows = []) {
  const available = rows.filter((row) => row?.technicals?.close > 0);
  if (!available.length) return { score: 0, stance: "mixed", confidenceBias: 0, projectedBias: 0 };
  const avg1d = available.reduce((sum, row) => sum + Number(row.change1d || 0), 0) / available.length;
  const avg5d = available.reduce((sum, row) => sum + Number(row.technicals.change5d || 0), 0) / available.length;
  const avg20d = available.reduce((sum, row) => sum + Number(row.technicals.change20d || 0), 0) / available.length;
  const avgTrend = available.reduce((sum, row) => sum + Number(row.technicals.trendScore || 50), 0) / available.length;
  const score = clamp(avg1d * 3 + avg5d * 0.8 + avg20d * 0.35 + (avgTrend - 50) * 0.18, -12, 12);
  return {
    score,
    avg1d,
    avg5d,
    avg20d,
    stance: score > 3 ? "risk-on" : score < -3 ? "risk-off" : "mixed",
    confidenceBias: clamp(score * 0.35, -4, 4),
    projectedBias: clamp(score * 0.08, -0.9, 0.9),
  };
}

function reliableIndexChangePercent(marketPayload = {}, candles = []) {
  const rows = normalizeCandles(candles);
  const latest = rows.at(-1) || {};
  const previous = rows.at(-2) || {};
  const candleChange = pctChange(latest.close, previous.close);
  const quote = marketPayload.quote || {};
  const quoteChange = Number(quote.changePercent);
  const quoteDate = String(quote.date || "").slice(0, 10);
  const latestDate = String(latest.date || "").slice(0, 10);
  const quotePlausible = Number.isFinite(quoteChange)
    && Math.abs(quoteChange) <= 12
    && quote.invalidChangePercent !== true
    && (!latestDate || !quoteDate || quoteDate === latestDate)
    && !quote.unavailable;
  if (quotePlausible) {
    return {
      value: quoteChange,
      source: "quote",
      rejected: false,
      rejectedValue: null,
      reason: "",
    };
  }
  return {
    value: candleChange,
    source: "candles",
    rejected: Number.isFinite(quoteChange),
    rejectedValue: quoteChange,
    reason: Number.isFinite(quoteChange)
      ? quote.invalidChangePercent === true
        ? quote.note || `quote 涨跌幅异常 ${formatPct(quoteChange)}`
        : `quote 涨跌幅异常 ${formatPct(quoteChange)}`
      : "",
  };
}

function indexRowMatchesConfig(row, index) {
  const symbols = [row?.displaySymbol, row?.symbol].filter(Boolean).map((symbol) => normalizeSymbolForMarket(symbol, state.market));
  const expected = normalizeSymbolForMarket(index?.symbol || "", state.market);
  return expected && symbols.includes(expected);
}

function isUsableIndexRow(row) {
  return !row?.error && Number(row?.close || row?.technicals?.close || 0) > 0;
}

function marketIndexRowsComplete(rows = []) {
  const expected = activeMarketConfig().indexes || [];
  if (!Array.isArray(rows) || !rows.length) return false;
  if (["ASX", "US"].includes(state.market) && rows.some((row) => row?.proxyUsed)) return false;
  if (!expected.length) return rows.some(isUsableIndexRow);
  return expected.every((index) => rows.some((row) => indexRowMatchesConfig(row, index) && isUsableIndexRow(row)));
}

function marketIndexRowLatestDate(row) {
  const direct = String(row?.latestDate || row?.quote?.date || "").slice(0, 10);
  if (direct) return direct;
  const candles = normalizeCandles(row?.candles);
  return String(candles.at(-1)?.date || "").slice(0, 10);
}

function marketIndexRowsCurrentForSession(rows = [], session = marketState()) {
  if (!marketIndexRowsComplete(rows) || !session?.dateKey) return false;
  const expected = activeMarketConfig().indexes || [];
  if (!expected.length) {
    return rows.some((row) => isUsableIndexRow(row) && marketIndexRowLatestDate(row) >= session.dateKey);
  }
  return expected.every((index) => {
    const row = rows.find((item) => indexRowMatchesConfig(item, index) && isUsableIndexRow(item));
    const latestDate = marketIndexRowLatestDate(row);
    return latestDate && latestDate >= session.dateKey;
  });
}

function marketIndexStartupHint() {
  const stateNow = marketState();
  if (marketIndexRowsComplete(state.marketIndexes)) {
    if (stateNow.canRefresh && !marketIndexRowsCurrentForSession(state.marketIndexes, stateNow)) {
      return "本地大盘快照不是当前交易日，正在读取真实指数源。";
    }
    return "";
  }
  if (stateNow.canRefresh) return "点击“更新大盘”读取真实指数源。";
  if (getRuntimeSettings().allowOffHoursFetch) {
    return "休市保护已开启，启动时优先不消耗外部额度；点击“更新大盘”可手动读取真实免费源/现金点位。";
  }
  return "休市中仅使用本地快照；若快照不完整，请打开“休市也允许刷新免 API 源”后手动更新大盘。";
}

function loadMarketIndexSnapshot() {
  const payload = readJsonStorage(indexSnapshotKey(), null);
  if (!payload || payload.market !== state.market || !Array.isArray(payload.rows)) return false;
  if (!marketIndexRowsComplete(payload.rows)) {
    safeStorage.removeItem(indexSnapshotKey());
    return false;
  }
  state.marketIndexes = payload.rows;
  state.marketIndexSignal = payload.signal || indexSignalFromRows(payload.rows);
  renderMarketIndexPanel();
  return true;
}

function saveMarketIndexSnapshot(rows, signal) {
  const payload = {
    market: state.market,
    updatedAt: new Date().toISOString(),
    rows,
    signal,
  };
  safeStorage.setItem(indexSnapshotKey(), JSON.stringify(payload));
}

function indexChartRangeCount(range = state.indexChartRange) {
  return {
    "5D": 80,
    "1M": 120,
    "3M": 90,
    "6M": 130,
    "1Y": 260,
    "2Y": 520,
    "5Y": 1200,
  }[range] || 130;
}

function indexChartFetchRange(interval = state.indexChartInterval, range = state.indexChartRange) {
  if (interval === "1wk") return range === "5Y" ? "5y" : "2y";
  if (interval === "1mo") return "5y";
  if (interval === "1d") return range === "2Y" ? "2y" : range === "5Y" ? "5y" : "1y";
  return range === "5D" ? "5d" : "1mo";
}

function indexChartDataKey(symbol, interval = state.indexChartInterval, range = state.indexChartRange, market = state.market) {
  return `index:${market}:${symbol}:${indexChartFetchRange(interval, range)}:${interval}`;
}

function selectedMarketIndexRow(rowsOverride = null) {
  const sourceRows = Array.isArray(rowsOverride)
    ? rowsOverride
    : (state.marketIndexes?.length ? state.marketIndexes : activeMarketConfig().indexes || []);
  const rows = (sourceRows || []).filter((row) => !row?.error);
  if (!rows.length) return null;
  const saved = state.marketIndexChartSymbol || safeStorage.getItem("marketIndexChartSymbol");
  const selected = rows.find((row) => row.symbol === saved || row.displaySymbol === saved);
  return selected || rows[0];
}

function saveIndexChartView() {
  safeStorage.setItem("marketIndexChartSymbol", state.marketIndexChartSymbol || "");
  safeStorage.setItem("indexChartInterval", state.indexChartInterval || "1d");
  safeStorage.setItem("indexChartRange", state.indexChartRange || "6M");
  safeStorage.setItem("indexChartZoom", String(state.indexChartZoom || 1));
}

function visibleIndexCandles(sourceCandles) {
  const source = normalizeCandles(sourceCandles);
  const baseCount = Math.min(source.length, indexChartRangeCount());
  const baseStart = Math.max(0, source.length - baseCount);
  const maxZoom = Math.max(1, baseCount / 18);
  state.indexChartZoom = clamp(Number(state.indexChartZoom || 1), 1, maxZoom);
  const visibleCount = Math.max(8, Math.min(baseCount, Math.round(baseCount / state.indexChartZoom)));
  const maxOffset = Math.max(0, baseCount - visibleCount);
  state.indexChartOffset = clamp(Math.round(Number(state.indexChartOffset || 0)), 0, maxOffset);
  const end = source.length - state.indexChartOffset;
  const start = Math.max(baseStart, end - visibleCount);
  return {
    candles: source.slice(start, end),
    baseCount,
    visibleCount,
    maxOffset,
    zoom: state.indexChartZoom,
  };
}

async function fetchIndexChartCandles(row, interval = state.indexChartInterval) {
  if (!row?.symbol) return [];
  const daily = normalizeCandles(row.candles || []);
  if (row.closeOnly && daily.length) return daily;
  if (interval === "1d" && daily.length) return daily;
  const range = indexChartFetchRange(interval);
  const key = indexChartDataKey(row.symbol, interval);
  const cached = state.chartDataCache.get(key);
  if (cached && Date.now() - cached.time < 60000) return normalizeCandles(cached.candles);
  try {
    const payload = await fetchMarketChartPayload(row.symbol, range, interval);
    const candles = normalizeCandles(payload.candles);
    if (!candles.length) throw new Error(`无法读取 ${row.symbol} ${interval}`);
    state.chartDataCache.set(key, { time: Date.now(), candles, source: payload.source, warning: payload.warning, actualInterval: interval });
    return candles;
  } catch (error) {
    if (!daily.length) throw error;
    state.chartDataCache.set(key, {
      time: Date.now(),
      candles: daily,
      source: row.source || "index-daily-real",
      warning: `${interval} 指数K线源不可用，已降级显示真实日线。${error.message || error}`,
      requestedInterval: interval,
      actualInterval: "1d",
      degraded: true,
    });
    return daily;
  }
}

function indexChartControlsHtml(rows = []) {
  const selected = selectedMarketIndexRow(rows);
  const closeOnly = Boolean(selected?.closeOnly || normalizeCandles(selected?.candles).some((row) => row.closeOnly));
  const effectiveInterval = closeOnly ? "1d" : state.indexChartInterval;
  const intervals = [
    ["5m", "5m"],
    ["15m", "15m"],
    ["60m", "60m"],
    ["1d", "日"],
    ["1wk", "周"],
    ["1mo", "月"],
  ];
  const ranges = ["5D", "1M", "3M", "6M", "1Y", "2Y", "5Y"];
  return `
    <div class="index-chart-toolbar">
      <div class="chart-tabs index-symbol-tabs">
        ${rows.map((row) => `<button class="range-btn ${selected?.symbol === row.symbol ? "active" : ""}" type="button" data-index-symbol="${escapeHtml(row.symbol)}">${escapeHtml(row.label || row.symbol)}</button>`).join("")}
      </div>
      <div class="chart-tabs">
        ${intervals.map(([value, label]) => {
          const disabled = closeOnly && value !== "1d";
          return `<button class="range-btn ${effectiveInterval === value ? "active" : ""}" type="button" data-index-interval="${value}" ${disabled ? "disabled title=\"该公开快照源仅提供日线收盘历史\"" : ""}>${label}</button>`;
        }).join("")}
        ${ranges.map((range) => `<button class="range-btn ${state.indexChartRange === range ? "active" : ""}" type="button" data-index-range="${range}">${range}</button>`).join("")}
      </div>
      <div class="chart-tools">
        <div id="indexChartReadout" class="chart-readout muted">滚轮/触控板缩放 X 轴，拖拽平移，悬停查看指数 OHLC</div>
        <button class="secondary mini-btn" type="button" data-index-chart-reset>重置</button>
      </div>
    </div>
  `;
}

function indexPointSnapshotHtml(selected) {
  const quote = selected.quote || {};
  const price = Number(selected.close || quote.price || 0);
  const previousClose = Number(quote.previousClose || 0);
  const change = Number.isFinite(Number(selected.change1d))
    ? Number(selected.change1d)
    : previousClose > 0
      ? pctChange(price, previousClose)
      : 0;
  const source = selected.source || quote.source || "real-index-quote";
  return `
    <div class="index-point-snapshot">
      <div>
        <span>现金指数点位</span>
        <strong>${formatIndexValue(selected)}</strong>
        <small>${escapeHtml(selected.latestDate || quote.date || "")} · ${escapeHtml(source)}</small>
      </div>
      <div class="index-point-meter ${change >= 0 ? "up" : "down"}">
        <span>当日</span>
        <strong>${formatPct(change)}</strong>
        <small>历史 OHLC 源未返回，K线/MACD/成交量暂停</small>
      </div>
      <p>${escapeHtml(compactDisplayError(selected.warning || "当前仅显示真实现金指数点位；不会用 ETF 或模拟数据补成K线。"))}</p>
    </div>
  `;
}

function marketIndexChartHtml(rows = []) {
  const selected = selectedMarketIndexRow(rows);
  if (!selected) return "";
  const candles = normalizeCandles(selected.candles);
  const closeOnly = Boolean(selected.closeOnly || candles.some((row) => row.closeOnly));
  const hasHistoricalCandles = !selected.quoteOnly && !closeOnly && candles.length > 1;
  const hasCloseLine = !selected.quoteOnly && closeOnly && candles.length > 1;
  const title = hasHistoricalCandles ? "大盘K线" : hasCloseLine ? "收盘线/MACD" : "现金点位快照";
  const subtitle = hasHistoricalCandles
    ? "指数图使用真实指数/官方点位数据；分钟线源不可用时降级为真实日线，不用 ETF 价格冒充指数。"
    : hasCloseLine
      ? "当前使用无 API 公开现金指数收盘历史；只画收盘线和基于收盘价的 MACD，不推断 OHLC/成交量。"
      : "当前仅有真实现金指数点位；历史K线源未返回时不会用 ETF 冒充，趋势预测暂停。";
  const chartTag = hasHistoricalCandles ? "真实K线" : hasCloseLine ? "真实收盘线" : "点位快照";
  return `
    <div class="index-chart-card">
      <div class="quant-result-head">
        <div>
          <h3>${escapeHtml(selected.label || selected.symbol)} · ${title}</h3>
          <p class="muted small-text">${subtitle}</p>
        </div>
        <span class="tag ${hasHistoricalCandles || hasCloseLine ? "good" : "warn"}">${chartTag}</span>
      </div>
      ${indexChartControlsHtml(rows)}
      ${hasHistoricalCandles || hasCloseLine ? `
        <div class="index-chart-layer">
          <canvas id="indexPriceChart" height="280"></canvas>
          <canvas id="indexVolumeChart" height="80"></canvas>
          <canvas id="indexMacdChart" height="110"></canvas>
        </div>
      ` : indexPointSnapshotHtml(selected)}
    </div>
  `;
}

function drawIndexChart(row = selectedMarketIndexRow()) {
  const priceCanvas = $("indexPriceChart");
  const volumeCanvas = $("indexVolumeChart");
  const macdCanvas = $("indexMacdChart");
  if (!row || !priceCanvas || !volumeCanvas || !macdCanvas) return;
  const key = indexChartDataKey(row.symbol);
  const cached = state.chartDataCache.get(key);
  const rowCloseOnly = Boolean(row.closeOnly);
  let source = normalizeCandles(rowCloseOnly || state.indexChartInterval === "1d" ? row.candles : cached?.candles);
  if (!source.length) {
    drawLoading(priceCanvas, `正在读取 ${state.indexChartInterval} 指数K线...`);
    drawLoading(volumeCanvas, "等待指数成交量");
    drawLoading(macdCanvas, "等待 MACD");
    if (!state.indexChartLoading.has(key)) {
      state.indexChartLoading.add(key);
      fetchIndexChartCandles(row, state.indexChartInterval)
        .then(() => drawIndexChart(row))
        .catch((error) => {
          drawLoading(priceCanvas, `${state.indexChartInterval} 指数K线不可用：${error.message || error}`);
          drawLoading(volumeCanvas, "真实指数源未返回");
          drawLoading(macdCanvas, "真实指数源未返回");
        })
        .finally(() => state.indexChartLoading.delete(key));
    }
    return;
  }
  const view = visibleIndexCandles(source);
  const candles = view.candles;
  if (!candles.length) return;
  const closeOnly = Boolean(rowCloseOnly || candles.some((item) => item.closeOnly));
  const hoverIndex = state.indexChartHoverIndex == null ? null : clamp(state.indexChartHoverIndex, 0, candles.length - 1);
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);
  const closes = candles.map((item) => item.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const vwap = closeOnly ? [] : cumulativeVwapSeries(candles);
  const bollinger = bollingerChartSeries(candles);
  const priceBounds = chartBounds([...highs, ...lows, ...sma20, ...sma50, ...vwap, ...bollinger.upper, ...bollinger.lower], 0.06);
  const price = setupCanvas(priceCanvas);
  drawGrid(price.ctx, price.width, price.height);
  drawAxis(price.ctx, priceBounds, price.width, price.height, (value) => formatCompactNumber(value, row.unit === "points" ? 1 : 2));
  const candleWidth = Math.max(3, Math.min(12, (price.width - 62) / candles.length * 0.62));
  if (closeOnly) {
    drawSeriesLine(price.ctx, closes, priceBounds, price.width, price.height, "#43e08a", 1.8);
  } else {
    candles.forEach((item, index) => {
      const x = xFor(index, candles.length, price.width);
      const yHigh = yFor(item.high, priceBounds.min, priceBounds.max, price.height);
      const yLow = yFor(item.low, priceBounds.min, priceBounds.max, price.height);
      const yOpen = yFor(item.open, priceBounds.min, priceBounds.max, price.height);
      const yClose = yFor(item.close, priceBounds.min, priceBounds.max, price.height);
      const up = item.close >= item.open;
      price.ctx.strokeStyle = up ? "#43e08a" : "#ff657d";
      price.ctx.fillStyle = up ? "rgba(67, 224, 138, 0.82)" : "rgba(255, 101, 125, 0.82)";
      price.ctx.beginPath();
      price.ctx.moveTo(x, yHigh);
      price.ctx.lineTo(x, yLow);
      price.ctx.stroke();
      price.ctx.fillRect(x - candleWidth / 2, Math.min(yOpen, yClose), candleWidth, Math.max(2, Math.abs(yClose - yOpen)));
    });
  }
  drawSeriesLine(price.ctx, sma20, priceBounds, price.width, price.height, "#38bdf8", 1.35);
  drawSeriesLine(price.ctx, sma50, priceBounds, price.width, price.height, "#f59e0b", 1.35);
  if (!closeOnly) drawSeriesLine(price.ctx, vwap, priceBounds, price.width, price.height, "#2fd6c9", 1.35);
  price.ctx.setLineDash([4, 4]);
  drawSeriesLine(price.ctx, bollinger.upper, priceBounds, price.width, price.height, "rgba(96, 165, 250, 0.76)", 1.1);
  drawSeriesLine(price.ctx, bollinger.lower, priceBounds, price.width, price.height, "rgba(96, 165, 250, 0.76)", 1.1);
  price.ctx.setLineDash([]);
  const latestCloseUp = candles.at(-1)?.close >= (closeOnly ? candles.at(-2)?.close || candles.at(-1)?.close : candles.at(-1)?.open);
  drawLastPriceMarker(price.ctx, candles.at(-1)?.close, priceBounds, price.width, price.height, latestCloseUp ? "#43e08a" : "#ff657d");
  drawTimeAxis(price.ctx, candles, price.width, price.height);
  if (cached?.degraded) {
    price.ctx.fillStyle = "rgba(246, 196, 83, 0.92)";
    price.ctx.font = "11px Inter, system-ui, sans-serif";
    price.ctx.fillText(`${cached.requestedInterval || state.indexChartInterval} -> ${cached.actualInterval || "1d"} real fallback`, 54, 30);
  }
  price.ctx.fillStyle = "rgba(216, 231, 248, 0.92)";
  price.ctx.font = "10px Inter, system-ui, sans-serif";
  price.ctx.fillText(closeOnly ? "Close / SMA20 / SMA50 / BOLL" : "SMA20 / SMA50 / VWAP / BOLL", 54, 16);

  const volume = setupCanvas(volumeCanvas);
  if (closeOnly) {
    drawLoading(volumeCanvas, "该公开快照源不含真实成交量；等待 Marketstack/交易所 OHLCV 源");
  } else {
    drawGrid(volume.ctx, volume.width, volume.height);
    const maxVolume = Math.max(1, ...candles.map((item) => Number(item.volume || 0)));
    drawAxis(volume.ctx, { min: 0, max: maxVolume }, volume.width, volume.height, (value) => formatCompactNumber(value, 1));
    candles.forEach((item, index) => {
      const x = xFor(index, candles.length, volume.width);
      const barHeight = Number(item.volume || 0) / maxVolume * (volume.height - 28);
      volume.ctx.fillStyle = item.close >= item.open ? "rgba(67, 224, 138, 0.62)" : "rgba(255, 101, 125, 0.62)";
      volume.ctx.fillRect(x - candleWidth / 2, volume.height - 18 - barHeight, candleWidth, Math.max(1, barHeight));
    });
    drawTimeAxis(volume.ctx, candles, volume.width, volume.height);
  }

  const macdSeries = computeMacdSeries(candles);
  const macd = setupCanvas(macdCanvas);
  const macdBounds = chartBounds([...macdSeries.macd, ...macdSeries.signal, ...macdSeries.histogram], 0.18);
  drawGrid(macd.ctx, macd.width, macd.height);
  drawAxis(macd.ctx, macdBounds, macd.width, macd.height, (value) => formatCompactNumber(value, 2));
  const zeroY = yFor(0, macdBounds.min, macdBounds.max, macd.height);
  macd.ctx.strokeStyle = "rgba(142, 163, 186, 0.46)";
  macd.ctx.beginPath();
  macd.ctx.moveTo(48, zeroY);
  macd.ctx.lineTo(macd.width - 14, zeroY);
  macd.ctx.stroke();
  macdSeries.histogram.forEach((value, index) => {
    const x = xFor(index, macdSeries.histogram.length, macd.width);
    const y = yFor(value, macdBounds.min, macdBounds.max, macd.height);
    macd.ctx.fillStyle = value >= 0 ? "rgba(67, 224, 138, 0.68)" : "rgba(255, 101, 125, 0.68)";
    macd.ctx.fillRect(x - candleWidth / 2, Math.min(y, zeroY), candleWidth, Math.max(1, Math.abs(zeroY - y)));
  });
  drawSeriesLine(macd.ctx, macdSeries.macd, macdBounds, macd.width, macd.height, "#38bdf8", 1.4);
  drawSeriesLine(macd.ctx, macdSeries.signal, macdBounds, macd.width, macd.height, "#f59e0b", 1.4);

  const readout = $("indexChartReadout");
  if (hoverIndex !== null) {
    [price, volume, macd].forEach((chart) => drawCrosshair(chart.ctx, hoverIndex, candles.length, chart.width, chart.height));
    const item = candles[hoverIndex];
    if (readout) {
      readout.textContent = closeOnly
        ? `${item.date} Close ${formatCompactNumber(item.close, 2)} MACD ${formatCompactNumber(macdSeries.macd[hoverIndex], 3)} / ${formatCompactNumber(macdSeries.signal[hoverIndex], 3)} · Zoom ${view.zoom.toFixed(2)}x`
        : `${item.date} O ${formatCompactNumber(item.open, 2)} H ${formatCompactNumber(item.high, 2)} L ${formatCompactNumber(item.low, 2)} C ${formatCompactNumber(item.close, 2)} Vol ${formatCompactNumber(item.volume, 1)} MACD ${formatCompactNumber(macdSeries.macd[hoverIndex], 3)} / ${formatCompactNumber(macdSeries.signal[hoverIndex], 3)} · Zoom ${view.zoom.toFixed(2)}x`;
    }
  } else if (readout) {
    const note = closeOnly
      ? "当前显示真实日线收盘历史；该源不含 OHLC/成交量 · "
      : cached?.degraded
        ? `当前显示 ${cached.actualInterval || "1d"} 真实K线；${cached.requestedInterval || state.indexChartInterval} 不可用 · `
        : "";
    readout.textContent = `${note}滚轮/触控板缩放 X 轴，拖拽平移，悬停查看指数 ${closeOnly ? "Close/MACD" : "OHLC"}`;
  }
  bindIndexChartEvents(row, candles);
}

function bindIndexChartEvents(row, candles) {
  const card = document.querySelector(".index-chart-card");
  if (!card || card.dataset.bound === "true") return;
  card.dataset.bound = "true";
  card.querySelectorAll("[data-index-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      state.marketIndexChartSymbol = button.dataset.indexSymbol;
      state.indexChartOffset = 0;
      state.indexChartZoom = 1;
      state.indexChartHoverIndex = null;
      saveIndexChartView();
      renderMarketIndexPanel();
    });
  });
  card.querySelectorAll("[data-index-interval]").forEach((button) => {
    button.addEventListener("click", () => {
      state.indexChartInterval = button.dataset.indexInterval || "1d";
      state.indexChartOffset = 0;
      state.indexChartZoom = 1;
      state.indexChartHoverIndex = null;
      saveIndexChartView();
      renderMarketIndexPanel();
    });
  });
  card.querySelectorAll("[data-index-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.indexChartRange = button.dataset.indexRange || "6M";
      state.indexChartOffset = 0;
      state.indexChartZoom = 1;
      state.indexChartHoverIndex = null;
      saveIndexChartView();
      drawIndexChart(row);
      card.querySelectorAll("[data-index-range]").forEach((item) => item.classList.toggle("active", item.dataset.indexRange === state.indexChartRange));
    });
  });
  card.querySelector("[data-index-chart-reset]")?.addEventListener("click", () => {
    state.indexChartOffset = 0;
    state.indexChartZoom = 1;
    state.indexChartHoverIndex = null;
    saveIndexChartView();
    drawIndexChart(row);
  });
  ["indexPriceChart", "indexVolumeChart", "indexMacdChart"].forEach((id) => {
    const canvas = $(id);
    if (!canvas) return;
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (sideways) {
        state.indexChartOffset = Math.max(0, Number(state.indexChartOffset || 0) + Math.round(event.deltaX / WHEEL_PAN_DIVISOR));
      } else {
        const factor = event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT;
        state.indexChartZoom = clamp(Number(state.indexChartZoom || 1) * factor, 1, 40);
      }
      saveIndexChartView();
      scheduleChartRedraw("index", () => drawIndexChart(row));
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => {
      state.indexChartDragging = { x: event.clientX, offset: Number(state.indexChartOffset || 0) };
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      if (state.indexChartDragging) {
        const barsPerPixel = candles.length / Math.max(1, rect.width - 62);
        state.indexChartOffset = Math.max(0, Math.round(state.indexChartDragging.offset - (event.clientX - state.indexChartDragging.x) * barsPerPixel));
        scheduleChartRedraw("index", () => drawIndexChart(row));
        return;
      }
      const ratio = clamp((event.clientX - rect.left - 48) / Math.max(1, rect.width - 62), 0, 1);
      state.indexChartHoverIndex = Math.round(ratio * (candles.length - 1));
      scheduleChartRedraw("index", () => drawIndexChart(row));
    });
    canvas.addEventListener("pointerup", () => {
      state.indexChartDragging = null;
      saveIndexChartView();
    });
    canvas.addEventListener("mouseleave", () => {
      state.indexChartHoverIndex = null;
      scheduleChartRedraw("index", () => drawIndexChart(row));
    });
  });
}

async function fetchIndexMarket(index) {
  const strictCashIndex = ["ASX", "US"].includes(state.market) && index.unit === "points";
  const rawCandidates = strictCashIndex
    ? [index.symbol]
    : [index.symbol, ...(index.fallbackSymbols || [])];
  const candidates = sanitizeSymbolsForMarket(rawCandidates, state.market);
  const errors = [];
  for (const symbol of candidates) {
    try {
      const market = await fetchMarket(symbol);
      const fallbackUsed = symbol !== normalizeSymbolForMarket(index.symbol, state.market);
      return {
        market,
        usedSymbol: symbol,
        fallbackUsed,
      };
    } catch (error) {
      errors.push(`${symbol}: ${error.message || error}`);
    }
  }
  if (strictCashIndex) {
    throw new Error(`${index.label} 现金指数点位暂不可用；真实指数源未返回，已拒绝用 ETF 价格替代点位。${errors.slice(0, 2).join(" | ")}`);
  }
  throw new Error(errors.join(" | ") || `${index.label} 无可用真实指数/ETF代理`);
}

async function refreshMarketIndexes(force = false) {
  const cached = readJsonStorage(indexSnapshotKey(), null);
  const cachedIsComplete = cached?.market === state.market && marketIndexRowsComplete(cached.rows);
  const previousRows = Array.isArray(state.marketIndexes) ? state.marketIndexes : [];
  const previousIsComplete = marketIndexRowsComplete(previousRows);
  const previousSignal = state.marketIndexSignal || indexSignalFromRows(previousRows);
  state.marketIndexUsedSnapshotFallback = false;
  if (!force && cachedIsComplete && Date.now() - new Date(cached.updatedAt || 0).getTime() < 3 * 60 * 1000) {
    state.marketIndexes = cached.rows;
    state.marketIndexSignal = cached.signal || indexSignalFromRows(cached.rows);
    renderMarketIndexPanel();
    return state.marketIndexes;
  }
  if (!force && !marketState().canRefresh && loadMarketIndexSnapshot()) return state.marketIndexes;

  const config = activeMarketConfig();
  const results = await Promise.allSettled((config.indexes || []).map(async (index) => {
    const indexMarket = await fetchIndexMarket(index);
    const market = indexMarket.market;
    const candles = normalizeCandles(market.candles);
    if (!candles.length) throw new Error(`${index.label} 无真实点位`);
    const closeOnly = Boolean(market.closeOnly || candles.some((row) => row.closeOnly));
    const quoteOnly = Boolean(market.quoteOnly || (!closeOnly && candles.length < 25) || candles.length < 2);
    const technicals = computeTechnicals(candles);
    const indexTechnicals = quoteOnly
      ? { ...technicals, change5d: 0, change20d: 0, trendScore: 50, momentumScore: 50, riskScore: 50, projectedUpside: 0 }
      : technicals;
    const analog = quoteOnly ? { count: 0, winRate: 0, averageForwardReturn: 0 } : computeHistoricalAnalog(candles, 15, getStrategy().horizonDays);
    const latest = candles.at(-1) || {};
    const changeModel = reliableIndexChangePercent(market, candles);
    const change1d = changeModel.value;
    const projectedUpside = quoteOnly ? 0 : clamp(technicals.projectedUpside * 0.72 + Number(analog.averageForwardReturn || 0) * 0.28, -8, 10);
    const confidence = quoteOnly ? 0 : clamp((technicals.trendScore + technicals.momentumScore + technicals.riskScore) / 3 + (analog.winRate ? (analog.winRate - 50) * 0.12 : 0), 0, 95);
    return {
      ...index,
      symbol: indexMarket.usedSymbol || index.symbol,
      displaySymbol: index.symbol,
      latestDate: String(latest.date || "").slice(0, 10),
      close: technicals.close,
      change1d,
      projectedUpside,
      confidence,
      unit: index.unit || (state.market === "US" && String(index.symbol || "").startsWith("^") ? "points" : ""),
      source: market.source,
      warning: [
        indexMarket.fallbackUsed ? `${index.symbol} 暂不可用，已使用 ${indexMarket.usedSymbol} 真实代理` : "",
        quoteOnly ? "当前仅显示真实现金指数点位；历史K线源暂不可用，指数趋势预测已暂停。" : "",
        closeOnly ? "当前指数历史来自无 API 公开收盘快照；趋势/MACD仅基于收盘价，未推断开高低和成交量。" : "",
        changeModel.rejected ? `指数 quote 百分比已拒绝：${changeModel.reason}，改用相邻真实点位计算当日涨跌。` : "",
        market.warning || "",
      ].filter(Boolean).join(" | "),
      candles: candles.slice(closeOnly ? -1300 : -260),
      quote: market.quote || null,
      quoteOnly,
      closeOnly,
      technicals: indexTechnicals,
      analog: {
        count: analog.count || 0,
        winRate: Number(analog.winRate || 0),
        averageForwardReturn: Number(analog.averageForwardReturn || 0),
      },
    };
  }));
  const rows = results.map((entry, index) => (
    entry.status === "fulfilled"
      ? entry.value
      : {
        ...(config.indexes || [])[index],
        error: normalizeApiErrorMessage(entry.reason?.message || String(entry.reason || "读取失败")),
      }
  ));
  if (!marketIndexRowsComplete(rows) && (previousIsComplete || cachedIsComplete)) {
    const errors = rows
      .filter((row) => row?.error)
      .map((row) => `${row.label || row.symbol}: ${compactDisplayError(row.error)}`)
      .slice(0, 3)
      .join(" | ");
    const fallbackSourceRows = previousIsComplete ? previousRows : cached.rows;
    const fallbackRows = fallbackSourceRows.map((row) => ({
      ...row,
      warning: [
        previousIsComplete
          ? `实时指数刷新未完整返回，已保留当前页面完整真实数据。${errors}`
          : `实时指数刷新失败，继续使用本地完整真实快照${cached.updatedAt ? `（${new Date(cached.updatedAt).toLocaleString()}）` : ""}。${errors}`,
        row.warning || "",
      ].filter(Boolean).join(" | "),
    }));
    state.marketIndexes = fallbackRows;
    state.marketIndexSignal = previousIsComplete ? previousSignal : cached.signal || indexSignalFromRows(fallbackRows);
    state.marketIndexUsedSnapshotFallback = true;
    renderMarketIndexPanel();
    return fallbackRows;
  }
  state.marketIndexes = rows;
  state.marketIndexSignal = indexSignalFromRows(rows);
  if (marketIndexRowsComplete(rows)) {
    saveMarketIndexSnapshot(rows, state.marketIndexSignal);
  }
  renderMarketIndexPanel();
  return rows;
}

function shouldHydrateMarketIndexes() {
  const session = marketState();
  const runtime = getRuntimeSettings();
  if (!session.canRefresh && !runtime.allowOffHoursFetch) return false;
  if (!marketIndexRowsComplete(state.marketIndexes)) return true;
  return session.canRefresh && !marketIndexRowsCurrentForSession(state.marketIndexes, session);
}

async function hydrateMarketIndexesIfNeeded(reason = "大盘快照不完整") {
  if (state.marketIndexRefreshing || !shouldHydrateMarketIndexes()) return false;
  const marketAtStart = state.market;
  state.marketIndexRefreshing = true;
  setStatus(`${reason}，正在读取${activeMarketConfig().label}真实免费指数源...`);
  let rows = [];
  try {
    rows = await refreshMarketIndexes(true);
  } catch (error) {
    console.warn("Unable to hydrate market indexes", error);
    if (state.market === marketAtStart) {
      loadMarketIndexSnapshot();
      renderMarketIndexPanel();
      setStatus(`${activeMarketConfig().label} 大盘指数自动补齐失败：${compactDisplayError(error.message || String(error))}`);
    }
    return false;
  } finally {
    state.marketIndexRefreshing = false;
  }
  if (state.market !== marketAtStart) return false;
  const complete = marketIndexRowsComplete(rows);
  try {
    renderCards();
    renderDetail();
  } catch (error) {
    console.warn("Market index hydration succeeded but a dependent panel failed to render", error);
  }
  if (state.marketIndexUsedSnapshotFallback) {
    setStatus(`${activeMarketConfig().label} 实时大盘源失败，已继续使用本地完整真实快照`);
    return true;
  }
  if (complete) {
    setStatus(`${activeMarketConfig().label} 大盘指数已用真实免费源补齐`);
    return true;
  }
  const failed = (rows || [])
    .filter((row) => row?.error)
    .map((row) => `${row.label || row.symbol}: ${compactDisplayError(row.error)}`)
    .slice(0, 2)
    .join("；");
  setStatus(`${activeMarketConfig().label} 大盘指数部分返回；${failed || "等待更多真实源"}`);
  return false;
}

function queueMarketIndexHydration(reason = "大盘快照不完整") {
  if (!shouldHydrateMarketIndexes()) return;
  if (state.marketIndexHydrationTimer) clearTimeout(state.marketIndexHydrationTimer);
  state.marketIndexHydrationTimer = setTimeout(() => {
    state.marketIndexHydrationTimer = null;
    hydrateMarketIndexesIfNeeded(reason);
  }, 80);
}

function dedupeNewsClient(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const key = `${item?.title || ""}|${item?.link || ""}`;
    if (!item?.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchNews(symbol, mode = "auto") {
  const encodedMarket = encodeURIComponent(state.market);
  const encodedSymbol = encodeURIComponent(symbol);
  const safeMode = ["local", "auto", "refresh", "live"].includes(String(mode || "").toLowerCase()) ? String(mode || "auto").toLowerCase() : "auto";
  const cacheKey = `news:${state.market}:${symbol}:all`;
  const url = `/api/news?market=${encodedMarket}&symbol=${encodedSymbol}&scope=all&mode=${encodeURIComponent(safeMode)}`;
  try {
    const payload = await requestJson(url);
    state.apiCache.set(cacheKey, { time: Date.now(), value: payload });
    if (payload.scope === "macro") state.apiCache.set(`news:${state.market}:__macro__`, { time: Date.now(), value: payload });
    safeStorage.setItem(`lastNewsOpen:${state.market}`, new Date().toISOString());
    return dedupeNewsClient(payload.news || []);
  } catch (error) {
    try {
      const [macro, stock] = await Promise.all([
        requestJson(`/api/news?market=${encodedMarket}&symbol=${encodedSymbol}&scope=macro&mode=${encodeURIComponent(safeMode)}`),
        requestJson(`/api/news?market=${encodedMarket}&symbol=${encodedSymbol}&scope=stock&mode=${encodeURIComponent(safeMode)}`),
      ]);
      state.apiCache.set(`news:${state.market}:__macro__`, { time: Date.now(), value: macro });
      state.apiCache.set(`news:${state.market}:${symbol}:stock`, { time: Date.now(), value: stock });
      return dedupeNewsClient([...(macro.news || []), ...(stock.news || [])]);
    } catch (fallbackError) {
      try {
        const payload = await requestJson(`/api/news?market=${encodedMarket}&symbol=${encodedSymbol}&scope=stock&mode=local`);
        state.apiCache.set(`news:${state.market}:${symbol}`, { time: Date.now(), value: payload });
        return dedupeNewsClient(payload.news || []);
      } catch (localError) {
        return [];
      }
    }
  }
}

function newsRefreshSymbolsForMarket(limit = 40) {
  return [...new Set([
    state.selected,
    ...[...state.analyses.keys()],
    ...state.watchlist,
  ].map((symbol) => normalizeSymbolForMarket(symbol, state.market)).filter(Boolean))].slice(0, limit);
}

async function refreshDueNewsOnOpen() {
  const symbol = state.selected || state.watchlist[0] || activeMarketConfig().defaultSymbols[0] || "";
  let health = null;
  try {
    health = await requestJson(`/api/data-health?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`);
  } catch (error) {
    console.warn("Unable to check news refresh schedule", error);
    return false;
  }
  const scheduleDue = Boolean(health?.refreshSchedule?.due);
  const cacheDue = Number(health?.newsCache?.summary?.dueCount || 0) > 0;
  if (!scheduleDue && !cacheDue) return false;
  const symbols = newsRefreshSymbolsForMarket(40);
  if (!symbols.length) return false;
  setStatus(`检测到错过新闻刷新窗口，后台补抓 ${symbols.length} 只股票新闻，不运行 AI 推理...`);
  const results = await Promise.allSettled(symbols.map(async (code) => {
    const news = await fetchNews(code, "auto");
    const item = state.analyses.get(code);
    if (item) {
      item.news = news;
      item.signalRefreshedAt = new Date().toISOString();
      state.analyses.set(code, item);
    }
    return news.length;
  }));
  const ok = results.filter((row) => row.status === "fulfilled").length;
  const count = results.reduce((sum, row) => sum + (row.status === "fulfilled" ? row.value : 0), 0);
  persistAnalysisSnapshot("scheduled-news-refresh");
  renderCards();
  renderDetail();
  if (state.activePage === "sources") await refreshDataHealth(false);
  setStatus(`新闻后台补抓完成：${ok}/${symbols.length} 只股票，当前可用新闻 ${count} 条；交易结论会在下一次刷新时重算。`);
  return true;
}

function redditWarmupSymbolsForMarket(limit = 60) {
  const portfolioSymbols = activePortfolio().map((holding) => holding.symbol);
  const analysisSymbols = [...state.analyses.keys()];
  const defaults = activeMarketConfig().defaultSymbols || [];
  return [...new Set([...portfolioSymbols, ...state.watchlist, ...analysisSymbols, ...defaults]
    .map((symbol) => normalizeSymbolForMarket(symbol, state.market))
    .filter(Boolean)
    .filter((symbol) => !String(symbol).startsWith("^")))]
    .slice(0, limit);
}

async function queueRedditSocialWarmup(reason = "auto", options = {}) {
  const symbols = redditWarmupSymbolsForMarket(options.maxSymbols || 60);
  if (!symbols.length) return null;
  const params = new URLSearchParams({
    market: state.market,
    symbols: symbols.join(","),
    limit: String(options.limit || 10),
    maxSymbols: String(options.maxSymbols || 60),
    reason,
  });
  if (options.force) params.set("force", "true");
  try {
    const payload = await requestJson(`/api/social/reddit/background?${params.toString()}`);
    state.redditWarmupStatus = payload;
    if (options.showStatus) {
      setStatus(`Reddit 社媒后台缓存已排队：新增 ${payload.queued || 0} / ${payload.requested || symbols.length}，页面刷新继续走本地缓存`);
    }
    return payload;
  } catch (error) {
    console.warn("Unable to queue Reddit social warmup", error);
    if (options.showStatus) setStatus(`Reddit 后台缓存排队失败：${compactDisplayError(error.message)}`);
    return null;
  }
}

function scheduleRedditSocialWarmup(reason = "auto", delay = 1800, options = {}) {
  if (state.redditWarmupTimer) clearTimeout(state.redditWarmupTimer);
  state.redditWarmupTimer = setTimeout(() => {
    state.redditWarmupTimer = null;
    queueRedditSocialWarmup(reason, options);
  }, Math.max(0, delay));
}

function cachedNewsValue(symbol) {
  const all = cachedSignalValue(`news:${state.market}:${symbol}:all`, { news: [] }).news || [];
  if (all.length) return dedupeNewsClient(all);
  const legacyStock = cachedSignalValue(`news:${state.market}:${symbol}`, { news: [] }).news || [];
  if (legacyStock.length) return dedupeNewsClient(legacyStock);
  const macro = cachedSignalValue(`news:${state.market}:__macro__`, { news: [] }).news || [];
  const stock = cachedSignalValue(`news:${state.market}:${symbol}:stock`, { news: [] }).news || [];
  return dedupeNewsClient([...macro, ...stock]);
}

async function fetchFundamentals(symbol) {
  try {
    const payload = await cachedJson(`fundamentals:${state.market}:${symbol}`, `/api/fundamentals?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, 60 * 60 * 1000);
    return payload.fundamentals || null;
  } catch (error) {
    return null;
  }
}

async function fetchX(symbol) {
  try {
    const payload = await cachedJson(`x:${state.market}:${symbol}`, `/api/x?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, 10 * 60 * 1000);
    return payload.posts || [];
  } catch (error) {
    return [];
  }
}

async function fetchYouTube(symbol) {
  try {
    const payload = await cachedJson(`youtube:${state.market}:${symbol}`, `/api/youtube?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, 15 * 60 * 1000);
    return payload.videos || [];
  } catch (error) {
    return [];
  }
}

async function fetchFactors(symbol) {
  try {
    const strategy = getStrategy();
    const payload = await cachedJson(
      `factors:${state.market}:${symbol}:${strategy.horizonDays}:${strategy.targetUpside}`,
      `/api/factors?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}&horizonDays=${encodeURIComponent(strategy.horizonDays)}&targetUpside=${encodeURIComponent(strategy.targetUpside)}`,
      10 * 60 * 1000
    );
    return payload.factors || null;
  } catch (error) {
    console.warn(`Factor layer unavailable for ${symbol}`, error);
    return null;
  }
}

function proxyFactorsForItem(item, reason = "factor-provider-unavailable") {
  const technicals = normalizeTechnicals(item?.technicals);
  const analog = item?.analog || {};
  const techScore = technicalFactorProxy(item);
  const trendScore = clamp((technicals.trendScore - 50) * 0.22 + (technicals.momentumScore - 50) * 0.18, -18, 18);
  const liquidityScore = clamp((technicals.volumeRatio - 1) * 6 + (technicals.riskScore - 50) * 0.05, -12, 12);
  const historyScore = clamp((Number(analog.strategyHitProbability ?? analog.targetHitRate ?? analog.winRate ?? 50) - 50) * 0.16, -12, 12);
  return {
    marketRegime: {
      source: "technical-proxy",
      score: Number(trendScore.toFixed(2)),
      thesis: [`趋势/动量代理：trend ${technicals.trendScore.toFixed(0)}，momentum ${technicals.momentumScore.toFixed(0)}。`],
      values: { proxy: true, reason },
    },
    liquidity: {
      source: "technical-proxy",
      score: Number(liquidityScore.toFixed(2)),
      thesis: [`流动性代理：量比 ${technicals.volumeRatio.toFixed(2)}，风险分 ${technicals.riskScore.toFixed(0)}。`],
      values: { proxy: true, reason },
    },
    calibration: {
      source: "history-proxy",
      score: Number(historyScore.toFixed(2)),
      thesis: [`历史/模型代理：策略达标样本 ${analog.count || 0}，命中 ${formatPct(analog.strategyHitProbability ?? analog.targetHitRate ?? analog.winRate ?? 0)}。`],
      values: { proxy: true, reason },
    },
    relativeStrength: {
      source: "technical-proxy",
      score: Number(techScore.toFixed(2)),
      thesis: [`综合技术代理因子 ${techScore.toFixed(1)}；真实因子源不可用时临时参与排序。`],
      values: { proxy: true, reason },
    },
  };
}

async function fetchAccuracySummary(force = false) {
  try {
    const key = `accuracy:${state.market}`;
    if (!force) {
      const cached = state.apiCache.get(key);
      if (cached && Date.now() - cached.time < 2 * 60 * 1000) {
        state.accuracySummary = cached.value;
        renderAccuracyPanel();
        return cached.value;
      }
    }
    if (force) {
      const synced = await syncPredictionUniverse();
      if (synced) return synced;
    }
    const activeSymbols = predictionActiveSymbols();
    const query = activeSymbols.length ? `&activeSymbols=${encodeURIComponent(activeSymbols.join(","))}` : "";
    const response = await fetch(`/api/accuracy?market=${encodeURIComponent(state.market)}${query}`);
    if (!response.ok) throw new Error((await response.json()).error || "无法读取准确率");
    const value = await response.json();
    state.apiCache.set(key, { time: Date.now(), value });
    state.accuracySummary = value;
    renderAccuracyPanel();
    return value;
  } catch (error) {
    console.warn("Unable to fetch accuracy summary", error);
    state.accuracySummary = null;
    renderAccuracyPanel();
    return null;
  }
}

function analysisSampleId(item, createdAt = new Date().toISOString()) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const strategy = getStrategy();
  const latest = (item.candles || []).at(-1) || {};
  const stamp = String(createdAt || new Date().toISOString()).replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${state.market}:${item.symbol}:${String(latest.date || "").slice(0, 10)}:${analysis.horizonDays || strategy.horizonDays}:${strategy.targetUpside}:${stamp}`;
}

function predictionSampleFromResult(item) {
  const analysis = normalizeAnalysis(item.analysis);
  if (!item?.symbol || analysis.action === "ERROR") return null;
  const technicals = normalizeTechnicals(item.technicals);
  const strategy = getStrategy();
  const latest = (item.candles || []).at(-1) || {};
  const asOfDate = String(latest.date || "").slice(0, 10);
  if (!asOfDate || !technicals.close) return null;
  const createdAt = new Date().toISOString();
  return {
    id: analysisSampleId(item, createdAt),
    market: state.market,
    symbol: item.symbol,
    asOfDate,
    createdAt,
    horizonDays: Number(analysis.horizonDays || strategy.horizonDays),
    targetUpside: Number(strategy.targetUpside || analysis.projectedUpside || 5),
    stopLoss: Number(strategy.stopLoss || 4),
    close: technicals.close,
    currentPrice: technicals.close,
    currentDate: latest.date || new Date().toISOString(),
    confidence: Number(analysis.confidence || 0),
    predictionConfidence: Number(analysis.predictionConfidence ?? analysis.confidence ?? 0),
    magnitudeConfidence: Number(analysis.magnitudeConfidence ?? analysis.magnitudeHitProbability ?? analysis.moveHitProbability ?? 0),
    magnitudeHitProbability: Number(analysis.magnitudeHitProbability ?? analysis.magnitudeConfidence ?? analysis.moveHitProbability ?? 0),
    moveHitProbability: Number(analysis.moveHitProbability ?? analysis.magnitudeHitProbability ?? analysis.magnitudeConfidence ?? 0),
    strategyConfidence: Number(analysis.strategyConfidence ?? analysis.strategyHitProbability ?? 0),
    strategyHitProbability: Number(analysis.strategyHitProbability ?? analysis.strategyConfidence ?? 0),
    rawConfidence: Number(analysis.rawConfidence ?? analysis.confidence ?? 0),
    projectedUpside: Number(analysis.projectedUpside || 0),
    projectedFinalReturn: Number(analysis.projectedFinalReturn ?? analysis.projectedUpside ?? 0),
    finalReturnConfidence: Number(analysis.finalReturnConfidence ?? analysis.finalReturnHitProbability ?? 0),
    finalReturnHitProbability: Number(analysis.finalReturnHitProbability ?? analysis.finalReturnConfidence ?? 0),
    projectedMaxUpside: Number(analysis.projectedMaxUpside ?? analysis.qualityGate?.projectedMaxUpside ?? 0),
    maxUpsideConfidence: Number(analysis.maxUpsideConfidence ?? analysis.maxUpsideHitProbability ?? 0),
    maxUpsideHitProbability: Number(analysis.maxUpsideHitProbability ?? analysis.maxUpsideConfidence ?? 0),
    direction: analysis.direction || "mixed",
    action: analysis.action,
    source: item.source || "unknown",
    sector: item?.fundamentals?.sector || sectorOf(item.symbol),
    calibration: analysis.calibration || null,
    strategyCalibration: analysis.strategyCalibration || null,
    marketRegime: analysis.ensemble?.marketRegime?.regime || item.factors?.marketRegime?.values?.regime || null,
    regimeBucket: analysis.ensemble?.marketRegime?.regime || null,
    ensemble: analysis.ensemble ? {
      direction: analysis.ensemble.direction,
      upsideAgreement: Number(analysis.ensemble.upsideAgreement || 0),
      consensusAgreement: Number(analysis.ensemble.consensusAgreement || 0),
      marketRegime: analysis.ensemble.marketRegime || null,
      models: (analysis.ensemble.models || []).map((model) => ({
        name: model.name,
        confidence: Number(model.confidence || 0),
        projectedUpside: Number(model.projectedUpside || 0),
        weight: Number(model.normalizedWeight || 0),
        available: model.available !== false,
      })),
    } : null,
    featureScores: {
      trend: technicals.trendScore,
      momentum: technicals.momentumScore,
      change5d: technicals.change5d,
      change20d: technicals.change20d,
      volumeRatio: technicals.volumeRatio,
      rsi: technicals.rsi,
      volume: technicals.volumeScore,
      risk: technicals.riskScore,
      factor: factorScoreForItem(item),
      analogConfidence: item.analog?.confidence || 0,
      modelConfidence: item.analog?.model?.confidence || 0,
    },
    signalCounts: {
      news: item.news?.length || 0,
      x: item.xPosts?.length || 0,
      youtube: item.youtubeItems?.length || 0,
      factors: factorRows(item.factors).filter(([, factor]) => factor?.available !== false).length,
    },
    candles: (item.candles || []).slice(-260),
  };
}

async function persistPredictionSamples(results) {
  const samples = (Array.isArray(results) ? results : [])
    .map(predictionSampleFromResult)
    .filter(Boolean);
  if (!samples.length) return null;
  try {
    const response = await fetch(`/api/accuracy?market=${encodeURIComponent(state.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samples, activeSymbols: predictionActiveSymbols() }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "无法保存预测样本");
    const value = await response.json();
    state.accuracySummary = value;
    state.apiCache.set(`accuracy:${state.market}`, { time: Date.now(), value });
    renderAccuracyPanel();
    return value;
  } catch (error) {
    console.warn("Unable to persist prediction samples", error);
    return null;
  }
}

function predictionActiveSymbols() {
  return [...new Set([
    ...state.watchlist,
    ...activePortfolio().map((holding) => holding.symbol),
  ].map((symbol) => normalizeSymbolForMarket(symbol, state.market)).filter(Boolean))];
}

async function syncPredictionUniverse(cancelSymbols = []) {
  try {
    const response = await fetch(`/api/accuracy?market=${encodeURIComponent(state.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        samples: [],
        activeSymbols: predictionActiveSymbols(),
        cancelSymbols: cancelSymbols.map((symbol) => normalizeSymbolForMarket(symbol, state.market)).filter(Boolean),
      }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "无法同步预测样本");
    const value = await response.json();
    state.accuracySummary = value;
    state.apiCache.set(`accuracy:${state.market}`, { time: Date.now(), value });
    renderAccuracyPanel();
    return value;
  } catch (error) {
    console.warn("Unable to sync prediction universe", error);
    return null;
  }
}

function deleteCacheEntriesForSymbol(symbol) {
  const normalized = normalizeSymbolForMarket(symbol, state.market);
  state.marketCache.delete(`market:${state.market}:${normalized}`);
  [...state.chartDataCache.keys()]
    .filter((key) => key.startsWith(`${state.market}:${normalized}:`))
    .forEach((key) => state.chartDataCache.delete(key));
  [...state.apiCache.keys()]
    .filter((key) => key.includes(`:${state.market}:${normalized}`))
    .forEach((key) => state.apiCache.delete(key));
}

function pruneLocalAnalysisSnapshot(symbol) {
  const normalized = normalizeSymbolForMarket(symbol, state.market);
  const keys = [snapshotKey()];
  if (state.market === "ASX") keys.push(SNAPSHOT_KEY);
  keys.forEach((key) => {
    const payload = readJsonStorage(key, null);
    if (!payload) return;
    const watchlist = (Array.isArray(payload.watchlist) ? payload.watchlist : [])
      .filter((item) => normalizeSymbolForMarket(item, state.market) !== normalized);
    const analyses = (Array.isArray(payload.analyses) ? payload.analyses : [])
      .filter((item) => normalizeSymbolForMarket(item.symbol, state.market) !== normalized);
    if (!watchlist.length && !analyses.length) {
      safeStorage.removeItem(key);
      return;
    }
    const selected = normalizeSymbolForMarket(payload.selected, state.market) === normalized
      ? normalizeSymbolForMarket(watchlist[0] || analyses[0]?.symbol, state.market)
      : payload.selected;
    safeStorage.setItem(key, JSON.stringify({
      ...payload,
      watchlist,
      analyses,
      selected,
      updatedAt: new Date().toISOString(),
      reason: "symbol-delete",
    }));
  });
}

async function deleteWatchSymbol(rawSymbol) {
  const symbol = normalizeSymbolForMarket(rawSymbol, state.market);
  if (!symbol) return;
  const wasHolding = Boolean(findHolding(symbol));
  state.watchlist = state.watchlist.filter((item) => normalizeSymbolForMarket(item, state.market) !== symbol);
  removeWatchlistOrigin(symbol, state.market);
  state.analyses.delete(symbol);
  state.analysesByMarket.set(state.market, new Map(state.analyses));
  state.selected = state.watchlist.find((item) => state.analyses.has(item)) || state.watchlist[0] || null;
  state.chartHoverIndex = null;
  deleteCacheEntriesForSymbol(symbol);
  pruneLocalAnalysisSnapshot(symbol);
  if (!state.analyses.size) {
    safeStorage.removeItem(snapshotTimeKey());
    if (state.market === "ASX") safeStorage.removeItem("analysisSnapshotTime");
    state.snapshotUpdatedAt = null;
  }
  saveState();
  persistAnalysisSnapshot("symbol-delete");
  await Promise.allSettled([
    syncPredictionUniverse([symbol]),
    fetch(`/api/snapshot?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" }),
  ]);
  evaluateAlerts();
  renderCards();
  renderPortfolioSummary();
  renderDetail();
  setStatus(`${symbol} 已从监控池删除，未完成预测已取消${wasHolding ? "；该股票仍在持仓中，持仓分析会继续保留" : ""}`);
}

async function optionalWithin(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function findHolding(symbol) {
  return activePortfolio().find((holding) => holding.symbol === normalizeSymbol(symbol)) || null;
}

function holdingDays(holding) {
  if (!holding?.entryDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(`${holding.entryDate}T00:00:00`).getTime()) / 86400000));
}

function cachedSignalValue(key, fallback) {
  const cached = state.apiCache.get(key);
  return cached ? cached.value : fallback;
}

function preparedHasSignals(item) {
  const result = item?.result || {};
  const factorEvidence = factorRows(result.factors).some(([, factor]) => factor?.values?.proxy !== true && factor?.available !== false);
  return Boolean(result.news?.length && (factorEvidence || result.fundamentals || result.xPosts?.length || result.youtubeItems?.length));
}

function compactAnalysisForSnapshot(item) {
  return {
    ...item,
    candles: (item.candles || []).slice(-220),
    news: (item.news || []).slice(0, 10),
    xPosts: (item.xPosts || []).slice(0, 10),
    youtubeItems: (item.youtubeItems || []).slice(0, 10),
  };
}

function usableSnapshotAnalysis(item) {
  return Boolean(
    item?.symbol &&
    item?.analysis?.action &&
    item.analysis.action !== "ERROR" &&
    Array.isArray(item.candles) &&
    item.candles.length &&
    item?.technicals &&
    hasRequiredSnapshotTechnicals(item.technicals)
  );
}

function snapshotCoversCurrentWatchlist(payload) {
  const analyses = Array.isArray(payload?.analyses) ? payload.analyses : [];
  const available = new Set(
    analyses
      .filter(usableSnapshotAnalysis)
      .map((item) => normalizeSymbolForMarket(item.symbol, state.market))
  );
  return state.watchlist.length > 0 && state.watchlist.every((symbol) => available.has(normalizeSymbol(symbol)));
}

function currentAnalysesCoverWatchlist() {
  return snapshotCoversCurrentWatchlist({ analyses: [...state.analyses.values()] });
}

function persistAnalysisSnapshot(reason = "refresh") {
  if (!snapshotsEnabled()) return false;
  const updatedAt = new Date().toISOString();
  const payload = {
    updatedAt,
    reason,
    market: state.market,
    watchlist: state.watchlist,
    portfolio: activePortfolio(),
    selected: state.selected,
    analyses: [...state.analyses.values()]
      .filter((item) => item?.analysis?.action !== "ERROR")
      .map(compactAnalysisForSnapshot),
  };
  if (!snapshotCoversCurrentWatchlist(payload)) {
    console.warn("Skipping incomplete analysis snapshot", {
      market: state.market,
      required: state.watchlist,
      available: payload.analyses.map((item) => item.symbol),
    });
    return false;
  }
  try {
    safeStorage.setItem(snapshotKey(), JSON.stringify(payload));
    safeStorage.setItem(snapshotTimeKey(), updatedAt);
    if (state.market === "ASX") safeStorage.setItem("analysisSnapshotTime", updatedAt);
    state.snapshotUpdatedAt = updatedAt;
    updateSydneyClock();
    fetch(`/api/snapshot?market=${encodeURIComponent(state.market)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((error) => console.warn("Unable to persist server snapshot", error));
    return true;
  } catch (error) {
    console.warn("Unable to persist analysis snapshot", error);
    return false;
  }
}

function applySnapshotPayload(payload) {
  const snapshot = normalizeSnapshotPayload(payload);
  if (snapshot?.market && safeMarket(snapshot.market) !== state.market) return false;
  if (!snapshot) return false;
  if (!snapshotCoversCurrentWatchlist(snapshot)) {
    console.warn("Ignoring incomplete analysis snapshot", {
      market: state.market,
      required: state.watchlist,
      available: snapshot.analyses.map((item) => item.symbol),
    });
    return false;
  }
  state.analyses = new Map(snapshot.analyses.map((item) => [item.symbol, item]));
  if (snapshot.selected) state.selected = snapshot.selected;
  if (Array.isArray(snapshot.watchlist) && snapshot.watchlist.length) {
    snapshot.watchlist.forEach((symbol) => {
      addWatchSymbol(symbol, watchlistOriginFor(symbol, state.market, "snapshot"), state.market);
    });
  }
  state.snapshotUpdatedAt = snapshot.updatedAt || snapshot.savedAt || safeStorage.getItem(snapshotTimeKey());
  return true;
}

function restoreAnalysisSnapshot() {
  if (!snapshotsEnabled()) return false;
  try {
    const payload = JSON.parse(safeStorage.getItem(snapshotKey()) || (state.market === "ASX" ? safeStorage.getItem(SNAPSHOT_KEY) : "null") || "null");
    const restored = applySnapshotPayload(payload);
    if (!restored && payload) {
      safeStorage.removeItem(snapshotKey());
      safeStorage.removeItem(snapshotTimeKey());
      state.snapshotUpdatedAt = null;
    }
    return restored;
  } catch (error) {
    console.warn("Unable to restore analysis snapshot", error);
    safeStorage.removeItem(snapshotKey());
    safeStorage.removeItem(snapshotTimeKey());
    state.snapshotUpdatedAt = null;
    return false;
  }
}

async function restoreServerSnapshot() {
  if (!snapshotsEnabled()) return false;
  try {
    const response = await fetch(`/api/snapshot?market=${encodeURIComponent(state.market)}`);
    if (!response.ok) return false;
    const payload = await response.json();
    if (!applySnapshotPayload(payload)) return false;
    safeStorage.setItem(snapshotKey(), JSON.stringify(payload));
    safeStorage.setItem(snapshotTimeKey(), state.snapshotUpdatedAt || "");
    evaluateAlerts();
    queueMainRender(["cards", "summary", "detail"]);
    updateSydneyClock();
    return true;
  } catch (error) {
    console.warn("Unable to restore server snapshot", error);
    return false;
  }
}

function useLocalSnapshotOnly(reason = `${activeMarketConfig().code} 休市中`) {
  if (!snapshotsEnabled()) {
    setStatus(`${reason}，本地快照已关闭`);
    return false;
  }
  const restored = currentAnalysesCoverWatchlist() ? true : restoreAnalysisSnapshot();
  if (restored) {
    evaluateAlerts();
    queueMainRender(["cards", "summary", "detail"]);
    setStatus(`${reason}，未请求外部 API/AI，已使用 ${formatSnapshotTime(state.snapshotUpdatedAt)} 的本地快照`);
  } else {
    setStatus(`${reason}，未请求外部 API/AI；本地还没有可用快照，请在交易时间内刷新一次`);
  }
  return restored;
}

async function useSnapshotOrFetch(reason, allowFetchWhenMissing = false) {
  if (useLocalSnapshotOnly(reason)) return true;
  const serverRestored = await restoreServerSnapshot();
  if (serverRestored) {
    setStatus(`${reason}，未请求外部行情/AI，已使用服务器保存的本地快照`);
    return true;
  }
  if (allowFetchWhenMissing) {
    setStatus(`${reason}，但当前没有任何快照；本次允许手动刷新建立第一份快照`);
    return false;
  }
  return true;
}

function buildAnalysisInput(symbol, technicals, analog, fundamentals, xPosts, youtubeItems, news, factors, market) {
  const holding = findHolding(symbol);
  const config = activeMarketConfig();
  return {
    symbol,
    market: state.market,
    marketLabel: config.label,
    currency: config.currency,
    strategy: getStrategy(),
    capital: getCapital(),
    holding: holding ? { ...holding, holdingDays: holdingDays(holding) } : null,
    technicals,
    analog,
    fundamentals,
    xPosts,
    youtubeItems,
    news,
    factors,
    researchConfig: {
      factorConfig: researchConfigForMarket().factorConfig,
    },
    marketValidation: market.validation,
    calibrationSummary: state.accuracySummary,
  };
}

function signalTimeouts(options = {}) {
  if (options.backgroundSignals) {
    return { news: 9000, fundamentals: 2500, x: 2200, youtube: 2200, factors: 6500 };
  }
  return { news: 6500, fundamentals: 1200, x: 1000, youtube: 1000, factors: 2800 };
}

async function prepareSymbol(symbol, options = {}) {
  const includeSignals = Boolean(options.includeSignals);
  const market = await fetchMarket(symbol);
  const candles = normalizeCandles(market.candles);
  if (candles.length < 35) throw new Error(`${symbol} 历史数据不足`);
  const technicals = computeTechnicals(candles);
  const analog = computeHistoricalAnalog(candles, getStrategy().horizonDays, getStrategy().horizonDays);
  const factorKey = `factors:${state.market}:${symbol}:${getStrategy().horizonDays}:${getStrategy().targetUpside}`;
  const timeouts = signalTimeouts(options);
  const [news, fundamentals, xPosts, youtubeItems, fetchedFactors] = includeSignals
    ? await Promise.all([
      optionalWithin(fetchNews(symbol), timeouts.news, cachedNewsValue(symbol)),
      optionalWithin(fetchFundamentals(symbol), timeouts.fundamentals, cachedSignalValue(`fundamentals:${state.market}:${symbol}`, { fundamentals: null }).fundamentals || null),
      optionalWithin(fetchX(symbol), timeouts.x, cachedSignalValue(`x:${state.market}:${symbol}`, { posts: [] }).posts || []),
      optionalWithin(fetchYouTube(symbol), timeouts.youtube, cachedSignalValue(`youtube:${state.market}:${symbol}`, { videos: [] }).videos || []),
      optionalWithin(fetchFactors(symbol), timeouts.factors, cachedSignalValue(factorKey, { factors: null }).factors || null),
    ])
    : [
      cachedNewsValue(symbol),
      cachedSignalValue(`fundamentals:${state.market}:${symbol}`, { fundamentals: null }).fundamentals || null,
      cachedSignalValue(`x:${state.market}:${symbol}`, { posts: [] }).posts || [],
      cachedSignalValue(`youtube:${state.market}:${symbol}`, { videos: [] }).videos || [],
      cachedSignalValue(factorKey, { factors: null }).factors || null,
    ];
  const baseItemForFactors = { symbol, technicals, analog };
  const factors = fetchedFactors || proxyFactorsForItem(baseItemForFactors, includeSignals ? "provider-timeout-or-error" : "cached-provider-empty");
  const input = buildAnalysisInput(symbol, technicals, analog, fundamentals, xPosts, youtubeItems, news, factors, market);
  return {
    symbol,
    input,
    result: {
      symbol,
      market: state.market,
      candles,
      technicals,
      quote: market.quote || null,
      analog,
      fundamentals,
      xPosts,
      youtubeItems,
      news,
      factors,
      marketSource: market.source,
      marketWarning: market.warning,
      quoteWarning: market.quoteWarning,
      marketValidation: market.validation,
    },
  };
}

function commitAnalysisResults(results, options = {}) {
  const adjusted = results
    .map((result) => {
      const symbol = allowWatchSymbolForMarket(result?.symbol, state.market, watchlistOriginFor(result?.symbol, state.market, "analysis"));
      if (!symbol || (result?.market && safeMarket(result.market) !== state.market)) return null;
      return applyPostModelAdjustments({ ...result, symbol, market: state.market });
    })
    .filter(Boolean);
  adjusted.forEach((result) => {
    if (result?.symbol) state.analyses.set(result.symbol, result);
  });
  if (options.agentStep === false) {
    renderAgentPanel();
    renderOptimalStrategyPanel();
  }
  else trainAgentsWithResults(adjusted);
  evaluateAlerts();
  persistAnalysisSnapshot("analysis-commit");
  persistPredictionSamples(adjusted);
  storeForecastMemory(adjusted);
  return adjusted;
}

async function requestBatchAnalysis(preparedItems, options = {}) {
  const response = await fetch("/api/analyze-batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: preparedItems.map((item) => item.input),
      localOnly: Boolean(options.localOnly),
    }),
  });
  if (!response.ok) {
    if (response.status === 404) return requestParallelSingleAnalysis(preparedItems, options);
    throw new Error((await response.json()).error || "批量 AI 分析失败");
  }
  const payload = await response.json();
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const bySymbol = new Map(rows.map((row) => [normalizeSymbolForMarket(row.symbol, state.market), row]).filter(([symbol]) => symbol));
  const results = [];
  const missing = [];
  preparedItems.forEach((item, index) => {
    const expected = normalizeSymbolForMarket(item.symbol, state.market);
    const indexed = rows[index];
    const indexedSymbol = normalizeSymbolForMarket(indexed?.symbol, state.market);
    const row = bySymbol.get(expected) || (indexedSymbol === expected ? indexed : null);
    if (!row?.analysis) {
      missing.push({ item, index, expected });
      return;
    }
    results[index] = {
      ...item.result,
      symbol: expected,
      market: state.market,
      analysis: row.analysis,
      source: row.source || payload.source,
    };
  });
  if (missing.length) {
    const fallbackResponse = await fetch("/api/analyze-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: missing.map(({ item }) => item.input),
        localOnly: true,
      }),
    });
    if (!fallbackResponse.ok) throw new Error((await fallbackResponse.json()).error || `${missing[0].item.symbol} 本地模型未返回分析`);
    const fallbackPayload = await fallbackResponse.json();
    const fallbackRows = Array.isArray(fallbackPayload.results) ? fallbackPayload.results : [];
    const fallbackBySymbol = new Map(fallbackRows.map((row) => [normalizeSymbolForMarket(row.symbol, state.market), row]).filter(([symbol]) => symbol));
    missing.forEach(({ item, index, expected }, fallbackIndex) => {
      const indexed = fallbackRows[fallbackIndex];
      const indexedSymbol = normalizeSymbolForMarket(indexed?.symbol, state.market);
      const row = fallbackBySymbol.get(expected) || (indexedSymbol === expected ? indexed : null);
      if (!row?.analysis) throw new Error(`${item.symbol} 未返回本地分析`);
      results[index] = {
        ...item.result,
        symbol: expected,
        market: state.market,
        analysis: row.analysis,
        source: `${payload.source || "batch"}+${row.source || fallbackPayload.source || "local-fallback"}`,
      };
    });
  }
  if (options.commit !== false) return commitAnalysisResults(results, options);
  return results;
}

async function requestParallelSingleAnalysis(preparedItems, options = {}) {
  const settled = await Promise.allSettled(preparedItems.map(async (item) => {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item.input),
    });
    if (!response.ok) throw new Error((await response.json()).error || `无法分析 ${item.symbol}`);
    const payload = await response.json();
    const result = {
      ...item.result,
      analysis: payload.analysis,
      source: `${payload.source || "openai"}-parallel-fallback`,
    };
    return result;
  }));
  const results = settled.map((entry, index) => {
    if (entry.status === "fulfilled") return entry.value;
    setSymbolError(preparedItems[index].symbol, entry.reason);
    return null;
  }).filter(Boolean);
  if (options.commit !== false) return commitAnalysisResults(results, options);
  return results;
}

async function analyzeSymbol(symbol) {
  await fetchAccuracySummary(false);
  const prepared = await prepareSymbol(symbol, { includeSignals: true });
  const [result] = await requestBatchAnalysis([prepared]);
  return result;
}

function orderedSymbolsForRefresh() {
  state.watchlist = sanitizeSymbolsForMarket(state.watchlist, state.market);
  const portfolioSymbols = activePortfolio().map((holding) => normalizeSymbol(holding.symbol)).filter(Boolean);
  return [...new Set([...portfolioSymbols, ...state.watchlist])];
}

function mergePreparedSignalsIntoAnalysis(prepared) {
  const result = prepared?.result || prepared;
  const symbol = normalizeSymbolForMarket(result?.symbol, state.market);
  if (!symbol) return null;
  const existing = state.analyses.get(symbol);
  if (!existing || normalizeAnalysis(existing.analysis).action === "ERROR") return null;
  const incomingNews = dedupeNewsClient(result.news || []);
  const incomingX = Array.isArray(result.xPosts) ? result.xPosts : [];
  const incomingYouTube = Array.isArray(result.youtubeItems) ? result.youtubeItems : [];
  const merged = {
    ...existing,
    fundamentals: result.fundamentals || existing.fundamentals || null,
    news: incomingNews.length ? incomingNews : (Array.isArray(existing.news) ? existing.news : []),
    xPosts: incomingX.length ? incomingX : (Array.isArray(existing.xPosts) ? existing.xPosts : []),
    youtubeItems: incomingYouTube.length ? incomingYouTube : (Array.isArray(existing.youtubeItems) ? existing.youtubeItems : []),
    factors: result.factors || existing.factors || null,
    signalRefreshedAt: new Date().toISOString(),
  };
  state.analyses.set(symbol, merged);
  state.analysesByMarket.set(state.market, new Map(state.analyses));
  return merged;
}

async function runBackgroundSignalAi(preparedItems, token) {
  const enrichedSettled = await Promise.allSettled(preparedItems.map((item) => (
    preparedHasSignals(item) ? item : prepareSymbol(item.symbol, { includeSignals: true, backgroundSignals: true })
  )));
  if (state.aiRefreshToken !== token) return;
  const enriched = enrichedSettled.map((entry, index) => entry.status === "fulfilled" ? entry.value : preparedItems[index]);
  const signalMerged = enriched.map(mergePreparedSignalsIntoAnalysis).filter(Boolean);
  if (signalMerged.length) {
    persistAnalysisSnapshot("background-signal-merge");
    queueMainRender(["cards", "summary", "detail"]);
    const newsCount = signalMerged.reduce((sum, item) => sum + Number(item.news?.length || 0), 0);
    setStatus(`后台新闻/因子已写入：${newsCount} 条新闻证据，AI 复核继续进行`);
  }
  let results = [];
  try {
    results = await requestBatchAnalysis(enriched, { commit: false });
  } catch (error) {
    if (state.aiRefreshToken !== token) return;
    console.error(error);
    setStatus(`后台新闻/因子已更新；AI 复核未完成：${error.message}`);
    return;
  }
  if (state.aiRefreshToken !== token) return;
  const adjusted = commitAnalysisResults(results, { agentStep: false });
  const buyAlerts = adjusted.filter((item) => isBuyAction(item.analysis?.action)).length;
  renderAnalysisPanelsNow();
  setStatus(`后台新闻/AI 复核完成：${buyAlerts} 个买入/轻仓关注提醒`);
}

function saveDecision(item) {
  const technicals = normalizeTechnicals(item.technicals);
  const analysis = normalizeAnalysis(item.analysis);
  const targetPrice = technicals.close * (1 + projectedFinalReturn(analysis) / 100);
  const maxTouchPrice = technicals.close * (1 + projectedMaxUpside(analysis) / 100);
  const record = {
    id: `${Date.now()}-${state.market}-${item.symbol}`,
    time: new Date().toISOString(),
    market: state.market,
    symbol: item.symbol,
    action: analysis.action,
    price: technicals.close,
    expectedPrice: targetPrice,
    expectedMaxTouchPrice: maxTouchPrice,
    confidence: analysis.confidence,
    projectedUpside: analysis.projectedUpside,
    projectedFinalReturn: projectedFinalReturn(analysis),
    projectedMaxUpside: projectedMaxUpside(analysis),
    finalReturnHitProbability: finalReturnProbability(analysis),
    maxUpsideHitProbability: maxUpsideProbability(analysis),
    suggestedTradeValue: analysis.suggestedTradeValue || 0,
  };
  state.history.unshift(record);
  state.history = state.history.slice(0, 60);
  safeStorage.setItem("decisionHistory", JSON.stringify(state.history));
  renderHistory();
  setStatus(`${item.symbol} 决策已记录`);
}

function renderHistory() {
  const target = $("decisionHistory");
  if (!target) return;
  const rows = activeHistory();
  target.innerHTML = rows.length
    ? rows.map((item) => `
      <div class="history-item">
        <strong>${item.symbol} · ${MARKET_CONFIG[safeMarket(item.market || state.market)].label}</strong>
        <span>${new Date(item.time).toLocaleString()}</span>
        <span>${actionLabel(item.action)} · ${item.qty ? `${item.qty} 股 · ` : ""}成交 ${formatMoney(item.price)}${Number.isFinite(Number(item.realizedPnl)) && item.action?.startsWith("SELL") ? ` · 实现盈亏 ${formatMoney(item.realizedPnl)}` : ` · 结束目标 ${formatMoney(item.expectedPrice)} · 最高触达 ${formatMoney(item.expectedMaxTouchPrice || item.expectedPrice)} · ${Math.round(item.confidence)}%`}</span>
      </div>
    `).join("")
    : `<p class="muted">接受实时决策后会记录在这里。</p>`;
}

function aiChatContext() {
  return {
    market: state.market,
    strategy: getStrategy(),
    capital: getCapital(),
    watchlist: state.watchlist,
    holdings: activePortfolio().map((holding) => ({
      symbol: holding.symbol,
      qty: holding.qty,
      avgPrice: holding.avgPrice,
      entryDate: holding.entryDate,
      holdingDays: holdingDays(holding),
    })),
    analyses: [...state.analyses.values()].map((item) => {
      const analysis = normalizeAnalysis(item.analysis);
      const technicals = normalizeTechnicals(item.technicals);
      return {
        symbol: item.symbol,
        action: analysis.action,
        confidence: analysis.confidence,
        upsideConfidence: analysis.upsideConfidence,
        downsideConfidence: analysis.downsideConfidence,
        projectedUpside: analysis.projectedUpside,
        projectedFinalReturn: projectedFinalReturn(analysis),
        finalReturnHitProbability: finalReturnProbability(analysis),
        projectedMaxUpside: projectedMaxUpside(analysis),
        maxUpsideHitProbability: maxUpsideProbability(analysis),
        strategyHitProbability: strategyProbability(analysis),
        close: technicals.close,
        change5d: technicals.change5d,
        volumeRatio: technicals.volumeRatio,
        rsi: technicals.rsi,
      };
    }),
    accuracy: state.accuracySummary ? {
      total: state.accuracySummary.total,
      resolved: state.accuracySummary.resolved,
      hitRate: state.accuracySummary.hitRate,
      buyHitRate: state.accuracySummary.buyHitRate,
      adaptive: state.accuracySummary.adaptive,
    } : null,
  };
}

function appendAiChat(role, text) {
  const log = $("aiChatLog");
  if (!log) return;
  if (log.querySelector(".muted")) log.innerHTML = "";
  const node = document.createElement("div");
  node.className = `chat-msg ${role}`;
  node.textContent = text;
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
}

async function sendAiChat() {
  const input = $("aiChatInput");
  const button = $("sendAiChat");
  const message = String(input?.value || "").trim();
  if (!message) {
    setStatus("请输入要询问AI的策略问题");
    return;
  }
  appendAiChat("user", message);
  input.value = "";
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/assistant-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, context: aiChatContext() }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "AI策略对话失败");
    const suggestions = (payload.suggestions || []).length ? `\n\n建议动作：${payload.suggestions.join("；")}` : "";
    appendAiChat("ai", `${payload.message || "暂无回复"}${suggestions}`);
    setStatus(`AI策略对话已返回：${payload.source || "assistant"}`);
  } catch (error) {
    appendAiChat("ai", `AI对话暂时失败：${error.message}`);
    setStatus(`AI对话失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function alertKey(alert) {
  return `${todayIso()}:${state.market}:${alert.type}:${alert.symbol}`;
}

function notifyUser(title, body, key) {
  if (!state.notificationsEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  if (key && state.notifiedAlerts[key]) return;
  if (key) {
    state.notifiedAlerts[key] = Date.now();
    safeStorage.setItem("notifiedAlerts", JSON.stringify(state.notifiedAlerts));
  }
  new Notification(title, { body, silent: false });
}

function renderNotificationButton() {
  const button = $("enableNotifications");
  if (!button) return;
  button.textContent = state.notificationsEnabled ? "关闭系统提醒" : "开启系统提醒";
  button.classList.toggle("danger-soft", state.notificationsEnabled);
}

async function toggleNotifications() {
  if (state.notificationsEnabled) {
    state.notificationsEnabled = false;
    safeStorage.setItem("notificationsEnabled", "false");
    renderNotificationButton();
    setStatus("系统提醒已关闭，应用不会再发送买入/卖出通知");
    return;
  }
  if (!("Notification" in window)) {
    setStatus("当前浏览器不支持系统提醒");
    return;
  }
  const permission = await Notification.requestPermission();
  state.notificationsEnabled = permission === "granted";
  safeStorage.setItem("notificationsEnabled", String(state.notificationsEnabled));
  renderNotificationButton();
  setStatus(state.notificationsEnabled ? "系统提醒已开启" : "系统提醒未授权");
}

function evaluateAlerts() {
  const strategy = getStrategy();
  const alerts = [];
  [...state.analyses.values()].forEach((item) => {
    const analysis = normalizeAnalysis(item.analysis);
    if (!isBuyAction(analysis.action)) return;
    const holding = findHolding(item.symbol);
    const strict = analysis.action === "STRONG_BUY";
    alerts.push({
      type: holding ? "ADD" : "BUY",
      symbol: item.symbol,
      severity: "buy",
      title: `${item.symbol} ${strict ? "强买入" : holding ? "补仓观察" : analysis.action === "LIGHT_BUY" ? "轻仓关注" : "买入提醒"}`,
      message: `结束 ${formatPct(projectedFinalReturn(analysis))}/${Math.round(finalReturnProbability(analysis))}%，最高触达 ${formatPct(projectedMaxUpside(analysis))}/${Math.round(maxUpsideProbability(analysis))}%，方向 ${directionLabel(analysis)} ${Math.round(directionReliability(analysis))}%，策略达标 ${Math.round(strategyProbability(analysis))}%，建议票额 ${formatMoney(analysis.suggestedTradeValue || 0)}。`,
    });
  });
  activePortfolio().forEach((holding) => {
    const item = state.analyses.get(holding.symbol);
    if (!item?.technicals?.close) return;
    const close = item.technicals.close;
    const pnlPct = pctChange(close, holding.avgPrice);
    const days = holdingDays(holding);
    const daysLeft = Number(strategy.horizonDays || 15) - days;
    if (pnlPct <= -Math.abs(strategy.stopLoss)) {
      alerts.push({
        type: "SELL_STOP",
        symbol: holding.symbol,
        severity: "sell",
        title: `${holding.symbol} 止损卖出提醒`,
        message: `现价 ${formatMoney(close)}，相对均价 ${formatPct(pnlPct)}，已触发 ${strategy.stopLoss}% 最大止损线。`,
      });
      return;
    }
    const analysis = normalizeAnalysis(item.analysis);
    const downsideConfidence = Number(analysis.downsideConfidence || 0);
    const severeModelRisk = analysis.action === "CRITICAL_SELL"
      || analysis.action === "STRONG_AVOID"
      || (downsideConfidence >= Math.max(70, Number(strategy.confidence || 80) - 5) && projectedFinalReturn(analysis) <= -Math.max(2.5, Number(strategy.stopLoss || 4) * 0.65));
    if (severeModelRisk) {
      alerts.push({
        type: "SELL_CRITICAL_MODEL",
        symbol: holding.symbol,
        severity: "sell",
        title: `${holding.symbol} 最严卖出警报`,
        message: `模型判断下跌风险高：下跌倾向 ${Math.round(downsideConfidence)}%，周期结束预估 ${formatPct(projectedFinalReturn(analysis))}，建议立即复核卖出/减仓。`,
      });
      return;
    }
    const memory = analysis.forecastMemory || {};
    const downgradeFromPriorBuy = memory.previousPositive && (
      isRiskAction(analysis.action) ||
      projectedFinalReturn(analysis) < Number(strategy.targetUpside || 5) * 0.25 ||
      Number(analysis.confidence || 0) < Number(strategy.confidence || 80) * 0.62
    );
    if (downgradeFromPriorBuy) {
      alerts.push({
        type: "SELL_DOWNSIDE",
        symbol: holding.symbol,
        severity: "sell",
        title: `${holding.symbol} 持仓卖出复核`,
        message: `上一轮偏多后当前模型已转弱，现价相对上一预测 ${formatPct(memory.returnSince || 0)}，建议复核减仓/卖出。`,
      });
      return;
    }
    if (daysLeft <= 2 && (isRiskAction(analysis.action) || projectedFinalReturn(analysis) < 0 || analysis.confidence < strategy.confidence * 0.68)) {
      alerts.push({
        type: "SELL_REVIEW",
        symbol: holding.symbol,
        severity: "sell",
        title: `${holding.symbol} 周期到期卖出复核`,
        message: `已持有 ${days} 天，距离策略周期 ${Math.max(0, daysLeft)} 天，后市风险偏高，建议复核卖出。`,
      });
      return;
    }
    if (daysLeft <= 2 && selectionUpside(analysis) >= strategy.targetUpside && analysis.confidence >= strategy.confidence) {
      alerts.push({
        type: "HOLD_EXTEND",
        symbol: holding.symbol,
        severity: "hold",
        title: `${holding.symbol} 可继续持有`,
        message: `已持有 ${days} 天，但仍满足上涨空间和置信度，可考虑延长观察。`,
      });
    }
  });
  state.latestAlerts = alerts;
  alerts
    .filter((alert) => alert.type === "BUY" || alert.type === "ADD" || alert.type === "SELL_STOP" || alert.type === "SELL_REVIEW" || alert.type === "SELL_DOWNSIDE")
    .forEach((alert) => notifyUser(alert.title, alert.message, alertKey(alert)));
}

function sectorOf(symbol) {
  const code = normalizeSymbol(symbol);
  if (state.market === "US") {
    if (["AAPL", "MSFT", "NVDA", "AMD", "GOOGL", "GOOG", "META"].includes(code)) return "科技/AI";
    if (["TSLA", "GM", "F"].includes(code)) return "汽车/新能源";
    if (["JPM", "BAC", "GS", "MS", "WFC"].includes(code)) return "金融";
    if (["XOM", "CVX", "COP"].includes(code)) return "能源";
    return "美股综合";
  }
  if (state.market === "CN") {
    if (/^60/.test(code)) return "沪市";
    if (/^30/.test(code)) return "创业板";
    if (/^00/.test(code)) return "深市";
    return "A股综合";
  }
  if (["BHP", "RIO", "FMG"].includes(code)) return "矿业/材料";
  if (["WDS", "STO"].includes(code)) return "能源";
  if (["CBA", "NAB", "ANZ", "WBC"].includes(code)) return "银行";
  if (["CSL", "RMD"].includes(code)) return "医疗";
  if (["WES", "WOW", "COL"].includes(code)) return "消费";
  return "综合";
}

function renderAlerts() {
  const target = $("alertStrip");
  if (!target) return;
  target.innerHTML = state.latestAlerts.length
    ? state.latestAlerts.map((alert) => `
      <div class="trade-alert ${alert.severity}">
        <strong>${alert.title}</strong>
        <span>${alert.message}</span>
      </div>
    `).join("")
    : `<p class="muted">暂无满足买入或卖出条件的提醒。</p>`;
}

function renderPortfolioTable() {
  const target = $("portfolioTable");
  if (!target) return;
  const holdings = activePortfolio();
  if (!holdings.length) {
    target.innerHTML = `<p class="muted">还没有持仓。可以手动添加、CSV 导入，或用截图识别后应用。</p>`;
    return;
  }
  target.innerHTML = `
    <div class="holding-row holding-head">
      <span>代码</span><span>数量</span><span>均价</span><span>现价</span><span>盈亏</span><span>时长</span><span></span>
    </div>
    ${holdings.map((holding) => {
      const item = state.analyses.get(holding.symbol);
      const close = item?.technicals?.close || holding.avgPrice;
      const pnlPct = pctChange(close, holding.avgPrice);
      return `
        <div class="holding-row">
          <strong>${holding.symbol} <small class="muted">${MARKET_CONFIG[holding.market]?.label || holding.market}</small></strong>
          <span>${holding.qty}</span>
          <span>${formatMoney(holding.avgPrice)}</span>
          <span>${formatMoney(close)}</span>
          <span class="${pnlPct >= 0 ? "good-text" : "danger-text"}">${formatPct(pnlPct)}</span>
          <span>${holdingDays(holding)} 天</span>
          <span class="holding-actions">
            <button class="secondary mini-btn" type="button" data-add-holding="${holding.symbol}">加仓</button>
            <button class="danger-soft mini-btn" type="button" data-reduce-holding="${holding.symbol}">减仓</button>
          </span>
        </div>
      `;
    }).join("")}
  `;
  target.querySelectorAll("[data-add-holding]").forEach((button) => {
    button.addEventListener("click", () => promptHoldingAdjustment(button.dataset.addHolding, "BUY"));
  });
  target.querySelectorAll("[data-reduce-holding]").forEach((button) => {
    button.addEventListener("click", () => promptHoldingAdjustment(button.dataset.reduceHolding, "SELL"));
  });
}

function promptHoldingAdjustment(symbol, side = "BUY") {
  const holding = findHolding(symbol);
  if (!holding) {
    setStatus(`${symbol} 当前没有持仓`);
    return;
  }
  const item = state.analyses.get(holding.symbol);
  const defaultPrice = Number(item?.technicals?.close || holding.avgPrice || 0);
  const qtyPrompt = side === "SELL" ? `卖出数量，当前最多 ${holding.qty}` : "买入数量";
  const rawQty = window.prompt(qtyPrompt, side === "SELL" ? String(Math.max(1, Math.floor(holding.qty * 0.5))) : "1");
  if (rawQty == null) return;
  const qty = side === "SELL" ? Math.min(holding.qty, asNumber(rawQty, 0)) : asNumber(rawQty, 0);
  const rawPrice = window.prompt(side === "SELL" ? "卖出成交价" : "买入成交价", defaultPrice ? defaultPrice.toFixed(2) : "");
  if (rawPrice == null) return;
  const price = asNumber(rawPrice, 0);
  if (qty <= 0 || price <= 0) {
    setStatus("请输入有效数量和成交价");
    return;
  }
  if (side === "SELL") applyHoldingSell(holding, qty, price, "portfolio-table");
  else applyHoldingBuy(holding.symbol, qty, price, "portfolio-table");
}

function applyHoldingBuy(symbol, qty, price, source = "manual-buy") {
  const existing = findHolding(symbol);
  if (existing) {
    const totalQty = existing.qty + qty;
    upsertHolding({
      ...existing,
      qty: totalQty,
      avgPrice: ((existing.avgPrice * existing.qty) + (price * qty)) / totalQty,
      entryDate: existing.entryDate,
      source: `${existing.source || "manual"}+${source}`,
    });
  } else {
    upsertHolding({ symbol, qty, avgPrice: price, entryDate: todayIso(), source });
  }
  recordTradeHistory({ symbol: normalizeSymbol(symbol), action: "BUY_ADD", price, expectedPrice: price, qty });
  evaluateAlerts();
  renderPortfolioSummary();
  renderCards();
  renderDetail();
  setStatus(`${normalizeSymbol(symbol)} 已加仓 ${qty} 股，成交价 ${formatMoney(price)}`);
}

function applyHoldingSell(holding, qty, price, source = "manual-sell") {
  const sellQty = Math.min(holding.qty, Math.max(0, qty));
  if (sellQty <= 0 || price <= 0) return;
  const realizedPnl = (price - holding.avgPrice) * sellQty;
  const remainingQty = Number((holding.qty - sellQty).toFixed(6));
  const baseCapital = asNumber($("totalCapital").value, 0);
  $("totalCapital").value = Math.max(0, baseCapital + realizedPnl).toFixed(2);
  if (remainingQty <= 0) {
    state.portfolio = state.portfolio.filter((row) => !(row.symbol === holding.symbol && row.market === holding.market));
  } else {
    state.portfolio = state.portfolio.map((row) => (
      row.symbol === holding.symbol && row.market === holding.market
        ? { ...row, qty: remainingQty, avgPrice: holding.avgPrice, source: `${row.source || "manual"}+${source}` }
        : row
    ));
  }
  savePortfolio();
  recordTradeHistory({
    market: holding.market,
    symbol: holding.symbol,
    action: remainingQty <= 0 ? "SELL_EXIT" : "SELL_REDUCE",
    price,
    expectedPrice: price,
    qty: sellQty,
    realizedPnl,
  });
  evaluateAlerts();
  renderPortfolioSummary();
  renderCards();
  renderDetail();
  setStatus(`${holding.symbol} 已减仓 ${sellQty} 股，成交价 ${formatMoney(price)}，剩余 ${Math.max(0, remainingQty)} 股`);
}

function renderAllocationAdvice() {
  const target = $("allocationAdvice");
  if (!target) return;
  const capital = getCapital();
  const strategy = getStrategy();
  const maxPerStock = capital.totalCapital * strategy.maxPosition / 100;
  const sectorExposure = new Map();
  activePortfolio().forEach((holding) => {
    const close = state.analyses.get(holding.symbol)?.technicals?.close || holding.avgPrice;
    const sector = sectorOf(holding.symbol);
    sectorExposure.set(sector, (sectorExposure.get(sector) || 0) + close * holding.qty);
  });
  const candidates = [...state.analyses.values()]
    .filter((item) => isStrictBuyAction(item.analysis?.action))
    .map((item) => {
      const holding = findHolding(item.symbol);
      const currentValue = holding ? (item.technicals.close || holding.avgPrice) * holding.qty : 0;
      const sector = sectorOf(item.symbol);
      const sectorPct = capital.totalCapital ? (sectorExposure.get(sector) || 0) / capital.totalCapital * 100 : 0;
      const diversificationPenalty = sectorPct > 35 ? 0.65 : sectorPct > 25 ? 0.82 : 1;
      const riskPenalty = Math.max(0.55, 1 - Number(item.technicals.volatility || 0) / 20);
      const analysis = normalizeAnalysis(item.analysis);
      const score = (analysis.confidence * 0.3 + strategyProbability(analysis) * 0.25 + directionReliability(analysis) * 0.16 + selectionUpside(analysis) * 7 + maxUpsideProbability(analysis) * 0.08) * diversificationPenalty * riskPenalty;
      const capacity = Math.max(0, maxPerStock - currentValue);
      return { item, holding, sector, score, capacity, analysis };
    })
    .filter((row) => row.capacity > 0)
    .sort((a, b) => b.score - a.score);
  const scoreSum = candidates.reduce((sum, row) => sum + Math.max(0, row.score), 0) || 1;
  const budget = capital.availableForNewTrades;
  target.innerHTML = `
    <div class="allocation-note">
      <strong>可用于新买入/补仓：${formatMoney(budget)}</strong>
      <span>已预留补仓现金 ${formatMoney(capital.reservedCash)}；单票上限 ${formatMoney(maxPerStock)}。配置会降低同板块过度集中。</span>
    </div>
    ${candidates.length ? candidates.map((row) => {
      const suggested = Math.min(row.capacity, budget * Math.max(0, row.score) / scoreSum);
      return `
        <div class="allocation-item">
          <strong>${row.item.symbol} · ${row.sector}</strong>
          <span>建议 ${formatMoney(suggested)}，方向 ${Math.round(directionReliability(row.analysis))}%，结束 ${formatPct(projectedFinalReturn(row.analysis))}/${Math.round(finalReturnProbability(row.analysis))}%，最高触达 ${formatPct(projectedMaxUpside(row.analysis))}/${Math.round(maxUpsideProbability(row.analysis))}%，达标 ${Math.round(strategyProbability(row.analysis))}%，剩余单票容量 ${formatMoney(row.capacity)}。</span>
        </div>
      `;
    }).join("") : `<p class="muted">当前没有同时满足策略、仓位容量和风控条件的买入配置。</p>`}
  `;
}

function pctOrPending(value) {
  return value == null ? "样本不足" : `${Number(value || 0).toFixed(0)}%`;
}

function numberOrPending(value, digits = 2) {
  return value == null ? "样本不足" : Number(value || 0).toFixed(digits);
}

function ratioOrPending(value, noLosses = false) {
  if (noLosses) return "无亏损";
  return value == null ? "样本不足" : Number(value || 0).toFixed(2);
}

function deltaText(value, digits = 0, suffix = "%") {
  if (value == null) return "样本不足";
  const number = Number(value || 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(digits)}${suffix}`;
}

function learningCurveHtml(curve = []) {
  if (!curve.length) return `<p class="muted">还没有已验证样本形成曲线；旧预测到期后会自动绘制方向准确率和买入达标率。</p>`;
  const rows = curve.slice(-24);
  return `
    <div class="learning-chart" aria-label="滚动方向准确率与买入达标率">
      ${rows.map((point) => {
        const hit = point.hitRate == null ? 0 : clamp(Number(point.hitRate), 3, 100);
        const buy = point.buyHitRate == null ? hit : clamp(Number(point.buyHitRate), 3, 100);
        return `
          <div class="learning-bar" title="${point.date} ${point.symbol} · 方向 ${pctOrPending(point.hitRate)} · 买入达标 ${pctOrPending(point.buyHitRate)}">
            <i style="height:${hit}%"></i>
            <b style="height:${buy}%"></b>
          </div>
        `;
      }).join("")}
    </div>
    <div class="learning-legend">
      <span><i class="legend-hit"></i>滚动方向准确率</span>
      <span><i class="legend-buy"></i>滚动买入达标率</span>
      <span>最近 ${rows.length} 个已验证点</span>
    </div>
  `;
}

function improvementHtml(improvement = {}) {
  const ready = improvement.status === "ready";
  const recent = improvement.recent || {};
  const baseline = improvement.baseline || {};
  return `
    <div class="learning-stage">
      <div>
        <span>早期窗口</span>
        <strong>${pctOrPending(baseline.hitRate)}</strong>
        <p>样本 ${baseline.samples || 0} · 买入达标 ${pctOrPending(baseline.buyHitRate)} · Brier ${baseline.brierScore == null ? "n/a" : Number(baseline.brierScore).toFixed(3)}</p>
      </div>
      <div>
        <span>近期窗口</span>
        <strong>${pctOrPending(recent.hitRate)}</strong>
        <p>样本 ${recent.samples || 0} · 买入达标 ${pctOrPending(recent.buyHitRate)} · Brier ${recent.brierScore == null ? "n/a" : Number(recent.brierScore).toFixed(3)}</p>
      </div>
      <div>
        <span>阶段改善</span>
        <strong>${ready ? deltaText(improvement.hitRateDelta) : "收集中"}</strong>
        <p>买入达标 ${ready ? deltaText(improvement.buyHitRateDelta) : "样本不足"} · Brier ${ready ? deltaText(improvement.brierDelta, 3, "") : "样本不足"} · 收益 ${ready ? deltaText(improvement.avgReturnDelta, 2) : "样本不足"}</p>
      </div>
    </div>
    ${improvement.message ? `<p class="muted small-text">${improvement.message}</p>` : ""}
  `;
}

function learningEventsHtml(events = []) {
  if (!events.length) return `<p class="muted">目前还没有触发失败迁移的预测。出现止损、未达标或未完成逆行后，这里会显示调参记录。</p>`;
  return `
    <div class="learning-events">
      ${events.map((event) => `
        <div class="learning-event">
          <div>
            <strong>${event.symbol}</strong>
            <span>${event.date || "未知日期"} · ${event.status || "等待验证"} · 周期 ${event.horizonDays || "-"} 日</span>
          </div>
          <p>预测 ${formatPct(event.projectedUpside)} / 方向置信 ${Math.round(event.confidence || 0)}%；实际 ${event.actualReturn == null ? "未完成" : formatPct(event.actualReturn)}，最大回撤 ${event.drawdown == null ? "n/a" : formatPct(event.drawdown)}。</p>
          <p>影响范围：${(event.transferScopes || []).join("、")}；${(event.changes || []).join("；")}。</p>
          ${(event.reasons || []).length ? `<p class="muted">${event.reasons.slice(0, 2).join("；")}</p>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function accuracyBoostPlanHtml(rows = []) {
  if (!rows.length) return `<p class="muted">暂无新的提升动作。</p>`;
  return `
    <div class="boost-plan">
      ${rows.map((row) => `
        <div class="boost-row">
          <strong>${row.priority || "中"} · ${row.title}</strong>
          <span>${row.action}</span>
          <p>${row.effect || ""}</p>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAccuracyPanel() {
  const target = $("accuracyPanel");
  if (!target) return;
  const summary = state.accuracySummary;
  if (!summary) {
    target.innerHTML = `<p class="muted">还没有读取到预测样本。刷新后会自动建立样本库并开始校准。</p>`;
    return;
  }
  const buckets = (summary.buckets || []).filter((bucket) => bucket.count > 0);
  const strategyBuckets = (summary.strategyBuckets || []).filter((bucket) => bucket.count > 0);
  const adaptive = summary.adaptive || {};
  const horizonRows = Object.values(summary.horizonStats || adaptive.horizonStats || {}).filter((row) => row.total > 0);
  const modelRows = Object.values(summary.modelStats || {})
    .filter((row) => row.samples > 0)
    .sort((a, b) => Number(b.samples || 0) - Number(a.samples || 0))
    .slice(0, 10);
  const regimeRows = Object.values(summary.regimeStats || {}).filter((row) => row.total > 0);
  const benchmarkRows = Array.isArray(summary.benchmarkComparisons) ? summary.benchmarkComparisons : [];
  const sectorRows = Object.values(summary.sectorStats || {})
    .filter((row) => row.total > 0)
    .sort((a, b) => Number(b.resolved || 0) - Number(a.resolved || 0) || Number(b.total || 0) - Number(a.total || 0))
    .slice(0, 12);
  const errorRows = Object.values(summary.errorTypeStats || {})
    .filter((row) => row.total > 0)
    .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
    .slice(0, 10);
  const patternRows = Object.values(adaptive.patternStats || {})
    .filter((row) => row.total > 0)
    .sort((a, b) => Number(b.confidencePenalty || 0) - Number(a.confidencePenalty || 0))
    .slice(0, 8);
  const recent = summary.recent || [];
  const overviewHtml = `
    <div class="learning-head">
      <div>
        <h3>预测学习曲线</h3>
        <p>旧预测不会被新预测覆盖；到期、触及目标或止损后会分别进入方向准确率和买入达标率，并反向调整后续模型。</p>
      </div>
      <span>${summary.updatedAt ? new Date(summary.updatedAt).toLocaleString() : "刚刚更新"}</span>
    </div>
    ${learningCurveHtml(summary.learningCurve || [])}
    ${improvementHtml(summary.improvement || {})}
    <div class="accuracy-grid">
      <div class="accuracy-metric"><span>样本 / 已验证</span><strong>${summary.total || 0} / ${summary.resolved || 0}</strong></div>
      <div class="accuracy-metric"><span>方向准确率</span><strong>${pctOrPending(summary.directionalHitRate ?? summary.hitRate)}</strong></div>
      <div class="accuracy-metric"><span>幅度达成率</span><strong>${pctOrPending(summary.magnitudeHitRate)}</strong></div>
      <div class="accuracy-metric"><span>结束收益命中</span><strong>${pctOrPending(summary.finalReturnHitRate)}</strong></div>
      <div class="accuracy-metric"><span>最高触达命中</span><strong>${pctOrPending(summary.maxUpsideHitRate)}</strong></div>
      <div class="accuracy-metric"><span>买入达标率</span><strong>${pctOrPending(summary.strategyHitRate ?? summary.buyHitRate)}</strong></div>
      <div class="accuracy-metric"><span>平均收益</span><strong>${summary.avgForwardReturn == null ? "样本不足" : formatPct(summary.avgForwardReturn)}</strong></div>
      <div class="accuracy-metric"><span>自适应扣分</span><strong>${numberOrPending(adaptive.confidencePenalty, 1)}%</strong></div>
      <div class="accuracy-metric"><span>涨幅收缩</span><strong>${adaptive.upsideShrink ? `${Math.round(adaptive.upsideShrink * 100)}%` : "样本不足"}</strong></div>
      <div class="accuracy-metric"><span>Brier Score</span><strong>${numberOrPending(summary.brierScore, 3)}</strong></div>
      <div class="accuracy-metric"><span>幅度Brier</span><strong>${numberOrPending(summary.magnitudeBrierScore, 3)}</strong></div>
      <div class="accuracy-metric"><span>结束Brier</span><strong>${numberOrPending(summary.finalReturnBrierScore, 3)}</strong></div>
      <div class="accuracy-metric"><span>触达Brier</span><strong>${numberOrPending(summary.maxUpsideBrierScore, 3)}</strong></div>
      <div class="accuracy-metric"><span>达标Brier</span><strong>${numberOrPending(summary.strategyBrierScore, 3)}</strong></div>
      <div class="accuracy-metric"><span>盈亏因子</span><strong>${ratioOrPending(summary.profitFactor, summary.profitFactorNoLosses)}</strong></div>
      <div class="accuracy-metric"><span>盈亏比</span><strong>${ratioOrPending(summary.payoffRatio)}</strong></div>
      <div class="accuracy-metric"><span>最大不利回撤</span><strong>${summary.maxAdverseDrawdown == null ? "样本不足" : formatPct(summary.maxAdverseDrawdown)}</strong></div>
      <div class="accuracy-metric"><span>平均最大回撤</span><strong>${summary.avgMaxDrawdown == null ? "样本不足" : formatPct(summary.avgMaxDrawdown)}</strong></div>
    </div>
    <div class="learning-section">
      <h4>基准对照</h4>
      <div class="bucket-list">
        ${benchmarkRows.length ? benchmarkRows.map((row) => `
          <div class="bucket-row">
            <strong>${escapeHtml(row.label)}</strong>
            <span>方向 ${pctOrPending(row.directionHitRate)}</span>
            <span>达标 ${pctOrPending(row.targetHitRate)}</span>
            <span>vs随机 ${row.edgeVsRandom == null ? "n/a" : `${row.edgeVsRandom >= 0 ? "+" : ""}${row.edgeVsRandom.toFixed(1)}%`}</span>
            <span>vs买入持有 ${row.edgeVsBuyHold == null ? "n/a" : `${row.edgeVsBuyHold >= 0 ? "+" : ""}${row.edgeVsBuyHold.toFixed(1)}%`}</span>
            <span>样本 ${row.samples || 0}</span>
            <span>${escapeHtml(row.note || "")}</span>
          </div>
        `).join("") : `<p class="muted">基准样本仍在收集中。</p>`}
      </div>
    </div>
  `;
  const adjustmentsHtml = `
    <div class="learning-section">
      <h4>失败后的模型调整</h4>
      ${learningEventsHtml(summary.learningEvents || [])}
    </div>
    <div class="learning-section">
      <h4>下一步提升预测成功率</h4>
      ${accuracyBoostPlanHtml(summary.accuracyBoostPlan || [])}
    </div>
  `;
  const performanceHtml = `
    <div class="learning-section">
      <h4>周期表现</h4>
      <div class="bucket-list">
        ${horizonRows.length ? horizonRows.map((row) => `
          <div class="bucket-row">
            <strong>${row.label}</strong>
            <span>样本 ${row.total}</span>
            <span>已验 ${row.resolved}</span>
            <span>方向 ${pctOrPending(row.hitRate)}</span>
            <span>幅度 ${pctOrPending(row.magnitudeHitRate)}</span>
            <span>结束 ${pctOrPending(row.finalReturnHitRate)}</span>
            <span>触达 ${pctOrPending(row.maxUpsideHitRate)}</span>
            <span>买入达标 ${pctOrPending(row.buyHitRate)}</span>
            <span>预测误差 ${row.avgForecastError == null ? "n/a" : formatPct(row.avgForecastError)}</span>
            <span>未完成逆行 ${row.adversePending || 0}</span>
          </div>
        `).join("") : `<p class="muted">短/中/长期样本仍在收集中。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>可迁移错误模式</h4>
      <div class="bucket-list">
        ${patternRows.length ? patternRows.map((row) => `
          <div class="bucket-row">
            <strong>${row.label}</strong>
            <span>迁移 ${Number(row.confidencePenalty || 0).toFixed(1)}%</span>
            <span>收缩 ${Math.round(Number(row.upsideShrink || 1) * 100)}%</span>
            <span>样本 ${row.total}</span>
            <span>已验 ${row.resolved}</span>
            <span>幅度 ${pctOrPending(row.magnitudeHitRate)}</span>
            <span>触达 ${pctOrPending(row.maxUpsideHitRate)}</span>
            <span>买入达标 ${pctOrPending(row.buyHitRate)}</span>
            <span>未完成逆行 ${row.adversePending || 0}</span>
          </div>
        `).join("") : `<p class="muted">还没有形成可迁移的错误行为模式。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>置信桶校准</h4>
      <div class="bucket-list">
        ${buckets.length ? buckets.map((bucket) => `
          <div class="bucket-row">
            <strong>${bucket.label}%</strong>
            <span>样本 ${bucket.count}</span>
            <span>方向 ${pctOrPending(bucket.hitRate)}</span>
            <span>均值 ${bucket.avgReturn == null ? "n/a" : formatPct(bucket.avgReturn)}</span>
            <span>Brier ${bucket.brierScore == null ? "n/a" : Number(bucket.brierScore).toFixed(3)}</span>
            <span>回撤 ${bucket.maxDrawdown == null ? "n/a" : formatPct(bucket.maxDrawdown)}</span>
          </div>
        `).join("") : `<p class="muted">还没有完成持仓周期的样本；后续刷新会自动给旧预测打标签。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>策略达标概率校准</h4>
      <div class="bucket-list">
        ${strategyBuckets.length ? strategyBuckets.map((bucket) => `
          <div class="bucket-row">
            <strong>${bucket.label}%</strong>
            <span>样本 ${bucket.count}</span>
            <span>达标 ${pctOrPending(bucket.hitRate)}</span>
            <span>均值 ${bucket.avgReturn == null ? "n/a" : formatPct(bucket.avgReturn)}</span>
            <span>Brier ${bucket.brierScore == null ? "n/a" : Number(bucket.brierScore).toFixed(3)}</span>
          </div>
        `).join("") : `<p class="muted">还没有足够样本校准策略达标概率。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>模型样本外权重</h4>
      <div class="bucket-list">
        ${modelRows.length ? modelRows.map((row) => `
          <div class="bucket-row">
            <strong>${row.name}</strong>
            <span>样本 ${row.samples}</span>
            <span>方向 ${pctOrPending(row.directionalHitRate)}</span>
            <span>达标 ${pctOrPending(row.strategyHitRate)}</span>
            <span>权重 ${Math.round(Number(row.weightMultiplier || 1) * 100)}%</span>
          </div>
        `).join("") : `<p class="muted">模型表现样本仍在收集中。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>市场环境表现</h4>
      <div class="bucket-list">
        ${regimeRows.length ? regimeRows.map((row) => `
          <div class="bucket-row">
            <strong>${row.label || row.regime}</strong>
            <span>样本 ${row.total}</span>
            <span>已验 ${row.resolved}</span>
            <span>买入达标 ${pctOrPending(row.buyHitRate)}</span>
            <span>平均收益 ${row.avgForwardReturn == null ? "n/a" : formatPct(row.avgForwardReturn)}</span>
          </div>
        `).join("") : `<p class="muted">市场环境样本仍在收集中。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>行业表现</h4>
      <div class="bucket-list">
        ${sectorRows.length ? sectorRows.map((row) => `
          <div class="bucket-row">
            <strong>${escapeHtml(row.sector || "unknown")}</strong>
            <span>样本 ${row.total}</span>
            <span>已验 ${row.resolved}</span>
            <span>方向 ${pctOrPending(row.hitRate)}</span>
            <span>达标 ${pctOrPending(row.buyHitRate)}</span>
            <span>平均收益 ${row.avgForwardReturn == null ? "n/a" : formatPct(row.avgForwardReturn)}</span>
          </div>
        `).join("") : `<p class="muted">行业样本仍在收集中。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>错误类型归档</h4>
      <div class="bucket-list">
        ${errorRows.length ? errorRows.map((row) => `
          <div class="bucket-row">
            <strong>${row.label || row.type}</strong>
            <span>样本 ${row.total}</span>
            <span>已验 ${row.resolved}</span>
            <span>买入达标 ${pctOrPending(row.buyHitRate)}</span>
            <span>平均误差 ${row.avgForecastError == null ? "n/a" : formatPct(row.avgForecastError)}</span>
          </div>
        `).join("") : `<p class="muted">暂未归档明确错误类型。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>最近预测样本</h4>
      <div class="sample-list">
        ${recent.length ? recent.map((sample) => `
          <div class="sample-row">
            <strong>${sample.symbol}</strong>
            <span>${sample.asOfDate}</span>
            <span>方向 ${Math.round(sample.predictionConfidence ?? sample.confidence ?? 0)}% · 结束 ${formatPct(sample.projectedFinalReturn ?? sample.projectedUpside ?? 0)}/${Math.round(sample.finalReturnHitProbability ?? sample.finalReturnConfidence ?? 0)}% · 触达 ${formatPct(sample.projectedMaxUpside || 0)}/${Math.round(sample.maxUpsideHitProbability ?? sample.maxUpsideConfidence ?? 0)}% · 达标 ${Math.round(sample.strategyHitProbability ?? sample.strategyConfidence ?? 0)}%</span>
            <span>${sample.outcome?.resolved ? sample.outcome.outcome : sample.interim?.adverse ? "未完成逆行" : "等待验证"}</span>
            <span>${sample.outcome?.resolved ? `最高 ${formatPct(sample.outcome.maxUpsidePct)} / 回撤 ${formatPct(sample.outcome.maxDrawdownPct)}` : sample.interim ? `当前 ${formatPct(sample.interim.forwardReturnPct)} / 回撤 ${formatPct(sample.interim.maxDrawdownPct)}` : `周期 ${sample.horizonDays} 日`}</span>
          </div>
        `).join("") : `<p class="muted">暂无预测记录。</p>`}
      </div>
    </div>
  `;
  target.innerHTML = `
    <div class="learning-window-grid">
      <details class="learning-window" open>
        <summary><span>曲线总览</span><strong>${pctOrPending(summary.hitRate)} / ${summary.resolved || 0} 已验证</strong></summary>
        <div class="learning-window-body">${overviewHtml}</div>
      </details>
      <details class="learning-window">
        <summary><span>模型调整</span><strong>${summary.learningEvents?.length || 0} 条记录</strong></summary>
        <div class="learning-window-body">${adjustmentsHtml}</div>
      </details>
      <details class="learning-window">
        <summary><span>周期与校准</span><strong>${horizonRows.length + patternRows.length + buckets.length + strategyBuckets.length + modelRows.length + errorRows.length} 组</strong></summary>
        <div class="learning-window-body">${performanceHtml}</div>
      </details>
    </div>
  `;
}

function renderMarketIndexPanel() {
  const target = $("marketIndexPanel");
  if (!target) return;
  const rows = state.marketIndexes || [];
  const displayRows = rows.length ? rows : activeMarketConfig().indexes || [];
  const chartRows = displayRows.filter((row) => !row?.error);
  if (!state.marketIndexChartSymbol && chartRows.length) state.marketIndexChartSymbol = chartRows[0].symbol;
  const signal = state.marketIndexSignal || indexSignalFromRows(rows);
	  const sourceNote = state.market === "ASX"
	    ? "澳股只显示现金指数点位；优先用 ASX 官方点位，历史K线源不可用时也不会用 STW/VAS/IOZ ETF 价格替代。"
	    : state.market === "US"
	      ? "美股只显示真实现金指数点位；S&P 500、Nasdaq、Dow Jones 不使用 SPY/QQQ/DIA ETF 代理。"
	      : "A股使用上证、深证、创业板官方指数代码。";
	  const startupHint = marketIndexStartupHint();
	  target.innerHTML = `
	    <div class="market-signal ${signal.stance}">
	      <strong>${signal.stance === "risk-on" ? "大盘偏强" : signal.stance === "risk-off" ? "大盘偏弱" : "大盘震荡"}</strong>
	      <span>综合分 ${Number(signal.score || 0).toFixed(1)} · 1日 ${formatPct(signal.avg1d || 0)} · 5日 ${formatPct(signal.avg5d || 0)} · 20日 ${formatPct(signal.avg20d || 0)}</span>
	      <small>${sourceNote}${startupHint ? ` ${startupHint}` : ""}</small>
	    </div>
    ${displayRows.map((row) => row.error ? `
      <article class="index-card error">
        <div><strong>${row.label}</strong><span>${row.symbol}</span></div>
        <p>${compactDisplayError(row.error)}</p>
      </article>
    ` : `
      <article class="index-card">
        <div><strong>${row.label}</strong><span>${row.note || row.displaySymbol || row.symbol}${row.displaySymbol && row.displaySymbol !== row.symbol ? ` · 实际 ${row.symbol}` : ""}</span></div>
        <strong class="index-price">${formatIndexValue(row)}</strong>
	        <div class="tag-row">
	          <span class="tag ${tagClass(row.change1d || 0, 0.3, -0.3)}">当日 ${formatPct(row.change1d || 0)}</span>
	          <span class="tag ${row.quoteOnly ? "" : tagClass(row.projectedUpside || 0, 1.2, -0.5)}">预估 ${row.quoteOnly ? "K线不足" : formatPct(row.projectedUpside || 0)}</span>
	          <span class="tag ${row.quoteOnly ? "" : tagClass(row.confidence || 0, 62, 45)}">置信 ${row.quoteOnly ? "暂停" : `${Math.round(row.confidence || 0)}%`}</span>
	        </div>
	        <p>${row.latestDate || ""} · ${row.source || startupHint || "等待行情源"}${row.warning ? ` · ${compactDisplayError(row.warning)}` : ""}</p>
	      </article>
	    `).join("")}
    ${marketIndexChartHtml(chartRows)}
  `;
  requestAnimationFrame(() => drawIndexChart(selectedMarketIndexRow()));
  renderMarketRegimePanel();
}

function regimeVectorSvg(dimensions = []) {
  const size = 260;
  const center = size / 2;
  const radius = 92;
  const rows = dimensions.length ? dimensions : [
    { label: "Feature", value: 50 },
    { label: "Factor", value: 50 },
    { label: "News", value: 50 },
    { label: "Index", value: 50 },
  ];
  const point = (index, value = 100) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / rows.length;
    const scaled = radius * clamp(Number(value || 0), 0, 100) / 100;
    return {
      x: center + Math.cos(angle) * scaled,
      y: center + Math.sin(angle) * scaled,
      lx: center + Math.cos(angle) * (radius + 26),
      ly: center + Math.sin(angle) * (radius + 26),
    };
  };
  const rings = [25, 50, 75, 100].map((value) => rows.map((_, index) => {
    const { x, y } = point(index, value);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" "));
  const polygon = rows.map((row, index) => {
    const { x, y } = point(index, row.value);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const axes = rows.map((row, index) => {
    const outer = point(index, 100);
    const label = point(index, 100);
    return `
      <line x1="${center}" y1="${center}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}"></line>
      <text x="${label.lx.toFixed(1)}" y="${label.ly.toFixed(1)}">${escapeHtml(row.label)}</text>
    `;
  }).join("");
  const points = rows.map((row, index) => {
    const { x, y } = point(index, row.value);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"><title>${escapeHtml(row.label)} ${formatCompactNumber(row.value, 1)}</title></circle>`;
  }).join("");
  return `
    <svg class="regime-vector-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Regime vector">
      ${rings.map((ring) => `<polygon class="regime-ring" points="${ring}"></polygon>`).join("")}
      <g class="regime-axis">${axes}</g>
      <polygon class="regime-polygon" points="${polygon}"></polygon>
      <g class="regime-points">${points}</g>
    </svg>
  `;
}

function regimeTriggerHtml(row) {
  const value = Number(row.value || 0);
  const stance = value >= 8 ? "positive" : value <= -8 ? "negative" : "neutral";
  const width = Math.max(4, Math.min(100, 50 + value * 2.2));
  return `
    <div class="regime-trigger ${stance}">
      <div>
        <strong>${escapeHtml(row.label)}</strong>
        <span>${escapeHtml(row.note || "")}</span>
      </div>
      <em>${value >= 0 ? "+" : ""}${formatCompactNumber(value, 1)}</em>
      <i><b style="width:${width}%"></b></i>
    </div>
  `;
}

function renderMarketRegimePanel() {
  const target = $("marketRegimePanel");
  if (!target) return;
  const availableItems = [...state.analyses.values()]
    .filter((item) => item?.symbol && item?.analysis?.action !== "ERROR" && Number(item?.technicals?.close || 0) > 0);
  const rows = availableItems
    .map((item) => {
      const technicals = normalizeTechnicals(item.technicals);
      const analysis = normalizeAnalysis(item.analysis);
      const change5d = Number(technicals.change5d || 0);
      const change20d = Number(technicals.change20d || 0);
      const score = change5d * 0.42 + change20d * 0.38 + (Number(technicals.trendScore || 50) - 50) * 0.12 + (Number(analysis.confidence || 50) - 50) * 0.08;
      return {
        symbol: item.symbol,
        change5d,
        change20d,
        score,
        confidence: Number(analysis.confidence || 0),
        action: analysis.action,
        sector: item?.fundamentals?.sector || sectorOf(item.symbol),
        technicals,
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!rows.length) {
    target.innerHTML = `<p class="muted">股票池尚未完成真实行情分析；刷新监控池后生成市场宽度和领涨领跌队列。</p>`;
    return;
  }
  const positive = rows.filter((row) => row.change5d > 0).length;
  const negative = rows.filter((row) => row.change5d < 0).length;
  const buySignals = rows.filter((row) => isBuyAction(row.action)).length;
  const coverage = state.watchlist.length ? rows.length / state.watchlist.length * 100 : 100;
  const breadth = positive / Math.max(1, positive + negative) * 100;
  const leaders = rows.slice(0, 30);
  const laggards = rows.slice().reverse().slice(0, 30);
  const average = (values) => {
    const numbers = values.map(Number).filter(Number.isFinite);
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
  };
  const sectorMap = new Map();
  rows.forEach((row) => {
    const current = sectorMap.get(row.sector) || { sector: row.sector, count: 0, score: 0, change5d: 0, change20d: 0 };
    current.count += 1;
    current.score += row.score;
    current.change5d += row.change5d;
    current.change20d += row.change20d;
    sectorMap.set(row.sector, current);
  });
  const sectorRows = [...sectorMap.values()]
    .map((row) => ({ ...row, score: row.score / row.count, change5d: row.change5d / row.count, change20d: row.change20d / row.count }))
    .sort((a, b) => b.score - a.score);
  const factorEvidence = [
    ["macro", "宏观/央行"],
    ["sector", "行业/产业链"],
    ["marketRegime", "市场状态"],
    ["flowOptions", "资金/期权"],
    ["relativeStrength", "相对强弱"],
    ["liquidity", "流动性"],
  ].map(([key, label]) => {
    const values = availableItems.map((item) => item.factors?.[key]).filter((factor) => factor && factor.available !== false);
    return {
      key,
      label,
      count: values.length,
      score: average(values.map((factor) => factor.score)),
      theses: [...new Set(values.flatMap((factor) => factor.thesis || []))].slice(0, 3),
    };
  });
  const newsMap = new Map();
  availableItems.flatMap((item) => item.news || []).forEach((news) => {
    const key = `${news.title || ""}|${news.link || ""}`;
    if (!news.title || newsMap.has(key)) return;
    newsMap.set(key, news);
  });
  const newsRows = [...newsMap.values()];
  const politicalPattern = /war|missile|sanction|tariff|election|government|president|minister|central bank|rate cut|rate hike|战争|制裁|关税|选举|政府|总统|总理|央行|降息|加息/i;
  const technologyPattern = /ai|chip|semiconductor|nvidia|data center|cloud|robot|人工智能|芯片|半导体|数据中心|云计算|机器人/i;
  const politicalRows = newsRows.filter((row) => politicalPattern.test(`${row.title || ""} ${row.description || ""}`)).slice(0, 8);
  const technologyRows = newsRows.filter((row) => technologyPattern.test(`${row.title || ""} ${row.description || ""}`)).slice(0, 8);
  const channelCounts = new Map();
  newsRows.forEach((row) => {
    const channel = String(row.channel || row.impactScope || "company").slice(0, 40);
    const current = channelCounts.get(channel) || { channel, count: 0, weight: 0 };
    current.count += 1;
    current.weight += asNumber(row.impactWeight, 0);
    channelCounts.set(channel, current);
  });
  const newsChannels = [...channelCounts.values()].sort((a, b) => b.weight - a.weight || b.count - a.count).slice(0, 10);
  const featureScore = average(rows.map((row) => (
    Number(row.technicals.trendScore || 50) * 0.32
    + Number(row.technicals.momentumScore || 50) * 0.28
    + Number(row.technicals.volumeScore || 50) * 0.2
    + Number(row.technicals.riskScore || 50) * 0.2
  )));
  const avgRiskScore = average(rows.map((row) => Number(row.technicals.riskScore || 50)));
  const avgVolumeScore = average(rows.map((row) => Number(row.technicals.volumeScore || 50)));
  const avgTrendScore = average(rows.map((row) => Number(row.technicals.trendScore || 50)));
  const concentrationTop5 = rows.slice(0, 5).reduce((sum, row) => sum + Math.max(0, row.score), 0) / Math.max(1, rows.reduce((sum, row) => sum + Math.max(0, row.score), 0)) * 100;
  const factorScore = average(factorEvidence.map((row) => row.score));
  const newsPressure = average(newsRows.map((row) => asNumber(row.impactWeight, 0))) * 10;
  const indexScore = Number(state.marketIndexSignal?.score || 0) * 4;
  const fusionScore = featureScore - 50 + factorScore * 1.4 + newsPressure + indexScore;
  const fusionState = fusionScore >= 8 ? "risk-on" : fusionScore <= -8 ? "risk-off" : "range";
  const volatilityProxy = Math.max(0, 100 - avgRiskScore);
  const regimePhase = fusionState === "risk-on" && breadth >= 58 && avgTrendScore >= 56
    ? "markup"
    : fusionState === "risk-off" && breadth <= 42
      ? "markdown"
      : volatilityProxy >= 54
        ? "volatile-distribution"
        : breadth >= 50 && avgVolumeScore >= 56
          ? "accumulation"
          : "range";
  const fusionDrivers = [
    { label: "特征", value: featureScore - 50 },
    { label: "因子", value: factorScore },
    { label: "新闻", value: newsPressure },
    { label: "指数", value: indexScore },
  ].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const regimeDimensions = [
    { label: "Feature", value: clamp(featureScore, 0, 100) },
    { label: "Factor", value: clamp(50 + factorScore * 3, 0, 100) },
    { label: "News", value: clamp(50 + newsPressure * 4, 0, 100) },
    { label: "Index", value: clamp(50 + indexScore * 4, 0, 100) },
    { label: "Breadth", value: clamp(breadth, 0, 100) },
    { label: "Volatility", value: clamp(volatilityProxy, 0, 100) },
  ];
  const regimeTriggers = [
    { label: "趋势广度", value: breadth - 50, note: `上涨宽度 ${formatPct(breadth)}` },
    { label: "量能扩张", value: avgVolumeScore - 50, note: `Volume score ${formatCompactNumber(avgVolumeScore, 1)}` },
    { label: "因子一致", value: factorScore, note: `${factorEvidence.filter((row) => row.count).length} 组因子有覆盖` },
    { label: "新闻压力", value: newsPressure, note: `${newsRows.length} 条去重新闻证据` },
    { label: "指数确认", value: indexScore, note: state.marketIndexSignal?.stance || "mixed" },
    { label: "集中度风险", value: 32 - concentrationTop5, note: `Top5 正贡献占比 ${formatPct(concentrationTop5)}` },
  ];
  const listHtml = (items) => items.map((row) => `
    <button class="regime-stock-row" type="button" data-regime-symbol="${escapeHtml(row.symbol)}">
      <strong>${escapeHtml(row.symbol)}</strong>
      <span>5日 ${formatPct(row.change5d)}</span>
      <span>20日 ${formatPct(row.change20d)}</span>
      <span>综合 ${formatCompactNumber(row.score, 1)}</span>
    </button>
  `).join("");
  target.innerHTML = `
    <div class="market-breadth-grid">
      <div><span>分析覆盖</span><strong>${rows.length} / ${state.watchlist.length || rows.length}</strong><small>${formatPct(coverage)}</small></div>
      <div><span>5日上涨宽度</span><strong>${formatPct(breadth)}</strong><small>上涨 ${positive} · 下跌 ${negative}</small></div>
      <div><span>当前买入信号</span><strong>${buySignals}</strong><small>仍需满足你的置信与仓位约束</small></div>
      <div><span>大盘状态</span><strong>${escapeHtml(state.marketIndexSignal?.stance || "mixed")}</strong><small>指数与股票池共同复核</small></div>
    </div>
    <div class="regime-fusion-strip ${fusionState}">
      <div>
        <span>Feature + Factor + Regime 联合判定</span>
        <strong>${fusionState === "risk-on" ? "风险偏好打开" : fusionState === "risk-off" ? "风险收缩/防守" : "震荡观察"}</strong>
        <small>阶段 ${escapeHtml(regimePhase)} · 融合分 ${fusionScore >= 0 ? "+" : ""}${formatCompactNumber(fusionScore, 1)}</small>
      </div>
      <div class="regime-fusion-score">
        <i style="width:${Math.max(4, Math.min(100, 50 + fusionScore * 2))}%"></i>
      </div>
      <div class="regime-driver-list">
        ${fusionDrivers.map((row) => `<span class="${row.value >= 0 ? "good-text" : "danger-text"}">${row.label} ${row.value >= 0 ? "+" : ""}${formatCompactNumber(row.value, 1)}</span>`).join("")}
      </div>
    </div>
    <div class="regime-lab-grid">
      <section class="regime-vector-card">
        <h3>Regime 多维向量</h3>
        ${regimeVectorSvg(regimeDimensions)}
      </section>
      <section class="regime-trigger-card">
        <h3>触发器矩阵</h3>
        <div class="regime-trigger-grid">
          ${regimeTriggers.map(regimeTriggerHtml).join("")}
        </div>
      </section>
    </div>
    <div class="regime-evidence-grid">
      <section>
        <h3>技术状态</h3>
        <div class="regime-evidence-metrics">
          <span>趋势均值 <strong>${formatCompactNumber(average(rows.map((row) => row.technicals.trendScore)), 1)}</strong></span>
          <span>动量均值 <strong>${formatCompactNumber(average(rows.map((row) => row.technicals.momentumScore)), 1)}</strong></span>
          <span>量能均值 <strong>${formatCompactNumber(average(rows.map((row) => row.technicals.volumeScore)), 1)}</strong></span>
          <span>风险均值 <strong>${formatCompactNumber(average(rows.map((row) => row.technicals.riskScore)), 1)}</strong></span>
        </div>
      </section>
      <section>
        <h3>因子状态</h3>
        <div class="regime-evidence-list">
          ${factorEvidence.map((row) => `<div><strong>${escapeHtml(row.label)}</strong><span class="${row.score >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(row.score, 2)}</span><small>覆盖 ${row.count}/${rows.length}${row.theses[0] ? ` · ${escapeHtml(row.theses[0])}` : ""}</small></div>`).join("")}
        </div>
      </section>
      <section>
        <h3>行业强弱</h3>
        <div class="regime-evidence-list">
          ${sectorRows.slice(0, 10).map((row) => `<div><strong>${escapeHtml(row.sector)}</strong><span class="${row.score >= 0 ? "good-text" : "danger-text"}">${formatCompactNumber(row.score, 1)}</span><small>${row.count} 只 · 5日 ${formatPct(row.change5d)} · 20日 ${formatPct(row.change20d)}</small></div>`).join("")}
        </div>
      </section>
      <section>
        <h3>真实新闻覆盖</h3>
        <div class="regime-evidence-list">
          ${newsChannels.length ? newsChannels.map((row) => `<div><strong>${escapeHtml(row.channel)}</strong><span>${row.count}</span><small>累计影响权重 ${formatCompactNumber(row.weight, 2)}</small></div>`).join("") : `<p class="muted small-text">当前分析结果未返回真实新闻，不生成消息面结论。</p>`}
        </div>
      </section>
    </div>
    <div class="regime-news-columns">
      <section>
        <h3>政治 / 战事 / 央行证据 ${politicalRows.length}</h3>
        <div class="regime-news-list">${politicalRows.length ? politicalRows.map((row) => `<div><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.publisher || row.source || "")} · ${escapeHtml(row.channel || row.impactScope || "macro")} · 权重 ${formatCompactNumber(row.impactWeight, 2)}</span></div>`).join("") : `<p class="muted small-text">当前真实新闻中没有命中政治、战事或央行主题。</p>`}</div>
      </section>
      <section>
        <h3>科技 / AI / 产业证据 ${technologyRows.length}</h3>
        <div class="regime-news-list">${technologyRows.length ? technologyRows.map((row) => `<div><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.publisher || row.source || "")} · ${escapeHtml(row.channel || row.impactScope || "industry")} · 权重 ${formatCompactNumber(row.impactWeight, 2)}</span></div>`).join("") : `<p class="muted small-text">当前真实新闻中没有命中科技或 AI 主题。</p>`}</div>
      </section>
    </div>
    <div class="regime-columns">
      <section><h3>领涨队列 Top ${leaders.length}</h3><div class="regime-stock-list">${listHtml(leaders)}</div></section>
      <section><h3>领跌队列 Bottom ${laggards.length}</h3><div class="regime-stock-list">${listHtml(laggards)}</div></section>
    </div>
  `;
  target.querySelectorAll("[data-regime-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected = button.dataset.regimeSymbol;
      setWorkspacePage("dashboard");
      renderCards();
      renderDetail();
    });
  });
}

function universeStorageKey(market = state.market) {
  return safeMarket(market);
}

function normalizeUniverseRows(rows = [], market = state.market) {
  const key = safeMarket(market);
  const bySymbol = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const symbol = normalizeSymbolForMarket(row?.symbol || row?.code || row, key);
    if (!symbol) return;
    bySymbol.set(symbol, {
      symbol,
      code: normalizeSymbolForMarket(row?.code || symbol, key) || symbol,
      name: String(row?.name || symbol).slice(0, 120),
      market: key,
      exchange: String(row?.exchange || key).slice(0, 40),
      sector: String(row?.sector || "").slice(0, 90),
      industry: String(row?.industry || "").slice(0, 120),
      source: String(row?.source || "server-universe").slice(0, 80),
      type: String(row?.type || "stock").slice(0, 40),
    });
  });
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function saveUniverseState() {
  safeStorage.setItem("marketUniverseByMarket", JSON.stringify(state.marketUniverseByMarket));
  safeStorage.setItem("universeStatusByMarket", JSON.stringify(state.universeStatusByMarket));
}

function cachedUniverseRows(market = state.market) {
  return normalizeUniverseRows(state.marketUniverseByMarket[universeStorageKey(market)] || [], market);
}

function universeForMarket(options = {}) {
  const key = safeMarket(options.market || state.market);
  const cached = cachedUniverseRows(key).map((row) => row.symbol);
  const fallback = sanitizeSymbolsForMarket(MARKET_UNIVERSES[key] || MARKET_CONFIG[key].defaultSymbols, key);
  const merged = [...new Set([...fallback, ...cached])].filter((symbol) => allowWatchSymbolForMarket(symbol, key, "ai-pick"));
  return options.forPicker ? merged.slice(0, AI_PICK_UNIVERSE_LIMIT) : merged;
}

function renderUniversePanel() {
  const panel = $("universePanel");
  if (!panel) return;
  const key = universeStorageKey();
  const status = state.universeStatusByMarket[key] || {};
  const rows = cachedUniverseRows();
  const fallback = sanitizeSymbolsForMarket(MARKET_UNIVERSES[key] || activeMarketConfig().defaultSymbols, key);
  if (!rows.length) {
    panel.innerHTML = `
      <div class="universe-empty">
        <p class="muted">尚未读取 ${activeMarketConfig().label} 全市场股票池。AI选股当前只能回退核心小池 ${fallback.length} 只。</p>
        ${status.error ? `<p class="quant-error">${escapeHtml(compactDisplayError(status.error))}</p>` : ""}
      </div>
    `;
    return;
  }
  const preview = rows.slice(0, 160);
  const scanCount = universeForMarket({ forPicker: true }).length;
  panel.innerHTML = `
    <div class="universe-summary-grid">
      <div><span>全市场股票</span><strong>${formatCompactNumber(status.count || rows.length, 0)}</strong><small>${activeMarketConfig().label}</small></div>
      <div><span>本地可用</span><strong>${formatCompactNumber(rows.length, 0)}</strong><small>${status.cache || "browser"} 缓存</small></div>
      <div><span>AI候选扫描</span><strong>${formatCompactNumber(scanCount, 0)}</strong><small>保护API与速度</small></div>
      <div><span>来源</span><strong>${escapeHtml(status.source || rows[0]?.source || "unknown")}</strong><small>${status.fetchedAt ? new Date(status.fetchedAt).toLocaleString() : "无时间戳"}</small></div>
    </div>
    ${status.error ? `<p class="quant-warning">${escapeHtml(compactDisplayError(status.error))}</p>` : ""}
    <div class="universe-list">
      ${preview.map((row) => `
        <button class="universe-chip" data-universe-add="${row.symbol}" type="button">
          <strong>${escapeHtml(row.symbol)}</strong>
          <span>${escapeHtml(row.name)}</span>
          <small>${escapeHtml(row.industry || row.exchange || row.source)}</small>
        </button>
      `).join("")}
    </div>
    <p class="muted small-text">预览 ${preview.length}/${rows.length} 只；点击代码可加入监控。完整列表保存在本地浏览器，并由服务端 .cache 持久化。</p>
  `;
  panel.querySelectorAll("[data-universe-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const symbol = allowWatchSymbolForMarket(button.dataset.universeAdd, state.market, "universe");
      if (!symbol) return;
      addWatchSymbol(symbol, "universe", state.market);
      saveState();
      renderCards();
      setStatus(`${symbol} 已从全市场股票池加入监控`);
    });
  });
}

async function loadMarketUniverse(force = false, showStatus = true) {
  const key = universeStorageKey();
  const loadButton = $("loadUniverse");
  const refreshButton = $("refreshUniverse");
  if (loadButton) loadButton.disabled = true;
  if (refreshButton) refreshButton.disabled = true;
  if (showStatus) setStatus(`${activeMarketConfig().label}股票池读取中${force ? "，正在强制重读外部源" : ""}...`);
  try {
    const payload = await requestJson(`/api/universe?market=${encodeURIComponent(state.market)}&limit=20000${force ? "&refresh=true" : ""}`);
    const rows = normalizeUniverseRows(payload.rows || [], state.market);
    state.marketUniverseByMarket[key] = rows;
    state.universeStatusByMarket[key] = {
      source: payload.source,
      cache: payload.cache,
      fetchedAt: payload.fetchedAt,
      count: payload.count,
      filteredCount: payload.filteredCount,
      error: "",
      updatedAt: new Date().toISOString(),
    };
    saveUniverseState();
    renderUniversePanel();
    if (showStatus) setStatus(`${activeMarketConfig().label}股票池已读取：${payload.count} 只，来源 ${payload.source}，缓存 ${payload.cache || "live"}`);
    return rows;
  } catch (error) {
    state.universeStatusByMarket[key] = {
      ...(state.universeStatusByMarket[key] || {}),
      error: error.message,
      updatedAt: new Date().toISOString(),
    };
    saveUniverseState();
    renderUniversePanel();
    if (showStatus) setStatus(`股票池读取失败：${compactDisplayError(error.message)}；AI选股将回退核心小池`);
    return cachedUniverseRows();
  } finally {
    if (loadButton) loadButton.disabled = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

function normalizeMoverRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const symbol = normalizeSymbolForMarket(row?.symbol, state.market);
    if (!symbol) return null;
    return {
      symbol,
      name: String(row?.name || symbol).slice(0, 140),
      price: Number(row?.price),
      change: Number(row?.change),
      changePercent: Number(row?.changePercent),
      volume: Number(row?.volume),
      amount: Number(row?.amount),
      turnoverRate: Number(row?.turnoverRate),
      reason: String(row?.reason || "").slice(0, 240),
      source: row?.source || "",
    };
  }).filter(Boolean);
}

function marketMoversForCurrentMarket() {
  const key = universeStorageKey();
  const saved = state.marketMoversByMarket[key] || {};
  return {
    market: key,
    source: saved.source || "",
    coverage: saved.coverage || "",
    scanned: asNumber(saved.scanned, 0),
    totalUniverse: asNumber(saved.totalUniverse, 0),
    warning: saved.warning || "",
    updatedAt: saved.updatedAt || null,
    gainers: normalizeMoverRows(saved.gainers || []),
    losers: normalizeMoverRows(saved.losers || []),
    dragonTiger: {
      available: saved.dragonTiger?.available === true,
      source: saved.dragonTiger?.source || "",
      warning: saved.dragonTiger?.warning || "",
      rows: normalizeMoverRows(saved.dragonTiger?.rows || []),
    },
  };
}

function saveMarketMoversState() {
  safeStorage.setItem("marketMoversByMarket", JSON.stringify(state.marketMoversByMarket));
}

function moverRowHtml(row, type) {
  const inWatchlist = state.watchlist.includes(row.symbol);
  const change = Number(row.changePercent || 0);
  const tone = change >= 0 ? "positive" : "negative";
  return `
    <div class="mover-row ${tone}">
      <button type="button" data-mover-select="${escapeHtml(row.symbol)}">
        <strong>${escapeHtml(row.symbol)}</strong>
        <span>${escapeHtml(row.name || "")}</span>
      </button>
      <em>${formatPct(change)}</em>
      <small>${Number.isFinite(row.price) ? formatMoney(row.price) : "价格未返回"}${Number.isFinite(row.volume) ? ` · 量 ${formatCompactNumber(row.volume, 1)}` : ""}${Number.isFinite(row.turnoverRate) ? ` · 换手 ${formatPct(row.turnoverRate)}` : ""}</small>
      ${row.reason ? `<p>${escapeHtml(row.reason)}</p>` : ""}
      <button class="secondary mini-btn" type="button" data-mover-add="${escapeHtml(row.symbol)}" data-mover-type="${escapeHtml(type)}" ${inWatchlist ? "disabled" : ""}>${inWatchlist ? "已监控" : "加入"}</button>
    </div>
  `;
}

function moverColumnHtml(title, rows, emptyText, type) {
  return `
    <section>
      <h3>${escapeHtml(title)}</h3>
      <div class="mover-list">
        ${rows.length ? rows.map((row) => moverRowHtml(row, type)).join("") : `<p class="muted small-text">${escapeHtml(emptyText)}</p>`}
      </div>
    </section>
  `;
}

function renderMarketMoversPanel() {
  const panel = $("marketMoversPanel");
  if (!panel) return;
  const movers = marketMoversForCurrentMarket();
  if (!movers.gainers.length && !movers.losers.length && !movers.dragonTiger.rows.length) {
    panel.innerHTML = `<p class="muted">尚未读取${activeMarketConfig().label}涨跌榜。点击读取榜单后显示真实上涨/下跌排行。</p>`;
    return;
  }
  const coverageText = movers.coverage === "full-market-ranking" || movers.coverage === "full-market-screener"
    ? "全市场榜单"
    : movers.coverage === "full-universe-quote-scan"
      ? `全 universe 扫描 ${formatCompactNumber(movers.scanned, 0)} 只`
      : movers.scanned
        ? `部分扫描 ${formatCompactNumber(movers.scanned, 0)} / ${formatCompactNumber(movers.totalUniverse || movers.scanned, 0)} 只`
        : "覆盖未返回";
  panel.innerHTML = `
    <div class="mover-meta">
      <span>来源 <strong>${escapeHtml(movers.source || "unknown")}</strong></span>
      <span>覆盖 <strong>${coverageText}</strong></span>
      <span>更新时间 <strong>${movers.updatedAt ? new Date(movers.updatedAt).toLocaleString() : "刚刚"}</strong></span>
    </div>
    ${movers.warning ? `<p class="quant-warning">${escapeHtml(compactDisplayError(movers.warning))}</p>` : ""}
    <div class="mover-columns">
      ${moverColumnHtml("当日上涨最多", movers.gainers, "真实榜单源暂未返回上涨排行。", "gainer")}
      ${moverColumnHtml("当日下跌最多", movers.losers, "真实榜单源暂未返回下跌排行。", "loser")}
      ${moverColumnHtml("龙虎榜 / 异动披露", movers.dragonTiger.rows, movers.dragonTiger.warning || "当前市场没有可用龙虎榜披露源。", "dragon-tiger")}
    </div>
  `;
  panel.querySelectorAll("[data-mover-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const symbol = allowWatchSymbolForMarket(button.dataset.moverAdd, state.market, button.dataset.moverType || "mover");
      if (!symbol) return;
      addWatchSymbol(symbol, button.dataset.moverType || "mover", state.market);
      saveState();
      renderCards();
      renderMarketMoversPanel();
      setStatus(`${symbol} 已从榜单加入监控台`);
    });
  });
  panel.querySelectorAll("[data-mover-select]").forEach((button) => {
    button.addEventListener("click", () => {
      const symbol = normalizeSymbolForMarket(button.dataset.moverSelect, state.market);
      if (!symbol) return;
      if (!state.watchlist.includes(symbol)) {
        addWatchSymbol(symbol, "mover", state.market);
        saveState();
      }
      state.selected = symbol;
      renderCards();
      renderDetail();
      setStatus(`${symbol} 已加入/选中；刷新后生成完整分析`);
    });
  });
}

async function loadMarketMovers(force = false, showStatus = true) {
  const button = $("refreshMarketMovers");
  if (button) button.disabled = true;
  if (showStatus) setStatus(`正在读取${activeMarketConfig().label}真实涨跌榜...`);
  try {
    const payload = await requestJson(`/api/market-movers?market=${encodeURIComponent(state.market)}&limit=30${force ? "&refresh=true" : ""}`);
    state.marketMoversByMarket[universeStorageKey()] = payload;
    saveMarketMoversState();
    renderMarketMoversPanel();
    if (showStatus) setStatus(`${activeMarketConfig().label}涨跌榜已更新：上涨 ${payload.gainers?.length || 0} / 下跌 ${payload.losers?.length || 0}`);
    return payload;
  } catch (error) {
    const existing = state.marketMoversByMarket[universeStorageKey()] || {};
    state.marketMoversByMarket[universeStorageKey()] = { ...existing, warning: error.message, updatedAt: existing.updatedAt || new Date().toISOString() };
    saveMarketMoversState();
    renderMarketMoversPanel();
    if (showStatus) setStatus(`涨跌榜读取失败：${compactDisplayError(error.message)}`);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function todayPickScore(item) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const candles = item.candles || [];
  const latest = candles.at(-1) || {};
  const previous = candles.at(-2) || {};
  const change1d = pctChange(latest.close, previous.close);
  const quoteChange = Number(item.quote?.changePercent ?? item.quote?.changePct);
  const realTimeMove = Number.isFinite(quoteChange) ? quoteChange : change1d;
  const reliability = predictionReliability(analysis);
  const magnitudeProb = magnitudeProbability(analysis);
  const maxProb = maxUpsideProbability(analysis);
  const targetProb = strategyProbability(analysis);
  const ensemble = analysis.ensemble || {};
  return realTimeMove * 4.2
    + technicals.volumeRatio * 8
    + (technicals.momentumScore - 50) * 0.42
    + (technicals.trendScore - 50) * 0.18
    + Math.max(0, technicals.macdHistogram) * 18
    + reliability * 0.06
    + magnitudeProb * 0.08
    + maxProb * 0.06
    + targetProb * 0.07
    + Number(ensemble.consensusAgreement || 0) * 0.06
    - Number(analysis.downsideConfidence || 0) * 0.08;
}

function predictionReliability(analysis) {
  return Number(analysis.predictionConfidence ?? analysis.confidence ?? 0);
}

function directionLabel(analysis) {
  const projected = projectedFinalReturn(analysis);
  const direction = String(analysis.direction || "").toLowerCase();
  if (direction === "downside" || projected < -0.35) return "看跌";
  if (direction === "upside" || projected > 0.35) return "看涨";
  return "中性";
}

function directionReliability(analysis) {
  const projected = Number(analysis.projectedFinalReturn ?? analysis.projectedUpside ?? 0);
  if (projected < -0.35) return Number(analysis.downsideConfidence || analysis.directionAgreement || analysis.predictionConfidence || analysis.confidence || 0);
  if (projected > 0.35) return Number(analysis.upsideConfidence || analysis.directionAgreement || analysis.predictionConfidence || analysis.confidence || 0);
  return Number(analysis.directionAgreement || analysis.predictionConfidence || analysis.confidence || 0);
}

function magnitudeProbability(analysis) {
  const value = Number(analysis.magnitudeHitProbability ?? analysis.magnitudeConfidence ?? analysis.moveHitProbability ?? analysis.projectedMoveConfidence ?? analysis.qualityGate?.magnitudeHitProbability ?? 0);
  if (value > 0) return value;
  const projected = Math.abs(projectedFinalReturn(analysis));
  const reliability = directionReliability(analysis);
  const uncertaintyPenalty = Math.min(28, projected * 4.2);
  return clamp(reliability * 0.82 - uncertaintyPenalty + 8, 0, 88);
}

function projectedFinalReturn(analysis) {
  return Number(analysis.projectedFinalReturn ?? analysis.projectedUpside ?? 0);
}

function finalReturnProbability(analysis) {
  const value = Number(analysis.finalReturnHitProbability ?? analysis.finalReturnConfidence ?? analysis.qualityGate?.finalReturnHitProbability ?? 0);
  if (value > 0) return value;
  const finalMove = Math.abs(projectedFinalReturn(analysis));
  return clamp(magnitudeProbability(analysis) - Math.min(18, finalMove * 2.2), 0, 90);
}

function projectedMaxUpside(analysis) {
  const explicit = Number(analysis.projectedMaxUpside ?? analysis.qualityGate?.projectedMaxUpside);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(0, Number(analysis.projectedUpside || 0));
}

function maxUpsideProbability(analysis) {
  const value = Number(analysis.maxUpsideHitProbability ?? analysis.maxUpsideConfidence ?? analysis.qualityGate?.maxUpsideHitProbability ?? 0);
  if (value > 0) return value;
  const maxMove = projectedMaxUpside(analysis);
  return clamp(magnitudeProbability(analysis) - Math.min(14, Math.max(0, maxMove - Math.abs(projectedFinalReturn(analysis))) * 2.6), 0, 90);
}

function selectionUpside(analysis) {
  return Math.max(0, projectedFinalReturn(analysis), projectedMaxUpside(analysis) * 0.72);
}

function strategyProbability(analysis) {
  const value = Number(analysis.strategyHitProbability ?? analysis.strategyConfidence ?? analysis.qualityGate?.strategyHitProbability ?? analysis.qualityGate?.historyGate?.strategyHitProbability ?? 0);
  if (value > 0) return value;
  return selectionUpside(analysis) > 0 ? predictionReliability(analysis) * 0.72 : 0;
}

function strategyProbabilityTarget(analysis) {
  const strategy = getStrategy();
  return Math.max(55, Math.min(76, Number(analysis.qualityGate?.strategyProbabilityTarget || (Number(strategy.confidence || 80) - 10))));
}

function decisionExplanation(item) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const strategy = getStrategy();
  const targetProb = strategyProbability(analysis);
  const targetRequired = strategyProbabilityTarget(analysis);
  const confidenceRequired = Number(strategy.confidence || 80);
  const trendRequired = 54;
  const volumeRequired = 0.8;
  const factorScore = factorScoreForItem(item);
  const liveFactorCount = factorRows(item.factors).filter(([, factor]) => factor?.available !== false && factor?.values?.proxy !== true).length;
  const newsCount = Number(item.news?.length || 0);
  const riskLimit = Math.max(42, Math.min(68, confidenceRequired - 18));
  const capital = getCapital();
  const suggested = Number(analysis.suggestedTradeValue || 0);
  const checks = [
    {
      key: "confidence",
      label: "综合置信",
      value: Number(analysis.confidence || 0),
      required: confidenceRequired,
      pass: Number(analysis.confidence || 0) >= confidenceRequired,
      note: `${Math.round(Number(analysis.confidence || 0))}% / ${Math.round(confidenceRequired)}%`,
    },
    {
      key: "target",
      label: "策略达标",
      value: targetProb,
      required: targetRequired,
      pass: targetProb >= targetRequired,
      note: `${Math.round(targetProb)}% / ${Math.round(targetRequired)}%`,
    },
    {
      key: "upside",
      label: "目标涨幅",
      value: projectedMaxUpside(analysis),
      required: Number(strategy.targetUpside || 5),
      pass: projectedMaxUpside(analysis) >= Number(strategy.targetUpside || 5) || projectedFinalReturn(analysis) >= Number(strategy.targetUpside || 5) * 0.62,
      note: `最高 ${formatPct(projectedMaxUpside(analysis))} / 目标 ${formatPct(strategy.targetUpside)}`,
    },
    {
      key: "trend",
      label: "趋势",
      value: technicals.trendScore,
      required: trendRequired,
      pass: technicals.trendScore >= trendRequired && technicals.macdHistogram > -0.02,
      note: `趋势 ${technicals.trendScore.toFixed(0)} · MACD ${technicals.macdHistogram.toFixed(4)}`,
    },
    {
      key: "volume",
      label: "量能",
      value: technicals.volumeRatio,
      required: volumeRequired,
      pass: technicals.volumeRatio >= volumeRequired,
      note: `量比 ${technicals.volumeRatio.toFixed(2)}x`,
    },
    {
      key: "news",
      label: "新闻",
      value: newsCount,
      required: 1,
      pass: newsCount >= 1,
      note: newsCount ? `${newsCount} 条，最高权重 ${Math.max(...item.news.map((row) => Number(row.impactWeight || 0))).toFixed(2)}` : "本地/实时新闻为空",
    },
    {
      key: "factor",
      label: "因子",
      value: factorScore,
      required: 0,
      pass: liveFactorCount >= 2 || factorScore >= 0,
      note: `真实因子 ${liveFactorCount} 个 · 分数 ${factorScore.toFixed(1)}`,
    },
    {
      key: "risk",
      label: "风险",
      value: Number(analysis.downsideConfidence || 0),
      required: riskLimit,
      pass: !isRiskAction(analysis.action) && Number(analysis.downsideConfidence || 0) <= riskLimit,
      note: `下跌倾向 ${Math.round(Number(analysis.downsideConfidence || 0))}% / 上限 ${Math.round(riskLimit)}%`,
    },
    {
      key: "capital",
      label: "仓位",
      value: capital.availableForNewTrades,
      required: suggested,
      pass: suggested <= 0 || capital.availableForNewTrades >= Math.min(suggested, technicals.close || suggested),
      note: `可新买 ${formatMoney(capital.availableForNewTrades)} · 建议 ${formatMoney(suggested)}`,
    },
  ];
  const blockers = checks.filter((row) => !row.pass);
  const buyScore = clamp(
    Number(analysis.confidence || 0) * 0.24
      + targetProb * 0.24
      + maxUpsideProbability(analysis) * 0.12
      + technicals.trendScore * 0.12
      + Math.min(100, technicals.volumeRatio * 45) * 0.08
      + Math.max(0, factorScore + 20) * 0.12
      + Math.min(100, newsCount * 16) * 0.08
      - Math.max(0, Number(analysis.downsideConfidence || 0) - 35) * 0.18,
    0,
    100
  );
  return {
    buyScore,
    threshold: targetRequired,
    checks,
    blockers,
    summary: blockers.length
      ? `未买入主要卡在：${blockers.slice(0, 3).map((row) => row.label).join("、")}。`
      : isBuyAction(analysis.action)
        ? "买入条件已通过，仍需遵守仓位和止损。"
        : "核心条件接近通过，但动作仍偏观察，等待更强确认。",
  };
}

function pickQualityGrade(item, mode = "forecast") {
  const analysis = normalizeAnalysis(item.analysis);
  const ensemble = analysis.ensemble || {};
  const projected = Number(analysis.projectedUpside || 0);
  const reliability = predictionReliability(analysis);
  const magnitudeProb = magnitudeProbability(analysis);
  const maxProb = maxUpsideProbability(analysis);
  const targetProb = strategyProbability(analysis);
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upside = Number(ensemble.upsideAgreement || 0);
  const score = (mode === "today" ? todayPickScore(item) : forecastPickScore(item));
  const pickMove = selectionUpside(analysis);
  if (reliability >= 72 && Math.max(magnitudeProb, maxProb) >= 58 && targetProb >= strategyProbabilityTarget(analysis) + 4 && pickMove >= Math.max(1.5, Number(getStrategy().targetUpside || 5) * 0.7) && consensus >= 68 && upside >= 60) return "A";
  if (reliability >= 60 && Math.max(magnitudeProb, maxProb) >= 48 && targetProb >= Math.max(48, strategyProbabilityTarget(analysis) - 10) && pickMove > 0.8 && consensus >= 58 && upside >= 52) return "B";
  return score > 12 ? "C" : "观察";
}

function forecastPickScore(item) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const factorScore = factorScoreForItem(item);
  const ensemble = analysis.ensemble || {};
  const qualityGate = analysis.qualityGate || {};
  const reliability = predictionReliability(analysis);
  const magnitudeProb = magnitudeProbability(analysis);
  const maxProb = maxUpsideProbability(analysis);
  const targetProb = strategyProbability(analysis);
  const adaptivePenalty = Number(ensemble.adaptivePenalty || analysis.adaptiveLearning?.confidencePenalty || 0);
  const downside = Number(analysis.downsideConfidence || 0);
  const crossSection = analysis.crossSection || {};
  return reliability * 0.26
    + magnitudeProb * 0.18
    + maxProb * 0.1
    + targetProb * 0.22
    + selectionUpside(analysis) * 8.5
    + Number(ensemble.consensusAgreement || 0) * 0.11
    + Number(ensemble.upsideAgreement || 0) * 0.11
    + Number(crossSection.forecastPercentile || 0) * 0.16
    + technicals.riskScore * 0.08
    + factorScore * 0.45
    + Math.max(0, technicals.volumeRatio - 1) * 4
    + (qualityGate.buyEligible === false || qualityGate.blocked ? -10 : 4)
    - adaptivePenalty * 1.15
    - downside * 0.08;
}

function pickRejectReason(item, mode = "forecast") {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  if (!item?.symbol || analysis.action === "ERROR") return "分析失败";
  if (isRiskAction(analysis.action)) return "风险等级过高";
  if (!technicals.close) return "无有效价格";
  const strategy = getStrategy();
  const target = Math.max(1, Number(strategy.targetUpside || 5));
  const reliability = predictionReliability(analysis);
  const magnitudeProb = magnitudeProbability(analysis);
  const maxProb = maxUpsideProbability(analysis);
  const targetProb = strategyProbability(analysis);
  const requiredTargetProb = strategyProbabilityTarget(analysis);
  const projected = projectedFinalReturn(analysis);
  const pickMove = selectionUpside(analysis);
  const ensemble = analysis.ensemble || {};
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const gate = analysis.qualityGate || {};
  const minReliability = Math.max(52, Math.min(74, Number(strategy.confidence || 80) - 18));
  if (pickMove < (mode === "today" ? 0.25 : Math.max(0.8, target * 0.35))) return `预估/触达涨幅不足：${formatPct(pickMove)}`;
  if (reliability < minReliability) return `方向置信不足：${Math.round(reliability)}%`;
  if (Math.max(magnitudeProb, maxProb) < Math.max(42, minReliability - 8)) return `幅度达成率不足：周期${Math.round(magnitudeProb)}% / 触达${Math.round(maxProb)}%`;
  if (targetProb < Math.max(45, requiredTargetProb - (mode === "today" ? 16 : 10))) return `策略达标概率不足：${Math.round(targetProb)}% / ${Math.round(requiredTargetProb)}%`;
  if (gate.buyEligible === false && reliability < Number(strategy.confidence || 80)) return "质量闸门未通过";
  if (consensus && consensus < (mode === "today" ? 50 : 55)) return `模型共识偏低：${Math.round(consensus)}%`;
  if (upsideAgreement && upsideAgreement < (mode === "today" ? 48 : 52)) return `上涨一致度偏低：${Math.round(upsideAgreement)}%`;
  if (Number(analysis.downsideConfidence || 0) > reliability + 8) return "下跌置信度高于上涨判断";
  if (analysis.crossSection?.forecastPercentile != null && mode === "forecast" && Number(analysis.crossSection.forecastPercentile) < 45) return `横截面排名偏低：${Math.round(analysis.crossSection.forecastPercentile)}%`;
  if (mode === "today" && todayPickScore(item) < 7 && technicals.volumeRatio < 1.12) return "当日强度/量能不足";
  return "";
}

function isForecastPickCandidate(item) {
  return !pickRejectReason(item, "forecast");
}

function isTodayStrongCandidate(item) {
  return !pickRejectReason(item, "today");
}

function isFallbackPickCandidate(item, mode = "forecast", used = new Set()) {
  const symbol = normalizeSymbolForMarket(item?.symbol, state.market);
  if (!symbol || used.has(symbol)) return false;
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  if (analysis.action === "ERROR" || isRiskAction(analysis.action) || !technicals.close) return false;
  const reliability = directionReliability(analysis);
  const magnitudeFloor = Math.max(finalReturnProbability(analysis), maxUpsideProbability(analysis));
  const target = Math.max(1, Number(getStrategy().targetUpside || 5));
  const minMove = mode === "today" ? 0.25 : Math.max(0.65, target * 0.28);
  if (selectionUpside(analysis) < minMove) return false;
  if (reliability < (mode === "today" ? 40 : 44)) return false;
  if (magnitudeFloor < (mode === "today" ? 34 : 38)) return false;
  if (Number(analysis.downsideConfidence || 0) > reliability + 18) return false;
  if (mode === "today" && todayPickScore(item) < 2 && technicals.volumeRatio < 1.02) return false;
  return true;
}

function fillPickList(adjusted = [], strict = [], mode = "forecast", used = new Set()) {
  const rows = strict.map((item) => ({ ...item, pickTier: item.pickTier || "strict" }));
  strict.forEach((item) => used.add(item.symbol));
  if (rows.length >= AI_PICK_COUNT) return rows.slice(0, AI_PICK_COUNT);
  const scoreFn = mode === "today" ? todayPickScore : forecastPickScore;
  const fallback = adjusted
    .filter((item) => isFallbackPickCandidate(item, mode, used))
    .sort((a, b) => scoreFn(b) - scoreFn(a))
    .slice(0, AI_PICK_COUNT - rows.length)
    .map((item) => ({ ...item, pickTier: "fallback" }));
  fallback.forEach((item) => used.add(item.symbol));
  return [...rows, ...fallback].slice(0, AI_PICK_COUNT);
}

function pickRowHtml(item, mode) {
  const symbol = normalizeSymbolForMarket(item.symbol, state.market);
  if (!symbol) return "";
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const score = mode === "today" ? todayPickScore(item) : forecastPickScore(item);
  const inWatchlist = state.watchlist.includes(symbol);
  const grade = pickQualityGrade(item, mode);
  const reliability = predictionReliability(analysis);
  const magnitudeProb = magnitudeProbability(analysis);
  const finalProb = finalReturnProbability(analysis);
  const maxMove = projectedMaxUpside(analysis);
  const maxProb = maxUpsideProbability(analysis);
  const targetProb = strategyProbability(analysis);
  const ensemble = analysis.ensemble || {};
  const rank = mode === "today" ? analysis.crossSection?.todayRank : analysis.crossSection?.forecastRank;
  const percentile = mode === "today" ? analysis.crossSection?.todayPercentile : analysis.crossSection?.forecastPercentile;
  return `
    <div class="pick-row">
      <strong>${symbol}<small>${item.pickTier === "fallback" ? "候补" : grade}</small></strong>
      <span>
        ${formatMoney(technicals.close)} · 结束 ${formatPct(projectedFinalReturn(analysis))}/${Math.round(finalProb)}% · 最高触达 ${formatPct(maxMove)}/${Math.round(maxProb)}% · 方向 ${directionLabel(analysis)} ${Math.round(directionReliability(analysis))}% · 达标 ${Math.round(targetProb)}%
        <p>评分 ${score.toFixed(1)}${rank ? ` · 横截面 #${rank}/${analysis.crossSection?.universeSize || "?"}（${Math.round(percentile || 0)}%）` : ""} · 综合 ${Math.round(reliability)}% · 共识 ${Math.round(ensemble.consensusAgreement || 0)}% · 上涨一致 ${Math.round(ensemble.upsideAgreement || 0)}% · 5日 ${formatPct(technicals.change5d)} · 量比 ${technicals.volumeRatio.toFixed(2)}</p>
      </span>
      <button class="secondary mini-btn" type="button" data-add-pick="${symbol}" ${inWatchlist ? "disabled" : ""}>${inWatchlist ? "已在池中" : "加入"}</button>
    </div>
  `;
}

function rejectedPickHtml(rows = []) {
  if (!rows.length) return "";
  return `
    <details class="pick-rejects">
      <summary>未入选原因 ${rows.length} 条</summary>
      <div>
        ${rows.slice(0, 10).map((row) => `<span>${row.symbol}: ${row.reason}</span>`).join("")}
      </div>
    </details>
  `;
}

function renderAiPickPanel() {
  const target = $("aiPickPanel");
  if (!target) return;
  const forecast = state.stockPicker?.forecast || [];
  const today = state.stockPicker?.today || [];
  const rejected = state.stockPicker?.rejected || [];
  const failures = state.stockPicker?.failures || [];
  if (!forecast.length && !today.length) {
    target.innerHTML = `<p class="muted">点击后会扫描当前市场核心流动性股票池，结合实时成交强弱、模型一致度、预测学习惩罚与AI批量复核，严格生成后市上涨潜力Top${AI_PICK_COUNT}和今日强势Top${AI_PICK_COUNT}。</p>`;
    return;
  }
  target.innerHTML = `
    <div class="pick-columns">
      <div>
        <h4>后市上涨潜力Top${AI_PICK_COUNT}</h4>
        <div class="pick-list">${forecast.map((item) => pickRowHtml(item, "forecast")).join("")}</div>
      </div>
      <div>
        <h4>今日强势Top${AI_PICK_COUNT}</h4>
        <div class="pick-list">${today.map((item) => pickRowHtml(item, "today")).join("")}</div>
      </div>
    </div>
    ${rejectedPickHtml(rejected)}
    ${failures.length ? `<p class="muted small-text">读取失败 ${failures.length} 只：${failures.slice(0, 3).map(compactDisplayError).join("；")}</p>` : ""}
    <p class="muted small-text">更新时间 ${state.stockPicker.updatedAt ? new Date(state.stockPicker.updatedAt).toLocaleString() : "刚刚"}。严格票优先；不足时用横截面候补补位，但仍过滤明显下跌、高风险或无价格股票。新闻/因子会在加入监控后继续后台复核。</p>
  `;
  target.querySelectorAll("[data-add-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const symbol = allowWatchSymbolForMarket(button.dataset.addPick, state.market, "ai-pick");
      if (!symbol || state.watchlist.includes(symbol)) return;
      const picked = [...forecast, ...today].find((item) => item.symbol === symbol);
      addWatchSymbol(symbol, "ai-pick", state.market, picked || null);
      saveState();
      renderCards();
      renderAiPickPanel();
      setStatus(`${symbol} 已加入自选监控池`);
    });
  });
}

function attachCrossSectionRanks(items = []) {
  const rows = items.filter((item) => item?.symbol && item.analysis?.action !== "ERROR");
  const withScores = rows.map((item) => ({
    item,
    forecastScore: forecastPickScore(item),
    todayScore: todayPickScore(item),
  }));
  const rankBy = (key) => {
    const sorted = withScores.slice().sort((a, b) => b[key] - a[key]);
    const total = Math.max(1, sorted.length - 1);
    sorted.forEach((row, index) => {
      const percentile = sorted.length <= 1 ? 100 : 100 - (index / total * 100);
      const analysis = normalizeAnalysis(row.item.analysis);
      analysis.crossSection = {
        ...(analysis.crossSection || {}),
        [`${key === "forecastScore" ? "forecast" : "today"}Rank`]: index + 1,
        [`${key === "forecastScore" ? "forecast" : "today"}Percentile`]: Number(percentile.toFixed(1)),
        [`${key === "forecastScore" ? "forecast" : "today"}Score`]: Number(row[key].toFixed(2)),
        universeSize: sorted.length,
      };
      row.item.analysis = analysis;
    });
  };
  rankBy("forecastScore");
  rankBy("todayScore");
  return items;
}

async function runAiStockPicker() {
  const button = $("aiPickStocks");
  if (button) button.disabled = true;
  if (!cachedUniverseRows().length) await loadMarketUniverse(false, false);
  const universe = universeForMarket({ forPicker: true });
  const prepared = [];
  const failures = [];
  const totalUniverse = cachedUniverseRows().length || universe.length;
  setStatus(`AI选股开始：从 ${totalUniverse} 只${activeMarketConfig().label}股票池中扫描 ${universe.length} 只候选`);
  try {
    await fetchAccuracySummary(false);
    for (let index = 0; index < universe.length; index += 6) {
      const batch = universe.slice(index, index + 6);
      const settled = await Promise.allSettled(batch.map((symbol) => prepareSymbol(symbol, { includeSignals: false })));
      settled.forEach((entry, offset) => {
        if (entry.status === "fulfilled") prepared.push(entry.value);
        else failures.push(`${batch[offset]}: ${entry.reason?.message || entry.reason}`);
      });
      setStatus(`AI选股行情扫描 ${Math.min(index + batch.length, universe.length)}/${universe.length}`);
    }
    if (!prepared.length) throw new Error(failures.slice(0, 3).join(" | ") || "没有候选股票返回真实行情");
    let aiFallback = "";
    let results;
    try {
      results = await requestBatchAnalysis(prepared, { localOnly: false, commit: false, agentStep: false });
    } catch (error) {
      aiFallback = `；AI批量分析失败，已回退本地模型：${error.message}`;
      results = await requestBatchAnalysis(prepared, { localOnly: true, commit: false, agentStep: false });
    }
    const allowed = new Set(universeForMarket());
    const adjusted = attachCrossSectionRanks(results
      .map(applyPostModelAdjustments)
      .map((item) => ({ ...item, symbol: normalizeSymbolForMarket(item.symbol, state.market), market: state.market }))
      .filter((item) => item.symbol && allowed.has(item.symbol)));
    const rejected = adjusted
      .map((item) => {
        const forecastReason = pickRejectReason(item, "forecast");
        const todayReason = pickRejectReason(item, "today");
        const reason = forecastReason && todayReason
          ? forecastReason === todayReason ? forecastReason : `${forecastReason}；${todayReason}`
          : "";
        return reason ? { symbol: item.symbol, reason, score: Math.max(forecastPickScore(item), todayPickScore(item)) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 18);
    const strictForecast = adjusted
      .filter(isForecastPickCandidate)
      .sort((a, b) => forecastPickScore(b) - forecastPickScore(a))
      .slice(0, AI_PICK_COUNT);
    const forecast = fillPickList(adjusted, strictForecast, "forecast", new Set());
    const forecastSymbols = new Set(forecast.map((item) => item.symbol));
    const strictToday = adjusted
      .filter((item) => !forecastSymbols.has(item.symbol))
      .filter(isTodayStrongCandidate)
      .sort((a, b) => todayPickScore(b) - todayPickScore(a))
      .slice(0, AI_PICK_COUNT);
    const today = fillPickList(adjusted, strictToday, "today", forecastSymbols);
    state.stockPicker = {
      forecast,
      today,
      rejected,
      failures: failures.slice(0, 12),
      updatedAt: new Date().toISOString(),
    };
    renderAiPickPanel();
    const fallbackCount = [...forecast, ...today].filter((item) => item.pickTier === "fallback").length;
    setStatus(`AI选股完成：后市Top${forecast.length}和今日强势Top${today.length}已生成${fallbackCount ? `，含 ${fallbackCount} 只横截面候补` : ""}；${rejected.length} 只因方向/幅度/达标/共识/风险未达标被拒绝${aiFallback}${failures.length ? `；${failures.length} 只候选读取失败` : ""}`);
  } catch (error) {
    console.error(error);
    setStatus(`AI选股失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function agentConfigForMarket(market = state.market) {
  const key = safeMarket(market);
  const saved = state.agentConfigByMarket[key] || {};
  return {
    initialCapital: asNumber(saved.initialCapital, key === "CN" ? 100000 : 10000),
  };
}

function defaultAgentRows(market = state.market) {
  const capital = agentConfigForMarket(market).initialCapital;
  const key = safeMarket(market);
  return [
    {
      id: "momentum",
      name: `${MARKET_CONFIG[key].label}趋势 Agent`,
      style: "momentum",
      cash: capital,
      initialCapital: capital,
      equity: capital,
      previousEquity: capital,
      positions: {},
      trades: [],
      strategyBook: {},
      bestStrategyId: "",
      learning: { aggressiveness: 1, confidenceBias: 0, symbolBias: {} },
      stats: { wins: 0, losses: 0, trades: 0, closedTrades: 0 },
    },
    {
      id: "reversion",
      name: `${MARKET_CONFIG[key].label}回撤 Agent`,
      style: "reversion",
      cash: capital,
      initialCapital: capital,
      equity: capital,
      previousEquity: capital,
      positions: {},
      trades: [],
      strategyBook: {},
      bestStrategyId: "",
      learning: { aggressiveness: 0.85, confidenceBias: 0, symbolBias: {} },
      stats: { wins: 0, losses: 0, trades: 0, closedTrades: 0 },
    },
    {
      id: "breakout",
      name: `${MARKET_CONFIG[key].label}突破实盘训练 Agent`,
      style: "breakout",
      cash: capital,
      initialCapital: capital,
      equity: capital,
      previousEquity: capital,
      positions: {},
      trades: [],
      strategyBook: {},
      bestStrategyId: "",
      learning: { aggressiveness: 1.12, confidenceBias: 0, symbolBias: {} },
      stats: { wins: 0, losses: 0, trades: 0, closedTrades: 0 },
    },
    {
      id: "news-flow",
      name: `${MARKET_CONFIG[key].label}新闻资金流 Agent`,
      style: "news-flow",
      cash: capital,
      initialCapital: capital,
      equity: capital,
      previousEquity: capital,
      positions: {},
      trades: [],
      strategyBook: {},
      bestStrategyId: "",
      learning: { aggressiveness: 0.95, confidenceBias: 0, symbolBias: {} },
      stats: { wins: 0, losses: 0, trades: 0, closedTrades: 0 },
    },
    {
      id: "risk-balanced",
      name: `${MARKET_CONFIG[key].label}稳健配置 Agent`,
      style: "risk-balanced",
      cash: capital,
      initialCapital: capital,
      equity: capital,
      previousEquity: capital,
      positions: {},
      trades: [],
      strategyBook: {},
      bestStrategyId: "",
      learning: { aggressiveness: 0.72, confidenceBias: 0, symbolBias: {} },
      stats: { wins: 0, losses: 0, trades: 0, closedTrades: 0 },
    },
  ];
}

function normalizeAgentRow(agent = {}, fallback = {}) {
  const base = { ...fallback, ...(agent || {}) };
  const fallbackCapital = asNumber(fallback.initialCapital, agentConfigForMarket().initialCapital);
  const initialCapital = asNumber(base.initialCapital, fallbackCapital);
  const learning = base.learning || {};
  base.initialCapital = initialCapital;
  base.cash = asNumber(base.cash, initialCapital);
  base.equity = asNumber(base.equity, initialCapital);
  base.previousEquity = asNumber(base.previousEquity, base.equity);
  base.positionValue = asNumber(base.positionValue, 0);
  base.returnPct = asNumber(base.returnPct, 0);
  base.positions = base.positions && typeof base.positions === "object" && !Array.isArray(base.positions) ? base.positions : {};
  base.trades = Array.isArray(base.trades) ? base.trades : [];
  base.strategyBook = base.strategyBook && typeof base.strategyBook === "object" && !Array.isArray(base.strategyBook) ? base.strategyBook : {};
  base.bestStrategyId = base.bestStrategyId || "";
  base.learning = {
    aggressiveness: asNumber(learning.aggressiveness, fallback.learning?.aggressiveness || 1),
    confidenceBias: asNumber(learning.confidenceBias, 0),
    symbolBias: learning.symbolBias && typeof learning.symbolBias === "object" ? learning.symbolBias : {},
  };
  base.stats = {
    wins: asNumber(base.stats?.wins, 0),
    losses: asNumber(base.stats?.losses, 0),
    trades: asNumber(base.stats?.trades, base.trades.length),
    closedTrades: asNumber(base.stats?.closedTrades, asNumber(base.stats?.wins, 0) + asNumber(base.stats?.losses, 0)),
  };
  return base;
}

function getAgentLedger(market = state.market) {
  const key = safeMarket(market);
  const defaults = defaultAgentRows(key);
  const memory = getAgentMemory(key);
  const existing = state.agentLedgerByMarket[key];
  if (existing?.agents?.length) {
    existing.market = key;
    existing.agents = defaults.map((fallback, index) => {
      const saved = existing.agents.find((agent) => agent?.id === fallback.id) || existing.agents[index] || {};
      return hydrateAgentFromMemory(normalizeAgentRow(saved, fallback), memory);
    });
    existing.updatedAt = existing.updatedAt || new Date().toISOString();
    state.agentLedgerByMarket[key] = existing;
    return existing;
  }
  const ledger = {
    market: key,
    updatedAt: new Date().toISOString(),
    agents: defaults.map((agent) => hydrateAgentFromMemory(agent, memory)),
  };
  state.agentLedgerByMarket[key] = ledger;
  return ledger;
}

function saveAgentState() {
  safeStorage.setItem("agentConfigByMarket", JSON.stringify(state.agentConfigByMarket));
  safeStorage.setItem("agentLedgerByMarket", JSON.stringify(state.agentLedgerByMarket));
  safeStorage.setItem("agentMemoryByMarket", JSON.stringify(state.agentMemoryByMarket));
}

function emptyAgentMemory(market = state.market) {
  return {
    market: safeMarket(market),
    updatedAt: new Date().toISOString(),
    archives: [],
    agents: {},
    strategyBook: {},
    symbolBias: {},
    transferCandidates: [],
    lossLessons: [],
    totalReplayTrades: 0,
    totalPaperTrades: 0,
  };
}

function getAgentMemory(market = state.market) {
  const key = safeMarket(market);
  const memory = state.agentMemoryByMarket[key] && typeof state.agentMemoryByMarket[key] === "object"
    ? state.agentMemoryByMarket[key]
    : emptyAgentMemory(key);
  memory.market = key;
  memory.archives = Array.isArray(memory.archives) ? memory.archives : [];
  memory.agents = memory.agents && typeof memory.agents === "object" && !Array.isArray(memory.agents) ? memory.agents : {};
  memory.strategyBook = memory.strategyBook && typeof memory.strategyBook === "object" && !Array.isArray(memory.strategyBook) ? memory.strategyBook : {};
  memory.symbolBias = memory.symbolBias && typeof memory.symbolBias === "object" && !Array.isArray(memory.symbolBias) ? memory.symbolBias : {};
  memory.transferCandidates = Array.isArray(memory.transferCandidates) ? memory.transferCandidates : [];
  memory.lossLessons = Array.isArray(memory.lossLessons) ? memory.lossLessons : [];
  memory.totalReplayTrades = asNumber(memory.totalReplayTrades, 0);
  memory.totalPaperTrades = asNumber(memory.totalPaperTrades, 0);
  state.agentMemoryByMarket[key] = memory;
  return memory;
}

function mergeLossLessons(existing = [], incoming = []) {
  const byKey = new Map();
  [...existing, ...incoming].forEach((row) => {
    if (!row?.symbol || !row?.lesson) return;
    const key = `${row.agentId || row.agentName || "agent"}:${row.symbol}:${row.time || ""}:${Number(row.pnlPct || 0).toFixed(3)}:${row.reason || ""}`;
    byKey.set(key, row);
  });
  return [...byKey.values()]
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))
    .slice(0, 80);
}

function mergePersistentStrategyBook(target, source) {
  Object.values(source || {}).forEach((row) => {
    if (!row?.id || !Number(row.trades || 0)) return;
    const existing = target[row.id] || {
      id: row.id,
      name: row.name,
      entry: row.entry,
      style: row.style,
      trades: 0,
      wins: 0,
      avgReturn: 0,
      maxDrawdown: 0,
      score: 0,
      symbols: {},
      target: row.target,
      stop: row.stop,
      maxHold: row.maxHold,
    };
    const totalTrades = Number(existing.trades || 0) + Number(row.trades || 0);
    existing.avgReturn = totalTrades
      ? ((Number(existing.avgReturn || 0) * Number(existing.trades || 0)) + (Number(row.avgReturn || 0) * Number(row.trades || 0))) / totalTrades
      : Number(row.avgReturn || 0);
    existing.wins = Number(existing.wins || 0) + Number(row.wins || 0);
    existing.trades = totalTrades;
    existing.maxDrawdown = Math.min(Number(existing.maxDrawdown || 0), Number(row.maxDrawdown || 0));
    existing.score = Number((existing.avgReturn * 3.4 + ((existing.wins / Math.max(1, existing.trades) * 100) - 50) * 0.18 + Math.min(18, existing.trades * 0.11) + existing.maxDrawdown * 0.45).toFixed(2));
    existing.symbols = existing.symbols && typeof existing.symbols === "object" ? existing.symbols : {};
    Object.entries(row.symbols || {}).forEach(([symbol, count]) => {
      existing.symbols[symbol] = Number(existing.symbols[symbol] || 0) + Number(count || 0);
    });
    existing.target = row.target ?? existing.target;
    existing.stop = row.stop ?? existing.stop;
    existing.maxHold = row.maxHold ?? existing.maxHold;
    target[row.id] = existing;
  });
}

function strategyBookDelta(book, baseline) {
  const result = {};
  Object.values(book || {}).forEach((row) => {
    if (!row?.id || !Number(row.trades || 0)) return;
    const base = baseline?.[row.id] || {};
    const trades = Number(row.trades || 0);
    const baseTrades = Number(base.trades || 0);
    const deltaTrades = Math.max(0, trades - baseTrades);
    if (!deltaTrades) return;
    const weightedReturn = (Number(row.avgReturn || 0) * trades) - (Number(base.avgReturn || 0) * baseTrades);
    const deltaWins = Math.max(0, Math.min(deltaTrades, Number(row.wins || 0) - Number(base.wins || 0)));
    const symbols = {};
    Object.entries(row.symbols || {}).forEach(([symbol, count]) => {
      const delta = Number(count || 0) - Number(base.symbols?.[symbol] || 0);
      if (delta > 0) symbols[symbol] = delta;
    });
    const avgReturn = weightedReturn / deltaTrades;
    const winRate = deltaWins / Math.max(1, deltaTrades) * 100;
    result[row.id] = {
      id: row.id,
      name: row.name,
      entry: row.entry,
      style: row.style,
      trades: deltaTrades,
      wins: deltaWins,
      avgReturn,
      maxDrawdown: Number(row.maxDrawdown || 0),
      score: Number((avgReturn * 3.4 + (winRate - 50) * 0.18 + Math.min(16, deltaTrades * 0.18) + Number(row.maxDrawdown || 0) * 0.45).toFixed(2)),
      symbols,
      target: row.target,
      stop: row.stop,
      maxHold: row.maxHold,
    };
  });
  return result;
}

function hydrateAgentFromMemory(agent, memory = getAgentMemory()) {
  const saved = memory.agents?.[agent.id] || {};
  agent.strategyBook = agent.strategyBook || {};
  if (!agent.memoryHydratedAt) {
    const combinedBook = {};
    if (Object.keys(memory.strategyBook || {}).length) mergePersistentStrategyBook(combinedBook, memory.strategyBook);
    else mergePersistentStrategyBook(combinedBook, saved.strategyBook);
    mergePersistentStrategyBook(combinedBook, agent.strategyBook);
    agent.strategyBook = combinedBook;
    agent.memoryHydratedAt = memory.updatedAt || new Date().toISOString();
  }
  agent.learning = agent.learning || { aggressiveness: 1, confidenceBias: 0, symbolBias: {} };
  agent.learning.aggressiveness = asNumber(saved.aggressiveness, agent.learning.aggressiveness);
  agent.learning.confidenceBias = asNumber(saved.confidenceBias, agent.learning.confidenceBias);
  agent.learning.symbolBias = {
    ...(memory.symbolBias || {}),
    ...(saved.symbolBias || {}),
    ...(agent.learning.symbolBias || {}),
  };
  const best = bestStrategyForAgent(agent);
  if (best) agent.bestStrategyId = best.id;
  return agent;
}

function persistAgentMemoryFromLedger(ledger = getAgentLedger(), reason = "training") {
  const key = safeMarket(ledger.market || state.market);
  const memory = getAgentMemory(key);
  const baselineBook = JSON.parse(JSON.stringify(memory.strategyBook || {}));
  const strategyBook = {};
  ledger.agents.forEach((agent) => {
    const agentBook = agent.memoryHydratedAt ? strategyBookDelta(agent.strategyBook, baselineBook) : agent.strategyBook;
    mergePersistentStrategyBook(strategyBook, agentBook);
    mergePersistentStrategyBook(memory.strategyBook, agentBook);
    const existingAgent = memory.agents[agent.id] || {};
    const mergedBook = { ...(existingAgent.strategyBook || {}) };
    mergePersistentStrategyBook(mergedBook, agentBook);
    memory.agents[agent.id] = {
      id: agent.id,
      name: agent.name,
      style: agent.style,
      aggressiveness: Number(agent.learning?.aggressiveness || existingAgent.aggressiveness || 1),
      confidenceBias: Number(agent.learning?.confidenceBias || existingAgent.confidenceBias || 0),
      symbolBias: { ...(existingAgent.symbolBias || {}), ...(agent.learning?.symbolBias || {}) },
      strategyBook: mergedBook,
      bestStrategyId: agent.bestStrategyId || existingAgent.bestStrategyId || "",
      stats: agent.stats || existingAgent.stats || {},
      lastReturnPct: Number(agent.returnPct || 0),
      lastEquity: Number(agent.equity || 0),
    };
    Object.entries(agent.learning?.symbolBias || {}).forEach(([symbol, bias]) => {
      memory.symbolBias[symbol] = clamp((Number(memory.symbolBias[symbol] || 0) * 0.65) + Number(bias || 0) * 0.35, -8, 8);
    });
    const losses = (agent.trades || [])
      .filter((trade) => trade.side === "SELL" && Number(trade.pnlPct || 0) < 0 && trade.lesson)
      .map((trade) => ({
        time: trade.time || new Date().toISOString(),
        agentId: agent.id,
        agentName: agent.name,
        style: agent.style,
        symbol: trade.symbol,
        pnlPct: Number(trade.pnlPct || 0),
        reason: trade.reason || "",
        lesson: trade.lesson,
      }));
    memory.lossLessons = mergeLossLessons(memory.lossLessons || [], losses);
  });
  memory.totalReplayTrades = Object.values(memory.strategyBook || {}).reduce((sum, row) => sum + Number(row.trades || 0), 0);
  memory.totalPaperTrades = Object.values(memory.agents || {}).reduce((sum, agent) => sum + Number(agent.stats?.trades || 0), 0);
  memory.updatedAt = new Date().toISOString();
  if (reason !== "training") {
    memory.archives.unshift({
      reason,
      archivedAt: memory.updatedAt,
      ledgerUpdatedAt: ledger.updatedAt,
      agents: ledger.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        returnPct: Number(agent.returnPct || 0),
        equity: Number(agent.equity || 0),
        stats: agent.stats,
        bestStrategyId: agent.bestStrategyId,
        strategyBook: agent.strategyBook,
      })),
    });
    memory.archives = memory.archives.slice(0, 20);
    const archive = memory.archives[0];
    requestJson(`/api/events?market=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "simulation-archive",
        entityId: `${key}:${archive.archivedAt}`,
        payload: archive,
      }),
    }).catch((error) => console.warn("Simulation archive kept locally; SQLite audit unavailable", error));
  }
  state.agentMemoryByMarket[key] = memory;
  return memory;
}

function resetLedgerPreservingMemory(reason = "reset") {
  const current = getAgentLedger();
  persistAgentMemoryFromLedger(current, reason);
  const memory = getAgentMemory();
  const ledger = {
    market: state.market,
    updatedAt: new Date().toISOString(),
    cycleStartedAt: new Date().toISOString(),
    agents: defaultAgentRows(state.market).map((agent) => hydrateAgentFromMemory(agent, memory)),
  };
  state.agentLedgerByMarket[state.market] = ledger;
  saveAgentState();
  return ledger;
}

const AGENT_STRATEGY_CANDIDATES = [
  { id: "momentum-pullback", name: "趋势回踩续涨", style: "momentum", entry: "趋势分>=58、MACD转强、RSI不过热", minTrend: 58, minMomentum: 52, minVolume: 0.85, rsiMax: 72, takeProfitScale: 0.72, stopScale: 0.9, holdScale: 0.75 },
  { id: "volume-breakout", name: "放量突破快进快出", style: "momentum", entry: "20日新高附近且量比>=1.15", minTrend: 62, minMomentum: 55, minVolume: 1.15, breakout: true, takeProfitScale: 0.62, stopScale: 0.82, holdScale: 0.55 },
  { id: "rsi-reversion", name: "超跌反弹轻仓", style: "reversion", entry: "RSI<=39且5日跌幅后企稳", rsiMax: 39, maxChange5d: 1.2, takeProfitScale: 0.5, stopScale: 0.72, holdScale: 0.45 },
  { id: "quality-trend", name: "稳态趋势持有", style: "momentum", entry: "趋势分>=65、风险分>=58、量能不过度异常", minTrend: 65, minRisk: 58, minVolume: 0.75, maxVolume: 2.8, takeProfitScale: 0.95, stopScale: 1, holdScale: 1 },
  { id: "opening-strength", name: "开盘强势延续", style: "breakout", entry: "趋势>=56、5日不弱、量比>=1.05，偏高频试错", minTrend: 56, minMomentum: 50, minVolume: 1.05, minChange5d: -1.8, takeProfitScale: 0.42, stopScale: 0.58, holdScale: 0.32 },
  { id: "volatility-squeeze", name: "低波动挤压突破", style: "breakout", entry: "风险分>=55、量能温和、MACD不弱，等待波动扩张", minRisk: 55, minVolume: 0.65, maxVolume: 1.8, macdFloor: -0.01, takeProfitScale: 0.56, stopScale: 0.62, holdScale: 0.46 },
  { id: "news-confirmed-momentum", name: "新闻确认趋势", style: "news-flow", entry: "新闻/因子证据不薄，趋势>=54，量能不失真", minTrend: 54, minVolume: 0.75, minEvidence: 54, takeProfitScale: 0.68, stopScale: 0.76, holdScale: 0.62 },
  { id: "factor-news-reversal", name: "利好修复反弹", style: "news-flow", entry: "短线回撤但新闻/因子评分改善，轻仓验证", maxChange5d: 0.6, minEvidence: 50, rsiMax: 56, takeProfitScale: 0.48, stopScale: 0.66, holdScale: 0.42 },
  { id: "risk-balanced-carry", name: "稳健低回撤持有", style: "risk-balanced", entry: "风险分>=62、趋势>=54、量能不过热", minRisk: 62, minTrend: 54, minVolume: 0.65, maxVolume: 2.1, takeProfitScale: 0.7, stopScale: 0.78, holdScale: 0.72 },
  { id: "cash-protected-entry", name: "现金保护低频买入", style: "risk-balanced", entry: "趋势>=58、模型共识高，单票更小、止损更紧", minTrend: 58, minMomentum: 48, minEvidence: 58, takeProfitScale: 0.62, stopScale: 0.62, holdScale: 0.56 },
];

function trainingEvidenceScore(item = {}, technicals = normalizeTechnicals(item.technicals), analysis = normalizeAnalysis(item.analysis)) {
  const newsCount = Number(item.news?.length || 0) + Number(item.xPosts?.length || 0) + Number(item.youtubeItems?.length || 0);
  const factorLiveCount = factorRows(item.factors).filter(([, factor]) => factor?.available !== false && factor?.values?.proxy !== true).length;
  const factorScore = factorScoreForItem(item);
  const consensus = Number(analysis.ensemble?.consensusAgreement || 0);
  const upsideAgreement = Number(analysis.ensemble?.upsideAgreement || 0);
  const analogConfidence = Number(item.analog?.confidence || item.analog?.model?.confidence || 0);
  return clamp(
    34
      + Math.min(16, newsCount * 2.2)
      + Math.min(14, factorLiveCount * 3.2)
      + Math.max(-10, Math.min(12, factorScore * 0.22))
      + Math.max(0, consensus - 55) * 0.22
      + Math.max(0, upsideAgreement - 52) * 0.18
      + Math.max(0, analogConfidence - 45) * 0.14
      + Math.max(0, technicals.volumeRatio - 1) * 4,
    0,
    100
  );
}

function strategyEntryMatches(candidate, candles, end, item = null) {
  if (end < 55) return false;
  const slice = candles.slice(0, end + 1);
  const technicals = computeTechnicals(slice);
  const close = candles[end].close;
  const recentHigh = Math.max(...candles.slice(Math.max(0, end - 20), end).map((row) => row.high || row.close));
  if (candidate.breakout && close < recentHigh * 0.995) return false;
  if (candidate.minTrend && technicals.trendScore < candidate.minTrend) return false;
  if (candidate.minMomentum && technicals.momentumScore < candidate.minMomentum) return false;
  if (candidate.minRisk && technicals.riskScore < candidate.minRisk) return false;
  if (candidate.minVolume && technicals.volumeRatio < candidate.minVolume) return false;
  if (candidate.maxVolume && technicals.volumeRatio > candidate.maxVolume) return false;
  if (candidate.rsiMax && technicals.rsi > candidate.rsiMax) return false;
  if (candidate.minChange5d != null && technicals.change5d < candidate.minChange5d) return false;
  if (candidate.maxChange5d != null && technicals.change5d > candidate.maxChange5d) return false;
  if (candidate.macdFloor != null && technicals.macdHistogram < candidate.macdFloor) return false;
  if (candidate.minEvidence != null && item && trainingEvidenceScore(item, technicals) < candidate.minEvidence) return false;
  if (["momentum", "breakout", "risk-balanced"].includes(candidate.style) && technicals.macdHistogram < -0.02) return false;
  return true;
}

function simulateStrategyCandidate(candles, candidate, strategy, item = null) {
  const rows = normalizeCandles(candles).slice(-220);
  if (rows.length < 75) return { trades: 0, wins: 0, avgReturn: 0, maxDrawdown: 0, score: -99 };
  const target = Math.max(1.2, Number(strategy.targetUpside || 5) * candidate.takeProfitScale);
  const stop = Math.max(1, Math.abs(Number(strategy.stopLoss || 4)) * candidate.stopScale);
  const maxHold = Math.max(2, Math.round(Number(strategy.horizonDays || 15) * candidate.holdScale));
  const returns = [];
  let wins = 0;
  let maxDrawdown = 0;
  for (let end = 55; end < rows.length - maxHold - 1; end += 1) {
    if (!strategyEntryMatches(candidate, rows, end, item)) continue;
    const entryTechnicals = computeTechnicals(rows.slice(0, end + 1));
    const entry = rows[end].close;
    let exit = rows[Math.min(rows.length - 1, end + maxHold)].close;
    let tradeDrawdown = 0;
    for (let offset = 1; offset <= maxHold && end + offset < rows.length; offset += 1) {
      const row = rows[end + offset];
      const highReturn = pctChange(row.high || row.close, entry);
      const lowReturn = pctChange(row.low || row.close, entry);
      tradeDrawdown = Math.min(tradeDrawdown, lowReturn);
      if (lowReturn <= -stop) {
        exit = entry * (1 - stop / 100);
        break;
      }
      if (highReturn >= target) {
        exit = entry * (1 + target / 100);
        break;
      }
      exit = row.close;
    }
    const tradeReturn = pctChange(exit, entry) - estimatedRoundTripCostPct(item, entryTechnicals);
    if (tradeReturn > 0) wins += 1;
    maxDrawdown = Math.min(maxDrawdown, tradeDrawdown);
    returns.push(tradeReturn);
  }
  const trades = returns.length;
  const avgReturn = trades ? returns.reduce((sum, value) => sum + value, 0) / trades : 0;
  const winRate = trades ? wins / trades * 100 : 0;
  const score = trades
    ? avgReturn * 3.4 + (winRate - 50) * 0.18 + Math.min(12, trades * 0.35) + maxDrawdown * 0.45
    : -99;
  return { trades, wins, winRate, avgReturn, maxDrawdown, score, target, stop, maxHold };
}

function mergeStrategyResult(book, candidate, sim, symbol) {
  if (!sim.trades) return;
  const existing = book[candidate.id] || {
    id: candidate.id,
    name: candidate.name,
    entry: candidate.entry,
    style: candidate.style,
    trades: 0,
    wins: 0,
    avgReturn: 0,
    maxDrawdown: 0,
    score: 0,
    symbols: {},
    target: sim.target,
    stop: sim.stop,
    maxHold: sim.maxHold,
  };
  const totalTrades = existing.trades + sim.trades;
  existing.avgReturn = totalTrades ? ((existing.avgReturn * existing.trades) + (sim.avgReturn * sim.trades)) / totalTrades : sim.avgReturn;
  existing.wins += sim.wins;
  existing.trades = totalTrades;
  existing.maxDrawdown = Math.min(existing.maxDrawdown || 0, sim.maxDrawdown || 0);
  existing.score = Number((existing.avgReturn * 3.4 + ((existing.wins / Math.max(1, existing.trades) * 100) - 50) * 0.18 + Math.min(16, existing.trades * 0.18) + existing.maxDrawdown * 0.45).toFixed(2));
  existing.symbols[symbol] = (existing.symbols[symbol] || 0) + sim.trades;
  existing.target = sim.target;
  existing.stop = sim.stop;
  existing.maxHold = sim.maxHold;
  book[candidate.id] = existing;
}

function candidateEligibleForAgent(candidate, agent) {
  if (candidate.style === agent.style) return true;
  if (agent.style === "momentum" && ["momentum", "breakout"].includes(candidate.style)) return true;
  if (agent.style === "breakout" && ["breakout", "momentum"].includes(candidate.style)) return true;
  if (agent.style === "news-flow" && ["news-flow", "momentum", "breakout"].includes(candidate.style)) return true;
  if (agent.style === "risk-balanced" && ["risk-balanced", "momentum"].includes(candidate.style)) return true;
  return false;
}

function trainAgentsWithHistoricalReplay(ledger, results = []) {
  const strategy = getStrategy();
  ledger.agents.forEach((agent) => {
    agent.strategyBook = agent.strategyBook || {};
    results.forEach((item) => {
      if (!Array.isArray(item.candles) || item.candles.length < 75) return;
      AGENT_STRATEGY_CANDIDATES
        .filter((candidate) => candidateEligibleForAgent(candidate, agent))
        .forEach((candidate) => mergeStrategyResult(agent.strategyBook, candidate, simulateStrategyCandidate(item.candles, candidate, strategy, item), item.symbol));
    });
    const best = bestStrategyForAgent(agent);
    if (best) {
      agent.bestStrategyId = best.id;
      agent.learning = agent.learning || { aggressiveness: 1, confidenceBias: 0, symbolBias: {} };
      agent.learning.aggressiveness = clamp(0.7 + Math.max(0, best.score) / 38, 0.55, 1.45);
      agent.learning.confidenceBias = clamp(Number(agent.learning.confidenceBias || 0) + best.score * 0.012, -5, 5);
    }
  });
}

function bestStrategyForAgent(agent) {
  return Object.values(agent.strategyBook || {})
    .filter((row) => row.trades >= 3)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function bestStrategyAcrossAgents() {
  const ledger = getAgentLedger();
  const memory = getAgentMemory();
  const rows = [
    ...ledger.agents.flatMap((agent) => Object.values(agent.strategyBook || {}).map((row) => ({ ...row, agentName: agent.name }))),
    ...Object.values(memory.strategyBook || {}).map((row) => ({ ...row, agentName: "长期记忆库" })),
  ];
  return rows.filter((row) => row.trades >= 3).sort((a, b) => b.score - a.score)[0] || null;
}

function markAgentToMarket(agent) {
  let positionValue = 0;
  Object.entries(agent.positions || {}).forEach(([symbol, position]) => {
    const close = state.analyses.get(symbol)?.technicals?.close || position.lastPrice || position.avgPrice;
    position.lastPrice = close;
    positionValue += close * Number(position.qty || 0);
  });
  agent.positionValue = positionValue;
  agent.equity = Number((Number(agent.cash || 0) + positionValue).toFixed(2));
  agent.returnPct = agent.initialCapital > 0 ? ((agent.equity - agent.initialCapital) / agent.initialCapital) * 100 : 0;
  return agent.equity;
}

function agentStyleLabel(style) {
  return {
    momentum: "趋势追踪",
    reversion: "回撤反弹",
    breakout: "突破高频训练",
    "news-flow": "新闻/资金流",
    "risk-balanced": "稳健配置",
  }[style] || style || "训练";
}

function agentTradeThreshold(agent) {
  const best = bestStrategyForAgent(agent);
  const scoreBonus = best ? clamp(Number(best.score || 0) / 12, -4, 4) : 0;
  const bias = Number(agent.learning?.confidenceBias || 0) * 0.35;
  const base = {
    momentum: 60,
    reversion: 56,
    breakout: 53,
    "news-flow": 55,
    "risk-balanced": 62,
  }[agent.style] ?? 58;
  return clamp(base - scoreBonus - bias, 49, 68);
}

function agentExitScoreFloor(agent) {
  return {
    momentum: 46,
    reversion: 43,
    breakout: 47,
    "news-flow": 45,
    "risk-balanced": 52,
  }[agent.style] ?? 46;
}

function agentPositionSizing(agent) {
  return {
    momentum: { cashPct: 0.18, equityPct: 0.045, maxPct: 0.16 },
    reversion: { cashPct: 0.14, equityPct: 0.034, maxPct: 0.12 },
    breakout: { cashPct: 0.12, equityPct: 0.028, maxPct: 0.09 },
    "news-flow": { cashPct: 0.15, equityPct: 0.036, maxPct: 0.13 },
    "risk-balanced": { cashPct: 0.1, equityPct: 0.026, maxPct: 0.08 },
  }[agent.style] || { cashPct: 0.14, equityPct: 0.035, maxPct: 0.12 };
}

function estimatedOneWayCostPct(item = null, technicals = normalizeTechnicals(item?.technicals)) {
  const base = {
    ASX: 0.08,
    US: 0.045,
    CN: 0.07,
  }[state.market] ?? 0.08;
  const volumeRatio = Number(technicals?.volumeRatio || 1);
  const illiquidity = volumeRatio < 0.65 ? 0.09 : volumeRatio < 0.9 ? 0.045 : 0;
  const sourcePenalty = item?.marketValidation?.degraded ? 0.025 : 0;
  return Number((base + illiquidity + sourcePenalty).toFixed(4));
}

function estimatedRoundTripCostPct(item = null, technicals = normalizeTechnicals(item?.technicals)) {
  return Number((estimatedOneWayCostPct(item, technicals) * 2).toFixed(4));
}

function agentDecisionScore(agent, item) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const marketBias = Number(state.marketIndexSignal?.score || 0);
  const learnedBias = Number(agent.learning?.symbolBias?.[item.symbol] || 0) + Number(agent.learning?.confidenceBias || 0);
  const evidence = trainingEvidenceScore(item, technicals, analysis);
  const factorScore = factorScoreForItem(item);
  const targetProb = strategyProbability(analysis);
  const finalProb = finalReturnProbability(analysis);
  const maxProb = maxUpsideProbability(analysis);
  if (agent.style === "reversion") {
    return clamp(
      46 + (50 - technicals.rsi) * 0.75 + projectedMaxUpside(analysis) * 2.4 + (analysis.confidence - 55) * 0.22 + marketBias * 0.55 + evidence * 0.08 + learnedBias,
      0,
      100
    );
  }
  if (agent.style === "breakout") {
    return clamp(
      35 + (analysis.confidence - 48) * 0.42 + projectedMaxUpside(analysis) * 3.1 + (technicals.trendScore - 48) * 0.22 + (technicals.volumeRatio - 1) * 11 + Math.max(0, technicals.change5d) * 0.45 + maxProb * 0.08 + marketBias * 0.7 + learnedBias,
      0,
      100
    );
  }
  if (agent.style === "news-flow") {
    return clamp(
      34 + evidence * 0.34 + factorScore * 0.2 + targetProb * 0.12 + projectedFinalReturn(analysis) * 2.6 + (technicals.trendScore - 50) * 0.12 + marketBias * 0.55 + learnedBias,
      0,
      100
    );
  }
  if (agent.style === "risk-balanced") {
    return clamp(
      28 + analysis.confidence * 0.24 + targetProb * 0.18 + finalProb * 0.1 + (technicals.riskScore - 45) * 0.28 + Math.max(0, technicals.trendScore - 50) * 0.14 + evidence * 0.08 - Math.max(0, Number(analysis.downsideConfidence || 0) - 45) * 0.18 + learnedBias * 0.6,
      0,
      100
    );
  }
  return clamp(
    38 + (analysis.confidence - 50) * 0.5 + projectedFinalReturn(analysis) * 3.2 + projectedMaxUpside(analysis) * 1.1 + (technicals.trendScore - 50) * 0.24 + (technicals.volumeRatio - 1) * 8 + evidence * 0.08 + marketBias * 0.9 + learnedBias,
    0,
    100
  );
}

function pushAgentTrade(agent, trade) {
  agent.trades = [trade, ...(agent.trades || [])].slice(0, 60);
  agent.stats = agent.stats || { wins: 0, losses: 0, trades: 0, closedTrades: 0 };
  agent.stats.trades += 1;
  if (trade.side === "SELL") {
    agent.stats.closedTrades = Number(agent.stats.closedTrades || 0) + 1;
    if (trade.pnlPct > 0) agent.stats.wins += 1;
    if (trade.pnlPct < 0) agent.stats.losses += 1;
  }
}

function sellAgentPosition(agent, symbol, price, reason) {
  const position = agent.positions?.[symbol];
  if (!position || price <= 0) return;
  agent.learning = agent.learning || { aggressiveness: 1, confidenceBias: 0, symbolBias: {} };
  agent.learning.symbolBias = agent.learning.symbolBias || {};
  const item = state.analyses.get(symbol);
  const exitCostPct = estimatedOneWayCostPct(item);
  const value = position.qty * price;
  const exitCost = value * exitCostPct / 100;
  const netValue = value - exitCost;
  const costBasis = Number(position.costBasis || (position.qty * position.avgPrice));
  const pnlPct = costBasis > 0 ? ((netValue - costBasis) / costBasis) * 100 : pctChange(price, position.avgPrice) - exitCostPct;
  const heldDays = Math.max(0, (Date.now() - new Date(position.openedAt || Date.now()).getTime()) / 86400000);
  const lesson = agentTradeLesson(agent, symbol, pnlPct, reason, heldDays);
  agent.cash += netValue;
  delete agent.positions[symbol];
  agent.learning.symbolBias[symbol] = clamp(Number(agent.learning.symbolBias[symbol] || 0) + (pnlPct > 0 ? 0.9 : -1.25), -6, 6);
  pushAgentTrade(agent, {
    time: new Date().toISOString(),
    side: "SELL",
    symbol,
    qty: position.qty,
    price,
    pnlPct,
    reason,
    lesson,
    heldDays,
    costPct: exitCostPct,
    cost: exitCost,
  });
}

function agentTradeLesson(agent, symbol, pnlPct, reason, heldDays = 0) {
  if (pnlPct >= 0) {
    if (reason === "take-profit/time") return "盈利退出：该策略可保留，但后续比较是否过早止盈。";
    return "正收益退出：记录为有效样本，继续观察同类入场的稳定性。";
  }
  if (reason === "stop") return "亏损复盘：价格先触及止损，后续同类入场需要更高量能/新闻/因子确认，且降低该票偏置。";
  if (reason === "signal-exit") return "亏损复盘：模型信号转弱才退出，说明入场后确认不足；同类交易下调入场频率或提高共识门槛。";
  if (heldDays > getStrategy().horizonDays * 0.7) return "亏损复盘：持有接近周期仍未兑现，后续缩短该策略最长持有或提前复核。";
  return `亏损复盘：${symbol} 本次 ${formatPct(pnlPct)}，作为失败交易保留，后续降低该形态信心。`;
}

function buyAgentPosition(agent, item, score) {
  const technicals = normalizeTechnicals(item.technicals);
  const price = technicals.close;
  const entryCostPct = estimatedOneWayCostPct(item, technicals);
  const grossPerShare = price * (1 + entryCostPct / 100);
  if (!price || price <= 0 || agent.cash < grossPerShare) return;
  const sizing = agentPositionSizing(agent);
  const maxPositionValue = Math.max(agent.equity * sizing.maxPct, agent.initialCapital * Math.min(0.06, sizing.maxPct));
  const currentValue = (agent.positions[item.symbol]?.qty || 0) * price;
  if (currentValue >= maxPositionValue) return;
  const ticket = Math.min(
    agent.cash * sizing.cashPct,
    agent.equity * sizing.equityPct * Number(agent.learning?.aggressiveness || 1),
    maxPositionValue - currentValue
  );
  const qty = Math.floor(ticket / grossPerShare);
  if (qty <= 0) return;
  const existing = agent.positions[item.symbol];
  const grossValue = qty * price;
  const entryCost = grossValue * entryCostPct / 100;
  if (existing) {
    const totalQty = existing.qty + qty;
    const previousCostBasis = Number(existing.costBasis || (existing.avgPrice * existing.qty));
    existing.costBasis = previousCostBasis + grossValue + entryCost;
    existing.avgPrice = existing.costBasis / totalQty;
    existing.qty = totalQty;
    existing.lastPrice = price;
    existing.costPaid = Number(existing.costPaid || 0) + entryCost;
  } else {
    agent.positions[item.symbol] = {
      qty,
      avgPrice: (grossValue + entryCost) / qty,
      lastPrice: price,
      openedAt: new Date().toISOString(),
      costBasis: grossValue + entryCost,
      costPaid: entryCost,
      entryCostPct,
    };
  }
  agent.cash -= grossValue + entryCost;
  pushAgentTrade(agent, {
    time: new Date().toISOString(),
    side: "BUY",
    symbol: item.symbol,
    qty,
    price,
    pnlPct: 0,
    reason: `score ${score.toFixed(1)} / threshold ${agentTradeThreshold(agent).toFixed(1)} · one-way cost ${entryCostPct.toFixed(3)}%`,
    costPct: entryCostPct,
    cost: entryCost,
  });
}

function trainAgentsWithResults(results = []) {
  const ledger = getAgentLedger();
  const before = agentModelSummary(ledger);
  const bySymbol = new Map(results.map((item) => [item.symbol, item]));
  trainAgentsWithHistoricalReplay(ledger, results);
  ledger.agents.forEach((agent) => {
    const previousEquity = Number(agent.equity || agent.initialCapital || 0);
    markAgentToMarket(agent);
    const rewardPct = previousEquity > 0 ? ((agent.equity - previousEquity) / previousEquity) * 100 : 0;
    agent.learning = agent.learning || { aggressiveness: 1, confidenceBias: 0, symbolBias: {} };
    agent.learning.symbolBias = agent.learning.symbolBias || {};
    agent.learning.aggressiveness = clamp(Number(agent.learning.aggressiveness || 1) + (rewardPct > 0 ? 0.015 : rewardPct < -0.15 ? -0.025 : 0), 0.55, 1.35);
    agent.learning.confidenceBias = clamp(Number(agent.learning.confidenceBias || 0) + (rewardPct > 0 ? 0.08 : rewardPct < -0.15 ? -0.12 : 0), -4, 4);
    Object.entries(agent.positions || {}).forEach(([symbol, position]) => {
      const item = bySymbol.get(symbol);
      if (!item) return;
      const price = normalizeTechnicals(item.technicals).close;
      const pnlPct = pctChange(price, position.avgPrice);
      const heldDays = Math.max(0, (Date.now() - new Date(position.openedAt || Date.now()).getTime()) / 86400000);
      const score = agentDecisionScore(agent, item);
      const styleStopScale = { breakout: 0.72, "news-flow": 0.85, "risk-balanced": 0.68, reversion: 0.78, momentum: 1 };
      const styleTakeProfitScale = { breakout: 0.42, "news-flow": 0.55, "risk-balanced": 0.7, reversion: 0.48, momentum: 0.55 };
      const stopLine = Math.abs(getStrategy().stopLoss || 4) * (styleStopScale[agent.style] || 1);
      const takeLine = Math.max(0.9, getStrategy().targetUpside * (styleTakeProfitScale[agent.style] || 0.55));
      const maxHoldScale = { breakout: 0.42, "news-flow": 0.62, "risk-balanced": 0.82, reversion: 0.52, momentum: 0.85 }[agent.style] || 0.75;
      if (pnlPct <= -stopLine || pnlPct >= takeLine || score < agentExitScoreFloor(agent) || heldDays > getStrategy().horizonDays * maxHoldScale) {
        sellAgentPosition(agent, symbol, price, pnlPct <= -stopLine ? "stop" : score < agentExitScoreFloor(agent) ? "signal-exit" : "take-profit/time");
      }
    });
    results.forEach((item) => {
      if (item.analysis?.action === "ERROR") return;
      const score = agentDecisionScore(agent, item);
      if (score >= agentTradeThreshold(agent)) buyAgentPosition(agent, item, score);
    });
    markAgentToMarket(agent);
    agent.previousEquity = agent.equity;
  });
  ledger.updatedAt = new Date().toISOString();
  state.agentLedgerByMarket[state.market] = ledger;
  persistAgentMemoryFromLedger(ledger, "training");
  saveAgentState();
  if (results.length) {
    appendModelChangeLog({
      type: "agent-auto-training",
      title: "Agent 自动学习已更新",
      summary: `使用 ${results.length} 只股票的最新分析更新纸面 Agent；仅影响本地模拟偏置，不提升实盘置信。`,
      before,
      after: agentModelSummary(ledger),
      details: { sampleCount: results.length, symbols: results.map((item) => item.symbol).slice(0, 40) },
    });
  }
  renderAgentPanel();
  renderOptimalStrategyPanel();
}

function agentInfluenceForSymbol(symbol) {
  const ledger = getAgentLedger();
  const memory = getAgentMemory();
  let raw = 0;
  let contributors = 0;
  const memorySymbolBias = Number(memory.symbolBias?.[symbol] || 0);
  const memoryBest = Object.values(memory.strategyBook || {})
    .filter((row) => Number(row.trades || 0) >= 5)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
  const memorySymbolBest = Object.values(memory.strategyBook || {})
    .filter((row) => Number(row.symbols?.[symbol] || 0) >= 2)
    .sort((a, b) => (Number(b.score || 0) + Math.log1p(Number(b.symbols?.[symbol] || 0))) - (Number(a.score || 0) + Math.log1p(Number(a.symbols?.[symbol] || 0))))[0];
  if (memoryBest || memorySymbolBest || memorySymbolBias) {
    raw += clamp(memorySymbolBias * 0.45, -2.5, 2.5)
      + (memoryBest ? clamp(Number(memoryBest.score || 0) / 16, -1.5, 1.8) : 0)
      + (memorySymbolBest ? clamp(Number(memorySymbolBest.score || 0) / 10 + Math.log1p(Number(memorySymbolBest.symbols?.[symbol] || 0)) * 0.22, -2, 2.8) : 0);
    contributors += 1;
  }
  ledger.agents.forEach((agent) => {
    markAgentToMarket(agent);
    const stats = agent.stats || {};
    const closedTrades = Number(stats.closedTrades || 0);
    if (closedTrades < 2) return;
    const winRate = closedTrades ? Number(stats.wins || 0) / closedTrades : 0;
    const perf = clamp(Number(agent.returnPct || 0) / 3, -2, 2);
    const symbolBias = Number(agent.learning?.symbolBias?.[symbol] || 0);
    const positionBias = agent.positions?.[symbol] ? 1.2 : 0;
    const best = bestStrategyForAgent(agent);
    const strategyBias = best ? clamp(best.score / 10, -1.5, 2.5) : 0;
    raw += (winRate - 0.5) * 4 + perf + symbolBias * 0.5 + positionBias + strategyBias;
    contributors += 1;
  });
  if (!contributors) return { confidence: 0, upside: 0, contributors: 0 };
  const confidence = clamp(raw / contributors, -5, 5);
  return { confidence, upside: clamp(confidence * 0.18, -1, 1), contributors };
}

function forecastMemoryKey() {
  return `forecastMemory:${state.market}`;
}

function readForecastMemory() {
  return readJsonStorage(forecastMemoryKey(), {});
}

function writeForecastMemory(memory) {
  safeStorage.setItem(forecastMemoryKey(), JSON.stringify(memory || {}));
}

function storeForecastMemory(results = []) {
  const memory = readForecastMemory();
  const strategy = getStrategy();
  results.forEach((result) => {
    if (!result?.symbol || result.analysis?.action === "ERROR") return;
    const analysis = normalizeAnalysis(result.analysis);
    const technicals = normalizeTechnicals(result.technicals);
    if (!technicals.close) return;
    memory[result.symbol] = {
      market: state.market,
      symbol: result.symbol,
      time: new Date().toISOString(),
      close: technicals.close,
      projectedUpside: analysis.projectedUpside,
      projectedFinalReturn: projectedFinalReturn(analysis),
      projectedMaxUpside: projectedMaxUpside(analysis),
      confidence: analysis.confidence,
      finalReturnHitProbability: finalReturnProbability(analysis),
      maxUpsideHitProbability: maxUpsideProbability(analysis),
      action: analysis.action,
      horizonDays: Number(analysis.horizonDays || strategy.horizonDays || 15),
      targetUpside: Number(strategy.targetUpside || 5),
    };
  });
  writeForecastMemory(memory);
}

function finalizeActionFromStrategy(analysis) {
  const strategy = getStrategy();
  const gate = analysis.qualityGate || {};
  const minConfidence = Math.max(Number(strategy.confidence || 80), Number(gate.minTradeConfidence || 72));
  const strategyProb = strategyProbability(analysis);
  const magnitudeProb = Math.max(magnitudeProbability(analysis), maxUpsideProbability(analysis));
  const strictMarket = state.market === "ASX" || state.market === "US";
  const summary = state.accuracySummary || {};
  const lowAccuracyMode = Number(summary.resolved || 0) >= 8 && (Number(summary.hitRate || 0) < 50 || (summary.buyHitRate != null && Number(summary.buyHitRate) < 50));
  const baseStrategyTarget = strictMarket ? Math.max(60, Number(strategy.confidence || 80) - 7) : Math.max(55, Number(strategy.confidence || 80) - 10);
  const strategyProbabilityTarget = Math.max(strictMarket ? 60 : 55, Math.min(80, Number(gate.strategyProbabilityTarget || baseStrategyTarget) + (lowAccuracyMode ? 4 : 0)));
  const magnitudeProbabilityTarget = Math.max(strictMarket ? 50 : 44, Math.min(70, Number(strategy.confidence || 80) - (strictMarket ? 24 : 30)));
  const gateBlocked = gate.blocked === true || gate.buyEligible === false;
  const ensemble = analysis.ensemble || {};
  const minConsensus = Number(gate.minBuyConsensus || (strictMarket ? 66 : 60));
  const minUpsideAgreement = Number(gate.minBuyUpsideAgreement || (strictMarket ? 62 : 56));
  const consensusOk = !ensemble.consensusAgreement || Number(ensemble.consensusAgreement || 0) >= minConsensus;
  const upsideOk = !ensemble.upsideAgreement || Number(ensemble.upsideAgreement || 0) >= minUpsideAgreement;
  const downsideConfidence = Number(analysis.downsideConfidence || (analysis.projectedUpside < 0 ? analysis.confidence : 0));
  const targetMove = selectionUpside(analysis);
  const stopLoss = Math.abs(Number(strategy.stopLoss || 4));
  const severeDownside = projectedFinalReturn(analysis) <= -Math.max(stopLoss, 4)
    || (downsideConfidence >= Math.max(70, Number(strategy.confidence || 80) - 5) && projectedFinalReturn(analysis) <= -Math.max(2.5, stopLoss * 0.65));
  if (severeDownside) return "STRONG_AVOID";
  if (!gateBlocked && consensusOk && upsideOk && analysis.confidence >= minConfidence + 8 && magnitudeProb >= magnitudeProbabilityTarget + 5 && strategyProb >= strategyProbabilityTarget + 5 && targetMove >= Number(strategy.targetUpside || 5) * 1.12) return "STRONG_BUY";
  if (!gateBlocked && consensusOk && upsideOk && analysis.confidence >= minConfidence && magnitudeProb >= magnitudeProbabilityTarget && strategyProb >= strategyProbabilityTarget && targetMove >= strategy.targetUpside) return "WATCH_BUY";
  const lightConfidenceFloor = strictMarket || lowAccuracyMode ? Math.max(58, minConfidence - 8) : Math.max(52, minConfidence - 12);
  const lightMagnitudeFloor = strictMarket || lowAccuracyMode ? Math.max(44, magnitudeProbabilityTarget - 8) : Math.max(38, magnitudeProbabilityTarget - 10);
  const lightStrategyFloor = strictMarket || lowAccuracyMode ? Math.max(55, strategyProbabilityTarget - 6) : Math.max(45, strategyProbabilityTarget - 12);
  const lightUpsideFloor = Math.max(0.8, Number(strategy.targetUpside || 5) * (strictMarket || lowAccuracyMode ? 0.65 : 0.45));
  if (!gateBlocked && consensusOk && upsideOk && analysis.confidence >= lightConfidenceFloor && magnitudeProb >= lightMagnitudeFloor && strategyProb >= lightStrategyFloor && targetMove >= lightUpsideFloor) return "LIGHT_BUY";
  if (analysis.confidence <= 42 || projectedFinalReturn(analysis) <= -1.2) return "AVOID_OR_REDUCE";
  return "HOLD_WATCH";
}

function conservativeClientForecast(analysis) {
  const strategy = getStrategy();
  const ensemble = analysis.ensemble || {};
  const gate = analysis.qualityGate || {};
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const disagreement = Number(ensemble.disagreementPenalty || 0);
  const target = Math.max(1, Number(strategy.targetUpside || 5));
  let projectedUpside = Number(analysis.projectedUpside || 0);
  let confidence = Number(analysis.confidence || 0);
  const strategyProb = strategyProbability(analysis);
  const sourceMagnitudeProb = Math.max(magnitudeProbability(analysis), maxUpsideProbability(analysis));
  const sourceFinalProb = finalReturnProbability(analysis);
  const sourceMaxProb = maxUpsideProbability(analysis);
  const sourceProjectedMax = projectedMaxUpside(analysis);
  const strictMarket = state.market === "ASX" || state.market === "US";
  const summary = state.accuracySummary || {};
  const lowAccuracyMode = Number(summary.resolved || 0) >= 8 && (Number(summary.hitRate || 0) < 50 || (summary.buyHitRate != null && Number(summary.buyHitRate) < 50));
  const baseStrategyTarget = strictMarket ? Math.max(60, Number(strategy.confidence || 80) - 7) : Math.max(55, Number(strategy.confidence || 80) - 10);
  const strategyProbabilityTarget = Math.max(strictMarket ? 60 : 55, Math.min(80, Number(gate.strategyProbabilityTarget || baseStrategyTarget) + (lowAccuracyMode ? 4 : 0)));
  const magnitudeProbabilityTarget = Math.max(strictMarket ? 50 : 44, Math.min(70, Number(strategy.confidence || 80) - (strictMarket ? 24 : 30)));
  if (projectedUpside > 0) {
    const cap = Number(gate.projectedUpsideCap || (
      consensus >= 82 && upsideAgreement >= 70 ? target * 1.55 : consensus >= 70 && upsideAgreement >= 62 ? target * 1.25 : target * (strictMarket ? 0.82 : 0.95)
    ));
    projectedUpside = Math.min(projectedUpside, cap);
  } else {
    projectedUpside = Math.max(projectedUpside, -Math.max(4, target * 1.25));
  }
  if (gate.confidenceCap != null) confidence = Math.min(confidence, Number(gate.confidenceCap));
  if (consensus && consensus < 58) confidence = Math.min(confidence, 62);
  else if (consensus && consensus < 66) confidence = Math.min(confidence, 75);
  if (disagreement > 6) confidence = Math.min(confidence, 78);
  const minConsensus = Number(gate.minBuyConsensus || (strictMarket ? 66 : 60));
  const minUpsideAgreement = Number(gate.minBuyUpsideAgreement || (strictMarket ? 62 : 56));
  const maxDisagreement = Number(gate.maxBuyDisagreement || (strictMarket ? 6.8 : 7.5));
  const blocked = gate.blocked === true
    || gate.buyEligible === false
    || strategyProb < strategyProbabilityTarget
    || (consensus && consensus < minConsensus)
    || (upsideAgreement && upsideAgreement < minUpsideAgreement)
    || disagreement > maxDisagreement;
  const finalConfidence = clamp(Math.round(confidence), 0, 99);
  const finalProjected = Number(projectedUpside.toFixed(2));
  const projectedDelta = Math.abs(finalProjected - Number(analysis.projectedUpside || 0));
  const finalMagnitudeProbability = clamp(Math.round(sourceMagnitudeProb - projectedDelta * 4.5 - (blocked && finalProjected > 0 ? 3 : 0)), 0, 92);
  const finalReturnHitProbability = clamp(Math.round(sourceFinalProb - projectedDelta * 4.8 - (blocked && finalProjected > 0 ? 3 : 0)), 0, 92);
  const maxUpsideCap = target * (consensus >= 82 && upsideAgreement >= 70 ? 1.8 : consensus >= 70 && upsideAgreement >= 62 ? 1.55 : strictMarket ? 1.18 : 1.35);
  const rawProjectedMax = finalProjected > 0
    ? Math.max(finalProjected, sourceProjectedMax)
    : Math.max(0, sourceProjectedMax * 0.72);
  const finalProjectedMax = Number(clamp(rawProjectedMax, 0, Math.max(0.8, maxUpsideCap)).toFixed(2));
  const maxDelta = Math.abs(finalProjectedMax - sourceProjectedMax);
  const finalMaxUpsideProbability = clamp(Math.round(sourceMaxProb - maxDelta * 3.6 - (blocked && finalProjectedMax > 0 ? 2 : 0)), 0, 92);
  const magnitudeBlocked = Math.max(finalProjected, finalProjectedMax * 0.72) > 0 && Math.max(finalMagnitudeProbability, finalMaxUpsideProbability) < magnitudeProbabilityTarget;
  const finalBlocked = blocked || magnitudeBlocked;
  const directionalUpsideAgreement = Number(ensemble.upsideAgreement || 50);
  const upsideConfidence = finalProjected > 0
    ? finalConfidence
    : clamp(Math.round((100 - finalConfidence) * 0.22 + directionalUpsideAgreement * 0.38), 0, 99);
  const downsideConfidence = finalProjected < 0
    ? finalConfidence
    : clamp(Math.round((100 - finalConfidence) * 0.22 + (100 - directionalUpsideAgreement) * 0.38 + Math.max(0, -finalProjected) * 4), 0, 99);
  return {
    ...analysis,
    confidence: finalConfidence,
    predictionConfidence: finalConfidence,
    magnitudeConfidence: finalMagnitudeProbability,
    magnitudeHitProbability: finalMagnitudeProbability,
    moveHitProbability: finalMagnitudeProbability,
    projectedMoveConfidence: finalMagnitudeProbability,
    projectedFinalReturn: finalProjected,
    finalReturnConfidence: finalReturnHitProbability,
    finalReturnHitProbability,
    projectedMaxUpside: finalProjectedMax,
    maxUpsideConfidence: finalMaxUpsideProbability,
    maxUpsideHitProbability: finalMaxUpsideProbability,
    strategyConfidence: strategyProb,
    strategyHitProbability: strategyProb,
    upsideConfidence,
    downsideConfidence,
    direction: finalProjected < -0.35 ? "downside" : finalProjected > 0.35 ? "upside" : analysis.direction || "mixed",
    projectedUpside: finalProjected,
    qualityGate: {
      ...gate,
      blocked: finalBlocked,
      buyEligible: !finalBlocked,
      minTradeConfidence: Math.max(Number(strategy.confidence || 80), Number(gate.minTradeConfidence || 72)),
      strategyProbabilityTarget,
      strategyHitProbability: strategyProb,
      magnitudeHitProbability: finalMagnitudeProbability,
      finalReturnHitProbability,
      projectedMaxUpside: finalProjectedMax,
      maxUpsideHitProbability: finalMaxUpsideProbability,
      magnitudeProbabilityTarget,
      minBuyConsensus: minConsensus,
      minBuyUpsideAgreement: minUpsideAgreement,
      maxBuyDisagreement: maxDisagreement,
    },
  };
}

function clientHorizonBucket(days) {
  const value = Number(days || getStrategy().horizonDays || 15);
  if (value <= 5) return "short";
  if (value <= 20) return "medium";
  return "long";
}

function clientPredictionBehaviorPatternKeys(result, analysis) {
  const technicals = normalizeTechnicals(result.technicals);
  const strategy = getStrategy();
  const ensemble = analysis.ensemble || {};
  const confidence = Number(analysis.rawConfidence ?? analysis.confidence ?? 0);
  const projectedUpside = projectedFinalReturn(analysis);
  const cycleProjected = selectionUpside(analysis);
  const targetUpside = Math.max(1, Number(strategy.targetUpside || 5));
  const horizon = clientHorizonBucket(analysis.horizonDays || strategy.horizonDays);
  const newsCount = Number(result.news?.length || 0) + Number(result.xPosts?.length || 0) + Number(result.youtubeItems?.length || 0);
  const factorCount = factorRows(result.factors).filter(([, factor]) => factor?.available !== false).length;
  const factorScore = factorScoreForItem(result);
  const analog = Number(result.analog?.confidence || 0);
  const trend = Number(technicals.trendScore || 0);
  const momentum = Number(technicals.momentumScore || 0);
  const volume = Number(technicals.volumeScore || 0);
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const strategyProb = strategyProbability(analysis);
  const positive = isBuyAction(analysis.action)
    || (cycleProjected >= targetUpside && confidence >= 58)
    || (cycleProjected >= Math.max(0.8, targetUpside * 0.35) && confidence >= 52 && strategyProb >= 55);
  const keys = [];

  if (!positive) return keys;
  if (confidence >= 72 && newsCount <= 1 && factorCount <= 1) {
    keys.push("thin-evidence-high-confidence", `${horizon}-thin-evidence-high-confidence`);
  }
  if ((trend >= 60 || momentum >= 60) && volume > 0 && volume < 52) {
    keys.push("strong-momentum-weak-volume");
    if (cycleProjected >= targetUpside) keys.push("target-with-weak-volume");
  }
  if (ensemble.direction === "upside" && consensus >= 65 && volume > 0 && volume < 55) {
    keys.push("upside-consensus-weak-volume");
  }
  if (factorScore > 0 && factorScore < 45 && confidence >= 62) keys.push("factor-weak-positive");
  if (analog > 0 && analog < 45 && cycleProjected > 0) keys.push("analog-weak-positive");
  if (confidence >= 72 && consensus > 0 && consensus < 62) keys.push("low-consensus-high-confidence");
  if (cycleProjected >= targetUpside * 1.25 && confidence >= 65) {
    keys.push("aggressive-upside-target", `${horizon}-aggressive-upside-target`);
  }
  if (upsideAgreement >= 65 && newsCount <= 1) keys.push("model-consensus-thin-news");
  if (confidence >= 70 && cycleProjected >= targetUpside && newsCount <= 1) keys.push("target-thin-news");
  return [...new Set(keys)];
}

function adaptiveClientLearningAdjustment(result, analysis) {
  const summary = state.accuracySummary || {};
  const adaptive = summary.adaptive || {};
  const normalizedSymbol = normalizeSymbolForMarket(result.symbol, state.market) || result.symbol;
  const serverSymbol = state.market === "ASX" && normalizedSymbol && !normalizedSymbol.startsWith("^")
    ? `${normalizedSymbol}.AX`
    : normalizedSymbol;
  const symbolStats = adaptive.symbolStats?.[serverSymbol] || adaptive.symbolStats?.[normalizedSymbol] || adaptive.symbolStats?.[result.symbol] || {};
  const horizon = adaptive.horizonStats?.[clientHorizonBucket(analysis.horizonDays)] || {};
  const globalPenalty = Number(adaptive.confidencePenalty || 0);
  const symbolPenalty = Number(symbolStats.confidencePenalty || 0);
  const horizonDirectionPenalty = horizon.resolved >= 6 && horizon.hitRate != null && Number(horizon.hitRate) < 50
    ? Math.min(7, (50 - Number(horizon.hitRate)) * 0.12)
    : 0;
  const horizonMagnitudePenalty = horizon.resolved >= 6 && horizon.magnitudeHitRate != null && Number(horizon.magnitudeHitRate) < 50
    ? Math.min(7, (50 - Number(horizon.magnitudeHitRate)) * 0.14)
    : 0;
  const horizonPenalty = horizon.resolved >= 4 && horizon.buyHitRate != null && Number(horizon.buyHitRate) < 55
    ? Math.min(8, (55 - Number(horizon.buyHitRate)) * 0.11)
    : 0;
  const horizonAdversePenalty = Number(horizon.adversePending || 0) > 0
    ? Math.min(5, Number(horizon.adversePending || 0) * 0.65 + Math.max(0, -Number(horizon.avgInterimReturn || 0)) * 0.35)
    : 0;
  const matchedPatternStats = clientPredictionBehaviorPatternKeys(result, analysis)
    .map((key) => adaptive.patternStats?.[key])
    .filter((stat) => Number(stat?.confidencePenalty || 0) > 0)
    .sort((a, b) => Number(b.confidencePenalty || 0) - Number(a.confidencePenalty || 0))
    .slice(0, 3);
  const patternPenalty = matchedPatternStats.reduce((sum, stat, index) => (
    sum + Number(stat.confidencePenalty || 0) * (index === 0 ? 1 : 0.45)
  ), 0);
  const confidencePenalty = clamp(globalPenalty + symbolPenalty + horizonDirectionPenalty + horizonMagnitudePenalty + horizonPenalty + horizonAdversePenalty + patternPenalty, 0, 28);
  const globalShrink = Number(adaptive.upsideShrink || 1) || 1;
  const symbolShrink = Number(symbolStats.upsideShrink || 1) || 1;
  const horizonDirectionShrink = horizon.resolved >= 6 && horizon.hitRate != null && Number(horizon.hitRate) < 50
    ? Math.max(0.72, 1 - (50 - Number(horizon.hitRate)) * 0.007)
    : 1;
  const horizonMagnitudeShrink = horizon.resolved >= 6 && horizon.magnitudeHitRate != null && Number(horizon.magnitudeHitRate) < 50
    ? Math.max(0.68, 1 - (50 - Number(horizon.magnitudeHitRate)) * 0.009)
    : 1;
  const horizonShrink = horizon.resolved >= 4 && Number(horizon.avgOverPrediction || 0) > 0
    ? Math.max(0.68, 1 - Number(horizon.avgOverPrediction || 0) * 0.025)
    : 1;
  const patternShrink = matchedPatternStats.reduce((value, stat) => Math.min(value, Number(stat.upsideShrink || 1) || 1), 1);
  const upsideShrink = clamp(globalShrink * symbolShrink * horizonDirectionShrink * horizonMagnitudeShrink * horizonShrink * patternShrink, 0.35, 1);
  if (confidencePenalty < 0.25 && upsideShrink > 0.985) return analysis;
  const notes = [];
  if (globalPenalty > 0.4) notes.push(`全局近期预测惩罚 ${globalPenalty.toFixed(1)}%`);
  if (symbolPenalty > 0.4) notes.push(`${result.symbol} 近期预测偏差惩罚 ${symbolPenalty.toFixed(1)}%`);
  if (horizonDirectionPenalty > 0.4) notes.push(`当前周期方向准确率不足惩罚 ${horizonDirectionPenalty.toFixed(1)}%`);
  if (horizonMagnitudePenalty > 0.4) notes.push(`当前周期幅度达成率不足惩罚 ${horizonMagnitudePenalty.toFixed(1)}%`);
  if (horizonPenalty > 0.4) notes.push(`当前周期买入达标不足惩罚 ${horizonPenalty.toFixed(1)}%`);
  if (horizonAdversePenalty > 0.4) notes.push(`当前周期未到期预测已逆行惩罚 ${horizonAdversePenalty.toFixed(1)}%`);
  if (patternPenalty > 0.4) notes.push(`相似预测行为惩罚 ${patternPenalty.toFixed(1)}%：${matchedPatternStats.map((stat) => stat.label).join("、")}`);
  if (upsideShrink < 0.985) notes.push(`预估涨幅按 ${(upsideShrink * 100).toFixed(0)}% 收缩`);
  const projectedUpside = Number(analysis.projectedUpside || 0);
  const finalConfidence = clamp(Math.round(Number(analysis.confidence || 0) - confidencePenalty), 0, 99);
  const finalProjected = Number((projectedUpside > 0 ? projectedUpside * upsideShrink : projectedUpside).toFixed(2));
  const finalMagnitudeProbability = clamp(Math.round(magnitudeProbability(analysis) - confidencePenalty * 0.7 - Math.max(0, 1 - upsideShrink) * 18), 0, 92);
  const finalReturnHitProbability = clamp(Math.round(finalReturnProbability(analysis) - confidencePenalty * 0.72 - Math.max(0, 1 - upsideShrink) * 19), 0, 92);
  const finalProjectedMax = Number((projectedMaxUpside(analysis) > 0 ? Math.max(0, projectedMaxUpside(analysis) * Math.max(0.58, upsideShrink * 0.92)) : Math.max(0, finalProjected)).toFixed(2));
  const finalMaxUpsideProbability = clamp(Math.round(maxUpsideProbability(analysis) - confidencePenalty * 0.58 - Math.max(0, 1 - upsideShrink) * 14), 0, 92);
  const upsideAgreement = Number(analysis.ensemble?.upsideAgreement || 50);
  return {
    ...analysis,
    confidence: finalConfidence,
    predictionConfidence: finalConfidence,
    magnitudeConfidence: finalMagnitudeProbability,
    magnitudeHitProbability: finalMagnitudeProbability,
    moveHitProbability: finalMagnitudeProbability,
    projectedMoveConfidence: finalMagnitudeProbability,
    projectedFinalReturn: finalProjected,
    finalReturnConfidence: finalReturnHitProbability,
    finalReturnHitProbability,
    projectedMaxUpside: finalProjectedMax,
    maxUpsideConfidence: finalMaxUpsideProbability,
    maxUpsideHitProbability: finalMaxUpsideProbability,
    upsideConfidence: finalProjected > 0 ? finalConfidence : clamp(Math.round((100 - finalConfidence) * 0.22 + upsideAgreement * 0.38), 0, 99),
    downsideConfidence: finalProjected < 0 ? finalConfidence : clamp(Math.round((100 - finalConfidence) * 0.22 + (100 - upsideAgreement) * 0.38 + Math.max(0, -finalProjected) * 4), 0, 99),
    direction: finalProjected < -0.35 ? "downside" : finalProjected > 0.35 ? "upside" : analysis.direction || "mixed",
    projectedUpside: finalProjected,
    adaptiveLearning: {
      confidencePenalty,
      upsideShrink,
      horizonBucket: clientHorizonBucket(analysis.horizonDays),
      patternPenalty,
      matchedPatterns: matchedPatternStats.map((stat) => stat.label),
    },
    thesis: [
      `自适应学习纠偏：${notes.join("；")}。旧预测不会被新周期覆盖，会按短/中/长期分别验证后更新参数。`,
      ...(analysis.thesis || []),
    ],
  };
}

function applyForecastStability(result, analysis) {
  const previous = readForecastMemory()[result.symbol];
  if (!previous || previous.market !== state.market) return analysis;
  const technicals = normalizeTechnicals(result.technicals);
  if (!technicals.close || !previous.close) return analysis;
  const elapsedDays = Math.max(0, (Date.now() - new Date(previous.time || Date.now()).getTime()) / 86400000);
  const horizon = Math.max(1, Number(previous.horizonDays || analysis.horizonDays || getStrategy().horizonDays || 15));
  if (elapsedDays > horizon + 2) return analysis;

  const strategy = getStrategy();
  const previousCycleProjected = Math.max(
    Number(previous.projectedFinalReturn ?? previous.projectedUpside ?? 0),
    Math.max(0, Number(previous.projectedMaxUpside || 0)) * 0.72
  );
  const previousPositive = isBuyAction(previous.action) || previousCycleProjected >= Number(previous.targetUpside || strategy.targetUpside || 5);
  const returnSince = pctChange(technicals.close, previous.close);
  const notes = [];
  let confidence = Number(analysis.confidence || 0);
  let projectedUpside = Number(analysis.projectedUpside || 0);

  if (previousPositive && returnSince <= -0.8) {
    const penalty = clamp(Math.abs(returnSince) * 1.35, 1.2, 9);
    confidence -= penalty;
    notes.push(`预测纠偏：上一轮偏多后实际走弱 ${formatPct(returnSince)}，置信度扣减 ${penalty.toFixed(1)}%。`);
  }

  const severeMove = returnSince <= -Math.abs(Number(strategy.stopLoss || 4)) || isRiskAction(analysis.action);
  const maxSwing = severeMove ? 5.2 : 3.2;
  const delta = projectedUpside - Number(previous.projectedUpside || 0);
  if (Math.abs(delta) > maxSwing) {
    projectedUpside = Number((Number(previous.projectedUpside || 0) + Math.sign(delta) * maxSwing).toFixed(2));
    notes.push(`预测稳定器：仍在 ${horizon} 日预测窗口内，单次预估变动限制为 ${maxSwing.toFixed(1)}%，避免因单日波动急转。`);
  }

  const adjusted = {
    ...analysis,
    confidence: clamp(Math.round(confidence), 0, 99),
    projectedUpside: Number(projectedUpside.toFixed(2)),
    projectedFinalReturn: Number(projectedUpside.toFixed(2)),
    finalReturnHitProbability: finalReturnProbability(analysis),
    finalReturnConfidence: finalReturnProbability(analysis),
    projectedMaxUpside: Math.max(0, projectedMaxUpside(analysis), Number(projectedUpside.toFixed(2))),
    maxUpsideHitProbability: maxUpsideProbability(analysis),
    maxUpsideConfidence: maxUpsideProbability(analysis),
    forecastMemory: {
      previousPositive,
      returnSince,
      previousProjectedUpside: Number(previous.projectedUpside || 0),
      previousConfidence: Number(previous.confidence || 0),
      elapsedDays: Number(elapsedDays.toFixed(1)),
    },
    thesis: [...notes, ...(analysis.thesis || [])],
  };
  adjusted.action = finalizeActionFromStrategy(adjusted);
  return adjusted;
}

function evidenceQualityCalibration(result, analysis) {
  const technicals = normalizeTechnicals(result.technicals);
  const evidence = trainingEvidenceScore(result, technicals, analysis);
  const newsCount = Number(result.news?.length || 0) + Number(result.xPosts?.length || 0) + Number(result.youtubeItems?.length || 0);
  const liveFactors = factorRows(result.factors).filter(([, factor]) => factor?.available !== false && factor?.values?.proxy !== true).length;
  const ensemble = analysis.ensemble || {};
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const summary = state.accuracySummary || {};
  const enoughAccuracy = Number(summary.resolved || 0) >= 8;
  const recentDirectionOk = !enoughAccuracy || summary.hitRate == null || Number(summary.hitRate) >= 50;
  const recentBuyOk = !enoughAccuracy || summary.buyHitRate == null || Number(summary.buyHitRate) >= 54;
  const degraded = Boolean(result.marketValidation?.degraded);
  let confidenceDelta = 0;
  let upsideScale = 1;
  const reasons = [];

  if (evidence >= 72 && consensus >= 66 && upsideAgreement >= 58 && recentDirectionOk && recentBuyOk && !degraded) {
    confidenceDelta += Math.min(4.5, (evidence - 68) * 0.12 + (consensus - 64) * 0.035);
    upsideScale += Math.min(0.06, (evidence - 70) * 0.002);
    reasons.push(`证据质量强 ${evidence.toFixed(0)}：新闻/因子/共识一致，允许小幅提高置信`);
  }
  if (evidence < 45) {
    const penalty = Math.min(7, (45 - evidence) * 0.18 + (newsCount <= 1 ? 1.6 : 0) + (liveFactors <= 1 ? 1.3 : 0));
    confidenceDelta -= penalty;
    upsideScale -= Math.min(0.18, penalty * 0.018);
    reasons.push(`证据质量弱 ${evidence.toFixed(0)}：新闻或真实因子偏薄，压低置信和涨幅`);
  }
  if (degraded) {
    confidenceDelta -= 1.8;
    upsideScale -= 0.03;
    reasons.push("行情仅单源/降级验证，避免把数据源不确定性转成高置信");
  }
  if (enoughAccuracy && !recentBuyOk && projectedFinalReturn(analysis) > 0) {
    confidenceDelta -= 2.5;
    upsideScale -= 0.06;
    reasons.push("近期买入达标率不足，正向信号继续保守校准");
  }
  if (!reasons.length) return analysis;

  const projected = Number(analysis.projectedUpside || 0);
  const projectedFinal = Number(projectedFinalReturn(analysis));
  const projectedMax = Number(projectedMaxUpside(analysis));
  const scaledProjected = projected > 0 ? projected * upsideScale : projected;
  const scaledFinal = projectedFinal > 0 ? projectedFinal * upsideScale : projectedFinal;
  const scaledMax = projectedMax > 0 ? projectedMax * Math.max(0.62, upsideScale * 0.96) : projectedMax;
  const magnitudeDelta = confidenceDelta * 0.62;
  return {
    ...analysis,
    confidence: clamp(Math.round(Number(analysis.confidence || 0) + confidenceDelta), 0, 99),
    predictionConfidence: clamp(Math.round(Number(analysis.predictionConfidence ?? analysis.confidence ?? 0) + confidenceDelta), 0, 99),
    projectedUpside: Number(scaledProjected.toFixed(2)),
    projectedFinalReturn: Number(scaledFinal.toFixed(2)),
    projectedMaxUpside: Number(Math.max(0, scaledMax).toFixed(2)),
    magnitudeConfidence: clamp(Math.round(magnitudeProbability(analysis) + magnitudeDelta), 0, 92),
    magnitudeHitProbability: clamp(Math.round(magnitudeProbability(analysis) + magnitudeDelta), 0, 92),
    finalReturnConfidence: clamp(Math.round(finalReturnProbability(analysis) + magnitudeDelta * 0.9), 0, 92),
    finalReturnHitProbability: clamp(Math.round(finalReturnProbability(analysis) + magnitudeDelta * 0.9), 0, 92),
    maxUpsideConfidence: clamp(Math.round(maxUpsideProbability(analysis) + magnitudeDelta * 0.72), 0, 92),
    maxUpsideHitProbability: clamp(Math.round(maxUpsideProbability(analysis) + magnitudeDelta * 0.72), 0, 92),
    qualityGate: {
      ...(analysis.qualityGate || {}),
      evidenceQualityScore: Number(evidence.toFixed(1)),
      evidenceNewsCount: newsCount,
      evidenceLiveFactorCount: liveFactors,
    },
    thesis: [
      `Evidence calibration: ${reasons.join("；")}。`,
      ...(analysis.thesis || []),
    ],
  };
}

function applyPostModelAdjustments(result) {
  if (!result?.analysis || result.analysis.action === "ERROR") return result;
  const analysis = normalizeAnalysis(result.analysis);
  const marketBias = state.marketIndexSignal || { confidenceBias: 0, projectedBias: 0, stance: "mixed" };
  const agentBias = agentInfluenceForSymbol(result.symbol);
  const confidenceAdjustment = Number(marketBias.confidenceBias || 0) + Number(agentBias.confidence || 0);
  const upsideAdjustment = Number(marketBias.projectedBias || 0) + Number(agentBias.upside || 0);
  let adjusted = {
    ...analysis,
    confidence: clamp(Math.round(analysis.confidence + confidenceAdjustment), 0, 99),
    projectedUpside: Number((analysis.projectedUpside + upsideAdjustment).toFixed(2)),
    projectedFinalReturn: Number((projectedFinalReturn(analysis) + upsideAdjustment).toFixed(2)),
    projectedMaxUpside: Number(Math.max(0, projectedMaxUpside(analysis) + Math.max(0, upsideAdjustment * 0.85)).toFixed(2)),
    thesis: [
      `Market/Agent overlay: ${marketBias.stance || "mixed"} market bias ${Number(marketBias.confidenceBias || 0).toFixed(1)}%, paper-agent bias ${Number(agentBias.confidence || 0).toFixed(1)}% from ${agentBias.contributors} trained agents.`,
      ...(analysis.thesis || []),
    ],
  };
  adjusted = evidenceQualityCalibration(result, adjusted);
  adjusted = adaptiveClientLearningAdjustment(result, adjusted);
  adjusted = conservativeClientForecast(adjusted);
  adjusted = applyForecastStability(result, adjusted);
  adjusted = conservativeClientForecast(adjusted);
  adjusted.action = finalizeActionFromStrategy(adjusted);
  return { ...result, analysis: adjusted };
}

function renderAgentPanel() {
  const target = $("agentPanel");
  if (!target) return;
  const ledger = getAgentLedger();
  const memory = getAgentMemory();
  ledger.agents.forEach(markAgentToMarket);
  const memorySummary = `
    <div class="agent-memory-note">
      <strong>长期策略记忆</strong>
      <span>策略 ${Object.keys(memory.strategyBook || {}).length} 个 · 归档 ${memory.archives?.length || 0} 个周期 · 回放交易 ${Math.round(memory.totalReplayTrades || 0)} · 纸面成交 ${Math.round(memory.totalPaperTrades || 0)}</span>
      <p>重置训练只会把当前周期归档；下一轮 agent 会继续继承长期胜率、策略评分和个股偏置。</p>
      ${(memory.lossLessons || []).length ? `<p>最近亏损经验：${memory.lossLessons.slice(0, 3).map((row) => `${escapeHtml(row.symbol)} ${formatPct(row.pnlPct)}：${escapeHtml(row.lesson)}`).join(" / ")}</p>` : ""}
    </div>
  `;
  target.innerHTML = memorySummary + ledger.agents.map((agent) => {
    const positions = Object.entries(agent.positions || {});
    const lastTrades = (agent.trades || []).slice(0, 3);
    return `
      <article class="agent-card">
        <div class="agent-top">
          <div><strong>${agent.name}</strong><span>${agentStyleLabel(agent.style)} · 入场阈值 ${agentTradeThreshold(agent).toFixed(1)} · 攻击性 ${Number(agent.learning?.aggressiveness || 1).toFixed(2)}</span></div>
          <strong class="${Number(agent.returnPct || 0) >= 0 ? "good-text" : "danger-text"}">${formatPct(agent.returnPct || 0)}</strong>
        </div>
        <div class="agent-metrics">
          <span>权益 ${formatMoney(agent.equity)}</span>
          <span>现金 ${formatMoney(agent.cash)}</span>
          <span>持仓 ${positions.length}</span>
          <span>胜/负 ${agent.stats?.wins || 0}/${agent.stats?.losses || 0}</span>
        </div>
        <p>${positions.length ? positions.map(([symbol, position]) => `${symbol} ${position.qty}股 @ ${formatMoney(position.avgPrice)}`).join(" · ") : "当前空仓，等待符合策略的高频模拟入场。"}</p>
        <div class="agent-trades">
          ${lastTrades.length ? lastTrades.map((trade) => `<span title="${escapeHtml(trade.lesson || trade.reason || "")}">${trade.side} ${trade.symbol} ${trade.qty} @ ${formatMoney(trade.price)} ${trade.pnlPct ? formatPct(trade.pnlPct) : ""}${trade.lesson ? ` · ${escapeHtml(trade.lesson)}` : ""}</span>`).join("") : "<span>暂无模拟成交</span>"}
        </div>
        <p>${bestStrategyForAgent(agent) ? `当前最优：${bestStrategyForAgent(agent).name}，回测交易 ${bestStrategyForAgent(agent).trades} 次，均值 ${formatPct(bestStrategyForAgent(agent).avgReturn)}。` : "策略草稿收集中，至少需要几次历史叠加交易。"}</p>
      </article>
    `;
  }).join("");
  renderSimulationArchivePanel();
}

function renderSimulationArchivePanel() {
  const target = $("simulationArchivePanel");
  if (!target) return;
  const memory = getAgentMemory();
  const archives = memory.archives || [];
  const acceptedIds = new Set((memory.transferCandidates || []).map((row) => `${row.sourceMarket}:${row.strategyId}`));
  const transferCandidates = Object.entries(state.agentMemoryByMarket || {})
    .filter(([market]) => safeMarket(market) !== state.market)
    .flatMap(([market, sourceMemory]) => Object.values(sourceMemory?.strategyBook || {}).map((row) => ({
      ...row,
      sourceMarket: safeMarket(market),
      transferScore: Number(row.score || 0) * Math.min(1.5, Math.log10(Math.max(10, Number(row.trades || 0))) / 1.5),
    })))
    .filter((row) => Number(row.trades || 0) >= 8 && Number(row.score || 0) > 0)
    .sort((a, b) => b.transferScore - a.transferScore)
    .slice(0, 8);
  target.innerHTML = `
    <div class="section-head"><h2>历史模拟周期</h2><span class="muted small-text">最近 ${Math.min(archives.length, 12)} / ${archives.length} 个归档</span></div>
    <div class="simulation-archive-list">
      ${archives.length ? archives.slice(0, 12).map((archive) => {
        const agents = Array.isArray(archive.agents) ? archive.agents : [];
        const averageReturn = agents.length ? agents.reduce((sum, agent) => sum + Number(agent.returnPct || 0), 0) / agents.length : 0;
        const best = agents.slice().sort((a, b) => Number(b.returnPct || 0) - Number(a.returnPct || 0))[0];
        return `
          <article>
            <div><strong>${new Date(archive.archivedAt).toLocaleString()}</strong><span>${escapeHtml(archive.reason || "archive")}</span></div>
            <p>Agent 平均收益 ${formatPct(averageReturn)}${best ? ` · 最优 ${escapeHtml(best.name)} ${formatPct(best.returnPct)}` : ""} · 独立 Agent ${agents.length} 个</p>
          </article>
        `;
      }).join("") : `<p class="muted">当前还没有归档周期。点击“重置训练”或修改 Agent 本金后，当前独立周期会保存到这里。</p>`}
    </div>
    <div class="section-head transfer-head"><h2>跨市场迁移候选</h2><span class="muted small-text">只传递聚合策略统计，不复制仓位或原始行情</span></div>
    <div class="simulation-archive-list transfer-candidate-list">
      ${transferCandidates.length ? transferCandidates.map((row) => {
        const accepted = acceptedIds.has(`${row.sourceMarket}:${row.id}`);
        return `
          <article>
            <div><strong>${escapeHtml(row.name || row.id)} · ${row.sourceMarket}</strong><button class="secondary mini-btn" type="button" data-transfer-market="${row.sourceMarket}" data-transfer-id="${escapeHtml(row.id)}" ${accepted ? "disabled" : ""}>${accepted ? "已进入验证队列" : "加入验证队列"}</button></div>
            <p>原市场样本 ${formatCompactNumber(row.trades, 0)} · 胜率 ${formatPct(Number(row.wins || 0) / Math.max(1, Number(row.trades || 0)) * 100)} · 均值 ${formatPct(row.avgReturn)} · 迁移评分 ${formatCompactNumber(row.transferScore, 1)}</p>
          </article>
        `;
      }).join("") : `<p class="muted">其他市场尚无达到最低样本与正评分要求的策略候选。</p>`}
    </div>
    <p class="muted small-text">加入队列不会自动启用策略；候选必须在当前市场完成独立 walk-forward 验证后才可升级。</p>
  `;
  target.querySelectorAll("[data-transfer-market]").forEach((button) => {
    button.addEventListener("click", () => {
      const sourceMarket = safeMarket(button.dataset.transferMarket);
      const strategyId = button.dataset.transferId;
      const source = state.agentMemoryByMarket?.[sourceMarket]?.strategyBook?.[strategyId];
      if (!source) return;
      const current = getAgentMemory();
      current.transferCandidates = [
        ...(current.transferCandidates || []).filter((row) => `${row.sourceMarket}:${row.strategyId}` !== `${sourceMarket}:${strategyId}`),
        {
          sourceMarket,
          strategyId,
          queuedAt: new Date().toISOString(),
          status: "validation-required",
          aggregate: {
            name: source.name,
            entry: source.entry,
            style: source.style,
            trades: Number(source.trades || 0),
            wins: Number(source.wins || 0),
            avgReturn: Number(source.avgReturn || 0),
            maxDrawdown: Number(source.maxDrawdown || 0),
            target: source.target,
            stop: source.stop,
            maxHold: source.maxHold,
          },
        },
      ].slice(-30);
      current.updatedAt = new Date().toISOString();
      state.agentMemoryByMarket[state.market] = current;
      saveAgentState();
      appendModelChangeLog({
        type: "agent-transfer",
        title: "跨市场策略已加入验证队列",
        summary: `${sourceMarket} 的 ${source.name || strategyId} 已加入 ${state.market}，尚未启用，必须通过当前市场独立验证。`,
        before: null,
        after: { transferCandidates: current.transferCandidates.slice(-5) },
        details: {
          sourceMarket,
          strategyId,
          rowsUsed: Number(source.trades || 0),
          avgReturn: Number(source.avgReturn || 0),
          score: Number(source.score || 0),
        },
      });
      renderSimulationArchivePanel();
      setStatus(`${sourceMarket} 的 ${source.name || strategyId} 已加入 ${state.market} 验证队列；尚未启用`);
    });
  });
}

function renderOptimalStrategyPanel() {
  const target = $("optimalStrategyPanel");
  if (!target) return;
  const best = bestStrategyAcrossAgents();
  const ledger = getAgentLedger();
  const memory = getAgentMemory();
  const memorySummary = `
    <div class="agent-memory-note compact">
      <strong>策略记忆已接入预测</strong>
      <span>长期策略 ${Object.keys(memory.strategyBook || {}).length} 个 · 归档 ${memory.archives?.length || 0} 个周期 · 最近更新 ${memory.updatedAt ? new Date(memory.updatedAt).toLocaleString() : "暂无"}</span>
    </div>
  `;
  const rows = [
    ...ledger.agents.flatMap((agent) => Object.values(agent.strategyBook || {}).map((row) => ({ ...row, agentName: agent.name }))),
    ...Object.values(memory.strategyBook || {}).map((row) => ({ ...row, agentName: "长期记忆库" })),
  ]
    .filter((row) => row.trades >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  if (!best) {
    target.innerHTML = `${memorySummary}<p class="muted">还没有足够的叠加训练样本。刷新几轮后会生成草稿版最优交易策略。</p>`;
    return;
  }
  const stable = best.trades >= 40 ? "稳定版" : best.trades >= 15 ? "增强草稿" : "草稿版";
  const winRate = best.trades ? best.wins / best.trades * 100 : 0;
  target.innerHTML = `
    ${memorySummary}
    <article class="strategy-draft">
      <h3>${stable}：${best.name}</h3>
      <p>入场条件：${best.entry}。目标止盈约 ${formatPct(best.target || 0)}，止损约 ${formatPct(best.stop || 0)}，最长持有 ${Math.round(best.maxHold || getStrategy().horizonDays)} 个交易日。</p>
      <p>训练结果：历史叠加交易 ${best.trades} 次，胜率 ${winRate.toFixed(0)}%，单次均值 ${formatPct(best.avgReturn)}，最大不利回撤 ${formatPct(best.maxDrawdown)}，策略评分 ${Number(best.score || 0).toFixed(1)}。</p>
      <p>执行建议：只在大盘不是明显 risk-off、个股成交量不失真、且你的仓位容量仍有余量时采用；如果连续两次刷新评分下降，就把它降级为观察策略。</p>
    </article>
    ${rows.map((row) => `
      <div class="allocation-item">
        <strong>${row.name} · ${row.agentName}</strong>
        <span>交易 ${row.trades} 次，胜率 ${(row.wins / Math.max(1, row.trades) * 100).toFixed(0)}%，均值 ${formatPct(row.avgReturn)}，评分 ${Number(row.score || 0).toFixed(1)}。</span>
      </div>
    `).join("")}
  `;
}

function renderPortfolioSummary() {
  const capital = getCapital();
  syncCapitalFields();
  const holdings = activePortfolio();
  const marketValue = holdings.reduce((sum, holding) => {
    const analysis = state.analyses.get(holding.symbol);
    const close = analysis?.technicals?.close || holding.avgPrice;
    return sum + close * holding.qty;
  }, 0);
  const cost = holdings.reduce((sum, holding) => sum + holding.avgPrice * holding.qty, 0);
  const pnl = marketValue - cost;
  const alerts = [...state.analyses.values()].filter((item) => isBuyAction(item.analysis?.action)).length;

  $("portfolioSummary").innerHTML = `
    <div class="metric"><span>总权益 / 浮盈亏</span><strong>${formatMoney(capital.totalCapital)} / ${formatMoney(capital.unrealizedPnl)}</strong></div>
    <div class="metric"><span>持仓占额</span><strong>${formatMoney(capital.investedValue)}</strong></div>
    <div class="metric"><span>可用 / 新买入</span><strong>${formatMoney(capital.availableCash)} / ${formatMoney(capital.availableForNewTrades)}</strong></div>
    <div class="metric"><span>买入/轻仓关注</span><strong>${alerts}</strong></div>
  `;
  renderAlerts();
  renderPortfolioTable();
  renderAllocationAdvice();
  renderAccuracyPanel();
}

function universeMetaForSymbol(symbol, market = state.market) {
  const normalized = normalizeSymbolForMarket(symbol, market);
  return cachedUniverseRows(market).find((row) => row.symbol === normalized || row.code === normalized) || {};
}

function selectWatchSymbol(symbol) {
  const normalized = normalizeSymbolForMarket(symbol, state.market);
  if (!normalized) return;
  state.selected = normalized;
  renderCards();
  renderDetail();
}

function renderCards() {
  state.watchlist = sanitizeSymbolsForMarket(state.watchlist, state.market);
  const cardsEl = $("cards");
  if (!cardsEl) return;
  const universeMeta = new Map();
  cachedUniverseRows(state.market).forEach((row) => {
    if (row.symbol) universeMeta.set(row.symbol, row);
    if (row.code) universeMeta.set(row.code, row);
  });
  const cards = state.watchlist.map((symbol) => {
    try {
      const meta = universeMeta.get(symbol) || {};
      const displayName = meta.name && meta.name !== symbol ? meta.name : activeMarketConfig().label;
      const watchOriginLabel = watchSourceLabel(watchlistOriginFor(symbol, state.market, "saved"));
      const item = state.analyses.get(symbol);
      const selectedClass = state.selected === symbol ? " selected" : "";
      if (!item) {
        return `
          <article class="stock-card empty-card${selectedClass}" data-symbol="${symbol}" data-card-symbol="${symbol}">
            <div class="card-top">
              <div class="stock-title-block">
                <h3>${symbol}</h3>
                <small class="stock-name">${escapeHtml(displayName)}</small>
              </div>
              <div class="card-signal-stack">
                <span class="card-state-chip warn">未刷新</span>
                <div class="card-actions card-top-actions">
                  <button class="danger-soft mini-btn" type="button" data-delete-symbol="${symbol}">删除</button>
                </div>
              </div>
            </div>
            <div class="tag-row card-primary-tags"><span class="tag warn">${watchOriginLabel}</span><span class="tag">${activeMarketConfig().label}</span></div>
            <div class="decision-row">
              <span class="muted">等待真实行情</span>
            </div>
          </article>
        `;
      }
      const technicals = normalizeTechnicals(item.technicals);
      const analysis = normalizeAnalysis(item.analysis);
      const isError = analysis.action === "ERROR";
      const isDegraded = item.marketValidation?.degraded;
      const sourceClass = isError ? "danger" : isDegraded ? "warn" : "good";
      const sourceLabel = isError ? errorLabel(item.errorKind) : isDegraded ? "单源真实数据" : item.marketSource;
      const quoteLabel = item.quote?.source ? `最新价 ${item.quote.delayed ? "延迟" : "实时"}` : "";
      const alertTag = !isError && isBuyAction(analysis.action)
        ? `<span class="tag ${analysis.action === "LIGHT_BUY" ? "warn" : "good"}">${actionLabel(analysis.action)} ${formatMoney(analysis.suggestedTradeValue || 0)}</span>`
        : !isError && ["STRONG_AVOID", "CRITICAL_SELL"].includes(analysis.action)
          ? `<span class="tag danger">${actionLabel(analysis.action)}</span>`
        : "";
      const factorScore = factorScoreForItem(item);
      const directionText = directionLabel(analysis);
      const directionProb = directionReliability(analysis);
      const finalProb = finalReturnProbability(analysis);
      const maxMove = projectedMaxUpside(analysis);
      const maxProb = maxUpsideProbability(analysis);
      const strategyProb = strategyProbability(analysis);
      const cardTone = isError ? "blocked" : isStrictBuyAction(analysis.action) ? "ready" : isRiskAction(analysis.action) ? "danger" : "watch";
      const indicatorTags = isError ? "" : `
            ${alertTag}
            <span class="tag ${tagClass(projectedFinalReturn(analysis), getStrategy().targetUpside, 0)}">结束 ${formatPct(projectedFinalReturn(analysis))}</span>
            <span class="tag ${tagClass(finalProb, Math.max(55, getStrategy().confidence - 22), 36)}">结束置信 ${Math.round(finalProb)}%</span>
            <span class="tag ${tagClass(maxMove, getStrategy().targetUpside, 0)}">最高触达 ${formatPct(maxMove)}</span>
            <span class="tag ${tagClass(maxProb, Math.max(55, getStrategy().confidence - 22), 36)}">触达置信 ${Math.round(maxProb)}%</span>
            <span class="tag ${tagClass(directionProb, getStrategy().confidence, 40)}">方向 ${directionText} ${Math.round(directionProb)}%</span>
            <span class="tag ${tagClass(strategyProb, strategyProbabilityTarget(analysis), 45)}">策略达标 ${Math.round(strategyProb)}%</span>
            <span class="tag ${tagClass(analysis.confidence, getStrategy().confidence, 45)}">综合 ${Math.round(analysis.confidence)}%</span>
            <span class="tag ${tagClass(factorScore, 8, -6)}">因子 ${factorScore.toFixed(1)}</span>
            <span class="tag ${tagClass(technicals.rsi, 55, 35)}">RSI ${technicals.rsi.toFixed(1)}</span>
            <span class="tag ${tagClass(technicals.mainForceProxy, 58, 42)}">主力代理 ${technicals.mainForceProxy.toFixed(0)}</span>`;
      const subline = isError
        ? "配置真实行情源后再分析"
        : `5日 ${formatPct(technicals.change5d)} · 量比 ${technicals.volumeRatio.toFixed(2)}`;
      return `
        <article class="stock-card${selectedClass} ${isStrictBuyAction(analysis.action) ? "buy-alert" : isRiskAction(analysis.action) ? "risk-alert" : ""}" data-symbol="${symbol}" data-card-symbol="${symbol}">
          <div class="card-top">
            <div class="stock-title-block">
              <h3>${symbol}</h3>
              <small class="stock-name">${escapeHtml(displayName)}</small>
            </div>
            <div class="card-signal-stack">
              <div class="price">${isError ? "N/A" : formatMoney(technicals.close)}</div>
              <span class="card-state-chip ${cardTone}">${actionLabel(analysis.action)}</span>
              <div class="card-actions card-top-actions">
                <button class="secondary mini-btn" type="button" data-view="${symbol}">详情</button>
                <button class="danger-soft mini-btn" type="button" data-delete-symbol="${symbol}">删除</button>
              </div>
            </div>
          </div>
          ${isError ? "" : `
            <div class="card-snapshot-grid">
              <span><b>${formatPct(projectedFinalReturn(analysis))}</b><small>周期结束</small></span>
              <span><b>${Math.round(strategyProb)}%</b><small>策略达标</small></span>
              <span><b>${formatPct(maxMove)}</b><small>最高触达</small></span>
              <span><b>${formatPct(technicals.change5d)}</b><small>5日变化</small></span>
            </div>
          `}
          <div class="tag-row card-primary-tags">
            <span class="tag ${sourceClass}">${sourceLabel}</span>
            <span class="tag">${watchOriginLabel}</span>
            ${quoteLabel ? `<span class="tag good">${quoteLabel}</span>` : ""}
          </div>
          <div class="tag-row card-factor-tags">
            ${indicatorTags}
          </div>
          <div class="decision-row">
            <span class="muted">${subline}</span>
          </div>
        </article>
      `;
    } catch (error) {
      console.error(`Unable to render card for ${symbol}`, error);
      return `
        <article class="stock-card blocked" data-symbol="${symbol}" data-card-symbol="${symbol}">
          <div class="card-top">
            <div class="stock-title-block">
              <h3>${symbol}</h3>
              <small class="stock-name">卡片渲染失败</small>
            </div>
            <div class="card-actions card-top-actions">
              <button class="danger-soft mini-btn" type="button" data-delete-symbol="${symbol}">删除</button>
            </div>
          </div>
          <div class="decision-row"><span class="muted">${escapeHtml(compactRuntimeError(error))}</span></div>
        </article>
      `;
    }
  }).join("");
  cardsEl.innerHTML = cards;
  cardsEl.onclick = (event) => {
    const deleteButton = event.target.closest("[data-delete-symbol]");
    if (deleteButton) {
      deleteWatchSymbol(deleteButton.dataset.deleteSymbol);
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      selectWatchSymbol(viewButton.dataset.view);
      return;
    }
    const card = event.target.closest("[data-card-symbol]");
    if (card) selectWatchSymbol(card.dataset.cardSymbol);
  };
}

function renderPendingDetail(symbol) {
  const normalized = normalizeSymbolForMarket(symbol, state.market);
  const detailPanel = $("detailPanel");
  const source = $("analysisSource");
  const label = normalized || "未选择";
  if (source) source.textContent = normalized ? `分析：${label} 等待真实行情` : "分析：等待选择";
  if (!detailPanel) return;
  if (!normalized) {
    detailPanel.innerHTML = `<p class="muted">请选择或刷新一只股票查看详情。</p>`;
    return;
  }
  const meta = universeMetaForSymbol(normalized);
  const displayName = meta.name && meta.name !== normalized ? meta.name : activeMarketConfig().label;
  detailPanel.innerHTML = `
    <h3>${escapeHtml(normalized)} · 等待真实行情</h3>
    <p class="muted">${escapeHtml(displayName)} 尚未完成本市场真实行情分析。这里不会回退显示其他股票，避免把默认股票误认为当前选择。</p>
    <div class="tag-row detail-tags">
      <span class="tag warn">未刷新</span>
      <span class="tag">${escapeHtml(watchSourceLabel(watchlistOriginFor(normalized, state.market, "saved")))}</span>
      <span class="tag danger">无模拟数据</span>
    </div>
    <div class="decision-actions">
      <button id="refreshSelectedStock" type="button">刷新真实行情</button>
      <button id="deleteSelectedStock" class="danger-soft" type="button">删除这只股票</button>
    </div>
  `;
  $("refreshSelectedStock")?.addEventListener("click", refreshAll);
  $("deleteSelectedStock")?.addEventListener("click", () => deleteWatchSymbol(normalized));
}

function renderDetailUnsafe() {
  const selected = normalizeSymbolForMarket(state.selected, state.market);
  let item = selected ? state.analyses.get(selected) : null;
  if (!item && selected && state.watchlist.includes(selected)) {
    renderPendingDetail(selected);
    return;
  }
  item = item || [...state.analyses.values()][0];
  if (!item) {
    renderPendingDetail(selected);
    return;
  }
  const symbol = normalizeSymbolForMarket(item.symbol, state.market);
  state.selected = symbol;
  const technicals = normalizeTechnicals(item.technicals);
  const analysis = normalizeAnalysis(item.analysis);
  const news = Array.isArray(item.news) ? item.news : [];
  const newsEmptyText = item.signalRefreshedAt
    ? "当前真实新闻源本轮未返回新闻。"
    : "新闻后台读取中；完成后会自动写入。";
  const source = item.source || "unknown";
  const quoteText = item.quote?.source ? ` · 报价：${item.quote.source}${item.quote.delayed ? "（延迟）" : "（实时）"}` : "";
  $("analysisSource").textContent = `分析：${source} · 行情：${item.marketSource || "unknown"}${quoteText}`;
  if (analysis.action === "ERROR") {
    $("detailPanel").innerHTML = `
      <h3>${symbol} · ${errorLabel(item.errorKind)}</h3>
      <p class="tag danger">${item.marketWarning || analysis.thesis?.[0] || "缺少真实行情源。"}</p>
      <div class="decision-actions">
        <button id="deleteSelectedStock" class="danger-soft" type="button">删除这只股票</button>
      </div>
    `;
    $("deleteSelectedStock")?.addEventListener("click", () => deleteWatchSymbol(symbol));
    return;
  }
  const holding = findHolding(symbol);
  const suggestedQty = Math.max(1, Math.floor((analysis.suggestedTradeValue || 0) / Math.max(0.01, technicals.close)));
  const ensemble = analysis.ensemble || {};
  const ensembleModels = Array.isArray(ensemble.models) ? ensemble.models : [];
  const targetProb = strategyProbability(analysis);
  const targetProbRequired = strategyProbabilityTarget(analysis);
  const directionText = directionLabel(analysis);
  const directionProb = directionReliability(analysis);
  const magnitudeProb = magnitudeProbability(analysis);
  const finalProb = finalReturnProbability(analysis);
  const maxMove = projectedMaxUpside(analysis);
  const maxProb = maxUpsideProbability(analysis);
  const decision = decisionExplanation(item);
  const socialMedia = item.factors?.socialMedia || null;
  $("detailPanel").innerHTML = `
    <h3>${symbol} · ${actionLabel(analysis.action)}</h3>
    <p class="muted">周期 ${analysis.horizonDays || getStrategy().horizonDays} 日 · 结束预估 ${formatPct(projectedFinalReturn(analysis))}/${Math.round(finalProb)}% · 最高触达 ${formatPct(maxMove)}/${Math.round(maxProb)}% · 方向 ${directionText} ${Math.round(directionProb)}% · 策略达标 ${Math.round(targetProb)}% / ${Math.round(targetProbRequired)}% · 综合 ${Math.round(analysis.confidence)}%${analysis.rawConfidence !== analysis.confidence ? `（原始 ${Math.round(analysis.rawConfidence)}%）` : ""}</p>
    <div class="tag-row detail-tags">
      ${isBuyAction(analysis.action) ? `<span class="tag ${analysis.action === "LIGHT_BUY" ? "warn" : "good"}">${actionLabel(analysis.action)}，建议票额 ${formatMoney(analysis.suggestedTradeValue || 0)}</span>` : ""}
      ${["STRONG_AVOID", "CRITICAL_SELL"].includes(analysis.action) ? `<span class="tag danger">${actionLabel(analysis.action)}：下跌倾向 ${Math.round(analysis.downsideConfidence || 0)}%</span>` : ""}
      ${item.marketValidation ? `<span class="tag ${item.marketValidation.degraded ? "warn" : item.marketValidation.ok ? "good" : "danger"}">${item.marketValidation.degraded ? "单源真实数据" : "双源验证通过"}</span>` : ""}
      ${item.quote?.source ? `<span class="tag good">${item.quote.delayed ? "延迟最新价" : "实时最新价"}：${formatMoney(item.quote.price)}</span>` : ""}
      ${item.marketValidation?.degraded ? `<span class="tag warn">已扣减置信度</span>` : ""}
      ${analysis.calibration?.sampleCount >= 5 ? `<span class="tag ${analysis.calibration.adjustment >= 0 ? "good" : "warn"}">校准 ${analysis.calibration.adjustment >= 0 ? "+" : ""}${analysis.calibration.adjustment}%</span>` : `<span class="tag warn">校准样本收集中</span>`}
      ${analysis.strategyCalibration?.sampleCount >= 5 ? `<span class="tag ${analysis.strategyCalibration.adjustment >= 0 ? "good" : "warn"}">达标校准 ${analysis.strategyCalibration.adjustment >= 0 ? "+" : ""}${analysis.strategyCalibration.adjustment}%</span>` : `<span class="tag warn">达标校准收集中</span>`}
      ${analysis.factorSignal?.configApplied ? `<span class="tag good">研究因子配置已接入 · ${factorScoreForItem(item).toFixed(1)}</span>` : `<span class="tag warn">研究因子使用默认权重</span>`}
      ${socialMedia ? `<span class="tag ${redditSocialStatusClass(socialMedia)}">Reddit社媒 ${Number(socialMedia.score || 0).toFixed(1)} · ${socialMedia.available === false ? "不可用" : `置信 ${Math.round(Number(socialMedia.confidence || 0))}%`}</span>` : `<span class="tag warn">Reddit社媒待读取</span>`}
    </div>
    <div class="decision-actions">
      <button id="acceptDecision" type="button">接受并记录决策</button>
      <button id="deleteSelectedStock" class="danger-soft" type="button">删除这只股票</button>
    </div>
    <div class="decision-explain-card">
      <div class="decision-explain-head">
        <strong>为什么${isBuyAction(analysis.action) ? "买/关注" : "暂不买"}</strong>
        <span>买入分数 ${decision.buyScore.toFixed(1)} / 阈值 ${decision.threshold.toFixed(1)}</span>
      </div>
      <p>${escapeHtml(decision.summary)}</p>
      <div class="decision-check-grid">
        ${decision.checks.map((check) => `
          <div class="${check.pass ? "pass" : "block"}">
            <strong>${escapeHtml(check.label)}</strong>
            <span>${escapeHtml(check.note)}</span>
            <em>${check.pass ? "通过" : `差 ${Math.max(0, Number(check.required || 0) - Number(check.value || 0)).toFixed(check.key === "volume" ? 2 : 1)}`}</em>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="trade-ticket">
      <div>
        <strong>${holding ? "持仓调整" : "买入票据"}</strong>
        <p class="muted">${holding ? `当前持仓 ${holding.qty} 股，均价 ${formatMoney(holding.avgPrice)}，已持有 ${holdingDays(holding)} 天。` : "满足策略时可直接确认买入并写入持仓。"}</p>
      </div>
      <label>
        数量
        <input id="ticketQty" type="number" min="1" step="1" value="${suggestedQty}">
      </label>
      <label>
        均价
        <input id="ticketPrice" type="number" min="0" step="0.01" value="${technicals.close.toFixed(2)}">
      </label>
      <button id="confirmBuy" type="button">${holding ? "确认补仓" : "确认买入"}</button>
    </div>
    ${holding ? `
      <div class="trade-ticket reduce-ticket">
        <div>
          <strong>减仓/卖出</strong>
          <p class="muted">可只卖出部分仓位；剩余持仓均价保持原均价，已实现盈亏会写回资金基准。</p>
        </div>
        <label>
          卖出数量
          <input id="reduceQty" type="number" min="1" max="${holding.qty}" step="1" value="${Math.max(1, Math.floor(holding.qty * 0.5))}">
        </label>
        <label>
          成交价
          <input id="reducePrice" type="number" min="0" step="0.01" value="${technicals.close.toFixed(2)}">
        </label>
        <button id="confirmReduce" class="danger-soft" type="button">确认减仓</button>
      </div>
    ` : ""}
    ${chartDashboardHtml({ title: "K线" })}
    <div class="detail-grid">
      <div class="detail-item"><span>${item.quote?.source ? "最新价" : "收盘价"}</span><strong>${formatMoney(technicals.close)}</strong></div>
      <div class="detail-item"><span>MACD Histogram</span><strong>${technicals.macdHistogram.toFixed(4)}</strong></div>
      <div class="detail-item"><span>SMA20 / SMA50</span><strong>${technicals.sma20.toFixed(2)} / ${technicals.sma50.toFixed(2)}</strong></div>
      <div class="detail-item"><span>换手/成交强度代理</span><strong>${technicals.volumeRatio.toFixed(2)}x</strong></div>
      <div class="detail-item"><span>20日涨跌</span><strong>${formatPct(technicals.change20d)}</strong></div>
      <div class="detail-item"><span>主力仓位代理</span><strong>${technicals.mainForceProxy.toFixed(0)} / 100</strong></div>
      <div class="detail-item"><span>周期结束涨跌</span><strong>${formatPct(projectedFinalReturn(analysis))} · 置信 ${Math.round(finalProb)}%</strong></div>
      <div class="detail-item"><span>周期内最高触达</span><strong>${formatPct(maxMove)} · 置信 ${Math.round(maxProb)}%</strong></div>
      <div class="detail-item"><span>原幅度达成率</span><strong>${Math.round(magnitudeProb)}%${analysis.qualityGate?.magnitudeBasis ? ` · ${analysis.qualityGate.magnitudeBasis}` : ""}</strong></div>
      <div class="detail-item"><span>方向判断</span><strong>${directionText} · ${Math.round(directionProb)}%</strong></div>
      <div class="detail-item"><span>策略达标概率</span><strong>${Math.round(targetProb)}% / 目标 ${Math.round(targetProbRequired)}%</strong></div>
      <div class="detail-item"><span>市场环境</span><strong>${ensemble.marketRegime ? `${ensemble.marketRegime.regime || "range"} · ${ensemble.marketRegime.riskLevel || "neutral"} · 阈值+${Math.round(ensemble.marketRegime.buyThresholdBonus || 0)}%` : "等待因子"}</strong></div>
      <div class="detail-item"><span>历史策略命中</span><strong>${item.analog?.count ? `${asNumber(item.analog.targetHitRate ?? item.analog.winRate).toFixed(0)}% / 结束 ${formatPct(item.analog.averageFinalReturn ?? item.analog.averageForwardReturn)} / 最高 ${formatPct(item.analog.averageMaxUpside || 0)}${item.analog.stopRate != null ? ` · 先止损 ${asNumber(item.analog.stopRate).toFixed(0)}%` : ""}` : "样本不足"}</strong></div>
      <div class="detail-item"><span>方向/达标拆分</span><strong>${item.analog?.count ? `方向 ${asNumber(item.analog.directionalHitRate ?? item.analog.winRate).toFixed(0)}% · 达标 ${asNumber(item.analog.strategyHitProbability ?? item.analog.targetHitRate ?? 0).toFixed(0)}%` : "样本不足"}</strong></div>
      <div class="detail-item"><span>自监督预测</span><strong>${item.analog?.model?.sampleCount ? `结束 ${formatPct(item.analog.model.predictedReturn)} · 最高 ${formatPct(item.analog.model.predictedMaxUpside || 0)} · 目标达标 ${asNumber(item.analog.model.targetHitAccuracy ?? item.analog.model.directionalAccuracy).toFixed(0)}%` : "样本不足"}</strong></div>
      <div class="detail-item"><span>样本外/Meta</span><strong>${item.analog?.model?.oosSampleCount ? `方向 ${asNumber(item.analog.model.oosDirectionalAccuracy ?? item.analog.model.directionalAccuracy).toFixed(0)}% · 最高触达 ${asNumber(item.analog.model.oosMaxUpsideHitAccuracy ?? item.analog.model.maxUpsideHitAccuracy).toFixed(0)}% · P80 ${formatPct(item.analog.model.conformalP80Error)}` : "样本不足"}</strong></div>
      <div class="detail-item"><span>可用资金 / 建议票额</span><strong>${formatMoney(getCapital().availableCash)} / ${formatMoney(analysis.suggestedTradeValue || 0)}</strong></div>
      <div class="detail-item"><span>基本面</span><strong>${item.fundamentals ? `PE ${Number(item.fundamentals.peRatio || 0).toFixed(1)} · Yield ${formatPct(Number(item.fundamentals.dividendYield || 0) * 100)}` : "套餐未授权"}</strong></div>
      <div class="detail-item"><span>Reddit 社媒</span><strong>${socialMedia ? `${Number(socialMedia.score || 0).toFixed(1)} · 权重 ${Number(socialMedia.weight || 0).toFixed(2)} · Top ${redditSocialItems(socialMedia).length}` : "待读取"}</strong></div>
      <div class="detail-item"><span>X / YouTube 信号</span><strong>${item.xPosts?.length || 0} / ${item.youtubeItems?.length || 0}</strong></div>
    </div>
    ${redditSocialCardHtml(item)}
    <h4>多模型集成</h4>
    <div class="ensemble-summary">
      <span>方向 ${ensemble.direction || "n/a"}</span>
      <span>上涨一致度 ${Math.round(ensemble.upsideAgreement || 0)}%</span>
      <span>共识强度 ${Math.round(ensemble.consensusAgreement || 0)}%</span>
      <span>数据源扣分 ${Math.round(ensemble.dataPenalty || 0)}%</span>
      <span>证据奖励 ${Number(ensemble.evidenceBonus || 0).toFixed(1)} / 分歧扣分 ${Number(ensemble.disagreementPenalty || 0).toFixed(1)}</span>
      <span>策略达标 ${Math.round(targetProb)}% / 门槛 ${Math.round(targetProbRequired)}%</span>
      <span>动态调权 ${Math.round(ensemble.performanceWeightAdjusted || 0)} 个模型</span>
    </div>
    <div class="ensemble-grid">
      ${ensembleModels.length ? ensembleModels.map((model) => `
        <div class="ensemble-card ${model.available === false ? "muted-factor" : ""}">
          <div><strong>${model.name || "模型"}</strong><span class="${Number(model.projectedUpside || 0) >= 0 ? "good-text" : "danger-text"}">${formatPct(model.projectedUpside || 0)}</span></div>
          <p>置信 ${Math.round(model.confidence || 0)}% · 权重 ${Math.round((model.normalizedWeight || model.weight || 0) * 100)}%${model.values?.performanceWeightMultiplier ? ` · 表现权重 ${Math.round(model.values.performanceWeightMultiplier * 100)}%` : ""}${model.values?.regimeWeightMultiplier ? ` · 环境权重 ${Math.round(model.values.regimeWeightMultiplier * 100)}%` : ""}</p>
          <p>${model.reason || ""}</p>
        </div>
      `).join("") : `<p class="muted">集成模型正在等待分析结果。</p>`}
    </div>
    <h4>新增因子层</h4>
    <div class="factor-grid">
      ${factorRows(item.factors).length ? factorRows(item.factors).map(([label, factor]) => `
        <div class="factor-card ${factor.available === false ? "muted-factor" : ""}">
          <div><strong>${label}</strong><span class="${Number(factor.score || 0) >= 0 ? "good-text" : "danger-text"}">${Number(factor.score || 0).toFixed(1)}</span></div>
          <p>${(factor.thesis || ["暂无说明"])[0]}</p>
        </div>
      `).join("") : `<p class="muted">因子层在后台读取中；完成后会自动参与复核。</p>`}
    </div>
    <h4>历史相似走势</h4>
    <ul>${item.analog?.examples?.length ? item.analog.examples.map((example) => `<li>${example.date} 后 ${analysis.horizonDays || getStrategy().horizonDays} 日：结束 ${formatPct(example.forwardReturn)}，最高 ${formatPct(example.maxUpside || 0)}，最大回撤 ${formatPct(example.maxDrawdown || 0)}，相似距离 ${asNumber(example.distance).toFixed(2)}</li>`).join("") : "<li>历史样本不足，暂不纳入相似走势判断。</li>"}</ul>
    <h4>判断</h4>
    <ul>${(analysis.thesis || []).map((itemText) => `<li>${itemText}</li>`).join("")}</ul>
    <h4>风险</h4>
    <ul>${(analysis.risks || []).map((itemText) => `<li>${itemText}</li>`).join("")}</ul>
    <h4>新闻</h4>
    <ul>${(news || []).slice(0, 8).map((itemNews) => `<li><a href="${itemNews.link}" target="_blank" rel="noreferrer">${itemNews.title}</a> <span class="muted">${itemNews.publisher || itemNews.source || ""} · ${itemNews.categoryLabel || itemNews.category || itemNews.channel || "news"} · ${itemNews.channel || "news"} · 权重 ${asNumber(itemNews.impactWeight, 0.4).toFixed(2)}</span></li>`).join("") || `<li>${newsEmptyText}</li>`}</ul>
    <h4>X / 一手消息</h4>
    <ul>${(item.xPosts || []).slice(0, 5).map((post) => `<li>${post.text}</li>`).join("") || "<li>未配置 X_BEARER_TOKEN，暂不读取 X。</li>"}</ul>
    <h4>YouTube 热门/搜索</h4>
    <ul>${(item.youtubeItems || []).slice(0, 5).map((video) => `<li><a href="${video.link}" target="_blank" rel="noreferrer">${video.title}</a> <span class="muted">${video.publisher || ""} · ${video.channel || ""}</span></li>`).join("") || "<li>未配置 YOUTUBE_API_KEY，或 YouTube 当前未返回视频。</li>"}</ul>
  `;
  $("acceptDecision")?.addEventListener("click", () => saveDecision(item));
  $("deleteSelectedStock")?.addEventListener("click", () => deleteWatchSymbol(symbol));
  $("confirmBuy")?.addEventListener("click", () => buyFromSignal(item));
  $("confirmReduce")?.addEventListener("click", () => reduceFromSignal(item));
  $("expandChart")?.addEventListener("click", () => openChartModal(item));
  $("openRedditTop10")?.addEventListener("click", () => openRedditSocialModal(item));
  $("refreshRedditSocial")?.addEventListener("click", () => refreshRedditSocialForItem(item));
  $("clearRedditSocialCache")?.addEventListener("click", () => clearRedditSocialForItem(item));
  requestAnimationFrame(() => renderCharts(item, document));
}

function renderDetail() {
  try {
    return renderDetailUnsafe();
  } catch (error) {
    console.error("renderDetail failed", error);
    const symbol = normalizeSymbolForMarket(state.selected || state.watchlist?.[0] || "", state.market);
    if ($("analysisSource")) $("analysisSource").textContent = `分析：详情渲染失败 · ${activeMarketConfig().label}`;
    if ($("detailPanel")) {
      $("detailPanel").innerHTML = `
        <h3>${symbol || activeMarketConfig().label} · 详情渲染失败</h3>
        <p class="tag danger">${escapeHtml(compactRuntimeError(error))}</p>
        <p class="muted">行情、市场切换和刷新仍可继续使用。你可以刷新当前股票，或切换市场后重新加载详情。</p>
        <div class="decision-actions">
          <button id="retryRenderDetail" type="button">重试详情渲染</button>
          ${symbol ? `<button id="deleteSelectedStock" class="danger-soft" type="button">删除这只股票</button>` : ""}
        </div>
      `;
      $("retryRenderDetail")?.addEventListener("click", () => renderDetail());
      $("deleteSelectedStock")?.addEventListener("click", () => deleteWatchSymbol(symbol));
    }
    setStatus(`详情模块已降级：${compactRuntimeError(error)}；市场切换仍可用`);
    return null;
  }
}

function buyFromSignal(item) {
  const technicals = normalizeTechnicals(item.technicals);
  const qty = asNumber($("ticketQty")?.value, 0);
  const price = asNumber($("ticketPrice")?.value, technicals.close);
  if (qty <= 0 || price <= 0) {
    setStatus("请输入有效买入数量和均价");
    return;
  }
  applyHoldingBuy(item.symbol, qty, price, "app-buy");
  saveDecision(item);
  notifyUser(`${item.symbol} 已加入持仓`, `${MARKET_CONFIG[state.market].label} · ${qty} 股，均价 ${formatMoney(price)}。`, `buy-confirm:${Date.now()}:${state.market}:${item.symbol}`);
  setStatus(`${item.symbol} 已写入持仓：${qty} 股，均价 ${formatMoney(price)}`);
}

function recordTradeHistory(record) {
  state.history.unshift({
    id: `${Date.now()}-${record.market || state.market}-${record.symbol}-${record.action}`,
    time: new Date().toISOString(),
    market: state.market,
    confidence: 0,
    projectedUpside: 0,
    suggestedTradeValue: 0,
    ...record,
  });
  state.history = state.history.slice(0, 60);
  safeStorage.setItem("decisionHistory", JSON.stringify(state.history));
  renderHistory();
}

function reduceFromSignal(item) {
  const holding = findHolding(item.symbol);
  if (!holding) {
    setStatus(`${item.symbol} 当前没有可减仓持仓`);
    return;
  }
  const technicals = normalizeTechnicals(item.technicals);
  const qty = Math.min(holding.qty, Math.max(0, asNumber($("reduceQty")?.value, 0)));
  const price = asNumber($("reducePrice")?.value, technicals.close);
  if (qty <= 0 || price <= 0) {
    setStatus("请输入有效卖出数量和成交价");
    return;
  }
  const remainingQty = Number((holding.qty - qty).toFixed(6));
  const realizedPnl = (price - holding.avgPrice) * qty;
  applyHoldingSell(holding, qty, price, "reduce");
  notifyUser(`${holding.symbol} 已减仓`, `${MARKET_CONFIG[state.market].label} · ${qty} 股，成交价 ${formatMoney(price)}，实现盈亏 ${formatMoney(realizedPnl)}。`, `sell-confirm:${Date.now()}:${state.market}:${holding.symbol}`);
  setStatus(`${holding.symbol} 已减仓 ${qty} 股，实现盈亏 ${formatMoney(realizedPnl)}，剩余 ${Math.max(0, remainingQty)} 股`);
}

function openChartModal(item) {
  state.chartExpanded = true;
  const modal = document.createElement("div");
  modal.className = "chart-modal";
  const title = item.label ? `${item.label} · ${item.symbol}` : item.symbol;
  modal.innerHTML = `
    <div class="chart-modal-panel">
      <div class="chart-modal-head">
        <div>
          <h3>${title} 图表</h3>
          <p class="muted">K线 / 成交量 / MACD</p>
        </div>
        <button id="closeChartModal" class="secondary" type="button">关闭</button>
      </div>
      ${chartDashboardHtml({ expanded: true, showExpand: false, title: "K线" })}
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => {
    state.chartExpanded = false;
    state.chartHoverIndex = null;
    modal.remove();
    renderDetail();
  };
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("#closeChartModal").addEventListener("click", close);
  requestAnimationFrame(() => renderCharts(item, modal));
}

function chartBounds(values, padding = 0.06) {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const spread = max - min || Math.abs(max) || 1;
  return { min: min - spread * padding, max: max + spread * padding };
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssHeight = rect.height || Number(canvas.getAttribute("height")) || 120;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: cssHeight };
}

function safeSocialFactor(factor) {
  return factor && typeof factor === "object" ? factor : {};
}

function redditSocialItems(factor = {}) {
  const safeFactor = safeSocialFactor(factor);
  const rows = Array.isArray(safeFactor.items) && safeFactor.items.length ? safeFactor.items : safeFactor.topItems;
  return Array.isArray(rows) ? rows.slice(0, 10) : [];
}

function redditSocialStatusClass(factor = {}) {
  const safeFactor = safeSocialFactor(factor);
  if (!Object.keys(safeFactor).length || safeFactor.available === false) return "warn";
  if (Number(safeFactor.manipulationRisk || 0) >= 55) return "danger";
  if (Number(safeFactor.score || 0) >= 1) return "good";
  if (Number(safeFactor.score || 0) <= -1) return "danger";
  return "warn";
}

function redditSocialCacheText(factor = {}) {
  const safeFactor = safeSocialFactor(factor);
  const cachedAt = safeFactor.cache?.cachedAt || safeFactor.cachedAt || null;
  if (!cachedAt) return safeFactor.available === false ? "缓存为空" : "未写入缓存";
  const parsed = Date.parse(cachedAt);
  if (!Number.isFinite(parsed)) return cachedAt;
  return `${new Date(cachedAt).toLocaleString()} · ${formatAge(Date.now() - parsed)}`;
}

function redditSocialCardHtml(item = {}) {
  const factor = safeSocialFactor(item?.factors?.socialMedia);
  const statusClass = redditSocialStatusClass(factor);
  const items = redditSocialItems(factor);
  const thesis = factor?.thesis?.[0] || (factor?.available === false ? "Reddit 未配置、缓存为空或本轮无相关帖子。" : "Reddit 社媒因子等待后台读取。");
  return `
    <div class="social-factor-card ${statusClass}">
      <div class="social-factor-head">
        <div>
          <span>社媒因子 · Reddit</span>
          <strong>${factor ? Number(factor.score || 0).toFixed(1) : "0.0"}</strong>
        </div>
        <div class="social-factor-actions">
          <button id="openRedditTop10" class="secondary" type="button">查看 Reddit Top10</button>
          <button id="refreshRedditSocial" type="button">刷新 Reddit</button>
          <button id="clearRedditSocialCache" class="danger-soft" type="button">清空 Reddit 缓存</button>
        </div>
      </div>
      <div class="social-score-strip">
        <span>权重 ${Number(factor?.weight || 0).toFixed(2)}</span>
        <span>置信 ${Math.round(Number(factor?.confidence || 0))}%</span>
        <span>情绪 ${Number(factor?.sentiment || 0).toFixed(2)}</span>
        <span>真伪 ${Math.round(Number(factor?.truthScore || 0))}</span>
        <span>操纵风险 ${Math.round(Number(factor?.manipulationRisk || 0))}</span>
        <span>Top ${items.length}</span>
      </div>
      <p>${escapeHtml(thesis)}</p>
      <small>缓存：${escapeHtml(redditSocialCacheText(factor || {}))}</small>
    </div>
  `;
}

function redditTopItemHtml(item = {}, index = 0) {
  const title = escapeHtml(item.title || item.text || "Untitled Reddit post");
  const subreddit = escapeHtml(item.subreddit ? `r/${item.subreddit}` : "reddit");
  const link = item.permalink || item.url || "";
  const relation = escapeHtml(item.relation || item.channel || "social");
  const meta = [
    subreddit,
    item.createdAt ? new Date(item.createdAt).toLocaleString() : "",
    `score ${Math.round(Number(item.score || 0))}`,
    `comments ${Math.round(Number(item.num_comments || 0))}`,
    relation,
  ].filter(Boolean).join(" · ");
  return `
    <div class="reddit-social-row">
      <div class="reddit-social-rank">${index + 1}</div>
      <div>
        <strong>${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${title}</a>` : title}</strong>
        <p class="reddit-social-meta">${escapeHtml(meta)}</p>
        <div class="social-score-strip compact">
          <span>相关 ${Math.round(Number(item.relevance ?? item.relevanceScore ?? 0))}</span>
          <span>影响 ${Math.round(Number(item.impactScore || 0))}</span>
          <span>真伪 ${Math.round(Number(item.truthScore || 0))}</span>
          <span>操纵 ${Math.round(Number(item.manipulationRisk || 0))}</span>
          <span>情绪 ${Number(item.sentiment || 0).toFixed(2)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderRedditSocialModalBody(modal, item = {}, message = "") {
  const body = modal.querySelector("[data-reddit-social-body]");
  if (!body) return;
  const factor = safeSocialFactor(item?.factors?.socialMedia);
  const items = redditSocialItems(factor);
  body.innerHTML = `
    ${message ? `<p class="muted">${escapeHtml(message)}</p>` : ""}
    <div class="social-factor-card ${redditSocialStatusClass(factor)}">
      <div class="social-score-strip">
        <span>分数 ${Number(factor.score || 0).toFixed(1)}</span>
        <span>权重 ${Number(factor.weight || 0).toFixed(2)}</span>
        <span>置信 ${Math.round(Number(factor.confidence || 0))}%</span>
        <span>真伪 ${Math.round(Number(factor.truthScore || 0))}</span>
        <span>操纵风险 ${Math.round(Number(factor.manipulationRisk || 0))}</span>
      </div>
      <p>${escapeHtml(factor.thesis?.[0] || "Reddit 当前没有足够相关的社媒证据。")}</p>
      <small>缓存：${escapeHtml(redditSocialCacheText(factor))}</small>
    </div>
    <div class="reddit-social-list">
      ${items.length ? items.map(redditTopItemHtml).join("") : `<p class="muted">暂无可展示的 Reddit Top10。未配置、缓存为空或当前股票在 Reddit 覆盖较弱时会出现这种状态。</p>`}
    </div>
  `;
}

function replaceItemSocialFactor(symbol, factor) {
  const normalized = normalizeSymbolForMarket(symbol, state.market);
  const current = state.analyses.get(normalized);
  if (!current) return null;
  const next = {
    ...current,
    factors: {
      ...(current.factors || {}),
      socialMedia: factor,
    },
  };
  state.analyses.set(normalized, next);
  return next;
}

async function refreshRedditSocialForItem(item, modal = null) {
  const symbol = normalizeSymbolForMarket(item.symbol, state.market);
  const button = modal?.querySelector("[data-refresh-reddit-social]") || $("refreshRedditSocial");
  try {
    if (button) button.disabled = true;
    setStatus(`正在把 ${symbol} 加入 Reddit 后台社媒缓存队列...`);
    if (modal) renderRedditSocialModalBody(modal, item, "已将当前股票加入 Reddit 后台刷新队列；当前窗口先显示本地缓存。");
    const params = new URLSearchParams({
      market: state.market,
      symbols: symbol,
      limit: "10",
      maxSymbols: "1",
      force: "true",
      reason: "manual-symbol-refresh",
    });
    await requestJson(`/api/social/reddit/background?${params.toString()}`);
    const factor = await requestJson(`/api/social/reddit?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}&mode=local&limit=10`);
    const next = replaceItemSocialFactor(symbol, factor) || item;
    persistAnalysisSnapshot("reddit-social-refresh");
    renderCards();
    renderDetail();
    if (modal) renderRedditSocialModalBody(modal, next, "Reddit 后台刷新已排队；这里显示的是当前本地缓存，后台完成后下一次打开/刷新会自动读取新缓存。");
    setStatus(`${symbol} Reddit 后台缓存已排队；当前本地缓存 Top ${redditSocialItems(factor).length}`);
  } catch (error) {
    if (modal) renderRedditSocialModalBody(modal, item, `Reddit 后台排队失败：${compactDisplayError(error.message)}`);
    setStatus(`Reddit 后台排队失败：${compactDisplayError(error.message)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function clearRedditSocialForItem(item, modal = null) {
  const symbol = normalizeSymbolForMarket(item.symbol, state.market);
  const button = modal?.querySelector("[data-clear-reddit-social]") || $("clearRedditSocialCache");
  try {
    if (button) button.disabled = true;
    await requestJson(`/api/social/reddit/cache?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    const emptyFactor = {
      available: false,
      source: "reddit-social-cache-cleared",
      score: 0,
      weight: 0,
      confidence: 0,
      sentiment: 0,
      manipulationRisk: 0,
      truthScore: 0,
      items: [],
      topItems: [],
      thesis: ["Reddit social cache cleared for this symbol."],
      cache: { cache: "cleared", cachedAt: null },
    };
    const next = replaceItemSocialFactor(symbol, emptyFactor) || item;
    persistAnalysisSnapshot("reddit-social-cache-clear");
    renderCards();
    renderDetail();
    if (modal) renderRedditSocialModalBody(modal, next, "该股票 Reddit 缓存已清空。");
    setStatus(`${symbol} Reddit 缓存已清空；下次刷新会重新请求 Reddit。`);
  } catch (error) {
    if (modal) renderRedditSocialModalBody(modal, item, `清空 Reddit 缓存失败：${compactDisplayError(error.message)}`);
    setStatus(`清空 Reddit 缓存失败：${compactDisplayError(error.message)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function openRedditSocialModal(item) {
  const symbol = normalizeSymbolForMarket(item.symbol, state.market);
  const fresh = state.analyses.get(symbol) || item;
  const modal = document.createElement("div");
  modal.className = "chart-modal reddit-social-modal";
  modal.innerHTML = `
    <div class="chart-modal-panel reddit-social-panel">
      <div class="chart-modal-head">
        <div>
          <h3>${escapeHtml(symbol)} Reddit Top10</h3>
          <p class="muted">按相关度、影响力、有效性、真伪风险和产业传导综合排序。</p>
        </div>
        <div class="modal-action-row">
          <button class="secondary" type="button" data-refresh-reddit-social>刷新 Reddit</button>
          <button class="danger-soft" type="button" data-clear-reddit-social>清空缓存</button>
          <button class="secondary" type="button" data-close-reddit-social>关闭</button>
        </div>
      </div>
      <div data-reddit-social-body></div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("[data-close-reddit-social]")?.addEventListener("click", close);
  modal.querySelector("[data-refresh-reddit-social]")?.addEventListener("click", () => refreshRedditSocialForItem(state.analyses.get(symbol) || fresh, modal));
  modal.querySelector("[data-clear-reddit-social]")?.addEventListener("click", () => clearRedditSocialForItem(state.analyses.get(symbol) || fresh, modal));
  renderRedditSocialModalBody(modal, fresh);
}

function drawGrid(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#050b13";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(104, 142, 170, 0.14)";
  ctx.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const y = (height / 4) * index;
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(width - 14, y);
    ctx.stroke();
  }
  for (let index = 1; index < 7; index += 1) {
    const x = 48 + ((width - 62) / 7) * index;
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, height - 20);
    ctx.stroke();
  }
}

function drawLine(ctx, values, min, max, width, height, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width;
    const y = height - ((value - min) / (max - min || 1)) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function rangeCount(range) {
  return { "5D": 5, "1M": 24, "3M": 66, "6M": 132, "9M": 220, ALL: 100000 }[range] || 132;
}

function xFor(index, count, width, left = 48, right = 14) {
  return left + (count <= 1 ? 0 : (index / (count - 1)) * (width - left - right));
}

function yFor(value, min, max, height, top = 12, bottom = 20) {
  return top + (1 - (value - min) / (max - min || 1)) * (height - top - bottom);
}

function drawAxis(ctx, bounds, width, height, formatter = (value) => value.toFixed(2)) {
  ctx.fillStyle = "#8ea3ba";
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  [bounds.max, (bounds.max + bounds.min) / 2, bounds.min].forEach((value) => {
    const y = yFor(value, bounds.min, bounds.max, height);
    ctx.textAlign = "left";
    ctx.fillText(formatter(value), 4, y);
    ctx.textAlign = "right";
    ctx.fillText(formatter(value), width - 4, y);
  });
}

function drawTimeAxis(ctx, candles, width, height) {
  const rows = Array.isArray(candles) ? candles : [];
  if (!rows.length) return;
  const indexes = [...new Set([0, Math.floor(rows.length * 0.25), Math.floor(rows.length * 0.5), Math.floor(rows.length * 0.75), rows.length - 1])]
    .filter((index) => index >= 0 && index < rows.length);
  ctx.save();
  ctx.fillStyle = "rgba(141, 164, 186, 0.82)";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  indexes.forEach((index) => {
    const row = rows[index];
    const x = xFor(index, rows.length, width);
    const label = String(row?.date || "").replace(/^(\d{4})-(\d{2})-(\d{2}).*/, "$2-$3");
    ctx.fillText(label, x, height - 2);
  });
  ctx.restore();
}

function drawLastPriceMarker(ctx, value, bounds, width, height, color) {
  if (!Number.isFinite(Number(value))) return;
  const y = yFor(Number(value), bounds.min, bounds.max, height);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(48, y);
  ctx.lineTo(width - 68, y);
  ctx.stroke();
  ctx.setLineDash([]);
  const label = formatCompactNumber(value, 3);
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const labelWidth = Math.max(54, ctx.measureText(label).width + 12);
  ctx.fillStyle = color;
  ctx.fillRect(width - labelWidth - 4, y - 11, labelWidth, 22);
  ctx.fillStyle = "#03131f";
  ctx.fillText(label, width - 10, y);
  ctx.restore();
}

function drawLoading(canvas, message) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#8ea3ba";
  ctx.font = "13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, width / 2, height / 2);
}

function overlayEnabled(name) {
  return state.chartOverlays?.[name] !== false;
}

function saveChartView() {
  safeStorage.setItem("chartRange", state.chartRange);
  safeStorage.setItem("chartInterval", state.chartInterval || "1d");
  safeStorage.setItem("chartZoom", String(state.chartZoom || 1));
  safeStorage.setItem("chartOverlays", JSON.stringify(state.chartOverlays || {}));
  safeStorage.setItem("chartFactorKeys", JSON.stringify(selectedChartFactorKeys()));
}

function chartIntervalButtons() {
  const rows = [
    ["5m", "5m"],
    ["15m", "15m"],
    ["60m", "60m"],
    ["1d", "日线"],
    ["1wk", "周线"],
    ["1mo", "月线"],
  ];
  return rows.map(([key, label]) => `<button class="range-btn ${state.chartInterval === key ? "active" : ""}" data-interval="${key}" type="button">${label}</button>`).join("");
}

function chartRangeButtons() {
  return ["5D", "1M", "3M", "6M", "9M", "ALL"]
    .map((range) => `<button class="range-btn ${state.chartRange === range ? "active" : ""}" data-range="${range}" type="button">${range}</button>`)
    .join("");
}

function chartDashboardHtml({ expanded = false, showExpand = true, title = "K线" } = {}) {
  return `
    <div class="chart-dashboard ${expanded ? "expanded" : "compact"}" id="chartDashboard">
      <div class="chart-toolbar">
        <div class="chart-tabs">
          ${chartIntervalButtons()}
          ${chartRangeButtons()}
        </div>
        <div class="chart-tools">
          <div id="chartReadout" class="chart-readout muted">${escapeHtml(chartFallbackReadout())}</div>
          <button class="secondary mini-btn" data-chart-reset type="button">重置</button>
          ${showExpand ? `<button id="expandChart" class="secondary" type="button">放大</button>` : ""}
        </div>
      </div>
      <div class="chart-legend"><span class="legend green">${escapeHtml(title)}</span>${chartOverlayButtons()}</div>
      <div class="chart-factor-strip"><span>因子叠合</span>${chartFactorButtons()}</div>
      ${expanded ? `<div class="chart-scroll">` : ""}
        <div class="chart-layer">
          <canvas id="priceChart" height="${expanded ? 340 : 300}"></canvas>
          <canvas id="factorChart" height="${expanded ? 138 : 118}"></canvas>
          <canvas id="volumeChart" height="${expanded ? 90 : 105}"></canvas>
          <canvas id="macdChart" height="${expanded ? 120 : 135}"></canvas>
        </div>
      ${expanded ? `</div>` : ""}
    </div>
  `;
}

function chartOverlayButtons() {
  const rows = [
    ["sma20", "SMA20"],
    ["sma50", "SMA50"],
    ["vwap", "VWAP"],
    ["bollinger", "BOLL"],
    ["fib", "Fib"],
    ["fvg", "FVG"],
    ["volume", "Volume"],
    ["profile", "Profile"],
    ["orderflow", "Footprint"],
    ["factorPrediction", "因子/预测"],
    ["macd", "MACD"],
    ["anomalies", "异常段"],
  ];
  return rows.map(([key, label]) => `<button class="overlay-btn ${overlayEnabled(key) ? "active" : ""}" data-overlay="${key}" type="button">${label}</button>`).join("");
}

function bindChartDashboardControls(item, root = document) {
  const dashboard = root.querySelector("#chartDashboard");
  if (!dashboard || dashboard.dataset.controlsBound === "true") return;
  dashboard.dataset.controlsBound = "true";
  dashboard.querySelectorAll("[data-overlay]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.overlay;
      state.chartOverlays[key] = !overlayEnabled(key);
      saveChartView();
      syncChartOverlayButtons(dashboard);
      renderCharts(item, root);
    });
  });
  dashboard.querySelectorAll("[data-chart-factor]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.chartFactor;
      const selected = new Set(selectedChartFactorKeys());
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      state.chartFactorKeys = [...selected];
      if (!state.chartFactorKeys.length) state.chartFactorKeys = ["momentum"];
      saveChartView();
      renderCharts(item, root);
    });
  });
  dashboard.querySelector("[data-chart-reset]")?.addEventListener("click", () => {
    state.chartZoom = 1;
    state.chartOffset = 0;
    state.chartHoverIndex = null;
    saveChartView();
    renderCharts(item, root);
  });
  dashboard.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartRange = button.dataset.range;
      state.chartHoverIndex = null;
      state.chartOffset = 0;
      state.chartZoom = 1;
      saveChartView();
      if (state.chartExpanded) renderCharts(item, root);
      else renderDetail();
    });
  });
  dashboard.querySelectorAll("[data-interval]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartInterval = button.dataset.interval || "1d";
      state.chartHoverIndex = null;
      state.chartOffset = 0;
      state.chartZoom = 1;
      saveChartView();
      if (state.chartExpanded) renderCharts(item, root);
      else renderDetail();
    });
  });
}

const CHART_FACTOR_LIBRARY = [
  ["momentum", "动量"],
  ["volume", "量能"],
  ["vwap", "VWAP偏离"],
  ["macd", "MACD"],
  ["bollinger", "BOLL位置"],
  ["orderflow", "主动买卖"],
  ["candle", "K线结构"],
  ["configured", "研究因子"],
];

function selectedChartFactorKeys() {
  const allowed = new Set(CHART_FACTOR_LIBRARY.map(([key]) => key));
  const selected = Array.isArray(state.chartFactorKeys) ? state.chartFactorKeys.filter((key) => allowed.has(key)) : [];
  return selected.length ? selected : ["momentum", "volume", "vwap", "macd"];
}

function chartFactorButtons() {
  const selected = new Set(selectedChartFactorKeys());
  return CHART_FACTOR_LIBRARY.map(([key, label]) => `
    <button class="factor-chip ${selected.has(key) ? "active" : ""}" data-chart-factor="${key}" type="button">${label}</button>
  `).join("");
}

function visibleChartCandles(sourceCandles) {
  const source = Array.isArray(sourceCandles) ? sourceCandles : [];
  const baseCount = Math.min(source.length, rangeCount(state.chartRange));
  const baseStart = Math.max(0, source.length - baseCount);
  const maxZoom = Math.max(1, baseCount / 18);
  const zoom = clamp(Number(state.chartZoom || 1), 1, maxZoom);
  state.chartZoom = zoom;
  const visibleCount = Math.max(8, Math.min(baseCount, Math.round(baseCount / zoom)));
  const maxOffset = Math.max(0, baseCount - visibleCount);
  state.chartOffset = clamp(Math.round(Number(state.chartOffset || 0)), 0, maxOffset);
  const end = source.length - state.chartOffset;
  const start = Math.max(baseStart, end - visibleCount);
  return {
    candles: source.slice(start, end),
    start,
    end,
    baseCount,
    visibleCount,
    maxOffset,
    zoom,
  };
}

function cumulativeVwapSeries(candles) {
  let notional = 0;
  let volume = 0;
  return candles.map((row) => {
    const typical = ((row.high || row.close || 0) + (row.low || row.close || 0) + (row.close || 0)) / 3;
    const rowVolume = Number(row.volume || 0);
    notional += typical * rowVolume;
    volume += rowVolume;
    return volume ? notional / volume : typical;
  });
}

function chartAnomalyIndexes(candles) {
  const returns = candles.map((row, index) => index ? ((row.close / Math.max(0.0001, candles[index - 1].close)) - 1) * 100 : 0);
  const volumes = candles.map((row) => Number(row.volume || 0));
  const avgVolume = volumes.reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.length);
  const variance = returns.reduce((sum, value) => sum + value * value, 0) / Math.max(1, returns.length);
  const returnThreshold = Math.max(1.2, Math.sqrt(variance) * 1.35);
  const volumeThreshold = Math.max(avgVolume * 1.8, avgVolume + Math.sqrt(volumes.reduce((sum, value) => sum + (value - avgVolume) ** 2, 0) / Math.max(1, volumes.length)) * 1.1);
  return candles.map((row, index) => ({
    index,
    type: returns[index] >= returnThreshold && row.volume >= volumeThreshold * 0.75
      ? "up"
      : returns[index] <= -returnThreshold && row.volume >= volumeThreshold * 0.75
        ? "down"
        : row.volume >= volumeThreshold
          ? "volume"
          : "",
  })).filter((row) => row.type);
}

function bollingerChartSeries(candles, period = 20, multiplier = 2) {
  const closes = candles.map((row) => Number(row.close || 0));
  const middle = sma(closes, period);
  const upper = [];
  const lower = [];
  closes.forEach((close, index) => {
    const start = Math.max(0, index - period + 1);
    const slice = closes.slice(start, index + 1);
    const avg = middle[index] || close;
    const variance = slice.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, slice.length);
    const sigma = Math.sqrt(variance);
    upper.push(avg + multiplier * sigma);
    lower.push(avg - multiplier * sigma);
  });
  return { middle, upper, lower };
}

function fibonacciChartLevels(candles, lookback = 60) {
  const rows = candles.slice(-lookback);
  if (!rows.length) return [];
  let highIndex = 0;
  let lowIndex = 0;
  rows.forEach((row, index) => {
    if (row.high > rows[highIndex].high) highIndex = index;
    if (row.low < rows[lowIndex].low) lowIndex = index;
  });
  const high = rows[highIndex].high;
  const low = rows[lowIndex].low;
  const span = Math.max(high - low, high * 0.0001);
  const upswing = lowIndex < highIndex;
  return [0.236, 0.382, 0.5, 0.618, 0.786].map((ratio) => ({
    ratio,
    label: `${(ratio * 100).toFixed(1)}%`,
    price: upswing ? high - span * ratio : low + span * ratio,
    direction: upswing ? "upswing" : "downswing",
  }));
}

function fvgChartZones(candles, lookback = 90) {
  const start = Math.max(2, candles.length - lookback);
  const zones = [];
  for (let index = start; index < candles.length; index += 1) {
    const left = candles[index - 2];
    const current = candles[index];
    if (current.low > left.high) {
      let endIndex = candles.length - 1;
      let filled = false;
      for (let next = index + 1; next < candles.length; next += 1) {
        if (candles[next].low <= left.high) {
          endIndex = next;
          filled = true;
          break;
        }
      }
      zones.push({ type: "bullish", startIndex: index - 2, endIndex, low: left.high, high: current.low, filled });
    }
    if (current.high < left.low) {
      let endIndex = candles.length - 1;
      let filled = false;
      for (let next = index + 1; next < candles.length; next += 1) {
        if (candles[next].high >= left.low) {
          endIndex = next;
          filled = true;
          break;
        }
      }
      zones.push({ type: "bearish", startIndex: index - 2, endIndex, low: current.high, high: left.low, filled });
    }
  }
  return zones.slice(-24);
}

function visibleVolumeProfile(candles, bucketCount = 28) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return { buckets: [], poc: null, valueArea: null, maxVolume: 0 };
  const lows = rows.map((row) => Number(row.low || row.close)).filter(Number.isFinite);
  const highs = rows.map((row) => Number(row.high || row.close)).filter(Number.isFinite);
  const low = Math.min(...lows);
  const high = Math.max(...highs);
  const span = Math.max(high - low, Math.abs(high) * 0.0001, 0.0001);
  const count = Math.max(8, Math.min(48, bucketCount));
  const buckets = Array.from({ length: count }, (_, index) => ({
    low: low + (span / count) * index,
    high: low + (span / count) * (index + 1),
    mid: low + (span / count) * (index + 0.5),
    volume: 0,
  }));
  rows.forEach((row) => {
    const typical = Number(((row.high || row.close) + (row.low || row.close) + row.close) / 3);
    const volume = Number(row.volume || 0);
    if (!Number.isFinite(typical) || !Number.isFinite(volume) || volume <= 0) return;
    const index = clamp(Math.floor(((typical - low) / span) * count), 0, count - 1);
    buckets[index].volume += volume;
  });
  const totalVolume = buckets.reduce((sum, row) => sum + row.volume, 0);
  const maxVolume = Math.max(1, ...buckets.map((row) => row.volume));
  const poc = buckets.reduce((best, row) => row.volume > best.volume ? row : best, buckets[0]);
  const ranked = buckets
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => b.volume - a.volume);
  let includedVolume = 0;
  const valueIndexes = new Set();
  for (const row of ranked) {
    if (includedVolume >= totalVolume * 0.7) break;
    includedVolume += row.volume;
    valueIndexes.add(row.index);
  }
  const selected = buckets.filter((_, index) => valueIndexes.has(index));
  const valueArea = selected.length
    ? {
      low: Math.min(...selected.map((row) => row.low)),
      high: Math.max(...selected.map((row) => row.high)),
      volumeShare: totalVolume ? includedVolume / totalVolume : 0,
    }
    : null;
  return {
    buckets: buckets.map((row) => ({ ...row, share: totalVolume ? row.volume / totalVolume : 0 })),
    poc,
    valueArea,
    maxVolume,
    totalVolume,
  };
}

function orderflowRows(candles) {
  return (Array.isArray(candles) ? candles : []).map((row) => {
    const volume = Math.max(0, Number(row.volume || 0));
    const realBuy = Number(row.buyVolume);
    const realSell = Number(row.sellVolume);
    const hasRealVolume = Number.isFinite(realBuy) && Number.isFinite(realSell) && realBuy + realSell > 0;
    const range = Math.max(0.000001, Number(row.high || row.close) - Number(row.low || row.close));
    const closeLocation = clamp((Number(row.close || 0) - Number(row.low || row.close)) / range, 0.05, 0.95);
    const bodyBias = row.close >= row.open ? 0.58 : 0.42;
    const proxyBuyRatio = clamp(closeLocation * 0.56 + bodyBias * 0.44, 0.08, 0.92);
    const buyVolume = hasRealVolume ? realBuy : volume * proxyBuyRatio;
    const sellVolume = hasRealVolume ? realSell : Math.max(0, volume - buyVolume);
    const realBuyTrades = Number(row.buyTrades);
    const realSellTrades = Number(row.sellTrades);
    const tradeCount = Number(row.tradeCount);
    const hasRealTrades = Number.isFinite(realBuyTrades) && Number.isFinite(realSellTrades) && realBuyTrades + realSellTrades > 0;
    const proxyTrades = Number.isFinite(tradeCount) && tradeCount > 0
      ? tradeCount
      : Math.max(1, Math.round(volume / Math.max(1, state.market === "CN" ? 100 : 1000)));
    const buyTrades = hasRealTrades ? realBuyTrades : proxyTrades * (buyVolume / Math.max(1, buyVolume + sellVolume));
    const sellTrades = hasRealTrades ? realSellTrades : proxyTrades - buyTrades;
    return {
      buyVolume,
      sellVolume,
      buyTrades,
      sellTrades,
      delta: buyVolume - sellVolume,
      hasRealVolume,
      hasRealTrades,
      hasReportedLevels: Array.isArray(row.priceLevels) && row.priceLevels.length > 0,
      source: hasRealVolume || hasRealTrades ? (row.orderflowSource || "reported-trades") : "ohlcv-proxy",
      proxy: !(hasRealVolume || hasRealTrades),
    };
  });
}

function priceLevelFlowRows(candle, flow, levelCount = 7, options = {}) {
  const allowProxy = options.allowProxy !== false;
  const reportedLevels = Array.isArray(candle?.priceLevels) ? candle.priceLevels : [];
  const normalizedReported = reportedLevels.map((level) => {
    const price = asNumber(level.price ?? level.level ?? level.mid, NaN);
    if (!Number.isFinite(price)) return null;
    return {
      price,
      buyVolume: Math.max(0, asNumber(level.buyVolume ?? level.activeBuyVolume ?? level.bidVolume, 0)),
      sellVolume: Math.max(0, asNumber(level.sellVolume ?? level.activeSellVolume ?? level.askVolume, 0)),
      buyTrades: Math.max(0, asNumber(level.buyTrades ?? level.buyCount ?? level.bidTrades, 0)),
      sellTrades: Math.max(0, asNumber(level.sellTrades ?? level.sellCount ?? level.askTrades, 0)),
      source: level.source || candle.orderflowSource || "reported-price-levels",
      proxy: false,
    };
  }).filter(Boolean);
  if (normalizedReported.length) {
    return normalizedReported.sort((a, b) => b.price - a.price);
  }
  if (!allowProxy) return [];

  const low = Number(candle.low || candle.close || 0);
  const high = Number(candle.high || candle.close || low);
  const span = Math.max(0.000001, high - low);
  const count = Math.max(4, Math.min(11, levelCount));
  const pathBias = candle.close >= candle.open ? 0.58 : 0.42;
  const closeLocation = clamp((candle.close - low) / span, 0.05, 0.95);
  const openLocation = clamp((candle.open - low) / span, 0.05, 0.95);
  const totalBuy = Math.max(0, Number(flow?.buyVolume || 0));
  const totalSell = Math.max(0, Number(flow?.sellVolume || 0));
  const totalBuyTrades = Math.max(0, Number(flow?.buyTrades || 0));
  const totalSellTrades = Math.max(0, Number(flow?.sellTrades || 0));
  const rows = Array.from({ length: count }, (_, index) => {
    const pct = count === 1 ? 0.5 : index / (count - 1);
    const price = high - span * pct;
    const lowToHighPct = 1 - pct;
    const buyWeight = 0.26 + Math.exp(-Math.abs(lowToHighPct - closeLocation) * 3.2) + pathBias * (lowToHighPct >= openLocation ? 0.42 : 0.16);
    const sellWeight = 0.26 + Math.exp(-Math.abs(lowToHighPct - openLocation) * 3.2) + (1 - pathBias) * (lowToHighPct <= openLocation ? 0.42 : 0.16);
    return { price, buyWeight, sellWeight };
  });
  const buyWeightSum = rows.reduce((sum, row) => sum + row.buyWeight, 0) || 1;
  const sellWeightSum = rows.reduce((sum, row) => sum + row.sellWeight, 0) || 1;
  return rows.map((row) => ({
    price: row.price,
    buyVolume: totalBuy * row.buyWeight / buyWeightSum,
    sellVolume: totalSell * row.sellWeight / sellWeightSum,
    buyTrades: totalBuyTrades * row.buyWeight / buyWeightSum,
    sellTrades: totalSellTrades * row.sellWeight / sellWeightSum,
    source: "ohlcv-price-ladder-proxy",
    proxy: true,
  }));
}

function drawOrderflowLadder(ctx, candles, flows, bounds, width, height, candleWidth) {
  if (!candles.length || !flows.length) return;
  const ladders = candles.map((row, index) => priceLevelFlowRows(row, flows[index], 7, { allowProxy: false }));
  const hasReportedPriceLevels = ladders.some((rows) => rows.some((row) => !row.proxy));
  if (!hasReportedPriceLevels) {
    const hasRealSideTotals = flows.some((row) => !row.proxy && (row.hasRealVolume || row.hasRealTrades));
    if (hasRealSideTotals) {
      drawOrderflowMarkers(ctx, candles, flows.filter(Boolean), bounds, width, height, candleWidth);
      ctx.save();
      ctx.fillStyle = "rgba(246, 196, 83, 0.9)";
      ctx.font = "10px Inter, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Reported buy/sell totals; no real price-level ladder", 52, 34);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.fillStyle = "rgba(246, 196, 83, 0.9)";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Footprint requires real tick/L1/L2 price-level rows; OHLCV is not promoted to orderflow", 52, 34);
    ctx.restore();
    return;
  }
  const maxLevelVolume = Math.max(1, ...ladders.flatMap((rows) => rows.flatMap((row) => [row.buyVolume, row.sellVolume])));
  const maxTrades = Math.max(1, ...ladders.flatMap((rows) => rows.flatMap((row) => [row.buyTrades, row.sellTrades])));
  ctx.save();
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(207, 255, 226, 0.86)";
  ctx.fillText("Real Tick Footprint · price-level volume + tick-rule side", 52, 34);
  ladders.forEach((levels, index) => {
    const x = xFor(index, candles.length, width);
    const maxHalfWidth = Math.max(5, Math.min(26, candleWidth * 2.2));
    levels.forEach((level) => {
      const y = yFor(level.price, bounds.min, bounds.max, height);
      const buyWidth = Math.max(1, (level.buyVolume / maxLevelVolume) * maxHalfWidth);
      const sellWidth = Math.max(1, (level.sellVolume / maxLevelVolume) * maxHalfWidth);
      const dotScale = Math.max(1.4, Math.min(4.4, Math.sqrt((level.buyTrades + level.sellTrades) / maxTrades) * 4.4));
      ctx.fillStyle = "rgba(67, 224, 138, 0.7)";
      ctx.fillRect(x - buyWidth - 1, y - 1.4, buyWidth, 2.8);
      ctx.fillStyle = "rgba(255, 101, 125, 0.72)";
      ctx.fillRect(x + 1, y - 1.4, sellWidth, 2.8);
      ctx.fillStyle = level.buyVolume >= level.sellVolume ? "rgba(67, 224, 138, 0.9)" : "rgba(255, 101, 125, 0.9)";
      ctx.beginPath();
      ctx.arc(x, y, dotScale, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  ctx.restore();
}

function drawOrderflowMarkers(ctx, candles, flows, bounds, width, height, candleWidth) {
  if (!candles.length || !flows.length) return;
  const maxSideVolume = Math.max(1, ...flows.flatMap((row) => [row.buyVolume, row.sellVolume]));
  const maxMarker = Math.max(3, Math.min(14, candleWidth * 0.72));
  ctx.save();
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = flows.some((row) => !row.proxy) ? "rgba(207, 255, 226, 0.82)" : "rgba(246, 196, 83, 0.84)";
  ctx.fillText(flows.some((row) => !row.proxy) ? "OrderFlow reported" : "OrderFlow OHLCV Proxy", 52, 34);
  flows.forEach((flow, index) => {
    const row = candles[index];
    const x = xFor(index, candles.length, width);
    const buyY = yFor(row.close >= row.open ? row.close : (row.close + row.low) / 2, bounds.min, bounds.max, height);
    const sellY = yFor(row.close >= row.open ? (row.open + row.high) / 2 : row.close, bounds.min, bounds.max, height);
    const buyRadius = 2 + (flow.buyVolume / maxSideVolume) * maxMarker;
    const sellRadius = 2 + (flow.sellVolume / maxSideVolume) * maxMarker;
    const buyX = x - candleWidth * 0.72;
    const sellX = x + candleWidth * 0.72;
    ctx.fillStyle = "rgba(67, 224, 138, 0.22)";
    ctx.strokeStyle = "rgba(67, 224, 138, 0.86)";
    ctx.beginPath();
    ctx.arc(buyX, buyY, buyRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 101, 125, 0.2)";
    ctx.strokeStyle = "rgba(255, 101, 125, 0.86)";
    ctx.beginPath();
    ctx.arc(sellX, sellY, sellRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const deltaHeight = clamp(Math.abs(flow.delta) / maxSideVolume * 30, 2, 30);
    ctx.fillStyle = flow.delta >= 0 ? "rgba(67, 224, 138, 0.72)" : "rgba(255, 101, 125, 0.72)";
    ctx.fillRect(x - 1.5, yFor((row.high + row.low) / 2, bounds.min, bounds.max, height) - deltaHeight / 2, 3, deltaHeight);
  });
  ctx.restore();
}

function factorPredictionSeries(item, candles) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return { predictionPrice: [], factorComposite: [], predictionPct: [], factorLines: {} };
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => Number(row.volume || 0));
  const vwap = cumulativeVwapSeries(rows);
  const macd = computeMacdSeries(rows);
  const avgVolume = sma(volumes, 20);
  const bollinger = bollingerChartSeries(rows);
  const flows = orderflowRows(rows);
  const currentFactor = factorScoreForItem(item);
  const analysis = normalizeAnalysis(item?.analysis);
  const anchor = clamp(projectedFinalReturn(analysis), -12, 12);
  const factorLines = {
    momentum: rows.map((row, index) => {
      const mom5 = index >= 5 ? pctChange(row.close, closes[index - 5]) : 0;
      const mom20 = index >= 20 ? pctChange(row.close, closes[index - 20]) : mom5;
      return clamp(mom5 * 2.2 + mom20 * 0.9, -42, 42);
    }),
    volume: rows.map((row, index) => avgVolume[index] ? clamp((row.volume / avgVolume[index] - 1) * 22, -42, 42) : 0),
    vwap: rows.map((row, index) => vwap[index] ? clamp((row.close / vwap[index] - 1) * 180, -42, 42) : 0),
    macd: rows.map((row, index) => clamp((macd.histogram[index] || 0) / Math.max(0.01, row.close) * 220, -42, 42)),
    bollinger: rows.map((row, index) => {
      const width = Math.max(0.000001, (bollinger.upper[index] || row.close) - (bollinger.lower[index] || row.close));
      const mid = bollinger.middle[index] || row.close;
      return clamp((row.close - mid) / width * 84, -42, 42);
    }),
    orderflow: rows.map((row, index) => {
      const flow = flows[index] || {};
      return clamp((Number(flow.delta || 0) / Math.max(1, row.volume || 0)) * 84, -42, 42);
    }),
    candle: rows.map((row) => {
      const range = Math.max(0.000001, row.high - row.low);
      const body = (row.close - row.open) / range * 34;
      const closeLocation = ((row.close - row.low) / range - 0.5) * 22;
      return clamp(body + closeLocation, -42, 42);
    }),
    configured: rows.map((_, index) => {
      const decay = rows.length <= 1 ? 1 : index / (rows.length - 1);
      return clamp(currentFactor * (0.62 + decay * 0.38), -42, 42);
    }),
  };
  const selected = selectedChartFactorKeys().filter((key) => factorLines[key]);
  const factorComposite = rows.map((row, index) => {
    const mom5 = index >= 5 ? pctChange(row.close, closes[index - 5]) : 0;
    const mom20 = index >= 20 ? pctChange(row.close, closes[index - 20]) : mom5;
    const volumeImpulse = avgVolume[index] ? clamp((row.volume / avgVolume[index] - 1) * 18, -18, 28) : 0;
    const vwapDistance = vwap[index] ? clamp((row.close / vwap[index] - 1) * 100, -12, 12) : 0;
    const macdImpulse = clamp((macd.histogram[index] || 0) / Math.max(0.01, row.close) * 120, -18, 18);
    const candleLocation = clamp(((row.close - row.low) / Math.max(0.000001, row.high - row.low) - 0.5) * 24, -12, 12);
    const factorAnchor = clamp(currentFactor, -18, 18) * 0.42;
    const selectedAverage = selected.length
      ? selected.reduce((sum, key) => sum + Number(factorLines[key][index] || 0), 0) / selected.length
      : 0;
    return clamp(mom5 * 0.82 + mom20 * 0.38 + volumeImpulse * 0.42 + vwapDistance * 0.75 + macdImpulse * 0.72 + candleLocation * 0.7 + factorAnchor + selectedAverage * 0.44, -42, 42);
  });
  const latestComposite = factorComposite.at(-1) || 0;
  const predictionPct = factorComposite.map((score, index) => {
    const blended = score * 0.13 + anchor * 0.55;
    const convergence = index === rows.length - 1 ? 0 : (latestComposite - score) * 0.025;
    return clamp(blended + convergence, -14, 14);
  });
  const predictionPrice = rows.map((row, index) => row.close * (1 + predictionPct[index] / 100));
  return { predictionPrice, factorComposite, predictionPct, factorLines };
}

function drawFactorPredictionOverlay(ctx, series, bounds, width, height) {
  if (!series?.predictionPrice?.length) return;
  drawSeriesLine(ctx, series.predictionPrice, bounds, width, height, "#facc15", 2.1);
  const colors = {
    momentum: "#38bdf8",
    volume: "#f97316",
    vwap: "#2fd6c9",
    macd: "#e879f9",
    bollinger: "#60a5fa",
    orderflow: "#43e08a",
    candle: "#ff657d",
    configured: "#a78bfa",
  };
  const labels = Object.fromEntries(CHART_FACTOR_LIBRARY);
  const selected = selectedChartFactorKeys().filter((key) => series.factorLines?.[key]);
  ctx.save();
  selected.forEach((key, index) => {
    const factorAsPrice = series.factorLines[key].map((score) => bounds.min + ((clamp(score, -42, 42) + 42) / 84) * (bounds.max - bounds.min));
    ctx.setLineDash(index % 2 ? [5, 5] : [2, 4]);
    drawSeriesLine(ctx, factorAsPrice, bounds, width, height, colors[key] || "#a78bfa", 1.3);
  });
  const compositeAsPrice = series.factorComposite.map((score) => bounds.min + ((clamp(score, -42, 42) + 42) / 84) * (bounds.max - bounds.min));
  ctx.setLineDash([7, 4]);
  drawSeriesLine(ctx, compositeAsPrice, bounds, width, height, "#ffffff", 1.45);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(250, 204, 21, 0.92)";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("预测价", 52, 50);
  selected.slice(0, 5).forEach((key, index) => {
    ctx.fillStyle = colors[key] || "#a78bfa";
    ctx.fillText(labels[key] || key, 104 + index * 62, 50);
  });
  ctx.fillStyle = "rgba(255, 255, 255, 0.86)";
  ctx.fillText("Composite", 104 + Math.min(5, selected.length) * 62, 50);
  ctx.restore();
}

function drawFactorStudyPanel(canvas, candles, series, hoverIndex = null) {
  if (!canvas) return;
  const rows = normalizeCandles(candles);
  const chart = setupCanvas(canvas);
  drawGrid(chart.ctx, chart.width, chart.height);
  if (!rows.length || !series?.factorComposite?.length) {
    drawLoading(canvas, "等待因子/预测序列");
    return;
  }
  const bounds = { min: -48, max: 48 };
  drawAxis(chart.ctx, bounds, chart.width, chart.height, (value) => value.toFixed(0));
  const firstClose = rows.find((row) => Number.isFinite(Number(row.close)) && row.close > 0)?.close || rows[0]?.close || 1;
  const priceReturn = rows.map((row) => clamp(pctChange(row.close, firstClose) * 4, -44, 44));
  const predictionScaled = (series.predictionPct || []).map((value) => clamp(Number(value || 0) * 3, -44, 44));
  const colors = {
    price: "#e9f6ff",
    prediction: "#facc15",
    composite: "#ffffff",
    momentum: "#38bdf8",
    volume: "#f97316",
    vwap: "#2fd6c9",
    macd: "#e879f9",
    bollinger: "#60a5fa",
    orderflow: "#43e08a",
    candle: "#ff657d",
    configured: "#a78bfa",
  };
  drawSeriesLine(chart.ctx, priceReturn, bounds, chart.width, chart.height, colors.price, 1.7);
  drawSeriesLine(chart.ctx, predictionScaled, bounds, chart.width, chart.height, colors.prediction, 1.9);
  chart.ctx.setLineDash([7, 4]);
  drawSeriesLine(chart.ctx, series.factorComposite, bounds, chart.width, chart.height, colors.composite, 1.6);
  chart.ctx.setLineDash([]);
  selectedChartFactorKeys().filter((key) => series.factorLines?.[key]).forEach((key, index) => {
    chart.ctx.setLineDash(index % 2 ? [5, 5] : [2, 4]);
    drawSeriesLine(chart.ctx, series.factorLines[key], bounds, chart.width, chart.height, colors[key] || "#a78bfa", 1.3);
  });
  chart.ctx.setLineDash([]);
  const labels = Object.fromEntries(CHART_FACTOR_LIBRARY);
  chart.ctx.font = "10px Inter, system-ui, sans-serif";
  chart.ctx.textAlign = "left";
  chart.ctx.fillStyle = colors.price;
  chart.ctx.fillText("价格收益x4", 52, 16);
  chart.ctx.fillStyle = colors.prediction;
  chart.ctx.fillText("Label预测x3", 130, 16);
  chart.ctx.fillStyle = colors.composite;
  chart.ctx.fillText("Composite", 218, 16);
  selectedChartFactorKeys().slice(0, 6).forEach((key, index) => {
    chart.ctx.fillStyle = colors[key] || "#a78bfa";
    chart.ctx.fillText(labels[key] || key, 52 + index * 76, 32);
  });
  drawTimeAxis(chart.ctx, rows, chart.width, chart.height);
  if (hoverIndex !== null) drawCrosshair(chart.ctx, clamp(hoverIndex, 0, rows.length - 1), rows.length, chart.width, chart.height);
}

function syncChartOverlayButtons(dashboard) {
  dashboard?.querySelectorAll("[data-overlay]").forEach((button) => {
    button.classList.toggle("active", overlayEnabled(button.dataset.overlay));
  });
}

function syncChartFactorButtons(dashboard) {
  const selected = new Set(selectedChartFactorKeys());
  dashboard?.querySelectorAll("[data-chart-factor]").forEach((button) => {
    button.classList.toggle("active", selected.has(button.dataset.chartFactor));
  });
}

function drawPriceVolumeOverlay(ctx, candles, width, height, candleWidth) {
  if (!candles.length) return;
  const maxVolume = Math.max(1, ...candles.map((row) => Number(row.volume || 0)));
  const overlayHeight = Math.max(46, Math.min(96, height * 0.24));
  const base = height - 20;
  ctx.save();
  ctx.fillStyle = "rgba(5, 11, 19, 0.48)";
  ctx.fillRect(48, base - overlayHeight, width - 62, overlayHeight);
  candles.forEach((row, index) => {
    const x = xFor(index, candles.length, width);
    const barHeight = Math.max(1, (Number(row.volume || 0) / maxVolume) * overlayHeight);
    const up = row.close >= row.open;
    const gradient = ctx.createLinearGradient(0, base - barHeight, 0, base);
    gradient.addColorStop(0, up ? "rgba(53, 208, 127, 0.46)" : "rgba(255, 93, 115, 0.46)");
    gradient.addColorStop(1, up ? "rgba(53, 208, 127, 0.08)" : "rgba(255, 93, 115, 0.08)");
    ctx.fillStyle = gradient;
    ctx.fillRect(x - candleWidth / 2, base - barHeight, Math.max(2, candleWidth), barHeight);
  });
  ctx.fillStyle = "rgba(141, 164, 186, 0.74)";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`Volume ${(maxVolume / 1000000).toFixed(2)}M`, 52, base - overlayHeight + 12);
  ctx.restore();
}

function drawVolumeProfileOverlay(ctx, profile, bounds, width, height) {
  const buckets = profile?.buckets || [];
  if (!buckets.length) return;
  const profileWidth = Math.max(96, Math.min(168, width * 0.2));
  const right = width - 14;
  const left = right - profileWidth;
  const maxVolume = Math.max(1, profile.maxVolume || 1);
  const valueArea = profile.valueArea || {};
  ctx.save();
  ctx.fillStyle = "rgba(5, 11, 19, 0.56)";
  ctx.fillRect(left - 6, 12, profileWidth + 6, height - 32);
  const linePoints = [];
  buckets.forEach((bucket) => {
    const y1 = yFor(bucket.high, bounds.min, bounds.max, height);
    const y2 = yFor(bucket.low, bounds.min, bounds.max, height);
    const y = (y1 + y2) / 2;
    const barHeight = Math.max(2, Math.abs(y2 - y1) - 1);
    const barWidth = Math.max(1, (bucket.volume / maxVolume) * profileWidth);
    const isPoc = profile.poc && Math.abs(bucket.mid - profile.poc.mid) < 0.000001;
    const inValueArea = valueArea.low != null && bucket.mid >= valueArea.low && bucket.mid <= valueArea.high;
    ctx.fillStyle = isPoc
      ? "rgba(250, 204, 21, 0.72)"
      : inValueArea
        ? "rgba(32, 212, 216, 0.36)"
        : "rgba(96, 165, 250, 0.2)";
    ctx.fillRect(right - barWidth, y - barHeight / 2, barWidth, barHeight);
    linePoints.push([right - barWidth, y]);
  });
  ctx.strokeStyle = "rgba(250, 204, 21, 0.86)";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  linePoints.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (valueArea.low != null) {
    const top = yFor(valueArea.high, bounds.min, bounds.max, height);
    const bottom = yFor(valueArea.low, bounds.min, bounds.max, height);
    ctx.strokeStyle = "rgba(32, 212, 216, 0.58)";
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(left - 4, top, profileWidth + 4, Math.max(2, bottom - top));
    ctx.setLineDash([]);
  }
  if (profile.poc) {
    const pocY = yFor(profile.poc.mid, bounds.min, bounds.max, height);
    ctx.strokeStyle = "rgba(250, 204, 21, 0.82)";
    ctx.beginPath();
    ctx.moveTo(48, pocY);
    ctx.lineTo(right, pocY);
    ctx.stroke();
    ctx.fillStyle = "#fde68a";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`POC ${formatCompactNumber(profile.poc.mid, 3)}`, right - 3, Math.max(22, pocY - 6));
  }
  ctx.fillStyle = "rgba(216, 231, 248, 0.88)";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("Volume Profile", right - 3, 22);
  ctx.restore();
}

function renderCharts(item, root = document) {
  const priceCanvas = root.querySelector("#priceChart");
  const factorCanvas = root.querySelector("#factorChart");
  const volumeCanvas = root.querySelector("#volumeChart");
  const macdCanvas = root.querySelector("#macdChart");
  if (!priceCanvas || !volumeCanvas || !macdCanvas) return;

  const chartKey = chartDataKey(item.symbol, state.chartInterval);
  const cachedChart = state.chartDataCache.get(chartKey);
  let sourceCandles = normalizeCandles(state.chartInterval === "1d" ? item.candles : cachedChart?.candles);
  if (!sourceCandles?.length) {
    const dashboard = root.querySelector("#chartDashboard");
    syncChartOverlayButtons(dashboard);
    syncChartFactorButtons(dashboard);
    bindChartDashboardControls(item, root);
    drawLoading(priceCanvas, `正在读取 ${state.chartInterval} 真实行情...`);
    if (factorCanvas) drawLoading(factorCanvas, "等待因子/预测序列");
    drawLoading(volumeCanvas, "等待数据");
    drawLoading(macdCanvas, "等待数据");
    if (state.chartInterval !== "1d" && !state.chartLoading.has(chartKey)) {
      state.chartLoading.add(chartKey);
      fetchChartMarket(item.symbol, state.chartInterval)
        .then(() => renderCharts(item, root))
        .catch((error) => {
          drawLoading(priceCanvas, `${state.chartInterval} 数据不可用：${error.message}`);
          drawLoading(volumeCanvas, "真实分钟线 provider 未返回");
          drawLoading(macdCanvas, "请确认数据套餐支持 intraday");
        })
        .finally(() => state.chartLoading.delete(chartKey));
    }
    return;
  }
  const view = visibleChartCandles(sourceCandles);
  const candles = view.candles;
  if (!candles.length) return;
  const hoverIndex = state.chartHoverIndex == null ? null : clamp(state.chartHoverIndex, 0, candles.length - 1);
  const chartNote = chartFallbackReadout(cachedChart);

  const closes = candles.map((row) => row.close);
  const highs = candles.map((row) => row.high);
  const lows = candles.map((row) => row.low);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const vwapSeries = cumulativeVwapSeries(candles);
  const bollingerSeries = bollingerChartSeries(candles);
  const fibLevels = fibonacciChartLevels(candles);
  const fvgZones = fvgChartZones(candles);
  const orderflow = orderflowRows(candles);
  const factorProjection = factorPredictionSeries(item, candles);
  const priceBounds = chartBounds([
    ...highs,
    ...lows,
    ...(overlayEnabled("sma20") ? sma20 : []),
    ...(overlayEnabled("sma50") ? sma50 : []),
    ...(overlayEnabled("vwap") ? vwapSeries : []),
    ...(overlayEnabled("bollinger") ? [...bollingerSeries.upper, ...bollingerSeries.lower] : []),
    ...(overlayEnabled("fib") ? fibLevels.map((row) => row.price) : []),
    ...(overlayEnabled("fvg") ? fvgZones.flatMap((zone) => [zone.low, zone.high]) : []),
    ...(overlayEnabled("factorPrediction") ? factorProjection.predictionPrice : []),
  ]);
  const price = setupCanvas(priceCanvas);
  drawGrid(price.ctx, price.width, price.height);
  if (cachedChart?.degraded) {
    price.ctx.save();
    price.ctx.fillStyle = "rgba(231, 238, 247, 0.88)";
    price.ctx.font = "11px Inter, system-ui, sans-serif";
    price.ctx.textAlign = "left";
    price.ctx.fillText(`${cachedChart.requestedInterval || state.chartInterval} -> ${cachedChart.actualInterval || "1d"} real daily fallback`, 54, 28);
    price.ctx.restore();
  }
  drawAxis(price.ctx, priceBounds, price.width, price.height);
  const plotWidth = price.width - 62;
  const candleWidth = Math.max(3, Math.min(12, plotWidth / candles.length * 0.62));
  const profileOverlay = visibleVolumeProfile(candles);
  if (overlayEnabled("volume")) drawPriceVolumeOverlay(price.ctx, candles, price.width, price.height, candleWidth);
  if (overlayEnabled("fvg")) {
    fvgZones.forEach((zone) => {
      const x1 = xFor(zone.startIndex, candles.length, price.width);
      const x2 = xFor(zone.endIndex, candles.length, price.width);
      const yTop = yFor(zone.high, priceBounds.min, priceBounds.max, price.height);
      const yBottom = yFor(zone.low, priceBounds.min, priceBounds.max, price.height);
      price.ctx.fillStyle = zone.type === "bullish"
        ? `rgba(34, 197, 94, ${zone.filled ? 0.08 : 0.18})`
        : `rgba(251, 113, 133, ${zone.filled ? 0.08 : 0.18})`;
      price.ctx.fillRect(Math.min(x1, x2), yTop, Math.max(3, Math.abs(x2 - x1)), Math.max(2, yBottom - yTop));
      price.ctx.strokeStyle = zone.type === "bullish" ? "rgba(34, 197, 94, 0.32)" : "rgba(251, 113, 133, 0.32)";
      price.ctx.strokeRect(Math.min(x1, x2), yTop, Math.max(3, Math.abs(x2 - x1)), Math.max(2, yBottom - yTop));
    });
  }
  candles.forEach((row, index) => {
    const x = xFor(index, candles.length, price.width);
    const yHigh = yFor(row.high, priceBounds.min, priceBounds.max, price.height);
    const yLow = yFor(row.low, priceBounds.min, priceBounds.max, price.height);
    const yOpen = yFor(row.open, priceBounds.min, priceBounds.max, price.height);
    const yClose = yFor(row.close, priceBounds.min, priceBounds.max, price.height);
    const up = row.close >= row.open;
    const candleColor = up ? "#43e08a" : "#ff657d";
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
    price.ctx.strokeStyle = candleColor;
    price.ctx.fillStyle = candleColor;
    price.ctx.beginPath();
    price.ctx.moveTo(x, yHigh);
    price.ctx.lineTo(x, yLow);
    price.ctx.stroke();
    const gradient = price.ctx.createLinearGradient(0, bodyTop, 0, bodyTop + bodyHeight);
    gradient.addColorStop(0, up ? "rgba(67, 224, 138, 0.96)" : "rgba(255, 101, 125, 0.96)");
    gradient.addColorStop(1, up ? "rgba(29, 155, 104, 0.72)" : "rgba(190, 58, 82, 0.72)");
    price.ctx.fillStyle = gradient;
    price.ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    price.ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
  });
  if (overlayEnabled("sma20")) drawSeriesLine(price.ctx, sma20, priceBounds, price.width, price.height, "#38bdf8");
  if (overlayEnabled("sma50")) drawSeriesLine(price.ctx, sma50, priceBounds, price.width, price.height, "#f59e0b");
  if (overlayEnabled("vwap")) drawSeriesLine(price.ctx, vwapSeries, priceBounds, price.width, price.height, "#e879f9");
  if (overlayEnabled("bollinger")) {
    drawSeriesLine(price.ctx, bollingerSeries.upper, priceBounds, price.width, price.height, "#60a5fa");
    price.ctx.setLineDash([4, 4]);
    drawSeriesLine(price.ctx, bollingerSeries.middle, priceBounds, price.width, price.height, "rgba(147, 197, 253, 0.78)");
    price.ctx.setLineDash([]);
    drawSeriesLine(price.ctx, bollingerSeries.lower, priceBounds, price.width, price.height, "#60a5fa");
  }
  if (overlayEnabled("fib")) {
    price.ctx.font = "11px Inter, system-ui, sans-serif";
    price.ctx.textAlign = "right";
    fibLevels.forEach((level) => {
      const y = yFor(level.price, priceBounds.min, priceBounds.max, price.height);
      price.ctx.strokeStyle = level.ratio === 0.618 ? "rgba(250, 204, 21, 0.74)" : "rgba(250, 204, 21, 0.28)";
      price.ctx.setLineDash(level.ratio === 0.618 ? [] : [5, 5]);
      price.ctx.beginPath();
      price.ctx.moveTo(48, y);
      price.ctx.lineTo(price.width - 14, y);
      price.ctx.stroke();
      price.ctx.setLineDash([]);
      price.ctx.fillStyle = "#fde68a";
      price.ctx.fillText(level.label, price.width - 16, Math.max(12, y - 6));
    });
  }
  if (overlayEnabled("profile")) drawVolumeProfileOverlay(price.ctx, profileOverlay, priceBounds, price.width, price.height);
  if (overlayEnabled("factorPrediction")) drawFactorPredictionOverlay(price.ctx, factorProjection, priceBounds, price.width, price.height);
  if (overlayEnabled("orderflow")) drawOrderflowLadder(price.ctx, candles, orderflow, priceBounds, price.width, price.height, candleWidth);
  if (overlayEnabled("anomalies")) {
    chartAnomalyIndexes(candles).forEach((mark) => {
      const row = candles[mark.index];
      const x = xFor(mark.index, candles.length, price.width);
      const y = yFor(row.high, priceBounds.min, priceBounds.max, price.height) - 7;
      price.ctx.fillStyle = mark.type === "up" ? "#22c55e" : mark.type === "down" ? "#fb7185" : "#facc15";
      price.ctx.beginPath();
      price.ctx.arc(x, y, 4, 0, Math.PI * 2);
      price.ctx.fill();
    });
  }
  const latestCandle = candles.at(-1);
  drawLastPriceMarker(price.ctx, latestCandle?.close, priceBounds, price.width, price.height, latestCandle?.close >= latestCandle?.open ? "#43e08a" : "#ff657d");
  drawTimeAxis(price.ctx, candles, price.width, price.height);

  const volume = setupCanvas(volumeCanvas);
  drawGrid(volume.ctx, volume.width, volume.height);
  const maxVolume = Math.max(...candles.map((row) => row.volume || 0), 1);
  drawAxis(volume.ctx, { min: 0, max: maxVolume }, volume.width, volume.height, (value) => `${(value / 1000000).toFixed(1)}M`);
  if (overlayEnabled("volume")) candles.forEach((row, index) => {
    const x = xFor(index, candles.length, volume.width);
    const barHeight = ((row.volume || 0) / maxVolume) * (volume.height - 28);
    const up = row.close >= row.open;
    const gradient = volume.ctx.createLinearGradient(0, volume.height - 18 - barHeight, 0, volume.height - 18);
    gradient.addColorStop(0, up ? "rgba(67, 224, 138, 0.68)" : "rgba(255, 101, 125, 0.68)");
    gradient.addColorStop(1, up ? "rgba(67, 224, 138, 0.16)" : "rgba(255, 101, 125, 0.16)");
    volume.ctx.fillStyle = gradient;
    volume.ctx.fillRect(x - candleWidth / 2, volume.height - 18 - barHeight, candleWidth, barHeight);
  });
  drawTimeAxis(volume.ctx, candles, volume.width, volume.height);

  const macdSeries = computeMacdSeries(candles);
  const macd = setupCanvas(macdCanvas);
  const macdBounds = chartBounds([...macdSeries.macd, ...macdSeries.signal, ...macdSeries.histogram], 0.18);
  drawGrid(macd.ctx, macd.width, macd.height);
  drawAxis(macd.ctx, macdBounds, macd.width, macd.height, (value) => value.toFixed(2));
  const zeroY = yFor(0, macdBounds.min, macdBounds.max, macd.height);
  macd.ctx.strokeStyle = "rgba(142, 163, 186, 0.46)";
  macd.ctx.beginPath();
  macd.ctx.moveTo(48, zeroY);
  macd.ctx.lineTo(macd.width, zeroY);
  macd.ctx.stroke();
  if (overlayEnabled("macd")) macdSeries.histogram.forEach((value, index) => {
    const x = xFor(index, macdSeries.histogram.length, macd.width);
    const y = yFor(value, macdBounds.min, macdBounds.max, macd.height);
    macd.ctx.fillStyle = value >= 0 ? "rgba(34, 197, 94, 0.72)" : "rgba(251, 113, 133, 0.72)";
    macd.ctx.fillRect(x - candleWidth / 2, Math.min(y, zeroY), candleWidth, Math.max(1, Math.abs(zeroY - y)));
  });
  if (overlayEnabled("macd")) {
    drawSeriesLine(macd.ctx, macdSeries.macd, macdBounds, macd.width, macd.height, "#38bdf8");
    drawSeriesLine(macd.ctx, macdSeries.signal, macdBounds, macd.width, macd.height, "#f59e0b");
  }

  if (hoverIndex !== null) {
    drawCrosshair(price.ctx, hoverIndex, candles.length, price.width, price.height);
    const row = candles[hoverIndex];
    const readout = root.querySelector("#chartReadout");
    if (readout) {
      const poc = profileOverlay.poc?.mid != null ? `  POC ${formatCompactNumber(profileOverlay.poc.mid, 3)}` : "";
      const flow = orderflow[hoverIndex] || {};
      const flowText = overlayEnabled("orderflow")
        ? flow.proxy
          ? "  Footprint unavailable: no real tick/L1/L2"
          : `  Buy ${formatCompactNumber(flow.buyVolume, 0)}/${formatCompactNumber(flow.buyTrades, 0)} Sell ${formatCompactNumber(flow.sellVolume, 0)}/${formatCompactNumber(flow.sellTrades, 0)} Tick-rule`
        : "";
      const predictionText = overlayEnabled("factorPrediction")
        ? `  Pred ${formatPct(factorProjection.predictionPct[hoverIndex] || 0)} Factor ${formatCompactNumber(factorProjection.factorComposite[hoverIndex], 1)} [${selectedChartFactorKeys().join(",")}]`
        : "";
      readout.textContent = `${row.date}  O ${row.open.toFixed(2)} H ${row.high.toFixed(2)} L ${row.low.toFixed(2)} C ${row.close.toFixed(2)}  Vol ${(row.volume / 1000000).toFixed(2)}M  MACD ${macdSeries.macd[hoverIndex].toFixed(3)} / ${macdSeries.signal[hoverIndex].toFixed(3)}${poc}${flowText}${predictionText}  Zoom ${view.zoom.toFixed(2)}x`;
    }
  } else {
    const readout = root.querySelector("#chartReadout");
    if (readout) readout.textContent = chartNote;
  }

  if (factorCanvas) {
    drawFactorStudyPanel(factorCanvas, candles, factorProjection, hoverIndex);
  }

  if (hoverIndex !== null) {
    drawCrosshair(volume.ctx, hoverIndex, candles.length, volume.width, volume.height);
    drawCrosshair(macd.ctx, hoverIndex, candles.length, macd.width, macd.height);
  }

  const dashboard = root.querySelector("#chartDashboard");
  syncChartOverlayButtons(dashboard);
  syncChartFactorButtons(dashboard);
  bindChartDashboardControls(item, root);
  if (dashboard && !dashboard.dataset.canvasBound) {
    dashboard.dataset.canvasBound = "true";
    [priceCanvas, factorCanvas, volumeCanvas, macdCanvas].filter(Boolean).forEach((canvas) => {
      canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
        if (sideways) {
          state.chartOffset = Math.max(0, Number(state.chartOffset || 0) + Math.round(event.deltaX / WHEEL_PAN_DIVISOR));
        } else {
          const factor = event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT;
          state.chartZoom = clamp(Number(state.chartZoom || 1) * factor, 1, 30);
        }
        saveChartView();
        scheduleChartRedraw("detail", () => renderCharts(item, root));
      }, { passive: false });
      canvas.addEventListener("pointerdown", (event) => {
        state.chartDragging = { x: event.clientX, offset: Number(state.chartOffset || 0) };
        canvas.setPointerCapture?.(event.pointerId);
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!state.chartDragging) return;
        const rect = canvas.getBoundingClientRect();
        const barsPerPixel = candles.length / Math.max(1, rect.width - 62);
        state.chartOffset = Math.max(0, Math.round(state.chartDragging.offset - (event.clientX - state.chartDragging.x) * barsPerPixel));
        scheduleChartRedraw("detail", () => renderCharts(item, root));
      });
      canvas.addEventListener("pointerup", () => {
        state.chartDragging = null;
        saveChartView();
      });
      canvas.addEventListener("mousemove", (event) => {
        if (state.chartDragging) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left - 48) / Math.max(1, rect.width - 62), 0, 1);
        state.chartHoverIndex = Math.round(ratio * (candles.length - 1));
        scheduleChartRedraw("detail", () => renderCharts(item, root));
      });
      canvas.addEventListener("mouseleave", () => {
        state.chartHoverIndex = null;
        const readout = root.querySelector("#chartReadout");
        if (readout) readout.textContent = chartFallbackReadout(state.chartDataCache.get(chartDataKey(item.symbol, state.chartInterval)));
        scheduleChartRedraw("detail", () => renderCharts(item, root));
      });
    });
  }
}

function drawSeriesLine(ctx, values, bounds, width, height, color, lineWidth = 1.6) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = xFor(index, values.length, width);
    const y = yFor(value, bounds.min, bounds.max, height);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawCrosshair(ctx, index, count, width, height) {
  const x = xFor(index, count, width);
  ctx.strokeStyle = "rgba(226, 232, 240, 0.38)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
}

function setSymbolError(symbol, error) {
  const message = error.message || String(error);
  const existing = state.analyses.get(symbol);
  if (existing?.candles?.length && existing?.analysis?.action !== "ERROR") {
    state.analyses.set(symbol, {
      ...existing,
      marketWarning: `实时行情源失败，保留上次真实数据：${message}`,
      marketValidation: {
        ...(existing.marketValidation || {}),
        degraded: true,
        status: "stale_snapshot_after_provider_failure",
        message,
      },
    });
    return;
  }
  const errorKind = /market|provider|candles|行情|EODHD|Twelve/i.test(message)
    ? "market"
    : /历史数据不足|数据不足/.test(message)
      ? "data"
      : "analysis";
  state.analyses.set(symbol, {
    symbol,
    technicals: { close: 0, rsi: 0, mainForceProxy: 0, volumeRatio: 0, change5d: 0 },
    analysis: { action: "ERROR", confidence: 0, projectedUpside: 0, thesis: [message], risks: [] },
    news: [],
    source: "error",
    marketSource: "not-configured",
    marketWarning: message,
    errorKind,
  });
}

async function refreshAll() {
  if (state.isRefreshing) {
    setStatus("上一次刷新还在进行，自动刷新已重新排队");
    if (state.autoRefreshEnabled) scheduleNextAutoRefresh();
    return;
  }
  const startedAt = new Date();
  const preparedItems = [];
  let symbols = [];
  let runtime = getRuntimeSettings();
  try {
    const session = marketState();
    runtime = getRuntimeSettings();
    if (!session.canRefresh && !runtime.allowOffHoursFetch) {
      const shouldStop = await useSnapshotOrFetch(`当前不在 ${activeMarketConfig().code} 交易/收盘刷新窗口`, true);
      if (shouldStop) {
        safeUiStep("安排下一次自动刷新", scheduleNextAutoRefresh);
        return;
      }
    }
    if (state.autoRefreshTimer) {
      clearTimeout(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
    state.isRefreshing = true;
    safeUiStep("保存刷新状态", saveState);
    const refreshButton = $("refreshAll");
    if (refreshButton) refreshButton.disabled = true;
    symbols = orderedSymbolsForRefresh();
    safeUiStep("排队 Reddit 社媒缓存", () => scheduleRedditSocialWarmup("refresh-start", 250, { maxSymbols: Math.max(20, Math.min(80, symbols.length + 10)) }));
    await safeUiStepAsync("同步预测准确率", () => fetchAccuracySummary(true));
    await refreshMarketIndexes(true).catch((error) => {
      console.warn("Unable to refresh market indexes", error);
      safeUiStep("恢复本地大盘快照", loadMarketIndexSnapshot);
    });
    setStatus(runtime.fastInitialRefresh
      ? `快速并行读取 ${symbols.length} 只股票真实行情；新闻/AI 后台复核...`
      : `并行读取 ${symbols.length} 只股票真实行情、新闻和因子；持仓股优先...`);
    const tasks = symbols.map(async (symbol) => {
      try {
        const prepared = await prepareSymbol(symbol, { includeSignals: !runtime.fastInitialRefresh });
        preparedItems.push(prepared);
        setStatusThrottled(`${symbol} 数据准备完成 · ${preparedItems.length}/${symbols.length}`);
      } catch (error) {
        console.error(error);
        safeUiStep(`${symbol} 写入失败状态`, () => setSymbolError(symbol, error));
      } finally {
        queueMainRender(["cards", "summary", "detail"]);
      }
    });
    await Promise.allSettled(tasks);
    preparedItems.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
    if (preparedItems.length) {
      try {
        setStatus(runtime.fastInitialRefresh
          ? `快速本地融合 ${preparedItems.length} 只股票，先给出技术/历史/自监督结论...`
          : `本地模型融合 ${preparedItems.length} 只股票，已纳入新闻/因子，AI 批量分析后台更新...`);
        const results = await requestBatchAnalysis(preparedItems, { localOnly: true });
        const buyAlerts = results.filter((item) => isBuyAction(item.analysis?.action)).length;
        setStatus(`本地融合完成：${buyAlerts} 个买入/轻仓关注提醒，新闻/因子/AI 正在后台复核`);
      } catch (error) {
        console.error(error);
        preparedItems.forEach((item) => safeUiStep(`${item.symbol} 写入本地模型失败`, () => setSymbolError(item.symbol, error)));
      } finally {
        renderAnalysisPanelsNow();
      }
    }
    const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    setStatus(`刷新完成：${preparedItems.length}/${symbols.length} 只股票，用时 ${seconds}s；后台复核继续更新新闻、因子和 AI`);
    safeUiStep("刷新后排队 Reddit 社媒缓存", () => scheduleRedditSocialWarmup("refresh-complete", 1200, { maxSymbols: Math.max(20, Math.min(80, symbols.length + 10)) }));
    safeUiStep("安排下一次自动刷新", scheduleNextAutoRefresh);
    if (preparedItems.length) {
      const token = Date.now();
      state.aiRefreshToken = token;
      runBackgroundSignalAi(preparedItems, token)
        .catch((error) => {
          if (state.aiRefreshToken !== token) return;
          console.error(error);
          setStatus(`后台新闻/AI 复核未完成：${error.message}`);
        });
    }
  } catch (error) {
    console.error("Refresh failed", error);
    setStatus(`刷新中断：${compactRuntimeError(error)}；按钮已恢复，可继续切换市场或再次刷新`);
    renderAnalysisPanelsNow();
    safeUiStep("刷新失败后安排自动刷新", scheduleNextAutoRefresh);
  } finally {
    const refreshButton = $("refreshAll");
    if (refreshButton) refreshButton.disabled = false;
    state.isRefreshing = false;
  }
}

function scheduleNextAutoRefresh() {
  if (!state.autoRefreshEnabled) return;
  if (state.autoRefreshTimer) clearTimeout(state.autoRefreshTimer);
  const session = marketState();
  const runtime = getRuntimeSettings();
  const interval = session.canRefresh || runtime.allowOffHoursFetch
    ? asNumber($("refreshInterval").value, 180000)
    : minutesUntilNextRefreshWindow() * 60000;
  state.nextAutoRefreshAt = new Date(Date.now() + interval);
  state.autoRefreshTimer = setTimeout(refreshAll, Math.min(interval, 2147483647));
  setStatus(session.canRefresh || runtime.allowOffHoursFetch
    ? `自动刷新运行中，下一次：${formatClock(state.nextAutoRefreshAt)}`
    : `${activeMarketConfig().code} 休市中，自动刷新暂停；下一次交易窗口：${formatClock(state.nextAutoRefreshAt)}`);
}

function startAutoRefresh(runNow = false) {
  if (state.autoRefreshTimer) clearTimeout(state.autoRefreshTimer);
  const interval = asNumber($("refreshInterval").value, 180000);
  state.autoRefreshEnabled = true;
  $("toggleAutoRefresh").textContent = "停止";
  saveState();
  setStatus(marketState().canRefresh || getRuntimeSettings().allowOffHoursFetch
    ? `自动刷新已启动：每 ${Math.round(interval / 60000)} 分钟`
    : "自动刷新已启动；当前休市，先使用本地快照并等待下一次交易窗口");
  if (runNow) refreshAll();
  else scheduleNextAutoRefresh();
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) clearTimeout(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
  state.autoRefreshEnabled = false;
  state.nextAutoRefreshAt = null;
  $("toggleAutoRefresh").textContent = "启动";
  saveState();
  setStatus("自动刷新已停止");
}

function stashActiveMarketState() {
  sanitizeActiveMarketState();
  state.watchlist = sanitizeSymbolsForMarket(state.watchlist, state.market);
  reconcileWatchlistOrigins(state.market);
  state.watchlistsByMarket[state.market] = state.watchlist;
  state.analysesByMarket.set(state.market, new Map(state.analyses));
  safeStorage.setItem("watchlistsByMarket", JSON.stringify(state.watchlistsByMarket));
  safeStorage.setItem("watchlistOriginsByMarket", JSON.stringify(state.watchlistOriginsByMarket));
}

function updateMarketUi() {
  const config = activeMarketConfig();
  document.title = `${config.title} · Global Quant Watch`;
  const marketCycleButton = $("marketCycleButton");
  if (marketCycleButton) {
    marketCycleButton.textContent = state.market === "ASX" ? "AUX" : state.market;
    marketCycleButton.setAttribute("aria-label", `当前${config.label}，点击切换市场`);
    marketCycleButton.title = `当前${config.label}，点击切换 AUX / US / CN`;
  }
  const brandMarketTitle = $("brandMarketTitle");
  if (brandMarketTitle) brandMarketTitle.textContent = `${config.label} ${config.code}`;
  const brandSubtitle = $("brandSubtitle");
  if (brandSubtitle) brandSubtitle.textContent = "Global Quant Watch · 多市场只读分析与提醒";
  const marketTitle = $("marketTitle");
  if (marketTitle) marketTitle.textContent = config.title;
  document.querySelectorAll(".currencyLabel").forEach((node) => {
    node.textContent = config.currency;
  });
  const symbolInput = $("symbolInput");
  if (symbolInput) symbolInput.placeholder = config.symbolPlaceholder;
  const holdingSymbol = $("holdingSymbol");
  if (holdingSymbol) holdingSymbol.placeholder = config.holdingPlaceholder;
  ["featureSymbol", "factorLabSymbol"].forEach((id) => {
    const input = $(id);
    if (!input) return;
    input.placeholder = config.holdingPlaceholder;
    if (!normalizeSymbolForMarket(input.value, state.market)) {
      input.value = state.selected || state.watchlist[0] || config.defaultSymbols[0] || "";
    }
  });
  const portfolioCsv = $("portfolioCsv");
  if (portfolioCsv) portfolioCsv.value = safeStorage.getItem(`portfolioCsv:${state.market}`) || holdingsToCsv(activePortfolio()) || config.samplePortfolio;
  const agentInitialCapital = $("agentInitialCapital");
  if (agentInitialCapital) agentInitialCapital.value = agentConfigForMarket().initialCapital;
  syncCapitalFields();
  updateSydneyClock();
}

async function switchMarket(nextMarket) {
  const market = safeMarket(nextMarket);
  if (market === state.market) return;
  const token = ++state.marketSwitchToken;
  safeUiStep("保存当前市场状态", stashActiveMarketState);
  state.market = market;
  state.watchlist = sanitizeSymbolsForMarket(initialWatchlistForMarket(market), market);
  state.analyses = new Map(state.analysesByMarket.get(market) || []);
  safeUiStep("清理市场状态", sanitizeActiveMarketState);
  state.chartHoverIndex = null;
  state.marketCache.clear();
  state.chartDataCache.clear();
  state.stockPicker = { forecast: [], today: [], rejected: [], failures: [], updatedAt: null };
  state.latestFactorLab = null;
  state.snapshotUpdatedAt = safeStorage.getItem(snapshotTimeKey()) || null;
  safeUiStep("保存市场选择", saveState);
  safeUiStep("更新市场 UI", updateMarketUi);
  setStatus(`已切换到${activeMarketConfig().label}；基础面板已可操作，历史数据后台恢复中`);
  state.marketIndexes = [];
  state.marketIndexSignal = null;
  safeUiStep("恢复大盘快照", loadMarketIndexSnapshot);
  safeUiStep("恢复本地分析快照", () => {
    const restored = restoreAnalysisSnapshot();
    if (restored) evaluateAlerts();
    return restored;
  });
  queueMainRender(["cards", "summary", "detail", "indexes", "agent"]);
  safeUiStep("渲染股票池", renderUniversePanel);
  safeUiStep("渲染涨跌榜", renderMarketMoversPanel);
  safeUiStep("渲染 AI 选股", renderAiPickPanel);
  deferMarketStepAsync(token, "恢复服务器快照", restoreServerSnapshot, 150, { idle: true, timeout: 3000 });
  deferMarketStep(token, "清理恢复后的市场状态", sanitizeActiveMarketState, 360, { idle: true });
  deferMarketStepAsync(token, "加载研究配置", loadResearchConfig, 560, { idle: true, timeout: 3500 });
  deferMarketStepAsync(token, "加载预测准确率", () => fetchAccuracySummary(true), 820, { idle: true, timeout: 4500 });
  deferMarketStep(token, "后台渲染市场面板", () => {
    evaluateAlerts();
    queueMainRender(["cards", "summary", "detail", "indexes", "agent"]);
    renderUniversePanel();
    renderMarketMoversPanel();
    renderAiPickPanel();
    setStatus(`已切换到${activeMarketConfig().label}；刷新后读取该市场真实行情`);
  }, 1050, { idle: true });
  if (state.activePage === "sources") {
    deferMarketStepAsync(token, "刷新数据源预算", () => refreshProviderBudget(false), 1250, { idle: true, timeout: 4500 });
    deferMarketStepAsync(token, "刷新数据健康中心", () => refreshDataHealth(false), 1450, { idle: true, timeout: 4500 });
  }
  deferMarketStepAsync(token, "刷新 API 状态", () => refreshApiStatusBar(false), 1650, { idle: true, timeout: 4500 });
  deferMarketStep(token, "排队 Reddit 社媒缓存", () => scheduleRedditSocialWarmup("market-switch", 300, { maxSymbols: 60 }), 1850, { idle: true });
  deferMarketStep(token, "排队补齐大盘快照", () => queueMarketIndexHydration(`${activeMarketConfig().label} 大盘快照不完整`), 2200, { idle: true });
  if (state.autoRefreshEnabled) safeUiStep("安排自动刷新", scheduleNextAutoRefresh);
}

function cycleMarket() {
  const order = ["ASX", "US", "CN"];
  const currentIndex = Math.max(0, order.indexOf(state.market));
  switchMarket(order[(currentIndex + 1) % order.length]).catch((error) => {
    console.error("Market switch failed", error);
    setStatus(`市场切换部分失败：${compactRuntimeError(error)}；可继续切换其它市场`);
  });
}

async function importPortfolioImage(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  $("imageImportStatus").textContent = "正在识别截图...";
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  try {
    const response = await fetch("/api/portfolio-image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: dataUrl, market: state.market }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "截图识别失败");
    const holdings = (payload.holdings || []).map((holding) => ({
      symbol: normalizeSymbol(holding.symbol),
      market: state.market,
      qty: asNumber(holding.qty),
      avgPrice: asNumber(holding.avgPrice),
      entryDate: holding.entryDate || todayIso(),
      source: "screenshot",
      marketLocked: true,
      explicitMarket: true,
      addedAt: new Date().toISOString(),
    })).filter((holding) => holding.symbol && holding.qty > 0 && holding.avgPrice > 0);
    if (!holdings.length) throw new Error("截图中未识别到 symbol / qty / avgPrice");
    $("portfolioOcrText").value = holdingsToCsv(holdings);
    state.portfolio = mergeHoldings([...state.portfolio, ...holdings]);
    savePortfolio();
    renderCards();
    renderPortfolioSummary();
    $("imageImportStatus").textContent = `截图已识别 ${holdings.length} 条持仓。`;
  } catch (error) {
    $("imageImportStatus").textContent = `截图自动识别不可用：${error.message}。可以把截图文字粘贴到下方再应用。`;
  } finally {
    event.target.value = "";
  }
}

function boot() {
  safeStorage.setItem(`lastAppOpen:${state.market}`, new Date().toISOString());
  window.addEventListener("pagehide", () => {
    safeStorage.setItem(`lastAppClose:${state.market}`, new Date().toISOString());
  });
  window.addEventListener("beforeunload", () => {
    safeStorage.setItem(`lastAppClose:${state.market}`, new Date().toISOString());
  });
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => setWorkspacePage(button.dataset.pageTarget));
  });
  bind("marketCycleButton", "click", cycleMarket);

  if (STARTUP_SAFE_MODE) {
    state.activePage = "dashboard";
    safeStorage.setItem("activeQuantPage", "dashboard");
  }
  safeUiStep("读取保存输入", loadSavedInputs);
  safeUiStep("清理启动状态", sanitizeActiveMarketState);
  safeUiStep("更新市场 UI", updateMarketUi);
  safeUiStep("保存持仓", savePortfolio);
  safeUiStep("渲染基础股票卡片", renderCards);
  safeUiStep("渲染基础持仓概览", renderPortfolioSummary);
  safeUiStep("渲染提醒按钮", renderNotificationButton);
  safeUiStep("渲染 API 状态", renderApiStatusBar);
  safeUiStep("启动市场时钟", startSydneyClock);
  safeUiStep("切换启动页面", () => setWorkspacePage(state.activePage, { silent: true }));
  setStatus(STARTUP_SAFE_MODE
    ? "已进入安全启动模式：先保证页面可操作，旧快照/新闻后台暂不自动加载"
    : "页面已进入可操作状态，历史快照和模型面板正在后台恢复");

  deferUiStep("恢复本地分析快照", () => {
    if (STARTUP_SAFE_MODE) return false;
    const restored = restoreAnalysisSnapshot();
    if (restored) {
      safeUiStep("快照恢复后渲染卡片", renderCards);
      safeUiStep("快照恢复后渲染详情", renderDetail);
      safeUiStep("快照恢复后检查提醒", evaluateAlerts);
    }
    return restored;
  }, 500);
  deferUiStep("恢复大盘快照", () => {
    if (STARTUP_SAFE_MODE) return false;
    loadMarketIndexSnapshot();
    renderMarketIndexPanel();
  }, 900);
  deferUiStep("恢复服务器快照", async () => {
    if (STARTUP_SAFE_MODE) return false;
    return restoreServerSnapshot();
  }, 1400);
  deferUiStep("加载研究配置", loadResearchConfig, 1700);
  deferUiStep("加载预测准确率", () => fetchAccuracySummary(true), STARTUP_SAFE_MODE ? 4500 : 2200);
  deferUiStep("渲染股票池", renderUniversePanel, 2600);
  deferUiStep("渲染涨跌榜", renderMarketMoversPanel, 2900);
  deferUiStep("渲染 AI 选股", renderAiPickPanel, 3200);
  deferUiStep("渲染 Agent", renderAgentPanel, 3500);
  deferUiStep("渲染最优策略", renderOptimalStrategyPanel, 3800);
  deferUiStep("渲染历史", renderHistory, 4100);
  deferUiStep("渲染因子配置", renderFactorConfigPanel, 4400);
  deferUiStep("渲染策略版本", renderStrategyRevisionPanel, 4700);
  deferUiStep("刷新 API 状态", () => refreshApiStatusBar(false), 5200);
  deferUiStep("排队 Reddit 社媒缓存", () => scheduleRedditSocialWarmup("startup", 300, { maxSymbols: 60 }), STARTUP_SAFE_MODE ? 6500 : 5600);
  deferUiStep("排队补齐大盘快照", () => {
    if (STARTUP_SAFE_MODE) return false;
    queueMarketIndexHydration("启动时大盘快照不完整");
    return true;
  }, 5800);
  deferUiStep("启动新闻窗口补抓", () => {
    if (STARTUP_SAFE_MODE) return false;
    return refreshDueNewsOnOpen();
  }, 9000);
  deferUiStep("确认启动完成", () => {
    safeStorage.setItem(BOOT_PENDING_KEY, "false");
    if (STARTUP_SAFE_MODE) setStatus("安全启动完成：页面可操作。需要数据时请手动点击刷新或数据源页检查。");
  }, 12000);

  bind("runFeatureAnalysis", "click", runFeatureAnalysis);
  bind("runTradeAnalysis", "click", runTradeAnalysis);
  bind("runFactorLab", "click", runFactorLab);
  bind("saveFactorConfig", "click", saveFactorConfig);
  bind("openModelChangeLog", "click", openModelChangeLogModal);
  bind("refreshProviderBudget", "click", () => refreshProviderBudget(true));
  bind("refreshDataHealth", "click", () => refreshDataHealth(true));
  bind("refreshNewsNow", "click", refreshNewsNow);
  bind("checkIbkrReadiness", "click", checkIbkrReadiness);
  bind("runRiskAssessment", "click", () => runRiskAssessment(true));
  bind("submitPaperIntent", "click", submitPaperOrderIntent);
  bind("refreshTradingAudit", "click", () => loadTradingAudit(true));
  bind("recordStrategyRevision", "click", recordStrategyRevision);

  bind("symbolForm", "submit", (event) => {
    event.preventDefault();
    const rawSymbol = $("symbolInput").value;
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) {
      setStatus(`${activeMarketConfig().label} 代码格式不正确：${rawSymbol || "空"}`);
      return;
    }
    if (state.watchlist.includes(symbol)) return;
    addWatchSymbol(symbol, "manual");
    $("symbolInput").value = "";
    saveState();
    renderCards();
    scheduleRedditSocialWarmup("manual-symbol-add", 500, { maxSymbols: 60 });
  });

  bind("saveStrategy", "click", () => {
    const before = readJsonStorage("strategy", null);
    const after = getStrategy();
    saveState();
    if (!before || strategyChanged(before, after)) {
      appendModelChangeLog({
        type: "strategy",
        title: "策略参数已保存",
        summary: `周期 ${after.horizonDays} 日、目标 ${formatPct(after.targetUpside)}、置信 ${formatPct(after.confidence)}、止损 ${formatPct(after.stopLoss)}。`,
        before: { strategy: before },
        after: { strategy: after },
        details: { source: "saveStrategy" },
      });
    }
    setStatus("策略已保存");
  });

  bind("saveCapital", "click", () => {
    saveState();
    renderPortfolioSummary();
    renderCards();
    renderDetail();
    setStatus("资金设置已保存");
  });

  bind("refreshAccuracy", "click", async () => {
    await fetchAccuracySummary(true);
    setStatus("预测准确率已更新");
  });

  bind("refreshIndexes", "click", async () => {
    const hadCompleteRows = marketIndexRowsComplete(state.marketIndexes);
    const fallbackRows = hadCompleteRows ? state.marketIndexes.slice() : [];
    const fallbackSignal = state.marketIndexSignal || indexSignalFromRows(fallbackRows);
    try {
      setStatus("正在更新大盘指数...");
      await refreshMarketIndexes(true);
      try {
        renderCards();
        renderDetail();
      } catch (renderError) {
        console.warn("Market index refresh succeeded but dependent render failed", renderError);
      }
      setStatus(state.marketIndexUsedSnapshotFallback
        ? "实时大盘指数源未完整返回，已保留当前完整真实数据"
        : "大盘指数已更新，并已纳入后续选股偏置");
    } catch (error) {
      console.error(error);
      if (hadCompleteRows) {
        state.marketIndexes = fallbackRows;
        state.marketIndexSignal = fallbackSignal;
        state.marketIndexUsedSnapshotFallback = true;
        renderMarketIndexPanel();
        setStatus("实时大盘指数源暂未完整返回，已保留当前完整真实数据");
        return;
      }
      if (loadMarketIndexSnapshot()) {
        state.marketIndexUsedSnapshotFallback = true;
        setStatus("实时大盘指数源暂未完整返回，已使用本地完整真实快照");
        return;
      }
      setStatus(`大盘指数更新失败：${compactDisplayError(error.message)}`);
    }
  });

  bind("loadUniverse", "click", () => loadMarketUniverse(false, true));
  bind("refreshUniverse", "click", () => loadMarketUniverse(true, true));
  bind("refreshMarketMovers", "click", () => loadMarketMovers(true, true));
  bind("aiPickStocks", "click", runAiStockPicker);
  bind("sendAiChat", "click", sendAiChat);
  bind("aiChatInput", "keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendAiChat();
  });

  bind("saveAgentCapital", "click", () => {
    const beforeLedger = getAgentLedger();
    const before = {
      capital: agentConfigForMarket().initialCapital,
      model: agentModelSummary(beforeLedger),
    };
    const value = Math.max(100, asNumber($("agentInitialCapital").value, agentConfigForMarket().initialCapital));
    state.agentConfigByMarket[state.market] = { initialCapital: value };
    resetLedgerPreservingMemory("capital-reset");
    appendModelChangeLog({
      type: "agent-capital",
      title: "Agent 本金已修改",
      summary: `单 Agent 初始本金调整为 ${formatMoney(value)}，当前训练周期已归档并重新开始。`,
      before,
      after: { capital: value, model: agentModelSummary(getAgentLedger()) },
      details: { source: "saveAgentCapital" },
    });
    renderAgentPanel();
    renderOptimalStrategyPanel();
    setStatus(`模拟交易 Agent 本金已设为 ${formatMoney(value)}；当前周期已归档，长期策略记忆已保留`);
  });

  bind("resetAgents", "click", () => {
    const before = agentModelSummary(getAgentLedger());
    resetLedgerPreservingMemory("manual-reset");
    appendModelChangeLog({
      type: "agent-reset",
      title: "Agent 训练周期已归档重置",
      summary: "当前市场训练周期已归档；长期策略记忆保留，但新周期需重新验证。",
      before,
      after: agentModelSummary(getAgentLedger()),
      details: { source: "manual-reset" },
    });
    renderAgentPanel();
    renderOptimalStrategyPanel();
    setStatus("当前市场训练周期已归档并重置；长期策略记忆会继续参与后续预测");
  });

  bind("refreshOptimalStrategy", "click", () => {
    const rows = [...state.analyses.values()].filter((item) => item?.candles?.length);
    if (!rows.length) {
      setStatus("还没有可用于训练的历史K线，请先刷新股票");
      return;
    }
    const ledger = getAgentLedger();
    const before = agentModelSummary(ledger);
    trainAgentsWithHistoricalReplay(ledger, rows);
    ledger.updatedAt = new Date().toISOString();
    state.agentLedgerByMarket[state.market] = ledger;
    persistAgentMemoryFromLedger(ledger, "manual-replay");
    saveAgentState();
    appendModelChangeLog({
      type: "agent-replay",
      title: "Agent 最优策略草稿已重放训练",
      summary: `使用当前股票池 ${rows.length} 只股票做历史重放；结果只进入草稿和本地 Agent 偏置。`,
      before,
      after: agentModelSummary(ledger),
      details: { sampleCount: rows.length, symbols: rows.map((item) => item.symbol).slice(0, 60) },
    });
    renderAgentPanel();
    renderOptimalStrategyPanel();
    setStatus("Agent 最优策略草稿已用当前股票池叠加训练更新");
  });

  bind("totalCapital", "input", () => {
    syncCapitalFields();
    renderPortfolioSummary();
    renderCards();
    renderDetail();
  });

  bind("toggleAutoRefresh", "click", () => {
    if (state.autoRefreshTimer) stopAutoRefresh();
    else startAutoRefresh(true);
  });

  bind("refreshInterval", "change", () => {
    if (!state.autoRefreshEnabled) return;
    startAutoRefresh(false);
  });

  ["fastInitialRefresh", "allowOffHoursFetch", "keepSnapshots"].forEach((id) => {
    bind(id, "change", () => {
      saveState();
      updateSydneyClock();
      if (state.autoRefreshEnabled) scheduleNextAutoRefresh();
      setStatus("刷新与快照策略已保存");
    });
  });

  bind("clearHistory", "click", () => {
    state.history = state.history.filter((item) => safeMarket(item.market || "ASX") !== state.market);
    safeStorage.setItem("decisionHistory", JSON.stringify(state.history));
    renderHistory();
  });

  bind("enableNotifications", "click", toggleNotifications);

  bind("addHolding", "click", () => {
    const ok = upsertHolding({
      symbol: $("holdingSymbol").value,
      qty: $("holdingQty").value,
      avgPrice: $("holdingAvgPrice").value,
      entryDate: $("holdingEntryDate").value || todayIso(),
      source: "manual",
    });
    if (!ok) {
      setStatus("请输入有效持仓代码、数量和均价");
      return;
    }
    $("holdingSymbol").value = "";
    $("holdingQty").value = "";
    $("holdingAvgPrice").value = "";
    $("holdingEntryDate").value = todayIso();
    renderCards();
    renderPortfolioSummary();
    setStatus("持仓已添加/更新");
  });

  const importPortfolioCsv = () => {
    const rows = parsePortfolio($("portfolioCsv").value);
    if (!rows.length) {
      setStatus("未从 CSV 中识别到持仓，请确认包含代码、数量、均价");
      return;
    }
    state.portfolio = mergeHoldings([
      ...state.portfolio.filter((holding) => holding.market !== state.market),
      ...rows,
    ]);
    savePortfolio();
    renderCards();
    renderPortfolioSummary();
    setStatus(`已从 CSV 保存 ${rows.length} 条持仓`);
  };
  bind("loadPortfolio", "click", importPortfolioCsv);
  bind("loadPortfolioCsv", "click", importPortfolioCsv);

  bind("applyPortfolioText", "click", () => {
    const rows = parsePortfolioText($("portfolioOcrText").value);
    if (!rows.length) {
      setStatus("未从文本中识别到持仓，请使用 symbol,qty,avgPrice 格式");
      return;
    }
    state.portfolio = mergeHoldings([...state.portfolio, ...rows]);
    savePortfolio();
    renderCards();
    renderPortfolioSummary();
    setStatus(`已应用 ${rows.length} 条持仓`);
  });

  bind("portfolioImage", "change", importPortfolioImage);
  bind("rebalanceAdvice", "click", () => {
    evaluateAlerts();
    renderPortfolioSummary();
    runRiskAssessment(false);
    setStatus("仓位建议已重新计算");
  });

  bind("refreshAll", "click", refreshAll);
  if (state.autoRefreshEnabled) startAutoRefresh(false);
}

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled async error", event.reason);
  setStatus(`后台模块失败：${compactRuntimeError(event.reason)}；市场切换仍可用`);
});

window.addEventListener("error", (event) => {
  console.error("Unhandled runtime error", event.error || event.message);
  setStatus(`页面模块失败：${compactRuntimeError(event.error || event.message)}；市场切换仍可用`);
});

try {
  boot();
} catch (error) {
  console.error(error);
  setStatus(`页面部分模块启动失败：${error.message}。市场切换仍可用。`);
  const cards = $("cards");
  if (cards && !cards.innerHTML) {
    cards.innerHTML = `<article class="stock-card"><div class="card-top"><h3>启动失败</h3><span class="muted">${error.message}</span></div></article>`;
  }
}
