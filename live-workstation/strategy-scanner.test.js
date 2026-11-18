import test from 'node:test';
import assert from 'node:assert/strict';
import { completedDailyCandles, dailyHistorySymbolForFnoRow, selectNearestOptionContract, selectNearestOptionContracts, strategyCandidateKey } from './strategy-scanner.js';

test('selects nearest expiry first, then nearest strike, without OI or volume fields', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const contracts = [
    {symbol:'NSE:ABC26DEC100CE',side:'CE',strike:100,expiry:'2026-12-31',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26NOV110CE',side:'CE',strike:110,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26NOV100CE',side:'CE',strike:100,expiry:'2026-11-26',tickSize:0.05,lotSize:10,oi:999999}
  ];
  assert.equal(selectNearestOptionContract(contracts,'CE',101,now).symbol,'NSE:ABC26NOV100CE');
});

test('rejects wrong side, expired and malformed contracts', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const contracts = [
    {symbol:'wrong',side:'PE',strike:100,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'expired',side:'CE',strike:100,expiry:'2026-10-26',tickSize:0.05,lotSize:10},
    {symbol:'bad',side:'CE',strike:100,expiry:'2026-11-26',tickSize:0,lotSize:10}
  ];
  assert.equal(selectNearestOptionContract(contracts,'CE',100,now),null);
});

test('daily filter excludes current partial session and requires fresh 50 completed candles', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const todayStart = Math.floor(now / 86400000) * 86400;
  const candles = Array.from({length:50},(_,i)=>({
    time: todayStart - (50-i)*86400,
    open:100+i,high:102+i,low:99+i,close:101+i
  }));
  candles.push({time:todayStart+33300,open:200,high:202,low:199,close:201});
  const result = completedDailyCandles(candles,now);
  assert.equal(result.ok,true);
  assert.equal(result.candles.length,50);
});

test('daily filter rejects stale and insufficient data', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  assert.equal(completedDailyCandles([],now).ok,false);
  const old = Array.from({length:50},(_,i)=>({time:now/1000-(60-i)*86400,open:100,high:102,low:99,close:101}));
  assert.match(completedDailyCandles(old,now).reason,/stale/i);
});

test('candidate identity is stable and independent of ranking', () => {
  assert.equal(strategyCandidateKey('NSE:ABC-EQ','NSE:ABC26NOV100CE'),'NSE:ABC-EQ|NSE:ABC26NOV100CE');
});

test('prewarms two nearest strikes per side from the nearest active expiry only', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const contracts = [
    {symbol:'NSE:ABC26NOV100CE',side:'CE',strike:100,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26NOV110CE',side:'CE',strike:110,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26NOV120CE',side:'CE',strike:120,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26NOV100PE',side:'PE',strike:100,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26NOV110PE',side:'PE',strike:110,expiry:'2026-11-26',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26DEC101CE',side:'CE',strike:101,expiry:'2026-12-31',tickSize:0.05,lotSize:10},
    {symbol:'NSE:ABC26OCT100CE',side:'CE',strike:100,expiry:'2026-10-26',tickSize:0.05,lotSize:10}
  ];
  assert.deepEqual(selectNearestOptionContracts(contracts,'CE',108,2,now).map(x=>x.symbol),['NSE:ABC26NOV110CE','NSE:ABC26NOV100CE']);
  assert.deepEqual(selectNearestOptionContracts(contracts,'PE',108,2,now).map(x=>x.symbol),['NSE:ABC26NOV110PE','NSE:ABC26NOV100PE']);
  assert.equal(selectNearestOptionContracts(contracts,'CE',108,5,now).length,0);
});


test('selects an option contract with compact YYYYMMDD expiry from FYERS Symbol Master', () => {
  const now = Date.parse('2026-11-18T04:00:00Z');
  const contracts = [{symbol:'NSE:ABC26NOV100CE',side:'CE',strike:100,expiry:'20261126',tickSize:0.05,lotSize:10}];
  assert.equal(selectNearestOptionContract(contracts,'CE',100,now).symbol,'NSE:ABC26NOV100CE');
});


test('uses the verified cash or index underlying for 50-day trend research, not the expiring futures contract', () => {
  assert.equal(dailyHistorySymbolForFnoRow({futureSymbol:'NSE:NAVINFLUOR26NOVFUT',underlyingSymbol:'NSE:NAVINFLUOR-EQ'}),'NSE:NAVINFLUOR-EQ');
  assert.equal(dailyHistorySymbolForFnoRow({futureSymbol:'NSE:NIFTY26NOVFUT',underlyingSymbol:'NSE:NIFTY50-INDEX'}),'NSE:NIFTY50-INDEX');
  assert.equal(dailyHistorySymbolForFnoRow({futureSymbol:'NSE:ABC26NOVFUT',underlyingSymbol:'invalid'}),'NSE:ABC26NOVFUT');
});
