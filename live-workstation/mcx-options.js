import { getCompletedCandleWindow } from './public/chart-safety.js';

function epochSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number > 1e12 ? number / 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}

export function mcxFutureRoot(symbol) {
  const match = String(symbol || '').toUpperCase().match(/^MCX:(CRUDEOIL|NATURALGAS)\d{2}[A-Z]{3}FUT$/);
  return match ? match[1] : '';
}

export function listMxcOptionContracts(master, futureSymbol, now = Date.now()) {
  const root = mcxFutureRoot(futureSymbol);
  if (!root || !master || typeof master !== 'object' || Array.isArray(master)) return [];
  const pattern = new RegExp('^MCX:' + root + '\\d{2}[A-Z]{3}\\d+(?:\\.\\d+)?(?:CE|PE)$');
  const rows = [];
  for (const [symbol, row] of Object.entries(master)) {
    if (!pattern.test(symbol) || !row || Number(row.tradeStatus) !== 1) continue;
    const side = String(row.optType || '').toUpperCase();
    const strike = Number(row.strikePrice);
    const lotSize = Number(row.minLotSize);
    const tickSize = Number(row.tickSize);
    const expirySeconds = epochSeconds(row.expiryDate);
    if (!['CE', 'PE'].includes(side) || !Number.isFinite(strike) || strike <= 0 ||
        !Number.isInteger(lotSize) || lotSize < 1 || !Number.isFinite(tickSize) || tickSize <= 0 ||
        !expirySeconds || expirySeconds * 1000 <= now) continue;
    rows.push({
      symbol, side, strike, lotSize, tickSize,
      expiry: expirySeconds,
      expiryDate: new Date(expirySeconds * 1000).toISOString().slice(0, 10),
      underlying: root
    });
  }
  if (!rows.length) return [];
  const nearestExpiry = Math.min(...rows.map(row => row.expiry));
  return rows.filter(row => row.expiry === nearestExpiry)
    .sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side) || a.symbol.localeCompare(b.symbol));
}

export function pickMxcOptionCandidates(contracts, underlyingPrice, side, limit = 3) {
  const optionSide = side === 'LONG' ? 'CE' : side === 'SHORT' ? 'PE' : '';
  const price = Number(underlyingPrice);
  if (!optionSide || !Number.isFinite(price) || price <= 0 || !Array.isArray(contracts)) return [];
  return contracts.filter(contract => contract.side === optionSide)
    .map(contract => ({ ...contract, strikeDistance: Math.abs(contract.strike - price) }))
    .sort((a, b) => a.strikeDistance - b.strikeDistance || a.strike - b.strike)
    .slice(0, Math.max(1, Math.min(3, Number(limit) || 3)));
}

export function evaluateMxcUnderlyingBreakout(candles, tick) {
  if (!tick || !Number.isFinite(Number(tick.price)) || Number(tick.price) <= 0) {
    return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Fresh MCX futures tick unavailable' };
  }
  const window = getCompletedCandleWindow(candles, tick.exchangeTime);
  if (!window.fresh) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Latest completed MCX futures candle is stale' };
  if (window.completed.length < 21) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'At least 21 completed 5-minute futures candles are required' };
  if (!window.contiguous) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'MCX futures breakout window has missing 5-minute candles' };
  const prior = window.completed.slice(-21, -1);
  const resistance = Math.max(...prior.map(candle => Number(candle.high)));
  const support = Math.min(...prior.map(candle => Number(candle.low)));
  const lastClosed = window.lastClosed;
  if (Number(lastClosed.close) > resistance && Number(tick.price) >= Number(lastClosed.close)) {
    return { status: 'SETUP_CONFIRMED', side: 'LONG', candleTime: lastClosed.time, entry: lastClosed.close };
  }
  if (Number(lastClosed.close) < support && Number(tick.price) <= Number(lastClosed.close)) {
    return { status: 'SETUP_CONFIRMED', side: 'SHORT', candleTime: lastClosed.time, entry: lastClosed.close };
  }
  return { status: 'NO_TRADE', reason: 'No confirmed 20-candle MCX futures breakout' };
}

export function evaluateMxcOptionBreakout(candles, tick, contract) {
  if (!tick || !Number.isFinite(Number(tick.price)) || Number(tick.price) <= 0) {
    return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Fresh option premium unavailable' };
  }
  const window = getCompletedCandleWindow(candles, tick.exchangeTime);
  if (!window.fresh) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Latest completed option candle is stale' };
  if (window.completed.length < 21) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'At least 21 completed 5-minute option candles are required' };
  if (!window.contiguous) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Option breakout window has missing 5-minute candles' };
  const prior = window.completed.slice(-21, -1);
  const resistance = Math.max(...prior.map(candle => Number(candle.high)));
  const lastClosed = window.lastClosed;
  const premium = Number(tick.price);
  if (!(Number(lastClosed.close) > resistance && premium >= Number(lastClosed.close))) {
    return { status: 'NO_TRADE', reason: 'Option premium has no confirmed 20-candle upside breakout' };
  }
  const swing = window.completed.slice(-5);
  const rawStop = Math.min(...swing.map(candle => Number(candle.low)));
  const tickSize = Number(contract?.tickSize);
  if (!Number.isFinite(tickSize) || tickSize <= 0) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Verified option tick size unavailable' };
  const entry = premium;
  const stopLoss = Math.floor((rawStop + 1e-9) / tickSize) * tickSize;
  const risk = entry - stopLoss;
  if (!Number.isFinite(risk) || risk < tickSize) return { status: 'NO_TRADE', reason: 'Option premium risk is zero or below one tick' };
  const target = Math.ceil((entry + 2 * risk - 1e-9) / tickSize) * tickSize;
  const rr = (target - entry) / risk;
  if (!(entry > stopLoss && target > entry && rr >= 2)) return { status: 'NO_TRADE', reason: 'Minimum 1:2 reward/risk could not be verified' };
  const distancePct = Math.abs(Number(contract.strike) - Number(contract.underlyingPrice)) / Number(contract.underlyingPrice) * 100;
  const breakoutPct = (Number(lastClosed.close) / resistance - 1) * 100;
  const score = breakoutPct - distancePct * 0.05;
  return {
    status: 'SETUP_CONFIRMED',
    symbol: contract.symbol,
    side: contract.side,
    strike: contract.strike,
    expiry: contract.expiryDate,
    lotSize: contract.lotSize,
    tickSize,
    premium,
    entry,
    stopLoss,
    target,
    rr: Number(rr.toFixed(2)),
    score,
    breakoutPct: Number(breakoutPct.toFixed(3)),
    optionCandleTime: lastClosed.time
  };
}
