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


/**
 * Reports the regular NSE cash-market time window using Asia/Kolkata clock time.
 * This is not an exchange-status or holiday-calendar lookup; live feed status remains separate.
 */
export function getNseSessionWindow(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid_session_time");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekday = values.weekday;
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const isRegularHours = isWeekday && minuteOfDay >= 9 * 60 + 15 && minuteOfDay < 15 * 60 + 30;
  let reason;
  if (!isWeekday) reason = "weekend";
  else if (minuteOfDay < 9 * 60 + 15) reason = "before-regular-session";
  else if (minuteOfDay >= 15 * 60 + 30) reason = "after-regular-session";
  else reason = "regular-session-window";
  return {
    timezone: "Asia/Kolkata",
    checkedAt: instant.toISOString(),
    weekday,
    localTime: values.hour + ":" + values.minute,
    isRegularHours,
    reason,
    exchangeHolidayChecked: false,
    note: "Clock-based regular NSE session window only. Exchange holidays/special sessions are not checked; fresh FYERS ticks are the separate proof of live data."
  };
}
