import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendFiles = [
  new URL("../../site/index.html", import.meta.url),
  new URL("../../site/app.js", import.meta.url)
];

test("Dashboard renders independent MCX feed status, contract, LTP and exchange timestamp", async () => {
  for (const file of frontendFiles) {
    const source = await readFile(file, "utf8");
    assert.match(source, /id="dashboardMcxStatus"/);
    assert.match(source, /id="dashboardMcxFeed"/);
    assert.match(source, /id="dashboardMcxSession"/);
    assert.match(source, /id="dashboardMcxSymbol"/);
    assert.match(source, /id="dashboardMcxLtp"/);
    assert.match(source, /id="dashboardMcxTime"/);
    assert.match(source, /id="dashboardMcxDetail"/);
    assert.match(source, /set\('#dashboardMcxFeed', feedLabel\(mcx\)\)/);
    assert.match(source, /\['#dashboardMcxFeed', feedText\]/);
    assert.match(source, /updateMcxConnectionDiagnostics\(status\)/);
  }
});

test("Dashboard MCX LIVE label is driven by backend exchange-timestamp freshness, never by socket connection alone", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /mcxTickAgeSeconds >= 0 && mcxTickAgeSeconds <= MCX_TICK_FRESHNESS_SECONDS \? 'LIVE' : 'STALE'/);
  assert.match(server, /mcxSubscribedSocket !== marketSocket \? 'SUBSCRIPTION_PENDING'/);
  assert.match(server, /exchangeTimestamp: tick\?\.updatedAt \|\| null/);
  assert.match(server, /signalsAllowed: false/);
});
