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
    "NSE:RELIANCE26OCTFUT": { underFyTok: "101", underSym: "Reliance Industries", exInstType: 13, minLotSize: 250, tradeStatus: 1 },
    "NSE:RELIANCE26OCT1500CE": { underFyTok: "101", optType: "CE", exInstType: 15, minLotSize: 250, tradeStatus: 1 },
    "NSE:NIFTY26OCT25000CE": { underFyTok: "999", optType: "CE", exInstType: 14, tradeStatus: 1 }
  };
  assert.deepEqual(buildFnoEquityUniverse(fo, cm), [{ symbol: "NSE:RELIANCE-EQ", underlying: "RELIANCE", lotSize: 250 }]);
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
  assert.deepEqual(buildFnoEquityUniverse(fo, cm), [{ symbol: "NSE:M&M-EQ", underlying: "M&M", lotSize: null }]);
});

test("excludes inactive derivative rows when FYERS tradeStatus is a string", () => {
  const cm = {
    "NSE:LIVE-EQ": { exSymbol: "LIVE", tradeStatus: 1 },
    "NSE:OLD-EQ": { exSymbol: "OLD", tradeStatus: 1 }
  };
  const fo = {
    "NSE:LIVE26OCTFUT": { underSym: "LIVE", exInstType: 13, tradeStatus: 1 },
    "NSE:OLD26OCTFUT": { underSym: "OLD", exInstType: 13, tradeStatus: "0" }
  };
  assert.deepEqual(buildFnoEquityUniverse(fo, cm), [{ symbol: "NSE:LIVE-EQ", underlying: "LIVE", lotSize: null }]);
});

test("invalid FYERS symbol masters fail closed", () => {
  assert.throws(() => buildFnoEquityUniverse(null, {}), /invalid_fyers_symbol_master/);
});


test("stock-level lot size is withheld when active derivative master rows disagree", () => {
  const cm = { "NSE:RELIANCE-EQ": { fyToken: "101", tradeStatus: 1 } };
  const fo = {
    "NSE:RELIANCE26OCTFUT": { underFyTok: "101", exInstType: 13, minLotSize: 250, tradeStatus: 1 },
    "NSE:RELIANCE26OCT2500CE": { underFyTok: "101", optType: "CE", exInstType: 15, minLotSize: 500, tradeStatus: 1 }
  };
  assert.deepEqual(buildFnoEquityUniverse(fo, cm), [
    { symbol: "NSE:RELIANCE-EQ", underlying: "RELIANCE", lotSize: null }
  ]);
});

test("NSE session window enforces exact 09:15 open and 15:30 close boundaries", async () => {
  const { getNseSessionWindow } = await import("../src/market-data.js");
  assert.equal(getNseSessionWindow(new Date("2026-11-02T03:44:00.000Z")).isRegularHours, false); // 09:14 IST
  assert.equal(getNseSessionWindow(new Date("2026-11-02T03:45:00.000Z")).isRegularHours, true); // 09:15 IST
  assert.equal(getNseSessionWindow(new Date("2026-11-02T09:59:00.000Z")).isRegularHours, true); // 15:29 IST
  assert.equal(getNseSessionWindow(new Date("2026-11-02T10:00:00.000Z")).isRegularHours, false); // 15:30 IST
});

test("NSE session window is timezone-independent for UTC instants", async () => {
  const { getNseSessionWindow } = await import("../src/market-data.js");
  const session = getNseSessionWindow(new Date("2026-11-06T04:00:00.000Z"));
  assert.equal(session.localTime, "09:30");
  assert.equal(session.isRegularHours, true);
  assert.equal(session.timezone, "Asia/Kolkata");
});
