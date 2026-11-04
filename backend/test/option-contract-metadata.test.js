import test from "node:test";
import assert from "node:assert/strict";
import { getVerifiedOptionContractMetadata } from "../src/option-contract-metadata.js";

const symbol = "NSE:RELIANCE2611262500CE";
const master = {
  [symbol]: { tradeStatus: 1, optType: "CE", strikePrice: 2500, expiryDate: "1795651200", minLotSize: 250, tickSize: 0.05 }
};

test("reads lot size and tick size from the exact active FYERS option contract", () => {
  assert.deepEqual(getVerifiedOptionContractMetadata(symbol, master), {
    symbol, side: "CE", strike: 2500, expiryDate: "1795651200", lotSize: 250, tickSize: 0.05
  });
});

test("rejects unknown, inactive, malformed and incomplete contract master rows", () => {
  assert.equal(getVerifiedOptionContractMetadata(symbol, {}), null);
  assert.equal(getVerifiedOptionContractMetadata(symbol, { [symbol]: { ...master[symbol], tradeStatus: 0 } }), null);
  assert.equal(getVerifiedOptionContractMetadata(symbol, { [symbol]: { ...master[symbol], minLotSize: 0 } }), null);
  assert.equal(getVerifiedOptionContractMetadata(symbol, { [symbol]: { ...master[symbol], tickSize: 0 } }), null);
  assert.equal(getVerifiedOptionContractMetadata(symbol, { [symbol]: { ...master[symbol], optType: "XX" } }), null);
  assert.equal(getVerifiedOptionContractMetadata("NSE:RELIANCE2611262500PE", master), null);
  assert.equal(getVerifiedOptionContractMetadata("BSE:RELIANCE2611262500CE", master), null);
});

test("resolves BSE SENSEX option sizing from the BSE_FO master", () => {
  const bseSymbol = "BSE:SENSEX26112682000CE";
  const bseMaster = {
    [bseSymbol]: { tradeStatus: "1", optType: "CE", strikePrice: 82000, expiryDate: "1795651200", minLotSize: 20, tickSize: 0.05 }
  };
  assert.deepEqual(getVerifiedOptionContractMetadata(bseSymbol, bseMaster), {
    symbol: bseSymbol, side: "CE", strike: 82000, expiryDate: "1795651200", lotSize: 20, tickSize: 0.05
  });
});

test("uses each underlying contract's own lot size, never a shared/default lot", () => {
  const reliance = "NSE:RELIANCE2611262500CE";
  const nifty = "NSE:NIFTY26112625000CE";
  const banknifty = "NSE:BANKNIFTY26112656000CE";
  const perContractMaster = {
    [reliance]: { tradeStatus: 1, optType: "CE", strikePrice: 2500, expiryDate: "1795651200", minLotSize: 250, tickSize: 0.05 },
    [nifty]: { tradeStatus: 1, optType: "CE", strikePrice: 25000, expiryDate: "1795651200", minLotSize: 25, tickSize: 0.05 },
    [banknifty]: { tradeStatus: 1, optType: "CE", strikePrice: 56000, expiryDate: "1795651200", minLotSize: 15, tickSize: 0.05 }
  };
  assert.equal(getVerifiedOptionContractMetadata(reliance, perContractMaster).lotSize, 250);
  assert.equal(getVerifiedOptionContractMetadata(nifty, perContractMaster).lotSize, 25);
  assert.equal(getVerifiedOptionContractMetadata(banknifty, perContractMaster).lotSize, 15);
});
