import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNseSymbolMasterLoader } from '../src/nse-symbol-master.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}


test('persisted validated NSE snapshot avoids large cold-start master downloads', async () => {
  let networkCalls = 0;
  let persistedReads = 0;
  const snapshot = {
    universe: [{ symbol: 'NSE:ABC-EQ' }],
    moversSymbols: ['NSE:ABC-EQ'],
    optionContractMaster: new Map([['NSE:ABC26NOV100CE', { optType: 'CE' }]])
  };
  const load = createNseSymbolMasterLoader({
    fetchImpl: async () => { networkCalls += 1; throw new Error('network must not be called'); },
    build: () => { throw new Error('builder must not run'); },
    loadPersistedSnapshot: async ({ maxAgeMs }) => {
      persistedReads += 1;
      assert.equal(maxAgeMs, 24 * 60 * 60 * 1000);
      return { snapshot, ageMs: 1000 };
    }
  });
  const result = await load();
  assert.equal(result, snapshot);
  assert.equal(persistedReads, 1);
  assert.equal(networkCalls, 0);
});

test('freshly validated NSE snapshot is persisted after successful build', async () => {
  let saved = null;
  const snapshot = {
    universe: [{ symbol: 'NSE:ABC-EQ' }],
    moversSymbols: ['NSE:ABC-EQ'],
    optionContractMaster: new Map()
  };
  const load = createNseSymbolMasterLoader({
    fetchImpl: async () => response({}),
    build: () => snapshot,
    savePersistedSnapshot: async (value, metadata) => { saved = { value, metadata }; }
  });
  const result = await load();
  assert.equal(result, snapshot);
  assert.equal(saved.value, snapshot);
  assert.equal(Number.isNaN(Date.parse(saved.metadata.fetchedAt)), false);
});

test('concurrent NSE consumers share one pair of official master downloads', async () => {
  let calls = 0;
  let builds = 0;
  const fo = { 'NSE:ABC-FUT': { tradeStatus: 1 } };
  const cm = { 'NSE:ABC-EQ': { tradeStatus: 1 } };
  const load = createNseSymbolMasterLoader({
    fetchImpl: async url => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return response(url.includes('NSE_FO') ? fo : cm);
    },
    build: (foMaster, cmMaster) => {
      builds += 1;
      return { universe: [foMaster], moversSymbols: Object.keys(cmMaster) };
    }
  });

  const [first, second] = await Promise.all([load(), load()]);
  assert.equal(first, second);
  assert.equal(calls, 2);
  assert.equal(builds, 1);
  assert.deepEqual(first.moversSymbols, ['NSE:ABC-EQ']);
});

test('NSE loader caches only the compact snapshot for subsequent consumers', async () => {
  let calls = 0;
  const compact = { universe: [{ symbol: 'NSE:ABC-EQ' }], moversSymbols: ['NSE:ABC-EQ'] };
  const load = createNseSymbolMasterLoader({
    fetchImpl: async () => {
      calls += 1;
      return response({});
    },
    build: () => compact
  });

  const first = await load();
  const second = await load();
  assert.equal(first, compact);
  assert.equal(second, compact);
  assert.equal(calls, 2);
});

test('failed or invalid NSE master loads are not cached and expose diagnostics', async () => {
  let calls = 0;
  let clock = 1_000;
  const diagnostics = [];
  const load = createNseSymbolMasterLoader({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return response({}, calls === 1 ? 503 : 200);
    },
    build: () => ({ universe: [], moversSymbols: [] }),
    onDiagnostic: (event, detail) => diagnostics.push({ event, detail })
  });

  await assert.rejects(load(), /NSE_FO symbol master HTTP 503/);
  clock += 30_000;
  const result = await load();
  assert.deepEqual(result.universe, []);
  assert.equal(calls, 4);
  assert.equal(diagnostics[0].event, 'failed');
  assert.equal(diagnostics[0].detail.stage, 'VALIDATE_NSE_FO_RESPONSE');
  assert.equal(diagnostics[0].detail.httpStatus, 503);
  assert.equal(diagnostics[1].event, 'loaded');
});

test('NSE loader rejects invalid master payloads without caching them', async () => {
  let calls = 0;
  let clock = 1_000;
  const load = createNseSymbolMasterLoader({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return response([]);
    },
    build: () => ({})
  });

  await assert.rejects(load(), /NSE_FO symbol master format is invalid/);
  clock += 30_000;
  await assert.rejects(load(), /NSE_FO symbol master format is invalid/);
  assert.equal(calls, 4);
});


test('NSE master failures share exponential backoff across consumers', async () => {
  let clock = 1_000;
  let calls = 0;
  const load = createNseSymbolMasterLoader({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return response({}, 503);
    },
    build: () => ({})
  });

  await assert.rejects(load(), error => error.statusCode === 503 && error.retryAfterSeconds === 30);
  await assert.rejects(load(), error => error.statusCode === 503 && error.retryAfterSeconds === 30);
  assert.equal(calls, 2);
  clock += 30_000;
  await assert.rejects(load(), error => error.statusCode === 503 && error.retryAfterSeconds === 60);
  assert.equal(calls, 4);
});


test('Sureshot and Movers share the same public NSE master loader', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const moversStart = source.indexOf('async function refreshMoversUniverse()');
  const moversEnd = source.indexOf('let institutionalFlowCache', moversStart);
  const sureshotStart = source.indexOf('async function getNseFnoEquityUniverse()');
  const sureshotEnd = source.indexOf('// The FYERS instrument masters are public reference data', sureshotStart);
  assert.ok(moversStart >= 0 && moversEnd > moversStart);
  assert.ok(sureshotStart >= 0 && sureshotEnd > sureshotStart);
  assert.match(source, /createNseSymbolMasterLoader/);
  assert.match(source.slice(moversStart, moversEnd), /loadNseSymbolMasterSnapshot\(\)/);
  assert.match(source.slice(sureshotStart, sureshotEnd), /loadNseSymbolMasterSnapshot\(\)/);
  const optionMetadataStart = source.indexOf('async function getFyersOptionContractMetadata(symbol)');
  const optionMetadataEnd = source.indexOf('// Stock Explorer/movers', optionMetadataStart);
  assert.ok(optionMetadataStart >= 0 && optionMetadataEnd > optionMetadataStart);
  assert.match(source.slice(optionMetadataStart, optionMetadataEnd), /loadNseSymbolMasterSnapshot\(\)/);
  assert.doesNotMatch(source, /fetchWithFyersBudget\(["']https:\/\/public\.fyers\.in\/sym_details\/NSE_(?:FO|CM)_sym_master\.json/);
});
