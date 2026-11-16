import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersDataApiBudget, isValidFyersRecoveryPayload } from './fyers-rest-budget.js';

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
      return new Response(JSON.stringify({ s: 'ok', data: { header: [], body: [] } }), { status: 200 });
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
  assert.equal(otherEndpoint.status, 429);
  assert.equal(sent, 0, 'other endpoints stay locally blocked after the cooldown expires');
  assert.equal(cleared, false, 'another endpoint cannot clear the blocked endpoint circuit');
  assert.equal(request.getStatus().recoveryProbeRequired, true);

  const recoveryProbe = await request('https://api-t1.fyers.in/api/v3/screeners/standard');
  assert.equal(recoveryProbe.status, 200);
  assert.equal(sent, 1);
  assert.equal(cleared, true, 'the originally blocked endpoint clears only after its own successful probe');

  const normalTraffic = await request('https://api-t1.fyers.in/api/v3/orders');
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


test('expired cooldown survives restart and still requires the original endpoint probe', async () => {
  let clock = 4_000_000;
  let sent = 0;
  const persisted = {
    blockedUntil: new Date(clock + 1000).toISOString(),
    cooldownReason: 'CLOUDFLARE_1015',
    cooldownPathname: '/data/quotes',
    cooldownGeneration: 3,
    consecutiveCloudflareBlocks: 2,
    consecutiveRateLimitBlocks: 0
  };
  const restarted = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ s: 'ok', d: [{ n: 'NSE:NIFTY50-INDEX', v: { lp: 25000 } }] }), { status: 200 });
    }
  });
  assert.equal(restarted.restoreStatus(persisted), true);
  clock += 2000;

  const wrongPath = await restarted('https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX');
  assert.equal(wrongPath.status, 429);
  assert.equal(sent, 0);
  assert.equal(restarted.getStatus().recoveryProbeRequired, true);

  const originalPathProbe = await restarted('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ANIFTY50-INDEX');
  assert.equal(originalPathProbe.status, 200);
  assert.equal(sent, 1);
  assert.equal(restarted.getStatus().cooldownActive, false);
  assert.equal(restarted.getStatus().recoveryProbeRequired, false);
});


test('recovery payload validation is endpoint-specific and rejects HTTP-200 error envelopes', () => {
  assert.equal(isValidFyersRecoveryPayload('/data/quotes', { s: 'ok', d: [{ n: 'NSE:NIFTY50-INDEX', v: { lp: 25000 } }] }), true);
  assert.equal(isValidFyersRecoveryPayload('/data/quotes', { s: 'ok', d: [] }), false);
  assert.equal(isValidFyersRecoveryPayload('/data/history', { s: 'ok', candles: [[1, 1, 2, 1, 2]] }), true);
  assert.equal(isValidFyersRecoveryPayload('/data/history', { s: 'ok', candles: [] }), false);
  assert.equal(isValidFyersRecoveryPayload('/data/options-chain-v3', { s: 'ok', data: { optionsChain: [{ symbol: 'NSE:TESTCE' }] } }), true);
  assert.equal(isValidFyersRecoveryPayload('/data/options-chain-v3', { s: 'ok', data: { optionsChain: [] } }), false);
  assert.equal(isValidFyersRecoveryPayload('/api/v3/screeners/config', { s: 'ok', data: { screeners_standard: [] } }), true);
  assert.equal(isValidFyersRecoveryPayload('/api/v3/screeners/standard', { s: 'ok', data: { header: [], body: [] } }), true);
  assert.equal(isValidFyersRecoveryPayload('/api/v3/screeners/standard', { s: 'ok', data: {} }), false);
  assert.equal(isValidFyersRecoveryPayload('/api/v3/positions', { s: 'ok', data: {} }), true);
  assert.equal(isValidFyersRecoveryPayload('/data/history', { s: 'error', message: 'invalid symbol' }), false);
});

test('same-endpoint HTTP 200 with an FYERS error envelope does not clear the recovery circuit', async () => {
  let clock = 5_000_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ s: 'error', message: 'temporarily unavailable' }), { status: 200 });
    },
    onCooldownChange: async () => true
  });
  const state = {
    blockedUntil: new Date(clock - 1).toISOString(),
    cooldownReason: 'CLOUDFLARE_1015',
    cooldownPathname: '/data/history',
    cooldownGeneration: 9,
    consecutiveCloudflareBlocks: 1,
    consecutiveRateLimitBlocks: 0
  };
  assert.equal(request.restoreStatus(state), true);
  const response = await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX');
  assert.equal(response.status, 200);
  assert.equal(sent, 1);
  assert.equal(request.getStatus().cooldownActive, true);
  assert.equal(request.getStatus().recoveryProbePathname, '/data/history');
});


test('priority queue runs live and option verification requests ahead of scanner history backlog', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const sent = [];
  const request = createFyersDataApiBudget({
    allApiPaths: true,
    minIntervalMs: 0,
    maxRequestsPerMinute: 15,
    sleep: async () => {},
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      sent.push(path);
      if (sent.length === 1) await firstGate;
      return new Response(JSON.stringify({ s: 'ok', d: [] }), { status: 200 });
    }
  });

  const active = request('https://api-t1.fyers.in/api/v3/orders', { priority: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const scannerHistory = request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ', { priority: 10 });
  const optionChain = request('https://api-t1.fyers.in/data/options-chain-v3?symbol=NSE%3ANIFTY50-INDEX', { priority: 80 });
  const liveQuotes = request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ANIFTY50-INDEX', { priority: 100 });
  releaseFirst();
  const results = await Promise.all([active, scannerHistory, optionChain, liveQuotes]);
  assert.ok(results.every(response => response.status === 200));
  assert.deepEqual(sent, [
    '/api/v3/orders',
    '/data/quotes',
    '/data/options-chain-v3',
    '/data/history'
  ]);
});


test('expired screener cooldown restores and probes only the persisted safe GET URL', async () => {
  let clock = 6_000_000;
  const sentUrls = [];
  const request = createFyersDataApiBudget({
    allApiPaths: true,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async url => {
      sentUrls.push(String(url));
      return new Response(JSON.stringify({ s: 'ok', data: { header: [], body: [] } }), { status: 200 });
    },
    onCooldownChange: async () => true
  });
  const probeUrl = 'https://api-t1.fyers.in/api/v3/screeners/standard?screener_id=futures-gainers&universe=fw002&fields=t0_close_ltp%2Ct0_per_change';
  const persisted = {
    blockedUntil: new Date(clock - 1).toISOString(),
    cooldownReason: 'CLOUDFLARE_1015',
    cooldownPathname: '/api/v3/screeners/standard',
    cooldownProbeUrl: probeUrl,
    cooldownProbeMethod: 'GET',
    cooldownGeneration: 11,
    consecutiveCloudflareBlocks: 1,
    consecutiveRateLimitBlocks: 0
  };
  assert.equal(request.restoreStatus(persisted), true);
  assert.equal(request.getStatus().blockedPathname, '/api/v3/screeners/standard');
  assert.equal(request.getStatus().recoveryProbeUrl, probeUrl);
  const response = await request(probeUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(sentUrls, [probeUrl]);
  assert.equal(request.getStatus().cooldownActive, false);
});

test('unsafe or mismatched persisted probe URLs are never restored', () => {
  let clock = 7_000_000;
  const request = createFyersDataApiBudget({ allApiPaths: true, now: () => clock });
  const state = {
    blockedUntil: new Date(clock - 1).toISOString(),
    cooldownPathname: '/api/v3/screeners/standard',
    cooldownProbeUrl: 'https://evil.example/api/v3/screeners/standard',
    cooldownProbeMethod: 'GET',
    cooldownGeneration: 12
  };
  assert.equal(request.restoreStatus(state), true);
  assert.equal(request.getStatus().recoveryProbeUrl, null);
});
