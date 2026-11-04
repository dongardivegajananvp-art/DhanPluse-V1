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
