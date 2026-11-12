import test from "node:test";
import assert from "node:assert/strict";
import { buildOptionRiskPlan } from "../src/option-risk-plan.js";

const now = Date.parse("2026-11-12T07:00:00Z");
const interval = 5 * 60;
function candles({ low = 95, high = 102, count = 25, lastStart = now - 5 * 60_000 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const time = Math.floor((lastStart - (count - 1 - index) * interval * 1000) / 1000);
    return [time, 100, high, low, 101, 500];
  });
}

test("builds 20-candle swing-low minus 0.35 ATR(14) stop and actual-entry 2R/3R targets", () => {
  const result = buildOptionRiskPlan({ lotSize: 25, candles: candles(), entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.entryPrice, 100);
  assert.equal(result.swingLow, 95);
  assert.equal(result.atr14, 7);
  assert.equal(result.stopLoss, 92.55);
  assert.equal(result.target1, 114.9);
  assert.equal(result.target2, 122.35);
  assert.ok(result.rrTarget1 >= 2);
  assert.ok(result.rrTarget2 >= 3);
  assert.equal(result.candleCount, 20);
  assert.equal(result.riskPerLot, 186.25);
  assert.equal(result.target1RewardPerLot, 372.5);
  assert.equal(result.target2RewardPerLot, 558.75);
});

test("normalizes strictly descending option candles before calculating ATR and risk", () => {
  const ascending = buildOptionRiskPlan({ lotSize: 25, candles: candles(), entryPrice: 100, resolution: "5", now });
  const descending = buildOptionRiskPlan({ lotSize: 25, candles: candles().reverse(), entryPrice: 100, resolution: "5", now });
  assert.equal(descending.ok, true, descending.reason);
  assert.equal(descending.stopLoss, ascending.stopLoss);
  assert.equal(descending.target1, ascending.target1);
  assert.equal(descending.target2, ascending.target2);
  assert.equal(descending.rrTarget2, ascending.rrTarget2);
});

test("blocks a forming latest candle and insufficient completed history", () => {
  const rows = candles({ count: 20, lastStart: now });
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

test("blocks when the buffered swing-low is not below the verified ask", () => {
  const rows = candles({ low: 101, high: 103 }).map(row => [row[0], 102, 103, 101, 102, 500]);
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /swing-low/i);
});

test("requires official lot size and calculates one-lot risk and premium exposure", () => {
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

test("rejects unsupported intervals, invalid entries and invalid ATR settings", () => {
  const rows = candles();
  assert.equal(buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, resolution: "D", now }).ok, false);
  assert.equal(buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 0, resolution: "5", now }).ok, false);
  assert.equal(buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100, atrBuffer: -1, now }).ok, false);
});

test("rounds stop down and targets up without reducing the required reward multiples", () => {
  const rows = candles({ low: 94.97 });
  const result = buildOptionRiskPlan({ lotSize: 25, candles: rows, entryPrice: 100.03, resolution: "5", now });
  assert.equal(result.ok, true);
  assert.equal(result.entryPrice, 100.03);
  assert.ok(result.stopLoss <= 94.97 - 0.35 * 7);
  assert.ok(result.target1 >= result.entryPrice + 2 * (result.entryPrice - result.stopLoss));
  assert.ok(result.target2 >= result.entryPrice + 3 * (result.entryPrice - result.stopLoss));
  assert.ok(result.rrTarget1 >= 2);
  assert.ok(result.rrTarget2 >= 3);
});

test("rejects future-dated and duplicate option candle timestamps", () => {
  const future = candles();
  future[24] = [Math.floor((now + 60_000) / 1000), 100, 102, 95, 101, 500];
  const futureResult = buildOptionRiskPlan({ lotSize: 25, candles: future, entryPrice: 100, resolution: "5", now });
  assert.equal(futureResult.ok, false);
  assert.match(futureResult.reason, /future|out-of-order/i);
  const duplicate = candles();
  duplicate[24] = [...duplicate[23]];
  const duplicateResult = buildOptionRiskPlan({ lotSize: 25, candles: duplicate, entryPrice: 100, resolution: "5", now });
  assert.equal(duplicateResult.ok, false);
  assert.match(duplicateResult.reason, /duplicated|out-of-order/i);
});
