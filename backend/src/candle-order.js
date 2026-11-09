/**
 * Normalize FYERS history candles to chronological order without guessing.
 * A strictly descending sequence is safe to reverse; duplicates or mixed
 * ordering are ambiguous and must remain blocked.
 */
export function normalizeFyersCandleOrder(candles) {
  if (!Array.isArray(candles)) return { ok: false, reason: "invalid_candle_array" };
  const timestamps = candles.map(row => Number(Array.isArray(row) ? row[0] : NaN));
  if (!timestamps.every(value => Number.isFinite(value) && value > 0)) return { ok: false, reason: "invalid_timestamps" };
  if (candles.length < 2) return { ok: true, order: "ascending", data: candles.slice() };
  const deltas = timestamps.slice(1).map((value, index) => value - timestamps[index]);
  if (deltas.every(delta => delta > 0)) return { ok: true, order: "ascending", data: candles.slice() };
  if (deltas.every(delta => delta < 0)) return { ok: true, order: "descending_reversed", data: candles.slice().reverse() };
  if (deltas.some(delta => delta === 0)) return { ok: false, reason: "duplicate_timestamps" };
  return { ok: false, reason: "mixed_timestamp_order" };
}
