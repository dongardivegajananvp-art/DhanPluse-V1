import test from "node:test";
import assert from "node:assert/strict";
import { buildVerifiedSureshotShortlist } from "../src/sureshot-shortlist.js";

const now = Date.parse("2026-11-02T07:00:00.000Z");
const universe = { data: Array.from({ length: 218 }, (_, i) => ({ symbol: `NSE:STOCK${i}-EQ` })) };
const quoteSnapshot = {
  ok: true, verified: true, universeCount: 218, quotedCount: 218,
  data: universe.data.map((row, i) => ({
    n: row.symbol,
    v: { lp: 100 + i, chp: i - 100, tt: Math.floor((now - 5000) / 1000) }
  }))
};
const indexTicks = new Map([
  ["NSE:NIFTY50-INDEX", { ltp: 24000, chp: 0.8, updatedAt: new Date(now - 1000).toISOString() }],
  ["NSE:NIFTYBANK-INDEX", { ltp: 52000, chp: -1.1, updatedAt: new Date(now - 1000).toISOString() }],
  ["BSE:SENSEX-INDEX", { ltp: 79000, chp: 0.4, updatedAt: new Date(now - 1000).toISOString() }]
]);

test("ranks top three only from complete fresh F&O quotes and all index ticks", () => {
  const result = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks, now });
  assert.equal(result.data.length, 3);
  assert.equal(result.data[0].symbol, "NSE:STOCK217-EQ");
  assert.equal(result.data[0].rank, 1);
  assert.equal(result.signalsAllowed, false);
  assert.equal(result.data.some(row => row.underlyingType === "INDEX"), false);
});

test("blocks incomplete F&O quote coverage", () => {
  const partial = { ...quoteSnapshot, data: quoteSnapshot.data.slice(0, 217), quotedCount: 217 };
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot: partial, universe, indexTicks, now }),
    /complete_verified_fno_quote_snapshot_required/);
});

test("blocks stale quotes and missing or stale index ticks", () => {
  const stale = structuredClone(quoteSnapshot);
  stale.data[0].v.tt = Math.floor((now - 31000) / 1000);
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot: stale, universe, indexTicks, now }),
    /stale_or_invalid_fno_quote_snapshot/);
  const missingIndex = new Map(indexTicks);
  missingIndex.delete("BSE:SENSEX-INDEX");
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks: missingIndex, now }),
    /all_three_fresh_exchange_stamped_index_ticks_required/);
});

test("rejects duplicate F&O symbols", () => {
  const duplicate = [...universe.data.slice(0, -1), universe.data[0]];
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot, universe: { data: duplicate }, indexTicks, now }),
    /fno_universe_contains_duplicate_symbols/);
});
