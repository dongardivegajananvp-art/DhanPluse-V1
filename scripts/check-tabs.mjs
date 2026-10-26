import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const navBlock = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/);
if (!navBlock) throw new Error('Navigation block #nav is missing.');

const navTabs = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)]
  .map(match => match[1].replace(/&amp;/g, '&'));
const descriptionsBlock = app.match(/const descriptions = \{([\s\S]*?)\n\};/);
if (!descriptionsBlock) throw new Error('Tab descriptions registry is missing.');
const describedTabs = [...descriptionsBlock[1].matchAll(/^\s*'([^']+)':\s*\[/gm)]
  .map(match => match[1]);

const duplicates = values => values.filter((value, index) => values.indexOf(value) !== index);
const approvedHiddenTabs = new Set(['Stock Explorer','NIFTY','BANKNIFTY','Watchlist','FII/DII Flow','Market Activity','Option Chain','Technical Indicators','Alerts','Logs','Trade Journal','Capital Protection']);
const missingNavigation = describedTabs.filter(tab => !navTabs.includes(tab) && !approvedHiddenTabs.has(tab));
const missingDescription = navTabs.filter(tab => !describedTabs.includes(tab));
const duplicateNav = duplicates(navTabs);
if (navTabs.length !== 12 || describedTabs.length !== 24 ||
    missingNavigation.length || missingDescription.length || duplicateNav.length) {
  console.error(JSON.stringify({ navCount: navTabs.length, descriptionCount: describedTabs.length,
    missingNavigation, missingDescription, duplicateNav }, null, 2));
  process.exit(1);
}
const renderStart = app.indexOf('function render(tab) {');
const renderEnd = app.indexOf('\nfunction bindTabActions', renderStart);
if (renderStart < 0 || renderEnd < 0) throw new Error('Workspace render function could not be located.');
const renderBlock = app.slice(renderStart, renderEnd);

const requiredRenderRoutes = [
  ['Dashboard', "if (tab === 'Dashboard') { featureContent.innerHTML = dashboardMarkup()"],
  ['Stock Explorer', "tab === 'Stock Explorer') featureContent.innerHTML = stockExplorerMarkup()"],
  ['NIFTY', "tab === 'NIFTY') featureContent.innerHTML = focusedQuoteMarkup(SYMBOLS[0].symbol)"],
  ['BANKNIFTY', "tab === 'BANKNIFTY') featureContent.innerHTML = focusedQuoteMarkup(SYMBOLS[1].symbol)"],
  ['Watchlist', "tab === 'Watchlist') featureContent.innerHTML = watchlistMarkup()"],
  ['Sureshot CE/PE', "tab === 'Sureshot CE/PE') featureContent.innerHTML = advancedScannerMarkup(tab)"],
  ['Breakout Scanner', "['Breakout Scanner','Momentum Scanner','Zero-to-Hero'].includes(tab)"],
  ['Momentum Scanner', "['Breakout Scanner','Momentum Scanner','Zero-to-Hero'].includes(tab)"],
  ['Zero-to-Hero', "['Breakout Scanner','Momentum Scanner','Zero-to-Hero'].includes(tab)"],
  ['FII/DII Flow', "tab === 'FII/DII Flow') featureContent.innerHTML = advancedScannerMarkup(tab)"],
  ['Market Activity', "tab === 'Market Activity') featureContent.innerHTML = marketActivityMarkup()"],
  ['Charts & Patterns', "tab === 'Charts & Patterns') featureContent.innerHTML = advancedScannerMarkup(tab)"],
  ['Gap-Up/Down', "tab === 'Gap-Up/Down') featureContent.innerHTML = gapAnalysisMarkup()"],
  ['Gainers & Losers', "tab === 'Gainers & Losers') featureContent.innerHTML = moversMarkup()"],
  ['Option Chain', "tab === 'Option Chain') featureContent.innerHTML = optionChainMarkup()"],
  ['Technical Indicators', "tab === 'Technical Indicators') featureContent.innerHTML = indicatorsMarkup()"],
  ['AI Signals', "tab === 'AI Signals') featureContent.innerHTML = signalsMarkup()"],
  ['Holdings', "tab === 'Holdings') featureContent.innerHTML = holdingsMarkup()"],
  ['Alerts', "tab === 'Alerts') featureContent.innerHTML = alertsMarkup()"],
  ['FYERS Settings', "tab === 'FYERS Settings') featureContent.innerHTML = settingsMarkup()"],
  ['Logs', "tab === 'Logs') featureContent.innerHTML = '<div id=\"logList\" class=\"log-list\"></div>'"],
  ['Trade Journal', "['Trade Journal','Capital Protection','Backtesting'].includes(tab)"],
  ['Capital Protection', "['Trade Journal','Capital Protection','Backtesting'].includes(tab)"],
  ['Backtesting', "['Trade Journal','Capital Protection','Backtesting'].includes(tab)"]
];
const missingRenderRoutes = requiredRenderRoutes
  .filter(([tab, snippet]) => navTabs.includes(tab) && !renderBlock.includes(snippet))
  .map(([tab]) => tab);
if (missingRenderRoutes.length) {
  console.error('Tabs without a dedicated renderer route: ' + missingRenderRoutes.join(', '));
  process.exit(1);
}
if (requiredRenderRoutes.length !== 24) throw new Error('Render-route audit must cover all 24 original tab routes.');
console.log('Tab audit passed: 12 approved navigation tabs, 24 registered render routes, no duplicate navigation, and every visible tab has a description and renderer.');
