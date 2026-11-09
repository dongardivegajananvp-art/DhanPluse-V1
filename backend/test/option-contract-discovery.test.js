import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOptionContractDiscovery } from "../src/option-contract-discovery.js";

test("returns only contract identity, strike, side and expiry", () => {
  const result = normalizeOptionContractDiscovery({
    expiryData: [{ expiry: "1793404800", date: "2026-10-31", expiry_flag: "WEEKLY" }],
    optionsChain: [
      { symbol: "NSE:NIFTY26OCT25000CE", strike_price: 25000, option_type: "CALL",
        ltp: 123.4, bid: 123, ask: 124, oi: 9000, volume: 5000, greeks: { delta: 0.42 } }
    ]
  });
  assert.deepEqual(result.optionsChain, [{
    symbol: "NSE:NIFTY26OCT25000CE", strike_price: 25000,
    option_type: "CE", expiry: "1793404800"
  }]);
  assert.equal("ltp" in result.optionsChain[0], false);
  assert.equal("oi" in result.optionsChain[0], false);
  assert.equal("volume" in result.optionsChain[0], false);
  assert.equal("delta" in result.optionsChain[0], false);
  assert.equal(result.expiryData[0].expiry_flag, "WEEKLY");
});

test("uses row expiry when no expiry list is provided", () => {
  const result = normalizeOptionContractDiscovery({
    optionsChain: [{ symbol: "NSE:ABC26NOV100PE", strike_price: 100,
      option_type: "PE", expiry_date: "1794000000" }]
  });
  assert.equal(result.optionsChain[0].expiry, "1794000000");
});

test("rejects missing or malformed contract descriptors", () => {
  assert.throws(() => normalizeOptionContractDiscovery({ optionsChain: [] }), /option_contract_list_missing/);
  assert.throws(() => normalizeOptionContractDiscovery({
    optionsChain: [{ symbol: "NSE:ABC26NOV100PE", strike_price: 100, option_type: "PE" }]
  }), /no_valid_option_contract_descriptors/);
});

test("normalizes BSE SENSEX option contract descriptors alongside NSE contracts", () => {
  const result = normalizeOptionContractDiscovery({
    expiryData: [{ expiry: "1795651200", date: "2026-11-26" }],
    optionsChain: [
      { symbol: "NSE:RELIANCE26NOV2500CE", option_type: "CE", strike_price: 2500 },
      { symbol: "BSE:SENSEX26NOV82000PE", option_type: "PE", strike_price: 82000 }
    ]
  });
  assert.equal(result.optionsChain.length, 2);
  assert.equal(result.optionsChain[1].symbol, "BSE:SENSEX26NOV82000PE");
  assert.equal(result.optionsChain[1].option_type, "PE");
});

test("normalizes MCX commodity option contract descriptors including decimal strikes", () => {
  const result = normalizeOptionContractDiscovery({
    expiryData: [{ expiry: "1795046400", date: "19-11-2026" }],
    optionsChain: [{ symbol: "MCX:GOLD26NOV100000.5CE", option_type: "CE", strike_price: 100000.5 }]
  });
  assert.equal(result.optionsChain[0].symbol, "MCX:GOLD26NOV100000.5CE");
  assert.equal(result.optionsChain[0].strike_price, 100000.5);
});

test("continues rejecting unsupported exchanges and malformed symbols", () => {
  assert.throws(() => normalizeOptionContractDiscovery({
    expiry: "1795651200",
    optionsChain: [
      { symbol: "BSE:SENSEX-INDEX", option_type: "CE", strike_price: 82000 }
    ]
  }), /no_valid_option_contract_descriptors/);
});
