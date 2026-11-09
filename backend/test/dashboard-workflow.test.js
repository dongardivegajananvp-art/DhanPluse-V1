import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const htmlUrl = new URL("../../site/index.html", import.meta.url);

test("served Dashboard makes one explicit chart request and honors Retry-After without automatic retry", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const chartStart = html.indexOf("async function loadDashboardCandles()");
  const chartEnd = html.indexOf("\nfunction quoteCardsMarkup", chartStart);
  assert.ok(chartStart >= 0 && chartEnd > chartStart);
  const chart = html.slice(chartStart, chartEnd);
  assert.match(chart, /dashboardCandleCooldownUntil/);
  assert.match(chart, /response\.headers\.get\('Retry-After'\)/);
  assert.match(chart, /result\.retryAfterSeconds/);
  assert.match(chart, /Automatic retry disabled/);
  assert.doesNotMatch(html, /if\s*\(\s*currentTab\s*===\s*['"]Dashboard['"]\s*\)\s*loadDashboardCandles\s*\(/);
  assert.match(html, /loadDashboardCandles\);/);
});

test("Sureshot always renders five non-fabricated strike slots and adds Paper BUY only for server-verified plans", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /Five strike slots remain visible/);
  assert.match(html, /NO VERIFIED STRIKE/);
  assert.match(html, /gvPaperBuyRow/);
  assert.match(html, /row\.paperPlanId/);
  assert.match(html, /BLOCKED/);
  assert.match(html, /TOP_FIVE_CANDIDATES_CHECKED/);
});

test("Paper BUY opens Position only after the server accepts a paper ledger write; no broker order route is called", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const start = html.indexOf("async function submitPaperBuy");
  const end = html.indexOf("\nasync function loadPaperLedger", start);
  assert.ok(start >= 0 && end > start);
  const buy = html.slice(start, end);
  assert.match(buy, /window\.open\('about:blank', '_blank'\)/);
  assert.doesNotMatch(buy, /window\.confirm/);
  assert.match(buy, /\/api\/paper\/buy/);
  assert.match(buy, /searchParams\.set\('tab', 'Position'\)/);
  assert.doesNotMatch(buy, /\/api\/orders\//);
  assert.match(html, /initialTab === 'Position' \? 'Position' : 'Home'/);
  assert.match(html, /Manual Exit/);
  assert.match(html, /\.gvPaperExit/);
});

test("Paper ledger and broker order placement remain explicitly separate and read-only", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const paperStore = await readFile(new URL("../src/paper-trading-store.js", import.meta.url), "utf8");
  assert.match(server, /orderPlacementEnabled:\s*false/);
  assert.match(server, /\/api\/orders\//);
  assert.match(server, /403/);
  assert.match(server, /target2/);
  assert.match(paperStore, /stop_loss/);
  assert.match(paperStore, /SELECT \\* FROM gv2vpd_paper_positions ORDER BY created_at DESC/);
});

test("Sureshot scan retains its server cursor across HTTP 429 and waits for provider cooldown", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /const SURESHOT_SCAN_TTL_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(server, /const resumableScan = status === 429 && Boolean\(sureshotScanState && sureshotScanState\.id\)/);
  assert.match(server, /scanPaused: resumableScan/);
  assert.match(server, /retryAfterSeconds: retryAfterSeconds \|\| null/);
  assert.match(server, /resumableScan \? sureshotScanState\.nextOffset : null/);
});
