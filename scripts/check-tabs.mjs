import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const inlineApp = html.match(/<script>\s*([\s\S]*?)<\/script>/);
if (!inlineApp) throw new Error('Inline production app bundle is missing.');
const app = inlineApp[1];
const navBlock = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/);
if (!navBlock) throw new Error('Navigation block #nav is missing.');
const navTabs = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)]
  .map(match => match[1].replace(/&amp;/g, '&'));
if (navTabs.length !== 2 || navTabs[0] !== 'Sureshot CE/PE' || navTabs[1] !== 'FYERS Connection') {
  throw new Error('Expected the two existing trading app tabs; found: ' + navTabs.join(', '));
}
if (html.includes('id="publicNav"') || /data-tab="(?:Home|About|Features|Contact|Login|Signup|App)"/.test(html)) {
  throw new Error('Removed public pages are still exposed in navigation.');
}
if (app.includes('sureshotFyersConnectBtn')) throw new Error('FYERS connect button must not be rendered on the Sureshot tab.');
if (!app.includes("else if (tab === 'FYERS Connection') featureContent.innerHTML = settingsMarkup();")) {
  throw new Error('Dedicated FYERS Connection tab renderer is missing.');
}
if (!app.includes("render('Sureshot CE/PE');")) throw new Error('Sureshot must be the initial landing page.');
if (!app.includes("if (!['Sureshot CE/PE','FYERS Connection'].includes(tab)) tab = 'Sureshot CE/PE';")) throw new Error('Only Sureshot and FYERS Connection may be rendered.');
if (!app.includes('sureshotExchangeStatus') || !app.includes('sureshotNseTitle') || !app.includes('sureshotMcxTitle')) throw new Error('Separate NSE and MCX Sureshot status cards are required.');
if (!app.includes('let nseSureshotScanRunning = false;') || !app.includes('let mcxSureshotScanRunning = false;')) throw new Error('NSE and MCX Sureshot scans must have independent state.');
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
if (!app.includes("startAutomaticTopFiveScan();") || !app.includes("startAutomaticMcxTopFiveScan();") || !app.includes("}, 30000);")) throw new Error('Sureshot must detect NSE and MCX session starts while its tab is active.');
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
console.log('PASS: exactly two tabs remain; Sureshot is the landing page; NSE and MCX status/scans are independent.');
console.log('PASS: legacy watchlist/alert browser data cleared; shared FYERS session preserved; frontend cooldown guard removed.');
const scanTriggerStart = app.indexOf('const startAutomaticTopFiveScan');
const scanTriggerEnd = app.indexOf('sureshotAutoScanTimer = window.setInterval', scanTriggerStart);
if (scanTriggerStart < 0 || scanTriggerEnd < 0 || app.slice(scanTriggerStart, scanTriggerEnd).includes('sureshotRequestRunning')) {
  throw new Error('Automatic Sureshot scan must not wait for a lower-priority chart/history request.');
}
if (!app.includes('function applyAuthoritativeFyersStatus(status, restCooldown = false)') ||
    !app.includes("label = 'FYERS SOCKET DISCONNECTED'") ||
    !app.includes("label = 'FYERS FEED PARTIAL'")) {
  throw new Error('Dashboard connection labels must follow the authoritative backend NSE feed state.');
}

const sw = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');
if (!app.includes('SURESHOT_AUTO_SCAN_ATTEMPT_KEY') ||
    !app.includes('refreshAuthoritativeFyersStatus') ||
    !app.includes("window.setInterval(() => { void refreshAuthoritativeFyersStatus(); }, 5000)") ||
    !app.includes("document.addEventListener('visibilitychange'") ||
    !app.includes("window.addEventListener('pageshow'") ||
    !html.includes('app.js?v=20261106-authoritative-status-v2') ||
    !html.includes('sw.js?v=20261106-authoritative-status-v2') ||
    !sw.includes('dhanpulse-shell-v134-public-pages-v1') ||
    !sw.includes('app.js?v=20261106-authoritative-status-v2') ||
    !sw.includes("fetch(request, { cache: 'no-store' })")) {
  throw new Error('PWA cache and bounded Sureshot automatic-attempt guard must be present in the published shell.');
}
if (!app.includes('settingsMcxFeed') || !app.includes('refreshConnectionDiagnostics') || !app.includes('updateMcxConnectionDiagnostics') || !app.includes('settingsNseSession') || !app.includes('settingsNseLiveFeed') || !app.includes('settingsMcxSession') || !app.includes('settingsMcxLiveFeed') || !app.includes('updateExchangeLiveSwitches')) throw new Error('MCX diagnostics must be visible in the existing FYERS Connection tab.');
console.log('PASS: PWA shell v134 loads the bounded Sureshot scan-attempt guard, MCX diagnostics, and independent NSE/MCX live switches in the existing FYERS Connection tab.');
