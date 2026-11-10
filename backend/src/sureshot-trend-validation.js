import { normalizeFyersCandleOrder } from "./candle-order.js";
function indiaDateKeyFromSeconds(seconds) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(seconds * 1000));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

function indiaMinuteOfDay(seconds) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(seconds * 1000));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(fields.hour) * 60 + Number(fields.minute);
}

function calculateEma(values, period) {
  if (values.length < period + 1) return null;
  const alpha = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let previous = ema;
  for (let i = period; i < values.length; i++) {
    previous = ema;
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return { current: ema, previous };
}

function calculateAdx(rows, period = 14) {
  if (rows.length < period * 2 + 2) return null;
  const tr = [], plusDm = [], minusDm = [];
  for (let i = 1; i < rows.length; i++) {
    const current = rows[i], prior = rows[i - 1];
    const up = current.high - prior.high;
    const down = prior.low - current.low;
    tr.push(Math.max(current.high - current.low, Math.abs(current.high - prior.close), Math.abs(current.low - prior.close)));
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let smoothTr = tr.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    smoothTr = smoothTr - smoothTr / period + tr[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i];
    if (smoothTr <= 0) continue;
    const plusDi = 100 * smoothPlus / smoothTr;
    const minusDi = 100 * smoothMinus / smoothTr;
    const denominator = plusDi + minusDi;
    if (denominator > 0) dx.push(100 * Math.abs(plusDi - minusDi) / denominator);
  }
  if (dx.length < period) return null;
  return dx.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

/**
 * Strict Sureshot gate: completed 5m trend, ADX, EMA20, session VWAP,
 * and today's volume against the previous five sessions at the same elapsed time.
 */
export function validateSureshotTrend({ candles, resolution = "5", now = Date.now(), minAdx = 20, minVolumeRatio = 1.5, minTrendScore = 70 }) {
  const minutes = Number(resolution);
  if (minutes !== 5 || !Array.isArray(candles)) return { ok: false, reason: "Sureshot trend validation requires FYERS 5-minute candles." };
  const ordered = normalizeFyersCandleOrder(candles);
  if (!ordered.ok) return { ok: false, reason: "Underlying candle timestamps are invalid, duplicated or inconsistently ordered." };
  candles = ordered.data;
  const completed = [];
  let previousTime = -Infinity;
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 6) return { ok: false, reason: "Underlying candle row is incomplete." };
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) ||
        time <= 0 || time <= previousTime || Math.min(open, high, low, close) <= 0 ||
        volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high) ||
        time * 1000 > now + 5000) {
      return { ok: false, reason: "Underlying candles contain invalid, future, duplicated or out-of-order OHLC data." };
    }
    previousTime = time;
    if (time * 1000 + minutes * 60_000 <= now) completed.push({ time, open, high, low, close, volume });
  }
  if (completed.length < 30) return { ok: false, reason: "At least 30 completed FYERS 5-minute candles are required for the trend check." };
  const latest = completed[completed.length - 1];
  const latestAgeMs = now - (latest.time * 1000 + minutes * 60_000);
  if (latestAgeMs < 0 || latestAgeMs > 15 * 60_000) return { ok: false, reason: "Latest completed underlying candle is stale." };

  const todayKey = indiaDateKeyFromSeconds(Math.floor(now / 1000));
  const todayRows = completed.filter(row => indiaDateKeyFromSeconds(row.time) === todayKey);
  if (!todayRows.length || todayRows[todayRows.length - 1].time !== latest.time) {
    return { ok: false, reason: "Latest completed FYERS candle is not from the current India trading session." };
  }
  const latestMinute = indiaMinuteOfDay(latest.time);
  const sessions = new Map();
  for (const row of completed) {
    const key = indiaDateKeyFromSeconds(row.time);
    if (key >= todayKey) continue;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(row);
  }
  const priorKeys = [...sessions.keys()].sort().slice(-5);
  if (priorKeys.length < 5) return { ok: false, reason: "Five previous FYERS trading sessions are required for the same-time volume average." };
  const priorVolumes = [];
  for (const key of priorKeys) {
    const rows = sessions.get(key).filter(row => indiaMinuteOfDay(row.time) <= latestMinute);
    if (!rows.length) return { ok: false, reason: "Previous-session volume coverage is incomplete at the current elapsed time." };
    priorVolumes.push(rows.reduce((sum, row) => sum + row.volume, 0));
  }
  const averagePriorVolume = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length;
  const currentVolume = todayRows.filter(row => indiaMinuteOfDay(row.time) <= latestMinute)
    .reduce((sum, row) => sum + row.volume, 0);
  if (!(averagePriorVolume > 0 && currentVolume > 0)) return { ok: false, reason: "Current or five-day comparison volume is missing." };
  const volumeRatio = currentVolume / averagePriorVolume;

  const totalVolume = todayRows.reduce((sum, row) => sum + row.volume, 0);
  const vwapVolume = todayRows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0);
  if (!(totalVolume > 0)) return { ok: false, reason: "Current-session VWAP cannot be verified without volume." };
  const vwap = vwapVolume / totalVolume;

  const ema = calculateEma(completed.map(row => row.close), 20);
  const adx = calculateAdx(completed, 14);
  if (!ema || !Number.isFinite(adx)) return { ok: false, reason: "Not enough completed candles to calculate ADX(14) and EMA(20)." };
  if (adx < minAdx) return { ok: false, reason: "Sideways trend blocked: ADX(14) is below " + minAdx + "." };
  if (volumeRatio < minVolumeRatio) return { ok: false, reason: "Volume confirmation blocked: same-time five-session ratio is below " + minVolumeRatio + "x." };

  let side = null;
  if (latest.close > ema.current && ema.current > ema.previous && latest.close > vwap) side = "CE";
  if (latest.close < ema.current && ema.current < ema.previous && latest.close < vwap) side = "PE";
  if (!side) return { ok: false, reason: "Trend direction is not aligned across EMA(20), EMA slope and session VWAP." };

  const scoreParts = {
    adx: adx >= 25 ? 35 : 25,
    sameTimeVolume: 25,
    emaSlope: 20,
    emaAlignment: 10,
    vwapAlignment: 10
  };
  const trendScore = Object.values(scoreParts).reduce((sum, value) => sum + value, 0);
  if (trendScore < minTrendScore) return { ok: false, reason: "Transparent Trend Score is below " + minTrendScore + "." };
  return {
    ok: true, side, trendScore, scoreParts,
    adx: Number(adx.toFixed(2)), ema20: Number(ema.current.toFixed(4)),
    ema20Previous: Number(ema.previous.toFixed(4)), vwap: Number(vwap.toFixed(4)),
    volumeRatio: Number(volumeRatio.toFixed(2)), currentVolume,
    averagePreviousFiveSameTimeVolume: Number(averagePriorVolume.toFixed(2)),
    latestCompletedCandleAt: new Date(latest.time * 1000).toISOString(),
    candleAgeSeconds: Number((latestAgeMs / 1000).toFixed(1)),
    completedCandleCount: completed.length
  };
}
