export function assertCompleteMoverSnapshot({
  requestedSymbols,
  rows,
  failedBatches = [],
  receivedSymbols = new Set(),
  rateLimitError = null
}) {
  if (rateLimitError) throw rateLimitError;

  const requested = Array.isArray(requestedSymbols) ? requestedSymbols : [];
  const received = receivedSymbols instanceof Set ? receivedSymbols : new Set(receivedSymbols || []);
  const rowSymbols = new Set((Array.isArray(rows) ? rows : [])
    .map(row => row && row.symbol)
    .filter(symbol => typeof symbol === 'string' && symbol.length > 0));
  const failed = [...new Set([
    ...requested.filter(symbol => !received.has(symbol)),
    ...(Array.isArray(failedBatches) ? failedBatches : [])
  ])];

  if (requested.length === 0 || !Array.isArray(rows) ||
      rows.length !== requested.length || rowSymbols.size !== requested.length ||
      failed.length > 0) {
    const error = new Error('FYERS quote coverage incomplete; partial rankings are blocked.');
    error.statusCode = 502;
    error.failedSymbols = failed;
    throw error;
  }

  return true;
}

export function assertFreshMoverSnapshot(rows, marketOpen) {
  if (!marketOpen) return true;
  const list = Array.isArray(rows) ? rows : [];
  const staleSymbols = list
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !row || row.priceStatus !== 'LIVE_QUOTE' ||
      typeof row.symbol !== 'string' || row.symbol.length === 0)
    .map(({ row, index }) => row && typeof row.symbol === 'string' && row.symbol.length
      ? row.symbol : `<row-${index + 1}>`);
  if (list.length === 0 || staleSymbols.length > 0) {
    const error = new Error('FYERS returned an empty, stale, or timestamp-unverified quote snapshot; live rankings and dependent signals are blocked.');
    error.statusCode = 502;
    error.staleSymbols = list.length === 0 ? ['<empty-snapshot>'] : staleSymbols;
    throw error;
  }
  return true;
}
