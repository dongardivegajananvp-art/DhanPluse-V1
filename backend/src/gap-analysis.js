export function analyzeOpeningGap({ previousClose, todayOpen, relativeVolume = null, majorEvent = false }) {
  const close = Number(previousClose), open = Number(todayOpen);
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(open) || open <= 0) throw new Error('verified_previous_close_and_open_required');
  const gapPct = (open - close) / close * 100, abs = Math.abs(gapPct);
  const direction = gapPct > 0 ? 'gap-up' : gapPct < 0 ? 'gap-down' : 'flat';
  const size = abs < 0.3 ? 'tiny' : abs < 0.8 ? 'small' : abs < 1.2 ? 'moderate' : 'large';
  const rv = relativeVolume === null || relativeVolume === undefined || relativeVolume === '' ? null : Number(relativeVolume);
  const elevatedVolume = rv !== null && Number.isFinite(rv) && rv >= 1.5;
  const context = majorEvent ? 'event-risk' : abs >= 1.2 && elevatedVolume ? 'large-gap-elevated-volume' : abs < 0.8 && !elevatedVolume ? 'small-gap-no-confirmed-volume-expansion' : 'mixed-context';
  return { direction, gapPct: Number(gapPct.toFixed(4)), size, relativeVolume: rv !== null && Number.isFinite(rv) && rv > 0 ? rv : null, elevatedVolume, majorEvent: Boolean(majorEvent), context, tradeSignal: null, note: 'Descriptive classification only. Gap continuation/fill is not guaranteed; participant intent cannot be inferred from the gap alone.' };
}

export function summarizeHistoricalGaps(bars, { minAbsGapPct = 0.3 } = {}) {
  if (!Array.isArray(bars) || bars.length < 2) throw new Error('at_least_two_verified_daily_bars_required');
  const ordered = [...bars].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), records = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], cur = ordered[i];
    const nums = [prev.close, cur.open, cur.high, cur.low, cur.close].map(Number);
    if (prev.verified !== true || cur.verified !== true || ![prev.timestamp, cur.timestamp].every(t => Number.isFinite(Date.parse(t))) || !nums.every(n => Number.isFinite(n) && n > 0) || Number(cur.high) < Math.max(Number(cur.open), Number(cur.close), Number(cur.low)) || Number(cur.low) > Math.min(Number(cur.open), Number(cur.close), Number(cur.high))) throw new Error('unverified_or_invalid_daily_bar_' + i);
    const previousClose = Number(prev.close), open = Number(cur.open), gapPct = (open - previousClose) / previousClose * 100;
    if (Math.abs(gapPct) < minAbsGapPct) continue;
    const filled = gapPct > 0 ? Number(cur.low) <= previousClose : Number(cur.high) >= previousClose;
    records.push({ timestamp: cur.timestamp, gapPct: Number(gapPct.toFixed(4)), direction: gapPct > 0 ? 'gap-up' : 'gap-down', filled });
  }
  const filledCount = records.filter(r => r.filled).length;
  return { sampleSize: records.length, filledCount, unfilledCount: records.length - filledCount, fillRatePct: records.length ? Number((filledCount / records.length * 100).toFixed(2)) : null, minAbsGapPct, records, warning: 'Historical descriptive rate only, not a forecast. Requires complete verified candles and excludes fees, slippage, overnight news and execution constraints.' };
}
