import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersDataApiBudget } from '../src/fyers-data-api-budget.js';

function response(status, body, headers = {}) {
  return new Response(body, { status, headers });
}

test('Cloudflare cooldown is exported for durable persistence and restored without an upstream probe', async () => {
  let clock = Date.parse('2026-11-12T08:00:00Z');
  let persisted = null;
  let sent = 0;
  const first = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    onCooldownChange: async state => { persisted = { ...state, blockedUntil: new Date(state.cooldownUntil).toISOString() }; },
    fetchImpl: async () => {
      sent += 1;
      return response(429, 'Cloudflare Error 1015', {
        server: 'cloudflare', 'cf-ray': 'test-ray', 'retry-after': '0'
      });
    }
  });
  await first('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  assert.equal(sent, 1);
  assert.equal(persisted.cooldownReason, 'CLOUDFLARE_1015');
  assert.equal(Date.parse(persisted.blockedUntil), clock + 3_600_000);

  const restored = createFyersDataApiBudget({
    now: () => clock,
    minIntervalMs: 0,
    fetchImpl: async () => { sent += 1; return response(200, '{"s":"ok"}'); }
  });
  assert.equal(restored.restoreStatus(persisted), true);
  const blocked = await restored('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  assert.equal(blocked.status, 429);
  assert.equal(sent, 1, 'restored cooldown must suppress the upstream request');
});

test('expired, malformed and overlong persisted cooldowns are rejected', () => {
  const request = createFyersDataApiBudget({ now: () => Date.parse('2026-11-12T08:00:00Z') });
  assert.equal(request.restoreStatus({ blockedUntil: '2026-11-12T07:59:00Z', cooldownPathname: '/data/quotes' }), false);
  assert.equal(request.restoreStatus({ blockedUntil: '2026-11-12T10:00:00Z', cooldownPathname: '/data/quotes' }), false);
  assert.equal(request.restoreStatus({ blockedUntil: '2026-11-12T08:30:00Z', cooldownPathname: '/unknown' }), false);
});


test('Data API fails closed after cooldown persistence fails', async () => {
  let sent = 0;
  const request = createFyersDataApiBudget({
    now: () => Date.parse('2026-11-12T08:00:00Z'),
    minIntervalMs: 0,
    onCooldownChange: async () => false,
    fetchImpl: async () => {
      sent += 1;
      return response(429, 'Cloudflare Error 1015', {
        server: 'cloudflare', 'cf-ray': 'persistence-failure-test', 'retry-after': '0'
      });
    }
  });
  const first = await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ');
  assert.equal(first.status, 429);
  const blocked = await request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3AINFOSYS-EQ');
  assert.equal(blocked.status, 503);
  assert.equal(sent, 1, 'no further upstream request after cooldown persistence failure');
  assert.equal(request.getStatus().cooldownPersistenceHealthy, false);
});

test('Data API waits for durable cooldown write before returning provider 429', async () => {
  let release;
  let writeFinished = false;
  const writeGate = new Promise(resolve => { release = resolve; });
  const request = createFyersDataApiBudget({
    now: () => Date.parse('2026-11-12T08:00:00Z'),
    minIntervalMs: 0,
    onCooldownChange: async () => { await writeGate; writeFinished = true; return true; },
    fetchImpl: async () => response(429, 'Cloudflare Error 1015', {
      server: 'cloudflare', 'cf-ray': 'durability-order-test', 'retry-after': '0'
    })
  });
  let settled = false;
  const pending = request('https://api-t1.fyers.in/data/quotes?symbols=NSE%3ATCS-EQ').then(r => { settled = true; return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'provider response must not return before durable save');
  release();
  const result = await pending;
  assert.equal(result.status, 429);
  assert.equal(writeFinished, true);
});
