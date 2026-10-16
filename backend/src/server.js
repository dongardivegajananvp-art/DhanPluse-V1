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
let marketSocket = null;
let streamConnected = false;
let streamError = '';
const latestTicks = new Map();

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
      try {
        socket.subscribe(allowedSymbols);
        socket.mode(socket.LiteMode);
      } catch {
        streamError = 'Could not subscribe to FYERS index symbols.';
      }
    });

    socket.on('message', message => {
      if (marketSocket !== socket) return;
      parseTick(message);
    });

    socket.on('error', () => {
      if (marketSocket !== socket) return;
      streamError = 'FYERS market data socket reported an error.';
    });

    socket.on('close', () => {
      if (marketSocket !== socket) return;
      streamConnected = false;
    });

    socket.connect();
    if (typeof socket.autoreconnect === 'function') socket.autoreconnect();
  } catch {
    streamConnected = false;
    streamError = 'Could not start the FYERS market data socket.';
  }
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
        ...(tick.ch === null ? {} : { ch: tick.ch }),
        ...(tick.chp === null ? {} : { chp: tick.chp })
      }
    }))
  };
}

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

app.get('/api/fyers/auth/start', (_req, res) => {
  if (!appId || !redirectUri) {
    return res.status(503).json({ error: 'FYERS environment settings are incomplete.' });
  }

  const url = new URL('https://api-t1.fyers.in/api/v3/generate-authcode');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', 'dhanpulse');
  res.json({ authorizationUrl: url.toString() });
});

app.post('/api/fyers/auth/exchange', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';

  if (!appId || !appSecret || !redirectUri) {
    return res.status(503).json({ error: 'FYERS environment settings are incomplete.' });
  }
  if (!code || code.length > 4096) {
    return res.status(400).json({ error: 'Invalid authorization code.' });
  }

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
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.s !== 'ok' || !data.access_token) {
      return res.status(401).json({
        error: 'FYERS authentication failed.',
        detail: data.message || data.error || 'Please check FYERS settings.'
      });
    }

    accessToken = data.access_token;
    authenticatedAt = new Date().toISOString();
    startMarketDataStream(accessToken);

    res.json({
      ok: true,
      fyers: 'connected',
      liveData: 'connecting',
      authenticatedAt
    });
  } catch {
    res.status(502).json({ error: 'Could not reach FYERS authentication service.' });
  }
});

// The dashboard reads the latest WebSocket ticks. This endpoint does not poll
// the FYERS REST Quotes API, avoiding repeated requests and REST rate limits.
app.get('/api/market/quotes', (_req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Connect FYERS first.' });
  }

  const snapshot = liveSnapshot();
  if (!streamConnected || !snapshot) {
    return res.status(503).json({
      error: 'FYERS live market data is not ready yet.',
      detail: streamError || 'Waiting for fresh NIFTY 50 and BANK NIFTY WebSocket ticks.'
    });
  }

  res.set('Cache-Control', 'no-store');
  return res.json(snapshot);
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
