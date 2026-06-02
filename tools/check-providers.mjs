import { existsSync, readFileSync } from "node:fs";

function loadEnv() {
  const env = {};
  const envPath = new URL("../.env.local", import.meta.url);
  if (!existsSync(envPath)) return env;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    env[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return env;
}

function redact(text) {
  return String(text).replace(/[A-Za-z0-9_-]{16,}/g, "[redacted]");
}

async function check(name, url) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    console.log(`${name} ${response.status} ${redact(text.slice(0, 220))}`);
  } catch (error) {
    console.log(`${name} ERR ${error.message}`);
  }
}

const env = loadEnv();
const from = new Date();
from.setMonth(from.getMonth() - 2);
const fromDate = from.toISOString().slice(0, 10);

await Promise.all([
  check("eodhd", `https://eodhd.com/api/eod/CBA.AU?from=${fromDate}&period=d&fmt=json&api_token=${env.EODHD_API_KEY}`),
  check("eodhistoricaldata", `https://eodhistoricaldata.com/api/eod/CBA.AU?from=${fromDate}&period=d&fmt=json&api_token=${env.EODHD_API_KEY}`),
  check("twelvedata", `https://api.twelvedata.com/time_series?symbol=CBA&exchange=ASX&interval=1day&outputsize=45&apikey=${env.TWELVEDATA_API_KEY}`),
]);
