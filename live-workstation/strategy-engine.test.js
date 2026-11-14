import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixedPremiumPlan, canAcceptStrategyTrade, detectContinuation, detectDailyTrendPullback, detectDayHighLowRetest, detectDoublePattern, detectEmaTrend, detectFlagVolume, detectNineStrategySetup, detectOpeningRange, detectTopGainerMomentum, evaluateNineStrategies, MAX_ACTIVE_TRADES, STRATEGIES } from './strategy-engine.js';
import { buildFnoUniverse, selectSubscriptionBatch } from './fno-universe.js';

function risingUnderlyingFixture(now){
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:52},(_,i)=>{const close=100+i;return{time:bucket-(52-i)*300,open:close-0.2,high:close+0.5,low:close-0.5,close,volume:100};});
  rows[51]={time:bucket-300,open:151.5,high:152,low:151,close:151.5,volume:100};
  rows.push({time:bucket,open:152.5,high:154,low:152,close:153.5,volume:120});
  return{rows,tick:{price:153.5,exchangeTime:now/1000,receivedAt:now}};
}

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
  const {rows,tick}=risingUnderlyingFixture(now);
  const result=evaluateNineStrategies({underlyingCandles:rows,underlyingTick:tick,optionCandles:[],optionTick:{...tick,receivedAt:now-11000},contract:{side:'CE',tickSize:0.05},now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/option premium tick/i);
});

test('strategy evaluator requires verified CE/PE contract metadata',()=>{
  const now=Date.parse('2026-11-16T04:00:00Z');
  const {rows,tick}=risingUnderlyingFixture(now);
  const result=evaluateNineStrategies({underlyingCandles:rows,underlyingTick:tick,optionCandles:[],optionTick:tick,contract:null,now});
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

test('fixed premium plan honors the half-R chase limit while keeping planned RR at 1:2',()=>{
  const base={breakoutLevel:100,tickSize:0.05,swingLow:99,atr:1};
  assert.match(buildFixedPremiumPlan({...base,livePremium:100.85}).reason,/0.5R/);
  const withinChase=buildFixedPremiumPlan({...base,livePremium:100.10});
  assert.equal(withinChase.status,'SETUP_CONFIRMED');
  assert.equal(withinChase.rr,2);
  assert.equal(withinChase.target,103.15);
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
  assert.deepEqual(rows.map(x=>x.futureSymbol),['NSE:NIFTY26NOVFUT','NSE:BANKNIFTY26NOVFUT','NSE:RELIANCE26NOVFUT']);
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
  assert.equal(third.symbols.length,100);
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

test('F&O universe maps additional NSE and BSE index futures to index symbols',()=>{
  const now=Date.parse('2026-11-14T00:00:00Z');
  const nseMaster={
    'NSE:FINNIFTY26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'},
    'NSE:MIDCPNIFTY26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'},
    'NSE:NIFTYNXT5026NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'}
  };
  const bseMaster={'BSE:BANKEX26NOVFUT':{tradeStatus:1,expiryDate:'2026-11-26'}};
  const rows=buildFnoUniverse({nseMaster,bseMaster,now});
  assert.deepEqual(rows.map(x=>x.underlyingSymbol),['BSE:BANKEX-INDEX','NSE:FINNIFTY-INDEX','NSE:MIDCPNIFTY-INDEX','NSE:NIFTYNXT50-INDEX']);
});

test('double-bottom breakout without a neckline retest is not an entry',()=>{
  const rows=doublePatternFixture('bottom');
  rows[39]={...rows[39],open:106.2,high:107,low:106,close:106.5};
  assert.equal(detectDoublePattern(rows),null);
});


function flatRows(count=52, start=1794801600) {
  return Array.from({length:count},(_,i)=>({time:start+i*300,open:100,high:101,low:99,close:100,volume:100}));
}
function dailyTrendRows(count=60, start=1792000000) {
  return Array.from({length:count},(_,i)=>{const close=100+i;return{time:start+i*86400,open:close-0.5,high:close+1,low:close-1,close,volume:1000};});
}
function continuationRows(side='LONG') {
  const rows=[];
  for(let i=0;i<17;i++){
    const close=side==='LONG'?100+i*1.2:120-i*1.2;
    rows.push({time:1794801600+i*300,open:close-0.2,high:close+0.3,low:close-0.3,close,volume:100});
  }
  for(let i=0;i<12;i++){
    const open=side==='LONG'?120.5:99.5,close=side==='LONG'?120:100;
    rows.push({time:1794801600+(17+i)*300,open,high:side==='LONG'?121:101,low:side==='LONG'?119:99,close,volume:40});
  }
  const open=side==='LONG'?121:99,close=side==='LONG'?122:98;
  rows.push({time:1794801600+29*300,open,high:side==='LONG'?122.5:99.2,low:side==='LONG'?120.8:97.5,close,volume:150});
  return rows;
}
function openingRangeRows({retest=true}={}) {
  const start=Date.parse('2026-11-16T03:45:00Z')/1000;
  return [
    {time:start,open:100,high:101.5,low:99,close:101,volume:100},
    {time:start+300,open:101,high:102,low:100,close:101.5,volume:100},
    {time:start+600,open:101,high:101.8,low:100.2,close:101,volume:100},
    {time:start+900,open:102,high:103,low:101.5,close:102.8,volume:120},
    {time:start+1200,open:102.8,high:103.1,low:retest?101.9:102.5,close:102.5,volume:130}
  ];
}

test('Strategy 1 EMA20/EMA50 trend detector confirms long and short direction only',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const {rows}=risingUnderlyingFixture(now);
  const long=detectEmaTrend(rows.slice(0,-1));
  assert.equal(long?.strategy,'EMA20_EMA50_TREND');
  assert.equal(long?.side,'LONG');
  const shortRows=rows.slice(0,-1).map(c=>({...c,open:300-c.open,high:300-c.low,low:300-c.high,close:300-c.close}));
  const short=detectEmaTrend(shortRows);
  assert.equal(short?.side,'SHORT');
  assert.equal(detectEmaTrend(flatRows()),null);
});

test('Strategy 2 momentum breakout requires top-gainer qualification and a completed 5m high break',()=>{
  const rows=flatRows();
  rows[rows.length-2]={...rows.at(-2),high:101,close:100.5};
  rows[rows.length-1]={...rows.at(-1),open:101,high:102.5,low:100.8,close:102};
  assert.equal(detectTopGainerMomentum(rows,false),null);
  assert.equal(detectTopGainerMomentum(rows,true)?.strategy,'TOP_GAINER_MOMENTUM_BREAKOUT');
  rows[rows.length-1]={...rows.at(-1),close:100.9};
  assert.equal(detectTopGainerMomentum(rows,true),null);
});

test('Strategy 3 daily trend pullback requires daily alignment, 5m EMA trend, touch and resume',()=>{
  const rows=flatRows();
  for(let i=0;i<rows.length;i++){
    const close=100+i*0.8;
    rows[i]={...rows[i],open:close-0.2,high:close+0.3,low:close-0.5,close};
  }
  const closes=rows.map(c=>c.close);
  const calcEma=(values,p)=>{let v=values.slice(0,p).reduce((a,b)=>a+b,0)/p;const alpha=2/(p+1);for(let i=p;i<values.length;i++)v=values[i]*alpha+v*(1-alpha);return v;};
  const e20=calcEma(closes,20);
  rows[rows.length-2]={...rows.at(-2),open:e20,high:e20*1.02,low:e20*0.98,close:e20};
  rows[rows.length-1]={...rows.at(-1),open:e20*1.02,high:e20*1.04,low:e20*1.01,close:e20*1.03};
  const daily=dailyTrendRows();
  assert.equal(detectDailyTrendPullback(rows,daily)?.strategy,'DAILY_TREND_5M_PULLBACK');
  assert.equal(detectDailyTrendPullback(rows,daily.slice(0,30)),null);
  assert.equal(detectDailyTrendPullback(rows,daily.map(c=>({...c,close:200-c.close,open:200-c.open,high:200-c.low,low:200-c.high}))),null);
});

test('Strategy 4 day high/low break requires retest and hold, not direct breakout',()=>{
  const rows=openingRangeRows();
  assert.equal(detectDayHighLowRetest(rows)?.strategy,'DAY_HIGH_LOW_BREAK_RETEST');
  const direct=rows.map(c=>({...c}));
  direct[4]={...direct[4],low:102.5,close:103};
  assert.equal(detectDayHighLowRetest(direct),null);
});

test('Strategy 6 bullish and Strategy 7 bearish continuation require impulse, consolidation and directional break',()=>{
  assert.equal(detectContinuation(continuationRows('LONG'),'LONG')?.strategy,'BULLISH_CONTINUATION');
  assert.equal(detectContinuation(continuationRows('SHORT'),'SHORT')?.strategy,'BEARISH_CONTINUATION');
  assert.equal(detectContinuation(continuationRows('LONG'),'SHORT'),null);
  assert.equal(detectContinuation(continuationRows('SHORT'),'LONG'),null);
});

test('Strategy 8 flag breakout requires volume contraction then expansion with the break',()=>{
  const rows=continuationRows('LONG');
  const flag=rows.slice(-13,-1);
  flag.forEach(c=>{c.volume=40;});
  rows.slice(-30,-13).forEach(c=>{c.volume=100;});
  rows.at(-1).volume=100;
  assert.equal(detectFlagVolume(rows)?.strategy,'FLAG_BREAKOUT_VOLUME');
  const noContraction=rows.map(c=>({...c,volume:100}));
  assert.equal(detectFlagVolume(noContraction),null);
  const noExpansion=rows.map(c=>({...c}));
  noExpansion.at(-1).volume=50;
  assert.equal(detectFlagVolume(noExpansion),null);
});

test('Strategy 9 opening range breakout requires 9:15-9:30 range, break then retest',()=>{
  assert.equal(detectOpeningRange(openingRangeRows())?.strategy,'OPENING_RANGE_15M_RETEST');
  assert.equal(detectOpeningRange(openingRangeRows({retest:false})),null);
});


function pullbackUnderlyingFixture(now) {
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:52},(_,i)=>{
    const close=100+i*0.8;
    return{time:bucket-(52-i)*300,open:close-0.2,high:close+0.3,low:close-0.5,close,volume:100};
  });
  const values=rows.map(c=>c.close);
  let e20=values.slice(0,20).reduce((a,b)=>a+b,0)/20;
  const alpha=2/21;
  for(let i=20;i<values.length;i++)e20=values[i]*alpha+e20*(1-alpha);
  rows[50]={...rows[50],open:e20,high:e20*1.02,low:e20*0.98,close:e20};
  rows[51]={...rows[51],open:e20*1.02,high:e20*1.04,low:e20*1.01,close:e20*1.03};
  return{rows,tick:{price:rows[51].close,exchangeTime:now/1000,receivedAt:now}};
}

test('simultaneous confirmations prefer a specific setup over the broad EMA trend fallback',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const momentum=risingUnderlyingFixture(now);
  const topGainer=detectNineStrategySetup({underlyingCandles:momentum.rows,underlyingTick:momentum.tick,isTopGainer:true,now});
  assert.equal(topGainer.strategy,'TOP_GAINER_MOMENTUM_BREAKOUT');
  const pullback=pullbackUnderlyingFixture(now);
  const daily=dailyTrendRows(60,Math.floor(now/86400000)*86400-60*86400);
  const dailySetup=detectNineStrategySetup({underlyingCandles:pullback.rows,underlyingTick:pullback.tick,dailyCandles:daily,now});
  assert.equal(dailySetup.strategy,'DAILY_TREND_5M_PULLBACK');
});

test('first-confirmed candle time wins before the same-candle specificity tie-break',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const {rows,tick}=risingUnderlyingFixture(now);
  const result=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,isTopGainer:true,now});
  assert.equal(result.status,'UNDERLYING_SETUP_CONFIRMED');
  assert.equal(result.confirmedAt,rows[rows.length-2].time);
});
