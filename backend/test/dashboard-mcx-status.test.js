import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../../site/app.js", import.meta.url);

test("Dashboard renders independent MCX feed status, contract, LTP and exchange timestamp", async () => {
  const source = await readFile(appUrl, "utf8");
  for (const id of ["dashboardMcxStatus", "dashboardMcxFeed", "dashboardMcxSession", "dashboardMcxSymbol",
    "dashboardMcxLtp", "dashboardMcxTime", "dashboardMcxDetail"]) {
    assert.ok(source.includes(id), "Missing MCX dashboard element: " + id);
  }
  assert.match(source, /set\('#dashboardMcxFeed', feedLabel\(mcx\)\)/);
  assert.match(source, /\['#dashboardMcxFeed', feedText\]/);
  assert.match(source, /updateMcxConnectionDiagnostics\(status\)/);
});

test("Dashboard MCX LIVE label is driven by backend exchange-timestamp freshness, never by socket connection alone", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /mcxSocketAudit\?\.complete \? 'LIVE'/);
  assert.match(server, /mcxUniverseSubscribedSocket !== marketSocket \? 'SUBSCRIPTION_PENDING'/);
  assert.match(server, /exchangeTimestamp: tick\?\.updatedAt \|\| null/);
  assert.match(server, /freshTickCount: mcxFreshTickCount, requiredTickCount: mcxRequiredTickCount/);
  assert.match(server, /buildMcxSocketQuoteRows/);
  assert.match(server, /signalsAllowed: false/);
});
