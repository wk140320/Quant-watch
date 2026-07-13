import { readFile } from "node:fs/promises";
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
  const body = await readFile(filePath);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
    "cache-control": cacheControlFor(url, filePath),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

export { cacheControlFor, resolvedStaticPath };
