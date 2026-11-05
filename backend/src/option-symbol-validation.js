/**
 * Validate a concrete FYERS option contract ticker. The official exchange
 * symbol master remains the authority for existence, activity and metadata.
 */
export function isSupportedOptionContractSymbol(value) {
  return typeof value === "string" &&
    /^(?:(?:NSE|BSE):[A-Z0-9&-]{3,48}|MCX:[A-Z0-9&.-]{3,48})(?:CE|PE)$/.test(value);
}
