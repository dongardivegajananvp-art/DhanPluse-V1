/**
 * Allow only the baseline indices or equities in the authenticated FYERS F&O symbol master.
 * Never broaden this to a regex-only NSE symbol check: arbitrary/unverified tickers must fail closed.
 */
export function isAllowedChartSymbol(symbol, indexSymbols, verifiedFnoSymbols) {
  if (typeof symbol !== "string" || !symbol.trim()) return false;
  return indexSymbols.includes(symbol) || verifiedFnoSymbols.has(symbol);
}
