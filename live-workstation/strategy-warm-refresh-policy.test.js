import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveStrategyWarmRefresh, releaseStrategyWarmRefresh } from './strategy-warm-refresh-policy.js';

test('REST cooldown pauses option prewarm without retaining the busy lock', () => {
  const state = { busy: false, lastAt: 0 };
  const paused = reserveStrategyWarmRefresh(state, {
    now: 100_000,
    minIntervalMs: 30_000,
    budgetReady: true,
    cooldownActive: true
  });

  assert.deepEqual(paused, { reserved: false, reason: 'REST_PAUSED' });
  assert.deepEqual(state, { busy: false, lastAt: 100_000 });

  const throttled = reserveStrategyWarmRefresh(state, {
    now: 110_000,
    minIntervalMs: 30_000,
    budgetReady: true
  });
  assert.deepEqual(throttled, { reserved: false, reason: 'THROTTLED' });
  assert.equal(state.busy, false);
});

test('option prewarm can reserve and release its lock after REST recovery', () => {
  const state = { busy: false, lastAt: 100_000 };
  const resumed = reserveStrategyWarmRefresh(state, {
    now: 130_001,
    minIntervalMs: 30_000,
    budgetReady: true,
    cooldownActive: false,
    recoveryProbeRequired: false
  });

  assert.deepEqual(resumed, { reserved: true, reason: 'READY' });
  assert.equal(state.busy, true);
  releaseStrategyWarmRefresh(state);
  assert.equal(state.busy, false);
});

test('option prewarm remains blocked while another refresh owns the lock', () => {
  const state = { busy: true, lastAt: 100_000 };
  const result = reserveStrategyWarmRefresh(state, {
    now: 200_000,
    minIntervalMs: 30_000,
    budgetReady: true
  });
  assert.deepEqual(result, { reserved: false, reason: 'BUSY' });
  assert.equal(state.busy, true);
});
