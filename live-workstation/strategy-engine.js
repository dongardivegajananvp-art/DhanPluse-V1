import { getCompletedCandleWindow } from './public/chart-safety.js';

const INTERVAL_SECONDS = 300;
const MAX_ACTIVE_TRADES = 2;
const STRATEGIES = Object.freeze([
  'EMA20_EMA50_TREND',
  'TOP_GAINER_MOMENTUM_BREAKOUT',
  'DAILY_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST',
  'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',
  'BULLISH_CONTINUATION',
  'BEARISH_CONTINUATION',
  'FLAG_BREAKOUT_VOLUME',
  'OPENING_RANGE_BREAKOUT'
]);
// When multiple setups confirm on the same completed candle, prefer the more specific pattern over the broad EMA trend fallback.
const STRATEGY_TIE_PRIORITY = Object.freeze([
  'TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK','DAY_HIGH_LOW_BREAK_RETEST',
  'DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION','BEARISH_CONTINUATION',
  'FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT','EMA20_EMA50_TREND'
]);

function finite(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function number(value) { return Number(value); }
function validOhlcv(c) {
  return c && ['time','open','high','low','close'].every(k => finite(c[k])) &&
    number(c.time) > 0 && number(c.open) > 0 && number(c.high) > 0 && number(c.low) > 0 && number(c.close) > 0 &&
    number(c.high) >= Math.max(number(c.open), number(c.close), number(c.low)) &&
    number(c.low) <= Math.min(number(c.open), number(c.close));
}
function ema(values, period) {
  if (values.length < period) return NaN;
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) result = values[i] * alpha + result * (1 - alpha);
  return result;
}
function istDayKey(seconds) {
  return new Date((seconds + 19800) * 1000).toISOString().slice(0,10);
}
function isTradingCandleContiguous(previousTime, currentTime, sessionStartMinute = 555, sessionCloseMinute = 930) {
  if (currentTime - previousTime === INTERVAL_SECONDS) return true;
  const localParts = value => {
    const date = new Date((Number(value) + 19800) * 1000);
    return { day: date.toISOString().slice(0, 10), minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
  };
  const previous = localParts(previousTime), current = localParts(currentTime);
  return previous.minute === sessionCloseMinute - 5 && current.minute === sessionStartMinute && current.day > previous.day;
}
function contiguousWindow(rows, count, sessionStartMinute = 555, sessionCloseMinute = 930) {
  if (!Array.isArray(rows) || rows.length < count) return false;
  const required = rows.slice(-count);
  return required.every((candle, index) => index === 0 ||
    isTradingCandleContiguous(number(required[index - 1].time), number(candle.time), sessionStartMinute, sessionCloseMinute));
}
function currentSessionRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const key = istDayKey(number(rows.at(-1).time));
  return rows.filter(candle => istDayKey(number(candle.time)) === key);
}
function completed(candles, tick, label) {
  if (!Array.isArray(candles) || candles.some(c => !validOhlcv(c))) {
    return { error: label + ' candles are missing or malformed' };
  }
  const window = getCompletedCandleWindow(candles, tick.exchangeTime);
  if (!window.fresh) return { error: label + ' latest completed candle is stale' };
  if (window.completed.length < 2) return { error: label + ' requires at least two completed 5-minute candles' };
  return { rows: window.completed, last: window.lastClosed };
}
function pivotHigh(rows, i, width=2) {
  const value=number(rows[i].high);
  for(let j=Math.max(0,i-width);j<=Math.min(rows.length-1,i+width);j++) if(j!==i&&number(rows[j].high)>=value)return false;
  return true;
}
function pivotLow(rows, i, width=2) {
  const value=number(rows[i].low);
  for(let j=Math.max(0,i-width);j<=Math.min(rows.length-1,i+width);j++) if(j!==i&&number(rows[j].low)<=value)return false;
  return true;
}
function candidate(strategy, side, level, candle, details={}) {
  if (!finite(level) || number(level)<=0) return null;
  return { strategy, side, breakoutLevel:number(level), confirmedAt:number(candle.time), confirmationClose:number(candle.close), ...details };
}
export function detectDoublePattern(rows) {
  const start=Math.max(2,rows.length-45), end=rows.length-3;
  const highs=[],lows=[];
  for(let i=start;i<end;i++){
    if(pivotHigh(rows,i,2))highs.push(i);
    if(pivotLow(rows,i,2))lows.push(i);
  }
  const last=rows.at(-1), prior=rows.slice(-3,-1);
  for(let a=0;a<highs.length;a++)for(let b=a+1;b<highs.length;b++){
    const i=highs[a],j=highs[b],h1=number(rows[i].high),h2=number(rows[j].high);
    if(j-i<4||Math.abs(h1-h2)/Math.max(h1,h2)>0.003)continue;
    const neck=Math.min(...rows.slice(i,j+1).map(x=>number(x.low)));
    const hadBreak=rows.slice(j+1,-1).some(x=>number(x.close)<neck);
    if(hadBreak&&number(last.high)>=neck*0.998&&number(last.close)<neck&&prior.some(x=>number(x.close)<neck))
      return candidate('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','SHORT',neck,last,{pattern:'DOUBLE_TOP'});
  }
  for(let a=0;a<lows.length;a++)for(let b=a+1;b<lows.length;b++){
    const i=lows[a],j=lows[b],l1=number(rows[i].low),l2=number(rows[j].low);
    if(j-i<4||Math.abs(l1-l2)/Math.max(l1,l2)>0.003)continue;
    const neck=Math.max(...rows.slice(i,j+1).map(x=>number(x.high)));
    const hadBreak=rows.slice(j+1,-1).some(x=>number(x.close)>neck);
    if(hadBreak&&number(last.low)<=neck*1.002&&number(last.close)>neck&&prior.some(x=>number(x.close)>neck))
      return candidate('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','LONG',neck,last,{pattern:'DOUBLE_BOTTOM'});
  }
  return null;
}
export function detectContinuation(rows, side) {
  const last=rows.at(-1), prior=rows.slice(-13,-1);
  const impulse=rows.slice(-30,-13);
  if(prior.length!==12||impulse.length<10)return null;
  const move=side==='LONG'
    ? number(impulse.at(-1).close)-number(impulse[0].close)
    : number(impulse[0].close)-number(impulse.at(-1).close);
  const range=Math.max(...prior.map(c=>number(c.high)))-Math.min(...prior.map(c=>number(c.low)));
  if(!(move>0&&range>0&&move>=range*1.5))return null;
  const ceiling=Math.max(...prior.map(c=>number(c.high)));
  const floor=Math.min(...prior.map(c=>number(c.low)));
  const breakout=side==='LONG'?number(last.close)>ceiling&&number(last.close)>number(last.open):number(last.close)<floor&&number(last.close)<number(last.open);
  if(!breakout)return null;
  const first=prior.slice(0,6),second=prior.slice(6);
  const firstHigh=Math.max(...first.map(c=>number(c.high))),secondHigh=Math.max(...second.map(c=>number(c.high)));
  const firstLow=Math.min(...first.map(c=>number(c.low))),secondLow=Math.min(...second.map(c=>number(c.low)));
  const ascendingTriangle=side==='LONG'&&Math.abs(ceiling-firstHigh)/ceiling<=0.003&&secondLow>firstLow;
  const descendingTriangle=side==='SHORT'&&Math.abs(floor-firstLow)/floor<=0.003&&secondHigh<firstHigh;
  const pattern=ascendingTriangle?'ASCENDING_TRIANGLE':descendingTriangle?'DESCENDING_TRIANGLE':range/move<0.45?'PENNANT':'FLAG';
  return candidate(side==='LONG'?'BULLISH_CONTINUATION':'BEARISH_CONTINUATION',side,side==='LONG'?ceiling:floor,last,{pattern});
}
export function detectFlagVolume(rows) {
  const last=rows.at(-1), flag=rows.slice(-13,-1), impulse=rows.slice(-30,-13);
  const volumes=flag.map(c=>number(c.volume)).filter(Number.isFinite);
  const priorVol=rows.slice(-30,-13).map(c=>number(c.volume)).filter(Number.isFinite);
  if(volumes.length!==12||priorVol.length<10)return null;
  const avgFlag=volumes.reduce((a,b)=>a+b,0)/volumes.length;
  const avgPrior=priorVol.reduce((a,b)=>a+b,0)/priorVol.length;
  const high=Math.max(...flag.map(c=>number(c.high))),low=Math.min(...flag.map(c=>number(c.low)));
  const impulseUp=number(impulse.at(-1).close)>number(impulse[0].close);
  const impulseDown=number(impulse.at(-1).close)<number(impulse[0].close);
  if(avgFlag>=avgPrior*0.75)return null;
  if(impulseUp&&number(last.close)>high&&number(last.volume)>=avgFlag*1.5)return candidate('FLAG_BREAKOUT_VOLUME','LONG',high,last);
  if(impulseDown&&number(last.close)<low&&number(last.volume)>=avgFlag*1.5)return candidate('FLAG_BREAKOUT_VOLUME','SHORT',low,last);
  return null;
}
export function detectOpeningRange(rows, sessionStartMinute = 555, livePrice = null) {
  const key=istDayKey(number(rows.at(-1).time));
  const day=rows.filter(c=>istDayKey(number(c.time))===key);
  if(!day.length)return null;
  const sessionMinute=c=>{
    const t=new Date((number(c.time)+19800)*1000);
    return t.getUTCHours()*60+t.getUTCMinutes();
  };
  // The first completed 5-minute candle defines the opening high/low.
  // A fresh underlying exchange tick crossing that range is the early trigger;
  // a completed close outside the range remains a valid confirmation fallback.
  const first=day.find(c=>sessionMinute(c)===sessionStartMinute);
  const last=day.at(-1),prior=day.at(-2);
  if(first&&last){
    const firstHigh=number(first.high),firstLow=number(first.low),price=Number(livePrice);
    if(Number.isFinite(price)&&number(last.close)<=firstHigh&&price>firstHigh)
      return candidate('OPENING_RANGE_BREAKOUT','LONG',firstHigh,last,{pattern:'FIRST_CANDLE_HIGH_LIVE_BREAKOUT'});
    if(Number.isFinite(price)&&number(last.close)>=firstLow&&price<firstLow)
      return candidate('OPENING_RANGE_BREAKOUT','SHORT',firstLow,last,{pattern:'FIRST_CANDLE_LOW_LIVE_BREAKDOWN'});
    if(prior&&number(last.time)>number(first.time)){
      if(number(prior.close)<=firstHigh&&number(last.close)>firstHigh)
        return candidate('OPENING_RANGE_BREAKOUT','LONG',firstHigh,last,{pattern:'FIRST_CANDLE_HIGH_BREAKOUT'});
      if(number(prior.close)>=firstLow&&number(last.close)<firstLow)
        return candidate('OPENING_RANGE_BREAKOUT','SHORT',firstLow,last,{pattern:'FIRST_CANDLE_LOW_BREAKDOWN'});
    }
  }
  // Retain the existing 15-minute opening-range break/retest path as a
  // second confirmation route within the same ninth strategy.
  if(day.length<5)return null;
  const opening=day.filter(c=>{
    const t=new Date((number(c.time)+19800)*1000);
    const mins=t.getUTCHours()*60+t.getUTCMinutes();
    return mins>=sessionStartMinute&&mins<sessionStartMinute+15;
  });
  if(opening.length!==3)return null;
  const high=Math.max(...opening.map(c=>number(c.high))),low=Math.min(...opening.map(c=>number(c.low)));
  const later=day.filter(c=>number(c.time)>number(opening.at(-1).time));
  const rangeLast=rows.at(-1), rangePrior=later.slice(0,-1);
  if(!rangePrior.length)return null;
  const brokeHigh=rangePrior.some(c=>number(c.close)>high);
  const brokeLow=rangePrior.some(c=>number(c.close)<low);
  if(brokeHigh&&number(rangeLast.low)<=high*1.002&&number(rangeLast.close)>high)return candidate('OPENING_RANGE_BREAKOUT','LONG',high,rangeLast);
  if(brokeLow&&number(rangeLast.high)>=low*0.998&&number(rangeLast.close)<low)return candidate('OPENING_RANGE_BREAKOUT','SHORT',low,rangeLast);
  return null;
}
export function detectDayHighLowRetest(rows) {
  const key=istDayKey(number(rows.at(-1).time));
  const day=rows.filter(c=>istDayKey(number(c.time))===key);
  if(day.length<4)return null;
  const last=day.at(-1),prior=day.slice(0,-1);
  for(let i=1;i<prior.length;i++){
    const level=Math.max(...day.slice(0,i).map(c=>number(c.high)));
    if(number(prior[i].close)>level&&number(last.low)<=level*1.002&&number(last.close)>level)
      return candidate('DAY_HIGH_LOW_BREAK_RETEST','LONG',level,last);
  }
  for(let i=1;i<prior.length;i++){
    const level=Math.min(...day.slice(0,i).map(c=>number(c.low)));
    if(number(prior[i].close)<level&&number(last.high)>=level*0.998&&number(last.close)<level)
      return candidate('DAY_HIGH_LOW_BREAK_RETEST','SHORT',level,last);
  }
  return null;
}
export function buildFixedPremiumPlan({ breakoutLevel, tickSize, livePremium, swingLow }) {
  const values=[breakoutLevel,tickSize,livePremium,swingLow];
  if(!values.every(finite)||values.some(v=>number(v)<=0))return{status:'NO_TRADE',reason:'Breakout, tick size, live premium and confirmed-candle swing low must be positive'};
  const step=number(tickSize);
  const entry=Number((Math.ceil((number(breakoutLevel)+step-1e-9)/step)*step).toFixed(8));
  // One completed post-breakout confirmation/retest candle defines the swing low.
  // Place the stop one official option tick below that candle structure; ATR(14) is not required.
  const stopLoss=Number((Math.floor((number(swingLow)-step+1e-9)/step)*step).toFixed(8));
  const risk=entry-stopLoss;
  if(!(risk>=step))return{status:'NO_TRADE',reason:'Single-candle confirmation swing low does not leave positive option-premium risk'};
  if(number(livePremium)+step*1e-7<entry)return{status:'NO_TRADE',reason:'Live option premium has not reached breakout level + one tick'};
  if(number(livePremium)>entry+0.5*risk+step*1e-7)return{status:'NO_TRADE',reason:'Option premium moved more than 0.5R beyond entry; chase blocked'};
  const target=Number((entry+2*risk).toFixed(8));
  const plannedRr=(target-entry)/risk;
  if(!(Number.isFinite(plannedRr)&&plannedRr>=2-1e-9))return{status:'NO_TRADE',reason:'Fixed Entry/SL/Target do not preserve the required 1:2 reward/risk'};
  return{status:'SETUP_CONFIRMED',entry,stopLoss,target,rr:Number(plannedRr.toFixed(2)),risk};
}

export function detectEmaTrend(rows) {
  if (!Array.isArray(rows) || rows.length < 50) return null;
  const last=rows.at(-1), closes=rows.map(c=>number(c.close));
  const e20=ema(closes,20),e50=ema(closes,50);
  if(e20>e50&&number(last.close)>e20)
    return candidate(STRATEGIES[0],'LONG',e20,last);
  if(e20<e50&&number(last.close)<e20)
    return candidate(STRATEGIES[0],'SHORT',e20,last);
  return null;
}
export function detectTopGainerMomentum(rows, isTopGainer=false) {
  if (!isTopGainer || !Array.isArray(rows) || rows.length < 2) return null;
  const last=rows.at(-1),prior=rows.at(-2);
  return number(last.close)>number(prior.high)
    ? candidate(STRATEGIES[1],'LONG',number(prior.high),last)
    : null;
}
export function detectDailyTrendPullback(rows, dailyCandles=[]) {
  if (!Array.isArray(rows) || rows.length < 50 || !Array.isArray(dailyCandles)) return null;
  const dailyCloses=dailyCandles.filter(validOhlcv).map(c=>number(c.close));
  if(dailyCloses.length<50)return null;
  const d20=ema(dailyCloses,20),d50=ema(dailyCloses,50);
  const closes=rows.map(c=>number(c.close)),e20=ema(closes,20),e50=ema(closes,50);
  const last=rows.at(-1),p=rows.at(-2),touch=number(p.low)<=e20*1.003&&number(p.high)>=e20*0.997;
  if(d20>d50&&e20>e50&&touch&&number(last.close)>number(p.high))
    return candidate(STRATEGIES[2],'LONG',number(p.high),last);
  if(d20<d50&&e20<e50&&touch&&number(last.close)<number(p.low))
    return candidate(STRATEGIES[2],'SHORT',number(p.low),last);
  return null;
}

export function detectNineStrategySetup({ underlyingCandles, underlyingTick, dailyCandles=[], isTopGainer=false, now=Date.now(), sessionStartMinute=555, sessionCloseMinute=930 }) {
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason});
  const tickFresh=t=>Boolean(t&&finite(t.price)&&number(t.price)>0&&finite(t.exchangeTime)&&finite(t.receivedAt)&&now-number(t.receivedAt)>=0&&now-number(t.receivedAt)<=10000&&now/1000-number(t.exchangeTime)>=-3&&now/1000-number(t.exchangeTime)<=10);
  if(!tickFresh(underlyingTick))return fail('Fresh FYERS underlying/futures tick is required');
  const u=completed(underlyingCandles,underlyingTick,'Underlying');
  if(u.error)return fail(u.error);
  const rows=u.rows,last=u.last;
  const candidates=[], evaluated=[], blocked=[];
  const consider=(name,eligible,detect)=>{
    if(!eligible){blocked.push(name);return;}
    evaluated.push(name);
    const result=detect();if(result)candidates.push(result);
  };
  // Each strategy validates only the candle history it actually consumes.
  // A gap in an older EMA50 window must not disable a valid two-candle momentum breakout.
  consider('EMA20_EMA50_TREND',contiguousWindow(rows,50,sessionStartMinute,sessionCloseMinute),()=>detectEmaTrend(rows));
  consider('TOP_GAINER_MOMENTUM_BREAKOUT',isTopGainer&&contiguousWindow(rows,2,sessionStartMinute,sessionCloseMinute),()=>detectTopGainerMomentum(rows,isTopGainer));
  consider('DAILY_TREND_5M_PULLBACK',contiguousWindow(rows,50,sessionStartMinute,sessionCloseMinute)&&Array.isArray(dailyCandles)&&dailyCandles.filter(validOhlcv).length>=50,()=>detectDailyTrendPullback(rows,dailyCandles));
  const sessionRows=currentSessionRows(rows);
  const sessionContiguous=sessionRows.length>0&&contiguousWindow(sessionRows,sessionRows.length,sessionStartMinute,sessionCloseMinute);
  consider('DAY_HIGH_LOW_BREAK_RETEST',sessionRows.length>=4&&sessionContiguous,()=>detectDayHighLowRetest(rows));
  consider('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST',contiguousWindow(rows,48,sessionStartMinute,sessionCloseMinute),()=>detectDoublePattern(rows));
  consider('BULLISH_CONTINUATION',contiguousWindow(rows,30,sessionStartMinute,sessionCloseMinute),()=>detectContinuation(rows,'LONG'));
  consider('BEARISH_CONTINUATION',contiguousWindow(rows,30,sessionStartMinute,sessionCloseMinute),()=>detectContinuation(rows,'SHORT'));
  consider('FLAG_BREAKOUT_VOLUME',contiguousWindow(rows,30,sessionStartMinute,sessionCloseMinute),()=>detectFlagVolume(rows));
  consider('OPENING_RANGE_BREAKOUT',sessionRows.length>=1&&sessionContiguous,()=>detectOpeningRange(rows,sessionStartMinute,number(underlyingTick.price)));
  if(!candidates.length){
    if(!evaluated.length)return fail('No strategy had its required fresh, contiguous candle window; blocked: '+blocked.join(', '));
    return{status:'NO_TRADE',reason:'No eligible strategy confirmed a completed-candle setup',evaluatedStrategies:evaluated,blockedStrategies:blocked};
  }
  candidates.sort((a,b)=>a.confirmedAt-b.confirmedAt||STRATEGY_TIE_PRIORITY.indexOf(a.strategy)-STRATEGY_TIE_PRIORITY.indexOf(b.strategy));
  return{status:'UNDERLYING_SETUP_CONFIRMED',...candidates[0],underlyingPrice:number(underlyingTick.price),underlyingCandleTime:last.time};
}

export function evaluateNineStrategies({ underlyingCandles, underlyingTick, optionCandles, optionTick, contract, dailyCandles=[], isTopGainer=false, now=Date.now(), sessionStartMinute=555, sessionCloseMinute=930 }) {
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason});
  const tickFresh=t=>Boolean(t&&finite(t.price)&&number(t.price)>0&&finite(t.exchangeTime)&&finite(t.receivedAt)&&now-number(t.receivedAt)>=0&&now-number(t.receivedAt)<=10000&&now/1000-number(t.exchangeTime)>=-3&&now/1000-number(t.exchangeTime)<=10);
  const setup=detectNineStrategySetup({underlyingCandles,underlyingTick,dailyCandles,isTopGainer,now,sessionStartMinute,sessionCloseMinute});
  if(setup.status!=='UNDERLYING_SETUP_CONFIRMED')return setup;
  if(!tickFresh(optionTick))return fail('Fresh FYERS option premium tick is required');
  if(!contract||!['CE','PE'].includes(contract.side)||!finite(contract.tickSize)||number(contract.tickSize)<=0)return fail('Verified active CE/PE contract and tick size are required');
  const o=completed(optionCandles,optionTick,'Option premium');
  if(o.error)return fail(o.error);
  if(!contiguousWindow(o.rows,3,sessionStartMinute,sessionCloseMinute))return fail('Option premium needs only 3 contiguous completed 5-minute candles: prior level, breakout candle, and one confirmation/retest candle');
  const chosen=setup;
  if(contract.side!==(chosen.side==='LONG'?'CE':'PE'))return{status:'NO_TRADE',reason:'Option side does not match the verified underlying direction',strategy:chosen.strategy};
  const premiumRows=o.rows,tickSize=number(contract.tickSize);
  const prior=premiumRows.at(-2),reference=premiumRows.at(-1);
  // The underlying strategy already confirmed on a completed 5-minute candle.
  // Do not wait for a second option candle confirmation: trigger on a fresh live
  // option premium crossing the latest completed option candle high + one tick.
  const premiumLevel=number(reference.high);
  const entry=Number((Math.ceil((premiumLevel+tickSize-1e-9)/tickSize)*tickSize).toFixed(8));
  if(number(optionTick.price)+tickSize*1e-7<entry)return{status:'WAITING_FOR_OPTION_BREAKOUT',reason:'Underlying setup is confirmed; waiting for live option premium to break the latest completed 5-minute candle high + one tick',strategy:chosen.strategy,optionBreakoutLevel:premiumLevel};
  // Structural risk uses the last two completed option candles; the live quote is
  // the trigger. This removes the redundant extra 5-minute confirmation delay.
  const swingLow=Math.min(number(prior.low),number(reference.low));
  const plan=buildFixedPremiumPlan({breakoutLevel:premiumLevel,tickSize,livePremium:optionTick.price,swingLow});
  if(plan.status!=='SETUP_CONFIRMED')return{...plan,strategy:chosen.strategy};
  return{status:'SETUP_CONFIRMED',strategy:chosen.strategy,underlyingSide:chosen.side,optionSide:contract.side,breakoutLevel:chosen.breakoutLevel,optionBreakoutLevel:premiumLevel,entry:plan.entry,stopLoss:plan.stopLoss,target:plan.target,rr:plan.rr,confirmedAt:chosen.confirmedAt,optionCandleTime:reference.time,optionConfirmation:'LIVE_PREMIUM_BREAKOUT',contract:contract.symbol};
}
export function canAcceptStrategyTrade(activeTrades, candidateTrade, maxActive=MAX_ACTIVE_TRADES) {
  if(!Array.isArray(activeTrades)||!candidateTrade||!candidateTrade.underlying||!candidateTrade.contract)return{ok:false,reason:'Active trade state or candidate identity is invalid'};
  if(!Number.isInteger(maxActive)||maxActive<1||maxActive>MAX_ACTIVE_TRADES)return{ok:false,reason:'Maximum active trade limit cannot exceed two'};
  if(activeTrades.length>=maxActive)return{ok:false,reason:'Maximum of two simultaneous strategy trades reached'};
  const duplicate=activeTrades.some(t=>t&&((t.underlying&&t.underlying===candidateTrade.underlying)||(t.contract&&t.contract===candidateTrade.contract)));
  if(duplicate)return{ok:false,reason:'Duplicate underlying or option contract already has an active trade'};
  return{ok:true};
}
export { MAX_ACTIVE_TRADES, STRATEGIES };
