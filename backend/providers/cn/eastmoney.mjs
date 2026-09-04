const EASTMONEY_DIVIDEND_ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";

function exchangeForCode(code = "") {
  return /^(5|6|9)/.test(String(code).trim()) ? "SH" : "SZ";
}

function rowsFromPayload(payload = {}) {
  const rows = payload?.result?.data;
  return Array.isArray(rows) ? rows : [];
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (!match) return null;
  return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRows(symbol, rows, normalizeCorporateActionRecords) {
  const code = String(symbol || "").trim();
  const prepared = rows.flatMap((row) => {
    const exDate = normalizeDate(row.EX_DIVIDEND_DATE);
    const recordDate = normalizeDate(row.EQUITY_RECORD_DATE);
    const paymentDate = normalizeDate(row.PAY_DATE || row.PAYABLE_DATE);
    const announcementDate = normalizeDate(row.PUBLISH_DATE || row.NOTICE_DATE || row.PLAN_NOTICE_DATE);
    const eventDate = exDate || recordDate;
    if (!eventDate || !announcementDate) return [];
    const cashAmount = row.PRETAX_BONUS_RMB ?? row.CASH_DIV ?? row.CASH_DIV_TAX;
    const stockRatio = row.BONUS_RATIO ?? row.STK_DIV ?? row.IT_RATIO;
    const eventType = finite(stockRatio) !== null && finite(stockRatio) > 0
      ? "stock-dividend"
      : "cash-dividend";
    return [{
      id: row.SECURITY_CODE && row.REPORT_DATE
        ? `${row.SECURITY_CODE}:${row.REPORT_DATE}:${announcementDate}`
        : undefined,
      eventType,
      exDate: eventDate,
      declarationDate: announcementDate,
      recordDate,
      paymentDate,
      amount: finite(cashAmount),
      ratio: finite(stockRatio),
      currency: "CNY",
      sourceAnnouncementDate: announcementDate,
    }];
  });
  return normalizeCorporateActionRecords(code, prepared, {
    provider: "eastmoney-cn-corporate-actions",
    eventType: "dividend",
    sourceQuality: 0.84,
  }).map((record) => ({
    ...record,
    historicalAvailabilityVerificationMethod: "eastmoney-public-ex-date-and-publication-date",
  }));
}

function createEastmoneyCorporateActionAdapter({ fetchJson, normalizeCorporateActionRecords } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("Eastmoney adapter requires fetchJson.");
  if (typeof normalizeCorporateActionRecords !== "function") {
    throw new TypeError("Eastmoney adapter requires normalizeCorporateActionRecords.");
  }

  async function fetchCorporateActions(symbol, { pageSize = 200, timeoutMs = 20_000 } = {}) {
    const code = String(symbol || "").trim();
    if (!/^\d{6}$/.test(code)) throw new Error(`Eastmoney corporate actions require a six-digit A-share code: ${code}`);
    const endpoint = new URL(EASTMONEY_DIVIDEND_ENDPOINT);
    endpoint.searchParams.set("reportName", "RPT_SHAREBONUS_DET");
    endpoint.searchParams.set("columns", "ALL");
    endpoint.searchParams.set("filter", `(SECURITY_CODE=\"${code}\")`);
    endpoint.searchParams.set("sortColumns", "REPORT_DATE");
    endpoint.searchParams.set("sortTypes", "-1");
    endpoint.searchParams.set("pageNumber", "1");
    endpoint.searchParams.set("pageSize", String(Math.max(1, Math.min(500, Number(pageSize) || 200))));
    endpoint.searchParams.set("source", "WEB");
    endpoint.searchParams.set("client", "WEB");
    const payload = await fetchJson(endpoint, timeoutMs, { referer: "https://data.eastmoney.com/" });
    if (payload?.success === false || Number(payload?.code || 0) !== 0) {
      throw new Error(payload?.message || `Eastmoney corporate-action error ${payload?.code || "unknown"}`);
    }
    const records = normalizeRows(code, rowsFromPayload(payload), normalizeCorporateActionRecords);
    if (!records.length) throw new Error(`Eastmoney returned no dated corporate actions for ${code}.`);
    return records;
  }

  return { fetchCorporateActions, exchangeForCode };
}

export {
  createEastmoneyCorporateActionAdapter,
  exchangeForCode,
  normalizeRows as normalizeEastmoneyCorporateActionRows,
};
