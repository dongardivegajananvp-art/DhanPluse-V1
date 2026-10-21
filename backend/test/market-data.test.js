import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuote, normalizeCandles } from "../src/market-data.js";

test("quote is marked fresh only with valid positive price and timestamp", () => {
  const now = 1_800_000_000_000;
  const q = normalizeQuote({ lp: 100, tt: now / 1000 }, "NSE:TEST-EQ", now);
  assert.equal(q.price, 100);
  assert.equal(q.freshness, "fresh");
  assert.equal(q.verified, true);
});
test("rejects invalid quote instead of fabricating data", () => {
  assert.throws(() => normalizeQuote({ lp: 0, tt: Date.now() / 1000 }, "NSE:TEST-EQ"));
});
test("validates OHLC invariants", () => {
  const c = normalizeCandles([[1_800_000_000, 100, 110, 95, 105, 1000]]);
  assert.equal(c[0].high, 110);
  assert.throws(() => normalizeCandles([[1_800_000_000, 100, 90, 95, 105, 1000]]));
});


test("NSE regular session window uses India time and weekdays", async () => {
  const { getNseSessionWindow } = await import("../src/market-data.js");
  const inSession = getNseSessionWindow(new Date("2026-10-19T03:50:00.000Z")); // Monday 09:20 IST
  assert.equal(inSession.isRegularHours, true);
  assert.equal(inSession.localTime, "09:20");
  assert.equal(inSession.exchangeHolidayChecked, false);
  const afterClose = getNseSessionWindow(new Date("2026-10-19T10:00:00.000Z")); // Monday 15:30 IST
  assert.equal(afterClose.isRegularHours, false);
  assert.equal(afterClose.reason, "after-regular-session");
  const weekend = getNseSessionWindow(new Date("2026-10-24T05:00:00.000Z")); // Saturday 10:30 IST
  assert.equal(weekend.isRegularHours, false);
  assert.equal(weekend.reason, "weekend");
});

test("invalid session time is rejected", async () => {
  const { getNseSessionWindow } = await import("../src/market-data.js");
  assert.throws(() => getNseSessionWindow(new Date("invalid")), /invalid_session_time/);
});


import { buildFnoEquityUniverse } from "../src/fno-universe.js";

test("resolves stock F&O underlyings by FY token and excludes index contracts", () => {
  const cm = {
    "NSE:RELIANCE-EQ": { fyToken: "101", exSymbol: "RELIANCE", exSymName: "Reliance Industries", tradeStatus: 1 },
    "NSE:NIFTY50-INDEX": { fyToken: "999", exSymbol: "NIFTY50", tradeStatus: 1 }
  };
  const fo = {
    "NSE:RELIANCE26OCTFUT": { underFyTok: "101", underSym: "Reliance Industries", exInstType: 13, tradeStatus: 1 },
    "NSE:RELIANCE26OCT1500CE": { underFyTok: "101", optType: "CE", exInstType: 15, tradeStatus: 1 },
    "NSE:NIFTY26OCT25000CE": { underFyTok: "999", optType: "CE", exInstType: 14, tradeStatus: 1 }
  };
  assert.deepEqual(buildFnoEquityUniverse(fo, cm), [{ symbol: "NSE:RELIANCE-EQ", underlying: "RELIANCE" }]);
});

test("normalizes underlying aliases and excludes inactive cash symbols", () => {
  const cm = {
    "NSE:M&M-EQ": { exSymbol: "M&M", exSymName: "Mahindra & Mahindra", tradeStatus: 1 },
    "NSE:OLD-EQ": { exSymbol: "OLD", tradeStatus: 0 }
  };
  const fo = {
    "NSE:MM26OCTFUT": { underSym: "Mahindra & Mahindra", exInstType: 13, tradeStatus: 1 },
    "NSE:OLD26OCTFUT": { underSym: "OLD", exInstType: 13, tradeStatus: 1 }
  };
  assert.deepEqual(buildFnoEquityUniverse(fo, cm), [{ symbol: "NSE:M&M-EQ", underlying: "M&M" }]);
});

test("invalid FYERS symbol masters fail closed", () => {
  assert.throws(() => buildFnoEquityUniverse(null, {}), /invalid_fyers_symbol_master/);
});
