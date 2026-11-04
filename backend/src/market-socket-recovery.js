export function canScheduleMarketSocketFallback({
  sessionOpen, hasToken, hasSocket, connected, timerPending
}) {
  return Boolean(sessionOpen && hasToken && hasSocket && !connected && !timerPending);
}

export function getMarketSocketReconnectDelay(attempt, baseDelayMs = 20_000, maxDelayMs = 120_000) {
  const safeAttempt = Number.isFinite(Number(attempt)) ? Math.max(0, Math.floor(Number(attempt))) : 0;
  const safeBase = Number.isFinite(Number(baseDelayMs)) && Number(baseDelayMs) > 0 ? Number(baseDelayMs) : 20_000;
  const safeMax = Number.isFinite(Number(maxDelayMs)) && Number(maxDelayMs) >= safeBase ? Number(maxDelayMs) : 120_000;
  return Math.min(safeMax, safeBase * (2 ** Math.min(safeAttempt, 10)));
}
