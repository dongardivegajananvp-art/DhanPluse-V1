import test from 'node:test';
import assert from 'node:assert/strict';
import { sameStrategyConfirmation, validateOptionContractIdentity } from './strategy-candidate-guard.js';

const now = Date.parse('2026-11-16T04:00:00Z');
const contract = { symbol: 'NSE:RELIANCE26NOV2500CE', side: 'CE', strike: 2500, tickSize: 0.05, lotSize: 250, expiry: '2026-11-26' };
const master = { ...contract, expiryDate: '2026-11-26' };

test('requires option contract fields and expiry to match current official master', () => {
  assert.equal(validateOptionContractIdentity(contract, master, now).ok, true);
  assert.equal(validateOptionContractIdentity(contract, { ...master, strike: 2550 }, now).ok, false);
  assert.equal(validateOptionContractIdentity(contract, { ...master, expiryDate: '2026-10-29' }, now).ok, false);
});

test('rejects an expired option contract', () => {
  assert.equal(validateOptionContractIdentity(contract, { ...master, expiryDate: '2026-11-13' }, now).ok, false);
});

test('pending candidate must still be the same completed-candle strategy confirmation', () => {
  const setup = { strategy: 'EMA20_EMA50_TREND', side: 'LONG', confirmedAt: 1000, breakoutLevel: 2500 };
  assert.equal(sameStrategyConfirmation(setup, { ...setup }), true);
  assert.equal(sameStrategyConfirmation(setup, { ...setup, confirmedAt: 1300 }), false);
  assert.equal(sameStrategyConfirmation(setup, { ...setup, strategy: 'FLAG_BREAKOUT_VOLUME' }), false);
});
