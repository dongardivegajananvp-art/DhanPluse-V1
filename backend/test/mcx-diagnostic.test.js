import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { selectMcxDiagnosticInstrument } from '../src/mcx-diagnostic.js';

const now = Date.UTC(2026, 10, 5, 9, 0, 0);

test('MCX diagnostic selects nearest active CRUDEOIL future from official master', () => {
  const master = {
    'MCX:CRUDEOIL26NOVFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 10, 19) / 1000), symDetails: 'CRUDEOIL NOV FUT' },
    'MCX:CRUDEOIL26DECFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 11, 17) / 1000), symDetails: 'CRUDEOIL DEC FUT' },
    'MCX:GOLD26NOVFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 10, 25) / 1000) },
    'MCX:CRUDEOIL26OCTFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 9, 19) / 1000) },
    'MCX:CRUDEOIL26NOV5000CE': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 10, 19) / 1000) },
    'MCX:CRUDEOIL26NOVFUT_INACTIVE': { tradeStatus: 0, expiryDate: String(Date.UTC(2026, 10, 19) / 1000) }
  };
  assert.deepEqual(selectMcxDiagnosticInstrument(master, now), {
    symbol: 'MCX:CRUDEOIL26NOVFUT', label: 'CRUDEOIL NOV FUT', expiryDate: '2026-11-19'
  });
});

test('MCX diagnostic falls back to nearest active GOLD future only when crude oil is unavailable', () => {
  const master = {
    'MCX:CRUDEOIL26NOVFUT': { tradeStatus: 0, expiryDate: String(Date.UTC(2026, 10, 19) / 1000) },
    'MCX:GOLD26DECFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 11, 5) / 1000) },
    'MCX:GOLD26NOVFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 10, 25) / 1000) }
  };
  assert.equal(selectMcxDiagnosticInstrument(master, now)?.symbol, 'MCX:GOLD26NOVFUT');
});

test('MCX diagnostic fails closed for malformed, inactive, expired, or non-MCX master rows', () => {
  assert.equal(selectMcxDiagnosticInstrument(null, now), null);
  assert.equal(selectMcxDiagnosticInstrument({
    'MCX:CRUDEOIL26NOVFUT': { tradeStatus: 0, expiryDate: String(Date.UTC(2026, 10, 19) / 1000) },
    'NSE:CRUDEOIL26NOVFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 10, 19) / 1000) },
    'MCX:GOLD26OCTFUT': { tradeStatus: 1, expiryDate: String(Date.UTC(2026, 9, 19) / 1000) }
  }, now), null);
});

test('MCX diagnostic uses official master and shared socket but stays outside NSE live snapshots', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /MCX_COM_sym_master\.json/);
  assert.match(source, /socket\.subscribe\(\[instrument\.symbol\]\)/);
  assert.match(source, /socketInstance: 'shared-existing'/);
  assert.match(source, /mcxDiagnostic:/);
  assert.match(source, /signalsAllowed: false/);
  const snapshotStart = source.indexOf('function liveSnapshot()');
  const snapshotEnd = source.indexOf('\n}', snapshotStart) + 2;
  const snapshot = source.slice(snapshotStart, snapshotEnd);
  assert.match(snapshot, /allowedSymbols\.map/);
  assert.doesNotMatch(snapshot, /mcxDiagnostic/);
  const parserStart = source.indexOf('function parseTick(raw)');
  const parserEnd = source.indexOf('function startMarketDataStream', parserStart);
  assert.ok(parserStart >= 0 && parserEnd > parserStart);
  assert.match(source.slice(parserStart, parserEnd), /if \(!exchangeTime\)/);
});
