function normalizeName(value) {
  return String(value ?? "").trim().toUpperCase().replace(/^NSE:/, "").replace(/-EQ$/, "").replace(/[^A-Z0-9]/g, "");
}

/**
 * Derive the current NSE stock-F&O universe from the official FYERS symbol masters.
 * Resolves the underlying by token first, then by normalized documented name fields.
 * Index contracts are excluded because their underlyings do not map to NSE cash equities.
 */
export function buildFnoEquityUniverse(foMaster, cmMaster) {
  if (!foMaster || typeof foMaster !== "object" || !cmMaster || typeof cmMaster !== "object") {
    throw new Error("invalid_fyers_symbol_master");
  }
  const cashByToken = new Map();
  const cashByAlias = new Map();
  for (const [ticker, item] of Object.entries(cmMaster)) {
    if (!ticker.startsWith("NSE:") || !/-EQ$/.test(ticker) || Number(item?.tradeStatus) === 0) continue;
    const tickerName = /^NSE:(.+)-EQ$/.exec(ticker)?.[1];
    if (!tickerName) continue;
    const aliases = [tickerName, item?.exSymbol, item?.exSymName, item?.symTicker, item?.underSym, item?.symDetails];
    for (const alias of aliases) {
      const key = normalizeName(alias);
      if (key) cashByAlias.set(key, ticker);
    }
    if (item?.fyToken !== undefined && item?.fyToken !== null && String(item.fyToken)) {
      cashByToken.set(String(item.fyToken), ticker);
    }
  }

  const underlyingByTicker = new Map();
  for (const [ticker, item] of Object.entries(foMaster)) {
    if (!ticker.startsWith("NSE:") || item?.tradeStatus === 0) continue;
    const type = Number(item?.exInstType);
    const isStockFuture = type === 13 || /FUT$/.test(ticker);
    const isOption = item?.optType === "CE" || item?.optType === "PE";
    if (!isStockFuture && !isOption) continue;

    let cashTicker = item?.underFyTok != null ? cashByToken.get(String(item.underFyTok)) : null;
    if (!cashTicker) {
      for (const alias of [item?.underSym, item?.exSymbol, item?.exSymName]) {
        const key = normalizeName(alias);
        if (key && cashByAlias.has(key)) {
          cashTicker = cashByAlias.get(key);
          break;
        }
      }
    }
    if (cashTicker) underlyingByTicker.set(cashTicker, cashTicker.replace(/^NSE:/, "").replace(/-EQ$/, ""));
  }
  return [...underlyingByTicker.entries()]
    .map(([symbol, underlying]) => ({ symbol, underlying }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
