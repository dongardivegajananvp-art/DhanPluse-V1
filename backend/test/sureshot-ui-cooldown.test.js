import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../../site/app.js", import.meta.url), "utf8");
const start = app.indexOf("async function loadSureshotUniverseShortlist");
const end = app.indexOf("function bindSureshotPaperPlanButtons", start);
const scan = app.slice(start, end);

test("manual NSE Sureshot scans respect the persisted FYERS cooldown", () => {
  assert.ok(start >= 0 && end > start, "NSE Sureshot scan handler exists");
  assert.match(scan, /if \(!automatic\)[\s\S]*localStorage\.getItem\(SURESHOT_AUTO_SCAN_RETRY_KEY\)/);
  assert.match(scan, /FYERS rate-limit cooldown active · no request sent/);
});

test("manual HTTP 429 failures persist the same cooldown used by automatic scans", () => {
  assert.match(scan, /Number\(error\.statusCode\) === 429 \|\| \(automatic && Number\(error\.statusCode\) !== 401\)/);
  assert.match(scan, /localStorage\.setItem\(SURESHOT_AUTO_SCAN_RETRY_KEY, String\(Date\.now\(\) \+ delayMs\)\)/);
});
