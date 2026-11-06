function expiryMillis(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizedUnderlying(value) {
  return String(value || "").trim().toUpperCase().replace(/^MCX:/, "").replace(/[^A-Z0-9]/g, "");
}

function isWithinMasterTradingSession(value, now) {
  const sessions = [...String(value || "").matchAll(/(\d{2}):?(\d{2})-(\d{2}):?(\d{2})/g)];
  if (!sessions.length) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(now));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(fields.hour) * 60 + Number(fields.minute);
  return sessions.some((match) => {
    const startMinute = Number(match[1]) * 60 + Number(match[2]);
    const endMinute = Number(match[3]) * 60 + Number(match[4]);
    return startMinute <= endMinute
      ? minute >= startMinute && minute < endMinute
      : minute >= startMinute || minute < endMinute;
  });
}

/**
 * Build MCX futures from FYERS' official MCX_COM master. The master ticker and
 * its fields are authoritative; no contract symbol or lot size is synthesized.
 * Each future must have active CE and PE option descriptors for the same
 * underlying. Option expiry is independently taken from each option record.
 */
export function buildMcxFuturesUniverse(master, now = Date.now()) {
  if (!master || typeof master !== "object" || Array.isArray(master)) {
    throw new Error("invalid_fyers_mcx_symbol_master");
  }
  const rows = Object.entries(master);
  const optionsByUnderlying = new Map();
  for (const [symbol, item] of rows) {
    const side = String(item?.optType || "").toUpperCase();
    const expiry = expiryMillis(item?.expiryDate);
    const strike = Number(item?.strikePrice);
    const underlying = normalizedUnderlying(item?.underSym);
    if (!symbol.startsWith("MCX:") || Number(item?.tradeStatus) !== 1 || !isWithinMasterTradingSession(item?.tradingSession, now) ||
        !["CE", "PE"].includes(side) || !Number.isFinite(strike) || strike <= 0 ||
        !Number.isFinite(expiry) || expiry <= now || !underlying ||
        !item?.fyToken || !Number.isFinite(Number(item?.minLotSize)) ||
        Number(item.minLotSize) <= 0 || !Number.isFinite(Number(item?.qtyMultiplier)) ||
        Number(item.qtyMultiplier) <= 0 || !Number.isFinite(Number(item?.tickSize)) ||
        Number(item.tickSize) <= 0) continue;
    const list = optionsByUnderlying.get(underlying) || [];
    list.push({
      symbol, side, strike, expiryDate: String(item.expiryDate),
      expiryMs: expiry, fyToken: String(item.fyToken),
      underFyTok: String(item.underFyTok || ""),
      lotSize: Number(item.qtyMultiplier), minimumLotCount: Number(item.minLotSize), tickSize: Number(item.tickSize)
    });
    optionsByUnderlying.set(underlying, list);
  }

  const futures = [];
  for (const [symbol, item] of rows) {
    const expiry = expiryMillis(item?.expiryDate);
    const underlying = normalizedUnderlying(item?.underSym || item?.exSymbol);
    if (!/^MCX:.+FUT$/.test(symbol) || Number(item?.tradeStatus) !== 1 || !isWithinMasterTradingSession(item?.tradingSession, now) ||
        String(item?.optType || "").toUpperCase() !== "XX" ||
        !Number.isFinite(expiry) || expiry <= now || !underlying ||
        !item?.fyToken) continue;
    const allUnderlyingOptions = optionsByUnderlying.get(underlying) || [];
    const tokenMatchedOptions = allUnderlyingOptions.filter(option => option.underFyTok && option.underFyTok === String(item.fyToken));
    const relatedOptions = tokenMatchedOptions.length ? tokenMatchedOptions : allUnderlyingOptions;
    // An option must not outlive the futures contract used as its underlying.
    const family = relatedOptions.filter(option => option.expiryMs <= expiry);
    const activeSides = new Set(family.map(option => option.side));
    if (!activeSides.has("CE") || !activeSides.has("PE")) continue;
    const lotSize = Number(item.qtyMultiplier);
    const minimumLotCount = Number(item.minLotSize);
    const tickSize = Number(item.tickSize);
    if (!Number.isInteger(lotSize) || lotSize <= 0 || !Number.isFinite(minimumLotCount) || minimumLotCount <= 0 ||
        !Number.isFinite(tickSize) || tickSize <= 0) continue;
    futures.push({
      symbol, underlying: String(item.underSym || item.exSymbol),
      normalizedUnderlying: underlying, fyToken: String(item.fyToken),
      expiryDate: String(item.expiryDate), expiryMs: expiry,
      lotSize, minimumLotCount, tickSize,
      optionContracts: family.map(({ expiryMs, ...option }) => option)
    });
  }
  const unique = new Map(futures.map(row => [row.symbol, row]));
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Validate complete exchange-timestamped MCX future quotes before ranking.
 * This ranking is only a shortlist; it is not a trade signal.
 */
export function buildVerifiedMcxShortlist({ universe, quoteRows, now = Date.now(), limit = 5, maxAgeMs = 30000 }) {
  if (!Array.isArray(universe) || !universe.length || !Array.isArray(quoteRows) || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("complete_mcx_quote_snapshot_required");
  const expected = new Map(universe.map(row => [row.symbol, row]));
  if (expected.size !== universe.length) throw new Error("duplicate_mcx_future_symbols");
  const seen = new Set(); const candidates = []; let excludedQuoteCount = 0;
  for (const row of quoteRows) {
    const symbol = row?.n || row?.symbol;
    if (!expected.has(symbol) || seen.has(symbol)) throw new Error("mcx_quote_coverage_mismatch");
    seen.add(symbol); const quote = row?.v || row;
    const price = Number(quote?.lp ?? quote?.ltp); const changePct = Number(quote?.chp ?? quote?.changePct);
    const rawTime = quote?.tt ?? quote?.ltt ?? quote?.exch_feed_time; const numeric = Number(rawTime);
    const timestamp = Number.isFinite(numeric) && numeric > 0 ? (numeric > 1e12 ? numeric : numeric * 1000) : Date.parse(String(rawTime || ""));
    const age = now - timestamp;
    if (String(row?.s || "ok").toLowerCase() !== "ok" || !Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct) || !Number.isFinite(timestamp) || age < -5000 || age > maxAgeMs) { excludedQuoteCount += 1; continue; }
    candidates.push({ symbol, underlying: expected.get(symbol).underlying, price, changePct, exchangeTime: new Date(timestamp).toISOString(), quoteAgeSeconds: Math.max(0, Number((age / 1000).toFixed(1))) });
  }
  const missingQuoteCount = universe.length - seen.size;
  // A shortlist is valid only when every expected future has one fresh,
  // exchange-timestamped quote. Never rank the fresh subset of a partial scan.
  if (missingQuoteCount > 0) throw new Error("incomplete_mcx_quote_snapshot");
  if (excludedQuoteCount > 0 || candidates.length !== expected.size) {
    throw new Error("stale_or_invalid_mcx_quote_snapshot");
  }
  if (!candidates.length) throw new Error("no_fresh_mcx_future_quotes");
  candidates.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol));
  return { ok: true, verified: true, source: "FYERS MCX_COM master + fresh exchange-timestamped futures quotes", universeCount: universe.length, receivedQuoteCount: seen.size, freshQuoteCount: candidates.length, excludedQuoteCount, missingQuoteCount, candidateCount: candidates.length, rankingIsSignal: false, coverage: { requested: universe.length, received: seen.size, fresh: candidates.length, excluded: excludedQuoteCount, missing: missingQuoteCount }, data: candidates.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row })) };
}
