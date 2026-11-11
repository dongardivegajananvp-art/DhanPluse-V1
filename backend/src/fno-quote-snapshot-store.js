import pg from 'pg';
import { isCompleteFreshFnoQuoteSnapshot } from './fno-quote-snapshot.js';

const { Pool } = pg;
const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS gv2vpd_fno_quote_snapshots (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  universe_symbols JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  snapshot_exchange_time TIMESTAMPTZ NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols) || !symbols.length ||
      symbols.some(symbol => typeof symbol !== 'string' || !symbol.trim()) ||
      new Set(symbols).size !== symbols.length) return null;
  return symbols;
}

export function createFnoQuoteSnapshotStore({ databaseUrl, PoolClass = Pool }) {
  const configured = /^postgres(?:ql)?:\/\//i.test(String(databaseUrl || '').trim());
  const pool = configured ? new PoolClass({
    connectionString: String(databaseUrl).trim(),
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'gv2vpd-fno-quote-snapshot'
  }) : null;
  if (pool && typeof pool.on === 'function') {
    pool.on('error', error => {
      console.error('PostgreSQL idle connection error in durable F&O snapshot store:', String(error?.message || error).slice(0, 160));
    });
  }

  return {
    configured,
    async initialize() {
      if (!pool) throw new Error('PostgreSQL is required for durable F&O snapshot recovery.');
      await pool.query(TABLE_SQL);
    },
    async save(snapshot, symbols, now = Date.now()) {
      if (!pool) throw new Error('Durable F&O snapshot store is unavailable.');
      const expected = normalizeSymbols(symbols);
      if (!expected || !isCompleteFreshFnoQuoteSnapshot(snapshot, expected, now, 30000)) {
        return { saved: false, reason: 'Snapshot is not a complete, fresh, verified FYERS F&O universe.' };
      }
      const exchangeTime = Date.parse(snapshot.fetchedAt || '');
      if (!Number.isFinite(exchangeTime) || exchangeTime <= 0 || exchangeTime > now + 5000) {
        return { saved: false, reason: 'Snapshot exchange time is invalid.' };
      }
      const result = await pool.query(
        `INSERT INTO gv2vpd_fno_quote_snapshots
          (id, universe_symbols, snapshot, snapshot_exchange_time, saved_at)
         VALUES (1, $1::jsonb, $2::jsonb, $3::timestamptz, NOW())
         ON CONFLICT (id) DO UPDATE SET
           universe_symbols = EXCLUDED.universe_symbols,
           snapshot = EXCLUDED.snapshot,
           snapshot_exchange_time = EXCLUDED.snapshot_exchange_time,
           saved_at = NOW()
         WHERE gv2vpd_fno_quote_snapshots.snapshot_exchange_time <= EXCLUDED.snapshot_exchange_time
         RETURNING id`,
        [JSON.stringify(expected), JSON.stringify(snapshot), new Date(exchangeTime).toISOString()]
      );
      return { saved: result.rowCount === 1, reason: result.rowCount === 1 ? null : 'A newer snapshot is already stored.' };
    },
    async load(symbols, now = Date.now(), maxAgeMs = MAX_SNAPSHOT_AGE_MS) {
      if (!pool) throw new Error('Durable F&O snapshot store is unavailable.');
      const expected = normalizeSymbols(symbols);
      if (!expected || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return null;
      const result = await pool.query(
        'SELECT universe_symbols, snapshot, snapshot_exchange_time FROM gv2vpd_fno_quote_snapshots WHERE id = 1'
      );
      const row = result.rows?.[0];
      if (!row) return null;
      let storedSymbols;
      let snapshot;
      try {
        storedSymbols = typeof row.universe_symbols === 'string' ? JSON.parse(row.universe_symbols) : row.universe_symbols;
        snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
      } catch { return null; }
      if (!Array.isArray(storedSymbols) || storedSymbols.length !== expected.length ||
          storedSymbols.some((symbol, index) => symbol !== expected[index])) return null;
      const exchangeTime = Date.parse(row.snapshot_exchange_time || snapshot?.fetchedAt || '');
      if (!Number.isFinite(exchangeTime) || exchangeTime > now + 5000 ||
          now - exchangeTime < 0 || now - exchangeTime > maxAgeMs) return null;
      if (!isCompleteFreshFnoQuoteSnapshot(snapshot, expected, now, maxAgeMs)) return null;
      return { snapshot, fetchedAt: exchangeTime, ageMs: now - exchangeTime };
    },
    async close() { if (pool) await pool.end(); }
  };
}
