import test from "node:test";
import assert from "node:assert/strict";
import { createVerifiedPlanRegistry } from "../src/verified-plan-registry.js";

const owner = "existing-dashboard-session-fingerprint";
const snapshot = Object.freeze({
  source: "FYERS_VERIFIED",
  symbol: "NSE:RELIANCE26NOV3000CE",
  contract: { side: "CE", expiry: "2026-11-26", strike: 3000 },
  risk: { entryPrice: 100, stopLoss: 70, target1: 150, target2: 250, quantity: 50 }
});

test("issues opaque short-lived IDs and returns an immutable copy", () => {
  let now = 1_000;
  const registry = createVerifiedPlanRegistry({ ttlMs: 30_000, now: () => now });
  const issued = registry.create(owner, snapshot);
  assert.match(issued.planId, /^[A-Za-z0-9_-]{32,128}$/);
  const fetched = registry.get(owner, issued.planId);
  assert.equal(fetched.snapshot.symbol, snapshot.symbol);
  fetched.snapshot.risk.entryPrice = 1;
  assert.equal(registry.get(owner, issued.planId).snapshot.risk.entryPrice, 100);
});

test("does not disclose a plan to another Dashboard Session", () => {
  const registry = createVerifiedPlanRegistry();
  const issued = registry.create(owner, snapshot);
  assert.equal(registry.get("different-session", issued.planId), null);
  assert.equal(registry.consume("different-session", issued.planId), null);
  assert.equal(registry.get(owner, issued.planId).snapshot.symbol, snapshot.symbol);
});

test("expires plans and rejects expired IDs", () => {
  let now = 5_000;
  const registry = createVerifiedPlanRegistry({ ttlMs: 2_000, now: () => now });
  const issued = registry.create(owner, snapshot);
  now += 2_000;
  assert.equal(registry.get(owner, issued.planId), null);
  assert.equal(registry.size, 0);
});

test("consumes a plan only once", () => {
  const registry = createVerifiedPlanRegistry();
  const issued = registry.create(owner, snapshot);
  assert.equal(registry.consume(owner, issued.planId).symbol, snapshot.symbol);
  assert.equal(registry.consume(owner, issued.planId), null);
});

test("requires an authenticated owner and valid TTL", () => {
  const registry = createVerifiedPlanRegistry();
  assert.throws(() => registry.create("", snapshot), /Dashboard Session/);
  assert.throws(() => createVerifiedPlanRegistry({ ttlMs: 120_000 }), /TTL/);
});
