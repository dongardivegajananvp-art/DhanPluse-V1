import test from 'node:test';
import assert from 'node:assert/strict';
import { getCompletedCandleWindow, isHistoryCacheFresh } from '../public/chart-safety.js';

test('history cache expires instead of remaining valid indefinitely', () => {
  const now = 1_800_000_000_000;
  assert.equal(isHistoryCacheFresh(now - 59_999, now), true);
  assert.equal(isHistoryCacheFresh(now - 60_000, now), false);
  assert.equal(isHistoryCacheFresh(now + 1, now), false);
  assert.equal(isHistoryCacheFresh('not-a-date', now), false);
});

test('current forming candle is excluded from completed candle window', () => {
  const exchangeTime = 1_800_000_000;
  const bucket = Math.floor(exchangeTime / 300) * 300;
  const candles = [{ time: bucket - 300 }, { time: bucket }];
  const result = getCompletedCandleWindow(candles, exchangeTime);
  assert.deepEqual(result.completed, [candles[0]]);
  assert.equal(result.lastClosed, candles[0]);
});

test('fresh latest completed candle passes the freshness gate', () => {
  const exchangeTime = 1_800_000_000;
  const bucket = Math.floor(exchangeTime / 300) * 300;
  const result = getCompletedCandleWindow([{ time: bucket - 300 }], exchangeTime);
  assert.equal(result.fresh, true);
  assert.ok(result.ageSeconds >= 0 && result.ageSeconds <= 600);
});

test('stale or future completed candles fail closed', () => {
  const exchangeTime = 1_800_000_000;
  assert.equal(getCompletedCandleWindow([{ time: 1_799_999_000 }], exchangeTime).fresh, false);
  assert.equal(getCompletedCandleWindow([{ time: 1_800_000_000 }], exchangeTime - 10).fresh, false);
  assert.equal(getCompletedCandleWindow([], exchangeTime).fresh, false);
});
