import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_SCAN_INTERVAL_MS,
  FNO_ROTATION_INTERVAL_MS,
  estimateScannerRestRequestsPerMinute,
  canFinishSubscriptionWindowBeforeRotation,
  shouldRetryFnoUniverse,
  prioritizeScannerSymbols,
  isFnoSubscriptionWindowRotation,
  resolveFnoSubscriptionWindowCursor
} from './scanner-schedule.js';

test('scanner reserves at least one third of the shared 15 rpm REST budget', () => {
  assert.equal(estimateScannerRestRequestsPerMinute(), 10);
  assert.ok(estimateScannerRestRequestsPerMinute() <= 10);
});

test('maximum 80-symbol window can be scanned before its rotation', () => {
  assert.equal(STRATEGY_SCAN_INTERVAL_MS, 12_000);
  assert.equal(FNO_ROTATION_INTERVAL_MS, 16 * 60_000);
  assert.equal(canFinishSubscriptionWindowBeforeRotation(80), true);
  assert.equal(canFinishSubscriptionWindowBeforeRotation(81), false);
});

test('invalid schedule inputs fail closed', () => {
  assert.equal(canFinishSubscriptionWindowBeforeRotation(-1), false);
  assert.throws(() => estimateScannerRestRequestsPerMinute({ intervalMs: 0 }), TypeError);
});


test('F&O universe retries after a recovered REST circuit without requiring a socket restart', () => {
  const base = {
    socketConnected:true, marketOpen:true, mcxOnlyMode:false,
    restBudgetReady:true, cooldownActive:false, recoveryProbeRequired:false,
    universeLoaded:false, subscriptionWindowReady:false, lastAttemptAt:0, now:60_000
  };
  assert.equal(shouldRetryFnoUniverse(base), true);
  assert.equal(shouldRetryFnoUniverse({...base, cooldownActive:true}), false);
  assert.equal(shouldRetryFnoUniverse({...base, recoveryProbeRequired:true}), false);
  assert.equal(shouldRetryFnoUniverse({...base, socketConnected:false}), false);
  assert.equal(shouldRetryFnoUniverse({...base, marketOpen:false}), false);
  assert.equal(shouldRetryFnoUniverse({...base, mcxOnlyMode:true}), false);
  assert.equal(shouldRetryFnoUniverse({...base, universeLoaded:true, subscriptionWindowReady:true}), false);
  assert.equal(shouldRetryFnoUniverse({...base, now:59_999}), false);
});

test('scanner checks fresh top-gainer futures first without duplicates or adding unsubscribed symbols', () => {
  assert.deepEqual(
    prioritizeScannerSymbols(['FUT-A','FUT-B','FUT-C','FUT-D'], ['FUT-C','FUT-A','NOT-SUBSCRIBED','FUT-C']),
    ['FUT-C','FUT-A','FUT-B','FUT-D']
  );
});

test('only scheduled or session/universe activation events advance the F&O subscription window', () => {
  assert.equal(isFnoSubscriptionWindowRotation('universe_loaded'), true);
  assert.equal(isFnoSubscriptionWindowRotation('scheduled_rotation'), true);
  assert.equal(isFnoSubscriptionWindowRotation('nse_session_open_universe_loaded'), true);
  for (const reason of ['fresh_tick_watchdog', 'state_change', 'post_unsubscribe_settle', 'strategy_option_candidate', 'top_gainer_option_prewarm']) {
    assert.equal(isFnoSubscriptionWindowRotation(reason), false, reason);
  }
});

test('watchdog and state changes keep the active F&O batch; scheduled rotation selects the next cursor', () => {
  const state = { activeCursor: 77, nextCursor: 154 };
  assert.equal(resolveFnoSubscriptionWindowCursor({ reason: 'fresh_tick_watchdog', ...state }), 77);
  assert.equal(resolveFnoSubscriptionWindowCursor({ reason: 'state_change', ...state }), 77);
  assert.equal(resolveFnoSubscriptionWindowCursor({ reason: 'post_unsubscribe_settle', ...state }), 77);
  assert.equal(resolveFnoSubscriptionWindowCursor({ reason: 'scheduled_rotation', ...state }), 154);
  assert.equal(resolveFnoSubscriptionWindowCursor({ reason: 'universe_loaded', activeCursor: 0, nextCursor: 0 }), 0);
});
