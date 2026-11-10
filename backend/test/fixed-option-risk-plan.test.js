import test from "node:test";
import assert from "node:assert/strict";
import { buildFixedOptionRiskPlan, validateCompletedOptionCandles } from "../src/fixed-option-risk-plan.js";

const now = Date.parse("2026-11-02T07:00:00.000Z");
const completed = Array.from({ length: 12 }, (_, index) => {
  const time = Math.floor((now - (12 - index) * 5 * 60_000) / 1000);
  return [time, 100, 101, 99, 100, 1000];
});

test("accepts only a strictly descending option candle sequence by reversing it chronologically", () => {
  const result = validateCompletedOptionCandles({ candles: completed.slice().reverse(), resolution: "5", now, lookback: 12 });
  assert.equal(result.ok, true);
  assert.equal(result.completedCandleCount, 12);
});

test("fixed risk plan uses 30 percent stop, 1.5x target and 2.5x target", () => {
  const result = buildFixedOptionRiskPlan({ entryPrice: 100, lotSize: 25, tickSize: 0.05 });
  assert.equal(result.ok, true);
  assert.equal(result.entryPrice, 100);
  assert.equal(result.stopLoss, 70);
  assert.equal(result.target1, 150);
  assert.equal(result.target2, 250);
  assert.equal(result.rr, 5);
  assert.equal(result.rrTarget1, 1.6667);
  assert.equal(result.rrTarget2, 5);
  assert.equal(result.riskPerLot, 750);
  assert.equal(result.target1RewardPerLot, 1250);
  assert.equal(result.target2RewardPerLot, 3750);
  assert.equal(result.targetAllocation, "SEQUENTIAL_OR_TESTED_LOT_SPLIT_REQUIRED");
});

test("fixed risk plan rejects unverified lot size, tick size and off-tick entry", () => {
  assert.equal(buildFixedOptionRiskPlan({ entryPrice: 100, lotSize: 0, tickSize: 0.05 }).ok, false);
  assert.equal(buildFixedOptionRiskPlan({ entryPrice: 100, lotSize: 25, tickSize: 0 }).ok, false);
  assert.equal(buildFixedOptionRiskPlan({ entryPrice: 100.03, lotSize: 25, tickSize: 0.05 }).ok, false);
});

test("fixed risk plans still require 12 fresh completed option candles", () => {
  const valid = validateCompletedOptionCandles({ candles: completed, resolution: "5", now, lookback: 12 });
  assert.equal(valid.ok, true);
  assert.equal(valid.completedCandleCount, 12);
  const formingOnly = completed.slice(0, 11).concat([[Math.floor((now - 60_000) / 1000), 100, 101, 99, 100, 1000]]);
  const blocked = validateCompletedOptionCandles({ candles: formingOnly, resolution: "5", now, lookback: 12 });
  assert.equal(blocked.ok, false);
});
