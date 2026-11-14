const FUTURE_SUFFIX = /^(NSE|BSE):(.+?)([0-9]{2}[A-Z]{3})FUT$/;

function epochSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric / 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}

function underlyingFor(exchange, root) {
  const normalized = String(root || '').toUpperCase();
  if (exchange === 'NSE' && normalized === 'NIFTY') return 'NSE:NIFTY50-INDEX';
  if (exchange === 'NSE' && normalized === 'BANKNIFTY') return 'NSE:NIFTYBANK-INDEX';
  if (exchange === 'BSE' && normalized === 'SENSEX') return 'BSE:SENSEX-INDEX';
  return exchange + ':' + normalized + '-EQ';
}

export function buildFnoUniverse({ nseMaster = {}, bseMaster = {}, now = Date.now() } = {}) {
  const nearest = new Map();
  for (const [symbol, row] of [...Object.entries(nseMaster), ...Object.entries(bseMaster)]) {
    if (!row || Number(row.tradeStatus) !== 1) continue;
    const match = String(symbol).match(FUTURE_SUFFIX);
    if (!match) continue;
    const expiry = epochSeconds(row.expiryDate);
    if (!expiry || expiry * 1000 <= now) continue;
    const [, exchange, root] = match;
    const underlyingSymbol = underlyingFor(exchange, root);
    const current = nearest.get(underlyingSymbol);
    if (!current || expiry < current.expiry) {
      nearest.set(underlyingSymbol, { futureSymbol: symbol, underlyingSymbol, expiry, exchange });
    }
  }
  return [...nearest.values()].sort((a, b) =>
    a.underlyingSymbol.localeCompare(b.underlyingSymbol)
  );
}

export function selectSubscriptionBatch({
  baseSymbols = [],
  pinnedSymbols = [],
  universeSymbols = [],
  cursor = 0,
  limit = 100
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Subscription limit must be a positive integer');
  const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  const fixed = unique([...baseSymbols, ...pinnedSymbols]);
  if (fixed.length > limit) throw new RangeError('Pinned FYERS symbols exceed the configured subscription limit');
  const rotating = unique(universeSymbols).filter(symbol => !fixed.includes(symbol));
  if (!rotating.length) return { symbols: fixed, nextCursor: 0, rotatingCount: 0, universeCount: unique(universeSymbols).length };
  const start = ((Math.trunc(cursor) % rotating.length) + rotating.length) % rotating.length;
  const capacity = limit - fixed.length;
  const count = Math.min(capacity, rotating.length);
  const selected = [];
  for (let i = 0; i < count; i++) selected.push(rotating[(start + i) % rotating.length]);
  return {
    symbols: [...fixed, ...selected],
    nextCursor: (start + count) % rotating.length,
    rotatingCount: selected.length,
    universeCount: unique(universeSymbols).length
  };
}
