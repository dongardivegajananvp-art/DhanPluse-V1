const BACKEND_URL = 'https://dhanpluse-v1.onrender.com';
const QUOTE_POLL_MS = 5000;
const QUOTE_POLL_MAX_MS = 30000;

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

const descriptions = {
  'Dashboard': ['Market overview', 'Verified FYERS market quotes and connection status.'],
  'NIFTY': ['NIFTY 50 workspace', 'Quote returned by the FYERS backend.'],
  'BANKNIFTY': ['BANK NIFTY workspace', 'Quote returned by the FYERS backend.'],
  'Watchlist': ['Watchlist', 'Index quotes are read from FYERS.'],
  'Option Chain': ['Option chain & OI', 'Option-chain integration is not enabled yet.'],
  'AI Signals': ['Technical analysis & signals', 'No fabricated or unverified signals are shown.'],
  'Holdings': ['Holdings & positions', 'Authenticated account endpoints are not implemented in this frontend.'],
  'FYERS Settings': ['FYERS connection settings', 'Connect through the secure backend.'],
  'Logs': ['System logs', 'Backend and quote request status.']
};

function setStatus(message) {
  const el = document.querySelector('#marketStatus');
  if (el) el.textContent = message;

  const connected = message === 'FYERS QUOTES RECEIVED';
  const waiting = document.querySelector('#sideFeedStatus');
  const footer = document.querySelector('#footerFeedStatus');
  const dot = document.querySelector('#sideFeedDot');

  if (waiting) waiting.textContent = connected ? 'Live feed connected' : 'Waiting for verified live feed';
  if (footer) footer.textContent = connected ? 'Live FYERS quotes received' : 'Waiting for verified live feed';
  if (dot) {
    dot.style.background = connected ? '#63e6d0' : '#64738a';
    dot.title = connected ? 'Verified quote response received' : 'No verified live quote response yet';
  }
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

function setConnection(message, muted = true) {
  const el = document.querySelector('#connectionValue');
  if (!el) return;

  el.textContent = message;
  el.classList.toggle('muted', muted);
}

function resetQuoteDisplay() {
  const metrics = document.querySelectorAll('.metric');

  [1, 2].forEach(index => {
    const metric = metrics[index];
    if (!metric) return;

    const value = metric.querySelector('strong');
    const detail = metric.querySelector('small');

    if (value) {
      value.textContent = '—';
      value.classList.add('muted');
    }

    if (detail) detail.textContent = 'No verified quote available';
  });

  const lastUpdate = document.querySelector('#lastUpdate');
  if (lastUpdate) {
    lastUpdate.textContent = '—';
    lastUpdate.classList.add('muted');
  }

  setConnection('Not verified');
}

function render(tab) {
  if (!descriptions[tab]) return;

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
          ? ['Account endpoints required']
          : tab === 'Watchlist'
            ? ['NIFTY 50', 'BANK NIFTY']
            : tab === 'Logs'
              ? ['Backend and quote status']
              : ['Waiting for a verified quote'];

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

    const quotes = document.createElement('button');
    quotes.className = 'primary';
    quotes.style.marginLeft = '8px';
    quotes.textContent = 'Test quotes';
    quotes.onclick = fetchLiveQuotes;
    featureContent.append(quotes);
  }

  if (tab === 'NIFTY' || tab === 'BANKNIFTY' || tab === 'Watchlist') {
    const refresh = document.createElement('button');
    refresh.className = 'primary';
    refresh.textContent = 'Refresh quotes';
    refresh.onclick = fetchLiveQuotes;
    featureContent.append(refresh);
  }
}

async function testBackend() {
  setBackendStatus('CHECKING…');

  try {
    const response = await fetch(BACKEND_URL + '/health', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error('Backend health check failed.');
    }

    setBackendStatus('ONLINE');
    showMessage('Backend is online. This does not prove live quotes are connected.');

    // Do not set FYERS connected from health alone.
    return data;
  } catch {
    setBackendStatus('UNREACHABLE');
    setStatus('BACKEND UNAVAILABLE');
    showMessage('Backend test failed. Check Render and CORS settings.', true);
    return null;
  }
}

async function startFyersLogin() {
  if (authInProgress) return;
  authInProgress = true;

  showMessage('Preparing secure FYERS login…');

  try {
    const response = await fetch(BACKEND_URL + '/api/fyers/auth/start', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.authorizationUrl) {
      throw new Error(data.error || 'Authorization URL unavailable.');
    }

    // Navigate to FYERS; the registered redirect URI must match exactly.
    window.location.assign(data.authorizationUrl);
  } catch (error) {
    authInProgress = false;
    showMessage(error.message || 'Could not start FYERS login.', true);
  }
}

function updateQuoteCards(quotes, fetchedAt) {
  if (!Array.isArray(quotes)) return false;

  const metrics = document.querySelectorAll('.metric');
  if (metrics.length < 4) return false;

  const quoteBySymbol = new Map();

  quotes.forEach(item => {
    if (item?.n && item?.v) {
      quoteBySymbol.set(item.n, item.v);
    }
  });

  const cards = [
    { symbol: 'NSE:NIFTY50-INDEX', index: 1 },
    { symbol: 'NSE:NIFTYBANK-INDEX', index: 2 }
  ];

  const verified = cards.map(card => {
    const quote = quoteBySymbol.get(card.symbol);
    const price = Number(quote?.lp);

    if (!quote || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    return { ...card, quote, price };
  });

  // Require both expected index quotes before marking the response successful.
  if (verified.some(item => item === null)) return false;

  for (const item of verified) {
    const metric = metrics[item.index];
    const valueEl = metric.querySelector('strong');
    const detailEl = metric.querySelector('small');

    if (!valueEl || !detailEl) return false;

    valueEl.textContent = item.price.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    valueEl.classList.remove('muted');

    const change = Number(item.quote.ch);
    const percent = Number(item.quote.chp);

    if (Number.isFinite(change) && Number.isFinite(percent)) {
      detailEl.textContent =
        `${change > 0 ? '+' : ''}${change.toFixed(2)} ` +
        `(${percent > 0 ? '+' : ''}${percent.toFixed(2)}%)`;
    } else {
      detailEl.textContent = 'FYERS quote received';
    }
  }

  const lastUpdate = document.querySelector('#lastUpdate');
  if (lastUpdate) {
    const parsedTime = Date.parse(fetchedAt);
    lastUpdate.textContent = Number.isFinite(parsedTime)
      ? new Date(parsedTime).toLocaleTimeString('en-IN')
      : 'Timestamp unavailable';
    lastUpdate.classList.remove('muted');
  }

  setStatus('FYERS QUOTES RECEIVED');
  setConnection('FYERS Connected', false);
  setFyersStatus('CONNECTED');

  return true;
}

async function fetchLiveQuotes() {
  if (quoteRequestRunning) return;
  quoteRequestRunning = true;

  try {
    const response = await fetch(BACKEND_URL + '/api/market/quotes', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 429) {
      // Respect the backend/FYERS cooldown instead of polling every 15 seconds.
      const retrySeconds = Number(data.retryAfterSeconds) || 30;
      quotePollDelay = Math.min(
        Math.max((retrySeconds + 5) * 1000, QUOTE_POLL_MS),
        QUOTE_POLL_MAX_MS
      );
      setStatus('FYERS RATE LIMIT — WAITING');
      showMessage(`FYERS is rate-limiting quote requests. Retrying in about ${Math.ceil(quotePollDelay / 1000)} seconds.`, true);
      return;
    }

    if (!response.ok || data.ok !== true || !Array.isArray(data.data)) {
      resetQuoteDisplay();

      if (response.status === 401) {
        setStatus('FYERS LOGIN REQUIRED');
        setFyersStatus('NOT CONNECTED');
        showMessage('FYERS is not authenticated. Use FYERS Settings to connect.', true);
      } else if (response.status === 503 && /waiting|not ready/i.test(String(data.detail || data.error || ''))) {
        quotePollDelay = QUOTE_POLL_MS;
        setStatus('WAITING FOR LIVE TICKS');
        showMessage(data.detail || data.error || 'FYERS WebSocket is connecting. Waiting for live ticks.');
      } else {
        setStatus('LIVE DATA UNAVAILABLE');
        showMessage(data.error || 'The backend did not return verified quotes.', true);
      }

      return;
    }

    quotePollDelay = QUOTE_POLL_MS;

    if (!updateQuoteCards(data.data, data.fetchedAt)) {
      resetQuoteDisplay();
      setStatus('INCOMPLETE QUOTE RESPONSE');
      showMessage('Both expected index quotes were not present. Prices cleared.', true);
      return;
    }

    showMessage('NIFTY and BANK NIFTY quotes received from the backend.');
  } catch {
    resetQuoteDisplay();
    setStatus('LIVE DATA UNAVAILABLE');
    showMessage('Cannot reach the quote API. Check network and backend status.', true);
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

  // Remove the one-time code from the visible address bar immediately.
  window.history.replaceState({}, document.title, window.location.pathname);

  setStatus('VERIFYING FYERS LOGIN…');
  setFyersStatus('VERIFYING…');
  showMessage('Authorization received. Verifying with the backend…');

  try {
    const response = await fetch(BACKEND_URL + '/api/fyers/auth/exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ code })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok !== true) {
      throw new Error(data.error || data.detail || 'Authentication failed.');
    }

    showMessage('FYERS authentication succeeded. Verifying quotes…');

    await fetchLiveQuotes();
  } catch (error) {
    resetQuoteDisplay();
    setStatus('FYERS AUTH FAILED');
    setFyersStatus('AUTH FAILED');
    showMessage(
      error.message || 'Authentication failed. Try a fresh FYERS login.',
      true
    );
  }
}

nav.addEventListener('click', event => {
  const button = event.target.closest('button[data-tab]');
  if (button) render(button.dataset.tab);
});

document.querySelector('#settingsBtn')?.addEventListener('click', () => {
  render('FYERS Settings');
});

render('Dashboard');
resetQuoteDisplay();

testBackend();
exchangeAuthCode();

// Poll the backend's cached WebSocket ticks; the backend no longer polls FYERS REST quotes.
// Use adaptive timeouts for any service cooldown responses.
fetchLiveQuotes();
