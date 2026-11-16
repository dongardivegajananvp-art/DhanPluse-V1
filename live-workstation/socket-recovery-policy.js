export const SOCKET_RECOVERY_BASE_DELAY_MS = 5_000;
export const SOCKET_RECOVERY_MAX_DELAY_MS = 60_000;

// Bounded exponential retry: 5s, 10s, 20s, 40s, then 60s indefinitely.
export function socketRecoveryDelayMs(attempt) {
  const count = Math.max(1, Math.trunc(Number(attempt) || 1));
  return Math.min(SOCKET_RECOVERY_MAX_DELAY_MS,
    SOCKET_RECOVERY_BASE_DELAY_MS * (2 ** Math.min(count - 1, 4)));
}
