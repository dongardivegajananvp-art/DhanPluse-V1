export function boundedRetryDelayMs({ attempt = 1, retryAfterMs = 0, baseMs = 15_000, maxMs = 300_000 } = {}) {
  const step = Math.max(1, Math.min(5, Number(attempt) || 1));
  const base = Math.max(1_000, Number(baseMs) || 15_000);
  const max = Math.max(base, Math.min(60 * 60_000, Number(maxMs) || 300_000));
  const exponential = Math.min(max, base * (2 ** (step - 1)));
  const retry = Number(retryAfterMs);
  return Number.isFinite(retry) && retry > 0
    ? Math.min(60 * 60_000, Math.max(exponential, retry))
    : exponential;
}
