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

test("selects the nearest listed CE/PE strike in the nearest expiry without consulting chain Greeks", () => {
  const expiryData = [{ expiry, date: "2026-11-26" }];
  const rows = [
    [90, "CE", 0.02], [95, "CE", 0.99], [100, "CE", 0.50], [105, "CE", 0.01], [110, "CE", 0.34],
    [90, "PE", -0.34], [95, "PE", -0.01], [100, "PE", -0.50], [105, "PE", -0.99], [110, "PE", -0.02]
  ].map(([strike, side, delta]) => ({
    symbol: "NSE:ABC26NOV" + strike + side, strike_price: strike, option_type: side, expiry, delta
  }));
  const discovery = { expiryData, optionsChain: rows };
  const call = selectNearestVerifiedOptionContract({
    discovery, underlyingSymbol: "NSE:ABC-EQ", side: "CE", spot: 100, now, strikeMode: "nearest"
  });
  const put = selectNearestVerifiedOptionContract({
    discovery, underlyingSymbol: "NSE:ABC-EQ", side: "PE", spot: 100, now, strikeMode: "nearest"
  });
  assert.equal(call.ok, true);
  assert.equal(call.contract.strike, 100);
  assert.equal("delta" in call.contract, false);
  assert.equal(put.ok, true);
  assert.equal(put.contract.strike, 100);
  assert.equal("delta" in put.contract, false);
});

test("does not impose an unrequested ₹30–₹150 premium band", () => {
  const direction = {
    ok: true, side: "CE", spot: 104,
    latestCandleAt: new Date(now - 300000).toISOString(),
    candleAgeSeconds: 0, completedCandleCount: 30
  };
  const contract = { symbol: "NSE:ABC26NOV105CE", strike: 105, side: "CE", expiry };
  const makeCandles = (open, high, low, close) => Array.from({ length: 25 }, (_, index) => [
    Math.floor((now - (25 - index) * 5 * 60_000) / 1000), open, high, low, close, 1000
  ]);
  const cases = [
    { bid: 19.9, ask: 20, candles: makeCandles(10, 12, 9, 11) },
    { bid: 199.9, ask: 200, candles: makeCandles(100, 102, 95, 101) }
  ];
  for (const item of cases) {
    const result = buildVerifiedSureshotTradePlan({
      underlyingSymbol: "NSE:ABC-EQ", direction, contract, optionCandles: item.candles,
      lotSize: 25, tickSize: 0.05, now,
      quote: { bid: item.bid, ask: item.ask, lp: item.bid, tt: Math.floor((now - 1000) / 1000) }
    });
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.risk.rrTarget1 >= 2);
    assert.ok(result.risk.rrTarget2 >= 3);
  }
});
