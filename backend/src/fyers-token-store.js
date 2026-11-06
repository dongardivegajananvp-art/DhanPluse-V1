import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dhanpulse_fyers_auth (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    encrypted_token TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    authenticated_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
const AAD = Buffer.from('DhanPulse/FYERS/access-token/v1', 'utf8');

function readEncryptionKey(value) {
  const raw = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error('FYERS_TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  }
  return Buffer.from(raw, 'hex');
}

export function createFyersTokenStore({ databaseUrl, encryptionKey }) {
  const configured = Boolean(String(databaseUrl || '').trim() && String(encryptionKey || '').trim());
  let pool = null;
  let key = null;

  if (configured) {
    if (!/^postgres(?:ql)?:\/\//i.test(String(databaseUrl).trim())) {
      throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
    }
    key = readEncryptionKey(encryptionKey);
    pool = new Pool({
      connectionString: String(databaseUrl).trim(),
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      application_name: 'dhanpulse-fyers-token-store'
    });
  }

  function encrypt(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
      encryptedToken: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64')
    };
  }

  function decrypt(row) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_token, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  return {
    configured,
    async initialize() {
      if (!configured) throw new Error('Token persistence is not configured.');
      await pool.query(TABLE_SQL);
      const result = await pool.query(
        'SELECT encrypted_token, iv, auth_tag, authenticated_at FROM dhanpulse_fyers_auth WHERE id = 1'
      );
      if (!result.rows.length) return null;
      const row = result.rows[0];
      return {
        accessToken: decrypt(row),
        authenticatedAt: new Date(row.authenticated_at).toISOString()
      };
    },
    async save(accessToken, authenticatedAt) {
      if (!configured) throw new Error('Token persistence is not configured.');
      if (typeof accessToken !== 'string' || !accessToken.trim()) {
        throw new Error('Refusing to persist an empty FYERS access token.');
      }
      const encrypted = encrypt(accessToken.trim());
      await pool.query(
        `INSERT INTO dhanpulse_fyers_auth
          (id, encrypted_token, iv, auth_tag, authenticated_at, updated_at)
         VALUES (1, $1, $2, $3, $4::timestamptz, NOW())
         ON CONFLICT (id) DO UPDATE SET
           encrypted_token = EXCLUDED.encrypted_token,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           authenticated_at = EXCLUDED.authenticated_at,
           updated_at = NOW()`,
        [encrypted.encryptedToken, encrypted.iv, encrypted.authTag, authenticatedAt]
      );
    },
    async clear() {
      if (!configured) return;
      await pool.query('DELETE FROM dhanpulse_fyers_auth WHERE id = 1');
    },
    async close() {
      if (pool) await pool.end();
    }
  };
}
