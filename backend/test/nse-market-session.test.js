import test from "node:test";
import assert from "node:assert/strict";
import { isNseRegularSession } from "../src/nse-market-session.js";

test("NSE session gate uses India time regardless of server timezone", () => {
  // Monday, 09:15 IST is 03:45 UTC.
  assert.equal(isNseRegularSession(new Date("2026-11-02T03:44:00.000Z")), false);
  assert.equal(isNseRegularSession(new Date("2026-11-02T03:45:00.000Z")), true);
  assert.equal(isNseRegularSession(new Date("2026-11-02T09:59:00.000Z")), true);
  // 15:30 IST is 10:00 UTC and is outside the regular session.
  assert.equal(isNseRegularSession(new Date("2026-11-02T09:59:00.000Z")), true);
  assert.equal(isNseRegularSession(new Date("2026-11-02T10:00:00.000Z")), false);
});

test("NSE session gate rejects weekends and invalid dates", () => {
  assert.equal(isNseRegularSession(new Date("2026-11-01T05:00:00.000Z")), false); // Sunday
  assert.equal(isNseRegularSession(new Date("2026-11-07T05:00:00.000Z")), false); // Saturday
  assert.equal(isNseRegularSession(new Date("invalid")), false);
});

test("NSE session gate accepts the final in-session minute on weekdays", () => {
  assert.equal(isNseRegularSession(new Date("2026-11-06T09:59:00.000Z")), true); // Friday 15:29 IST
  assert.equal(isNseRegularSession(new Date("2026-11-06T10:00:00.000Z")), false); // Friday 15:30 IST
});
