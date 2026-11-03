function isFinitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function isCurrentExchangeTime(value, now, maxAgeMs) {
  const stamp = Date.parse(String(value || ""));
  return Number.isFinite(stamp) && stamp > 0 && stamp <= now + 5000 && now - stamp <= maxAgeMs;
}

/**
 * Convert a complete, fresh Stock Explorer/movers snapshot to the shape used
 * by the Sureshot ranking engine. No prices are generated or inferred.
 */
export function moversPayloadToFnoQuoteSnapshot(payload, symbols, now = Date.now()) {
  if (!payload || payload.ok !== true || payload.partial === true ||
      !Array.isArray(symbols) || !symbols.length ||
      Number(payload.requestedSymbols) !== symbols.length ||
      Number(payload.receivedSymbols) !== symbols.length ||
      !Array.isArray(payload.data) || payload.data.length !== symbols.length) return null;

  const expected = new Set(symbols);
  const seen = new Set();
  const data = [];
  for (const row of payload.data) {
    if (!row || !expected.has(row.symbol) || seen.has(row.symbol) ||
        row.priceStatus !== "LIVE_QUOTE" || !isFinitePositive(row.price) ||
        !Number.isFinite(Number(row.changePct)) ||
        !isCurrentExchangeTime(row.priceAsOf, now, 120000)) return null;
    seen.add(row.symbol);
    data.push({
      n: row.symbol,
      v: {
        lp: Number(row.price),
        ch: Number.isFinite(Number(row.change)) ? Number(row.change) : null,
        chp: Number(row.changePct),
        tt: Math.floor(Date.parse(row.priceAsOf) / 1000)
      },
      verified: true
    });
  }
  if (seen.size !== expected.size) return null;
  return {
    ok: true,
    verified: true,
    source: "FYERS quotes API shared movers snapshot",
    fetchedAt: payload.fetchedAt,
    universeCount: symbols.length,
    quotedCount: data.length,
    data
  };
}

/**
 * Convert a complete verified F&O quote snapshot to Stock Explorer's format.
 * Reuse is allowed only while every exchange timestamp is within 30 seconds.
 */
export function fnoQuoteSnapshotToMoversPayload(snapshot, symbols, now = Date.now()) {
  if (!snapshot || snapshot.ok !== true || snapshot.verified !== true ||
      !Array.isArray(symbols) || !symbols.length ||
      Number(snapshot.universeCount) !== symbols.length ||
      Number(snapshot.quotedCount) !== symbols.length ||
      !Array.isArray(snapshot.data) || snapshot.data.length !== symbols.length) return null;

  const expected = new Set(symbols);
  const seen = new Set();
  const data = [];
  for (const item of snapshot.data) {
    const value = item?.v;
    const symbol = item?.n;
    const stamp = Number(value?.tt) * 1000;
    if (!expected.has(symbol) || seen.has(symbol) || item.verified !== true ||
        !isFinitePositive(value?.lp) || !Number.isFinite(Number(value?.chp)) ||
        !Number.isFinite(stamp) || stamp > now + 5000 || now - stamp > 30000) return null;
    seen.add(symbol);
    data.push({
      symbol,
      price: Number(value.lp),
      change: Number.isFinite(Number(value.ch)) ? Number(value.ch) : null,
      changePct: Number(value.chp),
      previousClose: null,
      priceAsOf: new Date(stamp).toISOString(),
      quoteAgeSeconds: Math.max(0, Math.floor((now - stamp) / 1000)),
      quoteFetchedAt: snapshot.fetchedAt,
      marketSession: "OPEN",
      priceStatus: "LIVE_QUOTE"
    });
  }
  if (seen.size !== expected.size) return null;
  return {
    ok: true,
    fetchedAt: snapshot.fetchedAt,
    marketSession: "OPEN",
    universe: "FYERS-NSE-FO-symbol-master",
    requestedSymbols: symbols.length,
    receivedSymbols: data.length,
    partial: false,
    failedSymbols: [],
    data
  };
}
