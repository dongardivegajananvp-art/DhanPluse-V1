import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersDataApiBudget } from '../src/fyers-data-api-budget.js';

function fakeResponse(status = 200, body = '', retryAfter = null) {
  return {
    status,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
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

test('non-Data API endpoints are not counted against the Data API budget', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    fetchImpl: async () => { sent += 1; return fakeResponse(); }
  });

  await request('https://api-t1.fyers.in/api/v3/holdings');
  assert.equal(sent, 1);
});
