import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { extname, normalize, relative, resolve } from "node:path";

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const compressedStaticCache = new Map();
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);

function resolvedStaticPath(root, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const decodedPath = decodeURIComponent(requested);
  if (decodedPath.split(/[\\/]/).includes("..")) {
    const error = new Error("Static path is outside the application root.");
    error.code = "EACCES";
    throw error;
  }
  const normalizedPath = normalize(decodedPath).replace(/^[/\\]+/, "");
  const filePath = resolve(root, normalizedPath);
  const relativePath = relative(root, filePath);
  if (relativePath.split(/[\\/]/).includes("..") || relativePath.startsWith("..")) {
    const error = new Error("Static path is outside the application root.");
    error.code = "EACCES";
    throw error;
  }
  return filePath;
}

function cacheControlFor(url, filePath) {
  if (extname(filePath) === ".html") return "no-store";
  if (url.searchParams.has("v")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

export async function serveStaticRequest(req, res, url, options = {}) {
  if (url.pathname === "/app.js" && req.headers["sec-fetch-dest"] === "document") {
    res.writeHead(302, { location: "/", "cache-control": "no-store" });
    res.end();
    return true;
  }

  const filePath = resolvedStaticPath(options.root, url.pathname);
  // The UI shell is local and small. A synchronous read avoids an intermittent
  // macOS async-file stall that otherwise leaves `/` open with no response;
  // compression remains asynchronous for clients that explicitly request it.
  const body = readFileSync(filePath);
  const metadata = statSync(filePath);
  const extension = extname(filePath);
  const accepted = String(req.headers["accept-encoding"] || "");
  const encoding = body.length >= 1_024 && COMPRESSIBLE.has(extension)
    ? accepted.includes("br") ? "br" : accepted.includes("gzip") ? "gzip" : null
    : null;
  let responseBody = body;
  if (encoding) {
    const cacheKey = `${filePath}:${metadata.mtimeMs}:${encoding}`;
    responseBody = compressedStaticCache.get(cacheKey);
    if (!responseBody) {
      responseBody = encoding === "br"
        ? await brotliCompressAsync(body, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        })
        : await gzipAsync(body, { level: 6 });
      compressedStaticCache.set(cacheKey, responseBody);
      if (compressedStaticCache.size > 32) compressedStaticCache.delete(compressedStaticCache.keys().next().value);
    }
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extension] || "application/octet-stream",
    "cache-control": cacheControlFor(url, filePath),
    "x-content-type-options": "nosniff",
    ...(encoding ? { "content-encoding": encoding, vary: "accept-encoding" } : {}),
  });
  res.end(responseBody);
  return true;
}

export { cacheControlFor, resolvedStaticPath };
