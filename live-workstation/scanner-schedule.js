export const STRATEGY_SCAN_INTERVAL_MS = 12_000;
export const FNO_ROTATION_INTERVAL_MS = 16 * 60_000;
export const MAX_HISTORY_REQUESTS_PER_SCAN = 2;

export function estimateScannerRestRequestsPerMinute({
  intervalMs = STRATEGY_SCAN_INTERVAL_MS,
  maxRequestsPerScan = MAX_HISTORY_REQUESTS_PER_SCAN
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 ||
      !Number.isFinite(maxRequestsPerScan) || maxRequestsPerScan < 0) {
    throw new TypeError('Scanner interval and request count must be valid non-negative numbers');
  }
  return (60_000 / intervalMs) * maxRequestsPerScan;
}

export function canFinishSubscriptionWindowBeforeRotation(activeSymbols, {
  scanIntervalMs = STRATEGY_SCAN_INTERVAL_MS,
  rotationIntervalMs = FNO_ROTATION_INTERVAL_MS
} = {}) {
  return Number.isInteger(activeSymbols) && activeSymbols >= 0 &&
    Number.isFinite(scanIntervalMs) && scanIntervalMs > 0 &&
    Number.isFinite(rotationIntervalMs) && rotationIntervalMs > 0 &&
    activeSymbols * scanIntervalMs <= rotationIntervalMs;
}
