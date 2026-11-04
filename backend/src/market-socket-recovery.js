export function canScheduleMarketSocketFallback({
  sessionOpen, hasToken, hasSocket, connected, timerPending
}) {
  return Boolean(sessionOpen && hasToken && hasSocket && !connected && !timerPending);
}
