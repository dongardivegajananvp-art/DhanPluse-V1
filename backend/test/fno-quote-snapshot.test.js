import test from "node:test";
import assert from "node:assert/strict";
import {
  moversPayloadToFnoQuoteSnapshot,
  fnoQuoteSnapshotToMoversPayload
} from "../src/fno-quote-snapshot.js";

const now = Date.parse("2026-11-03T05:00:00.000Z");
const symbols = ["NSE:ABC-EQ", "NSE:XYZ-EQ"];
const movers = {
  ok: true, partial: false, fetchedAt: new Date(now).toISOString(),
  requestedSymbols: 2, receivedSymbols: 2,
  data: symbols.map((symbol, i) => ({
    symbol, price: 100 + i, change: 1, changePct: 1,
    priceAsOf: new Date(now - 1000).toISOString(), priceStatus: "LIVE_QUOTE"
  }))
};
const snapshot = {
  ok: true, verified: true, fetchedAt: new Date(now).toISOString(),
  universeCount: 2, quotedCount: 2,
  data: symbols.map((n, i) => ({
    n, verified: true,
    v: { lp: 100 + i, ch: 1, chp: 1, tt: Math.floor((now - 1000) / 1000) }
  }))
};

test("complete fresh movers snapshot converts to a verified Sureshot quote snapshot", () => {
  const result = moversPayloadToFnoQuoteSnapshot(movers, symbols, now);
  assert.equal(result.verified, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].v.lp, 100);
});

test("incomplete, stale, duplicate, or non-live movers rows are never shared", () => {
  assert.equal(moversPayloadToFnoQuoteSnapshot({ ...movers, partial: true }, symbols, now), null);
  assert.equal(moversPayloadToFnoQuoteSnapshot({ ...movers, receivedSymbols: 1 }, symbols, now), null);
  const stale = structuredClone(movers);
  stale.data[0].priceAsOf = new Date(now - 121000).toISOString();
  assert.equal(moversPayloadToFnoQuoteSnapshot(stale, symbols, now), null);
  const duplicate = structuredClone(movers);
  duplicate.data[1].symbol = duplicate.data[0].symbol;
  assert.equal(moversPayloadToFnoQuoteSnapshot(duplicate, symbols, now), null);
  const lastKnown = structuredClone(movers);
  lastKnown.data[0].priceStatus = "LAST_KNOWN_PRICE";
  assert.equal(moversPayloadToFnoQuoteSnapshot(lastKnown, symbols, now), null);
});

test("complete fresh F&O quote snapshot converts to live movers rows", () => {
  const result = fnoQuoteSnapshotToMoversPayload(snapshot, symbols, now);
  assert.equal(result.partial, false);
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].priceStatus, "LIVE_QUOTE");
});

test("stale or incomplete F&O quote snapshots cannot seed movers cache", () => {
  assert.equal(fnoQuoteSnapshotToMoversPayload({ ...snapshot, quotedCount: 1 }, symbols, now), null);
  const stale = structuredClone(snapshot);
  stale.data[0].v.tt = Math.floor((now - 31000) / 1000);
  assert.equal(fnoQuoteSnapshotToMoversPayload(stale, symbols, now), null);
});
