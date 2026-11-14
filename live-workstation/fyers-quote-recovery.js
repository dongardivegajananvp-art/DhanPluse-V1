import { exchangeTickFreshness } from './market-data-integrity.js';

// A REST quote is only a recovery snapshot when FYERS supplies a recent exchange
// last-traded timestamp. Receipt time alone must never make an old quote live.
export function parseFyersQuoteTicks(payload, requestedSymbols, now = Date.now()) {
  const requested = new Set(Array.isArray(requestedSymbols) ? requestedSymbols : []);
  if (payload?.s !== 'ok') return [];
  const rows = Array.isArray(payload?.d) ? payload.d : [];
  const ticks = [];
  for (const row of rows) {
    const value = row?.v && typeof row.v === 'object' ? row.v : {};
    const symbol = String(row?.n || value.symbol || row?.symbol || '');
    if (!symbol || !requested.has(symbol) || row?.s !== 'ok' || (value.symbol && value.symbol !== symbol)) continue;
    const tick = {
      symbol,
      price: Number(value.lp),
      exchangeTime: Number(value.tt),
      receivedAt: now,
      previousClose: Number(value.prev_close_price) > 0 ? Number(value.prev_close_price) : null,
      source: 'FYERS_QUOTES_REST'
    };
    if (exchangeTickFreshness(tick, now, 15_000).status === 'FRESH') ticks.push(tick);
  }
  return ticks;
}
