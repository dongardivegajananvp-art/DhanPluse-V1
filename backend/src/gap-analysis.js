export function isValidIsoDate(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function analyzeOpeningGap({ previousClose, todayOpen }) {
  const close = Number(previousClose);
  const open = Number(todayOpen);
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(open) || open <= 0) {
    throw new Error("verified_previous_close_and_open_required");
  }
  const gapPct = (open - close) / close * 100;
  const abs = Math.abs(gapPct);
  return {
    direction: gapPct > 0 ? "gap-up" : gapPct < 0 ? "gap-down" : "flat",
    gapPct: Number(gapPct.toFixed(4)),
    size: abs < 0.3 ? "tiny" : abs < 0.8 ? "small" : abs < 1.2 ? "moderate" : "large",
    tradeSignal: null,
    note: "Descriptive only. Gap continuation or fill is not guaranteed; no trade signal is generated."
  };
}

function validateBar(bar, index) {
  if (!bar || bar.verified !== true || !Number.isFinite(Date.parse(bar.timestamp))) {
    throw new Error("unverified_or_invalid_daily_bar_" + index);
  }
  const o = Number(bar.open), h = Number(bar.high), l = Number(bar.low), c = Number(bar.close);
  if (![o, h, l, c].every(n => Number.isFinite(n) && n > 0) ||
      h < Math.max(o, c, l) || l > Math.min(o, c, h)) {
    throw new Error("unverified_or_invalid_daily_bar_" + index);
  }
}

export function summarizeHistoricalGaps(bars, { minAbsGapPct = 0.3 } = {}) {
  if (!Array.isArray(bars) || bars.length < 2) throw new Error("at_least_two_verified_daily_bars_required");
  const threshold = Number(minAbsGapPct);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 20) throw new Error("invalid_minimum_gap_threshold");
  const ordered = [...bars].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (let i = 0; i < ordered.length; i++) {
    validateBar(ordered[i], i);
    if (i > 0 && Date.parse(ordered[i].timestamp) <= Date.parse(ordered[i - 1].timestamp)) {
      throw new Error("duplicate_or_nonincreasing_daily_timestamp_" + i);
    }
  }
  const records = [];
  for (let i = 1; i < ordered.length; i++) {
    const previousClose = Number(ordered[i - 1].close);
    const current = ordered[i];
    const gapPct = (Number(current.open) - previousClose) / previousClose * 100;
    if (Math.abs(gapPct) < threshold) continue;
    records.push({
      timestamp: current.timestamp,
      gapPct: Number(gapPct.toFixed(4)),
      direction: gapPct > 0 ? "gap-up" : "gap-down",
      filled: gapPct > 0 ? Number(current.low) <= previousClose : Number(current.high) >= previousClose
    });
  }
  const filledCount = records.filter(record => record.filled).length;
  return {
    sampleSize: records.length,
    filledCount,
    unfilledCount: records.length - filledCount,
    fillRatePct: records.length ? Number((filledCount / records.length * 100).toFixed(2)) : null,
    minAbsGapPct: threshold,
    records,
    warning: "Historical descriptive rate only, not a forecast. Excludes fees, slippage, overnight news and execution constraints."
  };
}
