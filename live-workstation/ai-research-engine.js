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
function contiguousSuffixDiagnostics(rows, intervalSeconds=300) {
  if(!Array.isArray(rows)||!rows.length)return{count:0,gap:null};
  const parts=value=>{const d=new Date((num(value)+19800)*1000);return{day:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes(),label:d.toISOString().replace('T',' ').slice(0,16)+' UTC+05:30'};};
  for(let i=rows.length-1;i>0;i--){
    const previous=num(rows[i-1].time),current=num(rows[i].time);
    if(current-previous===intervalSeconds)continue;
    const a=parts(previous),b=parts(current);
    const sessionBoundary=intervalSeconds===300
      ?a.minute===925&&b.minute===555&&b.day>a.day
      :intervalSeconds===900&&a.minute===915&&b.minute===555&&b.day>a.day;
    if(sessionBoundary)continue;
    return{count:rows.length-i,gap:{previousTime:previous,currentTime:current,gapSeconds:current-previous,previousIst:a.label,currentIst:b.label}};
  }
  return{count:rows.length,gap:null};
}
function contiguousSuffixCount(rows, intervalSeconds=300) { return contiguousSuffixDiagnostics(rows,intervalSeconds).count; }
function describeHistoryGap(gap) {
  return gap?'; latest gap '+gap.previousIst+' -> '+gap.currentIst+' ('+gap.gapSeconds+'s)':'';
}
function contiguous(rows) { return contiguousSuffixCount(rows,300)>=50; }
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
function contiguous15m(rows) { return contiguousSuffixCount(rows,900)>=50; }

function nearestZones(rows, price) {
  const demand=[],supply=[];
  for(let i=2;i<rows.length-2;i++){
    const candle=rows[i],bodyLow=Math.min(num(candle.open),num(candle.close)),bodyHigh=Math.max(num(candle.open),num(candle.close));
    const pivotLow=rows.slice(i-2,i+3).every((x,j)=>j===2||num(candle.low)<num(x.low));
    const pivotHigh=rows.slice(i-2,i+3).every((x,j)=>j===2||num(candle.high)>num(x.high));
    if(pivotLow)demand.push({low:num(candle.low),high:bodyHigh,mid:(num(candle.low)+bodyHigh)/2});
    if(pivotHigh)supply.push({low:bodyLow,high:num(candle.high),mid:(bodyLow+num(candle.high))/2});
  }
  const below=demand.filter(z=>z.mid<=price).sort((a,b)=>b.mid-a.mid)[0]||null;
  const above=supply.filter(z=>z.mid>=price).sort((a,b)=>a.mid-b.mid)[0]||null;
  const pct=z=>z?Number((Math.abs(price-z.mid)/price*100).toFixed(3)):null;
  return {demand:below?{...below,distancePct:pct(below)}:null,supply:above?{...above,distancePct:pct(above)}:null};
}
function pullbackRetestEvidence(rows, setup) {
  const strategy=String(setup?.strategy||'');
  const required=/RETEST|PULLBACK|OPENING_RANGE/.test(strategy);
  if(!required)return {applicable:false,score:5,quality:'NOT_REQUIRED',reason:'This strategy does not require a separate retest/pullback'};
  const level=num(setup.breakoutLevel),side=setup.side,window=rows.slice(-9,-1);
  const held=window.some(c=>side==='LONG'
    ?num(c.low)<=level*1.003&&num(c.close)>=level*0.995
    :num(c.high)>=level*0.997&&num(c.close)<=level*1.005);
  const invalidated=window.some(c=>side==='LONG'?num(c.close)<level*0.992:num(c.close)>level*1.008);
  if(held&&!invalidated)return {applicable:true,score:10,quality:'RETEST_HELD',reason:'Breakout level was retested and held on completed candles'};
  if(held&&invalidated)return {applicable:true,score:2,quality:'RETEST_INVALIDATED',reason:'A retest occurred but a completed candle invalidated the level'};
  return {applicable:true,score:3,quality:'RETEST_NOT_CONFIRMED',reason:'No clean completed-candle retest/hold was found'};
}
function earlyInvalidation(rows, side) {
  const recent=rows.slice(-5);
  return side==='LONG'?Math.min(...recent.map(c=>num(c.low))):Math.max(...recent.map(c=>num(c.high)));
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
  if(!Array.isArray(candles)||candles.some(c=>!validCandle(c))||!contiguous(candles)){
    const diagnostic=contiguousSuffixDiagnostics(candles,300);
    return fail('50 contiguous completed FYERS 5-minute candles are required; received '+(Array.isArray(candles)?candles.length:0)+' valid rows, contiguous suffix '+diagnostic.count+describeHistoryGap(diagnostic.gap));
  }
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
  const fifteenRows=resample15m(candles),fifteenWindow=fifteenRows.slice(-50),fifteenDiagnostic=contiguousSuffixDiagnostics(fifteenRows,900);
  if(fifteenWindow.length<50||!contiguous15m(fifteenWindow))return fail('50 contiguous completed 15-minute candles derived from FYERS 5-minute data are required; derived '+fifteenRows.length+', contiguous suffix '+fifteenDiagnostic.count+describeHistoryGap(fifteenDiagnostic.gap));
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
  const zones=nearestZones(rows,num(tick.price));
  const alignedZone=side==='LONG'?zones.demand:zones.supply;
  const zoneDistance=alignedZone?.distancePct??null;
  const zonePoints=zoneDistance===null?5:zoneDistance<=1?10:zoneDistance<=2?7:3;
  const retest=pullbackRetestEvidence(rows,setup);
  const components=[
    {key:'dailyTrend',label:'Daily trend alignment',weight:12,points:dailyAligned?12:0,pass:dailyAligned},
    {key:'fifteenMinuteTrend',label:'15-minute EMA20/EMA50 alignment',weight:12,points:fifteenAligned?12:0,pass:fifteenAligned},
    {key:'intradayTrend',label:'5-minute EMA20/EMA50 alignment',weight:12,points:intradayAligned?12:0,pass:intradayAligned},
    {key:'momentum',label:'Recent 5-minute momentum confirmation',weight:12,points:momentum?12:0,pass:momentum},
    {key:'breakout',label:'Breakout close quality',weight:12,points:breakoutQuality?12:0,pass:breakoutQuality},
    {key:'volume',label:'Volume expansion',weight:8,points:!volumeKnown?4:volumeExpansion?8:1,pass:volumeExpansion},
    {key:'marketRegime',label:'Index market-regime alignment',weight:8,points:!regimeKnown?4:regimeAligned?8:0,pass:regimeAligned},
    {key:'volatility',label:'Candle volatility discipline',weight:4,points:volatilityDisciplined?4:Number.isFinite(rangeRatio)&&rangeRatio<=2.5?2:0,pass:volatilityDisciplined},
    {key:'supplyDemand',label:'Supply/demand zone context',weight:10,points:zonePoints,pass:zoneDistance!==null&&zoneDistance<=1},
    {key:'pullbackRetest',label:'Pullback/retest quality',weight:10,points:retest.score,pass:retest.quality==='RETEST_HELD'}
  ];
  const qualityScore=components.reduce((sum,item)=>sum+item.points,0);
  const evidence=components.filter(x=>x.pass).map(x=>x.label);
  const riskFlags=components.filter(x=>!x.pass&&!(x.key==='pullbackRetest'&&!retest.applicable)).map(x=>x.label+(x.key==='dailyTrend'?' conflicts with the setup direction':x.key==='marketRegime'&&regimeKnown?' conflicts with the index regime':' is not confirmed'));
  const missingEvidence=[];
  if(!volumeKnown)missingEvidence.push('Volume field is unavailable; volume score is neutral');
  if(!regimeKnown)missingEvidence.push('Fresh verified index market regime is unavailable or stale; regime score is neutral');
  if(!alignedZone)missingEvidence.push('No confirmed nearby '+(side==='LONG'?'demand':'supply')+' pivot zone in the available FYERS candle window');
  if(retest.applicable&&retest.quality!=='RETEST_HELD')missingEvidence.push(retest.reason);
  const grade=qualityScore>=85?'A+':qualityScore>=75?'A':qualityScore>=65?'B':qualityScore>=55?'C':'D';
  return {
    status:'COMPLETE',qualityScore,grade,scoreMeaning:'Research quality score out of 100; not a win probability',
    side,strategy:setup.strategy||null,components,evidence,riskFlags,missingEvidence,
    zones,
    zoneContext:{alignedZone:side==='LONG'?'DEMAND':'SUPPLY',distancePct:zoneDistance,scorePoints:zonePoints,source:'FYERS completed 5-minute OHLC pivot zones'},
    pullbackRetest:retest,
    earlyConfirmation:{triggerLevel:num(setup.breakoutLevel),invalidationReference:earlyInvalidation(rows,side),note:'Research reference only; does not modify fixed option Entry/SL/Target/RR'},
    marketRegime:regimeKnown?regimeDirection:regimeNeutral?'NEUTRAL':'UNAVAILABLE',
    evaluatedAt:new Date(now).toISOString(),source:'FYERS completed candles + fresh exchange timestamp',
    model:'GV2VPD_QUANT_RESEARCH_V2'
  };
}
export function analyzeEarlyWatch({candles=[],dailyCandles=[],tick,now=Date.now()}={}) {
  const incomplete=reason=>({status:'INCOMPLETE',reason});
  if(!Array.isArray(candles)||candles.some(c=>!validCandle(c))||!contiguous(candles)){
    const diagnostic=contiguousSuffixDiagnostics(candles,300);
    return incomplete('50 contiguous completed FYERS 5-minute candles are required for early watch; received '+(Array.isArray(candles)?candles.length:0)+' valid rows, contiguous suffix '+diagnostic.count+describeHistoryGap(diagnostic.gap));
  }
  if(!Array.isArray(dailyCandles)||dailyCandles.length<50||dailyCandles.some(c=>!validCandle(c)))return incomplete('50 completed FYERS daily candles are required for early watch trend context');
  const dailyAge=now/1000-num(dailyCandles.at(-1).time);
  if(dailyAge<0||dailyAge>4*86400)return incomplete('Latest completed FYERS daily candle is stale or future-dated');
  if(!tick||!finite(tick.price)||num(tick.price)<=0||!finite(tick.receivedAt)||now-num(tick.receivedAt)<0||now-num(tick.receivedAt)>10000||!finite(tick.exchangeTime)||now/1000-num(tick.exchangeTime)<-3||now/1000-num(tick.exchangeTime)>10)return incomplete('Fresh exchange-timestamped underlying tick is required for early watch');
  const rows=candles.slice(-50),closes=rows.map(c=>num(c.close)),dailyCloses=dailyCandles.slice(-50).map(c=>num(c.close));
  const e20=ema(closes,20),e50=ema(closes,50),d20=ema(dailyCloses,20),d50=ema(dailyCloses,50),price=num(tick.price);
  const fifteenRows=resample15m(candles),fifteenWindow=fifteenRows.slice(-50),fifteenSuffix=contiguousSuffixCount(fifteenRows,900);
  if(fifteenWindow.length<50||!contiguous15m(fifteenWindow))return incomplete('50 contiguous completed 15-minute candles derived from FYERS 5-minute data are required for early watch; derived '+fifteenRows.length+', contiguous suffix '+fifteenSuffix);
  const fifteenCloses=fifteenWindow.map(c=>num(c.close)),m20=ema(fifteenCloses,20),m50=ema(fifteenCloses,50);
  const side=price>e20&&e20>e50&&d20>d50&&fifteenCloses.at(-1)>m20&&m20>m50?'LONG':
    price<e20&&e20<e50&&d20<d50&&fifteenCloses.at(-1)<m20&&m20<m50?'SHORT':null;
  if(!side)return {status:'NONE',reason:'No aligned daily and 5-minute trend for an early watch'};
  const prior=rows.slice(-21,-1);
  const level=side==='LONG'?Math.max(...prior.map(c=>num(c.high))):Math.min(...prior.map(c=>num(c.low)));
  const distance=side==='LONG'?(level-price)/level*100:(price-level)/level*100;
  const lastCompletedClose=num(rows.at(-1).close);
  if(side==='LONG'&&lastCompletedClose>=level||side==='SHORT'&&lastCompletedClose<=level)
    return {status:'NONE',reason:'Latest completed candle has already crossed the watch trigger; confirmed setup logic must decide next'};
  if(!(distance>=0&&distance<=0.35))return {status:'NONE',reason:'Price is not within 0.35% of a verified 20-candle breakout level'};
  const zones=nearestZones(rows,price);
  return {status:'WATCH',side,breakoutLevel:level,triggerDistancePct:Number(distance.toFixed(3)),
    invalidationReference:earlyInvalidation(rows,side),zones,
    research:{status:'WATCH',grade:'EARLY',qualityScore:null,scoreMeaning:'Early watch only; not a confirmed setup or win probability',
      evidence:['Fresh exchange-timestamped underlying tick','Daily, 15-minute and 5-minute EMA20/EMA50 alignment','Price within 0.35% of prior 20-candle range'],
      riskFlags:['Breakout and option confirmation are not complete'],missingEvidence:['Completed-candle breakout confirmation','Fresh verified option quote and option candles'],
      model:'GV2VPD_QUANT_RESEARCH_V2',source:'FYERS completed candles + fresh exchange timestamp',
      earlyConfirmation:{triggerLevel:level,invalidationReference:earlyInvalidation(rows,side),triggerDistancePct:Number(distance.toFixed(3))},zones}
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
    const watchDistance = item => item?.status === 'EARLY_WATCH' && finite(item.triggerDistancePct) ? num(item.triggerDistancePct) : Infinity;
    const watchOrder = watchDistance(a) - watchDistance(b);
    if (Number.isFinite(watchOrder) && watchOrder) return watchOrder;
    const rr = (Number(b?.rr) || 0) - (Number(a?.rr) || 0);
    if (rr) return rr;
    return String(b?.verifiedAt || b?.updatedAt || '').localeCompare(String(a?.verifiedAt || a?.updatedAt || ''));
  });
}
