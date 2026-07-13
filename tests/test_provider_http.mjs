import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchJson,
  fetchText,
  redactProviderText,
  requestHeaders,
} from "../backend/providers/http.mjs";

test("Provider HTTP helpers read local data URLs without network dependencies", async () => {
  const json = await fetchJson("data:application/json,%7B%22ok%22%3Atrue%7D", 1000);
  const text = await fetchText("data:text/plain,market%20ready", 1000);
  assert.deepEqual(json, { ok: true });
  assert.equal(text, "market ready");
});

test("Provider HTTP helpers centralize headers and redact long tokens", () => {
  const headers = requestHeaders("application/json", { authorization: "Bearer local-test" });
  assert.match(headers["user-agent"], /Global Quant Watch/);
  assert.equal(headers.authorization, "Bearer local-test");
  assert.equal(redactProviderText("error token_abcdefghijklmnopqrstuvwxyz012345"), "error [redacted]");
});
