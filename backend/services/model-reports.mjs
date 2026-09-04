import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
  let indexCache = null;

  async function list(filters = {}) {
    let payload = null;
    try {
      // This is a small local index (not an OOF artifact). A synchronous read
      // avoids an intermittent macOS async-file stall that used to leave the
      // strategy page waiting forever for the report list.
      payload = { ...(JSON.parse(readFileSync(join(basePath, "index.json"), "utf8")) || {}), indexReadTimedOut: false };
      indexCache = payload;
    } catch {
      payload = { reports: [], indexReadTimedOut: false };
    }
    if (!payload.reports?.length && indexCache?.reports?.length) payload = { ...indexCache, indexReadTimedOut: false };
    const market = filters.market ? String(filters.market).toUpperCase() : null;
    const limit = Math.max(1, Math.min(100, Number(filters.limit || 30)));
    const reports = (payload.reports || [])
      .filter((row) => !market || (row.scope || []).includes(market))
      .slice(0, limit)
      .map((row) => {
        return {
          reportId: row.reportId,
          generatedAt: row.generatedAt,
          scope: row.scope,
          productionReady: row.productionReady === true,
          reportVersions: row.reportVersions || {},
          evidenceMetadataAvailable: row.evidenceMetadataAvailable === true,
          links: {
            json: `/api/model-reports/${encodeURIComponent(row.reportId)}?format=json`,
            html: `/api/model-reports/${encodeURIComponent(row.reportId)}?format=html`,
            docx: `/api/model-reports/${encodeURIComponent(row.reportId)}?format=docx`,
          },
        };
      });
    return { available: true, market, count: reports.length, reports, indexReadTimedOut: payload.indexReadTimedOut === true };
  }

  async function generate(payload = {}) {
    const markets = Array.isArray(payload.markets)
      ? payload.markets
      : payload.market
        ? [payload.market]
        : ["ASX", "US", "CN"];
    return runPython("model-report-generate", { root, markets }, Number(process.env.MODEL_REPORT_TIMEOUT_MS || 600_000));
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
