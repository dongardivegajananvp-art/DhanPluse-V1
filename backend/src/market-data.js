export function normalizeQuote(raw, symbol, now = Date.now()) {
  if (!raw || typeof raw !== "object") throw new Error("invalid_quote_payload");
  const price = Number(raw.lp ?? raw.ltp ?? raw.price);
  const timestampRaw = raw.tt ?? raw.timestamp ?? raw.exchangeTimestamp;
  const timestamp = typeof timestampRaw === "number"
    ? (timestampRaw < 1e12 ? timestampRaw * 1000 : timestampRaw)
    : Date.parse(timestampRaw);
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid_quote_price");
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("invalid_quote_timestamp");
  const ageMs = Math.max(0, now - timestamp);
  return {
    symbol,
    price,
    exchangeTimestamp: new Date(timestamp).toISOString(),
    receivedAt: new Date(now).toISOString(),
    ageMs,
    freshness: ageMs <= 15_000 ? "fresh" : "stale",
    source: "FYERS",
    verified: true
  };
}

export function normalizeCandles(rows) {
  if (!Array.isArray(rows)) throw new Error("invalid_candle_payload");
  return rows.map((row, index) => {
    const [time, open, high, low, close, volume] = row;
    const values = [open, high, low, close].map(Number);
    const [o, h, l, c] = values;
    const ts = typeof time === "number" ? (time < 1e12 ? time * 1000 : time) : Date.parse(time);
    if (!Number.isFinite(ts) || !values.every(Number.isFinite) ||
        Math.min(o, h, l, c) <= 0 || h < Math.max(o, c, l) || l > Math.min(o, c, h)) {
      throw new Error("invalid_candle_row_" + index);
    }
    return { timestamp: new Date(ts).toISOString(), open: o, high: h, low: l, close: c,
      volume: Number.isFinite(Number(volume)) ? Number(volume) : null, source: "FYERS", verified: true };
  });
}
