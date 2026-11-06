import test from "node:test";
import assert from "node:assert/strict";
import { isFyersAuthRejected } from "../src/fyers-auth-recovery.js";

test("detects an HTTP 401 from FYERS", () => {
  assert.equal(isFyersAuthRejected(401, undefined), true);
});

test("detects FYERS invalid-token code even when HTTP status is not 401", () => {
  assert.equal(isFyersAuthRejected(200, -16), true);
  assert.equal(isFyersAuthRejected(200, "-16"), true);
});

test("does not invalidate a valid session for rate limits or ordinary errors", () => {
  assert.equal(isFyersAuthRejected(429, undefined), false);
  assert.equal(isFyersAuthRejected(502, -1), false);
  assert.equal(isFyersAuthRejected(200, undefined), false);
});

import { readFile } from "node:fs/promises";

test("OAuth re-authentication issues a new dashboard bearer without clearing other live sessions", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const routeStart = source.indexOf("app.post('/api/fyers/auth/exchange'");
  const routeEnd = source.indexOf("// Index quotes are served", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const exchangeRoute = source.slice(routeStart, routeEnd);
  assert.match(exchangeRoute, /dashboardSessions\.set\(dashboardSessionToken/);
  assert.doesNotMatch(exchangeRoute, /dashboardSessions\.clear\(/);
});

test("protected API accepts a valid bearer and restores the signed PostgreSQL-backed session after restart", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("function requireDashboardSession");
  const end = source.indexOf("app.use('/api/market'", start);
  assert.ok(start >= 0 && end > start);
  const guard = source.slice(start, end);
  assert.match(guard, /\^Bearer \(\[a-f0-9\]\{64\}\)\$/);
  assert.match(guard, /Date\.now\(\) - session\.createdAt > DASHBOARD_SESSION_TTL_MS/);
  assert.ok(guard.includes('token && accessToken && fyersTokenStore.configured'));
  assert.ok(guard.includes('token === createDashboardSessionToken()'));
  assert.ok(source.includes("crypto.createHmac('sha256'"));
  assert.ok(source.includes('DhanPulse/dashboard-session/v1'));
  assert.match(guard, /session\.lastSeenAt = Date\.now\(\)/);
});

test("FYERS invalid-token rejection clears sessions and closes the owned socket", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("function invalidateFyersSession");
  const end = source.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  const invalidation = source.slice(start, end);
  assert.match(invalidation, /accessToken = ''/);
  assert.match(invalidation, /dashboardSessions\.clear\(\)/);
  assert.match(invalidation, /latestTicks\.clear\(\)/);
  assert.match(invalidation, /expiredSocket\.close\(\)/);
});
