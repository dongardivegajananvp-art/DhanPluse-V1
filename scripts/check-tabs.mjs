import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const navBlock = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/);
if (!navBlock) throw new Error('Navigation block #nav is missing.');
const navTabs = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)]
  .map(match => match[1].replace(/&amp;/g, '&'));
if (navTabs.length !== 1 || navTabs[0] !== 'Sureshot CE/PE') {
  throw new Error('Expected exactly one visible tab, Sureshot CE/PE; found: ' + navTabs.join(', '));
}
if (!navBlock[1].includes('class="active"')) throw new Error('Sureshot CE/PE must be the active tab.');
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
if (!app.includes("sessionStorage.getItem('dhanpulse-dashboard-session-v1')") ||
    !app.includes("const FYERS_COOLDOWN_KEY")) {
  throw new Error('FYERS session and cooldown protections must remain intact.');
}
console.log('PASS: exactly one visible tab (Sureshot CE/PE); Sureshot renderer and shortlist loader retained.');
console.log('PASS: legacy watchlist/alert browser data cleared; FYERS session and rate-limit guard preserved.');
