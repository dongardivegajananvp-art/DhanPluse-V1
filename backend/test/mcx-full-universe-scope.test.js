import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMcxSocketQuoteRows } from "../src/mcx-socket-audit.js";
import { buildVerifiedMcxAudit } from "../src/mcx-sureshot.js";

const now = Date.parse("2026-11-10T12:00:00.000Z");
test("MCX full-universe audit requires all 72 official futures to have fresh exchange timestamps", () => {
  const universe = Array.from({length:72},(_,i)=>({symbol:`MCX:CONTRACT${String(i+1).padStart(2,"0")}26NOVFUT`,underlying:`CONTRACT${String(i+1).padStart(2,"0")}`}));
  const ticks = new Map(universe.map((item,i)=>[item.symbol,{ltp:100+i,chp:i%2?-0.5:0.5,updatedAt:new Date(now-1000).toISOString()}]));
  const complete = buildVerifiedMcxAudit({universe,quoteRows:buildMcxSocketQuoteRows(universe,ticks),now,limit:72,maxAgeMs:30000});
  assert.equal(complete.coverage.requested,72); assert.equal(complete.coverage.received,72); assert.equal(complete.coverage.fresh,72); assert.equal(complete.complete,true); assert.equal(complete.data.length,72);
  ticks.delete(universe[71].symbol);
  const partial = buildVerifiedMcxAudit({universe,quoteRows:buildMcxSocketQuoteRows(universe,ticks),now,limit:72,maxAgeMs:30000});
  assert.equal(partial.complete,false); assert.equal(partial.coverage.fresh,71); assert.equal(partial.coverage.missing,1); assert.equal(partial.data.length,0);
});
test("MCX route rebuilds quote rows outside the settle callback before shortlist ranking", async () => {
  const src = await readFile(new URL("../src/server.js",import.meta.url),"utf8");
  const start=src.indexOf('app.get("/api/market/mcx-sureshot-auto-plans"');
  const end=src.indexOf("// Last-known F&O equity quotes",start);
  const route=src.slice(start,end);
  const guard=route.indexOf("if (!mcxAudit.complete)");
  const ranked=route.indexOf("const ranked = buildVerifiedMcxShortlist");
  const rebuilt=route.lastIndexOf("const quoteRows = buildMcxSocketQuoteRows(universe.data, latestTicks)",ranked);
  assert.ok(guard>=0 && ranked>guard && rebuilt>guard && rebuilt<ranked);
});
