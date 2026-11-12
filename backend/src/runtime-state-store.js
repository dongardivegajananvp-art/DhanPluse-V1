import pg from 'pg';

const { Pool } = pg;
const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS gv2vpd_runtime_state (
  state_key TEXT PRIMARY KEY,
  state_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function createRuntimeStateStore({ databaseUrl, PoolClass = Pool }) {
  const configured = /^postgres(?:ql)?:\\/\\//i.test(String(databaseUrl || '').trim());
  const pool = configured ? new PoolClass({
    connectionString: String(databaseUrl).trim(),
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'gv2vpd-runtime-state'
  }) : null;
  if (pool && typeof pool.on === 'function') {
    pool.on('error', error => {
      console.error('PostgreSQL idle connection error in runtime state store:', String(error?.message || error).slice(0, 160));
    });
  }
  return {
    configured,
    async initialize() {
      if (!pool) throw new Error('PostgreSQL is required for durable runtime state.');
      await pool.query(TABLE_SQL);
    },
    async load(key) {
      if (!pool) throw new Error('Runtime state store is unavailable.');
      const result = await pool.query(
        'SELECT state_value FROM gv2vpd_runtime_state WHERE state_key = $1',
        [String(key)]
      );
      const value = result.rows?.[0]?.state_value;
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return null; }
      }
      return value ?? null;
    },
    async save(key, value) {
      if (!pool) throw new Error('Runtime state store is unavailable.');
      await pool.query(
        `INSERT INTO gv2vpd_runtime_state (state_key, state_value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (state_key) DO UPDATE SET
           state_value = EXCLUDED.state_value, updated_at = NOW()`,
        [String(key), JSON.stringify(value)]
      );
      return true;
    },
    async delete(key) {
      if (!pool) throw new Error('Runtime state store is unavailable.');
      await pool.query('DELETE FROM gv2vpd_runtime_state WHERE state_key = $1', [String(key)]);
    },
    async close() { if (pool) await pool.end(); }
  };
}
