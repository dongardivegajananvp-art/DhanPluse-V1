const BACKEND_URL = 'https://dhanpluse-v1.onrender.com';

const nav = document.querySelector('#nav');
const title = document.querySelector('#pageTitle');
const panelTitle = document.querySelector('#panelTitle');
const featureTitle = document.querySelector('#featureTitle');
const featureDesc = document.querySelector('#featureDesc');
const featureContent = document.querySelector('#featureContent');

const descriptions = {
'Dashboard': ['Market overview', 'Verified FYERS market quotes and connection status.'],
'NIFTY': ['NIFTY 50 workspace', 'Live quote appears after FYERS authentication.'],
'BANKNIFTY': ['BANKNIFTY workspace', 'Live quote appears after FYERS authentication.'],
'Watchlist': ['Watchlist', 'Live quote integration is being verified.'],
'Option Chain': ['Option chain & OI', 'Option-chain data is not implemented in this connection step.'],
'AI Signals': ['Technical analysis & signals', 'No unverified or fabricated signals are shown.'],
'Holdings': ['Holdings & positions', 'Account data requires authenticated account endpoints.'],
'FYERS Settings': ['FYERS connection settings', 'Connect your FYERS account through the secure backend.'],
'Logs': ['System logs', 'Connection and quote status.']
};

function setStatus(message) {
const status = document.querySelector('#marketStatus');
if (status) status.textContent = message;
}

function setBackendStatus(message) {
const el = document.querySelector('#backendStatus');
if (el) el.textContent = message;
}

function setFyersStatus(message) {
const rows = document.querySelectorAll('.statusrow');
if (rows[2]?.lastElementChild) {
rows[2].lastElementChild.textContent = message;
}
}

function showMessage(message, isError = false) {
let el = document.querySelector('#dpMessage');

if (!el) {
el = document.createElement('p');
el.id = 'dpMessage';
el.className = 'hint';
featureContent.prepend(el);
}

el.textContent = message;
el.style.color = isError ? '#ff7777' : '';
}

function render(tab) {
title.textContent = tab;
panelTitle.textContent = descriptions[tab][0];
featureTitle.textContent = tab === 'Dashboard' ? 'Your tools' : tab;
featureDesc.textContent = descriptions[tab][1];

nav.querySelectorAll('button').forEach(button => {
button.classList.toggle('active', button.dataset.tab === tab);
});

featureContent.replaceChildren();

const items = tab === 'Dashboard'
? ['Technical indicators', 'Watchlist', 'Option chain & OI', 'Holdings & positions', 'Price alerts']
: tab === 'FYERS Settings'
? ['Secure FYERS login', 'Verified market quotes']
: tab === 'Option Chain'
? ['Option-chain integration pending']
: tab === 'Holdings'
? ['Account authentication required']
: tab === 'Watchlist'
? ['NIFTY 50', 'BANK NIFTY']
: tab === 'Logs'
? ['Connection status appears here']
: ['Waiting for verified live quote'];

items.forEach(item => {
const span = document.createElement('span');
span.className = 'chip';
span.textContent = item;
featureContent.append(span);
});

if (tab === 'FYERS Settings') {
const info = document.createElement('p');
info.className = 'hint';
info.textContent = 'Backend: ' + BACKEND_URL;
featureContent.append(info);

const test = document.createElement('button');
test.className = 'primary';
test.textContent = 'Test backend';
test.onclick = testBackend;
featureContent.append(test);

const connect = document.createElement('button');
connect.className = 'primary';
connect.style.marginLeft = '8px';
connect.textContent = 'Connect FYERS';
connect.onclick = startFyersLogin;
featureContent.append(connect);

}
}

async function testBackend() {
setBackendStatus('CHECKING…');

try {
const response = await fetch(BACKEND_URL + '/health', {
headers: { Accept: 'application/json' }
});

if (!response.ok) throw new Error('HTTP ' + response.status);

const data = await response.json();
setBackendStatus(data.ok ? 'ONLINE' : 'CHECK RESPONSE');

showMessage(
  data.ok
    ? 'Backend online. FYERS authentication still needs verification.'
    : 'Backend response was not verified.',
  !data.ok
);

} catch (error) {
setBackendStatus('UNREACHABLE');
showMessage('Backend test failed. Check the Render service and CORS settings.', true);
}
}

async function startFyersLogin() {
showMessage('Opening secure FYERS authorization…');

try {
const response = await fetch(BACKEND_URL + '/api/fyers/auth/start');

const data = await response.json();

if (!response.ok || !data.authorizationUrl) {
  throw new Error(data.error || 'Authorization URL unavailable.');
}

window.location.href = data.authorizationUrl;

} catch (error) {
showMessage('Could not start FYERS login. Check backend and CORS settings.', true);
}
}

function updateQuoteCards(quotes, fetchedAt) {
const metrics = document.querySelectorAll('.metric');
const quoteBySymbol = {};

quotes.forEach(item => {
const symbol = item.n || item.symbol;
const values = item.v || item;

if (symbol) quoteBySymbol[symbol] = values;

});

const cards = [
{ symbol: 'NSE:NIFTY50-INDEX', index: 1 },
{ symbol: 'NSE:NIFTYBANK-INDEX', index: 2 }
];

cards.forEach(card => {
const metric = metrics[card.index];
const quote = quoteBySymbol[card.symbol];

if (!metric || !quote) return;

const price = Number(quote.lp);

if (!Number.isFinite(price)) return;

const valueEl = metric.querySelector('strong');
const detailEl = metric.querySelector('small');

valueEl.textContent = price.toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

valueEl.classList.remove('muted');

const change = Number(quote.ch);
const percent = Number(quote.chp);

if (detailEl && Number.isFinite(change) && Number.isFinite(percent)) {
  detailEl.textContent =
    (change > 0 ? '+' : '') + change.toFixed(2) +
    ' (' + (percent > 0 ? '+' : '') + percent.toFixed(2) + '%)';
} else if (detailEl) {
  detailEl.textContent = 'FYERS quote received';
}

});

const lastUpdate = document.querySelector('#lastUpdate');
if (lastUpdate) {
lastUpdate.textContent = new Date(fetchedAt || Date.now()).toLocaleTimeString('en-IN');
lastUpdate.classList.remove('muted');
}

setStatus('LIVE QUOTES RECEIVED');
const connection = document.querySelector('#connectionValue');

if (connection) {
connection.textContent = 'FYERS Connected';
connection.classList.remove('muted');
}

setFyersStatus('CONNECTED');
}

async function fetchLiveQuotes() {
try {
const response = await fetch(BACKEND_URL + '/api/market/quotes', {
headers: { Accept: 'application/json' },
cache: 'no-store'
});

const data = await response.json();

if (!response.ok || !data.ok || !Array.isArray(data.data)) {
  if (response.status === 401) {
    setStatus('FYERS LOGIN REQUIRED');
    setFyersStatus('NOT CONNECTED');
  }
  return;
}

updateQuoteCards(data.data, data.fetchedAt);

} catch (error) {
setStatus('LIVE DATA UNAVAILABLE');
}
}

async function exchangeAuthCode() {
const params = new URLSearchParams(window.location.search);
const code = params.get('auth_code');

if (!code) return;

// Remove the one-time code from the address bar before making the request.
window.history.replaceState({}, document.title, window.location.pathname);

setStatus('VERIFYING FYERS LOGIN…');
setFyersStatus('VERIFYING…');
showMessage('FYERS login received. Verifying with the backend…');

try {
const response = await fetch(BACKEND_URL + '/api/fyers/auth/exchange', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
Accept: 'application/json'
},
body: JSON.stringify({ code })
});

const data = await response.json();

if (!response.ok || !data.ok) {
  throw new Error(data.error || data.detail || 'Authentication failed.');
}

setStatus('FYERS AUTHENTICATED');
setFyersStatus('CONNECTED');
showMessage('FYERS authentication succeeded. Checking live quotes…');

await fetchLiveQuotes();

} catch (error) {
setStatus('FYERS AUTH FAILED');
setFyersStatus('AUTH FAILED');
showMessage(
'FYERS authentication failed. Please check the Render logs and FYERS app settings, then try a fresh login.',
true
);
}
}

nav.addEventListener('click', event => {
const button = event.target.closest('button[data-tab]');
if (button) render(button.dataset.tab);
});

document.querySelector('#settingsBtn').addEventListener('click', () => {
render('FYERS Settings');
});

render('Dashboard');
testBackend();
exchangeAuthCode();

// Poll quotes only through the backend; never show sample/demo prices.
setInterval(fetchLiveQuotes, 15000);
fetchLiveQuotes();
