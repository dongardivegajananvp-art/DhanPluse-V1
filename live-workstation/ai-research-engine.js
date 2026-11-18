const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => Number(value);
function validCandle(c) {
  return c && ['time','open','high','low','close'].every(k=>finite(c[k])) &&
    num(c.time)>0 && num(c.open)>0 && num(c.high)>=Math.max(num(c.open),num(c.close),num(c.low)) &&
    num(c.low)<=Math.min(num(c.open),num(c.close)) && num(c.low)>0 && num(c.close)>0;
}
function ema(values,period) {
  if(values.length<period)return NaN;
  let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const alpha=2/(period+1);
  for(let i=period;i<values.length;i++)value=values[i]*alpha+value*(1-alpha);
  return value;
}
function mean(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : NaN; }
function contiguous(rows) {
  const w=rows.slice(-50);
  const parts=value=>{const d=new Date((num(value)+19800)*1000);return{day:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};};
  return w.length===50 && w.every((c,i)=>{
    if(i===0)return true;
    const previous=num(w[i-1].time),current=num(c.time);
    if(current-previous===300)return true;
    const a=parts(previous),b=parts(current);
    return a.minute===925&&b.minute===555&&b.day>a.day;
  });
}
function aligned(side, values, shortPeriod, longPeriod) {
  const eShort=ema(values,shortPeriod),eLong=ema(values,longPeriod),last=values.at(-1);
  return Number.isFinite(eShort)&&Number.isFinite(eLong)&&
    (side==='LONG'?last>eShort&&eShort>eLong:last<eShort&&eShort<eLong);
}
/**
 * Explainable, deterministic research layer. This is not an LLM prediction and
 * the score is setup quality, never a probability of profit.
 */
export function analyzeSetupResearch({candles=[],dailyCandles=[],tick,setup,marketRegime=null,now=Date.now()}={}) {
  const fail=reason=>({status:'INCOMPLETE',qualityScore:null,grade:'PENDING',scoreMeaning:'Quality score, not win probability',reason,evidence:[],riskFlags:[],missingEvidence:[reason],model:'GV2VPD_QUANT_RESEARCH_V1'});
  if(!Array.isArray(candles)||candles.some(c=>!validCandle(c))||candles.length<50||!contiguous(candles))
    return fail('50 contiguous completed FYERS 5-minute candles are required');
  if(!Array.isArray(dailyCandles)||dailyCandles.length<50||dailyCandles.some(c=>!validCandle(c)))
    return fail('50 completed FYERS daily candles are required for multi-timeframe research');
  if(!tick||!finite(tick.price)||num(tick.price)<=0||!finite(tick.receivedAt)||now-num(tick.receivedAt)<0||now-num(tick.receivedAt)>10000||
     !finite(tick.exchangeTime)||now/1000-num(tick.exchangeTime)<-3||now/1000-num(tick.exchangeTime)>10)
    return fail('Fresh exchange-timestamped underlying tick is required');
  if(!setup||!['LONG','SHORT'].includes(setup.side)||!finite(setup.breakoutLevel))
    return fail('Confirmed strategy direction and breakout level are required');

  const side=setup.side, rows=candles.slice(-50), daily=dailyCandles.slice(-50);
  const closes=rows.map(c=>num(c.close)),dailyCloses=daily.map(c=>num(c.close));
  const last=rows.at(-1),prior=rows.at(-4),dailyAligned=aligned(side,dailyCloses,20,50);
  const intradayAligned=aligned(side,closes,20,50);
  const emaNow=ema(closes,20),emaPrior=ema(closes.slice(0,-3),20);
  const emaSlopeAligned=Number.isFinite(emaNow)&&Number.isFinite(emaPrior)&&(side==='LONG'?emaNow>emaPrior:emaNow<emaPrior);
  const momentum=side==='LONG'?(num(last.close)>num(prior.close)&&emaSlopeAligned):(num(last.close)<num(prior.close)&&emaSlopeAligned);
  const candleRange=Math.max(num(last.high)-num(last.low),1e-9);
  const closeLocation=(num(last.close)-num(last.low))/candleRange;
  const breakoutQuality=side==='LONG'?num(last.close)>num(setup.breakoutLevel)&&closeLocation>=0.65:
    num(last.close)<num(setup.breakoutLevel)&&closeLocation<=0.35;
  const volumes=rows.slice(0,-1).slice(-20).map(c=>num(c.volume)).filter(Number.isFinite);
  const lastVolume=num(last.volume);
  const volumeKnown=volumes.length>=10&&Number.isFinite(lastVolume)&&lastVolume>0;
  const volumeExpansion=volumeKnown&&lastVolume>=mean(volumes)*1.2;
  const regimeDirection=String(marketRegime?.direction||marketRegime?.state||'').toUpperCase();
  const regimeKnown=Boolean(regimeDirection&&regimeDirection!=='UNAVAILABLE'&&regimeDirection!=='NONE');
  const regimeAligned=regimeKnown&&(regimeDirection===side||regimeDirection===(side==='LONG'?'BULLISH':'BEARISH'));
  const ranges=rows.slice(-21,-1).map(c=>num(c.high)-num(c.low)).filter(x=>Number.isFinite(x)&&x>0);
  const averageRange=mean(ranges),rangeRatio=averageRange>0?candleRange/averageRange:NaN;
  const volatilityDisciplined=Number.isFinite(rangeRatio)&&rangeRatio<=1.8;
  const components=[
    {key:'dailyTrend',label:'Daily trend alignment',weight:20,points:dailyAligned?20:0,pass:dailyAligned},
    {key:'intradayTrend',label:'5-minute EMA20/EMA50 alignment',weight:20,points:intradayAligned?20:0,pass:intradayAligned},
    {key:'momentum',label:'Recent momentum confirmation',weight:15,points:momentum?15:0,pass:momentum},
    {key:'breakout',label:'Breakout close quality',weight:15,points:breakoutQuality?15:0,pass:breakoutQuality},
    {key:'volume',label:'Volume expansion',weight:10,points:!volumeKnown?5:volumeExpansion?10:2,pass:volumeExpansion},
    {key:'marketRegime',label:'Index market-regime alignment',weight:10,points:!regimeKnown?5:regimeAligned?10:0,pass:regimeAligned},
    {key:'volatility',label:'Candle volatility discipline',weight:10,points:volatilityDisciplined?10:Number.isFinite(rangeRatio)&&rangeRatio<=2.5?6:2,pass:volatilityDisciplined}
  ];
  const qualityScore=components.reduce((sum,item)=>sum+item.points,0);
  const evidence=components.filter(x=>x.pass).map(x=>x.label);
  const riskFlags=components.filter(x=>!x.pass).map(x=>x.label+(x.key==='dailyTrend'?' conflicts with the setup direction':x.key==='marketRegime'&&regimeKnown?' conflicts with the index regime':' is not confirmed'));
  const missingEvidence=[];
  if(!volumeKnown)missingEvidence.push('Volume field is unavailable; volume score is neutral');
  if(!regimeKnown)missingEvidence.push('Fresh confirmed index market regime is unavailable; regime score is neutral');
  const grade=qualityScore>=85?'A+':qualityScore>=75?'A':qualityScore>=65?'B':qualityScore>=55?'C':'D';
  return {
    status:'COMPLETE',qualityScore,grade,scoreMeaning:'Research quality score out of 100; not a win probability',
    side,strategy:setup.strategy||null,components,evidence,riskFlags,missingEvidence,
    marketRegime:regimeKnown?regimeDirection:'UNAVAILABLE',
    evaluatedAt:new Date(now).toISOString(),source:'FYERS completed candles + fresh exchange timestamp',
    model:'GV2VPD_QUANT_RESEARCH_V1'
  };
}
