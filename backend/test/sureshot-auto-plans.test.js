import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveVerifiedUnderlyingDirection,
  selectNearestVerifiedOptionContract,
  buildVerifiedSureshotTradePlan
} from "../src/sureshot-auto-plans.js";

const now = Date.parse("2026-11-02T07:00:00.000Z");
const candleRows = Array.from({ length: 16 }, (_, i) => {
  const t = Math.floor((now - (16 - i) * 5 * 60_000) / 1000);
  return [t, 100, 101, 99, 100, 1000];
});
candleRows[14] = [Math.floor((now - 10 * 60_000) / 1000), 100, 102, 100, 101, 1000];
candleRows[15] = [Math.floor((now - 5 * 60_000) / 1000), 103, 105, 102, 104, 1000];

test("requires completed candles and blocks neutral/stale direction", () => {
  const neutral = deriveVerifiedUnderlyingDirection(candleRows, "5", now);
  assert.equal(neutral.ok, true);
  assert.equal(neutral.side, "CE");
  const stale = deriveVerifiedUnderlyingDirection(candleRows.slice(0, 12), "5", now);
  assert.equal(stale.ok, false);
});

test("blocks a contract whose exchange, side, symbol suffix or strike does not match", () => {
  const direction = { ok: true, side: "CE", spot: 104, latestCandleAt: new Date(now - 300000).toISOString(), candleAgeSeconds: 0, completedCandleCount: 15 };
  const quote = { bid: 19.2, ask: 20, lp: 19.5, tt: Math.floor((now - 1000) / 1000) };
  const options = Array.from({ length: 14 }, (_, i) => [Math.floor((now - (14 - i) * 5 * 60_000) / 1000), 20, 21, 19, 20, 100]);
  options[13][3] = 15;
  const base = { symbol: "NSE:ABC26NOV100CE", strike: 100, side: "CE", expiry: "1795651200" };
  for (const contract of [
    { ...base, side: "PE" },
    { ...base, symbol: "BSE:ABC26NOV100CE" },
    { ...base, symbol: "NSE:ABC26NOV100PE" },
    { ...base, strike: 0 },
    { ...base, strike: 105 },
    { ...base, expiry: "" }
  ]) {
    const result = buildVerifiedSureshotTradePlan({
      underlyingSymbol: "NSE:ABC-EQ", direction, contract, quote, optionCandles: options, now
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /contract identity/i);
  }
});

test("blocks expired contracts and stale or future underlying direction", () => {
  const direction = { ok: true, side: "CE", spot: 104, latestCandleAt: new Date(now - 300000).toISOString(), candleAgeSeconds: 0, completedCandleCount: 15 };
  const contract = { symbol: "NSE:ABC26NOV100CE", strike: 100, side: "CE", expiry: "1795651200" };
  const quote = { bid: 19.2, ask: 20, lp: 19.5, tt: Math.floor((now - 1000) / 1000) };
  const options = Array.from({ length: 14 }, (_, i) => [Math.floor((now - (14 - i) * 5 * 60_000) / 1000), 20, 21, 19, 20, 100]);
  options[13][3] = 15;
  const expired = buildVerifiedSureshotTradePlan({
    underlyingSymbol: "NSE:ABC-EQ", direction,
    contract: { ...contract, expiry: String(Math.floor((now - 86400_000) / 1000)) },
    quote, optionCandles: options, now
  });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expiry has passed/i);
  const staleDirection = buildVerifiedSureshotTradePlan({
    underlyingSymbol: "NSE:ABC-EQ",
    direction: { ...direction, latestCandleAt: new Date(now - 30 * 60_000).toISOString() },
    contract, quote, optionCandles: options, now
  });
  assert.equal(staleDirection.ok, false);
  assert.match(staleDirection.reason, /underlying direction/i);
  const futureDirection = buildVerifiedSureshotTradePlan({
    underlyingSymbol: "NSE:ABC-EQ",
    direction: { ...direction, latestCandleAt: new Date(now + 60_000).toISOString() },
    contract, quote, optionCandles: options, now
  });
  assert.equal(futureDirection.ok, false);
});

test("blocks future-dated option quotes and invalid spread thresholds", () => {
  const direction = { ok: true, side: "CE", spot: 104, latestCandleAt: new Date(now - 300000).toISOString(), candleAgeSeconds: 0, completedCandleCount: 15 };
  const contract = { symbol: "NSE:ABC26NOV100CE", strike: 100, side: "CE", expiry: "1795651200" };
  const quote = { bid: 19.2, ask: 20, lp: 19.5, tt: Math.floor((now + 1000) / 1000) };
  const options = Array.from({ length: 14 }, (_, i) => [Math.floor((now - (14 - i) * 5 * 60_000) / 1000), 20, 21, 19, 20, 100]);
  options[13][3] = 15;
  assert.equal(buildVerifiedSureshotTradePlan({
    underlyingSymbol: "NSE:ABC-EQ", direction, contract, quote, optionCandles: options, now
  }).ok, false);
  assert.equal(buildVerifiedSureshotTradePlan({
    underlyingSymbol: "NSE:ABC-EQ", direction, contract,
    quote: { ...quote, tt: Math.floor((now - 1000) / 1000) },
    optionCandles: options, now, maxSpreadPct: 0
  }).ok, false);
});

test("selects nearest strike only on matching exchange, side and nearest expiry", () => {
  const discovery = {
    expiryData: [
      { expiry: String(Math.floor((now + 10 * 86400_000) / 1000)), date: "2026-11-12" },
      { expiry: String(Math.floor((now + 17 * 86400_000) / 1000)), date: "2026-11-19" }
    ],
    optionsChain: [
      { symbol: "NSE:ABC26NOV100CE", strike_price: 100, option_type: "CE", expiry: String(Math.floor((now + 10 * 86400_000) / 1000)) },
      { symbol: "BSE:SENSEX26NOV100CE", strike_price: 100, option_type: "CE", expiry: String(Math.floor((now + 10 * 86400_000) / 1000)) },
      { symbol: "NSE:ABC26NOV105PE", strike_price: 105, option_type: "PE", expiry: String(Math.floor((now + 10 * 86400_000) / 1000)) }
    ]
  };
  const selected = selectNearestVerifiedOptionContract({ discovery, underlyingSymbol: "NSE:ABC-EQ", side: "CE", spot: 102, now });
  assert.equal(selected.ok, true);
  assert.equal(selected.contract.symbol, "NSE:ABC26NOV100CE");
});

test("blocks stale option quotes and only accepts a fresh >=1:2 risk plan", () => {
  const direction = { ok: true, side: "CE", spot: 104, latestCandleAt: new Date(now - 300000).toISOString(), candleAgeSeconds: 0, completedCandleCount: 15 };
  const contract = { symbol: "NSE:ABC26NOV100CE", strike: 100, side: "CE", expiry: "1795651200" };
  const quote = { bid: 19.2, ask: 20, lp: 19.5, tt: Math.floor((now - 1000) / 1000) };
  const options = Array.from({ length: 14 }, (_, i) => [Math.floor((now - (14 - i) * 5 * 60_000) / 1000), 20, 21, 19, 20, 100]);
  options[13][3] = 15;
  const result = buildVerifiedSureshotTradePlan({ underlyingSymbol: "NSE:ABC-EQ", direction, contract, quote, optionCandles: options, lotSize: 25, tickSize: 0.05, now });
  assert.equal(result.ok, true);
  assert.ok(result.risk.rr >= 2);
  assert.equal(result.risk.lotSize, 25);
  assert.equal(result.risk.quantity, 25);
  assert.equal(result.risk.riskPerLot, result.risk.riskPerUnit * 25);
  const stale = buildVerifiedSureshotTradePlan({ underlyingSymbol: "NSE:ABC-EQ", direction, contract, quote: { ...quote, tt: Math.floor((now - 16000) / 1000) }, optionCandles: options, lotSize: 25, tickSize: 0.05, now });
  assert.equal(stale.ok, false);
});
