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
if (!html.includes('id="backendDiagnostic"') || !app.includes("setBackendDiagnostic(message, isError = false)") || !app.includes("GET /api/status HTTP ")) throw new Error('Dashboard must expose exact backend HTTP/network failures instead of hiding them.');
    !app.includes("headers.set('Authorization', 'Bearer ' + requestSession)") ||
    !app.includes('Dashboard session missing or expired')) {
  throw new Error('The existing FYERS dashboard-session authentication flow must remain intact.');
}
if (!app.includes("const initialTab = new URLSearchParams(window.location.search).get('tab');") ||
    !app.includes("render(initialTab === 'Position' ? 'Position' : 'Home');") ||
    !app.includes("if (tab === 'Home') tab = 'Dashboard';") ||
    !app.includes("else if (tab === 'Sureshot') tab = 'Sureshot CE/PE';")) {
  throw new Error('Home must remain the default landing page, direct Position links must work, and Sureshot must map to the existing verified scanner.');
}
const backend = fs.readFileSync(new URL('../backend/src/server.js', import.meta.url), 'utf8');
if (!app.includes("BACKEND_URL + '/api/fyers/funds'") || !app.includes('homeAccountSnapshot') || !backend.includes('normalizeFyersFunds')) {
  throw new Error('Home must show verified FYERS funds and position P&L fields.');
}
if (!app.includes("if (tab === 'Position')") ||
    !app.includes("BACKEND_URL + '/api/fyers/positions'") ||
    !app.includes('Broker-confirmed positions')) {
  throw new Error('Position must display the broker-confirmed FYERS position response.');
}

const paperStore = fs.readFileSync(new URL('../backend/src/paper-trading-store.js', import.meta.url), 'utf8');
const planRegistry = fs.readFileSync(new URL('../backend/src/verified-plan-registry.js', import.meta.url), 'utf8');
const paperSubscriptions = fs.readFileSync(new URL('../backend/src/paper-socket-subscriptions.js', import.meta.url), 'utf8');
if (!backend.includes("app.use('/api/paper', requireDashboardSession)") ||
    !backend.includes("app.post('/api/paper/buy'") ||
    !backend.includes("verifiedPlanRegistry.create(sessionToken") ||
    !backend.includes("verifiedPlanRegistry.get(sessionToken, planId)") ||
    !backend.includes("quoteTimestampStatus(quoteTime, Date.now(), 10)") ||
    !backend.includes("buildFixedOptionRiskPlan({ entryPrice: ask") ||
    !backend.includes("const idempotencyKey = 'paper:' + planId;") ||
    !backend.includes("void paperStore.processVerifiedQuote") ||
    !backend.includes("void reconcileOpenPaperPositions(result.added)") ||
    !backend.includes("result?.updates?.some(position => position.state === 'CLOSED')") ||
    !paperSubscriptions.includes("socket.unsubscribe(removed, false)") ||
    !planRegistry.includes("crypto.randomBytes(32).toString(\"base64url\")") ||
    !planRegistry.includes("entry.owner !== String(sessionBinding || \"\")")) {
  throw new Error('Paper BUY must require an authenticated, short-lived server-owned plan and fresh FYERS quote; exits must use verified socket/restart quotes.');
}
if (!paperStore.includes("pg_advisory_xact_lock(716202611)") ||
    !paperStore.includes("last_quote_timestamp") ||
    !paperStore.includes("Maximum two open Paper positions allowed.") ||
    !paperStore.includes("An open Paper position already exists for this option contract.") ||
    !paperStore.includes("Daily paper loss limit of ₹5,000")) {
  throw new Error('Paper ledger persistence, concurrency, out-of-order quote, max-position and daily-loss guards are required.');
}
const paperBuyRoute = backend.slice(backend.indexOf("app.post('/api/paper/buy'"), backend.indexOf("app.all('/api/orders/*'"));
if (!paperBuyRoute || paperBuyRoute.includes('/api/v3/orders') || !backend.includes("app.all('/api/orders/*', (_req, res) => {\n  res.status(403)")) {
  throw new Error('Paper Mode must never call FYERS order endpoints and live order routes must remain blocked.');
}
if (!app.includes("BACKEND_URL + '/api/paper/buy'") ||
    !app.includes("BACKEND_URL + '/api/paper/positions'") ||
    !app.includes('Paper Mode ledger · simulation only')) {
  throw new Error('Position must show a separate durable Paper Mode ledger and Paper BUY must use the verified plan ID.');
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
if (!app.includes("id=\\"backendDiagnostic\\"") || !app.includes("setBackendDiagnostic(message, isError = false)") || !app.includes("GET /api/status HTTP ")) throw new Error('Dashboard must expose exact backend HTTP/network failures instead of hiding them.');
console.log('PASS: exactly three tabs; Home is default; Sureshot scanner preserved; broker and Paper positions are separated.');
console.log('PASS: Paper BUY is Dashboard-Session-bound, server-plan-bound and fresh-FYERS-quote-verified; automatic exits are quote-monitored.');
console.log('PASS: existing FYERS OAuth/dashboard-session login is retained; no duplicate OTP login gate exists.');
