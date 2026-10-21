export function analyzeOpeningGap({ previousClose, todayOpen, relativeVolume = null, majorEvent = false }) {
  const close = Number(previousClose), open = Number(todayOpen);
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(open) || open <= 0) {
    throw new Error("verified_previous_close_and_open_required");
  }
  const gapPct = (open - close) / close * 100;
  const abs = Math.abs(gapPct);
  const direction = gapPct > 0 ? "gap-up" : gapPct < 0 ? "gap-down" : "flat";
  const size = abs < 0.3 ? "tiny" : abs < 0.8 ? "small" : abs < 1.2 ? "moderate" : "large";
  const rv = relativeVolume === null || relativeVolume === undefined || relativeVolume === "" ? null : Number(relativeVolume);
  const validRelativeVolume = rv !== null && Number.isFinite(rv) && rv > 0 ? rv : null;
  const elevatedVolume = validRelativeVolume !== null && validRelativeVolume >= 1.5;
  const context = majorEvent ? "event-risk" : abs >= 1.2 && elevatedVolume ? "large-gap-elevated-volume" : abs < 0.8 && !elevatedVolume ? "small-gap-no-confirmed-volume-expansion" : "mixed-context";
  return {
    direction, gapPct: Number(gapPct.toFixed(4)), size, relativeVolume: validRelativeVolume,
    elevatedVolume, majorEvent: Boolean(majorEvent), context, tradeSignal: null,
    note: "Descriptive classification only. Gap continuation/fill is not guaranteed; participant intent cannot be inferred from the gap alone."
  };
}

function validateDailyBar(bar, index) {
  if (!bar || bar.verified !== true || !Number.isFinite(Date.parse(bar.timestamp))) {
    throw new Error("unverified_or_invalid_daily_bar_" + index);
  }
  const o = Number(bar.open), h = Number(bar.high), l = Number(bar.low), c = Number(bar.close);
  const v = bar.volume == null ? null : Number(bar.volume);
  if (![o, h, l, c].every(n => Number.isFinite(n) && n > 0) ||
      h < Math.max(o, c, l) || l > Math.min(o, c, h) ||
      (v !== null && (!Number.isFinite(v) || v < 0))) {
    throw new Error("unverified_or_invalid_daily_bar_" + index);
  }
}

export function summarizeHistoricalGaps(bars, { minAbsGapPct = 0.3 } = {}) {
  if (!Array.isArray(bars) || bars.length < 2) throw new Error("at_least_two_verified_daily_bars_required");
  if (!Number.isFinite(Number(minAbsGapPct)) || Number(minAbsGapPct) < 0 || Number(minAbsGapPct) > 20) {
    throw new Error("invalid_minimum_gap_threshold");
  }
  const ordered = [...bars].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (let i = 0; i < ordered.length; i++) {
    validateDailyBar(ordered[i], i);
    if (i > 0 && Date.parse(ordered[i].timestamp) <= Date.parse(ordered[i - 1].timestamp)) {
      throw new Error("duplicate_or_nonincreasing_daily_timestamp_" + i);
    }
  }
  const records = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], cur = ordered[i];
    const previousClose = Number(prev.close), open = Number(cur.open);
    const gapPct = (open - previousClose) / previousClose * 100;
    if (Math.abs(gapPct) < Number(minAbsGapPct)) continue;
    const filled = gapPct > 0 ? Number(cur.low) <= previousClose : Number(cur.high) >= previousClose;
    records.push({ timestamp: cur.timestamp, gapPct: Number(gapPct.toFixed(4)), direction: gapPct > 0 ? "gap-up" : "gap-down", filled });
  }
  const filledCount = records.filter(r => r.filled).length;
  return {
    sampleSize: records.length, filledCount, unfilledCount: records.length - filledCount,
    fillRatePct: records.length ? Number((filledCount / records.length * 100).toFixed(2)) : null,
    minAbsGapPct: Number(minAbsGapPct), records,
    warning: "Historical descriptive rate only, not a forecast. Requires complete verified candles and excludes fees, slippage, overnight news and execution constraints."
  };
}
