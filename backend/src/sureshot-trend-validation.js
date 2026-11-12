import { normalizeFyersCandleOrder } from "./candle-order.js";

function indiaDateKeyFromSeconds(seconds) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(seconds * 1000));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

/**
 * Sureshot direction uses a 20-period simple moving-average crossover on
 * completed FYERS 5-minute candles. Supply/demand breakout agreement is checked
 * by deriveVerifiedUnderlyingDirection; this module only validates the crossover.
 */
export function validateSureshotTrend({ candles, resolution = "5", now = Date.now() }) {
  if (Number(resolution) !== 5 || !Array.isArray(candles)) {
    return { ok: false, reason: "Sureshot DMA20 crossover requires FYERS 5-minute candles." };
  }
  const ordered = normalizeFyersCandleOrder(candles);
  if (!ordered.ok) return { ok: false, reason: "Underlying candle timestamps are invalid, duplicated or inconsistently ordered." };
  const completed = [];
  let previousTime = -Infinity;
  for (const row of ordered.data) {
    if (!Array.isArray(row) || row.length < 6) return { ok: false, reason: "Underlying candle row is incomplete." };
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) ||
        time <= 0 || time <= previousTime || Math.min(open, high, low, close) <= 0 ||
        volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high) ||
        time * 1000 > now + 5000) {
      return { ok: false, reason: "Underlying candles contain invalid, future, duplicated or out-of-order OHLC data." };
    }
    previousTime = time;
    if (time * 1000 + 5 * 60_000 <= now) completed.push({ time, open, high, low, close, volume });
  }
  if (completed.length < 21) return { ok: false, reason: "At least 21 completed FYERS 5-minute candles are required for the DMA20 crossover." };

  const latest = completed[completed.length - 1];
  const prior = completed[completed.length - 2];
  const latestAgeMs = now - (latest.time * 1000 + 5 * 60_000);
  if (latestAgeMs < 0 || latestAgeMs > 15 * 60_000) return { ok: false, reason: "Latest completed underlying candle is stale." };
  const todayKey = indiaDateKeyFromSeconds(Math.floor(now / 1000));
  if (indiaDateKeyFromSeconds(latest.time) !== todayKey) {
    return { ok: false, reason: "Latest completed FYERS candle is not from the current India trading session." };
  }

  const previousWindow = completed.slice(-21, -1);
  const currentWindow = completed.slice(-20);
  if (previousWindow.length !== 20 || currentWindow.length !== 20) {
    return { ok: false, reason: "DMA20 calculation history is incomplete." };
  }
  const average = rows => rows.reduce((sum, row) => sum + row.close, 0) / rows.length;
  const previousDma20 = average(previousWindow);
  const dma20 = average(currentWindow);
  const bullishCross = prior.close <= previousDma20 && latest.close > dma20;
  const bearishCross = prior.close >= previousDma20 && latest.close < dma20;
  const side = bullishCross ? "CE" : bearishCross ? "PE" : null;
  if (!side) return { ok: false, reason: "No fresh DMA20 crossover on the latest completed FYERS 5-minute candle." };

  return {
    ok: true,
    side,
    crossover: side === "CE" ? "BULLISH" : "BEARISH",
    dma20: Number(dma20.toFixed(4)),
    previousDma20: Number(previousDma20.toFixed(4)),
    latestClose: Number(latest.close.toFixed(4)),
    previousClose: Number(prior.close.toFixed(4)),
    latestCompletedCandleAt: new Date(latest.time * 1000).toISOString(),
    candleAgeSeconds: Number((latestAgeMs / 1000).toFixed(1)),
    completedCandleCount: completed.length,
    method: "20-period simple moving-average crossover on completed FYERS 5-minute candles"
  };
}
