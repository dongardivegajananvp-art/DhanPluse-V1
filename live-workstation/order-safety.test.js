import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFyersMarginPreflight, classifyFyersOrder } from './order-safety.js';

test('FYERS margin preflight accepts the documented nested response shape', () => {
  const result = parseFyersMarginPreflight({
    s: 'ok',
    data: { margin_avail: 294393.5226, margin_total: 138675.84, margin_new_order: 138675.84, prevMargin: 0 }
  });
  assert.deepEqual(result, { ok: true, required: 138675.84, available: 294393.5226 });
});

test('FYERS margin preflight fails closed for missing, malformed and insufficient values', () => {
  assert.equal(parseFyersMarginPreflight({ s: 'ok', data: {} }).ok, false);
  assert.equal(parseFyersMarginPreflight({ s: 'error', data: { margin_avail: 100, margin_new_order: 10 } }).ok, false);
  const insufficient = parseFyersMarginPreflight({ s: 'ok', data: { margin_avail: 99, margin_new_order: 100 } });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.reason, 'Insufficient FYERS available margin');
});

test('FYERS orderbook status maps filled, rejected, pending, cancelled and expired orders', () => {
  assert.equal(classifyFyersOrder({ status: 2, filledQty: 100, remainingQuantity: 0 }).status, 'FILLED');
  assert.equal(classifyFyersOrder({ status: 5, filledQty: 0, remainingQuantity: 100 }).status, 'REJECTED');
  assert.equal(classifyFyersOrder({ status: 6, filledQty: 0, remainingQuantity: 100 }).status, 'PENDING');
  assert.equal(classifyFyersOrder({ status: 1, filledQty: 0, remainingQuantity: 100 }).status, 'CANCELLED');
  assert.equal(classifyFyersOrder({ status: 7, filledQty: 0, remainingQuantity: 100 }).status, 'EXPIRED');
});

test('FYERS partial fills are never reported as complete execution', () => {
  const result = classifyFyersOrder({ status: 6, filledQty: 40, remainingQuantity: 60 });
  assert.deepEqual(result, { status: 'PARTIAL_FILL', filledQty: 40, remainingQty: 60 });
  assert.equal(classifyFyersOrder({ status: 4, filledQty: 0, remainingQuantity: 100 }).status, 'TRANSIT');
  assert.equal(classifyFyersOrder({ status: 99, filledQty: 0, remainingQuantity: 100 }).status, 'ACK_UNVERIFIED');
});
