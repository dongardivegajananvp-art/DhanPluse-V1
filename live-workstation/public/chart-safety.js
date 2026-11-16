export const HISTORY_CACHE_TTL_MS = 60_000;

export function isHistoryCacheFresh(fetchedAt, now = Date.now(), ttlMs = HISTORY_CACHE_TTL_MS) {
  const stamp = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(String(fetchedAt || ''));
  return Number.isFinite(stamp) && stamp <= now && now - stamp < ttlMs;
}

export function getCompletedCandleWindow(candles, exchangeTime, maxAgeSeconds = 600, contiguousCount = 21) {
  const stamp = Number(exchangeTime);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    return { completed: [], lastClosed: null, ageSeconds: Infinity, fresh: false };
  }
  const currentBucket = Math.floor(stamp / 300) * 300;
  const rows = Array.isArray(candles) ? candles : [];
  const completed = rows.length && Number(rows[rows.length - 1]?.time) === currentBucket
    ? rows.slice(0, -1)
    : rows;
  const lastClosed = completed[completed.length - 1] || null;
  const candleTime = Number(lastClosed?.time);
  const ageSeconds = lastClosed && Number.isFinite(candleTime) ? stamp - (candleTime + 300) : Infinity;
  const fresh = Boolean(lastClosed && Number.isFinite(candleTime) && ageSeconds >= -3 && ageSeconds <= maxAgeSeconds);
  const count = Math.max(1, Math.floor(Number(contiguousCount) || 21));
  const recent = completed.slice(-count);
  const contiguous = recent.length === count && recent.every((candle, index) => index === 0 || Number(candle.time) - Number(recent[index - 1].time) === 300);
  return { completed, lastClosed, ageSeconds, fresh, contiguous };
}

export function evaluateThreeCandleBreakout(completed, tickPrice) {
  const bars = Array.isArray(completed) ? completed.slice(-3) : [];
  if (bars.length < 3) return { status: 'WAIT', reason: 'Need three completed 5-minute candles: reference, breakout and one confirmation' };
  if (bars.some(c => !c || ![c.time,c.open,c.high,c.low,c.close].every(v => Number.isFinite(Number(v))))) {
    return { status: 'NO_TRADE', reason: 'Breakout candles contain invalid OHLC data' };
  }
  if (bars.some((c,i) => i > 0 && Number(c.time) - Number(bars[i-1].time) !== 300)) {
    return { status: 'NO_TRADE', reason: 'Breakout confirmation candles are not contiguous' };
  }
  const [reference, breakout, confirmation] = bars;
  const price = Number(tickPrice);
  if (!Number.isFinite(price) || price <= 0) return { status: 'NO_TRADE', reason: 'Fresh underlying price unavailable' };
  const resistance = Number(reference.high);
  const support = Number(reference.low);
  if (Number(breakout.close) > resistance && Number(confirmation.close) > resistance && price >= Number(confirmation.close)) {
    const risk = Number(confirmation.close) - Number(confirmation.low);
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Confirmation candle has invalid long-side risk' };
    return { status: 'SETUP_CONFIRMED', side: 'LONG', confirmationType: Number(confirmation.low) <= resistance ? 'ONE_CANDLE_RETEST' : 'ONE_CANDLE_HOLD',
      entry: Number(confirmation.close), stopLoss: Number(confirmation.low), target: Number(confirmation.close) + 2 * risk, rr: '1:2', candleTime: Number(confirmation.time) };
  }
  if (Number(breakout.close) < support && Number(confirmation.close) < support && price <= Number(confirmation.close)) {
    const risk = Number(confirmation.high) - Number(confirmation.close);
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Confirmation candle has invalid short-side risk' };
    return { status: 'SETUP_CONFIRMED', side: 'SHORT', confirmationType: Number(confirmation.high) >= support ? 'ONE_CANDLE_RETEST' : 'ONE_CANDLE_HOLD',
      entry: Number(confirmation.close), stopLoss: Number(confirmation.high), target: Number(confirmation.close) - 2 * risk, rr: '1:2', candleTime: Number(confirmation.time) };
  }
  return { status: 'WAIT', reason: 'Breakout must be followed by one completed candle holding above or retesting and reclaiming the breakout level' };
}
