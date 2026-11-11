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
      universe.data.length < 180 || quoteSnapshot.universeCount !== universe.data.length ||
      quoteSnapshot.quotedCount !== universe.data.length || quoteSnapshot.data.length !== universe.data.length) {
    throw new Error("complete_verified_fno_quote_snapshot_required");
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
      throw new Error("stale_or_invalid_fno_quote_snapshot");
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
  if (seen.size !== requested.size) throw new Error("incomplete_fno_quote_coverage");

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
    source: "FYERS complete NSE F&O quote snapshot + individually fresh FYERS WebSocket index ticks",
    verified: true,
    universeCount: requested.size + candidates.filter(row => row.underlyingType === "INDEX").length,
    candidateCount: candidates.length,
    rankedBy: "absolute FYERS percentage change; complete F&O equities plus individually fresh NIFTY/BANKNIFTY/SENSEX ticks",
    topGainers,
    topLosers,
    equityCandidates: equityRows.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol)),
    moverBoardsComplete: topGainers.length === 10 && topLosers.length === 10,
    signalsAllowed: false,
    data: candidates.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }))
  };
}


/**
 * After the complete F&O quote universe is verified and ranked, only the top
 * ten gainers, top ten losers and individually fresh index ticks proceed to
 * completed-candle and option-contract verification.
 */
export function selectSureshotTopMoverCandidates({ ranked, gainersLimit = 10, losersLimit = 10 }) {
  if (!ranked || ranked.ok !== true || ranked.verified !== true ||
      !Array.isArray(ranked.topGainers) || !Array.isArray(ranked.topLosers) ||
      !Array.isArray(ranked.data) || !ranked.moverBoardsComplete ||
      !Number.isInteger(gainersLimit) || gainersLimit !== 10 ||
      !Number.isInteger(losersLimit) || losersLimit !== 10) {
    throw new Error("complete_verified_top_mover_boards_required");
  }
  const selected = new Map();
  for (const row of ranked.topGainers.slice(0, gainersLimit)) {
    if (!row?.symbol || row.underlyingType !== "FNO_EQUITY" || !(Number(row.changePct) > 0) ||
        !Number.isFinite(Number(row.price)) || Number(row.price) <= 0) {
      throw new Error("invalid_verified_top_gainer");
    }
    if (selected.has(row.symbol)) throw new Error("duplicate_top_mover_symbol");
    selected.set(row.symbol, row);
  }
  for (const row of ranked.topLosers.slice(0, losersLimit)) {
    if (!row?.symbol || row.underlyingType !== "FNO_EQUITY" || !(Number(row.changePct) < 0) ||
        !Number.isFinite(Number(row.price)) || Number(row.price) <= 0) {
      throw new Error("invalid_verified_top_loser");
    }
    if (selected.has(row.symbol)) throw new Error("duplicate_top_mover_symbol");
    selected.set(row.symbol, row);
  }
  for (const row of ranked.data.filter(item => item?.underlyingType === "INDEX")) {
    if (!row.symbol || !Number.isFinite(Number(row.changePct)) ||
        !Number.isFinite(Number(row.price)) || Number(row.price) <= 0) {
      throw new Error("invalid_fresh_index_candidate");
    }
    if (!selected.has(row.symbol)) selected.set(row.symbol, row);
  }
  const data = [...selected.values()].sort((a, b) =>
    Math.abs(Number(b.changePct)) - Math.abs(Number(a.changePct)) || a.symbol.localeCompare(b.symbol));
  return {
    ok: true,
    fullUniverseRankedCount: Number(ranked.candidateCount) || 0,
    fullUniverseEquityCount: Number(ranked.equityCandidates?.length) || 0,
    moverEquityCount: Math.min(gainersLimit, ranked.topGainers.length) + Math.min(losersLimit, ranked.topLosers.length),
    freshIndexCount: data.filter(row => row.underlyingType === "INDEX").length,
    selectedCandidateCount: data.length,
    data
  };
}
