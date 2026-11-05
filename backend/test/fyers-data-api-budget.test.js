import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersDataApiBudget } from '../src/fyers-data-api-budget.js';

function fakeResponse(status = 200, body = '', retryAfter = null) {
  return {
    status,
    headers: {
      get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null,
      entries: () => []
    },
    statusText: status === 200 ? 'OK' : 'Too Many Requests',
    clone: () => ({ text: async () => body })
  };
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
    fetchImpl: async () => {
      sentAt.push(clock);
      return fakeResponse();
    }
  });

  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  await request('https://api-t1.fyers.in/data/options-chain-v3?symbol=NSE%3ANIFTY50-INDEX');

  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[2] - sentAt[0] >= 60_000, 'third request must wait for the first request to leave the rolling window');
});

test('Cloudflare 1015 is reported but does not activate an application cooldown', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => { sent += 1; return fakeResponse(429, 'Cloudflare Error 1015'); }
  });
  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ');
  assert.equal(sent, 2, 'a provider 1015 must not suppress the next app request');
  assert.equal(request.getStatus().cooldownActive, false);
  assert.equal(request.getStatus().retryAfterSeconds, 0);
});
test('HTTP 429 Retry-After is not turned into a local application cooldown', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => { sent += 1; return fakeResponse(429, 'rate limited', '3600'); }
  });
  await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX');
  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  assert.equal(sent, 2);
  assert.equal(request.getStatus().cooldownActive, false);
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
      return new Response(JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });

  const url = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX&resolution=5';
  const [first, second] = await Promise.all([request(url), request(url)]);
  assert.equal(sent, 1, 'concurrent identical reads should share one upstream request');
  assert.deepEqual(await first.json(), await second.json());

  const cached = await request(url);
  assert.equal(sent, 1, 'successful history response should be reused within its short TTL');
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  clock += 10_001;
  await request(url);
  assert.equal(sent, 2, 'expired history cache must refresh from FYERS');
});

test('default history cache reuses OHLC for five minutes, then requires a fresh FYERS read', async () => {
  let clock = 540_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });
  const url = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX&resolution=5';
  await request(url);
  clock += 4 * 60_000;
  const cached = await request(url);
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  assert.equal(sent, 1, 'history should be reused inside the five-minute cache window');
  clock += 60_001;
  await request(url);
  assert.equal(sent, 2, 'expired history must refresh from FYERS');
});

test('verified history cache remains readable and expired history is allowed to refresh after 1015', async () => {
  let clock = 550_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    historyCacheMs: 180_000,
    fetchImpl: async url => {
      sent += 1;
      if (String(url).includes('/data/quotes')) return new Response('Cloudflare Error 1015', { status: 429 });
      if (sent > 2) return new Response('Cloudflare Error 1015', { status: 429 });
      return new Response(JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });
  const historyUrl = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX&resolution=5';
  await request(historyUrl);
  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  const cached = await request(historyUrl);
  assert.equal(sent, 2);
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  clock += 180_001;
  const refreshed = await request(historyUrl);
  assert.equal(refreshed.status, 429, 'expired history must reach FYERS instead of a local cooldown gate');
  assert.equal(sent, 3);
});
test('option quote requests are never cached', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ s: 'ok', d: [] }), { status: 200 });
    }
  });
  const url = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ANIFTY26NOV25000CE';
  await request(url);
  await request(url);
  assert.equal(sent, 2, 'option premium quotes must always be fetched live');
});



test('identical concurrent quote reads share one upstream request but are not cached', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ s: 'ok', d: [{ n: 'NSE:TEST-EQ', v: { lp: 123.45, tt: 1 } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });
  const url = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATEST-EQ';
  const [first, second] = await Promise.all([request(url), request(url)]);
  assert.equal(sent, 1, 'concurrent identical quote reads should share one live response');
  assert.deepEqual(await first.json(), await second.json());

  await request(url);
  assert.equal(sent, 2, 'a later quote read must reach FYERS again; quote/premium data is never cached');
});

test('FYERS 429 status never reports an application-side cooldown', async () => {
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => fakeResponse(429, 'Cloudflare Error 1015')
  });
  await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX');
  assert.deepEqual(request.getStatus(), {
    cooldownActive: false, retryAfterSeconds: 0, blockedUntil: null,
    cooldownReason: null, consecutiveCloudflareBlocks: 1, queuedRequests: 0
  });
});
test('default FYERS pacing stays below the documented Standard plan limits', async () => {
  let clock = 700_000;
  const sentAt = [];
  const request = createFyersDataApiBudget({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => {
      sentAt.push(clock);
      return fakeResponse();
    }
  });

  for (let index = 0; index < 31; index += 1) {
    await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATEST' + index + '-EQ');
  }

  assert.equal(sentAt.length, 31);
  assert.ok(sentAt[1] - sentAt[0] >= 2000, 'requests must be spaced by at least 2 seconds');
  assert.ok(sentAt[29] - sentAt[0] < 60_000, '30 requests should fit within the conservative rolling-minute budget');
  assert.ok(sentAt[30] - sentAt[0] >= 60_000, 'the 31st request must wait for the rolling window');
});

test('repeated Cloudflare 1015 responses are diagnostic only and do not escalate a cooldown', async () => {
  const outcomes = [
    new Response('Cloudflare Error 1015', { status: 429 }),
    new Response('', { status: 429, headers: { server: 'cloudflare', 'cf-ray': 'abc123' } }),
    new Response(JSON.stringify({ s: 'ok' }), { status: 200 }),
    new Response('Cloudflare Error 1015', { status: 429 })
  ];
  const request = createFyersDataApiBudget({
    minIntervalMs: 0,
    fetchImpl: async () => outcomes.shift()
  });
  const url = 'https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATEST-EQ';
  await request(url);
  await request(url);
  assert.equal(request.getStatus().cooldownActive, false);
  assert.equal(request.getStatus().consecutiveCloudflareBlocks, 2);
  await request(url);
  assert.equal(request.getStatus().consecutiveCloudflareBlocks, 0);
  await request(url);
  assert.equal(request.getStatus().cooldownActive, false);
});
