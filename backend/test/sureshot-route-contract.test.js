import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const app = await readFile(new URL("../../site/app.js", import.meta.url), "utf8");

const discovery = await readFile(new URL("../src/option-contract-discovery.js", import.meta.url), "utf8");
const shortlist = await readFile(new URL("../src/sureshot-shortlist.js", import.meta.url), "utf8");

test("each sequential F&O quote batch validates exchange timestamps against its own receive time", () => {
  const start = server.indexOf("async function loadVerifiedFnoStockQuotes");
  const end = server.indexOf('app.get("/api/market/stock-quotes"', start);
  assert.ok(start >= 0 && end > start, "verified F&O quote loader exists");
  const loader = server.slice(start, end);
  const responseAt = loader.indexOf("body = await fyersReadOnlyGet(url, { priority, stage })");
  const receiveAt = loader.indexOf("const quoteValidationNow = Date.now()", responseAt);
  assert.ok(responseAt >= 0 && receiveAt > responseAt,
    "each batch captures validation time only after its FYERS response arrives");
  assert.match(loader, /stamp <= quoteValidationNow \+ 5000 && quoteValidationNow - stamp <= 30000/);
  assert.doesNotMatch(loader, /const now = Date\.now\(\)/,
    "a scan-start clock must not reject later fresh batches as future-dated");
  assert.match(loader, /isCompleteFreshFnoQuoteSnapshot\(result, symbols, Date\.now\(\)\)/,
    "the complete snapshot must still be fresh after the final batch");
});

test("Sureshot verifies the complete F&O quote universe and option-checks every candidate in five-item batches", () => {
  assert.match(server, /const SURESHOT_UNIVERSE_SCAN_LIMIT = 250/);
  assert.match(server, /const SURESHOT_BATCH_SIZE = 5/);
  assert.match(server, /const SURESHOT_SCAN_TTL_MS = 3 \* 60 \* 60 \* 1000/);
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /if \(!nseRegularSessionNow\(\)\)/);
  assert.match(route, /isCompleteFreshFnoQuoteSnapshot\(stockQuoteCache\.data, expectedQuoteSymbols/);
  assert.match(route, /loadVerifiedFnoStockQuotes\(\{ priority: "sureshot", stage: scanStage \}\)/);
  assert.match(route, /buildVerifiedSureshotShortlist\(/);
  assert.match(route, /limit: SURESHOT_UNIVERSE_SCAN_LIMIT/);
  assert.ok(route.includes("selectSureshotOptionVerificationCandidates(ranked)"));
  assert.match(route, /const batch = state\.candidates\.slice\(offset, offset \+ SURESHOT_BATCH_SIZE\)/);
  assert.match(route, /state\.nextOffset >= state\.candidates\.length/);
  assert.match(route, /rankedCandidateCount: ranked\.candidateCount/);
  assert.match(route, /FINAL_REVALIDATE_FNO_UNIVERSE_QUOTES/);
  assert.match(route, /FINAL_REVALIDATE_TOP3_UNDERLYING_QUOTES/);
  assert.match(route, /FINAL_REVALIDATE_OPTION_QUOTES/);
  assert.match(route, /topThreeSetups = \[\]/);
  assert.match(route, /for \(let offset = 0; offset < finalQuoteCandidates\.length && topThreeSetups\.length < 3; offset \+= 3\)/);
  assert.match(route, /const verified = topThreeSetups/);
  assert.match(route, /underlyingQuoteAgeSeconds/);
  assert.match(route, /maxIndexTickAgeMs: NSE_TICK_FRESHNESS_SECONDS \* 1000/);
  assert.match(route, /initiallyVerified: true/);
  assert.match(route, /FINAL_REVALIDATE_UNDERLYING/);
  assert.match(route, /FINAL_REVALIDATE_OPTION_QUOTES/);
  assert.match(route, /FINAL_REVALIDATE_OPTION_CANDLES/);
  assert.match(route, /item\.finalVerifiedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(route, /initiallyVerifiedCandidateCount/);
  assert.match(route, /ALL_ELIGIBLE_CANDIDATES_CHECKED/);
  assert.match(route, /The complete eligible FYERS NSE F\&O quote universe was checked/);
  assert.doesNotMatch(route, /Option verification is limited to the complete Top 10 gainers/);
  assert.match(app, /result\.stopReason !== 'ALL_ELIGIBLE_CANDIDATES_CHECKED'/);
  assert.match(app, /TOP 3 VERIFIED SETUPS/);
  assert.match(app, /FULL UNIVERSE AUDIT RESULTS/);
  assert.match(app, /result\.stopReason !== 'ALL_ELIGIBLE_CANDIDATES_CHECKED'/);
  assert.match(app, /TOP 3 VERIFIED SETUPS/);
  assert.match(app, /Scan Full F&O \+ Fresh Indices/);
  assert.match(app, /row\.finalVerifiedAt/);
  assert.match(app, /row\.finalVerifiedAt/);
  assert.match(app, /quoteAgeSeconds\) > 15/);
  assert.match(app, /quoteAgeSeconds\) > 15/);
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

test("the canonical frontend app starts automatic NSE Sureshot scans app-wide", () => {
  for (const [label, source] of [["app.js", app]]) {
    const helperStart = source.indexOf("function maybeStartAutomaticSureshotScan()");
    const helperEnd = source.indexOf("async function performSureshotSetup", helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, label + " helper exists");
    const helper = source.slice(helperStart, helperEnd);
    assert.ok(!helper.includes("currentTab"), label + " trigger is not tab-bound");
    for (const token of ["isRegularMarketSession()", "DASHBOARD_SESSION_KEY", "SURESHOT_AUTO_SCAN_DAY_KEY",
      "SURESHOT_AUTO_SCAN_RETRY_KEY", "loadSureshotUniverseShortlist({ automatic: true })"]) assert.ok(helper.includes(token), label + ": " + token);
    assert.doesNotMatch(helper, /attemptedToday === today/, label + " must resume after an interrupted browser scan");
    assert.match(helper, /attempt marker is diagnostic only/, label + " documents reload recovery");
    assert.ok(source.includes("maybeStartAutomaticSureshotScan();"), label + " starts at app boot");
    assert.ok(source.includes("window.setInterval(maybeStartAutomaticSureshotScan, 30000)"), label + " has guarded local scheduler");
    const loader = source.slice(source.indexOf("async function loadSureshotUniverseShortlist"), helperStart);
    for (const token of ["const automatic = options.automatic === true",
      "!automatic && currentTab !== 'Sureshot CE/PE'",
      "visibleHost || document.createElement('div')",
      "sureshotUniverseScanHtml = host.innerHTML",
      "currentHost.innerHTML = sureshotUniverseScanHtml"]) assert.ok(loader.includes(token), label + ": " + token);
  }
});

test("frontend resumes interrupted automatic scans after a page reload and marks completion only after every eligible candidate passes", () => {
  const start = app.indexOf("async function loadSureshotUniverseShortlist");
  const end = app.indexOf("async function performSureshotSetup", start);
  assert.ok(start >= 0 && end > start);
  const loader = app.slice(start, end);
  const triggerStart = app.indexOf("const startAutomaticTopThreeScan");
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
  const authEnd = app.indexOf("} catch (error)", authStart);
  const authSource = app.slice(authStart, authEnd);
  assert.match(authSource, /removeItem\(SURESHOT_AUTO_SCAN_ATTEMPT_KEY\)/);
  assert.match(authSource, /maybeStartAutomaticSureshotScan\(\)/, "successful FYERS auth starts the scan even when Dashboard is active");
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

test("MCX Sureshot passes its own stage context to every FYERS REST call", () => {
  const start = server.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.doesNotMatch(route, /stage: scanStage/,
    "scanStage belongs to the separate NSE route and is undefined in the MCX handler");
  const calls = [...route.matchAll(/fyersReadOnlyGet\([^;]*?\{ priority: "sureshot", stage \}\)/gs)];
  assert.equal(calls.length, 6, "all six MCX FYERS history/quote requests pass the current MCX stage");
  assert.equal((route.match(/stage: scanStage/g) || []).length, 0,
    "the MCX handler must not reference the NSE-only stage variable");
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
  assert.match(route, /const mcxAuditDiagnostics = mcxAudit\.audit\.map\(row => \(\{/);
  assert.match(route, /contractAudit: mcxAuditDiagnostics/);
  assert.match(route, /quoteAgeSeconds: row\.quoteAgeSeconds \?\? null/);
  assert.match(route, /contractAudit: Array\.isArray\(error\.mcxAudit\?\.audit\)/);
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
  assert.match(app, /MCX FULL UNIVERSE AUDIT RESULTS/);
  assert.match(app, /MCX TOP 3 VERIFIED SETUPS/);
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
  assert.match(app, /nseSureshotScanRunning \|\| mcxSureshotScanRunning \|\| mcxAutoScanStatusCheckInFlight/);
});


test("NSE option verification selects the complete verified F&O equity universe", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.ok(route.includes("selectSureshotOptionVerificationCandidates(ranked)"));
  assert.ok(route.includes("candidates: moverCandidates"));
  assert.ok(server.includes("selectSureshotOptionVerificationCandidates } from './sureshot-shortlist.js'"));
  assert.match(shortlist, /\[\.\.\.ranked\.equityCandidates/);
});


test("NSE final candle revalidation covers every initial pass and final Top 3 ranking uses a fresh complete F&O snapshot", () => {
  const start = server.indexOf('app.get("/api/market/sureshot-auto-plans"');
  const end = server.indexOf("// Last-known F&O equity quotes", start);
  const route = server.slice(start, end);
  assert.ok(route.includes("const finalCheckCandidates = results.filter(item =>"));
  assert.ok(!route.includes(".slice(0, 5);"));
  assert.ok(route.includes("finalRevalidationCandidateCount: finalCheckCandidates.length"));
  assert.ok(route.includes("FINAL_REVALIDATE_FNO_UNIVERSE_QUOTES"));
  assert.ok(route.includes("FINAL_REVALIDATE_TOP3_UNDERLYING_QUOTES"));
  assert.ok(route.includes("FINAL_REVALIDATE_OPTION_QUOTES"));
  assert.ok(route.includes("const verified = topThreeSetups"));
  assert.ok(route.includes("underlyingQuoteAgeSeconds"));
});

test("Sureshot FYERS request audit distinguishes upstream, cached and locally blocked requests", () => {
  assert.ok(server.includes("priority = 'normal', stage = null"));
  assert.ok(server.includes("Sureshot FYERS Data API request audit:"));
  assert.ok(server.includes("requestSource = localCooldown ? 'LOCAL_CIRCUIT_BREAKER'"));
  assert.ok(server.includes("cacheState === 'HIT' ? 'CACHE' : 'UPSTREAM'"));
  assert.ok(server.includes("endpoint: new URL(String(url)).pathname"));
  assert.ok(server.includes('loadVerifiedFnoStockQuotes({ priority: "sureshot", stage: scanStage })'));
});


test("MCX automatic scan retries incomplete runs and records completion only after a full backend audit", () => {
  const loaderStart = app.indexOf("async function loadMcxSureshotUniverseShortlist");
  const loaderEnd = app.indexOf("async function loadAdvancedScanner", loaderStart);
  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  const loader = app.slice(loaderStart, loaderEnd);
  assert.match(loader, /let scanComplete = false/);
  assert.match(loader, /scanComplete = response\.ok && payload\.ok === true && payload\.scanComplete === true/);
  assert.match(loader, /return scanComplete/);
  assert.match(loader, /return false/);

  const autoStart = app.indexOf("const startAutomaticMcxTopThreeScan");
  const autoEnd = app.indexOf("sureshotAutoScanTimer = window.setInterval", autoStart);
  assert.ok(autoStart >= 0 && autoEnd > autoStart);
  const automatic = app.slice(autoStart, autoEnd);
  assert.match(automatic, /dhanpulse_mcx_sureshot_scan_complete_day/);
  assert.match(automatic, /dhanpulse_mcx_sureshot_scan_retry_at/);
  assert.match(automatic, /await loadMcxSureshotUniverseShortlist\(\)/);
  assert.match(automatic, /if \(finished === true\)/);
  assert.doesNotMatch(automatic, /dhanpulse_mcx_sureshot_scan_attempt_day/);
});


test("MCX automatic scan starts after full-universe subscription without circularly requiring LIVE", () => {
  const gateStart = app.indexOf("function isMcxMarketSessionOpen()");
  const gateEnd = app.indexOf("function updateSureshotExchangeCards", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gate = app.slice(gateStart, gateEnd);
  assert.match(gate, /mcx\.session === 'SCHEDULED_OPEN'/);
  assert.match(gate, /subscribed === required/);
  assert.doesNotMatch(gate, /mcx\.feed === 'LIVE'/);
  assert.match(gate, /mcx\.feed !== 'DISCONNECTED'/);
});


test("Sureshot reuses cached candidate candles but forces fresh final candle revalidation", async () => {
  const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const helperStart = serverSource.indexOf("async function fyersReadOnlyGet");
  const helperEnd = serverSource.indexOf("app.get('/api/market/chart-quote'", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = serverSource.slice(helperStart, helperEnd);
  assert.match(helper, /bypassCache:\\s*bypassCache/);
  assert.doesNotMatch(helper, /priority === 'sureshot' && historyRequest/);

  const routeStart = serverSource.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const routeEnd = serverSource.indexOf("// Last-known F&O equity quotes", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /VERIFY_MCX_UNDERLYING_CANDLES[\\s\\S]{0,500}fyersReadOnlyGet\\(historyUrl, \\{ priority: "sureshot", stage \\}\\)/);
  assert.match(route, /VERIFY_MCX_OPTION_CANDLES[\\s\\S]{0,500}fyersReadOnlyGet\\(historyUrl, \\{ priority: "sureshot", stage \\}\\)/);
  assert.match(route, /FINAL_REVALIDATE_MCX_UNDERLYING[\\s\\S]{0,220}bypassCache: true/);
  assert.match(route, /FINAL_REVALIDATE_MCX_OPTION_CANDLES[\\s\\S]{0,220}bypassCache: true/);
});
