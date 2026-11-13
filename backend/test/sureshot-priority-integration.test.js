import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

test("NSE and MCX Sureshot cursors share the same FYERS REST priority gate", () => {
  assert.match(server, /shouldPauseFyersRead/);
  assert.match(server, /mcxScanState: mcxSureshotScanState/);
  const lastKnownStart = server.indexOf('app.get("/api/market/last-known-stock-quotes"');
  const lastKnownEnd = server.indexOf("// Last-known F&O equity quotes", lastKnownStart);
  const route = server.slice(lastKnownStart, lastKnownEnd);
  assert.match(route, /shouldPauseLastKnownStockRefresh/);
  assert.ok(route.indexOf("lastKnownStockCache.data &&") < route.indexOf("shouldPauseLastKnownStockRefresh"), "fresh display cache is returned before REST refresh is paused");
});
test("MCX route ranks individually fresh contracts and revalidates each candidate at publication", () => {
  const start = server.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.ok(route.includes("if (!mcxAudit.freshQuoteCount)"));
  assert.ok(route.includes("const ranked = { data: mcxAudit.data, candidateCount: mcxAudit.candidateCount }"));
  assert.ok(route.includes("if (!finalFuturesAudit.freshQuoteCount)"));
  assert.ok(route.includes("const finalFutureBySymbol = new Map(finalFuturesAudit.data.map"));
});
