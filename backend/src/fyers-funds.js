const amountFor = row => {
  if (!row || typeof row !== 'object') return { equity: null, commodity: null };
  const equity = row.equityAmount === null || row.equityAmount === undefined || row.equityAmount === '' ? NaN : Number(row.equityAmount);
  const commodity = row.commodityAmount === null || row.commodityAmount === undefined || row.commodityAmount === '' ? NaN : Number(row.commodityAmount);
  return {
    equity: Number.isFinite(equity) ? equity : null,
    commodity: Number.isFinite(commodity) ? commodity : null
  };
};

export function normalizeFyersFunds(payload) {
  const rows = Array.isArray(payload?.fund_limit) ? payload.fund_limit : [];
  const byTitle = title => rows.find(row =>
    String(row?.title || '').trim().toLowerCase() === title.toLowerCase()
  ) || null;
  return {
    availableBalance: amountFor(byTitle('Available Balance')),
    utilizedAmount: amountFor(byTitle('Utilized Amount')),
    realizedProfitLoss: amountFor(byTitle('Realized Profit and Loss')),
    totalBalance: amountFor(byTitle('Total Balance'))
  };
}
