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
  const result = buildOptionRiskPlan({ lotSize: 25, candles: candles(), entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, true);
  assert.equal(result.entryPrice, 100);
  assert.equal(result.stopLoss, 95);
  assert.ok(result.target >= 110);
  assert.ok(result.rr >= 2);
  assert.equal(result.candleCount, 12);
});

test("normalizes strictly descending option candles before building the risk plan", () => {
  const ascending = buildOptionRiskPlan({ lotSize: 25, candles: candles(), entryPrice: 100, resolution: "5", now });
  const descending = buildOptionRiskPlan({ lotSize: 25, candles: candles().reverse(), entryPrice: 100, resolution: "5", now });
  assert.equal(descending.ok, true, descending.reason);
  assert.equal(descending.stopLoss, ascending.stopLoss);
  assert.equal(descending.target, ascending.target);
  assert.equal(descending.rr, ascending.rr);
});

test("blocks a forming latest candle and insufficient completed history", () => {
  const rows = candles({ count: 12, lastStart: now });
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /completed option candles/i);
});

test("blocks stale completed option candles", () => {
  const rows = candles({ lastStart: now - 60 * 60_000 });
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /stale/i);
});

test("blocks invalid or out-of-order OHLC data", () => {
  const rows = candles();
  rows[4] = [...rows[4]];
  rows[4][2] = 90;
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid/i);
});

test("blocks when swing-low is not below the ask entry", () => {
  const rows = candles().map(row => [row[0], 102, 103, 101, 102, 500]);
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /swing-low/i);
});

test("requires an official lot size and calculates one-lot rupee exposure", () => {
  const rows = candles();
  const missing = buildOptionRiskPlan({ candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /lot size/i);
  const result = buildOptionRiskPlan({ candles: rows, entryPrice: 100, lotSize: 25, tickSize: 0.05, resolution: "5", now });
  assert.equal(result.ok, true);
  assert.equal(result.quantity, 25);
  assert.equal(result.lots, 1);
  assert.equal(result.lotSize, 25);
  assert.equal(result.riskPerLot, result.riskPerUnit * 25);
  assert.equal(result.rewardPerLot, result.rewardPerUnit * 25);
  assert.equal(result.premiumPerLot, 2500);
});

test("rejects invalid lot sizes and tick sizes", () => {
  const rows = candles();
  assert.equal(buildOptionRiskPlan({ candles: rows, entryPrice: 100, lotSize: 0, now }).ok, false);
  assert.equal(buildOptionRiskPlan({ candles: rows, entryPrice: 100, lotSize: 25, tickSize: 0, now }).ok, false);
});

test("rejects unsupported intervals and invalid entries", () => {
  assert.equal(buildOptionRiskPlan({ lotSize: 25, candles: candles(), entryPrice: 100, resolution: "D", now }).ok, false);
  assert.equal(buildOptionRiskPlan({ lotSize: 25, candles: candles(), entryPrice: 0, resolution: "5", now }).ok, false);
});

test("rounds stop down and target up without reducing the 1:2 reward", () => {
  const rows = candles({ low: 94.97 });
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100.03, resolution: "5", now });
  assert.equal(result.ok, true);
  assert.equal(result.entryPrice, 100.03);
  assert.equal(result.stopLoss, 94.95);
  assert.ok(result.target >= result.entryPrice + 2 * (result.entryPrice - result.stopLoss));
  assert.ok(result.rr >= 2);
});

test("rejects future-dated and duplicate option candle timestamps", () => {
  const future = candles();
  future[12] = [Math.floor((now + 60_000) / 1000), 100, 102, 95, 101, 500];
  const futureResult = buildOptionRiskPlan({ lotSize: 25, candles: future, entryPrice: 100, resolution: "5", now });
  assert.equal(futureResult.ok, false);
  assert.match(futureResult.reason, /future|out-of-order/i);

  const duplicate = candles();
  duplicate[12] = [...duplicate[11]];
  const duplicateResult = buildOptionRiskPlan({ lotSize: 25, candles: duplicate, entryPrice: 100, resolution: "5", now });
  assert.equal(duplicateResult.ok, false);
  assert.match(duplicateResult.reason, /duplicated|out-of-order/i);
});
