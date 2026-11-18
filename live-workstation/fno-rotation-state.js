export function resolveFnoRotationCursor({
  universeSymbols = [],
  savedActiveSymbol = '',
  savedActiveCursor = 0
} = {}) {
  const symbols = [...new Set((Array.isArray(universeSymbols) ? universeSymbols : [])
    .filter(value => typeof value === 'string' && value.length > 0))];
  if (!symbols.length) return 0;
  const anchoredIndex = savedActiveSymbol ? symbols.indexOf(savedActiveSymbol) : -1;
  if (anchoredIndex >= 0) return anchoredIndex;
  const fallback = Number(savedActiveCursor);
  return Number.isInteger(fallback) && fallback >= 0 ? fallback % symbols.length : 0;
}
