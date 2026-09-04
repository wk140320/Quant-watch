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
  const text = String(value || "").trim();
  const compact = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/.exec(text);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] || "00"}:${compact[5] || "00"}:${compact[6] || "00"}Z`
    : text;
  const parsed = new Date(normalized);
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

function normalizeSecDisclosureRecords(symbol, submissionRows = []) {
  const code = String(symbol || "").trim().toUpperCase();
  const rows = Array.isArray(submissionRows) ? submissionRows : [];
  const allowedForms = /^(?:10-K|10-Q|8-K|20-F|40-F|6-K)(?:\/A)?$/i;
  return rows.flatMap((row, index) => {
    const form = String(row?.form || "").trim().toUpperCase();
    const filed = isoDay(row?.filingDate, true);
    const accepted = safeIsoTimestamp(row?.acceptanceDateTime, filed);
    const eventTime = isoDay(row?.reportDate || row?.filingDate, true);
    if (!code || !allowedForms.test(form) || !eventTime || !accepted) return [];
    return [{
      id: `${code}:sec:${String(row?.accessionNumber || index)}:${accepted}`,
      symbol: code,
      form,
      accession: row?.accessionNumber || null,
      primaryDocument: row?.primaryDocument || null,
      reportDate: row?.reportDate || row?.filingDate || null,
      filingDate: row?.filingDate || null,
      event_time: eventTime,
      available_at: accepted,
      first_seen_at: accepted,
      revision: String(row?.accessionNumber || row?.primaryDocument || form).slice(0, 80),
      historicalAvailabilityVerified: true,
      historicalAvailabilityVerificationMethod: "sec-edgar-acceptance-datetime",
      sourceProvider: "sec-edgar-filing-history-pit",
      disclosureType: /^(?:10-K|20-F|40-F)(?:\/A)?$/i.test(form)
        ? "annual-filing"
        : /^(?:10-Q)(?:\/A)?$/i.test(form)
          ? "quarterly-filing"
          : "current-filing",
      values: { filingEvent: 1, sourceQuality: 1 },
    }];
  });
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

// FMP statement rows expose the period end separately from filing/acceptance
// timestamps.  A row without one of those publication timestamps is useful for
// a current profile, but must not enter point-in-time model training.
function normalizeFmpStatementPitRecords(symbol, payload = {}, options = {}) {
  const statement = String(options.statement || "financial-statement");
  const sourceProvider = String(options.sourceProvider || "fmp-financial-statements-pit");
  const rows = normalizedObjectRows(payload);
  const records = rows.flatMap((raw, index) => {
    const row = {
      ...(raw.values && typeof raw.values === "object" ? raw.values : {}),
      ...(raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : {}),
      ...raw,
    };
    const eventTime = safeIsoTimestamp(firstValue(row, [
      "date", "reportDate", "calendarYear", "periodEndDate", "fiscalDateEnding",
    ]), null) || isoDay(firstValue(row, ["date", "reportDate", "periodEndDate", "fiscalDateEnding"]), true);
    const availableAt = safeIsoTimestamp(firstValue(row, [
      "acceptedDate", "fillingDate", "filingDate", "publishedDate", "publicationDate", "datePublished",
    ]), null) || isoDay(firstValue(row, [
      "acceptedDate", "fillingDate", "filingDate", "publishedDate", "publicationDate", "datePublished",
    ]), true);
    if (!eventTime || !availableAt || availableAt < eventTime) return [];
    const revenue = finite(firstValue(row, ["revenue", "totalRevenue"]));
    const netIncome = finite(firstValue(row, ["netIncome", "netIncomeApplicableToCommonShares"]));
    const assets = finite(firstValue(row, ["totalAssets", "assets"]));
    const liabilities = finite(firstValue(row, ["totalLiabilities", "liabilities"]));
    const equity = finite(firstValue(row, ["totalStockholdersEquity", "totalEquity", "stockholdersEquity", "totalEquityGrossMinorityInterest"]));
    const operatingCashFlow = finite(firstValue(row, ["operatingCashFlow", "netCashProvidedByOperatingActivities"]));
    const capitalExpenditure = finite(firstValue(row, ["capitalExpenditure", "investmentsInPropertyPlantAndEquipment"]));
    const dilutedEps = finite(firstValue(row, ["epsdiluted", "epsDiluted", "eps"]));
    const values = {
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
      sourceQuality: Number(options.sourceQuality ?? 0.93),
    };
    if (!Object.values(values).some((value) => value !== null && value !== undefined && value !== 0.93)) return [];
    return [{
      id: `${symbol}:${statement}:${String(firstValue(row, ["cik", "reportedCurrency", "period"]) || "row")}:${eventTime.slice(0, 10)}:${availableAt.slice(0, 10)}:${index}`,
      event_time: eventTime,
      available_at: availableAt,
      revision: String(firstValue(row, ["acceptedDate", "fillingDate", "filingDate", "finalLink", "link"]) || availableAt).slice(0, 80),
      statement,
      fiscalYear: firstValue(row, ["calendarYear", "fiscalYear"]),
      fiscalPeriod: firstValue(row, ["period", "fiscalPeriod"]),
      historicalAvailabilityVerified: true,
      historicalAvailabilityMethod: "fmp-published-filing-timestamp",
      sourceProvider,
      values,
    }];
  });
  return [...new Map(records.map((record) => [
    `${record.statement}:${record.event_time}:${record.available_at}:${record.fiscalPeriod || ""}`,
    record,
  ])).values()].sort((left, right) => (
    left.available_at.localeCompare(right.available_at) || left.event_time.localeCompare(right.event_time)
  ));
}

function externalFinancialRows(payload = {}) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.data,
    payload?.financials,
    payload?.statements,
    payload?.results,
    payload?.rows,
    payload?.items,
  ];
  const direct = candidates.find((value) => Array.isArray(value));
  if (direct) return direct;
  return Object.values(payload || {})
    .filter((value) => Array.isArray(value))
    .flat();
}

function normalizeExternalFinancialPitRecords(symbol, payload = {}, options = {}) {
  const sourceProvider = String(options.sourceProvider || "external-financials-pit");
  const sourceName = String(options.sourceName || sourceProvider);
  const retrievedAt = safeIsoTimestamp(options.retrievedAt, new Date().toISOString());
  const filings = Array.isArray(options.filings) ? options.filings : [];
  const rows = externalFinancialRows(payload);
  const number = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const normalized = rows.flatMap((raw, index) => {
    const row = raw && typeof raw === "object" ? raw : {};
    const year = firstValue(row, ["fiscalYear", "fiscal_year", "year", "calendarYear"]);
    const periodEnd = firstValue(row, [
      "periodEnd", "period_end", "periodEndDate", "period_end_date", "reportDate", "report_date",
      "date", "fiscalDateEnding", "fiscal_date_ending",
    ]);
    const eventTime = safeIsoTimestamp(periodEnd, null)
      || (/^\d{4}$/.test(String(year || "")) ? isoDay(`${year}-06-30`, true) : null);
    if (!eventTime) return [];
    const fiscalYear = String(year || eventTime.slice(0, 4));
    const periodType = firstValue(row, ["periodType", "period_type", "period", "reportType", "report_type"]);
    const filing = filings.find((candidate) => {
      const filingText = JSON.stringify(candidate || {}).toLowerCase();
      const sameYear = filingText.includes(String(fiscalYear).toLowerCase());
      const samePeriod = !periodType || /annual|fy|full/i.test(String(periodType))
        ? /annual|full|fy/i.test(filingText)
        : /half|interim|h1|h2/i.test(filingText);
      return sameYear && samePeriod;
    });
    const directAvailable = firstValue(row, [
      "availableAt", "available_at", "filedAt", "filed_at", "filingDate", "filing_date",
      "publishedAt", "published_at", "publishedDate", "published_date", "releaseDate", "release_date",
      "announcementDate", "announcement_date",
    ]);
    const filingAvailable = firstValue(filing, ["filingDate", "filing_date", "publishedAt", "published_at"]);
    const availableAt = safeIsoTimestamp(directAvailable || filingAvailable, null);
    const verified = Boolean(availableAt && availableAt >= eventTime);
    const values = {
      revenue: number(firstValue(row, ["revenue", "totalRevenue", "total_revenue", "sales"])),
      netIncome: number(firstValue(row, ["netIncome", "net_income", "profitAfterTax", "profit_after_tax"])),
      assets: number(firstValue(row, ["totalAssets", "total_assets", "assets"])),
      liabilities: number(firstValue(row, ["totalLiabilities", "total_liabilities", "liabilities"])),
      equity: number(firstValue(row, ["totalEquity", "total_equity", "shareholdersEquity", "shareholders_equity"])),
      operatingCashFlow: number(firstValue(row, ["operatingCashFlow", "operating_cash_flow", "cashFromOperatingActivities"])),
      capitalExpenditure: number(firstValue(row, ["capitalExpenditures", "capital_expenditures", "capitalExpenditure", "capex"])),
      dilutedEps: number(firstValue(row, ["epsDiluted", "eps_diluted", "dilutedEps", "eps"])),
      cashAndEquivalents: number(firstValue(row, ["cashAndEquivalents", "cash_and_equivalents", "cash"])),
      longTermDebt: number(firstValue(row, ["longTermDebt", "long_term_debt", "debt"])),
      sharesOutstanding: number(firstValue(row, ["sharesOutstanding", "shares_outstanding"])),
    };
    if (!Object.values(values).some((value) => value !== null)) return [];
    const effectiveAvailableAt = availableAt || retrievedAt;
    return [{
      id: `${symbol}:${sourceName}:${eventTime.slice(0, 10)}:${effectiveAvailableAt.slice(0, 10)}:${index}`,
      event_time: eventTime,
      available_at: effectiveAvailableAt,
      first_seen_at: retrievedAt,
      revision: String(firstValue(row, ["revision", "version", "filingId", "filing_id", "accession"]) || effectiveAvailableAt).slice(0, 100),
      statement: String(periodType || "financial-statement"),
      fiscalYear,
      fiscalPeriod: periodType || null,
      historicalAvailabilityVerified: verified,
      historicalAvailabilityUnverified: !verified,
      historicalAvailabilityVerificationMethod: verified
        ? `${sourceName}-filing-or-publication-date`
        : `${sourceName}-period-only-unverified`,
      sourceProvider,
      warning: verified ? null : `${sourceName} did not provide a verifiable filing/publication timestamp for this period; Shadow-only.`,
      values: {
        ...values,
        profitMargin: values.revenue !== null && values.netIncome !== null
          ? clamp(values.netIncome / Math.max(1, Math.abs(values.revenue)))
          : null,
        debtToAssets: values.assets !== null && values.liabilities !== null
          ? clamp(values.liabilities / Math.max(1, Math.abs(values.assets)), 0, 3)
          : null,
        sourceQuality: Number(options.sourceQuality ?? 0.75),
      },
    }];
  });
  return [...new Map(normalized.map((record) => [
    `${record.event_time}:${record.statement}:${record.fiscalPeriod || ""}`,
    record,
  ])).values()].sort((left, right) => (
    left.event_time.localeCompare(right.event_time) || left.available_at.localeCompare(right.available_at)
  ));
}

function normalizeGrowthWithValuePitRecords(symbol, payload = {}, options = {}) {
  return normalizeExternalFinancialPitRecords(symbol, payload, {
    ...options,
    sourceName: "growth-with-value",
    sourceProvider: options.sourceProvider || "growth-with-value-asx-financials",
    sourceQuality: options.sourceQuality ?? 0.72,
  });
}

function normalizeStockMarketApiPitRecords(symbol, payload = {}, options = {}) {
  return normalizeExternalFinancialPitRecords(symbol, payload, {
    ...options,
    sourceName: "stockmarketapi-ai",
    sourceProvider: options.sourceProvider || "stockmarketapi-ai-asx-financials",
    sourceQuality: options.sourceQuality ?? 0.84,
  });
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

function normalizeAlphaVantageListingStatusRecords(rows = []) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const symbol = String(row.symbol || row.ticker || "").trim().toUpperCase();
    if (!symbol || !/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return [];
    const exchange = String(row.exchange || "US").trim().toUpperCase() || "US";
    const name = String(row.name || row.companyName || symbol).trim() || symbol;
    const records = [];
    const listedAt = isoDay(row.ipoDate || row.listingDate, false);
    if (listedAt) records.push({
      id: `${symbol}:listed:${listedAt.slice(0, 10)}`,
      symbol,
      exchange,
      name,
      assetType: row.assetType || row.type || null,
      listed: true,
      status: "active",
      event_time: listedAt,
      available_at: listedAt,
      revision: "alpha-vantage-listing-status",
      historicalAvailabilityVerified: true,
      historicalAvailabilityMethod: "alpha-vantage-historical-listing-status",
      sourceProvider: "alphavantage-listing-status-pit",
    });
    const delistedAt = isoDay(row.delistingDate || row.delistedDate, false);
    if (delistedAt) records.push({
      id: `${symbol}:delisted:${delistedAt.slice(0, 10)}`,
      symbol,
      exchange,
      name,
      assetType: row.assetType || row.type || null,
      listed: false,
      status: "delisted",
      event_time: delistedAt,
      available_at: delistedAt,
      revision: "alpha-vantage-listing-status",
      historicalAvailabilityVerified: true,
      historicalAvailabilityMethod: "alpha-vantage-historical-listing-status",
      sourceProvider: "alphavantage-listing-status-pit",
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
  T10Y2Y: 1,
  CPIAUCSL: -1,
  UNRATE: -1,
  VIXCLS: -1,
  BAMLC0A0CM: -1,
  GDP: 1,
  IRSTCI01AUM156N: -1,
  IRLTLT01AUM156N: -1,
  CPALTT01AUM657N: -1,
  CPALTT01AUQ659N: -1,
  LRUNTTTTAUM156S: -1,
  AUSGDPRQPSMEI: 1,
  IRSTCI01CNM156N: -1,
  CPALTT01CNM659N: -1,
  LRUNTTTTCNM156S: -1,
});

const MACRO_FEATURE_BY_SERIES = Object.freeze({
  FEDFUNDS: "macroRatesImpulse",
  DGS10: "macroRatesImpulse",
  IRSTCI01AUM156N: "macroRatesImpulse",
  IRLTLT01AUM156N: "macroRatesImpulse",
  IRSTCI01CNM156N: "macroRatesImpulse",
  CPIAUCSL: "macroInflationImpulse",
  CPALTT01AUM657N: "macroInflationImpulse",
  CPALTT01AUQ659N: "macroInflationImpulse",
  CPALTT01CNM659N: "macroInflationImpulse",
  UNRATE: "macroLaborImpulse",
  LRUNTTTTAUM156S: "macroLaborImpulse",
  LRUNTTTTCNM156S: "macroLaborImpulse",
  GDP: "macroGrowthImpulse",
  AUSGDPRQPSMEI: "macroGrowthImpulse",
  VIXCLS: "macroVolatilityImpulse",
  BAMLC0A0CM: "macroCreditImpulse",
  T10Y2Y: "macroYieldCurveImpulse",
  DEXUSAL: "macroFxImpulse",
  DEXCHUS: "macroFxImpulse",
  DCOILBRENTEU: "macroCommodityImpulse",
  PCOPPUSDM: "macroCommodityImpulse",
  GOLDAMGBD228NLBM: "macroCommodityImpulse",
});

function nextUtcDay(day) {
  const timestamp = Date.parse(`${String(day || "").slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp + 86_400_000).toISOString() : null;
}

function normalizeFredVintageRecords(seriesId, observations = [], options = {}) {
  const rows = observations.map((row) => ({
    date: String(row.date || "").slice(0, 10),
    realtimeStart: String(row.realtime_start || row.realtimeStart || "").slice(0, 10),
    realtimeEnd: String(row.realtime_end || row.realtimeEnd || "").slice(0, 10),
    availableAt: [
      nextUtcDay(row.date),
      options.conservativeMarketClose === true ? null : isoDay(row.realtime_start, false),
    ].filter(Boolean).sort().at(-1),
    value: finite(row.value),
  })).filter((row) => row.value !== null && row.availableAt && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  rows.sort((left, right) => left.date.localeCompare(right.date) || left.availableAt.localeCompare(right.availableAt));
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
    const direction = MACRO_DIRECTION[seriesId];
    const sentiment = Number.isFinite(direction) ? clamp(direction * surprise) : 0;
    const featureName = MACRO_FEATURE_BY_SERIES[seriesId];
    const featureValue = Number.isFinite(direction) ? sentiment : surprise;
    const featureValues = featureName ? { [featureName]: featureValue } : {};
    const vintage = row.realtimeStart || row.availableAt.slice(0, 10);
    const realtimeEnd = row.realtimeEnd || "9999-12-31";
    return {
      id: `${seriesId}:${row.date}:${vintage}:${realtimeEnd}:${row.value}`,
      seriesId,
      event_time: `${row.date}T00:00:00Z`,
      available_at: row.availableAt,
      release_date: vintage,
      realtime_start: vintage,
      realtime_end: realtimeEnd,
      vintage,
      revision: `fred-vintage-${vintage}`,
      historicalAvailabilityVerified: true,
      historicalAvailabilityMethod: options.conservativeMarketClose === true
        ? "conservative-next-utc-day-market-observation"
        : "alfred-initial-release-vintage",
      rawValue: row.value,
      values: {
        ...featureValues,
        eventSentiment: sentiment,
        eventRelevance: 0.8,
        eventNovelty: Math.abs(surprise),
        macroRisk: sentiment,
        macroDataCoverage: 1,
        sourceQuality: 1,
      },
    };
  });
}

function normalizePublishedPitRecords(items = [], options = {}) {
  const verified = options.historicalAvailabilityVerified !== false;
  return items.flatMap((item, index) => {
    const publishedAt = item.publishedAt || item.available_at || item.date;
    const text = String(publishedAt || "").trim();
    const dateOnlyPublishedAt = /^\d{4}-\d{2}-\d{2}$/.test(text);
    const availableAt = dateOnlyPublishedAt
      ? isoDay(text, true)
      : safeIsoTimestamp(text);
    if (!availableAt) return [];
    // A provider date must never become a verified PIT timestamp before it is
    // observable locally.  This guards the daily-announcement path where a
    // date-only value is normalized to 23:59 and would otherwise be future
    // dated while the fetch is still in progress.
    const availableAtMs = Date.parse(availableAt);
    const futurePublishedAt = Number.isFinite(availableAtMs) && availableAtMs > Date.now();
    const recordVerified = verified && !futurePublishedAt;
    const title = String(item.title || "");
    const description = String(item.description || item.summary || "");
    const textContent = `${title} ${description}`.toLowerCase();
    const positiveMatches = textContent.match(/\b(upgrade|record (?:revenue|profit|sales)|profit (?:up|increase)|guidance (?:raised|upgraded)|contract (?:award|win)|approval granted|buyback|share repurchase|dividend increase|special dividend|production increase|discovery|milestone achieved)\b/g) || [];
    const negativeMatches = textContent.match(/\b(downgrade|profit warning|guidance (?:cut|lowered|withdrawn)|net loss|impairment|investigation|suspension|insolvency|default|penalty|litigation|cyber incident|production decrease|fatality)\b/g) || [];
    const earningsEvent = /\b(annual report|half[- ]year(?:ly)? report|quarterly report|financial results|appendix 4[de]|earnings|preliminary final report)\b/.test(textContent);
    const positiveCapital = /\b(buyback|share repurchase|return of capital|special dividend|dividend increase)\b/.test(textContent);
    const dilution = /\b(placement|entitlement offer|rights issue|issue of (?:new )?shares|capital raising|convertible notes?)\b/.test(textContent);
    const regulatory = /\b(regulator|regulatory notice|investigation|litigation|court proceedings?|penalty|class action|compliance breach)\b/.test(textContent);
    const operationalPositive = /\b(contract award|production increase|guidance raised|guidance upgraded|discovery|milestone achieved)\b/.test(textContent);
    const operationalNegative = /\b(production decrease|guidance cut|guidance lowered|guidance withdrawn|shutdown|suspension|fatality)\b/.test(textContent);
    const existingValues = item.values && typeof item.values === "object" ? item.values : {};
    const suppliedSentiment = finite(existingValues.eventSentiment ?? item.eventSentiment ?? item.sentiment ?? item.sentimentScore);
    const lexicalSentiment = clamp((positiveMatches.length - negativeMatches.length) / 2, -1, 1);
    const eventSentiment = suppliedSentiment === null ? lexicalSentiment : clamp(suppliedSentiment, -1, 1);
    const sourceQuality = clamp(Number(existingValues.sourceQuality ?? item.sourceQuality ?? options.sourceQuality ?? 0.8), 0, 1);
    const relevance = clamp(Number(existingValues.eventRelevance ?? item.eventRelevance ?? item.relevance ?? (item.priceSensitive ? 1 : 0.72)), 0, 1);
    const explicitEvent = earningsEvent || positiveCapital || dilution || regulatory || operationalPositive || operationalNegative;
    const values = {
      ...existingValues,
      eventSentiment,
      eventRelevance: relevance,
      eventNovelty: clamp(Number(existingValues.eventNovelty ?? item.eventNovelty ?? item.novelty ?? (item.priceSensitive ? 0.95 : explicitEvent ? 0.78 : 0.45)), 0, 1),
      announcementScore: clamp(Number(existingValues.announcementScore ?? item.announcementScore ?? (item.priceSensitive ? 1 : explicitEvent ? 0.72 : 0.35)), 0, 1),
      fundamentalQuality: clamp(Number(existingValues.fundamentalQuality ?? item.fundamentalQuality ?? (earningsEvent ? eventSentiment : 0)), -1, 1),
      sourceQuality,
      positiveCatalyst: clamp(Number(item.positiveCatalyst ?? (positiveMatches.length || positiveCapital || operationalPositive ? 0.8 : 0)), 0, 1),
      negativeCatalyst: clamp(Number(item.negativeCatalyst ?? (negativeMatches.length || regulatory || operationalNegative ? 0.8 : 0)), 0, 1),
      dilutionRisk: clamp(Number(item.dilutionRisk ?? (dilution ? 0.9 : 0)), 0, 1),
      regulatoryRisk: clamp(Number(item.regulatoryRisk ?? (regulatory ? 0.9 : 0)), 0, 1),
      earningsEvent: clamp(Number(item.earningsEvent ?? (earningsEvent ? 1 : 0)), 0, 1),
      capitalAllocation: clamp(Number(item.capitalAllocation ?? (positiveCapital ? 0.8 : dilution ? -0.8 : 0)), -1, 1),
      operationalMomentum: clamp(Number(item.operationalMomentum ?? (operationalPositive ? 0.8 : operationalNegative ? -0.8 : 0)), -1, 1),
      eventIntensity: clamp(Number(item.eventIntensity ?? (item.priceSensitive ? 1 : explicitEvent ? 0.75 : 0.35)), 0, 1),
    };
    return [{
      ...item,
      id: item.id || item.link || `${options.symbol || "MARKET"}:${availableAt}:${index}`,
      event_time: availableAt,
      available_at: availableAt,
      revision: "initial",
      sourceQuality,
      values,
      historicalAvailabilityVerified: recordVerified,
      historicalAvailabilityUnverified: !recordVerified,
      historicalAvailabilityVerificationMethod: recordVerified
        ? "source-published-timestamp"
        : futurePublishedAt
          ? "future-source-published-timestamp-quarantined"
          : "source-published-timestamp-without-revision-vintage",
      warning: futurePublishedAt
        ? "Source publication timestamp is in the future relative to local observation time; Shadow-only until revalidated."
        : item.warning || null,
    }];
  });
}

function normalizeCorporateActionRecords(symbol, payload = [], options = {}) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.results)
        ? payload.results
        : [];
  const provider = String(options.provider || "corporate-action-provider");
  const defaultType = String(options.eventType || "corporate-action");
  return rows.flatMap((row, index) => {
    const eventDate = row.exDate || row.ex_date || row.date || row.effectiveDate || row.paymentDate || row.recordDate;
    const eventTime = isoDay(eventDate, false) || safeIsoTimestamp(eventDate);
    if (!eventTime) return [];
    const announced = row.declarationDate || row.declaration_date || row.announcementDate || row.ann_date;
    const availableAt = isoDay(announced, true) || safeIsoTimestamp(announced) || eventTime;
    const eventType = String(row.eventType || row.type || row.actionType || defaultType).toLowerCase();
    const ratio = row.ratio || row.split || row.splitRatio || row.split_factor || null;
    const amount = finite(row.amount ?? row.value ?? row.dividend ?? row.cash_div_tax ?? row.cash_div);
    return [{
      id: `${symbol}:${eventType}:${eventTime.slice(0, 10)}:${row.id || index}`,
      symbol,
      eventType,
      event_time: eventTime,
      available_at: availableAt,
      revision: String(row.updatedAt || row.lastUpdated || row.paymentDate || row.recordDate || eventDate).slice(0, 40),
      historicalAvailabilityVerified: true,
      sourceProvider: provider,
      values: {
        amount,
        ratio,
        currency: row.currency || row.currencyCode || null,
        recordDate: row.recordDate || row.record_date || null,
        paymentDate: row.paymentDate || row.payment_date || row.pay_date || null,
        declarationDate: announced || null,
        sourceQuality: Number(options.sourceQuality ?? 0.92),
      },
    }];
  });
}

function normalizeEodhdCompanyUniverseRecords(symbol, payload = {}, options = {}) {
  const general = payload?.General || payload?.general || payload || {};
  const listedAt = isoDay(general.IPODate || general.ipoDate || general.ListingDate, false);
  const delistedAt = isoDay(general.DelistedDate || general.delistedDate, false);
  const exchange = general.Exchange || general.ExchangeCode || options.exchange || options.market || "";
  const name = general.Name || general.name || symbol;
  const records = [];
  if (listedAt) records.push({
    id: `${symbol}:listed:${listedAt.slice(0, 10)}`,
    symbol,
    exchange,
    name,
    listed: true,
    status: "active",
    event_time: listedAt,
    available_at: listedAt,
    revision: "listing-event",
    historicalAvailabilityVerified: true,
    sourceProvider: "eodhd-company-general-pit",
  });
  if (delistedAt) records.push({
    id: `${symbol}:delisted:${delistedAt.slice(0, 10)}`,
    symbol,
    exchange,
    name,
    listed: false,
    status: "delisted",
    event_time: delistedAt,
    available_at: delistedAt,
    revision: "delisting-event",
    historicalAvailabilityVerified: true,
    sourceProvider: "eodhd-company-general-pit",
  });
  return records;
}

function normalizeEodhdFinancialPitRecords(symbol, payload = {}, options = {}) {
  const financials = payload?.Financials || payload?.financials || {};
  const provider = String(options.provider || "eodhd-financial-statements-pit");
  const records = [];
  for (const [statementName, statement] of Object.entries(financials)) {
    if (!statement || typeof statement !== "object") continue;
    for (const frequency of ["quarterly", "yearly", "annual"]) {
      const rows = statement[frequency];
      if (!rows || typeof rows !== "object") continue;
      for (const [periodKey, raw] of Object.entries(rows)) {
        const row = raw && typeof raw === "object" ? raw : {};
        const eventTime = isoDay(row.date || row.period || periodKey, true);
        const filed = row.filing_date || row.filingDate || row.filedDate || row.reportedDate || row.reportDate;
        const availableAt = isoDay(filed, true) || safeIsoTimestamp(filed);
        if (!eventTime || !availableAt || availableAt < eventTime) continue;
        records.push({
          id: `${symbol}:${statementName}:${frequency}:${eventTime.slice(0, 10)}:${availableAt.slice(0, 10)}`,
          symbol,
          statement: statementName,
          frequency,
          event_time: eventTime,
          available_at: availableAt,
          revision: String(row.updatedAt || row.filing_date || row.filingDate || filed).slice(0, 40),
          historicalAvailabilityVerified: true,
          sourceProvider: provider,
          values: {
            ...row,
            sourceQuality: Number(options.sourceQuality ?? 0.9),
          },
        });
      }
    }
  }
  return records.sort((left, right) => left.available_at.localeCompare(right.available_at));
}

export {
  safeIsoTimestamp,
  normalizeCorporateActionRecords,
  normalizeAlphaVantageListingStatusRecords,
  normalizeEodhdFinancialPitRecords,
  normalizeFmpStatementPitRecords,
  normalizeGrowthWithValuePitRecords,
  normalizeStockMarketApiPitRecords,
  normalizeFmpHistoricalUniverseRecords,
  normalizeFmpSymbolChangeRecords,
  normalizeOpenFigiMappings,
  normalizeEastmoneyPitRecords,
  normalizeEodhdCompanyUniverseRecords,
  normalizeFredVintageRecords,
  normalizePublishedPitRecords,
  secRecentRows,
  normalizeSecDisclosureRecords,
  normalizeSecPitRecords,
  normalizeSimfinPitRecords,
  normalizeTusharePitRecords,
  normalizeTushareUniverseRecords,
  tableRows,
};
