import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const FORMATS = Object.freeze({
  json: { filename: "evidence.json", contentType: "application/json; charset=utf-8" },
  html: { filename: "report.html", contentType: "text/html; charset=utf-8" },
  docx: { filename: null, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
});

function safeReportId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(id)) {
    throw Object.assign(new Error("Invalid model report id."), { statusCode: 400 });
  }
  return id;
}

function createModelReportService(options = {}) {
  const root = options.root;
  const basePath = options.basePath || join(root, ".cache", "model-reports");
  const runPython = options.runPython;
  if (!root || typeof runPython !== "function") throw new Error("Model report service requires root and Python client.");

  async function list(filters = {}) {
    const payload = await readFile(join(basePath, "index.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => ({ reports: [] }));
    const market = filters.market ? String(filters.market).toUpperCase() : null;
    const limit = Math.max(1, Math.min(100, Number(filters.limit || 30)));
    const reports = (payload.reports || [])
      .filter((row) => !market || (row.scope || []).includes(market))
      .slice(0, limit)
      .map((row) => ({
        reportId: row.reportId,
        generatedAt: row.generatedAt,
        scope: row.scope,
        productionReady: row.productionReady === true,
        links: {
          json: `/api/model-reports/${encodeURIComponent(row.reportId)}?format=json`,
          html: `/api/model-reports/${encodeURIComponent(row.reportId)}?format=html`,
          docx: `/api/model-reports/${encodeURIComponent(row.reportId)}?format=docx`,
        },
      }));
    return { available: true, market, count: reports.length, reports };
  }

  async function generate(payload = {}) {
    const markets = Array.isArray(payload.markets)
      ? payload.markets
      : payload.market
        ? [payload.market]
        : ["ASX", "US", "CN"];
    return runPython("model-report-generate", { root, markets }, Number(process.env.MODEL_REPORT_TIMEOUT_MS || 180_000));
  }

  async function artifact(reportId, format = "json") {
    const id = safeReportId(reportId);
    const selected = FORMATS[String(format).toLowerCase()] || FORMATS.json;
    const filename = selected.filename || `${id}.docx`;
    const reportDirectory = resolve(basePath, id);
    const filePath = resolve(reportDirectory, filename);
    if (!filePath.startsWith(`${reportDirectory}/`)) {
      throw Object.assign(new Error("Model report path is outside its report directory."), { statusCode: 403 });
    }
    const body = await readFile(filePath).catch(() => null);
    if (!body) throw Object.assign(new Error("Model report artifact not found."), { statusCode: 404 });
    return {
      body,
      contentType: selected.contentType,
      filename: basename(filePath),
      disposition: selected === FORMATS.html || selected === FORMATS.json ? "inline" : "attachment",
    };
  }

  return { artifact, generate, list };
}

export { createModelReportService, safeReportId };
