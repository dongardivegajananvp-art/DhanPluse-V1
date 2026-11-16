import test from 'node:test';
import assert from 'node:assert/strict';
import { socketRecoveryDelayMs, SOCKET_RECOVERY_MAX_DELAY_MS } from './socket-recovery-policy.js';

test('socket recovery backs off without retry storms and remains self-healing', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(socketRecoveryDelayMs),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(socketRecoveryDelayMs(100), SOCKET_RECOVERY_MAX_DELAY_MS);
});

test('invalid and negative retry counters safely use the first delay', () => {
  assert.equal(socketRecoveryDelayMs(0), 5_000);
  assert.equal(socketRecoveryDelayMs(-4), 5_000);
  assert.equal(socketRecoveryDelayMs('bad'), 5_000);
});
