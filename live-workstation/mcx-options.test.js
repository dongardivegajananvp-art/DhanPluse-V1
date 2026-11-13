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

function trendCandles() {
  const start = Math.floor(now / 300000) * 300 - 60 * 300;
  const rows = Array.from({ length: 60 }, (_, i) => ({
    time: start + i * 300,
    open: 100 + i * 0.5,
    high: 101 + i * 0.5,
    low: 99 + i * 0.5,
    close: 100 + i * 0.5,
    volume: 1
  }));
  rows[58] = { time: start + 58 * 300, open: 127, high: 129, low: 122, close: 124, volume: 1 };
  rows[59] = { time: start + 59 * 300, open: 124.5, high: 130, low: 124, close: 129.5, volume: 1 };
  return rows;
}

test('EMA20/EMA50 pullback fails closed without 51 completed fresh candles', () => {
  const tick = { price: 129.6, exchangeTime: Math.floor(now / 1000) + 60 };
  assert.equal(evaluateMxcTrendPullback(trendCandles().slice(-40), tick).status, 'DATA_UNAVAILABLE_NO_TRADE');
  assert.equal(evaluateMxcTrendPullback(trendCandles(), { ...tick, exchangeTime: 1 }).status, 'DATA_UNAVAILABLE_NO_TRADE');
});

test('EMA20/EMA50 pullback confirms only a bullish completed-candle reclaim and tick-aligned 1:2 option plan', () => {
  const tick = { price: 129.6, exchangeTime: Math.floor(now / 1000) + 60 };
  const contract = { tickSize: 0.05 };
  const result = evaluateMxcTrendPullback(trendCandles(), tick, contract);
  assert.equal(result.status, 'SETUP_CONFIRMED');
  assert.equal(result.strategy, 'B_EMA20_EMA50_TREND_PULLBACK');
  assert.equal(result.side, 'LONG');
  assert.ok(result.entry > result.stopLoss);
  assert.ok(result.target > result.entry);
  assert.ok(result.rr >= 2);
  assert.equal(Math.round(result.stopLoss / 0.05), result.stopLoss / 0.05);
  assert.equal(Math.round(result.target / 0.05), result.target / 0.05);
});

test('EMA20/EMA50 option premium BUY setup rejects bearish premium reclaim and missing tick metadata', () => {
  const tick = { price: 129.6, exchangeTime: Math.floor(now / 1000) + 60 };
  assert.equal(evaluateMxcTrendPullback(trendCandles(), tick, { tickSize: 0 }).status, 'DATA_UNAVAILABLE_NO_TRADE');
});
