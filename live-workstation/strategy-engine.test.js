import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixedPremiumPlan, canAcceptStrategyTrade, detectDoublePattern, detectNineStrategySetup, evaluateNineStrategies, MAX_ACTIVE_TRADES, STRATEGIES } from './strategy-engine.js';
import { buildFnoUniverse, selectSubscriptionBatch } from './fno-universe.js';

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

test('F&O universe keeps only active unexpired futures and nearest expiry per underlying',()=>{
  const now=Date.parse('2026-11-14T00:00:00Z');
  const nseMaster={
    'NSE:RELIANCE26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'},
    'NSE:RELIANCE31DECFUT':{tradeStatus:1,expiryDate:'2026-12-31'},
    'NSE:TCS26NOVFUT':{tradeStatus:0,expiryDate:'2026-11-26'},
    'NSE:INFY29OCTFUT':{tradeStatus:1,expiryDate:'2026-10-29'},
    'NSE:NIFTY26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'},
    'NSE:BANKNIFTY26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'}
  };
  const rows=buildFnoUniverse({nseMaster,now});
  assert.deepEqual(rows.map(x=>x.futureSymbol),['NSE:BANKNIFTY26NOVFUT','NSE:NIFTY26NOVFUT','NSE:RELIANCE26NOVFUT']);
  assert.equal(rows.find(x=>x.futureSymbol.includes('NIFTY26')).underlyingSymbol,'NSE:NIFTY50-INDEX');
  assert.equal(rows.find(x=>x.futureSymbol.includes('BANKNIFTY')).underlyingSymbol,'NSE:NIFTYBANK-INDEX');
});

test('F&O universe includes the BSE SENSEX future and maps it to the index',()=>{
  const now=Date.parse('2026-11-14T00:00:00Z');
  const rows=buildFnoUniverse({bseMaster:{'BSE:SENSEX26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'}},now});
  assert.equal(rows.length,1);
  assert.equal(rows[0].underlyingSymbol,'BSE:SENSEX-INDEX');
});

test('subscription batch reserves base and pinned symbols before rotating universe',()=>{
  const result=selectSubscriptionBatch({
    baseSymbols:['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'],
    pinnedSymbols:['NSE:RELIANCE26NOVFUT','NSE:RELIANCE26NOVFUT','NSE:RELIANCE26NOV1500CE'],
    universeSymbols:['NSE:RELIANCE26NOVFUT','NSE:TCS26NOVFUT','NSE:INFY26NOVFUT'],
    limit:5
  });
  assert.deepEqual(result.symbols,['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX','NSE:RELIANCE26NOVFUT','NSE:RELIANCE26NOV1500CE']);
  assert.equal(result.rotatingCount,0);
});

test('subscription rotation stays within 100 symbols and advances across the universe',()=>{
  const universe=Array.from({length:230},(_,i)=>'NSE:STOCK'+i+'26NOVFUT');
  const first=selectSubscriptionBatch({baseSymbols:['NSE:NIFTY50-INDEX'],universeSymbols:universe,limit:100});
  const second=selectSubscriptionBatch({baseSymbols:['NSE:NIFTY50-INDEX'],universeSymbols:universe,cursor:first.nextCursor,limit:100});
  const third=selectSubscriptionBatch({baseSymbols:['NSE:NIFTY50-INDEX'],universeSymbols:universe,cursor:second.nextCursor,limit:100});
  assert.equal(first.symbols.length,100);
  assert.equal(second.symbols.length,100);
  assert.equal(third.symbols.length,32);
  assert.equal(new Set([...first.symbols,...second.symbols,...third.symbols]).size,231);
});

test('subscription planner rejects more pinned symbols than the safe plan limit',()=>{
  assert.throws(()=>selectSubscriptionBatch({baseSymbols:['A','B'],pinnedSymbols:['C'],limit:2}),/exceed/);
});

test('underlying strategy detection is independently callable before option contract discovery',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:52},(_,i)=>{
    const close=100+i;
    return{time:bucket-(52-i)*300,open:close-0.2,high:close+0.5,low:close-0.5,close,volume:100};
  });
  rows[51]={time:bucket-300,open:151.5,high:152,low:151,close:151.5,volume:100};
  rows.push({time:bucket,open:152.5,high:154,low:152,close:153.5,volume:120});
  const tick={price:153.5,exchangeTime:now/1000,receivedAt:now};
  const result=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,now});
  assert.equal(result.status,'UNDERLYING_SETUP_CONFIRMED');
  assert.equal(result.strategy,'EMA20_EMA50_TREND');
  assert.equal(result.side,'LONG');
  assert.equal(result.breakoutLevel,150.5);
});
