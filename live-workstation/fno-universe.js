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
  if (exchange === 'NSE' && normalized === 'FINNIFTY') return 'NSE:FINNIFTY-INDEX';
  if (exchange === 'NSE' && normalized === 'MIDCPNIFTY') return 'NSE:MIDCPNIFTY-INDEX';
  if (exchange === 'NSE' && normalized === 'NIFTYNXT50') return 'NSE:NIFTYNXT50-INDEX';
  if (exchange === 'BSE' && normalized === 'SENSEX') return 'BSE:SENSEX-INDEX';
  if (exchange === 'BSE' && normalized === 'BANKEX') return 'BSE:BANKEX-INDEX';
  return exchange + ':' + normalized + '-EQ';
}

const uniqueSymbols = values => [...new Set((Array.isArray(values) ? values : [])
  .filter(value => typeof value === 'string' && value.trim())
  .map(value => value.trim()))];

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
    if (!current || expiry < current.expiry || (expiry === current.expiry && symbol.localeCompare(current.futureSymbol) < 0)) {
      nearest.set(underlyingSymbol, { futureSymbol: symbol, underlyingSymbol, expiry, exchange });
    }
  }
  return [...nearest.values()].sort((a, b) => a.underlyingSymbol.localeCompare(b.underlyingSymbol));
}

// Cursor stays anchored to the full universe so changing pinned symbols cannot
// re-index the rotating list and starve otherwise eligible F&O contracts.
export function selectFairSubscriptionBatch({ baseSymbols = [], pinnedSymbols = [], universeSymbols = [], cursor = 0, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Subscription limit must be a positive integer');
  const fixed = uniqueSymbols([...baseSymbols, ...pinnedSymbols]);
  if (fixed.length > limit) throw new RangeError('Pinned FYERS symbols exceed the configured subscription limit');
  const universe = uniqueSymbols(universeSymbols);
  if (!universe.length) return { symbols: fixed, fnoSymbols: [], nextCursor: 0, scannedCount: 0, rotatingCount: 0, universeCount: 0, pinnedUniverseCount: 0 };
  const start = ((Math.trunc(Number(cursor) || 0) % universe.length) + universe.length) % universe.length;
  const capacity = limit - fixed.length;
  const selected = [];
  let scannedCount = 0;
  while (scannedCount < universe.length && selected.length < capacity) {
    const symbol = universe[(start + scannedCount) % universe.length];
    scannedCount += 1;
    if (!fixed.includes(symbol)) selected.push(symbol);
  }
  const pinnedUniverseCount = universe.filter(symbol => fixed.includes(symbol)).length;
  const pinnedUniverseSymbols = universe.filter(symbol => fixed.includes(symbol));
  const activeUniverseSymbols = [...pinnedUniverseSymbols, ...selected];
  return {
    symbols: [...fixed, ...selected], fnoSymbols: activeUniverseSymbols,
    nextCursor: (start + scannedCount) % universe.length, scannedCount,
    rotatingCount: selected.length, universeCount: universe.length, pinnedUniverseCount,
    pinnedUniverseSymbols
  };
}

export function summarizeFnoCoverage(universeSymbols, requestedSymbols, freshSymbols) {
  const universe = uniqueSymbols(universeSymbols);
  const requested = new Set(uniqueSymbols(requestedSymbols));
  const fresh = new Set(uniqueSymbols(freshSymbols));
  const requestedInUniverse = universe.filter(symbol => requested.has(symbol));
  const freshInUniverse = universe.filter(symbol => fresh.has(symbol));
  const freshRequested = requestedInUniverse.filter(symbol => fresh.has(symbol));
  return {
    universeCount: universe.length,
    requestedCount: requestedInUniverse.length,
    notRequestedCount: universe.length - requestedInUniverse.length,
    freshUniverseCount: freshInUniverse.length,
    freshRequestedCount: freshRequested.length,
    staleOrMissingRequestedCount: requestedInUniverse.length - freshRequested.length,
    requestedCoveragePercent: universe.length ? Math.round(requestedInUniverse.length / universe.length * 1000) / 10 : 0,
    freshUniverseCoveragePercent: universe.length ? Math.round(freshInUniverse.length / universe.length * 1000) / 10 : 0,
    activeWindowFreshnessPercent: requestedInUniverse.length ? Math.round(freshRequested.length / requestedInUniverse.length * 1000) / 10 : 0,
    notRequestedSamples: universe.filter(symbol => !requested.has(symbol)).slice(0, 8),
    staleOrMissingSamples: requestedInUniverse.filter(symbol => !fresh.has(symbol)).slice(0, 8)
  };
}

// Compatibility wrapper for existing consumers; rotation should use the stable-cursor API.
export function selectSubscriptionBatch({ baseSymbols = [], pinnedSymbols = [], universeSymbols = [], cursor = 0, limit = 100 } = {}) {
  const batch = selectFairSubscriptionBatch({ baseSymbols, pinnedSymbols, universeSymbols, cursor, limit });
  return { symbols: batch.symbols, nextCursor: batch.nextCursor, rotatingCount: batch.rotatingCount, universeCount: batch.universeCount };
}
