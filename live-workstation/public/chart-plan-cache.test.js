import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberChartPlan, getRetainedChartPlan } from './chart-plan-cache.js';
const start = Date.parse('2026-11-17T04:00:00Z');
const setup = { side: 'LONG', entry: 100, stopLoss: 95, target: 110, confirmationType: 'CLOSE_ABOVE' };
test('retains all three confirmed levels when subsequent evaluations do not confirm', () => {
  const cache = new Map();
  const saved = rememberChartPlan(cache, 'NSE:ABC-EQ', setup, start);
  assert.deepEqual(getRetainedChartPlan(cache, 'NSE:ABC-EQ', start + 60_000), saved);
  assert.equal(saved.entry, 100);
  assert.equal(saved.stopLoss, 95);
  assert.equal(saved.target, 110);
});
test('does not carry a retained setup into the next IST session', () => {
  const cache = new Map();
  rememberChartPlan(cache, 'NSE:ABC-EQ', setup, start);
  assert.equal(getRetainedChartPlan(cache, 'NSE:ABC-EQ', Date.parse('2026-11-17T19:00:00Z')), null);
});
test('expires retained levels after six hours', () => {
  const cache = new Map();
  rememberChartPlan(cache, 'NSE:ABC-EQ', setup, start);
  assert.equal(getRetainedChartPlan(cache, 'NSE:ABC-EQ', start + 6 * 60 * 60 * 1000 + 1), null);
});
test('rejects incomplete or invalid levels', () => {
  assert.throws(() => rememberChartPlan(new Map(), 'NSE:ABC-EQ', { ...setup, target: 0 }, start), /complete confirmed chart plan/);
});
