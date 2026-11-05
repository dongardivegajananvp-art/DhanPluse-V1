import test from "node:test";
import assert from "node:assert/strict";
import { getExchangeSessionWindows } from "../src/exchange-session-status.js";

test("NSE and MCX session clocks are evaluated independently in India time", () => {
  const beforeNseOpen = getExchangeSessionWindows(new Date("2026-11-05T03:30:00.000Z"));
  assert.equal(beforeNseOpen.NSE.session, "SCHEDULED_CLOSED");
  assert.equal(beforeNseOpen.MCX.session, "SCHEDULED_OPEN");
  assert.equal(beforeNseOpen.NSE.localTime, "09:00");
  assert.equal(beforeNseOpen.MCX.sessionHours, "09:00–23:55 IST (non-agri)");
});

test("both regular sessions are scheduled open during weekday overlap", () => {
  const status = getExchangeSessionWindows(new Date("2026-11-05T05:00:00.000Z"));
  assert.equal(status.NSE.session, "SCHEDULED_OPEN");
  assert.equal(status.MCX.session, "SCHEDULED_OPEN");
});

test("NSE and MCX scheduled sessions close independently after their respective hours", () => {
  const status = getExchangeSessionWindows(new Date("2026-11-05T18:00:00.000Z"));
  assert.equal(status.NSE.session, "SCHEDULED_CLOSED");
  assert.equal(status.MCX.session, "SCHEDULED_OPEN");
});

test("weekends are scheduled closed for both exchanges", () => {
  const status = getExchangeSessionWindows(new Date("2026-11-07T05:00:00.000Z"));
  assert.equal(status.NSE.session, "SCHEDULED_CLOSED");
  assert.equal(status.MCX.session, "SCHEDULED_CLOSED");
  assert.equal(status.NSE.exchangeHolidayChecked, false);
  assert.equal(status.MCX.exchangeHolidayChecked, false);
});

test("invalid timestamps fail closed", () => {
  assert.throws(() => getExchangeSessionWindows("not-a-date"), /invalid_session_time/);
});
