import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getReferenceDataRetryDelay } from '../src/reference-data-backoff.js';

test('reference-data retry backoff grows exponentially and caps at five minutes', () => {
  assert.equal(getReferenceDataRetryDelay(1), 30_000);
  assert.equal(getReferenceDataRetryDelay(2), 60_000);
  assert.equal(getReferenceDataRetryDelay(3), 120_000);
  assert.equal(getReferenceDataRetryDelay(4), 240_000);
  assert.equal(getReferenceDataRetryDelay(5), 300_000);
  assert.equal(getReferenceDataRetryDelay(50), 300_000);
});

test('reference-data retry backoff sanitizes invalid configuration and attempts', () => {
  assert.equal(getReferenceDataRetryDelay(0), 30_000);
  assert.equal(getReferenceDataRetryDelay('bad'), 30_000);
  assert.equal(getReferenceDataRetryDelay(2, -1, 0), 60_000);
});

test('NSE F&O universe failures are locally throttled and expose retry timing', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function getNseFnoEquityUniverse()');
  const end = source.indexOf('// The FYERS instrument masters are public reference data', start);
  assert.ok(start >= 0 && end > start);
  const loader = source.slice(start, end);
  assert.match(loader, /Date\.now\(\) < fnoUniverseRetryAt/);
  assert.match(loader, /fnoUniverseFailureCount \+= 1/);
  assert.match(loader, /getReferenceDataRetryDelay\(fnoUniverseFailureCount\)/);
  assert.match(loader, /fnoUniverseRetryAt = Date\.now\(\) \+ retryDelayMs/);
  assert.match(loader, /fnoUniverseFailureCount = 0/);
  assert.match(loader, /fnoUniverseRetryAt = 0/);
});
