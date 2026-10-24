import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { fyersDataSocket } = require("fyers-api-v3");
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { analyzeOpeningGap, summarizeHistoricalGaps } from "./gap-analysis.js";
import { getNseSessionWindow } from "./market-data.js";
import { buildFnoEquityUniverse } from "./fno-universe.js";
import { normalizeInstitutionalFlow } from "./institutional-flow.js";
import { createFyersDataApiBudget } from "./fyers-data-api-budget.js";

const fetchWithFyersBudget = createFyersDataApiBudget();

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

const appId = process.env.FYERS_APP_ID || "";
const appSecret = process.env.FYERS_APP_SECRET || "";
const redirectUri = process.env.FYERS_REDIRECT_URI || "";
const allowedSymbols = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"];
let marketSocket = null;
let streamConnected = false;
let streamError = "";
const latestTicks = new Map();
const acceptedTickCounts = new Map();
const lastControlDiagnosticAt = new Map();
const diagnostics = [];
function recordDiagnostic(level, event, detail = {}) {
  diagnostics.push({ timestamp: new Date().toISOString(), level, event, ...detail });
  if (diagnostics.length > 200) diagnostics.splice(0, diagnostics.length - 200);
}
const liveCandleIntervals = [1, 5, 15, 30, 60];
const liveCandles = new Map();
function recordLiveCandles(symbol, ltp, exchangeTime) {
  const stampMs = exchangeTime * 1000;
  for (const minutes of liveCandleIntervals) {
    const bucketMs = Math.floor(stampMs / (minutes * 60000)) * minutes * 60000;
    const key = symbol + "|" + minutes;
    let rows = liveCandles.get(key) || [];
    let candle = rows.find(row => row.bucketMs === bucketMs);
    if (!candle) {
      candle = { bucketMs, timestamp: new Date(bucketMs).toISOString(), open: ltp, high: ltp, low: ltp, close: ltp, source: "FYERS websocket ticks", verified: true };
      rows.push(candle);
      rows.sort((a, b) => a.bucketMs - b.bucketMs);
      if (rows.length > 300) rows = rows.slice(-300);
      liveCandles.set(key, rows);
    } else {
      candle.high = Math.max(candle.high, ltp);
      candle.low = Math.min(candle.low, ltp);
      candle.close = ltp;
    }
  }
}

const allowedOrigins = new Set((process.env.ALLOWED_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean));
// Explicitly permit the isolated test UI; production origins remain controlled by ALLOWED_ORIGIN.
allowedOrigins.add("https://dhanpulse-clean-test-ui.onrender.com");
// Permit the isolated Ultimate UI test deployment to call this test backend.
allowedOrigins.add("https://dhanpulse-ultimate-session-test-ui.onrender.com");
// Allow only the current DhanPulse PR #40 test preview to use this test backend.
allowedOrigins.add("https://deploy-preview-40--spectacular-gaufre-b5c029.netlify.app");
if (redirectUri) { try { allowedOrigins.add(new URL(redirectUri).origin); } catch {} }
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.has(origin)) return callback(null, true);
  return callback(new Error("origin_not_allowed"));
}}));

const startedAt = Date.now();
let tickDiagnosticCounter = 0;
let accessToken = "";
let authenticatedAt = null;
const pendingAuthStates = new Map();
const dashboardSessions = new Map();
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const rateLimits = new Map();

function epochSeconds(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

function parseTick(raw) {
  let parsed = raw;
  if (typeof raw === "string") { try { parsed = JSON.parse(raw); } catch { return; } }
  // SDK versions can deliver one index tick, a list, or a small wrapper around the tick.
  const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
  const messages = [];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) { queue.push(...item); continue; }
    // Only unwrap common data containers; keep the original object as a candidate too.
    for (const key of ["data", "d", "values"]) {
      if (item[key] && typeof item[key] === "object") queue.push(item[key]);
    }
    messages.push(item);
  }
  for (const item of messages) {
    const value = item.v && typeof item.v === "object" ? item.v : {};
    const symbol = item.symbol || item.n || value.symbol || value.n;
    if (!allowedSymbols.includes(symbol)) continue;
    const rawLtp = item.ltp ?? item.lp ?? value.ltp ?? value.lp;
    const ltp = Number(rawLtp);
    if (rawLtp == null || !Number.isFinite(ltp) || ltp <= 0) {
      console.warn("FYERS index update ignored: invalid LTP.", JSON.stringify({ symbol, hasLtp: rawLtp != null }));
      continue;
    }
    const rawExchangeTime = item.exch_feed_time ?? item.last_traded_time ?? item.ltt ?? item.tt ??
      item.timestamp ?? item.ts ?? item.time ?? value.exch_feed_time ?? value.last_traded_time ??
      value.ltt ?? value.tt ?? value.timestamp ?? value.ts ?? value.time;
    const exchangeTime = epochSeconds(rawExchangeTime);
    if (!exchangeTime) {
      console.warn("FYERS index update ignored: missing exchange timestamp.", JSON.stringify({
        symbol, timestampKeys: Object.keys(item).filter(k => /time|timestamp|^tt$|^ts$/i.test(k)).slice(0, 10)
      }));
      continue;
    }
    const tickTime = new Date(exchangeTime * 1000).toISOString();
    const ageMs = Date.now() - Date.parse(tickTime);
    if (!Number.isFinite(ageMs) || ageMs < -30000 || ageMs > 120000) {
      console.warn("FYERS index update ignored: exchange timestamp outside freshness window.", JSON.stringify({ symbol, ageMs }));
      continue;
    }
    const rawCh = item.ch ?? value.ch;
    const rawChp = item.chp ?? value.chp;
    latestTicks.set(symbol, {
      symbol, ltp,
      ch: rawCh != null && Number.isFinite(Number(rawCh)) ? Number(rawCh) : null,
      chp: rawChp != null && Number.isFinite(Number(rawChp)) ? Number(rawChp) : null,
      updatedAt: tickTime
    });
    const acceptedCount = (acceptedTickCounts.get(symbol) || 0) + 1;
    acceptedTickCounts.set(symbol, acceptedCount);
    if (acceptedCount === 1 || acceptedCount % 50 === 0) {
      const acceptedEvent = { symbol, acceptedCount, exchangeTime: tickTime };
      recordDiagnostic("info", "fresh_tick_accepted", acceptedEvent);
      console.log("FYERS fresh tick accepted:", JSON.stringify(acceptedEvent));
    }
    recordLiveCandles(symbol, ltp, exchangeTime);
  }
}

function startMarketDataStream(token) {
  streamError = "";
  streamConnected = false;
  latestTicks.clear();
  try {
    if (marketSocket) { try { marketSocket.close(); } catch {} marketSocket = null; }
    const socket = fyersDataSocket.getInstance(`${appId}:${token}`, "", false);
    marketSocket = socket;
    socket.on("connect", () => {
      if (marketSocket !== socket) return;
      streamConnected = true;
      streamError = "";
      console.log("FYERS market socket connected; subscribing to configured index symbols.");
      recordDiagnostic("info", "socket_connected", { symbols: allowedSymbols });
      try {
        socket.mode(socket.FullMode);
        socket.subscribe(allowedSymbols);
        console.log("FYERS market socket subscription request sent.");
        recordDiagnostic("info", "subscription_requested", { symbols: allowedSymbols });
      } catch (error) {
        streamError = "Could not subscribe to FYERS index symbols.";
        console.error("FYERS market socket subscription failed:", String(error?.message || error).slice(0, 200));
      }
    });
    socket.on("message", message => {
      if (marketSocket !== socket) return;
      const parsed = typeof message === "string"
        ? (() => { try { return JSON.parse(message); } catch { return null; } })()
        : message;
      const frames = Array.isArray(parsed) ? parsed : [parsed];
      const now = Date.now();
      const controls = frames.filter(x => x && typeof x === "object" && (x.type || x.s || x.code != null))
        .filter(x => {
          const key = String(x.type || x.code || x.s);
          const last = lastControlDiagnosticAt.get(key) || 0;
          if (now - last < 15000) return false;
          lastControlDiagnosticAt.set(key, now);
          return true;
        })
        .slice(0, 3)
        .map(x => ({
          type: typeof x.type === "string" ? x.type.slice(0, 24) : null,
          status: typeof x.s === "string" ? x.s.slice(0, 16) : null,
          code: x.code == null ? null : String(x.code).slice(0, 24),
          message: typeof x.message === "string" ? x.message.replace(/\\s+/g, " ").slice(0, 120) : null
        }));
      if (controls.length) console.log("FYERS socket control frame:", JSON.stringify(controls));
      parseTick(parsed);
      // Sample raw timestamp metadata to diagnose SDK payload shape without logging credentials or full payloads.
      tickDiagnosticCounter += 1;
      if (tickDiagnosticCounter % 20 === 1) {
        const queue = Array.isArray(message) ? [...message] : [message];
        const samples = [];
        while (queue.length && samples.length < 4) {
          const item = queue.shift();
          if (!item || typeof item !== "object") continue;
          if (Array.isArray(item)) { queue.push(...item); continue; }
          for (const key of ["data", "d", "values"]) if (item[key] && typeof item[key] === "object") queue.push(item[key]);
          const v = item.v && typeof item.v === "object" ? item.v : {};
          const symbol = item.symbol || item.n || v.symbol || v.n;
          if (!allowedSymbols.includes(symbol)) continue;
          const timeKeys = ["exch_feed_time", "last_traded_time", "ltt", "tt", "timestamp", "ts", "time"];
          const timestamps = {};
          for (const key of timeKeys) {
            if (item[key] != null) timestamps[key] = String(item[key]).slice(0, 40);
            else if (v[key] != null) timestamps["v." + key] = String(v[key]).slice(0, 40);
          }
          samples.push({ symbol, hasLtp: (item.ltp ?? item.lp ?? v.ltp ?? v.lp) != null, timestamps });
        }
        if (samples.length) console.log("FYERS tick timestamp diagnostic sample:", JSON.stringify(samples));
      }
    });
    socket.on("error", error => {
      if (marketSocket !== socket) return;
      streamError = "FYERS market data socket reported an error.";
      recordDiagnostic("error", "socket_error", { message: String(error?.message || error).slice(0, 160) });
      console.error("FYERS market socket error:", String(error?.message || error).slice(0, 200));
    });
    socket.on("close", (code, reason) => {
      if (marketSocket !== socket) return;
      streamConnected = false;
      recordDiagnostic("warn", "socket_closed", { code: code ?? null, reason: reason == null ? null : String(reason).slice(0, 120) });
      console.warn("FYERS market socket closed:", JSON.stringify({ code: code ?? null, reason: reason == null ? null : String(reason).slice(0, 120) }));
    });
    socket.connect();
    if (typeof socket.autoreconnect === "function") socket.autoreconnect(10);
  } catch (error) {
    streamConnected = false;
    streamError = "Could not start the FYERS market data socket.";
    console.error("FYERS market socket startup failed:", String(error?.message || error).slice(0, 200));
  }
}

function liveSnapshot() {
  const ticks = allowedSymbols.map(symbol => latestTicks.get(symbol));
  if (ticks.some(tick => !tick)) return null;
  const ages = ticks.map(tick => Date.now() - Date.parse(tick.updatedAt));
  if (ages.some(age => !Number.isFinite(age) || age < -30000 || age > 120000)) return null;
  return {
    ok: true,
    fetchedAt: new Date(Math.min(...ticks.map(tick => Date.parse(tick.updatedAt)))).toISOString(),
    data: ticks.map(tick => ({ n: tick.symbol, verified: true, v: {
      lp: tick.ltp, tt: epochSeconds(tick.updatedAt),
      ...(tick.ch === null ? {} : { ch: tick.ch }),
      ...(tick.chp === null ? {} : { chp: tick.chp })
    }}))
  };
}

app.get("/", (_req, res) => res.json({ service: "DhanPulse clean backend", version: "0.2.0", status: "online", endpoints: ["/health", "/api/status", "/api/diagnostics", "/api/fyers/auth/start", "/api/fyers/auth/exchange", "/api/fyers/holdings", "/api/fyers/positions", "/api/fyers/option-quote", "/api/fyers/options-chain", "/api/market/quotes", "/api/market/last-known-quotes", "/api/market/fno-universe", "/api/market/stock-quotes", "/api/market/movers", "/api/market/institutional-flow", "/api/market/live-candles", "/api/market/candles", "/api/gap-analysis/history"], orderPlacement: "disabled" }));
app.get("/health", (_req, res) => {
  const snapshot = liveSnapshot();
  res.set("Cache-Control", "no-store").json({
    backend: "online", uptimeSeconds: Math.floor((Date.now()-startedAt)/1000),
    marketSession: getNseSessionWindow(),
    fyersConfigured: Boolean(appId && appSecret && redirectUri),
    liveDataConnected: Boolean(streamConnected && snapshot),
    marketSocketConnected: streamConnected, lastTickAt: snapshot?.fetchedAt || null,
    acceptedTickCounts: Object.fromEntries(acceptedTickCounts),
    lastAcceptedTickAtBySymbol: Object.fromEntries([...latestTicks.entries()].map(([symbol, tick]) => [symbol, tick.updatedAt])),
    orderPlacement: "disabled"
  });
});
app.get("/api/diagnostics", requireSession, (_req, res) => {
  res.set("Cache-Control", "no-store").json({
    ok: true, source: "DhanPulse backend diagnostics", fetchedAt: new Date().toISOString(),
    entries: diagnostics.slice(-100).reverse(),
    orderPlacement: "disabled"
  });
});

app.get("/api/status", (_req, res) => res.set("Cache-Control", "no-store").json({
  backend: "online",
  marketSession: getNseSessionWindow(),
  fyersConfigured: Boolean(appId && appSecret && redirectUri),
  fyers: accessToken ? "connected" : "not-connected",
  authenticatedAt,
  liveData: streamConnected && liveSnapshot() ? "streaming" : "waiting-for-live-ticks",
  marketSocketConnected: streamConnected,
  lastTickAt: liveSnapshot()?.fetchedAt || null,
  acceptedTickCounts: Object.fromEntries(acceptedTickCounts),
  lastAcceptedTickAtBySymbol: Object.fromEntries([...latestTicks.entries()].map(([symbol, tick]) => [symbol, tick.updatedAt])),
  ...(streamError ? { marketDataMessage: streamError } : {}),
  orderPlacement: "disabled",
  note: "Live feed is reported only when both configured indices have valid, fresh exchange timestamps. Backend status alone is not proof of live data."
}));

app.get("/api/fyers/auth/start", (_req, res) => {
  if (!appId || !redirectUri) return res.status(503).json({ error: "FYERS_APP_ID and FYERS_REDIRECT_URI must be configured on the server." });
  const now = Date.now();
  for (const [state, item] of pendingAuthStates) if (now - item.createdAt > AUTH_STATE_TTL_MS) pendingAuthStates.delete(state);
  const state = crypto.randomBytes(24).toString("hex");
  pendingAuthStates.set(state, { createdAt: now });
  const url = new URL("https://api-t1.fyers.in/api/v3/generate-authcode");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  res.set("Cache-Control", "no-store").json({ authorizationUrl: url.toString() });
});

app.post("/api/fyers/auth/exchange", async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const state = typeof req.body?.state === "string" ? req.body.state.trim() : "";
  if (!appId || !appSecret || !redirectUri) return res.status(503).json({ error: "FYERS server configuration is incomplete." });
  const pending = pendingAuthStates.get(state);
  if (!code || code.length > 4096 || !state || !pending || Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) {
    if (state) pendingAuthStates.delete(state);
    return res.status(400).json({ error: "FYERS authorization code/state is invalid or expired. Start Connect FYERS again." });
  }
  pendingAuthStates.delete(state);
  try {
    const appIdHash = crypto.createHash("sha256").update(`${appId}:${appSecret}`).digest("hex");
    const response = await fetchWithFyersBudget("https://api-t1.fyers.in/api/v3/validate-authcode", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", appIdHash, code }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.s !== "ok" || !data.access_token) return res.status(401).json({ error: "FYERS authentication failed.", detail: String(data.message || data.error || "Please retry Connect FYERS.").slice(0, 180) });
    accessToken = data.access_token;
    authenticatedAt = new Date().toISOString();
    recordDiagnostic("info", "fyers_authentication_succeeded", { authenticatedAt });
    startMarketDataStream(accessToken);
    dashboardSessions.clear();
    const dashboardSessionToken = crypto.randomBytes(32).toString("hex");
    dashboardSessions.set(dashboardSessionToken, { createdAt: Date.now() });
    res.set("Cache-Control", "no-store").json({ ok: true, fyers: "connected", dashboardSessionToken, authenticatedAt });
  } catch {
    res.status(502).json({ error: "Could not reach FYERS authentication service." });
  }
});

function requireSession(req, res, next) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(String(req.get("authorization") || ""));
  const token = match?.[1];
  const session = token ? dashboardSessions.get(token) : null;
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS || !accessToken) {
    if (token) dashboardSessions.delete(token);
    return res.status(401).json({ ok: false, error: "Connect FYERS again to access verified market history." });
  }
  return next();
}

async function fyersHistory(symbol, from, to, resolution = "D") {
  if (!accessToken) { const e = new Error("Connect FYERS first."); e.statusCode = 401; throw e; }
  const key = "history:" + resolution;
  const limit = rateLimits.get(key) || { until: 0, backoffMs: 60000 };
  if (Date.now() < limit.until) { const e = new Error("FYERS historical-data cooldown active; wait before retrying."); e.statusCode = 429; throw e; }
  const url = new URL("https://api-t1.fyers.in/data/history");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("date_format", "1");
  url.searchParams.set("range_from", from);
  url.searchParams.set("range_to", to);
  url.searchParams.set("cont_flag", "1");
  const response = await fetchWithFyersBudget(url, { headers: { Authorization: appId + ":" + accessToken, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
  const responseText = await response.text();
  let data = {}; try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retry) && retry > 0 ? Math.max(limit.backoffMs, retry * 1000) : limit.backoffMs;
    rateLimits.set(key, { until: Date.now() + backoffMs, backoffMs: Math.min(backoffMs * 2, 15 * 60 * 1000) });
  }
  if (!response.ok || data.s !== "ok" || !Array.isArray(data.candles)) {
    const e = new Error(String(data.message || data.error || `FYERS history request failed (HTTP ${response.status}).`).slice(0, 200));
    e.statusCode = response.status === 429 ? 429 : response.status === 401 || data.code === -16 ? 401 : 502;
    throw e;
  }
  rateLimits.delete(key);
  const bars = data.candles.map((row, index) => {
    if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(v => Number.isFinite(Number(v)))) throw new Error("Invalid FYERS daily candle at row " + index + "; analysis blocked.");
    const [time, open, high, low, close, volume] = row.map(Number);
    if (time <= 0 || Math.min(open, high, low, close) <= 0 || volume < 0 || high < Math.max(open, low, close) || low > Math.min(open, high, close)) throw new Error("Invalid FYERS OHLC values at row " + index + "; analysis blocked.");
    return { timestamp: new Date(time < 1e12 ? time * 1000 : time).toISOString(), open, high, low, close, volume, verified: true, source: "FYERS" };
  });
  return bars.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

app.get("/api/gap-analysis/history", requireSession, async (req, res) => {
  const symbol = String(req.query.symbol || "NSE:NIFTY50-INDEX");
  const allowed = new Set(["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "NSE:RELIANCE-EQ", "NSE:TCS-EQ", "NSE:INFY-EQ"]);
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const isRealDate = value => datePattern.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  const minGapPct = req.query.minGapPct == null ? 0.3 : Number(req.query.minGapPct);
  if (!allowed.has(symbol)) return res.status(400).json({ ok: false, error: "Unsupported symbol for this first verified gap-analysis release." });
  if (!isRealDate(from) || !isRealDate(to) || from > to || (Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000 > 365) return res.status(400).json({ ok: false, error: "Provide a valid YYYY-MM-DD date range of at most 365 days." });
  if (!Number.isFinite(minGapPct) || minGapPct < 0 || minGapPct > 20) return res.status(400).json({ ok: false, error: "minGapPct must be between 0 and 20." });
  try {
    const bars = await fyersHistory(symbol, from, to);
    if (bars.length < 2) return res.status(422).json({ ok: false, error: "FYERS returned fewer than two daily candles; gap analysis is unavailable.", candleCount: bars.length });
    const latest = bars.at(-1);
    const previous = bars.at(-2);
    const latestGap = analyzeOpeningGap({ previousClose: previous.close, todayOpen: latest.open });
    // Never count the current IST session as a completed historical fill observation:
    // its high/low can still change while the market is open.
    const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const completedBars = bars.filter(bar => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(bar.timestamp)) < todayIst);
    if (completedBars.length < 2) return res.status(422).json({ ok: false, error: "At least two completed daily sessions are required for historical gap-fill statistics.", candleCount: bars.length, completedCandleCount: completedBars.length, latestSession: { timestamp: latest.timestamp, gap: latestGap } });
    const summary = summarizeHistoricalGaps(completedBars, { minAbsGapPct: minGapPct });
    res.set("Cache-Control", "no-store").json({ ok: true, symbol, source: "FYERS historical daily candles", fetchedAt: new Date().toISOString(), range: { from, to }, candleCount: bars.length, completedCandleCount: completedBars.length, latestSession: { timestamp: latest.timestamp, previousClose: previous.close, open: latest.open, high: latest.high, low: latest.low, close: latest.close, volume: latest.volume, gap: latestGap, note: "Latest session is shown separately and is not counted as a completed historical gap-fill observation when it is today's session." }, historical: summary, warning: "Historical fill statistics exclude today's session to avoid treating an unfinished daily candle as complete. Daily candles do not prove FII/DII/operator intent or predict the next session." });
  } catch (error) {
    const status = Number(error.statusCode) || (String(error.message).startsWith("Invalid FYERS") ? 502 : 502);
    res.status(status).json({ ok: false, error: status === 429 ? "FYERS historical data rate limit; retry after cooldown." : status === 401 ? "FYERS session expired; reconnect." : "Gap analysis could not be verified.", detail: String(error.message || "Unknown upstream error").slice(0, 220) });
  }
});

let institutionalFlowCache = null;
let institutionalFlowCacheAt = 0;
let institutionalFlowInFlight = null;
const INSTITUTIONAL_FLOW_CACHE_MS = 10 * 60 * 1000;

app.get("/api/market/institutional-flow", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (institutionalFlowCache && Date.now() - institutionalFlowCacheAt < INSTITUTIONAL_FLOW_CACHE_MS) {
    return res.json({ ...institutionalFlowCache, cacheAgeSeconds: Math.floor((Date.now() - institutionalFlowCacheAt) / 1000) });
  }
  if (institutionalFlowInFlight) {
    try { return res.json(await institutionalFlowInFlight); }
    catch { return res.status(502).json({ ok: false, error: "Official NSE institutional flow is temporarily unavailable; figures withheld.", signalsAllowed: false }); }
  }
  institutionalFlowInFlight = (async () => {
    const response = await fetchWithFyersBudget("https://www.nseindia.com/api/fiidiiTradeReact", {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://www.nseindia.com/reports/fii-dii",
        "Accept-Language": "en-IN,en;q=0.9"
      },
      signal: AbortSignal.timeout(12000)
    }).then(async response => {
      if (!response.ok) throw new Error("nse_official_endpoint_http_" + response.status);
      return normalizeInstitutionalFlow(await response.json(), new Date().toISOString());
    });
    return response;
  })();
  try {
    const result = await institutionalFlowInFlight;
    institutionalFlowCache = result;
    institutionalFlowCacheAt = Date.now();
    return res.json({ ...result, cacheAgeSeconds: 0 });
  } catch (error) {
    recordDiagnostic("warn", "institutional_flow_unavailable", { reason: String(error.message || "source_error").slice(0, 120) });
    return res.status(502).json({
      ok: false,
      source: "NSE India official FII/FPI & DII report",
      sourceUrl: "https://www.nseindia.com/reports/fii-dii",
      error: "Official NSE data could not be verified. Figures withheld; open the official report directly.",
      signalsAllowed: false
    });
  } finally {
    institutionalFlowInFlight = null;
  }
});

app.get("/api/market/quotes", requireSession, (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });
  const snapshot = liveSnapshot();
  if (snapshot) return res.json({ ...snapshot, source: "websocket", streamConnected });
  return res.status(503).json({
    ok: false, error: "Waiting for verified FYERS WebSocket ticks.",
    detail: streamConnected ? "Socket connected, but both index symbols do not yet have fresh exchange-timestamped ticks." : (streamError || "FYERS market socket is reconnecting."),
    marketSocketConnected: streamConnected, retryAfterSeconds: 5
  });
});
let fnoUniverseCache = { fetchedAt: 0, data: null };
let fnoUniversePromise = null;
let stockQuoteCache = { fetchedAt: 0, data: null };
let stockQuotePromise = null;
let stockQuoteCooldown = { until: 0, backoffMs: 30000 };
const STOCK_QUOTE_CACHE_MS = 30000;
const STOCK_QUOTE_BATCH_SIZE = 50;
const STOCK_QUOTE_BATCH_PAUSE_MS = 1200;
async function getNseFnoEquityUniverse() {
  if (fnoUniverseCache.data && Date.now() - fnoUniverseCache.fetchedAt < 24 * 60 * 60 * 1000) return fnoUniverseCache.data;
  if (fnoUniversePromise) return fnoUniversePromise;
  fnoUniversePromise = (async () => {
    const [foResponse, cmResponse] = await Promise.all([
      fetchWithFyersBudget("https://public.fyers.in/sym_details/NSE_FO_sym_master.json", { signal: AbortSignal.timeout(45000) }),
      fetchWithFyersBudget("https://public.fyers.in/sym_details/NSE_CM_sym_master.json", { signal: AbortSignal.timeout(45000) })
    ]);
    if (!foResponse.ok || !cmResponse.ok) throw new Error("FYERS NSE_FO/NSE_CM symbol master download failed.");
    const [foMaster, cmMaster] = await Promise.all([foResponse.json(), cmResponse.json()]);
    if (!foMaster || typeof foMaster !== "object" || !cmMaster || typeof cmMaster !== "object") throw new Error("FYERS symbol master format was invalid.");
    const symbols = buildFnoEquityUniverse(foMaster, cmMaster);
    if (symbols.length < 180) {
      const error = new Error("FYERS symbol master returned an unexpectedly small F&O equity universe (" + symbols.length + " matched; refusing incomplete data).");
      error.diagnostics = { foEntries: Object.keys(foMaster).length, cmEntries: Object.keys(cmMaster).length, matchedEquities: symbols.length };
      throw error;
    }
    const result = { source: "FYERS NSE_FO + NSE_CM symbol masters", fetchedAt: new Date().toISOString(), count: symbols.length, data: symbols };
    fnoUniverseCache = { fetchedAt: Date.now(), data: result };
    console.log("FYERS NSE F&O equity universe loaded:", JSON.stringify({ count: symbols.length, source: result.source }));
    return result;
  })();
  try { return await fnoUniversePromise; }
  finally { fnoUniversePromise = null; }
}
app.get("/api/market/fno-universe", requireSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });
  try {
    const universe = await getNseFnoEquityUniverse();
    res.json({
      ok: true,
      source: universe.source,
      fetchedAt: universe.fetchedAt,
      count: universe.count,
      data: universe.data
    });
  } catch (error) {
    recordDiagnostic("warn", "fno_universe_unavailable", { message: String(error?.message || error).slice(0, 160) });
    res.status(503).json({ ok: false, error: "Verified NSE F&O universe unavailable; symbol selection blocked.", detail: String(error?.message || error).slice(0, 160) });
  }
});
function stockQuoteRateLimitError() {
  const now = Date.now();
  const until = now + stockQuoteCooldown.backoffMs;
  stockQuoteCooldown = { until, backoffMs: Math.min(stockQuoteCooldown.backoffMs * 2, 15 * 60 * 1000) };
  const error = new Error("FYERS quote rate limit reached; retry after cooldown.");
  error.statusCode = 429;
  error.retryAfterSeconds = Math.ceil((until - now) / 1000);
  return error;
}
async function loadVerifiedFnoStockQuotes() {
  const master = await getNseFnoEquityUniverse();
  const symbols = master.data.map(item => item.symbol);
  const now = Date.now();
  const data = [];
  const missingSymbols = [];
  // Sequential batches with a small pause avoid a burst of parallel quote requests.
  for (let offset = 0; offset < symbols.length; offset += STOCK_QUOTE_BATCH_SIZE) {
    if (offset > 0) await new Promise(resolve => setTimeout(resolve, STOCK_QUOTE_BATCH_PAUSE_MS));
    const batch = symbols.slice(offset, offset + STOCK_QUOTE_BATCH_SIZE);
    const url = new URL("https://api-t1.fyers.in/data/quotes");
    url.searchParams.set("symbols", batch.join(","));
    const response = await fetchWithFyersBudget(url, { headers: { Authorization: appId + ":" + accessToken, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      console.warn("FYERS stock quotes rate-limited:", JSON.stringify({ batchNumber: Math.floor(offset / STOCK_QUOTE_BATCH_SIZE) + 1, batchSize: batch.length }));
      throw stockQuoteRateLimitError();
    }
    if (!response.ok || body.s !== "ok" || !Array.isArray(body.d)) {
      const reason = String(body.message || body.code || "Invalid quote response").slice(0, 160);
      console.error("FYERS stock quote batch rejected:", JSON.stringify({
        batchNumber: Math.floor(offset / STOCK_QUOTE_BATCH_SIZE) + 1,
        batchSize: batch.length, httpStatus: response.status,
        responseStatus: body.s ?? null, reason
      }));
      const error = new Error(`FYERS quote batch ${Math.floor(offset / STOCK_QUOTE_BATCH_SIZE) + 1} failed (HTTP ${response.status}; ${reason}).`);
      error.statusCode = response.status === 401 ? 401 : response.status === 429 ? 429 : 502;
      throw error;
    }
    const returned = new Set();
    for (const item of body.d) {
      if (!item || !batch.includes(item.n) || !item.v) continue;
      returned.add(item.n);
      const v = item.v;
      const lp = Number(v.lp), tt = Number(v.tt), ch = Number(v.ch), chp = Number(v.chp);
      const stamp = tt > 0 ? tt * 1000 : 0;
      if (Number.isFinite(lp) && lp > 0 && Number.isFinite(chp) && stamp > 0 && Math.abs(now - stamp) <= 120000) {
        data.push({ n: item.n, v: { lp, ch: Number.isFinite(ch) ? ch : null, chp, tt }, verified: true });
      }
    }
    for (const symbol of batch) if (!returned.has(symbol) || !data.some(item => item.n === symbol)) missingSymbols.push(symbol);
  }
  if (missingSymbols.length > 0) {
    const error = new Error(`Incomplete verified F&O quote coverage (${data.length}/${symbols.length}); partial rankings discarded.`);
    error.statusCode = 503;
    error.universeCount = symbols.length;
    error.quotedCount = data.length;
    error.missingCount = missingSymbols.length;
    throw error;
  }
  if (!data.length) {
    const error = new Error("No fresh exchange-timestamped F&O stock quotes. No stale prices shown.");
    error.statusCode = 503;
    error.universeCount = symbols.length;
    throw error;
  }
  const result = {
    ok: true, source: "FYERS quotes API", verified: true, fetchedAt: new Date().toISOString(),
    freshnessLimitSeconds: 120, universe: "FYERS current NSE F&O equity symbol master",
    universeCount: symbols.length, quotedCount: data.length, data, missingSymbols
  };
  stockQuoteCache = { fetchedAt: Date.now(), data: result };
  stockQuoteCooldown = { until: 0, backoffMs: 30000 };
  return result;
}
app.get("/api/market/stock-quotes", requireSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });

  // Reuse the last successful snapshot while its exchange timestamps remain fresh.
  if (stockQuoteCache.data && Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS) {
    const cache = stockQuoteCache.data;
    const fresh = cache.data.filter(item => Math.abs(Date.now() - Number(item.v.tt) * 1000) <= 120000);
    if (fresh.length) return res.json({ ...cache, data: fresh, quotedCount: fresh.length, cached: true, fetchedAt: new Date(stockQuoteCache.fetchedAt).toISOString() });
  }

  const remaining = stockQuoteCooldown.until - Date.now();
  if (remaining > 0) {
    res.set("Retry-After", String(Math.ceil(remaining / 1000)));
    return res.status(429).json({
      ok: false, error: "FYERS stock-quote cooldown active; no upstream request was sent.",
      retryAfterSeconds: Math.ceil(remaining / 1000), partialQuotesDiscarded: true
    });
  }

  // Collapse simultaneous browser refreshes into one upstream request sequence.
  const request = stockQuotePromise || (stockQuotePromise = loadVerifiedFnoStockQuotes());
  try {
    const result = await request;
    return res.json(result);
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    if (status === 429) {
      const retry = Math.max(1, Number(error.retryAfterSeconds) || Math.ceil((stockQuoteCooldown.until - Date.now()) / 1000));
      res.set("Retry-After", String(retry));
      return res.status(429).json({
        ok: false, error: "FYERS quote rate limit reached while loading the F&O universe. Partial results were discarded.",
        retryAfterSeconds: retry, partialQuotesDiscarded: true
      });
    }
    return res.status(status).json({
      ok: false,
      error: status === 401 ? "FYERS session expired; reconnect." : status === 503 ? error.message : "FYERS F&O quotes could not be verified.",
      ...(error.universeCount ? { universeCount: error.universeCount } : {}),
      ...(Number.isFinite(error.quotedCount) ? { quotedCount: error.quotedCount } : {}),
      ...(Number.isFinite(error.missingCount) ? { missingCount: error.missingCount } : {}),
      partialQuotesDiscarded: status === 503,
      detail: String(error.message || "network error").slice(0, 160)
    });
  } finally {
    if (stockQuotePromise === request) stockQuotePromise = null;
  }
});

// Compatibility adapter for the Original Ultimate UI. Rankings are emitted only
// during the regular NSE clock window and only from a complete, fresh FYERS quote snapshot.
// This clock check is not a holiday calendar; any missing/stale upstream quote fails closed.
app.get("/api/market/movers", requireSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });
  const session = getNseSessionWindow(new Date());
  if (!session.isRegularHours) {
    return res.json({
      ok: true, source: "FYERS verified quotes only", marketSession: "CLOSED",
      sessionCheck: session, requestedSymbols: 0, receivedSymbols: 0,
      failedSymbols: [], partial: false, data: [],
      message: "Outside regular NSE hours. No live movers are ranked; last-known LTP must be shown separately."
    });
  }
  try {
    let snapshot;
    // A cached snapshot is usable only if every symbol remains fresh. Never shrink the
    // denominator or present a partial F&O universe as a complete ranking.
    if (stockQuoteCache.data && Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS) {
      const cached = stockQuoteCache.data;
      const allFresh = Array.isArray(cached.data) &&
        cached.data.length === cached.universeCount &&
        cached.data.every(item => item && item.verified === true && item.v &&
          Number.isFinite(Number(item.v.lp)) && Number(item.v.lp) > 0 &&
          Number.isFinite(Number(item.v.tt)) && Math.abs(Date.now() - Number(item.v.tt) * 1000) <= 120000);
      if (allFresh) snapshot = cached;
    }
    if (!snapshot) {
      const remaining = stockQuoteCooldown.until - Date.now();
      if (remaining > 0) {
        res.set("Retry-After", String(Math.ceil(remaining / 1000)));
        return res.status(429).json({
          ok: false, error: "FYERS quote cooldown active; live movers withheld.",
          retryAfterSeconds: Math.ceil(remaining / 1000), partial: true, data: []
        });
      }
      const request = stockQuotePromise || (stockQuotePromise = loadVerifiedFnoStockQuotes());
      try { snapshot = await request; }
      finally { if (stockQuotePromise === request) stockQuotePromise = null; }
    }
    const now = Date.now();
    const rows = snapshot.data.map(item => {
      const price = Number(item?.v?.lp);
      const changePct = Number(item?.v?.chp);
      const timestampSeconds = Number(item?.v?.tt);
      const priceAsOf = Number.isFinite(timestampSeconds) && timestampSeconds > 0
        ? new Date(timestampSeconds * 1000).toISOString() : null;
      const quoteAgeSeconds = priceAsOf ? (now - Date.parse(priceAsOf)) / 1000 : Infinity;
      return {
        symbol: item.n,
        name: String(item.n || "").replace(/^NSE:/, "").replace(/-EQ$/, ""),
        price, changePct, priceStatus: "LIVE_QUOTE", priceAsOf, quoteAgeSeconds,
        verified: item.verified === true, source: "FYERS quotes API"
      };
    });
    const requestedSymbols = Number(snapshot.universeCount);
    const receivedSymbols = rows.length;
    const invalid = rows.some(row => !row.verified || !Number.isFinite(row.price) || row.price <= 0 ||
      !Number.isFinite(row.changePct) || !Number.isFinite(row.quoteAgeSeconds) ||
      row.quoteAgeSeconds < 0 || row.quoteAgeSeconds > 120 || !row.priceAsOf);
    if (!Number.isInteger(requestedSymbols) || requestedSymbols < 180 ||
        receivedSymbols !== requestedSymbols || invalid) {
      return res.status(503).json({
        ok: false, error: "Incomplete or stale FYERS F&O quotes; live ranking blocked.",
        marketSession: "UNVERIFIED", requestedSymbols, receivedSymbols,
        failedSymbols: [], partial: true, data: []
      });
    }
    rows.sort((a, b) => b.changePct - a.changePct);
    return res.json({
      ok: true, source: "FYERS quotes API", verified: true,
      marketSession: "OPEN", sessionCheck: session,
      fetchedAt: snapshot.fetchedAt, requestedSymbols, receivedSymbols,
      failedSymbols: [], partial: false, data: rows
    });
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    if (status === 429) {
      const retry = Math.max(1, Number(error.retryAfterSeconds) || Math.ceil((stockQuoteCooldown.until - Date.now()) / 1000));
      res.set("Retry-After", String(retry));
      return res.status(429).json({
        ok: false, error: "FYERS rate limit reached; live movers withheld.",
        retryAfterSeconds: retry, partial: true, data: []
      });
    }
    return res.status(status).json({
      ok: false, error: "FYERS F&O movers could not be fully verified; ranking blocked.",
      partial: true, data: [], detail: String(error.message || "Upstream error").slice(0, 160)
    });
  }
});

// Read-only last-known index snapshot. It is display-only and never enables signals.
app.get("/api/market/last-known-quotes", requireSession, (req, res) => {
  res.set("Cache-Control", "no-store");
  const rows = allowedSymbols.map(symbol => {
    const tick = latestTicks.get(symbol);
    if (!tick || !Number.isFinite(Number(tick.ltp)) || Number(tick.ltp) <= 0 ||
        !Number.isFinite(Date.parse(tick.updatedAt))) return null;
    return { n: tick.symbol, verified: true, v: {
      lp: tick.ltp, tt: epochSeconds(tick.updatedAt),
      ...(tick.ch === null ? {} : { ch: tick.ch }),
      ...(tick.chp === null ? {} : { chp: tick.chp })
    }};
  });
  if (rows.some(row => !row)) {
    return res.status(503).json({
      ok: false, source: "last-known", error: "No complete last-known index snapshot is available.",
      data: [], marketOpen: getNseSessionWindow().isRegularHours
    });
  }
  const data = rows;
  const fetchedAt = new Date(Math.min(...data.map(row => Number(row.v.tt) * 1000))).toISOString();
  return res.json({
    ok: true, source: "last-known", fetchedAt, data,
    marketOpen: getNseSessionWindow().isRegularHours,
    signalsAllowed: false,
    note: "Last-known prices are display-only; live signals require fresh connected WebSocket ticks."
  });
});

async function fetchReadOnlyAccountEndpoint(path, res) {
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });
  try {
    const response = await fetchWithFyersBudget("https://api-t1.fyers.in/api/v3/" + path, {
      headers: { Authorization: appId + ":" + accessToken, Accept: "application/json" },
      cache: "no-store", signal: AbortSignal.timeout(12000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.s !== "ok") {
      const status = response.status === 401 || body.code === -16 ? 401 : response.status === 429 ? 429 : 502;
      if (status === 429) res.set("Retry-After", response.headers.get("retry-after") || "30");
      return res.status(status).json({
        ok: false,
        error: status === 401 ? "FYERS session expired; reconnect." : status === 429 ? "FYERS account API rate limit; retry after cooldown." : "Verified FYERS account data unavailable.",
        detail: String(body.message || body.error || "Invalid account response").slice(0, 160)
      });
    }
    return res.json({ ok: true, source: "FYERS read-only account API", fetchedAt: new Date().toISOString(), data: body });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "FYERS account endpoint could not be verified.", detail: String(error.message || "Network error").slice(0, 160) });
  }
}
app.get("/api/fyers/holdings", requireSession, (_req, res) => fetchReadOnlyAccountEndpoint("holdings", res));
app.get("/api/fyers/positions", requireSession, (_req, res) => fetchReadOnlyAccountEndpoint("positions", res));

// Fetch one specific option contract. No signal is issued unless the independent quote
// has a fresh exchange timestamp and a valid bid/ask spread.
app.get("/api/fyers/option-quote", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = String(req.query.symbol || "");
  if (symbol.length > 80 || !/^NSE:[A-Z0-9&-]+\d[A-Z0-9&-]*(?:CE|PE)$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: "A valid NSE option-contract symbol is required." });
  }
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });
  const cooldownKey = "optionquote:" + symbol;
  const cooldown = rateLimits.get(cooldownKey) || { until: 0, backoffMs: 30000 };
  if (Date.now() < cooldown.until) return res.status(429).json({ ok: false, error: "FYERS option quote cooldown active; no signal issued.", retryAfterSeconds: Math.ceil((cooldown.until - Date.now()) / 1000) });
  try {
    const url = new URL("https://api-t1.fyers.in/data/quotes");
    url.searchParams.set("symbols", symbol);
    const response = await fetchWithFyersBudget(url, {
      headers: { Authorization: appId + ":" + accessToken, Accept: "application/json" },
      cache: "no-store", signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const retryAfterSeconds = Math.max(30, Number(response.headers.get("retry-after")) || cooldown.backoffMs / 1000);
      rateLimits.set(cooldownKey, { until: Date.now() + retryAfterSeconds * 1000, backoffMs: Math.min(cooldown.backoffMs * 2, 900000) });
      return res.status(429).json({ ok: false, error: "FYERS option quote rate limit; no signal issued.", retryAfterSeconds });
    }
    if (!response.ok || body.s !== "ok" || !Array.isArray(body.d)) {
      return res.status(response.status === 401 || body.code === -16 ? 401 : 502).json({
        ok: false, error: "FYERS option quote unavailable; no signal issued.",
        detail: String(body.message || body.code || "Invalid quote response").slice(0, 160)
      });
    }
    const found = body.d.find(item => item && item.n === symbol && item.v);
    const value = found?.v;
    const ltp = Number(value?.lp), bid = Number(value?.bid), ask = Number(value?.ask);
    const tt = Number(value?.tt);
    const quoteTimeMs = tt > 0 ? (tt < 1e12 ? tt * 1000 : tt) : NaN;
    const ageMs = Date.now() - quoteTimeMs;
    if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(bid) || bid <= 0 ||
        !Number.isFinite(ask) || ask < bid || !Number.isFinite(ageMs) || ageMs < -5000 || ageMs > 15000) {
      return res.status(503).json({ ok: false, error: "Option quote is incomplete, stale, or has an invalid spread; no signal issued." });
    }
    rateLimits.delete(cooldownKey);
    return res.json({
      ok: true, source: "FYERS quotes API", fetchedAt: new Date().toISOString(),
      quote: { symbol, ltp, bid, ask, quoteTimeMs, quoteAgeMs: ageMs, verified: true }
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "FYERS option quote request failed; no signal issued.", detail: String(error.message || "Network error").slice(0, 160) });
  }
});

app.get("/api/fyers/options-chain", requireSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = String(req.query.symbol || "NSE:NIFTY50-INDEX");
  const allowedIndexSymbols = new Set(["NSE:NIFTY50-INDEX","NSE:NIFTYBANK-INDEX"]);
  const equitySymbolFormat = /^NSE:[A-Z0-9&-]+-EQ$/;
  const count = Number(req.query.strikecount ?? 10);
  const expiry = String(req.query.timestamp ?? "");
  if (!allowedIndexSymbols.has(symbol) && !equitySymbolFormat.test(symbol)) return res.status(400).json({ok:false,error:"Unsupported underlying."});
  if (equitySymbolFormat.test(symbol)) {
    try {
      const universe = await getNseFnoEquityUniverse();
      if (!universe.data.some(item => item.symbol === symbol)) return res.status(400).json({ok:false,error:"Underlying is not in the verified current NSE F&O equity universe."});
    } catch (error) {
      return res.status(503).json({ok:false,error:"Current NSE F&O universe could not be verified; option-chain request blocked.",detail:String(error.message||"Symbol master unavailable").slice(0,160)});
    }
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ok:false,error:"strikecount must be 1–50."});
  if (expiry && !/^\d{10}$/.test(expiry)) return res.status(400).json({ok:false,error:"Invalid expiry timestamp."});
  const cooldownKey = "optionchain:" + symbol;
  const cooldown = rateLimits.get(cooldownKey) || { until: 0, backoffMs: 30000 };
  if (Date.now() < cooldown.until) return res.status(429).json({ok:false,error:"FYERS option-chain cooldown active.",retryAfterSeconds:Math.ceil((cooldown.until-Date.now())/1000)});
  const url = new URL("https://api-t1.fyers.in/data/options-chain-v3");
  url.searchParams.set("symbol",symbol);url.searchParams.set("strikecount",String(count));url.searchParams.set("greeks","1");
  if (expiry) url.searchParams.set("timestamp",expiry);
  try {
    const response = await fetchWithFyersBudget(url,{headers:{Authorization:appId+":"+accessToken,Accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(12000)});
    const body = await response.json().catch(()=>({}));
    if (response.status===429) { rateLimits.set(cooldownKey,{until:Date.now()+cooldown.backoffMs,backoffMs:Math.min(cooldown.backoffMs*2,900000)}); return res.status(429).json({ok:false,error:"FYERS rate limit reached for option chain; retry after cooldown."}); }
    if (!response.ok || body.s!=="ok" || !Array.isArray(body.data?.optionsChain)) return res.status(response.status===401?401:502).json({ok:false,error:"FYERS option-chain data unavailable or unverified.",detail:String(body.message||"Invalid response").slice(0,160)});
    const underlying=body.data.optionsChain.find(x=>x&&x.option_type===""&&Number(x.strike_price)===-1);
    if (!underlying || !Number.isFinite(Number(underlying.ltp)) || Number(underlying.ltp)<=0) return res.status(502).json({ok:false,error:"Underlying quote missing; analysis blocked."});
    const legs=body.data.optionsChain.filter(x=>x&&(x.option_type==="CE"||x.option_type==="PE"));
    if (!legs.length) return res.status(422).json({ok:false,error:"No option legs returned."});
    const data=legs.map(x=>({symbol:x.symbol,type:x.option_type,strike:Number(x.strike_price),ltp:Number(x.ltp),oi:x.oi!==null&&x.oi!==undefined&&x.oi!==""&&Number.isFinite(Number(x.oi))&&Number(x.oi)>=0?Number(x.oi):null,oiChange:x.oich!==null&&x.oich!==undefined&&x.oich!==""&&Number.isFinite(Number(x.oich))?Number(x.oich):null,volume:x.volume!==null&&x.volume!==undefined&&x.volume!==""&&Number.isFinite(Number(x.volume))&&Number(x.volume)>=0?Number(x.volume):null,verified:typeof x.symbol==="string"&&x.symbol.startsWith("NSE:")&&Number(x.strike_price)>0&&x.ltp!==null&&x.ltp!==undefined&&Number.isFinite(Number(x.ltp))&&Number(x.ltp)>=0}));
    if (data.some(x=>!x.verified)) return res.status(502).json({ok:false,error:"Option leg validation failed; chain blocked."});
    const complete=data.every(x=>x.oi!==null&&x.volume!==null);
    rateLimits.delete(cooldownKey);
    res.json({ok:true,symbol,source:"FYERS option-chain API",fetchedAt:new Date().toISOString(),underlyingLtp:Number(underlying.ltp),expiryData:Array.isArray(body.data.expiryData)?body.data.expiryData:[],callOi:Number.isFinite(Number(body.data.callOi))?Number(body.data.callOi):null,putOi:Number.isFinite(Number(body.data.putOi))?Number(body.data.putOi):null,dataComplete:complete,signalsAllowed:false,count:data.length,data,warning:complete?"OI and volume fields are present, but exchange-time freshness and liquidity are not independently validated; display only and keep signals blocked.":"OI or volume missing on one or more legs; display only and keep signals blocked."});
  } catch (error) { res.status(502).json({ok:false,error:"FYERS option-chain request failed; analysis blocked.",detail:String(error.message||"Network error").slice(0,160)}); }
});

app.get("/api/market/live-candles", requireSession, (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = String(req.query.symbol || "NSE:NIFTY50-INDEX");
  const resolution = Number(req.query.resolution || 5);
  if (!allowedSymbols.includes(symbol)) return res.status(400).json({ ok: false, error: "Live tick candles are currently enabled only for NIFTY and BANKNIFTY." });
  if (!liveCandleIntervals.includes(resolution)) return res.status(400).json({ ok: false, error: "Live candle resolution must be 1, 5, 15, 30, or 60 minutes." });
  const now = Date.now();
  const rows = (liveCandles.get(symbol + "|" + resolution) || []).filter(row => now - row.bucketMs <= 24 * 60 * 60 * 1000);
  if (!rows.length) return res.status(503).json({ ok: false, error: "No verified live tick candles have been collected yet.", detail: "Connect FYERS and wait for fresh exchange-timestamped ticks. Historical candles are available through /api/market/candles." });
  const latest = rows[rows.length - 1];
  const tick = latestTicks.get(symbol);
  if (!tick || now - Date.parse(tick.updatedAt) > 120000 || Date.parse(tick.updatedAt) > now + 30000) return res.status(503).json({ ok: false, error: "Live tick candle is stale; live analysis blocked.", lastTickAt: tick ? tick.updatedAt : null, lastCandleAt: latest.timestamp });
  res.json({ ok: true, symbol, resolution, source: "FYERS websocket ticks", fetchedAt: new Date().toISOString(), count: rows.length, volumeAvailable: false, data: rows.map(({ bucketMs, ...row }) => row) });
});
app.get("/api/market/candles", requireSession, async (req, res) => {
  const symbol = String(req.query.symbol || "NSE:NIFTY50-INDEX");
  const resolution = String(req.query.resolution || "5");
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const allowedIndexSymbols = new Set(["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"]);
  const equitySymbolFormat = /^NSE:[A-Z0-9&-]+-EQ$/;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const isRealDate = value => datePattern.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  const allowedResolutions = new Set(["1", "2", "3", "5", "10", "15", "20", "30", "60", "D"]);
  if (!allowedIndexSymbols.has(symbol) && !equitySymbolFormat.test(symbol)) return res.status(400).json({ ok: false, error: "Unsupported symbol format for verified candles." });
  if (!allowedResolutions.has(resolution)) return res.status(400).json({ ok: false, error: "Resolution must be a supported FYERS interval: 1, 2, 3, 5, 10, 15, 20, 30, 60, or D." });
  if (!isRealDate(from) || !isRealDate(to) || from > to) return res.status(400).json({ ok: false, error: "Provide valid from/to dates in YYYY-MM-DD format." });
  const days = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000;
  const maxDays = resolution === "D" ? 365 : 30;
  if (days > maxDays) return res.status(400).json({ ok: false, error: "Date range exceeds " + maxDays + " days for this candle interval." });
  try {
    if (!allowedIndexSymbols.has(symbol)) {
      const universe = await getNseFnoEquityUniverse();
      if (!universe.data.some(item => item.symbol === symbol)) {
        return res.status(400).json({ ok: false, error: "Symbol is not in the verified current NSE F&O equity universe." });
      }
    }
    const candles = await fyersHistory(symbol, from, to, resolution);
    if (!candles.length) return res.status(422).json({ ok: false, error: "FYERS returned no candles for this symbol and interval.", data: [] });
    res.set("Cache-Control", "no-store").json({
      ok: true, symbol, resolution, source: "FYERS historical candles",
      fetchedAt: new Date().toISOString(), count: candles.length,
      data: candles.map(c => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, verified: true, source: "FYERS" }))
    });
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    res.status(status).json({
      ok: false,
      error: status === 429 ? "FYERS historical data rate limit; retry after cooldown." : status === 401 ? "FYERS session expired; reconnect." : "Candles could not be verified.",
      detail: String(error.message || "Unknown upstream error").slice(0, 220), data: []
    });
  }
});
app.all("/api/orders/*", (_req, res) => res.status(403).json({ error: "Order placement is disabled during testing." }));
app.use((err, _req, res, _next) => {
  if (err?.message === "origin_not_allowed") return res.status(403).json({ error: "origin_not_allowed" });
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log("DhanPulse clean backend listening on " + port));
