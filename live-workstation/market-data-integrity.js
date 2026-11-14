const DEFAULT_MAX_AGE_MS = 15_000;
const MAX_FUTURE_SKEW_SECONDS = 3;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000_000;

export function exchangeTickFreshness(tick, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!tick || typeof tick !== 'object') return { status: 'MISSING', ageMs: null, exchangeAgeSeconds: null };
  const price = Number(tick.price);
  const exchangeTime = Number(tick.exchangeTime);
  const receivedAt = Number(tick.receivedAt);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(exchangeTime) || exchangeTime <= 0 || exchangeTime > MAX_DATE_EPOCH_SECONDS ||
      !Number.isFinite(receivedAt) || receivedAt <= 0) {
    return { status: 'INVALID', ageMs: null, exchangeAgeSeconds: null };
  }
  const ageMs = now - receivedAt;
  const exchangeAgeSeconds = now / 1000 - exchangeTime;
  if (exchangeAgeSeconds < -MAX_FUTURE_SKEW_SECONDS) {
    return { status: 'FUTURE', ageMs, exchangeAgeSeconds };
  }
  if (ageMs < 0 || ageMs > maxAgeMs || exchangeAgeSeconds > 10) {
    return { status: 'STALE', ageMs, exchangeAgeSeconds };
  }
  return { status: 'FRESH', ageMs, exchangeAgeSeconds };
}

export function acceptExchangeTick(previous, candidate, now = Date.now()) {
  const freshness = exchangeTickFreshness(candidate, now, Number.MAX_SAFE_INTEGER);
  if (freshness.status === 'INVALID' || freshness.status === 'MISSING') {
    return { accepted: false, reason: 'INVALID_EXCHANGE_TICK' };
  }
  if (freshness.status === 'FUTURE') {
    return { accepted: false, reason: 'FUTURE_EXCHANGE_TIMESTAMP' };
  }
  if (previous && Number(candidate.exchangeTime) < Number(previous.exchangeTime)) {
    return { accepted: false, reason: 'OUT_OF_ORDER_EXCHANGE_TIMESTAMP' };
  }
  return { accepted: true, reason: '' };
}

export function summarizeFeedFreshness(symbols, ticks, now = Date.now()) {
  const rows = [...new Set(Array.isArray(symbols) ? symbols : [])].map(symbol => {
    const tick = ticks instanceof Map ? ticks.get(symbol) : ticks?.[symbol];
    const freshness = exchangeTickFreshness(tick, now);
    return {
      symbol,
      status: freshness.status,
      exchangeTimestamp: Number.isFinite(Number(tick?.exchangeTime)) && Number(tick.exchangeTime) > 0 && Number(tick.exchangeTime) <= MAX_DATE_EPOCH_SECONDS
        ? new Date(Number(tick.exchangeTime) * 1000).toISOString()
        : null,
      exchangeAgeSeconds: Number.isFinite(freshness.exchangeAgeSeconds)
        ? Math.round(freshness.exchangeAgeSeconds * 10) / 10
        : null
    };
  });
  const freshCount = rows.filter(row => row.status === 'FRESH').length;
  const staleCount = rows.filter(row => row.status === 'STALE' || row.status === 'FUTURE').length;
  const missingCount = rows.filter(row => row.status === 'MISSING' || row.status === 'INVALID').length;
  return {
    requiredCount: rows.length,
    freshCount,
    staleCount,
    missingCount,
    coveragePercent: rows.length ? Math.round(freshCount / rows.length * 1000) / 10 : 0,
    latestFreshExchangeTimestamp: rows.filter(row => row.status === 'FRESH' && row.exchangeTimestamp)
      .map(row => row.exchangeTimestamp).sort().at(-1) || null,
    staleOrMissingSamples: rows.filter(row => row.status !== 'FRESH').slice(0, 8)
  };
}

export function getScannerRuntimeState({
  authenticated, socketConnected, marketOpen, ledgerReady,
  universeCount, activeSubscriptions, freshFutureTicks
}) {
  if (!authenticated) return { state: 'BLOCKED_FYERS_SESSION', blocker: 'FYERS authentication is unavailable' };
  if (!socketConnected) return { state: 'WAITING_FOR_WEBSOCKET', blocker: 'FYERS WebSocket is not connected' };
  if (!marketOpen) return { state: 'MARKET_CLOSED', blocker: 'NSE regular market session is closed; live scan is paused' };
  if (!ledgerReady) return { state: 'BLOCKED_LEDGER_UNAVAILABLE', blocker: 'Persistent strategy plan ledger has not passed its readiness check' };
  if (!universeCount) return { state: 'WAITING_FOR_FNO_UNIVERSE', blocker: 'Official FYERS F&O universe is not loaded' };
  if (!activeSubscriptions) return { state: 'WAITING_FOR_SUBSCRIPTIONS', blocker: 'No active F&O futures subscription window is available' };
  if (!freshFutureTicks) return { state: 'WAITING_FOR_FRESH_FNO_TICKS', blocker: 'No active-window F&O future has a fresh exchange tick' };
  return { state: 'READY_OR_SCANNING', blocker: null };
}
