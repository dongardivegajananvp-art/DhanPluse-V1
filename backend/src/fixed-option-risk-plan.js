import { normalizeFyersCandleOrder } from "./candle-order.js";
function roundToTick(value, tickSize, direction) {
  const scaled = value / tickSize;
  const rounded = direction === "down" ? Math.floor(scaled + 1e-9)
    : direction === "up" ? Math.ceil(scaled - 1e-9) : Math.round(scaled);
  return Number((rounded * tickSize).toFixed(8));
}

export function validateCompletedOptionCandles({ candles, resolution = "5", now = Date.now(), lookback = 12 }) {
  const minutes = Number(resolution);
  if (![5, 15, 30, 60].includes(minutes) || !Array.isArray(candles)) {
    return { ok: false, reason: "Unsupported or missing option candles." };
  }
  if (!Number.isInteger(lookback) || lookback < 12) {
    return { ok: false, reason: "At least 12 completed option candles are required." };
  }
  const ordered = normalizeFyersCandleOrder(candles);
  if (!ordered.ok) return { ok: false, reason: "Option candle timestamps are invalid, duplicated or inconsistently ordered." };
  candles = ordered.data;
  let previous = -Infinity;
  const completed = [];
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 6) return { ok: false, reason: "Option candle row is incomplete." };
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) ||
        time <= 0 || time <= previous || Math.min(open, high, low, close) <= 0 ||
        volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high) ||
        time * 1000 > now + 5000) {
      return { ok: false, reason: "Option candles contain invalid, future, duplicated or out-of-order OHLC data." };
    }
    previous = time;
    if (time * 1000 + minutes * 60_000 <= now) completed.push({ time, close });
  }
  if (completed.length < lookback) return { ok: false, reason: "At least 12 completed option candles are required; forming candles are excluded." };
  const latest = completed[completed.length - 1];
  const ageMs = now - (latest.time * 1000 + minutes * 60_000);
  if (ageMs < 0 || ageMs > minutes * 60_000 * 3) {
    return { ok: false, reason: "Latest completed option candle is stale for the selected interval." };
  }
  return { ok: true, completedCandleCount: completed.length, latestCompletedCandleAt: new Date(latest.time * 1000).toISOString() };
}

export function buildFixedOptionRiskPlan({ entryPrice, lotSize, tickSize = 0.05 }) {
  const entry = Number(entryPrice);
  const lots = Number(lotSize);
  const tick = Number(tickSize);
  if (!Number.isFinite(entry) || entry <= 0) return { ok: false, reason: "A fresh verified option ask entry is required." };
  if (!Number.isInteger(lots) || lots <= 0) return { ok: false, reason: "A verified positive FYERS lot size is required." };
  if (!Number.isFinite(tick) || tick <= 0 || tick > 100) return { ok: false, reason: "A verified option tick size is required." };
  const entryTicks = entry / tick;
  if (Math.abs(entryTicks - Math.round(entryTicks)) > 1e-5) {
    return { ok: false, reason: "Verified ask entry is not aligned to the official contract tick size." };
  }
  const fixedEntry = Number(entry.toFixed(2));
  const stopLoss = roundToTick(fixedEntry * 0.70, tick, "down");
  const target1 = roundToTick(fixedEntry * 1.50, tick, "up");
  const target2 = roundToTick(fixedEntry * 2.50, tick, "up");
  const riskPerUnit = fixedEntry - stopLoss;
  const reward1PerUnit = target1 - fixedEntry;
  const reward2PerUnit = target2 - fixedEntry;
  const rrTarget1 = reward1PerUnit / riskPerUnit;
  const rr = reward2PerUnit / riskPerUnit;
  if (!(riskPerUnit > 0 && reward1PerUnit > 0 && reward2PerUnit > reward1PerUnit) ||
      !Number.isFinite(rr) || rr < 2) {
    return { ok: false, reason: "Tick-rounded fixed SL/Target 2 fails the minimum 1:2 reward/risk rule." };
  }
  const money = value => Number(value.toFixed(2));
  return {
    ok: true,
    model: "FIXED_30_PERCENT_SL_1_5X_2_5X",
    entryPrice: fixedEntry,
    stopLoss: money(stopLoss),
    target: money(target1),
    target1: money(target1),
    target2: money(target2),
    riskPerUnit: money(riskPerUnit),
    rewardPerUnit: money(reward1PerUnit),
    rewardTarget2PerUnit: money(reward2PerUnit),
    rr: Number(rr.toFixed(4)),
    rrTarget1: Number(rrTarget1.toFixed(4)),
    rrTarget2: Number(rr.toFixed(4)),
    lotSize: lots,
    quantity: lots,
    riskPerLot: money(riskPerUnit * lots),
    premiumPerLot: money(fixedEntry * lots),
    target1RewardPerLot: money(reward1PerUnit * lots),
    target2RewardPerLot: money(reward2PerUnit * lots),
    targetAllocation: "SEQUENTIAL_OR_TESTED_LOT_SPLIT_REQUIRED"
  };
}
