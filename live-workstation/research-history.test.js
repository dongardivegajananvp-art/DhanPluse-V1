import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFyersHistoryRange, normalizeCompletedFyersCandles } from './research-history.js';

test('requests enough recent FYERS 5-minute history for 5m and derived 15m research without extra REST calls', () => {
  const now = Date.parse('2026-11-18T06:18:00Z') / 1000;
  const range = buildFyersHistoryRange({ nowSeconds: now });
  assert.equal(range.lookbackDays, 15);
  assert.equal(range.rangeTo, Math.floor(now / 300) * 300 - 300);
  assert.equal(range.rangeFrom, range.rangeTo - 15 * 86400);
});

test('normalizes completed FYERS candles into ascending timestamp order and removes exact duplicates', () => {
  const now = Date.parse('2026-11-18T06:18:00Z') / 1000;
  const bucket = Math.floor(now / 300) * 300;
  const rows = [
    [bucket - 300, 101, 102, 100, 101.5, 20],
    [bucket - 600, 100, 101, 99, 100.5, 10],
    [bucket - 300, 101, 102, 100, 101.5, 20],
    [bucket, 101.5, 103, 101, 102.5, 5]
  ];
  const result = normalizeCompletedFyersCandles(rows, now);
  assert.deepEqual(result.candles.map(c => c.time), [bucket - 600, bucket - 300]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.partialCount, 1);
});

test('drops conflicting duplicate timestamps and malformed OHLC rather than inventing candle values', () => {
  const now = Date.parse('2026-11-18T06:18:00Z') / 1000;
  const bucket = Math.floor(now / 300) * 300;
  const result = normalizeCompletedFyersCandles([
    [bucket - 600, 100, 101, 99, 100.5, 10],
    [bucket - 600, 100, 102, 99, 101.5, 10],
    [bucket - 300, 100, 99, 98, 100.5, 10]
  ], now);
  assert.deepEqual(result.candles, []);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.invalidCount, 1);
});

test('rejects invalid FYERS range parameters', () => {
  assert.throws(() => buildFyersHistoryRange({ lookbackDays: 31 }), /Invalid FYERS historical range/);
});
