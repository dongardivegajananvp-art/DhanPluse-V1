export function fyersExpiryEpochSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;
  const raw = String(value).trim();
  const compact = /^(\\d{4})(\\d{2})(\\d{2})$/.exec(raw);
  const dateOnly = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(raw);
  const match = compact || dateOnly;
  if (match) {
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return 0;
    return Date.UTC(year, month - 1, day, 10, 0, 0) / 1000;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const stamp = numeric > 1e12 ? numeric / 1000 : numeric;
    const date = new Date(stamp * 1000);
    if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 10, 0, 0) / 1000;
    }
    return stamp;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}
