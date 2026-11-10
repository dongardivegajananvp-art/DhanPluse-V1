const TIMESTAMP_FIELDS = [
  "exch_feed_time",
  "last_traded_time",
  "ltt",
  "tt",
  "exchange_timestamp",
  "exchange_time",
  "last_traded_at",
  "feed_time"
];

function parseTimestampValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const timestampMs = numeric > 1e12 ? numeric : numeric * 1000;
    return Number.isFinite(timestampMs) && timestampMs > 0 ? { timestampMs, value } : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? { timestampMs: parsed, value } : null;
}

/** Resolve a FYERS quote timestamp without allowing date-only tt metadata to mask an intraday field. */
export function parseFyersQuoteTimestamp(quote) {
  if (!quote || typeof quote !== "object") return null;
  const containers = [quote, quote.v].filter(value => value && typeof value === "object");
  for (const field of TIMESTAMP_FIELDS) {
    for (const container of containers) {
      if (!(field in container)) continue;
      const parsed = parseTimestampValue(container[field]);
      if (parsed) return { field, ...parsed };
    }
  }
  return null;
}

/** Log timestamp-like fields only; never include prices, tokens or full quote payloads. */
export function summarizeFyersQuoteTimestampFields(rows, limit = 3) {
  if (!Array.isArray(rows) || !Number.isInteger(limit) || limit < 1) return [];
  return rows.slice(0, limit).map(row => {
    const containers = [row, row?.v].filter(value => value && typeof value === "object");
    const timestampFields = {};
    for (const field of TIMESTAMP_FIELDS) {
      for (const container of containers) {
        if (!(field in container)) continue;
        const value = container[field];
        if (value === null || value === undefined || value === "") {
          if (!(field in timestampFields)) timestampFields[field] = { type: value === null ? "null" : typeof value, value };
          continue;
        }
        timestampFields[field] = {
          type: Array.isArray(value) ? "array" : typeof value,
          value: ["string", "number", "boolean"].includes(typeof value) ? value : "[non-scalar]"
        };
        break;
      }
    }
    return { symbol: String(row?.n || row?.symbol || row?.v?.symbol || "UNKNOWN"), timestampFields };
  });
}
