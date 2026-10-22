
const BACKEND_URL = 'https://dhanpluse-v1.onrender.com';
// The FYERS access token stays on the backend. This opaque session token only
// authorizes this browser session to read protected dashboard APIs.
const nativeFetch = window.fetch.bind(window);
window.fetch = function(input, init = {}) {
  let url = '';
  try { url = new URL(typeof input === 'string' ? input : input.url, window.location.href).href; } catch {}
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const isBackend = url.startsWith(BACKEND_URL + '/');
  const publicPaths = ['/health', '/api/status', '/api/fyers/auth/start', '/api/fyers/auth/exchange'];
  const pathname = isBackend ? new URL(url).pathname : '';
  if (isBackend && !publicPaths.includes(pathname)) {
    const session = sessionStorage.getItem('dhanpulse-dashboard-session-v1');
    if (session) headers.set('Authorization', 'Bearer ' + session);
  }
  return nativeFetch(input, { ...init, headers });
};

const QUOTE_POLL_MS = 2000;
const QUOTE_POLL_MAX_MS = 30000;
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
let dashboardCandleRequestRunning = false;
let backendHealthState = 'CHECKING';
let fyersAuthState = 'NOT CONNECTED';
let authInProgress = false;
let deferredInstallPrompt = null;
let optionRequestRunning = false;
let portfolioRequestRunning = false;
let currentTab = 'Dashboard';
let latestQuotes = {};
let historyBySymbol = {};
let stockExplorerMoverRows = [];
let watchlistEquityRows = [];
let watchlistRequestRunning = false;
let watchlistSymbols = loadWatchlistSymbols();
let stockExplorerFetchStarted = false;
let appLogs = [];
let alerts = loadAlerts();

SYMBOLS.forEach(item => { historyBySymbol[item.symbol] = []; });

const descriptions = {
  'Stock Explorer': ['Stock explorer', 'Search supported NSE symbols and open research workspaces. Prices are shown only when verified FYERS quotes are returned.'],
  'Market Activity': ['Market activity', 'A research overview for market breadth, volatility, volume and institutional flow; unsupported data stays clearly unavailable.'],
  'Dashboard': ['Market overview', 'Live FYERS quotes, recent price movement, and console health.'],
  'NIFTY': ['NIFTY 50 workspace', 'Live index quote and recent received-price history.'],
  'BANKNIFTY': ['BANK NIFTY workspace', 'Live index quote and recent received-price history.'],
  'Watchlist': ['Live watchlist', 'Verified symbols currently streamed by the FYERS backend.'],
  'Sureshot CE/PE': ['CE / PE setup desk', 'Rule-based option candidates using live index samples and a verified FYERS option-chain response. No setup is guaranteed.'],
  'Breakout Scanner': ['Breakout watchlist', 'Ranked live movers for review. A quote snapshot alone does not confirm a technical breakout.'],
  'Momentum Scanner': ['Momentum scanner', 'Selected NSE stocks ranked by verified FYERS percentage change.'],
  'Zero-to-Hero': ['High-momentum watchlist', 'Unusual movers to investigate; option prices and risk must be verified in the option chain.'],
  'FII/DII Flow': ['Institutional flow', 'No FII/DII values are shown unless a verified source is available.'],
  'Charts & Patterns': ['Charts & pattern lab', 'Recent live index samples are plotted; confirmed candlestick patterns require historical OHLC candles.'],
  'Gainers & Losers': ['Gainers & losers', 'Verified FYERS quote snapshot for a selected large-cap NSE universe; not the entire exchange.'],
  'Option Chain': ['Option chain & open interest', 'Option-chain values must come from a verified FYERS response.'],
  'Technical Indicators': ['Technical indicators', 'EMA, RSI, ATR, volume and trend calculated from verified FYERS historical OHLC candles.'],
  'AI Signals': ['Market signals', 'Transparent momentum summaries from recent received quotes, not investment advice.'],
  'Holdings': ['Holdings & positions', 'Account data is private and shown only after a verified account endpoint is available.'],
  'Alerts': ['Price alerts', 'Browser-local alerts for the two live index quotes.'],
  'FYERS Settings': ['FYERS connection settings', 'Connect through the secure backend; credentials remain server-side.'],
  'Logs': ['System logs', 'Recent frontend, backend, and live-quote events.'],
  'Trade Journal': ['Trade journal & discipline', 'Review paper trades, planned risk/reward, rule adherence, and recurring emotional-trading patterns.'],
  'Capital Protection': ['Capital protection calculator', 'Estimate position size, planned risk/reward and daily loss guardrails. This calculator never places orders.'],
  'Backtesting': ['Historical candle backtest', 'Simulate a simple strategy against verified historical candles. Results are not forecasts and never place orders.']
};

function logEvent(message, level) {
  appLogs.unshift({ time: new Date().toLocaleTimeString('en-IN'), message: message, level: level || 'info' });
  appLogs = appLogs.slice(0, 80);
  if (currentTab === 'Logs') renderLogs();
}

function isRegularMarketSession() {
  // NSE cash-market hours in India; exchange holidays are not checked here.
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  if (!['Mon','Tue','Wed','Thu','Fri'].includes(values.weekday)) return false;
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
}

function setStatus(message) {
  const el = document.querySelector('#marketStatus');
  if (el) el.textContent = message;
  const quoteReceived = message === 'FYERS QUOTES RECEIVED';
  const marketOpen = isRegularMarketSession();
  const connected = quoteReceived && marketOpen;
  const closedQuote = quoteReceived && !marketOpen;
  const waiting = document.querySelector('#sideFeedStatus') || document.querySelector('.sidefoot span:last-child');
  const footer = document.querySelector('#footerFeedStatus') || document.querySelector('footer span:last-child');
  const dot = document.querySelector('#sideFeedDot') || document.querySelector('.sidefoot .dot');
  const headerDot = document.querySelector('.market-pill .dot');
  if (el && closedQuote) el.textContent = 'MARKET CLOSED · LAST QUOTES';
  if (waiting) waiting.textContent = connected ? 'Live feed connected' : closedQuote ? 'Market closed · last quotes' : message === 'LIVE DATA STALE' ? 'Live feed stale' : 'Waiting for verified live feed';
  if (footer) footer.textContent = connected ? 'Live FYERS quotes received' : closedQuote ? 'Last received quotes · market closed' : message === 'LIVE DATA STALE' ? 'Last quote is stale' : 'Waiting for verified live feed';
  [dot, headerDot].filter(Boolean).forEach(item => {
    item.style.background = connected ? '#63e6d0' : '#64738a';
    item.title = connected ? 'Verified quote response received' : 'No fresh verified quote response';
  });
  const connectionDetail = document.querySelector('.metrics .metric:first-child small');
  if (connectionDetail) connectionDetail.textContent = connected ? 'Live quotes verified from backend' : closedQuote ? 'Market closed · last quotes only' : 'Awaiting verified response';
  const welcomeCopy = document.querySelector('.welcome > div > p:last-child');
  if (welcomeCopy) welcomeCopy.textContent = connected
    ? 'FYERS live market ticks are arriving for NIFTY 50 and BANK NIFTY.'
    : closedQuote ? 'Indian market hours have ended. These are the latest quotes returned by FYERS, not a live-moving feed.'
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
  backendHealthState = message;
  const el = document.querySelector('#backendStatus');
  if (el) el.textContent = message;
  const dash = document.querySelector('#dashBackend');
  const settings = document.querySelector('#settingsBackend');
  if (dash) dash.textContent = message;
  if (settings) settings.textContent = message;
}

function setFyersStatus(message) {
  fyersAuthState = message;
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

function hasFreshLiveQuote(quote) {
  return isRegularMarketSession() && !!quote && quote.source === 'websocket' && quote.streamConnected === true && quoteAgeMs(quote) >= 0 && quoteAgeMs(quote) <= 15000;
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

function signalDataBlockReason(symbol) {
  const quote = quoteFor(symbol);
  if (!isRegularMarketSession()) return 'Market session is closed or outside NSE regular hours; no actionable signal.';
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return 'Verified quote is missing; no signal.';
  if (quote.source !== 'websocket' || quote.streamConnected !== true) return 'A connected live FYERS stream is required; last-known/reconnecting quotes cannot generate signals.';
  if (quoteAgeMs(quote) < 0 || quoteAgeMs(quote) > 15000) return 'Quote is stale or has a future timestamp; no signal.';
  const other = SYMBOLS.find(item => item.symbol !== symbol);
  const otherQuote = other ? quoteFor(other.symbol) : null;
  if (!otherQuote || !Number.isFinite(otherQuote.price) || otherQuote.source !== 'websocket' || otherQuote.streamConnected !== true || quoteAgeMs(otherQuote) < 0 || quoteAgeMs(otherQuote) > 15000) return 'Both index quotes are not fresh from a connected stream; signal blocked.';
  return '';
}

function validateOhlcCandles(candles, resolution) {
  if (!Array.isArray(candles) || candles.length < 12) return 'At least 12 OHLC candles are required.';
  let previousTime = -Infinity;
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 5) return 'Candle row is incomplete.';
    const time = Number(row[0]), open = Number(row[1]), high = Number(row[2]), low = Number(row[3]), close = Number(row[4]);
    if (![time, open, high, low, close].every(Number.isFinite) || time <= 0 || Math.min(open, high, low, close) <= 0) return 'Candle data contains missing or invalid numbers.';
    if (time * 1000 > Date.now() + 5000) return 'Candle timestamp is in the future; signal blocked.';
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return 'OHLC values are inconsistent; signal blocked.';
    if (time <= previousTime) return 'Candle timestamps are duplicated or out of order.';
    previousTime = time;
  }
  if (isRegularMarketSession()) {
    const lastTimeMs = Number(candles[candles.length - 1][0]) * 1000;
    // Daily candles can legitimately be older than 36 hours after weekends or exchange holidays.
    const maxAgeMs = resolution === 'D' ? 5 * 24 * 60 * 60 * 1000 : (Number(resolution) || 5) * 60 * 1000 * 3;
    if (Date.now() - lastTimeMs > maxAgeMs) return 'Latest candle is stale for this interval; signal blocked.';
  }
  return '';
}

function validateOptionChainPayload(payload) {
  if (!payload || !Array.isArray(payload.optionsChain) || !payload.optionsChain.length) return 'Option-chain rows are missing; no option signal.';
  // FYERS may include the underlying index as a special strike=-1 row; its LTP is spot, not an option premium.
  const underlyingRow = payload.optionsChain.find(row => Number(row?.strike_price) === -1 && !String(row?.option_type || '').trim() && /-(INDEX|EQ)$/.test(String(row?.symbol || '')) && Number(row?.ltp) > 0);
  const spot = Number(payload.optionsChain.find(row => Number(row?.underlying_price) > 0)?.underlying_price ?? payload.underlying_price ?? underlyingRow?.ltp);
  if (!Number.isFinite(spot) || spot <= 0) return 'Verified underlying spot is missing from option-chain response.';
  // FYERS option-chain legs do not document per-leg exchange timestamps or expiry.
  // Expiry is inherited from the selected chain's expiryData; freshness is checked
  // separately against /data/quotes for the actual candidate contract before a setup is issued.
  const chainExpiry = payload.expiryData?.[0]?.expiry ?? payload.expiry;
  const normalized = payload.optionsChain.map(row => {
    if (!row || !Number.isFinite(Number(row.strike_price)) || Number(row.strike_price) <= 0) return null;
    const type = String(row.option_type || '').toUpperCase();
    const ltp = Number(row.ltp), bid = Number(row.bid ?? row.bid_price ?? row.bidPrice), ask = Number(row.ask ?? row.ask_price ?? row.askPrice);
    const oi = Number(row.oi), volume = Number(row.volume);
    const expiry = row.expiry ?? row.expiry_date ?? row.expiryDate ?? chainExpiry;
    if (!['CE','PE','CALL','PUT'].includes(type) || !Number.isFinite(ltp) || ltp <= 0 ||
        !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid ||
        !Number.isFinite(oi) || oi < 0 || !Number.isFinite(volume) || volume < 0 || !expiry) return null;
    const spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
    return { ...row, option_type: type === 'CALL' ? 'CE' : type === 'PUT' ? 'PE' : type,
      strike_price: Number(row.strike_price), ltp, bid, ask, oi, volume, expiry: String(expiry),
      spreadPct, quoteTimeMs: null, quoteAgeSeconds: null };
  }).filter(Boolean);
  if (!normalized.length) return 'No option row passed strike, expiry, bid/ask, OI and volume validation.';
  return { spot, chain: normalized };
}

function signalFor(symbol) {
  const blocked = signalDataBlockReason(symbol);
  if (blocked) return { label: 'NO TRADE · DATA BLOCKED', detail: blocked, tone: 'negative' };
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

async function loadDashboardCandles() {
  const symbol=document.querySelector('#dashboardCandleSymbol');
  const resolution=document.querySelector('#dashboardCandleResolution');
  const chart=document.querySelector('#dashboardChart');
  const status=document.querySelector('#dashboardCandleStatus');
  const count=document.querySelector('#chartSampleCount');
  const button=document.querySelector('#dashboardCandlesBtn');
  if(!symbol||!resolution||!chart||!status||dashboardCandleRequestRunning)return;
  dashboardCandleRequestRunning=true;
  if(button)button.disabled=true;
  status.textContent='Requesting verified FYERS historical candles…';
  chart.innerHTML='<div class="chart-empty">Loading verified OHLC candles…</div>';
  try {
    const response=await fetch(BACKEND_URL+'/api/market/candles?'+new URLSearchParams({symbol:symbol.value,resolution:resolution.value}),{headers:{Accept:'application/json'},cache:'no-store'});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true||!Array.isArray(result.data))throw new Error(result.detail||result.error||'Historical candles unavailable.');
    if(!result.data.length)throw new Error('FYERS returned no historical candles for this symbol and timeframe.');
    const candleError=validateOhlcCandles(result.data,resolution.value);
    if(candleError)throw new Error(candleError);
    chart.innerHTML=candleSvg(result.data);
    const mainChart=document.querySelector('#mainTabChart');
    if(mainChart)mainChart.innerHTML=candleSvg(result.data);
    const mainNote=document.querySelector('#mainViewNote');
    if(mainNote)mainNote.textContent='Verified FYERS historical OHLC · '+result.data.length+' candles · '+resolution.value+' timeframe. No synthetic candles.';
    if(count)count.textContent=result.data.length+' verified candles';
    status.textContent=result.data.length+' verified candles · '+symbol.value+' · '+resolution.value+' timeframe · '+new Date(result.fetchedAt||Date.now()).toLocaleTimeString('en-IN');
    logEvent('Dashboard candlestick chart loaded ('+result.data.length+' verified candles for '+symbol.value+').','info');
  } catch(error) {
    const message=error.message||'Historical candles unavailable.';
    chart.innerHTML='<div class="chart-empty">'+escapeHtml(message)+'</div>';
    const mainChart=document.querySelector('#mainTabChart');
    if(mainChart)mainChart.innerHTML='<div class="chart-empty">Candlestick chart unavailable: '+escapeHtml(message)+'. No candle values were fabricated.</div>';
    const mainNote=document.querySelector('#mainViewNote');
    if(mainNote)mainNote.textContent='Verified OHLC candles are unavailable right now; no substitute line chart or fabricated candle values are shown.';
    status.textContent='Candlestick chart unavailable: '+message+'. No candle values were fabricated.';
    logEvent('Dashboard candlestick chart failed: '+message,'warn');
  } finally {
    dashboardCandleRequestRunning=false;
    if(button)button.disabled=false;
  }
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

function stockExplorerMarkup() {
  return '<div class="console-section"><div class="console-section-head"><div><h4>Stock Explorer</h4><p>FYERS NSE F&O equity universe · ranked by percent change. No prices are invented.</p></div><span class="live-tag">FYERS-READY</span></div>' +
    '<div class="explorer-controls"><label for="stockSearch">Search symbol or company</label><input id="stockSearch" type="search" placeholder="Try NIFTY, BANKNIFTY, RELIANCE, INFY…" autocomplete="off"><label for="stockCategory">Category</label><select id="stockCategory"><option value="all">All supported symbols</option><option value="index">Indices</option><option value="equity">Equity research</option></select><button class="secondary" id="refreshStockQuotesBtn">Refresh equity quotes</button></div>' +
    '<div id="stockExplorerStatus" class="hint">Requesting a verified FYERS equity snapshot…</div><div id="stockExplorerResults" class="explorer-grid"></div><p class="hint">Index cards use the live stream; Stock Explorer refreshes its F&O equity universe from the daily FYERS symbol master, with a validated configured fallback if that master is unavailable. After-hours prices are last-known quotes, not live ticks. Unavailable symbols remain unavailable.</p></div>';
}

let stockExplorerRequestRunning = false;
let stockExplorerCanRank = false;

async function loadStockExplorerQuotes() {
  if (stockExplorerRequestRunning || currentTab !== 'Stock Explorer') return;
  const status = document.querySelector('#stockExplorerStatus');
  const button = document.querySelector('#refreshStockQuotesBtn');
  if (!status) return;
  stockExplorerRequestRunning = true;
  if (button) button.disabled = true;
  status.textContent = 'Requesting verified equity quotes from FYERS…';
  try {
    const response = await fetch(BACKEND_URL + '/api/market/movers', {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.data)) {
      throw new Error(result.detail || result.error || 'FYERS equity snapshot unavailable.');
    }
    stockExplorerMoverRows = result.data.filter(row =>
      row && typeof row.symbol === 'string' &&
      Number.isFinite(Number(row.price)) && Number(row.price) > 0
    );
    const count = Number(result.receivedSymbols ?? stockExplorerMoverRows.length);
    const requested = Number(result.requestedSymbols ?? count);
    const missingSymbols = Array.isArray(result.failedSymbols) ? result.failedSymbols : [];
    const allRowsFresh = stockExplorerMoverRows.length === requested && stockExplorerMoverRows.every(row => {
      if (row.priceStatus !== 'LIVE_QUOTE' || !Number.isFinite(Number(row.changePct)) ||
          !Number.isFinite(Number(row.quoteAgeSeconds)) || Number(row.quoteAgeSeconds) < 0 ||
          Number(row.quoteAgeSeconds) > 180 || !row.priceAsOf) return false;
      const tradedAt = Date.parse(row.priceAsOf);
      const ageSeconds = (Date.now() - tradedAt) / 1000;
      return Number.isFinite(tradedAt) && ageSeconds >= 0 && ageSeconds <= 180;
    });
    stockExplorerCanRank = result.marketSession === 'OPEN' && result.partial !== true &&
      requested > 0 && count === requested && missingSymbols.length === 0 && allRowsFresh;
    renderStockExplorerResults();
    const sourceLabel = result.universe === 'FYERS-NSE-FO-symbol-master'
      ? 'FYERS NSE F&O master'
      : 'configured fallback universe';
    const quoteRows = Array.isArray(result.data) ? result.data : [];
    const liveCount = quoteRows.filter(row => row.priceStatus === 'LIVE_QUOTE').length;
    const lastKnownCount = quoteRows.filter(row => row.priceStatus === 'LAST_KNOWN_PRICE').length;
    const staleCount = quoteRows.filter(row => row.priceStatus === 'STALE_QUOTE' || row.priceStatus === 'TIME_UNVERIFIED').length;
    const missing = Array.isArray(result.failedSymbols) ? result.failedSymbols : [];
    status.textContent = 'FYERS snapshot ' + new Date(result.fetchedAt || Date.now()).toLocaleTimeString('en-IN') +
      ' · Universe: ' + sourceLabel + ' · Quotes: ' + count + '/' + requested +
      ' · Live: ' + liveCount + ' · Last-known: ' + lastKnownCount + ' · Stale/time-unverified: ' + staleCount +
      (result.partial ? ' · INCOMPLETE coverage; missing/unavailable: ' + missing.length +
        (missing.length ? ' (' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', …' : '') + ')' : '') : ' · Quote coverage complete for returned universe') +
      (stockExplorerCanRank ? ' · FULL LIVE RANKING VERIFIED' : ' · NOT A FULL LIVE RANKING; showing available quotes without ranking');
    logEvent('Stock Explorer FYERS snapshot (' + count + '/' + requested + '; ' + sourceLabel +
      '; live=' + liveCount + '; last-known=' + lastKnownCount + '; stale/unverified=' + staleCount +
      '; missing=' + missing.length + ').', result.partial ? 'warn' : 'info');
  } catch (error) {
    stockExplorerCanRank = false;
    renderStockExplorerResults();
    status.textContent = 'Equity quote request failed: ' + (error.message || 'FYERS snapshot unavailable.') +
      ' Tap Refresh equity quotes to retry. Any retained prices are not a current full-universe ranking. No prices were fabricated.';
    logEvent('Stock Explorer equity snapshot failed: ' + (error.message || 'unknown error'), 'warn');
  } finally {
    stockExplorerRequestRunning = false;
    if (button) button.disabled = false;
  }
}

function renderStockExplorerResults() {
  const host=document.querySelector('#stockExplorerResults');
  if(!host) return;
  const q=(document.querySelector('#stockSearch')?.value||'').trim().toLowerCase();
  const category=document.querySelector('#stockCategory')?.value||'all';
  const universe=[
    {symbol:'NSE:NIFTY50-INDEX',name:'NIFTY 50',kind:'index',tab:'NIFTY',note:'Benchmark index'},
    {symbol:'NSE:NIFTYBANK-INDEX',name:'BANK NIFTY',kind:'index',tab:'BANKNIFTY',note:'Banking index'}
  ];
  // Use the backend's current FYERS NSE F&O master snapshot, not a short hard-coded
  // stock list. Rank equity rows by verified percent change before showing indices.
  const dynamicRows=stockExplorerMoverRows.map(x=>({symbol:x.symbol,name:x.symbol.replace(/^NSE:/,'').replace(/-EQ$/,''),kind:'equity',tab:'Gainers & Losers',note:'Verified FYERS quote snapshot',price:Number(x.price),changePct:x.changePct==null?null:Number(x.changePct)}));
  // Do not present a partial or after-hours snapshot as a full-universe live ranking.
  if(stockExplorerCanRank){
    dynamicRows.sort((a,b)=>{
      const av=Number.isFinite(a.changePct)?a.changePct:-Infinity;
      const bv=Number.isFinite(b.changePct)?b.changePct:-Infinity;
      return bv-av;
    });
  }
  const combined=[...dynamicRows,...universe];
  const rows=combined.filter(x=>(category==='all'||x.kind===category)&&(!q||(x.symbol+' '+x.name).toLowerCase().includes(q)));
  host.innerHTML=rows.length?rows.map(x=>{
    const quote=quoteFor(x.symbol);
    const mover=stockExplorerMoverRows.find(row=>row.symbol===x.symbol);
    const price=quote?quote.price:(mover?Number(mover.price):null);
    const changePct=mover&&mover.changePct!=null&&Number.isFinite(Number(mover.changePct))?Number(mover.changePct):null;
    const fresh=hasFreshLiveQuote(quote);
    const marketClosed=!isRegularMarketSession();
    const priceTime=mover&&mover.priceAsOf?new Date(mover.priceAsOf).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'exchange trade time unavailable';
    const priceAsOfMs=mover&&mover.priceAsOf?Date.parse(mover.priceAsOf):NaN;
    const currentQuoteAgeMs=Number.isFinite(priceAsOfMs)?Date.now()-priceAsOfMs:Infinity;
    const moverStatus=!mover?'':marketClosed?'LAST_KNOWN_PRICE'
      :mover.priceStatus==='TIME_UNVERIFIED'?'TIME_UNVERIFIED'
      :mover.priceStatus!=='LIVE_QUOTE'?'STALE_QUOTE'
      :Number.isFinite(currentQuoteAgeMs)&&currentQuoteAgeMs>=0&&currentQuoteAgeMs<=180000?'LIVE_QUOTE':'STALE_QUOTE';
    const priceLabel=mover
      ? (moverStatus==='LIVE_QUOTE'?'LIVE FYERS QUOTE':moverStatus==='LAST_KNOWN_PRICE'?'LAST KNOWN PRICE':moverStatus==='STALE_QUOTE'?'STALE QUOTE':'QUOTE TIME UNKNOWN')
      : (fresh?'LIVE INDEX QUOTE':quote?(marketClosed?'LAST KNOWN INDEX PRICE':'STALE / RECONNECTING INDEX QUOTE'):'DATA PENDING');
    const changeLabel=changePct!==null?'<span class="'+(changePct>=0?'positive-text':'negative-text')+'">'+(changePct>0?'+':'')+changePct.toFixed(2)+'%</span>':'<span class="muted-text">Change unavailable</span>';
    const indexTime=quote&&quote.sourceTime&&Number.isFinite(Date.parse(quote.sourceTime))?new Date(quote.sourceTime).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'exchange trade time unavailable';
    const detail=mover
      ? (moverStatus==='LIVE_QUOTE'?'Fresh exchange-timestamped FYERS quote · '+priceTime
        : moverStatus==='LAST_KNOWN_PRICE'?'Market closed · last known FYERS price · '+priceTime
        : moverStatus==='STALE_QUOTE'?'Quote timestamp is stale · '+priceTime
        :'FYERS returned a price but its exchange timestamp is unavailable; freshness is unverified')
      : (quote?(fresh?'Fresh exchange-timestamped FYERS index quote · '+indexTime:marketClosed?'Market closed · last known FYERS index price · '+indexTime:'Last received FYERS index price; live freshness is not verified · '+indexTime):x.note);
    return '<article class="explorer-card"><div class="explorer-card-top"><span class="live-tag">'+(x.kind==='index'?'INDEX':'EQUITY')+'</span><span class="quote-time">'+priceLabel+'</span></div><h4>'+escapeHtml(x.name)+'</h4><small>'+escapeHtml(x.symbol)+'</small><strong class="explorer-price">'+(price!==null?'₹'+formatPrice(price):'—')+'</strong><p>'+changeLabel+' · '+escapeHtml(detail)+'</p><button class="secondary" data-explorer-jump="'+x.tab+'">Open workspace</button></article>';
  }).join(''):'<div class="chart-empty">No symbols match this search.</div>';
  host.querySelectorAll('[data-explorer-jump]').forEach(btn=>btn.addEventListener('click',()=>render(btn.dataset.explorerJump)));
}

function marketActivityMarkup() {
  return '<div class="console-grid console-grid-2">' +
    '<article class="console-section"><div class="console-section-head"><h4>Selected-universe breadth</h4><span class="live-tag">FYERS SNAPSHOT</span></div>' +
    '<div class="data-row"><span>Symbols returned</span><b id="activityTotal">—</b></div>' +
    '<div class="data-row"><span>Advancers</span><b id="activityAdvancers">—</b></div>' +
    '<div class="data-row"><span>Decliners</span><b id="activityDecliners">—</b></div>' +
    '<div class="data-row"><span>Unchanged / unavailable change</span><b id="activityUnchanged">—</b></div>' +
    '<div id="activityBreadthStatus" class="hint">Connect FYERS and refresh to calculate breadth from verified quote responses.</div></article>' +
    '<article class="console-section"><div class="console-section-head"><h4>Strongest movers</h4><span class="live-tag">QUOTE DATA</span></div>' +
    '<div id="activityMovers" class="table-wrap"><div class="chart-empty">No verified snapshot loaded.</div></div>' +
    '<button class="primary" id="refreshMarketActivityBtn">Refresh verified snapshot</button></article>' +
    '<article class="console-section"><div class="console-section-head"><h4>Volume & volatility</h4><span class="live-tag">OHLC REQUIRED</span></div>' +
    '<div class="chart-empty">Volume spikes and volatility rankings are withheld until verified historical OHLC/volume data is calculated for the selected symbols.</div></article>' +
    '<article class="console-section"><div class="console-section-head"><h4>Institutional flows</h4><span class="live-tag">SOURCE CHECK</span></div>' +
    '<div class="chart-empty">FII/DII figures are not connected to a verified source in this dashboard, so no numbers are shown.</div>' +
    '<button class="secondary" data-jump="FII/DII Flow">Open FII/DII workspace</button></article></div>' +
    '<p class="hint">Breadth covers only the selected large-cap NSE symbols returned by the FYERS Quotes API, not the entire exchange. Snapshot change is not a confirmed breakout or a trading recommendation.</p>';
}

async function loadMarketActivity() {
  if (currentTab !== 'Market Activity') return;
  const status = document.querySelector('#activityBreadthStatus');
  const table = document.querySelector('#activityMovers');
  const button = document.querySelector('#refreshMarketActivityBtn');
  if (!status || !table || (button && button.disabled)) return;
  if (button) button.disabled = true;
  status.textContent = 'Requesting a verified FYERS quote snapshot…';
  try {
    const response = await fetch(BACKEND_URL + '/api/market/movers', {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.data)) {
      throw new Error(result.detail || result.error || 'Verified FYERS snapshot unavailable.');
    }
    if (result.marketSession !== 'OPEN') {
      throw new Error('MARKET CLOSED — current breadth and movers are unavailable. Last-known prices are not ranked as live activity.');
    }
    const requested = Number(result.requestedSymbols);
    const received = Number(result.receivedSymbols);
    if (result.partial === true || !Number.isFinite(requested) || requested < 1 ||
        !Number.isFinite(received) || received !== requested ||
        (Array.isArray(result.failedSymbols) && result.failedSymbols.length > 0)) {
      throw new Error('INCOMPLETE QUOTE COVERAGE — market activity is blocked until every requested symbol is returned.');
    }
    const rows = result.data.filter(row => {
      if (!row || typeof row.symbol !== 'string' || row.priceStatus !== 'LIVE_QUOTE' ||
          !Number.isFinite(Number(row.price)) || Number(row.price) <= 0 ||
          !Number.isFinite(Number(row.changePct)) ||
          !Number.isFinite(Number(row.quoteAgeSeconds)) ||
          Number(row.quoteAgeSeconds) < 0 || Number(row.quoteAgeSeconds) > 180 ||
          !row.priceAsOf) return false;
      const tradedAt = Date.parse(row.priceAsOf);
      const ageSeconds = (Date.now() - tradedAt) / 1000;
      return Number.isFinite(tradedAt) && ageSeconds >= 0 && ageSeconds <= 180;
    });
    if (rows.length !== requested) {
      throw new Error('FRESHNESS CHECK FAILED — only ' + rows.length + ' of ' + requested + ' quotes passed validation. Breadth and rankings blocked.');
    }
    const changes = rows.map(row => Number(row.changePct));
    const advancers = changes.filter(value => value > 0).length;
    const decliners = changes.filter(value => value < 0).length;
    const unchanged = rows.length - advancers - decliners;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = String(value); };
    set('activityTotal', rows.length);
    set('activityAdvancers', advancers);
    set('activityDecliners', decliners);
    set('activityUnchanged', unchanged);
    const sorted = rows.slice().sort((a, b) => Number(b.changePct) - Number(a.changePct));
    const movers = [...sorted.slice(0, 5), ...sorted.slice(-5).reverse()];
    table.innerHTML = movers.length
      ? '<table class="console-table"><thead><tr><th>Symbol</th><th>LTP</th><th>Change %</th><th>Quote age</th></tr></thead><tbody>' +
        movers.map(row => '<tr><td>' + escapeHtml(row.symbol.replace(/^NSE:/, '').replace(/-EQ$/, '')) +
          '</td><td>' + formatPrice(Number(row.price)) + '</td><td class="' +
          (Number(row.changePct) > 0 ? 'positive-text' : Number(row.changePct) < 0 ? 'negative-text' : '') + '">' +
          (Number(row.changePct) > 0 ? '+' : '') + Number(row.changePct).toFixed(2) + '%</td><td>' +
          Math.floor(Number(row.quoteAgeSeconds)) + 's</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="chart-empty">No complete verified quote set was returned.</div>';
    status.textContent = 'COMPLETE FRESH FYERS snapshot · ' + rows.length + '/' + requested +
      ' quotes passed exchange-timestamp checks · received ' +
      new Date(result.fetchedAt || Date.now()).toLocaleTimeString('en-IN') + '.';
    logEvent('Market Activity accepted only a complete fresh FYERS snapshot (' + rows.length + '/' + requested + ').', 'info');
  } catch (error) {
    ['activityTotal', 'activityAdvancers', 'activityDecliners', 'activityUnchanged'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '—';
    });
    status.textContent = (error.message || 'Market snapshot unavailable.') + ' No live breadth or ranking is shown unless the complete fresh quote set passes validation.';
    table.innerHTML = '<div class="chart-empty">Market activity blocked. Complete, fresh exchange-timestamped quotes are required.</div>';
    logEvent('Market Activity snapshot blocked: ' + (error.message || 'unknown validation failure'), 'warn');
  } finally {
    if (button) button.disabled = false;
  }
}

function dashboardMarkup() {
  const chartSymbols = [
    { symbol: 'NSE:NIFTY50-INDEX', name: 'NIFTY 50' },
    { symbol: 'NSE:NIFTYBANK-INDEX', name: 'BANK NIFTY' },
    ...stockExplorerMoverRows.map(row => ({
      symbol: row.symbol,
      name: row.symbol.replace(/^NSE:/, '').replace(/-EQ$/, '')
    }))
  ];
  const seenChartSymbols = new Set();
  const chartSymbolOptions = chartSymbols.filter(item => {
    if (!item.symbol || seenChartSymbols.has(item.symbol)) return false;
    seenChartSymbols.add(item.symbol);
    return true;
  }).map(item => '<option value="' + escapeHtml(item.symbol) + '">' + escapeHtml(item.name) + '</option>').join('');
  const chartUniverseNote = stockExplorerMoverRows.length
    ? 'Symbol list includes ' + stockExplorerMoverRows.length + ' equities from the latest FYERS Stock Explorer snapshot.'
    : 'Index candles are available here. Open Stock Explorer and refresh verified FYERS quotes to populate the F&O equity symbol list.';
  return '<div class="console-grid">' + quoteCardsMarkup() + '</div>' +
    '<article class="console-section"><div class="console-section-head"><div><h4>Market candlestick chart</h4><p>Historical OHLC candles from FYERS · no synthetic candles</p></div><span class="live-tag">VERIFIED OHLC</span></div>' +
    '<div class="option-controls"><label>Symbol<select id="dashboardCandleSymbol">' + chartSymbolOptions + '</select></label><label>Timeframe<select id="dashboardCandleResolution"><option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">1 hour</option><option value="D">1 day</option></select></label><button class="primary" id="dashboardCandlesBtn">Load candlesticks</button></div>' +
    '<div id="dashboardCandleStatus" class="hint">Choose a symbol and load verified historical candles. ' + escapeHtml(chartUniverseNote) + '</div><div id="dashboardChart"><div class="chart-empty">Candlesticks have not been loaded yet.</div></div>' +
    '<div class="chart-foot"><span id="chartSampleCount">Historical FYERS candles</span><span>OHLC · READ ONLY</span></div></article>' +
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

function loadWatchlistSymbols() {
  try {
    const saved=JSON.parse(localStorage.getItem('dhanpulse-watchlist-v1')||'null');
    if(Array.isArray(saved))return [...new Set(saved.filter(value=>typeof value==='string'&&/^(NSE:[A-Z0-9&-]+-(?:INDEX|EQ))$/.test(value)))].slice(0,30);
  } catch {}
  return SYMBOLS.map(item=>item.symbol);
}
function saveWatchlistSymbols() {
  try { localStorage.setItem('dhanpulse-watchlist-v1',JSON.stringify(watchlistSymbols)); }
  catch { logEvent('Watchlist could not be saved in browser storage.','warn'); }
}
function watchlistMarkup() {
  return '<div class="console-section"><div class="console-section-head"><div><h4>Personal watchlist</h4><p>Indices use the authenticated stream; selected equities use the verified FYERS quote snapshot.</p></div><span class="live-tag">LOCAL LIST</span></div>' +
    '<div class="option-controls"><label>Add supported symbol<select id="watchlistSymbolSelect"><option value="">Load available equity symbols…</option></select></label><button class="primary" id="addWatchlistSymbolBtn">Add to watchlist</button><button class="secondary" id="refreshWatchlistBtn">Refresh quotes</button></div>' +
    '<div id="watchlistStatus" class="hint">Loading verified quote universe when FYERS is connected…</div><div id="watchlistTable" class="table-wrap"></div>' +
    '<p class="hint">Equity quotes are snapshots, not a streaming feed. The list is saved in this browser only; supported equity symbols are limited to the configured large-cap universe.</p></div>';
}
function renderWatchlistTable() {
  const host=document.querySelector('#watchlistTable'); if(!host)return;
  const rows=watchlistSymbols.map(symbol=>{
    const index=SYMBOLS.find(item=>item.symbol===symbol);
    const quote=index?quoteFor(symbol):null;
    const equity=watchlistEquityRows.find(item=>item.symbol===symbol);
    return {symbol,label:index?index.label:symbol.replace(/^NSE:/,'').replace(/-EQ$/,''),quote,equity};
  });
  host.innerHTML=rows.length?'<table class="console-table"><thead><tr><th>Symbol</th><th>Last price</th><th>Change %</th><th>Source / updated</th><th>Action</th></tr></thead><tbody>'+
    rows.map(row=>{
      const marketClosed=!isRegularMarketSession();
      const indexFresh=hasFreshLiveQuote(row.quote);
      const equityTime=row.equity&&row.equity.priceAsOf?Date.parse(row.equity.priceAsOf):NaN;
      const equityAge=Number.isFinite(equityTime)?(Date.now()-equityTime)/1000:Infinity;
      const equityFresh=!!row.equity&&!marketClosed&&row.equity.priceStatus==='LIVE_QUOTE'&&equityAge>=0&&equityAge<=180&&Number(row.equity.quoteAgeSeconds)>=0&&Number(row.equity.quoteAgeSeconds)<=180;
      const hasIndexPrice=!!row.quote&&Number.isFinite(Number(row.quote.price))&&Number(row.quote.price)>0;
      const hasEquityPrice=!!row.equity&&Number.isFinite(Number(row.equity.price))&&Number(row.equity.price)>0;
      const price=row.quote?(hasIndexPrice?Number(row.quote.price):null):hasEquityPrice?Number(row.equity.price):null;
      const change=row.quote?row.quote.changePct:row.equity?Number(row.equity.changePct):null;
      const updated=row.quote?(row.quote.sourceTime||new Date(row.quote.receivedAt).toISOString()):row.equity?(row.equity.priceAsOf||watchlistEquityRows.fetchedAt||'—'):'—';
      const source=row.quote?(indexFresh?'LIVE INDEX STREAM':marketClosed&&hasIndexPrice?'LAST KNOWN INDEX PRICE':hasIndexPrice?'STALE / RECONNECTING INDEX':'DATA UNAVAILABLE')
        :row.equity?(marketClosed&&hasEquityPrice?'LAST KNOWN · MARKET CLOSED':equityFresh?'LIVE FYERS QUOTE':hasEquityPrice?'STALE / UNVERIFIED EQUITY QUOTE':'DATA UNAVAILABLE')
        :'Waiting for verified quote';
      const displayPrice=price!==null?'₹'+formatPrice(price):'—';
      const displayChange=price!==null&&Number.isFinite(Number(change))?(Number(change)>0?'+':'')+Number(change).toFixed(2)+'%':'—';
      return '<tr><td><b>'+escapeHtml(row.label)+'</b><small>'+escapeHtml(row.symbol)+'</small></td><td>'+displayPrice+'</td><td class="'+(Number(change)>0?'positive-text':Number(change)<0?'negative-text':'')+'">'+displayChange+'</td><td>'+source+'<small>'+escapeHtml(updated==='—'?'—':new Date(updated).toLocaleString('en-IN'))+'</small></td><td>'+(SYMBOLS.some(item=>item.symbol===row.symbol)?'<span class="live-tag">INDEX</span>':'<button class="secondary" data-remove-watchlist="'+escapeHtml(row.symbol)+'">Remove</button>')+'</td></tr>';
    }).join('')+'</tbody></table>':'<div class="chart-empty">Your watchlist is empty. Add a supported symbol above.</div>';
  host.querySelectorAll('[data-remove-watchlist]').forEach(button=>button.addEventListener('click',()=>{watchlistSymbols=watchlistSymbols.filter(symbol=>symbol!==button.dataset.removeWatchlist);saveWatchlistSymbols();renderWatchlistTable();}));
}
async function loadWatchlistQuotes() {
  if(currentTab!=='Watchlist'||watchlistRequestRunning)return;
  watchlistRequestRunning=true;
  const status=document.querySelector('#watchlistStatus'),select=document.querySelector('#watchlistSymbolSelect');
  if(status)status.textContent='Requesting verified FYERS equity snapshot…';
  try {
    const response=await fetch(BACKEND_URL+'/api/market/movers',{headers:{Accept:'application/json'},cache:'no-store'});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true||!Array.isArray(result.data))throw new Error(result.detail||result.error||'FYERS equity snapshot unavailable.');
    watchlistEquityRows=result.data.filter(row=>row&&typeof row.symbol==='string'&&Number.isFinite(Number(row.price))&&Number(row.price)>0);
    watchlistEquityRows.fetchedAt=result.fetchedAt||new Date().toISOString();
    if(select){
      const previous=select.value;
      select.innerHTML='<option value="">Choose a supported symbol</option>'+watchlistEquityRows.map(row=>'<option value="'+escapeHtml(row.symbol)+'">'+escapeHtml(row.symbol.replace(/^NSE:/,'').replace(/-EQ$/,''))+'</option>').join('');
      if(previous&&Array.from(select.options).some(option=>option.value===previous))select.value=previous;
    }
    renderWatchlistTable();
    if(status)status.textContent='FYERS snapshot received · '+watchlistEquityRows.length+' supported equity quotes available.';
  } catch(error) {
    if(status)status.textContent=(error.message||'Equity snapshot unavailable.')+' Index stream may still be shown; no prices fabricated.';
    renderWatchlistTable();
  } finally {watchlistRequestRunning=false;}
}

function moversMarkup() {
  return '<div class="movers-toolbar"><div><b>Selected NSE large-cap stocks</b><p>Snapshot requested from the authenticated FYERS Quotes API. This is not a full-market scan.</p></div><button class="primary" id="refreshMoversBtn">Refresh movers</button></div><div id="moversStatus" class="hint">Load a verified FYERS snapshot to rank gainers and losers.</div><div class="console-grid console-grid-2"><article class="console-section"><div class="console-section-head"><h4>Top gainers</h4><span class="signal-tone positive">UP</span></div><div id="gainersTable" class="table-wrap"><div class="chart-empty">No snapshot loaded.</div></div></article><article class="console-section"><div class="console-section-head"><h4>Top losers</h4><span class="signal-tone negative">DOWN</span></div><div id="losersTable" class="table-wrap"><div class="chart-empty">No snapshot loaded.</div></div></article></div><p class="hint">Percent change comes directly from FYERS quotes. Symbols without a valid price/change are omitted. Refresh is manual to avoid excessive API requests.</p>';
}

async function loadMovers() {
  if (currentTab !== 'Gainers & Losers') return;
  const status = document.querySelector('#moversStatus');
  const gainers = document.querySelector('#gainersTable');
  const losers = document.querySelector('#losersTable');
  const button = document.querySelector('#refreshMoversBtn');
  if (!status || !gainers || !losers) return;
  if (button) button.disabled = true;
  status.textContent = 'Requesting a complete, fresh FYERS quote snapshot…';
  try {
    const response = await fetch(BACKEND_URL + '/api/market/movers', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.data)) {
      throw new Error(result.error || result.detail || 'FYERS market-mover snapshot unavailable.');
    }
    if (result.marketSession !== 'OPEN') {
      throw new Error('MARKET CLOSED — current gainers/losers are unavailable. Last-known prices must not be ranked as live movers.');
    }
    const requested = Number(result.requestedSymbols);
    const received = Number(result.receivedSymbols);
    if (result.partial === true || !Number.isFinite(requested) || requested < 1 ||
        !Number.isFinite(received) || received !== requested ||
        (Array.isArray(result.failedSymbols) && result.failedSymbols.length > 0)) {
      throw new Error('INCOMPLETE F&O COVERAGE — ranking blocked until every requested symbol has a quote.');
    }
    const rows = result.data.filter(item => {
      if (!item || item.priceStatus !== 'LIVE_QUOTE' ||
          !Number.isFinite(Number(item.price)) || Number(item.price) <= 0 ||
          !Number.isFinite(Number(item.changePct)) ||
          !Number.isFinite(Number(item.quoteAgeSeconds)) ||
          Number(item.quoteAgeSeconds) < 0 || Number(item.quoteAgeSeconds) > 180 ||
          !item.priceAsOf) return false;
      const tradedAt = Date.parse(item.priceAsOf);
      const actualAgeSeconds = (Date.now() - tradedAt) / 1000;
      return Number.isFinite(tradedAt) && actualAgeSeconds >= 0 && actualAgeSeconds <= 180;
    });
    if (rows.length !== requested) {
      throw new Error('FRESHNESS CHECK FAILED — only ' + rows.length + ' of ' + requested + ' quotes passed validation. Ranking blocked.');
    }
    const table = list => !list.length
      ? '<div class="chart-empty">No verified rows for this group.</div>'
      : '<table class="console-table"><thead><tr><th>Symbol</th><th>LTP</th><th>Change %</th><th>Quote age</th></tr></thead><tbody>' +
        list.map(item => '<tr><td><b>' + escapeHtml(item.symbol.replace(/^NSE:/, '').replace(/-EQ$/, '')) + '</b></td><td>' + formatPrice(item.price) + '</td><td class="' + (item.changePct >= 0 ? 'positive-text' : 'negative-text') + '">' + (item.changePct > 0 ? '+' : '') + item.changePct.toFixed(2) + '%</td><td>' + Math.floor(Number(item.quoteAgeSeconds)) + 's</td></tr>').join('') +
        '</tbody></table>';
    const sorted = rows.slice().sort((a, b) => b.changePct - a.changePct);
    gainers.innerHTML = table(sorted.filter(item => item.changePct > 0).slice(0, 10));
    losers.innerHTML = table(sorted.filter(item => item.changePct < 0).slice(-10).reverse());
    status.textContent = 'COMPLETE FRESH FYERS snapshot · ' + rows.length + '/' + requested + ' quotes verified · received ' + new Date(result.fetchedAt || Date.now()).toLocaleTimeString('en-IN') + '.';
    logEvent('FYERS gainers/losers ranking accepted only after full-coverage and freshness validation (' + rows.length + '/' + requested + ').', 'info');
  } catch (error) {
    gainers.innerHTML = '<div class="chart-empty">Ranking blocked. No verified current mover list is available; no values have been fabricated.</div>';
    losers.innerHTML = '<div class="chart-empty">Ranking blocked. No verified current mover list is available; no values have been fabricated.</div>';
    status.textContent = (error.message || 'Could not load movers.');
    logEvent('FYERS market-mover ranking blocked: ' + (error.message || 'unknown validation failure'), 'warn');
  } finally {
    if (button) button.disabled = false;
  }
}

function advancedScannerMarkup(tab) {
  if (tab === 'FII/DII Flow') {
    return '<div class="console-section"><div class="console-section-head"><div><h4>Official institutional flow report</h4><p>Use the exchange-published report for the latest FII/FPI and DII net buy/sell values.</p></div><span class="live-tag">OFFICIAL SOURCE</span></div>' +
      '<p class="hint">The NSE report may show provisional figures that can change after confirmation. DhanPulse does not scrape or cache these values yet, so it will not display them as if they were independently verified.</p>' +
      '<p><a class="primary" href="https://www.nseindia.com/reports/fii-dii" target="_blank" rel="noopener noreferrer">Open official NSE FII/DII report ↗</a></p>' +
      '<p class="hint">For historical reports, use NSE All Reports. Compare the report date and segment before using any figure in analysis.</p>' +
      '<p><a href="https://www.nseindia.com/all-reports" target="_blank" rel="noopener noreferrer">NSE All Reports ↗</a></p></div>';
  }
  if (tab === 'Sureshot CE/PE') {
    return '<div class="console-section"><div class="console-section-head"><div><h4>Sureshot · Supply/Demand setup desk</h4><p>Stocks + NIFTY/BANKNIFTY CE/PE · OHLC zones + verified option chain</p></div><span class="live-tag">RULE-BASED · READ ONLY</span></div><div class="option-controls"><label>Underlying<select id="setupSymbol"><option value="NSE:NIFTY50-INDEX">NIFTY 50 · Index options</option><option value="NSE:NIFTYBANK-INDEX">BANK NIFTY · Index options</option><option value="NSE:RELIANCE-EQ">RELIANCE · Stock</option><option value="NSE:HDFCBANK-EQ">HDFC BANK · Stock</option><option value="NSE:INFY-EQ">INFOSYS · Stock</option><option value="NSE:TCS-EQ">TCS · Stock</option><option value="NSE:ICICIBANK-EQ">ICICI BANK · Stock</option><option value="NSE:SBIN-EQ">SBI · Stock</option></select></label><label>Chart interval<select id="setupResolution"><option value="5" selected>5 min</option><option value="15">15 min</option><option value="60">60 min</option><option value="D">Daily</option></select></label><button class="primary" id="refreshSetupBtn">Analyse verified setup</button></div><div id="setupStatus" class="hint">A setup is shown only after verified OHLC candles and option-chain data are available. Weak setups are marked NO TRADE.</div><div class="zone-legend"><span><i class="zone-swatch supply"></i> Supply zone</span><span><i class="zone-swatch demand"></i> Buyer / demand zone</span><span>Minimum planned RR: <b>1:2</b></span></div><div id="setupZoneChart" class="pattern-chart"><div class="chart-empty">Load verified candles to draw zones.</div></div><div id="setupZoneSummary" class="hint">Zones will be calculated from returned OHLC candles, not fabricated values.</div><div id="setupCards" class="console-grid console-grid-2"><div class="chart-empty">Waiting for analysis.</div></div></div><p class="hint">Supply/demand zones and risk levels are heuristic, not guarantees. A valid plan needs a confirmed directional setup, verified option premium, and at least 1:2 planned reward-to-risk. No trade is generated when data or conditions are insufficient. No orders are placed.</p>';
  }
  if (tab === 'FII/DII Flow') {
    return '<div class="console-section"><div class="console-section-head"><h4>Institutional activity</h4><span class="live-tag">SOURCE CHECK</span></div><div class="chart-empty">FII/DII data is not currently connected to a verified source in this project. No institutional figures are fabricated. This module will show data only after a source and timestamp can be verified.</div><p class="hint">FYERS index quotes and option-chain OI are not the same as official FII/DII cash-market flows.</p></div>';
  }
  if (tab === 'Charts & Patterns') {
    return '<div class="console-section"><div class="console-section-head"><div><h4>Historical candle lab</h4><p>OHLC candles requested from authenticated FYERS history API</p></div><span class="live-tag">FYERS DATA</span></div><div class="option-controls"><label>Symbol<select id="patternSymbol"><option value="NSE:NIFTY50-INDEX">NIFTY 50</option><option value="NSE:NIFTYBANK-INDEX">BANK NIFTY</option><option value="NSE:RELIANCE-EQ">RELIANCE</option><option value="NSE:HDFCBANK-EQ">HDFC BANK</option><option value="NSE:INFY-EQ">INFOSYS</option></select></label><label>Interval<select id="patternResolution"><option value="1">1 min</option><option value="5" selected>5 min</option><option value="15">15 min</option><option value="60">60 min</option><option value="D">Daily</option></select></label><button class="primary" id="loadCandlesBtn">Load candles</button></div><div id="patternStatus" class="hint">Load verified historical candles to inspect OHLC movement.</div><div id="patternChart" class="pattern-chart"><div class="chart-empty">No candles loaded.</div></div><div id="patternSummary" class="hint">No pattern analysis yet.</div><div id="candleTable" class="table-wrap"></div></div><p class="hint">Pattern descriptions are heuristic and historical, not predictions or trade recommendations. Data availability depends on FYERS permissions.</p>';
  }
  const title = tab === 'Breakout Scanner' ? 'Breakout candidates to review' : tab === 'Momentum Scanner' ? 'Momentum leaders' : 'High-momentum candidates';
  const desc = tab === 'Breakout Scanner' ? 'Snapshot candidates only — confirm resistance, volume and candle close.' : tab === 'Momentum Scanner' ? 'Ranked by verified percentage change from the selected large-cap universe.' : 'Large percentage movers for research; not a “cheap option” guarantee.';
  return '<div class="movers-toolbar"><div><b>'+title+'</b><p>'+desc+'</p></div><button class="primary" id="refreshAdvancedBtn">Refresh FYERS snapshot</button></div><div id="advancedStatus" class="hint">Fetching no data until you request a verified FYERS snapshot.</div><div id="advancedTable" class="table-wrap"><div class="chart-empty">No snapshot loaded.</div></div><p class="hint">Universe: selected large-cap NSE symbols returned by FYERS Quotes API, not the entire exchange. Snapshot momentum alone does not confirm a breakout or predict future returns.</p>';
}

function sureshotZoneChart(candles, supply, demand) {
  if(!Array.isArray(candles)||candles.length<8) return '<div class="chart-empty">At least 8 verified OHLC candles are required to map zones.</div>';
  const rows=candles.slice(-45), highs=rows.map(x=>Number(x[2])), lows=rows.map(x=>Number(x[3]));
  const hi=Math.max(...highs),lo=Math.min(...lows),span=hi-lo||1,w=720,h=260,pad=14;
  const y=v=>h-pad-((v-lo)/span)*(h-pad*2),slot=(w-pad*2)/rows.length;
  const bands=[{z:supply,fill:'#ff8198',label:'SUPPLY'},{z:demand,fill:'#5de0a2',label:'BUYER / DEMAND'}];
  const bandSvg=bands.map(({z,fill,label})=>{if(!z)return '';const top=Math.max(0,Math.min(h,y(z.high))),bottom=Math.max(0,Math.min(h,y(z.low)));return '<rect x="'+pad+'" y="'+Math.min(top,bottom)+'" width="'+(w-pad*2)+'" height="'+Math.max(2,Math.abs(bottom-top))+'" fill="'+fill+'" opacity=".16"/><line x1="'+pad+'" y1="'+y(z.high)+'" x2="'+(w-pad)+'" y2="'+y(z.high)+'" stroke="'+fill+'" stroke-dasharray="5 4"/><text x="'+(w-pad-4)+'" y="'+(y(z.high)-4)+'" text-anchor="end" fill="'+fill+'" font-size="10">'+label+' '+formatPrice(z.high)+'–'+formatPrice(z.low)+'</text>';}).join('');
  const candlesSvg=rows.map((x,i)=>{const o=Number(x[1]),hh=Number(x[2]),ll=Number(x[3]),c=Number(x[4]),cx=pad+i*slot+slot/2,color=c>=o?'#61f2d2':'#ff8198',by=Math.min(y(o),y(c)),bh=Math.max(1,Math.abs(y(o)-y(c)));return '<line x1="'+cx+'" y1="'+y(hh)+'" x2="'+cx+'" y2="'+y(ll)+'" stroke="'+color+'" stroke-width="1.2"/><rect x="'+(cx-slot*.28)+'" y="'+by+'" width="'+Math.max(2,slot*.56)+'" height="'+bh+'" fill="'+color+'" rx="1"/>';}).join('');
  return '<svg class="live-chart candle-chart" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Verified FYERS candles with calculated supply and demand zones">'+bandSvg+candlesSvg+'<text x="'+pad+'" y="12" class="chart-label">HIGH '+formatPrice(hi)+'</text><text x="'+pad+'" y="'+(h-2)+'" class="chart-label">LOW '+formatPrice(lo)+'</text></svg>';
}
function deriveSureshotZones(candles) {
  if(!Array.isArray(candles)||candles.length<12) return null;
  const rows=candles.slice(-32,-1);
  const supplyHigh=Math.max(...rows.map(x=>Number(x[2])));
  const supplyRow=rows.find(x=>Number(x[2])===supplyHigh);
  const supplyLow=Math.max(Number(supplyRow[1]),Number(supplyRow[4]));
  const demandLow=Math.min(...rows.map(x=>Number(x[3])));
  const demandRow=rows.find(x=>Number(x[3])===demandLow);
  const demandHigh=Math.min(Number(demandRow[1]),Number(demandRow[4]));
  return {supply:{low:Math.min(supplyLow,supplyHigh),high:supplyHigh},demand:{low:demandLow,high:Math.max(demandLow,demandHigh)}};
}
async function loadSureshotStockUniverse() {
  const select=document.querySelector('#setupSymbol');
  if(!select||select.dataset.universeLoaded==='true')return;
  select.dataset.universeLoaded='loading';
  try {
    const response=await fetch(BACKEND_URL+'/api/market/movers',{headers:{Accept:'application/json'},cache:'no-store'});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true||!Array.isArray(result.data))throw new Error(result.error||'Verified stock universe unavailable.');
    const previous=select.value;
    const indexOptions=Array.from(select.options).filter(option=>!option.value.endsWith('-EQ'));
    const stockRows=result.data.filter(row=>row&&typeof row.symbol==='string'&&/^NSE:[A-Z0-9&-]+-EQ$/.test(row.symbol)&&Number.isFinite(Number(row.price))&&Number(row.price)>0);
    const stockOptions=stockRows.map(row=>{
      const symbol=row.symbol;
      const name=symbol.replace(/^NSE:/,'').replace(/-EQ$/,'');
      const option=document.createElement('option');
      option.value=symbol;
      option.textContent=name+' · Stock options';
      return option;
    });
    select.replaceChildren(...indexOptions,...stockOptions);
    if(Array.from(select.options).some(option=>option.value===previous))select.value=previous;
    select.dataset.universeLoaded='true';
    const status=document.querySelector('#setupStatus');
    if(status)status.textContent='Verified quote universe loaded: '+stockRows.length+' configured stock symbols plus indices. This is the backend selected-stock list, not the complete NSE F&O universe.';
  } catch(error) {
    select.dataset.universeLoaded='false';
    const status=document.querySelector('#setupStatus');
    if(status)status.textContent='Could not refresh stock choices from FYERS: '+(error.message||'verified quote universe unavailable')+'. Existing index/stock choices remain; no prices invented.';
  }
}

async function loadSureshotSetup() {
  if(currentTab!=='Sureshot CE/PE')return;
  const status=document.querySelector('#setupStatus'),cards=document.querySelector('#setupCards'),symbolEl=document.querySelector('#setupSymbol'),resolutionEl=document.querySelector('#setupResolution'),chart=document.querySelector('#setupZoneChart'),summary=document.querySelector('#setupZoneSummary');
  if(!status||!cards||!symbolEl||!resolutionEl||!chart||!summary)return;
  const symbol=symbolEl.value,resolution=resolutionEl.value;
  status.textContent='Requesting verified FYERS OHLC candles and option-chain data…';
  cards.innerHTML='<div class="chart-empty">Checking conditions…</div>';
  chart.innerHTML='<div class="chart-empty">Loading verified candles…</div>';
  try{
    const candleResponse=await fetch(BACKEND_URL+'/api/market/candles?'+new URLSearchParams({symbol,resolution}),{headers:{Accept:'application/json'},cache:'no-store'});
    const candleResult=await candleResponse.json().catch(()=>({}));
    if(!candleResponse.ok||candleResult.ok!==true||!Array.isArray(candleResult.data))throw new Error(candleResult.error||candleResult.detail||'Verified historical candles unavailable.');
    const candles=candleResult.data;
    const candleError=validateOhlcCandles(candles,resolution);
    if(candleError)throw new Error(candleError);
    const zones=deriveSureshotZones(candles);
    if(!zones)throw new Error('At least 12 verified candles are needed before zones can be calculated.');
    const lastCandle=candles[candles.length-1],close=Number(lastCandle[4]),previous=Number(candles[candles.length-2][4]);
    chart.innerHTML=sureshotZoneChart(candles,zones.supply,zones.demand);
    summary.textContent='Calculated from '+candles.length+' verified FYERS candles · Supply '+formatPrice(zones.supply.low)+'–'+formatPrice(zones.supply.high)+' · Buyer/demand '+formatPrice(zones.demand.low)+'–'+formatPrice(zones.demand.high)+'. Zones are heuristic and may change as candles update.';
    let bias='NO TRADE',reason='Price is inside the mapped zones or has not confirmed a breakout.';
    if(!isRegularMarketSession()){reason='Market session is closed or outside NSE regular hours. Historical zones may be reviewed, but no actionable setup is shown.';}
    else if(close>zones.supply.high&&close>previous){bias='CE WATCH';reason='Latest candle closed above the calculated supply-zone high.';}
    else if(close<zones.demand.low&&close<previous){bias='PE WATCH';reason='Latest candle closed below the calculated buyer/demand-zone low.';}
    const optionResponse=await fetch(BACKEND_URL+'/api/fyers/options-chain?'+new URLSearchParams({symbol,strikecount:'10'}),{headers:{Accept:'application/json'},cache:'no-store'});
    const optionResult=await optionResponse.json().catch(()=>({}));
    if(!optionResponse.ok||optionResult.ok!==true||!optionResult.data)throw new Error(optionResult.error||optionResult.detail||'Verified option-chain data unavailable; no entry plan generated.');
    const chainCheck=validateOptionChainPayload(optionResult.data);
    if(typeof chainCheck==='string')throw new Error(chainCheck);
    const chain=chainCheck.chain;
    const spot=chainCheck.spot;
    const fetchedAt=Date.parse(optionResult.fetchedAt||'');
    if(!Number.isFinite(fetchedAt)||Date.now()-fetchedAt>15000||fetchedAt>Date.now()+5000)throw new Error('Option-chain snapshot timestamp is stale or invalid; no signal.');
    const strikes=[...new Set(chain.map(x=>Number(x.strike_price)).filter(x=>Number.isFinite(x)&&x>0))];
    const atm=strikes.length?strikes.reduce((best,x)=>Math.abs(x-spot)<Math.abs(best-spot)?x:best,strikes[0]):null;
    const type=bias==='CE WATCH'?'CE':bias==='PE WATCH'?'PE':null;
    const atmIndex=atm===null?-1:strikes.indexOf(atm);
    const nearbyStrikes=new Set(atmIndex<0?[]:strikes.slice(Math.max(0,atmIndex-2),Math.min(strikes.length,atmIndex+3)));
    const legCandidates=type?chain.filter(x=>nearbyStrikes.has(Number(x.strike_price))&&x.option_type===type&&Number(x.ltp)>0&&x.spreadPct<=5&&x.oi>0&&x.volume>0):[];
    // Prefer the most actively traded verified contract among the five nearest strikes,
    // then use OI, spread, and ATM distance as deterministic tie-breakers.
    legCandidates.sort((a,b)=>b.volume-a.volume||b.oi-a.oi||a.spreadPct-b.spreadPct||Math.abs(a.strike_price-spot)-Math.abs(b.strike_price-spot));
    const leg=legCandidates[0]||null;
    if(!type||!leg){
      cards.innerHTML='<article class="console-section"><div class="console-section-head"><h4>NO TRADE</h4><span class="signal-tone neutral">FILTERED</span></div><p>'+escapeHtml(reason)+'</p><p class="hint">No entry/target is issued without a confirmed breakout and a verified matching option premium.</p></article>';
      status.textContent='NO TRADE · '+reason+' Option chain was verified; no actionable setup passed all filters.';
      logEvent('Sureshot filtered setup: '+reason,'info');return;
    }
    const quoteResponse=await fetch(BACKEND_URL+'/api/fyers/option-quote?'+new URLSearchParams({symbol:leg.symbol}),{headers:{Accept:'application/json'},cache:'no-store'});
    const quoteResult=await quoteResponse.json().catch(()=>({}));
    if(!quoteResponse.ok||quoteResult.ok!==true||!quoteResult.quote)throw new Error(quoteResult.error||quoteResult.detail||'Selected option contract has no independently verified fresh quote; no signal.');
    const freshQuote=quoteResult.quote;
    const quoteTimeMs=Number(freshQuote.quoteTimeMs),quoteAgeMs=Date.now()-quoteTimeMs;
    if(!Number.isFinite(quoteTimeMs)||quoteAgeMs < -5000||quoteAgeMs > 15000)throw new Error('Selected option contract quote is stale or timestamped in the future; no signal.');
    const freshBid=Number(freshQuote.bid),freshAsk=Number(freshQuote.ask),freshLtp=Number(freshQuote.ltp);
    if(![freshBid,freshAsk,freshLtp].every(Number.isFinite)||freshBid<=0||freshAsk<freshBid||freshLtp<=0)throw new Error('Selected option contract bid/ask/LTP is invalid; no signal.');
    const freshSpreadPct=((freshAsk-freshBid)/((freshAsk+freshBid)/2))*100;
    if(freshSpreadPct>5)throw new Error('Selected option contract spread exceeds 5%; no trade.');
    const entry=freshAsk,stop=entry*0.90,target=entry+(entry-stop)*2,rr=(target-entry)/(entry-stop);
    const oi=displayNumber(leg.oi,0);
    const volume=displayNumber(leg.volume,0);
    cards.innerHTML='<article class="console-section"><div class="console-section-head"><h4>'+type+' · '+Number(leg.strike_price)+' strike</h4><span class="signal-tone positive">'+bias+'</span></div><strong class="console-price">₹'+formatPrice(entry)+'</strong><div class="data-row"><span>Entry reference (ask-side premium)</span><b>₹'+formatPrice(entry)+'</b></div><div class="data-row"><span>Stop-loss (−10%)</span><b>₹'+formatPrice(stop)+'</b></div><div class="data-row"><span>Target (+20%)</span><b>₹'+formatPrice(target)+'</b></div><div class="data-row"><span>Planned Risk : Reward</span><b>1 : '+rr.toFixed(2)+'</b></div><div class="data-row"><span>Verified contract quote age</span><b>'+Math.max(0,quoteAgeMs/1000).toFixed(1)+' sec</b></div><div class="data-row"><span>Bid / Ask</span><b>₹'+formatPrice(freshBid)+' / ₹'+formatPrice(freshAsk)+'</b></div><div class="data-row"><span>Spread</span><b>'+freshSpreadPct.toFixed(2)+'%</b></div><div class="data-row"><span>Expiry</span><b>'+escapeHtml(/^\d{9,12}$/.test(String(leg.expiry))?new Date(Number(leg.expiry)*1000).toLocaleDateString('en-IN'):leg.expiry)+'</b></div><div class="data-row"><span>OI / Volume</span><b>'+oi+' / '+volume+'</b></div><p class="hint">Underlying confirmation: '+escapeHtml(reason)+' · Selected contract bid/ask/LTP verified independently via FYERS Quotes API. Spread, liquidity, expiry and slippage can change outcomes.</p></article>';
    status.textContent='Candidate only · FYERS candles and option chain verified at '+new Date(optionResult.fetchedAt||Date.now()).toLocaleTimeString('en-IN')+'. Not a guaranteed signal; no order placed.';
    logEvent('Sureshot candidate built from verified OHLC zone and option-chain data.','info');
  }catch(error){
    cards.innerHTML='<article class="console-section"><div class="console-section-head"><h4>NO TRADE</h4><span class="signal-tone neutral">DATA / FILTER</span></div><p>'+escapeHtml(error.message||'Required verified data unavailable.')+'</p><p class="hint">No prices or signals were invented. Retry after confirming FYERS historical-data and option-chain access.</p></article>';
    status.textContent='No setup generated · '+(error.message||'Verified data unavailable.');
    chart.innerHTML='<div class="chart-empty">Supply/demand chart unavailable until verified candles are returned.</div>';
    logEvent('Sureshot withheld signal because verified data or setup conditions were unavailable.','warn');
  }
}
async function loadAdvancedScanner() {
  if(!['Breakout Scanner','Momentum Scanner','Zero-to-Hero'].includes(currentTab)) return;
  const status=document.querySelector('#advancedStatus'), table=document.querySelector('#advancedTable'), button=document.querySelector('#refreshAdvancedBtn');
  if(!status||!table) return;
  if(button) button.disabled=true;
  status.textContent='Requesting a fresh selected-universe quote snapshot from FYERS…';
  try {
    const response=await fetch(BACKEND_URL+'/api/market/movers',{headers:{Accept:'application/json'},cache:'no-store'});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true||!Array.isArray(result.data)) throw new Error(result.error||result.detail||'Verified snapshot unavailable.');
    if(result.marketSession!=='OPEN'){
      table.innerHTML='<div class="chart-empty">Market is closed. Last-known quotes are not used to create live scanner candidates or trade signals.</div>';
      status.textContent='Market closed · live breakout/momentum scan withheld. Refresh during NSE market hours.';
      return;
    }
    const requestedCount=Number(result.requestedSymbols);
    const receivedCount=Number(result.receivedSymbols);
    const failedCount=Array.isArray(result.failedSymbols)?result.failedSymbols.length:0;
    if(result.partial===true || !Number.isFinite(requestedCount) || !Number.isFinite(receivedCount) || requestedCount<1 || receivedCount!==requestedCount || failedCount>0){
      table.innerHTML='<div class="chart-empty"><b>NO TRADE — incomplete F&O universe.</b><p>FYERS returned only '+(Number.isFinite(receivedCount)?receivedCount:'an unknown number')+' of '+(Number.isFinite(requestedCount)?requestedCount:'an unknown number')+' requested symbols. '+(failedCount?' '+failedCount+' symbol entries are reported unavailable or failed.':'')+' Scanner candidates are withheld until full universe coverage is verified.</p></div>';
      status.textContent='Signal blocked · incomplete FYERS F&O coverage. Partial snapshots may inform research but cannot confirm scanner candidates.';
      logEvent(currentTab+' blocked because FYERS F&O quote coverage was incomplete.','warn');
      return;
    }
    const rows=result.data.filter(x=>{
      if(!x||!Number.isFinite(Number(x.changePct))||!Number.isFinite(Number(x.price))||Number(x.price)<=0) return false;
      if(x.priceStatus!=='LIVE_QUOTE'||!x.priceAsOf) return false;
      const age=Number(x.quoteAgeSeconds);
      const timestamp=Date.parse(x.priceAsOf);
      return Number.isFinite(age)&&age>=0&&age<=180&&Number.isFinite(timestamp)&&Date.now()-timestamp>=-30000&&Date.now()-timestamp<=180000;
    });
    if(rows.length!==requestedCount){
      table.innerHTML='<div class="chart-empty"><b>NO TRADE — incomplete fresh-quote coverage.</b><p>Only '+rows.length+' of '+requestedCount+' F&O symbols have fresh, exchange-timestamped quotes. Stale or timestamp-unverified symbols are not silently excluded to create a misleading shortlist; scanner candidates are withheld.</p></div>';
      status.textContent='Signal blocked · fresh verified quotes cover '+rows.length+' / '+requestedCount+' requested F&O symbols.';
      logEvent(currentTab+' blocked because one or more F&O quotes were stale or timestamp-unverified.','warn');
      return;
    }
    if(!rows.length){
      table.innerHTML='<div class="chart-empty">No fresh exchange-timestamped FYERS quotes. Scanner output is blocked until fresh quotes are available.</div>';
      status.textContent='No live scanner candidates · fresh quote timestamps are missing or stale.';
      return;
    }
    let sorted=rows.slice().sort((x,y)=>Number(y.changePct)-Number(x.changePct));
    if(currentTab==='Breakout Scanner') sorted=sorted.filter(x=>Number(x.changePct)>0).slice(0,8);
    else if(currentTab==='Momentum Scanner') sorted=sorted.sort((x,y)=>Math.abs(Number(y.changePct))-Math.abs(Number(x.changePct))).slice(0,20);
    else sorted=sorted.sort((x,y)=>Math.abs(Number(y.changePct))-Math.abs(Number(x.changePct))).slice(0,15);
    if(currentTab==='Breakout Scanner'&&sorted.length){
      status.textContent='Checking verified historical candles for the strongest positive movers…';
      const candleChecked=[];
      // Fetch sequentially to avoid bursting the FYERS historical API and triggering 429 cooldowns.
      for(const x of sorted){
        try{
          const cr=await fetch(BACKEND_URL+'/api/market/candles?'+new URLSearchParams({symbol:x.symbol,resolution:'5'}),{headers:{Accept:'application/json'},cache:'no-store'});
          const cj=await cr.json().catch(()=>({}));
          if(!cr.ok||cj.ok!==true||!Array.isArray(cj.data)){
            candleChecked.push({...x,pattern:'Verified candles unavailable; pattern not assessed.',candleVerified:false});
          }else{
            const candleError=validateOhlcCandles(cj.data,'5');
            if(candleError)candleChecked.push({...x,pattern:candleError+' Pattern not assessed.',candleVerified:false,breakoutConfirmed:false});
            else {
              const candles=cj.data;
              const last=candles[candles.length-1];
              const prior=candles.slice(Math.max(0,candles.length-21),candles.length-1);
              const priorHigh=prior.length?Math.max(...prior.map(row=>Number(row[2]))):Infinity;
              const lastCandleClosed=Number(last[0])*1000+5*60*1000<=Date.now();
              const breakoutConfirmed=lastCandleClosed&&Number(last[4])>priorHigh&&Number(last[4])>Number(last[1]);
              const breakoutReason=!lastCandleClosed?'Latest 5-minute candle is still forming; confirmation withheld.':breakoutConfirmed?'Confirmed closed 5-minute candle above prior '+prior.length+' candle highs.':'No confirmed breakout: latest closed candle did not clear prior candle highs with a bullish close.';
              candleChecked.push({...x,pattern:breakoutReason,candleVerified:true,breakoutConfirmed});
            }
          }
        }catch{
          candleChecked.push({...x,pattern:'Candle request failed; pattern not assessed.',candleVerified:false});
        }
        await new Promise(resolve=>setTimeout(resolve,350));
      }
      const verifiedBreakouts=candleChecked.filter(x=>x.candleVerified&&x.breakoutConfirmed).sort((a,b)=>Number(b.changePct)-Number(a.changePct)).slice(0,8);
      sorted=verifiedBreakouts;
    }
    table.innerHTML=sorted.length?'<table class="console-table"><thead><tr><th>Symbol</th><th>LTP</th><th>Change %</th><th>Research note</th></tr></thead><tbody>'+sorted.map(x=>'<tr><td><b>'+escapeHtml(x.symbol.replace(/^NSE:/,'').replace(/-EQ$/,''))+'</b></td><td>₹'+formatPrice(x.price)+'</td><td class="'+(x.changePct>=0?'positive-text':'negative-text')+'">'+(x.changePct>0?'+':'')+Number(x.changePct).toFixed(2)+'%</td><td>'+escapeHtml(currentTab==='Breakout Scanner'?(x.pattern||'No candle pattern assessed.'):currentTab==='Momentum Scanner'?'Ranked by absolute verified percentage change; volume/traded value unavailable in this quote response.':'High percentage movement only; option-chain liquidity and risk are not yet verified.')+'</td></tr>').join('')+'</tbody></table>':'<div class="chart-empty">No qualifying rows in this verified snapshot.</div>';
    status.textContent='Fresh exchange-timestamped FYERS snapshot '+new Date(result.fetchedAt||Date.now()).toLocaleTimeString('en-IN')+' · '+rows.length+' fresh symbols eligible. '+(currentTab==='Breakout Scanner'?'Only symbols with verified 5-minute candles and a bullish close above the prior 20-candle high are shown; this is a technical breakout screen, not an option entry signal.':currentTab==='Momentum Scanner'?'Ranked by percentage change only; volume/traded value is not verified here.':'Ranked by percentage change only; option liquidity and strike selection are not yet verified.');
    logEvent(currentTab+' refreshed from verified FYERS quotes.','info');
  } catch(error) {
    status.textContent=(error.message||'Snapshot unavailable.')+' No demo prices shown.';
    table.innerHTML='<div class="chart-empty">No verified FYERS data available.</div>';
    logEvent(currentTab+' request failed.','warn');
  } finally {if(button)button.disabled=false;}
}

function indicatorsMarkup() {
  return '<div class="movers-toolbar"><div><b>OHLC-based technical indicators</b><p>Calculated from verified FYERS 5-minute historical candles.</p></div><button class="primary" id="refreshIndicatorsBtn">Refresh indicators</button></div>' +
    '<div id="indicatorStatus" class="hint">Loading historical candles for both indices…</div>' +
    '<div class="table-wrap"><table class="console-table"><thead><tr><th>Metric</th><th>NIFTY 50</th><th>BANK NIFTY</th><th>Interpretation</th></tr></thead><tbody>' +
    '<tr><td><b>Latest candle close</b></td><td id="candle-close-0">—</td><td id="candle-close-1">—</td><td>Last returned OHLC close</td></tr>' +
    '<tr><td><b>EMA 20</b></td><td id="candle-ema20-0">—</td><td id="candle-ema20-1">—</td><td>Short-term trend reference</td></tr>' +
    '<tr><td><b>EMA 50</b></td><td id="candle-ema50-0">—</td><td id="candle-ema50-1">—</td><td>Medium-term trend reference</td></tr>' +
    '<tr><td><b>RSI 14</b></td><td id="candle-rsi-0">—</td><td id="candle-rsi-1">—</td><td>Momentum oscillator (Wilder smoothing)</td></tr>' +
    '<tr><td><b>ATR 14</b></td><td id="candle-atr-0">—</td><td id="candle-atr-1">—</td><td>Average true range / volatility</td></tr>' +
    '<tr><td><b>Last volume / 20-candle average</b></td><td id="candle-volume-0">—</td><td id="candle-volume-1">—</td><td>Volume expansion ratio where available</td></tr>' +
    '<tr><td><b>Trend structure</b></td><td id="candle-trend-0">—</td><td id="candle-trend-1">—</td><td>Close vs EMA20 vs EMA50</td></tr>' +
    '</tbody></table></div><p class="hint">These indicators use historical OHLC data, not tick samples. They are descriptive tools, not predictions or guaranteed trading signals. Values remain unavailable when FYERS data is missing.</p>';
}

function calculateCandleIndicators(rows) {
  const candles = (Array.isArray(rows) ? rows : []).filter(row => Array.isArray(row) && row.length >= 6 && row.slice(1, 6).every(v => Number.isFinite(Number(v)))).map(row => ({
    open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5])
  }));
  const closes = candles.map(row => row.close);
  const ema = period => {
    if (closes.length < period) return null;
    const alpha = 2 / (period + 1);
    let value = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) value = closes[i] * alpha + value * (1 - alpha);
    return value;
  };
  let rsi = null;
  if (closes.length >= 15) {
    const changes = closes.slice(1).map((value, i) => value - closes[i]);
    let gain = changes.slice(0, 14).reduce((sum, value) => sum + Math.max(0, value), 0) / 14;
    let loss = changes.slice(0, 14).reduce((sum, value) => sum + Math.max(0, -value), 0) / 14;
    for (let i = 14; i < changes.length; i++) {
      gain = (gain * 13 + Math.max(0, changes[i])) / 14;
      loss = (loss * 13 + Math.max(0, -changes[i])) / 14;
    }
    rsi = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  const trueRanges = [];
  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];
    const previousClose = i ? candles[i - 1].close : current.close;
    trueRanges.push(Math.max(current.high - current.low, Math.abs(current.high - previousClose), Math.abs(current.low - previousClose)));
  }
  let atr = null;
  if (trueRanges.length >= 14) {
    atr = trueRanges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
    for (let i = 14; i < trueRanges.length; i++) atr = (atr * 13 + trueRanges[i]) / 14;
  }
  const last = candles[candles.length - 1] || null;
  const ema20 = ema(20), ema50 = ema(50);
  const priorVolumes = candles.slice(-21, -1).map(row => row.volume).filter(v => Number.isFinite(v) && v > 0);
  const averageVolume = priorVolumes.length ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : null;
  const volumeRatio = last && averageVolume && last.volume > 0 ? last.volume / averageVolume : null;
  let trend = 'Insufficient candles';
  if (last && ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) trend = 'Bullish alignment';
    else if (last.close < ema20 && ema20 < ema50) trend = 'Bearish alignment';
    else trend = 'Mixed / range';
  }
  return { count: candles.length, last, ema20, ema50, rsi, atr, volumeRatio, trend };
}

async function loadTechnicalIndicators() {
  const status = document.querySelector('#indicatorStatus');
  if (!status) return;
  status.textContent = 'Requesting verified 5-minute OHLC candles from FYERS…';
  const targets = SYMBOLS.map((item, index) => ({ item, index }));
  try {
    const results = await Promise.all(targets.map(async target => {
      const params = new URLSearchParams({ symbol: target.item.symbol, resolution: '5' });
      const response = await fetch(BACKEND_URL + '/api/market/candles?' + params.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true || !Array.isArray(result.data)) throw new Error(result.error || result.detail || 'Verified candles unavailable.');
      const candleError = validateOhlcCandles(result.data, '5');
      if (candleError) throw new Error(candleError);
      return { ...target, result, indicators: calculateCandleIndicators(result.data) };
    }));
    results.forEach(({ index, result, indicators }) => {
      const put = (suffix, value) => {
        const el = document.getElementById('candle-' + suffix + '-' + index);
        if (el) el.textContent = value;
      };
      put('close', indicators.last ? '₹' + formatPrice(indicators.last.close) : '—');
      put('ema20', indicators.ema20 === null ? 'Need 20+ candles' : formatPrice(indicators.ema20));
      put('ema50', indicators.ema50 === null ? 'Need 50+ candles' : formatPrice(indicators.ema50));
      put('rsi', indicators.rsi === null ? 'Need 15+ candles' : indicators.rsi.toFixed(1));
      put('atr', indicators.atr === null ? 'Need 14+ candles' : formatPrice(indicators.atr));
      put('volume', indicators.volumeRatio === null ? 'Unavailable' : indicators.volumeRatio.toFixed(2) + '×');
      put('trend', indicators.trend);
      logEvent('OHLC indicators refreshed for ' + targetSymbolName(index) + ' (' + indicators.count + ' candles).', 'info');
    });
    status.textContent = 'Verified FYERS candles received for both indices · updated ' + new Date().toLocaleTimeString('en-IN') + '.';
  } catch (error) {
    status.textContent = (error.message || 'Historical indicators unavailable.') + ' No values have been fabricated.';
    logEvent('Historical technical indicator request failed.', 'warn');
  }
}

function targetSymbolName(index) {
  return index === 1 ? 'BANK NIFTY' : 'NIFTY 50';
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
  return '<div class="settings-grid"><article class="console-section"><h4>Secure connection</h4><p>FYERS credentials stay on the Render backend. Do not paste app secrets or access tokens into this page.</p><div class="data-row"><span>Backend URL</span><b>Render</b></div><code class="backend-url">' + BACKEND_URL + '</code><div class="button-row"><button class="primary" id="testBackendBtn">Test backend</button><button class="primary" id="connectFyersBtn">Connect FYERS</button><button class="secondary" id="testQuotesBtn">Refresh live quotes</button><button class="secondary" id="installPwaBtn">Install DhanPulse app</button></div><p class="hint">Install on desktop/laptop from the browser install icon, or on mobile use the browser menu → Install app / Add to Home Screen.</p></article><article class="console-section"><h4>Connection diagnostics</h4><div class="data-row"><span>Frontend</span><b class="positive-text">ONLINE</b></div><div class="data-row"><span>Backend health</span><b id="settingsBackend">CHECKING</b></div><div class="data-row"><span>Latest quotes</span><b id="settingsFeed">WAITING</b></div><div class="data-row"><span>Order placement</span><b class="warning-text">DISABLED</b></div><p class="hint">Backend health alone does not prove that FYERS authentication or live market data is connected.</p></article></div>';
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
    const chainCheck = validateOptionChainPayload(data);
    if (typeof chainCheck === 'string') throw new Error(chainCheck);
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
    const chain = chainCheck.chain;
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
    status.textContent = 'FYERS option-chain response received at ' + new Date(result.fetchedAt || Date.now()).toLocaleTimeString('en-IN') + '. ' + strikes.length + ' strikes shown. Response time alone does not prove exchange-quote freshness; selected contracts are checked separately before a Sureshot setup.';
    logEvent('FYERS option-chain data received for ' + symbolEl.value + '.', 'info');
  } catch (error) {
    status.textContent = (error.message || 'Could not load option chain.') + ' Use FYERS Settings to reconnect if authentication expired.';
    table.innerHTML = '<div class="chart-empty">No verified option-chain data available. No values have been fabricated.</div>';
    const callEl = document.querySelector('#ocCallOi'), putEl = document.querySelector('#ocPutOi'), pcrEl = document.querySelector('#ocPcr');
    if (callEl) callEl.textContent = '—';
    if (putEl) putEl.textContent = '—';
    if (pcrEl) pcrEl.textContent = '—';
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
  if (['Trade Journal','Capital Protection','Backtesting'].includes(tab)) {
    currentTab = tab;
    ['.welcome','.metrics','.grid'].forEach(selector => { const section=document.querySelector(selector); if(section) section.style.display='none'; });
    title.textContent=tab; panelTitle.textContent=descriptions[tab][0]; featureTitle.textContent=tab; featureDesc.textContent=descriptions[tab][1];
    nav.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
    const mainPanel=document.querySelector('#mainWorkspaceContent');
    if(mainPanel) mainPanel.innerHTML='<div class="main-view-heading"><span class="eyebrow">DHANPULSE WORKSPACE</span><h2>'+escapeHtml(tab)+'</h2><p>'+escapeHtml(descriptions[tab][1])+'</p></div><p class="hint">Use the dedicated '+escapeHtml(tab)+' panel below. No live order placement is available.</p>';
    featureContent.innerHTML='<article class="console-section"><div class="chart-empty">Loading dedicated '+escapeHtml(tab)+' tool…</div></article>';
    window.setTimeout(()=>{ if(currentTab!==tab)return; const hasPanel=featureContent.querySelector('#dpJournalForm, #dpRiskForm, #dpBtForm'); if(!hasPanel) featureContent.innerHTML='<article class="console-section"><h4>'+escapeHtml(tab)+' unavailable</h4><p class="hint">The dedicated tool did not initialize. Reload the page after the latest frontend is published. No simulated success is shown.</p></article>'; },1500);
    return;
  }
  currentTab = tab;
    ['.welcome','.metrics','.grid'].forEach(selector => { const section=document.querySelector(selector); if(section) section.style.display='none'; });
    title.textContent=tab; panelTitle.textContent=descriptions[tab][0]; featureTitle.textContent=tab; featureDesc.textContent=descriptions[tab][1];
    nav.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
    const mainPanel=document.querySelector('#mainWorkspaceContent');
    if(mainPanel) mainPanel.innerHTML='<div class="main-view-heading"><span class="eyebrow">DHANPULSE WORKSPACE</span><h2>'+escapeHtml(tab)+'</h2><p>'+escapeHtml(descriptions[tab][1])+'</p></div><p class="hint">Read-only and paper-trading tools. No live orders are available.</p>';
    if (tab === 'Trade Journal') {
      featureContent.innerHTML='<article class="console-section"><div class="console-section-head"><div><h4>Paper trade journal</h4><p>Stored in this browser only; it is not sent to FYERS.</p></div><span class="live-tag">PAPER ONLY</span></div><form id="dpJournalForm" class="option-controls"><label>Symbol<input id="dpJSymbol" maxlength="40" required placeholder="NIFTY / BANKNIFTY / stock"></label><label>Side<select id="dpJSide"><option>Long / CE</option><option>Short / PE</option></select></label><label>Entry price<input id="dpJEntry" type="number" min="0.01" step="any" required></label><label>Stop loss<input id="dpJStop" type="number" min="0.01" step="any" required></label><label>Target<input id="dpJTarget" type="number" min="0.01" step="any" required></label><label>Outcome<select id="dpJOutcome"><option value="Open">Open / not reviewed</option><option value="Win">Win</option><option value="Loss">Loss</option><option value="Breakeven">Breakeven</option></select></label><label>Emotion / note<input id="dpJNote" maxlength="240" placeholder="Calm, rushed, revenge urge…"></label><label><span>Rules followed?</span><select id="dpJRules"><option value="yes">Yes</option><option value="no">No</option><option value="partial">Partly</option></select></label><button class="primary" type="submit">Save paper trade</button></form><div id="dpJournalStatus" class="hint" role="status">No paper trade saved yet.</div><div id="dpJournalRows" class="table-wrap"></div><p class="hint">This is browser-local storage. Clearing browser site data may remove entries; export/backup is not currently provided.</p></article>';
      const form=document.querySelector('#dpJournalForm'), rows=document.querySelector('#dpJournalRows'), status=document.querySelector('#dpJournalStatus');
      const readJournal=()=>{try{const v=JSON.parse(localStorage.getItem('dhanpulse-paper-journal-v1')||'[]');return Array.isArray(v)?v.filter(x=>x&&typeof x==='object').slice(0,200):[];}catch{return [];}};
      const drawJournal=()=>{const data=readJournal();rows.innerHTML=data.length?'<table class="console-table"><thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Entry / SL / Target</th><th>Outcome</th><th>Rules</th><th>Note</th></tr></thead><tbody>'+data.map(x=>'<tr><td>'+escapeHtml(x.date||'')+'</td><td>'+escapeHtml(x.symbol||'')+'</td><td>'+escapeHtml(x.side||'')+'</td><td>'+[x.entry,x.stop,x.target].map(v=>escapeHtml(String(v))).join(' / ')+'</td><td>'+escapeHtml(x.outcome||'')+'</td><td>'+escapeHtml(x.rules||'')+'</td><td>'+escapeHtml(x.note||'')+'</td></tr>').join('')+'</tbody></table><button class="secondary" id="dpJournalClear">Clear local journal</button>':'<div class="chart-empty">No journal entries yet. Add a paper trade above.</div>';const clear=document.querySelector('#dpJournalClear');if(clear)clear.addEventListener('click',()=>{if(window.confirm('Clear all browser-local paper journal entries?')){localStorage.removeItem('dhanpulse-paper-journal-v1');drawJournal();status.textContent='Local journal cleared.';}});};
      form.addEventListener('submit',event=>{event.preventDefault();const entry=Number(document.querySelector('#dpJEntry').value),stop=Number(document.querySelector('#dpJStop').value),target=Number(document.querySelector('#dpJTarget').value),side=document.querySelector('#dpJSide').value;if(![entry,stop,target].every(Number.isFinite)||Math.min(entry,stop,target)<=0){status.textContent='Invalid prices; trade not saved.';return;}const long=side==='Long / CE';if((long&&(stop>=entry||target<=entry))||(!long&&(stop<=entry||target>=entry))){status.textContent='Price direction is inconsistent with the selected side; trade not saved.';return;}const risk=Math.abs(entry-stop),rr=Math.abs(target-entry)/risk;if(!Number.isFinite(rr)||rr<2){status.textContent='Planned reward-to-risk is below 1:2; saved only after you correct the plan.';return;}const data=readJournal();data.unshift({date:new Date().toISOString(),symbol:document.querySelector('#dpJSymbol').value.trim().slice(0,40),side,entry,stop,target,rr:Number(rr.toFixed(2)),outcome:document.querySelector('#dpJOutcome').value,rules:document.querySelector('#dpJRules').value,note:document.querySelector('#dpJNote').value.trim().slice(0,240)});try{localStorage.setItem('dhanpulse-paper-journal-v1',JSON.stringify(data.slice(0,200)));status.textContent='Paper trade saved locally. Planned RR: 1:'+rr.toFixed(2)+'.';drawJournal();form.reset();}catch{status.textContent='Browser storage unavailable; trade was not saved.';}});
      drawJournal();
    } else if (tab === 'Capital Protection') {
      featureContent.innerHTML='<article class="console-section"><div class="console-section-head"><div><h4>Position risk calculator</h4><p>Planning math only. Share quantity is not an option-lot recommendation.</p></div><span class="live-tag">NO ORDERS</span></div><form id="dpRiskForm" class="option-controls"><label>Capital ₹<input id="dpRCapital" type="number" min="1" step="any" value="3000" required></label><label>Risk per trade %<input id="dpRRisk" type="number" min="0.1" max="2" step="0.1" value="1" required></label><label>Direction<select id="dpRSide"><option value="long">Long / CE</option><option value="short">Short / PE</option></select></label><label>Entry price ₹<input id="dpREntry" type="number" min="0.01" step="any" required></label><label>Stop loss ₹<input id="dpRStop" type="number" min="0.01" step="any" required></label><label>Target ₹<input id="dpRTarget" type="number" min="0.01" step="any" required></label><button class="primary" type="submit">Calculate safe size</button></form><div id="dpRiskResult" class="hint" role="status">Enter a valid plan to calculate maximum quantity and planned reward-to-risk.</div><p class="hint">Assumes linear price movement and excludes brokerage, slippage, taxes, lot size, liquidity and gap risk. A stop loss cannot guarantee the loss limit.</p></article>';
      const form=document.querySelector('#dpRiskForm'),out=document.querySelector('#dpRiskResult');
      form.addEventListener('submit',event=>{event.preventDefault();const capital=Number(document.querySelector('#dpRCapital').value),pct=Number(document.querySelector('#dpRRisk').value),entry=Number(document.querySelector('#dpREntry').value),stop=Number(document.querySelector('#dpRStop').value),target=Number(document.querySelector('#dpRTarget').value),side=document.querySelector('#dpRSide').value;const long=side==='long';if(![capital,pct,entry,stop,target].every(Number.isFinite)||capital<=0||pct<=0||pct>2||Math.min(entry,stop,target)<=0||(long&&(stop>=entry||target<=entry))||(!long&&(stop<=entry||target>=entry))){out.textContent='Invalid plan or inconsistent stop/target direction. No position size calculated.';return;}const riskPerUnit=Math.abs(entry-stop),riskBudget=capital*pct/100,qty=Math.floor(riskBudget/riskPerUnit),rewardPerUnit=Math.abs(target-entry),rr=rewardPerUnit/riskPerUnit,plannedLoss=qty*riskPerUnit,plannedReward=qty*rewardPerUnit,capitalUse=qty*entry;out.innerHTML='<div class="statusrow"><span>Maximum whole-share quantity</span><b>'+qty+'</b></div><div class="statusrow"><span>Risk budget</span><b>₹'+riskBudget.toFixed(2)+'</b></div><div class="statusrow"><span>Planned loss at stop</span><b>₹'+plannedLoss.toFixed(2)+'</b></div><div class="statusrow"><span>Planned reward</span><b>₹'+plannedReward.toFixed(2)+'</b></div><div class="statusrow"><span>Capital needed (before costs)</span><b>₹'+capitalUse.toFixed(2)+'</b></div><div class="statusrow"><span>Planned reward:risk</span><b>1:'+rr.toFixed(2)+'</b></div><p class="hint">'+(qty<1?'NO TRADE: one unit exceeds the risk budget.':capitalUse>capital?'NO TRADE: estimated capital required exceeds capital available.':rr<2?'NO TRADE: planned reward-to-risk is below 1:2.':'Risk filters pass mathematically; this is not a market signal or trade recommendation.')+'</p>';});
    } else {
      featureContent.innerHTML='<article class="console-section"><div class="console-section-head"><div><h4>Historical SMA crossover backtest</h4><p>Uses returned FYERS historical OHLC only; results are illustrative, not forecasts.</p></div><span class="live-tag">SIMULATION ONLY</span></div><div class="option-controls"><label>Symbol<select id="dpBtSymbol"><option value="NSE:NIFTY50-INDEX">NIFTY 50</option><option value="NSE:NIFTYBANK-INDEX">BANK NIFTY</option></select></label><label>Resolution<select id="dpBtResolution"><option value="D">Daily</option><option value="60">60 min</option><option value="15">15 min</option><option value="5" selected>5 min</option></select></label><button class="primary" id="dpBtRun">Run historical backtest</button></div><div id="dpBtStatus" class="hint" role="status">No backtest run. FYERS authentication is required.</div><div id="dpBtResult"></div><p class="hint">Rule: long-only SMA(5) above SMA(20) enters at the next bar close; crossover below exits at the next bar close. No fees, slippage, spreads, dividends or option-premium modeling; not suitable for direct trading.</p></article>';
      document.querySelector('#dpBtRun').addEventListener('click',async()=>{const status=document.querySelector('#dpBtStatus'),out=document.querySelector('#dpBtResult'),symbol=document.querySelector('#dpBtSymbol').value,resolution=document.querySelector('#dpBtResolution').value;status.textContent='Requesting authenticated FYERS historical candles…';out.innerHTML='';const now=new Date();const to=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);const fromDate=new Date(now.getTime()-(resolution==='D'?300:30)*86400000);const from=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(fromDate);try{const qs=new URLSearchParams({symbol,resolution,from,to});const response=await fetch(BACKEND_URL+'/api/market/candles?'+qs.toString(),{headers:{Accept:'application/json'},cache:'no-store'});const payload=await response.json().catch(()=>({}));if(!response.ok||payload.ok!==true||!Array.isArray(payload.data)||payload.data.length<25)throw new Error(payload.error||'At least 25 verified historical candles are required.');const bars=payload.data;let prev=-Infinity;for(const row of bars){if(!Array.isArray(row)||row.length<6||!row.slice(0,6).every(v=>Number.isFinite(Number(v))))throw new Error('Incomplete or invalid OHLC row; backtest blocked.');const [t,o,h,l,c,v]=row.map(Number);if(t<=prev||Math.min(o,h,l,c)<=0||h<Math.max(o,c)||l>Math.min(o,c)||h<l||v<0)throw new Error('OHLC validation failed; backtest blocked.');prev=t;}let position=null,trades=[],equity=1;for(let i=20;i<bars.length-1;i++){const closes=bars.slice(0,i+1).map(r=>Number(r[4]));const sma5=closes.slice(-5).reduce((x,y)=>x+y,0)/5;const sma20=closes.slice(-20).reduce((x,y)=>x+y,0)/20;const prev5=closes.slice(-6,-1).reduce((x,y)=>x+y,0)/5;const prev20=closes.slice(-21,-1).reduce((x,y)=>x+y,0)/20;const nextClose=Number(bars[i+1][4]);if(!position&&prev5<=prev20&&sma5>sma20)position={entry:nextClose,index:i+1};else if(position&&prev5>=prev20&&sma5<sma20){const ret=nextClose/position.entry-1;equity*=1+ret;trades.push({ret,entry:position.entry,exit:nextClose});position=null;}}if(position){const last=Number(bars[bars.length-1][4]),ret=last/position.entry-1;equity*=1+ret;trades.push({ret,entry:position.entry,exit:last});}if(!trades.length)throw new Error('No completed SMA crossover trades in this sample; no performance conclusion available.');const wins=trades.filter(t=>t.ret>0).length,winRate=wins/trades.length*100,avg=trades.reduce((sum,t)=>sum+t.ret,0)/trades.length*100;out.innerHTML='<div class="statusrow"><span>Verified candles</span><b>'+bars.length+'</b></div><div class="statusrow"><span>Closed / marked trades</span><b>'+trades.length+'</b></div><div class="statusrow"><span>Winning trades</span><b>'+wins+' ('+winRate.toFixed(1)+'%)</b></div><div class="statusrow"><span>Compounded return before costs</span><b>' + ((equity-1)*100).toFixed(2)+'%</b></div><div class="statusrow"><span>Average trade return</span><b>'+avg.toFixed(2)+'%</b></div><p class="hint">Backtest uses historical close prices and a simplified fill assumption. Results can change materially after costs and realistic execution assumptions.</p>';status.textContent='Backtest completed using authenticated FYERS historical candles fetched at '+new Date(payload.fetchedAt||Date.now()).toLocaleString('en-IN')+'.';}catch(error){status.textContent=(error.message||'Backtest unavailable.')+' No synthetic candles or results were substituted.';out.innerHTML='<div class="chart-empty">Backtest blocked until verified historical candles are available.</div>'; }});
    }
    return;
  }
  currentTab = tab;
    ['.welcome','.metrics','.grid'].forEach(selector => { const section=document.querySelector(selector); if(section) section.style.display='none'; });
    title.textContent=tab; panelTitle.textContent=descriptions[tab][0]; featureTitle.textContent=tab; featureDesc.textContent=descriptions[tab][1];
    nav.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
    const mainPanel=document.querySelector('#mainWorkspaceContent');
    if(mainPanel) mainPanel.innerHTML='<div class="main-view-heading"><span class="eyebrow">DHANPULSE WORKSPACE</span><h2>'+escapeHtml(tab)+'</h2><p>'+escapeHtml(descriptions[tab][1])+'</p></div><p class="hint">Use the dedicated '+escapeHtml(tab)+' panel below. No live order placement is available.</p>';
    featureContent.innerHTML='<article class="console-section"><div class="chart-empty">Loading dedicated '+escapeHtml(tab)+' tool…</div></article>';
    window.setTimeout(()=>{ if(currentTab!==tab)return; const hasPanel=featureContent.querySelector('#dpJournalForm, #dpRiskForm, #dpBtForm'); if(!hasPanel) featureContent.innerHTML='<article class="console-section"><h4>'+escapeHtml(tab)+' unavailable</h4><p class="hint">The dedicated tool did not initialize. Reload the page after the latest frontend is published. No simulated success is shown.</p></article>'; },1500);
    return;
  }
  currentTab = tab;
  const dashboardMode = tab === 'Dashboard';
  ['.welcome', '.metrics', '.grid'].forEach(selector => {
    const section = document.querySelector(selector);
    if (section) section.style.display = dashboardMode ? '' : 'none';
  });
  title.textContent = tab;
  panelTitle.textContent = descriptions[tab][0];
  featureTitle.textContent = tab === 'Dashboard' ? 'Live console' : tab;
  featureDesc.textContent = descriptions[tab][1];
  nav.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  const mainPanel = document.querySelector('#mainWorkspaceContent');
  if (mainPanel) {
    const symbol = tab === 'BANKNIFTY' ? SYMBOLS[1].symbol : SYMBOLS[0].symbol;
    const showsOhlc = tab === 'Charts & Patterns';
    mainPanel.innerHTML = '<div class="main-view-heading"><span class="eyebrow">DHANPULSE WORKSPACE</span><h2>' + escapeHtml(tab) + '</h2><p>' + escapeHtml(descriptions[tab][1]) + '</p></div>' + (showsOhlc ? '<div class="main-chart-wrap"><div class="main-chart-title"><span>' + escapeHtml(tab === 'BANKNIFTY' ? 'BANK NIFTY' : 'NIFTY 50') + ' · HISTORICAL OHLC</span><span class="tag">FYERS SOURCE</span></div><div id="mainTabChart"><div class="chart-empty">Load verified historical candles to display OHLC candlesticks.</div></div></div><p class="main-view-note" id="mainViewNote">No candlestick values appear until a valid FYERS historical OHLC response is received.</p>' : '') + '<button class="primary" id="mainPanelAction">' + (tab === 'FYERS Settings' ? 'Connect FYERS' : tab === 'Charts & Patterns' ? 'Load historical candles' : tab === 'Technical Indicators' ? 'Refresh indicators' : 'Refresh live data') + '</button>';
    const action = document.querySelector('#mainPanelAction');
    if (action) action.addEventListener('click', () => {
      if (currentTab === 'FYERS Settings') startFyersLogin();
      else if (currentTab === 'Charts & Patterns') loadCandles();
      else if (currentTab === 'Technical Indicators') loadTechnicalIndicators();
      else if (['Breakout Scanner','Momentum Scanner','Zero-to-Hero'].includes(currentTab)) loadAdvancedScanner();
      else if (currentTab === 'Gainers & Losers') loadMovers();
      else if (currentTab === 'Option Chain') loadOptionChain();
      else fetchLiveQuotes();
    });
  }
  if (tab === 'Dashboard') featureContent.innerHTML = dashboardMarkup();
  else if (tab === 'NIFTY') featureContent.innerHTML = focusedQuoteMarkup(SYMBOLS[0].symbol);
  else if (tab === 'BANKNIFTY') featureContent.innerHTML = focusedQuoteMarkup(SYMBOLS[1].symbol);
  else if (tab === 'Watchlist') featureContent.innerHTML = watchlistMarkup();
  else if (tab === 'Stock Explorer') featureContent.innerHTML = stockExplorerMarkup();
  else if (tab === 'Market Activity') featureContent.innerHTML = marketActivityMarkup();
  else if (['Sureshot CE/PE','Breakout Scanner','Momentum Scanner','Zero-to-Hero','FII/DII Flow','Charts & Patterns'].includes(tab)) featureContent.innerHTML = advancedScannerMarkup(tab);
  else if (tab === 'Gainers & Losers') featureContent.innerHTML = moversMarkup();
  else if (tab === 'Option Chain') featureContent.innerHTML = optionChainMarkup();
  else if (tab === 'Technical Indicators') featureContent.innerHTML = indicatorsMarkup();
  else if (tab === 'AI Signals') featureContent.innerHTML = signalsMarkup();
  else if (tab === 'Holdings') featureContent.innerHTML = holdingsMarkup();
  else if (tab === 'Alerts') featureContent.innerHTML = alertsMarkup();
  else if (tab === 'FYERS Settings') featureContent.innerHTML = settingsMarkup();
  else featureContent.innerHTML = '<div id="logList" class="log-list"></div>';
  bindTabActions();
  updateDynamicPanel();
  if (tab === 'Market Activity') loadMarketActivity();
  if (tab === 'Technical Indicators') loadTechnicalIndicators();
  if (tab === 'Gainers & Losers') loadMovers();
  if (tab === 'Sureshot CE/PE') loadSureshotSetup();
  if (['Breakout Scanner','Momentum Scanner','Zero-to-Hero'].includes(tab)) loadAdvancedScanner();
  if (tab === 'Charts & Patterns') loadCandles();
  if (tab === 'Option Chain') loadOptionChain();
  if (tab === 'Holdings') loadPortfolio();
  if (tab === 'Logs') renderLogs();
}

function bindTabActions() {
  featureContent.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => render(button.dataset.jump)));
  const stockSearch=document.querySelector('#stockSearch');
  const stockCategory=document.querySelector('#stockCategory');
  if(stockSearch) stockSearch.addEventListener('input',renderStockExplorerResults);
  if(stockCategory) stockCategory.addEventListener('change',renderStockExplorerResults);
  if(currentTab==='Stock Explorer') {
    renderStockExplorerResults();
    loadStockExplorerQuotes();
  }
  if(currentTab==='Watchlist') {
    renderWatchlistTable();
    loadWatchlistQuotes();
  }
  const addWatchlistBtn=document.querySelector('#addWatchlistSymbolBtn');
  if(addWatchlistBtn)addWatchlistBtn.addEventListener('click',()=>{
    const select=document.querySelector('#watchlistSymbolSelect'),status=document.querySelector('#watchlistStatus');
    const symbol=select?select.value:'';
    if(!symbol){if(status)status.textContent='Choose a supported equity symbol first.';return;}
    if(watchlistSymbols.includes(symbol)){if(status)status.textContent='That symbol is already in your watchlist.';return;}
    if(watchlistSymbols.length>=30){if(status)status.textContent='Watchlist limit is 30 symbols. Remove one before adding another.';return;}
    watchlistSymbols.push(symbol);saveWatchlistSymbols();renderWatchlistTable();
    if(status)status.textContent='Added '+symbol+' to your browser-local watchlist.';
  });
  const refreshWatchlistBtn=document.querySelector('#refreshWatchlistBtn');
  if(refreshWatchlistBtn)refreshWatchlistBtn.addEventListener('click',loadWatchlistQuotes);
  const refreshStockQuotesBtn=document.querySelector('#refreshStockQuotesBtn');
  if(refreshStockQuotesBtn)refreshStockQuotesBtn.addEventListener('click',loadStockExplorerQuotes);
  const dashCandles=document.querySelector('#dashboardCandlesBtn');
  if(dashCandles) dashCandles.addEventListener('click',loadDashboardCandles);
  const dashSymbol=document.querySelector('#dashboardCandleSymbol');
  const dashResolution=document.querySelector('#dashboardCandleResolution');
  if(dashSymbol) dashSymbol.addEventListener('change',()=>{const st=document.querySelector('#dashboardCandleStatus');if(st)st.textContent='Selection changed. Load candles to refresh the chart.';});
  if(currentTab==='Dashboard') loadDashboardCandles();
  const test = document.querySelector('#testBackendBtn');
  if (test) test.addEventListener('click', testBackend);
  const connect = document.querySelector('#connectFyersBtn');
  if (connect) connect.addEventListener('click', startFyersLogin);
  const quotes = document.querySelector('#testQuotesBtn');
  if (quotes) quotes.addEventListener('click', fetchLiveQuotes);
  const installButton = document.querySelector('#installPwaBtn');
  if (installButton) installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      showMessage('If the browser does not show an install prompt, open its menu and choose Install app or Add to Home Screen.');
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    showMessage('If installation was accepted, DhanPulse is available from your device app launcher.');
  });
  const setupRefresh=document.querySelector('#refreshSetupBtn');
  if(currentTab==='Sureshot CE/PE') loadSureshotStockUniverse();
  if(setupRefresh) setupRefresh.addEventListener('click',loadSureshotSetup);
  const setupSymbol=document.querySelector('#setupSymbol');
  if(setupSymbol) setupSymbol.addEventListener('change',loadSureshotSetup);
  const advancedRefresh=document.querySelector('#refreshAdvancedBtn');
  if(advancedRefresh) advancedRefresh.addEventListener('click',loadAdvancedScanner);
  const loadCandlesBtn=document.querySelector('#loadCandlesBtn');
  if(loadCandlesBtn) loadCandlesBtn.addEventListener('click',loadCandles);
  const refreshMarketActivity = document.querySelector('#refreshMarketActivityBtn');
  if (refreshMarketActivity) refreshMarketActivity.addEventListener('click', loadMarketActivity);
  const refreshIndicators = document.querySelector('#refreshIndicatorsBtn');
  if (refreshIndicators) refreshIndicators.addEventListener('click', loadTechnicalIndicators);
  const refreshMovers = document.querySelector('#refreshMoversBtn');
  if (refreshMovers) refreshMovers.addEventListener('click', loadMovers);
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

function updateQuoteCards(quotes, fetchedAt, source, streamConnected) {
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
          receivedAt: Number.isFinite(Number(item.v.tt)) && Number(item.v.tt) > 0
            ? (Number(item.v.tt) > 1e12 ? Number(item.v.tt) : Number(item.v.tt) * 1000)
            : (source === 'websocket' && Number.isFinite(Date.parse(fetchedAt)) ? Date.parse(fetchedAt) : 0),
          sourceTime: Number.isFinite(Number(item.v.tt)) && Number(item.v.tt) > 0
            ? new Date(Number(item.v.tt) > 1e12 ? Number(item.v.tt) : Number(item.v.tt) * 1000).toISOString()
            : (source === 'websocket' ? fetchedAt || null : null),
          source: source || 'unknown',
          streamConnected: streamConnected === true
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
    // Only fresh ticks from a connected WebSocket may feed indicators or trigger alerts.
    // Last-known and reconnecting snapshots are display-only, even if their timestamps look recent.
    const verifiedLiveTick = source === 'websocket' && streamConnected === true &&
      Number.isFinite(next.receivedAt) && next.receivedAt > 0 &&
      Date.now() - next.receivedAt >= 0 && Date.now() - next.receivedAt <= 15000;
    if (verifiedLiveTick) {
      if (!last || last.price !== next.price) {
        history.push({ price: next.price, time: next.receivedAt });
        if (history.length > 180) history.splice(0, history.length - 180);
      }
      if (old && old.price !== next.price) checkAlerts(item.symbol, next.price);
    }
  });
  const metrics = document.querySelectorAll('.metrics .metric');
  SYMBOLS.forEach((item, index) => {
    const metric = metrics[index + 1];
    const quote = latestQuotes[item.symbol];
    if (!metric || !quote) return;
    const valueEl = metric.querySelector('strong');
    const detailEl = metric.querySelector('small');
    if (valueEl) { valueEl.textContent = formatPrice(quote.price); valueEl.classList.remove('muted'); }
    if (detailEl) {
      const change = quote.change;
      const pct = quote.changePct;
      detailEl.textContent = !isRegularMarketSession()
        ? 'Last received · market closed'
        : change === null ? 'FYERS live quote received' : (change > 0 ? '+' : '') + change.toFixed(2) + (pct === null ? '' : ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)');
    }
  });
  if (source === 'last-known') {
    setStatus(isRegularMarketSession() ? 'LIVE DATA STALE · LAST KNOWN' : 'MARKET CLOSED · LAST KNOWN LTP');
    setConnection('Last-known FYERS prices · fresh ticks unavailable', true);
  } else if (source === 'websocket-recent' || streamConnected === false) {
    setStatus('LIVE DATA STALE');
    setConnection('Stream reconnecting · last verified prices', true);
  } else {
    setStatus('FYERS QUOTES RECEIVED');
    setConnection('FYERS Connected', false);
  }
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

function candleSvg(candles) {
  if(!Array.isArray(candles)||candles.length<2) return '<div class="chart-empty">At least two verified candles are needed.</div>';
  const rows=candles.slice(-70), highs=rows.map(x=>Number(x[2])), lows=rows.map(x=>Number(x[3]));
  const hi=Math.max(...highs), lo=Math.min(...lows), span=hi-lo||1, width=720, height=260, pad=12, slot=(width-pad*2)/rows.length;
  const y=v=>height-pad-((v-lo)/span)*(height-pad*2);
  return '<svg class="live-chart candle-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Verified FYERS historical OHLC candles">'+rows.map((x,i)=>{const open=Number(x[1]),high=Number(x[2]),low=Number(x[3]),close=Number(x[4]),cx=pad+i*slot+slot/2,up=close>=open,color=up?'#63e6d0':'#ff8d9a',bodyY=Math.min(y(open),y(close)),bodyH=Math.max(1,Math.abs(y(open)-y(close)));return '<line x1="'+cx.toFixed(2)+'" y1="'+y(high).toFixed(2)+'" x2="'+cx.toFixed(2)+'" y2="'+y(low).toFixed(2)+'" stroke="'+color+'" stroke-width="1.2"/><rect x="'+(cx-slot*0.28).toFixed(2)+'" y="'+bodyY.toFixed(2)+'" width="'+Math.max(2,slot*0.56).toFixed(2)+'" height="'+bodyH.toFixed(2)+'" fill="'+color+'" rx="1"/>';}).join('')+'<text x="12" y="13" class="chart-label">HIGH '+formatPrice(hi)+'</text><text x="12" y="'+(height-3)+'" class="chart-label">LOW '+formatPrice(lo)+'</text></svg>';
}
function summarizeCandles(candles) {
  if(!Array.isArray(candles)||candles.length<8) return 'At least 8 verified OHLC candles are needed for a cautious pattern scan.';
  const rows=candles.slice(-40);
  const n=rows.length;
  const last=rows[n-1],prev=rows[n-2],close=Number(last[4]);
  const highs=rows.map(x=>Number(x[2])),lows=rows.map(x=>Number(x[3]));
  const tolerance=(Math.max(...highs)-Math.min(...lows))*0.025;
  const pivots=[];
  for(let i=2;i<n-2;i++){
    const high=highs[i],low=lows[i];
    if(high>highs[i-1]&&high>=highs[i-2]&&high>highs[i+1]&&high>=highs[i+2])pivots.push({i,type:'H',value:high});
    if(low<lows[i-1]&&low<=lows[i-2]&&low<lows[i+1]&&low<=lows[i+2])pivots.push({i,type:'L',value:low});
  }
  const tops=pivots.filter(x=>x.type==='H'), bottoms=pivots.filter(x=>x.type==='L');
  let pattern='No clear common pattern detected in the recent verified candles.';
  const t1=tops.at(-1),t2=tops.at(-2),b1=bottoms.at(-1),b2=bottoms.at(-2);
  if(t1&&t2&&t1.i-t2.i>=3&&Math.abs(t1.value-t2.value)<=tolerance&&close<Math.min(...rows.slice(t2.i,t1.i+1).map(x=>Number(x[3])))){
    pattern='Possible double-top with neckline break candidate; wait for retest/volume confirmation.';
  } else if(b1&&b2&&b1.i-b2.i>=3&&Math.abs(b1.value-b2.value)<=tolerance&&close>Math.max(...rows.slice(b2.i,b1.i+1).map(x=>Number(x[2])))){
    pattern='Possible double-bottom with neckline break candidate; wait for retest/volume confirmation.';
  } else {
    const recent=rows.slice(-6),rh=recent.map(x=>Number(x[2])),rl=recent.map(x=>Number(x[3]));
    const higherHighs=rh.slice(1).every((v,i)=>v>=rh[i]),higherLows=rl.slice(1).every((v,i)=>v>=rl[i]);
    const lowerHighs=rh.slice(1).every((v,i)=>v<=rh[i]),lowerLows=rl.slice(1).every((v,i)=>v<=rl[i]);
    const highRange=Math.max(...rh)-Math.min(...rh),lowRange=Math.max(...rl)-Math.min(...rl);
    if(close>Number(prev[2]))pattern='Bullish range breakout candidate: latest close above previous candle high.';
    else if(close<Number(prev[3]))pattern='Bearish range breakdown candidate: latest close below previous candle low.';
    else if(higherHighs&&higherLows)pattern='Uptrend continuation candidate: recent highs and lows are rising.';
    else if(lowerHighs&&lowerLows)pattern='Downtrend continuation candidate: recent highs and lows are falling.';
    else if(highRange>0&&lowRange>0&&highRange<lowRange*0.75)pattern='Possible contracting triangle / volatility squeeze; breakout not confirmed.';
    else if(highRange>0&&lowRange>0&&lowRange<highRange*0.75)pattern='Possible rising-range compression; direction requires a confirmed break.';
  }
  return pattern+' Latest verified OHLC: O '+formatPrice(last[1])+' · H '+formatPrice(last[2])+' · L '+formatPrice(last[3])+' · C '+formatPrice(close)+'. Patterns are heuristic candidates, not trading guarantees.';
}
async function loadCandles() {
  const se=document.querySelector('#patternSymbol'),re=document.querySelector('#patternResolution'),status=document.querySelector('#patternStatus'),chart=document.querySelector('#patternChart'),summary=document.querySelector('#patternSummary'),table=document.querySelector('#candleTable');
  if(!se||!re||!status||!chart||!summary||!table)return;
  status.textContent='Requesting verified historical OHLC candles from FYERS…';chart.innerHTML='<div class="chart-empty">Loading candles…</div>';table.innerHTML='';
  try{
    const params=new URLSearchParams({symbol:se.value,resolution:re.value});
    const response=await fetch(BACKEND_URL+'/api/market/candles?'+params.toString(),{headers:{Accept:'application/json'},cache:'no-store'});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true||!Array.isArray(result.data))throw new Error(result.error||result.detail||'Historical candles unavailable.');
    const rows=result.data;
    const candleError=validateOhlcCandles(rows,re.value);
    if(candleError)throw new Error(candleError);
    chart.innerHTML=candleSvg(rows);summary.textContent=summarizeCandles(rows);const mainChart=document.querySelector('#mainTabChart');if(mainChart&&currentTab==='Charts & Patterns')mainChart.innerHTML=candleSvg(rows);const mainNote=document.querySelector('#mainViewNote');if(mainNote&&currentTab==='Charts & Patterns')mainNote.textContent='Historical OHLC candles returned by FYERS. '+rows.length+' candles loaded; chart is based on those candles.';
    table.innerHTML=rows.length?'<table class="console-table"><thead><tr><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></tr></thead><tbody>'+rows.slice(-12).reverse().map(row=>'<tr><td>'+escapeHtml(new Date(Number(row[0])*1000).toLocaleString('en-IN'))+'</td>'+row.slice(1,6).map((v,i)=>'<td>'+displayNumber(v,i===4?0:2)+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'<div class="chart-empty">FYERS returned no candles for this range.</div>';
    status.textContent='Verified FYERS history response · '+rows.length+' candles · '+re.value+' interval · '+new Date(result.fetchedAt||Date.now()).toLocaleTimeString('en-IN');
    logEvent('Historical candles loaded for '+se.value+' ('+rows.length+').','info');
  }catch(error){status.textContent=(error.message||'Historical candles unavailable.')+' No chart values were fabricated.';chart.innerHTML='<div class="chart-empty">Verified candles unavailable.</div>';summary.textContent='Pattern analysis withheld until verified OHLC data is available.';const mainChart=document.querySelector('#mainTabChart');if(mainChart&&currentTab==='Charts & Patterns')mainChart.innerHTML='<div class="chart-empty">Historical chart unavailable until FYERS returns verified candles.</div>';const mainNote=document.querySelector('#mainViewNote');if(mainNote&&currentTab==='Charts & Patterns')mainNote.textContent='No candle values were fabricated. Check FYERS connection and historical-data access.';table.innerHTML='';logEvent('Historical candle request failed.','warn');}
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
  const mainTabChart = document.querySelector('#mainTabChart');
  if (mainTabChart && !mainTabChart.querySelector('.candle-chart') && currentTab !== 'Charts & Patterns') {
    mainTabChart.innerHTML = '<div class="chart-empty">Historical OHLC candles have not been loaded for this workspace.</div>';
  }
  const dashboardChart = document.querySelector('#dashboardChart');
  if (dashboardChart && !dashboardChart.querySelector('.candle-chart')) dashboardChart.innerHTML = '<div class="chart-empty">Load verified historical candles to display the candlestick chart.</div>';
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
  if (dashBackend) dashBackend.textContent = backendHealthState;
  const dashFeed = document.querySelector('#dashFeed');
  if (dashFeed) dashFeed.textContent = SYMBOLS.every(item => hasFreshLiveQuote(quoteFor(item.symbol))) ? 'LIVE' : (isRegularMarketSession() ? 'WAITING' : 'MARKET CLOSED / LAST KNOWN');
  const settingsBackend = document.querySelector('#settingsBackend');
  if (settingsBackend) settingsBackend.textContent = backendHealthState;
  const settingsFeed = document.querySelector('#settingsFeed');
  if (settingsFeed) settingsFeed.textContent = SYMBOLS.every(item => hasFreshLiveQuote(quoteFor(item.symbol))) ? 'LIVE' : (isRegularMarketSession() ? 'WAITING' : 'MARKET CLOSED / LAST KNOWN');
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
    try {
      const statusResponse = await fetch(BACKEND_URL + '/api/status', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const status = await statusResponse.json().catch(() => ({}));
      if (statusResponse.ok) {
        setFyersStatus(status.fyers === 'connected' ? 'CONNECTED' : 'NOT CONNECTED');
        if (status.liveData === 'streaming') setStatus('FYERS QUOTES RECEIVED');
      } else {
        setFyersStatus('STATUS UNKNOWN');
      }
    } catch {
      setFyersStatus('STATUS UNKNOWN');
    }
    logEvent('Backend health check succeeded.', 'info');
    showMessage('Backend is online. FYERS authentication and live quotes are checked separately.');
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
      const retrySeconds = Number(data.retryAfterSeconds) || 30;
      quotePollDelay = Math.min(Math.max((retrySeconds + 2) * 1000, 15000), QUOTE_POLL_MAX_MS);
      setStatus('FYERS RATE LIMIT — WAITING');
      showMessage('FYERS rate limit is active. The dashboard is backing off and will not force REST quote polling.', true);
      return;
    }
    if (!response.ok || data.ok !== true || !Array.isArray(data.data)) {
      if (response.status === 503) {
        // A last-known snapshot is display-only; stale values never enable signals.
        try {
          const lastResponse = await fetch(BACKEND_URL + '/api/market/last-known-quotes', { headers: { Accept: 'application/json' }, cache: 'no-store' });
          const lastData = await lastResponse.json().catch(() => ({}));
          if (lastResponse.ok && lastData.ok === true && lastData.source === 'last-known' && Array.isArray(lastData.data) &&
              updateQuoteCards(lastData.data, lastData.fetchedAt, 'last-known', false)) {
            quotePollDelay = 15000;
            setStatus(lastData.marketOpen ? 'LIVE DATA STALE · LAST KNOWN' : 'MARKET CLOSED · LAST KNOWN LTP');
            showMessage('Showing last-known FYERS index prices from ' + new Date(lastData.fetchedAt).toLocaleString('en-IN') + '. These are not live ticks; signals remain blocked until fresh data returns.');
            return;
          }
        } catch {}
      }
      if (response.status === 401) {
        latestQuotes = {};
        setStatus('FYERS LOGIN REQUIRED');
        setFyersStatus('NOT CONNECTED');
        setConnection('Not connected', true);
        document.querySelectorAll('.metrics .metric').forEach((metric, index) => {
          if (index === 1 || index === 2) {
            const value = metric.querySelector('strong');
            const detail = metric.querySelector('small');
            if (value) { value.textContent = '—'; value.classList.add('muted'); }
            if (detail) detail.textContent = 'No authenticated quote available';
          }
        });
        const staleUpdate = document.querySelector('#lastUpdate');
        if (staleUpdate) { staleUpdate.textContent = '—'; staleUpdate.classList.add('muted'); }
        updateDynamicPanel();
        showMessage('FYERS is not authenticated. Open FYERS Settings to connect.', true);
      } else if (response.status === 503) {
        quotePollDelay = 5000;
        if (Object.keys(latestQuotes).length) setStatus('LIVE DATA STALE');
        else setStatus('WAITING FOR LIVE TICKS');
        showMessage(data.detail || data.error || 'Waiting for fresh FYERS WebSocket ticks. REST fallback is disabled to protect rate limits.');
      } else {
        setStatus('LIVE DATA UNAVAILABLE');
        showMessage(data.error || 'The backend did not return verified quotes.', true);
      }
      return;
    }
    quotePollDelay = QUOTE_POLL_MS;
    if (!updateQuoteCards(data.data, data.fetchedAt, data.source, data.streamConnected)) {
      setStatus('INCOMPLETE QUOTE RESPONSE');
      showMessage('Both expected index quotes were not present. No new values were applied.', true);
      logEvent('Quote response was incomplete.', 'warn');
      return;
    }
    if (data.source === 'websocket-recent' || data.streamConnected === false) {
      showMessage('Showing the last verified FYERS prices while the market socket reconnects. Signals remain blocked until fresh ticks resume.');
    } else {
      showMessage('NIFTY and BANK NIFTY quotes received from the backend.');
    }
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
  const state = params.get('state');
  const brokerError = params.get('error_description') || params.get('error');
  if (!code) {
    if (brokerError) {
      window.history.replaceState({}, document.title, window.location.pathname);
      setStatus('FYERS AUTH FAILED');
      setFyersStatus('AUTH FAILED');
      showMessage('FYERS login was cancelled or rejected: ' + brokerError, true);
      logEvent('FYERS login returned an authorization error.', 'warn');
    }
    return;
  }
  window.history.replaceState({}, document.title, window.location.pathname);
  setStatus('VERIFYING FYERS LOGIN…');
  setFyersStatus('VERIFYING…');
  showMessage('Authorization received. Verifying with the backend…');
  try {
    const response = await fetch(BACKEND_URL + '/api/fyers/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code: code, state: state })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true || !data.dashboardSessionToken) throw new Error(data.error || data.detail || 'Authentication failed or session was not issued.');
    sessionStorage.setItem('dhanpulse-dashboard-session-v1', data.dashboardSessionToken);
    setFyersStatus('CONNECTED');
    setBackendStatus('ONLINE');
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

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  showMessage('DhanPulse app installed successfully.');
});

nav.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
  const button = target && target.closest('button[data-tab]');
  if (!button) return;
  try {
    render(button.dataset.tab);
  } catch (error) {
    const tab = button.dataset.tab || 'Workspace';
    const message = error && error.message ? error.message : 'Unexpected workspace error';
    currentTab = tab;
    if (title) title.textContent = tab;
    if (panelTitle) panelTitle.textContent = 'Workspace error';
    if (featureTitle) featureTitle.textContent = tab;
    if (featureDesc) featureDesc.textContent = 'Navigation responded, but this workspace hit an error.';
    const diagnostic = '<div class="chart-empty"><strong>Workspace could not load.</strong><p>' + escapeHtml(message) + '</p><p>The navigation click worked, but the workspace renderer stopped. This error is shown instead of leaving old dashboard content in place.</p></div>';
    if (featureContent) featureContent.innerHTML = diagnostic;
    const mainWorkspace = document.querySelector('#mainWorkspaceContent');
    if (mainWorkspace) mainWorkspace.innerHTML = '<div class="main-view-heading"><span class="eyebrow">DHANPULSE DIAGNOSTIC</span><h2>' + escapeHtml(tab) + '</h2></div>' + diagnostic;
    nav.querySelectorAll('button[data-tab]').forEach(item => item.classList.toggle('active', item === button));
    logEvent('Workspace render failed for ' + tab + ': ' + message, 'error');
  }
});
document.querySelector('#settingsBtn')?.addEventListener('click', () => render('FYERS Settings'));

render('Dashboard');
testBackend();
exchangeAuthCode();
logEvent('DhanPulse console initialised.', 'info');
fetchLiveQuotes();
