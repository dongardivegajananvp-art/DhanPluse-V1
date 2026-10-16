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

// FYERS REST quotes can be rate-limited. Cache successful responses briefly,
// coalesce concurrent requests, and respect upstream 429 responses.
const quoteCache = new Map();
const quoteInflight = new Map();
let quotesRateLimitedUntil = 0;

app.get('/api/market/quotes', async (req, res) => {
  if (!accessToken) {
    return res.status(401).json({ error: 'Connect FYERS first.' });
  }

  const allowedSymbols = new Set([
    'NSE:NIFTY50-INDEX',
    'NSE:NIFTYBANK-INDEX'
  ]);

  const symbols = [...new Set(String(
    req.query.symbols || 'NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX'
  )
    .split(',')
    .map(s => s.trim())
    .filter(s => allowedSymbols.has(s)))].sort();

  if (!symbols.length) {
    return res.status(400).json({ error: 'No supported symbols requested.' });
  }

  const cacheKey = symbols.join(',');
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);

  if (cached && now - cached.savedAt < 5000) {
    res.set('Cache-Control', 'no-store');
    return res.json({ ...cached.payload, cached: true });
  }

  if (now < quotesRateLimitedUntil) {
    const retryAfterSeconds = Math.max(1, Math.ceil((quotesRateLimitedUntil - now) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'FYERS quote requests are temporarily rate-limited.',
      detail: 'The backend is cooling down to avoid repeated requests.',
      retryAfterSeconds
    });
  }

  try {
    let pending = quoteInflight.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const url = new URL('https://api-t1.fyers.in/data/quotes');
        url.searchParams.set('symbols', symbols.join(','));

        const response = await fetch(url, {
          headers: {
            Authorization: `${appId}:${accessToken}`,
            Accept: 'application/json'
          }
        });

        const data = await response.json().catch(() => ({}));

        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          let retryMs = 15000;
          if (header) {
            const seconds = Number(header);
            const parsed = Number.isFinite(seconds) && seconds > 0
              ? seconds * 1000
              : Date.parse(header) - Date.now();
            if (Number.isFinite(parsed) && parsed > 0) retryMs = Math.max(retryMs, parsed);
          }
          quotesRateLimitedUntil = Date.now() + Math.min(retryMs, 120000);
          return {
            status: 429,
            body: {
              error: 'FYERS quote requests are temporarily rate-limited.',
              detail: data.message || 'FYERS returned HTTP 429.',
              retryAfterSeconds: Math.ceil((quotesRateLimitedUntil - Date.now()) / 1000)
            }
          };
        }

        if (!response.ok || data.s !== 'ok') {
          if (response.status === 401) accessToken = '';
          return {
            status: 502,
            body: {
              error: 'FYERS did not return a verified live quote.',
              detail: data.message || `HTTP ${response.status}`
            }
          };
        }

        const payload = {
          ok: true,
          fetchedAt: new Date().toISOString(),
          data: data.d || []
        };
        quoteCache.set(cacheKey, { savedAt: Date.now(), payload });
        return { status: 200, body: payload };
      })();
      quoteInflight.set(cacheKey, pending);
    }

    const result = await pending;
    res.set('Cache-Control', 'no-store');
    if (result.status === 429) {
      res.set('Retry-After', String(result.body.retryAfterSeconds || 15));
    }
    return res.status(result.status).json(result.body);
  } catch {
    return res.status(502).json({
      error: 'Could not reach FYERS quotes service.'
    });
  } finally {
    quoteInflight.delete(cacheKey);
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
