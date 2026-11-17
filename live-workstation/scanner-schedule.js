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


export function shouldRetryFnoUniverse({
  socketConnected = false, marketOpen = false, mcxOnlyMode = false,
  restBudgetReady = false, cooldownActive = false, recoveryProbeRequired = false,
  universeLoaded = false, subscriptionWindowReady = false,
  lastAttemptAt = 0, now = Date.now(), retryIntervalMs = 60_000
} = {}) {
  const elapsed = Number(now) - Number(lastAttemptAt);
  const interval = Number(retryIntervalMs);
  return Boolean(
    socketConnected && marketOpen && !mcxOnlyMode && restBudgetReady &&
    !cooldownActive && !recoveryProbeRequired &&
    (!universeLoaded || !subscriptionWindowReady) &&
    Number.isFinite(elapsed) && Number.isFinite(interval) && interval > 0 && elapsed >= interval
  );
}

export function prioritizeScannerSymbols(activeSymbols = [], prioritySymbols = []) {
  const active = [...new Set((Array.isArray(activeSymbols) ? activeSymbols : []).filter(x => typeof x === 'string' && x.length))];
  const activeSet = new Set(active);
  const priority = [...new Set((Array.isArray(prioritySymbols) ? prioritySymbols : []).filter(x => activeSet.has(x)))];
  const prioritySet = new Set(priority);
  return [...priority, ...active.filter(symbol => !prioritySet.has(symbol))];
}
