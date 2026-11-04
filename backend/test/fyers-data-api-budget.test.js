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

test('Cloudflare 1015 blocks all FYERS Data API paths, not just one endpoint', async () => {
  let clock = 200_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    minIntervalMs: 0,
    fetchImpl: async () => {
      sent += 1;
      return fakeResponse(429, 'Cloudflare Error 1015');
    }
  });

  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  await assert.rejects(
    request('https://api-t1.fyers.in/data/history?symbol=NSE%3ATCS-EQ'),
    error => error.statusCode === 429 && /Data API cooldown active/.test(error.message)
  );
  assert.equal(sent, 1, 'second endpoint must not reach upstream during the shared cooldown');
});

test('Cloudflare 1015 is detected when the code appears before Cloudflare', async () => {
  for (const body of ['Error 1015: You are being rate limited', '1015 - Cloudflare rate limit']) {
    let clock = 300_000;
    let sent = 0;
    const request = createFyersDataApiBudget({
      now: () => clock,
      sleep: async ms => { clock += ms; },
      minIntervalMs: 0,
      fetchImpl: async () => {
        sent += 1;
        return fakeResponse(429, body);
      }
    });

    await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX');
    await assert.rejects(
      request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ'),
      error => error.statusCode === 429 && /Data API cooldown active/.test(error.message)
    );
    assert.equal(sent, 1, '1015 response must activate the shared cooldown');
  }
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

test('verified history cache remains readable during a shared Cloudflare cooldown', async () => {
  let clock = 550_000;
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    historyCacheMs: 180_000,
    fetchImpl: async url => {
      sent += 1;
      if (String(url).includes('/data/quotes')) {
        return new Response('Cloudflare Error 1015', { status: 429 });
      }
      return new Response(JSON.stringify({ s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });

  const historyUrl = 'https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX&resolution=5';
  await request(historyUrl);
  await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');

  const cached = await request(historyUrl);
  assert.equal(sent, 2, 'a cache hit must not send another upstream request during cooldown');
  assert.equal(cached.headers.get('x-dhanpulse-cache'), 'HIT');
  assert.deepEqual(await cached.json(), { s: 'ok', candles: [[1, 10, 11, 9, 10, 100]] });

  clock += 180_001;
  await assert.rejects(
    request(historyUrl),
    error => error.statusCode === 429 && /Data API cooldown active/.test(error.message)
  );
  assert.equal(sent, 2, 'an expired cache must remain blocked rather than probing Cloudflare early');
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

test('cooldown status reports the real shared FYERS Data API backoff without exposing request data', async () => {
  let clock = 600_000;
  const request = createFyersDataApiBudget({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    minIntervalMs: 0,
    cloudflareCooldownMs: 120_000,
    fetchImpl: async () => fakeResponse(429, 'Cloudflare Error 1015')
  });

  const before = request.getStatus();
  assert.equal(before.cooldownActive, false);
  assert.equal(before.retryAfterSeconds, 0);
  await request('https://api-t1.fyers.in/data/history?symbol=NSE%3ANIFTY50-INDEX');
  const active = request.getStatus();
  assert.equal(active.cooldownActive, true);
  assert.equal(active.retryAfterSeconds, 120);
  assert.equal(active.blockedUntil, new Date(clock + 120_000).toISOString());
  clock += 30_000;
  assert.equal(request.getStatus().retryAfterSeconds, 90);
  clock += 90_000;
  assert.equal(request.getStatus().cooldownActive, false);
  assert.equal(request.getStatus().blockedUntil, null);
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

  for (let index = 0; index < 41; index += 1) {
    await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATEST' + index + '-EQ');
  }

  assert.equal(sentAt.length, 41);
  assert.ok(sentAt[1] - sentAt[0] >= 1250, 'requests must be spaced by at least 1.25 seconds');
  assert.ok(sentAt[39] - sentAt[0] < 60_000, '40 requests should fit within the conservative rolling-minute budget');
  assert.ok(sentAt[40] - sentAt[0] >= 60_000, 'the 41st request must wait for the rolling-minute window');
});
