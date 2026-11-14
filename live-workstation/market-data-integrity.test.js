import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptExchangeTick, exchangeTickFreshness, getScannerRuntimeState, summarizeFeedFreshness } from './market-data-integrity.js';

const now = Date.parse('2026-11-16T04:00:00.000Z');
const fresh = (symbol, secondsAgo = 2) => ({
  symbol, price: 100, exchangeTime: now / 1000 - secondsAgo, receivedAt: now - secondsAgo * 1000
});

test('freshness requires both recent receipt and recent exchange timestamp', () => {
  assert.equal(exchangeTickFreshness(fresh('NSE:ABC', 2), now).status, 'FRESH');
  assert.equal(exchangeTickFreshness(fresh('NSE:ABC', 25), now).status, 'STALE');
  assert.equal(exchangeTickFreshness({ ...fresh('NSE:ABC', 2), receivedAt: now - 20000 }, now).status, 'STALE');
  assert.equal(exchangeTickFreshness({ ...fresh('NSE:ABC', 2), exchangeTime: 9e12 }, now).status, 'INVALID');
});

test('rejects future and out-of-order exchange timestamps', () => {
  const previous = fresh('NSE:ABC', 2);
  assert.deepEqual(acceptExchangeTick(previous, fresh('NSE:ABC', 4), now), {
    accepted: false, reason: 'OUT_OF_ORDER_EXCHANGE_TIMESTAMP'
  });
  assert.deepEqual(acceptExchangeTick(null, {
    ...fresh('NSE:ABC', 0), exchangeTime: now / 1000 + 8
  }, now), { accepted: false, reason: 'FUTURE_EXCHANGE_TIMESTAMP' });
});

test('keeps per-symbol fresh, stale and missing coverage distinct', () => {
  const ticks = new Map([
    ['NSE:A', fresh('NSE:A', 1)],
    ['NSE:B', fresh('NSE:B', 40)]
  ]);
  const summary = summarizeFeedFreshness(['NSE:A', 'NSE:B', 'NSE:C'], ticks, now);
  assert.equal(summary.requiredCount, 3);
  assert.equal(summary.freshCount, 1);
  assert.equal(summary.staleCount, 1);
  assert.equal(summary.missingCount, 1);
  assert.equal(summary.coveragePercent, 33.3);
  assert.equal(summary.staleOrMissingSamples.length, 2);
});

test('scanner runtime reports explicit blockers instead of implying readiness', () => {
  assert.equal(getScannerRuntimeState({
    authenticated: true, socketConnected: true, marketOpen: false, ledgerReady: true,
    universeCount: 200, activeSubscriptions: 97, freshFutureTicks: 0
  }).state, 'MARKET_CLOSED');
  assert.equal(getScannerRuntimeState({
    authenticated: true, socketConnected: true, marketOpen: true, ledgerReady: true,
    universeCount: 200, activeSubscriptions: 97, freshFutureTicks: 0
  }).state, 'WAITING_FOR_FRESH_FNO_TICKS');
  assert.equal(getScannerRuntimeState({
    authenticated: true, socketConnected: true, marketOpen: true, ledgerReady: false,
    universeCount: 200, activeSubscriptions: 97, freshFutureTicks: 1
  }).state, 'BLOCKED_LEDGER_UNAVAILABLE');
});
