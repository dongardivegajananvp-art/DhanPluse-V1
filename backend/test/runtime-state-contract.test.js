import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const budget = await readFile(new URL('../src/fyers-data-api-budget.js', import.meta.url), 'utf8');
const store = await readFile(new URL('../src/runtime-state-store.js', import.meta.url), 'utf8');

test('FYERS cooldown is restored before Sureshot requests and persisted on provider block', () => {
  assert.match(server, /createRuntimeStateStore\(/);
  assert.match(server, /runtimeStateReady = initializeRuntimeStateStore\(\)/);
  assert.match(server, /await runtimeStateReady/);
  assert.match(server, /runtimeStateStore\.load\('fyers-data-api-cooldown'\)/);
  assert.match(server, /fetchWithFyersBudget\.restoreStatus\(cooldown\)/);
  assert.match(server, /runtimeStateStore\.save\('fyers-data-api-cooldown'/);
  assert.match(budget, /onCooldownChange/);
  assert.match(budget, /run\.restoreStatus = state =>/);
});

test('NSE Sureshot scan cursor and completed batches survive backend restarts safely', () => {
  assert.match(server, /runtimeStateStore\.load\('nse-sureshot-scan-cursor'\)/);
  assert.match(server, /runtimeStateStore\.save\('nse-sureshot-scan-cursor', sureshotScanState\)/);
  assert.match(server, /await persistSureshotScanState\(\)/);
  assert.match(server, /cursor\.results\.length === cursor\.nextOffset/);
  assert.match(server, /Date\.now\(\) - cursor\.createdAt <= SURESHOT_SCAN_TTL_MS/);
  assert.match(server, /await clearSureshotScanState\(\)/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS gv2vpd_runtime_state/);
  assert.match(store, /ON CONFLICT \(state_key\) DO UPDATE/);
});

test('Sureshot fails closed when durable runtime state is unavailable or cursor writes fail', () => {
  assert.match(server, /const runtimeStateAvailable = await runtimeStateReady/);
  assert.match(server, /if \(!runtimeStateAvailable\)[\s\S]*?No upstream scan request was sent/);
  assert.match(server, /runtimeStateReady = Promise\.resolve\(false\)/);
  assert.equal((server.match(/if \(!\(await persistSureshotScanState\(\)\)\)/g) || []).length, 2);
  assert.match(server, /verified plans withheld/);
});
