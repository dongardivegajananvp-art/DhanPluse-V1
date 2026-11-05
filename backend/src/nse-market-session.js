/**
 * NSE regular cash-market clock gate.
 * This checks weekday/session hours only; exchange holidays are deliberately
 * not inferred here. Live data freshness and backend session checks remain
 * independent mandatory gates.
 */
export function isNseRegularSession(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(fields.hour) * 60 + Number(fields.minute);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(fields.weekday) &&
    minute >= 9 * 60 + 15 && minute < 15 * 60 + 30;
}
