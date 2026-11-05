import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const navBlock = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/);
if (!navBlock) throw new Error('Navigation block #nav is missing.');
const navTabs = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)]
  .map(match => match[1].replace(/&amp;/g, '&'));
if (navTabs.length !== 2 || navTabs[0] !== 'Sureshot CE/PE' || navTabs[1] !== 'FYERS Connection') {
  throw new Error('Expected exactly two visible tabs (Sureshot CE/PE, FYERS Connection); found: ' + navTabs.join(', '));
}
if (!navBlock[1].includes('class="active"') || !navBlock[1].includes('class="active" data-tab="Sureshot CE/PE"')) {
  throw new Error('Sureshot CE/PE must be the active initial tab.');
}
if (app.includes('sureshotFyersConnectBtn')) throw new Error('FYERS connect button must not be rendered on the Sureshot tab.');
if (!app.includes("else if (tab === 'FYERS Connection') featureContent.innerHTML = settingsMarkup();")) {
  throw new Error('Dedicated FYERS Connection tab renderer is missing.');
}
if (!app.includes("render('Sureshot CE/PE');")) throw new Error('Sureshot CE/PE must be the initial workspace.');
const renderStart = app.indexOf('function render(tab) {');
const renderEnd = app.indexOf('\nfunction bindTabActions', renderStart);
if (renderStart < 0 || renderEnd < 0) throw new Error('Workspace render function could not be located.');
const renderBlock = app.slice(renderStart, renderEnd);
if (!renderBlock.includes("tab === 'Sureshot CE/PE') featureContent.innerHTML = advancedScannerMarkup(tab)")) {
  throw new Error('Sureshot CE/PE renderer is missing.');
}
if (!app.includes('async function loadSureshotUniverseShortlist(options = {})')) throw new Error('Sureshot full-universe shortlist loader is missing.');
if (!app.includes('startAutomaticTopFiveScan();') || !app.includes('SURESHOT_AUTO_SCAN_DAY_KEY') || !app.includes("localStorage.getItem(DASHBOARD_SESSION_KEY)")) {
  throw new Error('Authenticated automatic full-universe Top 5 scan trigger is missing.');
}
if (!app.includes("window.setInterval(startAutomaticTopFiveScan, 30000)")) throw new Error('Sureshot must detect the start of the regular NSE session while its tab is active.');
if (!app.includes("localStorage.removeItem('dhanpulse-watchlist-v1')") ||
    !app.includes("localStorage.removeItem('dhanpulse-price-alerts')")) {
  throw new Error('Legacy watchlist and alert data must be cleared from browser storage.');
}
if (!app.includes("localStorage.getItem('dhanpulse-dashboard-session-v1')") ||
    app.includes('FYERS_COOLDOWN_KEY') ||
    app.includes('getFyersCooldownRemaining') ||
    app.includes('FYERS Data API cooldown active; request suppressed locally.')) {
  throw new Error('FYERS shared session must remain intact and obsolete browser-local cooldown blocking must be absent.');
}
const dashboardCandleStart = app.indexOf('async function loadDashboardCandles()');
const dashboardCandleEnd = app.indexOf('\nfunction quoteCardsMarkup()', dashboardCandleStart);
if (dashboardCandleStart < 0 || dashboardCandleEnd < 0) {
  throw new Error('Dashboard candle request handler could not be located.');
}
const dashboardCandleHandler = app.slice(dashboardCandleStart, dashboardCandleEnd);
if (!dashboardCandleHandler.includes("const requestSession = localStorage.getItem(DASHBOARD_SESSION_KEY) || '';") ||
    !dashboardCandleHandler.includes("currentSession && currentSession !== requestSession") ||
    !dashboardCandleHandler.includes("if (requestSession && currentSession === requestSession) localStorage.removeItem(DASHBOARD_SESSION_KEY)")) {
  throw new Error('Dashboard candle 401 handler must preserve a newer FYERS session.');
}
if (dashboardCandleHandler.includes("localStorage.removeItem('dhanpulse-dashboard-session-v1')")) {
  throw new Error('Unconditional dashboard-session deletion remains in the candle handler.');
}
console.log('PASS: exactly two visible tabs (Sureshot CE/PE, FYERS Connection); connection controls are separated from Sureshot.');
console.log('PASS: legacy watchlist/alert browser data cleared; shared FYERS session preserved; frontend cooldown guard removed.');

const sw = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');
if (!app.includes('SURESHOT_AUTO_SCAN_ATTEMPT_KEY') ||
    !html.includes('app.js?v=20261105-mcx-sureshot-v1') ||
    !html.includes('sw.js?v=20261105-mcx-sureshot-v1') ||
    !sw.includes('dhanpulse-shell-v130-mcx-sureshot-v1') ||
    !sw.includes('app.js?v=20261105-mcx-sureshot-v1') ||
    !sw.includes("fetch(request, { cache: 'no-store' })")) {
  throw new Error('PWA cache and bounded Sureshot automatic-attempt guard must be present in the published shell.');
}
if (!app.includes('settingsMcxFeed') || !app.includes('refreshConnectionDiagnostics') || !app.includes('updateMcxConnectionDiagnostics') || !app.includes('settingsNseSession') || !app.includes('settingsNseLiveFeed') || !app.includes('settingsMcxSession') || !app.includes('settingsMcxLiveFeed') || !app.includes('updateExchangeLiveSwitches')) throw new Error('MCX diagnostics must be visible in the existing FYERS Connection tab.');
console.log('PASS: PWA shell v128 loads the bounded Sureshot scan-attempt guard, MCX diagnostics, and independent NSE/MCX live switches in the existing FYERS Connection tab.');
