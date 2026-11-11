import test from 'node:test';
import assert from 'node:assert/strict';
import { createNseSymbolMasterLoader } from '../src/nse-symbol-master.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

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
  const diagnostics = [];
  const load = createNseSymbolMasterLoader({
    fetchImpl: async () => {
      calls += 1;
      return response({}, calls === 1 ? 503 : 200);
    },
    build: () => ({ universe: [], moversSymbols: [] }),
    onDiagnostic: (event, detail) => diagnostics.push({ event, detail })
  });

  await assert.rejects(load(), /NSE_FO symbol master HTTP 503/);
  const result = await load();
  assert.deepEqual(result.universe, []);
  assert.equal(calls, 3);
  assert.equal(diagnostics[0].event, 'failed');
  assert.equal(diagnostics[0].detail.stage, 'VALIDATE_NSE_FO_RESPONSE');
  assert.equal(diagnostics[0].detail.httpStatus, 503);
  assert.equal(diagnostics[1].event, 'loaded');
});

test('NSE loader rejects invalid master payloads without caching them', async () => {
  let calls = 0;
  const load = createNseSymbolMasterLoader({
    fetchImpl: async () => {
      calls += 1;
      return response([]);
    },
    build: () => ({})
  });

  await assert.rejects(load(), /NSE_FO symbol master format is invalid/);
  await assert.rejects(load(), /NSE_FO symbol master format is invalid/);
  assert.equal(calls, 4);
});
