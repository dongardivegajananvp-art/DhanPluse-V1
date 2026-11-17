import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateThreeCandleBreakout, getCompletedCandleWindow, isFreshExchangeTick, isHistoryCacheFresh } from '../public/chart-safety.js';

test('index feed accepts the exchange 30-second cadence while normal instruments retain the 10-second freshness gate',()=>{
  const now=Date.parse('2026-11-17T06:37:36Z');
  const indexTick={receivedAt:now-10000,exchangeTime:now/1000-10};
  const optionTick={...indexTick};
  assert.equal(isFreshExchangeTick(indexTick,now,40000),true);
  assert.equal(isFreshExchangeTick(optionTick,now),false);
});

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

test('three-candle breakout window rejects missing 5-minute intervals', () => {
  const exchangeTime = 1_800_000_000;
  const bucket = Math.floor(exchangeTime / 300) * 300;
  const candles = Array.from({ length: 3 }, (_, index) => ({
    time: bucket - 300 * (3 - index)
  }));
  candles[1].time += 300;
  const result = getCompletedCandleWindow(candles, exchangeTime, 600, 3);
  assert.equal(result.fresh, true);
  assert.equal(result.contiguous, false);
});

test('three consecutive completed 5-minute candles are accepted', () => {
  const exchangeTime = 1_800_000_000;
  const bucket = Math.floor(exchangeTime / 300) * 300;
  const candles = Array.from({ length: 3 }, (_, index) => ({
    time: bucket - 300 * (3 - index)
  }));
  const result = getCompletedCandleWindow(candles, exchangeTime, 600, 3);
  assert.equal(result.contiguous, true);
});

test('one completed candle after breakout confirms a long hold with fixed 1:2 risk', () => {
  const bars = [
    { time: 900, open: 99, high: 100, low: 98, close: 99 },
    { time: 1200, open: 99, high: 103, low: 99, close: 102 },
    { time: 1500, open: 102, high: 104, low: 101, close: 103 }
  ];
  const plan = evaluateThreeCandleBreakout(bars, 103.5);
  assert.equal(plan.status, 'SETUP_CONFIRMED');
  assert.equal(plan.side, 'LONG');
  assert.equal(plan.confirmationType, 'ONE_CANDLE_HOLD');
  assert.equal(plan.entry, 103);
  assert.equal(plan.stopLoss, 101);
  assert.equal(plan.target, 107);
  assert.equal(plan.rr, '1:2');
});

test('one completed candle after breakout confirms a short retest', () => {
  const bars = [
    { time: 900, open: 101, high: 102, low: 100, close: 101 },
    { time: 1200, open: 101, high: 101, low: 97, close: 98 },
    { time: 1500, open: 98, high: 102, low: 96, close: 97 }
  ];
  const plan = evaluateThreeCandleBreakout(bars, 96.5);
  assert.equal(plan.status, 'SETUP_CONFIRMED');
  assert.equal(plan.side, 'SHORT');
  assert.equal(plan.confirmationType, 'ONE_CANDLE_RETEST');
  assert.equal(plan.entry, 97);
  assert.equal(plan.stopLoss, 102);
  assert.equal(plan.target, 87);
});

test('breakout without the one following confirmation candle remains WAIT', () => {
  const bars = [
    { time: 900, open: 99, high: 100, low: 98, close: 99 },
    { time: 1200, open: 99, high: 103, low: 99, close: 102 }
  ];
  assert.equal(evaluateThreeCandleBreakout(bars, 102).status, 'WAIT');
});

test('default candle window preserves 21-bar continuity for existing MCX checks', () => {
  const exchangeTime = 1_800_000_000;
  const bucket = Math.floor(exchangeTime / 300) * 300;
  const candles = Array.from({ length: 21 }, (_, index) => ({
    time: bucket - 300 * (21 - index)
  }));
  assert.equal(getCompletedCandleWindow(candles, exchangeTime).contiguous, true);
  candles[10].time += 300;
  assert.equal(getCompletedCandleWindow(candles, exchangeTime).contiguous, false);
});

test('index freshness requires both recent receipt and fresh exchange timestamp', () => {
  const now = 1_800_000_000_000;
  const tick = { receivedAt: now - 1_000, exchangeTime: now / 1000 - 1 };
  assert.equal(isFreshExchangeTick(tick, now), true);
  assert.equal(isFreshExchangeTick({ ...tick, receivedAt: now - 11_000 }, now), false);
  assert.equal(isFreshExchangeTick({ ...tick, exchangeTime: now / 1000 - 11 }, now), false);
  assert.equal(isFreshExchangeTick({ ...tick, receivedAt: now + 1 }, now), false);
  assert.equal(isFreshExchangeTick({ ...tick, exchangeTime: now / 1000 + 4 }, now), false);
  assert.equal(isFreshExchangeTick({ exchangeTime: tick.exchangeTime }, now), false);
});
