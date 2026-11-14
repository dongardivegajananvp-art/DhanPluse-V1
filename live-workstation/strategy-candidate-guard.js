function expiryEpoch(value) {
  if (value === null || value === undefined || value === '') return 0;
  const raw = String(value).trim();
  const compactDate = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compactDate) return Date.UTC(Number(compactDate[1]), Number(compactDate[2]) - 1, Number(compactDate[3]), 10, 0, 0) / 1000;
  const numeric = Number(value);
  let stamp = 0;
  if (Number.isFinite(numeric) && numeric > 0) {
    stamp = numeric > 1e12 ? numeric / 1000 : numeric;
    const date = new Date(stamp * 1000);
    if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 10, 0, 0) / 1000;
    }
    return stamp;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const match = dateOnly;
  if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 10, 0, 0) / 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}

function isTickAligned(value, tickSize) {
  const price = Number(value), step = Number(tickSize);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(step) || step <= 0) return false;
  const units = price / step;
  return Math.abs(units - Math.round(units)) <= 1e-6;
}

export function validateOptionPremiumTick(tick, contract, now = Date.now(), maxAgeMs = 10_000) {
  const receivedAt = Number(tick?.receivedAt), exchangeTime = Number(tick?.exchangeTime);
  if (!tick || !Number.isFinite(Number(tick.price)) || Number(tick.price) <= 0) return { ok: false, reason: 'Option premium is missing or non-positive' };
  if (contract?.symbol && tick.symbol !== contract.symbol) return { ok: false, reason: 'Option premium tick symbol does not match the verified contract' };
  if (!Number.isFinite(receivedAt) || now - receivedAt < 0 || now - receivedAt > maxAgeMs) return { ok: false, reason: 'Option premium receive timestamp is missing, future-dated, or stale' };
  if (!Number.isFinite(exchangeTime) || exchangeTime <= 0 || now / 1000 - exchangeTime < -3 || now / 1000 - exchangeTime > maxAgeMs / 1000) return { ok: false, reason: 'Option premium exchange timestamp is missing, future-dated, or stale' };
  if (!isTickAligned(tick.price, contract?.tickSize)) return { ok: false, reason: 'Option premium does not align with the official contract tick size' };
  return { ok: true, reason: '' };
}

export function validateOptionCandles(candles, tick, contract, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 51) return { ok: false, reason: 'At least 51 completed FYERS option candles are required' };
  const rows = candles.slice();
  const exchangeTime = Number(tick?.exchangeTime);
  if (!Number.isFinite(exchangeTime) || exchangeTime <= 0 || now / 1000 - exchangeTime < -3 || now / 1000 - exchangeTime > 10) return { ok: false, reason: 'Option candle reference tick is missing, future-dated, or stale' };
  const currentBucket = Math.floor(exchangeTime / 300) * 300;
  for (let i = 0; i < rows.length; i++) {
    const candle = rows[i];
    const values = ['time', 'open', 'high', 'low', 'close'].map(key => Number(candle?.[key]));
    if (!values.every(Number.isFinite) || values[0] <= 0 || values.slice(1).some(value => value <= 0)) return { ok: false, reason: 'FYERS option candles contain missing or invalid OHLC values' };
    const [time, open, high, low, close] = values;
    if (high < Math.max(open, close, low) || low > Math.min(open, close)) return { ok: false, reason: 'FYERS option candle OHLC range is inconsistent' };
    if (i && time <= Number(rows[i - 1].time)) return { ok: false, reason: 'FYERS option candle timestamps are duplicated or out of order' };
    if (time > currentBucket) return { ok: false, reason: 'FYERS option candles contain a future interval beyond the live exchange tick' };
    if (![open, high, low, close].every(value => isTickAligned(value, contract?.tickSize))) return { ok: false, reason: 'FYERS option candle price does not align with official contract tick size' };
  }
  const completed = Number(rows.at(-1).time) === currentBucket ? rows.slice(0, -1) : rows;
  if (completed.length < 51) return { ok: false, reason: 'FYERS option candle window includes an unfinished candle or has fewer than 51 completed candles' };
  const required = completed.slice(-51);
  if (!required.every((candle, index) => index === 0 || Number(candle.time) - Number(required[index - 1].time) === 300)) return { ok: false, reason: 'Latest 51 FYERS option candles are not contiguous 5-minute intervals' };
  const latest = completed.at(-1);
  const age = exchangeTime - (Number(latest.time) + 300);
  if (!Number.isFinite(exchangeTime) || age < -3 || age > 600 || now / 1000 - (Number(latest.time) + 300) > 900) return { ok: false, reason: 'Latest completed FYERS option candle is stale or ahead of the exchange tick' };
  return { ok: true, reason: '', completedCandles: completed.slice(-51), latestCompletedTime: Number(latest.time) };
}

export function validateOptionContractIdentity(candidate, official, now = Date.now()) {
  if (!candidate || !official || candidate.symbol !== official.symbol) return { ok: false, reason: 'Option contract symbol does not match the current FYERS Symbol Master' };
  if (!['CE', 'PE'].includes(String(candidate.side)) || candidate.side !== official.side) return { ok: false, reason: 'Option side does not match the current FYERS Symbol Master' };
  for (const key of ['strike', 'tickSize', 'lotSize']) {
    const left = Number(candidate[key]), right = Number(official[key]);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left !== right) return { ok: false, reason: 'Option ' + key + ' does not match the current FYERS Symbol Master' };
  }
  const candidateExpiry = expiryEpoch(candidate.expiry);
  const officialExpiry = expiryEpoch(official.expiryDate ?? official.expiry);
  if (!candidateExpiry || !officialExpiry || candidateExpiry !== officialExpiry || candidateExpiry * 1000 <= now) {
    return { ok: false, reason: 'Option expiry is missing, expired, or does not match the current FYERS Symbol Master' };
  }
  return { ok: true, reason: '' };
}

export function sameStrategyConfirmation(original, refreshed) {
  return Boolean(original && refreshed &&
    original.strategy === refreshed.strategy &&
    original.side === refreshed.side &&
    Number(original.confirmedAt) === Number(refreshed.confirmedAt) &&
    Number(original.breakoutLevel) === Number(refreshed.breakoutLevel));
}
