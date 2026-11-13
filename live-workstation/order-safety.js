export function validateRiskReward({ side, premium, stopLoss, takeProfit }) {
  const p=Number(premium), sl=Number(stopLoss), tp=Number(takeProfit);
  if (![p,sl,tp].every(Number.isFinite) || p<=0 || sl<=0 || tp<=0) return { ok:false, reason:'Premium, stop-loss and target must be positive finite prices' };
  let risk=0,reward=0;
  if (side==='BUY') {
    if (!(sl<p && tp>p)) return { ok:false, reason:'BUY stop-loss/target must bracket the live premium' };
    risk=p-sl; reward=tp-p;
  } else if (side==='SELL') {
    if (!(tp<p && sl>p)) return { ok:false, reason:'SELL stop-loss/target must bracket the live premium' };
    risk=sl-p; reward=p-tp;
  } else return { ok:false, reason:'Side must be BUY or SELL' };
  const rr=reward/risk;
  return rr>=2 ? { ok:true, risk, reward, rr } : { ok:false, risk, reward, rr, reason:'Minimum reward-to-risk ratio 1:2 is required' };
}
