import test from "node:test";
import assert from "node:assert/strict";
import { buildMcxFuturesUniverse, buildVerifiedMcxShortlist } from "../src/mcx-sureshot.js";

const now = Date.parse("2026-11-05T14:00:00.000Z");
const master = {
  "MCX:CRUDEOIL26NOVFUT": { tradeStatus: 1, fyToken: "fut-1", underSym: "CRUDEOIL", expiryDate: "2026-11-19", minLotSize: 100 },
  "MCX:CRUDEOIL26NOV8400CE": { tradeStatus: 1, fyToken: "opt-1", underFyTok: "fut-1", underSym: "CRUDEOIL", optType: "CE", strikePrice: 8400, expiryDate: "2026-11-19", minLotSize: 100 },
  "MCX:CRUDEOIL26NOV8400PE": { tradeStatus: 1, fyToken: "opt-2", underFyTok: "fut-1", underSym: "CRUDEOIL", optType: "PE", strikePrice: 8400, expiryDate: "2026-11-19", minLotSize: 100 },
  "MCX:GOLD26NOVFUT": { tradeStatus: 0, fyToken: "fut-2", underSym: "GOLD", expiryDate: "2026-11-28" },
  "MCX:NATURALGAS26NOVFUT": { tradeStatus: 1, fyToken: "fut-3", underSym: "NATURALGAS", expiryDate: "2026-11-25" }
};

test("MCX universe includes only active unexpired futures with matching active option contracts", () => {
  const rows = buildMcxFuturesUniverse(master, now);
  assert.deepEqual(rows.map(row => row.symbol), ["MCX:CRUDEOIL26NOVFUT"]);
  assert.equal(rows[0].optionContractCount, 2);
});

test("MCX shortlist requires complete fresh timestamped quotes and ranks absolute move", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  const rows = buildVerifiedMcxShortlist({ universe, now, quoteRows: [{
    n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) }
  }] });
  assert.equal(rows.data[0].symbol, "MCX:CRUDEOIL26NOVFUT");
  assert.equal(rows.data[0].price, 8440);
});

test("MCX shortlist fails closed for missing or stale quotes", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  assert.throws(() => buildVerifiedMcxShortlist({ universe, quoteRows: [], now }), /incomplete_mcx_quote_coverage/);
  assert.throws(() => buildVerifiedMcxShortlist({ universe, now, quoteRows: [{
    n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor((now - 60000) / 1000) }
  }] }), /stale_or_invalid_mcx_future_quote/);
});
