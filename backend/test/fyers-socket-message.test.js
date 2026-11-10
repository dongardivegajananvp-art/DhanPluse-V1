import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFyersSocketMessage, summarizeFyersSocketMessage } from '../src/fyers-socket-message.js';

const tick = {
  type: 'if',
  symbol: 'NSE:NIFTY50-INDEX',
  ltp: '25000',
  exch_feed_time: '1794300000'
};

test('decodes JSON string payloads without changing the data', () => {
  assert.deepEqual(decodeFyersSocketMessage(JSON.stringify(tick)), tick);
});

test('decodes Buffer payloads from the Node WebSocket transport', () => {
  const raw = Buffer.from(JSON.stringify(tick), 'utf8');
  assert.deepEqual(decodeFyersSocketMessage(raw), tick);
  assert.equal(summarizeFyersSocketMessage(raw, tick).rawType, 'Buffer');
});

test('decodes ArrayBuffer payloads', () => {
  const raw = Uint8Array.from(Buffer.from(JSON.stringify(tick), 'utf8')).buffer;
  assert.deepEqual(decodeFyersSocketMessage(raw), tick);
  assert.equal(summarizeFyersSocketMessage(raw, tick).rawType, 'ArrayBuffer');
});

test('decodes typed-array views with byte offsets', () => {
  const bytes = Buffer.from('x' + JSON.stringify(tick) + 'y', 'utf8');
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 1, bytes.byteLength - 2);
  assert.deepEqual(decodeFyersSocketMessage(view), tick);
});

test('keeps already-parsed object payloads unchanged', () => {
  assert.equal(decodeFyersSocketMessage(tick), tick);
});

test('rejects malformed or unsupported payloads safely', () => {
  assert.equal(decodeFyersSocketMessage(Buffer.from('{bad json')), null);
  assert.equal(decodeFyersSocketMessage(42), null);
});

test('diagnostics expose payload shape but never LTP values', () => {
  const summary = summarizeFyersSocketMessage(Buffer.from(JSON.stringify(tick)), tick);
  assert.equal(summary.frameCount, 1);
  assert.deepEqual(summary.frameTypes, ['if']);
  assert.deepEqual(summary.marketFrameShape, [{
    type: 'if',
    hasSymbol: true,
    hasLtp: true,
    hasExchangeTimestamp: true
  }]);
  assert.equal(JSON.stringify(summary).includes('25000'), false);
  assert.equal(JSON.stringify(summary).includes('NSE:NIFTY50-INDEX'), false);
});
