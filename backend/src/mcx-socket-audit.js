/**
 * Convert the current in-memory FYERS WebSocket ticks into the same minimal
 * quote-row shape consumed by the strict MCX audit. Exchange timestamps are
 * copied from the tick only; local receive time is never used as a fallback.
 */
export function buildMcxSocketQuoteRows(universe, ticks) {
  if (!Array.isArray(universe) || !universe.length || !(ticks instanceof Map)) {
    throw new Error("mcx_socket_snapshot_inputs_required");
  }
  return universe.flatMap((item) => {
    const tick = ticks.get(item.symbol);
    if (!tick) return [];
    const timestampMs = Date.parse(String(tick.updatedAt || ""));
    const quote = {
      lp: Number.isFinite(Number(tick.ltp)) && Number(tick.ltp) > 0 ? Number(tick.ltp) : undefined,
      chp: tick.chp != null && Number.isFinite(Number(tick.chp)) ? Number(tick.chp) : undefined,
      exch_feed_time: Number.isFinite(timestampMs) && timestampMs > 0
        ? Math.floor(timestampMs / 1000) : undefined
    };
    return [{ n: item.symbol, v: quote }];
  });
}
