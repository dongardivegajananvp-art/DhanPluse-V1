import test from "node:test";
import assert from "node:assert/strict";
import { isSupportedOptionContractSymbol } from "../src/option-symbol-validation.js";

test("accepts NSE stock and index option contract symbols", () => {
  assert.equal(isSupportedOptionContractSymbol("NSE:RELIANCE26NOV2500CE"), true);
  assert.equal(isSupportedOptionContractSymbol("NSE:NIFTY26NOV25000PE"), true);
});

test("accepts BSE SENSEX option contract symbols", () => {
  assert.equal(isSupportedOptionContractSymbol("BSE:SENSEX26NOV82000CE"), true);
  assert.equal(isSupportedOptionContractSymbol("BSE:SENSEX26NOV82000PE"), true);
});

test("accepts MCX option contracts and rejects unsupported exchanges or malformed symbols", () => {
  assert.equal(isSupportedOptionContractSymbol("MCX:GOLD26NOV100000CE"), true);
  assert.equal(isSupportedOptionContractSymbol("MCX:CRUDEOIL26NOV8400PE"), true);
  for (const symbol of [
    "CDS:USDINR26NOV90CE",
    "MCX:CRUDEOIL26NOVFUT",
    "NSE:RELIANCE-EQ",
    "BSE:SENSEX-INDEX",
    "NSE:CE",
    "",
    null,
    123
  ]) {
    assert.equal(isSupportedOptionContractSymbol(symbol), false, String(symbol));
  }
});
