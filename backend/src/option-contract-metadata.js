/**
 * Resolve sizing for this exact option ticker from its exchange-specific FYERS
 * derivative master. Different underlyings/contracts may have different lot sizes.
 * Never infer lot size or tick size from the underlying or another contract.
 */
export function getVerifiedOptionContractMetadata(symbol, foMaster) {
  if (typeof symbol !== "string" || !/^(?:NSE|BSE):[A-Z0-9&-]+(?:CE|PE)$/.test(symbol) ||
      !foMaster || typeof foMaster !== "object" || Array.isArray(foMaster)) return null;
  const item = foMaster[symbol];
  if (!item || Number(item.tradeStatus) !== 1 || !["CE", "PE"].includes(item.optType)) return null;
  const lotSize = Number(item.minLotSize);
  const tickSize = Number(item.tickSize);
  const strike = Number(item.strikePrice);
  const expiryDate = String(item.expiryDate ?? "").trim();
  if (!Number.isInteger(lotSize) || lotSize <= 0 ||
      !Number.isFinite(tickSize) || tickSize <= 0 ||
      !Number.isFinite(strike) || strike <= 0 || !expiryDate) return null;
  return { symbol, side: item.optType, strike, expiryDate, lotSize, tickSize };
}
