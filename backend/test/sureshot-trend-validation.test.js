import test from "node:test";
import assert from "node:assert/strict";
import { validateSureshotTrend } from "../src/sureshot-trend-validation.js";

function indiaEpoch(date, minute) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor((Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60) - 330 * 60_000) / 1000);
}

function candlesForCross(side = "CE") {
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    const minute = 555 + index * 5;
    rows.push([indiaEpoch("2026-11-12", minute), 100, 101, 99, 100, 100]);
  }
  if (side === "CE") {
    rows.push([indiaEpoch("2026-11-12", 655), 100, 100.2, 98.8, 99, 100]);
    rows.push([indiaEpoch("2026-11-12", 660), 99, 102, 98.5, 101, 100]);
  } else {
    rows.push([indiaEpoch("2026-11-12", 655), 100, 101.2, 99.8, 101, 100]);
    rows.push([indiaEpoch("2026-11-12", 660), 101, 101.2, 98, 99, 100]);
  }
  return rows;
}

const now = indiaEpoch("2026-11-12", 665) * 1000;

test("confirms a bullish DMA20 crossover from completed FYERS 5-minute candles", () => {
  const result = validateSureshotTrend({ candles: candlesForCross("CE"), resolution: "5", now });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.side, "CE");
  assert.equal(result.crossover, "BULLISH");
  assert.equal(result.completedCandleCount, 22);
  assert.ok(result.latestClose > result.dma20);
  assert.ok(result.previousClose <= result.previousDma20);
});

test("confirms a bearish DMA20 crossover from completed FYERS 5-minute candles", () => {
  const result = validateSureshotTrend({ candles: candlesForCross("PE"), resolution: "5", now });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.side, "PE");
  assert.equal(result.crossover, "BEARISH");
  assert.ok(result.latestClose < result.dma20);
  assert.ok(result.previousClose >= result.previousDma20);
});

test("normalizes strictly descending candle responses before crossover analysis", () => {
  const ascending = validateSureshotTrend({ candles: candlesForCross("CE"), resolution: "5", now });
  const descending = validateSureshotTrend({ candles: candlesForCross("CE").reverse(), resolution: "5", now });
  assert.equal(descending.ok, true, descending.reason);
  assert.equal(descending.side, ascending.side);
  assert.equal(descending.dma20, ascending.dma20);
});

test("does not create a signal when the latest candle has no fresh DMA20 cross", () => {
  const rows = candlesForCross("CE");
  rows[21] = [rows[21][0], 100, 101, 99, 100, 100];
  const result = validateSureshotTrend({ candles: rows, resolution: "5", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No fresh DMA20 crossover/i);
});

test("blocks insufficient, stale, future and unsupported-timeframe candles", () => {
  const rows = candlesForCross("CE");
  assert.equal(validateSureshotTrend({ candles: rows.slice(-15), resolution: "5", now }).ok, false);
  assert.equal(validateSureshotTrend({ candles: rows, resolution: "15", now }).ok, false);
  const stale = rows.map(row => [...row]);
  stale[21][0] -= 60 * 60;
  assert.equal(validateSureshotTrend({ candles: stale, resolution: "5", now }).ok, false);
  const future = rows.map(row => [...row]);
  future[21][0] = Math.floor((now + 60_000) / 1000);
  assert.equal(validateSureshotTrend({ candles: future, resolution: "5", now }).ok, false);
});
