import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedChartSymbol } from "../src/chart-symbol-validation.js";

const indices = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX"];
const verifiedFno = new Set(["NSE:RELIANCE-EQ", "NSE:SBIN-EQ"]);

test("allows the baseline indices", () => {
  for (const symbol of indices) assert.equal(isAllowedChartSymbol(symbol, indices, verifiedFno), true);
});

test("allows an equity only when present in the verified F&O universe", () => {
  assert.equal(isAllowedChartSymbol("NSE:RELIANCE-EQ", indices, verifiedFno), true);
  assert.equal(isAllowedChartSymbol("NSE:SBIN-EQ", indices, verifiedFno), true);
});

test("rejects arbitrary, malformed, or unverified symbols", () => {
  for (const symbol of ["NSE:FAKE-EQ", "NSE:RELIANCE-EQ-EXTRA", "BSE:RELIANCE-EQ", "", null, 42]) {
    assert.equal(isAllowedChartSymbol(symbol, indices, verifiedFno), false);
  }
});
