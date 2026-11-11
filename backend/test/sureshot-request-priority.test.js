import test from "node:test";
import assert from "node:assert/strict";
import { isSureshotScanPriorityActive, shouldPauseFyersRead, shouldPauseLastKnownStockRefresh } from "../src/sureshot-request-priority.js";

const now = Date.parse("2026-11-11T10:00:00.000Z");
const ttlMs = 30 * 60 * 1000;

test("an active NSE scan retains FYERS priority between HTTP batches", () => {
  assert.equal(isSureshotScanPriorityActive({ nseScanState: { createdAt: now - 60_000 }, now, ttlMs }), true);
});
test("an active MCX scan retains FYERS priority between HTTP batches", () => {
  assert.equal(isSureshotScanPriorityActive({ mcxScanState: { createdAt: now - 60_000 }, now, ttlMs }), true);
});
test("either active exchange scan retains FYERS priority", () => {
  assert.equal(isSureshotScanPriorityActive({ nseScanState: { createdAt: now - 60_000 }, mcxScanState: { createdAt: now - 120_000 }, now, ttlMs }), true);
});
test("expired or future-dated scan state does not reserve the FYERS budget", () => {
  assert.equal(isSureshotScanPriorityActive({ nseScanState: { createdAt: now - ttlMs - 1 }, mcxScanState: { createdAt: now + 1 }, now, ttlMs }), false);
});
test("an in-flight Sureshot batch retains priority even without a stored cursor", () => {
  assert.equal(isSureshotScanPriorityActive({ scanInFlight: true, now, ttlMs }), true);
});

test("normal FYERS reads pause during an active NSE or MCX scan, while Sureshot keeps priority", () => {
  const nse = { nseScanState: { createdAt: now - 60_000 }, now, ttlMs };
  const mcx = { mcxScanState: { createdAt: now - 60_000 }, now, ttlMs };
  assert.equal(shouldPauseFyersRead(nse), true);
  assert.equal(shouldPauseFyersRead(mcx), true);
  assert.equal(shouldPauseFyersRead({ ...nse, priority: "sureshot" }), false);
});

test("normal FYERS reads resume after scan cursor expiry or completion", () => {
  assert.equal(shouldPauseFyersRead({
    nseScanState: { createdAt: now - ttlMs - 1 }, now, ttlMs
  }), false);
  assert.equal(shouldPauseFyersRead({ now, ttlMs }), false);
});

test("last-known cache hits remain displayable while a scan is active; cache-miss refresh yields", () => {
  const active = { scanInFlight: true, now, ttlMs };
  assert.equal(shouldPauseLastKnownStockRefresh({ ...active, cacheIsFresh: true }), false);
  assert.equal(shouldPauseLastKnownStockRefresh({ ...active, cacheIsFresh: false }), true);
});
