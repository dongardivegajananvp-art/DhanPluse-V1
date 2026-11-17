import crypto from 'node:crypto';

export const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Persist only a one-way digest of the OAuth state; never store/log the raw value.
export function oauthStateStorageKey(state) {
  const value = String(state || '').trim();
  if (!/^[a-f0-9]{48}$/i.test(value)) return '';
  return 'gv2vpd-live-workstation-oauth-state:' + crypto.createHash('sha256').update(value).digest('hex');
}

export function oauthStateIsFresh(record, now = Date.now(), ttlMs = AUTH_STATE_TTL_MS) {
  const createdAt = Number(record?.createdAt);
  return Boolean(Number.isFinite(createdAt) && createdAt > 0 && createdAt <= now && now - createdAt <= ttlMs);
}
