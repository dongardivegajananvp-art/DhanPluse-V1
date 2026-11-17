import test from 'node:test';
import assert from 'node:assert/strict';
import { getMcxChartPriceDomain } from './chart-safety.js';

test('MCX chart domain adds breathing room around a narrow single-candle range', () => {
  const domain = getMcxChartPriceDomain(8067, 8069);
  assert.ok(domain.lo < 8067);
  assert.ok(domain.hi > 8069);
  assert.ok(domain.hi - domain.lo >= 8068 * 0.08);
  assert.ok(domain.hi - domain.lo <= 8068 * 0.096);
});

test('MCX chart domain preserves a wider real multi-candle range with padding', () => {
  const domain = getMcxChartPriceDomain(8000, 8100);
  assert.ok(domain.lo < 8000);
  assert.ok(domain.hi > 8100);
  assert.ok(domain.hi - domain.lo > 100);
});

test('MCX chart domain rejects invalid price bounds', () => {
  assert.throws(() => getMcxChartPriceDomain(0, 10), /Valid positive/);
  assert.throws(() => getMcxChartPriceDomain(20, 10), /Valid positive/);
});
