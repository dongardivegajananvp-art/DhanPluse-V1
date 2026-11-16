import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRestartSilentIndexFeed } from './socket-feed-watchdog.js';

test('silent connected socket is restarted only after the index heartbeat grace period', () => {
  const base = { marketOpen: true, socketConnected: true, freshIndexCount: 0, requiredIndexCount: 3, staleSince: 1000, now: 30999 };
  assert.equal(shouldRestartSilentIndexFeed(base), false);
  assert.equal(shouldRestartSilentIndexFeed({ ...base, now: 31000 }), true);
});

test('feed watchdog never restarts outside market, while disconnected, or when indexes are fresh', () => {
  const base = { marketOpen: true, socketConnected: true, freshIndexCount: 0, requiredIndexCount: 3, staleSince: 1000, now: 40000 };
  assert.equal(shouldRestartSilentIndexFeed({ ...base, marketOpen: false }), false);
  assert.equal(shouldRestartSilentIndexFeed({ ...base, socketConnected: false }), false);
  assert.equal(shouldRestartSilentIndexFeed({ ...base, freshIndexCount: 3 }), false);
  assert.equal(shouldRestartSilentIndexFeed({ ...base, staleSince: null }), false);
});
