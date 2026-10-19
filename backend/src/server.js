import 'dotenv/config';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

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

    latestTicks.set(symbol, {
      symbol,
      ltp,
      ch: Number.isFinite(Number(item.ch)) ? Number(item.ch) : null,
      chp: Number.isFinite(Number(item.chp)) ? Number(item.chp) : null,
      updatedAt: new Date().toISOString()
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
        socket.subscribe(allowedSymbols);
        socket.mode(socket.LiteMode);
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

    socket.on('close', () => {
      if (marketSocket !== socket) return;
      streamConnected = false;
      console.log('FYERS market socket closed.');
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
  const newestTickAge = Date.now() - Math.min(...ticks.map(tick => Date.parse(tick.updatedAt)));
  if (!Number.isFinite(newestTickAge) || newestTickAge > 120000) return null;

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

// The dashboard reads the latest WebSocket ticks. This endpoint does not poll
// the FYERS REST Quotes API, avoiding repeated requests and REST rate limits.
app.get('/api/market/quotes', async (_req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Connect FYERS first.' });
  }

  const snapshot = liveSnapshot();
  // Keep displaying the most recent verified ticks during a brief socket
  // reconnect. The response explicitly marks them as non-live so the UI can
  // show prices without pretending the stream is currently connected.
  if (snapshot) {
    res.set('Cache-Control', 'no-store');
    return res.json({
      ...snapshot,
      source: streamConnected ? 'websocket' : 'websocket-recent',
      streamConnected
    });
  }

  // WebSocket errors should not blank the dashboard when the same FYERS
  // access token can still read the official Quotes API. Cache for 5 seconds
  // because the frontend polls this endpoint frequently.
  try {
    const now = Date.now();
    if (restQuoteCache && now - restQuoteFetchedAt < 5000) {
      res.set('Cache-Control', 'no-store');
      return res.json(restQuoteCache);
    }

    if (!restQuoteInFlight) {
      const url = new URL('https://api-t1.fyers.in/data/quotes');
      url.searchParams.set('symbols', allowedSymbols.join(','));
      restQuoteInFlight = fyersReadOnlyGet(url).then(result => {
        const rows = Array.isArray(result.d) ? result.d : (Array.isArray(result.data) ? result.data : []);
        const normalized = rows.map(item => {
          const value = item && (item.v || item);
          const symbol = item && (item.n || item.symbol || value.symbol);
          const lp = Number(value && (value.lp ?? value.ltp));
          if (!allowedSymbols.includes(symbol) || !Number.isFinite(lp) || lp <= 0) return null;
          const ch = Number(value.ch);
          const chp = Number(value.chp);
          const tt = epochSeconds(value.tt ?? value.ltt ?? value.last_trade_time);
          return {
            n: symbol,
            v: {
              lp,
              ...(tt ? { tt } : {}),
              ...(Number.isFinite(ch) ? { ch } : {}),
              ...(Number.isFinite(chp) ? { chp } : {})
            }
          };
        }).filter(Boolean);

        if (allowedSymbols.some(symbol => !rows.some(item => (item?.n || item?.symbol || item?.v?.symbol) === symbol)) ||
            allowedSymbols.some(symbol => !normalized.some(item => item.n === symbol))) {
          throw new Error('FYERS Quotes API did not return both configured index symbols.');
        }

        if (nseRegularSessionNow() && normalized.some(item => !item.v.tt || Date.now() - item.v.tt * 1000 > 120000 || item.v.tt * 1000 > Date.now() + 5000)) {
          throw new Error('FYERS Quotes API did not provide a recent exchange trade timestamp for every index. Live signal blocked.');
        }

        const payload = {
          ok: true,
          fetchedAt: new Date().toISOString(),
          source: 'rest-quotes-fallback',
          data: normalized
        };
        restQuoteCache = payload;
        restQuoteFetchedAt = Date.now();
        return payload;
      }).finally(() => {
        restQuoteInFlight = null;
      });
    }

    const fallback = await restQuoteInFlight;
    res.set('Cache-Control', 'no-store');
    return res.json(fallback);
  } catch (error) {
    return res.status(error.statusCode || 503).json({
      error: error.statusCode === 401
        ? 'FYERS rejected the access token. Reconnect FYERS.'
        : 'FYERS WebSocket and Quotes API are not currently returning live data.',
      detail: String(error.message || streamError || 'Waiting for fresh index quotes.').slice(0, 220)
    });
  }
});


async function fyersReadOnlyGet(url) {
  if (!accessToken) {
    const error = new Error('Connect FYERS first.');
    error.statusCode = 401;
    throw error;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: appId + ':' + accessToken, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.s !== 'ok') {
    // Include safe upstream diagnostics (never credentials) so quote failures
    // can be fixed from evidence instead of guessing at permissions or symbols.
    const upstreamMessage = data.message || data.error || data.details;
    const upstreamStatus = String(data.s || 'missing');
    const upstreamCode = data.code == null ? 'n/a' : String(data.code);
    const message = upstreamMessage
      ? String(upstreamMessage).slice(0, 150)
      : 'FYERS API returned no error message.';
    const error = new Error(`FYERS API rejected the request (HTTP ${response.status}, status ${upstreamStatus}, code ${upstreamCode}): ${message}`.slice(0, 220));
    error.statusCode = response.status === 401 || data.code === -16 ? 401 : 502;
    console.warn('FYERS read-only request failed:', JSON.stringify({
      path: url.pathname,
      httpStatus: response.status,
      apiStatus: upstreamStatus,
      apiCode: upstreamCode,
      message
    }));
    throw error;
  }
  return data;
}


app.get('/api/market/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const allowed = new Set([...allowedSymbols, ...moversSymbols]);
  const resolution = String(req.query.resolution || '5');
  const allowedResolutions = new Set(['1', '3', '5', '15', '30', '60', 'D']);
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - (resolution === 'D' ? 29 : 6) * 86400000).toISOString().slice(0, 10);
  const rangeFrom = String(req.query.from || defaultFrom);
  const rangeTo = String(req.query.to || today);
  if (!allowed.has(symbol)) return res.status(400).json({ ok: false, error: 'Unsupported candle symbol.' });
  if (!allowedResolutions.has(resolution)) return res.status(400).json({ ok: false, error: 'Unsupported candle resolution.' });
  if (!datePattern.test(rangeFrom) || !datePattern.test(rangeTo) || rangeFrom > rangeTo) return res.status(400).json({ ok: false, error: 'Use valid YYYY-MM-DD date ranges.' });
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
    const valid = candles.filter(row => Array.isArray(row) && row.length >= 6 && row.slice(0, 5).every(value => Number.isFinite(Number(value))));
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, symbol, resolution, from: rangeFrom, to: rangeTo, fetchedAt: new Date().toISOString(), data: valid });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ ok: false, error: error.statusCode === 401 ? 'Connect FYERS to load historical candles.' : 'FYERS historical-candle request failed.', detail: String(error.message || 'Upstream request failed.').slice(0, 220) });
  }
});

const moversSymbols = ["NSE:RELIANCE-EQ","NSE:HDFCBANK-EQ","NSE:ICICIBANK-EQ","NSE:INFY-EQ","NSE:TCS-EQ","NSE:BHARTIARTL-EQ","NSE:SBIN-EQ","NSE:ITC-EQ","NSE:LT-EQ","NSE:AXISBANK-EQ","NSE:KOTAKBANK-EQ","NSE:BAJFINANCE-EQ","NSE:HINDUNILVR-EQ","NSE:MARUTI-EQ","NSE:SUNPHARMA-EQ","NSE:TATAMOTORS-EQ","NSE:M&M-EQ","NSE:NTPC-EQ","NSE:TATASTEEL-EQ","NSE:POWERGRID-EQ","NSE:ONGC-EQ","NSE:JSWSTEEL-EQ","NSE:ADANIENT-EQ","NSE:ADANIPORTS-EQ","NSE:COALINDIA-EQ","NSE:WIPRO-EQ","NSE:ULTRACEMCO-EQ","NSE:NESTLEIND-EQ","NSE:TITAN-EQ","NSE:BAJAJFINSV-EQ","NSE:ASIANPAINT-EQ","NSE:GRASIM-EQ","NSE:TECHM-EQ","NSE:HCLTECH-EQ","NSE:INDUSINDBK-EQ","NSE:DRREDDY-EQ","NSE:CIPLA-EQ","NSE:EICHERMOT-EQ","NSE:TRENT-EQ","NSE:BEL-EQ","NSE:SHRIRAMFIN-EQ","NSE:APOLLOHOSP-EQ","NSE:DIVISLAB-EQ","NSE:BPCL-EQ","NSE:HINDALCO-EQ","NSE:TATACONSUM-EQ","NSE:HEROMOTOCO-EQ","NSE:BRITANNIA-EQ","NSE:SBILIFE-EQ","NSE:LTIM-EQ"];

app.get('/api/market/movers', async (_req, res) => {
  if (!accessToken) return res.status(401).json({ ok: false, error: 'Connect FYERS first to load market movers.' });

  // Keep requests small so one invalid/unavailable instrument does not make
  // the entire selected-stock snapshot fail. All values still come from FYERS.
  const batches = [];
  for (let i = 0; i < moversSymbols.length; i += 10) batches.push(moversSymbols.slice(i, i + 10));

  const settled = await Promise.allSettled(batches.map(async (symbols) => {
    const url = new URL('https://api-t1.fyers.in/data/quotes');
    url.searchParams.set('symbols', symbols.join(','));
    const result = await fyersReadOnlyGet(url);
    const quotes = Array.isArray(result.d) ? result.d : (Array.isArray(result.data) ? result.data : []);
    return quotes.map(item => {
      const value = item && (item.v || item);
      const symbol = item && (item.n || item.symbol || value.symbol);
      const price = Number(value.lp ?? value.ltp);
      const change = Number(value.ch);
      const changePct = Number(value.chp);
      if (!symbols.includes(symbol) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct)) return null;
      return { symbol, price, change: Number.isFinite(change) ? change : null, changePct };
    }).filter(Boolean);
  }));

  const rows = [];
  const failedBatches = [];
  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') rows.push(...item.value);
    else {
      const reason = String(item.reason?.message || 'FYERS quote request failed.').slice(0, 160);
      failedBatches.push({ batch: index + 1, error: reason });
      console.warn('FYERS market-mover batch failed:', index + 1, reason);
    }
  });

  if (!rows.length) {
    const firstError = failedBatches[0]?.error || 'FYERS returned no valid equity quote rows.';
    return res.status(502).json({
      ok: false,
      error: 'FYERS did not return a verified stock-quote snapshot.',
      detail: firstError,
      failedBatches: failedBatches.length,
      requestedSymbols: moversSymbols.length
    });
  }

  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    universe: 'selected-large-cap-NSE',
    requestedSymbols: moversSymbols.length,
    receivedSymbols: rows.length,
    partial: failedBatches.length > 0 || rows.length < moversSymbols.length,
    failedBatches,
    data: rows
  });
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
