import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../../site/app.js", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("../../site/index.html", import.meta.url), "utf8");
const discovery = await readFile(new URL("../src/option-contract-discovery.js", import.meta.url), "utf8");

test("Sureshot backend verifies every eligible F&O and individually fresh index candidate in five-item batches", () => {
  assert.match(server, /const SURESHOT_UNIVERSE_SCAN_LIMIT = 250/);
  assert.match(server, /const SURESHOT_BATCH_SIZE = 5/);
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /if \(!nseRegularSessionNow\(\)\)/);
  assert.match(route, /isCompleteFreshFnoQuoteSnapshot\(stockQuoteCache\.data, expectedQuoteSymbols/);
  assert.match(route, /loadVerifiedFnoStockQuotes\(\{ priority: "sureshot" \}\)/);
  assert.match(route, /buildVerifiedSureshotShortlist\(/);
  assert.match(route, /limit: SURESHOT_UNIVERSE_SCAN_LIMIT/);
  assert.match(route, /const moverCandidates = ranked\.data\.map/);
  assert.match(route, /const batch = state\.candidates\.slice\(offset, offset \+ SURESHOT_BATCH_SIZE\)/);
  assert.match(route, /state\.nextOffset >= state\.candidates\.length/);
  assert.match(route, /rankedCandidateCount: ranked\.candidateCount/);
  assert.match(route, /topThreeSetups = verified\.slice\(0, 3\)/);
  assert.match(route, /initiallyVerified: true/);
  assert.match(route, /FINAL_REVALIDATE_UNDERLYING/);
  assert.match(route, /FINAL_REVALIDATE_OPTION_QUOTES/);
  assert.match(route, /FINAL_REVALIDATE_OPTION_CANDLES/);
  assert.match(route, /item\.finalVerifiedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(route, /initiallyVerifiedCandidateCount/);
  assert.match(route, /ALL_ELIGIBLE_CANDIDATES_CHECKED/);
  assert.match(app, /result\.stopReason !== 'ALL_ELIGIBLE_CANDIDATES_CHECKED'/);
  assert.match(app, /TOP 3 VERIFIED SETUPS/);
  assert.match(app, /FULL UNIVERSE AUDIT RESULTS/);
  assert.match(indexHtml, /result\.stopReason !== 'ALL_ELIGIBLE_CANDIDATES_CHECKED'/);
  assert.match(indexHtml, /TOP 3 VERIFIED SETUPS/);
  assert.match(indexHtml, /Scan Full F&O \+ Fresh Indices/);
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
  assert.match(route, /stopReason: "ALL_ELIGIBLE_CANDIDATES_CHECKED"/);
  assert.match(route, /bestSetup: topThreeSetups\[0\] \|\| null/);
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
  assert.match(trigger, /SURESHOT_AUTO_SCAN_ATTEMPT_KEY/);
  const loader = app.slice(app.indexOf("async function loadSureshotUniverseShortlist"), app.indexOf("async function performSureshotSetup"));
  assert.match(loader, /DASHBOARD_SESSION_KEY/);
  assert.match(trigger, /loadSureshotUniverseShortlist\(\{ automatic: true \}\)/);
});

test("frontend records one automatic attempt per session day and marks completion only after every eligible candidate passes", () => {
  const start = app.indexOf("async function loadSureshotUniverseShortlist");
  const end = app.indexOf("async function performSureshotSetup", start);
  assert.ok(start >= 0 && end > start);
  const loader = app.slice(start, end);
  const triggerStart = app.indexOf("const startAutomaticTopFiveScan");
  const triggerEnd = app.indexOf("sureshotAutoScanTimer = window.setInterval", triggerStart);
  const trigger = app.slice(triggerStart, triggerEnd);
  const marker = loader.indexOf("localStorage.setItem(SURESHOT_AUTO_SCAN_DAY_KEY");
  const complete = loader.indexOf("result.selectedCandidatesComplete !== true");
  const catchAt = loader.indexOf("} catch (error)");
  assert.ok(marker > complete && marker < catchAt, "success marker must be written after completion checks and before catch");
  const attempt = loader.indexOf("localStorage.setItem(SURESHOT_AUTO_SCAN_ATTEMPT_KEY");
  const firstFetch = loader.indexOf("fetch(BACKEND_URL + '/api/market/sureshot-auto-plans'");
  assert.ok(attempt >= 0 && attempt < firstFetch, "attempt marker must be written before any FYERS scan request");
  assert.match(loader.slice(0, catchAt), /ALL_ELIGIBLE_CANDIDATES_CHECKED/);
  assert.match(loader.slice(catchAt), /All partial plans are discarded/);
  assert.match(loader.slice(catchAt), /SURESHOT_AUTO_SCAN_RETRY_KEY/);
  assert.match(loader.slice(catchAt), /retryAfterSeconds/);
  assert.match(loader.slice(catchAt), /removeItem\(SURESHOT_AUTO_SCAN_ATTEMPT_KEY/);
  assert.match(trigger, /SURESHOT_AUTO_SCAN_RETRY_KEY/);
  const authStart = app.indexOf("localStorage.setItem(DASHBOARD_SESSION_KEY, data.dashboardSessionToken)");
  const authEnd = app.indexOf("authExchangeInProgress = false", authStart);
  assert.match(app.slice(authStart, authEnd), /removeItem\(SURESHOT_AUTO_SCAN_ATTEMPT_KEY\)/);
});


test("option-chain Greeks are not requested or used for Sureshot strike selection", () => {
  assert.doesNotMatch(server, /searchParams\.set\(["']greeks["']/);
  assert.doesNotMatch(server, /requireDelta\s*:\s*true/);
  assert.doesNotMatch(discovery, /row\.greeks\?\.delta|delta:\s*Number/);
});


test("Paper position close releases its FYERS socket symbol and reconnect restores only open positions", () => {
  assert.match(server, /reconcilePaperSocketSubscriptions/);
  assert.match(server, /result\?\.updates\?\.some\(position => position\.state === 'CLOSED'\)[\s\S]*subscribeOpenPaperPositions\(marketSocket\)/);
  assert.match(server, /manualExit\([\s\S]*?await subscribeOpenPaperPositions\(marketSocket\)/);
  assert.match(server, /subscribeOpenPaperPositions\(socket, \{ forceSubscribe: true \}\)/);
});
