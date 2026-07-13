(function installQuantMarket(globalScope) {
  "use strict";

  const MARKET_CONFIG = Object.freeze({
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
  });

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

  const MARKET_UNIVERSES = Object.freeze({
    ASX: [
      "BHP", "CBA", "RIO", "CSL", "NAB", "WBC", "ANZ", "MQG", "WES", "WOW",
      "TLS", "FMG", "WDS", "GMG", "TCL", "QBE", "REA", "COH", "SHL", "CPU",
      "ORG", "APA", "SCG", "NST", "S32", "MIN", "PLS", "LYC", "COL", "PME",
      "ALL", "XRO", "JHX", "AMC", "CAR", "SOL", "IAG", "SUN", "SGP", "EDV",
      "TWE", "AGL", "DXS", "BSL", "QAN", "HVN", "JBH", "ALD", "VCX", "WHC",
      "STO", "RHC", "SEK", "DMP", "A2M", "IEL", "ALU", "MGR", "BXB", "NEM",
      "BRG", "SFR", "PDN", "NXG", "LTR", "ELV", "CMM", "BOE", "AIA", "EVN",
      "GGP", "DRO", "WGX", "WAF", "IPX", "FLT", "JDO", "HUB",
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
  });

  const MANUAL_WATCH_SOURCES = new Set(["manual", "holding", "csv", "text", "screenshot", "app-buy"]);
  const LEGACY_WRONG_MARKET_HOLDINGS = Object.freeze({ US: new Set(["TCL"]) });

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

  function sourceFromWatchEntry(entry, fallback) {
    if (entry && typeof entry === "object") return entry.source || fallback || "saved";
    return fallback || "saved";
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

  function isLikelyForeignMarketSymbol(symbol, market) {
    const key = safeMarket(market);
    const normalized = normalizeSymbolForMarket(symbol, key);
    if (!normalized || normalized.startsWith("^") || /^(SH000|SZ399)\d{3}$/.test(normalized)) return false;
    const asxKnown = marketUniverseSet("ASX").has(normalized) || marketDefaultSet("ASX").has(normalized) || OBVIOUS_ASX_ONLY_SYMBOLS.has(normalized);
    const usKnown = marketUniverseSet("US").has(normalized) || marketDefaultSet("US").has(normalized) || OBVIOUS_US_SYMBOLS.has(normalized);
    if (key === "US") return asxKnown && !usKnown;
    if (key === "ASX") return usKnown && !asxKnown;
    if (key === "CN") return !/^\d{6}$/.test(normalized);
    return false;
  }

  function allowWatchSymbolForMarket(symbol, market, source) {
    const key = safeMarket(market);
    const normalized = normalizeSymbolForMarket(symbol, key);
    if (!normalized) return "";
    if (isManualWatchSource(source || "saved")) return normalized;
    if (isLikelyForeignMarketSymbol(normalized, key)) return "";
    return isMarketNativeAutoSymbol(normalized, key) ? normalized : "";
  }

  function normalizeWatchlistItemsForMarket(symbols, market, origins, fallbackSource) {
    const key = safeMarket(market);
    const originMap = origins?.[key] || {};
    const rows = Array.isArray(symbols) ? symbols : [];
    return [...new Set(rows.map((entry) => {
      const raw = symbolFromWatchEntry(entry);
      const normalized = normalizeSymbolForMarket(raw, key);
      const source = sourceFromWatchEntry(entry, originMap[normalized] || fallbackSource || "saved");
      return allowWatchSymbolForMarket(normalized || raw, key, source);
    }).filter(Boolean))];
  }

  globalScope.QuantMarket = Object.freeze({
    LEGACY_WRONG_MARKET_HOLDINGS,
    MARKET_CONFIG,
    MARKET_UNIVERSES,
    allowWatchSymbolForMarket,
    cleanSymbolText,
    isLikelyForeignMarketSymbol,
    isManualWatchSource,
    isMarketNativeAutoSymbol,
    marketDefaultSet,
    marketUniverseSet,
    normalizeSymbolForMarket,
    normalizeWatchlistItemsForMarket,
    safeMarket,
    sourceFromWatchEntry,
    symbolFromWatchEntry,
  });
}(typeof window !== "undefined" ? window : globalThis));
