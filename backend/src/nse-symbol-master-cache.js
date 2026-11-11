import pg from 'pg';

const { Pool } = pg;
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS gv2vpd_reference_cache (
    cache_key TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function encode(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return { __gv2vpdType: 'Map', entries: [...item.entries()] };
    if (item instanceof Set) return { __gv2vpdType: 'Set', values: [...item.values()] };
    return item;
  });
}

function decode(value) {
  return JSON.parse(typeof value === 'string' ? value : JSON.stringify(value), (_key, item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.__gv2vpdType === 'Map' && Array.isArray(item.entries)) return new Map(item.entries);
    if (item.__gv2vpdType === 'Set' && Array.isArray(item.values)) return new Set(item.values);
    return item;
  });
}

// This store contains only validated exchange reference metadata. It must never
// be used as a source of prices, candles, quotes, or signal freshness.
export function createNseSymbolMasterCache({ databaseUrl, PoolImpl = Pool } = {}) {
  const configured = Boolean(String(databaseUrl || '').trim());
  if (configured && !/^postgres(?:ql)?:\\/\\//i.test(String(databaseUrl).trim())) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  const pool = configured ? new PoolImpl({
    connectionString: String(databaseUrl).trim(),
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'gv2vpd-nse-reference-cache'
  }) : null;
  let initialized = null;

  async function ensureTable() {
    if (!configured) return false;
    if (!initialized) initialized = pool.query(TABLE_SQL).catch(error => {
      initialized = null;
      throw error;
    });
    await initialized;
    return true;
  }

  return {
    configured,
    async load({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
      if (!configured) return null;
      await ensureTable();
      const result = await pool.query(
        'SELECT payload, fetched_at, EXTRACT(EPOCH FROM (NOW() - fetched_at)) * 1000 AS age_ms FROM gv2vpd_reference_cache WHERE cache_key = $1 LIMIT 1',
        ['nse-fno-cm-v1']
      );
      if (!result.rows.length) return null;
      const row = result.rows[0];
      const ageMs = Math.max(0, Number(row.age_ms) || 0);
      if (ageMs > maxAgeMs) return null;
      const snapshot = decode(row.payload);
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.universe) ||
          !Array.isArray(snapshot.moversSymbols) || !(snapshot.optionContractMaster instanceof Map)) {
        throw new Error('Persisted NSE symbol snapshot failed structural validation.');
      }
      return { snapshot, ageMs, fetchedAt: new Date(row.fetched_at).toISOString() };
    },
    async save(snapshot, { fetchedAt = new Date().toISOString() } = {}) {
      if (!configured) return false;
      if (!snapshot || !Array.isArray(snapshot.universe) ||
          !Array.isArray(snapshot.moversSymbols) || !(snapshot.optionContractMaster instanceof Map)) {
        throw new Error('Refusing to persist an invalid NSE symbol snapshot.');
      }
      await ensureTable();
      await pool.query(
        `INSERT INTO gv2vpd_reference_cache (cache_key, payload, fetched_at, updated_at)
         VALUES ($1, $2::jsonb, $3::timestamptz, NOW())
         ON CONFLICT (cache_key) DO UPDATE SET
           payload = EXCLUDED.payload,
           fetched_at = EXCLUDED.fetched_at,
           updated_at = NOW()`,
        ['nse-fno-cm-v1', encode(snapshot), fetchedAt]
      );
      return true;
    },
    async close() {
      if (pool) await pool.end();
    }
  };
}
