import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listMxcOptionContracts,
  pickMxcOptionCandidates,
  evaluateMxcUnderlyingBreakout,
  evaluateMxcOptionBreakout
} from './mcx-options.js';

const now = Date.parse('2026-11-13T10:30:00Z');
const expiry = Math.floor(Date.parse('2026-11-25T12:00:00Z') / 1000);
const master = {
  'MCX:CRUDEOIL26NOV5400CE': { tradeStatus: 1, optType: 'CE', strikePrice: 5400, minLotSize: 100, tickSize: 0.05, expiryDate: expiry },
  'MCX:CRUDEOIL26NOV5400PE': { tradeStatus: 1, optType: 'PE', strikePrice: 5400, minLotSize: 100, tickSize: 0.05, expiryDate: expiry },
  'MCX:CRUDEOIL26DEC5400CE': { tradeStatus: 1, optType: 'CE', strikePrice: 5400, minLotSize: 100, tickSize: 0.05, expiryDate: expiry + 86400 * 30 },
  'MCX:CRUDEOIL26NOV5500CE': { tradeStatus: 0, optType: 'CE', strikePrice: 5500, minLotSize: 100, tickSize: 0.05, expiryDate: expiry },
  'MCX:NATURALGAS26NOV300CE': { tradeStatus: 1, optType: 'CE', strikePrice: 300, minLotSize: 1250, tickSize: 0.05, expiryDate: expiry },
  'MCX:CRUDEOIL26NOV5400XX': { tradeStatus: 1, optType: 'XX', strikePrice: 5400, minLotSize: 100, tickSize: 0.05, expiryDate: expiry }
};

function candles({ breakout = false } = {}) {
  const start = Math.floor(now / 300000) * 300 - 21 * 300;
  const rows = [];
  for (let i = 0; i < 21; i++) {
    const base = breakout && i === 20 ? 102 : 95;
    rows.push({ time: start + i * 300, open: base - 1, high: breakout && i === 20 ? 103 : 100, low: breakout && i === 20 ? 101 : 90, close: base, volume: 1 });
  }
  rows.push({ time: Math.floor(now / 300000) * 300, open: 102, high: 103, low: 101, close: 102, volume: 0 });
  return rows;
}

test('MCX Symbol Master filtering keeps only active CE/PE for selected root and nearest expiry', () => {
  const rows = listMxcOptionContracts(master, 'MCX:CRUDEOIL26NOVFUT', now);
  assert.deepEqual(rows.map(row => row.symbol), ['MCX:CRUDEOIL26NOV5400CE', 'MCX:CRUDEOIL26NOV5400PE']);
});

test('MCX option discovery rejects unsupported roots and malformed futures', () => {
  assert.deepEqual(listMxcOptionContracts(master, 'MCX:GOLD26NOVFUT', now), []);
  assert.deepEqual(listMxcOptionContracts(master, 'MCX:CRUDEOIL26NOV', now), []);
});

test('MCX candidate selection follows the verified underlying breakout direction and nearest strike', () => {
  const rows = listMxcOptionContracts(master, 'MCX:CRUDEOIL26NOVFUT', now);
  assert.equal(pickMxcOptionCandidates(rows, 5410, 'LONG')[0].side, 'CE');
  assert.equal(pickMxcOptionCandidates(rows, 5410, 'SHORT')[0].side, 'PE');
  assert.deepEqual(pickMxcOptionCandidates(rows, 5410, 'WAIT'), []);
});

test('underlying breakout requires a completed, contiguous 21-candle window', () => {
  const tick = { price: 103, exchangeTime: Math.floor(now / 1000) + 60 };
  assert.equal(evaluateMxcUnderlyingBreakout(candles({ breakout: true }), tick).status, 'SETUP_CONFIRMED');
  assert.equal(evaluateMxcUnderlyingBreakout(candles(), tick).status, 'NO_TRADE');
  assert.equal(evaluateMxcUnderlyingBreakout(candles({ breakout: true }).slice(0, 10), tick).status, 'DATA_UNAVAILABLE_NO_TRADE');
});

test('option breakout returns a tick-aligned minimum 1:2 plan only with fresh premium', () => {
  const tick = { price: 103, exchangeTime: Math.floor(now / 1000) + 60 };
  const contract = { symbol: 'MCX:CRUDEOIL26NOV5400CE', side: 'CE', strike: 5400, lotSize: 100, tickSize: 0.05, underlyingPrice: 5410 };
  const result = evaluateMxcOptionBreakout(candles({ breakout: true }), tick, contract);
  assert.equal(result.status, 'SETUP_CONFIRMED');
  assert.ok(result.rr >= 2);
  assert.ok(result.entry > result.stopLoss);
  assert.ok(result.target > result.entry);
  assert.equal(evaluateMxcOptionBreakout(candles(), tick, contract).status, 'NO_TRADE');
});


import { evaluateMxcTrendPullback } from './mcx-options.js';

test('trend-pullback test fails closed when 51 completed candles are unavailable', () => {
  const tick = { price: 103, exchangeTime: Math.floor(now / 1000) + 60 };
  assert.equal(evaluateMxcTrendPullback(candles({ breakout: true }), tick).status, 'DATA_UNAVAILABLE_NO_TRADE');
});

test('trend-pullback test requires fresh exchange tick and contiguous EMA window', () => {
  const tick = { price: 103, exchangeTime: Math.floor(now / 1000) + 60 };
  const longSeries = Array.from({ length: 60 }, (_, i) => ({
    time: Math.floor(now / 300000) * 300 - 60 * 300 + i * 300,
    open: 90 + i, high: 92 + i, low: 89 + i, close: 91 + i, volume: 1
  }));
  assert.equal(evaluateMxcTrendPullback(longSeries, { ...tick, exchangeTime: 1 }).status, 'DATA_UNAVAILABLE_NO_TRADE');
  longSeries[20].time += 300;
  assert.equal(evaluateMxcTrendPullback(longSeries, tick).status, 'DATA_UNAVAILABLE_NO_TRADE');
});
