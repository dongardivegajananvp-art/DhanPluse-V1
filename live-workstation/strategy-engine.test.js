import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixedPremiumPlan, canAcceptStrategyTrade, evaluateNineStrategies, MAX_ACTIVE_TRADES, STRATEGIES } from './strategy-engine.js';

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

test('fixed premium plan uses breakout plus one tick, ATR-buffered stop and exact 2R target',()=>{
  const plan=buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:99,atr:1});
  assert.equal(plan.status,'SETUP_CONFIRMED');
  assert.equal(plan.entry,100.05);
  assert.equal(plan.stopLoss,98.5);
  assert.equal(plan.target,103.15);
  assert.equal(plan.rr,2);
});

test('fixed premium plan blocks chase, live RR deterioration and resistance before target',()=>{
  const base={breakoutLevel:100,tickSize:0.05,swingLow:99,atr:1};
  assert.match(buildFixedPremiumPlan({...base,livePremium:100.85}).reason,/0.5R/);
  assert.match(buildFixedPremiumPlan({...base,livePremium:100.10}).reason,/1:2/);
  assert.match(buildFixedPremiumPlan({...base,livePremium:100.05,priorResistances:[102]}).reason,/resistance/);
});

test('strategy evaluator rejects a gap anywhere in the required 51-candle window',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=[];
  for(let i=0;i<52;i++){
    if(i===8)continue;
    const price=100+i;
    rows.push({time:bucket-(52-i)*300,open:price,high:price+1,low:price-1,close:price,volume:10});
  }
  rows.push({time:bucket,open:152,high:153,low:151,close:152,volume:0});
  const tick={price:151,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles:rows,underlyingTick:tick,optionCandles:[],optionTick:tick,contract:{side:'CE',tickSize:0.05},now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/missing 5-minute interval/);
});
