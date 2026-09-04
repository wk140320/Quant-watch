import { spawn } from "node:child_process";

const DEFAULT_USER_AGENT = "Mozilla/5.0 Global Quant Watch";

function redactProviderText(value, limit = 180) {
  return String(value || "")
    .slice(0, limit)
    .replace(/[A-Za-z0-9_-]{16,}/g, "[redacted]");
}

function requestHeaders(accept, extraHeaders = {}) {
  return {
    "user-agent": DEFAULT_USER_AGENT,
    accept,
    ...extraHeaders,
  };
}

async function fetchJson(url, timeoutMs = 10000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: requestHeaders("application/json,text/plain,*/*", extraHeaders),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${redactProviderText(await response.text())}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonPost(url, payload, timeoutMs = 10000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...requestHeaders("application/json,text/plain,*/*"),
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${redactProviderText(await response.text())}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFormJsonPost(url, payload, timeoutMs = 10000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...requestHeaders("application/json,text/plain,*/*"),
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...extraHeaders,
      },
      body: new URLSearchParams(Object.entries(payload || {}).map(([key, value]) => [key, String(value ?? "")])).toString(),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${redactProviderText(await response.text())}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 10000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: requestHeaders("application/rss+xml,text/xml,text/plain,*/*", extraHeaders),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${redactProviderText(await response.text(), 160)}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithCurl(url, timeoutMs = 10000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-sL", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
    Object.entries(requestHeaders("application/json,text/plain,*/*", extraHeaders)).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") args.push("-H", `${key}: ${value}`);
    });
    args.push(String(url));
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("error", (error) => {
      if (error?.code !== "EPIPE") reject(error);
    });
    child.stderr.on("error", (error) => {
      if (error?.code !== "EPIPE") reject(error);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(redactProviderText(stderr.slice(-400), 400) || `curl exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch {
        reject(new Error(`curl returned invalid JSON: ${redactProviderText(stdout)}`));
      }
    });
  });
}

export {
  fetchJson,
  fetchFormJsonPost,
  fetchJsonPost,
  fetchJsonWithCurl,
  fetchText,
  redactProviderText,
  requestHeaders,
};
