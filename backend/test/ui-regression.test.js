import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const html = read('site/index.html');
const app = read('site/app.js');
const sw = read('site/sw.js');

test('all original DhanPulse navigation tabs have descriptions and render routes', () => {
  const tabs = [...html.matchAll(/data-tab=["']([^"']+)["']/g)]
    .map(match => match[1].replaceAll('&amp;', '&'));
  assert.equal(tabs.length, 24, 'original tab count must remain 24');
  assert.equal(new Set(tabs).size, 24, 'tab names must be unique');

  const descriptionStart = app.indexOf('const descriptions');
  assert.notEqual(descriptionStart, -1, 'tab descriptions must exist');
  const descriptionEnd = app.indexOf('};', descriptionStart);
  const descriptions = app.slice(descriptionStart, descriptionEnd + 2);
  for (const tab of tabs) {
    assert.ok(descriptions.includes(JSON.stringify(tab)) || descriptions.includes("'" + tab + "'"),
      'missing description for tab: ' + tab);
  }

  for (const tab of ['Dashboard', 'Stock Explorer', 'NIFTY', 'BANKNIFTY', 'Watchlist',
    'Sureshot CE/PE', 'Breakout Scanner', 'Momentum Scanner', 'Zero-to-Hero',
    'FII/DII Flow', 'Market Activity', 'Gap-Up/Down', 'Charts & Patterns',
    'Gainers & Losers', 'Option Chain', 'Technical Indicators', 'AI Signals',
    'Holdings', 'Alerts', 'FYERS Settings', 'Logs']) {
    assert.ok(app.includes("'" + tab + "'"), 'missing app render/route reference: ' + tab);
  }
  for (const [path, id] of [['site/journal.js', 'dpJournalForm'],
    ['site/risk-calculator.js', 'dpRiskForm'], ['site/backtest.js', 'dpBtForm']]) {
    assert.ok(read(path).includes(id), 'dedicated workspace form missing: ' + path);
  }
});

test('app and service-worker cache-busting versions stay in sync', () => {
  const htmlVersion = html.match(/app\.js\?v=([^"']+)/)?.[1];
  const swVersion = sw.match(/app\.js\?v=([^"']+)/)?.[1];
  const cacheName = sw.match(/CACHE_NAME\s*=\s*'([^']+)'/)?.[1];
  assert.ok(htmlVersion, 'index must version app.js');
  assert.equal(htmlVersion, swVersion, 'index and service worker must request same app.js version');
  assert.ok(cacheName, 'service-worker cache name must be versioned');
});

test('signals require fresh connected FYERS websocket data and closed-market blocking', () => {
  assert.match(app, /function signalDataBlockReason\(/);
  assert.match(app, /!isRegularMarketSession\(\).*no actionable signal/i);
  assert.match(app, /quote\.source !== 'websocket'.*quote\.streamConnected !== true/);
  assert.match(app, /quoteAgeMs\(quote\) > 15000/);
  assert.match(app, /all signals remain blocked/);
});

test('source keeps explicit no-order-placement language for paper tools', () => {
  assert.match(app, /No live order placement is available/);
  assert.match(read('site/risk-calculator.js'), /does not place orders/i);
  assert.match(read('site/backtest.js'), /SIMULATION ONLY/);
});
