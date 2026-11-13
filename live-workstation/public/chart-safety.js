export const HISTORY_CACHE_TTL_MS = 60_000;

export function isHistoryCacheFresh(fetchedAt, now = Date.now(), ttlMs = HISTORY_CACHE_TTL_MS) {
  const stamp = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(String(fetchedAt || ''));
  return Number.isFinite(stamp) && stamp <= now && now - stamp < ttlMs;
}

export function getCompletedCandleWindow(candles, exchangeTime, maxAgeSeconds = 600) {
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
  const recent = completed.slice(-21);
  const contiguous = recent.length === 21 && recent.every((candle, index) => index === 0 || Number(candle.time) - Number(recent[index - 1].time) === 300);
  return { completed, lastClosed, ageSeconds, fresh, contiguous };
}
