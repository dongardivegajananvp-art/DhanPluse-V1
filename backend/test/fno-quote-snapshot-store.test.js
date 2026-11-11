import test from 'node:test';
import assert from 'node:assert/strict';
import { createFnoQuoteSnapshotStore } from '../src/fno-quote-snapshot-store.js';

const now = Date.parse('2026-11-11T10:00:00.000Z');
const symbols = ['NSE:AAA-EQ', 'NSE:BBB-EQ'];
const snapshot = {
  ok: true, verified: true, fetchedAt: new Date(now - 1000).toISOString(),
  universeCount: 2, quotedCount: 2,
  data: symbols.map((n, i) => ({
    n, verified: true,
    v: { lp: 100 + i, ch: 1, chp: 1, tt: Math.floor((now - 1000) / 1000) }
  }))
};

function fakePoolClass() {
  const state = { row: null };
  class FakePool {
    constructor() {}
    async query(sql, params = []) {
      if (sql.startsWith('INSERT INTO gv2vpd_fno_quote_snapshots')) {
        const exchangeTime = params[2];
        if (state.row && Date.parse(state.row.snapshot_fetched_at) > Date.parse(exchangeTime)) {
          return { rowCount: 0, rows: [] };
        }
        state.row = { universe_symbols: params[0], snapshot: params[1], snapshot_fetched_at: exchangeTime };
        return { rowCount: 1, rows: [{ id: 1 }] };
      }
      if (sql.startsWith('SELECT universe_symbols')) return { rows: state.row ? [state.row] : [] };
      return { rowCount: 0, rows: [] };
    }
    async end() {}
  }
  return { FakePool, state };
}

test('durable snapshot store saves only complete fresh verified F&O snapshots', async () => {
  const { FakePool, state } = fakePoolClass();
  const store = createFnoQuoteSnapshotStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  await store.initialize();
  assert.equal((await store.save(snapshot, symbols, now)).saved, true);
  const incomplete = structuredClone(snapshot);
  incomplete.data.pop();
  assert.equal((await store.save(incomplete, symbols, now)).saved, false);
  assert.equal(state.row !== null, true);
});

test('durable snapshot recovery requires exact universe and permits prior-session age only within 24h', async () => {
  const { FakePool } = fakePoolClass();
  const store = createFnoQuoteSnapshotStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  await store.initialize();
  await store.save(snapshot, symbols, now);
  const loaded = await store.load(symbols, now + 60_000);
  assert.equal(loaded.snapshot.quotedCount, 2);
  assert.equal(await store.load(['NSE:AAA-EQ'], now + 60_000), null);
  assert.equal(await store.load(symbols, now + 24 * 60 * 60 * 1000 + 60_000), null);
});

test('older snapshots cannot overwrite a newer persisted FYERS snapshot', async () => {
  const { FakePool } = fakePoolClass();
  const store = createFnoQuoteSnapshotStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  await store.initialize();
  const newer = structuredClone(snapshot);
  newer.fetchedAt = new Date(now).toISOString();
  newer.data.forEach(row => { row.v.tt = Math.floor(now / 1000); });
  assert.equal((await store.save(newer, symbols, now)).saved, true);
  const older = structuredClone(snapshot);
  assert.equal((await store.save(older, symbols, now + 1000)).saved, false);
  const restored = await store.load(symbols, now + 2000);
  assert.equal(restored.snapshot.fetchedAt, newer.fetchedAt);
});

test('stale exchange timestamps are never persisted even when the snapshot is complete', async () => {
  const { FakePool, state } = fakePoolClass();
  const store = createFnoQuoteSnapshotStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  await store.initialize();
  const stale = structuredClone(snapshot);
  stale.data[0].v.tt = Math.floor((now - 31_000) / 1000);
  assert.equal((await store.save(stale, symbols, now)).saved, false);
  assert.equal(state.row, null);
});

test('unconfigured snapshot store fails closed', async () => {
  const store = createFnoQuoteSnapshotStore({ databaseUrl: '' });
  assert.equal(store.configured, false);
  await assert.rejects(() => store.initialize(), /PostgreSQL is required/);
});

test('durable snapshot store persists and restores through PostgreSQL', {
  skip: !process.env.PAPER_TEST_DATABASE_URL
}, async () => {
  const pg = await import('pg');
  const cleanupPool = new pg.default.Pool({
    connectionString: process.env.PAPER_TEST_DATABASE_URL,
    max: 1,
    application_name: 'gv2vpd-fno-snapshot-store-test-cleanup'
  });
  const store = createFnoQuoteSnapshotStore({ databaseUrl: process.env.PAPER_TEST_DATABASE_URL });
  const testSymbols = ['NSE:GV2VPD-SNAPSHOT-TEST-A', 'NSE:GV2VPD-SNAPSHOT-TEST-B'];
  const testNow = Date.now();
  const testSnapshot = {
    ok: true, verified: true, fetchedAt: new Date(testNow).toISOString(),
    universeCount: testSymbols.length, quotedCount: testSymbols.length,
    data: testSymbols.map((n, i) => ({
      n, verified: true,
      v: { lp: 200 + i, ch: 1, chp: 0.5, tt: Math.floor(testNow / 1000) }
    }))
  };
  try {
    await store.initialize();
    await cleanupPool.query('DELETE FROM gv2vpd_fno_quote_snapshots WHERE id = 1');
    assert.equal((await store.save(testSnapshot, testSymbols, testNow)).saved, true);
    const restored = await store.load(testSymbols, testNow + 60_000);
    assert.equal(restored.snapshot.data.length, 2);
    assert.equal(restored.snapshot.data[0].n, testSymbols[0]);
  } finally {
    await cleanupPool.query('DELETE FROM gv2vpd_fno_quote_snapshots WHERE id = 1').catch(() => {});
    await store.close();
    await cleanupPool.end();
  }
});
