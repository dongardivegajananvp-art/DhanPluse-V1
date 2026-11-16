import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRetryDelayMs, shouldAttemptHistoryRetry } from './history-retry-policy.js';

test('invalid history responses use bounded exponential backoff', () => {
  assert.equal(historyRetryDelayMs({statusCode:502,attempt:1}),30000);
  assert.equal(historyRetryDelayMs({statusCode:502,attempt:2}),60000);
  assert.equal(historyRetryDelayMs({statusCode:502,attempt:5}),300000);
});
test('429 and explicit Retry-After are respected without shortening the wait', () => {
  assert.equal(historyRetryDelayMs({statusCode:429}),3600000);
  assert.equal(historyRetryDelayMs({statusCode:502,retryAfterMs:90000}),90000);
  assert.equal(historyRetryDelayMs({statusCode:502,retryAfterMs:99999999}),3600000);
});
test('history retry gate blocks until its deadline', () => {
  assert.equal(shouldAttemptHistoryRetry(2000,1999),false);
  assert.equal(shouldAttemptHistoryRetry(2000,2000),true);
  assert.equal(shouldAttemptHistoryRetry(null,2000),true);
});
