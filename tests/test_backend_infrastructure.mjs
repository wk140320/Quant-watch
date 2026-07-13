import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPythonQuantClient } from "../backend/services/python-quant.mjs";
import { createRuntimeEventHub } from "../backend/services/runtime-events.mjs";
import { createJobManager } from "../backend/services/job-manager.mjs";
import { createAlpacaAdapter } from "../backend/providers/us/alpaca.mjs";
import {
  cleanCode,
  isValidMarketCode,
  normalizeMarketSymbol,
  safeMarket,
} from "../backend/domain/markets.mjs";
import { readJsonBody, sendJson } from "../backend/http/json.mjs";

function requestFrom(chunks, headers = {}) {
  const request = Readable.from(chunks);
  request.headers = headers;
  return request;
}

test("JSON transport parses chunked request bodies", async () => {
  const request = requestFrom([Buffer.from('{"market":'), Buffer.from('"US","limit":10}')]);
  assert.deepEqual(await readJsonBody(request), { market: "US", limit: 10 });
});

test("JSON transport rejects malformed and oversized request bodies", async () => {
  await assert.rejects(
    readJsonBody(requestFrom(["{broken"])),
    (error) => error.statusCode === 400 && /valid JSON/.test(error.message),
  );
  await assert.rejects(
    readJsonBody(requestFrom(["123456789"]), { maxBytes: 8 }),
    (error) => error.statusCode === 413 && /exceeds/.test(error.message),
  );
  await assert.rejects(
    readJsonBody(requestFrom([], { "content-length": "20" }), { maxBytes: 8 }),
    (error) => error.statusCode === 413,
  );
});

test("JSON responses are non-cacheable and protected from MIME sniffing", () => {
  const response = {
    headers: null,
    status: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  sendJson(response, 200, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test("Python quant client requires an explicit application root", () => {
  assert.throws(() => createPythonQuantClient(), /application root/);
});

test("Backend market contract isolates exchange symbols", () => {
  assert.equal(safeMarket("US"), "US");
  assert.equal(safeMarket("UNKNOWN"), "ASX");
  assert.equal(cleanCode("BHP.AX", "ASX"), "BHP");
  assert.equal(normalizeMarketSymbol("BHP", "ASX"), "BHP.AX");
  assert.equal(normalizeMarketSymbol("AAPL", "ASX"), "");
  assert.equal(normalizeMarketSymbol("CBA", "US"), "");
  assert.equal(isValidMarketCode("600519", "CN"), true);
  assert.equal(normalizeMarketSymbol("000001.SS", "CN"), "SH000001");
});

test("Alpaca adapter preserves the normalized candle contract", () => {
  let receivedOptions = null;
  const adapter = createAlpacaAdapter({
    isIntradayInterval: (interval) => interval === "5m",
    sanitizeCandleRows: (rows, options) => {
      receivedOptions = options;
      return rows;
    },
  });
  const rows = adapter.alpacaRows({ bars: [{ t: "2026-01-01T10:00:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 100, n: 8, vw: 10.4 }] }, "5m");
  assert.equal(rows[0].tradeCount, 8);
  assert.equal(rows[0].providerVwap, 10.4);
  assert.deepEqual(receivedOptions, { preserveTimestamp: true });
});

test("Runtime event hub retains bounded local event history", () => {
  const hub = createRuntimeEventHub({ historyLimit: 20 });
  hub.publish("paper-agent.trade", { symbol: "AAPL", order_execution_enabled: false });
  const summary = hub.summary();
  assert.equal(summary.clients, 0);
  assert.equal(summary.lastEventId, 1);
  assert.equal(summary.recent[0].payload.order_execution_enabled, false);
});

test("Background jobs persist completion without blocking the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quant-jobs-"));
  try {
    const manager = createJobManager({ basePath: directory });
    manager.register("unit", async (payload, update) => {
      await update(0.5, { phase: "half" });
      return { value: payload.value * 2 };
    });
    const queued = await manager.create("unit", { value: 21 });
    assert.equal(queued.status, "queued");
    let completed = null;
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await manager.get(queued.id);
      if (completed?.status === "complete") break;
    }
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.result?.value, 42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
