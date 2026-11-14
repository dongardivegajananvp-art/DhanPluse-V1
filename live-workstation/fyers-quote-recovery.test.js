import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFyersQuoteTicks } from './fyers-quote-recovery.js';

const now = Date.parse('2026-11-16T04:00:00Z');
const row = (symbol, secondsAgo = 2) => ({
  n: symbol, s: 'ok',
  v: { symbol, lp: 123.45, tt: String(now / 1000 - secondsAgo), prev_close_price: 120 }
});

test('accepts only requested FYERS quote rows with fresh exchange timestamps', () => {
  const rows = parseFyersQuoteTicks({ s: 'ok', d: [row('NSE:A'), row('NSE:B', 20), row('NSE:UNREQUESTED')] }, ['NSE:A', 'NSE:B'], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'NSE:A');
  assert.equal(rows[0].price, 123.45);
  assert.equal(rows[0].source, 'FYERS_QUOTES_REST');
});

test('rejects missing, invalid, stale and future quote timestamps', () => {
  const missing = { n: 'NSE:A', s: 'ok', v: { lp: 123 } };
  const invalid = { ...row('NSE:B'), v: { ...row('NSE:B').v, lp: 0 } };
  const future = { ...row('NSE:C'), v: { ...row('NSE:C').v, tt: String(now / 1000 + 8) } };
  const stale = row('NSE:D', 30);
  assert.deepEqual(parseFyersQuoteTicks({ d: [missing, invalid, future, stale] }, ['NSE:A','NSE:B','NSE:C','NSE:D'], now), []);
});

test('rejects non-ok rows and malformed response envelopes', () => {
  assert.deepEqual(parseFyersQuoteTicks({ d: [{ ...row('NSE:A'), s: 'error' }] }, ['NSE:A'], now), []);
  assert.deepEqual(parseFyersQuoteTicks({ s: 'error', d: [row('NSE:A')] }, ['NSE:A'], now), []);
  assert.deepEqual(parseFyersQuoteTicks({ s: 'ok', d: [{ ...row('NSE:A'), v: { ...row('NSE:A').v, symbol: 'NSE:OTHER' } }] }, ['NSE:A'], now), []);
});
