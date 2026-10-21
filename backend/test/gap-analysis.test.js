import test from "node:test";
import assert from "node:assert/strict";
import { analyzeOpeningGap, summarizeHistoricalGaps } from "../src/gap-analysis.js";

const bar = (timestamp, open, high, low, close, volume = 100, verified = true) =>
  ({ timestamp, open, high, low, close, volume, verified });

test("opening gap direction and percent are calculated", () => {
  const x = analyzeOpeningGap({ previousClose: 100, todayOpen: 102, relativeVolume: 2 });
  assert.equal(x.direction, "gap-up"); assert.equal(x.gapPct, 2); assert.equal(x.size, "large");
  assert.equal(x.elevatedVolume, true); assert.equal(x.tradeSignal, null);
});
test("event risk is a caution, not a trade signal", () => {
  const x = analyzeOpeningGap({ previousClose: 100, todayOpen: 99, majorEvent: true });
  assert.equal(x.context, "event-risk"); assert.equal(x.tradeSignal, null);
});
test("invalid source prices are rejected", () => {
  assert.throws(() => analyzeOpeningGap({ previousClose: 0, todayOpen: 100 }));
});
test("invalid relative volume is treated as unknown, not elevated", () => {
  const x = analyzeOpeningGap({ previousClose: 100, todayOpen: 101, relativeVolume: -2 });
  assert.equal(x.relativeVolume, null); assert.equal(x.elevatedVolume, false);
});
test("historical gap fill rate uses verified daily bars", () => {
  const bars = [
    bar("2026-01-01T00:00:00Z", 100, 105, 95, 100),
    bar("2026-01-02T00:00:00Z", 102, 104, 99, 101),
    bar("2026-01-03T00:00:00Z", 98, 101, 97, 99)
  ];
  const x = summarizeHistoricalGaps(bars);
  assert.equal(x.sampleSize, 2); assert.equal(x.filledCount, 2); assert.equal(x.fillRatePct, 100);
});
test("historical gap analysis sorts valid daily bars chronologically", () => {
  const bars = [
    bar("2026-01-02T00:00:00Z", 102, 104, 99, 101),
    bar("2026-01-01T00:00:00Z", 100, 105, 95, 100)
  ];
  const x = summarizeHistoricalGaps(bars);
  assert.equal(x.records[0].timestamp, "2026-01-02T00:00:00Z");
});
test("all OHLCV bars are validated, including the previous session", () => {
  const bars = [
    bar("2026-01-01T00:00:00Z", 100, 90, 95, 98),
    bar("2026-01-02T00:00:00Z", 102, 104, 99, 101)
  ];
  assert.throws(() => summarizeHistoricalGaps(bars), /unverified_or_invalid_daily_bar/);
});
test("duplicate daily timestamps are rejected", () => {
  const bars = [
    bar("2026-01-01T00:00:00Z", 100, 105, 95, 100),
    bar("2026-01-01T00:00:00Z", 102, 104, 99, 101)
  ];
  assert.throws(() => summarizeHistoricalGaps(bars), /duplicate_or_nonincreasing_daily_timestamp/);
});
test("empty qualifying sample has no fabricated percentage", () => {
  const bars = [
    bar("2026-01-01T00:00:00Z", 100, 101, 99, 100),
    bar("2026-01-02T00:00:00Z", 100.1, 101, 99, 100)
  ];
  const x = summarizeHistoricalGaps(bars, { minAbsGapPct: 5 });
  assert.equal(x.sampleSize, 0); assert.equal(x.fillRatePct, null);
});
test("invalid gap threshold is rejected", () => {
  const bars = [
    bar("2026-01-01T00:00:00Z", 100, 105, 95, 100),
    bar("2026-01-02T00:00:00Z", 102, 104, 99, 101)
  ];
  assert.throws(() => summarizeHistoricalGaps(bars, { minAbsGapPct: -1 }), /invalid_minimum_gap_threshold/);
});
test("historical statistics reject unverified bars", () => {
  assert.throws(() => summarizeHistoricalGaps([
    bar("2026-01-01T00:00:00Z", 100, 105, 95, 100, 100, false),
    bar("2026-01-02T00:00:00Z", 101, 103, 99, 102)
  ]), /unverified_or_invalid_daily_bar/);
});
