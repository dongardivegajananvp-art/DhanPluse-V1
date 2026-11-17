const MAX_PLAN_AGE_MS = 6 * 60 * 60 * 1000;
const STORAGE_VERSION = 1;
function istSessionDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(timestamp));
}
function isValidPlan(plan) {
  const values = [plan?.entry, plan?.stopLoss, plan?.target].map(Number);
  return values.every(value => Number.isFinite(value) && value > 0)
    && ['LONG', 'SHORT'].includes(plan?.side)
    && Number.isFinite(Number(plan?.confirmedAt))
    && typeof plan?.sessionDate === 'string';
}
export function rememberChartPlan(cache, symbol, plan, now = Date.now()) {
  if (!(cache instanceof Map) || typeof symbol !== 'string' || !symbol) throw new TypeError('A chart plan cache and symbol are required');
  const values = [plan?.entry, plan?.stopLoss, plan?.target].map(Number);
  if (values.some(value => !Number.isFinite(value) || value <= 0) || !['LONG', 'SHORT'].includes(plan?.side)) throw new TypeError('Only a complete confirmed chart plan can be retained');
  const previous = getRetainedChartPlan(cache, symbol, now);
  if (previous && previous.side === plan.side && previous.entry === values[0] && previous.stopLoss === values[1] && previous.target === values[2] && previous.confirmationType === plan.confirmationType) return previous;
  const retained = { ...plan, entry: values[0], stopLoss: values[1], target: values[2], confirmedAt: now, sessionDate: istSessionDate(now) };
  cache.set(symbol, retained);
  return retained;
}
export function getRetainedChartPlan(cache, symbol, now = Date.now()) {
  const plan = cache instanceof Map ? cache.get(symbol) : null;
  if (!plan) return null;
  const age = now - Number(plan.confirmedAt);
  if (!isValidPlan(plan) || !Number.isFinite(age) || age < 0 || age > MAX_PLAN_AGE_MS || plan.sessionDate !== istSessionDate(now)) {
    cache.delete(symbol);
    return null;
  }
  return plan;
}
export function serializeChartPlans(cache, now = Date.now()) {
  if (!(cache instanceof Map)) return '';
  const plans = [];
  for (const [symbol] of cache) {
    const plan = getRetainedChartPlan(cache, symbol, now);
    if (plan) plans.push([symbol, plan]);
  }
  return JSON.stringify({ version: STORAGE_VERSION, plans });
}
export function restoreChartPlans(cache, raw, now = Date.now()) {
  if (!(cache instanceof Map)) throw new TypeError('A chart plan cache is required');
  cache.clear();
  if (typeof raw !== 'string' || !raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.plans)) return 0;
    for (const row of parsed.plans) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0] || !isValidPlan(row[1])) continue;
      cache.set(row[0], { ...row[1], entry: Number(row[1].entry), stopLoss: Number(row[1].stopLoss), target: Number(row[1].target) });
      getRetainedChartPlan(cache, row[0], now);
    }
    return cache.size;
  } catch {
    cache.clear();
    return 0;
  }
}
