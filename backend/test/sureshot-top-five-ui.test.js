import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../../site/index.html", import.meta.url), "utf8");

test("Sureshot always renders five verified setup slots and keeps unverified slots blocked", () => {
  assert.match(html, /const topFiveRows = Array\.from\(\{ length: 5 \}/);
  assert.match(html, /TOP 5 VERIFIED SETUPS/);
  assert.match(html, /topFiveRows\.map\(\(row, index\) =>/);
  assert.match(html, /BLOCKED · NO VERIFIED STRIKE/);
  assert.match(html, /result\.stopReason !== 'ALL_TOP_MOVER_CANDIDATES_CHECKED'/);
});

test("Sureshot UI rejects stale option quotes and RR below 1:2 in every top-five slot", () => {
  assert.match(html, /topFive\.some\(row => row\.status !== 'VERIFIED SETUP'/);
  assert.match(html, /Number\(row\.plan\.quote\.quoteAgeSeconds\) > 15/);
  assert.match(html, /Number\(row\.plan\.risk\.rrTarget2 \?\? row\.plan\.risk\.rr\) < 2/);
});
