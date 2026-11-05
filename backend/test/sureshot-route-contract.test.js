import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../../site/app.js", import.meta.url), "utf8");

test("Sureshot backend scans exactly five ranked candidates from a complete fresh universe", () => {
  assert.match(server, /const SURESHOT_UNIVERSE_SCAN_LIMIT = 5/);
  assert.match(server, /const SURESHOT_BATCH_SIZE = 5/);
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /if \(!nseRegularSessionNow\(\)\)/);
  assert.match(route, /isCompleteFreshFnoQuoteSnapshot\(stockQuoteCache\.data, expectedQuoteSymbols/);
  assert.match(route, /loadVerifiedFnoStockQuotes\(\{ priority: "sureshot" \}\)/);
  assert.match(route, /buildVerifiedSureshotShortlist\(/);
  assert.match(route, /rankedCandidateCount: ranked\.candidateCount/);
});

test("each selected candidate must pass underlying history, contract, live option quote, option candles and risk validation", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.match(route, /for \(const candidate of batch\)/);
  assert.match(route, /VERIFY_UNDERLYING_CANDLES/);
  assert.match(route, /DISCOVER_OPTION_CONTRACT/);
  assert.match(route, /getFyersOptionContractMetadata\(selected\.contract\.symbol\)/);
  assert.match(route, /VERIFY_OPTION_QUOTE/);
  assert.match(route, /VERIFY_OPTION_CANDLES/);
  assert.match(route, /BUILD_RISK_PLAN/);
  assert.match(route, /state\.results\.push\(\.\.\.batchResults\)/);
  assert.match(route, /state\.nextOffset \+= batchResults\.length/);
});

test("Sureshot publishes only after all selected candidates finish and discards partial plans on failure", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.match(route, /const selectedCandidatesComplete = state\.nextOffset >= state\.candidates\.length/);
  assert.match(route, /selectedCandidatesComplete,/);
  assert.match(route, /stopReason: "TOP_FIVE_CANDIDATES_CHECKED"/);
  assert.match(route, /bestSetup: verified\[0\] \|\| null/);
  assert.match(route, /sureshotScanState = null;[\s\S]*partialPlansDiscarded: true/);
  assert.match(route, /orderPlacement: "disabled"/);
});

test("server cursor resumes an interrupted scan in sequence and rejects expired/out-of-order cursors", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.match(route, /offset !== sureshotScanState\.nextOffset/);
  assert.match(route, /Scan cursor expired or out of sequence/);
  assert.match(route, /if \(!scanId && sureshotScanState[\s\S]*offset = sureshotScanState\.nextOffset/);
});

test("frontend automatic scan requires active Sureshot tab, open session and shared authenticated session", () => {
  const start = app.indexOf("const startAutomaticTopFiveScan");
  const end = app.indexOf("sureshotAutoScanTimer = window.setInterval", start);
  assert.ok(start >= 0 && end > start);
  const trigger = app.slice(start, end);
  assert.match(trigger, /currentTab !== 'Sureshot CE\/PE'/);
  assert.match(trigger, /!isRegularMarketSession\(\)/);
  assert.match(trigger, /SURESHOT_AUTO_SCAN_DAY_KEY/);
  const loader = app.slice(app.indexOf("async function loadSureshotUniverseShortlist"), app.indexOf("async function performSureshotSetup"));
  assert.match(loader, /DASHBOARD_SESSION_KEY/);
  assert.match(trigger, /loadSureshotUniverseShortlist\(\{ automatic: true \}\)/);
});

test("frontend marks the trading date only after complete Top 5 scan; failure keeps retry eligible", () => {
  const start = app.indexOf("async function loadSureshotUniverseShortlist");
  const end = app.indexOf("async function performSureshotSetup", start);
  assert.ok(start >= 0 && end > start);
  const loader = app.slice(start, end);
  const marker = loader.indexOf("localStorage.setItem(SURESHOT_AUTO_SCAN_DAY_KEY");
  const complete = loader.indexOf("result.selectedCandidatesComplete !== true");
  const catchAt = loader.indexOf("} catch (error)");
  assert.ok(marker > complete && marker < catchAt, "daily marker must be written after completion checks and before catch");
  assert.match(loader.slice(0, catchAt), /TOP_FIVE_CANDIDATES_CHECKED/);
  assert.match(loader.slice(catchAt), /All partial plans are discarded/);
});
