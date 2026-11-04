import test from "node:test";
import assert from "node:assert/strict";
import {
  canScheduleMarketSocketFallback,
  getMarketSocketReconnectDelay,
  buildMarketSocketSubscriptionSymbols
} from "../src/market-socket-recovery.js";

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

test("reconnect subscription restoration includes baseline indices and selected chart once", () => {
  const baseline = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX"];
  assert.deepEqual(buildMarketSocketSubscriptionSymbols(baseline, "NSE:RELIANCE-EQ"), [
    "NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX", "NSE:RELIANCE-EQ"
  ]);
  assert.deepEqual(buildMarketSocketSubscriptionSymbols(baseline, "NSE:NIFTY50-INDEX"), baseline);
  assert.deepEqual(buildMarketSocketSubscriptionSymbols(["NSE:NIFTY50-INDEX", "NSE:NIFTY50-INDEX"], null), ["NSE:NIFTY50-INDEX"]);
});
