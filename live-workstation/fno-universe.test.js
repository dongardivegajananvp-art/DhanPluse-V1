import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFnoUniverse, selectFairSubscriptionBatch, selectSubscriptionBatch, summarizeFnoCoverage } from './fno-universe.js';

const expiry = date => Math.floor(Date.parse(date + 'T00:00:00Z') / 1000);
const now = Date.parse('2026-11-14T00:00:00Z');

test('builds one nearest active FYERS futures contract per underlying', () => {
  const nseMaster = {
    'NSE:RELIANCE25NOVFUT': { tradeStatus: 1, expiryDate: expiry('2026-11-25') },
    'NSE:RELIANCE30DECFUT': { tradeStatus: 1, expiryDate: expiry('2026-12-30') },
    'NSE:INFY25NOVFUT': { tradeStatus: 0, expiryDate: expiry('2026-11-25') },
    'NSE:TCS30OCTFUT': { tradeStatus: 1, expiryDate: expiry('2026-10-30') }
  };
  const rows = buildFnoUniverse({ nseMaster, now });
  assert.deepEqual(rows.map(row => row.futureSymbol), ['NSE:RELIANCE25NOVFUT']);
});

test('rotates every eligible symbol in bounded windows without duplicates', () => {
  const universe = Array.from({ length: 205 }, (_, i) => 'NSE:STOCK' + i + '25NOVFUT');
  const seen = new Set();
  let cursor = 0;
  for (let i = 0; i < 3; i++) {
    const batch = selectFairSubscriptionBatch({
      baseSymbols: ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'],
      universeSymbols: universe, cursor, limit: 100
    });
    assert.equal(batch.symbols.length, 100);
    assert.equal(new Set(batch.fnoSymbols).size, batch.fnoSymbols.length);
    batch.fnoSymbols.forEach(x => seen.add(x));
    cursor = batch.nextCursor;
  }
  assert.equal(seen.size, 205);
});

test('changing pinned symbols does not re-index or starve the rotating universe', () => {
  const universe = Array.from({ length: 8 }, (_, i) => 'NSE:S' + i + '25NOVFUT');
  const pinSets = [['NSE:S0' + '25NOVFUT'], ['NSE:S3' + '25NOVFUT'], [], ['NSE:S1' + '25NOVFUT'], []];
  const seen = new Set();
  let cursor = 0;
  for (const pinnedSymbols of pinSets) {
    const batch = selectFairSubscriptionBatch({ baseSymbols: ['NSE:NIFTY50-INDEX'], pinnedSymbols, universeSymbols: universe, cursor, limit: 4 });
    assert.ok(batch.symbols.length <= 4);
    assert.equal(new Set(batch.symbols).size, batch.symbols.length);
    batch.fnoSymbols.forEach(symbol => seen.add(symbol));
    cursor = batch.nextCursor;
  }
  assert.equal(seen.size, 8);
});

test('pinned contracts reduce rotating capacity and overflow fails explicitly', () => {
  const batch = selectFairSubscriptionBatch({
    baseSymbols: ['NSE:NIFTY50-INDEX'],
    pinnedSymbols: ['NSE:RELIANCE25NOVFUT'],
    universeSymbols: ['NSE:RELIANCE25NOVFUT', 'NSE:TCS25NOVFUT', 'NSE:INFY25NOVFUT'],
    cursor: 0, limit: 3
  });
  assert.deepEqual(batch.symbols, ['NSE:NIFTY50-INDEX', 'NSE:RELIANCE25NOVFUT', 'NSE:TCS25NOVFUT']);
  assert.deepEqual(batch.fnoSymbols, ['NSE:RELIANCE25NOVFUT', 'NSE:TCS25NOVFUT']);
  assert.equal(batch.pinnedUniverseCount, 1);
  assert.throws(() => selectFairSubscriptionBatch({
    baseSymbols: ['NSE:NIFTY50-INDEX'], pinnedSymbols: ['NSE:A','NSE:B','NSE:C'],
    universeSymbols: [], limit: 3
  }), /Pinned FYERS symbols exceed/);
});

test('reports requested-window freshness separately from whole-universe coverage', () => {
  const universe = ['NSE:A', 'NSE:B', 'NSE:C', 'NSE:D'];
  const coverage = summarizeFnoCoverage(universe, ['NSE:A', 'NSE:B'], ['NSE:A', 'NSE:C']);
  assert.equal(coverage.universeCount, 4);
  assert.equal(coverage.requestedCount, 2);
  assert.equal(coverage.notRequestedCount, 2);
  assert.equal(coverage.freshRequestedCount, 1);
  assert.equal(coverage.staleOrMissingRequestedCount, 1);
  assert.equal(coverage.requestedCoveragePercent, 50);
  assert.equal(coverage.freshUniverseCoveragePercent, 50);
  assert.equal(coverage.activeWindowFreshnessPercent, 50);
  assert.deepEqual(coverage.notRequestedSamples, ['NSE:C', 'NSE:D']);
});
