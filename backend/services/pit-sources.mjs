function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function isoDay(value, endOfDay = false) {
  const text = String(value || "").trim();
  const day = /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
}

function safeIsoTimestamp(value, fallback = null) {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function tableRows(payload = {}) {
  if (Number(payload?.code || 0) !== 0) return [];
  const fields = Array.isArray(payload?.data?.fields) ? payload.data.fields : [];
  return (Array.isArray(payload?.data?.items) ? payload.data.items : []).map((item) => (
    Object.fromEntries(fields.map((field, index) => [field, item[index]]))
  ));
}

function secRecentRows(submissions = {}) {
  const recent = submissions?.filings?.recent || {};
  const length = Math.max(0, ...(Object.values(recent).filter(Array.isArray).map((rows) => rows.length)));
  return Array.from({ length }, (_, index) => Object.fromEntries(
    Object.entries(recent).map(([key, values]) => [key, Array.isArray(values) ? values[index] : null]),
  ));
}

const SEC_CONCEPTS = Object.freeze({
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capitalExpenditure: ["PaymentsToAcquirePropertyPlantAndEquipment"],
  dilutedEps: ["EarningsPerShareDiluted"],
});

function conceptEntries(companyFacts = {}, aliases = []) {
  for (const namespace of ["us-gaap", "ifrs-full"]) {
    for (const alias of aliases) {
      const units = companyFacts?.facts?.[namespace]?.[alias]?.units || {};
      const preferred = units.USD || units["USD/shares"] || units.shares || Object.values(units)[0];
      if (Array.isArray(preferred) && preferred.length) return preferred;
    }
  }
  return [];
}

function normalizeSecPitRecords(symbol, submissions = {}, companyFacts = {}) {
  const acceptanceByAccession = new Map(secRecentRows(submissions).map((row) => [
    String(row.accessionNumber || ""),
    safeIsoTimestamp(row.acceptanceDateTime, isoDay(row.filingDate, true)),
  ]));
  const grouped = new Map();
  for (const [valueName, aliases] of Object.entries(SEC_CONCEPTS)) {
    for (const row of conceptEntries(companyFacts, aliases)) {
      if (!row?.accn || !["10-K", "10-Q", "20-F", "40-F", "6-K"].includes(String(row.form || ""))) continue;
      const value = finite(row.val);
      const eventTime = isoDay(row.end, true);
      const availableAt = acceptanceByAccession.get(String(row.accn)) || isoDay(row.filed, true);
      if (value === null || !eventTime || !availableAt) continue;
      const current = grouped.get(row.accn) || {
        id: `${symbol}:${row.accn}`,
        accession: row.accn,
        form: row.form,
        fiscalYear: row.fy,
        fiscalPeriod: row.fp,
        event_time: eventTime,
        available_at: availableAt,
        revision: row.accn,
        historicalAvailabilityVerified: true,
        values: {},
      };
      current.values[valueName] = value;
      grouped.set(row.accn, current);
    }
  }
  const records = [...grouped.values()].sort((left, right) => left.event_time.localeCompare(right.event_time));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const values = record.values;
    if (finite(values.revenue) && finite(values.netIncome)) {
      values.profitMargin = clamp(values.netIncome / Math.max(1, Math.abs(values.revenue)));
    }
    const previous = records.slice(0, index).reverse().find((candidate) => (
      candidate.fiscalPeriod === record.fiscalPeriod
      && Number(candidate.fiscalYear) === Number(record.fiscalYear) - 1
    ));
    if (previous && finite(previous.values.netIncome) !== null && finite(values.netIncome) !== null) {
      values.earningsGrowth = clamp((values.netIncome - previous.values.netIncome) / Math.max(1, Math.abs(previous.values.netIncome)));
    }
    if (previous && finite(previous.values.revenue) !== null && finite(values.revenue) !== null) {
      values.revenueGrowth = clamp((values.revenue - previous.values.revenue) / Math.max(1, Math.abs(previous.values.revenue)));
    }
    values.sourceQuality = 1;
  }
  return records;
}

function normalizeTusharePitRecords(symbol, payload = {}) {
  return tableRows(payload).flatMap((row) => {
    const availableAt = isoDay(row.f_ann_date || row.ann_date, true);
    const eventTime = isoDay(row.end_date, true);
    if (!availableAt || !eventTime) return [];
    const margin = finite(row.netprofit_margin ?? row.grossprofit_margin);
    const earningsGrowth = finite(row.netprofit_yoy ?? row.profit_dedt_yoy);
    const revenueGrowth = finite(row.or_yoy ?? row.tr_yoy);
    const values = {
      profitMargin: margin === null ? 0 : clamp(margin / 100),
      earningsGrowth: earningsGrowth === null ? 0 : clamp(earningsGrowth / 100),
      revenueGrowth: revenueGrowth === null ? 0 : clamp(revenueGrowth / 100),
      returnOnEquity: finite(row.roe) === null ? null : finite(row.roe) / 100,
      debtToAssets: finite(row.debt_to_assets) === null ? null : finite(row.debt_to_assets) / 100,
      currentRatio: finite(row.current_ratio),
      sourceQuality: 0.92,
    };
    return [{
      id: `${symbol}:${row.end_date}:${row.ann_date || row.f_ann_date || "initial"}`,
      event_time: eventTime,
      available_at: availableAt,
      revision: row.update_flag || row.ann_date || "initial",
      historicalAvailabilityVerified: true,
      values,
    }];
  });
}

function normalizeTushareUniverseRecords(payload = {}) {
  return tableRows(payload).flatMap((row) => {
    const symbol = String(row.symbol || String(row.ts_code || "").split(".")[0] || "").trim();
    if (!/^\d{6}$/.test(symbol)) return [];
    const records = [];
    const listedAt = isoDay(row.list_date, false);
    if (listedAt) records.push({
      id: `${symbol}:listed:${row.list_date}`,
      symbol,
      exchange: row.exchange,
      name: row.name,
      listed: true,
      status: "active",
      event_time: listedAt,
      available_at: listedAt,
      revision: "listing-event",
      historicalAvailabilityVerified: true,
    });
    const delistedAt = isoDay(row.delist_date, false);
    if (delistedAt) records.push({
      id: `${symbol}:delisted:${row.delist_date}`,
      symbol,
      exchange: row.exchange,
      name: row.name,
      listed: false,
      status: "delisted",
      event_time: delistedAt,
      available_at: delistedAt,
      revision: "delisting-event",
      historicalAvailabilityVerified: true,
    });
    return records;
  });
}

function normalizedObjectRows(payload = {}) {
  const direct = Array.isArray(payload) ? payload : [];
  const nested = [payload?.data, payload?.results, payload?.statements, payload?.financials]
    .filter(Array.isArray)
    .flat();
  const companies = (Array.isArray(payload) ? payload : [payload]).flatMap((company) => (
    [company?.data, company?.results, company?.statements, company?.financials]
      .filter(Array.isArray)
      .flat()
      .map((row) => ({
        ...(row && typeof row === "object" && !Array.isArray(row) ? row : {}),
        ticker: row?.ticker || company?.ticker,
        simfinId: row?.simfinId || row?.id || company?.simfinId || company?.id,
      }))
  ));
  const compactStatements = (Array.isArray(payload) ? payload : [payload]).flatMap((company) => (
    (Array.isArray(company?.statements) ? company.statements : []).flatMap((statement) => {
      const columns = Array.isArray(statement?.columns) ? statement.columns : [];
      const names = columns.map((column, index) => (
        typeof column === "string"
          ? column
          : column?.name || column?.caption || column?.label || column?.field || column?.internalId || column?.id || `column_${index}`
      ));
      const data = Array.isArray(statement?.data) ? statement.data : [];
      return data.map((item) => ({
        ...(Array.isArray(item)
          ? Object.fromEntries(names.map((name, index) => [name, item[index]]))
          : item && typeof item === "object" ? item : {}),
        statement: statement?.statement,
        ticker: company?.ticker,
        simfinId: company?.id || company?.simfinId,
        currency: company?.currency,
      }));
    })
  ));
  return [...direct, ...nested, ...companies, ...compactStatements]
    .filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

function firstValue(row, aliases = []) {
  const entries = Object.entries(row || {});
  for (const alias of aliases) {
    const normalizedAlias = String(alias).toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = entries.find(([key]) => String(key).toLowerCase().replace(/[^a-z0-9]/g, "") === normalizedAlias);
    if (match && match[1] !== null && match[1] !== undefined && match[1] !== "") return match[1];
  }
  return null;
}

function normalizeSimfinPitRecords(symbol, payload = {}) {
  const rows = normalizedObjectRows(payload);
  const normalized = rows.flatMap((raw, index) => {
    const row = {
      ...(raw.values && typeof raw.values === "object" ? raw.values : {}),
      ...(raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : {}),
      ...raw,
    };
    const eventTime = safeIsoTimestamp(firstValue(row, [
      "reportDate", "endDate", "periodEndDate", "asOf", "date", "Report Date",
    ]), null) || isoDay(firstValue(row, ["reportDate", "endDate", "periodEndDate", "asOf", "date"]), true);
    const availableAt = safeIsoTimestamp(firstValue(row, [
      "publishDate", "publishedDate", "filingDate", "acceptedDate", "acceptedAt", "datePublished", "Publish Date",
    ]), null) || isoDay(firstValue(row, [
      "publishDate", "publishedDate", "filingDate", "acceptedDate", "datePublished", "Publish Date",
    ]), true);
    if (!eventTime || !availableAt) return [];
    const revenue = finite(firstValue(row, ["revenue", "totalRevenue", "Revenue"]));
    const netIncome = finite(firstValue(row, ["netIncome", "netIncomeCommon", "Net Income"]));
    const assets = finite(firstValue(row, ["totalAssets", "assets", "Total Assets"]));
    const liabilities = finite(firstValue(row, ["totalLiabilities", "liabilities", "Total Liabilities"]));
    const equity = finite(firstValue(row, ["totalEquity", "shareholdersEquity", "equity", "Total Equity"]));
    const operatingCashFlow = finite(firstValue(row, ["operatingCashFlow", "cashFromOperatingActivities", "Net Cash from Operating Activities"]));
    const capitalExpenditure = finite(firstValue(row, ["capitalExpenditure", "capex", "Capital Expenditures"]));
    const dilutedEps = finite(firstValue(row, ["dilutedEps", "epsDiluted", "Diluted EPS"]));
    const coreValues = {
      revenue,
      netIncome,
      assets,
      liabilities,
      equity,
      operatingCashFlow,
      capitalExpenditure,
      dilutedEps,
      profitMargin: revenue !== null && netIncome !== null
        ? clamp(netIncome / Math.max(1, Math.abs(revenue)))
        : null,
      debtToAssets: assets !== null && liabilities !== null
        ? clamp(liabilities / Math.max(1, Math.abs(assets)), 0, 3)
        : null,
    };
    if (!Object.values(coreValues).some((value) => value !== null && value !== undefined)) return [];
    const values = { ...coreValues, sourceQuality: 0.94 };
    const revision = String(firstValue(row, ["restatedDate", "filingDate", "publishDate", "acceptedDate"]) || availableAt).slice(0, 40);
    return [{
      id: `${symbol}:${firstValue(row, ["simfinId", "id"]) || "simfin"}:${eventTime.slice(0, 10)}:${index}`,
      event_time: eventTime,
      available_at: availableAt,
      revision,
      statement: firstValue(row, ["statement", "statementType"]),
      fiscalYear: firstValue(row, ["fyear", "fiscalYear"]),
      fiscalPeriod: firstValue(row, ["period", "fiscalPeriod"]),
      historicalAvailabilityVerified: true,
      sourceProvider: "simfin-asreported-pit",
      values,
    }];
  });
  return [...new Map(normalized.map((record) => [
    `${record.event_time}:${record.available_at}:${record.statement || ""}:${record.fiscalPeriod || ""}`,
    record,
  ])).values()].sort((left, right) => (
    left.available_at.localeCompare(right.available_at) || left.event_time.localeCompare(right.event_time)
  ));
}

function normalizeFmpHistoricalUniverseRecords(payload = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.flatMap((row) => {
    const symbol = String(row.symbol || row.ticker || row.newSymbol || "").trim().toUpperCase();
    if (!symbol) return [];
    const records = [];
    const listedAt = isoDay(row.ipoDate || row.listingDate || row.dateFirstTrading, false);
    if (listedAt) records.push({
      id: `${symbol}:listed:${listedAt.slice(0, 10)}`,
      symbol,
      exchange: row.exchange || row.exchangeShortName || "US",
      name: row.companyName || row.name || symbol,
      listed: true,
      status: "active",
      event_time: listedAt,
      available_at: listedAt,
      revision: "listing-event",
      historicalAvailabilityVerified: true,
    });
    const delistedAt = isoDay(row.delistedDate || row.delistingDate, false);
    if (delistedAt) records.push({
      id: `${symbol}:delisted:${delistedAt.slice(0, 10)}`,
      symbol,
      exchange: row.exchange || row.exchangeShortName || "US",
      name: row.companyName || row.name || symbol,
      listed: false,
      status: "delisted",
      event_time: delistedAt,
      available_at: delistedAt,
      revision: "delisting-event",
      historicalAvailabilityVerified: true,
    });
    return records;
  });
}

function normalizeFmpSymbolChangeRecords(payload = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.flatMap((row) => {
    const eventTime = isoDay(row.date || row.effectiveDate, false);
    const oldSymbol = String(row.oldSymbol || row.symbolFrom || "").trim().toUpperCase();
    const newSymbol = String(row.newSymbol || row.symbolTo || "").trim().toUpperCase();
    if (!eventTime || !oldSymbol || !newSymbol) return [];
    return [{
      id: `${oldSymbol}:${newSymbol}:${eventTime.slice(0, 10)}`,
      symbol: newSymbol,
      previousSymbol: oldSymbol,
      name: row.name || row.companyName || newSymbol,
      listed: true,
      status: "symbol-change",
      event_time: eventTime,
      available_at: eventTime,
      revision: "symbol-change-event",
      historicalAvailabilityVerified: true,
    }];
  });
}

function normalizeOpenFigiMappings(symbols = [], payload = [], market = "US", retrievedAt = new Date().toISOString()) {
  const requested = Array.isArray(symbols) ? symbols : [];
  const responses = Array.isArray(payload) ? payload : [];
  return responses.flatMap((response, index) => {
    const symbol = String(requested[index] || "").trim().toUpperCase();
    const candidates = Array.isArray(response?.data) ? response.data : [];
    const equity = candidates.find((row) => String(row.marketSector || "").toLowerCase() === "equity") || candidates[0];
    if (!symbol || !equity?.figi) return [];
    return [{
      id: `${market}:${symbol}:${equity.figi}`,
      symbol,
      name: equity.name || symbol,
      exchange: equity.exchCode || market,
      figi: equity.figi,
      compositeFigi: equity.compositeFIGI || null,
      shareClassFigi: equity.shareClassFIGI || null,
      securityType: equity.securityType || equity.securityType2 || null,
      marketSector: equity.marketSector || null,
      ticker: equity.ticker || symbol,
      listed: true,
      status: "identifier-mapping",
      event_time: retrievedAt,
      available_at: retrievedAt,
      revision: equity.figi,
      identifierMappingVerified: true,
      historicalAvailabilityVerified: false,
      historicalAvailabilityUnverified: true,
    }];
  });
}

function normalizeEastmoneyPitRecords(symbol, payload = {}) {
  const rows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  return rows.flatMap((row) => {
    const eventTime = isoDay(row.REPORT_DATE, true);
    const noticeAt = isoDay(row.NOTICE_DATE, true);
    const updateAt = isoDay(row.UPDATE_DATE, true);
    const availableAt = [noticeAt, updateAt].filter(Boolean).sort().at(-1);
    if (!eventTime || !availableAt) return [];
    const ratio = (value) => finite(value) === null ? null : finite(value) / 100;
    return [{
      id: `${symbol}:${String(row.REPORT_DATE || "").slice(0, 10)}:${String(row.UPDATE_DATE || row.NOTICE_DATE || "initial").slice(0, 10)}`,
      event_time: eventTime,
      available_at: availableAt,
      revision: String(row.UPDATE_DATE || row.NOTICE_DATE || "initial").slice(0, 19),
      historicalAvailabilityVerified: true,
      sourceProvider: "eastmoney-finance-main-pit",
      values: {
        profitMargin: ratio(row.XSJLL),
        grossProfitMargin: ratio(row.XSMLL),
        earningsGrowth: ratio(row.PARENTNETPROFITTZ),
        revenueGrowth: ratio(row.TOTALOPERATEREVETZ),
        returnOnEquity: ratio(row.ROEJQ),
        debtToAssets: ratio(row.ZCFZL),
        currentRatio: finite(row.LD),
        operatingCashFlow: finite(row.NETCASH_OPERATE_PK),
        totalAssets: finite(row.TOTAL_ASSETS_PK),
        totalEquity: finite(row.TOTAL_EQUITY_PK),
        sourceQuality: 0.86,
      },
    }];
  });
}

const MACRO_DIRECTION = Object.freeze({
  FEDFUNDS: -1,
  DGS10: -1,
  CPIAUCSL: -1,
  UNRATE: -1,
  VIXCLS: -1,
  GDP: 1,
  IRSTCI01AUM156N: -1,
  CPALTT01AUM657N: -1,
  LRUNTTTTAUM156S: -1,
  IRSTCI01CNM156N: -1,
  CPALTT01CNM659N: -1,
  LRUNTTTTCNM156S: -1,
});

function normalizeFredVintageRecords(seriesId, observations = []) {
  const rows = observations.map((row) => ({
    date: String(row.date || "").slice(0, 10),
    availableAt: isoDay(row.realtime_start, false),
    value: finite(row.value),
  })).filter((row) => row.value !== null && row.availableAt && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  rows.sort((left, right) => left.date.localeCompare(right.date));
  const changes = [];
  return rows.map((row, index) => {
    const previous = index ? rows[index - 1].value : row.value;
    const change = row.value - previous;
    const history = changes.slice(Math.max(0, changes.length - 24));
    const mean = history.reduce((sum, value) => sum + value, 0) / Math.max(1, history.length);
    const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, history.length);
    const scale = Math.sqrt(variance) || Math.max(1e-6, Math.abs(previous) * 0.02);
    const surprise = clamp((change - mean) / scale, -3, 3) / 3;
    changes.push(change);
    const sentiment = clamp((MACRO_DIRECTION[seriesId] || 0) * surprise);
    return {
      id: `${seriesId}:${row.date}:${row.availableAt.slice(0, 10)}`,
      seriesId,
      event_time: `${row.date}T23:59:59Z`,
      available_at: row.availableAt,
      revision: "initial-release",
      historicalAvailabilityVerified: true,
      rawValue: row.value,
      values: {
        eventSentiment: sentiment,
        eventRelevance: 0.8,
        eventNovelty: Math.abs(surprise),
        macroRisk: sentiment,
        sourceQuality: 1,
      },
    };
  });
}

function normalizePublishedPitRecords(items = [], options = {}) {
  return items.flatMap((item, index) => {
    const publishedAt = item.publishedAt || item.available_at || item.date;
    const text = String(publishedAt || "").trim();
    const availableAt = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? isoDay(text, true)
      : safeIsoTimestamp(text);
    if (!availableAt) return [];
    return [{
      ...item,
      id: item.id || item.link || `${options.symbol || "MARKET"}:${availableAt}:${index}`,
      event_time: availableAt,
      available_at: availableAt,
      revision: "initial",
      sourceQuality: Number(item.sourceQuality ?? options.sourceQuality ?? 0.8),
      historicalAvailabilityVerified: true,
    }];
  });
}

export {
  normalizeFmpHistoricalUniverseRecords,
  normalizeFmpSymbolChangeRecords,
  normalizeOpenFigiMappings,
  normalizeEastmoneyPitRecords,
  normalizeFredVintageRecords,
  normalizePublishedPitRecords,
  normalizeSecPitRecords,
  normalizeSimfinPitRecords,
  normalizeTusharePitRecords,
  normalizeTushareUniverseRecords,
  tableRows,
};
