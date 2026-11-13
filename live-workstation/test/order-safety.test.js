import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRiskReward } from '../order-safety.js';

test('BUY order requires at least 1:2 reward to risk', () => {
  assert.equal(validateRiskReward({ side:'BUY', premium:100, stopLoss:95, takeProfit:110 }).ok, true);
  assert.equal(validateRiskReward({ side:'BUY', premium:100, stopLoss:95, takeProfit:109.99 }).ok, false);
});

test('SELL order requires at least 1:2 reward to risk', () => {
  assert.equal(validateRiskReward({ side:'SELL', premium:100, stopLoss:105, takeProfit:90 }).ok, true);
  assert.equal(validateRiskReward({ side:'SELL', premium:100, stopLoss:105, takeProfit:90.01 }).ok, false);
});

test('invalid, inverted or zero-risk plans fail closed', () => {
  for (const input of [
    { side:'BUY', premium:100, stopLoss:100, takeProfit:120 },
    { side:'BUY', premium:100, stopLoss:101, takeProfit:120 },
    { side:'SELL', premium:100, stopLoss:99, takeProfit:80 },
    { side:'SELL', premium:100, stopLoss:105, takeProfit:100 },
    { side:'HOLD', premium:100, stopLoss:95, takeProfit:110 },
    { side:'BUY', premium:0, stopLoss:0, takeProfit:10 }
  ]) assert.equal(validateRiskReward(input).ok, false);
});
