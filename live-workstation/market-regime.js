const INDEX_SYMBOLS = Object.freeze(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX']);
function finite(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));}
function istParts(seconds){
 const date=new Date((Number(seconds)+19800)*1000);
 return {day:date.toISOString().slice(0,10),minute:date.getUTCHours()*60+date.getUTCMinutes()};
}
function contiguous(previous,current){
 if(Number(current.time)-Number(previous.time)===300)return true;
 const a=istParts(previous.time),b=istParts(current.time);
 return a.minute===925&&b.minute===555&&b.day>a.day;
}
function validCandle(c){
 return c&&['time','open','high','low','close'].every(k=>finite(c[k]))&&
  Number(c.time)>0&&Number(c.open)>0&&Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low))&&
  Number(c.low)<=Math.min(Number(c.open),Number(c.close))&&Number(c.low)>0&&Number(c.close)>0;
}
function ema(values,period){
 if(values.length<period)return NaN;
 let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
 const alpha=2/(period+1);
 for(let i=period;i<values.length;i++)value=values[i]*alpha+value*(1-alpha);
 return value;
}
export function unavailableMarketRegime(reason='Fresh index candles are unavailable'){
 return {state:'UNAVAILABLE',direction:'NONE',reason,confirmedIndexes:[],indexes:{},evaluatedAt:null,source:'FYERS 5-minute candles + fresh exchange ticks'};
}
export function evaluateIndexMarketRegime({candles={},ticks={},now=Date.now()}={}){
 const details={};const directions=[];
 for(const symbol of INDEX_SYMBOLS){
  const rows=Array.isArray(candles[symbol])?candles[symbol].filter(validCandle):[];
  const tick=ticks[symbol];
  const tickFresh=Boolean(tick&&finite(tick.price)&&Number(tick.price)>0&&finite(tick.exchangeTime)&&finite(tick.receivedAt)&&
   now-Number(tick.receivedAt)>=0&&now-Number(tick.receivedAt)<=10000&&
   now/1000-Number(tick.exchangeTime)>=-3&&now/1000-Number(tick.exchangeTime)<=10);
  if(!tickFresh){details[symbol]={state:'UNAVAILABLE',reason:'Fresh exchange tick missing or stale'};continue;}
  if(rows.length<50){details[symbol]={state:'UNAVAILABLE',reason:'At least 50 valid 5-minute candles are required'};continue;}
  const window=rows.slice(-50);
  if(!window.every((c,i)=>i===0||contiguous(window[i-1],c))){
   details[symbol]={state:'UNAVAILABLE',reason:'Latest 50-candle EMA window contains a missing intraday interval'};continue;
  }
  const age=now/1000-Number(window.at(-1).time);
  if(age<300||age>600){details[symbol]={state:'UNAVAILABLE',reason:'Latest completed 5-minute candle is stale'};continue;}
  const closes=window.map(c=>Number(c.close));
  const e20=ema(closes,20),e50=ema(closes,50),last=closes.at(-1),prior=closes.at(-4);
  const direction=last>e20&&e20>e50&&last>prior?'BULLISH':
   last<e20&&e20<e50&&last<prior?'BEARISH':'NEUTRAL';
  details[symbol]={state:direction,close:last,ema20:Number(e20.toFixed(4)),ema50:Number(e50.toFixed(4)),exchangeTime:new Date(Number(tick.exchangeTime)*1000).toISOString(),candleTime:new Date(Number(window.at(-1).time)*1000).toISOString()};
  directions.push(direction);
 }
 if(directions.length!==INDEX_SYMBOLS.length){
  return {state:'UNAVAILABLE',direction:'NONE',reason:'All three index feeds need fresh exchange ticks and contiguous completed 5-minute candles',confirmedIndexes:directions,indexes:details,evaluatedAt:new Date(now).toISOString(),source:'FYERS 5-minute candles + fresh exchange ticks'};
 }
 const bullish=directions.filter(x=>x==='BULLISH').length;
 const bearish=directions.filter(x=>x==='BEARISH').length;
 const direction=bullish>=2?'BULLISH':bearish>=2?'BEARISH':'NEUTRAL';
 return {state:direction,direction,reason:direction==='NEUTRAL'?'No 2-of-3 index trend alignment':'Confirmed by at least two of three indexes',confirmedIndexes:directions,indexes:details,evaluatedAt:new Date(now).toISOString(),source:'FYERS 5-minute candles + fresh exchange ticks'};
}
