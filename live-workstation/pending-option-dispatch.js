export function claimPendingCandidateProcessing(candidate, { optionTick, underlyingTick, isFresh, nowMs = Date.now(), minIntervalMs = 1000 } = {}) {
  if (!candidate || candidate.processing || typeof isFresh !== 'function') return false;
  if (!isFresh(optionTick) || !isFresh(underlyingTick)) return false;
  const lastStarted = Number(candidate.lastProcessingStartedAt) || 0;
  if (lastStarted && nowMs - lastStarted < minIntervalMs) return false;
  candidate.lastProcessingStartedAt = nowMs;
  candidate.processing = true;
  return true;
}

export function releasePendingCandidateProcessing(candidate) {
  if (!candidate) return false;
  candidate.processing = false;
  return true;
}
