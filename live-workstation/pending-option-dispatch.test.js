import test from 'node:test';
import assert from 'node:assert/strict';
import { claimPendingCandidateProcessing, releasePendingCandidateProcessing } from './pending-option-dispatch.js';

const fresh = tick => tick?.fresh === true;

test('claims a pending candidate only when option and underlying ticks are both fresh', () => {
  const candidate = { contract: { symbol: 'NSE:ABC26NOV100CE' }, futureSymbol: 'NSE:ABC26NOVFUT' };
  assert.equal(claimPendingCandidateProcessing(candidate, { optionTick: { fresh: true }, underlyingTick: { fresh: true }, isFresh: fresh }), true);
  assert.equal(candidate.processing, true);
});

test('prevents duplicate concurrent processing and releases the lock for a later tick', () => {
  const candidate = { processing: false };
  const ticks = { optionTick: { fresh: true }, underlyingTick: { fresh: true }, isFresh: fresh, minIntervalMs: 1000 };
  assert.equal(claimPendingCandidateProcessing(candidate, { ...ticks, nowMs: 1000 }), true);
  assert.equal(claimPendingCandidateProcessing(candidate, { ...ticks, nowMs: 1000 }), false);
  assert.equal(releasePendingCandidateProcessing(candidate), true);
  assert.equal(claimPendingCandidateProcessing(candidate, { ...ticks, nowMs: 2000 }), true);
});

test('does not claim when either exchange tick is stale or missing', () => {
  const candidate = {};
  assert.equal(claimPendingCandidateProcessing(candidate, { optionTick: { fresh: true }, underlyingTick: { fresh: false }, isFresh: fresh }), false);
  assert.equal(claimPendingCandidateProcessing(candidate, { optionTick: null, underlyingTick: { fresh: true }, isFresh: fresh }), false);
  assert.equal(candidate.processing, undefined);
});


test('throttles repeated exchange events to one processing attempt per second', () => {
  const candidate = { processing: false };
  const ticks = { optionTick: { fresh: true }, underlyingTick: { fresh: true }, isFresh: fresh, minIntervalMs: 1000 };
  assert.equal(claimPendingCandidateProcessing(candidate, { ...ticks, nowMs: 1000 }), true);
  releasePendingCandidateProcessing(candidate);
  assert.equal(claimPendingCandidateProcessing(candidate, { ...ticks, nowMs: 1500 }), false);
  assert.equal(claimPendingCandidateProcessing(candidate, { ...ticks, nowMs: 2000 }), true);
});
