import test from "node:test";
import assert from "node:assert/strict";
import { pruneExpiredMap } from "../src/bounded-runtime-map.js";

test("prunes expired and malformed runtime entries", () => {
  const map = new Map([
    ["expired", { createdAt: 100 }],
    ["fresh", { createdAt: 950 }],
    ["missing", {}]
  ]);
  const result = pruneExpiredMap(map, { now: 1_000, ttlMs: 100, maxEntries: 10 });
  assert.deepEqual(result, { removed: 2, remaining: 1 });
  assert.deepEqual([...map.keys()], ["fresh"]);
});

test("evicts the oldest live entries when the hard cap is exceeded", () => {
  const map = new Map([
    ["one", { createdAt: 10 }],
    ["two", { createdAt: 20 }],
    ["three", { createdAt: 30 }],
    ["four", { createdAt: 40 }]
  ]);
  const result = pruneExpiredMap(map, { now: 50, ttlMs: 1_000, maxEntries: 2 });
  assert.deepEqual(result, { removed: 2, remaining: 2 });
  assert.deepEqual([...map.keys()], ["three", "four"]);
});

test("supports a zero-entry cap and rejects invalid arguments", () => {
  const map = new Map([["one", { createdAt: 1 }]]);
  assert.deepEqual(pruneExpiredMap(map, { now: 2, ttlMs: 10, maxEntries: 0 }), {
    removed: 1, remaining: 0
  });
  assert.throws(() => pruneExpiredMap([], {}), /map must be a Map/);
  assert.throws(() => pruneExpiredMap(new Map(), { maxEntries: -1 }), /maxEntries/);
});
