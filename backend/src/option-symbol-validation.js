/**
 * Validate a concrete FYERS option-contract symbol before requesting its
 * live quote or historical risk candles. NSE and BSE are both supported;
 * the endpoint still verifies the returned exchange timestamp and prices.
 */
export function isSupportedOptionContractSymbol(value) {
  return typeof value === "string" &&
    /^(?:NSE|BSE):[A-Z0-9&-]{3,48}(?:CE|PE)$/.test(value);
}
