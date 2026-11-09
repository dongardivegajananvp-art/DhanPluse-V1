import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFyersCandleOrder } from "../src/candle-order.js";

const older = [1762704000, 100, 105, 99, 104, 1000];
const newer = [1762704300, 104, 108, 103, 107, 1200];
const newest = [1762704600, 107, 110, 106, 109, 900];

test("keeps strictly ascending FYERS candles unchanged", () => {
  const result = normalizeFyersCandleOrder([older, newer, newest]);
  assert.equal(result.ok, true);
  assert.equal(result.order, "ascending");
  assert.deepEqual(result.data, [older, newer, newest]);
});

test("reverses only a strictly descending FYERS candle sequence", () => {
  const result = normalizeFyersCandleOrder([newest, newer, older]);
  assert.equal(result.ok, true);
  assert.equal(result.order, "descending_reversed");
  assert.deepEqual(result.data, [older, newer, newest]);
});

test("rejects duplicate candle timestamps without dropping rows", () => {
  assert.deepEqual(normalizeFyersCandleOrder([older, newer, newer, newest]), { ok: false, reason: "duplicate_timestamps" });
});

test("rejects mixed or partially shuffled candle timestamps", () => {
  assert.deepEqual(normalizeFyersCandleOrder([older, newest, newer]), { ok: false, reason: "mixed_timestamp_order" });
});

test("rejects malformed or non-positive candle timestamps", () => {
  assert.deepEqual(normalizeFyersCandleOrder([[0, 1, 1, 1, 1, 1], older]), { ok: false, reason: "invalid_timestamps" });
});
