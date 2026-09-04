const DEFAULT_DATASETS = Object.freeze([
  {
    dataflow: "ABS,CPI,2.0.0",
    dataKey: "1.10001.10.50.M",
    seriesId: "ABS-CPI-MONTHLY",
    label: "Australian CPI monthly",
  },
  {
    dataflow: "ABS,ANA_AGG,1.1.0",
    dataKey: "M1.GPM.20.AUS.Q",
    seriesId: "ABS-GDP-QUARTERLY",
    label: "Australian GDP quarterly",
  },
]);

function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && next === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function finite(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function periodStart(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  if (/^\d{4}-Q[1-4]$/i.test(text)) return `${text.slice(0, 4)}-${({ Q1: "01", Q2: "04", Q3: "07", Q4: "10" })[text.slice(5).toUpperCase()]}-01`;
  if (/^\d{4}$/.test(text)) return `${text}-01-01`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseDatasets(value) {
  if (!value) return DEFAULT_DATASETS;
  return String(value).split(";").map((item) => {
    const [dataflow, dataKey, seriesId, label] = item.split("|").map((part) => part.trim());
    return dataflow && dataKey ? { dataflow, dataKey, seriesId: seriesId || dataflow, label: label || dataflow } : null;
  }).filter(Boolean);
}

function normalizeRows(dataset, csv, retrievedAt) {
  return parseCsv(csv).flatMap((row, index) => {
    const observationDate = String(row.TIME_PERIOD || row["Time Period"] || "").trim();
    const date = periodStart(observationDate);
    const value = finite(row.OBS_VALUE || row["Observation Value"]);
    if (!date || value === null) return [];
    return [{
      id: `${dataset.seriesId}:${observationDate}:${value}:${index}`,
      seriesId: dataset.seriesId,
      observationDate,
      event_time: `${date}T00:00:00Z`,
      available_at: retrievedAt,
      first_seen_at: retrievedAt,
      revision: `abs-current-vintage-${retrievedAt.slice(0, 10)}`,
      rawValue: value,
      unit: row.UNIT_MEASURE || row["Unit of Measure"] || null,
      frequency: row.FREQ || row.FREQUENCY || null,
      historicalAvailabilityVerified: false,
      historicalAvailabilityUnverified: true,
      historicalAvailabilityVerificationMethod: "abs-sdmx-current-vintage-no-release-calendar",
      values: {
        eventSentiment: 0,
        eventRelevance: 0.7,
        eventNovelty: 0,
        macroDataCoverage: 1,
        sourceQuality: 0.72,
        absObservationValue: value,
      },
    }];
  });
}

function createAbsAdapter(options = {}) {
  const fetchText = options.fetchText || ((url) => fetch(url).then(async (response) => {
    if (!response.ok) throw new Error(`ABS HTTP ${response.status}`);
    return response.text();
  }));

  async function fetchMacro({ datasets = DEFAULT_DATASETS, startPeriod = "1990-01", endPeriod = "", timeoutMs = 30_000 } = {}) {
    const retrievedAt = new Date().toISOString();
    const selected = parseDatasets(datasets);
    const results = await Promise.allSettled(selected.map(async (dataset) => {
      const endpoint = new URL(`https://data.api.abs.gov.au/rest/data/${dataset.dataflow}/${dataset.dataKey}`);
      endpoint.searchParams.set("format", "csvfilewithlabels");
      endpoint.searchParams.set("startPeriod", startPeriod);
      if (endPeriod) endpoint.searchParams.set("endPeriod", endPeriod);
      const csv = await fetchText(endpoint, timeoutMs, { accept: "text/csv,text/plain,*/*" });
      return normalizeRows(dataset, csv, retrievedAt);
    }));
    return {
      records: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
      errors: results.filter((result) => result.status === "rejected").map((result) => String(result.reason?.message || result.reason)),
      retrievedAt,
      datasets: selected.map((dataset) => dataset.seriesId),
    };
  }

  return { fetchMacro, defaultDatasets: DEFAULT_DATASETS };
}

export { createAbsAdapter, DEFAULT_DATASETS as ABS_DEFAULT_DATASETS };
