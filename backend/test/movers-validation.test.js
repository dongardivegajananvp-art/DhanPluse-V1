import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteMoverSnapshot } from '../src/movers-validation.js';

const requestedSymbols = ['NSE:AAA-EQ', 'NSE:BBB-EQ'];
const completeRows = [
  { symbol: 'NSE:AAA-EQ', price: 101 },
  { symbol: 'NSE:BBB-EQ', price: 202 }
];

test('accepts a complete, unique snapshot', () => {
  assert.equal(assertCompleteMoverSnapshot({
    requestedSymbols,
    rows: completeRows,
    receivedSymbols: new Set(requestedSymbols)
  }), true);
});

test('blocks missing symbols even if the API returned some rows', () => {
  assert.throws(() => assertCompleteMoverSnapshot({
    requestedSymbols,
    rows: [completeRows[0]],
    receivedSymbols: new Set(['NSE:AAA-EQ'])
  }), error => error.statusCode === 502 && error.failedSymbols.includes('NSE:BBB-EQ'));
});

test('blocks failed quote batches even if returned rows appear complete', () => {
  assert.throws(() => assertCompleteMoverSnapshot({
    requestedSymbols,
    rows: completeRows,
    receivedSymbols: new Set(requestedSymbols),
    failedBatches: ['NSE:BBB-EQ']
  }), error => error.statusCode === 502 && error.failedSymbols.includes('NSE:BBB-EQ'));
});

test('blocks duplicate quote rows instead of treating them as full coverage', () => {
  assert.throws(() => assertCompleteMoverSnapshot({
    requestedSymbols,
    rows: [completeRows[0], completeRows[0]],
    receivedSymbols: new Set(requestedSymbols)
  }), error => error.statusCode === 502);
});

test('propagates rate-limit errors without accepting partial data', () => {
  const rateLimit = Object.assign(new Error('rate limited'), { statusCode: 429 });
  assert.throws(() => assertCompleteMoverSnapshot({
    requestedSymbols,
    rows: completeRows,
    receivedSymbols: new Set(requestedSymbols),
    rateLimitError: rateLimit
  }), error => error === rateLimit);
});

test('blocks an empty requested universe', () => {
  assert.throws(() => assertCompleteMoverSnapshot({
    requestedSymbols: [],
    rows: [],
    receivedSymbols: new Set()
  }), error => error.statusCode === 502);
});

import { assertFreshMoverSnapshot } from '../src/movers-validation.js';

test('blocks live rankings if any quote is stale or timestamp-unverified', () => {
  assert.throws(() => assertFreshMoverSnapshot([
    { symbol: 'NSE:AAA-EQ', priceStatus: 'LIVE_QUOTE' },
    { symbol: 'NSE:BBB-EQ', priceStatus: 'STALE_QUOTE' }
  ], true), error => error.statusCode === 502 && error.staleSymbols.includes('NSE:BBB-EQ'));
  assert.throws(() => assertFreshMoverSnapshot([
    { symbol: 'NSE:AAA-EQ', priceStatus: 'LIVE_QUOTE' },
    { symbol: 'NSE:BBB-EQ', priceStatus: 'TIME_UNVERIFIED' }
  ], true), error => error.statusCode === 502 && error.staleSymbols.includes('NSE:BBB-EQ'));
});

test('allows explicitly last-known rows after market close', () => {
  assert.equal(assertFreshMoverSnapshot([
    { symbol: 'NSE:AAA-EQ', priceStatus: 'LAST_KNOWN_PRICE' }
  ], false), true);
});
