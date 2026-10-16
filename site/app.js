const BACKEND_URL = 'https://dhanpluse-v1.onrender.com';
const QUOTE_POLL_MS = 1500;
const QUOTE_POLL_MAX_MS = 10000;
const SYMBOLS = [
  { symbol: 'NSE:NIFTY50-INDEX', label: 'NIFTY 50', tab: 'NIFTY' },
  { symbol: 'NSE:NIFTYBANK-INDEX', label: 'BANK NIFTY', tab: 'BANKNIFTY' }
];

const nav = document.querySelector('#nav');
const title = document.querySelector('#pageTitle');
const panelTitle = document.querySelector('#panelTitle');
const featureTitle = document.querySelector('#featureTitle');
const featureDesc = document.querySelector('#featureDesc');
const featureContent = document.querySelector('#featureContent');

let quoteTimer = null;
let quotePollDelay = QUOTE_POLL_MS;
let quoteRequestRunning = false;
let authInProgress = false;
let optionRequestRunning = false;
let portfolioRequestRunning = false;
let currentTab = 'Dashboard';
let latestQuotes = {};
let historyBySymbol = {};
let appLogs = [];
let alerts = loadAlerts();

SYMBOLS.forEach(item => { historyBySymbol[item.symbol] = []; });

const descriptions = {
  'Dashboard': ['Market overview', 'Live FYERS quotes, recent price movement, and console health.'],
  'NIFTY': ['NIFTY 50 workspace', 'Live index quote and recent received-price history.'],
  'BANKNIFTY': ['BANK NIFTY workspace', 'Live index quote and recent received-price history.'],
  'Watchlist': ['Live watchlist', 'Verified symbols currently streamed by the FYERS backend.'],
  'Option Chain': ['Option chain & open interest', 'Option-chain values must come from a verified FYERS response.'],
  'Technical Indicators': ['Technical indicators', 'Calculated from received quote samples; these are not candle-based indicators.'],
  'AI Signals': ['Market signals', 'Transparent momentum summaries from recent received quotes, not investment advice.'],
  'Holdings': ['Holdings & positions', 'Account data is private and shown only after a verified account endpoint is available.'],
  'Alerts': ['Price alerts', 'Browser-local alerts for the two live index quotes.'],
  'FYERS Settings': ['FYERS connection settings', 'Connect through the secure backend; credentials remain server-side.'],
  'Logs': ['System logs', 'Recent frontend, backend, and live-quote events.']
};

function logEvent(message, level) {
  appLogs.unshift({ time: new Date().toLocaleTimeString('en-IN'), message: message, level: level || 'info' });
  appLogs = appLogs.slice(0, 80);
  if (currentTab === 'Logs') renderLogs();
}

function setStatus(message) {
  const el = document.querySelector('#marketStatus');
  if (el) el.textContent = message;
  const connected = message === 'FYERS QUOTES RECEIVED';
  const waiting = document.querySelector('#sideFeedStatus') || document.querySelector('.sidefoot span:last-child');
  const footer = document.querySelector('#footerFeedStatus') || document.querySelector('footer span:last-child');
  const dot = document.querySelector('#sideFeedDot') || document.querySelector('.sidefoot .dot');
  const headerDot = document.querySelector('.market-pill .dot');
  if (waiting) waiting.textContent = connected ? 'Live feed connected' : message === 'LIVE DATA STALE' ? 'Live feed stale' : 'Waiting for verified live feed';
  if (footer) footer.textContent = connected ? 'Live FYERS quotes received' : message === 'LIVE DATA STALE' ? 'Last quote is stale' : 'Waiting for verified live feed';
  [dot, headerDot].filter(Boolean).forEach(item => {
    item.style.background = connected ? '#63e6d0' : '#64738a';
    item.title = connected ? 'Verified quote response received' : 'No fresh verified quote response';
  });
  const connectionDetail = document.querySelector('.metrics .metric:first-child small');
  if (connectionDetail) connectionDetail.textContent = connected ? 'Live quotes verified from backend' : 'Awaiting verified response';
  const welcomeCopy = document.querySelector('.welcome > div > p:last-child');
  if (welcomeCopy) welcomeCopy.textContent = connected
    ? 'FYERS live market ticks are arriving for NIFTY 50 and BANK NIFTY.'
    : 'Live quotes appear here only after the backend returns verified FYERS data.';
  const empty = document.querySelector('.empty');
  if (empty) {
    const heading = empty.querySelector('h3');
    const copy = empty.querySelector('p');
    if (heading) heading.textContent = connected ? 'Live market feed connected' : 'Waiting for a verified FYERS quote';
    if (copy) copy.textContent = connected
      ? 'The backend is returning fresh NIFTY 50 and BANK NIFTY quotes.'
      : 'The console will display prices only after verified quote data is received.';
  }
}

function setBackendStatus(message) {
  const el = document.querySelector('#backendStatus');
  if (el) el.textContent = message;
}

function setFyersStatus(message) {
  const rows = document.querySelectorAll('.statusrow');
  if (rows[2] && rows[2].lastElementChild) rows[2].lastElementChild.textContent = message;
}

function showMessage(message, isError) {
  if (!featureContent) return;
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

function setConnection(message, muted) {
  const el = document.querySelector('#connectionValue');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('muted', muted !== false);
}

function formatPrice(value) {
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quoteFor(symbol) { return latestQuotes[symbol] || null; }

function quoteAgeMs(quote) {
  if (!quote || !quote.receivedAt) return Infinity;
  return Date.now() - quote.receivedAt;
}

function calculateIndicators(symbol) {
  const values = (historyBySymbol[symbol] || []).map(point => point.price);
  const sma = function (n) {
    if (values.length < n) return null;
    const sample = values.slice(-n);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  };
  let gains = 0;
  let losses = 0;
  const changes = [];
  for (let i = 1; i < values.length; i++) changes.push(values[i] - values[i - 1]);
  changes.slice(-14).forEach(change => {
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  });
  const sampleCount = Math.min(14, changes.length);
  let rsi = null;
  if (sampleCount > 0) {
    const avgGain = gains / sampleCount;
    const avgLoss = losses / sampleCount;
    rsi = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - (100 / (1 + avgGain / avgLoss));
  }
  const last = values.length ? values[values.length - 1] : null;
  return { samples: values.length, last: last, sma5: sma(5), sma20: sma(20), rsi14: rsi, changes: changes };
}

function signalFor(symbol) {
  const data = calculateIndicators(symbol);
  if (data.samples < 5 || data.changes.length < 4) {
    return { label: 'Collecting data', detail: 'Need more live quote samples before summarising momentum.', tone: 'neutral' };
  }
  const recent = data.changes.slice(-5);
  const net = recent.reduce((sum, value) => sum + value, 0);
  const current = data.last;
  const sma5 = data.sma5;
  if (sma5 !== null && current > sma5 && net > 0) {
    return { label: 'Positive short-term momentum', detail: 'Recent samples are rising and price is above the 5-sample average. Not a buy recommendation.', tone: 'positive' };
  }
  if (sma5 !== null && current < sma5 && net < 0) {
    return { label: 'Negative short-term momentum', detail: 'Recent samples are falling and price is below the 5-sample average. Not a sell recommendation.', tone: 'negative' };
  }
  return { label: 'Mixed / sideways', detail: 'Recent samples do not show a consistent direction. No trade recommendation is generated.', tone: 'neutral' };
}

function svgChart(symbol, height) {
  const points = (historyBySymbol[symbol] || []).slice(-60);
  const h = height || 180;
  if (points.length < 2) return '<div class="chart-empty">Waiting for more verified quote samples…</div>';
  const prices = points.map(point => point.price);
  let min = Math.min.apply(null, prices);
  let max = Math.max.apply(null, prices);
  if (max === min) { max += 1; min -= 1; }
  const pad = 8;
  const width = 720;
  const plotH = h - pad * 2;
  const coords = prices.map((price, index) => {
    const x = pad + (index / (prices.length - 1)) * (width - pad * 2);
    const y = h - pad - ((price - min) / (max - min)) * plotH;
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const latest = prices[prices.length - 1];
  const first = prices[0];
  const stroke = latest >= first ? '#63e6d0' : '#ff8d9a';
  return '<svg class="live-chart" viewBox="0 0 ' + width + ' ' + h + '" role="img" aria-label="Recent received quote samples">' +
    '<line x1="8" y1="' + (h * 0.25) + '" x2="' + (width - 8) + '" y2="' + (h * 0.25) + '" class="chart-grid"/>' +
    '<line x1="8" y1="' + (h * 0.5) + '" x2="' + (width - 8) + '" y2="' + (h * 0.5) + '" class="chart-grid"/>' +
    '<line x1="8" y1="' + (h * 0.75) + '" x2="' + (width - 8) + '" y2="' + (h * 0.75) + '" class="chart-grid"/>' +
    '<polyline points="' + coords.join(' ') + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<text x="12" y="16" class="chart-label">HIGH ' + formatPrice(max) + '</text>' +
    '<text x="12" y="' + (h - 3) + '" class="chart-label">LOW ' + formatPrice(min) + '</text></svg>';
}

function quoteCardsMarkup() {
  return SYMBOLS.map(item => {
    const quote = quoteFor(item.symbol);
    const price = quote ? formatPrice(quote.price) : '—';
    const change = quote && Number.isFinite(quote.change) ? (quote.change > 0 ? '+' : '') + quote.change.toFixed(2) : '—';
    const changePct = quote && Number.isFinite(quote.changePct) ? ' (' + (quote.changePct > 0 ? '+' : '') + quote.changePct.toFixed(2) + '%)' : '';
    return '<article class="console-card"><div class="console-card-head"><span>' + item.label + '</span><span class="live-tag">FYERS</span></div><strong class="console-price" data-price-symbol="' + item.symbol + '">' + price + '</strong><small class="quote-change" data-change-symbol="' + item.symbol + '">' + change + changePct + '</small><div class="mini-chart" data-mini-symbol="' + item.symbol + '">' + svgChart(item.symbol, 80) + '</div><small class="quote-time" data-time-symbol="' + item.symbol + '">' + (quote ? new Date(quote.receivedAt).toLocaleTimeString('en-IN') : 'Waiting for quote') + '</small></article>';
  }).join('');
}

function dashboardMarkup() {
  return '<div class="console-grid">' + quoteCardsMarkup() + '</div>' +
    '<article class="console-section"><div class="console-section-head"><div><h4>Live quote trace</h4><p>Recent received prices · sampled by this browser</p></div><span class="live-tag">READ ONLY</span></div>' +
    '<div id="dashboardChart">' + svgChart(SYMBOLS[0].symbol, 210) + '</div>' +
    '<div class="chart-foot"><span id="chartSampleCount">Samples: ' + (historyBySymbol[SYMBOLS[0].symbol] || []).length + '</span><span>Not a candlestick chart</span></div></article>' +
    '<div class="console-grid console-grid-2"><article class="console-section"><h4>Connection monitor</h4><div class="data-row"><span>Frontend</span><b class="positive-text">ONLINE</b></div><div class="data-row"><span>Backend</span><b id="dashBackend">CHECKING</b></div><div class="data-row"><span>FYERS quote stream</span><b id="dashFeed">WAITING</b></div><div class="data-row"><span>Order placement</span><b class="warning-text">DISABLED</b></div></article><article class="console-section"><h4>Console modules</h4><div class="module-links"><button data-jump="Technical Indicators">Technical indicators</button><button data-jump="Option Chain">Option chain &amp; OI</button><button data-jump="Alerts">Price alerts</button><button data-jump="Holdings">Holdings &amp; positions</button></div></article></div>';
}

function focusedQuoteMarkup(symbol) {
  const item = SYMBOLS.find(entry => entry.symbol === symbol);
  const quote = quoteFor(symbol);
  const indicators = calculateIndicators(symbol);
  return '<div class="focus-price"><div><span>' + item.label + '</span><strong data-price-symbol="' + symbol + '">' + (quote ? formatPrice(quote.price) : '—') + '</strong><small data-change-symbol="' + symbol + '">' + (quote && Number.isFinite(quote.change) ? quote.change.toFixed(2) : 'Waiting for change data') + '</small></div><span class="live-tag">FYERS LIVE</span></div>' +
    '<article class="console-section"><div class="console-section-head"><div><h4>Recent quote movement</h4><p>Up to 60 samples received by this browser</p></div><span class="quote-time" data-time-symbol="' + symbol + '">' + (quote ? new Date(quote.receivedAt).toLocaleTimeString('en-IN') : 'Waiting') + '</span></div><div id="focusChart">' + svgChart(symbol, 250) + '</div></article>' +
    '<div class="console-grid console-grid-3"><article class="console-section"><small>SMA · 5 samples</small><strong id="focusSma5">' + (indicators.sma5 === null ? 'Collecting…' : formatPrice(indicators.sma5)) + '</strong></article><article class="console-section"><small>SMA · 20 samples</small><strong id="focusSma20">' + (indicators.sma20 === null ? 'Collecting…' : formatPrice(indicators.sma20)) + '</strong></article><article class="console-section"><small>RSI · 14 changes</small><strong id="focusRsi">' + (indicators.rsi14 === null ? 'Collecting…' : indicators.rsi14.toFixed(1)) + '</strong></article></div>' +
    '<p class="hint">Indicators use sampled index quotes, not official candle data. Values may differ from charting platforms and are for observation only.</p>';
}

function watchlistMarkup() {
  return '<div class="table-wrap"><table class="console-table"><thead><tr><th>Symbol</th><th>Last price</th><th>Change</th><th>Feed status</th><th>Updated</th></tr></thead><tbody>' +
    SYMBOLS.map(item => {
      const quote = quoteFor(item.symbol);
      return '<tr><td><b>' + item.label + '</b><small>' + item.symbol + '</small></td><td data-price-symbol="' + item.symbol + '">' + (quote ? formatPrice(quote.price) : '—') + '</td><td data-change-symbol="' + item.symbol + '">' + (quote && Number.isFinite(quote.change) ? (quote.change > 0 ? '+' : '') + quote.change.toFixed(2) : '—') + '</td><td><span class="live-tag">' + (quote && quoteAgeMs(quote) < 15000 ? 'LIVE' : 'WAITING') + '</span></td><td class="quote-time" data-time-symbol="' + item.symbol + '">' + (quote ? new Date(quote.receivedAt).toLocaleTimeString('en-IN') : '—') + '</td></tr>';
    }).join('') + '</tbody></table></div><p class="hint">This watchlist currently contains the two index symbols streamed by the configured backend. Other symbols are not subscribed yet.</p>';
}

function indicatorsMarkup() {
  return '<div class="table-wrap"><table class="console-table"><thead><tr><th>Indicator</th><th>NIFTY 50</th><th>BANK NIFTY</th><th>Meaning</th></tr></thead><tbody>' +
    '<tr><td><b>SMA (5 samples)</b></td><td id="ind-sma5-0">Collecting…</td><td id="ind-sma5-1">Collecting…</td><td>Mean of last 5 received prices</td></tr>' +
    '<tr><td><b>SMA (20 samples)</b></td><td id="ind-sma20-0">Collecting…</td><td id="ind-sma20-1">Collecting…</td><td>Mean of last 20 received prices</td></tr>' +
    '<tr><td><b>RSI (14 changes)</b></td><td id="ind-rsi-0">Collecting…</td><td id="ind-rsi-1">Collecting…</td><td>Approximate RSI from quote-to-quote changes</td></tr>' +
    '<tr><td><b>Sample count</b></td><td id="ind-count-0">0</td><td id="ind-count-1">0</td><td>Received quote observations</td></tr></tbody></table></div>' +
    '<p class="hint">These are approximate tick-sample indicators, not candle-based technical indicators. They are not trading advice. For proper chart indicators, a verified historical-candles endpoint is required.</p>';
}

function signalsMarkup() {
  return '<div class="console-grid console-grid-2">' + SYMBOLS.map((item, index) => {
    const signal = signalFor(item.symbol);
    const quote = quoteFor(item.symbol);
    return '<article class="console-section"><div class="console-section-head"><h4>' + item.label + '</h4><span class="signal-tone ' + signal.tone + '" id="signal-tone-' + index + '">' + signal.label + '</span></div><strong class="console-price" data-price-symbol="' + item.symbol + '">' + (quote ? formatPrice(quote.price) : '—') + '</strong><p id="signal-detail-' + index + '">' + signal.detail + '</p></article>';
  }).join('') + '</div><p class="hint">Signals are simple summaries of recent sampled prices. They do not predict the market and must not be used alone to make trades.</p>';
}

function optionChainMarkup() {
  return '<div class="console-section"><div class="option-controls"><label>Underlying<select id="ocSymbol"><option value="NSE:NIFTY50-INDEX">NIFTY 50</option><option value="NSE:NIFTYBANK-INDEX">BANK NIFTY</option></select></label><label>Strikes each side<select id="ocStrikeCount"><option value="5">5</option><option value="10" selected>10</option><option value="15">15</option><option value="20">20</option></select></label><label>Expiry<select id="ocExpiry"><option value="">Nearest expiry</option></select></label><button class="primary" id="loadOptionChainBtn">Load option chain</button></div><div id="ocStatus" class="hint">Option chain will load from the authenticated FYERS read-only endpoint.</div><div class="console-grid console-grid-3" id="ocSummary"><article class="console-section"><small>Total Call OI</small><strong id="ocCallOi">—</strong></article><article class="console-section"><small>Total Put OI</small><strong id="ocPutOi">—</strong></article><article class="console-section"><small>Put / Call Ratio</small><strong id="ocPcr">—</strong></article></div><div id="ocTable" class="table-wrap"><div class="chart-empty">Open the panel to load verified strikes.</div></div></div><p class="hint">Market-data display only. Option premiums and OI can change quickly; verify with FYERS before acting. No orders can be placed from this console.</p>';
}

function holdingsMarkup() {
  return '<div class="button-row"><button class="primary" id="refreshPortfolioBtn">Refresh account data</button><span class="live-tag">READ ONLY</span></div><div id="portfolioStatus" class="hint">Loading authenticated FYERS account data when available…</div><article class="console-section"><div class="console-section-head"><div><h4>Holdings</h4><p>Demat holdings returned by FYERS</p></div></div><div id="holdingsTable" class="table-wrap"><div class="chart-empty">Waiting for account response.</div></div></article><article class="console-section"><div class="console-section-head"><div><h4>Positions</h4><p>Current trading-day net positions returned by FYERS</p></div></div><div id="positionsTable" class="table-wrap"><div class="chart-empty">Waiting for account response.</div></div></article><p class="hint">This panel is read-only. No order placement, position exit, or conversion actions are available.</p>';
}

function loadAlerts() {
  try {
    const value = JSON.parse(localStorage.getItem('dhanpulse-price-alerts') || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function saveAlerts() {
  try { localStorage.setItem('dhanpulse-price-alerts', JSON.stringify(alerts)); } catch {}
}

function alertsMarkup() {
  return '<form id="alertForm" class="alert-form"><label for="alertSymbol">Symbol</label><select id="alertSymbol"><option value="NSE:NIFTY50-INDEX">NIFTY 50</option><option value="NSE:NIFTYBANK-INDEX">BANK NIFTY</option></select><label for="alertDirection">Condition</label><select id="alertDirection"><option value="above">Price rises above</option><option value="below">Price falls below</option></select><label for="alertPrice">Target price</label><input id="alertPrice" type="number" min="0.01" step="0.05" placeholder="Enter target price" required><button class="primary" type="submit">Add price alert</button></form><div id="alertList" class="alert-list">' + alertListMarkup() + '</div><p class="hint">Alerts are saved in this browser only. Keep the dashboard open to evaluate live quote alerts; no SMS, email, or server-side notification is configured.</p>';
}

function alertListMarkup() {
  if (!alerts.length) return '<div class="chart-empty">No price alerts yet.</div>';
  return alerts.map((alert, index) => {
    const item = SYMBOLS.find(entry => entry.symbol === alert.symbol);
    return '<div class="alert-item"><div><b>' + (item ? item.label : alert.symbol) + '</b><small>' + (alert.direction === 'above' ? 'Above ' : 'Below ') + formatPrice(alert.target) + '</small><span class="signal-tone ' + (alert.triggered ? 'positive' : 'neutral') + '">' + (alert.triggered ? 'TRIGGERED' : 'ARMED') + '</span></div><button class="secondary" data-remove-alert="' + index + '">Remove</button></div>';
  }).join('');
}

function settingsMarkup() {
  return '<div class="settings-grid"><article class="console-section"><h4>Secure connection</h4><p>FYERS credentials stay on the Render backend. Do not paste app secrets or access tokens into this page.</p><div class="data-row"><span>Backend URL</span><b>Render</b></div><code class="backend-url">' + BACKEND_URL + '</code><div class="button-row"><button class="primary" id="testBackendBtn">Test backend</button><button class="primary" id="connectFyersBtn">Connect FYERS</button><button class="secondary" id="testQuotesBtn">Refresh live quotes</button></div></article><article class="console-section"><h4>Connection diagnostics</h4><div class="data-row"><span>Frontend</span><b class="positive-text">ONLINE</b></div><div class="data-row"><span>Backend health</span><b id="settingsBackend">CHECKING</b></div><div class="data-row"><span>Latest quotes</span><b id="settingsFeed">WAITING</b></div><div class="data-row"><span>Order placement</span><b class="warning-text">DISABLED</b></div><p class="hint">Backend health alone does not prove that FYERS authentication or live market data is connected.</p></article></div>';
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function displayNumber(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-IN', { maximumFractionDigits: digits == null ? 2 : digits }) : '—';
}

async function loadOptionChain() {
  if (optionRequestRunning || currentTab !== 'Option Chain') return;
  const status = document.querySelector('#ocStatus');
  const table = document.querySelector('#ocTable');
  const symbolEl = document.querySelector('#ocSymbol');
  const countEl = document.querySelector('#ocStrikeCount');
  const expiryEl = document.querySelector('#ocExpiry');
  if (!status || !table || !symbolEl || !countEl || !expiryEl) return;
  optionRequestRunning = true;
  status.textContent = 'Requesting verified option-chain data from FYERS…';
  try {
    const params = new URLSearchParams({
      symbol: symbolEl.value,
      strikecount: countEl.value
    });
    if (expiryEl.value) params.set('timestamp', expiryEl.value);
    const response = await fetch(BACKEND_URL + '/api/fyers/options-chain?' + params.toString(), {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !result.data) {
      throw new Error(result.error || result.detail || 'Option-chain response unavailable.');
    }
    const data = result.data;
    const expiries = Array.isArray(data.expiryData) ? data.expiryData : [];
    const selectedBefore = expiryEl.value;
    if (expiries.length) {
      expiryEl.innerHTML = expiries.map((item, index) => '<option value="' + escapeHtml(item.expiry) + '">' + escapeHtml(item.date || ('Expiry ' + (index + 1))) + (item.expiry_flag ? ' · ' + escapeHtml(item.expiry_flag) : '') + '</option>').join('');
      if (selectedBefore && expiries.some(item => String(item.expiry) === selectedBefore)) expiryEl.value = selectedBefore;
      else if (!selectedBefore && expiries[0]) expiryEl.value = String(expiries[0].expiry);
    }
    const callOi = Number(data.callOi);
    const putOi = Number(data.putOi);
    const callEl = document.querySelector('#ocCallOi');
    const putEl = document.querySelector('#ocPutOi');
    const pcrEl = document.querySelector('#ocPcr');
    if (callEl) callEl.textContent = displayNumber(callOi, 0);
    if (putEl) putEl.textContent = displayNumber(putOi, 0);
    if (pcrEl) pcrEl.textContent = Number.isFinite(callOi) && callOi > 0 && Number.isFinite(putOi) ? (putOi / callOi).toFixed(2) : '—';
    const chain = Array.isArray(data.optionsChain) ? data.optionsChain : [];
    const byStrike = new Map();
    chain.forEach(leg => {
      if (!leg || !['CE', 'PE'].includes(leg.option_type)) return;
      const strike = Number(leg.strike_price);
      if (!Number.isFinite(strike) || strike <= 0) return;
      if (!byStrike.has(strike)) byStrike.set(strike, {});
      byStrike.get(strike)[leg.option_type] = leg;
    });
    const strikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
    if (!strikes.length) {
      table.innerHTML = '<div class="chart-empty">FYERS returned no option strikes for this selection.</div>';
    } else {
      table.innerHTML = '<table class="console-table option-table"><thead><tr><th colspan="4">CALL OPTIONS</th><th>STRIKE</th><th colspan="4">PUT OPTIONS</th></tr><tr><th>LTP</th><th>Chg %</th><th>OI</th><th>Volume</th><th>Price</th><th>LTP</th><th>Chg %</th><th>OI</th><th>Volume</th></tr></thead><tbody>' +
        strikes.map(strike => {
          const row = byStrike.get(strike);
          const ce = row.CE || {};
          const pe = row.PE || {};
          return '<tr><td>' + displayNumber(ce.ltp) + '</td><td>' + displayNumber(ce.ltpchp) + '</td><td>' + displayNumber(ce.oi, 0) + '</td><td>' + displayNumber(ce.volume, 0) + '</td><td><b>' + displayNumber(strike, 0) + '</b></td><td>' + displayNumber(pe.ltp) + '</td><td>' + displayNumber(pe.ltpchp) + '</td><td>' + displayNumber(pe.oi, 0) + '</td><td>' + displayNumber(pe.volume, 0) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    status.textContent = 'Verified FYERS option-chain response received at ' + new Date(result.fetchedAt || Date.now()).toLocaleTimeString('en-IN') + '. ' + strikes.length + ' strikes shown.';
    logEvent('FYERS option-chain data received for ' + symbolEl.value + '.', 'info');
  } catch (error) {
    status.textContent = (error.message || 'Could not load option chain.') + ' Use FYERS Settings to reconnect if authentication expired.';
    table.innerHTML = '<div class="chart-empty">No verified option-chain data available. No values have been fabricated.</div>';
    logEvent('Option-chain request failed.', 'warn');
  } finally {
    optionRequestRunning = false;
  }
}

function extractRows(payload, keys) {
  for (const key of keys) {
    if (Array.isArray(payload && payload[key])) return payload[key];
  }
  return [];
}

function renderPortfolioTable(targetId, rows, type) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!rows.length) {
    target.innerHTML = '<div class="chart-empty">No ' + type + ' rows were returned by FYERS for this account/session.</div>';
    return;
  }
  const columns = type === 'holdings'
    ? [
      ['Symbol', ['symbol', 'fyToken']],
      ['Quantity', ['quantity', 'qty', 'holdingQty', 'remainingQuantity']],
      ['Avg cost', ['costPrice', 'avgPrice', 'cost_price']],
      ['LTP', ['ltp', 'marketPrice', 'currentPrice']],
      ['P&L', ['pl', 'pnl', 'unrealized_profit']]
    ]
    : [
      ['Symbol', ['symbol']],
      ['Net qty', ['netQty', 'qty', 'quantity']],
      ['Side', ['side']],
      ['Product', ['productType']],
      ['Avg price', ['avgPrice', 'buyAvg', 'sellAvg']],
      ['LTP', ['ltp']],
      ['P&L', ['pl', 'unrealized_profit', 'realized_profit']]
    ];
  const findValue = (row, candidates) => {
    for (const key of candidates) if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    return '—';
  };
  target.innerHTML = '<table class="console-table"><thead><tr>' + columns.map(col => '<th>' + escapeHtml(col[0]) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr>' + columns.map((col, index) => {
      const value = findValue(row, col[1]);
      const formatted = typeof value === 'number' && index > 0 ? displayNumber(value) : String(value);
      return '<td>' + escapeHtml(formatted) + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table>';
}

async function loadPortfolio() {
  if (portfolioRequestRunning || currentTab !== 'Holdings') return;
  portfolioRequestRunning = true;
  const status = document.querySelector('#portfolioStatus');
  if (status) status.textContent = 'Fetching read-only FYERS holdings and positions…';
  try {
    const responses = await Promise.all([
      fetch(BACKEND_URL + '/api/fyers/holdings', { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      fetch(BACKEND_URL + '/api/fyers/positions', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    ]);
    const results = await Promise.all(responses.map(response => response.json().catch(() => ({}))));
    if (responses.some(response => !response.ok) || results.some(result => result.ok !== true)) {
      const message = results.find(result => result.error || result.detail);
      throw new Error(message ? (message.error || message.detail) : 'FYERS account data unavailable.');
    }
    const holdingPayload = results[0].data || {};
    const positionPayload = results[1].data || {};
    const holdings = extractRows(holdingPayload, ['holdings', 'data', 'holdingsData']);
    const positions = extractRows(positionPayload, ['netPositions', 'positions', 'data']);
    renderPortfolioTable('holdingsTable', holdings, 'holdings');
    renderPortfolioTable('positionsTable', positions, 'positions');
    if (status) status.textContent = 'Read-only FYERS account responses received at ' + new Date().toLocaleTimeString('en-IN') + '.';
    logEvent('FYERS holdings and positions loaded in read-only mode.', 'info');
  } catch (error) {
    if (status) status.textContent = (error.message || 'Account data unavailable.') + ' Connect or reconnect FYERS from settings if needed.';
    const holdingsTable = document.querySelector('#holdingsTable');
    const positionsTable = document.querySelector('#positionsTable');
    if (holdingsTable) holdingsTable.innerHTML = '<div class="chart-empty">Verified holdings data is unavailable.</div>';
    if (positionsTable) positionsTable.innerHTML = '<div class="chart-empty">Verified positions data is unavailable.</div>';
    logEvent('FYERS portfolio read failed.', 'warn');
  } finally {
    portfolioRequestRunning = false;
  }
}

function renderLogs() {
  if (currentTab !== 'Logs') return;
  const box = document.querySelector('#logList');
  if (!box) return;
  box.innerHTML = appLogs.length ? appLogs.map(item => '<div class="log-item"><time>' + item.time + '</time><span class="' + item.level + '">' + item.level.toUpperCase() + '</span><p>' + item.message.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p></div>').join('') : '<div class="chart-empty">No events recorded yet.</div>';
}

function render(tab) {
  if (!descriptions[tab]) return;
  currentTab = tab;
  title.textContent = tab;
  panelTitle.textContent = descriptions[tab][0];
  featureTitle.textContent = tab === 'Dashboard' ? 'Live console' : tab;
  featureDesc.textContent = descriptions[tab][1];
  nav.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  if (tab === 'Dashboard') featureContent.innerHTML = dashboardMarkup();
  else if (tab === 'NIFTY') featureContent.innerHTML = focusedQuoteMarkup(SYMBOLS[0].symbol);
  else if (tab === 'BANKNIFTY') featureContent.innerHTML = focusedQuoteMarkup(SYMBOLS[1].symbol);
  else if (tab === 'Watchlist') featureContent.innerHTML = watchlistMarkup();
  else if (tab === 'Option Chain') featureContent.innerHTML = optionChainMarkup();
  else if (tab === 'Technical Indicators') featureContent.innerHTML = indicatorsMarkup();
  else if (tab === 'AI Signals') featureContent.innerHTML = signalsMarkup();
  else if (tab === 'Holdings') featureContent.innerHTML = holdingsMarkup();
  else if (tab === 'Alerts') featureContent.innerHTML = alertsMarkup();
  else if (tab === 'FYERS Settings') featureContent.innerHTML = settingsMarkup();
  else featureContent.innerHTML = '<div id="logList" class="log-list"></div>';
  bindTabActions();
  updateDynamicPanel();
  if (tab === 'Option Chain') loadOptionChain();
  if (tab === 'Holdings') loadPortfolio();
  if (tab === 'Logs') renderLogs();
}

function bindTabActions() {
  featureContent.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => render(button.dataset.jump)));
  const test = document.querySelector('#testBackendBtn');
  if (test) test.addEventListener('click', testBackend);
  const connect = document.querySelector('#connectFyersBtn');
  if (connect) connect.addEventListener('click', startFyersLogin);
  const quotes = document.querySelector('#testQuotesBtn');
  if (quotes) quotes.addEventListener('click', fetchLiveQuotes);
  const loadChain = document.querySelector('#loadOptionChainBtn');
  if (loadChain) loadChain.addEventListener('click', loadOptionChain);
  const expiry = document.querySelector('#ocExpiry');
  if (expiry) expiry.addEventListener('change', loadOptionChain);
  const ocSymbol = document.querySelector('#ocSymbol');
  if (ocSymbol) ocSymbol.addEventListener('change', () => {
    const exp = document.querySelector('#ocExpiry');
    if (exp) exp.innerHTML = '<option value="">Nearest expiry</option>';
    loadOptionChain();
  });
  const portfolioRefresh = document.querySelector('#refreshPortfolioBtn');
  if (portfolioRefresh) portfolioRefresh.addEventListener('click', loadPortfolio);
  const form = document.querySelector('#alertForm');
  if (form) form.addEventListener('submit', event => {
    event.preventDefault();
    const symbol = document.querySelector('#alertSymbol').value;
    const direction = document.querySelector('#alertDirection').value;
    const target = Number(document.querySelector('#alertPrice').value);
    if (!Number.isFinite(target) || target <= 0) return;
    alerts.push({ symbol: symbol, direction: direction, target: target, triggered: false, createdAt: new Date().toISOString() });
    saveAlerts();
    logEvent('Price alert added for ' + symbol + '.', 'info');
    render('Alerts');
  });
  featureContent.querySelectorAll('[data-remove-alert]').forEach(button => button.addEventListener('click', () => {
    alerts.splice(Number(button.dataset.removeAlert), 1);
    saveAlerts();
    render('Alerts');
  }));
}

function updateQuoteCards(quotes, fetchedAt) {
  if (!Array.isArray(quotes)) return false;
  const map = {};
  quotes.forEach(item => {
    if (item && item.n && item.v) {
      const price = Number(item.v.lp);
      if (Number.isFinite(price) && price > 0) {
        map[item.n] = {
          price: price,
          change: Number.isFinite(Number(item.v.ch)) ? Number(item.v.ch) : null,
          changePct: Number.isFinite(Number(item.v.chp)) ? Number(item.v.chp) : null,
          receivedAt: Date.now(),
          sourceTime: fetchedAt || null
        };
      }
    }
  });
  if (!map[SYMBOLS[0].symbol] || !map[SYMBOLS[1].symbol]) return false;
  SYMBOLS.forEach(item => {
    const next = map[item.symbol];
    const old = latestQuotes[item.symbol];
    latestQuotes[item.symbol] = next;
    const history = historyBySymbol[item.symbol];
    const last = history.length ? history[history.length - 1] : null;
    if (!last || last.price !== next.price) {
      history.push({ price: next.price, time: next.receivedAt });
      if (history.length > 180) history.splice(0, history.length - 180);
    }
    if (old && old.price !== next.price) checkAlerts(item.symbol, next.price);
  });
  setStatus('FYERS QUOTES RECEIVED');
  setConnection('FYERS Connected', false);
  setFyersStatus('CONNECTED');
  setBackendStatus('ONLINE');
  const lastUpdate = document.querySelector('#lastUpdate');
  if (lastUpdate) {
    lastUpdate.textContent = fetchedAt && Number.isFinite(Date.parse(fetchedAt)) ? new Date(fetchedAt).toLocaleTimeString('en-IN') : new Date().toLocaleTimeString('en-IN');
    lastUpdate.classList.remove('muted');
  }
  // Avoid flooding the console log on every 1.5-second refresh.
  updateDynamicPanel();
  return true;
}

function updateDynamicPanel() {
  SYMBOLS.forEach(item => {
    const quote = quoteFor(item.symbol);
    const price = quote ? formatPrice(quote.price) : '—';
    featureContent.querySelectorAll('[data-price-symbol="' + item.symbol + '"]').forEach(el => el.textContent = price);
    featureContent.querySelectorAll('[data-change-symbol="' + item.symbol + '"]').forEach(el => {
      if (!quote) { el.textContent = 'Waiting for quote'; return; }
      const change = quote.change;
      const pct = quote.changePct;
      el.textContent = change === null ? 'FYERS quote received' : (change > 0 ? '+' : '') + change.toFixed(2) + (pct === null ? '' : ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)');
    });
    featureContent.querySelectorAll('[data-time-symbol="' + item.symbol + '"]').forEach(el => el.textContent = quote ? new Date(quote.receivedAt).toLocaleTimeString('en-IN') : 'Waiting for quote');
    const mini = featureContent.querySelector('[data-mini-symbol="' + item.symbol + '"]');
    if (mini) mini.innerHTML = svgChart(item.symbol, 80);
  });
  const dashboardChart = document.querySelector('#dashboardChart');
  if (dashboardChart) dashboardChart.innerHTML = svgChart(SYMBOLS[0].symbol, 210);
  const focusChart = document.querySelector('#focusChart');
  if (focusChart) {
    const active = currentTab === 'BANKNIFTY' ? SYMBOLS[1].symbol : SYMBOLS[0].symbol;
    focusChart.innerHTML = svgChart(active, 250);
    const indicators = calculateIndicators(active);
    const sma5 = document.querySelector('#focusSma5');
    const sma20 = document.querySelector('#focusSma20');
    const rsi = document.querySelector('#focusRsi');
    if (sma5) sma5.textContent = indicators.sma5 === null ? 'Collecting…' : formatPrice(indicators.sma5);
    if (sma20) sma20.textContent = indicators.sma20 === null ? 'Collecting…' : formatPrice(indicators.sma20);
    if (rsi) rsi.textContent = indicators.rsi14 === null ? 'Collecting…' : indicators.rsi14.toFixed(1);
  }
  SYMBOLS.forEach((item, index) => {
    const indicators = calculateIndicators(item.symbol);
    const ids = [
      ['ind-sma5-' + index, indicators.sma5 === null ? 'Collecting…' : formatPrice(indicators.sma5)],
      ['ind-sma20-' + index, indicators.sma20 === null ? 'Collecting…' : formatPrice(indicators.sma20)],
      ['ind-rsi-' + index, indicators.rsi14 === null ? 'Collecting…' : indicators.rsi14.toFixed(1)],
      ['ind-count-' + index, String(indicators.samples)]
    ];
    ids.forEach(pair => { const el = document.getElementById(pair[0]); if (el) el.textContent = pair[1]; });
    const signal = signalFor(item.symbol);
    const tone = document.getElementById('signal-tone-' + index);
    const detail = document.getElementById('signal-detail-' + index);
    if (tone) { tone.textContent = signal.label; tone.className = 'signal-tone ' + signal.tone; }
    if (detail) detail.textContent = signal.detail;
  });
  const dashBackend = document.querySelector('#dashBackend');
  if (dashBackend) dashBackend.textContent = 'ONLINE';
  const dashFeed = document.querySelector('#dashFeed');
  if (dashFeed) dashFeed.textContent = SYMBOLS.every(item => quoteFor(item.symbol) && quoteAgeMs(quoteFor(item.symbol)) < 15000) ? 'LIVE' : 'WAITING';
  const settingsBackend = document.querySelector('#settingsBackend');
  if (settingsBackend) settingsBackend.textContent = 'ONLINE';
  const settingsFeed = document.querySelector('#settingsFeed');
  if (settingsFeed) settingsFeed.textContent = SYMBOLS.every(item => quoteFor(item.symbol) && quoteAgeMs(quoteFor(item.symbol)) < 15000) ? 'LIVE' : 'WAITING';
  const sampleCount = document.querySelector('#chartSampleCount');
  if (sampleCount) sampleCount.textContent = 'Samples: ' + (historyBySymbol[SYMBOLS[0].symbol] || []).length;
}

function checkAlerts(symbol, price) {
  let changed = false;
  alerts.forEach(alert => {
    if (alert.triggered || alert.symbol !== symbol) return;
    const hit = alert.direction === 'above' ? price >= alert.target : price <= alert.target;
    if (hit) {
      alert.triggered = true;
      changed = true;
      const item = SYMBOLS.find(entry => entry.symbol === symbol);
      logEvent('PRICE ALERT TRIGGERED: ' + (item ? item.label : symbol) + ' at ' + formatPrice(price) + '.', 'warn');
    }
  });
  if (changed) {
    saveAlerts();
    if (currentTab === 'Alerts') render('Alerts');
  }
}

async function testBackend() {
  setBackendStatus('CHECKING…');
  try {
    const response = await fetch(BACKEND_URL + '/health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error('Backend health check failed.');
    setBackendStatus('ONLINE');
    logEvent('Backend health check succeeded.', 'info');
    showMessage('Backend is online. Live quote status is verified separately.');
    return data;
  } catch {
    setBackendStatus('UNREACHABLE');
    setStatus('BACKEND UNAVAILABLE');
    logEvent('Backend health check failed.', 'error');
    showMessage('Backend test failed. Check Render status and CORS settings.', true);
    return null;
  }
}

async function startFyersLogin() {
  if (authInProgress) return;
  authInProgress = true;
  showMessage('Preparing secure FYERS login…');
  try {
    const response = await fetch(BACKEND_URL + '/api/fyers/auth/start', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.authorizationUrl) throw new Error(data.error || 'Authorization URL unavailable.');
    logEvent('FYERS login flow started.', 'info');
    window.location.assign(data.authorizationUrl);
  } catch (error) {
    authInProgress = false;
    showMessage(error.message || 'Could not start FYERS login.', true);
    logEvent('FYERS login flow could not start.', 'error');
  }
}

async function fetchLiveQuotes() {
  if (quoteRequestRunning) return;
  quoteRequestRunning = true;
  try {
    const response = await fetch(BACKEND_URL + '/api/market/quotes', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const retrySeconds = Number(data.retryAfterSeconds) || 10;
      quotePollDelay = Math.min(Math.max((retrySeconds + 2) * 1000, QUOTE_POLL_MS), QUOTE_POLL_MAX_MS);
      setStatus('FYERS RATE LIMIT — WAITING');
      showMessage('The quote service asked us to slow down. Retrying shortly.', true);
      return;
    }
    if (!response.ok || data.ok !== true || !Array.isArray(data.data)) {
      if (response.status === 401) {
        setStatus('FYERS LOGIN REQUIRED');
        setFyersStatus('NOT CONNECTED');
        setConnection('Not connected', true);
        showMessage('FYERS is not authenticated. Open FYERS Settings to connect.', true);
      } else if (response.status === 503) {
        if (Object.keys(latestQuotes).length) setStatus('LIVE DATA STALE');
        else setStatus('WAITING FOR LIVE TICKS');
        showMessage(data.detail || data.error || 'Waiting for fresh FYERS WebSocket ticks.');
      } else {
        setStatus('LIVE DATA UNAVAILABLE');
        showMessage(data.error || 'The backend did not return verified quotes.', true);
      }
      return;
    }
    quotePollDelay = QUOTE_POLL_MS;
    if (!updateQuoteCards(data.data, data.fetchedAt)) {
      setStatus('INCOMPLETE QUOTE RESPONSE');
      showMessage('Both expected index quotes were not present. No new values were applied.', true);
      logEvent('Quote response was incomplete.', 'warn');
      return;
    }
    showMessage('NIFTY and BANK NIFTY quotes received from the backend.');
  } catch {
    setStatus('LIVE DATA UNAVAILABLE');
    showMessage('Cannot reach the quote API. Retrying automatically.', true);
    logEvent('Quote API request failed; automatic retry scheduled.', 'error');
  } finally {
    quoteRequestRunning = false;
    if (quoteTimer) window.clearTimeout(quoteTimer);
    quoteTimer = window.setTimeout(fetchLiveQuotes, quotePollDelay);
  }
}

async function exchangeAuthCode() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('auth_code');
  if (!code) return;
  window.history.replaceState({}, document.title, window.location.pathname);
  setStatus('VERIFYING FYERS LOGIN…');
  setFyersStatus('VERIFYING…');
  showMessage('Authorization received. Verifying with the backend…');
  try {
    const response = await fetch(BACKEND_URL + '/api/fyers/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code: code })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(data.error || data.detail || 'Authentication failed.');
    logEvent('FYERS authentication succeeded; checking live quotes.', 'info');
    showMessage('FYERS authentication succeeded. Verifying live quotes…');
    await fetchLiveQuotes();
  } catch (error) {
    setStatus('FYERS AUTH FAILED');
    setFyersStatus('AUTH FAILED');
    showMessage(error.message || 'Authentication failed. Try a fresh FYERS login.', true);
    logEvent('FYERS authentication failed.', 'error');
  }
}

nav.addEventListener('click', event => {
  const button = event.target.closest('button[data-tab]');
  if (button) render(button.dataset.tab);
});
document.querySelector('#settingsBtn')?.addEventListener('click', () => render('FYERS Settings'));

render('Dashboard');
testBackend();
exchangeAuthCode();
logEvent('DhanPulse console initialised.', 'info');
fetchLiveQuotes();
