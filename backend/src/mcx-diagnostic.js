function toExpiryMillis(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pick one currently active MCX future from FYERS' official symbol master.
 * Prefer the nearest-expiry CRUDEOIL contract; use GOLD only as a fallback.
 * Never construct a ticker or accept an inactive contract row.
 */
export function selectMcxDiagnosticInstrument(master, nowMs = Date.now()) {
  if (!master || typeof master !== 'object' || Array.isArray(master)) return null;
  const candidates = Object.entries(master)
    .filter(([symbol, item]) =>
      /^MCX:[A-Z0-9]+\d{2}[A-Z]{3}FUT$/.test(symbol) &&
      Number(item?.tradeStatus) === 1 &&
      ['CRUDEOIL', 'GOLD'].some(name => symbol.startsWith('MCX:' + name))
    )
    .map(([symbol, item]) => {
      const expiryMs = toExpiryMillis(item?.expiryDate);
      if (!expiryMs || expiryMs <= nowMs) return null;
      const commodity = symbol.startsWith('MCX:CRUDEOIL') ? 'CRUDEOIL' : 'GOLD';
      return {
        symbol,
        label: String(item?.symDetails || item?.exSymbol || commodity).trim().slice(0, 100),
        expiryDate: new Date(expiryMs).toISOString().slice(0, 10),
        expiryMs,
        commodity
      };
    })
    .filter(Boolean);
  const crudeOil = candidates.filter(item => item.commodity === 'CRUDEOIL');
  const preferred = crudeOil.length ? crudeOil : candidates.filter(item => item.commodity === 'GOLD');
  preferred.sort((a, b) => a.expiryMs - b.expiryMs || a.symbol.localeCompare(b.symbol));
  if (!preferred.length) return null;
  const { symbol, label, expiryDate } = preferred[0];
  return { symbol, label, expiryDate };
}
