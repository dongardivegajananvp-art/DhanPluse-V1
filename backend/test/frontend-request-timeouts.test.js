import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../site/index.html', import.meta.url), 'utf8');

test('Dashboard health and status checks have a bounded deadline and cannot stay CHECKING indefinitely', () => {
  assert.match(html, /healthRequestTimeoutMs = isBackend && \/\['\/health', '\/api\/status'\]\.includes\(pathname\) \? 15000 : 0/);
  assert.match(html, /Backend request timed out after ' \+ Math\.round\(requestTimeoutMs \/ 1000\)/);
  assert.match(html, /setBackendStatus\('ONLINE'\)/);
  assert.match(html, /setBackendStatus\('UNREACHABLE'\)/);
});

test('NSE and MCX Sureshot, candle and option-risk requests abort on a bounded timeout', () => {
  for (const path of [
    '/api/market/sureshot-auto-plans',
    '/api/market/mcx-sureshot-auto-plans',
    '/api/market/candles',
    '/api/fyers/option-risk-plan',
    '/api/fyers/option-chain'
  ]) assert.ok(html.includes(path), 'Missing bounded endpoint ' + path);
  assert.match(html, /scanRequestTimeoutMs = isBackend && \[/);
  assert.match(html, /\? 120000 : 0/);
  assert.match(html, /finally \(\) => \{/);
  assert.match(html, /window\.clearTimeout\(timeoutId\)/);
});

test('Sureshot mobile buttons wrap full labels instead of clipping', () => {
  assert.match(html, /\.option-controls button\{margin:0;min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;line-height:1\.3;text-align:center\}/);
  assert.match(html, /\.option-controls button\{grid-column:1\/-1;justify-self:stretch\}/);
  for (const label of ['Analyse selected setup', 'Scan Full F&O + Fresh Indices', 'Scan MCX Full Universe + Top 3']) {
    assert.ok(html.includes(label), 'Missing visible action label: ' + label);
  }
});
