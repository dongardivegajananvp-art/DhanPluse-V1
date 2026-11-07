import test from "node:test";
import assert from "node:assert/strict";
import { getMcxWatchdogRetryDelay } from "../src/mcx-watchdog.js";

test("MCX subscription recovery uses bounded exponential backoff", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 20].map(getMcxWatchdogRetryDelay),
    [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]
  );
});

test("MCX watchdog rejects invalid retry counts", () => {
  assert.throws(() => getMcxWatchdogRetryDelay(-1), /invalid_mcx_watchdog_retry_count/);
  assert.throws(() => getMcxWatchdogRetryDelay(1.5), /invalid_mcx_watchdog_retry_count/);
});
