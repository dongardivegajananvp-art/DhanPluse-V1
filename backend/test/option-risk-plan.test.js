import test from "node:test";
import assert from "node:assert/strict";
import { buildOptionRiskPlan } from "../src/option-risk-plan.js";

const now = Date.parse("2026-10-31T07:00:00Z");
const interval = 5 * 60;
function candles({ low = 95, count = 13, lastStart = now - 5 * 60_000 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const time = Math.floor((lastStart - (count - 1 - index) * interval * 1000) / 1000);
    return [time, 100, 102, low, 101, 500];
  });
}

test("builds a 1:2-or-better option risk plan from completed candles", () => {
  const result = buildOptionRiskPlan({ candles: candles(), entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, true);
  assert.equal(result.entryPrice, 100);
  assert.equal(result.stopLoss, 95);
  assert.ok(result.target >= 110);
  assert.ok(result.rr >= 2);
  assert.equal(result.candleCount, 12);
});

test("blocks a forming latest candle and insufficient completed history", () => {
  const rows = candles({ count: 12, lastStart: now });
  const result = buildOptionRiskPlan({ candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /completed option candles/i);
});

test("blocks stale completed option candles", () => {
  const rows = candles({ lastStart: now - 60 * 60_000 });
  const result = buildOptionRiskPlan({ candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /stale/i);
});

test("blocks invalid or out-of-order OHLC data", () => {
  const rows = candles();
  rows[4] = [...rows[4]];
  rows[4][2] = 90;
  const result = buildOptionRiskPlan({ candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid/i);
});

test("blocks when swing-low is not below the ask entry", () => {
  const rows = candles({ low: 101 });
  const result = buildOptionRiskPlan({ candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /swing-low/i);
});

test("rejects unsupported intervals and invalid entries", () => {
  assert.equal(buildOptionRiskPlan({ candles: candles(), entryPrice: 100, resolution: "D", now }).ok, false);
  assert.equal(buildOptionRiskPlan({ candles: candles(), entryPrice: 0, resolution: "5", now }).ok, false);
});
