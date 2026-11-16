import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_SCAN_INTERVAL_MS,
  FNO_ROTATION_INTERVAL_MS,
  estimateScannerRestRequestsPerMinute,
  canFinishSubscriptionWindowBeforeRotation
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
