const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const previewUrl = process.env.GV2VPD_PREVIEW_URL;
const backendUrl = process.env.GV2VPD_BACKEND_URL || 'https://dhanpulse-clean-test.onrender.com';
const backendOrigin = new URL(backendUrl).origin;
if (!previewUrl) throw new Error('GV2VPD_PREVIEW_URL is required.');

async function mockTestBackend(page, socketState = { connected: false, feed: 'DISCONNECTED' }) {
  const backendOrigins = new Set([
    backendOrigin,
    'https://dhanpluse-v1.onrender.com',
    'https://dhanpulse-clean-test.onrender.com'
  ]);
  for (const origin of backendOrigins) await page.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    const json = (status, body) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(body)
    });
    if (url.pathname === '/health') {
      return json(200, { ok: true, fyersConfigured: true, orderPlacementEnabled: false });
    }
    if (url.pathname === '/api/status') {
      return json(200, {
        backend: 'online',
        fyers: 'connected',
        liveData: 'waiting-for-live-ticks',
        marketSocketConnected: socketState.connected,
        orderPlacement: 'disabled',
        exchangeLiveStatus: {
          NSE: { session: 'SCHEDULED_OPEN', feed: socketState.feed },
          MCX: { session: 'SCHEDULED_CLOSED', feed: 'WAITING' }
        },
        fyersDataApi: { cooldownActive: false, retryAfterSeconds: 0 }
      });
    }
    return json(401, { ok: false, error: 'Controlled browser-smoke unauthenticated response; no market data supplied.' });
  });
}

async function verifyDesktop(browser) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockTestBackend(page, { connected: true, feed: 'RECONNECTING' });
  const response = await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.ok(response && response.ok(), 'PR preview /site/ page must return HTTP success');
  await page.waitForSelector('#nav button[data-tab]', { timeout: 10000 });
  const tabs = await page.locator('#nav button[data-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.tab));
  const expectedTabs = ['Dashboard','Stock Explorer','NIFTY','BANKNIFTY','Watchlist','Sureshot CE/PE','Breakout Scanner','Momentum Scanner','Zero-to-Hero','FII/DII Flow','Market Activity','Charts & Patterns','Gap-Up/Down','Gainers & Losers','Option Chain','Technical Indicators','AI Signals','Position','Alerts','FYERS Settings','Logs','Trade Journal','Capital Protection','Backtesting'];
  assert.deepEqual(tabs, expectedTabs, 'the original 24-tab workstation must render in the expected order');

  await page.locator('#nav button[data-tab="Sureshot CE/PE"]').click();
  await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent?.trim() === 'Sureshot CE/PE');
  assert.ok(await page.locator('#featureContent').count(), 'Sureshot workspace container must exist');

  await page.locator('#nav button[data-tab="Position"]').click();
  await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent?.trim() === 'Holdings & Positions');
  await page.waitForSelector('#portfolioStatus', { timeout: 5000 });
  await page.waitForSelector('#holdingsTable', { timeout: 5000 });
  await page.waitForSelector('#positionsTable', { timeout: 5000 });
  await page.waitForSelector('#gvPaperLedger', { timeout: 5000 });
  const positionText = await page.locator('#featureContent').innerText();
  assert.match(positionText, /Paper Mode ledger/i);
  assert.match(positionText, /No order placement/i);

  for (const tab of expectedTabs) {
    await page.locator('#nav button[data-tab="' + tab + '"]').click();
    const expectedTitle = tab === 'Position' ? 'Holdings & Positions' : tab;
    await page.waitForFunction(expected => document.querySelector('#pageTitle')?.textContent?.trim() === expected, expectedTitle);
    if (tab === 'Trade Journal') await page.waitForSelector('#dpJournalForm', { timeout: 5000 });
    if (tab === 'Capital Protection') await page.waitForSelector('#dpRiskForm', { timeout: 5000 });
    if (tab === 'Backtesting') await page.waitForSelector('#dpBtForm', { timeout: 5000 });
  }
  await page.locator('#nav button[data-tab="Dashboard"]').click();
  assert.equal(await page.locator('#nav button[data-tab="Dashboard"]').getAttribute('class').then(v => v.includes('active')), true);
  await page.waitForFunction(() => document.querySelector('#dashFeed')?.textContent?.trim() === 'RECOVERING · BLOCKED', { timeout: 10000 });
  assert.equal(await page.locator('#dashFeed').innerText(), 'RECOVERING · BLOCKED',
    'Dashboard must distinguish a connected transport recovering NSE ticks from a true socket disconnect');
  assert.match(await page.locator('#connectionValue').innerText(), /WebSocket connected · waiting for fresh NSE ticks after subscription recovery/i,
    'Top connection status must not call a connected transport disconnected during subscription recovery');
  assert.match(await page.locator('body').innerText(), /Order placement/i);
  assert.match(await page.locator('body').innerText(), /DISABLED/i);
  assert.deepEqual(errors, [], 'desktop browser must have no uncaught JavaScript errors');
  await context.close();
}

async function verifyMobile(browser) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockTestBackend(page, { connected: false, feed: 'DISCONNECTED' });
  const response = await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.ok(response && response.ok(), 'mobile PR preview must return HTTP success');
  const tabs = page.locator('#nav button[data-tab]');
  assert.equal(await tabs.count(), 24, 'mobile viewport must render all 24 workstation tabs');
  await page.locator('#nav button[data-tab="Sureshot CE/PE"]').tap();
  await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent?.trim() === 'Sureshot CE/PE');
  await page.locator('#nav button[data-tab="Dashboard"]').tap();
  await page.waitForFunction(() => document.querySelector('#dashFeed')?.textContent?.trim() === 'DISCONNECTED · BLOCKED', { timeout: 10000 });
  await page.locator('#nav button[data-tab="Position"]').tap();
  await page.waitForSelector('#holdingsTable', { timeout: 5000 });
  await page.waitForSelector('#gvPaperLedger', { timeout: 5000 });
  assert.deepEqual(errors, [], 'mobile browser must have no uncaught JavaScript errors');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyDesktop(browser);
    await verifyMobile(browser);
    console.log('PASS: GV2VPD PR preview desktop + mobile smoke; all 24 tabs navigate; Holdings/Positions/Paper ledger renders; live order placement stays disabled.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
