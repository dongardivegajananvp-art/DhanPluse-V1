import { fyersExpiryEpochSeconds as epochSeconds } from './expiry-date.js';

export function selectNearestOptionContracts(contracts, side, underlyingPrice, count = 2, now = Date.now()) {
  if (!Array.isArray(contracts) || !['CE','PE'].includes(side) ||
      !Number.isFinite(Number(underlyingPrice)) || Number(underlyingPrice) <= 0 ||
      !Number.isInteger(count) || count < 1 || count > 4) return [];
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
  if (!eligible.length) return [];
  const nearestExpiry = epochSeconds(eligible[0].expiry);
  return eligible.filter(contract => epochSeconds(contract.expiry) === nearestExpiry).slice(0, count)
    .map(contract => ({ ...contract, strike: Number(contract.strike), tickSize: Number(contract.tickSize), lotSize: Number(contract.lotSize) }));
}

export function selectNearestOptionContract(contracts, side, underlyingPrice, now = Date.now()) {
  return selectNearestOptionContracts(contracts, side, underlyingPrice, 1, now)[0] || null;
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
  if (rows.length < 50) return { candles: rows, ok: false, reason: 'At least 50 completed daily FYERS candles are required' };
  const latest = Number(rows.at(-1).time);
  const age = now / 1000 - latest;
  if (age < 0 || age > maxAgeSeconds) return { candles: rows, ok: false, reason: 'Latest completed daily FYERS candle is stale' };
  return { candles: rows, ok: true, reason: '' };
}

export function strategyCandidateKey(underlying, contract) {
  return String(underlying || '') + '|' + String(contract || '');
}
