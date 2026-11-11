import test from "node:test";
import assert from "node:assert/strict";
import { buildMcxSocketQuoteRows } from "../src/mcx-socket-audit.js";
import { buildVerifiedMcxAudit } from "../src/mcx-sureshot.js";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const universe = [
  { symbol: "MCX:CRUDEOIL26NOVFUT", underlying: "CRUDEOIL" },
  { symbol: "MCX:GOLD26DECFUT", underlying: "GOLD" }
];

test("MCX socket audit uses exchange-stamped ticks for every requested future", () => {
  const ticks = new Map([
    [universe[0].symbol, { ltp: 6500, chp: 1.25, updatedAt: new Date(now).toISOString(), receivedAt: new Date(now + 5000).toISOString() }],
    [universe[1].symbol, { ltp: 7000, chp: -0.5, updatedAt: new Date(now - 5000).toISOString(), receivedAt: new Date(now).toISOString() }]
  ]);
  const rows = buildMcxSocketQuoteRows(universe, ticks);
  const audit = buildVerifiedMcxAudit({ universe, quoteRows: rows, now, maxAgeMs: 30_000 });
  assert.equal(rows.length, 2);
  assert.equal(audit.complete, true);
  assert.equal(audit.coverage.fresh, 2);
  assert.equal(audit.data[0].symbol, universe[0].symbol);
});

test("MCX socket audit keeps missing and stale contracts visible and blocks ranking", () => {
  const ticks = new Map([
    [universe[0].symbol, { ltp: 6500, chp: 1.25, updatedAt: new Date(now).toISOString() }],
    [universe[1].symbol, { ltp: 7000, chp: -0.5, updatedAt: new Date(now - 60_000).toISOString() }]
  ]);
  const audit = buildVerifiedMcxAudit({
    universe, quoteRows: buildMcxSocketQuoteRows(universe, ticks), now, maxAgeMs: 30_000
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.data.length, 0);
  assert.equal(audit.audit[0].status, "FRESH_QUOTE");
  assert.equal(audit.audit[1].status, "STALE_OR_INVALID_QUOTE");
});

test("local WebSocket receive time cannot replace a missing exchange timestamp", () => {
  const ticks = new Map([
    [universe[0].symbol, { ltp: 6500, chp: 1.25, receivedAt: new Date(now).toISOString() }]
  ]);
  const audit = buildVerifiedMcxAudit({
    universe: [universe[0]], quoteRows: buildMcxSocketQuoteRows([universe[0]], ticks), now
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.audit[0].status, "STALE_OR_INVALID_QUOTE");
  assert.equal(audit.audit[0].exchangeTime, null);
});

test("MCX socket audit rejects ticks without a verified percentage change", () => {
  const ticks = new Map([
    [universe[0].symbol, { ltp: 6500, chp: null, updatedAt: new Date(now).toISOString() }]
  ]);
  const audit = buildVerifiedMcxAudit({
    universe: [universe[0]], quoteRows: buildMcxSocketQuoteRows([universe[0]], ticks), now
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.audit[0].status, "STALE_OR_INVALID_QUOTE");
});


test("MCX scan waits for socket ticks to arrive after subscriptions", async () => {
  let clock = now;
  let reads = 0;
  const completeAudit = buildVerifiedMcxAudit({
    universe,
    quoteRows: buildMcxSocketQuoteRows(universe, new Map(universe.map((item) => [
      item.symbol, { ltp: 100, chp: 1, updatedAt: new Date(clock).toISOString() }
    ]))),
    now: clock,
    maxAgeMs: 30_000
  });
  const { waitForCompleteMcxSocketAudit } = await import("../src/mcx-socket-audit.js");
  const result = await waitForCompleteMcxSocketAudit({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timeoutMs: 5_000,
    pollIntervalMs: 1_000,
    getAudit: async () => (++reads < 3
      ? { complete: false, coverage: { fresh: 0 } }
      : completeAudit)
  });
  assert.equal(reads, 3);
  assert.equal(result.audit.complete, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.waitedMs, 2_000);
});

test("MCX socket settle window times out without relaxing freshness", async () => {
  let clock = now;
  const { waitForCompleteMcxSocketAudit } = await import("../src/mcx-socket-audit.js");
  const result = await waitForCompleteMcxSocketAudit({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timeoutMs: 2_000,
    pollIntervalMs: 1_000,
    getAudit: async () => ({ complete: false, coverage: { fresh: 1, missing: 1 } })
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.waitedMs, 2_000);
  assert.equal(result.audit.complete, false);
});
