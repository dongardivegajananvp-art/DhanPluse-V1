import test from "node:test";
import assert from "node:assert/strict";
import {
  canScheduleMarketSocketFallback,
  getMarketSocketReconnectDelay
} from "./market-socket-recovery.js";

test("socket fallback is scheduled only during market hours with a disconnected authenticated socket", () => {
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: true, connected: false, timerPending: false }), true);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: false, hasToken: true, hasSocket: true, connected: false, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: false, hasSocket: true, connected: false, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: false, connected: false, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: true, connected: true, timerPending: false }), false);
  assert.equal(canScheduleMarketSocketFallback({ sessionOpen: true, hasToken: true, hasSocket: true, connected: false, timerPending: true }), false);
});

test("socket reconnect backoff grows and is capped", () => {
  assert.equal(getMarketSocketReconnectDelay(0), 20_000);
  assert.equal(getMarketSocketReconnectDelay(1), 40_000);
  assert.equal(getMarketSocketReconnectDelay(2), 80_000);
  assert.equal(getMarketSocketReconnectDelay(3), 120_000);
  assert.equal(getMarketSocketReconnectDelay(20), 120_000);
});

test("socket reconnect delay sanitizes invalid attempts and bounds", () => {
  assert.equal(getMarketSocketReconnectDelay(-3), 20_000);
  assert.equal(getMarketSocketReconnectDelay("bad"), 20_000);
  assert.equal(getMarketSocketReconnectDelay(1, -5, 0), 40_000);
});
