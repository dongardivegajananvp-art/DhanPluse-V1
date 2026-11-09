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

function parseMcxExchangeTimestamp(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Build a row-by-row audit for every official MCX future. Partial, stale or
 * malformed snapshots remain visible as audit findings but are never ranked.
 */
export function buildVerifiedMcxAudit({ universe, quoteRows, now = Date.now(), limit = 5, maxAgeMs = 30000 }) {
  if (!Array.isArray(universe) || !universe.length || !Array.isArray(quoteRows) ||
      !Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new Error("complete_mcx_quote_snapshot_required");
  }
  const expected = new Map(universe.map(row => [row.symbol, row]));
  if (expected.size !== universe.length) throw new Error("duplicate_mcx_future_symbols");
  const received = new Map();
  const unexpectedSymbols = [];
  const duplicateSymbols = [];
  for (const row of quoteRows) {
    const symbol = row?.n || row?.symbol;
    if (!expected.has(symbol)) { unexpectedSymbols.push(String(symbol || "UNKNOWN")); continue; }
    if (received.has(symbol)) { duplicateSymbols.push(symbol); continue; }
    received.set(symbol, row);
  }
  const audit = universe.map(item => {
    const row = received.get(item.symbol);
    if (!row) return {
      symbol: item.symbol, underlying: item.underlying, status: "MISSING_QUOTE",
      reason: "FYERS did not return a quote row for this official MCX future."
    };
    const quote = row?.v || row;
    const price = Number(quote?.lp ?? quote?.ltp);
    const changePct = Number(quote?.chp ?? quote?.changePct);
    // Prefer actual exchange/last-traded timestamps. FYERS `tt` may be
    // date-only metadata (e.g. YYYY-MM-DD), which parses as midnight UTC and
    // must never override a valid intraday exchange timestamp.
    const rawTime = quote?.exch_feed_time ?? quote?.last_traded_time ?? quote?.ltt ?? quote?.tt;
    const timestamp = parseMcxExchangeTimestamp(rawTime);
    const age = now - timestamp;
    const rowStatus = String(row?.s || "ok").toLowerCase();
    if (rowStatus !== "ok" || !Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct) ||
        !Number.isFinite(timestamp) || age < -5000 || age > maxAgeMs) {
      return {
        symbol: item.symbol, underlying: item.underlying, status: "STALE_OR_INVALID_QUOTE",
        exchangeTime: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
        quoteAgeSeconds: Number.isFinite(age) ? Number((age / 1000).toFixed(1)) : null,
        reason: "Quote is stale, invalid, or missing a valid exchange timestamp."
      };
    }
    return {
      symbol: item.symbol, underlying: item.underlying, status: "FRESH_QUOTE",
      price, changePct, exchangeTime: new Date(timestamp).toISOString(),
      quoteAgeSeconds: Math.max(0, Number((age / 1000).toFixed(1)))
    };
  });
  const fresh = audit.filter(row => row.status === "FRESH_QUOTE");
  const missing = audit.filter(row => row.status === "MISSING_QUOTE");
  const excluded = audit.filter(row => row.status === "STALE_OR_INVALID_QUOTE");
  const complete = missing.length === 0 && excluded.length === 0 &&
    unexpectedSymbols.length === 0 && duplicateSymbols.length === 0 && fresh.length === expected.size;
  const ranked = complete ? fresh.slice().sort((a, b) =>
    Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol)
  ) : [];
  return {
    ok: complete, complete, source: "FYERS MCX_COM master + fresh exchange-timestamped futures quotes",
    universeCount: universe.length, receivedQuoteCount: received.size,
    freshQuoteCount: fresh.length, excludedQuoteCount: excluded.length,
    missingQuoteCount: missing.length, unexpectedSymbols, duplicateSymbols,
    candidateCount: complete ? ranked.length : 0,
    coverage: { requested: universe.length, received: received.size, fresh: fresh.length,
      excluded: excluded.length, missing: missing.length },
    audit,
    data: ranked.slice(0, limit).map((row, index) => ({
      rank: index + 1, symbol: row.symbol, underlying: row.underlying,
      price: row.price, changePct: row.changePct, exchangeTime: row.exchangeTime,
      quoteAgeSeconds: row.quoteAgeSeconds,
      ...expected.get(row.symbol)
    }))
  };
}

/**
 * Validate complete exchange-timestamped MCX future quotes before ranking.
 * This ranking is only a shortlist; it is not a trade signal.
 */
export function buildVerifiedMcxShortlist({ universe, quoteRows, now = Date.now(), limit = 5, maxAgeMs = 30000 }) {
  const audit = buildVerifiedMcxAudit({ universe, quoteRows, now, limit, maxAgeMs });
  if (audit.unexpectedSymbols.length || audit.duplicateSymbols.length) throw new Error("mcx_quote_coverage_mismatch");
  if (audit.missingQuoteCount > 0) throw new Error("incomplete_mcx_quote_snapshot");
  if (audit.excludedQuoteCount > 0 || audit.freshQuoteCount !== audit.universeCount) {
    throw new Error("stale_or_invalid_mcx_quote_snapshot");
  }
  if (!audit.data.length) throw new Error("no_fresh_mcx_future_quotes");
  return {
    ok: true, verified: true, source: audit.source,
    universeCount: audit.universeCount, receivedQuoteCount: audit.receivedQuoteCount,
    freshQuoteCount: audit.freshQuoteCount, excludedQuoteCount: audit.excludedQuoteCount,
    missingQuoteCount: audit.missingQuoteCount, candidateCount: audit.candidateCount,
    rankingIsSignal: false, coverage: audit.coverage, data: audit.data
  };
}


/**
 * Return a tightly allow-listed diagnostic view of timestamp-like quote fields.
 * Prices, tokens, credentials, and arbitrary quote payload values are never logged.
 */
export function summarizeMcxQuoteTimestampFields(rows, limit = 3) {
  if (!Array.isArray(rows) || !Number.isInteger(limit) || limit < 0 || limit > 10) return [];
  const explicitFields = [
    "exch_feed_time", "last_traded_time", "ltt", "tt",
    "exchange_timestamp", "exchange_time", "last_traded_at", "feed_time"
  ];
  return rows.slice(0, limit).map(row => {
    const quote = row?.v && typeof row.v === "object" ? row.v : row;
    const keys = [...new Set([...Object.keys(row || {}), ...Object.keys(quote || {})])];
    const timestampKeys = [...new Set([
      ...explicitFields.filter(key => Object.hasOwn(quote || {}, key) || Object.hasOwn(row || {}, key)),
      ...keys.filter(key => /(time|timestamp|_at)$/i.test(key))
    ])];
    const fields = {};
    for (const key of timestampKeys) {
      const value = Object.hasOwn(quote || {}, key) ? quote[key] : row[key];
      if (typeof value === "number") fields[key] = { type: "number", value };
      else if (typeof value === "string") fields[key] = { type: "string", value: value.slice(0, 80) };
      else if (value == null) fields[key] = { type: value === null ? "null" : "undefined", value: null };
      else fields[key] = { type: Array.isArray(value) ? "array" : typeof value, value: "[omitted]" };
    }
    return {
      symbol: String(row?.n || row?.symbol || "").slice(0, 80) || null,
      rowKeys: Object.keys(row || {}).slice(0, 40),
      quoteKeys: Object.keys(quote || {}).slice(0, 60),
      timestampFields: fields
    };
  });
}
