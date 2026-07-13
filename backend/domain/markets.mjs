const MARKET_CONFIG = Object.freeze({
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
});

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

const TRAINING_UNIVERSES = Object.freeze({
  ASX: [
    "BHP", "CBA", "RIO", "CSL", "NAB", "WBC", "ANZ", "MQG", "WES", "WOW",
    "TLS", "FMG", "WDS", "GMG", "TCL", "QBE", "REA", "COH", "SHL", "CPU",
    "ORG", "APA", "SCG", "NST", "S32", "MIN", "PLS", "LYC", "COL", "PME",
    "ALL", "XRO", "JHX", "AMC", "CAR", "SOL", "IAG", "SUN", "SGP", "EDV",
    "TWE", "AGL", "DXS", "BSL", "QAN", "HVN", "JBH", "ALD", "VCX", "WHC",
    "STO", "RHC", "SEK", "DMP", "A2M", "IEL", "ALU", "MGR", "BXB", "NEM",
    "IFT", "FPH", "RMD", "HUB", "NXT", "WEB", "ALX", "BEN", "BOQ", "SGR",
  ],
  US: [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "JPM",
    "BAC", "WFC", "GS", "MS", "XOM", "CVX", "COP", "LLY", "UNH", "V",
    "MA", "COST", "WMT", "NFLX", "CRM", "ORCL", "ADBE", "INTC", "QCOM", "KO",
    "PEP", "PLTR", "IBM", "GE", "CAT", "BA", "RTX", "NKE", "DIS", "MCD",
    "HD", "TMO", "ABBV", "MRK", "PFE", "NOW", "SHOP", "UBER", "PANW", "CRWD",
    "MU", "SMCI", "ARM", "TSM", "BABA", "SBUX", "LMT", "LIN", "ISRG", "BKNG",
    "TXN", "AMAT", "LRCX", "KLAC", "DE", "LOW", "AXP", "BLK", "SCHW", "C",
  ],
  CN: [
    "600519", "300750", "002594", "000858", "601318", "600036", "601398", "000001",
    "600900", "601899", "600276", "300760", "002475", "600030", "601012", "600309",
    "000333", "000651", "300059", "002415", "600887", "601888", "600089", "002230",
    "603259", "688981", "600031", "600050", "600406", "601668", "601857", "601988",
    "601288", "601985", "600028", "600048", "600919", "002352", "002714", "300124",
    "300274", "300308", "300347", "300498", "600438", "600660", "000063", "000725",
    "002371", "002466", "002812", "300014", "300015", "300122", "600570", "601138",
  ],
});

function safeMarket(value) {
  return MARKET_CONFIG[value] ? value : "ASX";
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
  if (!code || !isValidMarketCode(code, key)) return "";
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

export {
  MARKET_CONFIG,
  TRAINING_UNIVERSES,
  assertValidMarketCode,
  cleanAsxCode,
  cleanCode,
  isValidMarketCode,
  normalizeAsxSymbol,
  normalizeMarketSymbol,
  safeMarket,
};
