// Shared exchange-timestamp gate for live quote paths.
// timestampSeconds must be an exchange/last-traded timestamp, not fetch time.
export function quoteTimestampStatus(timestampSeconds, nowMs = Date.now(), maxAgeSeconds = 30) {
  const timestamp = Number(timestampSeconds);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(nowMs) ||
      !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) return 'TIME_UNVERIFIED';
  const ageSeconds = nowMs / 1000 - timestamp;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'TIME_UNVERIFIED';
  return ageSeconds <= maxAgeSeconds ? 'FRESH' : 'STALE';
}
