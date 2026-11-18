import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFnoRotationCursor } from './fno-rotation-state.js';

test('restores the active F&O window by its symbol anchor after universe reordering', () => {
  const cursor = resolveFnoRotationCursor({
    universeSymbols: ['NSE:AAA26NOVFUT', 'NSE:CCC26NOVFUT', 'NSE:BBB26NOVFUT'],
    savedActiveSymbol: 'NSE:BBB26NOVFUT',
    savedActiveCursor: 1
  });
  assert.equal(cursor, 2);
});

test('falls back to the saved cursor when the active symbol is no longer listed', () => {
  const cursor = resolveFnoRotationCursor({
    universeSymbols: ['NSE:AAA26NOVFUT', 'NSE:BBB26NOVFUT', 'NSE:CCC26NOVFUT'],
    savedActiveSymbol: 'NSE:REMOVED26NOVFUT',
    savedActiveCursor: 5
  });
  assert.equal(cursor, 2);
});

test('returns zero for an empty universe or invalid saved cursor', () => {
  assert.equal(resolveFnoRotationCursor({ universeSymbols: [] }), 0);
  assert.equal(resolveFnoRotationCursor({
    universeSymbols: ['NSE:AAA26NOVFUT'],
    savedActiveCursor: -1
  }), 0);
});
