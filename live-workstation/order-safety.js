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


// FYERS multi-order margin response uses a nested data object.
// Fail closed if any required field is absent or malformed.
export function parseFyersMarginPreflight(payload) {
  const data = payload?.data;
  if (payload?.s !== 'ok' || !data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'FYERS margin response envelope is invalid' };
  }
  const requiredRaw = data.margin_new_order ?? data.margin_total;
  const availableRaw = data.margin_avail;
  if (requiredRaw === null || requiredRaw === undefined || requiredRaw === '' ||
      availableRaw === null || availableRaw === undefined || availableRaw === '') {
    return { ok: false, reason: 'FYERS margin response is missing required/available margin' };
  }
  const required = Number(requiredRaw);
  const available = Number(availableRaw);
  if (!Number.isFinite(required) || required <= 0 || !Number.isFinite(available) || available < 0) {
    return { ok: false, reason: 'FYERS margin response contains invalid numeric values' };
  }
  if (required > available) return { ok: false, required, available, reason: 'Insufficient FYERS available margin' };
  return { ok: true, required, available };
}

// Translate FYERS order-book status codes and quantities into explicit execution states.
export function classifyFyersOrder(order) {
  if (!order || typeof order !== 'object') return { status: 'ACK_UNVERIFIED', filledQty: null, remainingQty: null };
  const rawStatus = order.status ?? order.orderStatus;
  const code = Number(rawStatus);
  const filledRaw = order.filledQty;
  const remainingRaw = order.remainingQuantity ?? order.pendingQty;
  const filledQty = filledRaw === null || filledRaw === undefined || filledRaw === '' ? null : Number(filledRaw);
  const remainingQty = remainingRaw === null || remainingRaw === undefined || remainingRaw === '' ? null : Number(remainingRaw);
  if ((filledQty !== null && (!Number.isFinite(filledQty) || filledQty < 0)) ||
      (remainingQty !== null && (!Number.isFinite(remainingQty) || remainingQty < 0))) {
    return { status: 'ACK_UNVERIFIED', filledQty: null, remainingQty: null };
  }
  if (filledQty !== null && remainingQty !== null && filledQty > 0 && remainingQty > 0) {
    return { status: 'PARTIAL_FILL', filledQty, remainingQty };
  }
  const states = { 1: 'CANCELLED', 2: 'FILLED', 4: 'TRANSIT', 5: 'REJECTED', 6: 'PENDING', 7: 'EXPIRED' };
  return { status: states[code] || 'ACK_UNVERIFIED', filledQty, remainingQty };
}
