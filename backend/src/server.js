import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { analyzeOpeningGap, summarizeHistoricalGaps } from "./gap-analysis.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

const appId = process.env.FYERS_APP_ID || "";
const appSecret = process.env.FYERS_APP_SECRET || "";
const redirectUri = process.env.FYERS_REDIRECT_URI || "";
const allowedOrigins = new Set((process.env.ALLOWED_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean));
if (redirectUri) { try { allowedOrigins.add(new URL(redirectUri).origin); } catch {} }
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.has(origin)) return callback(null, true);
  return callback(new Error("origin_not_allowed"));
}}));

const startedAt = Date.now();
let accessToken = "";
let authenticatedAt = null;
const pendingAuthStates = new Map();
const dashboardSessions = new Map();
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const rateLimits = new Map();

app.get("/", (_req, res) => res.json({ service: "DhanPulse clean backend", version: "0.2.0", status: "online", endpoints: ["/health", "/api/status", "/api/fyers/auth/start", "/api/fyers/auth/exchange", "/api/gap-analysis/history"], orderPlacement: "disabled" }));
app.get("/health", (_req, res) => res.set("Cache-Control", "no-store").json({ backend: "online", uptimeSeconds: Math.floor((Date.now()-startedAt)/1000), orderPlacement: "disabled" }));
app.get("/api/status", (_req, res) => res.set("Cache-Control", "no-store").json({
  backend: "online",
  fyersConfigured: Boolean(appId && appSecret && redirectUri),
  fyers: accessToken ? "connected" : "not-connected",
  authenticatedAt,
  liveData: "not-streaming",
  marketSocketConnected: false,
  orderPlacement: "disabled",
  note: "This branch currently uses authenticated FYERS historical candles for gap analysis; it does not claim a live tick stream."
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
    const response = await fetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", appIdHash, code }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.s !== "ok" || !data.access_token) return res.status(401).json({ error: "FYERS authentication failed.", detail: String(data.message || data.error || "Please retry Connect FYERS.").slice(0, 180) });
    accessToken = data.access_token;
    authenticatedAt = new Date().toISOString();
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

async function fyersHistory(symbol, from, to) {
  if (!accessToken) { const e = new Error("Connect FYERS first."); e.statusCode = 401; throw e; }
  const key = "history";
  const limit = rateLimits.get(key) || { until: 0, backoffMs: 60000 };
  if (Date.now() < limit.until) { const e = new Error("FYERS historical-data cooldown active; wait before retrying."); e.statusCode = 429; throw e; }
  const url = new URL("https://api-t1.fyers.in/data/history");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", "D");
  url.searchParams.set("date_format", "1");
  url.searchParams.set("range_from", from);
  url.searchParams.set("range_to", to);
  url.searchParams.set("cont_flag", "1");
  const response = await fetch(url, { headers: { Authorization: appId + ":" + accessToken, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
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

app.get("/api/market/quotes", (_req, res) => res.status(503).json({ error: "live_quote_stream_not_connected", message: "This branch does not claim live streaming. No placeholder prices are returned.", data: [] }));
app.get("/api/market/candles", (_req, res) => res.status(503).json({ error: "live_candle_route_not_implemented", message: "Use authenticated daily history through /api/gap-analysis/history for the verified gap-analysis release.", data: [] }));
app.all("/api/orders/*", (_req, res) => res.status(403).json({ error: "Order placement is disabled during testing." }));
app.use((err, _req, res, _next) => {
  if (err?.message === "origin_not_allowed") return res.status(403).json({ error: "origin_not_allowed" });
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => console.log("DhanPulse clean backend listening on " + port));
