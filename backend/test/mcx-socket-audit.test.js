import test from "node:test";
import assert from "node:assert/strict";
import { buildMcxSocketQuoteRows } from "../src/mcx-socket-audit.js";
import { buildVerifiedMcxAudit } from "../src/mcx-sureshot.js";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const universe = [
  { symbol: "MCX:CRUDEOIL26NOVFUT", underlying: "CRUDEOIL" },
  { symbol: "MCX:GOLD26DEC FUT", underlying: "GOLD" }
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
