function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value).trim())) {
    const epoch = Number(value);
    const parsedEpoch = new Date(epoch < 10_000_000_000 ? epoch * 1000 : epoch);
    return Number.isFinite(parsedEpoch.getTime()) ? parsedEpoch.toISOString() : null;
  }
  const text = String(value).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/.exec(text);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] || "00"}:${compact[5] || "00"}:${compact[6] || "00"}Z`
    : text;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function monthEnd(year, period) {
  const month = /^M(\d{2})$/.exec(String(period || ""));
  if (!month) return `${year}-12-31T00:00:00.000Z`;
  const monthNumber = Math.max(1, Math.min(12, Number(month[1])));
  return new Date(Date.UTC(Number(year), monthNumber, 0)).toISOString();
}

function quarterEnd(year, period) {
  const quarter = /^Q(\d)$/.exec(String(period || ""));
  if (!quarter) return `${year}-12-31T00:00:00.000Z`;
  const month = Number(quarter[1]) * 3;
  return new Date(Date.UTC(Number(year), month, 0)).toISOString();
}

function normalizeBlsMacroRecords(market, payload = {}, options = {}) {
  const retrievedAt = safeIso(options.retrievedAt) || new Date().toISOString();
  const series = Array.isArray(payload?.Results?.series) ? payload.Results.series : [];
  return series.flatMap((item) => {
    const seriesId = String(item?.seriesID || "").trim();
    return (Array.isArray(item?.data) ? item.data : []).flatMap((row) => {
      const year = String(row?.year || "").trim();
      const period = String(row?.period || "").trim();
      if (!/^\d{4}$/.test(year) || !/^M\d{2}$|^Q\d$|^A$/.test(period)) return [];
      const eventTime = period.startsWith("M")
        ? monthEnd(year, period)
        : quarterEnd(year, period);
      const value = finite(row?.value);
      if (value === null) return [];
      return [{
        id: `bls:${market}:${seriesId}:${year}:${period}:${value}`,
        seriesId,
        event_time: eventTime,
        available_at: retrievedAt,
        first_seen_at: retrievedAt,
        revision: `bls-api-${row?.footnotes?.length || 0}`,
        rawValue: value,
        values: {
          macroValue: value,
          macroSeries: seriesId,
          macroPeriod: period,
          sourceQuality: 0.72,
        },
        historicalAvailabilityVerified: false,
        historicalAvailabilityUnverified: true,
        historicalAvailabilityVerificationMethod: "bls-series-api-without-release-vintage",
        sourceProvider: "bls-public-api-shadow",
        warning: "BLS public series API does not expose a complete historical release vintage; Shadow-only.",
      }];
    });
  });
}

function cninfoAnnouncementLink(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  return `https://static.cninfo.com.cn/${text.replace(/^\/+/, "")}`;
}

function normalizeCninfoAnnouncementRecords(symbol, payload = {}, options = {}) {
  const code = String(symbol || "").replace(/\D/g, "").slice(-6);
  const rows = Array.isArray(payload?.announcements)
    ? payload.announcements
    : Array.isArray(payload?.data?.announcements)
      ? payload.data.announcements
      : [];
  const source = String(options.source || "cninfo-official-disclosure");
  return rows.flatMap((row, index) => {
    const publishedAt = safeIso(row?.announcementTime || row?.announcementDate || row?.publishTime || row?.date);
    if (!publishedAt) return [];
    const title = String(row?.announcementTitle || row?.title || "").trim();
    if (!title) return [];
    const announcementId = String(row?.announcementId || row?.id || index);
    const relatedSymbol = String(row?.secCode || row?.stockCode || code).replace(/\D/g, "").slice(-6);
    return [{
      id: `cninfo:${relatedSymbol || code}:${announcementId}:${publishedAt}`,
      symbol: relatedSymbol || code,
      title,
      description: String(row?.announcementContent || row?.summary || "").slice(0, 600),
      publisher: "CNINFO",
      link: cninfoAnnouncementLink(row?.adjunctUrl || row?.url),
      publishedAt,
      event_time: publishedAt,
      available_at: publishedAt,
      first_seen_at: publishedAt,
      revision: String(row?.announcementType || row?.category || "official-disclosure").slice(0, 80),
      historicalAvailabilityVerified: true,
      historicalAvailabilityVerificationMethod: "cninfo-official-announcement-time",
      sourceProvider: source,
      sourceQuality: 1,
      relevance: 1,
      impactScope: "official-disclosure",
      channel: "official-disclosure",
      values: {
        announcementScore: 1,
        eventRelevance: 1,
        sourceQuality: 1,
      },
    }];
  });
}

function publicPitSourceCatalog() {
  return [
    { name: "sec-edgar", market: "US", dataset: "fundamentals/financial_disclosures", access: "free-no-key", pit: "strict", status: "ready", officialUrl: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces", registration: "none", fields: ["period_end", "filed_at", "available_at", "revision", "revenue", "net_income", "assets", "liabilities", "cfo", "capex"] },
    { name: "sec-edgar-bulk-submissions", market: "US", dataset: "financial_disclosures/universe", access: "free-no-key", pit: "strict", status: "batch-capable", officialUrl: "https://www.sec.gov/edgar/sec-filings-securities-and-exchange-commission", registration: "none", fields: ["cik", "ticker", "form", "filed_at", "acceptance_date_time", "company_name"] },
    { name: "nasdaq-trader-symbol-directory", market: "US", dataset: "universe/asset-classification", access: "free-no-key", pit: "shadow-current-snapshot", status: "ready-shadow", officialUrl: "https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs", registration: "none", fields: ["symbol", "exchange", "security_type", "etf_flag", "name", "as_of", "available_at"] },
    { name: "finra-otc-directories", market: "US", dataset: "universe/asset-classification/corporate_actions", access: "free-no-key", pit: "shadow-until-dated-snapshot", status: "edge-source", officialUrl: "https://otce.finra.org/otce/directories", registration: "none", fields: ["symbol", "security_type", "name", "market", "listing_status", "effective_date", "available_at"] },
    { name: "openfigi", market: "US/ASX/CN", dataset: "entity-identity/asset-classification", access: "free-no-key", pit: "shadow-until-dated-snapshot", status: "ready-shadow", officialUrl: "https://www.openfigi.com/api/documentation", registration: "optional-api-key", fields: ["figi", "ticker", "exch_code", "security_type", "market_sector", "security_description", "available_at"] },
    { name: "gleif-api", market: "US/ASX/CN", dataset: "entity-identity", access: "free-no-key", pit: "shadow-identity", status: "ready-shadow", officialUrl: "https://www.gleif.org/en/lei-data/gleif-api", registration: "none", fields: ["lei", "legal_name", "legal_address", "parent_lei", "bic", "isin", "queried_at"] },
    { name: "common-crawl-index", market: "US/ASX/CN", dataset: "news/financial_disclosures", access: "free-no-key", pit: "shadow-archive-only", status: "edge-source", officialUrl: "https://index.commoncrawl.org/", registration: "none", fields: ["url", "crawl_id", "crawl_timestamp", "digest", "source_url", "event_time", "available_at"] },
    { name: "internet-archive-wayback-cdx", market: "US/ASX/CN", dataset: "news/financial_disclosures", access: "free-no-key", pit: "shadow-archive-only", status: "edge-source", officialUrl: "https://github.com/internetarchive/wayback", registration: "none", fields: ["url", "timestamp", "digest", "status", "mime", "available_at"] },
    { name: "yahoo-finance-chart-events", market: "US", dataset: "corporate_actions", access: "free-no-key", pit: "strict-ex-date", status: "fallback", officialUrl: "https://finance.yahoo.com/", registration: "none", fields: ["action_type", "ex_date", "ratio", "cash_amount", "available_at"] },
    { name: "yahoo-finance-chart-events", market: "ASX", dataset: "corporate_actions", access: "free-no-key", pit: "strict-ex-date", status: "fallback", officialUrl: "https://finance.yahoo.com/", registration: "none", fields: ["action_type", "ex_date", "ratio", "cash_amount", "available_at"] },
    { name: "eastmoney-public-corporate-actions", market: "CN", dataset: "corporate_actions", access: "free-public", pit: "strict-publication-and-ex-date", status: "fallback", officialUrl: "https://data.eastmoney.com/", registration: "none", fields: ["action_type", "ex_date", "record_date", "pay_date", "ratio", "cash_amount", "published_at", "available_at"] },
    { name: "asx-official-announcements", market: "ASX", dataset: "universe/corporate_actions/news", access: "free-personal-use", pit: "strict-event", status: "ready", officialUrl: "https://www.asx.com.au/markets/trade-our-cash-market/historical-announcements", registration: "none", fields: ["symbol", "event_time", "published_at", "source_url", "event_type", "revision"] },
    { name: "asx-codes-and-descriptors", market: "ASX", dataset: "universe/asset-classification", access: "free-no-key", pit: "shadow-unless-dated-archive", status: "ready-shadow", officialUrl: "https://www.asx.com.au/markets/market-resources/asx-codes-and-descriptors", registration: "none", fields: ["symbol", "security_type", "descriptor", "effective_from", "effective_to", "available_at"] },
    { name: "asx-company-directory", market: "ASX", dataset: "entity-identity/universe", access: "free-public", pit: "shadow-current-snapshot", status: "ready-shadow", officialUrl: "https://www.asx.com.au/markets/trade-our-cash-market/directory.html", registration: "none", fields: ["symbol", "company_name", "security_type", "listing_status", "as_of", "available_at"] },
    { name: "asx-official-reports-archive", market: "ASX", dataset: "financial_disclosures/reports", access: "free-public", pit: "strict-event", status: "ready", officialUrl: "https://www.asx.com.au/about/asx-shareholders/reports.html", registration: "none", fields: ["symbol", "report_type", "period_end", "published_at", "available_at", "source_url", "revision"] },
    { name: "abn-bulk-extract", market: "ASX", dataset: "entity-identity", access: "free-no-key", pit: "shadow-current-snapshot", status: "ready-shadow", officialUrl: "https://data.gov.au/data/dataset/abn-bulk-extract", registration: "none", fields: ["abn", "acn", "entity_name", "entity_status", "effective_from", "effective_to", "available_at"] },
    { name: "abn-lookup-web-services", market: "ASX", dataset: "entity-identity", access: "free-guid", pit: "shadow-identity", status: "requires-guid", officialUrl: "https://abr.business.gov.au/Tools/WebServices/1000", registration: "free-guid-registration", fields: ["abn", "acn", "entity_name", "entity_status", "effective_from", "effective_to", "queried_at"] },
    { name: "fmp-asx-financials", market: "ASX", dataset: "fundamentals", access: "account/plan-dependent", pit: "strict-when-filed", status: "fallback-entitlement", officialUrl: "https://site.financialmodelingprep.com/developer/docs", registration: "free-account", fields: ["period_end", "filed_at", "available_at", "revision", "revenue", "net_income", "assets", "liabilities", "cfo", "capex"] },
    { name: "tiingo-asx-financials", market: "ASX", dataset: "fundamentals", access: "account/plan-dependent", pit: "strict-when-filed", status: "fallback-entitlement", officialUrl: "https://www.tiingo.com/documentation", registration: "free-account", fields: ["period_end", "filed_at", "available_at", "revision", "revenue", "net_income", "assets", "liabilities", "cfo", "capex"] },
    { name: "finnhub-asx-financials", market: "ASX", dataset: "fundamentals", access: "account/plan-dependent", pit: "strict-when-filed", status: "fallback-entitlement", officialUrl: "https://finnhub.io/docs/api/financials-reported", registration: "free-account", fields: ["period_end", "filed_at", "available_at", "revision", "revenue", "net_income", "assets", "liabilities", "cfo", "capex"] },
    { name: "growthwithvalue-asx-financials", market: "ASX", dataset: "fundamentals/ratios", access: "free-api-key", pit: "strict-when-filed-or-shadow", status: "free-starter-250-calls-day", officialUrl: "https://growthwithvalue.com/api-documentation/", registration: "free-starter-account", fields: ["period_end", "filed_at", "available_at", "fiscal_year", "revenue", "net_income", "assets", "liabilities", "cfo", "capex", "ratios"] },
    { name: "stockmarketapi-ai-asx-financials", market: "ASX", dataset: "fundamentals/financial_disclosures/annual_reports", access: "free-api-key", pit: "strict-when-filed-or-shadow", status: "free-tier", officialUrl: "https://stockmarketapi.ai/api/docs", registration: "free-api-key-by-email", fields: ["period_end", "filing_date", "available_at", "period_type", "revenue", "net_income", "assets", "liabilities", "operating_cash_flow", "capital_expenditures", "report_url"] },
    { name: "asx-equity-stocks", market: "ASX", dataset: "quote/market_depth", access: "free-api-key", pit: "not-pit", status: "research-execution-only", officialUrl: "https://www.asxequitystocks.com.au/api", registration: "free-beta-key", fields: ["symbol", "last", "bid", "ask", "volume", "market_depth", "as_of"] },
    { name: "stockanalysis-asx-snapshot", market: "ASX", dataset: "fundamentals", access: "free-public", pit: "shadow-only", status: "current-snapshot", officialUrl: "https://stockanalysis.com/quote/asx/", registration: "none", fields: ["name", "sector", "industry", "market_cap", "revenue", "net_income", "pe", "dividend_yield", "beta", "as_of"] },
    { name: "cninfo-official-disclosure", market: "CN", dataset: "news/financial_disclosures", access: "free-public", pit: "strict-event", status: "ready", officialUrl: "https://www.cninfo.com.cn/?lang=en", registration: "none", fields: ["symbol", "published_at", "available_at", "source_url", "event_type", "revision"] },
    { name: "sse-szse-official-disclosure", market: "CN", dataset: "news/financial_disclosures", access: "free-public", pit: "strict-event", status: "companion-source", officialUrl: "https://www.sse.com.cn/disclosure/", registration: "none", fields: ["symbol", "published_at", "available_at", "source_url", "event_type", "revision"] },
    { name: "fred-alfred", market: "US/ASX/CN", dataset: "macro", access: "free-api-key", pit: "strict-vintage", status: "ready", officialUrl: "https://fred.stlouisfed.org/docs/api/fred/alfred.html", registration: "one-key-per-user", fields: ["series_id", "observation_date", "release_date", "realtime_start", "realtime_end", "vintage", "value"] },
    { name: "rba-official", market: "ASX", dataset: "macro/news", access: "free-public", pit: "strict-event", status: "ready", officialUrl: "https://www.rba.gov.au/statistics/", registration: "none", fields: ["series_id", "event_time", "published_at", "available_at", "revision", "value"] },
    { name: "gdelt", market: "US/ASX/CN", dataset: "news", access: "free-no-key", pit: "event-timestamp", status: "ready", officialUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/", registration: "none", fields: ["event_time", "published_at", "first_seen_at", "source_url", "entity", "event_type"] },
    { name: "bls-public-api-shadow", market: "US", dataset: "macro", access: "free-no-key", pit: "shadow-only", status: "ready", officialUrl: "https://www.bls.gov/developers/", registration: "none", fields: ["series_id", "observation_date", "release_date", "value"] },
    { name: "abs-sdmx", market: "ASX", dataset: "macro", access: "free-no-key", pit: "requires-dataflow", status: "configured-by-dataset", officialUrl: "https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide/using-api", registration: "none", fields: ["dataflow", "observation_date", "release_date", "revision", "value"] },
    { name: "alpha-vantage-listing-status", market: "US", dataset: "universe", access: "free-api-key", pit: "strict-event", status: "limited-quota", officialUrl: "https://www.alphavantage.co/documentation/", registration: "free-key", fields: ["symbol", "exchange", "status", "name", "date", "available_at"] },
    { name: "simfin-asreported", market: "US", dataset: "fundamentals", access: "free-api-key", pit: "strict-when-filed", status: "limited-quota", officialUrl: "https://www.simfin.com/en/api/", registration: "free-account", fields: ["period_end", "published_at", "filing_date", "revision", "revenue", "net_income", "assets", "liabilities", "cfo", "capex"] },
    { name: "akshare-public-adapters", market: "CN", dataset: "fundamentals/news/corporate_actions", access: "free-no-key", pit: "shadow-unless-release-time", status: "research-fallback", officialUrl: "https://akshare.akfamily.xyz/", registration: "none", fields: ["symbol", "event_time", "published_at", "available_at", "source_url", "revision"] },
    { name: "ricequant-rqdata", market: "CN", dataset: "historical-ohlcv/adjusted-bars", access: "licensed-trial", pit: "strict-bars", status: "configured-by-license", officialUrl: "https://www.ricequant.com/doc/rqsdk/manual-rqsdk", registration: "licensed-trial", fields: ["timestamp", "open", "high", "low", "close", "volume", "adjustment", "available_at"] },
  ];
}

const PIT_GAP_DEFINITIONS = Object.freeze([
  { id: "historical_universe", label: "历史股票池/退市/换代码", dataset: "universe", minimum: 80, fields: ["listing_date", "delisting_date", "membership_from", "membership_to", "identifier_map", "available_at"], sources: ["sec-edgar-bulk-submissions", "alpha-vantage-listing-status", "fmp", "tushare", "asx-official-announcements", "finra-otc-directories"] },
  { id: "corporate_actions", label: "拆股、分红与复权", dataset: "corporate_actions", minimum: 95, fields: ["action_type", "ex_date", "record_date", "pay_date", "ratio", "cash_amount", "adjustment_factor", "raw_price", "adjusted_price", "available_at"], sources: ["yahoo-finance-chart-events", "tiingo", "fmp", "tushare", "baostock", "eastmoney-public-corporate-actions"] },
  { id: "pit_fundamentals", label: "点时财报与基本面", dataset: "fundamentals", minimum: 80, fields: ["period_end", "filed_at", "published_at", "available_at", "revision", "revenue", "net_income", "cfo", "capex", "roe", "roic"], sources: ["sec-edgar", "simfin-asreported", "fmp", "tushare", "cninfo-official-disclosure"] },
  { id: "events_news", label: "公告、新闻与事件", dataset: "news", minimum: 80, fields: ["event_time", "published_at", "available_at", "first_seen_at", "source_url", "entity", "event_type", "revision"], sources: ["asx-official-announcements", "cninfo-official-disclosure", "sse-szse-official-disclosure", "gdelt", "marketaux", "common-crawl-index", "internet-archive-wayback-cdx"] },
  { id: "industry_semantics", label: "历史行业语义", dataset: "universe", minimum: 95, fields: ["taxonomy", "sector", "industry", "effective_from", "effective_to", "source", "available_at"], sources: ["sec-edgar", "openfigi", "tushare", "asx-official-announcements"] },
  { id: "macro_vintage", label: "宏观发布版本", dataset: "macro", minimum: 80, fields: ["series_id", "observation_date", "release_date", "realtime_start", "realtime_end", "vintage", "value"], sources: ["fred-alfred", "rba-official", "abs-sdmx", "bls-public-api-shadow"] },
]);

function buildPitGapReport({ market = "ALL", coverage = {}, providerStatus = [], coverageAvailable = true } = {}) {
  const key = String(market || "ALL").toUpperCase();
  const providers = new Map((Array.isArray(providerStatus) ? providerStatus : []).map((row) => [String(row.name), row]));
  const providerAliases = {
    "sec-edgar": "sec",
    "sec-edgar-bulk-submissions": "sec",
    "simfin-asreported": "simfin",
    "fred-alfred": "fred-alfred",
  };
  const rows = PIT_GAP_DEFINITIONS.map((definition) => {
    const datasetCoverage = coverage?.[definition.dataset] || {};
    const marketCoverage = definition.dataset === "macro"
      ? key === "ALL"
        ? Number(datasetCoverage.marketDateCoveragePct?.ALL ?? datasetCoverage.verifiedPct ?? 0)
        : Number(datasetCoverage.marketDateCoveragePct?.[key] ?? datasetCoverage.verifiedMarketPct?.[key] ?? 0)
      : key === "ALL"
        ? Number(datasetCoverage.trainingUniverseCoveragePct?.ALL ?? datasetCoverage.verifiedPct ?? 0)
        : Number(datasetCoverage.trainingUniverseCoveragePct?.[key] ?? datasetCoverage.verifiedMarketPct?.[key] ?? 0);
    const sourceRows = definition.sources.map((name) => ({
      name,
      configured: providers.get(providerAliases[name] || name)?.configured ?? null,
      status: providers.get(providerAliases[name] || name)?.status || "not_registered_in_runtime",
    }));
    const verified = coverageAvailable && Number.isFinite(marketCoverage) ? marketCoverage : null;
    return {
      ...definition,
      market: key,
      coveragePct: verified === null ? null : Number(verified.toFixed(4)),
      meetsMinimum: verified !== null && verified >= definition.minimum,
      missingFields: definition.fields,
      sourceRows,
      action: !coverageAvailable
        ? "await_data_audit_snapshot_before_scoring_gap"
        : verified >= definition.minimum
        ? "keep_auditing_and_test_incremental_OOF"
        : "queue_resumable_backfill_and_rebuild_frozen_snapshot",
      coverageBasis: definition.dataset === "macro" ? "market-date-coverage" : "training-universe-symbol-coverage",
    };
  });
  return {
    market: key,
    generatedAt: new Date().toISOString(),
    strictOofReady: rows.every((row) => row.meetsMinimum),
    definitions: rows,
    note: "覆盖率仅表示审计后的可验证记录，不代表模型已经获得增量预测能力；未满足门槛的数据只能进入 Shadow，不能提升线上置信度。",
  };
}

export {
  buildPitGapReport,
  normalizeBlsMacroRecords,
  normalizeCninfoAnnouncementRecords,
  publicPitSourceCatalog,
};
