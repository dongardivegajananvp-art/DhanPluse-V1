import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteTimestampStatus } from '../src/fresh-data-validation.js';

const now = Date.parse('2026-10-24T04:00:00.000Z');

test('accepts exchange timestamps inside the configured freshness window', () => {
  assert.equal(quoteTimestampStatus(now / 1000 - 15, now, 15), 'FRESH');
  assert.equal(quoteTimestampStatus(now / 1000 - 30, now, 30), 'FRESH');
});

test('blocks quotes just beyond the freshness window', () => {
  assert.equal(quoteTimestampStatus(now / 1000 - 16, now, 15), 'STALE');
  assert.equal(quoteTimestampStatus(now / 1000 - 31, now, 30), 'STALE');
});

test('rejects missing, invalid, and future timestamps', () => {
  assert.equal(quoteTimestampStatus(null, now, 30), 'TIME_UNVERIFIED');
  assert.equal(quoteTimestampStatus('not-a-time', now, 30), 'TIME_UNVERIFIED');
  assert.equal(quoteTimestampStatus(now / 1000 + 1, now, 30), 'TIME_UNVERIFIED');
});
