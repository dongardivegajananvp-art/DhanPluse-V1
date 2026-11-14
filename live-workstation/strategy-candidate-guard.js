function expiryEpoch(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}

export function validateOptionContractIdentity(candidate, official, now = Date.now()) {
  if (!candidate || !official || candidate.symbol !== official.symbol) return { ok: false, reason: 'Option contract symbol does not match the current FYERS Symbol Master' };
  if (!['CE', 'PE'].includes(String(candidate.side)) || candidate.side !== official.side) return { ok: false, reason: 'Option side does not match the current FYERS Symbol Master' };
  for (const key of ['strike', 'tickSize', 'lotSize']) {
    const left = Number(candidate[key]), right = Number(official[key]);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left !== right) return { ok: false, reason: 'Option ' + key + ' does not match the current FYERS Symbol Master' };
  }
  const candidateExpiry = expiryEpoch(candidate.expiry);
  const officialExpiry = expiryEpoch(official.expiryDate ?? official.expiry);
  if (!candidateExpiry || !officialExpiry || candidateExpiry !== officialExpiry || candidateExpiry * 1000 <= now) {
    return { ok: false, reason: 'Option expiry is missing, expired, or does not match the current FYERS Symbol Master' };
  }
  return { ok: true, reason: '' };
}

export function sameStrategyConfirmation(original, refreshed) {
  return Boolean(original && refreshed &&
    original.strategy === refreshed.strategy &&
    original.side === refreshed.side &&
    Number(original.confirmedAt) === Number(refreshed.confirmedAt) &&
    Number(original.breakoutLevel) === Number(refreshed.breakoutLevel));
}
