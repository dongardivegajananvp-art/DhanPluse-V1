import { normalizeFyersCandleOrder } from "./candle-order.js";

/**
 * Build a long-option plan from fresh, completed FYERS option candles.
 * Entry is the independently verified option ask. SL is the 20-candle swing
 * low buffered by 0.35 x ATR(14). T1/T2 are actual-entry 2R/3R targets.
 * No fixed-premium percentages, synthetic prices or fallback candles.
 */
export function buildOptionRiskPlan({
  candles, entryPrice, lotSize, tickSize = 0.05, resolution = "5", now = Date.now(),
  lookback = 20, atrPeriod = 14, atrBuffer = 0.35
}) {
  const intervalMinutes = Number(resolution);
  if (!Number.isFinite(intervalMinutes) || ![5, 15, 30, 60].includes(intervalMinutes)) {
    return { ok: false, reason: "Unsupported option-candle interval." };
  }
  if (!Array.isArray(candles) || !Number.isInteger(lookback) || lookback < 20 ||
      !Number.isInteger(atrPeriod) || atrPeriod < 2 || lookback < atrPeriod + 1 ||
      candles.length < lookback) {
    return { ok: false, reason: "At least 20 option candles and sufficient ATR(14) history are required." };
  }
  if (!Number.isFinite(Number(atrBuffer)) || Number(atrBuffer) < 0 || Number(atrBuffer) > 2) {
    return { ok: false, reason: "ATR stop buffer is invalid." };
  }
  const ordered = normalizeFyersCandleOrder(candles);
  if (!ordered.ok) return { ok: false, reason: "Option candle timestamps are invalid, duplicated or inconsistently ordered." };
  candles = ordered.data;

  const entry = Number(entryPrice), lots = Number(lotSize), tick = Number(tickSize);
  if (!Number.isInteger(lots) || lots <= 0) return { ok: false, reason: "A verified positive FYERS contract lot size is required." };
  if (!Number.isFinite(tick) || tick <= 0 || tick > 100) return { ok: false, reason: "A valid FYERS contract tick size is required." };
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(now)) {
    return { ok: false, reason: "A valid independently verified option ask price is required." };
  }

  let previousTime = -Infinity;
  const valid = [];
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 6) return { ok: false, reason: "Option candle row is incomplete." };
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) ||
        time <= 0 || Math.min(open, high, low, close) <= 0 || volume < 0 ||
        high < Math.max(open, close, low) || low > Math.min(open, close, high) ||
        time <= previousTime || time * 1000 > now + 5000) {
      return { ok: false, reason: "Option candles contain invalid, future, duplicated, or out-of-order OHLC data." };
    }
    previousTime = time;
    valid.push({ time, open, high, low, close, volume });
  }

  const intervalMs = intervalMinutes * 60_000;
  const completed = valid.filter(row => row.time * 1000 + intervalMs <= now);
  if (completed.length < lookback || completed.length < atrPeriod + 1) {
    return { ok: false, reason: "Not enough completed option candles; the forming candle is excluded." };
  }
  const latest = completed[completed.length - 1];
  const candleAgeMs = now - (latest.time * 1000 + intervalMs);
  if (candleAgeMs < 0 || candleAgeMs > intervalMs * 3) {
    return { ok: false, reason: "Latest completed option candle is stale for the selected interval." };
  }

  const window = completed.slice(-lookback);
  const swingLow = Math.min(...window.map(row => row.low));
  const atrRows = completed.slice(-(atrPeriod + 1));
  const trueRanges = [];
  for (let index = 1; index < atrRows.length; index += 1) {
    const current = atrRows[index], prior = atrRows[index - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - prior.close),
      Math.abs(current.low - prior.close)
    ));
  }
  if (trueRanges.length !== atrPeriod || trueRanges.some(value => !Number.isFinite(value) || value <= 0)) {
    return { ok: false, reason: "ATR(14) cannot be calculated from the completed option candles." };
  }
  const atr14 = trueRanges.reduce((sum, value) => sum + value, 0) / atrPeriod;
  const rawStop = swingLow - Number(atrBuffer) * atr14;
  const roundDownToTick = value => Math.floor((value + 1e-9) / tick) * tick;
  const roundUpToTick = value => Math.ceil((value - 1e-9) / tick) * tick;
  const round = value => Number(value.toFixed(2));
  const roundedEntry = round(entry);
  const stopLoss = round(roundDownToTick(rawStop));
  if (!(stopLoss > 0 && stopLoss < roundedEntry)) {
    return { ok: false, reason: "20-candle swing-low minus ATR buffer does not sit below the verified ask; no valid long-option risk plan." };
  }

  const riskPerUnit = roundedEntry - stopLoss;
  const target1 = round(roundUpToTick(roundedEntry + 2 * riskPerUnit));
  const target2 = round(roundUpToTick(roundedEntry + 3 * riskPerUnit));
  const actualRisk = roundedEntry - stopLoss;
  const reward1 = target1 - roundedEntry;
  const reward2 = target2 - roundedEntry;
  const rrTarget1 = reward1 / actualRisk;
  const rrTarget2 = reward2 / actualRisk;
  if (!(actualRisk > 0 && reward1 > 0 && reward2 > 0 && rrTarget1 >= 2 && rrTarget2 >= 3)) {
    return { ok: false, reason: "Calculated 2R/3R targets failed after official tick-size rounding." };
  }

  const riskPerLot = round(actualRisk * lots);
  const target1RewardPerLot = round(reward1 * lots);
  const target2RewardPerLot = round(reward2 * lots);
  return {
    ok: true,
    entryPrice: roundedEntry,
    stopLoss,
    target: target1,
    target1,
    target2,
    riskPerUnit: round(actualRisk),
    rewardPerUnit: round(reward2),
    lotSize: lots,
    quantity: lots,
    lots: 1,
    riskPerLot,
    rewardPerLot: target2RewardPerLot,
    target1RewardPerLot,
    target2RewardPerLot,
    premiumPerLot: round(roundedEntry * lots),
    rr: Number(rrTarget2.toFixed(2)),
    rrTarget1: Number(rrTarget1.toFixed(2)),
    rrTarget2: Number(rrTarget2.toFixed(2)),
    candleCount: window.length,
    completedCandleCount: completed.length,
    lookback,
    atrPeriod,
    atr14: round(atr14),
    atrBuffer: Number(atrBuffer),
    swingLow: round(swingLow),
    latestCandleAt: new Date(latest.time * 1000).toISOString(),
    latestCompletedCandleAt: new Date(latest.time * 1000).toISOString(),
    candleAgeSeconds: Number((candleAgeMs / 1000).toFixed(1)),
    method: "Fresh FYERS option candles: 20-candle swing low - 0.35 x ATR(14); fresh ask entry; T1=2R and T2=3R"
  };
}
