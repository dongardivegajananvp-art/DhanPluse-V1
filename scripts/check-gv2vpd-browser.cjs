const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const previewUrl = process.env.GV2VPD_PREVIEW_URL;
if (!previewUrl) throw new Error('GV2VPD_PREVIEW_URL is required.');

async function mockTestBackend(page) {
  await page.route('https://dhanpulse-clean-test.onrender.com/**', async route => {
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
        fyers: 'not-connected',
        liveData: 'waiting-for-live-ticks',
        marketSocketConnected: false,
        orderPlacement: 'disabled',
        exchangeLiveStatus: {
          NSE: { session: 'SCHEDULED_CLOSED', feed: 'WAITING' },
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
  await mockTestBackend(page);
  const response = await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.ok(response && response.ok(), 'PR preview /site/ page must return HTTP success');
  await page.waitForSelector('#nav button[data-tab]', { timeout: 10000 });
  const tabs = await page.locator('#nav button[data-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.tab));
  assert.deepEqual(tabs, ['Home', 'Sureshot', 'Position'], 'exactly the requested three tabs must render');

  await page.locator('#nav button[data-tab="Sureshot"]').click();
  await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent?.trim() === 'Sureshot CE/PE');
  assert.ok(await page.locator('#featureContent').count(), 'Sureshot workspace container must exist');

  await page.locator('#nav button[data-tab="Position"]').click();
  await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent?.trim() === 'Position');
  await page.waitForSelector('#gvPositionStatus', { timeout: 5000 });
  await page.waitForSelector('#gvPaperLedger', { timeout: 5000 });
  const positionText = await page.locator('#featureContent').innerText();
  assert.match(positionText, /Paper Mode ledger/i);
  assert.match(positionText, /Live BUY remains disabled/i);

  await page.locator('#nav button[data-tab="Home"]').click();
  assert.equal(await page.locator('#nav button[data-tab="Home"]').getAttribute('class').then(v => v.includes('active')), true);
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
  await mockTestBackend(page);
  const response = await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.ok(response && response.ok(), 'mobile PR preview must return HTTP success');
  const tabs = page.locator('#nav button[data-tab]');
  assert.equal(await tabs.count(), 3, 'mobile viewport must render exactly three tabs');
  await page.locator('#nav button[data-tab="Sureshot"]').tap();
  await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent?.trim() === 'Sureshot CE/PE');
  await page.locator('#nav button[data-tab="Position"]').tap();
  await page.waitForSelector('#gvPaperLedger', { timeout: 5000 });
  assert.deepEqual(errors, [], 'mobile browser must have no uncaught JavaScript errors');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyDesktop(browser);
    await verifyMobile(browser);
    console.log('PASS: GV2VPD PR preview desktop + mobile smoke; Home/Sureshot/Position navigation works; Position/Paper ledger renders; live order placement stays disabled.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
