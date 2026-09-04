/* Public identity adapters.  These records improve entity resolution and
 * asset classification; they are deliberately Shadow-only unless a source
 * supplies a historical publication timestamp. */

function finiteText(value, limit = 240) {
  return String(value ?? "").trim().slice(0, limit);
}

function safeIso(value, fallback) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function normalizeGleifIdentityRecords(payload = {}, { symbol = "", market = "US", retrievedAt = new Date().toISOString() } = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.flatMap((row, index) => {
    const attributes = row?.attributes || {};
    const entity = attributes.entity || {};
    const registration = attributes.registration || {};
    const lei = finiteText(row?.id || attributes.lei, 32).toUpperCase();
    if (!lei) return [];
    const eventTime = safeIso(registration.initialRegistrationDate || registration.registrationStatusDate, retrievedAt);
    return [{
      id: `gleif:${market}:${symbol}:${lei}:${index}`,
      symbol,
      market,
      identityType: "LEI",
      lei,
      legalName: finiteText(entity.legalName?.name || entity.legalName),
      legalAddress: finiteText(entity.legalAddress?.addressLines?.join(", ") || entity.legalAddress?.city),
      jurisdiction: finiteText(entity.jurisdiction),
      entityStatus: finiteText(entity.status),
      event_time: eventTime,
      available_at: retrievedAt,
      first_seen_at: retrievedAt,
      revision: finiteText(attributes.registration?.lastUpdateDate || "gleif-current-record", 80),
      historicalAvailabilityVerified: false,
      historicalAvailabilityUnverified: true,
      historicalAvailabilityVerificationMethod: "gleif-current-entity-record",
      sourceProvider: "gleif-public-api",
      values: { identityMatch: 1, sourceQuality: 0.7 },
    }];
  });
}

function normalizeAbnLookupRecords(xml = "", { symbol = "", market = "ASX", retrievedAt = new Date().toISOString() } = {}) {
  const text = String(xml || "");
  const abn = text.match(/<Abn>([^<]+)<\/Abn>/i)?.[1] || text.match(/<ABN>([^<]+)<\/ABN>/i)?.[1];
  const entityName = text.match(/<(?:OrganisationName|EntityName|MainName)[^>]*>([^<]+)<\//i)?.[1];
  if (!abn && !entityName) return [];
  return [{
    id: `abn-lookup:${market}:${symbol}:${finiteText(abn || entityName, 32)}`,
    symbol,
    market,
    identityType: "ABN",
    abn: finiteText(abn, 32),
    legalName: finiteText(entityName),
    event_time: retrievedAt,
    available_at: retrievedAt,
    first_seen_at: retrievedAt,
    revision: "abn-lookup-current-record",
    historicalAvailabilityVerified: false,
    historicalAvailabilityUnverified: true,
    historicalAvailabilityVerificationMethod: "abr-current-entity-record",
    sourceProvider: "abn-lookup-public-api",
    values: { identityMatch: 1, sourceQuality: 0.65 },
  }];
}

async function fetchGleifIdentityRecords(name, options = {}) {
  const legalName = finiteText(name, 200);
  if (!legalName) return { records: [], source: "gleif-public-api", warning: "missing-legal-name" };
  const endpoint = new URL("https://api.gleif.org/api/v1/lei-records");
  endpoint.searchParams.set("filter[entity.legalName]", legalName);
  endpoint.searchParams.set("page[size]", "5");
  const payload = await options.fetchJson(endpoint, options.timeoutMs || 8_000);
  return {
    records: normalizeGleifIdentityRecords(payload, options),
    source: "gleif-public-api",
  };
}

async function fetchAbnLookupRecords(name, options = {}) {
  const guid = finiteText(options.guid, 80);
  const legalName = finiteText(name, 200);
  if (!guid) return { records: [], source: "abn-lookup-public-api", warning: "ABN_LOOKUP_GUID is not configured" };
  if (!legalName) return { records: [], source: "abn-lookup-public-api", warning: "missing-legal-name" };
  const endpoint = new URL("https://abr.business.gov.au/abrxmlsearch/ABRXMLSearch.asmx/ABRSearchByNameSimpleProtocol");
  endpoint.searchParams.set("name", legalName);
  endpoint.searchParams.set("guid", guid);
  endpoint.searchParams.set("postcode", "");
  endpoint.searchParams.set("legalName", "Y");
  const xml = await options.fetchText(endpoint, options.timeoutMs || 8_000);
  return {
    records: normalizeAbnLookupRecords(xml, options),
    source: "abn-lookup-public-api",
  };
}

function publicIdentitySourceStatus(env = process.env) {
  return [
    {
      name: "nasdaq-trader-symbol-directory",
      market: "US",
      dataset: "universe/asset-identity",
      access: "free-no-key",
      configured: true,
      status: "ready",
      pit: "current-directory-plus-dated-listing-when-available",
      officialUrl: "https://www.nasdaqtrader.com/Trader.aspx?id=symboldirdefs",
      registration: "none",
    },
    {
      name: "asx-company-directory",
      market: "ASX",
      dataset: "universe/asset-identity",
      access: "free-no-key",
      configured: true,
      status: "ready",
      pit: "current-directory-plus-official-announcement-history",
      officialUrl: "https://www.asx.com.au/asx/research/ASXListedCompanies.csv",
      registration: "none",
    },
    {
      name: "asx-codes-and-descriptors",
      market: "ASX",
      dataset: "universe/asset-classification",
      access: "free-no-key",
      configured: true,
      status: "ready-shadow",
      pit: "current-rules-plus-dated-archive-when-available",
      officialUrl: "https://www.asx.com.au/markets/market-resources/asx-codes-and-descriptors",
      registration: "none",
    },
    {
      name: "abn-bulk-extract",
      market: "ASX",
      dataset: "entity-identity",
      access: "free-no-key",
      configured: true,
      status: "ready-shadow",
      pit: "current-snapshot-only",
      officialUrl: "https://data.gov.au/data/dataset/abn-bulk-extract",
      registration: "none",
    },
    {
      name: "gleif-public-api",
      market: "US/ASX/CN",
      dataset: "entity-identity",
      access: "free-no-key",
      configured: true,
      status: "ready-shadow",
      pit: "current-identity-only",
      officialUrl: "https://www.gleif.org/en/lei-data/gleif-api",
      registration: "none",
    },
    {
      name: "abn-lookup-public-api",
      market: "ASX",
      dataset: "entity-identity",
      access: "free-guid",
      configured: Boolean(String(env.ABN_LOOKUP_GUID || "").trim()),
      status: String(env.ABN_LOOKUP_GUID || "").trim() ? "ready-shadow" : "requires_guid",
      pit: "current-identity-only",
      officialUrl: "https://abr.business.gov.au/Tools/WebServices",
      registration: "free-guid-request",
    },
  ];
}

export {
  fetchAbnLookupRecords,
  fetchGleifIdentityRecords,
  normalizeAbnLookupRecords,
  normalizeGleifIdentityRecords,
  publicIdentitySourceStatus,
};
