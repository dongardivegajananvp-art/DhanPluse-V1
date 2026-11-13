const INDEX_SYMBOLS = [
  "NSE:NIFTY50-INDEX",
  "NSE:NIFTYBANK-INDEX",
  "BSE:SENSEX-INDEX"
];

function quoteTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Rank a complete FYERS F&O equity snapshot plus any independently fresh index ticks.
 * Missing/stale index ticks do not block verified F&O equities. This shortlist does not create
 * a directional option signal or any entry/SL/target values.
 */
export function buildVerifiedSureshotShortlist({
  quoteSnapshot,
  universe,
  indexTicks,
  now = Date.now(),
  maxEquityQuoteAgeMs = 30_000,
  maxIndexTickAgeMs = 30_000,
  limit = 5
}) {
  if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new Error("invalid_shortlist_parameters");
  }
  if (!quoteSnapshot || quoteSnapshot.ok !== true || quoteSnapshot.verified !== true ||
      !Array.isArray(quoteSnapshot.data) || !universe || !Array.isArray(universe.data) ||
      universe.data.length < 180 || !Number.isInteger(quoteSnapshot.universeCount) ||
      quoteSnapshot.universeCount !== universe.data.length ||
      !Number.isInteger(quoteSnapshot.quotedCount) || quoteSnapshot.quotedCount < 1 ||
      quoteSnapshot.quotedCount > universe.data.length ||
      quoteSnapshot.data.length !== quoteSnapshot.quotedCount) {
    throw new Error("verified_fno_quote_candidates_required");
  }
  const universeBySymbol = new Map(universe.data.map(row => [row?.symbol, row]));
  const requested = new Set(universeBySymbol.keys());
  if (requested.size !== universe.data.length) throw new Error("fno_universe_contains_duplicate_symbols");
  const seen = new Set();
  const candidates = [];
  for (const row of quoteSnapshot.data) {
    const symbol = row?.n;
    const quote = row?.v;
    if (!requested.has(symbol) || seen.has(symbol) || !quote) throw new Error("fno_quote_coverage_mismatch");
    seen.add(symbol);
    const price = Number(quote.lp);
    const changePct = Number(quote.chp);
    const timestampMs = quoteTimestampMs(quote.tt);
    const ageMs = now - timestampMs;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct) ||
        !Number.isFinite(timestampMs) || ageMs < -5000 || ageMs > maxEquityQuoteAgeMs) {
      continue;
    }
    candidates.push({
      symbol,
      underlyingType: "FNO_EQUITY",
      price,
      changePct,
      lotSize: Number.isInteger(Number(universeBySymbol.get(symbol)?.lotSize)) && Number(universeBySymbol.get(symbol)?.lotSize) > 0
        ? Number(universeBySymbol.get(symbol).lotSize) : null,
      exchangeTime: new Date(timestampMs).toISOString(),
      quoteAgeSeconds: Math.max(0, Number((ageMs / 1000).toFixed(1)))
    });
  }
  if (seen.size === 0) throw new Error("no_fresh_fno_quote_candidates");

  const ticks = indexTicks instanceof Map ? indexTicks : new Map(Object.entries(indexTicks || {}));
  for (const symbol of INDEX_SYMBOLS) {
    const tick = ticks.get(symbol);
    const timestampMs = quoteTimestampMs(tick?.updatedAt);
    const ageMs = now - timestampMs;
    const price = Number(tick?.ltp);
    const changePct = Number(tick?.chp);
    // An index is a candidate only when its own WebSocket tick is fresh and
    // exchange-stamped. A missing index tick must never suppress valid F&O stocks.
    if (!tick || tick.chp == null || !Number.isFinite(price) || price <= 0 ||
        !Number.isFinite(changePct) || !Number.isFinite(timestampMs) ||
        ageMs < -5000 || ageMs > maxIndexTickAgeMs) continue;
    candidates.push({
      symbol,
      underlyingType: "INDEX",
      price,
      changePct,
      exchangeTime: new Date(timestampMs).toISOString(),
      quoteAgeSeconds: Math.max(0, Number((ageMs / 1000).toFixed(1)))
    });
  }

  candidates.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) ||
    a.symbol.localeCompare(b.symbol));
  const equityRows = candidates.filter(row => row.underlyingType === "FNO_EQUITY");
  const topGainers = equityRows.filter(row => row.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct || a.symbol.localeCompare(b.symbol))
    .slice(0, 10).map((row, index) => ({ rank: index + 1, ...row }));
  const topLosers = equityRows.filter(row => row.changePct < 0)
    .sort((a, b) => a.changePct - b.changePct || a.symbol.localeCompare(b.symbol))
    .slice(0, 10).map((row, index) => ({ rank: index + 1, ...row }));
  return {
    ok: true,
    source: "FYERS individually fresh NSE F&O quotes + individually fresh FYERS WebSocket index ticks",
    verified: true,
    universeCount: requested.size + candidates.filter(row => row.underlyingType === "INDEX").length,
    quotedEquityCount: equityRows.length,
    partialQuoteCoverage: equityRows.length !== requested.size,
    candidateCount: candidates.length,
    rankedBy: "absolute FYERS percentage change; individually fresh F&O equities plus fresh NIFTY/BANKNIFTY/SENSEX ticks",
    topGainers,
    topLosers,
    equityCandidates: equityRows.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol)),
    moverBoardsComplete: topGainers.length === 10 && topLosers.length === 10,
    signalsAllowed: false,
    data: candidates.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }))
  };
}


/**
 * Deep-verify every member of the already complete, fresh F&O equity snapshot.
 * Fresh index ticks are included independently. Five-item request batches and
 * the shared FYERS budget control pacing; they must not silently shrink coverage.
 */
export function selectSureshotOptionVerificationCandidates(ranked) {
  if (!ranked || ranked.verified !== true ||
      !Array.isArray(ranked.equityCandidates) || !Array.isArray(ranked.data)) {
    throw new Error("complete_verified_fno_universe_required");
  }
  const bySymbol = new Map();
  for (const row of [...ranked.equityCandidates,
    ...ranked.data.filter(item => item.underlyingType === "INDEX")]) {
    if (!row || typeof row.symbol !== "string" || !row.symbol ||
        !Number.isFinite(Number(row.changePct))) continue;
    bySymbol.set(row.symbol, row);
  }
  const selected = [...bySymbol.values()].sort((a, b) =>
    Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol));
  return selected.map((row, index) => ({ ...row, rank: index + 1 }));
}
