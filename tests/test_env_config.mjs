import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvText } from "../backend/config/env.mjs";

test("Environment parser preserves explicit process values and tracks sources", () => {
  const target = { EXISTING: "keep" };
  const sources = new Map();
  parseEnvText("EXISTING=replace\nNEW_KEY='value'\n# ignored", {
    target,
    sources,
    sourcePath: "/tmp/local.env",
  });
  assert.equal(target.EXISTING, "keep");
  assert.equal(target.NEW_KEY, "value");
  assert.equal(sources.get("NEW_KEY"), "/tmp/local.env");
  assert.equal(sources.has("EXISTING"), false);
});

test("External Reddit env loading accepts only Reddit-prefixed keys", () => {
  const target = {};
  parseEnvText("REDDIT_CLIENT_ID=client\nOPENAI_API_KEY=blocked", {
    target,
    onlyPrefix: "REDDIT_",
  });
  assert.equal(target.REDDIT_CLIENT_ID, "client");
  assert.equal(target.OPENAI_API_KEY, undefined);
});
