export const HISTORY_CACHE_TTL_MS = 60_000;

export function isFreshExchangeTick(tick, now = Date.now(), maxAgeMs = 10_000) {
  if (!tick || !Number.isFinite(Number(tick.receivedAt)) || !Number.isFinite(Number(tick.exchangeTime))) return false;
  const receivedAge = now - Number(tick.receivedAt);
  const exchangeAge = now / 1000 - Number(tick.exchangeTime);
  return receivedAge >= 0 && receivedAge < maxAgeMs && exchangeAge >= -3 && exchangeAge <= maxAgeMs / 1000;
}

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
  if (bars.length < 2) return { status: 'WAIT', reason: 'Need two completed 5-minute candles: reference and breakout' };
  if (bars.some(c => !c || ![c.time,c.open,c.high,c.low,c.close].every(v => Number.isFinite(Number(v))))) {
    return { status: 'NO_TRADE', reason: 'Breakout candles contain invalid OHLC data' };
  }
  if (bars.some((c,i) => i > 0 && Number(c.time) - Number(bars[i-1].time) !== 300)) {
    return { status: 'NO_TRADE', reason: 'Breakout confirmation candles are not contiguous' };
  }
  const price = Number(tickPrice);
  if (!Number.isFinite(price) || price <= 0) return { status: 'NO_TRADE', reason: 'Fresh underlying price unavailable' };

  // Early confirmation: a completed directional breakout candle plus a fresh
  // exchange tick through that candle's extreme. No extra 5-minute candle wait.
  const reference = bars.at(-2), breakout = bars.at(-1);
  const resistance = Number(reference.high), support = Number(reference.low);
  const high = Number(breakout.high), low = Number(breakout.low);
  if (Number(breakout.close) > resistance && Number(breakout.close) > Number(breakout.open) && price >= high) {
    const entry = high, stopLoss = low, risk = entry - stopLoss;
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Breakout candle has invalid long-side structural risk' };
    if (price > entry + risk * 0.25) return { status: 'WAIT', reason: 'Live price is more than 0.25R above the exact entry; chase blocked' };
    return { status: 'SETUP_CONFIRMED', side: 'LONG', confirmationType: 'EARLY_LIVE_HIGH_BREAK',
      entry, stopLoss, target: entry + 2 * risk, rr: '1:2', candleTime: Number(breakout.time), triggerPrice: high };
  }
  if (Number(breakout.close) < support && Number(breakout.close) < Number(breakout.open) && price <= low) {
    const entry = low, stopLoss = high, risk = stopLoss - entry;
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Breakout candle has invalid short-side structural risk' };
    if (price < entry - risk * 0.25) return { status: 'WAIT', reason: 'Live price is more than 0.25R below the exact entry; chase blocked' };
    return { status: 'SETUP_CONFIRMED', side: 'SHORT', confirmationType: 'EARLY_LIVE_LOW_BREAK',
      entry, stopLoss, target: entry - 2 * risk, rr: '1:2', candleTime: Number(breakout.time), triggerPrice: low };
  }

  // Keep the prior three-candle hold/retest path as a conservative fallback.
  if (bars.length < 3) return { status: 'WAIT', reason: 'Waiting for a fresh live break of the completed breakout candle high/low' };
  const [oldReference, breakoutCandle, confirmation] = bars;
  const oldResistance = Number(oldReference.high), oldSupport = Number(oldReference.low);
  if (Number(breakoutCandle.close) > oldResistance && Number(confirmation.close) > oldResistance && price >= Number(confirmation.close)) {
    const risk = Number(confirmation.close) - Number(confirmation.low);
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Confirmation candle has invalid long-side risk' };
    return { status: 'SETUP_CONFIRMED', side: 'LONG', confirmationType: Number(confirmation.low) <= oldResistance ? 'ONE_CANDLE_RETEST' : 'ONE_CANDLE_HOLD',
      entry: Number(confirmation.close), stopLoss: Number(confirmation.low), target: Number(confirmation.close) + 2 * risk, rr: '1:2', candleTime: Number(confirmation.time) };
  }
  if (Number(breakoutCandle.close) < oldSupport && Number(confirmation.close) < oldSupport && price <= Number(confirmation.close)) {
    const risk = Number(confirmation.high) - Number(confirmation.close);
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Confirmation candle has invalid short-side risk' };
    return { status: 'SETUP_CONFIRMED', side: 'SHORT', confirmationType: Number(confirmation.high) >= oldSupport ? 'ONE_CANDLE_RETEST' : 'ONE_CANDLE_HOLD',
      entry: Number(confirmation.close), stopLoss: Number(confirmation.high), target: Number(confirmation.close) - 2 * risk, rr: '1:2', candleTime: Number(confirmation.time) };
  }
  return { status: 'WAIT', reason: 'Waiting for a completed directional breakout and fresh live tick through its exact high/low' };
}

// MCX futures can produce large candles relative to the instrument price. Keep
// real OHLC untouched, but use a wider 8% minimum visual price span plus 20%
// padding so a small number of candles cannot stretch to fill the chart.
export function getMcxChartPriceDomain(low, high) {
  const lo = Number(low), hi = Number(high);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
    throw new TypeError('Valid positive MCX chart bounds are required');
  }
  const center = (lo + hi) / 2;
  const rawSpan = Math.max(hi - lo, 0.01);
  const span = Math.max(rawSpan, center * 0.08);
  const paddedSpan = span * 1.2;
  const midpoint = (lo + hi) / 2;
  return { lo: midpoint - paddedSpan / 2, hi: midpoint + paddedSpan / 2 };
}
