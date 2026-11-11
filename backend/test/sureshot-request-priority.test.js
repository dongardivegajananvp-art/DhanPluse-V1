import test from "node:test";
import assert from "node:assert/strict";
import { isSureshotScanPriorityActive } from "../src/sureshot-request-priority.js";

const now = Date.parse("2026-11-11T10:00:00.000Z");
const ttlMs = 30 * 60 * 1000;

test("an active NSE scan retains FYERS priority between HTTP batches", () => {
  assert.equal(isSureshotScanPriorityActive({
    nseScanState: { createdAt: now - 60_000 }, now, ttlMs
  }), true);
});

test("an active MCX scan retains FYERS priority between HTTP batches", () => {
  assert.equal(isSureshotScanPriorityActive({
    mcxScanState: { createdAt: now - 60_000 }, now, ttlMs
  }), true);
});

test("either active exchange scan retains FYERS priority", () => {
  assert.equal(isSureshotScanPriorityActive({
    nseScanState: { createdAt: now - 60_000 },
    mcxScanState: { createdAt: now - 120_000 }, now, ttlMs
  }), true);
});

test("expired or future-dated scan state does not reserve the FYERS budget", () => {
  assert.equal(isSureshotScanPriorityActive({
    nseScanState: { createdAt: now - ttlMs - 1 },
    mcxScanState: { createdAt: now + 1 }, now, ttlMs
  }), false);
});

test("an in-flight Sureshot batch retains priority even without a stored cursor", () => {
  assert.equal(isSureshotScanPriorityActive({ scanInFlight: true, now, ttlMs }), true);
});
