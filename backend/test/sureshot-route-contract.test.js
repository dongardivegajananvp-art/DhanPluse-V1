import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../../site/app.js", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("../../site/index.html", import.meta.url), "utf8");
const discovery = await readFile(new URL("../src/option-contract-discovery.js", import.meta.url), "utf8");

test("Sureshot verifies the complete F&O quote universe and option-checks bounded mover candidates in five-item batches", () => {
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
  assert.ok(route.includes("selectSureshotOptionVerificationCandidates(ranked)"));
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
  assert.match(app, /row\.finalVerifiedAt/);
  assert.match(indexHtml, /row\.finalVerifiedAt/);
  assert.match(app, /quoteAgeSeconds\) > 15/);
  assert.match(indexHtml, /quoteAgeSeconds\) > 15/);
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
  assert.match(route, /sureshotScanState = null;[\s\S]*partialPlansDiscarded: !resumableScan/);
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

test("MCX Sureshot audits and verifies every eligible future in resumable batches before publishing Top 3", () => {
  const start = server.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /if \(!scanId && !streamConnected\)/);
  assert.doesNotMatch(route.slice(0, route.indexOf("const subscriptionReady")), /mcxUniverseSubscribedSocket !== marketSocket/);
  assert.match(route, /const subscriptionReady = await subscribeMcxFuturesUniverse\(marketSocket\)/);
  assert.match(route, /buildMcxSocketQuoteRows\(universe\.data, latestTicks\)/);
  assert.match(route, /VERIFY_MCX_FUTURES_WEBSOCKET_TICKS/);
  assert.match(route, /buildVerifiedMcxAudit\(/);
  assert.match(route, /limit: universe\.data\.length/);
  assert.match(route, /const batch = state\.candidates\.slice\(offset, offset \+ SURESHOT_BATCH_SIZE\)/);
  assert.match(route, /VERIFY_MCX_UNDERLYING_CANDLES/);
  assert.match(route, /SELECT_MCX_OPTION_CONTRACT/);
  assert.match(route, /VERIFY_MCX_OPTION_QUOTES/);
  assert.match(route, /VERIFY_MCX_OPTION_CANDLES/);
  assert.match(route, /state\.results\.push\(\.\.\.batchResults\)/);
  assert.match(route, /state\.nextOffset \+= batchResults\.length/);
  assert.match(route, /FINAL_REVALIDATE_MCX_UNDERLYING/);
  assert.match(route, /FINAL_REVALIDATE_MCX_OPTION_CANDLES/);
  assert.match(route, /FINAL_REVALIDATE_MCX_OPTION_QUOTES/);
  assert.match(route, /FINAL_REVALIDATE_MCX_FUTURES_WEBSOCKET_TICKS/);
  assert.match(route, /FINAL_REVALIDATE_MCX_FUTURES_WEBSOCKET_TICKS/);
  assert.match(route, /mcxUniverseSubscribedSocket !== marketSocket/);
  assert.match(route, /mcxUniverseSubscribedSocket !== marketSocket/);
  assert.match(route, /buildVerifiedMcxAudit\(\{[\s\S]*?quoteRows: finalFuturesQuoteRows/);
  assert.match(route, /FINAL_REVALIDATE_MCX_FUTURES_WEBSOCKET_TICKS/);
  assert.match(route, /mcxUniverseSubscribedSocket !== marketSocket/);
  assert.match(route, /finalFuturesAudit\.complete/);
  assert.match(route, /state\.audit = finalFuturesAudit\.audit/);
  assert.match(route, /item\.exchangeTime = quote\.exchangeTime/);
  assert.match(route, /topThreeSetups = verified\.slice\(0, 3\)/);
  assert.match(route, /ALL_ELIGIBLE_MCX_CANDIDATES_CHECKED/);
  assert.match(route, /fullUniverseAuditCount: fullUniverseAudit\.length/);
  assert.match(route, /partialPlansDiscarded: !resumableScan/);
  assert.match(app, /MCX FULL UNIVERSE AUDIT RESULTS/);
  assert.match(app, /MCX TOP 3 VERIFIED SETUPS/);
  assert.match(app, /while \(attempts\+\+ < 100\)/);
  assert.match(app, /payload\.scanPaused === true/);
  assert.match(app, /row\.optionPremium/);
  assert.match(indexHtml, /MCX FULL UNIVERSE AUDIT RESULTS/);
  assert.match(indexHtml, /MCX TOP 3 VERIFIED SETUPS/);
});

test("NSE and MCX Sureshot scan gates are independent", () => {
  const start = server.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /const mcxSessionOpen = \(\) => getExchangeSessionWindows\(\)\.MCX\?\.session === "SCHEDULED_OPEN"/);
  assert.match(route, /if \(mcxSureshotAutoPlansInFlight\)/);
  assert.doesNotMatch(route, /if \(sureshotAutoPlansInFlight\)/);
  assert.match(route, /mcxSureshotAutoPlansInFlight = true/);
  assert.match(route, /sureshotAutoPlansInFlight = nseSureshotAutoPlansInFlight/);
  const mcxFrontend = app.slice(app.indexOf("async function loadMcxSureshotUniverseShortlist"), app.indexOf("async function loadAdvancedScanner"));
  assert.match(mcxFrontend, /mcxSureshotUniverseScanRunning/);
  assert.doesNotMatch(mcxFrontend, /sureshotUniverseScanRunning/);
  assert.match(app, /mcxSureshotUniverseScanRunning \|\| mcxAutoScanStatusCheckInFlight/);
});


test("NSE option verification uses the complete Top 10 gainers/losers boards, not all 218 equities", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.ok(route.includes("selectSureshotOptionVerificationCandidates(ranked)"));
  assert.ok(route.includes("topGainers: ranked.topGainers, topLosers: ranked.topLosers"));
  assert.ok(!route.includes("const moverCandidates = ranked.data.map"));
  assert.ok(server.includes("export function selectSureshotOptionVerificationCandidates"));
});


test("NSE option verification is bounded to Top 10 gainers, Top 10 losers and fresh indices", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.ok(route.includes("selectSureshotOptionVerificationCandidates(ranked)"));
  assert.ok(route.includes("topGainers: ranked.topGainers, topLosers: ranked.topLosers"));
  assert.ok(!route.includes("const moverCandidates = ranked.data.map"));
  assert.ok(server.includes("export function selectSureshotOptionVerificationCandidates"));
});
