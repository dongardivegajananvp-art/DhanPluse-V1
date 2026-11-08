import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const SESSION_TTL_HOURS = 12;
const OTP_COOLDOWN_MS = 60_000;
const MAX_SENDS_PER_DAY = 5;
const MAX_VERIFY_ATTEMPTS = 5;

export function normalizeIndianMobile(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  const national = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
  if (!/^[6-9][0-9]{9}$/.test(national)) return '';
  return '91' + national;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function maskMobile(mobile) {
  return '+91 ••••••' + mobile.slice(-4);
}

export function createAppAuth({ databaseUrl, msg91AuthKey, msg91OtpTemplateId }) {
  const configured = Boolean(String(databaseUrl || '').trim());
  const msg91Configured = Boolean(String(msg91AuthKey || '').trim() && String(msg91OtpTemplateId || '').trim());
  const pool = configured ? new Pool({
    connectionString: String(databaseUrl).trim(),
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'gv2vpd-app-auth'
  }) : null;

  async function initialize() {
    if (!configured) throw new Error('DATABASE_URL is required for persistent GV2VPD App Login.');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gv2vpd_app_users (
        phone TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS gv2vpd_app_otp_limits (
        phone TEXT PRIMARY KEY,
        last_sent_at TIMESTAMPTZ,
        day_key DATE NOT NULL DEFAULT CURRENT_DATE,
        sends_today INTEGER NOT NULL DEFAULT 0,
        verify_failures INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS gv2vpd_app_sessions (
        token_hash TEXT PRIMARY KEY,
        phone TEXT NOT NULL REFERENCES gv2vpd_app_users(phone) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gv2vpd_app_sessions_expiry_idx ON gv2vpd_app_sessions(expires_at);
    `);
    await pool.query('DELETE FROM gv2vpd_app_sessions WHERE expires_at <= NOW()');
  }

  async function sendOtp(mobileInput) {
    if (!msg91Configured) throw Object.assign(new Error('MSG91 is not configured. Add MSG91_AUTHKEY and MSG91_OTP_TEMPLATE_ID in Render environment variables.'), { status: 503 });
    const mobile = normalizeIndianMobile(mobileInput);
    if (!mobile) throw Object.assign(new Error('Enter a valid 10-digit Indian mobile number.'), { status: 400 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO gv2vpd_app_otp_limits(phone) VALUES($1) ON CONFLICT(phone) DO NOTHING', [mobile]);
      const current = await client.query(
        'SELECT last_sent_at, day_key, sends_today, locked_until, (day_key=CURRENT_DATE) AS same_day FROM gv2vpd_app_otp_limits WHERE phone = $1 FOR UPDATE',
        [mobile]
      );
      const row = current.rows[0];
      const now = Date.now();
      if (row?.locked_until && new Date(row.locked_until).getTime() > now) {
        throw Object.assign(new Error('OTP verification is temporarily locked. Try again later.'), { status: 429 });
      }
      if (row?.last_sent_at && now - new Date(row.last_sent_at).getTime() < OTP_COOLDOWN_MS) {
        throw Object.assign(new Error('Please wait 60 seconds before requesting another OTP.'), { status: 429 });
      }
      const sendsToday = row?.same_day ? Number(row.sends_today || 0) : 0;
      if (sendsToday >= MAX_SENDS_PER_DAY) {
        throw Object.assign(new Error('Daily OTP send limit reached. Try again tomorrow.'), { status: 429 });
      }
      await client.query(
        'UPDATE gv2vpd_app_otp_limits SET last_sent_at=NOW(), sends_today=CASE WHEN day_key=CURRENT_DATE THEN sends_today+1 ELSE 1 END, day_key=CURRENT_DATE, verify_failures=0, locked_until=NULL WHERE phone=$1',
        [mobile]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw error;
    }
    client.release();

    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', String(msg91OtpTemplateId).trim());
    url.searchParams.set('mobile', mobile);
    url.searchParams.set('otp_length', '6');
    url.searchParams.set('otp_expiry', '5');
    let response, payload;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authkey: String(msg91AuthKey).trim(), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({})
      });
      payload = await response.json().catch(() => ({}));
    } catch {
      throw Object.assign(new Error('MSG91 could not be reached. No OTP was confirmed as sent.'), { status: 502 });
    }
    if (!response.ok || payload.type !== 'success') {
      throw Object.assign(new Error('MSG91 did not confirm OTP delivery. Check Authkey, template, DLT and provider account status.'), { status: 502 });
    }
    return { mobile: maskMobile(mobile), expiresInSeconds: 300, resendAfterSeconds: 60 };
  }

  async function verifyOtp(mobileInput, otpInput) {
    if (!msg91Configured) throw Object.assign(new Error('MSG91 is not configured.'), { status: 503 });
    const mobile = normalizeIndianMobile(mobileInput);
    const otp = String(otpInput || '').trim();
    if (!mobile || !/^[0-9]{6}$/.test(otp)) throw Object.assign(new Error('Enter the valid mobile number and 6-digit OTP.'), { status: 400 });

    const limit = await pool.query('SELECT verify_failures, locked_until, last_sent_at FROM gv2vpd_app_otp_limits WHERE phone=$1', [mobile]);
    const row = limit.rows[0];
    if (!row?.last_sent_at) throw Object.assign(new Error('Request an OTP first.'), { status: 400 });
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) throw Object.assign(new Error('OTP verification is locked. Try again later.'), { status: 429 });
    if (Date.now() - new Date(row.last_sent_at).getTime() > 5 * 60_000) throw Object.assign(new Error('OTP expired. Request a new code.'), { status: 400 });

    const url = new URL('https://control.msg91.com/api/v5/otp/verify');
    url.searchParams.set('otp', otp);
    url.searchParams.set('mobile', mobile);
    let response, payload;
    try {
      response = await fetch(url, { headers: { authkey: String(msg91AuthKey).trim(), accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      payload = await response.json().catch(() => ({}));
    } catch {
      throw Object.assign(new Error('MSG91 verification service is unavailable.'), { status: 502 });
    }
    if (!response.ok || payload.type !== 'success') {
      const failures = Number(row.verify_failures || 0) + 1;
      await pool.query(
        'UPDATE gv2vpd_app_otp_limits SET verify_failures=$2, locked_until=CASE WHEN $2 >= $3 THEN NOW()+INTERVAL \'15 minutes\' ELSE locked_until END WHERE phone=$1',
        [mobile, failures, MAX_VERIFY_ATTEMPTS]
      );
      throw Object.assign(new Error(failures >= MAX_VERIFY_ATTEMPTS ? 'Too many incorrect OTP attempts. Login is locked for 15 minutes.' : 'OTP is incorrect or expired.'), { status: 401 });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO gv2vpd_app_users(phone) VALUES($1)
         ON CONFLICT(phone) DO UPDATE SET last_login_at=NOW()`,
        [mobile]
      );
      await client.query('DELETE FROM gv2vpd_app_sessions WHERE phone=$1 OR expires_at<=NOW()', [mobile]);
      await client.query(
        'INSERT INTO gv2vpd_app_sessions(token_hash,phone,expires_at) VALUES($1,$2,$3)',
        [hash(token), mobile, expiresAt]
      );
      await client.query('UPDATE gv2vpd_app_otp_limits SET verify_failures=0, locked_until=NULL WHERE phone=$1', [mobile]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { appSessionToken: token, expiresAt: expiresAt.toISOString(), mobile: maskMobile(mobile) };
  }

  async function validateSession(token) {
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
    const result = await pool.query(
      'SELECT phone, expires_at FROM gv2vpd_app_sessions WHERE token_hash=$1 AND expires_at>NOW()',
      [hash(token)]
    );
    return result.rows[0] ? { phone: result.rows[0].phone, expiresAt: new Date(result.rows[0].expires_at).toISOString() } : null;
  }

  async function revokeSession(token) {
    if (/^[a-f0-9]{64}$/.test(String(token || ''))) await pool.query('DELETE FROM gv2vpd_app_sessions WHERE token_hash=$1', [hash(token)]);
  }

  async function requireSession(req, res, next) {
    if (req.method === 'GET' && req.path === '/status') return next();
    if (req.path.startsWith('/app-auth/')) return next();
    if (req.method === 'GET' && req.path === '/market/fno-universe') return next();
    if (!configured) return res.status(503).json({ ok: false, error: 'GV2VPD App Login storage is not configured. Add DATABASE_URL and restart the backend.' });
    try {
      const token = String(req.get('x-gv2vpd-session') || '');
      const session = await validateSession(token);
      if (!session) return res.status(401).json({ ok: false, error: 'GV2VPD App Login required. Verify your mobile OTP.' });
      req.appUser = session;
      return next();
    } catch (error) {
      console.error('GV2VPD app session validation failed:', error?.message || 'database error');
      return res.status(503).json({ ok: false, error: 'GV2VPD App Login service is temporarily unavailable.' });
    }
  }

  return { configured, msg91Configured, initialize, sendOtp, verifyOtp, validateSession, revokeSession, requireSession, close: async () => { if (pool) await pool.end(); } };
}
