import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersDataApiBudget, canClearFyersDataApiCooldown } from '../src/fyers-data-api-budget.js';

function fakeResponse(status = 200, body = '', headers = {}) {
  return new Response(body, { status, headers });
}

test('FYERS Data API requests share a rolling-minute budget', async () => {
  let clock = 100_000;
  const sentAt = [];
  const request = createFyersDataApiBudget({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    maxRequestsPerMinute: 2,
    minIntervalMs: 0,
    windowMs: 60_000,
    fetchImpl: async () => { sentAt.push(clock); return fakeResponse(); }
  });

  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  await request('https://api-t1.fyers.in/data/options-chain-v3?symbol=NSE%3ANIFTY50-INDEX');
  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[2] - sentAt[0] >= 60_000);
});

test('Cloudflare 1015 opens a shared one-hour circuit breaker and suppresses later upstream calls', async () => {
  let clock = 100_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async () => { sent += 1; return fakeResponse(429, 'Cloudflare Error 1015', { server: 'cloudflare', 'cf-ray': 'abc123', 'retry-after': '0' }); }
  });

  const first = await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  assert.equal(first.status, 429);
  assert.equal(request.getStatus().cooldownActive, true);
  assert.equal(request.getStatus().retryAfterSeconds, 3600);
  assert.equal(request.getStatus().cooldownReason, 'CLOUDFLARE_1015');

  const blocked = await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('x-dhanpulse-cooldown'), 'active');
  assert.equal(sent, 1, 'no additional upstream request may be sent during the circuit break');
});

test('requests already waiting in the serial queue are stopped after the first 1015', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return fakeResponse(429, 'Cloudflare Error 1015');
    }
  });

  const [first, second, third] = await Promise.all([
    request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3AA-EQ'),
    request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3AB-EQ'),
    request('https://api-t1.fyers.in/data/history?symbol=NSE%3AC-EQ')
  ]);
  assert.equal(first.status, 429);
  assert.equal(second.status, 429);
  assert.equal(third.status, 429);
  assert.equal(sent, 1, 'queued requests must not leak through after a provider block');
});

test('repeated Cloudflare 1015 escalates backoff; a successful probe clears the circuit', async () => {
  let clock = 200_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return sent <= 2 ? fakeResponse(429, 'Cloudflare Error 1015') : fakeResponse(200, '{"s":"ok"}');
    }
  });
  const url = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ';

  await request(url);
  assert.equal(request.getStatus().retryAfterSeconds, 3600);
  clock += 3_600_001;
  await request(url);
  assert.equal(request.getStatus().retryAfterSeconds, 3600);
  clock += 3_600_001;
  const recovered = await request(url);
  assert.equal(recovered.status, 200);
  assert.equal(request.getStatus().cooldownActive, false);
  assert.equal(request.getStatus().consecutiveCloudflareBlocks, 0);
});

test('HTTP 429 honours Retry-After and treats Retry-After zero as a one-minute minimum', async () => {
  let clock = 300_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return fakeResponse(429, 'rate limited', { 'retry-after': sent === 1 ? '3600' : '0' });
    }
  });
  const url = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX';

  await request(url);
  assert.equal(request.getStatus().retryAfterSeconds, 3600);
  const blocked = await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  assert.equal(blocked.status, 429);
  assert.equal(sent, 1);
});

test('a late in-flight success cannot clear a newer Cloudflare 1015 cooldown', () => {
  const blockedGeneration = 8;
  const requestStartedBeforeBlock = 7;
  assert.equal(canClearFyersDataApiCooldown({
    responseOk: true,
    blockedPathname: '/data/quotes',
    responsePathname: '/data/history',
    requestGeneration: requestStartedBeforeBlock,
    currentGeneration: blockedGeneration
  }), false);
  assert.equal(canClearFyersDataApiCooldown({
    responseOk: true,
    blockedPathname: '/data/quotes',
    responsePathname: '/data/quotes',
    requestGeneration: requestStartedBeforeBlock,
    currentGeneration: blockedGeneration
  }), false);
  assert.equal(canClearFyersDataApiCooldown({
    responseOk: true,
    blockedPathname: '/data/quotes',
    responsePathname: '/data/quotes',
    requestGeneration: blockedGeneration,
    currentGeneration: blockedGeneration
  }), true);
});

test('a history read already in flight is serialized before a quote 1015 and cannot reopen upstream traffic', async () => {
  let releaseHistory;
  let markHistoryStarted;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const historyStarted = new Promise(resolve => { markHistoryStarted = resolve; });
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  let upstreamCalls = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async url => {
      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      upstreamCalls += 1;
      if (String(url).includes('/data/history')) {
        markHistoryStarted();
        await historyGate;
        activeRequests -= 1;
        return fakeResponse(200, '{"s":"ok","candles":[]}', { 'content-type': 'application/json' });
      }
      activeRequests -= 1;
      return fakeResponse(429, 'Cloudflare Error 1015', {
        server: 'cloudflare', 'cf-ray': 'inflight-1015', 'retry-after': '0'
      });
    }
  });

  const historyPromise = request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ&resolution=5');
  await historyStarted;
  const quotePromise = request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  releaseHistory();
  const [history, quotes] = await Promise.all([historyPromise, quotePromise]);

  assert.equal(history.status, 200);
  assert.equal(quotes.status, 429);
  assert.equal(maxConcurrentRequests, 1, 'Data API upstream requests must remain serialized');
  assert.equal(request.getStatus().cooldownActive, true);

  const blocked = await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ABANKNIFTY-INDEX');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('x-dhanpulse-cooldown'), 'active');
  assert.equal(upstreamCalls, 2, 'no third upstream request may be sent while the quote cooldown is active');
});

test('non-Data API endpoints are not counted against the Data API budget', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    fetchImpl: async () => { sent += 1; return fakeResponse(); }
  });
  await request('https://api-t1.fyers.in/api/v3/holdings');
  assert.equal(sent, 1);
});

test('identical history reads are coalesced and briefly cached', async () => {
  let clock = 500_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    historyCacheMs: 10_000,
    fetchImpl: async () => {
      sent += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return fakeResponse(200, JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), { 'content-type': 'application/json' });
    }
  });
  const url = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ&resolution=5';
  const [first, second] = await Promise.all([request(url), request(url)]);
  assert.equal(sent, 1);
  assert.deepEqual(await first.json(), await second.json());
  const cached = await request(url);
  assert.equal(sent, 1);
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  clock += 10_001;
  await request(url);
  assert.equal(sent, 2);
});

test('bypassCache forces a fresh history request and refreshes the shared cache', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return fakeResponse(200, JSON.stringify({ s: 'ok', generation: sent }), { 'content-type': 'application/json' });
    }
  });
  const url = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ&resolution=5';
  await request(url);
  const fresh = await request(url, { bypassCache: true });
  assert.equal(sent, 2);
  assert.equal(fresh.headers.get('x-dhanpulse-cache'), 'MISS');
  assert.equal((await fresh.json()).generation, 2);
  const cached = await request(url);
  assert.equal(sent, 2);
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  assert.equal((await cached.json()).generation, 2);
});

test('default history cache reuses OHLC for five minutes, then requires a fresh FYERS read', async () => {
  let clock = 540_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return fakeResponse(200, JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), { 'content-type': 'application/json' });
    }
  });
  const url = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX&resolution=5';
  await request(url);
  clock += 4 * 60_000;
  const cached = await request(url);
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  assert.equal(sent, 1);
  clock += 60_001;
  await request(url);
  assert.equal(sent, 2);
});

test('verified cached history remains available during cooldown but expired history cannot bypass it', async () => {
  let clock = 550_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    historyCacheMs: 180_000,
    fetchImpl: async url => {
      sent += 1;
      if (String(url).includes('/data/quotes')) return fakeResponse(429, 'Cloudflare Error 1015');
      return fakeResponse(200, JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), { 'content-type': 'application/json' });
    }
  });
  const historyUrl = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX&resolution=5';
  await request(historyUrl);
  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  const cached = await request(historyUrl);
  assert.equal(sent, 2);
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  clock += 180_001;
  const blocked = await request(historyUrl);
  assert.equal(blocked.status, 429);
  assert.equal(sent, 2, 'expired history must not reach FYERS while the circuit is open');
});

test('option quote requests are never cached', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return fakeResponse(200, JSON.stringify({ s: 'ok', d: [] }));
    }
  });
  const url = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ANIFTY26NOV25000CE';
  await request(url);
  await request(url);
  assert.equal(sent, 2);
});

test('identical concurrent quote reads share one upstream request but are not cached', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return fakeResponse(200, JSON.stringify({ s: 'ok', d: [{ n: 'NSE:TEST-EQ', v: { lp: 123.45, tt: 1 } }] }), { 'content-type': 'application/json' });
    }
  });
  const url = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATEST-EQ';
  const [first, second] = await Promise.all([request(url), request(url)]);
  assert.equal(sent, 1);
  assert.deepEqual(await first.json(), await second.json());
  await request(url);
  assert.equal(sent, 2);
});

test('default FYERS pacing enforces six requests per minute and a ten-second minimum gap', async () => {
  let clock = 700_000;
  const sentAt = [];
  const request = createFyersDataApiBudget({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => { sentAt.push(clock); return fakeResponse(); }
  });
  for (let index = 0; index < 16; index += 1) {
    await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATEST' + index + '-EQ&resolution=5');
  }
  assert.equal(sentAt.length, 16);
  assert.ok(sentAt[1] - sentAt[0] >= 10_000);
  assert.ok(sentAt[5] - sentAt[0] < 60_000);
  assert.ok(sentAt[6] - sentAt[0] >= 60_000);
});


test('success from a different FYERS endpoint does not reset Cloudflare backoff for blocked quotes', async () => {
  let clock = 900_000;
  let quoteAttempts = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async url => {
      if (String(url).includes('/data/quotes')) {
        quoteAttempts += 1;
        return fakeResponse(429, 'Cloudflare Error 1015', { server: 'cloudflare', 'cf-ray': 'xyz987', 'retry-after': '0' });
      }
      return fakeResponse(200, '{"s":"ok"}');
    }
  });
  const quotes = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ';
  await request(quotes);
  assert.equal(request.getStatus().retryAfterSeconds, 3600);
  clock += 3_600_001;
  const history = await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  assert.equal(history.status, 200);
  assert.equal(request.getStatus().consecutiveCloudflareBlocks, 1);
  await request(quotes);
  assert.equal(request.getStatus().retryAfterSeconds, 3600);
  assert.equal(quoteAttempts, 2);
});

test('default FYERS budget stays at or below six requests per minute with a ten-second minimum gap', async () => {
  let clock = 700_000;
  const sentAt = [];
  const request = createFyersDataApiBudget({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => { sentAt.push(clock); return fakeResponse(); }
  });

  for (let index = 0; index < 16; index += 1) {
    await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ&resolution=5&request=' + index);
  }

  assert.equal(sentAt.length, 16);
  for (let index = 1; index < sentAt.length; index += 1) {
    assert.ok(sentAt[index] - sentAt[index - 1] >= 10_000, 'requests must be at least ten seconds apart');
  }
  assert.ok(sentAt[6] - sentAt[0] >= 60_000, 'the seventh request must wait for the rolling-minute budget');
});


test('request timeout starts after queue wait, not while waiting for shared FYERS pacing', async () => {
  let markFirstStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let secondSignal;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      if (String(url).includes('first-request')) {
        markFirstStarted();
        await firstGate;
        return fakeResponse(200, '{"s":"ok"}');
      }
      secondSignal = init.signal;
      assert.ok(secondSignal instanceof AbortSignal, 'the network timeout signal is created at dispatch');
      assert.equal(secondSignal.aborted, false, 'queue waiting must not consume the network timeout');
      await new Promise(resolve => setTimeout(resolve, 5));
      return fakeResponse(200, '{"s":"ok"}');
    }
  });

  const first = request('https://api-t1.fyers.in/data/quotes?first-request=1');
  await firstStarted;
  const second = request('https://api-t1.fyers.in/data/quotes?second-request=1', { timeoutMs: 30 });
  setTimeout(releaseFirst, 60);
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.ok(secondSignal);
  assert.equal(secondSignal.aborted, false);
});
