/**
 * Build a long-option risk plan from completed, validated FYERS option candles.
 * The premium entry is the independently verified ask price. The stop is the
 * recent completed-candle swing low; the target is at least 2R. No fallback
 * prices or synthetic candles are permitted.
 */
export function buildOptionRiskPlan({ candles, entryPrice, resolution = "5", now = Date.now(), lookback = 12 }) {
  const intervalMinutes = Number(resolution);
  if (!Number.isFinite(intervalMinutes) || ![5, 15, 30, 60].includes(intervalMinutes)) {
    return { ok: false, reason: "Unsupported option-candle interval." };
  }
  if (!Array.isArray(candles) || !Number.isInteger(lookback) || lookback < 12 || candles.length < lookback) {
    return { ok: false, reason: "At least 12 option candles are required for a risk plan." };
  }
  const entry = Number(entryPrice);
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
    valid.push({ time, low });
  }
  const intervalMs = intervalMinutes * 60_000;
  const completed = valid.filter(row => row.time * 1000 + intervalMs <= now);
  if (completed.length < lookback) {
    return { ok: false, reason: "Not enough completed option candles; the forming candle is excluded." };
  }
  const latest = completed[completed.length - 1];
  const candleAgeMs = now - (latest.time * 1000 + intervalMs);
  if (candleAgeMs < 0 || candleAgeMs > intervalMs * 3) {
    return { ok: false, reason: "Latest completed option candle is stale for the selected interval." };
  }
  const window = completed.slice(-lookback);
  const swingLow = Math.min(...window.map(row => row.low));
  // NSE option premiums use a ₹0.05 tick. Round the stop down and target up,
  // so rounding can never reduce the planned reward below 2R.
  const tick = 0.05;
  const stopLoss = Math.floor((swingLow + 1e-9) / tick) * tick;
  if (!(stopLoss > 0 && stopLoss < entry)) {
    return { ok: false, reason: "Recent option swing-low does not sit below the verified ask entry; no valid long-option risk plan." };
  }
  const riskPerUnit = entry - stopLoss;
  const rawTarget = entry + 2 * riskPerUnit;
  const target = Math.ceil((rawTarget - 1e-9) / tick) * tick;
  const round = value => Number(value.toFixed(2));
  const roundedEntry = round(entry);
  const roundedStop = round(stopLoss);
  const roundedTarget = round(target);
  const actualRisk = roundedEntry - roundedStop;
  const actualReward = roundedTarget - roundedEntry;
  const rr = actualReward / actualRisk;
  if (!(actualRisk > 0 && actualReward > 0 && rr >= 2)) {
    return { ok: false, reason: "Calculated risk/reward failed the minimum 1:2 rule." };
  }
  return {
    ok: true,
    entryPrice: roundedEntry,
    stopLoss: roundedStop,
    target: roundedTarget,
    riskPerUnit: round(actualRisk),
    rewardPerUnit: round(actualReward),
    rr: Number(rr.toFixed(2)),
    candleCount: window.length,
    lookback,
    latestCandleAt: new Date(latest.time * 1000).toISOString(),
    candleAgeSeconds: Number((candleAgeMs / 1000).toFixed(1)),
    method: "12 completed FYERS option candles; stop at recent swing low; target at or above 2R"
  };
}
