import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const inlineApp = html.match(/<script>\s*([\s\S]*?)<\/script>/);
if (!inlineApp) throw new Error('Inline production app bundle is missing.');
const app = inlineApp[1];
const navBlock = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/);
if (!navBlock) throw new Error('Navigation block #nav is missing.');
const navTabs = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
if (navTabs.length !== 3 || navTabs.join('|') !== 'Home|Sureshot|Position') {
  throw new Error('Expected exactly Home, Sureshot and Position; found: ' + navTabs.join(', '));
}
if (html.includes('id="publicNav"') || /data-tab="(?:Dashboard|FYERS Connection|Stock Explorer|About|Features|Contact|Login|Signup)"/.test(html)) {
  throw new Error('Legacy or public navigation remains exposed.');
}
if (html.includes('gv2vpdAuthGate') ||
    html.includes('gv2vpd-app-session-v1') ||
    html.includes('X-GV2VPD-Session') ||
    html.includes('/api/app-auth/')) {
  throw new Error('A duplicate GV2VPD OTP App Login must not replace the existing FYERS login.');
}
if (!app.includes("localStorage.getItem(DASHBOARD_SESSION_KEY)") ||
    !app.includes("headers.set('Authorization', 'Bearer ' + requestSession)") ||
    !app.includes('Dashboard session missing or expired')) {
  throw new Error('The existing FYERS dashboard-session authentication flow must remain intact.');
}
if (!app.includes("render('Home');") ||
    !app.includes("if (tab === 'Home') tab = 'Dashboard';") ||
    !app.includes("else if (tab === 'Sureshot') tab = 'Sureshot CE/PE';")) {
  throw new Error('Home must be the landing page and Sureshot must map to the existing verified scanner.');
}
const backend = fs.readFileSync(new URL('../backend/src/server.js', import.meta.url), 'utf8');
if (!app.includes("BACKEND_URL + '/api/fyers/funds'") || !app.includes('homeAccountSnapshot') || !backend.includes('normalizeFyersFunds')) {
  throw new Error('Home must show verified FYERS funds and position P&L fields.');
}\nif (!app.includes("if (tab === 'Position')") ||
    !app.includes("BACKEND_URL + '/api/fyers/positions'") ||
    !app.includes('Broker-confirmed positions')) {
  throw new Error('Position must display the broker-confirmed FYERS position response.');
}
if (!app.includes("tab === 'Sureshot CE/PE') featureContent.innerHTML = advancedScannerMarkup(tab)") ||
    !app.includes('async function loadSureshotUniverseShortlist(options = {})')) {
  throw new Error('Existing FYERS-verified Sureshot scanner must be preserved.');
}
if (!app.includes('refreshAuthoritativeFyersStatus') ||
    !app.includes("window.setInterval(() => { void refreshAuthoritativeFyersStatus(); }, 5000)") ||
    !app.includes('SURESHOT_AUTO_SCAN_ATTEMPT_KEY')) {
  throw new Error('Authoritative FYERS status refresh and bounded Sureshot auto-scan guard must remain.');
}
if (!html.includes('GV2VPD — FYERS') ||
    !html.includes('sw.js?v=20261108-gv2vpd-three-tab-v1')) {
  throw new Error('GV2VPD identity and versioned PWA shell must be published together.');
}
const sw = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');
if (!sw.includes('gv2vpd-shell-v3-three-tab-app') ||
    !sw.includes('gv2vpd-icon.svg') ||
    !sw.includes("fetch(request, { cache: 'no-store' })")) {
  throw new Error('GV2VPD service-worker cache shell is incomplete.');
}
console.log('PASS: exactly three tabs; Home is default; Sureshot scanner preserved; Position reads FYERS positions.');
console.log('PASS: existing FYERS OAuth/dashboard-session login is retained; no duplicate OTP login gate exists.');
