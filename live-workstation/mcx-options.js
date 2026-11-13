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


// B strategy: EMA20/EMA50 trend-pullback on completed FYERS 5-minute candles.
// When contract metadata is supplied, this evaluates a long option premium setup
// and aligns SL/target to the exchange tick size using the fresh option premium.
export function evaluateMxcTrendPullback(candles, tick, contract = null) {
  if (!tick || !Number.isFinite(Number(tick.price)) || Number(tick.price) <= 0) {
    return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Fresh FYERS exchange tick unavailable' };
  }
  const window = getCompletedCandleWindow(candles, tick.exchangeTime);
  if (!window.fresh) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Latest completed 5-minute candle is stale' };
  if (window.completed.length < 51) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'At least 51 completed candles are required for EMA50' };
  const recent = window.completed.slice(-51);
  if (!recent.every((candle, index) => index === 0 || Number(candle.time) - Number(recent[index - 1].time) === 300)) {
    return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'EMA trend-pullback window has missing 5-minute candles' };
  }
  const closes = recent.map(candle => Number(candle.close));
  const ema = (values, period) => {
    if (values.length < period) return NaN;
    // Seed each EMA with the period SMA, then apply the standard EMA recurrence.
    // This avoids initializing EMA50 from a single first candle.
    let value = values.slice(0, period).reduce((sum, close) => sum + close, 0) / period;
    const alpha = 2 / (period + 1);
    for (let index = period; index < values.length; index++) value = values[index] * alpha + value * (1 - alpha);
    return value;
  };
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const prior = recent[recent.length - 2];
  const last = recent[recent.length - 1];
  const ranges = recent.slice(-15).map((candle, index, rows) => {
    const previousClose = index ? Number(rows[index - 1].close) : Number(recent[recent.length - 16].close);
    return Math.max(Number(candle.high) - Number(candle.low), Math.abs(Number(candle.high) - previousClose), Math.abs(Number(candle.low) - previousClose));
  });
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const tolerance = atr * 0.25;
  const pullbackTouched = Number(prior.low) <= ema20 + tolerance && Number(prior.high) >= ema20 - tolerance;
  const livePrice = Number(tick.price);
  let direction = '';
  if (ema20 > ema50 && pullbackTouched && Number(last.close) > Number(last.open) &&
      Number(last.close) > Number(prior.high) && Number(last.close) > ema20 && livePrice >= Number(last.close)) direction = 'LONG';
  if (ema20 < ema50 && pullbackTouched && Number(last.close) < Number(last.open) &&
      Number(last.close) < Number(prior.low) && Number(last.close) < ema20 && livePrice <= Number(last.close)) direction = 'SHORT';
  if (!direction) return { status: 'NO_TRADE', reason: 'No confirmed EMA20/EMA50 trend-pullback reclaim' };

  const swing = recent.slice(-5);
  let stopLoss = direction === 'LONG'
    ? Math.min(...swing.map(candle => Number(candle.low)))
    : Math.max(...swing.map(candle => Number(candle.high)));
  let entry = Number(last.close);
  let target;
  let rr;
  if (contract) {
    // Long CE/PE premium only. A falling premium is not a BUY setup.
    if (direction !== 'LONG') return { status: 'NO_TRADE', reason: 'Option premium is not in a bullish reclaim for a BUY setup' };
    const tickSize = Number(contract.tickSize);
    if (!Number.isFinite(tickSize) || tickSize <= 0) return { status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Verified option tick size unavailable' };
    entry = livePrice;
    stopLoss = Math.floor((stopLoss + 1e-9) / tickSize) * tickSize;
    const risk = entry - stopLoss;
    if (!(risk >= tickSize)) return { status: 'NO_TRADE', reason: 'Option premium risk is below one exchange tick' };
    target = Math.ceil((entry + 2 * risk - 1e-9) / tickSize) * tickSize;
    rr = (target - entry) / risk;
  } else {
    const risk = direction === 'LONG' ? entry - stopLoss : stopLoss - entry;
    if (!(risk > 0)) return { status: 'NO_TRADE', reason: 'Underlying swing risk is zero or invalid' };
    target = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
    rr = 2;
  }
  if (!(entry > 0 && stopLoss > 0 && target > 0 && rr >= 2)) {
    return { status: 'NO_TRADE', reason: 'Tick-aligned minimum 1:2 risk/reward could not be verified' };
  }
  return {
    status: 'SETUP_CONFIRMED',
    strategy: 'B_EMA20_EMA50_TREND_PULLBACK',
    side: direction,
    entry,
    stopLoss,
    target,
    rr: Number(rr.toFixed(2)),
    ema20: Number(ema20.toFixed(4)),
    ema50: Number(ema50.toFixed(4)),
    atr: Number(atr.toFixed(4)),
    candleTime: last.time
  };
}
