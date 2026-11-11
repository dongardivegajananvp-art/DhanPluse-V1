import test from 'node:test';
import assert from 'node:assert/strict';
import { createNseSymbolMasterCache } from '../src/nse-symbol-master-cache.js';

class FakePool {
  static row = null;
  constructor() {}
  async query(sql, params = []) {
    if (sql.includes('CREATE TABLE')) return { rows: [] };
    if (sql.includes('INSERT INTO gv2vpd_reference_cache')) {
      FakePool.row = {
        payload: JSON.parse(params[1]),
        fetched_at: params[2],
        age_ms: 1000
      };
      return { rows: [] };
    }
    if (sql.includes('SELECT payload')) return { rows: FakePool.row ? [FakePool.row] : [] };
    throw new Error('Unexpected SQL: ' + sql);
  }
  async end() {}
}

test('NSE reference cache round-trips Maps and validates snapshot structure', async () => {
  FakePool.row = null;
  const cache = createNseSymbolMasterCache({ databaseUrl: 'postgres://test', PoolImpl: FakePool });
  const snapshot = {
    universe: [{ symbol: 'NSE:ABC-EQ' }],
    moversSymbols: ['NSE:ABC-EQ'],
    optionContractMaster: new Map([['NSE:ABC26NOV100CE', { optType: 'CE', strikePrice: 100 }]])
  };
  await cache.save(snapshot, { fetchedAt: '2026-11-11T07:00:00.000Z' });
  const loaded = await cache.load({ maxAgeMs: 60_000 });
  assert.equal(loaded.snapshot.optionContractMaster instanceof Map, true);
  assert.deepEqual(loaded.snapshot.optionContractMaster.get('NSE:ABC26NOV100CE'), { optType: 'CE', strikePrice: 100 });
  assert.deepEqual(loaded.snapshot.universe, snapshot.universe);
  await cache.close();
});

test('NSE reference cache refuses to persist incomplete snapshots', async () => {
  const cache = createNseSymbolMasterCache({ databaseUrl: 'postgres://test', PoolImpl: FakePool });
  await assert.rejects(cache.save({ universe: [], moversSymbols: [], optionContractMaster: {} }), /invalid NSE symbol snapshot/);
  await cache.close();
});

test('NSE reference cache can be safely disabled when DATABASE_URL is absent', async () => {
  const cache = createNseSymbolMasterCache({ databaseUrl: '', PoolImpl: FakePool });
  assert.equal(cache.configured, false);
  assert.equal(await cache.load(), null);
  assert.equal(await cache.save({}), false);
});
