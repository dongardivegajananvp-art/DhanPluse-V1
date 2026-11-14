import test from 'node:test';
import assert from 'node:assert/strict';
import { sameStrategyConfirmation, validateOptionCandles, validateOptionContractIdentity, validateOptionPremiumTick } from './strategy-candidate-guard.js';

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


test('expiry date-only values remain valid through the official expiry session close', () => {
  const expiryContract = { ...contract, expiry: '2026-11-26' };
  const expiryMaster = { ...master, expiryDate: '2026-11-26' };
  assert.equal(validateOptionContractIdentity(expiryContract, expiryMaster, Date.parse('2026-11-26T09:59:00Z')).ok, true);
  assert.equal(validateOptionContractIdentity(expiryContract, expiryMaster, Date.parse('2026-11-26T10:01:00Z')).ok, false);
  assert.equal(validateOptionContractIdentity({ ...expiryContract, expiry: '20261126' }, { ...expiryMaster, expiryDate: '20261126' }, Date.parse('2026-11-26T09:59:00Z')).ok, true);\n  const numericMidnight = Date.UTC(2026, 10, 26) / 1000;
  assert.equal(validateOptionContractIdentity({ ...expiryContract, expiry: numericMidnight }, { ...expiryMaster, expiryDate: numericMidnight }, Date.parse('2026-11-26T09:59:00Z')).ok, true);
});

test('option premium tick requires fresh exchange and receive timestamps plus official tick alignment', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const fresh = { symbol: contract.symbol, price: 123.45, exchangeTime: now / 1000 - 2, receivedAt: now };
  assert.equal(validateOptionPremiumTick(fresh, contract, now).ok, true);
  assert.equal(validateOptionPremiumTick({ ...fresh, price: 123.46 }, contract, now).ok, false);
  assert.equal(validateOptionPremiumTick({ ...fresh, exchangeTime: now / 1000 - 20 }, contract, now).ok, false);
  assert.equal(validateOptionPremiumTick({ ...fresh, receivedAt: now - 12000 }, contract, now).ok, false);
  assert.equal(validateOptionPremiumTick({ ...fresh, symbol: 'NSE:OTHER26NOV2500CE' }, contract, now).ok, false);
});

test('option candles require 51 completed contiguous, valid and tick-aligned FYERS bars', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const exchangeTime = now / 1000;
  const currentBucket = Math.floor(exchangeTime / 300) * 300;
  const candles = Array.from({ length: 51 }, (_, i) => ({
    time: currentBucket - (51 - i) * 300,
    open: 100, high: 100.20, low: 99.95, close: 100.10, volume: 1000
  }));
  const tick = { price: 100.10, exchangeTime, receivedAt: now };
  assert.equal(validateOptionCandles(candles, tick, contract, now).ok, true);
  assert.equal(validateOptionCandles(candles.slice(0, 50), tick, contract, now).ok, false);
  const gap = candles.map(c => ({ ...c }));
  gap[20].time += 300;
  assert.equal(validateOptionCandles(gap, tick, contract, now).ok, false);
  const offTick = candles.map(c => ({ ...c }));
  offTick[10].close = 100.11;
  assert.equal(validateOptionCandles(offTick, tick, contract, now).ok, false);
  const unfinished = [...candles, { time: currentBucket, open: 100, high: 100.2, low: 99.95, close: 100.1 }];
  const withForming = validateOptionCandles(unfinished, tick, contract, now);
  assert.equal(withForming.ok, true);
  assert.equal(withForming.completedCandles.length, 51);
});

test('option candle verifier rejects stale and malformed OHLC payloads', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const exchangeTime = now / 1000;
  const currentBucket = Math.floor(exchangeTime / 300) * 300;
  const candles = Array.from({ length: 51 }, (_, i) => ({
    time: currentBucket - (51 - i) * 300,
    open: 100, high: 100.20, low: 99.95, close: 100.10
  }));
  assert.equal(validateOptionCandles(candles, { exchangeTime: exchangeTime + 1200 }, contract, now).ok, false);
  const malformed = candles.map(c => ({ ...c }));
  malformed[5].low = 100.15;
  assert.equal(validateOptionCandles(malformed, { exchangeTime }, contract, now).ok, false);
});


test('option verifier allows prior-session gaps but requires the latest 51 bars to be contiguous', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const exchangeTime = now / 1000;
  const currentBucket = Math.floor(exchangeTime / 300) * 300;
  const priorSession = Array.from({ length: 8 }, (_, i) => ({
    time: currentBucket - 86400 - (8 - i) * 300,
    open: 100, high: 100.20, low: 99.95, close: 100.10
  }));
  const currentSession = Array.from({ length: 51 }, (_, i) => ({
    time: currentBucket - (51 - i) * 300,
    open: 100, high: 100.20, low: 99.95, close: 100.10
  }));
  assert.equal(validateOptionCandles([...priorSession, ...currentSession], { exchangeTime }, contract, now).ok, true);
  assert.equal(validateOptionCandles(currentSession, { exchangeTime: exchangeTime + 1200 }, contract, now).ok, false);
});
