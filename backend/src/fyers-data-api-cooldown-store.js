import pg from 'pg';

const { Pool } = pg;
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS dhanpulse_fyers_data_api_cooldown (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    blocked_until TIMESTAMPTZ NOT NULL,
    cooldown_reason TEXT NOT NULL,
    blocked_pathname TEXT NOT NULL,
    consecutive_cloudflare_blocks INTEGER NOT NULL DEFAULT 0,
    consecutive_rate_limit_blocks INTEGER NOT NULL DEFAULT 0,
    cooldown_generation INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

export function createFyersDataApiCooldownStore({ databaseUrl } = {}) {
  const connectionString = String(databaseUrl || '').trim();
  const configured = Boolean(connectionString);
  if (configured && !(connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  const pool = configured ? new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'dhanpulse-fyers-data-api-cooldown'
  }) : null;

  return {
    configured,
    async initialize() {
      if (!configured) return null;
      await pool.query(TABLE_SQL);
      const result = await pool.query(`
        SELECT blocked_until, cooldown_reason, blocked_pathname,
          consecutive_cloudflare_blocks, consecutive_rate_limit_blocks,
          cooldown_generation
        FROM dhanpulse_fyers_data_api_cooldown WHERE id = 1
      `);
      if (!result.rows.length) return null;
      const row = result.rows[0];
      return {
        cooldownUntil: new Date(row.blocked_until).getTime(),
        cooldownReason: row.cooldown_reason,
        cooldownPathname: row.blocked_pathname,
        consecutiveCloudflareBlocks: Number(row.consecutive_cloudflare_blocks) || 0,
        consecutiveRateLimitBlocks: Number(row.consecutive_rate_limit_blocks) || 0,
        cooldownGeneration: Number(row.cooldown_generation) || 0
      };
    },
    async save(state) {
      if (!configured) return;
      await pool.query(`
        INSERT INTO dhanpulse_fyers_data_api_cooldown
          (id, blocked_until, cooldown_reason, blocked_pathname,
           consecutive_cloudflare_blocks, consecutive_rate_limit_blocks,
           cooldown_generation, updated_at)
        VALUES (1, $1::timestamptz, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          blocked_until = EXCLUDED.blocked_until,
          cooldown_reason = EXCLUDED.cooldown_reason,
          blocked_pathname = EXCLUDED.blocked_pathname,
          consecutive_cloudflare_blocks = EXCLUDED.consecutive_cloudflare_blocks,
          consecutive_rate_limit_blocks = EXCLUDED.consecutive_rate_limit_blocks,
          cooldown_generation = EXCLUDED.cooldown_generation,
          updated_at = NOW()
      `, [
        new Date(state.cooldownUntil).toISOString(), state.cooldownReason,
        state.cooldownPathname, state.consecutiveCloudflareBlocks,
        state.consecutiveRateLimitBlocks, state.cooldownGeneration
      ]);
    },
    async clear() {
      if (configured) await pool.query('DELETE FROM dhanpulse_fyers_data_api_cooldown WHERE id = 1');
    },
    async close() {
      if (pool) await pool.end();
    }
  };
}
