const DEFAULT_JSON_BODY_LIMIT = 2 * 1024 * 1024;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
    return true;
  } catch (error) {
    if (error?.code !== "EPIPE" && error?.code !== "ECONNRESET") throw error;
    return false;
  }
}

async function readJsonBody(req, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes || process.env.JSON_BODY_LIMIT_BYTES || DEFAULT_JSON_BODY_LIMIT));
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw httpError(413, `JSON request body exceeds the ${maxBytes} byte limit.`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw httpError(413, `JSON request body exceeds the ${maxBytes} byte limit.`);
    chunks.push(buffer);
  }

  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw httpError(400, "Request body is not valid JSON.");
  }
}

export { DEFAULT_JSON_BODY_LIMIT, httpError, readJsonBody, sendJson };
