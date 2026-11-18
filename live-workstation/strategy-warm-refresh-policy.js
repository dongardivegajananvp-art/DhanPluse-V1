export function reserveStrategyWarmRefresh(state, {
  now = Date.now(),
  minIntervalMs = 30_000,
  budgetReady = true,
  cooldownActive = false,
  recoveryProbeRequired = false
} = {}) {
  if (state.busy) return { reserved: false, reason: 'BUSY' };
  if (now - Number(state.lastAt || 0) < minIntervalMs) {
    return { reserved: false, reason: 'THROTTLED' };
  }
  if (!budgetReady || cooldownActive || recoveryProbeRequired) {
    // Record the pause time for throttling, but never acquire the busy lock.
    state.lastAt = now;
    return { reserved: false, reason: 'REST_PAUSED' };
  }
  state.busy = true;
  state.lastAt = now;
  return { reserved: true, reason: 'READY' };
}

export function releaseStrategyWarmRefresh(state) {
  state.busy = false;
}
