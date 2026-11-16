export function shouldRestartSilentIndexFeed({
  marketOpen, socketConnected, freshIndexCount, requiredIndexCount,
  staleSince, now = Date.now(), restartAfterMs = 30_000
}) {
  return Boolean(
    marketOpen &&
    socketConnected &&
    Number(requiredIndexCount) > 0 &&
    Number(freshIndexCount) < Number(requiredIndexCount) &&
    Number.isFinite(Number(staleSince)) &&
    Number(staleSince) > 0 &&
    Number(now) - Number(staleSince) >= restartAfterMs
  );
}
