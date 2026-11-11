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
        if (state.row && Date.parse(state.row.snapshot_exchange_time) > Date.parse(exchangeTime)) {
          return { rowCount: 0, rows: [] };
        }
        state.row = { universe_symbols: params[0], snapshot: params[1], snapshot_exchange_time: exchangeTime };
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

test('unconfigured snapshot store fails closed', async () => {
  const store = createFnoQuoteSnapshotStore({ databaseUrl: '' });
  assert.equal(store.configured, false);
  await assert.rejects(() => store.initialize(), /PostgreSQL is required/);
});
