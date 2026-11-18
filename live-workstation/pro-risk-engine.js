const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const n = value => Number(value);
const floorTick = (value, tick) => Number((Math.floor((value + tick * 1e-8) / tick) * tick).toFixed(8));
const ceilTick = (value, tick) => Number((Math.ceil((value - tick * 1e-8) / tick) * tick).toFixed(8));

function atr14(rows) {
  if (!Array.isArray(rows) || rows.length < 15) return NaN;
  const ranges=[];
  for(let i=1;i<rows.length;i++){
    const high=n(rows[i].high),low=n(rows[i].low),previous=n(rows[i-1].close);
    ranges.push(Math.max(high-low,Math.abs(high-previous),Math.abs(low-previous)));
  }
  const recent=ranges.slice(-14);
  return recent.length===14&&recent.every(Number.isFinite)?recent.reduce((a,b)=>a+b,0)/14:NaN;
}
function pivots(rows, key, direction) {
  const result=[];
  for(let i=Math.max(2,rows.length-18);i<rows.length-2;i++){
    const value=n(rows[i][key]);
    if(!Number.isFinite(value))continue;
    const left=rows.slice(i-2,i),right=rows.slice(i+1,i+3);
    const isPivot=direction==='LOW'
      ?left.every(c=>value<n(c.low))&&right.every(c=>value<=n(c.low))
      :left.every(c=>value>n(c.high))&&right.every(c=>value>=n(c.high));
    if(isPivot)result.push({index:i,price:value,time:rows[i].time});
  }
  return result;
}
export function wilsonLowerBound(wins, losses, z=1.96) {
  const w=Math.max(0,Math.trunc(Number(wins)||0)),l=Math.max(0,Math.trunc(Number(losses)||0)),total=w+l;
  if(!total)return null;
  const p=w/total,z2=z*z,denominator=1+z2/total;
  const centre=p+z2/(2*total),margin=z*Math.sqrt((p*(1-p)+z2/(4*total))/total);
  return Math.max(0,(centre-margin)/denominator);
}
export function estimateTargetHitConfidence(stats={}) {
  const wins=Math.max(0,Math.trunc(Number(stats.wins)||0)),losses=Math.max(0,Math.trunc(Number(stats.losses)||0)),samples=wins+losses;
  const rate=samples?wins/samples:null,lower=wilsonLowerBound(wins,losses);
  if(samples<30)return{status:'UNCALIBRATED',samples,wins,losses,hitRate:null,lowerBound:null,reason:'At least 30 completed NSE outcomes in the comparable strategy/RR bucket are required; no probability claim is made'};
  if(lower===null||lower<0.50)return{status:'LOW_CONFIDENCE',samples,wins,losses,hitRate:Number((rate*100).toFixed(1)),lowerBound:Number(((lower||0)*100).toFixed(1)),reason:'Conservative 95% lower confidence bound does not clear the internal 50% research-confidence floor; this is not the 1:2 reward/risk break-even threshold'};
  return{status:'CALIBRATED',samples,wins,losses,hitRate:Number((rate*100).toFixed(1)),lowerBound:Number((lower*100).toFixed(1)),reason:'Historical NSE target/stop outcomes; confidence bound, not a guarantee'};
}

/**
 * NSE-only adaptive option-premium risk plan. It chooses the tightest defensible
 * structural stop, rejects noise-tight/wide stops, and places target before the
 * nearest verified overhead supply pivot while preserving >=1:2 RR.
 * This is deterministic risk research, not an LLM or guaranteed prediction.
 */
export function buildProRiskPlan({candles=[],entry,tickSize,livePremium,side='LONG',outcomeStats={}}={}) {
  const fail=reason=>({status:'NO_TRADE',reason,model:'GV2VPD_NSE_PRO_RISK_V1'});
  if(!Array.isArray(candles)||candles.length<20||candles.some(c=>!['open','high','low','close'].every(k=>finite(c[k])&&n(c[k])>0)))return fail('At least 20 valid completed FYERS option candles are required for Pro risk research');
  if(![entry,tickSize,livePremium].every(finite)||n(entry)<=0||n(tickSize)<=0||n(livePremium)<=0)return fail('Fresh option entry, tick size and live premium are required');
  const rows=candles.slice(-30),step=n(tickSize),trigger=ceilTick(n(entry),step),premium=n(livePremium),atr=atr14(rows);
  if(!Number.isFinite(atr)||atr<=0)return fail('Option ATR(14) cannot be verified from completed candles');
  if(premium+step*1e-7<trigger)return fail('Live option premium has not reached the verified breakout entry');
  const lows=pivots(rows,'low','LOW'),highs=pivots(rows,'high','HIGH');
  const structuralLow=lows.filter(p=>p.price<trigger).sort((a,b)=>b.price-a.price)[0]||{price:Math.min(...rows.slice(-5).map(c=>n(c.low))),time:rows.at(-1).time};
  const stopBuffer=Math.max(step,atr*0.12);
  let stop=floorTick(structuralLow.price-stopBuffer,step);
  const minimumNoiseRisk=Math.max(step*2,atr*0.25);
  let risk=trigger-stop;
  if(risk<minimumNoiseRisk){risk=ceilTick(minimumNoiseRisk,step);stop=floorTick(trigger-risk,step);risk=trigger-stop;}
  const maximumRisk=Math.max(step*2,atr*1.5);
  if(!(risk>=step&&risk<=maximumRisk))return fail('Structural stop is too wide versus option ATR(14); risk cap exceeded, so the setup is rejected');
  const chaseLimit=Math.min(atr*0.25,risk*0.5);
  if(premium>trigger+chaseLimit+step*1e-7)return fail('Option premium has moved beyond the Pro entry chase limit; wait for a fresh setup');
  const resistance=highs.filter(p=>p.price>trigger).sort((a,b)=>a.price-b.price)[0]||null;
  let target, targetSource;
  if(resistance){
    const resistanceTarget=floorTick(resistance.price-Math.max(step,atr*0.1),step);
    if(resistanceTarget<trigger+2*risk-step*1e-7)return fail('Nearest verified option supply pivot is inside the minimum 1:2 reward/risk runway');
    target=Math.min(resistanceTarget,floorTick(trigger+2.5*risk,step));
    targetSource='NEAREST_VERIFIED_OPTION_SUPPLY_PIVOT';
  }else{
    target=ceilTick(trigger+2*risk,step);
    targetSource='MINIMUM_2R_NO_NEARBY_VERIFIED_SUPPLY';
  }
  const reward=target-trigger,rr=reward/risk;
  if(!(Number.isFinite(rr)&&rr>=2-1e-8))return fail('Adaptive target cannot preserve the minimum 1:2 reward/risk');
  const probability=estimateTargetHitConfidence(outcomeStats);
  return{
    status:'SETUP_CONFIRMED',entry:trigger,stopLoss:stop,target,rr:Number(rr.toFixed(2)),risk,
    model:'GV2VPD_NSE_PRO_RISK_V1',
    riskResearch:{
      model:'GV2VPD_NSE_PRO_RISK_V1',
      atr14:Number(atr.toFixed(6)),stopDistanceAtr:Number((risk/atr).toFixed(3)),
      targetDistanceAtr:Number((reward/atr).toFixed(3)),stopSource:'TIGHTEST_CONFIRMED_5M_STRUCTURAL_PIVOT_WITH_ATR_NOISE_BUFFER',
      targetSource,structuralStopPivot:structuralLow.price,resistancePivot:resistance?.price??null,
      entryChaseLimit:Number(chaseLimit.toFixed(6)),probability,
      tradePermission:probability.status==='LOW_CONFIDENCE'?'NO_TRADE':probability.status==='CALIBRATED'?'RESEARCH_CONFIDENCE_CALIBRATED':'READ_ONLY_RESEARCH_ONLY_UNCALIBRATED',
      note:'Minimum practical structural stop; target is resistance-aware and never below 1:2 RR. Hit-rate is shown only after 30 comparable completed NSE outcomes.'
    }
  };
}
