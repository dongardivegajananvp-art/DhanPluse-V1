import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb' }));

const appId = process.env.FYERS_APP_ID || '';
const appSecret = process.env.FYERS_APP_SECRET || '';
const redirectUri = process.env.FYERS_REDIRECT_URI || '';

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
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed'));
  }
}));

let accessToken = '';
let authenticatedAt = null;

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'dhanpulse-backend',
    fyersConfigured: Boolean(appId && appSecret && redirectUri),
    liveDataConnected: Boolean(accessToken),
    orderPlacementEnabled: false
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    backend: 'online',
    fyers: accessToken ? 'connected' : 'not-connected',
    liveData: accessToken ? 'available-on-request' : 'unavailable',
    authenticatedAt,
    orderPlacement: 'disabled'
  });
});

app.get('/api/fyers/auth/start', (_req, res) => {
  if (!appId || !redirectUri) {
    return res.status(503).json({
      error: 'FYERS environment settings are incomplete.'
    });
  }

  const url = new URL(
    'https://api-t1.fyers.in/api/v3/generate-authcode'
  );

  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', 'dhanpulse');

  res.json({ authorizationUrl: url.toString() });
});

app.post('/api/fyers/auth/exchange', async (req, res) => {
  const code =
    typeof req.body?.code === 'string' ? req.body.code.trim() : '';

  if (!appId || !appSecret || !redirectUri) {
    return res.status(503).json({
      error: 'FYERS environment settings are incomplete.'
    });
  }

  if (!code || code.length > 4096) {
    return res.status(400).json({ error: 'Invalid authorization code.' });
  }

  try {
    const appIdHash = crypto
      .createHash('sha256')
      .update(`${appId}:${appSecret}`)
      .digest('hex');

    const response = await fetch(
      'https://api-t1.fyers.in/api/v3/validate-authcode',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          appIdHash,
          code
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.s !== 'ok' || !data.access_token) {
      return res.status(401).json({
        error: 'FYERS authentication failed.',
        detail: data.message || data.error || 'Please check FYERS settings.'
      });
    }

    accessToken = data.access_token;
    authenticatedAt = new Date().toISOString();

    res.json({ ok: true, fyers: 'connected', authenticatedAt });
  } catch {
    res.status(502).json({
      error: 'Could not reach FYERS authentication service.'
    });
  }
});

app.get('/api/market/quotes', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Connect FYERS first.' });
  }

  const allowedSymbols = new Set([
    'NSE:NIFTY50-INDEX',
    'NSE:NIFTYBANK-INDEX'
  ]);

  const symbols = String(
    req.query.symbols || 'NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX'
  )
    .split(',')
    .map(s => s.trim())
    .filter(s => allowedSymbols.has(s));

  if (!symbols.length) {
    return res.status(400).json({ error: 'No supported symbols requested.' });
  }

  try {
    const url = new URL('https://api-t1.fyers.in/data/quotes');
    url.searchParams.set('symbols', symbols.join(','));

    const response = await fetch(url, {
      headers: {
        Authorization: `${appId}:${accessToken}`,
        Accept: 'application/json'
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.s !== 'ok') {
      if (response.status === 401) accessToken = '';

      return res.status(502).json({
        error: 'FYERS did not return a verified live quote.',
        detail: data.message || `HTTP ${response.status}`
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      data: data.d || []
    });
  } catch {
    res.status(502).json({
      error: 'Could not reach FYERS quotes service.'
    });
  }
});

app.all('/api/orders/*', (_req, res) => {
  res.status(403).json({
    error: 'Order placement is disabled during testing.'
  });
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
