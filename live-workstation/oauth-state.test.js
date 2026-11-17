import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_STATE_TTL_MS, oauthStateIsFresh, oauthStateStorageKey } from './oauth-state.js';

test('OAuth state key is a one-way digest and rejects malformed state', () => {
  const state = 'a'.repeat(48);
  const key = oauthStateStorageKey(state);
  assert.match(key, /^gv2vpd-live-workstation-oauth-state:[a-f0-9]{64}$/);
  assert.equal(key.includes(state), false);
  assert.equal(oauthStateStorageKey(''), '');
  assert.equal(oauthStateStorageKey('not-a-state'), '');
});

test('OAuth state freshness is bounded and rejects future/expired records', () => {
  const now = 2_000_000;
  assert.equal(oauthStateIsFresh({ createdAt: now - 1000 }, now), true);
  assert.equal(oauthStateIsFresh({ createdAt: now - AUTH_STATE_TTL_MS - 1 }, now), false);
  assert.equal(oauthStateIsFresh({ createdAt: now + 1 }, now), false);
  assert.equal(oauthStateIsFresh(null, now), false);
});
