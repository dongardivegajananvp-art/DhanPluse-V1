/**
 * Keep the shared FYERS Data API budget reserved for either Sureshot scan
 * across the gaps between its five-candidate HTTP batches. NSE and MCX keep
 * independent scan state, but both share the same upstream account/IP budget.
 */
export function isSureshotScanPriorityActive({
  scanInFlight = false,
  nseScanState = null,
  mcxScanState = null,
  now = Date.now(),
  ttlMs = 30 * 60 * 1000
} = {}) {
  if (scanInFlight) return true;
  const isActive = (state) => {
    const createdAt = Number(state?.createdAt);
    return Number.isFinite(createdAt) && createdAt <= now && now - createdAt <= ttlMs;
  };
  return isActive(nseScanState) || isActive(mcxScanState);
}
