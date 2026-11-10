import test from "node:test";
import assert from "node:assert/strict";
import { parseFyersQuoteTimestamp, summarizeFyersQuoteTimestampFields } from "../src/fyers-quote-timestamp.js";

const now = Date.parse("2026-11-10T03:15:00.000Z");

test("prefers exchange feed time over last-traded time and tt", () => {
  const result = parseFyersQuoteTimestamp({
    v: { tt: "2026-11-10", last_traded_time: Math.floor((now - 60000) / 1000), exch_feed_time: Math.floor(now / 1000) }
  });
  assert.equal(result.field, "exch_feed_time");
  assert.equal(result.timestampMs, now);
});

test("uses last_traded_time or ltt when exchange feed time is absent", () => {
  assert.equal(parseFyersQuoteTimestamp({ v: { tt: "2026-11-10", last_traded_time: Math.floor(now / 1000) } }).timestampMs, now);
  assert.equal(parseFyersQuoteTimestamp({ ltt: Math.floor(now / 1000), tt: "2026-11-10" }).timestampMs, now);
});

test("accepts numeric seconds, numeric milliseconds and ISO timestamps", () => {
  assert.equal(parseFyersQuoteTimestamp({ tt: Math.floor(now / 1000) }).timestampMs, now);
  assert.equal(parseFyersQuoteTimestamp({ tt: now }).timestampMs, now);
  assert.equal(parseFyersQuoteTimestamp({ exch_feed_time: new Date(now).toISOString() }).timestampMs, now);
});

test("rejects date-only tt and malformed or absent timestamps", () => {
  assert.equal(parseFyersQuoteTimestamp({ tt: "2026-11-10" }), null);
  assert.equal(parseFyersQuoteTimestamp({ tt: "not-a-time" }), null);
  assert.equal(parseFyersQuoteTimestamp(null), null);
});

test("timestamp diagnostics include timestamp fields only and never leak prices or tokens", () => {
  const summary = summarizeFyersQuoteTimestampFields([{
    n: "NSE:TEST-EQ",
    v: { lp: 123.45, fyToken: "secret-token", tt: "2026-11-10", exch_feed_time: Math.floor(now / 1000) }
  }]);
  const serialized = JSON.stringify(summary);
  assert.equal(summary[0].timestampFields.exch_feed_time.value, Math.floor(now / 1000));
  assert.equal(serialized.includes("123.45"), false);
  assert.equal(serialized.includes("secret-token"), false);
});
