import test from "node:test";
import assert from "node:assert/strict";
import { shouldStopSureshotScan, getSureshotScanStopReason } from "../src/sureshot-scan-policy.js";

test("continues after one or two verified plans so the scan can return three", () => {
  assert.equal(shouldStopSureshotScan({ verifiedSetupCount: 1, scannedCandidateCount: 2, candidateCount: 5 }), false);
  assert.equal(shouldStopSureshotScan({ verifiedSetupCount: 2, scannedCandidateCount: 4, candidateCount: 5 }), false);
});

test("stops after three verified plans and reports the top-three stop reason", () => {
  assert.equal(shouldStopSureshotScan({ verifiedSetupCount: 3, scannedCandidateCount: 4, candidateCount: 5 }), true);
  assert.equal(getSureshotScanStopReason({ verifiedSetupCount: 3, scannedCandidateCount: 4, candidateCount: 5 }), "THREE_VERIFIED_SETUPS_FOUND");
});

test("checks the full selected candidate set when fewer than three plans verify", () => {
  assert.equal(shouldStopSureshotScan({ verifiedSetupCount: 2, scannedCandidateCount: 5, candidateCount: 5 }), true);
  assert.equal(getSureshotScanStopReason({ verifiedSetupCount: 2, scannedCandidateCount: 5, candidateCount: 5 }), "ALL_CANDIDATES_CHECKED");
});

test("rejects invalid scan progress and incomplete stop-reason requests", () => {
  assert.throws(() => shouldStopSureshotScan({ verifiedSetupCount: -1, scannedCandidateCount: 1, candidateCount: 5 }), /invalid_sureshot_scan_progress/);
  assert.throws(() => getSureshotScanStopReason({ verifiedSetupCount: 1, scannedCandidateCount: 1, candidateCount: 5 }), /sureshot_scan_not_complete/);
});
