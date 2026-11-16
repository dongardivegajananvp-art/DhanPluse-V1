const TRADING_DAYS = new Set(['Mon','Tue','Wed','Thu','Fri']);

export function getNseMarketSession(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(values.hour) * 60 + Number(values.minute);
  const isTradingDay = TRADING_DAYS.has(values.weekday);

  if (!isTradingDay) return { phase: 'CLOSED', label: 'SESSION CLOSED', minute, isTradingDay };
  if (minute >= 540 && minute < 548) {
    return { phase: 'PRE_OPEN_ORDER_ENTRY', label: 'PRE-OPEN · ORDER ENTRY · INDICATIVE ONLY', minute, isTradingDay };
  }
  if (minute >= 548 && minute < 552) {
    return { phase: 'PRE_OPEN_MATCHING', label: 'PRE-OPEN · ORDER MATCHING · INDICATIVE ONLY', minute, isTradingDay };
  }
  if (minute >= 552 && minute < 555) {
    return { phase: 'PRE_OPEN_BUFFER', label: 'PRE-OPEN · BUFFER · INDICATIVE ONLY', minute, isTradingDay };
  }
  if (minute >= 555 && minute < 930) {
    return { phase: 'REGULAR', label: 'REGULAR MARKET · 09:15–15:30 IST', minute, isTradingDay };
  }
  return { phase: 'CLOSED', label: 'SESSION CLOSED', minute, isTradingDay };
}
