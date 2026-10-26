const parseAmount = value => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.replace(/[₹,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

export function normalizeInstitutionalFlow(payload, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error("official_flow_payload_empty_or_invalid");
  const rows = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") throw new Error("official_flow_row_invalid");
    const category = String(raw.category ?? raw.Category ?? "").trim().toUpperCase();
    const normalizedCategory = /^(DII|DOMESTIC INSTITUTIONAL INVESTORS?)$/.test(category)
      ? "DII"
      : /^(FII(?:\/FPI)?|FPI|FOREIGN INSTITUTIONAL INVESTORS?|FOREIGN PORTFOLIO INVESTORS?)$/.test(category)
        ? "FII/FPI" : null;
    if (!normalizedCategory) continue;
    const date = String(raw.date ?? raw.Date ?? raw.tradingDate ?? "").trim();
    const buyValue = parseAmount(raw.buyValue ?? raw.buy_value ?? raw.BuyValue ?? raw.buy);
    const sellValue = parseAmount(raw.sellValue ?? raw.sell_value ?? raw.SellValue ?? raw.sell);
    const netValue = parseAmount(raw.netValue ?? raw.net_value ?? raw.NetValue ?? raw.net);
    if (!date || buyValue === null || sellValue === null || netValue === null) throw new Error("official_flow_numeric_fields_invalid");
    if (Math.abs((buyValue - sellValue) - netValue) > 0.11) throw new Error("official_flow_net_value_mismatch");
    rows.push({ category: normalizedCategory, date, buyValue, sellValue, netValue });
  }
  const categories = new Set(rows.map(row => row.category));
  if (categories.size !== 2 || !categories.has("DII") || !categories.has("FII/FPI")) {
    throw new Error("official_flow_missing_required_categories");
  }
  const dates = new Set(rows.map(row => row.date));
  if (dates.size !== 1) throw new Error("official_flow_date_mismatch");
  rows.sort((a, b) => a.category.localeCompare(b.category));
  return {
    ok: true,
    source: "NSE India official FII/FPI & DII trading activity",
    sourceUrl: "https://www.nseindia.com/reports/fii-dii",
    sourceDate: rows[0].date,
    fetchedAt,
    provisional: true,
    segment: "Capital Market",
    unit: "₹ crore",
    rows,
    signalsAllowed: false,
    warning: "NSE figures are provisional and may be revised. Institutional flow is context only, not a standalone trade signal."
  };
}
