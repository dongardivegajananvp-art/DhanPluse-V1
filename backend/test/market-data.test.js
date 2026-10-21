import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuote, normalizeCandles } from "../src/market-data.js";

test("quote is marked fresh only with valid positive price and timestamp", () => {
  const now = 1_800_000_000_000;
  const q = normalizeQuote({ lp: 100, tt: now / 1000 }, "NSE:TEST-EQ", now);
  assert.equal(q.price, 100);
  assert.equal(q.freshness, "fresh");
  assert.equal(q.verified, true);
});
test("rejects invalid quote instead of fabricating data", () => {
  assert.throws(() => normalizeQuote({ lp: 0, tt: Date.now() / 1000 }, "NSE:TEST-EQ"));
});
test("validates OHLC invariants", () => {
  const c = normalizeCandles([[1_800_000_000, 100, 110, 95, 105, 1000]]);
  assert.equal(c[0].high, 110);
  assert.throws(() => normalizeCandles([[1_800_000_000, 100, 90, 95, 105, 1000]]));
});
