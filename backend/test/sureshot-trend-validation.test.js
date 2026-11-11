import test from "node:test";
import assert from "node:assert/strict";
import { validateSureshotTrend } from "../src/sureshot-trend-validation.js";

function indiaEpoch(date, minute) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor((Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60) - 330 * 60_000) / 1000);
}

function trendCandles(side = "UP", currentVolume = 200) {
  const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
  const rows = [];
  let price = 100;
  for (const date of days) {
    for (const minute of [555, 560, 565, 570, 575, 580]) {
      const open = price;
      const close = side === "UP" ? price + 1 : price - 1;
      const high = side === "UP" ? close + 0.4 : open + 0.2;
      const low = side === "UP" ? open - 0.2 : close - 0.4;
      rows.push([indiaEpoch(date, minute), open, high, low, close, 100]);
      price = close;
    }
  }
  for (const minute of [555, 560, 565]) {
    const open = price;
    const close = side === "UP" ? price + 1 : price - 1;
    const high = side === "UP" ? close + 0.4 : open + 0.2;
    const low = side === "UP" ? open - 0.2 : close - 0.4;
    rows.push([indiaEpoch("2026-11-02", minute), open, high, low, close, currentVolume]);
    price = close;
  }
  return rows;
}

const now = indiaEpoch("2026-11-02", 571) * 1000;

test("confirms a strong CE trend only when ADX, EMA, VWAP and same-time volume align", () => {
  const result = validateSureshotTrend({ candles: trendCandles("UP"), resolution: "5", now });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.side, "CE");
  assert.ok(result.adx >= 20);
  assert.ok(result.volumeRatio >= 1.5);
  assert.ok(result.trendScore >= 70);
  assert.equal(result.scoreParts.sameTimeVolume, 20);
});

test("normalizes a strictly descending FYERS trend response before validation", () => {
  const ascending = validateSureshotTrend({ candles: trendCandles("UP"), resolution: "5", now });
  const descending = validateSureshotTrend({ candles: trendCandles("UP").reverse(), resolution: "5", now });
  assert.equal(descending.ok, true, descending.reason);
  assert.equal(descending.side, ascending.side);
  assert.equal(descending.trendScore, ascending.trendScore);
});

test("confirms a strong PE trend with the inverse EMA and VWAP alignment", () => {
  const result = validateSureshotTrend({ candles: trendCandles("DOWN"), resolution: "5", now });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.side, "PE");
  assert.ok(result.adx >= 20);
  assert.ok(result.volumeRatio >= 1.5);
});

test("scores low same-time volume instead of treating it as an automatic veto", () => {
  const lowVolume = validateSureshotTrend({ candles: trendCandles("UP", 50), resolution: "5", now });
  assert.equal(lowVolume.ok, true, lowVolume.reason);
  assert.equal(lowVolume.side, "CE");
  assert.equal(lowVolume.scoreParts.sameTimeVolume, 5);
  assert.ok(lowVolume.trendScore >= 55);
});

test("retains the hard data-history gate and configurable minimum weighted score", () => {
  const insufficient = validateSureshotTrend({ candles: trendCandles("UP").slice(-15), resolution: "5", now });
  assert.equal(insufficient.ok, false);
  assert.match(insufficient.reason, /30 completed|five previous/i);
  const highThreshold = validateSureshotTrend({ candles: trendCandles("UP", 50), resolution: "5", now, minTrendScore: 90 });
  assert.equal(highThreshold.ok, false);
  assert.match(highThreshold.reason, /Weighted Trend Score/i);
});
