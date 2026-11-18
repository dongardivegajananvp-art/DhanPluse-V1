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
function sessionParts(value) {
  const d=new Date((num(value)+19800)*1000);
  return {day:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};
}
function resample15m(rows) {
  const groups=new Map();
  for(const candle of rows) {
    const part=sessionParts(candle.time);
    if(part.minute<555||part.minute>925)continue;
    const bucket=555+Math.floor((part.minute-555)/15)*15;
    const key=part.day+'|'+bucket;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(candle);
  }
  const output=[];
  for(const [key,items] of groups) {
    items.sort((a,b)=>num(a.time)-num(b.time));
    if(items.length!==3||num(items[1].time)-num(items[0].time)!==300||num(items[2].time)-num(items[1].time)!==300)continue;
    const volumes=items.map(x=>num(x.volume));
    output.push({time:num(items[0].time),open:num(items[0].open),high:Math.max(...items.map(x=>num(x.high))),
      low:Math.min(...items.map(x=>num(x.low))),close:num(items[2].close),
      ...(volumes.every(Number.isFinite)?{volume:volumes.reduce((a,b)=>a+b,0)}:{})});
  }
  return output.sort((a,b)=>a.time-b.time);
}
function contiguous15m(rows) {
  const w=rows.slice(-50);
  return w.length===50&&w.every((c,i)=>{
    if(i===0)return true;
    const previous=num(w[i-1].time),current=num(c.time);
    if(current-previous===900)return true;
    const a=sessionParts(previous),b=sessionParts(current);
    return a.minute===915&&b.minute===555&&b.day>a.day;
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
  const dailyLastTime=num(dailyCandles.at(-1).time),dailyAge=now/1000-dailyLastTime;
  if(dailyAge<0||dailyAge>4*86400)return fail('Latest completed FYERS daily candle is future-dated or stale');
  const fiveMinuteCloseTime=num(candles.at(-1).time)+300,fiveMinuteAge=now/1000-fiveMinuteCloseTime;
  if(fiveMinuteAge< -3||fiveMinuteAge>600)return fail('Latest completed FYERS 5-minute candle is future-dated or stale');
  if(!tick||!finite(tick.price)||num(tick.price)<=0||!finite(tick.receivedAt)||now-num(tick.receivedAt)<0||now-num(tick.receivedAt)>10000||
     !finite(tick.exchangeTime)||now/1000-num(tick.exchangeTime)<-3||now/1000-num(tick.exchangeTime)>10)
    return fail('Fresh exchange-timestamped underlying tick is required');
  if(!setup||!['LONG','SHORT'].includes(setup.side)||!finite(setup.breakoutLevel))
    return fail('Confirmed strategy direction and breakout level are required');

  const side=setup.side, rows=candles.slice(-50), daily=dailyCandles.slice(-50);
  const closes=rows.map(c=>num(c.close)),dailyCloses=daily.map(c=>num(c.close));
  const fifteenRows=resample15m(candles),fifteenWindow=fifteenRows.slice(-50);
  if(fifteenWindow.length<50||!contiguous15m(fifteenWindow))return fail('50 contiguous completed 15-minute candles derived from FYERS 5-minute data are required');
  const fifteenCloses=fifteenWindow.map(c=>num(c.close));
  const last=rows.at(-1),prior=rows.at(-4),dailyAligned=aligned(side,dailyCloses,20,50);
  const fifteenAligned=aligned(side,fifteenCloses,20,50);
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
  const regimeAt=Date.parse(marketRegime?.evaluatedAt||'');
  const regimeFresh=Number.isFinite(regimeAt)&&now-regimeAt>=0&&now-regimeAt<=15_000;
  const regimeDirection=regimeFresh?String(marketRegime?.direction||marketRegime?.state||'').toUpperCase():'';
  const regimeNeutral=regimeFresh&&regimeDirection==='NEUTRAL';
  const regimeKnown=Boolean(regimeDirection&&regimeDirection!=='UNAVAILABLE'&&regimeDirection!=='NONE'&&!regimeNeutral);
  const regimeAligned=regimeKnown&&(regimeDirection===side||regimeDirection===(side==='LONG'?'BULLISH':'BEARISH'));
  const ranges=rows.slice(-21,-1).map(c=>num(c.high)-num(c.low)).filter(x=>Number.isFinite(x)&&x>0);
  const averageRange=mean(ranges),rangeRatio=averageRange>0?candleRange/averageRange:NaN;
  const volatilityDisciplined=Number.isFinite(rangeRatio)&&rangeRatio<=1.8;
  const components=[
    {key:'dailyTrend',label:'Daily trend alignment',weight:15,points:dailyAligned?15:0,pass:dailyAligned},
    {key:'fifteenMinuteTrend',label:'15-minute EMA20/EMA50 alignment',weight:15,points:fifteenAligned?15:0,pass:fifteenAligned},
    {key:'intradayTrend',label:'5-minute EMA20/EMA50 alignment',weight:15,points:intradayAligned?15:0,pass:intradayAligned},
    {key:'momentum',label:'Recent 5-minute momentum confirmation',weight:15,points:momentum?15:0,pass:momentum},
    {key:'breakout',label:'Breakout close quality',weight:15,points:breakoutQuality?15:0,pass:breakoutQuality},
    {key:'volume',label:'Volume expansion',weight:10,points:!volumeKnown?5:volumeExpansion?10:2,pass:volumeExpansion},
    {key:'marketRegime',label:'Index market-regime alignment',weight:10,points:!regimeKnown?5:regimeAligned?10:0,pass:regimeAligned},
    {key:'volatility',label:'Candle volatility discipline',weight:5,points:volatilityDisciplined?5:Number.isFinite(rangeRatio)&&rangeRatio<=2.5?3:1,pass:volatilityDisciplined}
  ];
  const qualityScore=components.reduce((sum,item)=>sum+item.points,0);
  const evidence=components.filter(x=>x.pass).map(x=>x.label);
  const riskFlags=components.filter(x=>!x.pass).map(x=>x.label+(x.key==='dailyTrend'?' conflicts with the setup direction':x.key==='marketRegime'&&regimeKnown?' conflicts with the index regime':' is not confirmed'));
  const missingEvidence=[];
  if(!volumeKnown)missingEvidence.push('Volume field is unavailable; volume score is neutral');
  if(!regimeKnown)missingEvidence.push('Fresh verified index market regime is unavailable or stale; regime score is neutral');
  const grade=qualityScore>=85?'A+':qualityScore>=75?'A':qualityScore>=65?'B':qualityScore>=55?'C':'D';
  return {
    status:'COMPLETE',qualityScore,grade,scoreMeaning:'Research quality score out of 100; not a win probability',
    side,strategy:setup.strategy||null,components,evidence,riskFlags,missingEvidence,
    marketRegime:regimeKnown?regimeDirection:regimeNeutral?'NEUTRAL':'UNAVAILABLE',
    evaluatedAt:new Date(now).toISOString(),source:'FYERS completed candles + fresh exchange timestamp',
    model:'GV2VPD_QUANT_RESEARCH_V1'
  };
}


/**
 * Rank visible scanner candidates by research quality first. A confirmed plan
 * is only a tie-breaker; lifecycle status must not outrank better research.
 * Missing/incomplete research is deliberately placed after every scored result.
 */
export function rankResearchResults(results = []) {
  return [...(Array.isArray(results) ? results : [])].sort((a, b) => {
    const score = item => item?.research?.status === 'COMPLETE' && finite(item.research.qualityScore)
      ? num(item.research.qualityScore) : -1;
    const quality = score(b) - score(a);
    if (quality) return quality;
    const confirmed = Number(b?.status === 'PLAN_CONFIRMED_READ_ONLY') - Number(a?.status === 'PLAN_CONFIRMED_READ_ONLY');
    if (confirmed) return confirmed;
    const rr = (Number(b?.rr) || 0) - (Number(a?.rr) || 0);
    if (rr) return rr;
    return String(b?.verifiedAt || b?.updatedAt || '').localeCompare(String(a?.verifiedAt || a?.updatedAt || ''));
  });
}
