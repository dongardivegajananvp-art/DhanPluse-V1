export function claimPendingCandidateProcessing(candidate, { optionTick, underlyingTick, isFresh } = {}) {
  if (!candidate || candidate.processing || typeof isFresh !== 'function') return false;
  if (!isFresh(optionTick) || !isFresh(underlyingTick)) return false;
  candidate.processing = true;
  return true;
}

export function releasePendingCandidateProcessing(candidate) {
  if (!candidate) return false;
  candidate.processing = false;
  return true;
}
