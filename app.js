function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch (error) {
    console.warn(`Ignoring invalid localStorage.${key}`, error);
    localStorage.removeItem(key);
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

const initialMarket = safeMarket(localStorage.getItem("selectedMarket") || "ASX");
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
  chartRange: localStorage.getItem("chartRange") || "6M",
  chartInterval: "1d",
  chartHoverIndex: null,
  chartExpanded: false,
  autoRefreshTimer: null,
  autoRefreshEnabled: localStorage.getItem("autoRefreshEnabled") === "true",
  nextAutoRefreshAt: null,
  isRefreshing: false,
  aiRefreshToken: 0,
  clockTimer: null,
  snapshotUpdatedAt: localStorage.getItem(`analysisSnapshotTime:${initialMarket}`) || (initialMarket === "ASX" ? localStorage.getItem("analysisSnapshotTime") : null),
  history: Array.isArray(readJsonStorage("decisionHistory", [])) ? readJsonStorage("decisionHistory", []) : [],
  notifiedAlerts: readJsonStorage("notifiedAlerts", {}),
  notificationsEnabled: localStorage.getItem("notificationsEnabled") === "true",
  latestAlerts: [],
  apiCache: new Map(),
  marketCache: new Map(),
  forecastCache: new Map(),
  chartDataCache: new Map(),
  chartLoading: new Set(),
  accuracySummary: null,
  marketIndexes: [],
  marketIndexSignal: null,
  stockPicker: { forecast: [], today: [], rejected: [], failures: [], updatedAt: null },
  agentConfigByMarket: readJsonStorage("agentConfigByMarket", {}),
  agentLedgerByMarket: readJsonStorage("agentLedgerByMarket", {}),
  agentMemoryByMarket: readJsonStorage("agentMemoryByMarket", {}),
  runtimeSettings: readJsonStorage("runtimeSettings", {}),
};

const $ = (id) => document.getElementById(id);
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
  upsideConfidence: 0,
  downsideConfidence: 0,
  direction: "mixed",
  directionAgreement: 0,
  rawConfidence: 0,
  projectedUpside: 0,
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
  return `marketIndexSnapshot:${safeMarket(market)}`;
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
  analysis.predictionConfidence = asNumber(analysis.predictionConfidence, analysis.confidence);
  analysis.upsideConfidence = asNumber(analysis.upsideConfidence, analysis.projectedUpside > 0 ? analysis.confidence : 0);
  analysis.downsideConfidence = asNumber(analysis.downsideConfidence, analysis.projectedUpside < 0 ? analysis.confidence : 0);
  analysis.direction = String(analysis.direction || (analysis.projectedUpside > 0 ? "upside" : analysis.projectedUpside < 0 ? "downside" : "mixed"));
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
  localStorage.setItem("runtimeSettings", JSON.stringify(state.runtimeSettings));
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
  localStorage.setItem("selectedMarket", state.market);
  localStorage.setItem("watchlistsByMarket", JSON.stringify(state.watchlistsByMarket));
  localStorage.setItem("watchlistOriginsByMarket", JSON.stringify(state.watchlistOriginsByMarket));
  localStorage.setItem("watchlist", JSON.stringify(state.watchlist));
  localStorage.setItem("strategy", JSON.stringify(getStrategy()));
  localStorage.setItem("capital", JSON.stringify({ ...getCapital(), baseCapital: asNumber($("totalCapital").value, 0) }));
  localStorage.setItem(`portfolioCsv:${state.market}`, $("portfolioCsv").value);
  localStorage.setItem("portfolioJson", JSON.stringify(state.portfolio));
  localStorage.setItem("portfolioByMarket", JSON.stringify(portfolioByMarketRows()));
  localStorage.setItem("chartRange", state.chartRange);
  localStorage.setItem("chartInterval", "1d");
  localStorage.setItem("autoRefreshEnabled", String(state.autoRefreshEnabled));
  localStorage.setItem("refreshInterval", $("refreshInterval").value);
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
  const savedInterval = asNumber(localStorage.getItem("refreshInterval"), 1800000);
  $("refreshInterval").value = savedInterval >= 3600000 ? "3600000" : "1800000";
  $("portfolioCsv").value = localStorage.getItem(`portfolioCsv:${state.market}`) || holdingsToCsv(activePortfolio()) || activeMarketConfig().samplePortfolio;
  $("holdingEntryDate").value = todayIso();
  syncCapitalFields();
}

function parsePortfolio(csv) {
  const lines = String(csv || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const hasHeader = /symbol|code|股票|代码/i.test(lines[0]);
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows.map((line) => {
    const parts = line.split(/,|\t|\s{2,}/).map((item) => item.trim()).filter(Boolean);
    const [symbol, qty, avgPrice, entryDate] = parts;
    return {
      symbol: normalizeSymbolForMarket(symbol, state.market),
      market: state.market,
      qty: asNumber(qty),
      avgPrice: asNumber(avgPrice),
      entryDate: /^\d{4}-\d{2}-\d{2}$/.test(entryDate || "") ? entryDate : todayIso(),
      source: "csv",
      marketLocked: true,
      explicitMarket: true,
      addedAt: new Date().toISOString(),
    };
  }).filter((row) => row.symbol && row.qty > 0);
}

function parsePortfolioText(text) {
  const holdings = parsePortfolio(text);
  if (holdings.length) return holdings;
  const rows = [];
  const pattern = /\b([A-Z]{1,6}(?:\.[A-Z])?|\d{6})(?:\.A[UX]|\.SS|\.SH|\.SZ|\.SHH|\.SHZ|\.SHE)?\b[^\d]{0,20}([\d,]+(?:\.\d+)?)\D{1,20}(\d+(?:\.\d+)?)/g;
  let match;
  while ((match = pattern.exec(String(text || "").toUpperCase()))) {
    rows.push({
      symbol: normalizeSymbolForMarket(match[1], state.market),
      market: state.market,
      qty: asNumber(match[2].replace(/,/g, "")),
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
  localStorage.setItem(`portfolioCsv:${state.market}`, $("portfolioCsv").value);
  localStorage.setItem("portfolioJson", JSON.stringify(state.portfolio));
  localStorage.setItem("portfolioByMarket", JSON.stringify(portfolioByMarketRows()));
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

function computeHistoricalAnalog(candles, lookback = 15, horizon = 15) {
  const rows = normalizeCandles(candles);
  if (rows.length < lookback * 3 + horizon) {
    return { count: 0, confidence: 0, averageForwardReturn: 0, winRate: 0, examples: [] };
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
    const forwardReturn = pctChange(closes[end + horizon], closes[end]);
    matches.push({
      date: rows[end].date,
      distance: dist,
      forwardReturn,
      close: closes[end],
    });
  }
  const best = matches.sort((a, b) => a.distance - b.distance).slice(0, 8);
  const averageForwardReturn = best.reduce((sum, item) => sum + item.forwardReturn, 0) / best.length;
  const winRate = best.filter((item) => item.forwardReturn > 0).length / best.length * 100;
  const confidence = clamp(35 + winRate * 0.35 + averageForwardReturn * 3 - (best[0]?.distance || 0) * 10, 0, 95);
  const model = computeSelfSupervisedForecast(rows, horizon);
  const blendedReturn = model.sampleCount
    ? averageForwardReturn * 0.55 + model.predictedReturn * 0.45
    : averageForwardReturn;
  const blendedConfidence = model.sampleCount
    ? clamp(confidence * 0.58 + model.confidence * 0.42, 0, 95)
    : confidence;
  return {
    count: best.length,
    confidence: blendedConfidence,
    averageForwardReturn: blendedReturn,
    winRate,
    model,
    examples: best.slice(0, 5),
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

function computeSelfSupervisedForecast(candles, horizon) {
  const rows = normalizeCandles(candles);
  if (rows.length < 95 + horizon) {
    return { sampleCount: 0, predictedReturn: 0, confidence: 0, mae: 0, directionalAccuracy: 0 };
  }
  const latest = rows.at(-1) || {};
  const cacheKey = `${latest.date}:${latest.close}:${latest.volume}:stacked:${horizon}:${rows.length}`;
  const cached = state.forecastCache.get(cacheKey);
  if (cached) return cached;
  const closes = rows.map((row) => row.close);
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
  const samples = [];
  for (let end = 55; end < rows.length - Math.min(...horizons) - 1; end += 1) {
    const x = vectorFor(end);
    horizons.forEach((targetHorizon) => {
      if (end + targetHorizon >= rows.length) return;
      const scale = Math.sqrt(requestedHorizon / targetHorizon);
      samples.push({
        x,
        y: (pctChange(closes[end + targetHorizon], closes[end]) / 10) * scale,
      });
    });
  }
  if (!samples.length) return { sampleCount: 0, predictedReturn: 0, confidence: 0, mae: 0, directionalAccuracy: 0 };
  const weights = Array(samples[0].x.length).fill(0);
  const lr = 0.016;
  const ridge = 0.002;
  for (let epoch = 0; epoch < 42; epoch += 1) {
    for (const sample of samples) {
      const pred = weights.reduce((sum, weight, index) => sum + weight * sample.x[index], 0);
      const error = pred - sample.y;
      for (let index = 0; index < weights.length; index += 1) {
        weights[index] -= lr * (error * sample.x[index] + ridge * weights[index]);
      }
    }
  }
  const predictions = samples.map((sample) => weights.reduce((sum, weight, index) => sum + weight * sample.x[index], 0) * 10);
  const actuals = samples.map((sample) => sample.y * 10);
  const mae = predictions.reduce((sum, prediction, index) => sum + Math.abs(prediction - actuals[index]), 0) / predictions.length;
  const directionalAccuracy = predictions.filter((prediction, index) => Math.sign(prediction) === Math.sign(actuals[index])).length / predictions.length * 100;
  const predictedReturn = weights.reduce((sum, weight, index) => sum + weight * vectorFor(rows.length - 1)[index], 0) * 10;
  const sampleBonus = clamp(Math.log10(samples.length) * 5, 0, 14);
  const confidence = clamp(28 + directionalAccuracy * 0.48 + Math.abs(predictedReturn) * 1.3 - mae * 2.1 + sampleBonus, 0, 95);
  const result = {
    sampleCount: samples.length,
    predictedReturn,
    confidence,
    mae,
    directionalAccuracy,
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

function compactDisplayError(message) {
  return String(message || "读取失败")
    .replace(/HTTP 403[\s\S]*?(?=\||$)/gi, "Provider 403/权限限制")
    .replace(/Thank you for using Alpha Vantage![\s\S]*?(?=\||$)/gi, "Alpha Vantage 免费额度/端点限制")
    .replace(/You exceeded your daily API requests limit[\s\S]*?(?=\||$)/gi, "EODHD 日额度已用尽")
    .replace(/This operation was aborted/g, "请求超时")
    .replace(/Stooq CSV download requires captcha\/API key/g, "Stooq 需要 API key/captcha")
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
  return ["announcements", "shortInterest", "macro", "sector", "flowOptions", "marketRegime", "relativeStrength", "liquidity", "calibration"]
    .reduce((sum, key) => sum + Number(factors[key]?.available === false ? 0 : factors[key]?.score || 0), 0);
}

function factorRows(factors) {
  if (!factors) return [];
  return [
    [state.market === "US" ? "SEC/公告" : "公告", factors.announcements],
    [state.market === "ASX" ? "空头" : "资金/空头", factors.shortInterest],
    ["宏观", factors.macro],
    ["行业", factors.sector],
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

async function fetchChartMarket(symbol, interval) {
  if (interval === "1d") return normalizeCandles(state.analyses.get(symbol)?.candles || []);
  const key = `${state.market}:${symbol}:${interval}`;
  const cached = state.chartDataCache.get(key);
  if (cached && Date.now() - cached.time < 60000) return normalizeCandles(cached.candles);
  const response = await fetch(`/api/market/${encodeURIComponent(symbol)}?market=${encodeURIComponent(state.market)}&range=5d&interval=${encodeURIComponent(interval)}`);
  if (!response.ok) throw new Error((await response.json()).error || `无法读取 ${symbol} ${interval}`);
  const payload = await response.json();
  const candles = normalizeCandles(payload.candles);
  state.chartDataCache.set(key, { time: Date.now(), candles, source: payload.source, warning: payload.warning });
  return candles;
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

function loadMarketIndexSnapshot() {
  const payload = readJsonStorage(indexSnapshotKey(), null);
  if (!payload || payload.market !== state.market || !Array.isArray(payload.rows)) return false;
  const hasUsableIndex = payload.rows.some((row) => !row?.error && Number(row?.close || row?.technicals?.close || 0) > 0);
  if (!hasUsableIndex) {
    localStorage.removeItem(indexSnapshotKey());
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
  localStorage.setItem(indexSnapshotKey(), JSON.stringify(payload));
}

async function fetchIndexMarket(index) {
  const rawCandidates = ["ASX", "US"].includes(state.market) && index.unit === "points"
    ? [index.symbol]
    : [index.symbol, ...(index.fallbackSymbols || [])];
  const candidates = sanitizeSymbolsForMarket(rawCandidates, state.market);
  const errors = [];
  for (const symbol of candidates) {
    try {
      const market = await fetchMarket(symbol);
      return {
        market,
        usedSymbol: symbol,
        fallbackUsed: symbol !== normalizeSymbolForMarket(index.symbol, state.market),
      };
    } catch (error) {
      errors.push(`${symbol}: ${error.message || error}`);
    }
  }
  if (["ASX", "US"].includes(state.market) && index.unit === "points") {
    throw new Error(`${index.label} 现金指数点位暂不可用；真实指数源未返回，已拒绝用 ETF 价格替代点位。${errors.slice(0, 2).join(" | ")}`);
  }
  throw new Error(errors.join(" | ") || `${index.label} 无可用真实指数/ETF代理`);
}

async function refreshMarketIndexes(force = false) {
  const cached = readJsonStorage(indexSnapshotKey(), null);
  const cachedHasUsableIndex = Array.isArray(cached?.rows) && cached.rows.some((row) => !row?.error && Number(row?.close || row?.technicals?.close || 0) > 0);
  if (!force && cached?.market === state.market && cachedHasUsableIndex && Date.now() - new Date(cached.updatedAt || 0).getTime() < 3 * 60 * 1000) {
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
    const quoteOnly = Boolean(market.quoteOnly || candles.length < 25);
    const technicals = computeTechnicals(candles);
    const indexTechnicals = quoteOnly
      ? { ...technicals, change5d: 0, change20d: 0, trendScore: 50, momentumScore: 50, riskScore: 50, projectedUpside: 0 }
      : technicals;
    const analog = quoteOnly ? { count: 0, winRate: 0, averageForwardReturn: 0 } : computeHistoricalAnalog(candles, 15, getStrategy().horizonDays);
    const latest = candles.at(-1) || {};
    const previous = candles.at(-2) || {};
    const quoteChange = Number(market.quote?.changePercent);
    const change1d = Number.isFinite(quoteChange) ? quoteChange : pctChange(latest.close, previous.close);
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
        market.warning || "",
      ].filter(Boolean).join(" | "),
      candles: candles.slice(-260),
      quote: market.quote || null,
      quoteOnly,
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
        error: entry.reason?.message || String(entry.reason || "读取失败"),
      }
  ));
  state.marketIndexes = rows;
  state.marketIndexSignal = indexSignalFromRows(rows);
  saveMarketIndexSnapshot(rows, state.marketIndexSignal);
  renderMarketIndexPanel();
  return rows;
}

async function fetchNews(symbol) {
  try {
    const [macro, stock] = await Promise.all([
      cachedJson(`news:${state.market}:__macro__`, `/api/news?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}&scope=macro`, 10 * 60 * 1000),
      cachedJson(`news:${state.market}:${symbol}:stock`, `/api/news?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}&scope=stock`, 10 * 60 * 1000),
    ]);
    const seen = new Set();
    return [...(macro.news || []), ...(stock.news || [])].filter((item) => {
      const key = `${item.title || ""}|${item.link || ""}`;
      if (!item.title || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    try {
      const payload = await cachedJson(`news:${state.market}:${symbol}`, `/api/news?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}&scope=stock`, 10 * 60 * 1000);
      return payload.news || [];
    } catch {
      return [];
    }
  }
}

function cachedNewsValue(symbol) {
  const macro = cachedSignalValue(`news:${state.market}:__macro__`, { news: [] }).news || [];
  const stock = cachedSignalValue(`news:${state.market}:${symbol}:stock`, { news: [] }).news || [];
  return [...macro, ...stock];
}

async function fetchFundamentals(symbol) {
  try {
    const payload = await cachedJson(`fundamentals:${state.market}:${symbol}`, `/api/fundamentals?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, 60 * 60 * 1000);
    return payload.fundamentals || null;
  } catch {
    return null;
  }
}

async function fetchX(symbol) {
  try {
    const payload = await cachedJson(`x:${state.market}:${symbol}`, `/api/x?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, 10 * 60 * 1000);
    return payload.posts || [];
  } catch {
    return [];
  }
}

async function fetchYouTube(symbol) {
  try {
    const payload = await cachedJson(`youtube:${state.market}:${symbol}`, `/api/youtube?market=${encodeURIComponent(state.market)}&symbol=${encodeURIComponent(symbol)}`, 15 * 60 * 1000);
    return payload.videos || [];
  } catch {
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
  } catch {
    return null;
  }
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
    rawConfidence: Number(analysis.rawConfidence ?? analysis.confidence ?? 0),
    projectedUpside: Number(analysis.projectedUpside || 0),
    action: analysis.action,
    source: item.source || "unknown",
    calibration: analysis.calibration || null,
    ensemble: analysis.ensemble ? {
      direction: analysis.ensemble.direction,
      upsideAgreement: Number(analysis.ensemble.upsideAgreement || 0),
      consensusAgreement: Number(analysis.ensemble.consensusAgreement || 0),
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
      volume: technicals.volumeScore,
      risk: technicals.riskScore,
      factor: factorTotal(item.factors),
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
      localStorage.removeItem(key);
      return;
    }
    const selected = normalizeSymbolForMarket(payload.selected, state.market) === normalized
      ? normalizeSymbolForMarket(watchlist[0] || analyses[0]?.symbol, state.market)
      : payload.selected;
    localStorage.setItem(key, JSON.stringify({
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
    localStorage.removeItem(snapshotTimeKey());
    if (state.market === "ASX") localStorage.removeItem("analysisSnapshotTime");
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
  return Boolean(item?.result && (item.result.news?.length || item.result.factors));
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
    localStorage.setItem(snapshotKey(), JSON.stringify(payload));
    localStorage.setItem(snapshotTimeKey(), updatedAt);
    if (state.market === "ASX") localStorage.setItem("analysisSnapshotTime", updatedAt);
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
  state.snapshotUpdatedAt = snapshot.updatedAt || snapshot.savedAt || localStorage.getItem(snapshotTimeKey());
  return true;
}

function restoreAnalysisSnapshot() {
  if (!snapshotsEnabled()) return false;
  try {
    const payload = JSON.parse(localStorage.getItem(snapshotKey()) || (state.market === "ASX" ? localStorage.getItem(SNAPSHOT_KEY) : "null") || "null");
    const restored = applySnapshotPayload(payload);
    if (!restored && payload) {
      localStorage.removeItem(snapshotKey());
      localStorage.removeItem(snapshotTimeKey());
      state.snapshotUpdatedAt = null;
    }
    return restored;
  } catch (error) {
    console.warn("Unable to restore analysis snapshot", error);
    localStorage.removeItem(snapshotKey());
    localStorage.removeItem(snapshotTimeKey());
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
    localStorage.setItem(snapshotKey(), JSON.stringify(payload));
    localStorage.setItem(snapshotTimeKey(), state.snapshotUpdatedAt || "");
    evaluateAlerts();
    renderCards();
    renderPortfolioSummary();
    renderDetail();
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
    renderCards();
    renderPortfolioSummary();
    renderDetail();
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
    marketValidation: market.validation,
    calibrationSummary: state.accuracySummary,
  };
}

function signalTimeouts(options = {}) {
  if (options.backgroundSignals) {
    return { news: 6500, fundamentals: 2600, x: 3200, youtube: 3200, factors: 7000 };
  }
  return { news: 2800, fundamentals: 1600, x: 1300, youtube: 1300, factors: 3600 };
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
  const [news, fundamentals, xPosts, youtubeItems, factors] = includeSignals
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
  const results = preparedItems.map((item, index) => {
    const expected = normalizeSymbolForMarket(item.symbol, state.market);
    const indexed = rows[index];
    const indexedSymbol = normalizeSymbolForMarket(indexed?.symbol, state.market);
    const row = bySymbol.get(expected) || (indexedSymbol === expected ? indexed : null);
    if (!row?.analysis) throw new Error(`${item.symbol} 未返回 AI 分析`);
    return {
      ...item.result,
      symbol: expected,
      market: state.market,
      analysis: row.analysis,
      source: row.source || payload.source,
    };
  });
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

async function runBackgroundSignalAi(preparedItems, token) {
  const enrichedSettled = await Promise.allSettled(preparedItems.map((item) => (
    preparedHasSignals(item) ? item : prepareSymbol(item.symbol, { includeSignals: true, backgroundSignals: true })
  )));
  if (state.aiRefreshToken !== token) return;
  const enriched = enrichedSettled.map((entry, index) => entry.status === "fulfilled" ? entry.value : preparedItems[index]);
  const results = await requestBatchAnalysis(enriched, { commit: false });
  if (state.aiRefreshToken !== token) return;
  const adjusted = commitAnalysisResults(results, { agentStep: false });
  const buyAlerts = adjusted.filter((item) => isBuyAction(item.analysis?.action)).length;
  renderCards();
  renderPortfolioSummary();
  renderDetail();
  setStatus(`后台新闻/AI 复核完成：${buyAlerts} 个买入/轻仓关注提醒`);
}

function saveDecision(item) {
  const technicals = normalizeTechnicals(item.technicals);
  const analysis = normalizeAnalysis(item.analysis);
  const targetPrice = technicals.close * (1 + Number(analysis.projectedUpside || 0) / 100);
  const record = {
    id: `${Date.now()}-${state.market}-${item.symbol}`,
    time: new Date().toISOString(),
    market: state.market,
    symbol: item.symbol,
    action: analysis.action,
    price: technicals.close,
    expectedPrice: targetPrice,
    confidence: analysis.confidence,
    projectedUpside: analysis.projectedUpside,
    suggestedTradeValue: analysis.suggestedTradeValue || 0,
  };
  state.history.unshift(record);
  state.history = state.history.slice(0, 60);
  localStorage.setItem("decisionHistory", JSON.stringify(state.history));
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
        <span>${actionLabel(item.action)} · ${item.qty ? `${item.qty} 股 · ` : ""}成交 ${formatMoney(item.price)}${Number.isFinite(Number(item.realizedPnl)) && item.action?.startsWith("SELL") ? ` · 实现盈亏 ${formatMoney(item.realizedPnl)}` : ` · 期望 ${formatMoney(item.expectedPrice)} · ${Math.round(item.confidence)}%`}</span>
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
    localStorage.setItem("notifiedAlerts", JSON.stringify(state.notifiedAlerts));
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
    localStorage.setItem("notificationsEnabled", "false");
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
  localStorage.setItem("notificationsEnabled", String(state.notificationsEnabled));
  renderNotificationButton();
  setStatus(state.notificationsEnabled ? "系统提醒已开启" : "系统提醒未授权");
}

function evaluateAlerts() {
  const strategy = getStrategy();
  const alerts = [];
  [...state.analyses.values()].forEach((item) => {
    if (!isBuyAction(item.analysis?.action)) return;
    const holding = findHolding(item.symbol);
    const strict = item.analysis.action === "STRONG_BUY";
    alerts.push({
      type: holding ? "ADD" : "BUY",
      symbol: item.symbol,
      severity: "buy",
      title: `${item.symbol} ${strict ? "强买入" : holding ? "补仓观察" : item.analysis.action === "LIGHT_BUY" ? "轻仓关注" : "买入提醒"}`,
      message: `预测可靠度 ${Math.round(item.analysis.confidence)}%，上涨倾向 ${Math.round(item.analysis.upsideConfidence || 0)}%，预估 ${formatPct(item.analysis.projectedUpside)}，建议票额 ${formatMoney(item.analysis.suggestedTradeValue || 0)}。`,
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
    const downsideConfidence = Number(item.analysis?.downsideConfidence || 0);
    const severeModelRisk = item.analysis?.action === "CRITICAL_SELL"
      || item.analysis?.action === "STRONG_AVOID"
      || (downsideConfidence >= Math.max(70, Number(strategy.confidence || 80) - 5) && Number(item.analysis?.projectedUpside || 0) <= -Math.max(2.5, Number(strategy.stopLoss || 4) * 0.65));
    if (severeModelRisk) {
      alerts.push({
        type: "SELL_CRITICAL_MODEL",
        symbol: holding.symbol,
        severity: "sell",
        title: `${holding.symbol} 最严卖出警报`,
        message: `模型判断下跌风险高：下跌倾向 ${Math.round(downsideConfidence)}%，预估 ${formatPct(item.analysis.projectedUpside || 0)}，建议立即复核卖出/减仓。`,
      });
      return;
    }
    const memory = item.analysis?.forecastMemory || {};
    const downgradeFromPriorBuy = memory.previousPositive && (
      isRiskAction(item.analysis.action) ||
      Number(item.analysis.projectedUpside || 0) < Number(strategy.targetUpside || 5) * 0.25 ||
      Number(item.analysis.confidence || 0) < Number(strategy.confidence || 80) * 0.62
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
    if (daysLeft <= 2 && (isRiskAction(item.analysis.action) || item.analysis.projectedUpside < 0 || item.analysis.confidence < strategy.confidence * 0.68)) {
      alerts.push({
        type: "SELL_REVIEW",
        symbol: holding.symbol,
        severity: "sell",
        title: `${holding.symbol} 周期到期卖出复核`,
        message: `已持有 ${days} 天，距离策略周期 ${Math.max(0, daysLeft)} 天，后市风险偏高，建议复核卖出。`,
      });
      return;
    }
    if (daysLeft <= 2 && item.analysis.projectedUpside >= strategy.targetUpside && item.analysis.confidence >= strategy.confidence) {
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
          <button class="secondary mini-btn" type="button" data-reduce-holding="${holding.symbol}">减仓</button>
        </div>
      `;
    }).join("")}
  `;
  target.querySelectorAll("[data-reduce-holding]").forEach((button) => {
    button.addEventListener("click", () => {
      const symbol = button.dataset.reduceHolding;
      state.selected = symbol;
      if (!state.analyses.has(symbol)) {
        setStatus(`${symbol} 已选中，请刷新后在详情里设置减仓数量和成交价`);
      }
      renderDetail();
    });
  });
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
      const score = (item.analysis.confidence * 0.55 + item.analysis.projectedUpside * 7) * diversificationPenalty * riskPenalty;
      const capacity = Math.max(0, maxPerStock - currentValue);
      return { item, holding, sector, score, capacity };
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
          <span>建议 ${formatMoney(suggested)}，置信 ${Math.round(row.item.analysis.confidence)}%，预估 ${formatPct(row.item.analysis.projectedUpside)}，剩余单票容量 ${formatMoney(row.capacity)}。</span>
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
  if (!curve.length) return `<p class="muted">还没有已验证样本形成曲线；旧预测到期后会自动绘制滚动命中率。</p>`;
  const rows = curve.slice(-24);
  return `
    <div class="learning-chart" aria-label="滚动命中率">
      ${rows.map((point) => {
        const hit = point.hitRate == null ? 0 : clamp(Number(point.hitRate), 3, 100);
        const buy = point.buyHitRate == null ? hit : clamp(Number(point.buyHitRate), 3, 100);
        return `
          <div class="learning-bar" title="${point.date} ${point.symbol} · 总体 ${pctOrPending(point.hitRate)} · 买入 ${pctOrPending(point.buyHitRate)}">
            <i style="height:${hit}%"></i>
            <b style="height:${buy}%"></b>
          </div>
        `;
      }).join("")}
    </div>
    <div class="learning-legend">
      <span><i class="legend-hit"></i>滚动总体命中率</span>
      <span><i class="legend-buy"></i>滚动买入命中率</span>
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
        <p>样本 ${baseline.samples || 0} · 买入 ${pctOrPending(baseline.buyHitRate)} · Brier ${baseline.brierScore == null ? "n/a" : Number(baseline.brierScore).toFixed(3)}</p>
      </div>
      <div>
        <span>近期窗口</span>
        <strong>${pctOrPending(recent.hitRate)}</strong>
        <p>样本 ${recent.samples || 0} · 买入 ${pctOrPending(recent.buyHitRate)} · Brier ${recent.brierScore == null ? "n/a" : Number(recent.brierScore).toFixed(3)}</p>
      </div>
      <div>
        <span>阶段改善</span>
        <strong>${ready ? deltaText(improvement.hitRateDelta) : "收集中"}</strong>
        <p>买入 ${ready ? deltaText(improvement.buyHitRateDelta) : "样本不足"} · Brier ${ready ? deltaText(improvement.brierDelta, 3, "") : "样本不足"} · 收益 ${ready ? deltaText(improvement.avgReturnDelta, 2) : "样本不足"}</p>
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
          <p>预测 ${formatPct(event.projectedUpside)} / 可靠度 ${Math.round(event.confidence || 0)}%；实际 ${event.actualReturn == null ? "未完成" : formatPct(event.actualReturn)}，最大回撤 ${event.drawdown == null ? "n/a" : formatPct(event.drawdown)}。</p>
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
  const adaptive = summary.adaptive || {};
  const horizonRows = Object.values(summary.horizonStats || adaptive.horizonStats || {}).filter((row) => row.total > 0);
  const patternRows = Object.values(adaptive.patternStats || {})
    .filter((row) => row.total > 0)
    .sort((a, b) => Number(b.confidencePenalty || 0) - Number(a.confidencePenalty || 0))
    .slice(0, 8);
  const recent = summary.recent || [];
  const overviewHtml = `
    <div class="learning-head">
      <div>
        <h3>预测学习曲线</h3>
        <p>旧预测不会被新预测覆盖；到期、触及目标或止损后会进入滚动命中率，并反向调整后续模型。</p>
      </div>
      <span>${summary.updatedAt ? new Date(summary.updatedAt).toLocaleString() : "刚刚更新"}</span>
    </div>
    ${learningCurveHtml(summary.learningCurve || [])}
    ${improvementHtml(summary.improvement || {})}
    <div class="accuracy-grid">
      <div class="accuracy-metric"><span>样本 / 已验证</span><strong>${summary.total || 0} / ${summary.resolved || 0}</strong></div>
      <div class="accuracy-metric"><span>总体命中率</span><strong>${pctOrPending(summary.hitRate)}</strong></div>
      <div class="accuracy-metric"><span>买入信号命中</span><strong>${pctOrPending(summary.buyHitRate)}</strong></div>
      <div class="accuracy-metric"><span>平均收益</span><strong>${summary.avgForwardReturn == null ? "样本不足" : formatPct(summary.avgForwardReturn)}</strong></div>
      <div class="accuracy-metric"><span>自适应扣分</span><strong>${numberOrPending(adaptive.confidencePenalty, 1)}%</strong></div>
      <div class="accuracy-metric"><span>涨幅收缩</span><strong>${adaptive.upsideShrink ? `${Math.round(adaptive.upsideShrink * 100)}%` : "样本不足"}</strong></div>
      <div class="accuracy-metric"><span>Brier Score</span><strong>${numberOrPending(summary.brierScore, 3)}</strong></div>
      <div class="accuracy-metric"><span>盈亏因子</span><strong>${ratioOrPending(summary.profitFactor, summary.profitFactorNoLosses)}</strong></div>
      <div class="accuracy-metric"><span>盈亏比</span><strong>${ratioOrPending(summary.payoffRatio)}</strong></div>
      <div class="accuracy-metric"><span>最大不利回撤</span><strong>${summary.maxAdverseDrawdown == null ? "样本不足" : formatPct(summary.maxAdverseDrawdown)}</strong></div>
      <div class="accuracy-metric"><span>平均最大回撤</span><strong>${summary.avgMaxDrawdown == null ? "样本不足" : formatPct(summary.avgMaxDrawdown)}</strong></div>
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
            <span>命中 ${pctOrPending(row.hitRate)}</span>
            <span>买入命中 ${pctOrPending(row.buyHitRate)}</span>
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
            <span>买入命中 ${pctOrPending(row.buyHitRate)}</span>
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
            <span>命中 ${pctOrPending(bucket.hitRate)}</span>
            <span>均值 ${bucket.avgReturn == null ? "n/a" : formatPct(bucket.avgReturn)}</span>
            <span>Brier ${bucket.brierScore == null ? "n/a" : Number(bucket.brierScore).toFixed(3)}</span>
            <span>回撤 ${bucket.maxDrawdown == null ? "n/a" : formatPct(bucket.maxDrawdown)}</span>
          </div>
        `).join("") : `<p class="muted">还没有完成持仓周期的样本；后续刷新会自动给旧预测打标签。</p>`}
      </div>
    </div>
    <div class="learning-section">
      <h4>最近预测样本</h4>
      <div class="sample-list">
        ${recent.length ? recent.map((sample) => `
          <div class="sample-row">
            <strong>${sample.symbol}</strong>
            <span>${sample.asOfDate}</span>
            <span>可靠度 ${Math.round(sample.predictionConfidence ?? sample.confidence ?? 0)}% · 预估 ${formatPct(sample.projectedUpside || 0)}</span>
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
        <summary><span>周期与校准</span><strong>${horizonRows.length + patternRows.length + buckets.length} 组</strong></summary>
        <div class="learning-window-body">${performanceHtml}</div>
      </details>
    </div>
  `;
}

function renderMarketIndexPanel() {
  const target = $("marketIndexPanel");
  if (!target) return;
  const rows = state.marketIndexes || [];
  const signal = state.marketIndexSignal || indexSignalFromRows(rows);
  const sourceNote = state.market === "ASX"
    ? "澳股只显示现金指数点位；优先用 ASX 官方点位，历史K线源不可用时也不会用 STW/VAS/IOZ ETF 价格替代。"
    : state.market === "US"
      ? "美股只显示现金指数点位；优先用真实指数点位，历史K线源不可用时也不会用 SPY/QQQ/DIA ETF 价格替代。"
      : "A股使用上证、深证、创业板官方指数代码。";
  target.innerHTML = `
    <div class="market-signal ${signal.stance}">
      <strong>${signal.stance === "risk-on" ? "大盘偏强" : signal.stance === "risk-off" ? "大盘偏弱" : "大盘震荡"}</strong>
      <span>综合分 ${Number(signal.score || 0).toFixed(1)} · 1日 ${formatPct(signal.avg1d || 0)} · 5日 ${formatPct(signal.avg5d || 0)} · 20日 ${formatPct(signal.avg20d || 0)}</span>
      <small>${sourceNote}</small>
    </div>
    ${(rows.length ? rows : activeMarketConfig().indexes || []).map((row) => row.error ? `
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
        <div class="index-actions">
          <button class="secondary mini-btn" type="button" data-index-chart="${row.symbol}" ${row.candles?.length ? "" : "disabled"}>K线</button>
        </div>
        <p>${row.latestDate || ""} · ${row.source || "等待行情源"}${row.warning ? ` · ${row.warning}` : ""}</p>
      </article>
    `).join("")}
  `;
  target.querySelectorAll("[data-index-chart]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = (state.marketIndexes || []).find((item) => item.symbol === button.dataset.indexChart);
      if (!row?.candles?.length) {
        setStatus(`${button.dataset.indexChart} 指数K线需要先更新大盘`);
        return;
      }
      openChartModal({
        ...row,
        symbol: row.symbol,
        analysis: { action: "HOLD_WATCH", confidence: row.confidence || 0, projectedUpside: row.projectedUpside || 0 },
        marketSource: row.source,
      });
    });
  });
}

function universeForMarket() {
  return sanitizeSymbolsForMarket(MARKET_UNIVERSES[state.market] || activeMarketConfig().defaultSymbols, state.market);
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
  const ensemble = analysis.ensemble || {};
  return realTimeMove * 4.2
    + technicals.volumeRatio * 8
    + (technicals.momentumScore - 50) * 0.42
    + (technicals.trendScore - 50) * 0.18
    + Math.max(0, technicals.macdHistogram) * 18
    + reliability * 0.08
    + Number(ensemble.consensusAgreement || 0) * 0.06
    - Number(analysis.downsideConfidence || 0) * 0.08;
}

function predictionReliability(analysis) {
  return Number(analysis.predictionConfidence ?? analysis.confidence ?? 0);
}

function pickQualityGrade(item, mode = "forecast") {
  const analysis = normalizeAnalysis(item.analysis);
  const ensemble = analysis.ensemble || {};
  const projected = Number(analysis.projectedUpside || 0);
  const reliability = predictionReliability(analysis);
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upside = Number(ensemble.upsideAgreement || 0);
  const score = (mode === "today" ? todayPickScore(item) : forecastPickScore(item));
  if (reliability >= 72 && projected >= Math.max(1.5, Number(getStrategy().targetUpside || 5) * 0.7) && consensus >= 68 && upside >= 60) return "A";
  if (reliability >= 60 && projected > 0.8 && consensus >= 58 && upside >= 52) return "B";
  return score > 12 ? "C" : "观察";
}

function forecastPickScore(item) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const factorScore = factorTotal(item.factors);
  const ensemble = analysis.ensemble || {};
  const qualityGate = analysis.qualityGate || {};
  const reliability = predictionReliability(analysis);
  const adaptivePenalty = Number(ensemble.adaptivePenalty || analysis.adaptiveLearning?.confidencePenalty || 0);
  const downside = Number(analysis.downsideConfidence || 0);
  return reliability * 0.32
    + Math.max(0, analysis.projectedUpside) * 8.5
    + Number(ensemble.consensusAgreement || 0) * 0.11
    + Number(ensemble.upsideAgreement || 0) * 0.11
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
  const projected = Number(analysis.projectedUpside || 0);
  const ensemble = analysis.ensemble || {};
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const gate = analysis.qualityGate || {};
  const minReliability = Math.max(52, Math.min(74, Number(strategy.confidence || 80) - 18));
  if (projected < (mode === "today" ? 0.25 : Math.max(0.8, target * 0.35))) return `预估涨幅不足：${formatPct(projected)}`;
  if (reliability < minReliability) return `预测可靠度不足：${Math.round(reliability)}%`;
  if (gate.buyEligible === false && reliability < Number(strategy.confidence || 80)) return "质量闸门未通过";
  if (consensus && consensus < (mode === "today" ? 50 : 55)) return `模型共识偏低：${Math.round(consensus)}%`;
  if (upsideAgreement && upsideAgreement < (mode === "today" ? 48 : 52)) return `上涨一致度偏低：${Math.round(upsideAgreement)}%`;
  if (Number(analysis.downsideConfidence || 0) > reliability + 8) return "下跌置信度高于上涨判断";
  if (mode === "today" && todayPickScore(item) < 7 && technicals.volumeRatio < 1.12) return "当日强度/量能不足";
  return "";
}

function isForecastPickCandidate(item) {
  return !pickRejectReason(item, "forecast");
}

function isTodayStrongCandidate(item) {
  return !pickRejectReason(item, "today");
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
  const ensemble = analysis.ensemble || {};
  return `
    <div class="pick-row">
      <strong>${symbol}<small>${grade}</small></strong>
      <span>
        ${formatMoney(technicals.close)} · 可靠度 ${Math.round(reliability)}% · 预估 ${formatPct(analysis.projectedUpside)}
        <p>评分 ${score.toFixed(1)} · 共识 ${Math.round(ensemble.consensusAgreement || 0)}% · 上涨一致 ${Math.round(ensemble.upsideAgreement || 0)}% · 5日 ${formatPct(technicals.change5d)} · 量比 ${technicals.volumeRatio.toFixed(2)}</p>
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
    <p class="muted small-text">更新时间 ${state.stockPicker.updatedAt ? new Date(state.stockPicker.updatedAt).toLocaleString() : "刚刚"}。这版不会为了凑满Top${AI_PICK_COUNT}塞入低质量或预估下跌股票；新闻/因子会在加入监控后继续后台复核。</p>
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

async function runAiStockPicker() {
  const button = $("aiPickStocks");
  if (button) button.disabled = true;
  const universe = universeForMarket();
  const prepared = [];
  const failures = [];
  setStatus(`AI选股开始：扫描 ${universe.length} 只${activeMarketConfig().label}核心股票`);
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
    const adjusted = results
      .map(applyPostModelAdjustments)
      .map((item) => ({ ...item, symbol: normalizeSymbolForMarket(item.symbol, state.market), market: state.market }))
      .filter((item) => item.symbol && allowed.has(item.symbol));
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
    const forecast = adjusted
      .filter(isForecastPickCandidate)
      .sort((a, b) => forecastPickScore(b) - forecastPickScore(a))
      .slice(0, AI_PICK_COUNT);
    const forecastSymbols = new Set(forecast.map((item) => item.symbol));
    const today = adjusted
      .filter((item) => !forecastSymbols.has(item.symbol))
      .filter(isTodayStrongCandidate)
      .sort((a, b) => todayPickScore(b) - todayPickScore(a))
      .slice(0, AI_PICK_COUNT);
    state.stockPicker = {
      forecast,
      today,
      rejected,
      failures: failures.slice(0, 12),
      updatedAt: new Date().toISOString(),
    };
    renderAiPickPanel();
    setStatus(`AI选股完成：后市Top${forecast.length}和今日强势Top${today.length}已生成；${rejected.length} 只因可靠度/共识/涨幅/风险未达标被拒绝${aiFallback}${failures.length ? `；${failures.length} 只候选读取失败` : ""}`);
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
  localStorage.setItem("agentConfigByMarket", JSON.stringify(state.agentConfigByMarket));
  localStorage.setItem("agentLedgerByMarket", JSON.stringify(state.agentLedgerByMarket));
  localStorage.setItem("agentMemoryByMarket", JSON.stringify(state.agentMemoryByMarket));
}

function emptyAgentMemory(market = state.market) {
  return {
    market: safeMarket(market),
    updatedAt: new Date().toISOString(),
    archives: [],
    agents: {},
    strategyBook: {},
    symbolBias: {},
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
  memory.totalReplayTrades = asNumber(memory.totalReplayTrades, 0);
  memory.totalPaperTrades = asNumber(memory.totalPaperTrades, 0);
  state.agentMemoryByMarket[key] = memory;
  return memory;
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
];

function strategyEntryMatches(candidate, candles, end) {
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
  if (candidate.maxChange5d != null && technicals.change5d > candidate.maxChange5d) return false;
  if (candidate.style === "momentum" && technicals.macdHistogram < -0.02) return false;
  return true;
}

function simulateStrategyCandidate(candles, candidate, strategy) {
  const rows = normalizeCandles(candles).slice(-220);
  if (rows.length < 75) return { trades: 0, wins: 0, avgReturn: 0, maxDrawdown: 0, score: -99 };
  const target = Math.max(1.2, Number(strategy.targetUpside || 5) * candidate.takeProfitScale);
  const stop = Math.max(1, Math.abs(Number(strategy.stopLoss || 4)) * candidate.stopScale);
  const maxHold = Math.max(2, Math.round(Number(strategy.horizonDays || 15) * candidate.holdScale));
  const returns = [];
  let wins = 0;
  let maxDrawdown = 0;
  for (let end = 55; end < rows.length - maxHold - 1; end += 1) {
    if (!strategyEntryMatches(candidate, rows, end)) continue;
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
    const tradeReturn = pctChange(exit, entry);
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

function trainAgentsWithHistoricalReplay(ledger, results = []) {
  const strategy = getStrategy();
  ledger.agents.forEach((agent) => {
    agent.strategyBook = agent.strategyBook || {};
    results.forEach((item) => {
      if (!Array.isArray(item.candles) || item.candles.length < 75) return;
      AGENT_STRATEGY_CANDIDATES
        .filter((candidate) => candidate.style === agent.style || agent.style === "momentum")
        .forEach((candidate) => mergeStrategyResult(agent.strategyBook, candidate, simulateStrategyCandidate(item.candles, candidate, strategy), item.symbol));
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

function agentDecisionScore(agent, item) {
  const analysis = normalizeAnalysis(item.analysis);
  const technicals = normalizeTechnicals(item.technicals);
  const marketBias = Number(state.marketIndexSignal?.score || 0);
  const learnedBias = Number(agent.learning?.symbolBias?.[item.symbol] || 0) + Number(agent.learning?.confidenceBias || 0);
  if (agent.style === "reversion") {
    return clamp(
      46 + (50 - technicals.rsi) * 0.75 + analysis.projectedUpside * 3.2 + (analysis.confidence - 55) * 0.28 + marketBias * 0.8 + learnedBias,
      0,
      100
    );
  }
  return clamp(
    38 + (analysis.confidence - 50) * 0.58 + analysis.projectedUpside * 4.2 + (technicals.trendScore - 50) * 0.24 + (technicals.volumeRatio - 1) * 8 + marketBias * 0.9 + learnedBias,
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
  const value = position.qty * price;
  const pnlPct = pctChange(price, position.avgPrice);
  agent.cash += value;
  delete agent.positions[symbol];
  agent.learning.symbolBias[symbol] = clamp(Number(agent.learning.symbolBias[symbol] || 0) + (pnlPct > 0 ? 0.9 : -1.1), -6, 6);
  pushAgentTrade(agent, {
    time: new Date().toISOString(),
    side: "SELL",
    symbol,
    qty: position.qty,
    price,
    pnlPct,
    reason,
  });
}

function buyAgentPosition(agent, item, score) {
  const technicals = normalizeTechnicals(item.technicals);
  const price = technicals.close;
  if (!price || price <= 0 || agent.cash < price) return;
  const maxPositionValue = Math.max(agent.equity * 0.16, agent.initialCapital * 0.06);
  const currentValue = (agent.positions[item.symbol]?.qty || 0) * price;
  if (currentValue >= maxPositionValue) return;
  const ticket = Math.min(agent.cash * 0.18, agent.equity * 0.045 * Number(agent.learning?.aggressiveness || 1), maxPositionValue - currentValue);
  const qty = Math.floor(ticket / price);
  if (qty <= 0) return;
  const existing = agent.positions[item.symbol];
  if (existing) {
    const totalQty = existing.qty + qty;
    existing.avgPrice = ((existing.avgPrice * existing.qty) + (price * qty)) / totalQty;
    existing.qty = totalQty;
    existing.lastPrice = price;
  } else {
    agent.positions[item.symbol] = { qty, avgPrice: price, lastPrice: price, openedAt: new Date().toISOString() };
  }
  agent.cash -= qty * price;
  pushAgentTrade(agent, {
    time: new Date().toISOString(),
    side: "BUY",
    symbol: item.symbol,
    qty,
    price,
    pnlPct: 0,
    reason: `score ${score.toFixed(1)}`,
  });
}

function trainAgentsWithResults(results = []) {
  const ledger = getAgentLedger();
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
      if (pnlPct <= -Math.abs(getStrategy().stopLoss || 4) || pnlPct >= Math.max(1.5, getStrategy().targetUpside * 0.55) || score < 46 || heldDays > getStrategy().horizonDays * 0.85) {
        sellAgentPosition(agent, symbol, price, pnlPct <= -Math.abs(getStrategy().stopLoss || 4) ? "stop" : score < 46 ? "signal-exit" : "take-profit/time");
      }
    });
    results.forEach((item) => {
      if (item.analysis?.action === "ERROR") return;
      const score = agentDecisionScore(agent, item);
      if (score >= (agent.style === "momentum" ? 60 : 56)) buyAgentPosition(agent, item, score);
    });
    markAgentToMarket(agent);
    agent.previousEquity = agent.equity;
  });
  ledger.updatedAt = new Date().toISOString();
  state.agentLedgerByMarket[state.market] = ledger;
  persistAgentMemoryFromLedger(ledger, "training");
  saveAgentState();
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
  localStorage.setItem(forecastMemoryKey(), JSON.stringify(memory || {}));
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
      confidence: analysis.confidence,
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
  const gateBlocked = gate.blocked === true || gate.buyEligible === false;
  const ensemble = analysis.ensemble || {};
  const consensusOk = !ensemble.consensusAgreement || Number(ensemble.consensusAgreement || 0) >= 60;
  const upsideOk = !ensemble.upsideAgreement || Number(ensemble.upsideAgreement || 0) >= 56;
  const downsideConfidence = Number(analysis.downsideConfidence || (analysis.projectedUpside < 0 ? analysis.confidence : 0));
  const stopLoss = Math.abs(Number(strategy.stopLoss || 4));
  const severeDownside = analysis.projectedUpside <= -Math.max(stopLoss, 4)
    || (downsideConfidence >= Math.max(70, Number(strategy.confidence || 80) - 5) && analysis.projectedUpside <= -Math.max(2.5, stopLoss * 0.65));
  if (severeDownside) return "STRONG_AVOID";
  if (!gateBlocked && consensusOk && upsideOk && analysis.confidence >= minConfidence + 8 && analysis.projectedUpside >= Number(strategy.targetUpside || 5) * 1.35) return "STRONG_BUY";
  if (!gateBlocked && consensusOk && upsideOk && analysis.confidence >= minConfidence && analysis.projectedUpside >= strategy.targetUpside) return "WATCH_BUY";
  if (!gateBlocked && analysis.confidence >= Math.max(52, minConfidence - 12) && analysis.projectedUpside >= Math.max(0.8, Number(strategy.targetUpside || 5) * 0.45)) return "LIGHT_BUY";
  if (analysis.confidence <= 42 || analysis.projectedUpside <= -1.2) return "AVOID_OR_REDUCE";
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
  if (projectedUpside > 0) {
    const cap = Number(gate.projectedUpsideCap || (
      consensus >= 78 && upsideAgreement >= 65 ? target * 1.55 : consensus >= 65 ? target * 1.25 : target * 0.95
    ));
    projectedUpside = Math.min(projectedUpside, cap);
  } else {
    projectedUpside = Math.max(projectedUpside, -Math.max(4, target * 1.25));
  }
  if (gate.confidenceCap != null) confidence = Math.min(confidence, Number(gate.confidenceCap));
  if (consensus && consensus < 58) confidence = Math.min(confidence, 62);
  else if (consensus && consensus < 66) confidence = Math.min(confidence, 75);
  if (disagreement > 6) confidence = Math.min(confidence, 78);
  const blocked = gate.blocked === true || gate.buyEligible === false || (consensus && consensus < 60) || (upsideAgreement && upsideAgreement < 56);
  const finalConfidence = clamp(Math.round(confidence), 0, 99);
  const finalProjected = Number(projectedUpside.toFixed(2));
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
    upsideConfidence,
    downsideConfidence,
    direction: finalProjected < -0.35 ? "downside" : finalProjected > 0.35 ? "upside" : analysis.direction || "mixed",
    projectedUpside: finalProjected,
    qualityGate: {
      ...gate,
      blocked,
      buyEligible: !blocked,
      minTradeConfidence: Math.max(Number(strategy.confidence || 80), Number(gate.minTradeConfidence || 72)),
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
  const projectedUpside = Number(analysis.projectedUpside || 0);
  const targetUpside = Math.max(1, Number(strategy.targetUpside || 5));
  const horizon = clientHorizonBucket(analysis.horizonDays || strategy.horizonDays);
  const newsCount = Number(result.news?.length || 0) + Number(result.xPosts?.length || 0) + Number(result.youtubeItems?.length || 0);
  const factorCount = factorRows(result.factors).filter(([, factor]) => factor?.available !== false).length;
  const factorScore = factorTotal(result.factors);
  const analog = Number(result.analog?.confidence || 0);
  const trend = Number(technicals.trendScore || 0);
  const momentum = Number(technicals.momentumScore || 0);
  const volume = Number(technicals.volumeScore || 0);
  const consensus = Number(ensemble.consensusAgreement || 0);
  const upsideAgreement = Number(ensemble.upsideAgreement || 0);
  const positive = isBuyAction(analysis.action) || projectedUpside > 0 || confidence >= 65;
  const keys = [];

  if (!positive) return keys;
  if (confidence >= 72 && newsCount <= 1 && factorCount <= 1) {
    keys.push("thin-evidence-high-confidence", `${horizon}-thin-evidence-high-confidence`);
  }
  if ((trend >= 60 || momentum >= 60) && volume > 0 && volume < 52) {
    keys.push("strong-momentum-weak-volume");
    if (projectedUpside >= targetUpside) keys.push("target-with-weak-volume");
  }
  if (ensemble.direction === "upside" && consensus >= 65 && volume > 0 && volume < 55) {
    keys.push("upside-consensus-weak-volume");
  }
  if (factorScore > 0 && factorScore < 45 && confidence >= 62) keys.push("factor-weak-positive");
  if (analog > 0 && analog < 45 && projectedUpside > 0) keys.push("analog-weak-positive");
  if (confidence >= 72 && consensus > 0 && consensus < 62) keys.push("low-consensus-high-confidence");
  if (projectedUpside >= targetUpside * 1.25 && confidence >= 65) {
    keys.push("aggressive-upside-target", `${horizon}-aggressive-upside-target`);
  }
  if (upsideAgreement >= 65 && newsCount <= 1) keys.push("model-consensus-thin-news");
  if (confidence >= 70 && projectedUpside >= targetUpside && newsCount <= 1) keys.push("target-thin-news");
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
  const horizonPenalty = horizon.resolved >= 4 && horizon.buyHitRate != null && Number(horizon.buyHitRate) < 55
    ? Math.min(6, (55 - Number(horizon.buyHitRate)) * 0.08)
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
  const confidencePenalty = clamp(globalPenalty + symbolPenalty + horizonPenalty + horizonAdversePenalty + patternPenalty, 0, 22);
  const globalShrink = Number(adaptive.upsideShrink || 1) || 1;
  const symbolShrink = Number(symbolStats.upsideShrink || 1) || 1;
  const horizonShrink = horizon.resolved >= 4 && Number(horizon.avgOverPrediction || 0) > 0
    ? Math.max(0.68, 1 - Number(horizon.avgOverPrediction || 0) * 0.025)
    : 1;
  const patternShrink = matchedPatternStats.reduce((value, stat) => Math.min(value, Number(stat.upsideShrink || 1) || 1), 1);
  const upsideShrink = clamp(globalShrink * symbolShrink * horizonShrink * patternShrink, 0.42, 1);
  if (confidencePenalty < 0.25 && upsideShrink > 0.985) return analysis;
  const notes = [];
  if (globalPenalty > 0.4) notes.push(`全局近期预测惩罚 ${globalPenalty.toFixed(1)}%`);
  if (symbolPenalty > 0.4) notes.push(`${result.symbol} 近期预测偏差惩罚 ${symbolPenalty.toFixed(1)}%`);
  if (horizonPenalty > 0.4) notes.push(`当前周期命中不足惩罚 ${horizonPenalty.toFixed(1)}%`);
  if (horizonAdversePenalty > 0.4) notes.push(`当前周期未到期预测已逆行惩罚 ${horizonAdversePenalty.toFixed(1)}%`);
  if (patternPenalty > 0.4) notes.push(`相似预测行为惩罚 ${patternPenalty.toFixed(1)}%：${matchedPatternStats.map((stat) => stat.label).join("、")}`);
  if (upsideShrink < 0.985) notes.push(`预估涨幅按 ${(upsideShrink * 100).toFixed(0)}% 收缩`);
  const projectedUpside = Number(analysis.projectedUpside || 0);
  const finalConfidence = clamp(Math.round(Number(analysis.confidence || 0) - confidencePenalty), 0, 99);
  const finalProjected = Number((projectedUpside > 0 ? projectedUpside * upsideShrink : projectedUpside).toFixed(2));
  const upsideAgreement = Number(analysis.ensemble?.upsideAgreement || 50);
  return {
    ...analysis,
    confidence: finalConfidence,
    predictionConfidence: finalConfidence,
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
  const previousPositive = isBuyAction(previous.action) || Number(previous.projectedUpside || 0) >= Number(previous.targetUpside || strategy.targetUpside || 5);
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
    thesis: [
      `Market/Agent overlay: ${marketBias.stance || "mixed"} market bias ${Number(marketBias.confidenceBias || 0).toFixed(1)}%, paper-agent bias ${Number(agentBias.confidence || 0).toFixed(1)}% from ${agentBias.contributors} trained agents.`,
      ...(analysis.thesis || []),
    ],
  };
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
    </div>
  `;
  target.innerHTML = memorySummary + ledger.agents.map((agent) => {
    const positions = Object.entries(agent.positions || {});
    const lastTrades = (agent.trades || []).slice(0, 3);
    return `
      <article class="agent-card">
        <div class="agent-top">
          <div><strong>${agent.name}</strong><span>${agent.style === "momentum" ? "趋势追踪" : "回撤反弹"} · 攻击性 ${Number(agent.learning?.aggressiveness || 1).toFixed(2)}</span></div>
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
          ${lastTrades.length ? lastTrades.map((trade) => `<span>${trade.side} ${trade.symbol} ${trade.qty} @ ${formatMoney(trade.price)} ${trade.pnlPct ? formatPct(trade.pnlPct) : ""}</span>`).join("") : "<span>暂无模拟成交</span>"}
        </div>
        <p>${bestStrategyForAgent(agent) ? `当前最优：${bestStrategyForAgent(agent).name}，回测交易 ${bestStrategyForAgent(agent).trades} 次，均值 ${formatPct(bestStrategyForAgent(agent).avgReturn)}。` : "策略草稿收集中，至少需要几次历史叠加交易。"}</p>
      </article>
    `;
  }).join("");
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

function renderCards() {
  state.watchlist = sanitizeSymbolsForMarket(state.watchlist, state.market);
  const cards = state.watchlist.map((symbol) => {
    const watchOriginLabel = watchSourceLabel(watchlistOriginFor(symbol, state.market, "saved"));
    const item = state.analyses.get(symbol);
    if (!item) {
      return `
        <article class="stock-card" data-symbol="${symbol}">
          <div class="card-top"><h3>${symbol}</h3><span class="muted">未刷新</span></div>
          <div class="tag-row"><span class="tag warn">${watchOriginLabel}</span><span class="tag">${activeMarketConfig().label}</span></div>
          <div class="decision-row">
            <span class="muted">等待真实行情</span>
            <div class="card-actions">
              <button class="danger-soft mini-btn" type="button" data-delete-symbol="${symbol}">删除</button>
            </div>
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
    const factorScore = factorTotal(item.factors);
    const indicatorTags = isError ? "" : `
          ${alertTag}
          <span class="tag ${tagClass(analysis.confidence, getStrategy().confidence, 45)}">预测可靠度 ${Math.round(analysis.confidence)}%</span>
          <span class="tag ${tagClass(analysis.upsideConfidence || 0, getStrategy().confidence, 35)}">涨 ${Math.round(analysis.upsideConfidence || 0)}%</span>
          <span class="tag ${tagClass(analysis.downsideConfidence || 0, getStrategy().confidence, 35)}">跌 ${Math.round(analysis.downsideConfidence || 0)}%</span>
          <span class="tag ${tagClass(analysis.projectedUpside, getStrategy().targetUpside, 0)}">预估 ${formatPct(analysis.projectedUpside)}</span>
          <span class="tag ${tagClass(factorScore, 8, -6)}">因子 ${factorScore.toFixed(1)}</span>
          <span class="tag ${tagClass(technicals.rsi, 55, 35)}">RSI ${technicals.rsi.toFixed(1)}</span>
          <span class="tag ${tagClass(technicals.mainForceProxy, 58, 42)}">主力代理 ${technicals.mainForceProxy.toFixed(0)}</span>`;
    const subline = isError
      ? "配置真实行情源后再分析"
      : `5日 ${formatPct(technicals.change5d)} · 量比 ${technicals.volumeRatio.toFixed(2)}`;
    return `
      <article class="stock-card ${isStrictBuyAction(analysis.action) ? "buy-alert" : isRiskAction(analysis.action) ? "risk-alert" : ""}" data-symbol="${symbol}">
        <div class="card-top">
          <div><h3>${symbol}</h3><span class="muted">${actionLabel(analysis.action)}</span></div>
          <div class="price">${isError ? "N/A" : formatMoney(technicals.close)}</div>
        </div>
        <div class="tag-row">
          <span class="tag ${sourceClass}">${sourceLabel}</span>
          <span class="tag">${watchOriginLabel}</span>
          ${quoteLabel ? `<span class="tag good">${quoteLabel}</span>` : ""}
          ${indicatorTags}
        </div>
        <div class="decision-row">
          <span class="muted">${subline}</span>
          <div class="card-actions">
            <button class="secondary mini-btn" type="button" data-view="${symbol}">详情</button>
            <button class="danger-soft mini-btn" type="button" data-delete-symbol="${symbol}">删除</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
  $("cards").innerHTML = cards;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected = button.dataset.view;
      renderDetail();
    });
  });
  document.querySelectorAll("[data-delete-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteWatchSymbol(button.dataset.deleteSymbol);
    });
  });
}

function renderDetail() {
  const item = state.analyses.get(state.selected) || [...state.analyses.values()][0];
  if (!item) {
    const detailPanel = $("detailPanel");
    if (detailPanel) detailPanel.innerHTML = `<p class="muted">请选择或刷新一只股票查看详情。</p>`;
    const source = $("analysisSource");
    if (source) source.textContent = "分析：等待选择";
    return;
  }
  state.selected = item.symbol;
  const symbol = normalizeSymbol(item.symbol);
  const technicals = normalizeTechnicals(item.technicals);
  const analysis = normalizeAnalysis(item.analysis);
  const news = Array.isArray(item.news) ? item.news : [];
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
  $("detailPanel").innerHTML = `
    <h3>${symbol} · ${actionLabel(analysis.action)}</h3>
    <p class="muted">周期 ${analysis.horizonDays || getStrategy().horizonDays} 日 · 预测可靠度 ${Math.round(analysis.confidence)}%${analysis.rawConfidence !== analysis.confidence ? `（原始 ${Math.round(analysis.rawConfidence)}%）` : ""} · 上涨倾向 ${Math.round(analysis.upsideConfidence || 0)}% · 下跌倾向 ${Math.round(analysis.downsideConfidence || 0)}% · 预估涨幅 ${formatPct(analysis.projectedUpside)}</p>
    <div class="tag-row detail-tags">
      ${isBuyAction(analysis.action) ? `<span class="tag ${analysis.action === "LIGHT_BUY" ? "warn" : "good"}">${actionLabel(analysis.action)}，建议票额 ${formatMoney(analysis.suggestedTradeValue || 0)}</span>` : ""}
      ${["STRONG_AVOID", "CRITICAL_SELL"].includes(analysis.action) ? `<span class="tag danger">${actionLabel(analysis.action)}：下跌倾向 ${Math.round(analysis.downsideConfidence || 0)}%</span>` : ""}
      ${item.marketValidation ? `<span class="tag ${item.marketValidation.degraded ? "warn" : item.marketValidation.ok ? "good" : "danger"}">${item.marketValidation.degraded ? "单源真实数据" : "双源验证通过"}</span>` : ""}
      ${item.quote?.source ? `<span class="tag good">${item.quote.delayed ? "延迟最新价" : "实时最新价"}：${formatMoney(item.quote.price)}</span>` : ""}
      ${item.marketValidation?.degraded ? `<span class="tag warn">已扣减置信度</span>` : ""}
      ${analysis.calibration?.sampleCount >= 5 ? `<span class="tag ${analysis.calibration.adjustment >= 0 ? "good" : "warn"}">校准 ${analysis.calibration.adjustment >= 0 ? "+" : ""}${analysis.calibration.adjustment}%</span>` : `<span class="tag warn">校准样本收集中</span>`}
    </div>
    <div class="decision-actions">
      <button id="acceptDecision" type="button">接受并记录决策</button>
      <button id="deleteSelectedStock" class="danger-soft" type="button">删除这只股票</button>
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
    <div class="chart-dashboard compact" id="chartDashboard">
      <div class="chart-toolbar">
        <div class="chart-tabs">
          <button class="range-btn active" type="button" title="当前数据源只支持真实日线">日线</button>
          ${["1M", "3M", "6M", "9M"].map((range) => `<button class="range-btn ${state.chartRange === range ? "active" : ""}" data-range="${range}" type="button">${range}</button>`).join("")}
        </div>
        <div class="chart-tools">
          <div id="chartReadout" class="chart-readout muted">悬停查看每日 OHLC / 量 / MACD</div>
          <button id="expandChart" class="secondary" type="button">放大</button>
        </div>
      </div>
      <div class="chart-legend"><span class="legend green">K线</span><span class="legend blue">SMA20</span><span class="legend amber">SMA50 / Signal</span></div>
      <div class="chart-layer">
        <canvas id="priceChart" height="300"></canvas>
        <canvas id="volumeChart" height="105"></canvas>
        <canvas id="macdChart" height="135"></canvas>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><span>${item.quote?.source ? "最新价" : "收盘价"}</span><strong>${formatMoney(technicals.close)}</strong></div>
      <div class="detail-item"><span>MACD Histogram</span><strong>${technicals.macdHistogram.toFixed(4)}</strong></div>
      <div class="detail-item"><span>SMA20 / SMA50</span><strong>${technicals.sma20.toFixed(2)} / ${technicals.sma50.toFixed(2)}</strong></div>
      <div class="detail-item"><span>换手/成交强度代理</span><strong>${technicals.volumeRatio.toFixed(2)}x</strong></div>
      <div class="detail-item"><span>20日涨跌</span><strong>${formatPct(technicals.change20d)}</strong></div>
      <div class="detail-item"><span>主力仓位代理</span><strong>${technicals.mainForceProxy.toFixed(0)} / 100</strong></div>
      <div class="detail-item"><span>历史相似胜率</span><strong>${item.analog?.count ? `${asNumber(item.analog.winRate).toFixed(0)}% / ${formatPct(item.analog.averageForwardReturn)}` : "样本不足"}</strong></div>
      <div class="detail-item"><span>自监督预测</span><strong>${item.analog?.model?.sampleCount ? `${formatPct(item.analog.model.predictedReturn)} · 命中 ${asNumber(item.analog.model.directionalAccuracy).toFixed(0)}% · MAE ${asNumber(item.analog.model.mae).toFixed(2)}%` : "样本不足"}</strong></div>
      <div class="detail-item"><span>可用资金 / 建议票额</span><strong>${formatMoney(getCapital().availableCash)} / ${formatMoney(analysis.suggestedTradeValue || 0)}</strong></div>
      <div class="detail-item"><span>基本面</span><strong>${item.fundamentals ? `PE ${Number(item.fundamentals.peRatio || 0).toFixed(1)} · Yield ${formatPct(Number(item.fundamentals.dividendYield || 0) * 100)}` : "套餐未授权"}</strong></div>
      <div class="detail-item"><span>X / YouTube 信号</span><strong>${item.xPosts?.length || 0} / ${item.youtubeItems?.length || 0}</strong></div>
    </div>
    <h4>多模型集成</h4>
    <div class="ensemble-summary">
      <span>方向 ${ensemble.direction || "n/a"}</span>
      <span>上涨一致度 ${Math.round(ensemble.upsideAgreement || 0)}%</span>
      <span>共识强度 ${Math.round(ensemble.consensusAgreement || 0)}%</span>
      <span>数据源扣分 ${Math.round(ensemble.dataPenalty || 0)}%</span>
      <span>证据奖励 ${Number(ensemble.evidenceBonus || 0).toFixed(1)} / 分歧扣分 ${Number(ensemble.disagreementPenalty || 0).toFixed(1)}</span>
    </div>
    <div class="ensemble-grid">
      ${ensembleModels.length ? ensembleModels.map((model) => `
        <div class="ensemble-card ${model.available === false ? "muted-factor" : ""}">
          <div><strong>${model.name || "模型"}</strong><span class="${Number(model.projectedUpside || 0) >= 0 ? "good-text" : "danger-text"}">${formatPct(model.projectedUpside || 0)}</span></div>
          <p>置信 ${Math.round(model.confidence || 0)}% · 权重 ${Math.round((model.normalizedWeight || model.weight || 0) * 100)}%</p>
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
    <ul>${item.analog?.examples?.length ? item.analog.examples.map((example) => `<li>${example.date} 后 ${analysis.horizonDays || getStrategy().horizonDays} 日：${formatPct(example.forwardReturn)}，相似距离 ${asNumber(example.distance).toFixed(2)}</li>`).join("") : "<li>历史样本不足，暂不纳入相似走势判断。</li>"}</ul>
    <h4>判断</h4>
    <ul>${(analysis.thesis || []).map((itemText) => `<li>${itemText}</li>`).join("")}</ul>
    <h4>风险</h4>
    <ul>${(analysis.risks || []).map((itemText) => `<li>${itemText}</li>`).join("")}</ul>
    <h4>新闻</h4>
    <ul>${(news || []).slice(0, 8).map((itemNews) => `<li><a href="${itemNews.link}" target="_blank" rel="noreferrer">${itemNews.title}</a> <span class="muted">${itemNews.publisher || itemNews.source || ""} · ${itemNews.channel || "news"} · 权重 ${asNumber(itemNews.impactWeight, 0.4).toFixed(2)}</span></li>`).join("") || "<li>当前 provider 未返回新闻。</li>"}</ul>
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
  requestAnimationFrame(() => renderCharts(item, document));
}

function buyFromSignal(item) {
  const technicals = normalizeTechnicals(item.technicals);
  const qty = asNumber($("ticketQty")?.value, 0);
  const price = asNumber($("ticketPrice")?.value, technicals.close);
  if (qty <= 0 || price <= 0) {
    setStatus("请输入有效买入数量和均价");
    return;
  }
  const existing = findHolding(item.symbol);
  if (existing) {
    const totalQty = existing.qty + qty;
    upsertHolding({
      ...existing,
      qty: totalQty,
      avgPrice: ((existing.avgPrice * existing.qty) + (price * qty)) / totalQty,
      entryDate: existing.entryDate,
      source: "app-buy",
    });
  } else {
    upsertHolding({
      symbol: item.symbol,
      qty,
      avgPrice: price,
      entryDate: todayIso(),
      source: "app-buy",
    });
  }
  saveDecision(item);
  evaluateAlerts();
  renderPortfolioSummary();
  renderCards();
  renderDetail();
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
  localStorage.setItem("decisionHistory", JSON.stringify(state.history));
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
  const realizedPnl = (price - holding.avgPrice) * qty;
  const remainingQty = Number((holding.qty - qty).toFixed(6));
  const baseCapital = asNumber($("totalCapital").value, 0);
  $("totalCapital").value = Math.max(0, baseCapital + realizedPnl).toFixed(2);
  if (remainingQty <= 0) {
    state.portfolio = state.portfolio.filter((row) => !(row.symbol === holding.symbol && row.market === holding.market));
  } else {
    state.portfolio = state.portfolio.map((row) => (
      row.symbol === holding.symbol && row.market === holding.market
        ? { ...row, qty: remainingQty, avgPrice: holding.avgPrice, source: `${row.source || "manual"}+reduce` }
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
    qty,
    realizedPnl,
  });
  evaluateAlerts();
  renderPortfolioSummary();
  renderCards();
  renderDetail();
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
      <div class="chart-dashboard expanded" id="chartDashboard">
        <div class="chart-toolbar">
          <div class="chart-tabs">
            <button class="range-btn active" type="button" title="当前数据源只支持真实日线">日线</button>
            ${["1M", "3M", "6M", "9M"].map((range) => `<button class="range-btn ${state.chartRange === range ? "active" : ""}" data-range="${range}" type="button">${range}</button>`).join("")}
          </div>
          <div id="chartReadout" class="chart-readout muted">悬停查看每日 OHLC / 量 / MACD</div>
        </div>
        <div class="chart-legend"><span class="legend green">K线</span><span class="legend blue">SMA20</span><span class="legend amber">SMA50 / Signal</span></div>
        <div class="chart-scroll">
          <div class="chart-layer">
            <canvas id="priceChart" height="340"></canvas>
            <canvas id="volumeChart" height="90"></canvas>
            <canvas id="macdChart" height="120"></canvas>
          </div>
        </div>
      </div>
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

function drawGrid(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#e5ebf1";
  ctx.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const y = (height / 4) * index;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
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
  return { "1M": 24, "3M": 66, "6M": 132, "9M": 220 }[range] || 132;
}

function xFor(index, count, width, left = 48, right = 14) {
  return left + (count <= 1 ? 0 : (index / (count - 1)) * (width - left - right));
}

function yFor(value, min, max, height, top = 12, bottom = 20) {
  return top + (1 - (value - min) / (max - min || 1)) * (height - top - bottom);
}

function drawAxis(ctx, bounds, width, height, formatter = (value) => value.toFixed(2)) {
  ctx.fillStyle = "#64748b";
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  [bounds.max, (bounds.max + bounds.min) / 2, bounds.min].forEach((value) => {
    const y = yFor(value, bounds.min, bounds.max, height);
    ctx.fillText(formatter(value), 4, y);
  });
}

function drawLoading(canvas, message) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#64748b";
  ctx.font = "13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, width / 2, height / 2);
}

function renderCharts(item, root = document) {
  const priceCanvas = root.querySelector("#priceChart");
  const volumeCanvas = root.querySelector("#volumeChart");
  const macdCanvas = root.querySelector("#macdChart");
  if (!priceCanvas || !volumeCanvas || !macdCanvas) return;

  const chartKey = `${state.market}:${item.symbol}:${state.chartInterval}`;
  const cachedChart = state.chartDataCache.get(chartKey);
  let sourceCandles = normalizeCandles(state.chartInterval === "1d" ? item.candles : cachedChart?.candles);
  if (!sourceCandles?.length) {
    drawLoading(priceCanvas, `正在读取 ${state.chartInterval} 真实行情...`);
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
  const candles = sourceCandles.slice(-rangeCount(state.chartRange));
  if (!candles.length) return;
  const hoverIndex = state.chartHoverIndex == null ? null : clamp(state.chartHoverIndex, 0, candles.length - 1);

  const closes = candles.map((row) => row.close);
  const highs = candles.map((row) => row.high);
  const lows = candles.map((row) => row.low);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const priceBounds = chartBounds([...highs, ...lows, ...sma20, ...sma50]);
  const price = setupCanvas(priceCanvas);
  drawGrid(price.ctx, price.width, price.height);
  drawAxis(price.ctx, priceBounds, price.width, price.height);
  const plotWidth = price.width - 62;
  const candleWidth = Math.max(3, Math.min(12, plotWidth / candles.length * 0.62));
  candles.forEach((row, index) => {
    const x = xFor(index, candles.length, price.width);
    const yHigh = yFor(row.high, priceBounds.min, priceBounds.max, price.height);
    const yLow = yFor(row.low, priceBounds.min, priceBounds.max, price.height);
    const yOpen = yFor(row.open, priceBounds.min, priceBounds.max, price.height);
    const yClose = yFor(row.close, priceBounds.min, priceBounds.max, price.height);
    const up = row.close >= row.open;
    price.ctx.strokeStyle = up ? "#15803d" : "#be123c";
    price.ctx.fillStyle = up ? "#15803d" : "#be123c";
    price.ctx.beginPath();
    price.ctx.moveTo(x, yHigh);
    price.ctx.lineTo(x, yLow);
    price.ctx.stroke();
    price.ctx.fillRect(x - candleWidth / 2, Math.min(yOpen, yClose), candleWidth, Math.max(2, Math.abs(yClose - yOpen)));
  });
  drawSeriesLine(price.ctx, sma20, priceBounds, price.width, price.height, "#2563eb");
  drawSeriesLine(price.ctx, sma50, priceBounds, price.width, price.height, "#b45309");

  const volume = setupCanvas(volumeCanvas);
  drawGrid(volume.ctx, volume.width, volume.height);
  const maxVolume = Math.max(...candles.map((row) => row.volume || 0), 1);
  drawAxis(volume.ctx, { min: 0, max: maxVolume }, volume.width, volume.height, (value) => `${(value / 1000000).toFixed(1)}M`);
  candles.forEach((row, index) => {
    const x = xFor(index, candles.length, volume.width);
    const barHeight = ((row.volume || 0) / maxVolume) * (volume.height - 28);
    volume.ctx.fillStyle = row.close >= row.open ? "rgba(21, 128, 61, 0.75)" : "rgba(190, 18, 60, 0.72)";
    volume.ctx.fillRect(x - candleWidth / 2, volume.height - 18 - barHeight, candleWidth, barHeight);
  });

  const macdSeries = computeMacdSeries(candles);
  const macd = setupCanvas(macdCanvas);
  const macdBounds = chartBounds([...macdSeries.macd, ...macdSeries.signal, ...macdSeries.histogram], 0.18);
  drawGrid(macd.ctx, macd.width, macd.height);
  drawAxis(macd.ctx, macdBounds, macd.width, macd.height, (value) => value.toFixed(2));
  const zeroY = yFor(0, macdBounds.min, macdBounds.max, macd.height);
  macd.ctx.strokeStyle = "#94a3b8";
  macd.ctx.beginPath();
  macd.ctx.moveTo(48, zeroY);
  macd.ctx.lineTo(macd.width, zeroY);
  macd.ctx.stroke();
  macdSeries.histogram.forEach((value, index) => {
    const x = xFor(index, macdSeries.histogram.length, macd.width);
    const y = yFor(value, macdBounds.min, macdBounds.max, macd.height);
    macd.ctx.fillStyle = value >= 0 ? "rgba(21, 128, 61, 0.72)" : "rgba(190, 18, 60, 0.72)";
    macd.ctx.fillRect(x - candleWidth / 2, Math.min(y, zeroY), candleWidth, Math.max(1, Math.abs(zeroY - y)));
  });
  drawSeriesLine(macd.ctx, macdSeries.macd, macdBounds, macd.width, macd.height, "#2563eb");
  drawSeriesLine(macd.ctx, macdSeries.signal, macdBounds, macd.width, macd.height, "#b45309");

  if (hoverIndex !== null) {
    drawCrosshair(price.ctx, hoverIndex, candles.length, price.width, price.height);
    drawCrosshair(volume.ctx, hoverIndex, candles.length, volume.width, volume.height);
    drawCrosshair(macd.ctx, hoverIndex, candles.length, macd.width, macd.height);
    const row = candles[hoverIndex];
    const readout = root.querySelector("#chartReadout");
    if (readout) readout.textContent = `${row.date}  O ${row.open.toFixed(2)} H ${row.high.toFixed(2)} L ${row.low.toFixed(2)} C ${row.close.toFixed(2)}  Vol ${(row.volume / 1000000).toFixed(2)}M  MACD ${macdSeries.macd[hoverIndex].toFixed(3)} / ${macdSeries.signal[hoverIndex].toFixed(3)}`;
  }

  const dashboard = root.querySelector("#chartDashboard");
  if (dashboard && !dashboard.dataset.bound) {
    dashboard.dataset.bound = "true";
    dashboard.querySelectorAll("[data-range]").forEach((button) => {
      button.addEventListener("click", () => {
        state.chartRange = button.dataset.range;
        state.chartHoverIndex = null;
        saveState();
        if (state.chartExpanded) renderCharts(item, root);
        else renderDetail();
      });
    });
    [priceCanvas, volumeCanvas, macdCanvas].forEach((canvas) => {
      canvas.addEventListener("mousemove", (event) => {
        const rect = canvas.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left - 48) / Math.max(1, rect.width - 62), 0, 1);
        state.chartHoverIndex = Math.round(ratio * (candles.length - 1));
        renderCharts(item, root);
      });
      canvas.addEventListener("mouseleave", () => {
        state.chartHoverIndex = null;
        const readout = root.querySelector("#chartReadout");
        if (readout) readout.textContent = "悬停查看每日 OHLC / 量 / MACD";
        renderCharts(item, root);
      });
    });
  }
}

function drawSeriesLine(ctx, values, bounds, width, height, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
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
  ctx.strokeStyle = "rgba(15, 23, 42, 0.38)";
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
  const session = marketState();
  const runtime = getRuntimeSettings();
  if (!session.canRefresh && !runtime.allowOffHoursFetch) {
    const shouldStop = await useSnapshotOrFetch(`当前不在 ${activeMarketConfig().code} 交易/收盘刷新窗口`, true);
    if (shouldStop) {
      scheduleNextAutoRefresh();
      return;
    }
  }
  if (state.autoRefreshTimer) {
    clearTimeout(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  state.isRefreshing = true;
  saveState();
  $("refreshAll").disabled = true;
  const startedAt = new Date();
  const preparedItems = [];
  const symbols = orderedSymbolsForRefresh();
  await fetchAccuracySummary(true);
  await refreshMarketIndexes(true).catch((error) => {
    console.warn("Unable to refresh market indexes", error);
    loadMarketIndexSnapshot();
  });
  setStatus(runtime.fastInitialRefresh
    ? `快速并行读取 ${symbols.length} 只股票真实行情；新闻/AI 后台复核...`
    : `并行读取 ${symbols.length} 只股票真实行情、新闻和因子；持仓股优先...`);
  const tasks = symbols.map(async (symbol) => {
    try {
      const prepared = await prepareSymbol(symbol, { includeSignals: !runtime.fastInitialRefresh });
      preparedItems.push(prepared);
      setStatus(`${symbol} 数据准备完成`);
    } catch (error) {
      console.error(error);
      setSymbolError(symbol, error);
    } finally {
      renderCards();
      renderPortfolioSummary();
      renderDetail();
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
      preparedItems.forEach((item) => setSymbolError(item.symbol, error));
    } finally {
      renderCards();
      renderPortfolioSummary();
      renderDetail();
    }
  }
  $("refreshAll").disabled = false;
  state.isRefreshing = false;
  const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  setStatus(`刷新完成：${preparedItems.length}/${symbols.length} 只股票，用时 ${seconds}s；后台复核继续更新新闻、因子和 AI`);
  scheduleNextAutoRefresh();
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
  localStorage.setItem("watchlistsByMarket", JSON.stringify(state.watchlistsByMarket));
  localStorage.setItem("watchlistOriginsByMarket", JSON.stringify(state.watchlistOriginsByMarket));
}

function updateMarketUi() {
  const config = activeMarketConfig();
  document.title = `${config.title} · Global Quant Watch`;
  const marketSelect = $("marketSelect");
  if (marketSelect) marketSelect.value = state.market;
  const marketTitle = $("marketTitle");
  if (marketTitle) marketTitle.textContent = config.title;
  document.querySelectorAll(".currencyLabel").forEach((node) => {
    node.textContent = config.currency;
  });
  const symbolInput = $("symbolInput");
  if (symbolInput) symbolInput.placeholder = config.symbolPlaceholder;
  const holdingSymbol = $("holdingSymbol");
  if (holdingSymbol) holdingSymbol.placeholder = config.holdingPlaceholder;
  const portfolioCsv = $("portfolioCsv");
  if (portfolioCsv) portfolioCsv.value = localStorage.getItem(`portfolioCsv:${state.market}`) || holdingsToCsv(activePortfolio()) || config.samplePortfolio;
  const agentInitialCapital = $("agentInitialCapital");
  if (agentInitialCapital) agentInitialCapital.value = agentConfigForMarket().initialCapital;
  syncCapitalFields();
  updateSydneyClock();
}

async function switchMarket(nextMarket) {
  const market = safeMarket(nextMarket);
  if (market === state.market) return;
  stashActiveMarketState();
  state.market = market;
  state.watchlist = sanitizeSymbolsForMarket(initialWatchlistForMarket(market), market);
  state.analyses = new Map(state.analysesByMarket.get(market) || []);
  sanitizeActiveMarketState();
  state.selected = null;
  state.chartHoverIndex = null;
  state.marketCache.clear();
  state.chartDataCache.clear();
  state.stockPicker = { forecast: [], today: [], rejected: [], failures: [], updatedAt: null };
  state.snapshotUpdatedAt = localStorage.getItem(snapshotTimeKey()) || null;
  saveState();
  updateMarketUi();
  state.marketIndexes = [];
  state.marketIndexSignal = null;
  loadMarketIndexSnapshot();
  renderMarketIndexPanel();
  renderAgentPanel();
  renderOptimalStrategyPanel();
  restoreAnalysisSnapshot();
  await restoreServerSnapshot();
  await fetchAccuracySummary(true);
  evaluateAlerts();
  renderCards();
  renderPortfolioSummary();
  renderMarketIndexPanel();
  renderAiPickPanel();
  renderAgentPanel();
  renderOptimalStrategyPanel();
  renderDetail();
  setStatus(`已切换到${activeMarketConfig().label}；刷新后读取该市场真实行情`);
  if (state.autoRefreshEnabled) scheduleNextAutoRefresh();
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
  loadSavedInputs();
  sanitizeActiveMarketState();
  updateMarketUi();
  savePortfolio();
  restoreAnalysisSnapshot();
  loadMarketIndexSnapshot();
  restoreServerSnapshot();
  fetchAccuracySummary(true);
  evaluateAlerts();
  renderCards();
  renderPortfolioSummary();
  renderMarketIndexPanel();
  renderAiPickPanel();
  renderAgentPanel();
  renderOptimalStrategyPanel();
  renderHistory();
  renderNotificationButton();
  startSydneyClock();

  bind("marketSelect", "change", (event) => {
    switchMarket(event.target.value);
  });

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
  });

  bind("saveStrategy", "click", () => {
    saveState();
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
    try {
      setStatus("正在更新大盘指数...");
      await refreshMarketIndexes(true);
      renderCards();
      renderDetail();
      setStatus("大盘指数已更新，并已纳入后续选股偏置");
    } catch (error) {
      console.error(error);
      setStatus(`大盘指数更新失败：${error.message}`);
    }
  });

  bind("aiPickStocks", "click", runAiStockPicker);
  bind("sendAiChat", "click", sendAiChat);
  bind("aiChatInput", "keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendAiChat();
  });

  bind("saveAgentCapital", "click", () => {
    const value = Math.max(100, asNumber($("agentInitialCapital").value, agentConfigForMarket().initialCapital));
    state.agentConfigByMarket[state.market] = { initialCapital: value };
    resetLedgerPreservingMemory("capital-reset");
    renderAgentPanel();
    renderOptimalStrategyPanel();
    setStatus(`模拟交易 Agent 本金已设为 ${formatMoney(value)}；当前周期已归档，长期策略记忆已保留`);
  });

  bind("resetAgents", "click", () => {
    resetLedgerPreservingMemory("manual-reset");
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
    trainAgentsWithHistoricalReplay(ledger, rows);
    ledger.updatedAt = new Date().toISOString();
    state.agentLedgerByMarket[state.market] = ledger;
    persistAgentMemoryFromLedger(ledger, "manual-replay");
    saveAgentState();
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
    localStorage.setItem("decisionHistory", JSON.stringify(state.history));
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

  bind("loadPortfolio", "click", () => {
    state.portfolio = mergeHoldings([
      ...state.portfolio.filter((holding) => holding.market !== state.market),
      ...parsePortfolio($("portfolioCsv").value),
    ]);
    savePortfolio();
    renderCards();
    renderPortfolioSummary();
    setStatus("持仓已导入");
  });

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
    setStatus("仓位建议已重新计算");
  });

  bind("refreshAll", "click", refreshAll);
  if (state.autoRefreshEnabled) startAutoRefresh(false);
}

try {
  boot();
} catch (error) {
  console.error(error);
  setStatus(`页面启动失败：${error.message}。已忽略旧缓存，请刷新页面。`);
  const cards = $("cards");
  if (cards && !cards.innerHTML) {
    cards.innerHTML = `<article class="stock-card"><div class="card-top"><h3>启动失败</h3><span class="muted">${error.message}</span></div></article>`;
  }
}
