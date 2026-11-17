const MAX_PLAN_AGE_MS = 6 * 60 * 60 * 1000;
function istSessionDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(timestamp));
}
export function rememberChartPlan(cache, symbol, plan, now = Date.now()) {
  if (!(cache instanceof Map) || typeof symbol !== 'string' || !symbol) throw new TypeError('A chart plan cache and symbol are required');
  const values = [plan?.entry, plan?.stopLoss, plan?.target].map(Number);
  if (values.some(value => !Number.isFinite(value) || value <= 0) || !['LONG', 'SHORT'].includes(plan?.side)) throw new TypeError('Only a complete confirmed chart plan can be retained');
  const retained = { ...plan, entry: values[0], stopLoss: values[1], target: values[2], confirmedAt: now, sessionDate: istSessionDate(now) };
  cache.set(symbol, retained);
  return retained;
}
export function getRetainedChartPlan(cache, symbol, now = Date.now()) {
  const plan = cache instanceof Map ? cache.get(symbol) : null;
  if (!plan) return null;
  const age = now - Number(plan.confirmedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_PLAN_AGE_MS || plan.sessionDate !== istSessionDate(now)) {
    cache.delete(symbol);
    return null;
  }
  return plan;
}
