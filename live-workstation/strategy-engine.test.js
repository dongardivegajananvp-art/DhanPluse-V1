import test from 'node:test';
import assert from 'node:assert/strict';
import { canAcceptStrategyTrade, evaluateNineStrategies, MAX_ACTIVE_TRADES, STRATEGIES } from './strategy-engine.js';

test('nine fixed strategy identifiers are present and stable',()=>{
  assert.equal(STRATEGIES.length,9);
  assert.equal(MAX_ACTIVE_TRADES,2);
});

test('trade gate permits two independent trades but blocks a third',()=>{
  const first={underlying:'NSE:RELIANCE-EQ',contract:'NSE:RELIANCE26NOV1500CE'};
  const second={underlying:'NSE:TCS-EQ',contract:'NSE:TCS26NOV3500PE'};
  assert.equal(canAcceptStrategyTrade([],first).ok,true);
  assert.equal(canAcceptStrategyTrade([first],second).ok,true);
  assert.equal(canAcceptStrategyTrade([first,second],{underlying:'NSE:INFY-EQ',contract:'NSE:INFY26NOV1600CE'}).ok,false);
});

test('trade gate rejects duplicate underlying and duplicate contract',()=>{
  const active=[{underlying:'NSE:RELIANCE-EQ',contract:'NSE:RELIANCE26NOV1500CE'}];
  assert.equal(canAcceptStrategyTrade(active,{underlying:'NSE:RELIANCE-EQ',contract:'NSE:RELIANCE26NOV1550CE'}).ok,false);
  assert.equal(canAcceptStrategyTrade(active,{underlying:'NSE:TCS-EQ',contract:'NSE:RELIANCE26NOV1500CE'}).ok,false);
});

test('strategy evaluator fails closed when either futures or option tick is stale',()=>{
  const now=Date.parse('2026-11-16T04:00:00Z');
  const tick={price:100,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles:[],underlyingTick:tick,optionCandles:[],optionTick:{...tick,receivedAt:now-11000},contract:{side:'CE',tickSize:0.05},now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/option premium tick/i);
});

test('strategy evaluator requires verified CE/PE contract metadata',()=>{
  const now=Date.parse('2026-11-16T04:00:00Z');
  const tick={price:100,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles:[],underlyingTick:tick,optionCandles:[],optionTick:tick,contract:null,now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/verified active CE\/PE/i);
});
