export const NSE_RESEARCH_HISTORY_DAYS = 15;
export const FYERS_CANDLE_SECONDS = 300;

export function buildFyersHistoryRange({ nowSeconds = Math.floor(Date.now() / 1000), lookbackDays = NSE_RESEARCH_HISTORY_DAYS, candleSeconds = FYERS_CANDLE_SECONDS } = {}) {
  const now = Number(nowSeconds), days = Number(lookbackDays), interval = Number(candleSeconds);
  if (!Number.isFinite(now) || now <= 0 || !Number.isInteger(days) || days < 1 || days > 30 ||
      !Number.isInteger(interval) || interval < 60 || interval > 86400) {
    throw new RangeError('Invalid FYERS historical range');
  }
  const rangeTo = Math.floor(now / interval) * interval - interval;
  return { rangeFrom: rangeTo - days * 86400, rangeTo, lookbackDays: days, candleSeconds: interval };
}

export function normalizeCompletedFyersCandles(rows, nowSeconds = Math.floor(Date.now() / 1000), { sessionStartMinute = 555, sessionEndMinute = 925 } = {}) {
  const currentBucket = Math.floor(Number(nowSeconds) / FYERS_CANDLE_SECONDS) * FYERS_CANDLE_SECONDS;
  const byTime = new Map(), conflicted = new Set();
  let invalidCount = 0, partialCount = 0, duplicateCount = 0, outsideSessionCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 5) { invalidCount++; continue; }
    const [time, open, high, low, close] = row.slice(0, 5).map(Number);
    const volume = Number(row[5] ?? 0);
    if (![time, open, high, low, close].every(Number.isFinite) || time <= 0 ||
        ![open, high, low, close].every(value => value > 0) ||
        time % FYERS_CANDLE_SECONDS !== 0 ||
        high < Math.max(open, close, low) || low > Math.min(open, close)) {
      invalidCount++; continue;
    }
    if (time >= currentBucket) { partialCount++; continue; }
    const ist = new Date((time + 19800) * 1000);
    const sessionMinute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (sessionMinute < sessionStartMinute || sessionMinute > sessionEndMinute) { outsideSessionCount++; continue; }
    if (conflicted.has(time)) { duplicateCount++; continue; }
    const candle = { time, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 };
    const previous = byTime.get(time);
    if (previous) {
      duplicateCount++;
      if (['open','high','low','close'].some(key => previous[key] !== candle[key])) {
        byTime.delete(time);
        conflicted.add(time);
      }
      continue;
    }
    byTime.set(time, candle);
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, invalidCount, partialCount, duplicateCount, outsideSessionCount, currentBucket, sessionStartMinute, sessionEndMinute };
}
