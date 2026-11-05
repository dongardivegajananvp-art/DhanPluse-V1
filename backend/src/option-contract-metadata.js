/**
 * Resolve sizing for this exact option ticker from its exchange-specific FYERS
 * derivative master. Never infer lot size or tick size from another contract.
 */
export function getVerifiedOptionContractMetadata(symbol, foMaster) {
  if (typeof symbol !== "string" ||
      !/^(?:NSE|BSE|MCX):[A-Z0-9&.-]+(?:CE|PE)$/.test(symbol) ||
      !foMaster || typeof foMaster !== "object" || Array.isArray(foMaster)) return null;
  const item = foMaster[symbol];
  if (!item || Number(item.tradeStatus) !== 1 || !["CE", "PE"].includes(String(item.optType || "").toUpperCase())) return null;
  const lotSize = Number(symbol.startsWith("MCX:") ? item.qtyMultiplier : item.minLotSize);
  const tickSize = Number(item.tickSize);
  const strike = Number(item.strikePrice);
  const expiryDate = String(item.expiryDate ?? "").trim();
  const expiryNumber = Number(expiryDate);
  const expiryMs = Number.isFinite(expiryNumber) && expiryNumber > 0
    ? (expiryNumber > 1e12 ? expiryNumber : expiryNumber * 1000)
    : Date.parse(expiryDate);
  if (!Number.isInteger(lotSize) || lotSize <= 0 ||
      !Number.isFinite(tickSize) || tickSize <= 0 ||
      !Number.isFinite(strike) || strike <= 0 ||
      !Number.isFinite(expiryMs) || expiryMs <= 0) return null;
  return { symbol, side: String(item.optType).toUpperCase(), strike, expiryDate, lotSize, tickSize };
}
