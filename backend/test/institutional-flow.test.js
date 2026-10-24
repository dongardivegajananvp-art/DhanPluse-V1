import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInstitutionalFlow } from "../src/institutional-flow.js";

const valid = [
  { category: "DII", date: "22-Oct-2026", buyValue: "1200.00", sellValue: "1000.00", netValue: "200.00" },
  { category: "FII/FPI", date: "22-Oct-2026", buyValue: "800.00", sellValue: "950.00", netValue: "-150.00" }
];

test("normalizes official FII/DII rows and marks them provisional and non-signal", () => {
  const result = normalizeInstitutionalFlow(valid, "2026-10-22T10:00:00.000Z");
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.provisional, true);
  assert.equal(result.signalsAllowed, false);
  assert.equal(result.rows.find(row => row.category === "FII/FPI").netValue, -150);
});

test("rejects empty, partial, and inconsistent official payloads", () => {
  assert.throws(() => normalizeInstitutionalFlow([]), /empty_or_invalid/);
  assert.throws(() => normalizeInstitutionalFlow([valid[0]]), /missing_required_categories/);
  assert.throws(() => normalizeInstitutionalFlow([
    valid[0], { ...valid[1], netValue: "-100.00" }
  ]), /net_value_mismatch/);
});

test("rejects mixed report dates", () => {
  assert.throws(() => normalizeInstitutionalFlow([
    valid[0], { ...valid[1], date: "21-Oct-2026" }
  ]), /date_mismatch/);
});

test("ignores unrelated categories but requires both institutional categories", () => {
  const result = normalizeInstitutionalFlow([...valid, {
    category: "CLIENT", date: "22-Oct-2026", buyValue: "1", sellValue: "1", netValue: "0"
  }]);
  assert.equal(result.rows.length, 2);
});
