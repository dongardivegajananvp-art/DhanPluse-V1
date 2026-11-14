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
  'OPENING_RANGE_15M_RETEST'
]);

function finite(value) { return Number.isFinite(Number(value)); }
function number(value) { return Number(value); }
function validOhlcv(c) {
  return c && ['time','open','high','low','close'].every(k => finite(c[k])) &&
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
function atr14(candles) {
  if (candles.length < 15) return NaN;
  const rows = candles.slice(-14);
  const ranges = rows.map((c, i) => {
    const prev = candles[candles.length - 15 + i];
    const pc = prev ? number(prev.close) : number(c.close);
    return Math.max(number(c.high)-number(c.low), Math.abs(number(c.high)-pc), Math.abs(number(c.low)-pc));
  });
  return ranges.reduce((a,b)=>a+b,0)/ranges.length;
}
function istDayKey(seconds) {
  return new Date((seconds + 19800) * 1000).toISOString().slice(0,10);
}
function completed(candles, tick, label) {
  if (!Array.isArray(candles) || candles.some(c => !validOhlcv(c))) {
    return { error: label + ' candles are missing or malformed' };
  }
  const window = getCompletedCandleWindow(candles, tick.exchangeTime);
  if (!window.fresh) return { error: label + ' latest completed candle is stale' };
  if (!window.contiguous || window.completed.length < 51) return { error: label + ' requires at least 51 contiguous completed 5-minute candles' };
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
function detectDoublePattern(rows) {
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
    if(hadBreak&&number(last.low)<=neck*1.002&&number(last.close)<neck&&prior.some(x=>number(x.close)<neck))
      return candidate('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','SHORT',neck,last,{pattern:'DOUBLE_TOP'});
  }
  for(let a=0;a<lows.length;a++)for(let b=a+1;b<lows.length;b++){
    const i=lows[a],j=lows[b],l1=number(rows[i].low),l2=number(rows[j].low);
    if(j-i<4||Math.abs(l1-l2)/Math.max(l1,l2)>0.003)continue;
    const neck=Math.max(...rows.slice(i,j+1).map(x=>number(x.high)));
    const hadBreak=rows.slice(j+1,-1).some(x=>number(x.close)>neck);
    if(hadBreak&&number(last.high)>=neck*0.998&&number(last.close)>neck&&prior.some(x=>number(x.close)>neck))
      return candidate('DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','LONG',neck,last,{pattern:'DOUBLE_BOTTOM'});
  }
  return null;
}
function detectContinuation(rows, side) {
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
function detectFlagVolume(rows) {
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
function detectOpeningRange(rows) {
  const key=istDayKey(number(rows.at(-1).time));
  const day=rows.filter(c=>istDayKey(number(c.time))===key);
  if(day.length<5)return null;
  const opening=day.filter(c=>{
    const t=new Date((number(c.time)+19800)*1000);
    const mins=t.getUTCHours()*60+t.getUTCMinutes();
    return mins>=555&&mins<570;
  });
  if(opening.length!==3)return null;
  const high=Math.max(...opening.map(c=>number(c.high))),low=Math.min(...opening.map(c=>number(c.low)));
  const later=day.filter(c=>number(c.time)>number(opening.at(-1).time));
  const last=rows.at(-1), prior=later.slice(0,-1);
  if(!prior.length)return null;
  const brokeHigh=prior.some(c=>number(c.close)>high);
  const brokeLow=prior.some(c=>number(c.close)<low);
  if(brokeHigh&&number(last.low)<=high*1.002&&number(last.close)>high)return candidate('OPENING_RANGE_15M_RETEST','LONG',high,last);
  if(brokeLow&&number(last.high)>=low*0.998&&number(last.close)<low)return candidate('OPENING_RANGE_15M_RETEST','SHORT',low,last);
  return null;
}
function detectDayHighLowRetest(rows) {
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
export function buildFixedPremiumPlan({ breakoutLevel, tickSize, livePremium, swingLow, atr, priorResistances=[] }) {
  const values=[breakoutLevel,tickSize,livePremium,swingLow,atr];
  if(!values.every(finite)||values.some(v=>number(v)<=0))return{status:'NO_TRADE',reason:'Breakout, tick size, live premium, swing low and ATR must be positive'};
  const step=number(tickSize);
  const entry=Number((Math.ceil((number(breakoutLevel)+step-1e-9)/step)*step).toFixed(8));
  const stopLoss=Number((Math.floor((number(swingLow)-0.5*number(atr)+1e-9)/step)*step).toFixed(8));
  const risk=entry-stopLoss;
  if(!(risk>=step))return{status:'NO_TRADE',reason:'Swing-low minus half ATR does not leave positive option-premium risk'};
  if(number(livePremium)+step*1e-7<entry)return{status:'NO_TRADE',reason:'Live option premium has not reached breakout level + one tick'};
  if(number(livePremium)>entry+0.5*risk+step*1e-7)return{status:'NO_TRADE',reason:'Option premium moved more than 0.5R beyond entry; chase blocked'};
  const target=Number((entry+2*risk).toFixed(8));
  const liveRisk=number(livePremium)-stopLoss;
  const liveReward=target-number(livePremium);
  const liveRr=liveReward/liveRisk;
  if(!(liveRisk>0&&liveReward>0&&liveRr>=2-1e-9))return{status:'NO_TRADE',reason:'Live option premium no longer supports fixed 1:2 reward/risk'};
  if(priorResistances.some(level=>finite(level)&&number(level)>entry&&number(level)<target))return{status:'NO_TRADE',reason:'Verified resistance lies before the fixed 2R target'};
  return{status:'SETUP_CONFIRMED',entry,stopLoss,target,rr:Number(liveRr.toFixed(2)),risk};
}

export function evaluateNineStrategies({ underlyingCandles, underlyingTick, optionCandles, optionTick, contract, dailyCandles=[], isTopGainer=false, now=Date.now() }) {
  const fail=(reason)=>({status:'DATA_UNAVAILABLE_NO_TRADE',reason});
  const tickFresh=t=>Boolean(t&&finite(t.price)&&number(t.price)>0&&finite(t.exchangeTime)&&finite(t.receivedAt)&&now-number(t.receivedAt)>=0&&now-number(t.receivedAt)<=10000&&now/1000-number(t.exchangeTime)>=-3&&now/1000-number(t.exchangeTime)<=10);
  if(!tickFresh(underlyingTick))return fail('Fresh FYERS underlying/futures tick is required');
  if(!tickFresh(optionTick))return fail('Fresh FYERS option premium tick is required');
  if(!contract||!['CE','PE'].includes(contract.side)||!finite(contract.tickSize)||number(contract.tickSize)<=0)return fail('Verified active CE/PE contract and tick size are required');
  const u=completed(underlyingCandles,underlyingTick,'Underlying');
  if(u.error)return fail(u.error);
  const o=completed(optionCandles,optionTick,'Option premium');
  if(o.error)return fail(o.error);
  const rows=u.rows,last=u.last,closes=rows.map(c=>number(c.close));
  const e20=ema(closes,20),e50=ema(closes,50),prior=rows.at(-2);
  const candidates=[];
  if(e20>e50&&number(last.close)>e20&&number(last.close)>number(prior.high))
    candidates.push(candidate(STRATEGIES[0],'LONG',number(prior.high),last));
  if(e20<e50&&number(last.close)<e20&&number(last.close)<number(prior.low))
    candidates.push(candidate(STRATEGIES[0],'SHORT',number(prior.low),last));
  if(isTopGainer&&number(last.close)>number(prior.high))
    candidates.push(candidate(STRATEGIES[1],'LONG',number(prior.high),last));
  const dailyCloses=dailyCandles.filter(validOhlcv).map(c=>number(c.close));
  if(dailyCloses.length>=51){
    const d20=ema(dailyCloses,20),d50=ema(dailyCloses,50);
    const p=rows.at(-2),touch=number(p.low)<=e20*1.003&&number(p.high)>=e20*0.997;
    if(d20>d50&&e20>e50&&touch&&number(last.close)>number(p.high))candidates.push(candidate(STRATEGIES[2],'LONG',number(p.high),last));
    if(d20<d50&&e20<e50&&touch&&number(last.close)<number(p.low))candidates.push(candidate(STRATEGIES[2],'SHORT',number(p.low),last));
  }
  const dayRetest=detectDayHighLowRetest(rows);if(dayRetest)candidates.push(dayRetest);
  const double=detectDoublePattern(rows);if(double)candidates.push(double);
  const bull=detectContinuation(rows,'LONG');if(bull)candidates.push(bull);
  const bear=detectContinuation(rows,'SHORT');if(bear)candidates.push(bear);
  const flag=detectFlagVolume(rows);if(flag)candidates.push(flag);
  const orb=detectOpeningRange(rows);if(orb)candidates.push(orb);
  if(!candidates.length)return{status:'NO_TRADE',reason:'None of the nine completed-candle strategies confirmed a setup'};
  candidates.sort((a,b)=>a.confirmedAt-b.confirmedAt||STRATEGIES.indexOf(a.strategy)-STRATEGIES.indexOf(b.strategy));
  const chosen=candidates[0];
  if(contract.side!==(chosen.side==='LONG'?'CE':'PE'))return{status:'NO_TRADE',reason:'Option side does not match the verified underlying direction',strategy:chosen.strategy};
  const premiumRows=o.rows, premiumLast=o.last, tickSize=number(contract.tickSize);
  const premiumLevel=Math.max(...premiumRows.slice(-21,-1).map(c=>number(c.high)));
  if(!(number(premiumLast.close)>premiumLevel))return{status:'NO_TRADE',reason:'Underlying setup confirmed, but option premium has no completed breakout confirmation',strategy:chosen.strategy};
  const atr=atr14(premiumRows);
  if(!Number.isFinite(atr)||atr<=0)return fail('Option premium ATR(14) is unavailable');
  const swing=premiumRows.slice(-5);
  const swingLow=Math.min(...swing.map(c=>number(c.low)));
  const olderPremiumRows=premiumRows.slice(0,-21);
  const resistances=olderPremiumRows.filter((c,i,a)=>i>1&&i<a.length-2&&pivotHigh(a,i,1)).map(c=>number(c.high));
  const plan=buildFixedPremiumPlan({breakoutLevel:premiumLevel,tickSize,livePremium:optionTick.price,swingLow,atr,priorResistances:resistances});
  if(plan.status!=='SETUP_CONFIRMED')return{...plan,strategy:chosen.strategy};
  return{status:'SETUP_CONFIRMED',strategy:chosen.strategy,underlyingSide:chosen.side,optionSide:contract.side,breakoutLevel:chosen.breakoutLevel,optionBreakoutLevel:premiumLevel,entry:plan.entry,stopLoss:plan.stopLoss,target:plan.target,rr:plan.rr,atr14:Number(atr.toFixed(4)),confirmedAt:chosen.confirmedAt,optionCandleTime:premiumLast.time,contract:contract.symbol};
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
