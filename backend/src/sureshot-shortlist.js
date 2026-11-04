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
  const requested = new Set(universe.data.map(row => row?.symbol).filter(Boolean));
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
  return {
    ok: true,
    source: "FYERS complete NSE F&O quote snapshot + individually fresh FYERS WebSocket index ticks",
    verified: true,
    universeCount: requested.size + candidates.filter(row => row.underlyingType === "INDEX").length,
    candidateCount: candidates.length,
    rankedBy: "absolute FYERS percentage change; complete F&O equities plus individually fresh NIFTY/BANKNIFTY/SENSEX ticks",
    signalsAllowed: false,
    data: candidates.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }))
  };
}
