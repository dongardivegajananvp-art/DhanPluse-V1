import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersDataApiBudget } from '../backend/src/fyers-data-api-budget.js';

test('workstation budget serializes FYERS v3 and Data API paths with one shared pace', async () => {
  let clock = 1_000_000;
  const sentAt = [];
  const request = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => {
      sentAt.push(clock);
      return new Response(JSON.stringify({ s: 'ok' }), { status: 200 });
    }
  });

  const first = await request('https://api-t1.fyers.in/api/v3/screeners/standard');
  const second = await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(sentAt.length, 2);
  assert.ok(sentAt[1] - sentAt[0] >= 4000, 'all FYERS REST paths share the minimum request gap');
});

test('Cloudflare 1015 is persisted and blocks every FYERS REST endpoint across restart', async () => {
  let clock = 2_000_000;
  let sent = 0;
  let persisted = null;
  const first = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => {
      sent += 1;
      return new Response('Cloudflare error 1015', {
        status: 429,
        headers: { 'retry-after': '3600', server: 'cloudflare', 'cf-ray': 'test-ray' }
      });
    },
    onCooldownChange: async state => {
      persisted = { ...state, blockedUntil: new Date(state.cooldownUntil).toISOString() };
      return true;
    }
  });

  const blockedResponse = await first('https://api-t1.fyers.in/api/v3/screeners/standard');
  assert.equal(blockedResponse.status, 429);
  assert.equal(sent, 1);
  assert.equal(persisted.cooldownReason, 'CLOUDFLARE_1015');
  assert.equal(persisted.cooldownUntil - clock, 60 * 60 * 1000);

  const sameProcessBlocked = await first('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  assert.equal(sameProcessBlocked.status, 429);
  assert.equal(sent, 1, 'no queued request reaches the provider during cooldown');

  const restarted = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ s: 'ok' }), { status: 200 });
    }
  });
  assert.equal(restarted.restoreStatus(persisted), true);
  const afterRestart = await restarted('https://api-t1.fyers.in/api/v3/positions');
  assert.equal(afterRestart.status, 429);
  assert.equal(sent, 1, 'restart does not erase the persisted provider cooldown');
});

test('after cooldown only the previously blocked endpoint can perform the single recovery probe', async () => {
  let clock = 3_000_000;
  let sent = 0;
  let cleared = false;
  const request = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ s: 'ok' }), { status: 200 });
    },
    onCooldownChange: async state => {
      if (state.cooldownUntil === 0) cleared = true;
      return true;
    }
  });
  const persisted = {
    blockedUntil: new Date(clock + 60_000).toISOString(),
    cooldownReason: 'CLOUDFLARE_1015',
    cooldownPathname: '/api/v3/screeners/standard',
    cooldownGeneration: 1,
    consecutiveCloudflareBlocks: 1,
    consecutiveRateLimitBlocks: 0
  };
  assert.equal(request.restoreStatus(persisted), true);
  clock += 60_001;

  const otherEndpoint = await request('https://api-t1.fyers.in/api/v3/positions');
  assert.equal(otherEndpoint.status, 503);
  assert.equal(sent, 0, 'do not probe a different FYERS endpoint after expiry');

  const recoveryProbe = await request('https://api-t1.fyers.in/api/v3/screeners/standard');
  assert.equal(recoveryProbe.status, 200);
  assert.equal(sent, 1);
  assert.equal(cleared, true);

  const normalTraffic = await request('https://api-t1.fyers.in/api/v3/positions');
  assert.equal(normalTraffic.status, 200);
  assert.equal(sent, 2);
});

test('queue overflow is rejected locally instead of accumulating REST backlog', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let sent = 0;
  const request = createFyersDataApiBudget({
    allApiPaths: true,
    maxQueuedRequests: 1,
    fetchImpl: async () => {
      sent += 1;
      await gate;
      return new Response(JSON.stringify({ s: 'ok' }), { status: 200 });
    }
  });

  const first = request('https://api-t1.fyers.in/api/v3/positions');
  await new Promise(resolve => setImmediate(resolve));
  const overflow = await request('https://api-t1.fyers.in/api/v3/orders');
  assert.equal(overflow.status, 503);
  assert.equal(sent, 1);
  release();
  assert.equal((await first).status, 200);
});
