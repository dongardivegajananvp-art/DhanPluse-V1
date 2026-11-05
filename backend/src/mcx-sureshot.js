function expiryMillis(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}
function normalizedUnderlying(value) {
  return String(value || "").trim().toUpperCase().replace(/^MCX:/, "").replace(/[^A-Z0-9]/g, "");
}

/** Build only active, unexpired MCX futures that have a matching active option family in FYERS' official MCX master. */
export function buildMcxFuturesUniverse(master, now = Date.now()) {
  if (!master || typeof master !== "object" || Array.isArray(master)) throw new Error("invalid_fyers_mcx_symbol_master");
  const rows = Object.entries(master);
  const options = rows.filter(([symbol, item]) =>
    symbol.startsWith("MCX:") && Number(item?.tradeStatus) === 1 &&
    ["CE", "PE"].includes(String(item?.optType || "").toUpperCase()) &&
    Number(item?.strikePrice) > 0 && expiryMillis(item?.expiryDate) > now);
  const result = [];
  for (const [symbol, item] of rows) {
    if (!/^MCX:[A-Z0-9]+\d{2}[A-Z]{3}FUT$/.test(symbol) ||
        Number(item?.tradeStatus) !== 1 || expiryMillis(item?.expiryDate) <= now) continue;
    const token = String(item?.fyToken || "");
    const underlying = normalizedUnderlying(item?.underSym || item?.exSymbol || symbol);
    if (!token && !underlying) continue;
    const optionFamily = options.filter(([optionSymbol, option]) => {
      const sameToken = token && String(option?.underFyTok || "") === token;
      const optionUnderlying = normalizedUnderlying(option?.underSym || option?.exSymbol || optionSymbol);
      return Boolean(sameToken || (underlying && optionUnderlying === underlying));
    });
    if (!optionFamily.length) continue;
    result.push({
      symbol,
      underlying: String(item?.underSym || item?.exSymbol || symbol.replace(/^MCX:/, "").replace(/\d{2}[A-Z]{3}FUT$/, "")),
      fyToken: token,
      expiryDate: String(item.expiryDate),
      lotSize: Number.isInteger(Number(item?.minLotSize)) && Number(item.minLotSize) > 0 ? Number(item.minLotSize) : null,
      optionContractCount: optionFamily.length
    });
  }
  const unique = new Map(result.map(row => [row.symbol, row]));
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Rank a complete MCX futures quote snapshot; every member must be exchange-stamped and <=30s old. */
export function buildVerifiedMcxShortlist({ universe, quoteRows, now = Date.now(), limit = 5, maxAgeMs = 30000 }) {
  if (!Array.isArray(universe) || !universe.length || !Array.isArray(quoteRows) ||
      !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("complete_mcx_quote_snapshot_required");
  const expected = new Map(universe.map(row => [row.symbol, row]));
  if (expected.size !== universe.length) throw new Error("duplicate_mcx_future_symbols");
  const seen = new Set();
  const candidates = [];
  for (const row of quoteRows) {
    const symbol = row?.n || row?.symbol;
    const quote = row?.v || row;
    if (!expected.has(symbol) || seen.has(symbol)) throw new Error("mcx_quote_coverage_mismatch");
    seen.add(symbol);
    const price = Number(quote?.lp ?? quote?.ltp);
    const changePct = Number(quote?.chp ?? quote?.changePct);
    const rawTime = quote?.tt ?? quote?.ltt ?? quote?.exch_feed_time;
    const numeric = Number(rawTime);
    const timestamp = Number.isFinite(numeric) && numeric > 0
      ? (numeric > 1e12 ? numeric : numeric * 1000) : Date.parse(String(rawTime || ""));
    const age = now - timestamp;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct) ||
        !Number.isFinite(timestamp) || age < -5000 || age > maxAgeMs) {
      throw new Error("stale_or_invalid_mcx_future_quote");
    }
    candidates.push({
      symbol, underlying: expected.get(symbol).underlying, price, changePct,
      exchangeTime: new Date(timestamp).toISOString(),
      quoteAgeSeconds: Math.max(0, Number((age / 1000).toFixed(1))),
      optionContractCount: expected.get(symbol).optionContractCount
    });
  }
  if (seen.size !== expected.size || quoteRows.length !== universe.length) throw new Error("incomplete_mcx_quote_coverage");
  candidates.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol));
  return {
    ok: true, verified: true, source: "FYERS complete MCX_COM futures quote snapshot",
    universeCount: universe.length, candidateCount: candidates.length,
    data: candidates.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }))
  };
}
