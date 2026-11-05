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
if (!app.includes("loadSureshotUniverseShortlist()")) throw new Error('Sureshot shortlist loader is missing.');
if (!app.includes("localStorage.removeItem('dhanpulse-watchlist-v1')") ||
    !app.includes("localStorage.removeItem('dhanpulse-price-alerts')")) {
  throw new Error('Legacy watchlist and alert data must be cleared from browser storage.');
}
if (!app.includes("localStorage.getItem('dhanpulse-dashboard-session-v1')") ||
    !app.includes("const FYERS_COOLDOWN_KEY")) {
  throw new Error('FYERS session and cooldown protections must remain intact.');
}
console.log('PASS: exactly two visible tabs (Sureshot CE/PE, FYERS Connection); connection controls are separated from Sureshot.');
console.log('PASS: legacy watchlist/alert browser data cleared; FYERS session and rate-limit guard preserved.');

const sw = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');
if (!html.includes('app.js?v=20261105-session-race-v3') ||
    !html.includes('sw.js?v=20261105-session-race-v3') ||
    !sw.includes('dhanpulse-shell-v122-session-race-v3') ||
    !sw.includes("fetch(request, { cache: 'no-store' })")) {
  throw new Error('PWA session-cache fix must force a new shell cache and bypass stale browser HTTP cache for app assets.');
}
console.log('PASS: PWA shell cache is version-bumped and app assets revalidate against the network before cache fallback.');
