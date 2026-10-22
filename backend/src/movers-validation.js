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
