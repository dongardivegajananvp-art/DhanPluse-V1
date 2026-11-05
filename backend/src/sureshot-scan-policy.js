export const SURESHOT_TARGET_VERIFIED_SETUPS = 3;

export function shouldStopSureshotScan({ verifiedSetupCount, scannedCandidateCount, candidateCount }) {
  if (![verifiedSetupCount, scannedCandidateCount, candidateCount].every(Number.isInteger) ||
      verifiedSetupCount < 0 || scannedCandidateCount < 0 || candidateCount < 1 ||
      scannedCandidateCount > candidateCount) {
    throw new Error("invalid_sureshot_scan_progress");
  }
  return verifiedSetupCount >= SURESHOT_TARGET_VERIFIED_SETUPS || scannedCandidateCount >= candidateCount;
}

export function getSureshotScanStopReason({ verifiedSetupCount, scannedCandidateCount, candidateCount }) {
  if (verifiedSetupCount >= SURESHOT_TARGET_VERIFIED_SETUPS) return "THREE_VERIFIED_SETUPS_FOUND";
  if (scannedCandidateCount >= candidateCount) return "ALL_CANDIDATES_CHECKED";
  throw new Error("sureshot_scan_not_complete");
}
