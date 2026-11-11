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


/**
 * Wait briefly for the FYERS socket to deliver a complete, simultaneously fresh
 * MCX futures snapshot after subscriptions have been applied. This is a bounded
 * collection window, not a freshness relaxation: every row must still pass the
 * caller's exchange-timestamp audit at the same instant.
 */
export async function waitForCompleteMcxSocketAudit({
  getAudit,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 60_000,
  pollIntervalMs = 1_000
} = {}) {
  if (typeof getAudit !== "function" || typeof now !== "function" ||
      typeof sleep !== "function" || !Number.isFinite(timeoutMs) || timeoutMs < 0 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("invalid_mcx_socket_audit_wait_options");
  }
  const startedAt = now();
  let audit = null;
  while (true) {
    audit = await getAudit();
    const elapsedMs = Math.max(0, now() - startedAt);
    if (audit?.complete) return { audit, waitedMs: elapsedMs, timedOut: false };
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  return { audit, waitedMs: Math.max(0, now() - startedAt), timedOut: true };
}
