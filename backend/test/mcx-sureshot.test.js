import test from "node:test";
import assert from "node:assert/strict";
import { buildMcxFuturesUniverse, buildVerifiedMcxShortlist } from "../src/mcx-sureshot.js";

const now = Date.parse("2026-11-05T14:00:00.000Z");
const expiry = Math.floor(Date.parse("2026-11-19T00:00:00.000Z") / 1000);
const master = {
  "MCX:CRUDEOIL26NOVFUT": {
    tradeStatus: 1, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-1", underSym: "CRUDEOIL",
    expiryDate: expiry, minLotSize: 100, tickSize: 1
  },
  "MCX:CRUDEOIL26NOV8400CE": {
    tradeStatus: 1, optType: "CE", tradingSession: "0900-2355", fyToken: "opt-1", underFyTok: "fut-1",
    underSym: "CRUDEOIL", strikePrice: 8400, expiryDate: expiry,
    minLotSize: 100, tickSize: 0.05
  },
  "MCX:CRUDEOIL26NOV8400PE": {
    tradeStatus: 1, optType: "PE", tradingSession: "0900-2355", fyToken: "opt-2", underFyTok: "fut-1",
    underSym: "CRUDEOIL", strikePrice: 8400, expiryDate: expiry,
    minLotSize: 100, tickSize: 0.05
  },
  "MCX:GOLD26NOVFUT": {
    tradeStatus: 0, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-2", underSym: "GOLD",
    expiryDate: expiry, minLotSize: 100, tickSize: 1
  },
  "MCX:NATURALGAS26NOVFUT": {
    tradeStatus: 1, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-3", underSym: "NATURALGAS",
    expiryDate: expiry, minLotSize: 1250, tickSize: 0.1
  }
};

test("MCX universe accepts only active unexpired futures with active CE and PE master contracts", () => {
  const rows = buildMcxFuturesUniverse(master, now);
  assert.deepEqual(rows.map(row => row.symbol), ["MCX:CRUDEOIL26NOVFUT"]);
  assert.equal(rows[0].optionContracts.length, 2);
  assert.equal(rows[0].optionContracts[0].tickSize, 0.05);
});

test("MCX universe rejects malformed masters and missing option sides", () => {
  assert.throws(() => buildMcxFuturesUniverse(null, now), /invalid_fyers_mcx_symbol_master/);
  const incomplete = { ...master };
  delete incomplete["MCX:CRUDEOIL26NOV8400PE"];
  assert.deepEqual(buildMcxFuturesUniverse(incomplete, now), []);
});

test("excludes contracts whose official trading session has closed", () => {\n  const closed = {\n    "MCX:SILVER26NOVFUT": { tradeStatus: 1, optType: "XX", tradingSession: "0900-1700", fyToken: "fut-silver", underSym: "SILVER", expiryDate: expiry, minLotSize: 30, tickSize: 1 },\n    "MCX:SILVER26NOV100000CE": { tradeStatus: 1, optType: "CE", tradingSession: "0900-1700", fyToken: "silver-ce", underSym: "SILVER", strikePrice: 100000, expiryDate: expiry, minLotSize: 30, tickSize: 0.05 },\n    "MCX:SILVER26NOV100000PE": { tradeStatus: 1, optType: "PE", tradingSession: "0900-1700", fyToken: "silver-pe", underSym: "SILVER", strikePrice: 100000, expiryDate: expiry, minLotSize: 30, tickSize: 0.05 }\n  };\n  assert.deepEqual(buildMcxFuturesUniverse(closed, now), []);\n});\n\ntest("MCX shortlist requires complete fresh exchange-timestamped quote coverage", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  const rows = buildVerifiedMcxShortlist({
    universe, now, quoteRows: [{
      n: "MCX:CRUDEOIL26NOVFUT",
      v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) }
    }]
  });
  assert.equal(rows.data[0].symbol, "MCX:CRUDEOIL26NOVFUT");
  assert.equal(rows.data[0].price, 8440);
  assert.equal(rows.rankingIsSignal, false);
});

test("MCX shortlist fails closed for missing, duplicate, unknown or stale quotes", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  assert.throws(() => buildVerifiedMcxShortlist({ universe, quoteRows: [], now }), /incomplete_mcx_quote_coverage/);
  assert.throws(() => buildVerifiedMcxShortlist({
    universe, now, quoteRows: [{ n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor((now - 60000) / 1000) } }]
  }), /stale_or_invalid_mcx_future_quote/);
  assert.throws(() => buildVerifiedMcxShortlist({
    universe, now, quoteRows: [
      { n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) } },
      { n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8441, chp: 1.3, tt: Math.floor(now / 1000) } }
    ]
  }), /mcx_quote_coverage_mismatch/);
});
