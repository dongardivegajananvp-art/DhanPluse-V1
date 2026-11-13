import test from "node:test";
import assert from "node:assert/strict";
import { buildVerifiedSureshotShortlist, selectSureshotOptionVerificationCandidates } from "../src/sureshot-shortlist.js";

const now = Date.parse("2026-11-02T07:00:00.000Z");
const universe = { data: Array.from({ length: 218 }, (_, i) => ({ symbol: `NSE:STOCK${i}-EQ`, lotSize: 25 })) };
const quoteSnapshot = {
  ok: true, verified: true, universeCount: 218, quotedCount: 218,
  data: universe.data.map((row, i) => ({
    n: row.symbol,
    v: { lp: 100 + i, chp: i - 100, tt: Math.floor((now - 5000) / 1000) }
  }))
};
const indexTicks = new Map([
  ["NSE:NIFTY50-INDEX", { ltp: 24000, chp: 999, updatedAt: new Date(now - 1000).toISOString() }],
  ["NSE:NIFTYBANK-INDEX", { ltp: 52000, chp: -888, updatedAt: new Date(now - 1000).toISOString() }],
  ["BSE:SENSEX-INDEX", { ltp: 79000, chp: 777, updatedAt: new Date(now - 1000).toISOString() }]
]);

test("ranks the complete fresh F&O universe and includes individually fresh indices", () => {
  const result = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks, now, limit: 250 });
  assert.equal(result.data.length, 221);
  assert.equal(result.candidateCount, 221);
  assert.equal(result.universeCount, 221);
  assert.equal(result.data[0].symbol, "NSE:NIFTY50-INDEX");
  assert.equal(result.data[0].rank, 1);
  assert.equal(result.signalsAllowed, false);
  assert.equal(result.topGainers.length, 10);
  assert.equal(result.topLosers.length, 10);
  assert.equal(result.topGainers[0].changePct, 117);
  assert.equal(result.topLosers[0].changePct, -100);
  assert.equal(result.moverBoardsComplete, true);
  assert.equal(result.data.find(row => row.symbol === "NSE:STOCK217-EQ").lotSize, 25, "official stock lot size is preserved in the ranked rows");
  assert.deepEqual(result.data.slice(0, 5).map(row => row.symbol), ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX", "NSE:STOCK217-EQ", "NSE:STOCK216-EQ"]);
  assert.equal(result.data.at(-1).rank, 221);
});

test("ranks only independently fresh F&O quotes when universe coverage is partial", () => {
  const partial = { ...quoteSnapshot, data: quoteSnapshot.data.slice(0, 217), quotedCount: 217 };
  const result = buildVerifiedSureshotShortlist({ quoteSnapshot: partial, universe, indexTicks, now, limit: 250 });
  assert.equal(result.quotedEquityCount, 217);
  assert.equal(result.partialQuoteCoverage, true);
  assert.equal(result.equityCandidates.length, 217);
  assert.equal(result.candidateCount, 220);
});

test("skips stale individual equity quotes and missing, null-change or stale index ticks", () => {
  const stale = structuredClone(quoteSnapshot);
  stale.data[0].v.tt = Math.floor((now - 31000) / 1000);
  const staleResult = buildVerifiedSureshotShortlist({ quoteSnapshot: stale, universe, indexTicks, now });
  assert.equal(staleResult.quotedEquityCount, 217);
  assert.equal(staleResult.partialQuoteCoverage, true);
  const missingIndex = new Map(indexTicks);
  missingIndex.delete("BSE:SENSEX-INDEX");
  const missingResult = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks: missingIndex, now, limit: 5 });
  assert.equal(missingResult.data.length, 5);
  assert.equal(missingResult.data.some(row => row.symbol === "BSE:SENSEX-INDEX"), false);
  const nullChange = new Map(indexTicks);
  nullChange.set("BSE:SENSEX-INDEX", { ...indexTicks.get("BSE:SENSEX-INDEX"), chp: null });
  const nullChangeResult = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks: nullChange, now, limit: 5 });
  assert.equal(nullChangeResult.data.length, 5);
  assert.equal(nullChangeResult.data.some(row => row.symbol === "BSE:SENSEX-INDEX"), false);
});

test("rejects duplicate F&O symbols", () => {
  const duplicate = [...universe.data.slice(0, -1), universe.data[0]];
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot, universe: { data: duplicate }, indexTicks, now }),
    /fno_universe_contains_duplicate_symbols/);
});

test("default shortlist is exactly five from the complete 218-equity universe", () => {
  const result = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks, now });
  assert.equal(result.data.length, 5);
  assert.equal(result.candidateCount, 221);
  assert.deepEqual(result.data.map(row => row.rank), [1, 2, 3, 4, 5]);
});


test("option verification includes every fresh F&O equity and each independently fresh index", () => {
  const ranked = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks, now, limit: 250 });
  const selected = selectSureshotOptionVerificationCandidates(ranked);
  assert.equal(selected.length, 221);
  assert.equal(selected.filter(row => row.underlyingType === "FNO_EQUITY").length, 218);
  assert.equal(selected.filter(row => row.underlyingType === "INDEX").length, 3);
  assert.equal(new Set(selected.map(row => row.symbol)).size, 221);
  assert.deepEqual(selected.map(row => row.rank), Array.from({ length: 221 }, (_, i) => i + 1));
});

test("missing or stale index ticks do not remove any verified F&O equities", () => {
  const ranked = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks, now, limit: 250 });
  const missingIndex = new Map(indexTicks);
  missingIndex.delete("BSE:SENSEX-INDEX");
  const partial = buildVerifiedSureshotShortlist({ quoteSnapshot, universe, indexTicks: missingIndex, now, limit: 250 });
  const selected = selectSureshotOptionVerificationCandidates(partial);
  assert.equal(selected.length, 220);
  assert.equal(selected.filter(row => row.underlyingType === "FNO_EQUITY").length, 218);
});

test("requires quote rows to be unique and within the declared verified partial snapshot", () => {
  const missing = { ...quoteSnapshot, data: quoteSnapshot.data.slice(0, -1), quotedCount: 217 };
  const partialResult = buildVerifiedSureshotShortlist({ quoteSnapshot: missing, universe, indexTicks, now, limit: 250 });
  assert.equal(partialResult.quotedEquityCount, 217);
  assert.equal(partialResult.partialQuoteCoverage, true);
  const duplicateQuote = structuredClone(quoteSnapshot);
  duplicateQuote.data[217].n = duplicateQuote.data[0].n;
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot: duplicateQuote, universe, indexTicks, now }),
    /fno_quote_coverage_mismatch/);
  const wrongSymbol = structuredClone(quoteSnapshot);
  wrongSymbol.data[217].n = "NSE:NOT-IN-UNIVERSE-EQ";
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot: wrongSymbol, universe, indexTicks, now }),
    /fno_quote_coverage_mismatch/);
  const staleLast = structuredClone(quoteSnapshot);
  staleLast.data[217].v.tt = Math.floor((now - 30001) / 1000);
  assert.throws(() => buildVerifiedSureshotShortlist({ quoteSnapshot: staleLast, universe, indexTicks, now }),
    /stale_or_invalid_fno_quote_snapshot/);
});
