import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFnoUniverse, selectSubscriptionBatch } from './fno-universe.js';

const expiry = date => Math.floor(Date.parse(date + 'T00:00:00Z') / 1000);
const now = Date.parse('2026-11-14T00:00:00Z');

test('builds one nearest active FYERS futures contract per underlying', () => {
  const nseMaster = {
    'NSE:RELIANCE25NOVFUT': { tradeStatus: 1, expiryDate: expiry('2026-11-25') },
    'NSE:RELIANCE30DEC FUT': { tradeStatus: 1, expiryDate: expiry('2026-12-30') },
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
    const batch = selectSubscriptionBatch({
      baseSymbols: ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'],
      universeSymbols: universe, cursor, limit: 100
    });
    assert.equal(batch.symbols.length, 100);
    batch.symbols.filter(x => universe.includes(x)).forEach(x => seen.add(x));
    cursor = batch.nextCursor;
  }
  assert.equal(seen.size, 205);
});

test('pinned contracts reduce rotating capacity and overflow fails explicitly', () => {
  const batch = selectSubscriptionBatch({
    baseSymbols: ['NSE:NIFTY50-INDEX'],
    pinnedSymbols: ['NSE:RELIANCE25NOVFUT'],
    universeSymbols: ['NSE:RELIANCE25NOVFUT', 'NSE:TCS25NOVFUT', 'NSE:INFY25NOVFUT'],
    cursor: 0, limit: 3
  });
  assert.deepEqual(batch.symbols, ['NSE:NIFTY50-INDEX', 'NSE:RELIANCE25NOVFUT', 'NSE:TCS25NOVFUT']);
  assert.throws(() => selectSubscriptionBatch({
    baseSymbols: ['NSE:NIFTY50-INDEX'], pinnedSymbols: ['NSE:A','NSE:B','NSE:C'],
    universeSymbols: [], limit: 3
  }), /Pinned FYERS symbols exceed/);
});
