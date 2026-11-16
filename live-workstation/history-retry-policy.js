export function historyRetryDelayMs({ statusCode = 0, retryAfterMs = 0, attempt = 1 } = {}) {
  const retry = Number(retryAfterMs);
  if (Number.isFinite(retry) && retry > 0) return Math.min(60 * 60_000, retry);
  if (Number(statusCode) === 429) return 60 * 60_000;
  const step = Math.max(1, Math.min(5, Number(attempt) || 1));
  return Math.min(5 * 60_000, 30_000 * (2 ** (step - 1)));
}
export function shouldAttemptHistoryRetry(retryAt, now = Date.now()) {
  return !Number.isFinite(Number(retryAt)) || Number(retryAt) <= Number(now);
}
