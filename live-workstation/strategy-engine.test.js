import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixedPremiumPlan, canAcceptStrategyTrade, detectDoublePattern, evaluateNineStrategies, MAX_ACTIVE_TRADES, STRATEGIES } from './strategy-engine.js';

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

function doublePatternFixture(kind) {
  const rows=Array.from({length:40},(_,i)=>({time:1794801600+i*300,open:100,high:101,low:99,close:100,volume:10}));
  if(kind==='top'){
    for(const i of [8,18])rows[i]={...rows[i],open:105,high:110,low:104,close:105};
    rows[13]={...rows[13],open:100,high:102,low:95,close:100};
    rows[24]={...rows[24],open:96,high:97,low:93,close:94};
    for(const i of [37,38,39])rows[i]={...rows[i],open:94.5,high:i===39?95.2:95,low:93.5,close:94.5};
  }else{
    for(const i of [8,18])rows[i]={...rows[i],open:95,high:96,low:90,close:95};
    rows[13]={...rows[13],open:100,high:105,low:98,close:100};
    rows[24]={...rows[24],open:104,high:107,low:103,close:106};
    for(const i of [37,38,39])rows[i]={...rows[i],open:105.5,high:106,low:i===39?104.8:105,close:105.5};
  }
  return rows;
}

test('double-top SHORT requires an actual underside neckline retest and rejection',()=>{
  const result=detectDoublePattern(doublePatternFixture('top'));
  assert.equal(result?.pattern,'DOUBLE_TOP');
  assert.equal(result?.side,'SHORT');
  assert.equal(result?.breakoutLevel,95);
});

test('double-bottom LONG requires an actual topside neckline retest and hold',()=>{
  const result=detectDoublePattern(doublePatternFixture('bottom'));
  assert.equal(result?.pattern,'DOUBLE_BOTTOM');
  assert.equal(result?.side,'LONG');
  assert.equal(result?.breakoutLevel,105);
});

test('strategy evaluator rejects null candle fields as malformed rather than numeric zero',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:52},(_,i)=>({time:bucket-(52-i)*300,open:100,high:101,low:99,close:100,volume:10}));
  rows[12]={...rows[12],time:null};
  const tick={price:100,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles:rows,underlyingTick:tick,optionCandles:[],optionTick:tick,contract:{side:'CE',tickSize:0.05},now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/missing or malformed/i);
});
