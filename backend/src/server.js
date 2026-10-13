import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { if (!origin || allowed.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed')); } }));
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'dhanpulse-backend', fyersConfigured: Boolean(process.env.FYERS_APP_ID && process.env.FYERS_APP_SECRET), liveDataConnected: false, orderPlacementEnabled: false }));
app.get('/api/status', (_req, res) => res.json({ backend: 'online', fyers: 'not-connected', liveData: 'unavailable', orderPlacement: 'disabled', message: 'Backend health is not proof of FYERS authentication or live data.' }));
app.post('/api/fyers/auth/start', (_req, res) => {
  if (!process.env.FYERS_APP_ID || !process.env.FYERS_REDIRECT_URI) return res.status(503).json({ error: 'FYERS_APP_ID and FYERS_REDIRECT_URI must be configured on the backend.' });
  const url = new URL('https://api-t1.fyers.in/api/v3/generate-authcode');
  url.searchParams.set('client_id', process.env.FYERS_APP_ID);
  url.searchParams.set('redirect_uri', process.env.FYERS_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', 'dhanpulse');
  return res.json({ authorizationUrl: url.toString(), note: 'Validate this URL and the auth-code exchange against current FYERS documentation before production use.' });
});
app.all('/api/market/*', (_req, res) => res.status(503).json({ error: 'Live market-data route is not wired in this starter. No demo values are returned.' }));
app.all('/api/orders/*', (_req, res) => res.status(403).json({ error: 'Order placement is intentionally disabled until authentication, permissions, and risk controls are implemented and reviewed.' }));
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`DhanPulse backend listening on ${port}`));
