function istParts(instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(instant);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function isUsDaylightSaving(instant) {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "longOffset"
  }).formatToParts(instant).find(part => part.type === "timeZoneName")?.value || "";
  return zone.includes("-04:00");
}

/**
 * Clock-based NSE/MCX session windows only. Exchange holidays and special
 * sessions are deliberately not inferred; exchange-timestamped FYERS ticks
 * remain the independent proof that a feed is live.
 */
export function getExchangeSessionWindows(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid_session_time");
  const local = istParts(instant);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(local.weekday);
  const minute = Number(local.hour) * 60 + Number(local.minute);
  const nseOpen = weekday && minute >= 9 * 60 + 15 && minute < 15 * 60 + 30;
  const mcxClose = isUsDaylightSaving(instant) ? 23 * 60 + 30 : 23 * 60 + 55;
  const mcxOpen = weekday && minute >= 9 * 60 && minute < mcxClose;
  const base = {
    timezone: "Asia/Kolkata",
    checkedAt: instant.toISOString(),
    weekday: local.weekday,
    localTime: local.hour + ":" + local.minute,
    exchangeHolidayChecked: false
  };
  return {
    NSE: {
      ...base, session: nseOpen ? "SCHEDULED_OPEN" : "SCHEDULED_CLOSED",
      sessionHours: "09:15–15:30 IST",
      note: "Regular NSE cash-session clock only; holidays and special sessions are not checked."
    },
    MCX: {
      ...base, session: mcxOpen ? "SCHEDULED_OPEN" : "SCHEDULED_CLOSED",
      sessionHours: "09:00–" + (mcxClose === 23 * 60 + 30 ? "23:30" : "23:55") + " IST (non-agri)",
      note: "Regular MCX non-agri session clock only; holidays and special sessions are not checked."
    }
  };
}
