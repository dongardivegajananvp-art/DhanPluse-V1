import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRetryDelayMs } from './request-retry.js';

test('request retry delay grows exponentially and remains bounded', () => {
  assert.equal(boundedRetryDelayMs({ attempt: 1 }), 15_000);
  assert.equal(boundedRetryDelayMs({ attempt: 2 }), 30_000);
  assert.equal(boundedRetryDelayMs({ attempt: 5 }), 240_000);
  assert.equal(boundedRetryDelayMs({ attempt: 8 }), 300_000);
});
test('server Retry-After is never shortened and is capped at one hour', () => {
  assert.equal(boundedRetryDelayMs({ attempt: 1, retryAfterMs: 90_000 }), 90_000);
  assert.equal(boundedRetryDelayMs({ attempt: 4, retryAfterMs: 10_000 }), 120_000);
  assert.equal(boundedRetryDelayMs({ attempt: 2, retryAfterMs: 99_999_999 }), 3_600_000);
});
test('broker retry policy supports a shorter independent backoff', () => {
  assert.equal(boundedRetryDelayMs({ attempt: 1, baseMs: 10_000, maxMs: 300_000 }), 10_000);
  assert.equal(boundedRetryDelayMs({ attempt: 3, baseMs: 10_000, maxMs: 300_000 }), 40_000);
});
