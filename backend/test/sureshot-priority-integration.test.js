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
test("MCX quote rows are rebuilt in route scope after the complete socket audit and before ranking", () => {
  const start = server.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  const guard = route.indexOf("if (!mcxAudit.complete)");
  const ranked = route.indexOf("const ranked = buildVerifiedMcxShortlist");
  const rebuilt = route.lastIndexOf("const quoteRows = buildMcxSocketQuoteRows(universe.data, latestTicks)", ranked);
  assert.ok(guard >= 0 && ranked > guard && rebuilt > guard && rebuilt < ranked);
});
