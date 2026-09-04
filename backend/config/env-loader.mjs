import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseEnvText(text, options = {}) {
  const target = options.target || process.env;
  const sources = options.sources || new Map();
  const sourcePath = options.sourcePath || "inline";
  String(text || "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separator = trimmed.indexOf("=");
    if (separator === -1) return;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (options.onlyPrefix && !key.startsWith(options.onlyPrefix)) return;
    if (key && target[key] === undefined) {
      target[key] = value;
      sources.set(key, sourcePath);
    }
  });
  return sources;
}

function parseEnvFile(envPath, options = {}) {
  if (!envPath || !existsSync(envPath)) return options.sources || new Map();
  return parseEnvText(readFileSync(envPath, "utf8"), { ...options, sourcePath: envPath });
}

function loadEnvironment(options = {}) {
  const root = options.root;
  const target = options.target || process.env;
  const sources = new Map();
  parseEnvFile(join(root, ".env.local"), { target, sources });
  parseEnvFile(join(root, ".env"), { target, sources });
  const redditEnvPath = target.REDDIT_ENV_PATH || options.defaultRedditEnvPath || "";
  if (redditEnvPath) parseEnvFile(redditEnvPath, { target, sources, onlyPrefix: "REDDIT_" });
  return sources;
}

export { loadEnvironment, parseEnvFile, parseEnvText };
