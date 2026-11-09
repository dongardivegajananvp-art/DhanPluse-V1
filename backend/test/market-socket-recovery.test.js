import test from "node:test";
import assert from "node:assert/strict";
import {
  canScheduleMarketSocketFallback,
  getMarketSocketReconnectDelay,
  buildMarketSocketSubscriptionSymbols,
  getMarketSocketReconnectDelay
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

import { readFile } from "node:fs/promises";

test("failed socket startup releases only its own socket so the same token can retry", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /let socket = null;\s*try \{/);
  assert.match(source, /if \(socket && marketSocket === socket\) \{\s*marketSocket = null;\s*marketSocketToken = '';/);
  assert.match(source, /if \(marketSocket && marketSocketToken === token\)/);
});

test("ordinary SDK close keeps the socket owner intact for SDK-managed reconnect", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const closeHandler = source.match(/socket\.on\('close',[\s\S]*?\n    \}\);/);
  assert.ok(closeHandler, "socket close handler must exist");
  assert.doesNotMatch(closeHandler[0], /marketSocket\s*=\s*null|marketSocketToken\s*=/);
});

test("SDK handles transport reconnects while the 10-second NSE heartbeat restores silent subscriptions", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("function startMarketDataStream");
  const end = source.indexOf("// NSE feed heartbeat:", start);
  assert.ok(start >= 0 && end > start);
  const lifecycle = source.slice(start, end);
  assert.match(lifecycle, /socket\.autoreconnect|socket\.autoReconnect/);
  assert.match(lifecycle, /sdkReconnect\(SDK_RECONNECT_RETRIES\)/);
  assert.match(lifecycle, /socket\.connect\(\)/);
  const heartbeat = source.slice(end, source.indexOf("marketSocketWatchdog.unref", end));
  assert.match(source, /NSE_TICK_HEARTBEAT_MS = 10_000/);
  assert.match(heartbeat, /marketSocket\.subscribe\(nseIndexSymbols\)/);
  assert.match(heartbeat, /no_fresh_nse_tick_within_10_seconds/);
  assert.match(heartbeat, /getMarketSocketReconnectDelay\(nseResubscribeCount, 10_000, 120_000\)/);
  assert.doesNotMatch(heartbeat, /marketSocket\.close\(/);
  assert.match(heartbeat, /setInterval\([\s\S]*?,\s*1_000\)/);
});

test("socket reconnect reapplies mode and the complete subscriptions after every SDK reconnect", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("socket.on('connect'");
  const end = source.indexOf("socket.on('message'", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /socket\.mode\(socket\.FullMode\)/);
  assert.match(handler, /socketConnectCount \+= 1/);
  assert.match(handler, /reconnect: socketConnectCount > 1/);
  assert.match(handler, /Re-apply the complete required subscription set after EVERY connect/);
  assert.match(handler, /socket\.subscribe\(nseSubscriptionSymbols\)/);
  assert.doesNotMatch(handler, /if \(socketConnectCount === 1\)/);
});

test("market ticks without exchange timestamps are rejected and live snapshots enforce timestamp freshness", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const parseStart = source.indexOf("function parseTick");
  const parseEnd = source.indexOf("function startMarketDataStream", parseStart);
  assert.ok(parseStart >= 0 && parseEnd > parseStart);
  const parser = source.slice(parseStart, parseEnd);
  assert.match(parser, /if \(!exchangeTime\)/);
  assert.match(parser, /latestTicks\.set\(symbol/);
  const snapshotStart = source.indexOf("function liveSnapshot");
  const snapshotEnd = source.indexOf("\n}", snapshotStart) + 2;
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  assert.match(source.slice(snapshotStart, snapshotEnd), /quoteTimestampStatus/);
});

test("FYERS SDK reconnect attempts are bounded to avoid repeated provider 429 pressure", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /const SDK_RECONNECT_RETRIES = 50;/);
  assert.match(source, /NSE_TICK_HEARTBEAT_MS = 10_000/);
});

test("FYERS SDK error event does not falsely mark a still-ticking socket disconnected", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const errorStart = source.indexOf("socket.on('error'");
  const closeStart = source.indexOf("socket.on('close'", errorStart);
  assert.ok(errorStart >= 0 && closeStart > errorStart);
  const errorHandler = source.slice(errorStart, closeStart);
  assert.doesNotMatch(errorHandler, /streamConnected\s*=\s*false/);
  assert.match(errorHandler, /market_socket_error/);
  assert.match(errorHandler, /transportState/);
  const closeEnd = source.indexOf("// Add one official MCX", closeStart);
  assert.ok(closeEnd > closeStart);
  assert.match(source.slice(closeStart, closeEnd), /streamConnected\s*=\s*false/);
});

test("verified live snapshots continue to reject stale exchange timestamps", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("function liveSnapshot");
  const end = source.indexOf("\n}", start) + 2;
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /quoteTimestampStatus/);
  assert.match(source.slice(start, end), /'FRESH'/);
});

test("NSE status exposes RECONNECTING while a fresh-tick recovery is pending and keeps MCX independent", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /: nseReconnectPending \? 'RECONNECTING'/);
  assert.match(source, /const mcxFeed = !accessToken \? 'NOT_CONNECTED'[\s\S]*?mcxSubscribedSocket !== marketSocket/);
  assert.match(source, /NSE socket disconnected, reconnecting\.\.\./);
  assert.match(source, /NSE live feed restored after automatic recovery/);
  assert.match(source, /MCX_TICK_HEARTBEAT_MS = 10_000/);
  assert.match(source, /MCX_TICK_FRESHNESS_SECONDS = 10/);
  const mcxWatchdogStart = source.indexOf("const mcxMarketSocketWatchdog = setInterval");
  const mcxWatchdogEnd = source.indexOf("mcxMarketSocketWatchdog.unref", mcxWatchdogStart);
  assert.ok(mcxWatchdogStart >= 0 && mcxWatchdogEnd > mcxWatchdogStart);
  const mcxWatchdog = source.slice(mcxWatchdogStart, mcxWatchdogEnd);
  assert.match(mcxWatchdog, /getExchangeSessionWindows\(\)\.MCX\?\.session !== 'SCHEDULED_OPEN'/);
  assert.match(mcxWatchdog, /marketSocket\.subscribe\(\[mcxDiagnosticInstrument\.symbol\]\)/);
  assert.doesNotMatch(mcxWatchdog, /marketSocket\.close\(|subscribe\(nseIndexSymbols\)/);
});


test("NSE silent-feed recovery uses exponential resubscribe backoff", () => {
  assert.equal(getMarketSocketReconnectDelay(0, 10_000, 120_000), 10_000);
  assert.equal(getMarketSocketReconnectDelay(1, 10_000, 120_000), 20_000);
  assert.equal(getMarketSocketReconnectDelay(2, 10_000, 120_000), 40_000);
  assert.equal(getMarketSocketReconnectDelay(3, 10_000, 120_000), 80_000);
  assert.equal(getMarketSocketReconnectDelay(4, 10_000, 120_000), 120_000);
});
