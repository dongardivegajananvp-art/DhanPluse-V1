import test from "node:test";
import assert from "node:assert/strict";
import { canScheduleMarketSocketFallback } from "./market-socket-recovery.js";

test("socket fallback is scheduled only during market hours with a disconnected authenticated socket", () => {
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: true, connected: false, timerPending: false }), true);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: false, hasToken: true, hasSocket: true, connected: false, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: false, hasSocket: true, connected: false, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: false, connected: false, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: true, connected: true, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: true, connected: false, timerPending: true }), false);
});
