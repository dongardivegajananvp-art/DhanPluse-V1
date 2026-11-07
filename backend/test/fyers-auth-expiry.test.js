import test from "node:test";
import assert from "node:assert/strict";
import { isExpiredFyersAccessTokenError } from "../src/fyers-auth-recovery.js";

test("detects expired FYERS SDK access-token errors", () => {
  assert.equal(isExpiredFyersAccessTokenError(new Error("Failed to decode JWT: You are passing an expired token")), true);
  assert.equal(isExpiredFyersAccessTokenError("JWT expired"), true);
  assert.equal(isExpiredFyersAccessTokenError("FYERS API request failed with HTTP 500"), false);
  assert.equal(isExpiredFyersAccessTokenError("socket disconnected"), false);
});
