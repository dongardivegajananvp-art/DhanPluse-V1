import test from "node:test";
import assert from "node:assert/strict";
import { analyzeOpeningGap, summarizeHistoricalGaps } from "../src/gap-analysis.js";

test("classifies gap up and gap down without creating a signal", () => {
  assert.equal(analyzeOpeningGap({ previousClose: 100, todayOpen: 101 }).direction, "gap-up");
  assert.equal(analyzeOpeningGap({ previousClose: 100, todayOpen: 99 }).direction, "gap-down");
  assert.equal(analyzeOpeningGap({ previousClose: 100, todayOpen: 101 }).tradeSignal, null);
});

test("blocks missing or invalid prices", () => {
  assert.throws(() => analyzeOpeningGap({ previousClose: 0, todayOpen: 101 }));
});

test("summarizes historical gap fills using validated OHLC bars", () => {
  const bars = [
    { timestamp: "2026-10-19T09:15:00+05:30", open: 100, high: 102, low: 99, close: 101, verified: true },
    { timestamp: "2026-10-20T09:15:00+05:30", open: 103, high: 104, low: 100, close: 102, verified: true },
    { timestamp: "2026-10-21T09:15:00+05:30", open: 99, high: 101, low: 98, close: 100, verified: true }
  ];
  const summary = summarizeHistoricalGaps(bars, { minAbsGapPct: 0.3 });
  assert.equal(summary.sampleSize, 2);
  assert.equal(summary.filledCount, 2);
  assert.equal(summary.fillRatePct, 100);
});

test("rejects unverified, invalid, or duplicate candles", () => {
  assert.throws(() => summarizeHistoricalGaps([
    { timestamp: "2026-10-19T09:15:00Z", open: 100, high: 102, low: 99, close: 101, verified: false },
    { timestamp: "2026-10-20T09:15:00Z", open: 101, high: 102, low: 99, close: 100, verified: true }
  ]));
  assert.throws(() => summarizeHistoricalGaps([
    { timestamp: "2026-10-19T09:15:00Z", open: 100, high: 102, low: 99, close: 101, verified: true },
    { timestamp: "2026-10-19T09:15:00Z", open: 101, high: 102, low: 99, close: 100, verified: true }
  ]));
});
