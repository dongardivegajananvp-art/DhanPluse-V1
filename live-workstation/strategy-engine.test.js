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

test('EMA20/EMA50 strategy evaluates with exactly 50 completed 5-minute candles',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:50},(_,i)=>{
    const close=100+i*0.5;
    return {time:bucket-(50-i)*300,open:close-0.1,high:close+0.2,low:close-0.2,close,volume:100};
  });
  const last=rows.at(-1);
  const result=detectNineStrategySetup({
    underlyingCandles:rows,
    underlyingTick:{price:last.close,exchangeTime:now/1000,receivedAt:now},
    now
  });
  assert.ok(detectEmaTrend(rows));
});

test('daily trend pullback strategy accepts 50 completed underlying and daily candles',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:50},(_,i)=>({
    time:bucket-(50-i)*300,open:100,high:100.2,low:99.8,close:100,volume:100
  }));
  const dailyCandles=Array.from({length:50},(_,i)=>{
    const close=100+i*0.5;
    return {time:Math.floor(now/1000)-(50-i)*86400,open:close-0.1,high:close+0.2,low:close-0.2,close};
  });
  const last=rows.at(-1);
  const result=detectNineStrategySetup({
    underlyingCandles:rows,
    underlyingTick:{price:last.close,exchangeTime:now/1000,receivedAt:now},
    dailyCandles,
    now
  });
  assert.equal(result.status,'NO_TRADE');
  assert.equal(result.evaluatedStrategies.includes('DAILY_TREND_5M_PULLBACK'),true);
});

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

test('option entry triggers on live premium breakout after the underlying completed-candle setup',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const underlyingCandles=[
    {time:bucket-600,open:100,high:100.5,low:99.5,close:100,volume:100},
    {time:bucket-300,open:100.5,high:101.2,low:100.2,close:101,volume:120}
  ];
  const optionCandles=[
    {time:bucket-900,open:100,high:100.2,low:99.8,close:100,volume:100},
    {time:bucket-600,open:100.2,high:100.4,low:100.1,close:100.3,volume:120},
    {time:bucket-300,open:100.3,high:100.45,low:100.15,close:100.3,volume:110}
  ];
  const optionTick={price:100.5,exchangeTime:now/1000,receivedAt:now};
  const underlyingTick={price:101.1,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({
    underlyingCandles,underlyingTick,optionCandles,optionTick,
    contract:{symbol:'NSE:RELIANCE26NOV2500CE',side:'CE',tickSize:0.05},isTopGainer:true,now
  });
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.strategy,'TOP_GAINER_MOMENTUM_BREAKOUT');
  assert.equal(result.rr,2);
  assert.equal(result.optionConfirmation,'LIVE_PREMIUM_BREAKOUT');
  assert.equal(result.entry,100.5);
  assert.equal(result.stopLoss,100.05);
  assert.equal(result.target,101.4);
});


test('confirmed underlying setup remains WAITING until live option premium breaks the completed candle high',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const underlyingCandles=[
    {time:bucket-600,open:100,high:100.5,low:99.5,close:100,volume:100},
    {time:bucket-300,open:100.5,high:101.2,low:100.2,close:101,volume:120}
  ];
  const optionCandles=[
    {time:bucket-900,open:100,high:100.2,low:99.8,close:100,volume:100},
    {time:bucket-600,open:100.2,high:100.4,low:100.1,close:100.3,volume:120},
    {time:bucket-300,open:100.3,high:100.45,low:100.15,close:100.3,volume:110}
  ];
  const optionTick={price:100.3,exchangeTime:now/1000,receivedAt:now};
  const underlyingTick={price:101.1,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles,underlyingTick,optionCandles,optionTick,contract:{symbol:'NSE:RELIANCE26NOV2500CE',side:'CE',tickSize:0.05},isTopGainer:true,now});
  assert.equal(result.status,'WAITING_FOR_OPTION_BREAKOUT');
  assert.match(result.reason,/live option premium/i);
});

test('option premium stop uses the lower of the last two completed candle lows',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const {rows:underlyingCandles}=risingUnderlyingFixture(now);
  const optionCandles=[
    {time:bucket-900,open:100,high:100.2,low:99.8,close:100,volume:100},
    {time:bucket-600,open:100.2,high:100.4,low:100.05,close:100.3,volume:120},
    {time:bucket-300,open:100.3,high:100.45,low:100.3,close:100.35,volume:110}
  ];
  const optionTick={price:100.5,exchangeTime:now/1000,receivedAt:now};
  const underlyingTick={price:153.5,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({underlyingCandles,underlyingTick,optionCandles,optionTick,contract:{symbol:'NSE:RELIANCE26NOV2500CE',side:'CE',tickSize:0.05},isTopGainer:true,now});
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.entry,100.5);
  assert.equal(result.stopLoss,100);
  assert.equal(result.target,101.5);
  assert.equal(result.rr,2);
});

test('option premium remains WAITING until live quote crosses the latest completed candle high',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const underlyingCandles=[
    {time:bucket-600,open:100,high:100.5,low:99.5,close:100,volume:100},
    {time:bucket-300,open:100.5,high:101.2,low:100.2,close:101,volume:120}
  ];
  const optionCandles=[
    {time:bucket-900,open:100,high:100.2,low:99.8,close:100,volume:100},
    {time:bucket-600,open:100.2,high:100.4,low:100.1,close:100.3,volume:120},
    {time:bucket-300,open:100.2,high:100.3,low:100.1,close:100.15,volume:110}
  ];
  const optionTick={price:100.15,exchangeTime:now/1000,receivedAt:now};
  const underlyingTick={price:101.1,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({
    underlyingCandles,underlyingTick,optionCandles,optionTick,
    contract:{symbol:'NSE:RELIANCE26NOV2500CE',side:'CE',tickSize:0.05},isTopGainer:true,now
  });
  assert.equal(result.status,'WAITING_FOR_OPTION_BREAKOUT');
  assert.match(result.reason,/live option premium/i);
});

test('strategy evaluator requires verified CE/PE contract metadata',()=>{
  const now=Date.parse('2026-11-16T04:00:00Z');
  const {rows,tick}=risingUnderlyingFixture(now);
  const result=evaluateNineStrategies({underlyingCandles:rows,underlyingTick:tick,optionCandles:[],optionTick:tick,contract:null,now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/verified active CE\/PE/i);
});

test('fixed premium plan uses structural swing low, one-tick stop buffer and exact 2R target',()=>{
  const plan=buildFixedPremiumPlan({breakoutLevel:100,tickSize:0.05,livePremium:100.05,swingLow:99});
  assert.equal(plan.status,'SETUP_CONFIRMED');
  assert.equal(plan.entry,100.05);
  assert.equal(plan.stopLoss,98.95);
  assert.equal(plan.target,102.25);
  assert.equal(plan.rr,2);
});

test('fixed premium plan honors the half-R chase limit while keeping planned RR at 1:2',()=>{
  const base={breakoutLevel:100,tickSize:0.05,swingLow:99};
  assert.match(buildFixedPremiumPlan({...base,livePremium:100.85}).reason,/0.5R/);
  const withinChase=buildFixedPremiumPlan({...base,livePremium:100.10});
  assert.equal(withinChase.status,'SETUP_CONFIRMED');
  assert.equal(withinChase.rr,2);
  assert.equal(withinChase.target,102.25);
  assert.equal(buildFixedPremiumPlan({...base,livePremium:100.05}).status,'SETUP_CONFIRMED');
});

test('a gap in the older EMA50 window does not block a fresh two-candle top-gainer breakout',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=[];
  for(let i=0;i<52;i++){
    if(i===8)continue;
    const price=100+i;
    rows.push({time:bucket-(52-i)*300,open:price,high:price+1,low:price-1,close:price,volume:10});
  }
  rows[rows.length-1]={...rows.at(-1),open:151.5,high:152,low:151,close:151.5,volume:100};
  rows.push({time:bucket,open:152,high:153,low:151,close:152,volume:0});
  const tick={price:152,exchangeTime:now/1000,receivedAt:now};
  const result=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,isTopGainer:true,now});
  assert.equal(result.status,'UNDERLYING_SETUP_CONFIRMED');
  assert.equal(result.strategy,'TOP_GAINER_MOMENTUM_BREAKOUT');
  assert.equal(result.side,'LONG');
  assert.equal(result.breakoutLevel,151);
});

test('top-gainer momentum still blocks when its own latest two-candle window has a gap',()=>{
  const now=Date.parse('2026-11-16T04:00:30Z');
  const bucket=Math.floor((now/1000)/300)*300;
  const rows=Array.from({length:52},(_,i)=>{const close=100+i;return{time:bucket-(52-i)*300,open:close,high:close+1,low:close-1,close,volume:10};});
  rows[51]={...rows[51],time:rows[51].time-300};
  rows.push({time:bucket,open:152,high:153,low:151,close:152,volume:0});
  const tick={price:152,exchangeTime:now/1000,receivedAt:now};
  const result=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,isTopGainer:true,now});
  assert.equal(result.status,'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason,/TOP_GAINER_MOMENTUM_BREAKOUT/);
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
  assert.ok(result.breakoutLevel>0&&result.breakoutLevel<result.underlyingPrice);
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
  const longRows=rows.slice(0,-1);
  longRows[longRows.length-2]={...longRows.at(-2),high:200};
  const long=detectEmaTrend(longRows);
  assert.equal(long?.strategy,'EMA20_EMA50_TREND');
  assert.equal(long?.side,'LONG');
  const shortRows=rows.slice(0,-1).map(c=>({...c,open:300-c.open,high:300-c.low,low:300-c.high,close:300-c.close}));
  shortRows[shortRows.length-2]={...shortRows.at(-2),low:100};
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
  assert.equal(detectOpeningRange(openingRangeRows())?.strategy,'OPENING_RANGE_BREAKOUT');
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
  rows[51]={...rows[51],open:e20*1.04,high:e20*1.06,low:e20*1.03,close:e20*1.05};
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


test('strategy candle gate accepts a normal Friday-to-Monday session boundary',()=>{
  const previousSessionStart=Date.parse('2026-11-13T05:50:00Z')/1000;
  const previousSession=Array.from({length:50},(_,i)=>({
    time:previousSessionStart+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  const mondayOpen=Date.parse('2026-11-16T03:45:00Z')/1000;
  const now=Date.parse('2026-11-16T03:50:30Z');
  const rows=[...previousSession,{time:mondayOpen,open:100,high:101,low:99,close:100,volume:100}];
  const tick={price:100,exchangeTime:now/1000,receivedAt:now};
  const result=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,now});
  assert.equal(result.status,'NO_TRADE');
  assert.match(result.reason,/No eligible strategy confirmed/);
  assert.ok(result.evaluatedStrategies.includes('EMA20_EMA50_TREND'));
});


test('MCX nine-strategy session uses 09:00 opening range rather than NSE 09:15',()=>{
  const now=Date.parse('2026-11-16T03:56:00Z');
  const base=Math.floor(Date.parse('2026-11-16T03:30:00Z')/1000);
  const rows=[
    {time:base,open:100,high:101,low:99,close:100,volume:100},
    {time:base+300,open:100,high:102,low:100,close:101,volume:110},
    {time:base+600,open:101,high:103,low:100.5,close:102,volume:120},
    {time:base+900,open:102,high:104,low:101.5,close:103.5,volume:130},
    {time:base+1200,open:103,high:103.4,low:102.8,close:103.1,volume:140}
  ];
  const tick={price:103.1,exchangeTime:now/1000,receivedAt:now};
  const result=detectNineStrategySetup({
    underlyingCandles:rows,underlyingTick:tick,now,
    sessionStartMinute:540,sessionCloseMinute:1435
  });
  assert.equal(result.status,'UNDERLYING_SETUP_CONFIRMED');
  assert.equal(detectOpeningRange(rows,540).strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(detectOpeningRange(rows,555),null);
});

test('MCX overnight candle continuity accepts 23:50 to next-session 09:00 with MCX session settings',()=>{
  const start=Math.floor(Date.parse('2026-11-15T14:20:00Z')/1000); // 19:50 IST
  const rows=Array.from({length:49},(_,i)=>({
    time:start+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  rows.push({time:Math.floor(Date.parse('2026-11-16T03:30:00Z')/1000),open:100,high:101,low:99,close:100,volume:100});
  const now=Date.parse('2026-11-16T03:36:00Z');
  const tick={price:100,exchangeTime:now/1000,receivedAt:now};
  const mcx=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,now,sessionStartMinute:540,sessionCloseMinute:1435});
  assert.equal(mcx.status,'NO_TRADE');
  assert.ok(mcx.evaluatedStrategies.includes('EMA20_EMA50_TREND'));
  assert.ok(mcx.blockedStrategies.includes('TOP_GAINER_MOMENTUM_BREAKOUT'));
});

test('MCX option confirmation accepts the verified 23:50 to 09:00 session boundary',()=>{
  const now=Date.parse('2026-11-17T03:40:30Z'); // 09:10:30 IST
  const priorClose=Date.parse('2026-11-16T18:20:00Z')/1000;
  const underlyingCandles=Array.from({length:48},(_,i)=>{
    const close=100+i*0.1;
    return{time:priorClose-(47-i)*300,open:close-0.05,high:close+0.1,low:close-0.1,close,volume:100};
  });
  for(const [time,close] of [
    [Date.parse('2026-11-17T03:30:00Z')/1000,104.8],
    [Date.parse('2026-11-17T03:35:00Z')/1000,104.9]
  ])underlyingCandles.push({time,open:close-0.05,high:close+0.1,low:close-0.1,close,volume:120});
  const optionCandles=[
    {time:priorClose,open:100,high:100.2,low:99.95,close:100.1,volume:100},
    {time:Date.parse('2026-11-17T03:30:00Z')/1000,open:100.1,high:100.35,low:100.05,close:100.3,volume:120},
    {time:Date.parse('2026-11-17T03:35:00Z')/1000,open:100.3,high:100.4,low:100.15,close:100.35,volume:110}
  ];
  const underlyingTick={price:105,exchangeTime:now/1000,receivedAt:now};
  const optionTick={price:100.45,exchangeTime:now/1000,receivedAt:now};
  const result=evaluateNineStrategies({
    underlyingCandles,underlyingTick,optionCandles,optionTick,
    contract:{symbol:'MCX:CRUDEOIL26NOV7500CE',side:'CE',tickSize:0.05},
    isTopGainer:false,now,sessionStartMinute:540,sessionCloseMinute:1435
  });
  assert.equal(result.status,'SETUP_CONFIRMED');
  assert.equal(result.rr,2);
});


test('Strategy 9 confirms a completed close above the first 5-minute candle high',()=>{
  const start=Date.parse('2026-11-16T03:45:00Z')/1000;
  const rows=[
    {time:start,open:100,high:101,low:99,close:100.5,volume:100},
    {time:start+300,open:100.5,high:102,low:100.2,close:101.5,volume:120}
  ];
  const result=detectOpeningRange(rows,555);
  assert.equal(result?.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(result?.side,'LONG');
  assert.equal(result?.breakoutLevel,101);
  assert.equal(result?.pattern,'FIRST_CANDLE_HIGH_BREAKOUT');
});

test('Strategy 9 confirms a completed close below the first 5-minute candle low',()=>{
  const start=Date.parse('2026-11-16T03:45:00Z')/1000;
  const rows=[
    {time:start,open:100,high:101,low:99,close:99.5,volume:100},
    {time:start+300,open:99.5,high:99.8,low:98,close:98.5,volume:130}
  ];
  const result=detectOpeningRange(rows,555);
  assert.equal(result?.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(result?.side,'SHORT');
  assert.equal(result?.breakoutLevel,99);
  assert.equal(result?.pattern,'FIRST_CANDLE_LOW_BREAKDOWN');
});

test('Strategy 9 does not trigger on an intrabar wick without a completed close outside first-candle range',()=>{
  const start=Date.parse('2026-11-16T03:45:00Z')/1000;
  const rows=[
    {time:start,open:100,high:101,low:99,close:100.5,volume:100},
    {time:start+300,open:100.5,high:102,low:100.2,close:100.8,volume:120}
  ];
  assert.equal(detectOpeningRange(rows,555),null);
});

test('Strategy 9 does not re-enter after the first-candle breakout is already extended',()=>{
  const start=Date.parse('2026-11-16T03:45:00Z')/1000;
  const rows=[
    {time:start,open:100,high:101,low:99,close:100.5,volume:100},
    {time:start+300,open:100.5,high:102,low:100.2,close:101.5,volume:120},
    {time:start+600,open:101.5,high:103,low:101.2,close:102.5,volume:130}
  ];
  assert.equal(detectOpeningRange(rows,555),null);
});


test('Strategy 9 first-candle breakout is returned by the complete nine-strategy evaluator',()=>{
  const start=Date.parse('2026-11-16T03:45:00Z')/1000;
  const rows=[
    {time:start,open:100,high:101,low:99,close:100.5,volume:100},
    {time:start+300,open:100.5,high:100.9,low:100.2,close:100.7,volume:110},
    {time:start+600,open:100.7,high:102,low:100.6,close:101.5,volume:120}
  ];
  const now=Date.parse('2026-11-16T04:01:00Z');
  const tick={price:101.5,exchangeTime:now/1000,receivedAt:now};
  const result=detectNineStrategySetup({underlyingCandles:rows,underlyingTick:tick,now});
  assert.equal(result.status,'UNDERLYING_SETUP_CONFIRMED',JSON.stringify(result));
  assert.equal(result.strategy,'OPENING_RANGE_BREAKOUT');
  assert.equal(result.side,'LONG');
  assert.equal(result.pattern,'FIRST_CANDLE_HIGH_BREAKOUT');
});
