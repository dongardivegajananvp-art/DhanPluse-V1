import { buildOptionRiskPlan } from "./option-risk-plan.js";

function epochSeconds(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

function indiaDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

function expiryTime(value) {
  const seconds = epochSeconds(value);
  if (seconds) return seconds * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function deriveVerifiedUnderlyingDirection(candles, resolution = "5", now = Date.now()) {
  const minutes = Number(resolution);
  if (![5, 15, 30, 60].includes(minutes) || !Array.isArray(candles)) {
    return { ok: false, reason: "Unsupported or missing underlying candles." };
  }
  let previous = -Infinity;
  const valid = [];
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 6) {
      return { ok: false, reason: "Underlying candle row is incomplete." };
    }
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) ||
        time <= previous || time <= 0 || Math.min(open, high, low, close) <= 0 ||
        volume < 0 || high < Math.max(open, close, low) ||
        low > Math.min(open, close, high) || time * 1000 > now + 5000) {
      return { ok: false, reason: "Underlying OHLC candles are invalid, future, duplicated or out of order." };
    }
    previous = time;
    if (time * 1000 + minutes * 60_000 <= now) valid.push({ time, open, high, low, close, volume });
  }
  if (valid.length < 13) return { ok: false, reason: "At least 13 completed underlying candles are required." };
  const latest = valid[valid.length - 1];
  const ageMs = now - (latest.time * 1000 + minutes * 60_000);
  if (ageMs < 0 || ageMs > minutes * 60_000 * 3) {
    return { ok: false, reason: "Latest completed underlying candle is stale." };
  }
  const zoneRows = valid.slice(-32, -1);
  if (zoneRows.length < 12) return { ok: false, reason: "Not enough completed candles to calculate supply and demand zones." };
  const supplyHigh = Math.max(...zoneRows.map(row => row.high));
  const supplyBar = zoneRows.find(row => row.high === supplyHigh);
  const supplyLow = Math.max(supplyBar.open, supplyBar.close);
  const demandLow = Math.min(...zoneRows.map(row => row.low));
  const demandBar = zoneRows.find(row => row.low === demandLow);
  const demandHigh = Math.min(demandBar.open, demandBar.close);
  const supply = { low: Math.min(supplyLow, supplyHigh), high: supplyHigh };
  const demand = { low: demandLow, high: Math.max(demandLow, demandHigh) };
  const prior = valid[valid.length - 2];
  let side = null;
  let reason = "Latest completed candle did not confirm a supply or demand breakout.";
  if (latest.close > supply.high && latest.close > prior.close) {
    side = "CE";
    reason = "Latest completed FYERS candle closed above the supply zone and prior close.";
  } else if (latest.close < demand.low && latest.close < prior.close) {
    side = "PE";
    reason = "Latest completed FYERS candle closed below the demand zone and prior close.";
  }
  return {
    ok: true, side, reason, spot: latest.close,
    latestCandleAt: new Date(latest.time * 1000).toISOString(),
    candleAgeSeconds: Number((ageMs / 1000).toFixed(1)),
    completedCandleCount: valid.length, supply, demand
  };
}

export function selectNearestVerifiedOptionContract({
  discovery, underlyingSymbol, side, spot, now = Date.now()
}) {
  if (!discovery || !Array.isArray(discovery.expiryData) ||
      !Array.isArray(discovery.optionsChain) || !["CE", "PE"].includes(side) ||
      !Number.isFinite(Number(spot)) || Number(spot) <= 0) {
    return { ok: false, reason: "Option contract discovery is incomplete." };
  }
  const exchange = String(underlyingSymbol || "").split(":")[0];
  const today = indiaDateKey(now);
  const expiries = discovery.expiryData
    .map(item => ({ ...item, expiry: String(item.expiry), expiryMs: expiryTime(item.expiry) }))
    .filter(item => Number.isFinite(item.expiryMs) && indiaDateKey(item.expiryMs) >= today)
    .sort((a, b) => a.expiryMs - b.expiryMs);
  if (!expiries.length) return { ok: false, reason: "No current or future listed expiry was returned by FYERS." };
  const expiry = expiries[0];
  const eligible = discovery.optionsChain.filter(row =>
    String(row.symbol || "").startsWith(exchange + ":") &&
    row.option_type === side && String(row.expiry) === expiry.expiry &&
    Number.isFinite(Number(row.strike_price)) && Number(row.strike_price) > 0
  );
  if (!eligible.length) return { ok: false, reason: "No matching " + side + " contract exists for the nearest listed expiry on this exchange." };
  eligible.sort((a, b) => Math.abs(Number(a.strike_price) - spot) - Math.abs(Number(b.strike_price) - spot));
  const chosen = eligible[0];
  return {
    ok: true,
    contract: {
      symbol: chosen.symbol,
      strike: Number(chosen.strike_price),
      side,
      expiry: expiry.expiry,
      expiryDate: expiry.date || indiaDateKey(expiry.expiryMs)
    }
  };
}

export function buildVerifiedSureshotTradePlan({
  underlyingSymbol, direction, contract, quote, optionCandles,
  resolution = "5", now = Date.now(), maxSpreadPct = 5
}) {
  if (!direction?.ok || !["CE", "PE"].includes(direction.side) ||
      !underlyingSymbol || !contract?.symbol || !quote || !Array.isArray(optionCandles)) {
    return { ok: false, reason: "Underlying direction, contract, fresh quote and option candles are all required." };
  }
  const underlyingExchange = String(underlyingSymbol).split(":")[0];
  const contractSymbol = String(contract.symbol);
  const contractSide = String(contract.side || "").toUpperCase();
  const contractStrike = Number(contract.strike);
  if (!["NSE", "BSE"].includes(underlyingExchange) ||
      !contractSymbol.startsWith(underlyingExchange + ":") ||
      !/^(?:NSE|BSE):[A-Z0-9&-]{3,48}(CE|PE)$/.test(contractSymbol) ||
      contractSide !== direction.side || !contractSymbol.endsWith(direction.side) ||
      !Number.isFinite(contractStrike) || contractStrike <= 0 ||
      contract.expiry == null || String(contract.expiry).trim() === "") {
    return { ok: false, reason: "Selected option contract identity does not match the underlying exchange, direction, strike or expiry." };
  }
  if (!Number.isFinite(maxSpreadPct) || maxSpreadPct <= 0) {
    return { ok: false, reason: "Maximum option spread threshold is invalid." };
  }
  const quoteTime = epochSeconds(quote.ltt ?? quote.tt ?? quote.exch_feed_time);
  const ageMs = quoteTime ? now - quoteTime * 1000 : Infinity;
  const bid = Number(quote.bid ?? quote.bid_price);
  const ask = Number(quote.ask ?? quote.ask_price);
  const ltp = Number(quote.lp ?? quote.ltp);
  if (![bid, ask, ltp].every(Number.isFinite) || bid <= 0 || ask < bid || ltp <= 0 ||
      !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15_000) {
    return { ok: false, reason: "Option bid/ask/LTP quote is missing, invalid or older than 15 seconds." };
  }
  const spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
  if (!Number.isFinite(spreadPct) || spreadPct > maxSpreadPct) {
    return { ok: false, reason: "Option bid/ask spread exceeds 5%; trade blocked." };
  }
  const risk = buildOptionRiskPlan({
    candles: optionCandles, entryPrice: ask, resolution, now, lookback: 12
  });
  if (!risk.ok || risk.rr < 2) return { ok: false, reason: risk.reason || "Minimum 1:2 risk/reward was not met." };
  return {
    ok: true,
    underlyingSymbol,
    direction: direction.side,
    underlying: {
      spot: direction.spot,
      latestCandleAt: direction.latestCandleAt,
      candleAgeSeconds: direction.candleAgeSeconds,
      completedCandleCount: direction.completedCandleCount
    },
    contract,
    quote: {
      bid, ask, ltp,
      quoteTime: new Date(quoteTime * 1000).toISOString(),
      quoteAgeSeconds: Number((ageMs / 1000).toFixed(1)),
      spreadPct: Number(spreadPct.toFixed(2))
    },
    risk,
    readOnly: true,
    orderPlacement: "disabled"
  };
}
