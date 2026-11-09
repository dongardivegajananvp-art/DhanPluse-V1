import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOptionContractDiscovery } from "../src/option-contract-discovery.js";
import { selectNearestVerifiedOptionContract, buildVerifiedSureshotTradePlan } from "../src/sureshot-auto-plans.js";

const now = Date.parse("2026-11-02T07:00:00.000Z");
const expiry = "1795651200";

test("option-chain normalization preserves only listed contract identity and omits Greeks and market fields", () => {
  const result = normalizeOptionContractDiscovery({
    expiryData: [{ expiry, date: "2026-11-26" }],
    optionsChain: [{ symbol: "NSE:ABC26NOV105CE", strike_price: 105, option_type: "CE", expiry,
      greeks: { delta: 0.44 }, ltp: 77, bid: 76, ask: 78, oi: 1000, volume: 900 }]
  });
  assert.deepEqual(result.optionsChain, [{
    symbol: "NSE:ABC26NOV105CE", strike_price: 105, option_type: "CE", expiry
  }]);
});

test("selects exactly one listed ATM+1 OTM strike for CE and PE without consulting delta", () => {
  const expiryData = [{ expiry, date: "2026-11-26" }];
  const rows = [
    [90, "CE", 0.02], [95, "CE", 0.99], [100, "CE", 0.50], [105, "CE", 0.01], [110, "CE", 0.34],
    [90, "PE", -0.34], [95, "PE", -0.01], [100, "PE", -0.50], [105, "PE", -0.99], [110, "PE", -0.02]
  ].map(([strike, side, delta]) => ({
    symbol: "NSE:ABC26NOV" + strike + side, strike_price: strike, option_type: side, expiry, delta
  }));
  const discovery = { expiryData, optionsChain: rows };
  const call = selectNearestVerifiedOptionContract({
    discovery, underlyingSymbol: "NSE:ABC-EQ", side: "CE", spot: 100, now, strikeMode: "one-otm"
  });
  const put = selectNearestVerifiedOptionContract({
    discovery, underlyingSymbol: "NSE:ABC-EQ", side: "PE", spot: 100, now, strikeMode: "one-otm"
  });
  assert.equal(call.ok, true);
  assert.equal(call.contract.strike, 105);
  assert.equal("delta" in call.contract, false);
  assert.equal(put.ok, true);
  assert.equal(put.contract.strike, 95);
  assert.equal("delta" in put.contract, false);
});

test("blocks when no listed OTM contract exists; does not substitute ATM", () => {
  const discovery = {
    expiryData: [{ expiry, date: "2026-11-26" }],
    optionsChain: [
      { symbol: "NSE:ABC26NOV95CE", strike_price: 95, option_type: "CE", expiry },
      { symbol: "NSE:ABC26NOV100CE", strike_price: 100, option_type: "CE", expiry }
    ]
  };
  const result = selectNearestVerifiedOptionContract({
    discovery, underlyingSymbol: "NSE:ABC-EQ", side: "CE", spot: 100, now, strikeMode: "one-otm"
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exact ATM \+ 1 OTM/i);
});

test("blocks premiums outside ₹30–₹150 when the fixed risk model is active", () => {
  const direction = {
    ok: true, side: "CE", spot: 104,
    latestCandleAt: new Date(now - 300000).toISOString(),
    candleAgeSeconds: 0, completedCandleCount: 15
  };
  const contract = { symbol: "NSE:ABC26NOV105CE", strike: 105, side: "CE", expiry };
  const candles = Array.from({ length: 12 }, (_, index) => [
    Math.floor((now - (12 - index) * 5 * 60_000) / 1000), 100, 101, 99, 100, 1000
  ]);
  const base = { underlyingSymbol: "NSE:ABC-EQ", direction, contract, optionCandles: candles,
    lotSize: 25, tickSize: 0.05, riskModel: "fixed", requirePremiumRange: true, now };
  const low = buildVerifiedSureshotTradePlan({ ...base, quote: { bid: 29.9, ask: 29.95, lp: 29.9, tt: Math.floor((now - 1000) / 1000) } });
  const high = buildVerifiedSureshotTradePlan({ ...base, quote: { bid: 150, ask: 150.05, lp: 150, tt: Math.floor((now - 1000) / 1000) } });
  const valid = buildVerifiedSureshotTradePlan({ ...base, quote: { bid: 99.95, ask: 100, lp: 100, tt: Math.floor((now - 1000) / 1000) } });
  assert.equal(low.ok, false);
  assert.match(low.reason, /premium/i);
  assert.equal(high.ok, false);
  assert.equal(valid.ok, true);
  assert.equal(valid.risk.stopLoss, 70);
  assert.equal(valid.risk.target1, 150);
  assert.equal(valid.risk.target2, 250);
});
