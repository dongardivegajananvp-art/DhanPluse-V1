import 'dotenv/config';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { analyzeOpeningGap, isValidIsoDate, summarizeHistoricalGaps } from './gap-analysis.js';

const require = createRequire(import.meta.url);
const { fyersDataSocket } = require('fyers-api-v3');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb' }));

const appId = process.env.FYERS_APP_ID || '';
const appSecret = process.env.FYERS_APP_SECRET || '';
const redirectUri = process.env.FYERS_REDIRECT_URI || '';
const allowedSymbols = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX'];

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
);

// Allow the free GitHub Pages frontend origin as an explicit browser API client.
allowedOrigins.add('https://dongardivegajananvp-art.github.io');

if (redirectUri) {
  try {
    allowedOrigins.add(new URL(redirectUri).origin);
  } catch {}
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));

let accessToken = '';
let authenticatedAt = null;
const pendingAuthStates = new Map();
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const dashboardSessions = new Map();
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
let marketSocket = null;
let streamConnected = false;
let streamError = '';
const latestTicks = new Map();
let restQuoteCache = null;
let restQuoteFetchedAt = 0;
let restQuoteInFlight = null;

function parseTick(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return; }
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const symbol = item.symbol || item.n;
    const ltp = Number(item.ltp ?? item.lp ?? item.v?.lp);
    if (!allowedSymbols.includes(symbol) || !Number.isFinite(ltp) || ltp <= 0) continue;

    // Use the exchange feed timestamp, not the time this server received the
    // message. FYERS can send the last known index snapshot after reconnecting
    // when the market is closed; stamping that replay with "now" falsely makes
    // an old quote look live.
    const exchangeTime = epochSeconds(
      item.exch_feed_time ?? item.last_traded_time ?? item.ltt ?? item.tt
    );
    if (!exchangeTime) {
      console.warn('FYERS index update ignored: missing exchange timestamp.', JSON.stringify({ symbol, type: item.type || null }));
      continue;
    }

    latestTicks.set(symbol, {
      symbol,
      ltp,
      ch: Number.isFinite(Number(item.ch)) ? Number(item.ch) : null,
      chp: Number.isFinite(Number(item.chp)) ? Number(item.chp) : null,
      updatedAt: new Date(exchangeTime * 1000).toISOString(),
      receivedAt: new Date().toISOString()
    });
  }
}

function startMarketDataStream(token) {
  streamError = '';
  streamConnected = false;
  latestTicks.clear();

  try {
    if (marketSocket) {
      try { marketSocket.close(); } catch {}
      marketSocket = null;
    }

    const socket = fyersDataSocket.getInstance(`${appId}:${token}`, '', false);
    marketSocket = socket;

    socket.on('connect', () => {
      if (marketSocket !== socket) return;
      streamConnected = true;
      streamError = '';
      console.log('FYERS market socket connected; subscribing to configured index symbols.');
      try {
        // Select full updates before subscribing so exchange timestamps are present
        // when the first index messages arrive; this prevents stale snapshots from
        // being treated as fresh live data.
        socket.mode(socket.FullMode);
        socket.subscribe(allowedSymbols);
        console.log('FYERS market socket subscription request sent.');
      } catch (error) {
        streamError = 'Could not subscribe to FYERS index symbols.';
        console.error('FYERS market socket subscription failed:', String(error?.message || error).slice(0, 240));
      }
    });

    socket.on('message', message => {
      if (marketSocket !== socket) return;
      const before = latestTicks.size;
      parseTick(message);
      const after = latestTicks.size;
      if (after > before || after > 0) {
        const summary = Array.isArray(message)
          ? message.slice(0, 5).map(x => ({ symbol: x?.symbol || x?.n || null, type: x?.type || null, hasLtp: x?.ltp != null || x?.lp != null || x?.v?.lp != null }))
          : { symbol: message?.symbol || message?.n || null, type: message?.type || null, hasLtp: message?.ltp != null || message?.lp != null || message?.v?.lp != null };
        console.log('FYERS market tick received:', JSON.stringify(summary));
      } else {
        const shape = message && typeof message === 'object'
          ? { keys: Object.keys(message).slice(0, 20), type: message.type || null, symbol: message.symbol || message.n || null }
          : { messageType: typeof message };
        console.log('FYERS socket message not parsed as an index tick:', JSON.stringify(shape));
      }
    });

    socket.on('error', error => {
      if (marketSocket !== socket) return;
      streamError = 'FYERS market data socket reported an error.';
      console.error('FYERS market socket error:', String(error?.message || error).slice(0, 240));
    });

    socket.on('close', (code, reason) => {
      if (marketSocket !== socket) return;
      streamConnected = false;
      const safeReason = reason == null ? '' : String(reason).slice(0, 160);
      console.warn('FYERS market socket closed:', JSON.stringify({
        code: code ?? null,
        reason: safeReason || null
      }));
    });

    socket.connect();
    if (typeof socket.autoreconnect === 'function') socket.autoreconnect(10);
  } catch (error) {
    streamConnected = false;
    streamError = 'Could not start the FYERS market data socket.';
    console.error('FYERS market socket startup failed:', String(error?.message || error).slice(0, 240));
  }
}

function nseRegularSessionNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(fields.hour) * 60 + Number(fields.minute);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(fields.weekday) && minute >= 555 && minute < 930;
}

function epochSeconds(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

function liveSnapshot() {
  const ticks = allowedSymbols.map(symbol => latestTicks.get(symbol));
  if (ticks.some(tick => !tick)) return null;
  const now = Date.now();
  const tickAges = ticks.map(tick => now - Date.parse(tick.updatedAt));
  // Every index timestamp must be plausible: reject both stale and future-dated ticks.
  if (tickAges.some(age => !Number.isFinite(age) || age < 0 || age > 120000)) return null;

  return {
    ok: true,
    fetchedAt: new Date(Math.max(...ticks.map(tick => Date.parse(tick.updatedAt)))).toISOString(),
    data: ticks.map(tick => ({
      n: tick.symbol,
      v: {
        lp: tick.ltp,
        tt: epochSeconds(tick.updatedAt),
        ...(tick.ch === null ? {} : { ch: tick.ch }),
        ...(tick.chp === null ? {} : { chp: tick.chp })
      }
    }))
  };
}

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'dhanpulse-backend',
    message: 'Backend is online. Check /api/status for FYERS authentication and live-data state.',
    endpoints: {
      health: '/health',
      status: '/api/status',
      quotes: '/api/market/quotes',
      candles: '/api/market/candles',
      movers: '/api/market/movers',
      optionsChain: '/api/fyers/options-chain'
    },
    orderPlacement: 'disabled'
  });
});

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = liveSnapshot();
  res.json({
    ok: true,
    service: 'dhanpulse-backend',
    fyersConfigured: Boolean(appId && appSecret && redirectUri),
    liveDataConnected: Boolean(streamConnected && snapshot),
    marketSocketConnected: streamConnected,
    lastTickAt: snapshot?.fetchedAt || null,
    orderPlacementEnabled: false
  });
});

app.get('/api/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = liveSnapshot();
  res.json({
    backend: 'online',
    fyers: accessToken ? 'connected' : 'not-connected',
    liveData: streamConnected && snapshot ? 'streaming' : 'waiting-for-live-ticks',
    marketSocketConnected: streamConnected,
    authenticatedAt,
    lastTickAt: snapshot?.fetchedAt || null,
    ...(streamError ? { marketDataMessage: streamError } : {}),
    orderPlacement: 'disabled'
  });
});

function requireDashboardSession(req, res, next) {
  const header = String(req.get('authorization') || '');
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header);
  const token = match ? match[1] : '';
  const session = token ? dashboardSessions.get(token) : null;
  if (!session || Date.now() - session.createdAt > DASHBOARD_SESSION_TTL_MS || !accessToken) {
    if (token) dashboardSessions.delete(token);
    return res.status(401).json({ ok: false, error: 'Dashboard session missing or expired. Reconnect FYERS.' });
  }
  session.lastSeenAt = Date.now();
  return next();
}

// Browser requests must prove they completed the FYERS OAuth flow before
// receiving quotes, historical candles, option-chain, holdings or positions.
// CORS is not authentication; this short-lived opaque session token is.
app.use('/api/market', requireDashboardSession);
app.use('/api/fyers/options-chain', requireDashboardSession);
app.use('/api/fyers/option-quote', requireDashboardSession);
app.use('/api/fyers/holdings', requireDashboardSession);
app.use('/api/fyers/positions', requireDashboardSession);

app.get('/api/fyers/auth/start', (_req, res) => {
  if (!appId || !redirectUri) {
    return res.status(503).json({ error: 'FYERS environment settings are incomplete.' });
  }

  const now = Date.now();
  for (const [key, value] of pendingAuthStates) {
    if (now - value.createdAt > AUTH_STATE_TTL_MS) pendingAuthStates.delete(key);
  }
  const state = crypto.randomBytes(24).toString('hex');
  pendingAuthStates.set(state, { createdAt: now });
  const url = new URL('https://api-t1.fyers.in/api/v3/generate-authcode');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  res.set('Cache-Control', 'no-store');
  res.json({ authorizationUrl: url.toString() });
});

app.post('/api/fyers/auth/exchange', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const state = typeof req.body?.state === 'string' ? req.body.state.trim() : '';

  if (!appId || !appSecret || !redirectUri) {
    return res.status(503).json({ error: 'FYERS environment settings are incomplete.' });
  }
  if (!code || code.length > 4096) {
    return res.status(400).json({ error: 'Invalid authorization code.' });
  }
  const pending = pendingAuthStates.get(state);
  if (!state || !pending || Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) {
    if (state) pendingAuthStates.delete(state);
    return res.status(400).json({ error: 'FYERS login state is invalid or expired. Start Connect FYERS again.' });
  }
  // One-time state prevents callback replay and cross-site login mix-ups.
  pendingAuthStates.delete(state);

  try {
    const appIdHash = crypto.createHash('sha256')
      .update(`${appId}:${appSecret}`)
      .digest('hex');

    const response = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        appIdHash,
        code
      }),
      signal: AbortSignal.timeout(12000)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.s !== 'ok' || !data.access_token) {
      return res.status(401).json({
        error: 'FYERS authentication failed.',
        detail: data.message || data.error || 'Please check FYERS settings.'
      });
    }

    accessToken = data.access_token;
    dashboardSessions.clear();
    const dashboardSessionToken = crypto.randomBytes(32).toString('hex');
    dashboardSessions.set(dashboardSessionToken, { createdAt: Date.now(), lastSeenAt: Date.now() });
    authenticatedAt = new Date().toISOString();
    restQuoteCache = null;
    restQuoteFetchedAt = 0;
    startMarketDataStream(accessToken);

    res.json({
      ok: true,
      fyers: 'connected',
      liveData: 'connecting',
      dashboardSessionToken,
      authenticatedAt
    });
  } catch {
    res.status(502).json({ error: 'Could not reach FYERS authentication service.' });
  }
});

// Index quotes are served from the authenticated FYERS WebSocket only.
// Never fall back to REST polling here: the dashboard polls this route frequently,
// and REST fallback caused repeated HTTP 429s while the socket was reconnecting.
// Last-known index quotes are read-only and never treated as fresh ticks.
app.get('/api/market/last-known-quotes', (req, res) => {
  const rows = allowedSymbols.map(symbol => latestTicks.get(symbol)).filter(tick =>
    tick && Number.isFinite(Number(tick.ltp)) && Number(tick.ltp) > 0 &&
    Number.isFinite(Date.parse(tick.updatedAt))
  );
  if (rows.length !== allowedSymbols.length) {
    return res.status(503).json({
      ok: false,
      error: 'No complete last-known FYERS index snapshot is available.',
      availableSymbols: rows.map(tick => tick.symbol),
      requiredSymbols: allowedSymbols
    });
  }
  const newestTickAt = Math.max(...rows.map(tick => Date.parse(tick.updatedAt)));
  const oldestTickAt = Math.min(...rows.map(tick => Date.parse(tick.updatedAt)));
  const now = Date.now();
  const marketOpen = nseRegularSessionNow();
  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    source: 'last-known',
    streamConnected: false,
    marketOpen,
    fetchedAt: new Date(newestTickAt).toISOString(),
    quoteAgeSeconds: Math.max(0, Math.floor((now - oldestTickAt) / 1000)),
    data: rows.map(tick => ({
      n: tick.symbol,
      v: {
        lp: Number(tick.ltp),
        tt: epochSeconds(tick.updatedAt),
        ...(tick.ch === null || tick.ch === undefined ? {} : { ch: tick.ch }),
        ...(tick.chp === null || tick.chp === undefined ? {} : { chp: tick.chp })
      }
    }))
  });
});

app.get('/api/market/quotes', async (_req, res) => {
  if (!accessToken) {
    return res.status(401).json({ ok: false, error: 'Connect FYERS first.' });
  }

  res.set('Cache-Control', 'no-store');
  const snapshot = liveSnapshot();
  if (snapshot) {
    return res.json({
      ...snapshot,
      source: streamConnected ? 'websocket' : 'websocket-recent',
      streamConnected
    });
  }

  return res.status(503).json({
    ok: false,
    error: 'Waiting for verified FYERS WebSocket ticks. REST fallback is disabled to protect rate limits.',
    detail: streamConnected
      ? 'The socket is connected, but fresh ticks for both index symbols have not arrived yet.'
      : (streamError || 'The FYERS market socket is reconnecting.'),
    retryAfterSeconds: 5,
    marketSocketConnected: streamConnected
  });
});

// Rate-limit each FYERS REST endpoint independently. A 429 from the equity
// Quotes API must not silently block an unrelated historical-candles request.
// Each endpoint still backs off exponentially, so a throttled route is not
// repeatedly hammered while other read-only routes can be diagnosed normally.
const fyersRateLimits = new Map();
const FYERS_429_INITIAL_BACKOFF_MS = 60_000;
const FYERS_429_MAX_BACKOFF_MS = 60 * 60_000;

async function fyersReadOnlyGet(url) {
  if (!accessToken) {
    const error = new Error('Connect FYERS first.');
    error.statusCode = 401;
    throw error;
  }
  const rateLimitKey = url instanceof URL ? url.pathname : new URL(String(url)).pathname;
  const rateLimit = fyersRateLimits.get(rateLimitKey) || { until: 0, backoffMs: FYERS_429_INITIAL_BACKOFF_MS };
  if (Date.now() < rateLimit.until) {
    const waitSeconds = Math.ceil((rateLimit.until - Date.now()) / 1000);
    const error = new Error(`FYERS rate-limit cooldown active for ${rateLimitKey}. Retry in about ${waitSeconds} seconds.`);
    error.statusCode = 429;
    throw error;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: appId + ':' + accessToken, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });
  // Preserve non-JSON upstream error bodies too; some 429 gateways return an
  // empty body, which was hiding whether FYERS sent a retry hint or diagnostic.
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  const retryAfterHeader = response.headers.get('retry-after');
  if (response.status === 429) {
    const retryAfterSeconds = retryAfterHeader && /^\d+(?:\.\d+)?$/.test(retryAfterHeader)
      ? Math.ceil(Number(retryAfterHeader))
      : 0;
    // Cloudflare Error 1015 is an upstream rate-limit block; Retry-After may
    // misleadingly be "0". Stop retrying this endpoint for an hour instead
    // of re-triggering the block every few minutes.
    const cloudflare1015 = /error\s*1015|cloudflare.{0,80}1015/i.test(responseText);
    const backoffMs = cloudflare1015
      ? FYERS_429_MAX_BACKOFF_MS
      : retryAfterSeconds > 0
        ? Math.max(rateLimit.backoffMs, retryAfterSeconds * 1000)
        : rateLimit.backoffMs;
    fyersRateLimits.set(rateLimitKey, {
      until: Date.now() + backoffMs,
      backoffMs: Math.min(Math.max(rateLimit.backoffMs * 2, backoffMs), FYERS_429_MAX_BACKOFF_MS)
    });
  }
  if (!response.ok || data.s !== 'ok') {
    // Include safe upstream diagnostics (never credentials) so quote failures
    // can be fixed from evidence instead of guessing at permissions or symbols.
    const upstreamMessage = data.message || data.error || data.details;
    const upstreamStatus = String(data.s || 'missing');
    const upstreamCode = data.code == null ? 'n/a' : String(data.code);
    const message = upstreamMessage
      ? String(upstreamMessage).slice(0, 150)
      : (responseText ? responseText.replace(/\s+/g, ' ').slice(0, 150) : 'FYERS API returned no error message.');
    const error = new Error(`FYERS API rejected the request (HTTP ${response.status}, status ${upstreamStatus}, code ${upstreamCode}${retryAfterHeader ? `, Retry-After ${retryAfterHeader}` : ''}): ${message}`.slice(0, 220));
    error.statusCode = response.status === 429 ? 429 : (response.status === 401 || data.code === -16 ? 401 : 502);
    console.warn('FYERS read-only request failed:', JSON.stringify({
      path: url.pathname,
      httpStatus: response.status,
      apiStatus: upstreamStatus,
      apiCode: upstreamCode,
      retryAfter: retryAfterHeader || null,
      message
    }));
    throw error;
  }
  fyersRateLimits.delete(rateLimitKey);
  return data;
}


app.get('/api/market/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const allowed = new Set([...allowedSymbols, ...moversSymbols]);
  const resolution = String(req.query.resolution || '5');
  const allowedResolutions = new Set(['1', '3', '5', '15', '30', '60', 'D']);
  // FYERS candle dates are exchange-local calendar dates. Use IST rather than UTC
  // so the default range does not roll over at 00:00 UTC (05:30 IST).
  const indiaNow = new Date(Date.now() + 330 * 60 * 1000);
  const today = indiaNow.toISOString().slice(0, 10);
  const defaultLookbackDays = resolution === 'D' ? 29 : 6;
  const defaultFrom = new Date(Date.UTC(
    indiaNow.getUTCFullYear(),
    indiaNow.getUTCMonth(),
    indiaNow.getUTCDate() - defaultLookbackDays
  )).toISOString().slice(0, 10);
  const rangeFrom = String(req.query.from || defaultFrom);
  const rangeTo = String(req.query.to || today);
  if (!allowed.has(symbol)) return res.status(400).json({ ok: false, error: 'Unsupported candle symbol.' });
  if (!allowedResolutions.has(resolution)) return res.status(400).json({ ok: false, error: 'Unsupported candle resolution.' });
  if (!isValidIsoDate(rangeFrom) || !isValidIsoDate(rangeTo) || rangeFrom > rangeTo || rangeTo > today) {
    return res.status(400).json({ ok: false, error: 'Use real calendar dates in YYYY-MM-DD format, ending no later than today (IST).' });
  }
  const spanDays = (Date.parse(rangeTo + 'T00:00:00Z') - Date.parse(rangeFrom + 'T00:00:00Z')) / 86400000;
  if (!Number.isFinite(spanDays) || spanDays > (resolution === 'D' ? 365 : 30)) return res.status(400).json({ ok: false, error: 'Requested candle range is too large.' });
  try {
    const url = new URL('https://api-t1.fyers.in/data/history');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('resolution', resolution);
    url.searchParams.set('date_format', '1');
    url.searchParams.set('range_from', rangeFrom);
    url.searchParams.set('range_to', rangeTo);
    url.searchParams.set('cont_flag', '1');
    const result = await fyersReadOnlyGet(url);
    const candles = Array.isArray(result.candles) ? result.candles : [];
    if (candles.length === 0) {
      res.set('Cache-Control', 'no-store');
      return res.status(422).json({
        ok: false,
        error: 'FYERS returned no candles for the requested range; analysis blocked.',
        detail: 'An empty history response is not a verified chart dataset.'
      });
    }
    const isValidCandle = row => {
      if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(value => Number.isFinite(Number(value)))) return false;
      const [timestamp, open, high, low, close, volume] = row.map(Number);
      return timestamp > 0 && open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0 &&
        high >= Math.max(open, low, close) && low <= Math.min(open, high, close);
    };
    const invalidCandleCount = candles.filter(row => !isValidCandle(row)).length;
    if (invalidCandleCount > 0) {
      res.set('Cache-Control', 'no-store');
      return res.status(502).json({
        ok: false,
        error: 'FYERS returned invalid or incomplete OHLC candle rows; analysis blocked.',
        detail: 'No partial candle set was returned because invalid rows must not be silently discarded.',
        invalidCandleCount
      });
    }
    for (let i = 1; i < candles.length; i++) {
      if (Number(candles[i][0]) <= Number(candles[i - 1][0])) {
        res.set('Cache-Control', 'no-store');
        return res.status(502).json({
          ok: false,
          error: 'FYERS candle timestamps are duplicate or non-increasing; analysis blocked.',
          detail: 'No partial candle set was returned because timestamp order must be verified.'
        });
      }
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, symbol, resolution, from: rangeFrom, to: rangeTo, fetchedAt: new Date().toISOString(), data: candles });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ ok: false, error: error.statusCode === 401 ? 'Connect FYERS to load historical candles.' : 'FYERS historical-candle request failed.', detail: String(error.message || 'Upstream request failed.').slice(0, 220) });
  }
});


app.get('/api/gap-analysis/history', requireDashboardSession, async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const allowed = new Set(['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'NSE:RELIANCE-EQ', 'NSE:TCS-EQ', 'NSE:INFY-EQ']);
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const istNow = new Date(Date.now() + 330 * 60 * 1000);
  const today = istNow.toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 119)).toISOString().slice(0, 10);
  const from = String(req.query.from || defaultFrom);
  const to = String(req.query.to || today);
  const minGapPct = Number(req.query.minGapPct ?? 0.3);
  if (!allowed.has(symbol)) return res.status(400).json({ ok: false, error: 'Unsupported symbol for verified gap analysis.' });
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to || to > today) return res.status(400).json({ ok: false, error: 'Use real calendar dates in YYYY-MM-DD format, ending no later than today (IST).' });
  const spanDays = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
  if (!Number.isFinite(spanDays) || spanDays > 365) return res.status(400).json({ ok: false, error: 'Gap-analysis range must be 365 days or less.' });
  if (!Number.isFinite(minGapPct) || minGapPct < 0 || minGapPct > 20) return res.status(400).json({ ok: false, error: 'Minimum gap must be between 0 and 20%.' });
  try {
    const url = new URL('https://api-t1.fyers.in/data/history');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('resolution', 'D');
    url.searchParams.set('date_format', '1');
    url.searchParams.set('range_from', from);
    url.searchParams.set('range_to', to);
    url.searchParams.set('cont_flag', '1');
    const result = await fyersReadOnlyGet(url);
    const raw = Array.isArray(result.candles) ? result.candles : [];
    if (raw.some(row => !Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(value => Number.isFinite(Number(value))))) {
      return res.status(502).json({ ok: false, error: 'FYERS returned incomplete daily candles; gap analysis blocked.' });
    }
    const bars = raw.map(row => {
      const [timestamp, open, high, low, close, volume] = row.map(Number);
      const valid = timestamp > 0 && open > 0 && high >= Math.max(open, low, close) && low > 0 && low <= Math.min(open, high, close) && close > 0 && volume >= 0;
      return { timestamp: new Date(timestamp * 1000).toISOString(), open, high, low, close, volume, verified: valid };
    });
    if (bars.some(bar => !bar.verified)) return res.status(502).json({ ok: false, error: 'FYERS OHLC validation failed; no gap result returned.' });
    bars.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (bars.length < 2) return res.status(422).json({ ok: false, error: 'At least two verified daily candles are required.', candleCount: bars.length });
    for (let i = 1; i < bars.length; i++) {
      if (Date.parse(bars[i].timestamp) <= Date.parse(bars[i - 1].timestamp)) {
        return res.status(502).json({ ok: false, error: 'Duplicate or non-increasing daily candle timestamps; gap analysis blocked.' });
      }
    }
    const istDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const completedBars = bars.filter(bar => istDate(bar.timestamp) < today);
    const latest = bars.at(-1);
    const previous = bars.at(-2);
    const latestGap = analyzeOpeningGap({ previousClose: previous.close, todayOpen: latest.open });
    if (completedBars.length < 2) return res.status(422).json({ ok: false, error: 'Two completed sessions are required for historical gap-fill statistics.', candleCount: bars.length, latestSession: { timestamp: latest.timestamp, gap: latestGap } });
    const historical = summarizeHistoricalGaps(completedBars, { minAbsGapPct: minGapPct });
    res.set('Cache-Control', 'no-store').json({
      ok: true, symbol, source: 'FYERS historical daily candles', fetchedAt: new Date().toISOString(),
      range: { from, to }, candleCount: bars.length, completedCandleCount: completedBars.length,
      latestSession: { timestamp: latest.timestamp, previousClose: previous.close, open: latest.open, high: latest.high, low: latest.low, close: latest.close, gap: latestGap,
        note: 'Latest session is shown separately. Historical fill statistics exclude the current IST session.' },
      historical,
      warning: 'Historical gap-fill rate is descriptive, not predictive. It does not create a trade signal or infer participant intent.'
    });
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    return res.status(status).json({ ok: false, error: status === 429 ? 'FYERS historical-data cooldown active; wait before retrying.' : status === 401 ? 'FYERS session expired; reconnect.' : 'Gap analysis could not be verified.', detail: String(error.message || 'Historical data request failed.').slice(0, 220) });
  }
});

const MOVERS_CACHE_TTL_MS = 60000;
const MOVERS_BATCH_SIZE = 50;
let moversSnapshotCache = null;
let moversSnapshotInFlight = null;

// NSE equity-derivatives underlyings, configured from the exchange's published
// F&O list and newer additions. FYERS symbol availability is checked per row;
// missing/renamed contracts are reported as unavailable rather than fabricated.
const configuredMoversSymbols = [
  "NSE:360ONE-EQ", "NSE:ABB-EQ", "NSE:ABCAPITAL-EQ", "NSE:ADANIENSOL-EQ", "NSE:ADANIENT-EQ", "NSE:ADANIGREEN-EQ", "NSE:ADANIPORTS-EQ", "NSE:ADANIPOWER-EQ", "NSE:ALKEM-EQ", "NSE:AMBER-EQ", "NSE:AMBUJACEM-EQ", "NSE:ANGELONE-EQ", "NSE:APLAPOLLO-EQ", "NSE:APOLLOHOSP-EQ", "NSE:APOLLOTYRE-EQ", "NSE:ASHOKLEY-EQ", "NSE:ASIANPAINT-EQ", "NSE:ASTRAL-EQ", "NSE:ATUL-EQ", "NSE:AUBANK-EQ", "NSE:AUROPHARMA-EQ", "NSE:AXISBANK-EQ", "NSE:BAJAJ-AUTO-EQ", "NSE:BAJFINANCE-EQ", "NSE:BAJAJFINSV-EQ", "NSE:BAJAJHLDNG-EQ", "NSE:BALKRISIND-EQ", "NSE:BALRAMCHIN-EQ", "NSE:BANDHANBNK-EQ", "NSE:BANKBARODA-EQ", "NSE:BANKINDIA-EQ", "NSE:BATAINDIA-EQ", "NSE:BERGEPAINT-EQ", "NSE:BEL-EQ", "NSE:BHARATFORG-EQ", "NSE:BHEL-EQ", "NSE:BPCL-EQ", "NSE:BHARTIARTL-EQ", "NSE:BIOCON-EQ", "NSE:BSOFT-EQ", "NSE:BOSCHLTD-EQ", "NSE:BRITANNIA-EQ", "NSE:CANFINHOME-EQ", "NSE:CANBK-EQ", "NSE:CHAMBLFERT-EQ", "NSE:CHOLAFIN-EQ", "NSE:CIPLA-EQ", "NSE:CUB-EQ", "NSE:COALINDIA-EQ", "NSE:COFORGE-EQ", "NSE:COLPAL-EQ", "NSE:CONCOR-EQ", "NSE:COROMANDEL-EQ", "NSE:CROMPTON-EQ", "NSE:CUMMINSIND-EQ", "NSE:DABUR-EQ", "NSE:DALBHARAT-EQ", "NSE:DEEPAKNTR-EQ", "NSE:DELHIVERY-EQ", "NSE:DEVYANI-EQ", "NSE:DLF-EQ", "NSE:LALPATHLAB-EQ", "NSE:DRREDDY-EQ", "NSE:EICHERMOT-EQ", "NSE:ESCORTS-EQ", "NSE:EXIDEIND-EQ", "NSE:GAIL-EQ", "NSE:GLENMARK-EQ", "NSE:GMRINFRA-EQ", "NSE:GODREJCP-EQ", "NSE:GODREJPROP-EQ", "NSE:GRANULES-EQ", "NSE:GRASIM-EQ", "NSE:GUJGASLTD-EQ", "NSE:HAVELLS-EQ", "NSE:HCLTECH-EQ", "NSE:HDFCAMC-EQ", "NSE:HDFCBANK-EQ", "NSE:HDFCLIFE-EQ", "NSE:HEROMOTOCO-EQ", "NSE:HINDALCO-EQ", "NSE:HAL-EQ", "NSE:HINDCOPPER-EQ", "NSE:HINDPETRO-EQ", "NSE:HINDUNILVR-EQ", "NSE:ICICIBANK-EQ", "NSE:ICICIGI-EQ", "NSE:ICICIPRULI-EQ", "NSE:IDFCFIRSTB-EQ", "NSE:INDIAMART-EQ", "NSE:IEX-EQ", "NSE:IOC-EQ", "NSE:IRCTC-EQ", "NSE:IGL-EQ", "NSE:INDUSTOWER-EQ", "NSE:INDUSINDBK-EQ", "NSE:NAUKRI-EQ", "NSE:INFY-EQ", "NSE:INTELLECT-EQ", "NSE:INDIGO-EQ", "NSE:IPCALAB-EQ", "NSE:ITC-EQ", "NSE:JINDALSTEL-EQ", "NSE:JKCEMENT-EQ", "NSE:JSWSTEEL-EQ", "NSE:JUBLFOOD-EQ", "NSE:KOTAKBANK-EQ", "NSE:LTTS-EQ", "NSE:LTIM-EQ", "NSE:LT-EQ", "NSE:LAURUSLABS-EQ", "NSE:LICHSGFIN-EQ", "NSE:LUPIN-EQ", "NSE:MGL-EQ", "NSE:M&MFIN-EQ", "NSE:M&M-EQ", "NSE:MANAPPURAM-EQ", "NSE:MARICO-EQ", "NSE:MARUTI-EQ", "NSE:MFSL-EQ", "NSE:METROPOLIS-EQ", "NSE:MOTHERSON-EQ", "NSE:MPHASIS-EQ", "NSE:MRF-EQ", "NSE:MCX-EQ", "NSE:MUTHOOTFIN-EQ", "NSE:NATIONALUM-EQ", "NSE:NAVINFLUOR-EQ", "NSE:NESTLEIND-EQ", "NSE:NMDC-EQ", "NSE:NTPC-EQ", "NSE:OBEROIRLTY-EQ", "NSE:ONGC-EQ", "NSE:OFSS-EQ", "NSE:PAGEIND-EQ", "NSE:PERSISTENT-EQ", "NSE:PETRONET-EQ", "NSE:PIIND-EQ", "NSE:PIDILITIND-EQ", "NSE:PEL-EQ", "NSE:POLYCAB-EQ", "NSE:PFC-EQ", "NSE:POWERGRID-EQ", "NSE:PNB-EQ", "NSE:PVRINOX-EQ", "NSE:RAIN-EQ", "NSE:RBLBANK-EQ", "NSE:RECLTD-EQ", "NSE:RELIANCE-EQ", "NSE:SBICARD-EQ", "NSE:SBILIFE-EQ", "NSE:SHREECEM-EQ", "NSE:SHRIRAMFIN-EQ", "NSE:SIEMENS-EQ", "NSE:SRF-EQ", "NSE:SBIN-EQ", "NSE:SAIL-EQ", "NSE:SUNPHARMA-EQ", "NSE:SUNTV-EQ", "NSE:SYNGENE-EQ", "NSE:TATACHEM-EQ", "NSE:TATACOMM-EQ", "NSE:TCS-EQ", "NSE:TATACONSUM-EQ", "NSE:TATAMOTORS-EQ", "NSE:TATAPOWER-EQ", "NSE:TATASTEEL-EQ", "NSE:TECHM-EQ", "NSE:FEDERALBNK-EQ", "NSE:INDHOTEL-EQ", "NSE:RAMCOCEM-EQ", "NSE:TITAN-EQ", "NSE:TORNTPHARM-EQ", "NSE:TRENT-EQ", "NSE:TVSMOTOR-EQ", "NSE:ULTRACEMCO-EQ", "NSE:UBL-EQ", "NSE:MCDOWELL-N-EQ", "NSE:UPL-EQ", "NSE:VEDL-EQ", "NSE:IDEA-EQ", "NSE:VOLTAS-EQ", "NSE:WHIRLPOOL-EQ", "NSE:WIPRO-EQ", "NSE:ZEEL-EQ", "NSE:ZYDUSLIFE-EQ", "NSE:ANANDRATHI-EQ", "NSE:ATHERENERG-EQ", "NSE:DMART-EQ", "NSE:BSE-EQ", "NSE:BLUESTARCO-EQ", "NSE:MAHABANK-EQ", "NSE:BDL-EQ", "NSE:ETERNAL-EQ", "NSE:SWIGGY-EQ", "NSE:HYUNDAI-EQ", "NSE:OLAELEC-EQ", "NSE:INOXWIND-EQ", "NSE:IREDA-EQ", "NSE:HUDCO-EQ", "NSE:PRESTIGE-EQ", "NSE:UNOMINDA-EQ", "NSE:TIINDIA-EQ", "NSE:SONACOMS-EQ", "NSE:INDIANB-EQ", "NSE:MAZDOCK-EQ", "NSE:COCHINSHIP-EQ", "NSE:GRSE-EQ", "NSE:IRFC-EQ", "NSE:RVNL-EQ", "NSE:RAILTEL-EQ", "NSE:NBCC-EQ", "NSE:IRCON-EQ", "NSE:RITES-EQ", "NSE:POWERINDIA-EQ", "NSE:SUZLON-EQ", "NSE:NYKAA-EQ", "NSE:LODHA-EQ", "NSE:PHOENIXLTD-EQ", "NSE:MAXHEALTH-EQ", "NSE:MEDANTA-EQ", "NSE:NUVAMA-EQ", "NSE:KFINTECH-EQ", "NSE:CAMS-EQ", "NSE:CDSL-EQ", "NSE:LICI-EQ", "NSE:IDBI-EQ", "NSE:UNIONBANK-EQ", "NSE:CESC-EQ", "NSE:HFCL-EQ", "NSE:YESBANK-EQ", "NSE:INDIANHOTEL-EQ", "NSE:JKLAKSHMI-EQ", "NSE:KEI-EQ", "NSE:KEC-EQ", "NSE:ACC-EQ", "NSE:ABBOTTINDIA-EQ", "NSE:AARTIIND-EQ", "NSE:ABFRL-EQ", "NSE:DIXON-EQ", "NSE:GNFC-EQ"
];
let moversSymbols = [...configuredMoversSymbols];
let moversUniverseSource = 'configured-fallback';
let moversMasterUpdatedAt = null;
let moversMasterNextRefreshAt = 0;
let moversMasterRefreshInFlight = null;
const MOVERS_MASTER_REFRESH_MS = 24 * 60 * 60 * 1000;
const MOVERS_MASTER_RETRY_MS = 5 * 60 * 1000;

// Refresh the stock universe from FYERS' daily symbol masters. Keep the known
// list as a safe fallback if either master is unavailable or validation fails.
async function refreshMoversUniverse() {
  if (Date.now() < moversMasterNextRefreshAt) return;
  if (moversMasterRefreshInFlight) return moversMasterRefreshInFlight;

  moversMasterRefreshInFlight = (async () => {
    try {
      const [foResponse, cmResponse] = await Promise.all([
        fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json', { signal: AbortSignal.timeout(12000) }),
        fetch('https://public.fyers.in/sym_details/NSE_CM_sym_master.json', { signal: AbortSignal.timeout(12000) })
      ]);
      if (!foResponse.ok || !cmResponse.ok) throw new Error('FYERS symbol master download failed.');
      const [foMaster, cmMaster] = await Promise.all([foResponse.json(), cmResponse.json()]);
      if (!foMaster || typeof foMaster !== 'object' || !cmMaster || typeof cmMaster !== 'object') {
        throw new Error('FYERS symbol master format was invalid.');
      }

      const cashSymbols = new Map();
      for (const [ticker, item] of Object.entries(cmMaster)) {
        const match = /^NSE:([A-Z0-9&-]+)-EQ$/.exec(ticker);
        if (match && item?.tradeStatus !== 0) cashSymbols.set(match[1], ticker);
      }

      const underlyingSymbols = new Set();
      for (const [ticker, item] of Object.entries(foMaster)) {
        if (!ticker.startsWith('NSE:') || item?.tradeStatus === 0) continue;
        const isOption = item?.optType === 'CE' || item?.optType === 'PE';
        const isFuture = /FUT$/.test(ticker);
        if (!isOption && !isFuture) continue;
        const underlying = String(item?.underSym || '').trim().toUpperCase();
        if (underlying && cashSymbols.has(underlying)) underlyingSymbols.add(underlying);
      }

      const dynamicSymbols = [...underlyingSymbols]
        .map(symbol => cashSymbols.get(symbol))
        .sort();
      // A suspiciously small master should never replace the known fallback.
      if (dynamicSymbols.length < 180) {
        throw new Error('FYERS symbol master validation failed: too few NSE F&O equity underlyings.');
      }

      const previousSymbols = moversSymbols.join(',');
      moversSymbols = dynamicSymbols;
      moversUniverseSource = 'FYERS_NSE_FO_SYMBOL_MASTER';
      moversMasterUpdatedAt = new Date().toISOString();
      moversMasterNextRefreshAt = Date.now() + MOVERS_MASTER_REFRESH_MS;
      if (previousSymbols !== moversSymbols.join(',')) moversSnapshotCache = null;
      console.log('FYERS NSE F&O universe refreshed:', JSON.stringify({
        symbols: moversSymbols.length,
        source: moversUniverseSource,
        updatedAt: moversMasterUpdatedAt
      }));
    } catch (error) {
      moversMasterNextRefreshAt = Date.now() + MOVERS_MASTER_RETRY_MS;
      console.warn('FYERS symbol master refresh failed; using last valid universe:', String(error?.message || error).slice(0, 180));
    }
  })();

  try {
    await moversMasterRefreshInFlight;
  } finally {
    moversMasterRefreshInFlight = null;
  }
}
app.get('/api/market/movers', async (_req, res) => {
  if (!accessToken) return res.status(401).json({ ok: false, error: 'Connect FYERS first to load market movers.' });

  await refreshMoversUniverse();
  if (moversSnapshotCache && Date.now() - moversSnapshotCache.cachedAt < MOVERS_CACHE_TTL_MS) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ...moversSnapshotCache.payload, cached: true });
  }
  try {
    if (!moversSnapshotInFlight) {
      moversSnapshotInFlight = (async () => {
        const quoteFetchedAt = new Date().toISOString();
        const marketOpen = nseRegularSessionNow();
        const quoteItems = [];
        const failedBatches = [];
        let batchRateLimitError = null;
        // Keep each request within the 50-symbol Quotes API limit and avoid
        // parallel bursts that can trigger FYERS 429 cooldowns.
        for (let offset = 0; offset < moversSymbols.length; offset += MOVERS_BATCH_SIZE) {
          const batch = moversSymbols.slice(offset, offset + MOVERS_BATCH_SIZE);
          try {
            const url = new URL('https://api-t1.fyers.in/data/quotes');
            url.searchParams.set('symbols', batch.join(','));
            const result = await fyersReadOnlyGet(url);
            const quotes = Array.isArray(result.d) ? result.d : (Array.isArray(result.data) ? result.data : []);
            quoteItems.push(...quotes);
            const returned = new Set(quotes.map(item => item && (item.n || item.symbol || item.v?.symbol)).filter(Boolean));
            failedBatches.push(...batch.filter(symbol => !returned.has(symbol)));
            if (offset + MOVERS_BATCH_SIZE < moversSymbols.length) {
              // Space provider quote batches conservatively to reduce HTTP 429 / Cloudflare throttling.
              await new Promise(resolve => setTimeout(resolve, 1250));
            }
          } catch (error) {
            failedBatches.push(...batch);
            // A 429 means this endpoint is in cooldown; stop immediately rather
            // than issuing more requests that cannot succeed.
            if (Number(error.statusCode) === 429) {
              batchRateLimitError = error;
              break;
            }
          }
        }
        const received = new Set();
        const rows = quoteItems.map(item => {
          const value = item && (item.v || item);
          const symbol = item && (item.n || item.symbol || value?.symbol);
          const price = Number(value && (value.lp ?? value.ltp));
          const previousCloseRaw = value && (value.prev_close_price ?? value.prev_close ?? value.pc);
          const previousClose = Number(previousCloseRaw);
          const rawChange = value?.ch == null ? NaN : Number(value.ch);
          const rawChangePct = value?.chp == null ? NaN : Number(value.chp);
          const hasPreviousClose = Number.isFinite(previousClose) && previousClose > 0;
          const change = Number.isFinite(rawChange) ? rawChange : (hasPreviousClose && Number.isFinite(price) ? price - previousClose : null);
          const changePct = Number.isFinite(rawChangePct) ? rawChangePct : (hasPreviousClose && Number.isFinite(price) ? ((price - previousClose) / previousClose) * 100 : null);
          const tradedAtEpoch = epochSeconds(value && (value.tt ?? value.exch_feed_time ?? value.last_traded_time ?? value.ltt));
          if (!moversSymbols.includes(symbol) || (item.s && item.s !== 'ok') ||
              !Number.isFinite(price) || price <= 0) return null;
          received.add(symbol);
          const rawQuoteAgeSeconds = tradedAtEpoch
            ? Math.floor(Date.now() / 1000) - tradedAtEpoch
            : null;
          const quoteAgeSeconds = rawQuoteAgeSeconds === null ? null : Math.max(0, rawQuoteAgeSeconds);
          // A successful HTTP response is not proof that the underlying quote is fresh.
          // Missing, future-dated, or old exchange timestamps must never be called live.
          const priceStatus = !marketOpen
            ? 'LAST_KNOWN_PRICE'
            : (!tradedAtEpoch || rawQuoteAgeSeconds < 0
              ? 'TIME_UNVERIFIED'
              : (rawQuoteAgeSeconds <= 180 ? 'LIVE_QUOTE' : 'STALE_QUOTE'));
          return {
            symbol, price,
            change: Number.isFinite(change) ? change : null,
            changePct: Number.isFinite(changePct) ? changePct : null,
            previousClose: hasPreviousClose ? previousClose : null,
            priceAsOf: tradedAtEpoch ? new Date(tradedAtEpoch * 1000).toISOString() : null,
            quoteAgeSeconds,
            quoteFetchedAt,
            marketSession: marketOpen ? 'OPEN' : 'CLOSED',
            priceStatus
          };
        }).filter(Boolean);
        if (!rows.length) {
          if (batchRateLimitError) throw batchRateLimitError;
          throw new Error('FYERS returned no valid verified equity quote rows.');
        }
        return {
          ok: true, fetchedAt: quoteFetchedAt, marketSession: marketOpen ? 'OPEN' : 'CLOSED',
          universe: moversUniverseSource === 'FYERS_NSE_FO_SYMBOL_MASTER' ? 'FYERS-NSE-FO-symbol-master' : 'configured-NSE-F&O-equities-fallback',
          universeUpdatedAt: moversMasterUpdatedAt,
          requestedSymbols: moversSymbols.length, receivedSymbols: rows.length,
          partial: rows.length < moversSymbols.length || failedBatches.length > 0,
          failedSymbols: [...new Set([...moversSymbols.filter(symbol => !received.has(symbol)), ...failedBatches])],
          data: rows
        };
      })();
    }
    const payload = await moversSnapshotInFlight;
    moversSnapshotCache = { cachedAt: Date.now(), payload };
    res.set('Cache-Control', 'no-store');
    return res.json(payload);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502;
    return res.status(statusCode).json({
      ok: false,
      error: statusCode === 429 ? 'FYERS quote rate limit reached. Wait briefly before refreshing.' : 'FYERS did not return a verified stock-quote snapshot.',
      detail: String(error.message || 'FYERS quote request failed.').slice(0, 220),
      requestedSymbols: moversSymbols.length
    });
  } finally {
    moversSnapshotInFlight = null;
  }
});
app.get('/api/fyers/options-chain', async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const allowed = [...allowedSymbols, ...moversSymbols];
  const strikeCount = Number.parseInt(String(req.query.strikecount || '10'), 10);
  const timestamp = req.query.timestamp == null ? '' : String(req.query.timestamp);
  if (!allowed.includes(symbol)) return res.status(400).json({ ok: false, error: 'Unsupported underlying symbol.' });
  if (!Number.isInteger(strikeCount) || strikeCount < 1 || strikeCount > 50) {
    return res.status(400).json({ ok: false, error: 'strikecount must be between 1 and 50.' });
  }
  if (timestamp && !/^\d{9,12}$/.test(timestamp)) {
    return res.status(400).json({ ok: false, error: 'Invalid expiry timestamp.' });
  }
  try {
    const url = new URL('https://api-t1.fyers.in/data/options-chain-v3');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('strikecount', String(strikeCount));
    url.searchParams.set('greeks', '1');
    if (timestamp) url.searchParams.set('timestamp', timestamp);
    const result = await fyersReadOnlyGet(url);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, fetchedAt: new Date().toISOString(), data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view option-chain data.' : 'FYERS option-chain request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/option-quote', async (req, res) => {
  const symbol = String(req.query.symbol || '');
  // Read-only single-contract quote; this endpoint never places orders.
  if (!/^NSE:[A-Z0-9&-]{3,48}$/.test(symbol) || !/(CE|PE)$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: 'Invalid NSE option contract symbol.' });
  }
  try {
    const url = new URL('https://api-t1.fyers.in/data/quotes');
    url.searchParams.set('symbols', symbol);
    const result = await fyersReadOnlyGet(url);
    const rows = Array.isArray(result.d) ? result.d : (Array.isArray(result.data) ? result.data : []);
    const row = rows.find(item => (item?.n || item?.symbol || item?.v?.symbol) === symbol);
    const v = row?.v || row;
    const ltp = Number(v?.lp ?? v?.ltp);
    const bid = Number(v?.bid ?? v?.bid_price);
    const ask = Number(v?.ask ?? v?.ask_price);
    const rawTime = v?.ltt ?? v?.tt ?? v?.exch_feed_time;
    const n = Number(rawTime);
    const quoteTimeMs = Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : Date.parse(String(rawTime || ''));
    const ageMs = Date.now() - quoteTimeMs;
    if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(bid) || bid <= 0 ||
        !Number.isFinite(ask) || ask < bid || !Number.isFinite(quoteTimeMs) ||
        ageMs < -5000 || ageMs > 15000) {
      return res.status(502).json({ ok: false, error: 'Selected option contract quote is missing, stale, or invalid; no signal.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, symbol, quote: { ltp, bid, ask, quoteTimeMs, quoteAgeSeconds: Math.max(0, ageMs / 1000) } });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to verify the selected option quote.' : 'Selected option quote verification failed.',
      detail: String(error.message || 'FYERS quote request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/holdings', async (_req, res) => {
  try {
    const result = await fyersReadOnlyGet('https://api-t1.fyers.in/api/v3/holdings');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, fetchedAt: new Date().toISOString(), data: result });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view holdings.' : 'FYERS holdings request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/positions', async (_req, res) => {
  try {
    const result = await fyersReadOnlyGet('https://api-t1.fyers.in/api/v3/positions');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, fetchedAt: new Date().toISOString(), data: result });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view positions.' : 'FYERS positions request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});

app.all('/api/orders/*', (_req, res) => {
  res.status(403).json({ error: 'Order placement is disabled during testing.' });
});

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  res.status(500).json({ error: 'Unexpected backend error.' });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`DhanPulse backend listening on ${port}`);
});
