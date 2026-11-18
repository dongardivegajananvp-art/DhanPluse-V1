import test from 'node:test';
import assert from 'node:assert/strict';
import { fyersExpiryEpochSeconds } from './expiry-date.js';

test('normalizes compact and ISO date-only FYERS expiry values', () => {
  const expected = Date.UTC(2026, 10, 26, 10, 0, 0) / 1000;
  assert.equal(fyersExpiryEpochSeconds('20261126'), expected);
  assert.equal(fyersExpiryEpochSeconds('2026-11-26'), expected);
});

test('rejects impossible compact calendar dates instead of treating them as epoch seconds', () => {
  assert.equal(fyersExpiryEpochSeconds('20261131'), 0);
  assert.equal(fyersExpiryEpochSeconds('20260229'), 0);
});

test('preserves valid FYERS epoch seconds and millisecond timestamps', () => {
  const seconds = Date.UTC(2026, 10, 26, 4, 0, 0) / 1000;
  assert.equal(fyersExpiryEpochSeconds(String(seconds)), seconds);
  assert.equal(fyersExpiryEpochSeconds(String(seconds * 1000)), seconds);
});
