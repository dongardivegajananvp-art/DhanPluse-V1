const CONTRACT_SYMBOL = /^(?:NSE|BSE):[A-Z0-9&-]{3,48}(CE|PE)$/;

export function normalizeOptionContractDiscovery(payload) {
  if (!payload || typeof payload !== "object" ||
      !Array.isArray(payload.optionsChain) || payload.optionsChain.length === 0) {
    throw new Error("option_contract_list_missing");
  }

  const expiryData = (Array.isArray(payload.expiryData) ? payload.expiryData : [])
    .map((item) => {
      if (!item || item.expiry == null) return null;
      return {
        expiry: String(item.expiry),
        ...(item.date ? { date: String(item.date) } : {}),
        ...(item.expiry_flag ? { expiry_flag: String(item.expiry_flag) } : {})
      };
    })
    .filter(Boolean);

  const defaultExpiry = expiryData[0]?.expiry ?? payload.expiry ?? null;
  const optionsChain = payload.optionsChain.map((row) => {
    if (!row || !CONTRACT_SYMBOL.test(String(row.symbol || ""))) return null;
    const rawType = String(row.option_type || "").toUpperCase();
    const optionType = rawType === "CALL" ? "CE" : rawType === "PUT" ? "PE" : rawType;
    const strike = Number(row.strike_price);
    const expiry = row.expiry ?? row.expiry_date ?? row.expiryDate ?? defaultExpiry;
    if (!["CE", "PE"].includes(optionType) || !Number.isFinite(strike) ||
        strike <= 0 || expiry == null || String(expiry).trim() === "") return null;
    return {
      symbol: String(row.symbol),
      strike_price: strike,
      option_type: optionType,
      expiry: String(expiry)
    };
  }).filter(Boolean);

  if (optionsChain.length === 0) throw new Error("no_valid_option_contract_descriptors");
  // Deliberately omit LTP, bid/ask, OI and volume: FYERS does not document
  // an exchange timestamp for this chain response, so those values cannot
  // be used for liquidity ranking or signal generation.
  return { expiryData, optionsChain };
}
