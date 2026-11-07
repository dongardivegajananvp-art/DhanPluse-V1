export function isFyersAuthRejected(httpStatus, apiCode) {
  return Number(httpStatus) === 401 || Number(apiCode) === -16;
}

/**
 * Detect an expired persisted FYERS access token from SDK startup errors.
 * This only changes in-memory authentication state; the encrypted DB value is
 * left untouched until the user completes a fresh OAuth exchange.
 */
export function isExpiredFyersAccessTokenError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /(?:expired token|token expired|jwt expired|token has expired)/.test(message);
}
