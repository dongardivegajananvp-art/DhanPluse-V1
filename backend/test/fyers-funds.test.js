import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFyersFunds } from '../src/fyers-funds.js';

test('maps FYERS funds by title rather than relying on array position', () => {
  const result = normalizeFyersFunds({ fund_limit: [
    { id: 10, title: 'Available Balance', equityAmount: 12500.5, commodityAmount: 0 },
    { id: 4, title: 'Realized Profit and Loss', equityAmount: -125, commodityAmount: 0 },
    { id: 2, title: 'Utilized Amount', equityAmount: 2500, commodityAmount: 0 },
    { id: 1, title: 'Total Balance', equityAmount: 15000.5, commodityAmount: 0 }
  ] });
  assert.deepEqual(result.availableBalance, { equity: 12500.5, commodity: 0 });
  assert.deepEqual(result.utilizedAmount, { equity: 2500, commodity: 0 });
  assert.deepEqual(result.realizedProfitLoss, { equity: -125, commodity: 0 });
  assert.deepEqual(result.totalBalance, { equity: 15000.5, commodity: 0 });
});

test('keeps missing or invalid FYERS fund fields unavailable instead of showing zero', () => {
  const result = normalizeFyersFunds({ fund_limit: [
    { title: 'Available Balance', equityAmount: 'not-a-number' }
  ] });
  assert.deepEqual(result.availableBalance, { equity: null, commodity: null });
  assert.deepEqual(result.utilizedAmount, { equity: null, commodity: null });
  assert.deepEqual(result.realizedProfitLoss, { equity: null, commodity: null });
});
