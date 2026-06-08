import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run import:postman-env -- /path/to/postman-environment.json");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(resolve(input), "utf8"));
const values = Array.isArray(payload.values) ? payload.values : [];
const postmanVars = new Map();
for (const row of values) {
  if (row && row.enabled !== false && row.key) {
    postmanVars.set(String(row.key).trim().toUpperCase(), String(row.value || "").trim());
  }
}

const aliases = {
  ALPACA_API_KEY: ["ALPACA_API_KEY", "APCA_API_KEY_ID", "ALPACA_KEY_ID"],
  ALPACA_API_SECRET: ["ALPACA_API_SECRET", "APCA_API_SECRET_KEY", "ALPACA_SECRET_KEY"],
  ALPACA_DATA_FEED: ["ALPACA_DATA_FEED", "APCA_DATA_FEED"],
};

function firstValue(keys) {
  for (const key of keys) {
    const value = postmanVars.get(key);
    if (value) return value;
  }
  return "";
}

const updates = Object.fromEntries(
  Object.entries(aliases)
    .map(([target, keys]) => [target, firstValue(keys)])
    .filter(([, value]) => value)
);

if (!updates.ALPACA_API_KEY || !updates.ALPACA_API_SECRET) {
  console.error("No Alpaca API key/secret pair found in the exported Postman environment.");
  process.exit(1);
}

if (!updates.ALPACA_DATA_FEED) updates.ALPACA_DATA_FEED = "iex";

const envPath = resolve(".env.local");
const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
const seen = new Set();
const next = current.map((line) => {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!match) return line;
  const key = match[1];
  if (!(key in updates)) return line;
  seen.add(key);
  return `${key}=${updates[key]}`;
});

for (const [key, value] of Object.entries(updates)) {
  if (!seen.has(key)) next.push(`${key}=${value}`);
}

writeFileSync(envPath, `${next.filter((line, index, rows) => line || index < rows.length - 1).join("\n")}\n`);
console.log(`Imported ${Object.keys(updates).length} Alpaca setting(s) into .env.local. Values were not printed.`);
