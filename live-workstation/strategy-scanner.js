function epochSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n / 1000 : n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}

export function selectNearestOptionContract(contracts, side, underlyingPrice, now = Date.now()) {
  if (!Array.isArray(contracts) || !['CE','PE'].includes(side) ||
      !Number.isFinite(Number(underlyingPrice)) || Number(underlyingPrice) <= 0) return null;
  const eligible = contracts.filter(contract => {
    const expiry = epochSeconds(contract?.expiry);
    return contract && contract.side === side &&
      typeof contract.symbol === 'string' && contract.symbol.length > 0 &&
      Number.isFinite(Number(contract.strike)) && Number(contract.strike) > 0 &&
      Number.isFinite(Number(contract.tickSize)) && Number(contract.tickSize) > 0 &&
      Number.isInteger(Number(contract.lotSize)) && Number(contract.lotSize) > 0 &&
      expiry * 1000 > now;
  });
  eligible.sort((a, b) => epochSeconds(a.expiry) - epochSeconds(b.expiry) ||
    Math.abs(Number(a.strike) - Number(underlyingPrice)) - Math.abs(Number(b.strike) - Number(underlyingPrice)) ||
    a.symbol.localeCompare(b.symbol));
  if (!eligible.length) return null;
  const best = eligible[0];
  return { ...best, strike: Number(best.strike), tickSize: Number(best.tickSize), lotSize: Number(best.lotSize) };
}

export function completedDailyCandles(candles, now = Date.now(), maxAgeSeconds = 4 * 86400) {
  if (!Array.isArray(candles)) return { candles: [], ok: false, reason: 'Daily FYERS candles are unavailable' };
  const istDay = seconds => new Date((Number(seconds) + 19800) * 1000).toISOString().slice(0, 10);
  const today = istDay(now / 1000);
  const rows = candles.filter(c => c && ['time','open','high','low','close'].every(k =>
    c[k] !== null && c[k] !== undefined && Number.isFinite(Number(c[k]))) &&
    Number(c.time) > 0 && Number(c.open) > 0 && Number(c.high) >= Math.max(Number(c.open), Number(c.close), Number(c.low)) &&
    Number(c.low) <= Math.min(Number(c.open), Number(c.close)) && istDay(c.time) < today)
    .sort((a,b) => Number(a.time) - Number(b.time));
  if (rows.length < 51) return { candles: rows, ok: false, reason: 'At least 51 completed daily FYERS candles are required' };
  const latest = Number(rows.at(-1).time);
  const age = now / 1000 - latest;
  if (age < 0 || age > maxAgeSeconds) return { candles: rows, ok: false, reason: 'Latest completed daily FYERS candle is stale' };
  return { candles: rows, ok: true, reason: '' };
}

export function strategyCandidateKey(underlying, contract) {
  return String(underlying || '') + '|' + String(contract || '');
}
