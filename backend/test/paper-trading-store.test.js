import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaperPlan } from '../src/paper-trading-store.js';

const now = Date.parse('2026-11-09T03:00:00.000Z');
const valid = {
  source: 'FYERS_VERIFIED',
  exchangeTimestamp: new Date(now - 1000).toISOString(),
  symbol: 'NSE:RELIANCE26NOV3000CE',
  side: 'CE',
  expiry: '2026-11-26',
  strike: 3000,
  plan: { entryPrice: 100, stopLoss: 70, target1: 150, target2: 250, quantity: 50 }
};

test('accepts only fresh FYERS verified immutable paper plans', () => {
  const result = validatePaperPlan(valid, now);
  assert.equal(result.quantity, 50);
  assert.equal(result.entry, 100);
  assert.equal(result.t2, 250);
});

test('rejects stale, missing or future exchange timestamps', () => {
  assert.throws(() => validatePaperPlan({ ...valid, exchangeTimestamp: new Date(now - 10001).toISOString() }, now), /older than 10 seconds/);
  assert.throws(() => validatePaperPlan({ ...valid, exchangeTimestamp: '' }, now), /timestamp/);
  assert.throws(() => validatePaperPlan({ ...valid, exchangeTimestamp: new Date(now + 6000).toISOString() }, now), /future-dated/);
});

test('rejects non-FYERS sources and incomplete contract identity', () => {
  assert.throws(() => validatePaperPlan({ ...valid, source: 'DEMO' }, now), /verified FYERS/);
  assert.throws(() => validatePaperPlan({ ...valid, strike: null }, now), /contract identity/);
});

test('rejects a risk plan below the minimum T2 1:2 reward/risk', () => {
  assert.throws(() => validatePaperPlan({
    ...valid, plan: { ...valid.plan, target2: 129 }
  }, now), /minimum 1:2/);
});

test('rejects non-positive or non-integer lot quantity', () => {
  assert.throws(() => validatePaperPlan({
    ...valid, plan: { ...valid.plan, quantity: 0 }
  }, now), /Immutable entry/);
});
