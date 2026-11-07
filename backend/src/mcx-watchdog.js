// Bounded MCX-only subscription recovery. Repeated subscribe calls on a
// healthy shared socket do not prove that FYERS is delivering exchange ticks;
// progressively space retries and reset only after a verified MCX tick.
const RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];

export function getMcxWatchdogRetryDelay(retryCount = 0) {
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error("invalid_mcx_watchdog_retry_count");
  }
  return RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
}
