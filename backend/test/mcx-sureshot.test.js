import test from "node:test";
import assert from "node:assert/strict";
import { buildMcxFuturesUniverse, buildVerifiedMcxShortlist, buildVerifiedMcxAudit, summarizeMcxQuoteTimestampFields } from "../src/mcx-sureshot.js";

const now = Date.parse("2026-11-05T14:00:00.000Z");
const expiry = Math.floor(Date.parse("2026-11-19T00:00:00.000Z") / 1000);
const master = {
  "MCX:CRUDEOIL26NOVFUT": {
    tradeStatus: 1, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-1", underSym: "CRUDEOIL",
    expiryDate: expiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 1
  },
  "MCX:CRUDEOIL26NOV8400CE": {
    tradeStatus: 1, optType: "CE", tradingSession: "0900-2355", fyToken: "opt-1", underFyTok: "fut-1",
    underSym: "CRUDEOIL", strikePrice: 8400, expiryDate: expiry,
    minLotSize: 1, qtyMultiplier: 100, tickSize: 0.05
  },
  "MCX:CRUDEOIL26NOV8400PE": {
    tradeStatus: 1, optType: "PE", tradingSession: "0900-2355", fyToken: "opt-2", underFyTok: "fut-1",
    underSym: "CRUDEOIL", strikePrice: 8400, expiryDate: expiry,
    minLotSize: 1, qtyMultiplier: 100, tickSize: 0.05
  },
  "MCX:GOLD26NOVFUT": {
    tradeStatus: 0, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-2", underSym: "GOLD",
    expiryDate: expiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 1
  },
  "MCX:NATURALGAS26NOVFUT": {
    tradeStatus: 1, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-3", underSym: "NATURALGAS",
    expiryDate: expiry, minLotSize: 1, qtyMultiplier: 1250, tickSize: 0.1
  }
};

test("MCX universe accepts only active unexpired futures with active CE and PE master contracts", () => {
  const rows = buildMcxFuturesUniverse(master, now);
  assert.deepEqual(rows.map(row => row.symbol), ["MCX:CRUDEOIL26NOVFUT"]);
  assert.equal(rows[0].optionContracts.length, 2);
  assert.equal(rows[0].optionContracts[0].tickSize, 0.05);
});

test("accepts colon-form tradingSession values in IST", () => {
  const colonMaster = Object.fromEntries(Object.entries(master).map(([symbol, item]) => [
    symbol, { ...item, tradingSession: "09:00-23:55" }
  ]));
  assert.deepEqual(buildMcxFuturesUniverse(colonMaster, now).map(row => row.symbol), ["MCX:CRUDEOIL26NOVFUT"]);
});

test("MCX universe rejects malformed masters and missing option sides", () => {
  assert.throws(() => buildMcxFuturesUniverse(null, now), /invalid_fyers_mcx_symbol_master/);
  const incomplete = { ...master };
  delete incomplete["MCX:CRUDEOIL26NOV8400PE"];
  assert.deepEqual(buildMcxFuturesUniverse(incomplete, now), []);
});

test("excludes contracts whose official trading session has closed", () => {
  const closed = {
    "MCX:SILVER26NOVFUT": { tradeStatus: 1, optType: "XX", tradingSession: "0900-1700", fyToken: "fut-silver", underSym: "SILVER", expiryDate: expiry, minLotSize: 1, qtyMultiplier: 30, tickSize: 1 },
    "MCX:SILVER26NOV100000CE": { tradeStatus: 1, optType: "CE", tradingSession: "0900-1700", fyToken: "silver-ce", underSym: "SILVER", strikePrice: 100000, expiryDate: expiry, minLotSize: 1, qtyMultiplier: 30, tickSize: 0.05 },
    "MCX:SILVER26NOV100000PE": { tradeStatus: 1, optType: "PE", tradingSession: "0900-1700", fyToken: "silver-pe", underSym: "SILVER", strikePrice: 100000, expiryDate: expiry, minLotSize: 1, qtyMultiplier: 30, tickSize: 0.05 }
  };
  assert.deepEqual(buildMcxFuturesUniverse(closed, now), []);
});

test("matches MCX option families to their exact underlying futures token", () => {
  const secondExpiry = Math.floor(Date.parse("2026-12-17T00:00:00.000Z") / 1000);
  const paired = {
    "MCX:CRUDEOIL26NOVFUT": { tradeStatus: 1, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-nov", underSym: "CRUDEOIL", expiryDate: expiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 1 },
    "MCX:CRUDEOIL26DECFUT": { tradeStatus: 1, optType: "XX", tradingSession: "0900-2355", fyToken: "fut-dec", underSym: "CRUDEOIL", expiryDate: secondExpiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 1 },
    "MCX:CRUDEOIL26NOV8400CE": { tradeStatus: 1, optType: "CE", tradingSession: "0900-2355", fyToken: "nov-ce", underFyTok: "fut-nov", underSym: "CRUDEOIL", strikePrice: 8400, expiryDate: expiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 0.05 },
    "MCX:CRUDEOIL26NOV8400PE": { tradeStatus: 1, optType: "PE", tradingSession: "0900-2355", fyToken: "nov-pe", underFyTok: "fut-nov", underSym: "CRUDEOIL", strikePrice: 8400, expiryDate: expiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 0.05 },
    "MCX:CRUDEOIL26DEC8500CE": { tradeStatus: 1, optType: "CE", tradingSession: "0900-2355", fyToken: "dec-ce", underFyTok: "fut-dec", underSym: "CRUDEOIL", strikePrice: 8500, expiryDate: secondExpiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 0.05 },
    "MCX:CRUDEOIL26DEC8500PE": { tradeStatus: 1, optType: "PE", tradingSession: "0900-2355", fyToken: "dec-pe", underFyTok: "fut-dec", underSym: "CRUDEOIL", strikePrice: 8500, expiryDate: secondExpiry, minLotSize: 1, qtyMultiplier: 100, tickSize: 0.05 }
  };
  const rows = buildMcxFuturesUniverse(paired, now);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.fyToken === "fut-nov").optionContracts.map(row => row.symbol), [
    "MCX:CRUDEOIL26NOV8400CE", "MCX:CRUDEOIL26NOV8400PE"
  ]);
  assert.deepEqual(rows.find(row => row.fyToken === "fut-dec").optionContracts.map(row => row.symbol), [
    "MCX:CRUDEOIL26DEC8500CE", "MCX:CRUDEOIL26DEC8500PE"
  ]);
});

test("MCX shortlist ranks only fresh exchange-timestamped quote rows", () => {
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
  assert.deepEqual(rows.coverage, { requested: 1, received: 1, fresh: 1, excluded: 0, missing: 0 });
});

test("MCX shortlist rejects partial quote coverage instead of ranking fresh peers", () => {
  const universe = [
    ...buildMcxFuturesUniverse(master, now),
    { symbol: "MCX:NATURALGAS26NOVFUT", underlying: "NATURALGAS" }
  ];
  const freshCrude = { n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) } };
  assert.throws(() => buildVerifiedMcxShortlist({
    universe, quoteRows: [freshCrude], now
  }), /incomplete_mcx_quote_snapshot/);
  assert.throws(() => buildVerifiedMcxShortlist({
    universe, quoteRows: [
      freshCrude,
      { n: "MCX:NATURALGAS26NOVFUT", v: { lp: 320, chp: 0.5, tt: Math.floor((now - 60000) / 1000) } }
    ], now
  }), /stale_or_invalid_mcx_quote_snapshot/);
});

test("MCX shortlist fails closed when no fresh quotes are available and rejects duplicate or unknown symbols", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  assert.throws(() => buildVerifiedMcxShortlist({ universe, quoteRows: [], now }), /incomplete_mcx_quote_snapshot/);
  assert.throws(() => buildVerifiedMcxShortlist({
    universe, now, quoteRows: [{ n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor((now - 60000) / 1000) } }]
  }), /stale_or_invalid_mcx_quote_snapshot/);
  assert.throws(() => buildVerifiedMcxShortlist({
    universe, now, quoteRows: [
      { n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) } },
      { n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8441, chp: 1.3, tt: Math.floor(now / 1000) } }
    ]
  }), /mcx_quote_coverage_mismatch/);
});

test("MCX full-universe audit reports every official future and ranks only a complete fresh snapshot", () => {
  const universe = [
    ...buildMcxFuturesUniverse(master, now),
    { symbol: "MCX:NATURALGAS26NOVFUT", underlying: "NATURALGAS" }
  ];
  const quoteRows = [
    { n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) } },
    { n: "MCX:NATURALGAS26NOVFUT", v: { lp: 320, chp: -0.5, tt: Math.floor(now / 1000) } }
  ];
  const audit = buildVerifiedMcxAudit({ universe, quoteRows, now });
  assert.equal(audit.complete, true);
  assert.equal(audit.audit.length, 2);
  assert.equal(audit.freshQuoteCount, 2);
  assert.equal(audit.data[0].symbol, "MCX:CRUDEOIL26NOVFUT");
  assert.equal(audit.data[1].symbol, "MCX:NATURALGAS26NOVFUT");
});

test("MCX full-universe audit keeps stale and missing rows visible but blocks ranking", () => {
  const universe = [
    ...buildMcxFuturesUniverse(master, now),
    { symbol: "MCX:NATURALGAS26NOVFUT", underlying: "NATURALGAS" }
  ];
  const audit = buildVerifiedMcxAudit({
    universe, now, quoteRows: [{
      n: "MCX:CRUDEOIL26NOVFUT",
      v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) }
    }, {
      n: "MCX:NATURALGAS26NOVFUT",
      v: { lp: 320, chp: -0.5, tt: Math.floor((now - 60000) / 1000) }
    }]
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.data.length, 0);
  assert.equal(audit.audit[0].status, "FRESH_QUOTE");
  assert.equal(audit.audit[1].status, "STALE_OR_INVALID_QUOTE");
  assert.equal(audit.excludedQuoteCount, 1);
});

test("MCX full-universe audit identifies missing quote rows without hiding contracts", () => {
  const universe = [
    ...buildMcxFuturesUniverse(master, now),
    { symbol: "MCX:NATURALGAS26NOVFUT", underlying: "NATURALGAS" }
  ];
  const audit = buildVerifiedMcxAudit({
    universe, now, quoteRows: [{
      n: "MCX:CRUDEOIL26NOVFUT",
      v: { lp: 8440, chp: 1.25, tt: Math.floor(now / 1000) }
    }]
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.audit.length, 2);
  assert.equal(audit.audit[1].status, "MISSING_QUOTE");
  assert.equal(audit.missingQuoteCount, 1);
});


test("MCX audit prefers intraday exchange timestamps over date-only tt metadata", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  const freshEpoch = Math.floor(now / 1000);
  const audit = buildVerifiedMcxAudit({
    universe, now, quoteRows: [{
      n: "MCX:CRUDEOIL26NOVFUT",
      v: { lp: 8440, chp: 1.25, tt: "2026-11-05", ltt: freshEpoch }
    }]
  });
  assert.equal(audit.complete, true);
  assert.equal(audit.audit[0].status, "FRESH_QUOTE");
  assert.equal(audit.audit[0].exchangeTime, new Date(now).toISOString());
});

test("MCX audit prefers exch_feed_time and last_traded_time before tt", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  const freshEpoch = Math.floor(now / 1000);
  for (const fields of [
    { tt: "2026-11-05", exch_feed_time: freshEpoch, ltt: freshEpoch - 60 },
    { tt: "2026-11-05", last_traded_time: freshEpoch, ltt: freshEpoch - 60 }
  ]) {
    const audit = buildVerifiedMcxAudit({
      universe, now, quoteRows: [{ n: "MCX:CRUDEOIL26NOVFUT", v: { lp: 8440, chp: 1.25, ...fields } }]
    });
    assert.equal(audit.complete, true);
    assert.equal(audit.audit[0].exchangeTime, new Date(now).toISOString());
  }
});

test("MCX audit rejects date-only tt when no intraday exchange timestamp exists", () => {
  const universe = buildMcxFuturesUniverse(master, now);
  const audit = buildVerifiedMcxAudit({
    universe, now, quoteRows: [{
      n: "MCX:CRUDEOIL26NOVFUT",
      v: { lp: 8440, chp: 1.25, tt: "2026-11-05" }
    }]
  });
  assert.equal(audit.complete, false);
  assert.equal(audit.audit[0].status, "STALE_OR_INVALID_QUOTE");
  assert.equal(audit.audit[0].exchangeTime, null);
  assert.equal(audit.data.length, 0);
});


test("MCX timestamp diagnostics expose timestamp field names/types without quote payload values", () => {
  const result = summarizeMcxQuoteTimestampFields([{
    n: "MCX:CRUDEOIL26NOVFUT", s: "ok",
    v: { lp: 8400, fyToken: "must-not-appear", tt: "2026-11-09", ltt: 1794250000, exch_feed_time: null }
  }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].symbol, "MCX:CRUDEOIL26NOVFUT");
  assert.deepEqual(result[0].timestampFields.tt, { type: "string", value: "2026-11-09" });
  assert.deepEqual(result[0].timestampFields.ltt, { type: "number", value: 1794250000 });
  assert.equal(JSON.stringify(result).includes("8400"), false);
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
});
