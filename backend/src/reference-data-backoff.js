// Exponential retry delay for public reference-data masters.
// This limits repeated failed downloads without ever substituting stale symbols.
export function getReferenceDataRetryDelay(failureCount, baseMs = 30_000, maxMs = 300_000) {
  const attempt = Number.isFinite(Number(failureCount)) ? Math.max(1, Math.floor(Number(failureCount))) : 1;
  const base = Number.isFinite(Number(baseMs)) && Number(baseMs) > 0 ? Number(baseMs) : 30_000;
  const maximum = Number.isFinite(Number(maxMs)) && Number(maxMs) > 0 ? Number(maxMs) : 300_000;
  return Math.min(maximum, base * (2 ** Math.min(attempt - 1, 20)));
}
