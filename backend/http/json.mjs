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
    // Some local desktop HTTP clients keep the socket reusable after sending
    // the complete fixed-length body. Once every declared byte is present we
    // can parse immediately instead of waiting for a later connection-level
    // end signal that may never arrive.
    if (declaredLength > 0 && size >= declaredLength) break;
  }

  if (!size) return {};
  if (declaredLength > 0 && size < declaredLength) {
    throw httpError(400, "JSON request body ended before the declared content length was received.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw httpError(400, "Request body is not valid JSON.");
  }
}

export { DEFAULT_JSON_BODY_LIMIT, httpError, readJsonBody, sendJson };
