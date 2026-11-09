import 'dotenv/config';
import crypto from 'node:crypto';
import { createFyersTokenStore } from './fyers-token-store.js';
import { createRequire } from 'node:module';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { analyzeOpeningGap, isValidIsoDate, summarizeHistoricalGaps } from './gap-analysis.js';
import { assertCompleteMoverSnapshot, assertFreshMoverSnapshot } from './movers-validation.js';
import { quoteTimestampStatus } from './fresh-data-validation.js';
import { getNseSessionWindow } from './market-data.js';
import { getExchangeSessionWindows } from './exchange-session-status.js';

import { buildFnoEquityUniverse } from './fno-universe.js';
import { normalizeFyersFunds } from './fyers-funds.js';
import { getReferenceDataRetryDelay } from './reference-data-backoff.js';
import { isAllowedChartSymbol } from './chart-symbol-validation.js';
import { normalizeInstitutionalFlow } from './institutional-flow.js';
import { createFyersDataApiBudget } from './fyers-data-api-budget.js';
import { buildOptionRiskPlan } from './option-risk-plan.js';
import { buildFixedOptionRiskPlan, validateCompletedOptionCandles } from './fixed-option-risk-plan.js';
import { getVerifiedOptionContractMetadata as resolveOptionContractMetadata } from './option-contract-metadata.js';
import { isFyersAuthRejected, isExpiredFyersAccessTokenError } from './fyers-auth-recovery.js';
import { normalizeOptionContractDiscovery } from './option-contract-discovery.js';
import { isSupportedOptionContractSymbol } from './option-symbol-validation.js';
import { buildVerifiedSureshotShortlist } from './sureshot-shortlist.js';
import { summarizeFyersUpstreamFailure } from './fyers-upstream-diagnostics.js';
import { buildMarketSocketSubscriptionSymbols, getMarketSocketReconnectDelay } from './market-socket-recovery.js';
import { selectMcxDiagnosticInstrument } from './mcx-diagnostic.js';
import { getMcxWatchdogRetryDelay } from './mcx-watchdog.js';
import { buildMcxFuturesUniverse, buildVerifiedMcxShortlist } from './mcx-sureshot.js';
import { moversPayloadToFnoQuoteSnapshot, fnoQuoteSnapshotToMoversPayload, isCompleteFreshFnoQuoteSnapshot } from './fno-quote-snapshot.js';
import { deriveVerifiedUnderlyingDirection, selectNearestVerifiedOptionContract, buildVerifiedSureshotTradePlan } from './sureshot-auto-plans.js';
import { createPaperTradingStore } from './paper-trading-store.js';
import { reconcilePaperSocketSubscriptions } from './paper-socket-subscriptions.js';
import { createVerifiedPlanRegistry } from './verified-plan-registry.js';

const require = createRequire(import.meta.url);
const { fyersDataSocket } = require('fyers-api-v3');
const fetchWithFyersBudget = createFyersDataApiBudget();

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb' }));

const appId = (process.env.FYERS_APP_ID || '').trim();
const appSecret = (process.env.FYERS_APP_SECRET || '').trim();
// FIX: Accept both URI and URL naming - Render UI truncation issue
const redirectUri = (process.env.FYERS_REDIRECT_URI || process.env.FYERS_REDIRECT_URL || process.env.FYERS_REDIRECT || '').trim();
const fyersTokenStore = createFyersTokenStore({
  databaseUrl: process.env.DATABASE_URL,
  encryptionKey: process.env.FYERS_TOKEN_ENCRYPTION_KEY
});
let fyersTokenStoreReady = false;
const paperStore = createPaperTradingStore({ databaseUrl: process.env.DATABASE_URL });
const verifiedPlanRegistry = createVerifiedPlanRegistry({ ttlMs: 30_000 });
let paperStoreReady = false;
const paperSocketSymbols = new Set();
let paperSocketSyncQueue = Promise.resolve();
const allowedSymbols = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'];
let chartStreamSymbol = null;

// Production is restricted to the original DhanPulse GitHub Pages frontend.
// Localhost remains available for local development; retired preview/test hosts
// are intentionally ignored even if stale ALLOWED_ORIGIN(S) values remain set.
const allowedOrigins = new Set([
  'https://dongardivegajananvp-art.github.io',
  // Backward compatibility for the previously shared installed PWA origin.
  // This is an exact host allow-list entry, not a wildcard or general preview permission.
  'https://spectacular-gaufre-b5c029.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000'
]);

if (redirectUri) {
  try {
    allowedOrigins.add(new URL(redirectUri).origin);
  } catch {}
}

console.log('Allowed Origins:', [...allowedOrigins]);
console.log('FYERS Config - AppID:', appId ? appId.slice(0,6)+'...' : 'MISSING', 'Redirect:', redirectUri || 'MISSING');

app.use(cors({
  origin(origin, callback) {
    // Allow no-origin (curl, health checks, Render)
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    console.warn('CORS blocked origin:', origin);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
  // The frontend uses the server's exact FYERS cooldown deadline to schedule
  // its next automatic scan without probing the provider during the block.
  exposedHeaders: ['Retry-After']
}));

let accessToken = '';
let authenticatedAt = null;
const pendingAuthStates = new Map();
const diagnostics = [];
function recordDiagnostic(level, event, detail = {}) {
  diagnostics.push({ timestamp: new Date().toISOString(), level, event, ...detail });
  if (diagnostics.length > 200) diagnostics.splice(0, diagnostics.length - 200);
}
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const dashboardSessions = new Map();
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
let marketSocket = null;
let marketSocketGeneration = 0;
let marketSocketStartedAt = 0;
let marketSocketLastCloseAt = 0;
// A one-way SHA-256 fingerprint is diagnostic only; never log or expose a token.
function socketTokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}
// Track which FYERS access token owns the one active SDK socket. A repeated
// OAuth exchange with the same token must never close/recreate a healthy or
// SDK-reconnecting socket; doing so resets SDK reconnect state and subscriptions.
let marketSocketToken = '';
let mcxDiagnosticInstrument = null;
let mcxDiagnosticTick = null;
let mcxDiagnosticMasterStatus = 'NOT_LOADED';
let mcxDiagnosticMasterPromise = null;
let mcxSubscribedSocket = null;
// Both the connection diagnostic and Sureshot must share one authoritative
// official master download. Separate fetches caused duplicate slow requests
// and could leave the diagnostic and scanner with conflicting availability.
let mcxOfficialMaster = null;
let mcxOfficialMasterFetchedAt = 0;
let mcxOfficialMasterPromise = null;
const MCX_OFFICIAL_MASTER_CACHE_MS = 24 * 60 * 60 * 1000;

async function loadOfficialMcxSymbolMaster() {
  if (mcxOfficialMaster && Date.now() - mcxOfficialMasterFetchedAt < MCX_OFFICIAL_MASTER_CACHE_MS) {
    return mcxOfficialMaster;
  }
  if (mcxOfficialMasterPromise) return mcxOfficialMasterPromise;
  mcxOfficialMasterPromise = (async () => {
    const response = await fetch('https://public.fyers.in/sym_details/MCX_COM_sym_master.json', {
      signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`FYERS official MCX_COM symbol master unavailable (HTTP ${response.status}).`);
    const master = await response.json();
    if (!master || typeof master !== 'object' || Array.isArray(master)) {
      throw new Error('FYERS MCX_COM symbol master format is invalid.');
    }
    mcxOfficialMaster = master;
    mcxOfficialMasterFetchedAt = Date.now();
    console.log('FYERS official MCX_COM symbol master cached for connection diagnostics and Sureshot.', JSON.stringify({
      entries: Object.keys(master).length,
      fetchedAt: new Date(mcxOfficialMasterFetchedAt).toISOString()
    }));
    return master;
  })().finally(() => { mcxOfficialMasterPromise = null; });
  return mcxOfficialMasterPromise;
}
let streamConnected = false;
let streamError = '';
const latestTicks = new Map();
// Track NSE baseline market-data activity separately from MCX diagnostics and per-symbol freshness.
// An unchanged index may legitimately emit no new tick; MCX ticks must not mask
// silence in the NSE baseline feed.
let lastAnyMarketTickAt = 0;
let marketSocketConnectedAt = 0;
// NSE heartbeat is independent of MCX and BSE activity.
const NSE_TICK_HEARTBEAT_MS = 10_000;
const NSE_TICK_FRESHNESS_SECONDS = 10;
// MCX has its own freshness gate and subscription retry on the shared FYERS
// Data Socket. NSE silence must never trigger this controller, or vice versa.
const MCX_TICK_HEARTBEAT_MS = 10_000;
const MCX_TICK_FRESHNESS_SECONDS = 10;
const nseIndexSymbols = allowedSymbols.filter(symbol => symbol.startsWith('NSE:'));
let nseReconnectPending = false;
let lastNseResubscribeAt = 0;
let nseResubscribeCount = 0;
let lastMcxResubscribeAt = 0;
let mcxResubscribeCount = 0;
const lastTickDiagnosticAt = new Map();
const lastRejectedDiagnosticAt = new Map();
const lastControlDiagnosticAt = new Map();
const SOCKET_DIAGNOSTIC_LOG_INTERVAL_MS = 15_000;
let restQuoteCache = null;
let restQuoteFetchedAt = 0;
let restQuoteInFlight = null;

function shouldLogSocketDiagnostic(store, symbol) {
  const now = Date.now();
  const last = store.get(symbol) || 0;
  if (now - last < SOCKET_DIAGNOSTIC_LOG_INTERVAL_MS) return false;
  store.set(symbol, now);
  return true;
}

async function loadMcxDiagnosticInstrument() {
  if (mcxDiagnosticInstrument) return mcxDiagnosticInstrument;
  if (mcxDiagnosticMasterPromise) return mcxDiagnosticMasterPromise;
  mcxDiagnosticMasterStatus = 'LOADING_OFFICIAL_SYMBOL_MASTER';
  mcxDiagnosticMasterPromise = (async () => {
    const master = await loadOfficialMcxSymbolMaster();
    const selected = selectMcxDiagnosticInstrument(master, Date.now());
    if (!selected) {
      mcxDiagnosticMasterStatus = 'NO_ACTIVE_FUTURE';
      console.warn('FYERS MCX diagnostics: no active unexpired CRUDEOIL or GOLD future found in the official symbol master.');
      return null;
    }
    mcxDiagnosticInstrument = selected;
    mcxDiagnosticMasterStatus = 'READY';
    console.log('FYERS MCX diagnostic contract resolved from official symbol master.', JSON.stringify({
      symbol: selected.symbol, expiryDate: selected.expiryDate, source: 'MCX_COM_sym_master.json'
    }));
    return selected;
  })().catch(error => {
    mcxDiagnosticMasterStatus = 'MASTER_UNAVAILABLE';
    console.warn('FYERS MCX diagnostic symbol master unavailable:', String(error?.message || error).slice(0, 180));
    return null;
  }).finally(() => { mcxDiagnosticMasterPromise = null; });
  return mcxDiagnosticMasterPromise;
}

function parseTick(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return 0; }
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let acceptedCount = 0;
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const symbol = item.symbol || item.n;
    const ltp = Number(item.ltp ?? item.lp ?? item.v?.lp);
    const isMcxDiagnostic = Boolean(mcxDiagnosticInstrument && symbol === mcxDiagnosticInstrument.symbol);
    const isPaperOption = paperSocketSymbols.has(symbol);
    if (!(allowedSymbols.includes(symbol) || symbol === chartStreamSymbol || isMcxDiagnostic || isPaperOption) || !Number.isFinite(ltp) || ltp <= 0) continue;
    const exchangeTime = epochSeconds(
      item.exch_feed_time ?? item.last_traded_time ?? item.ltt ?? item.tt ?? item.v?.exch_feed_time ?? item.v?.last_traded_time ?? item.v?.ltt ?? item.v?.tt
    );
    if (!exchangeTime) {
      if (shouldLogSocketDiagnostic(lastRejectedDiagnosticAt, symbol)) {
        console.warn(isMcxDiagnostic ? 'FYERS MCX update ignored: missing exchange timestamp.' : 'FYERS index update ignored: missing exchange timestamp.', JSON.stringify({ symbol, type: item.type || null }));
      }
      continue;
    }
    const tick = {
      symbol, ltp,
      ch: item.ch == null || !Number.isFinite(Number(item.ch)) ? null : Number(item.ch),
      chp: item.chp == null || !Number.isFinite(Number(item.chp)) ? null : Number(item.chp),
      updatedAt: new Date(exchangeTime * 1000).toISOString(),
      receivedAt: new Date().toISOString()
    };
    latestTicks.set(symbol, tick);
    if (isPaperOption && paperStoreReady) {
      void paperStore.processVerifiedQuote({
        symbol, price: ltp, exchangeTimestamp: tick.updatedAt, source: 'FYERS_VERIFIED'
      }).then(result => {
        if (result?.updates?.some(position => position.state === 'CLOSED')) {
          void subscribeOpenPaperPositions(marketSocket);
        }
      }).catch(error => console.error('Paper position quote processing failed:', String(error?.message || error).slice(0, 180)));
    }
    if (isMcxDiagnostic) {
      mcxDiagnosticTick = tick;
      // Only a fresh exchange-stamped tick proves recovery; stale frames do not
      // reset the watchdog or postpone the next bounded subscription attempt.
      if (quoteTimestampStatus(exchangeTime, Date.now(), MCX_TICK_FRESHNESS_SECONDS) === 'FRESH') {
        mcxResubscribeCount = 0;
        lastMcxResubscribeAt = 0;
      }
      if (shouldLogSocketDiagnostic(lastTickDiagnosticAt, symbol)) {
        const ageSeconds = Number(((Date.now() / 1000) - exchangeTime).toFixed(1));
        console.log('FYERS MCX diagnostic tick accepted.', JSON.stringify({
          symbol, exchangeTimestamp: tick.updatedAt, exchangeAgeSeconds: ageSeconds,
          freshness: ageSeconds >= 0 && ageSeconds <= 30 ? 'FRESH' : 'STALE'
        }));
      }
    }
    // MCX and BSE activity must never mask silence in the NSE baseline feed.
    if (!isMcxDiagnostic) lastAnyMarketTickAt = Date.now();
    if (symbol.startsWith('NSE:') && quoteTimestampStatus(exchangeTime, Date.now(), NSE_TICK_FRESHNESS_SECONDS) === 'FRESH') {
      if (nseReconnectPending && nseIndexSymbols.every(requiredSymbol => {
        const requiredTick = latestTicks.get(requiredSymbol);
        return Boolean(requiredTick && quoteTimestampStatus(Date.parse(requiredTick.updatedAt) / 1000, Date.now(), NSE_TICK_FRESHNESS_SECONDS) === 'FRESH');
      })) {
        nseReconnectPending = false;
        nseResubscribeCount = 0;
        if (streamError.startsWith('NSE feed is reconnecting')) streamError = '';
        console.log('NSE live feed restored after automatic recovery.', JSON.stringify({ symbol, exchangeTimestamp: tick.updatedAt, allRequiredNseSymbolsFresh: true }));
      }
    }
    acceptedCount += 1;
  }
  return acceptedCount;
}

async function reconcileOpenPaperPositions(symbols) {
  if (!paperStoreReady || !accessToken || !nseRegularSessionNow() || !symbols.length) return;
  try {
    const needsRestCheck = symbols.filter(symbol => {
      const tick = latestTicks.get(symbol);
      return !tick || quoteTimestampStatus(epochSeconds(tick.updatedAt), Date.now(), 10) !== 'FRESH';
    });
    if (!needsRestCheck.length) return;
    const url = new URL('https://api-t1.fyers.in/data/quotes');
    url.searchParams.set('symbols', needsRestCheck.join(','));
    const result = await fyersReadOnlyGet(url, { priority: 'sureshot' });
    const rows = Array.isArray(result?.d) ? result.d : (Array.isArray(result?.data) ? result.data : []);
    for (const row of rows) {
      const symbol = row?.n || row?.symbol || row?.v?.symbol;
      if (!needsRestCheck.includes(symbol)) continue;
      const quote = row?.v || row;
      const price = Number(quote?.lp ?? quote?.ltp);
      const timestamp = epochSeconds(quote?.ltt ?? quote?.tt ?? quote?.exch_feed_time);
      if (Number.isFinite(price) && price > 0 && quoteTimestampStatus(timestamp, Date.now(), 10) === 'FRESH') {
        await paperStore.processVerifiedQuote({
          symbol, price, exchangeTimestamp: new Date(timestamp * 1000).toISOString(), source: 'FYERS_VERIFIED'
        });
      }
    }
  } catch (error) {
    console.warn('Paper position restart/reconnect quote reconciliation deferred; no stale quote was applied:', String(error?.message || error).slice(0, 180));
  }
}

async function subscribeOpenPaperPositions(socket, { forceSubscribe = false } = {}) {
  if (!paperStoreReady || !socket || marketSocket !== socket || !streamConnected) return;
  const task = paperSocketSyncQueue.then(async () => {
    if (!paperStoreReady || !socket || marketSocket !== socket || !streamConnected) return;
    try {
      const positions = await paperStore.listOpenPositions();
      const symbols = [...new Set(positions.map(row => String(row.symbol || '')).filter(isSupportedOptionContractSymbol))];
      const reservedSymbols = [...allowedSymbols, chartStreamSymbol, mcxDiagnosticInstrument?.symbol].filter(Boolean);
      const result = reconcilePaperSocketSubscriptions({
        socket, currentSymbols: paperSocketSymbols, desiredSymbols: symbols,
        reservedSymbols, maxSymbols: 100, forceSubscribe
      });
      for (const symbol of result.removed) latestTicks.delete(symbol);
      if (result.removed.length) {
        console.log('FYERS closed Paper position symbols unsubscribed.', JSON.stringify({
          removedCount: result.removed.length, activePaperPositionSymbols: paperSocketSymbols.size,
          knownSocketSymbolCount: result.totalKnownSymbols
        }));
      }
      if (result.added.length) {
        console.log('FYERS open Paper position symbols subscribed.', JSON.stringify({
          addedCount: result.added.length, activePaperPositionSymbols: paperSocketSymbols.size,
          knownSocketSymbolCount: result.totalKnownSymbols, reconnectRestore: forceSubscribe
        }));
        void reconcileOpenPaperPositions(result.added);
      }
    } catch (error) {
      console.error('Could not reconcile FYERS Paper position subscriptions:', String(error?.message || error).slice(0, 180));
    }
  });
  paperSocketSyncQueue = task.catch(() => {});
  return task;
}

function startMarketDataStream(token, startReason = 'unspecified') {
  const requestedFingerprint = socketTokenFingerprint(token);
  const currentFingerprint = marketSocketToken ? socketTokenFingerprint(marketSocketToken) : null;
  console.log('FYERS market socket start requested.', JSON.stringify({
    reason: startReason, requestedTokenFingerprint: requestedFingerprint,
    currentTokenFingerprint: currentFingerprint, socketPresent: Boolean(marketSocket),
    transportConnected: streamConnected, generation: marketSocketGeneration
  }));
  if (marketSocket && marketSocketToken === token) {
    console.log('FYERS market socket start skipped: same access token already owns the socket; preserving SDK lifecycle.', JSON.stringify({
      reason: startReason, tokenFingerprint: requestedFingerprint, generation: marketSocketGeneration
    }));
    return;
  }
  streamError = '';
  streamConnected = false;
  nseReconnectPending = false;
  lastNseResubscribeAt = 0;
  nseResubscribeCount = 0;
  latestTicks.clear();
  mcxDiagnosticTick = null;
  mcxSubscribedSocket = null;
  let socket = null;
  try {
    if (marketSocket) {
      console.warn('FYERS market socket owner is being replaced for a different token.', JSON.stringify({
        reason: startReason, previousTokenFingerprint: currentFingerprint,
        nextTokenFingerprint: requestedFingerprint, previousGeneration: marketSocketGeneration,
        previousTransportConnected: streamConnected
      }));
      try { marketSocket.close(); } catch {}
      marketSocket = null;
    }
    // The third SDK argument controls SDK logging, not reconnect behavior.
    // Keep logging disabled and explicitly enable the SDK's single reconnect
    // owner. FYERS documents that it restores prior subscriptions on reconnect.
    socket = fyersDataSocket.getInstance(`${appId}:${token}`, '', false);
    marketSocket = socket;
    marketSocketToken = token;
    marketSocketGeneration += 1;
    const socketGeneration = marketSocketGeneration;
    marketSocketStartedAt = Date.now();
    console.log('FYERS market socket owner created.', JSON.stringify({
      reason: startReason, tokenFingerprint: requestedFingerprint,
      generation: socketGeneration, startedAt: new Date(marketSocketStartedAt).toISOString()
    }));
    // FYERS documents a maximum of 50 SDK-managed reconnect attempts.
    const SDK_RECONNECT_RETRIES = 50;
    // FYERS Node docs use `autoreconnect`; support the camelCase spelling
    // present in some published SDK examples without creating two controllers.
    const sdkReconnect = typeof socket.autoreconnect === 'function'
      ? socket.autoreconnect.bind(socket)
      : typeof socket.autoReconnect === 'function'
        ? socket.autoReconnect.bind(socket)
        : null;
    if (!sdkReconnect) {
      throw new Error('Installed FYERS SDK does not expose its documented auto-reconnect method; refusing to start an unmanaged live socket.');
    }
    sdkReconnect(SDK_RECONNECT_RETRIES);
    console.log('FYERS SDK auto-reconnect enabled.', JSON.stringify({
      retries: SDK_RECONNECT_RETRIES,
      method: typeof socket.autoreconnect === 'function' ? 'autoreconnect' : 'autoReconnect'
    }));
    let socketConnectCount = 0;
    socket.on('connect', () => {
      if (marketSocket !== socket) return;
      streamConnected = true;
      streamError = '';
      marketSocketConnectedAt = Date.now();
      lastAnyMarketTickAt = 0;
      nseReconnectPending = false;
      lastNseResubscribeAt = 0;
      socketConnectCount += 1;
      console.log('FYERS market socket connected; restoring baseline subscription.', JSON.stringify({
        generation: socketGeneration, tokenFingerprint: requestedFingerprint,
        connectionNumber: socketConnectCount, reconnect: socketConnectCount > 1,
        connectedAt: new Date(marketSocketConnectedAt).toISOString(),
        secondsSinceSocketOwnerCreated: Number(((marketSocketConnectedAt - marketSocketStartedAt) / 1000).toFixed(1))
      }));
      try {
        // Re-apply mode and subscriptions on every connect event. A TCP/WebSocket
        // reconnect does not guarantee that the provider retained subscriptions.
        socket.mode(socket.FullMode);
        // Re-apply the complete required subscription set after EVERY connect,
        // including SDK-managed reconnects. Do not assume the provider retained
        // subscriptions across a dropped WebSocket session.
        const nseSubscriptionSymbols = buildMarketSocketSubscriptionSymbols(allowedSymbols, chartStreamSymbol);
        try {
          socket.subscribe(nseSubscriptionSymbols);
          console.log('FYERS NSE subscriptions applied after socket connect.', JSON.stringify({
            connectionNumber: socketConnectCount, reconnect: socketConnectCount > 1,
            symbols: nseSubscriptionSymbols
          }));
        } catch (nseSubscriptionError) {
          nseReconnectPending = true;
          console.error('FYERS NSE subscription restore failed; MCX subscription restore will still be attempted:', String(nseSubscriptionError?.message || nseSubscriptionError).slice(0, 200));
        }
        // Keep MCX subscription restoration independent from NSE subscription
        // restoration even though FYERS requires one Data Socket transport.
        if (mcxDiagnosticInstrument) {
          try {
            socket.subscribe([mcxDiagnosticInstrument.symbol]);
            mcxSubscribedSocket = socket;
            console.log('FYERS MCX subscription restored independently after socket connect.', JSON.stringify({
              connectionNumber: socketConnectCount, reconnect: socketConnectCount > 1,
              symbol: mcxDiagnosticInstrument.symbol
            }));
          } catch (mcxSubscriptionError) {
            mcxSubscribedSocket = null;
            console.error('FYERS MCX subscription restore failed independently of NSE:', String(mcxSubscriptionError?.message || mcxSubscriptionError).slice(0, 200));
          }
        }
        void subscribeOpenPaperPositions(socket, { forceSubscribe: true });
      } catch (error) {
        streamConnected = false;
        streamError = 'Could not subscribe to FYERS index symbols; controlled recovery is pending.';
        console.error('FYERS market socket subscription failed:', String(error?.message || error).slice(0, 240));

      }
    });
    socket.on('message', message => {
      if (marketSocket !== socket) return;
      const parsedMessage = typeof message === 'string'
        ? (() => { try { return JSON.parse(message); } catch { return null; } })()
        : message;
      const frames = Array.isArray(parsedMessage) ? parsedMessage : [parsedMessage];
      const controlFrames = frames
        .filter(x => x && typeof x === 'object' && (x.type || x.s || x.code != null))
        .filter(x => shouldLogSocketDiagnostic(lastControlDiagnosticAt, String(x.type || x.code || x.s)))
        .slice(0, 3)
        .map(x => ({
          type: typeof x.type === 'string' ? x.type.slice(0, 24) : null,
          status: typeof x.s === 'string' ? x.s.slice(0, 16) : null,
          code: x.code == null ? null : String(x.code).slice(0, 24),
          message: typeof x.message === 'string' ? x.message.replace(/\s+/g, ' ').slice(0, 120) : null
        }));
      if (controlFrames.length) {
        console.log('FYERS socket control frame:', JSON.stringify(controlFrames));
      }
      const acceptedCount = parseTick(parsedMessage);
      if (acceptedCount > 0) {
        const summary = frames.filter(x => x && typeof x === 'object' && allowedSymbols.includes(x.symbol || x.n))
          .filter(x => shouldLogSocketDiagnostic(lastTickDiagnosticAt, x.symbol || x.n))
          .slice(0, 5)
          .map(x => {
            const exchangeTime = epochSeconds(x.exch_feed_time ?? x.last_traded_time ?? x.ltt ?? x.tt ?? x.v?.exch_feed_time ?? x.v?.last_traded_time ?? x.v?.ltt ?? x.v?.tt);
            const ageSeconds = exchangeTime ? Number(((Date.now() / 1000) - exchangeTime).toFixed(1)) : null;
            return {
              symbol: x.symbol || x.n,
              exchangeTimestampPresent: Boolean(exchangeTime),
              exchangeTimestamp: exchangeTime ? new Date(exchangeTime * 1000).toISOString() : null,
              exchangeAgeSeconds: ageSeconds,
              freshness: ageSeconds === null || ageSeconds < 0 ? 'TIME_UNVERIFIED' : ageSeconds <= 30 ? 'FRESH' : 'STALE'
            };
          });
        if (summary.length) {
          console.log('FYERS verified index tick accepted:', JSON.stringify({ acceptedCount, ticks: summary }));
        }
      } else {
        const indexLike = frames.filter(x => x && typeof x === 'object' && allowedSymbols.includes(x.symbol || x.n))
          .filter(x => shouldLogSocketDiagnostic(lastRejectedDiagnosticAt, x.symbol || x.n));
        if (indexLike.length) {
          console.warn('FYERS index frame rejected by tick validation:', JSON.stringify(indexLike.slice(0, 5).map(x => ({
            symbol: x.symbol || x.n,
            type: x.type || null,
            hasLtp: x.ltp != null || x.lp != null || x.v?.lp != null,
            hasExchangeTimestamp: Boolean(epochSeconds(x.exch_feed_time ?? x.last_traded_time ?? x.ltt ?? x.tt ?? x.v?.exch_feed_time ?? x.v?.last_traded_time ?? x.v?.ltt ?? x.v?.tt))
          }))));
        }
      }
    });
    socket.on('error', error => {
      if (marketSocket !== socket) return;
      // FYERS SDK error events are not proof that the transport has closed.
      // Keep the connection state until the close event or verified tick
      // freshness says otherwise; liveSnapshot() remains fail-closed.
      const detail = error && typeof error === 'object'
        ? error
        : { message: String(error ?? 'Unknown socket error') };
      const code = detail.code ?? detail.statusCode ?? detail.status ?? detail.response?.status ?? null;
      const message = String(detail.message ?? detail.error ?? detail.reason ?? 'Unspecified FYERS SDK socket error')
        .replace(/\s+/g, ' ').slice(0, 240);
      recordDiagnostic('warn', 'market_socket_error', {
        code: code == null ? null : String(code).slice(0, 40),
        message,
        transportState: streamConnected ? 'connected-awaiting-close-or-freshness-check' : 'not-connected'
      });
      console.warn('FYERS market socket error event; transport state retained until close/freshness check:', JSON.stringify({
        code: code == null ? null : String(code).slice(0, 40),
        statusCode: detail.statusCode ?? detail.response?.status ?? null,
        message,
        transportState: streamConnected ? 'connected' : 'not-connected'
      }));
    });
    socket.on('close', (code, reason) => {
      if (marketSocket !== socket) return;
      streamConnected = false;
      const safeReason = reason == null ? '' : String(reason).slice(0, 160);
      streamError = 'FYERS market socket disconnected; automatic recovery is in progress.';
      nseReconnectPending = true;
      marketSocketLastCloseAt = Date.now();
      console.warn('NSE socket disconnected, reconnecting...', JSON.stringify({
        generation: socketGeneration, tokenFingerprint: requestedFingerprint,
        code: code ?? null,
        reason: safeReason || null,
        closedAt: new Date(marketSocketLastCloseAt).toISOString(),
        connectedDurationSeconds: marketSocketConnectedAt ? Number(((marketSocketLastCloseAt - marketSocketConnectedAt) / 1000).toFixed(1)) : null,
        sdkAutoReconnect: true,
        retryPolicy: 'fyers-sdk-autoReconnect',
        retryLimit: SDK_RECONNECT_RETRIES,
        nseHeartbeatMs: NSE_TICK_HEARTBEAT_MS
      }));
    });
    // Add one official MCX diagnostic contract to this same SDK socket.
    // MCX never enters NSE snapshots, Sureshot ranking, option logic, or orders.
    void loadMcxDiagnosticInstrument().then(instrument => {
      if (!instrument || marketSocket !== socket || !streamConnected || mcxSubscribedSocket === socket) return;
      try {
        socket.subscribe([instrument.symbol]);
        mcxSubscribedSocket = socket;
        console.log('FYERS MCX diagnostic subscription requested on existing socket.', JSON.stringify({
          symbol: instrument.symbol, exchange: 'MCX', socketInstance: 'shared-existing'
        }));
      } catch (error) {
        console.warn('FYERS MCX diagnostic subscription failed:', String(error?.message || error).slice(0, 180));
      }
    });
    // Exactly one reconnect owner: FYERS SDK autoReconnect. Do not run a
    // second application-level connect timer alongside it.
    socket.connect();
  } catch (error) {
    streamConnected = false;
    if (isExpiredFyersAccessTokenError(error)) {
      // Do not report a restored-but-expired PostgreSQL token as authenticated.
      // Keep the encrypted DB record untouched; a successful OAuth exchange
      // replaces it after the user reconnects FYERS.
      accessToken = '';
      authenticatedAt = null;
      streamError = 'Saved FYERS session expired; reconnect FYERS to restore live data.';
      recordDiagnostic('warn', 'fyers_persisted_token_expired', { reconnectRequired: true });
      console.warn('Saved FYERS access token is expired; in-memory session cleared and fresh OAuth login is required.');
    } else {
      streamError = 'Could not start the FYERS market data socket; controlled recovery is pending.';
    }
    console.error('FYERS market socket startup failed:', String(error?.message || error).slice(0, 240));
    // A startup exception is different from an ordinary SDK close/reconnect.
    // Release only this failed socket so a later auth/start attempt can retry;
    // never clear a newer socket that may have replaced it in the meantime.
    if (socket && marketSocket === socket) {
      marketSocket = null;
      marketSocketToken = '';
      try { socket.close(); } catch {}
    }
  }
}

// NSE feed heartbeat: MCX/BSE ticks do not count as proof that NSE index
// subscriptions are alive. After 10 seconds without a fresh exchange-timestamped
// NSE tick, re-apply only NSE subscriptions on the existing FYERS Data Socket.
// Actual transport closes use the SDK auto-reconnect controller.
const marketSocketWatchdog = setInterval(() => {
  if (!accessToken || !marketSocket || !nseRegularSessionNow()) return;
  const now = Date.now();
  const staleNseAgesMs = nseIndexSymbols.map(symbol => {
    const tick = latestTicks.get(symbol);
    const tickAt = tick ? Date.parse(tick.updatedAt) : marketSocketConnectedAt;
    if (!Number.isFinite(tickAt) || tickAt <= 0) return Infinity;
    const ageMs = now - tickAt;
    return ageMs < 0 ? Infinity : ageMs;
  });
  const silentForMs = staleNseAgesMs.length ? Math.max(...staleNseAgesMs) : Infinity;
  const retryDelayMs = getMarketSocketReconnectDelay(nseResubscribeCount, 10_000, 120_000);
  if (silentForMs < NSE_TICK_HEARTBEAT_MS || now - lastNseResubscribeAt < retryDelayMs) return;
  nseReconnectPending = true;
  lastNseResubscribeAt = now;
  nseResubscribeCount += 1;
  try {
    if (streamConnected && marketSocket && typeof marketSocket.subscribe === 'function') {
      marketSocket.mode(marketSocket.FullMode);
      marketSocket.subscribe(nseIndexSymbols);
      streamError = 'NSE feed is reconnecting after 10 seconds without a fresh exchange tick.';
      console.warn('NSE socket disconnected, reconnecting...', JSON.stringify({
        reason: 'no_fresh_nse_tick_within_10_seconds', silentForMs,
        retry: nseResubscribeCount, nextRetryDelayMs: getMarketSocketReconnectDelay(nseResubscribeCount, 10_000, 120_000),
        recovery: 'reapply_nse_subscriptions_on_existing_shared_socket',
        transportConnected: true, symbols: nseIndexSymbols
      }));
    } else {
      streamError = 'NSE socket disconnected; FYERS SDK auto-reconnect is in progress.';
      console.warn('NSE socket disconnected, reconnecting...', JSON.stringify({
        reason: 'socket_transport_not_connected', silentForMs,
        retry: nseResubscribeCount, nextRetryDelayMs: getMarketSocketReconnectDelay(nseResubscribeCount, 10_000, 120_000),
        recovery: 'fyers_sdk_auto_reconnect'
      }));
    }
  } catch (error) {
    streamError = 'NSE subscription recovery failed; automatic retry remains active.';
    console.error('NSE socket disconnected, reconnecting... subscription recovery failed:', String(error?.message || error).slice(0, 200));
  }
}, 1_000);
marketSocketWatchdog.unref?.();

// MCX-only silence watchdog. It never closes/reconnects the transport and never
// changes NSE subscription state. On a healthy shared transport it re-applies
// only the official MCX diagnostic contract after 10 seconds without a fresh tick.
const mcxMarketSocketWatchdog = setInterval(() => {
  if (!accessToken || !marketSocket || !mcxDiagnosticInstrument ||
      getExchangeSessionWindows().MCX?.session !== 'SCHEDULED_OPEN') return;
  const now = Date.now();
  if (!streamConnected || typeof marketSocket.subscribe !== 'function') return;
  const tickAt = mcxDiagnosticTick ? Date.parse(mcxDiagnosticTick.updatedAt) : marketSocketConnectedAt;
  const silentForMs = Number.isFinite(tickAt) && tickAt > 0 ? Math.max(0, now - tickAt) : Infinity;
  const retryDelayMs = getMcxWatchdogRetryDelay(mcxResubscribeCount);
  if (silentForMs < MCX_TICK_HEARTBEAT_MS || now - lastMcxResubscribeAt < retryDelayMs) return;
  lastMcxResubscribeAt = now;
  mcxResubscribeCount += 1;
  try {
    marketSocket.mode(marketSocket.FullMode);
    marketSocket.subscribe([mcxDiagnosticInstrument.symbol]);
    mcxSubscribedSocket = marketSocket;
    console.warn('MCX feed watchdog re-applied MCX-only subscription after 10 seconds without a fresh exchange tick.', JSON.stringify({
      reason: 'no_fresh_mcx_tick_within_10_seconds', silentForMs,
      retry: mcxResubscribeCount, nextRetryDelayMs: getMcxWatchdogRetryDelay(mcxResubscribeCount),
      recovery: 'mcx_only_resubscribe_on_existing_transport',
      transportConnected: true, symbol: mcxDiagnosticInstrument.symbol
    }));
  } catch (error) {
    console.error('MCX-only subscription recovery failed; retry remains scheduled:', String(error?.message || error).slice(0, 200));
  }
}, 1_000);
mcxMarketSocketWatchdog.unref?.();

function nseRegularSessionNow() {
  return getNseSessionWindow().isRegularHours;
}

function epochSeconds(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

function liveSnapshot() {
  const ticks = allowedSymbols.map(symbol => latestTicks.get(symbol));
  if (ticks.some(tick => !tick)) return null;
  const now = Date.now();
  if (ticks.some(tick => quoteTimestampStatus(Date.parse(tick.updatedAt) / 1000, now, 30) !== 'FRESH')) return null;
  return {
    ok: true,
    fetchedAt: new Date(Math.max(...ticks.map(tick => Date.parse(tick.updatedAt)))).toISOString(),
    data: ticks.map(tick => ({
      n: tick.symbol,
      v: { lp: tick.ltp, tt: epochSeconds(tick.updatedAt), ...(tick.ch === null ? {} : { ch: tick.ch }), ...(tick.chp === null ? {} : { chp: tick.chp }) }
    }))
  };
}

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true, service: 'dhanpulse-backend',
    message: 'Backend is online. Check /api/status for FYERS authentication and live-data state.',
    endpoints: { health: '/health', status: '/api/status', quotes: '/api/market/quotes', candles: '/api/market/candles', movers: '/api/market/movers', optionsChain: '/api/fyers/options-chain' },
    orderPlacement: 'disabled',
    allowedOrigins: [...allowedOrigins]
  });
});

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = liveSnapshot();
  const checkedAt = Date.now();
  const nseFreshTickCount = nseIndexSymbols.filter(symbol => {
    const tick = latestTicks.get(symbol);
    return Boolean(tick && quoteTimestampStatus(Date.parse(tick.updatedAt) / 1000, checkedAt, NSE_TICK_FRESHNESS_SECONDS) === 'FRESH');
  }).length;
  const mcxTickAgeSeconds = mcxDiagnosticTick
    ? (checkedAt - Date.parse(mcxDiagnosticTick.updatedAt)) / 1000 : null;
  const mcxFeedFresh = Boolean(streamConnected && mcxSubscribedSocket === marketSocket &&
    Number.isFinite(mcxTickAgeSeconds) && mcxTickAgeSeconds >= 0 &&
    mcxTickAgeSeconds <= MCX_TICK_FRESHNESS_SECONDS);
  const nseFeedFresh = nseFreshTickCount === nseIndexSymbols.length;
  res.json({
    ok: true,
    service: 'dhanpulse-backend',
    serviceHealth: 'HEALTHY',
    fyersConfigured: Boolean(appId && appSecret && redirectUri),
    fyersAuthenticated: Boolean(accessToken),
    liveDataConnected: Boolean(streamConnected && snapshot),
    marketSocketConnected: streamConnected,
    lastTickAt: snapshot?.fetchedAt || null,
    dataReadiness: {
      NSE: {
        status: nseFeedFresh ? 'FRESH' : nseFreshTickCount > 0 ? 'PARTIAL' : 'WAITING_OR_STALE',
        freshTickCount: nseFreshTickCount,
        requiredTickCount: nseIndexSymbols.length,
        freshnessWindowSeconds: NSE_TICK_FRESHNESS_SECONDS,
        liveSignalsAllowed: nseRegularSessionNow() && nseFeedFresh
      },
      MCX: {
        status: mcxFeedFresh ? 'FRESH' : 'WAITING_OR_STALE',
        exchangeTimestamp: mcxDiagnosticTick?.updatedAt || null,
        receivedAt: mcxDiagnosticTick?.receivedAt || null,
        ageSeconds: Number.isFinite(mcxTickAgeSeconds) ? Number(mcxTickAgeSeconds.toFixed(1)) : null,
        freshnessWindowSeconds: MCX_TICK_FRESHNESS_SECONDS,
        liveSignalsAllowed: getExchangeSessionWindows().MCX?.session === 'SCHEDULED_OPEN' && mcxFeedFresh
      }
    },
    tradingDataReady: nseRegularSessionNow() ? nseFeedFresh : false,
    orderPlacementEnabled: false,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const snapshot = liveSnapshot();
  const exchangeSessions = getExchangeSessionWindows();
  const nseSymbols = allowedSymbols.filter(symbol => symbol.startsWith('NSE:'));
  const nseFreshTickCount = nseSymbols.filter(symbol => {
    const tick = latestTicks.get(symbol);
    return Boolean(tick && quoteTimestampStatus(Date.parse(tick.updatedAt) / 1000, Date.now(), NSE_TICK_FRESHNESS_SECONDS) === 'FRESH');
  }).length;
  const nseHasAnyTick = nseSymbols.some(symbol => latestTicks.has(symbol));
  const nseFeed = !accessToken ? 'NOT_CONNECTED'
    : nseReconnectPending ? 'RECONNECTING'
    : !streamConnected ? 'RECONNECTING'
    : nseFreshTickCount === nseSymbols.length ? 'LIVE'
    : nseFreshTickCount > 0 ? 'PARTIAL'
    : nseHasAnyTick ? 'STALE' : 'WAITING';
  const mcxTickAgeSeconds = mcxDiagnosticTick
    ? (Date.now() - Date.parse(mcxDiagnosticTick.updatedAt)) / 1000 : null;
  const mcxFeed = !accessToken ? 'NOT_CONNECTED'
    : !streamConnected ? 'DISCONNECTED'
    : mcxSubscribedSocket !== marketSocket ? 'SUBSCRIPTION_PENDING'
    : mcxTickAgeSeconds === null ? 'WAITING'
    : mcxTickAgeSeconds >= 0 && mcxTickAgeSeconds <= MCX_TICK_FRESHNESS_SECONDS ? 'LIVE' : 'STALE';
  res.json({
    backend: 'online', fyers: accessToken ? 'connected' : 'not-connected',
    liveData: streamConnected && snapshot ? 'streaming' : 'waiting-for-live-ticks',
    marketSocketConnected: streamConnected, authenticatedAt,
    lastTickAt: snapshot?.fetchedAt || null,
    exchangeLiveStatus: {
      NSE: {
        ...exchangeSessions.NSE, feed: nseFeed,
        freshTickCount: nseFreshTickCount, requiredTickCount: nseSymbols.length,
        live: nseFeed === 'LIVE'
      },
      MCX: {
        ...exchangeSessions.MCX, feed: mcxFeed,
        freshTickCount: mcxFeed === 'LIVE' ? 1 : 0, requiredTickCount: 1,
        live: mcxFeed === 'LIVE'
      }
    },
    mcxDiagnostic: (() => {
      const tick = mcxDiagnosticTick;
      const exchangeTime = tick ? Date.parse(tick.updatedAt) / 1000 : null;
      const ageSeconds = Number.isFinite(exchangeTime) ? Number((Date.now() / 1000 - exchangeTime).toFixed(1)) : null;
      const freshness = ageSeconds === null || ageSeconds < 0 ? 'TIME_UNVERIFIED' : ageSeconds <= MCX_TICK_FRESHNESS_SECONDS ? 'FRESH' : 'STALE';
      let status = mcxDiagnosticMasterStatus;
      if (status === 'READY') {
        if (!accessToken) status = 'FYERS_NOT_CONNECTED';
        else if (!streamConnected) status = 'SOCKET_DISCONNECTED';
        else if (mcxSubscribedSocket !== marketSocket) status = 'SUBSCRIPTION_PENDING';
        else if (!tick) status = 'WAITING_FOR_EXCHANGE_TICK';
        else status = freshness;
      }
      return {
        exchange: 'MCX', status, symbol: mcxDiagnosticInstrument?.symbol || null,
        instrument: mcxDiagnosticInstrument?.label || null,
        expiryDate: mcxDiagnosticInstrument?.expiryDate || null,
        source: mcxDiagnosticInstrument ? 'FYERS official MCX_COM symbol master' : null,
        socketConnected: streamConnected,
        subscribedOnCurrentSocket: Boolean(marketSocket && mcxSubscribedSocket === marketSocket),
        ltp: tick?.ltp ?? null, exchangeTimestamp: tick?.updatedAt || null,
        receivedAt: tick?.receivedAt || null, ageSeconds, freshness,
        signalsAllowed: false,
        note: 'Connection diagnostics only; never used by NSE Sureshot or trading signals.'
      };
    })(),
    indexTickStatus: allowedSymbols.map(symbol => {
      const tick = latestTicks.get(symbol);
      const exchangeTime = tick ? Date.parse(tick.updatedAt) / 1000 : null;
      const ageSeconds = Number.isFinite(exchangeTime) ? Number((Date.now() / 1000 - exchangeTime).toFixed(1)) : null;
      return {
        symbol,
        exchangeTimestamp: tick?.updatedAt || null,
        receivedAt: tick?.receivedAt || null,
        ageSeconds,
        freshness: ageSeconds === null || ageSeconds < 0 ? 'TIME_UNVERIFIED' : ageSeconds <= 30 ? 'FRESH' : 'STALE'
      };
    }),
    fyersDataApi: fetchWithFyersBudget.getStatus(),
    ...(streamError ? { marketDataMessage: streamError } : {}),
    orderPlacement: 'disabled',
    configCheck: { hasAppId: !!appId, hasSecret: !!appSecret, hasRedirect: !!redirectUri, redirectUri }
  });
});

function createDashboardSessionToken() {
  const keyHex = String(process.env.FYERS_TOKEN_ENCRYPTION_KEY || '').trim();
  if (fyersTokenStore.configured && /^[a-f0-9]{64}$/i.test(keyHex) && accessToken && authenticatedAt) {
    return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update(`DhanPulse/dashboard-session/v1:${accessToken}:${authenticatedAt}`)
      .digest('hex');
  }
  return crypto.randomBytes(32).toString('hex');
}

function requireDashboardSession(req, res, next) {
  // The official FYERS NSE F&O instrument master is public reference data.
  // Exempt only this read-only GET endpoint; all quotes, candles, options,
  // portfolio and signal endpoints remain protected by the dashboard session.
  if (req.method === 'GET' && req.path === '/fno-universe') return next();
  const header = String(req.get('authorization') || '');
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header);
  const token = match ? match[1] : '';
  const session = token ? dashboardSessions.get(token) : null;
  const persistedSessionValid = Boolean(token && accessToken && fyersTokenStore.configured &&
    token === createDashboardSessionToken());
  if ((!session || Date.now() - session.createdAt > DASHBOARD_SESSION_TTL_MS) && !persistedSessionValid) {
    if (token) dashboardSessions.delete(token);
    return res.status(401).json({ ok: false, error: 'Dashboard session missing or expired. Reconnect FYERS.' });
  }
  if (!session && persistedSessionValid) {
    dashboardSessions.set(token, { createdAt: Date.now(), lastSeenAt: Date.now() });
  } else if (session) {
    session.lastSeenAt = Date.now();
  }
  return next();
}

app.use('/api/market', requireDashboardSession);
app.use('/api/fyers/options-chain', requireDashboardSession);
app.use('/api/fyers/option-quote', requireDashboardSession);
app.use('/api/fyers/option-risk-plan', requireDashboardSession);
app.use('/api/fyers/funds', requireDashboardSession);
app.use('/api/fyers/holdings', requireDashboardSession);
app.use('/api/fyers/positions', requireDashboardSession);
app.use('/api/paper', requireDashboardSession);

app.get('/api/fyers/auth/start', (_req, res) => {
  if (!appId || !redirectUri) {
    return res.status(503).json({ error: 'FYERS environment settings are incomplete.', detail: { hasAppId: !!appId, hasRedirect: !!redirectUri } });
  }
  const now = Date.now();
  for (const [key, value] of pendingAuthStates) {
    if (now - value.createdAt > AUTH_STATE_TTL_MS) pendingAuthStates.delete(key);
  }
  const state = crypto.randomBytes(24).toString('hex');
  pendingAuthStates.set(state, { createdAt: now });
  const url = new URL('https://api-t1.fyers.in/api/v3/generate-authcode');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  res.set('Cache-Control', 'no-store');
  res.json({ authorizationUrl: url.toString() });
});

app.post('/api/fyers/auth/exchange', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const state = typeof req.body?.state === 'string' ? req.body.state.trim() : '';
  if (!appId || !appSecret || !redirectUri) {
    return res.status(503).json({ error: 'FYERS environment settings are incomplete.' });
  }
  if (!code || code.length > 4096) {
    return res.status(400).json({ error: 'Invalid authorization code.' });
  }
  const pending = pendingAuthStates.get(state);
  if (!state || !pending || Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) {
    if (state) pendingAuthStates.delete(state);
    return res.status(400).json({ error: 'FYERS login state is invalid or expired. Start Connect FYERS again.' });
  }
  pendingAuthStates.delete(state);
  if (fyersTokenStore.configured && !fyersTokenStoreReady) {
    return res.status(503).json({ error: 'Secure FYERS token storage is not ready. Configure DATABASE_URL and FYERS_TOKEN_ENCRYPTION_KEY, then restart the backend.' });
  }
  try {
    const appIdHash = crypto.createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
    const response = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code }),
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.s !== 'ok' || !data.access_token) {
      return res.status(401).json({ error: 'FYERS authentication failed.', detail: data.message || data.error || 'Please check FYERS settings.' });
    }
    const newAuthenticatedAt = new Date().toISOString();
    if (fyersTokenStore.configured) {
      try {
        await fyersTokenStore.save(data.access_token, newAuthenticatedAt);
      } catch (storageError) {
        console.error('FYERS token was issued but secure persistence failed; login is not activated.', storageError?.message || 'database error');
        return res.status(503).json({ error: 'FYERS token could not be securely saved. Connection was not activated; check backend database configuration.' });
      }
    }
    accessToken = data.access_token;
    authenticatedAt = newAuthenticatedAt;
    // With encrypted PostgreSQL persistence, this HMAC-derived browser session
    // remains verifiable after a backend restart without exposing the FYERS token.
    const dashboardSessionToken = createDashboardSessionToken();
    dashboardSessions.set(dashboardSessionToken, { createdAt: Date.now(), lastSeenAt: Date.now() });
    restQuoteCache = null;
    restQuoteFetchedAt = 0;
    startMarketDataStream(accessToken, 'fyers_oauth_callback');
    res.json({ ok: true, fyers: 'connected', liveData: 'connecting', dashboardSessionToken, authenticatedAt });
  } catch {
    res.status(502).json({ error: 'Could not reach FYERS authentication service.' });
  }
});

// Index quotes are served from the authenticated FYERS WebSocket only.
// Never fall back to REST polling here: the dashboard polls this route frequently,
// and REST fallback caused repeated HTTP 429s while the socket was reconnecting.
// Last-known index quotes are read-only and never treated as fresh ticks.
app.get('/api/market/last-known-quotes', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const marketOpen = nseRegularSessionNow();
  let rows = allowedSymbols.map(symbol => latestTicks.get(symbol)).filter(tick =>
    tick && Number.isFinite(Number(tick.ltp)) && Number(tick.ltp) > 0 &&
    Number.isFinite(Date.parse(tick.updatedAt))
  );
  let source = 'FYERS WebSocket last-known tick';
  if (rows.length !== allowedSymbols.length) {
    // Index display must never fall back to FYERS REST quotes. When the socket
    // has not supplied every allowed index tick, wait for WebSocket data instead
    // of re-triggering Cloudflare 1015 on each dashboard refresh.
    console.warn('FYERS WebSocket index snapshot incomplete; REST fallback suppressed.', JSON.stringify({
      received: rows.map(tick => tick.symbol),
      expected: allowedSymbols
    }));
    return res.status(503).json({
      ok: false,
      source: 'FYERS WebSocket last-known tick',
      error: 'Waiting for complete verified FYERS WebSocket index ticks; REST fallback is disabled.',
      data: rows,
      marketOpen,
      signalsAllowed: false,
      retryAfterSeconds: 5
    });
  }
  const newestTickAt = Math.max(...rows.map(tick => Date.parse(tick.updatedAt)));
  const oldestTickAt = Math.min(...rows.map(tick => Date.parse(tick.updatedAt)));
  return res.json({
    ok: true, source, streamConnected: false, marketOpen,
    fetchedAt: new Date(newestTickAt).toISOString(),
    quoteAgeSeconds: Math.max(0, Math.floor((Date.now() - oldestTickAt) / 1000)),
    data: rows.map(tick => ({ n: tick.symbol, verified: true, v: {
      lp: Number(tick.ltp), tt: epochSeconds(tick.updatedAt),
      ...(tick.ch == null ? {} : { ch: tick.ch }),
      ...(tick.chp == null ? {} : { chp: tick.chp })
    }})),
    signalsAllowed: false,
    note: 'Actual FYERS last-known exchange prices for display only. Source exchange timestamp is preserved; this response never enables live signals.'
  });
});

app.get('/api/market/quotes', async (_req, res) => {
  if (!accessToken) {
    return res.status(401).json({ ok: false, error: 'Connect FYERS first.' });
  }

  res.set('Cache-Control', 'no-store');
  const snapshot = liveSnapshot();
  if (snapshot) {
    return res.json({
      ...snapshot,
      source: streamConnected ? 'websocket' : 'websocket-recent',
      streamConnected
    });
  }

  return res.status(503).json({
    ok: false,
    error: 'Waiting for verified FYERS WebSocket ticks. REST fallback is disabled to protect rate limits.',
    detail: streamConnected
      ? 'The socket is connected, but fresh ticks for both index symbols have not arrived yet.'
      : (streamError || 'The FYERS market socket is reconnecting.'),
    retryAfterSeconds: 5,
    marketSocketConnected: streamConnected
  });
});

// The shared Data API budget is the single cooldown authority. Check its
// response cache before any upstream cooldown decision so safe cached OHLC
// remains readable while a 1015 block prevents new requests.
function invalidateFyersSession(reason) {
  if (!accessToken) return;
  accessToken = '';
  authenticatedAt = null;
  streamConnected = false;
  streamError = 'FYERS access token was rejected or expired. Reconnect FYERS.';
  latestTicks.clear();
  dashboardSessions.clear();
  fyersTokenStore.clear().catch(error => {
    console.error('Could not clear persisted FYERS token after auth rejection:', error?.message || 'database error');
  });
  const expiredSocket = marketSocket;
  marketSocket = null;
  marketSocketToken = '';
  if (expiredSocket) {
    try { expiredSocket.close(); } catch {}
  }
  recordDiagnostic('warn', 'fyers_session_invalidated', {
    reason: String(reason || 'FYERS authentication rejected').slice(0, 160)
  });
}

async function fyersReadOnlyGet(url, { priority = 'normal' } = {}) {
  // While a Sureshot scan is active, keep unrelated Data API traffic from
  // competing for the same account/IP budget. Existing in-flight reads finish;
  // Sureshot requests explicitly opt into the priority lane below.
  const scanStateIsActive = sureshotScanState &&
    Date.now() - sureshotScanState.createdAt <= SURESHOT_SCAN_TTL_MS;
  if (priority !== 'sureshot' && (sureshotAutoPlansInFlight || scanStateIsActive)) {
    const error = new Error('Sureshot full-universe scan has priority; other FYERS Data API reads are paused briefly.');
    error.statusCode = 503;
    error.retryAfterSeconds = 5;
    throw error;
  }
  if (!accessToken) {
    const error = new Error('Connect FYERS first.');
    error.statusCode = 401;
    throw error;
  }
  const requestAccessToken = accessToken;
  const response = await fetchWithFyersBudget(url, {
    method: 'GET',
    headers: { Authorization: appId + ':' + requestAccessToken, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });
  // Preserve non-JSON upstream error bodies too; some 429 gateways return an
  // empty body, which was hiding whether FYERS sent a retry hint or diagnostic.
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  const retryAfterHeader = response.headers.get('retry-after');
  if (!response.ok || data.s !== 'ok') {
    // Include safe upstream diagnostics (never credentials) so quote failures
    // can be fixed from evidence instead of guessing at permissions or symbols.
    const upstreamMessage = data.message || data.error || data.details;
    const upstreamStatus = String(data.s || 'missing');
    const upstreamCode = data.code == null ? 'n/a' : String(data.code);
    const message = upstreamMessage
      ? String(upstreamMessage).slice(0, 110)
      : (responseText ? responseText.replace(/\s+/g, ' ').slice(0, 110) : 'FYERS API returned no error message.');
    const upstreamDiagnostics = summarizeFyersUpstreamFailure({
      responseText, headers: response.headers, apiCode: data.code
    });
    const { cloudflareRayId, upstreamServer, cloudflareMitigation, cloudflareErrorCode } = upstreamDiagnostics;
    const diagnosticTags = [
      cloudflareRayId ? `CF-Ray ${cloudflareRayId}` : '',
      upstreamServer ? `server ${upstreamServer}` : '',
      cloudflareMitigation ? `cf-mitigated ${cloudflareMitigation}` : '',
      cloudflareErrorCode ? `Cloudflare error ${cloudflareErrorCode}` : ''
    ].filter(Boolean).join(', ');
    const error = new Error(`FYERS API rejected the request (HTTP ${response.status}, status ${upstreamStatus}, code ${upstreamCode}${retryAfterHeader ? `, Retry-After ${retryAfterHeader}` : ''}${diagnosticTags ? `, ${diagnosticTags}` : ''}): ${message}`.slice(0, 500));
    error.statusCode = response.status === 429 ? 429 : (response.status === 401 || data.code === -16 ? 401 : 502);
    if (isFyersAuthRejected(response.status, data.code) && accessToken === requestAccessToken) {
      invalidateFyersSession(message);
    }
    if (response.status === 429) {
      error.retryAfterSeconds = fetchWithFyersBudget.getStatus().retryAfterSeconds;
    }
    console.warn('FYERS read-only request failed:', JSON.stringify({
      path: url.pathname,
      httpStatus: response.status,
      apiStatus: upstreamStatus,
      apiCode: upstreamCode,
      retryAfter: retryAfterHeader || null,
      ...upstreamDiagnostics,
      message
    }));
    throw error;
  }
  return data;
}


app.get('/api/market/chart-quote', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const symbol = String(req.query.symbol || '');
  if (!allowedSymbols.includes(symbol) && symbol !== chartStreamSymbol) {
    return res.status(400).json({ ok: false, error: 'Symbol is not the currently selected verified chart symbol.' });
  }
  if (!streamConnected) return res.status(503).json({ ok: false, error: 'FYERS WebSocket is not connected; live candle update unavailable.' });
  const tick = latestTicks.get(symbol);
  const exchangeTime = tick ? Date.parse(tick.updatedAt) : NaN;
  const ageMs = Date.now() - exchangeTime;
  if (!tick || !Number.isFinite(Number(tick.ltp)) || Number(tick.ltp) <= 0 ||
      !Number.isFinite(exchangeTime) || ageMs < 0 || ageMs > 15000 || !nseRegularSessionNow()) {
    return res.status(409).json({ ok: false, error: 'No fresh exchange-stamped FYERS tick for this chart symbol; historical candles remain unchanged.' });
  }
  return res.json({
    ok: true,
    source: 'FYERS WebSocket',
    streamConnected: true,
    data: { symbol, price: Number(tick.ltp), exchangeTime: tick.updatedAt, ageMs }
  });
});

app.get('/api/market/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const allowed = new Set(allowedSymbols);
  if (symbol.startsWith('MCX:') && accessToken) {
    try {
      const mcxUniverse = await getMcxFnoUniverse();
      if (mcxUniverse.data.some(item => item.symbol === symbol)) allowed.add(symbol);
    } catch (error) {
      return res.status(503).json({ ok: false, error: 'Official MCX symbol master unavailable; MCX candles blocked.', detail: String(error.message || error).slice(0, 160) });
    }
  }
  if (!allowed.has(symbol) && accessToken) {
    try {
      const verifiedUniverse = await getNseFnoEquityUniverse();
      for (const item of verifiedUniverse.data) allowed.add(item.symbol);
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({
        ok: false,
        error: 'Verified NSE F&O universe unavailable; chart symbol validation blocked.',
        detail: String(error.message || error).slice(0, 160)
      });
    }
  }
  const resolution = String(req.query.resolution || '5');
  const allowedResolutions = new Set(['1', '3', '5', '15', '30', '60', 'D']);
  // FYERS candle dates are exchange-local calendar dates. Use IST rather than UTC
  // so the default range does not roll over at 00:00 UTC (05:30 IST).
  const indiaNow = new Date(Date.now() + 330 * 60 * 1000);
  const today = indiaNow.toISOString().slice(0, 10);
  const defaultLookbackDays = resolution === 'D' ? 29 : 6;
  const defaultFrom = new Date(Date.UTC(
    indiaNow.getUTCFullYear(),
    indiaNow.getUTCMonth(),
    indiaNow.getUTCDate() - defaultLookbackDays
  )).toISOString().slice(0, 10);
  const rangeFrom = String(req.query.from || defaultFrom);
  const rangeTo = String(req.query.to || today);
  if (!isAllowedChartSymbol(symbol, allowedSymbols, allowed)) return res.status(400).json({ ok: false, error: 'Unsupported candle symbol.' });
  if (!allowedResolutions.has(resolution)) return res.status(400).json({ ok: false, error: 'Unsupported candle resolution.' });
  // Keep only the selected equity chart subscribed alongside the three baseline indices.
  // Historical data can still render if the live subscription is unavailable; the UI must not claim live updates.
  if (!allowedSymbols.includes(symbol) && chartStreamSymbol !== symbol) {
    const previousChartSymbol = chartStreamSymbol;
    chartStreamSymbol = symbol;
    try {
      if (marketSocket && streamConnected) {
        if (previousChartSymbol && !allowedSymbols.includes(previousChartSymbol) &&
            typeof marketSocket.unsubscribe === 'function') {
          try { marketSocket.unsubscribe([previousChartSymbol]); } catch {}
        }
        marketSocket.subscribe([symbol]);
        console.log('FYERS selected chart symbol subscription requested:', symbol);
      }
    } catch (error) {
      console.warn('FYERS selected chart symbol subscription failed:', String(error?.message || error).slice(0, 160));
    }
  }
  if (!isValidIsoDate(rangeFrom) || !isValidIsoDate(rangeTo) || rangeFrom > rangeTo || rangeTo > today) return res.status(400).json({ ok: false, error: 'Use real calendar dates in YYYY-MM-DD format, ending no later than today (IST).' });
  const spanDays = (Date.parse(rangeTo + 'T00:00:00Z') - Date.parse(rangeFrom + 'T00:00:00Z')) / 86400000;
  if (!Number.isFinite(spanDays) || spanDays > (resolution === 'D' ? 365 : 30)) return res.status(400).json({ ok: false, error: 'Requested candle range is too large.' });
  try {
    const url = new URL('https://api-t1.fyers.in/data/history');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('resolution', resolution);
    url.searchParams.set('date_format', '1');
    url.searchParams.set('range_from', rangeFrom);
    url.searchParams.set('range_to', rangeTo);
    url.searchParams.set('cont_flag', '1');
    const result = await fyersReadOnlyGet(url);
    const candles = Array.isArray(result.candles) ? result.candles : [];
    if (candles.length === 0) {
      res.set('Cache-Control', 'no-store');
      return res.status(422).json({
        ok: false,
        error: 'FYERS returned no candles for the requested range; analysis blocked.',
        detail: 'An empty history response is not a verified chart dataset.'
      });
    }
    const isValidCandle = row => {
      if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(value => Number.isFinite(Number(value)))) return false;
      const [timestamp, open, high, low, close, volume] = row.map(Number);
      return timestamp > 0 && open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0 &&
        high >= Math.max(open, low, close) && low <= Math.min(open, high, close);
    };
    const invalidCandleCount = candles.filter(row => !isValidCandle(row)).length;
    if (invalidCandleCount > 0) {
      res.set('Cache-Control', 'no-store');
      return res.status(502).json({
        ok: false,
        error: 'FYERS returned invalid or incomplete OHLC candle rows; analysis blocked.',
        detail: 'No partial candle set was returned because invalid rows must not be silently discarded.',
        invalidCandleCount
      });
    }
    for (let i = 1; i < candles.length; i++) {
      if (Number(candles[i][0]) <= Number(candles[i - 1][0])) {
        res.set('Cache-Control', 'no-store');
        return res.status(502).json({
          ok: false,
          error: 'FYERS candle timestamps are duplicate or non-increasing; analysis blocked.',
          detail: 'No partial candle set was returned because timestamp order must be verified.'
        });
      }
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, symbol, resolution, from: rangeFrom, to: rangeTo, fetchedAt: new Date().toISOString(), data: candles });
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    const retryAfterSeconds = status === 429
      ? Math.max(1, Number(error.retryAfterSeconds) || fetchWithFyersBudget.getStatus().retryAfterSeconds || 1)
      : 0;
    if (retryAfterSeconds > 0) res.set('Retry-After', String(retryAfterSeconds));
    return res.status(status).json({
      ok: false,
      error: status === 401 ? 'Connect FYERS to load historical candles.' : 'FYERS historical-candle request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220),
      ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {})
    });
  }
});

app.get('/api/gap-analysis/history', requireDashboardSession, async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const allowed = new Set(['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'NSE:RELIANCE-EQ', 'NSE:TCS-EQ', 'NSE:INFY-EQ']);
  // Allow verified NSE F&O equities from the current FYERS symbol masters instead
  // of hard-coding five instruments. This is symbol discovery only; history data
  // still comes from FYERS and must pass OHLC/timestamp validation below.
  if (!allowed.has(symbol) && /^NSE:[A-Z0-9&-]+-EQ$/.test(symbol) && accessToken) {
    try {
      const universe = await getNseFnoEquityUniverse();
      for (const item of universe.data) if (item && typeof item.symbol === 'string') allowed.add(item.symbol);
    } catch (error) {
      return res.status(503).json({
        ok: false,
        error: 'Verified FYERS NSE F&O universe unavailable; gap analysis blocked.',
        detail: String(error.message || error).slice(0, 160)
      });
    }
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const istNow = new Date(Date.now() + 330 * 60 * 1000);
  const today = istNow.toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - 119)).toISOString().slice(0, 10);
  const from = String(req.query.from || defaultFrom);
  const to = String(req.query.to || today);
  const minGapPct = Number(req.query.minGapPct ?? 0.3);
  if (!allowed.has(symbol)) return res.status(400).json({ ok: false, error: 'Unsupported symbol for verified gap analysis.' });
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to || to > today) return res.status(400).json({ ok: false, error: 'Use real calendar dates in YYYY-MM-DD format, ending no later than today (IST).' });
  const spanDays = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
  if (!Number.isFinite(spanDays) || spanDays > 365) return res.status(400).json({ ok: false, error: 'Gap-analysis range must be 365 days or less.' });
  if (!Number.isFinite(minGapPct) || minGapPct < 0 || minGapPct > 20) return res.status(400).json({ ok: false, error: 'Minimum gap must be between 0 and 20%.' });
  try {
    const url = new URL('https://api-t1.fyers.in/data/history');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('resolution', 'D');
    url.searchParams.set('date_format', '1');
    url.searchParams.set('range_from', from);
    url.searchParams.set('range_to', to);
    url.searchParams.set('cont_flag', '1');
    const result = await fyersReadOnlyGet(url);
    const raw = Array.isArray(result.candles) ? result.candles : [];
    if (raw.some(row => !Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(value => Number.isFinite(Number(value))))) {
      return res.status(502).json({ ok: false, error: 'FYERS returned incomplete daily candles; gap analysis blocked.' });
    }
    const bars = raw.map(row => {
      const [timestamp, open, high, low, close, volume] = row.map(Number);
      const valid = timestamp > 0 && open > 0 && high >= Math.max(open, low, close) && low > 0 && low <= Math.min(open, high, close) && close > 0 && volume >= 0;
      return { timestamp: new Date(timestamp * 1000).toISOString(), open, high, low, close, volume, verified: valid };
    });
    if (bars.some(bar => !bar.verified)) return res.status(502).json({ ok: false, error: 'FYERS OHLC validation failed; no gap result returned.' });
    bars.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (bars.length < 2) return res.status(422).json({ ok: false, error: 'At least two verified daily candles are required.', candleCount: bars.length });
    for (let i = 1; i < bars.length; i++) {
      if (Date.parse(bars[i].timestamp) <= Date.parse(bars[i - 1].timestamp)) {
        return res.status(502).json({ ok: false, error: 'Duplicate or non-increasing daily candle timestamps; gap analysis blocked.' });
      }
    }
    const istDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const completedBars = bars.filter(bar => istDate(bar.timestamp) < today);
    const latest = bars.at(-1);
    const previous = bars.at(-2);
    const latestGap = analyzeOpeningGap({ previousClose: previous.close, todayOpen: latest.open });
    if (completedBars.length < 2) return res.status(422).json({ ok: false, error: 'Two completed sessions are required for historical gap-fill statistics.', candleCount: bars.length, latestSession: { timestamp: latest.timestamp, gap: latestGap } });
    const historical = summarizeHistoricalGaps(completedBars, { minAbsGapPct: minGapPct });
    res.set('Cache-Control', 'no-store').json({
      ok: true, symbol, source: 'FYERS historical daily candles', fetchedAt: new Date().toISOString(),
      range: { from, to }, candleCount: bars.length, completedCandleCount: completedBars.length,
      latestSession: { timestamp: latest.timestamp, previousClose: previous.close, open: latest.open, high: latest.high, low: latest.low, close: latest.close, gap: latestGap,
        note: 'Latest session is shown separately. Historical fill statistics exclude the current IST session.' },
      historical,
      warning: 'Historical gap-fill rate is descriptive, not predictive. It does not create a trade signal or infer participant intent.'
    });
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    return res.status(status).json({ ok: false, error: status === 429 ? 'FYERS historical-data cooldown active; wait before retrying.' : status === 401 ? 'FYERS session expired; reconnect.' : 'Gap analysis could not be verified.', detail: String(error.message || 'Historical data request failed.').slice(0, 220) });
  }
});


const MOVERS_CACHE_TTL_MS = 60000;
const MOVERS_BATCH_SIZE = 50;
let moversSnapshotCache = null;
let moversSnapshotInFlight = null;

// NSE equity-derivatives underlyings, configured from the exchange's published
// F&O list and newer additions. FYERS symbol availability is checked per row;
// missing/renamed contracts are reported as unavailable rather than fabricated.
const configuredMoversSymbols = [
  "NSE:360ONE-EQ", "NSE:ABB-EQ", "NSE:ABCAPITAL-EQ", "NSE:ADANIENSOL-EQ", "NSE:ADANIENT-EQ", "NSE:ADANIGREEN-EQ", "NSE:ADANIPORTS-EQ", "NSE:ADANIPOWER-EQ", "NSE:ALKEM-EQ", "NSE:AMBER-EQ", "NSE:AMBUJACEM-EQ", "NSE:ANGELONE-EQ", "NSE:APLAPOLLO-EQ", "NSE:APOLLOHOSP-EQ", "NSE:APOLLOTYRE-EQ", "NSE:ASHOKLEY-EQ", "NSE:ASIANPAINT-EQ", "NSE:ASTRAL-EQ", "NSE:ATUL-EQ", "NSE:AUBANK-EQ", "NSE:AUROPHARMA-EQ", "NSE:AXISBANK-EQ", "NSE:BAJAJ-AUTO-EQ", "NSE:BAJFINANCE-EQ", "NSE:BAJAJFINSV-EQ", "NSE:BAJAJHLDNG-EQ", "NSE:BALKRISIND-EQ", "NSE:BALRAMCHIN-EQ", "NSE:BANDHANBNK-EQ", "NSE:BANKBARODA-EQ", "NSE:BANKINDIA-EQ", "NSE:BATAINDIA-EQ", "NSE:BERGEPAINT-EQ", "NSE:BEL-EQ", "NSE:BHARATFORG-EQ", "NSE:BHEL-EQ", "NSE:BPCL-EQ", "NSE:BHARTIARTL-EQ", "NSE:BIOCON-EQ", "NSE:BSOFT-EQ", "NSE:BOSCHLTD-EQ", "NSE:BRITANNIA-EQ", "NSE:CANFINHOME-EQ", "NSE:CANBK-EQ", "NSE:CHAMBLFERT-EQ", "NSE:CHOLAFIN-EQ", "NSE:CIPLA-EQ", "NSE:CUB-EQ", "NSE:COALINDIA-EQ", "NSE:COFORGE-EQ", "NSE:COLPAL-EQ", "NSE:CONCOR-EQ", "NSE:COROMANDEL-EQ", "NSE:CROMPTON-EQ", "NSE:CUMMINSIND-EQ", "NSE:DABUR-EQ", "NSE:DALBHARAT-EQ", "NSE:DEEPAKNTR-EQ", "NSE:DELHIVERY-EQ", "NSE:DEVYANI-EQ", "NSE:DLF-EQ", "NSE:LALPATHLAB-EQ", "NSE:DRREDDY-EQ", "NSE:EICHERMOT-EQ", "NSE:ESCORTS-EQ", "NSE:EXIDEIND-EQ", "NSE:GAIL-EQ", "NSE:GLENMARK-EQ", "NSE:GMRINFRA-EQ", "NSE:GODREJCP-EQ", "NSE:GODREJPROP-EQ", "NSE:GRANULES-EQ", "NSE:GRASIM-EQ", "NSE:GUJGASLTD-EQ", "NSE:HAVELLS-EQ", "NSE:HCLTECH-EQ", "NSE:HDFCAMC-EQ", "NSE:HDFCBANK-EQ", "NSE:HDFCLIFE-EQ", "NSE:HEROMOTOCO-EQ", "NSE:HINDALCO-EQ", "NSE:HAL-EQ", "NSE:HINDCOPPER-EQ", "NSE:HINDPETRO-EQ", "NSE:HINDUNILVR-EQ", "NSE:ICICIBANK-EQ", "NSE:ICICIGI-EQ", "NSE:ICICIPRULI-EQ", "NSE:IDFCFIRSTB-EQ", "NSE:INDIAMART-EQ", "NSE:IEX-EQ", "NSE:IOC-EQ", "NSE:IRCTC-EQ", "NSE:IGL-EQ", "NSE:INDUSTOWER-EQ", "NSE:INDUSINDBK-EQ", "NSE:NAUKRI-EQ", "NSE:INFY-EQ", "NSE:INTELLECT-EQ", "NSE:INDIGO-EQ", "NSE:IPCALAB-EQ", "NSE:ITC-EQ", "NSE:JINDALSTEL-EQ", "NSE:JKCEMENT-EQ", "NSE:JSWSTEEL-EQ", "NSE:JUBLFOOD-EQ", "NSE:KOTAKBANK-EQ", "NSE:LTTS-EQ", "NSE:LTIM-EQ", "NSE:LT-EQ", "NSE:LAURUSLABS-EQ", "NSE:LICHSGFIN-EQ", "NSE:LUPIN-EQ", "NSE:MGL-EQ", "NSE:M&MFIN-EQ", "NSE:M&M-EQ", "NSE:MANAPPURAM-EQ", "NSE:MARICO-EQ", "NSE:MARUTI-EQ", "NSE:MFSL-EQ", "NSE:METROPOLIS-EQ", "NSE:MOTHERSON-EQ", "NSE:MPHASIS-EQ", "NSE:MRF-EQ", "NSE:MCX-EQ", "NSE:MUTHOOTFIN-EQ", "NSE:NATIONALUM-EQ", "NSE:NAVINFLUOR-EQ", "NSE:NESTLEIND-EQ", "NSE:NMDC-EQ", "NSE:NTPC-EQ", "NSE:OBEROIRLTY-EQ", "NSE:ONGC-EQ", "NSE:OFSS-EQ", "NSE:PAGEIND-EQ", "NSE:PERSISTENT-EQ", "NSE:PETRONET-EQ", "NSE:PIIND-EQ", "NSE:PIDILITIND-EQ", "NSE:PEL-EQ", "NSE:POLYCAB-EQ", "NSE:PFC-EQ", "NSE:POWERGRID-EQ", "NSE:PNB-EQ", "NSE:PVRINOX-EQ", "NSE:RAIN-EQ", "NSE:RBLBANK-EQ", "NSE:RECLTD-EQ", "NSE:RELIANCE-EQ", "NSE:SBICARD-EQ", "NSE:SBILIFE-EQ", "NSE:SHREECEM-EQ", "NSE:SHRIRAMFIN-EQ", "NSE:SIEMENS-EQ", "NSE:SRF-EQ", "NSE:SBIN-EQ", "NSE:SAIL-EQ", "NSE:SUNPHARMA-EQ", "NSE:SUNTV-EQ", "NSE:SYNGENE-EQ", "NSE:TATACHEM-EQ", "NSE:TATACOMM-EQ", "NSE:TCS-EQ", "NSE:TATACONSUM-EQ", "NSE:TATAMOTORS-EQ", "NSE:TATAPOWER-EQ", "NSE:TATASTEEL-EQ", "NSE:TECHM-EQ", "NSE:FEDERALBNK-EQ", "NSE:INDHOTEL-EQ", "NSE:RAMCOCEM-EQ", "NSE:TITAN-EQ", "NSE:TORNTPHARM-EQ", "NSE:TRENT-EQ", "NSE:TVSMOTOR-EQ", "NSE:ULTRACEMCO-EQ", "NSE:UBL-EQ", "NSE:MCDOWELL-N-EQ", "NSE:UPL-EQ", "NSE:VEDL-EQ", "NSE:IDEA-EQ", "NSE:VOLTAS-EQ", "NSE:WHIRLPOOL-EQ", "NSE:WIPRO-EQ", "NSE:ZEEL-EQ", "NSE:ZYDUSLIFE-EQ", "NSE:ANANDRATHI-EQ", "NSE:ATHERENERG-EQ", "NSE:DMART-EQ", "NSE:BSE-EQ", "NSE:BLUESTARCO-EQ", "NSE:MAHABANK-EQ", "NSE:BDL-EQ", "NSE:ETERNAL-EQ", "NSE:SWIGGY-EQ", "NSE:HYUNDAI-EQ", "NSE:OLAELEC-EQ", "NSE:INOXWIND-EQ", "NSE:IREDA-EQ", "NSE:HUDCO-EQ", "NSE:PRESTIGE-EQ", "NSE:UNOMINDA-EQ", "NSE:TIINDIA-EQ", "NSE:SONACOMS-EQ", "NSE:INDIANB-EQ", "NSE:MAZDOCK-EQ", "NSE:COCHINSHIP-EQ", "NSE:GRSE-EQ", "NSE:IRFC-EQ", "NSE:RVNL-EQ", "NSE:RAILTEL-EQ", "NSE:NBCC-EQ", "NSE:IRCON-EQ", "NSE:RITES-EQ", "NSE:POWERINDIA-EQ", "NSE:SUZLON-EQ", "NSE:NYKAA-EQ", "NSE:LODHA-EQ", "NSE:PHOENIXLTD-EQ", "NSE:MAXHEALTH-EQ", "NSE:MEDANTA-EQ", "NSE:NUVAMA-EQ", "NSE:KFINTECH-EQ", "NSE:CAMS-EQ", "NSE:CDSL-EQ", "NSE:LICI-EQ", "NSE:IDBI-EQ", "NSE:UNIONBANK-EQ", "NSE:CESC-EQ", "NSE:HFCL-EQ", "NSE:YESBANK-EQ", "NSE:INDIANHOTEL-EQ", "NSE:JKLAKSHMI-EQ", "NSE:KEI-EQ", "NSE:KEC-EQ", "NSE:ACC-EQ", "NSE:ABBOTTINDIA-EQ", "NSE:AARTIIND-EQ", "NSE:ABFRL-EQ", "NSE:DIXON-EQ", "NSE:GNFC-EQ"
];
let moversSymbols = [...configuredMoversSymbols];
let moversUniverseSource = 'configured-fallback';
let moversMasterUpdatedAt = null;
let moversMasterNextRefreshAt = 0;
let moversMasterRefreshInFlight = null;
const MOVERS_MASTER_REFRESH_MS = 24 * 60 * 60 * 1000;
const MOVERS_MASTER_RETRY_MS = 5 * 60 * 1000;

// Refresh the stock universe from FYERS' daily symbol masters. Keep the known
// list as a safe fallback if either master is unavailable or validation fails.
async function refreshMoversUniverse() {
  if (Date.now() < moversMasterNextRefreshAt) return;
  if (moversMasterRefreshInFlight) return moversMasterRefreshInFlight;

  moversMasterRefreshInFlight = (async () => {
    try {
      const [foResponse, cmResponse] = await Promise.all([
        fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json', { signal: AbortSignal.timeout(12000) }),
        fetch('https://public.fyers.in/sym_details/NSE_CM_sym_master.json', { signal: AbortSignal.timeout(12000) })
      ]);
      if (!foResponse.ok || !cmResponse.ok) throw new Error('FYERS symbol master download failed.');
      const [foMaster, cmMaster] = await Promise.all([foResponse.json(), cmResponse.json()]);
      if (!foMaster || typeof foMaster !== 'object' || !cmMaster || typeof cmMaster !== 'object') {
        throw new Error('FYERS symbol master format was invalid.');
      }

      const cashSymbols = new Map();
      for (const [ticker, item] of Object.entries(cmMaster)) {
        const match = /^NSE:([A-Z0-9&-]+)-EQ$/.exec(ticker);
        if (match && item?.tradeStatus === 1) cashSymbols.set(match[1], ticker);
      }

      const underlyingSymbols = new Set();
      for (const [ticker, item] of Object.entries(foMaster)) {
        if (!ticker.startsWith('NSE:') || item?.tradeStatus !== 1) continue;
        const isOption = item?.optType === 'CE' || item?.optType === 'PE';
        const isFuture = /FUT$/.test(ticker);
        if (!isOption && !isFuture) continue;
        const underlying = String(item?.underSym || '').trim().toUpperCase();
        if (underlying && cashSymbols.has(underlying)) underlyingSymbols.add(underlying);
      }

      const dynamicSymbols = [...underlyingSymbols]
        .map(symbol => cashSymbols.get(symbol))
        .sort();
      // A suspiciously small master should never replace the known fallback.
      if (dynamicSymbols.length < 180) {
        throw new Error('FYERS symbol master validation failed: too few NSE F&O equity underlyings.');
      }

      const previousSymbols = moversSymbols.join(',');
      moversSymbols = dynamicSymbols;
      moversUniverseSource = 'FYERS_NSE_FO_SYMBOL_MASTER';
      moversMasterUpdatedAt = new Date().toISOString();
      moversMasterNextRefreshAt = Date.now() + MOVERS_MASTER_REFRESH_MS;
      if (previousSymbols !== moversSymbols.join(',')) moversSnapshotCache = null;
      console.log('FYERS NSE F&O universe refreshed:', JSON.stringify({
        symbols: moversSymbols.length,
        source: moversUniverseSource,
        updatedAt: moversMasterUpdatedAt
      }));
    } catch (error) {
      moversMasterNextRefreshAt = Date.now() + MOVERS_MASTER_RETRY_MS;
      console.warn('FYERS symbol master refresh failed; using last valid universe:', String(error?.message || error).slice(0, 180));
    }
  })();

  try {
    await moversMasterRefreshInFlight;
  } finally {
    moversMasterRefreshInFlight = null;
  }
}
let institutionalFlowCache = null;
let institutionalFlowCacheAt = 0;
let institutionalFlowInFlight = null;
const INSTITUTIONAL_FLOW_CACHE_MS = 10 * 60 * 1000;

app.get("/api/market/institutional-flow", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (institutionalFlowCache && Date.now() - institutionalFlowCacheAt < INSTITUTIONAL_FLOW_CACHE_MS) {
    return res.json({ ...institutionalFlowCache, cacheAgeSeconds: Math.floor((Date.now() - institutionalFlowCacheAt) / 1000) });
  }
  if (institutionalFlowInFlight) {
    try { return res.json(await institutionalFlowInFlight); }
    catch { return res.status(502).json({ ok: false, error: "Official NSE institutional flow is temporarily unavailable; figures withheld.", signalsAllowed: false }); }
  }
  institutionalFlowInFlight = (async () => {
    const response = await fetchWithFyersBudget("https://www.nseindia.com/api/fiidiiTradeReact", {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://www.nseindia.com/reports/fii-dii",
        "Accept-Language": "en-IN,en;q=0.9"
      },
      signal: AbortSignal.timeout(12000)
    }).then(async response => {
      if (!response.ok) throw new Error("nse_official_endpoint_http_" + response.status);
      return normalizeInstitutionalFlow(await response.json(), new Date().toISOString());
    });
    return response;
  })();
  try {
    const result = await institutionalFlowInFlight;
    institutionalFlowCache = result;
    institutionalFlowCacheAt = Date.now();
    return res.json({ ...result, cacheAgeSeconds: 0 });
  } catch (error) {
    console.warn("Official NSE institutional flow unavailable:", String(error.message || error).slice(0, 120));
    return res.status(502).json({
      ok: false,
      source: "NSE India official FII/FPI & DII report",
      sourceUrl: "https://www.nseindia.com/reports/fii-dii",
      error: "Official NSE data could not be verified. Figures withheld; open the official report directly.",
      signalsAllowed: false
    });
  } finally {
    institutionalFlowInFlight = null;
  }
});

let fnoUniverseCache = { fetchedAt: 0, data: null };
let fnoUniversePromise = null;
let fnoUniverseFailureCount = 0;
let fnoUniverseRetryAt = 0;
let fnoUniverseLastError = '';
let mcxFnoUniverseCache = { fetchedAt: 0, data: null, master: null };
let mcxFnoUniversePromise = null;
function buildCurrentMcxFnoUniverse(master, fetchedAt) {
  const data = buildMcxFuturesUniverse(master, Date.now());
  return { source: 'FYERS MCX_COM symbol master', fetchedAt: new Date(fetchedAt).toISOString(),
    count: data.length, data, sessionFilteredAt: new Date().toISOString() };
}
async function getMcxFnoUniverse() {
  if (mcxFnoUniverseCache.master && Date.now() - mcxFnoUniverseCache.fetchedAt < 24 * 60 * 60 * 1000) {
    // Re-evaluate tradingSession fields on every request. Do not cache an
    // evening-only universe into the next morning (or vice versa).
    return buildCurrentMcxFnoUniverse(mcxFnoUniverseCache.master, mcxFnoUniverseCache.fetchedAt);
  }
  if (mcxFnoUniversePromise) return mcxFnoUniversePromise;
  mcxFnoUniversePromise = (async () => {
    // Reuse the same official master request/cache as the connection diagnostic;
    // never download the large MCX master twice in parallel.
    const master = await loadOfficialMcxSymbolMaster();
    const fetchedAt = mcxOfficialMasterFetchedAt;
    mcxFnoUniverseCache = { fetchedAt, data: null, master };
    const result = buildCurrentMcxFnoUniverse(master, fetchedAt);
    console.log('FYERS MCX F&O universe loaded:', JSON.stringify({ count: result.count, source: result.source }));
    return result;
  })();
  try { return await mcxFnoUniversePromise; } finally { mcxFnoUniversePromise = null; }
}
async function getMcxOptionContractMetadata(symbol) {
  const universe = await getMcxFnoUniverse();
  const master = mcxFnoUniverseCache.master;
  const metadata = resolveOptionContractMetadata(symbol, master);
  if (!metadata || !universe.data.some(row => row.optionContracts.some(option => option.symbol === symbol))) return null;
  return metadata;
}
let stockQuoteCache = { fetchedAt: 0, data: null };
let stockQuotePromise = null;
const STOCK_QUOTE_CACHE_MS = 30000;
const STOCK_QUOTE_BATCH_SIZE = 50;

// Contract sizing is reference data from FYERS' official NSE_FO symbol master.
// Cache once per day; never infer a lot size from the underlying or option chain.
let optionContractMasterCache = { fetchedAt: 0, data: null };
let optionContractMasterPromise = null;
async function getFyersOptionContractMetadata(symbol) {
  if (String(symbol).startsWith('MCX:')) return getMcxOptionContractMetadata(symbol);
  if (optionContractMasterCache.data && Date.now() - optionContractMasterCache.fetchedAt < 24 * 60 * 60 * 1000) {
    return resolveOptionContractMetadata(symbol, optionContractMasterCache.data);
  }
  if (!optionContractMasterPromise) {
    optionContractMasterPromise = (async () => {
      const [nseResponse, bseResponse] = await Promise.all([
        fetchWithFyersBudget("https://public.fyers.in/sym_details/NSE_FO_sym_master.json", { signal: AbortSignal.timeout(45000) }),
        fetchWithFyersBudget("https://public.fyers.in/sym_details/BSE_FO_sym_master.json", { signal: AbortSignal.timeout(45000) }).catch(() => null)
      ]);
      if (!nseResponse.ok) throw new Error("FYERS NSE_FO symbol master unavailable; lot-size risk is blocked.");
      const nseMaster = await nseResponse.json();
      if (!nseMaster || typeof nseMaster !== "object" || Array.isArray(nseMaster)) {
        throw new Error("FYERS NSE_FO symbol master format is invalid; lot-size risk is blocked.");
      }
      let bseMaster = {};
      if (bseResponse?.ok) {
        const candidate = await bseResponse.json().catch(() => null);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) bseMaster = candidate;
      }
      const master = { ...nseMaster, ...bseMaster };
      optionContractMasterCache = { fetchedAt: Date.now(), data: master };
      return master;
    })();
  }
  try {
    const master = await optionContractMasterPromise;
    return resolveOptionContractMetadata(symbol, master);
  } finally {
    optionContractMasterPromise = null;
  }
}


// Stock Explorer/movers and Sureshot must share one verified F&O snapshot.
// Otherwise switching tabs can spend the same five FYERS quote calls twice.
function syncMoversCacheFromFnoQuoteSnapshot(snapshot, symbols = moversSymbols) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.length !== moversSymbols.length ||
      symbols.some(symbol => !moversSymbols.includes(symbol))) return false;
  const payload = fnoQuoteSnapshotToMoversPayload(snapshot, symbols, Date.now());
  if (!payload) return false;
  moversSnapshotCache = { cachedAt: Date.parse(payload.fetchedAt), payload };
  return true;
}

function syncFnoQuoteCacheFromMoversPayload(payload, symbols = moversSymbols) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.length !== moversSymbols.length ||
      symbols.some(symbol => !moversSymbols.includes(symbol))) return false;
  const snapshot = moversPayloadToFnoQuoteSnapshot(payload, symbols, Date.now());
  if (!snapshot) return false;
  stockQuoteCache = { fetchedAt: Date.parse(snapshot.fetchedAt), data: snapshot };
  return true;
}
async function getNseFnoEquityUniverse() {
  if (fnoUniverseCache.data && Date.now() - fnoUniverseCache.fetchedAt < 24 * 60 * 60 * 1000) return fnoUniverseCache.data;
  if (fnoUniversePromise) return fnoUniversePromise;
  if (Date.now() < fnoUniverseRetryAt) {
    const error = new Error(fnoUniverseLastError || 'FYERS F&O symbol master retry is cooling down.');
    error.statusCode = 503;
    error.retryAfterSeconds = Math.max(1, Math.ceil((fnoUniverseRetryAt - Date.now()) / 1000));
    throw error;
  }
  fnoUniversePromise = (async () => {
    const [foResponse, cmResponse] = await Promise.all([
      fetchWithFyersBudget("https://public.fyers.in/sym_details/NSE_FO_sym_master.json", { signal: AbortSignal.timeout(45000) }),
      fetchWithFyersBudget("https://public.fyers.in/sym_details/NSE_CM_sym_master.json", { signal: AbortSignal.timeout(45000) })
    ]);
    if (!foResponse.ok || !cmResponse.ok) throw new Error("FYERS NSE_FO/NSE_CM symbol master download failed.");
    const [foMaster, cmMaster] = await Promise.all([foResponse.json(), cmResponse.json()]);
    if (!foMaster || typeof foMaster !== "object" || !cmMaster || typeof cmMaster !== "object") throw new Error("FYERS symbol master format was invalid.");
    const symbols = buildFnoEquityUniverse(foMaster, cmMaster);
    if (symbols.length < 180) {
      const error = new Error("FYERS symbol master returned an unexpectedly small F&O equity universe (" + symbols.length + " matched; refusing incomplete data).");
      error.diagnostics = { foEntries: Object.keys(foMaster).length, cmEntries: Object.keys(cmMaster).length, matchedEquities: symbols.length };
      throw error;
    }
    const result = { source: "FYERS NSE_FO + NSE_CM symbol masters", fetchedAt: new Date().toISOString(), count: symbols.length, data: symbols };
    fnoUniverseCache = { fetchedAt: Date.now(), data: result };
    fnoUniverseFailureCount = 0;
    fnoUniverseRetryAt = 0;
    fnoUniverseLastError = '';
    console.log("FYERS NSE F&O equity universe loaded:", JSON.stringify({ count: symbols.length, source: result.source }));
    return result;
  })().catch(error => {
    fnoUniverseFailureCount += 1;
    const retryDelayMs = getReferenceDataRetryDelay(fnoUniverseFailureCount);
    fnoUniverseRetryAt = Date.now() + retryDelayMs;
    fnoUniverseLastError = String(error?.message || 'FYERS F&O symbol master unavailable.').slice(0, 160);
    error.retryAfterSeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
    console.warn("FYERS NSE F&O symbol master retry backoff activated:", JSON.stringify({
      failureCount: fnoUniverseFailureCount,
      retryAfterSeconds: Math.ceil(retryDelayMs / 1000),
      reason: fnoUniverseLastError
    }));
    throw error;
  });
  try { return await fnoUniversePromise; }
  finally { fnoUniversePromise = null; }
}
// The FYERS instrument masters are public reference data, not account data.
 // Keep this discovery endpoint independent of the per-browser dashboard session:
 // chart/stock selection must remain available even when OAuth needs reconnecting.
app.get("/api/market/fno-universe", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const universe = await getNseFnoEquityUniverse();
    res.json({
      ok: true,
      source: universe.source,
      fetchedAt: universe.fetchedAt,
      count: universe.count,
      data: universe.data
    });
  } catch (error) {
    const retryAfterSeconds = Math.max(0, Number(error.retryAfterSeconds) || 0);
    if (retryAfterSeconds) res.set("Retry-After", String(retryAfterSeconds));
    console.warn("Verified F&O universe unavailable:", String(error?.message || error).slice(0, 160));
    res.status(503).json({ ok: false, error: "Verified NSE F&O universe unavailable; symbol selection blocked.",
      detail: String(error?.message || error).slice(0, 160), ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
  }
});
function sendFyersDataApiCooldown(res, extra = {}) {
  const status = fetchWithFyersBudget.getStatus();
  const retryAfterSeconds = Number(status.retryAfterSeconds) || 0;
  if (!status.cooldownActive || retryAfterSeconds <= 0) return false;
  res.set("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    ok: false,
    error: "FYERS Data API cooldown active; no upstream request was sent.",
    retryAfterSeconds,
    ...extra
  });
  return true;
}
async function loadVerifiedFnoStockQuotes({ priority = 'normal' } = {}) {
  const master = await getNseFnoEquityUniverse();
  const symbols = master.data.map(item => item.symbol);
  const now = Date.now();
  const data = [];
  const missingSymbols = [];
  // Sequential batches with a small pause avoid a burst of parallel quote requests.
  for (let offset = 0; offset < symbols.length; offset += STOCK_QUOTE_BATCH_SIZE) {
    const batch = symbols.slice(offset, offset + STOCK_QUOTE_BATCH_SIZE);
    const url = new URL("https://api-t1.fyers.in/data/quotes");
    url.searchParams.set("symbols", batch.join(","));
    let body;
    try {
      // Share the same /data/quotes cooldown with movers and other read-only quote
      // consumers. A separate raw fetch here used to bypass endpoint cooldown state.
      body = await fyersReadOnlyGet(url, { priority });
    } catch (error) {
      if (Number(error.statusCode) === 429) {
        console.warn("FYERS stock quotes rate-limited:", JSON.stringify({
          batchNumber: Math.floor(offset / STOCK_QUOTE_BATCH_SIZE) + 1,
          batchSize: batch.length,
          retryAfterSeconds: Number(error.retryAfterSeconds) || null
        }));
      }
      throw error;
    }
    if (body.s !== "ok" || !Array.isArray(body.d)) {
      const reason = String(body.message || body.code || "Invalid quote response").slice(0, 160);
      console.error("FYERS stock quote batch rejected:", JSON.stringify({
        batchNumber: Math.floor(offset / STOCK_QUOTE_BATCH_SIZE) + 1,
        batchSize: batch.length,
        responseStatus: body.s ?? null, reason
      }));
      const error = new Error(`FYERS quote batch ${Math.floor(offset / STOCK_QUOTE_BATCH_SIZE) + 1} failed (invalid quote payload; ${reason}).`);
      error.statusCode = 502;
      throw error;
    }
    const returned = new Set();
    for (const item of body.d) {
      if (!item || !batch.includes(item.n) || !item.v) continue;
      returned.add(item.n);
      const v = item.v;
      const lp = Number(v.lp), tt = Number(v.tt), ch = Number(v.ch), chp = Number(v.chp);
      const stamp = tt > 0 ? tt * 1000 : 0;
      if (Number.isFinite(lp) && lp > 0 && Number.isFinite(chp) && stamp > 0 && Math.abs(now - stamp) <= 30000) {
        data.push({ n: item.n, v: { lp, ch: Number.isFinite(ch) ? ch : null, chp, tt }, verified: true });
      }
    }
    for (const symbol of batch) if (!returned.has(symbol) || !data.some(item => item.n === symbol)) missingSymbols.push(symbol);
  }
  if (missingSymbols.length > 0) {
    const error = new Error(`Incomplete verified F&O quote coverage (${data.length}/${symbols.length}); partial rankings discarded.`);
    error.statusCode = 503;
    error.universeCount = symbols.length;
    error.quotedCount = data.length;
    error.missingCount = missingSymbols.length;
    throw error;
  }
  if (!data.length) {
    const error = new Error("No fresh exchange-timestamped F&O stock quotes. No stale prices shown.");
    error.statusCode = 503;
    error.universeCount = symbols.length;
    throw error;
  }
  const result = {
    ok: true, source: "FYERS quotes API", verified: true, fetchedAt: new Date().toISOString(),
    marketSession: getNseSessionWindow().isRegularHours ? "OPEN" : "CLOSED",
    freshnessLimitSeconds: 30, universe: "FYERS current NSE F&O equity symbol master",
    universeCount: symbols.length, quotedCount: data.length, data, missingSymbols
  };
  stockQuoteCache = { fetchedAt: Date.now(), data: result };
  syncMoversCacheFromFnoQuoteSnapshot(result, master.data.map(item => item.symbol));
  return result;
}
app.get("/api/market/stock-quotes", requireDashboardSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first." });

  // Reuse the last successful snapshot while its exchange timestamps remain fresh.
  let expectedQuoteSymbols;
  try {
    const quoteUniverse = await getNseFnoEquityUniverse();
    expectedQuoteSymbols = quoteUniverse.data.map(item => item.symbol);
  } catch (error) {
    return res.status(503).json({ ok: false, error: "Complete FYERS F&O universe could not be verified; quote cache reuse is blocked.",
      detail: String(error.message || "F&O universe unavailable.").slice(0, 160), partialQuotesDiscarded: true });
  }
  if (stockQuoteCache.data && Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS &&
      isCompleteFreshFnoQuoteSnapshot(stockQuoteCache.data, expectedQuoteSymbols, Date.now())) {
    return res.json({ ...stockQuoteCache.data, marketSession: getNseSessionWindow().isRegularHours ? "OPEN" : "CLOSED",
      cached: true, fetchedAt: new Date(stockQuoteCache.fetchedAt).toISOString() });
  }
  // An aging snapshot is discarded as a whole. Do not return a fresh-looking
  // subset when even one F&O symbol has a stale or missing exchange timestamp.
  if (stockQuoteCache.data) stockQuoteCache = { fetchedAt: 0, data: null };

  if (sendFyersDataApiCooldown(res, { partialQuotesDiscarded: true })) return;

  // Collapse simultaneous browser refreshes into one upstream request sequence.
  const request = stockQuotePromise || (stockQuotePromise = loadVerifiedFnoStockQuotes());
  try {
    const result = await request;
    return res.json(result);
  } catch (error) {
    const status = Number(error.statusCode) || 502;
    if (status === 429) {
      const retry = Math.max(1, Number(error.retryAfterSeconds) || fetchWithFyersBudget.getStatus().retryAfterSeconds || 1);
      res.set("Retry-After", String(retry));
      return res.status(429).json({
        ok: false, error: "FYERS Data API rate limit reached while loading the F&O universe. Partial results were discarded.",
        retryAfterSeconds: retry, partialQuotesDiscarded: true
      });
    }
    return res.status(status).json({
      ok: false,
      error: status === 401 ? "FYERS session expired; reconnect." : status === 503 ? error.message : "FYERS F&O quotes could not be verified.",
      ...(error.universeCount ? { universeCount: error.universeCount } : {}),
      ...(Number.isFinite(error.quotedCount) ? { quotedCount: error.quotedCount } : {}),
      ...(Number.isFinite(error.missingCount) ? { missingCount: error.missingCount } : {}),
      partialQuotesDiscarded: status === 503,
      detail: String(error.message || "network error").slice(0, 160)
    });
  } finally {
    if (stockQuotePromise === request) stockQuotePromise = null;
  }
});

app.get("/api/market/sureshot-shortlist", requireDashboardSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, signalsAllowed: false, error: "Connect FYERS first." });
  if (!nseRegularSessionNow()) return res.status(409).json({
    ok: false, signalsAllowed: false,
    error: "Market session is closed; no actionable Sureshot scan is available."
  });

  try {
    const universe = await getNseFnoEquityUniverse();
    if (!stockQuoteCache.data || Date.now() - stockQuoteCache.fetchedAt >= STOCK_QUOTE_CACHE_MS) {
      syncFnoQuoteCacheFromMoversPayload(moversSnapshotCache?.payload, universe.data.map(item => item.symbol));
    }
    const indexSymbols = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX"];
    const indexTicks = new Map(indexSymbols.map(symbol => [symbol, latestTicks.get(symbol)]));
    // Index ticks are optional shortlist candidates. A missing/stale index must
    // not block a complete, independently verified NSE F&O equity scan.
    let snapshot = stockQuoteCache.data &&
      Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS
      ? stockQuoteCache.data : null;
    if (!snapshot) {
      if (sendFyersDataApiCooldown(res, { signalsAllowed: false })) return;
      const request = stockQuotePromise || (stockQuotePromise = loadVerifiedFnoStockQuotes());
      try { snapshot = await request; }
      finally { if (stockQuotePromise === request) stockQuotePromise = null; }
    }

    const result = buildVerifiedSureshotShortlist({
      quoteSnapshot: snapshot, universe, indexTicks, now: Date.now(), limit: SURESHOT_CANDIDATE_SCAN_LIMIT
    });
    return res.json({
      ...result,
      marketSession: "OPEN",
      notice: "This is a verified momentum shortlist only, not an option trade signal. Each underlying still requires completed directional FYERS candles, a listed option contract, a fresh option quote and a valid >=1:2 risk plan. No orders are placed."
    });
  } catch (error) {
    const status = Number(error.statusCode) || 503;
    if (status === 429 && error.retryAfterSeconds) res.set("Retry-After", String(error.retryAfterSeconds));
    return res.status(status).json({
      ok: false, signalsAllowed: false,
      error: status === 429
        ? "FYERS rate-limit cooldown active; shortlist withheld."
        : "Complete fresh FYERS F&O + index snapshot could not be verified; shortlist withheld.",
      detail: String(error.message || "Verification failed.").slice(0, 180)
    });
  }
});

// Rank the complete FYERS F&O universe, but verify option plans only for the top 5 movers.
// Each candidate can require four Data API reads (underlying candles, option chain,
// live option quote, option candles). Five candidates bound the scan to ~20 reads
// plus the shared F&O snapshot, leaving headroom under the rolling API budget.
const SURESHOT_UNIVERSE_SCAN_LIMIT = 5;
const SURESHOT_BATCH_SIZE = 5;
const SURESHOT_SCAN_TTL_MS = 2 * 60 * 60 * 1000;
let sureshotAutoPlansInFlight = false;
let nseSureshotAutoPlansInFlight = false;
let mcxSureshotAutoPlansInFlight = false;
let sureshotScanState = null;
app.get("/api/market/sureshot-auto-plans", requireDashboardSession, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "Connect FYERS first." });
  if (!nseRegularSessionNow()) return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "Market session is closed; actionable option plans are withheld." });
  const indiaScanClock = new Date(Date.now() + 330 * 60_000);
  const indiaScanMinutes = indiaScanClock.getUTCHours() * 60 + indiaScanClock.getUTCMinutes();
  if (indiaScanMinutes < 9 * 60 + 30) return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "Sureshot final selection is blocked until 09:30 Asia/Kolkata." });
  if (nseSureshotAutoPlansInFlight) return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "An NSE Sureshot batch is already running." });
  let scanId = String(req.query.scanId || "");
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ ok: false, scanComplete: false, error: "Invalid scan offset." });
  if (scanId && (!sureshotScanState || scanId !== sureshotScanState.id ||
      Date.now() - sureshotScanState.createdAt > SURESHOT_SCAN_TTL_MS ||
      offset !== sureshotScanState.nextOffset)) {
    sureshotScanState = null;
    return res.status(409).json({ ok: false, scanComplete: false, error: "Scan cursor expired or out of sequence. Start a fresh scan." });
  }
  // If the app was backgrounded or reloaded between batches, resume the
  // server-held cursor instead of leaving the user stuck with a 409 for 30 min.
  if (!scanId && sureshotScanState && Date.now() - sureshotScanState.createdAt <= SURESHOT_SCAN_TTL_MS) {
    scanId = sureshotScanState.id;
    offset = sureshotScanState.nextOffset;
  } else if (!scanId && sureshotScanState) {
    sureshotScanState = null;
  }
  nseSureshotAutoPlansInFlight = true;
  sureshotAutoPlansInFlight = true;
  let scanStage = "LOAD_FNO_UNIVERSE";
  console.info("Sureshot scan started:", JSON.stringify({ resumed: Boolean(scanId), offset }));
  try {
    if (!scanId) {
      scanStage = "LOAD_FNO_UNIVERSE";
      const universe = await getNseFnoEquityUniverse();
      const indexSymbols = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX"];
      const indexTicks = new Map(indexSymbols.map(symbol => [symbol, latestTicks.get(symbol)]));
      const expectedQuoteSymbols = universe.data.map(item => item.symbol);
      if (!isCompleteFreshFnoQuoteSnapshot(stockQuoteCache.data, expectedQuoteSymbols, Date.now()) ||
          Date.now() - stockQuoteCache.fetchedAt >= STOCK_QUOTE_CACHE_MS) {
        syncFnoQuoteCacheFromMoversPayload(moversSnapshotCache?.payload, expectedQuoteSymbols);
      }
      scanStage = "VERIFY_FNO_QUOTES";
      let snapshot = stockQuoteCache.data && Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS &&
        isCompleteFreshFnoQuoteSnapshot(stockQuoteCache.data, expectedQuoteSymbols, Date.now())
        ? stockQuoteCache.data : null;
      if (!snapshot) {
        if (sendFyersDataApiCooldown(res, { scanComplete: false, signalsAllowed: false, stage: scanStage })) return;
        const request = stockQuotePromise || (stockQuotePromise = loadVerifiedFnoStockQuotes({ priority: "sureshot" }));
        try { snapshot = await request; } finally { if (stockQuotePromise === request) stockQuotePromise = null; }
      }
      scanStage = "RANK_FNO_UNIVERSE";
      const ranked = buildVerifiedSureshotShortlist({
        quoteSnapshot: snapshot, universe, indexTicks, now: Date.now(), limit: SURESHOT_UNIVERSE_SCAN_LIMIT
      });
      console.info("Sureshot F&O shortlist verified:", JSON.stringify({ universeCount: universe.count, quotedCount: snapshot.quotedCount, rankedCandidateCount: ranked.candidateCount, selectedForOptionVerification: ranked.data.length }));
      const moverCandidates = [...ranked.topGainers, ...ranked.topLosers]
        .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol))
        .slice(0, SURESHOT_UNIVERSE_SCAN_LIMIT)
        .map((row, index) => ({ ...row, rank: index + 1 }));
      sureshotScanState = { id: crypto.randomBytes(16).toString("hex"), createdAt: Date.now(),
        candidates: moverCandidates, topGainers: ranked.topGainers, topLosers: ranked.topLosers,
        moverBoardsComplete: ranked.moverBoardsComplete,
        rankedCandidateCount: ranked.equityCandidates.length, nextOffset: 0, results: [] };
    }
    const state = sureshotScanState;
    if (!state || state.nextOffset !== offset) return res.status(409).json({ ok: false, scanComplete: false, error: "Scan state unavailable. Start a fresh scan." });
    const indiaNow = new Date(Date.now() + 330 * 60 * 1000);
    const today = indiaNow.toISOString().slice(0, 10);
    const from = new Date(Date.UTC(indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), indiaNow.getUTCDate() - 10)).toISOString().slice(0, 10);
    const batch = state.candidates.slice(offset, offset + SURESHOT_BATCH_SIZE);
    const resultBySymbol = new Map();
    const prepared = [];

    // Stage 1: verify each selected underlying and discover its exact option
    // contract. Do not request premiums until all eligible contracts are known.
    for (const candidate of batch) {
      if (!nseRegularSessionNow()) { const error = new Error("Market session closed during scan; partial plans discarded."); error.statusCode = 409; throw error; }
      const base = { rank: candidate.rank, underlyingSymbol: candidate.symbol, underlyingType: candidate.underlyingType,
        changePct: candidate.changePct, ltp: candidate.price, lotSize: candidate.lotSize ?? null, quoteAgeSeconds: candidate.quoteAgeSeconds };
      try {
        const underlyingUrl = new URL("https://api-t1.fyers.in/data/history");
        underlyingUrl.searchParams.set("symbol", candidate.symbol); underlyingUrl.searchParams.set("resolution", "5");
        underlyingUrl.searchParams.set("date_format", "1"); underlyingUrl.searchParams.set("range_from", from);
        underlyingUrl.searchParams.set("range_to", today); underlyingUrl.searchParams.set("cont_flag", "1");
        scanStage = "VERIFY_UNDERLYING_CANDLES";
        const underlyingHistory = await fyersReadOnlyGet(underlyingUrl, { priority: "sureshot" });
        const direction = deriveVerifiedUnderlyingDirection(Array.isArray(underlyingHistory?.candles) ? underlyingHistory.candles : [], "5", Date.now(), { strictTrend: true });
        if (!direction.ok || !direction.side) {
          resultBySymbol.set(candidate.symbol, { ...base, status: "NO TRADE", reason: direction.reason || "No confirmed CE/PE direction." });
          continue;
        }

        scanStage = "DISCOVER_OPTION_CONTRACT";
        const chainUrl = new URL("https://api-t1.fyers.in/data/options-chain-v3");
        chainUrl.searchParams.set("symbol", candidate.symbol); chainUrl.searchParams.set("strikecount", "10");
        const chainResult = await fyersReadOnlyGet(chainUrl, { priority: "sureshot" });
        const discovery = normalizeOptionContractDiscovery(chainResult?.data);
        const selected = selectNearestVerifiedOptionContract({ discovery, underlyingSymbol: candidate.symbol, side: direction.side, spot: direction.spot, now: Date.now(), strikeMode: "one-otm" });
        if (!selected.ok) {
          resultBySymbol.set(candidate.symbol, { ...base, status: "NO TRADE", direction: direction.side, reason: selected.reason });
          continue;
        }

        const contractSizing = await getFyersOptionContractMetadata(selected.contract.symbol);
        if (!contractSizing) {
          resultBySymbol.set(candidate.symbol, { ...base, status: "NO TRADE", direction: direction.side, contract: selected.contract,
            reason: "Official FYERS lot size or tick size is unavailable for the selected option contract." });
          continue;
        }
        prepared.push({
          candidate, base, direction,
          contract: { ...selected.contract, lotSize: contractSizing.lotSize, tickSize: contractSizing.tickSize },
          contractSizing
        });
      } catch (error) {
        const status = Number(error.statusCode) || 0;
        if (status === 429 || status === 401) throw error;
        resultBySymbol.set(candidate.symbol, { ...base, status: "NO TRADE", reason: String(error.message || "Candidate verification failed.").slice(0, 180) });
      }
    }

    // Stage 2: fetch all selected option premiums in one live FYERS quote call.
    // This preserves per-contract exchange timestamps while replacing five
    // serial quote requests with one bounded batch (Top 5 is below FYERS' 50 limit).
    const quoteBySymbol = new Map();
    if (prepared.length) {
      try {
        scanStage = "VERIFY_OPTION_QUOTE";
        const quoteUrl = new URL("https://api-t1.fyers.in/data/quotes");
        quoteUrl.searchParams.set("symbols", prepared.map(item => item.contract.symbol).join(","));
        const quoteResult = await fyersReadOnlyGet(quoteUrl, { priority: "sureshot" });
        const quoteRows = Array.isArray(quoteResult?.d) ? quoteResult.d : (Array.isArray(quoteResult?.data) ? quoteResult.data : []);
        for (const row of quoteRows) {
          const symbol = row?.n || row?.symbol || row?.v?.symbol;
          if (symbol && prepared.some(item => item.contract.symbol === symbol)) quoteBySymbol.set(symbol, row?.v || row);
        }
      } catch (error) {
        const status = Number(error.statusCode) || 0;
        if (status === 429 || status === 401) throw error;
        for (const item of prepared) {
          resultBySymbol.set(item.candidate.symbol, { ...item.base, status: "NO TRADE", direction: item.direction.side,
            contract: item.contract, reason: String(error.message || "FYERS option quote batch could not be verified.").slice(0, 180) });
        }
      }
    }

    // Stage 3: independently validate each premium, completed option candles and
    // risk plan. A missing quote blocks only that candidate; no candidate is skipped.
    for (const item of prepared) {
      if (resultBySymbol.has(item.candidate.symbol)) continue;
      if (!nseRegularSessionNow()) { const error = new Error("Market session closed during scan; partial plans discarded."); error.statusCode = 409; throw error; }
      const { candidate, base, direction, contract, contractSizing } = item;
      const quote = quoteBySymbol.get(contract.symbol);
      if (!quote) {
        resultBySymbol.set(candidate.symbol, { ...base, status: "NO TRADE", direction: direction.side, contract,
          reason: "FYERS returned no quote for selected option contract." });
        continue;
      }
      try {
        const optionHistoryUrl = new URL("https://api-t1.fyers.in/data/history");
        optionHistoryUrl.searchParams.set("symbol", contract.symbol); optionHistoryUrl.searchParams.set("resolution", "5");
        optionHistoryUrl.searchParams.set("date_format", "1"); optionHistoryUrl.searchParams.set("range_from", from);
        optionHistoryUrl.searchParams.set("range_to", today); optionHistoryUrl.searchParams.set("cont_flag", "1");
        scanStage = "VERIFY_OPTION_CANDLES";
        const optionHistory = await fyersReadOnlyGet(optionHistoryUrl, { priority: "sureshot" });
        scanStage = "BUILD_RISK_PLAN";
        const plan = buildVerifiedSureshotTradePlan({ underlyingSymbol: candidate.symbol, direction, contract, quote,
          optionCandles: Array.isArray(optionHistory?.candles) ? optionHistory.candles : [], resolution: "5",
          lotSize: contractSizing.lotSize, tickSize: contractSizing.tickSize, riskModel: "fixed", requirePremiumRange: true, now: Date.now() });
        resultBySymbol.set(candidate.symbol, plan.ok ? { ...base, status: "VERIFIED SETUP", plan } :
          { ...base, status: "NO TRADE", direction: direction.side, contract, reason: plan.reason });
      } catch (error) {
        const status = Number(error.statusCode) || 0;
        if (status === 429 || status === 401) throw error;
        resultBySymbol.set(candidate.symbol, { ...base, status: "NO TRADE", direction: direction.side, contract,
          reason: String(error.message || "Candidate verification failed.").slice(0, 180) });
      }
    }

    const batchResults = batch.map(candidate => resultBySymbol.get(candidate.symbol) ||
      { rank: candidate.rank, underlyingSymbol: candidate.symbol, status: "NO TRADE", reason: "Candidate verification did not produce a complete result." });
    state.results.push(...batchResults);
    state.nextOffset += batchResults.length;
    const selectedCandidatesComplete = state.nextOffset >= state.candidates.length;
    const scanComplete = selectedCandidatesComplete;
    if (!scanComplete) return res.json({ ok: true, scanComplete: false, batchComplete: true,
      orderPlacement: "disabled", scanId: state.id, nextOffset: state.nextOffset,
      scannedCandidateCount: state.results.length, rankedCandidateCount: state.rankedCandidateCount,
      totalCandidateCount: state.candidates.length, batchSize: batchResults.length,
      topGainers: state.topGainers, topLosers: state.topLosers, moverBoardsComplete: state.moverBoardsComplete,
      scannedCandidates: state.results.map(item => ({
        rank: item.rank, underlyingSymbol: item.underlyingSymbol, underlyingType: item.underlyingType,
        changePct: item.changePct, ltp: item.ltp, lotSize: item.lotSize ?? null, status: item.status, direction: item.direction || null,
        reason: item.reason || null
      })) });
    const results = state.results;
    const verified = results.filter(item => item.status === "VERIFIED SETUP");
    const sessionToken = /^Bearer ([a-f0-9]{64})$/.exec(String(req.get('authorization') || ''))?.[1] || '';
    for (const item of verified) {
      const tradePlan = item.plan;
      const issued = verifiedPlanRegistry.create(sessionToken, {
        source: 'FYERS_VERIFIED',
        symbol: tradePlan.contract.symbol,
        side: tradePlan.contract.side,
        expiry: tradePlan.contract.expiryDate || tradePlan.contract.expiry,
        strike: tradePlan.contract.strike,
        lotSize: tradePlan.contract.lotSize,
        tickSize: tradePlan.contract.tickSize,
        underlyingSymbol: item.underlyingSymbol,
        plan: tradePlan.risk
      });
      item.paperPlanId = issued.planId;
      item.paperPlanExpiresAt = issued.expiresAt;
    }
    console.info("Sureshot scan completed:", JSON.stringify({ scannedCandidateCount: results.length, rankedCandidateCount: state.rankedCandidateCount, verifiedSetupCount: verified.length, stopReason: "TOP_FIVE_CANDIDATES_CHECKED" }));
    const payload = { ok: true, scanComplete: true, selectedCandidatesComplete,
      stopReason: "TOP_FIVE_CANDIDATES_CHECKED",
      signalsAllowed: verified.length > 0,
      orderPlacement: "disabled", readOnly: true, source: "FYERS only",
      rankedCandidateCount: state.rankedCandidateCount, selectedCandidateCount: state.candidates.length,
      topGainers: state.topGainers, topLosers: state.topLosers, moverBoardsComplete: state.moverBoardsComplete,
      scannedCandidateCount: results.length, verifiedSetupCount: verified.length,
      bestSetup: verified[0] || null, results,
      notice: "The complete eligible FYERS NSE F&O universe was ranked from a verified quote snapshot; all selected top-five candidates were checked independently for fresh underlying candles, contract identity, live option premium, completed option candles and T2 reward/risk >=1:2. No orders are placed." };
    sureshotScanState = null;
    return res.json(payload);
  } catch (error) {
    const status = Number(error.statusCode) || 503;
    const retryAfterSeconds = status === 429 ? Math.max(0, Number(error.retryAfterSeconds) || 0) : 0;
    if (retryAfterSeconds > 0) res.set("Retry-After", String(retryAfterSeconds));
    console.warn("Sureshot scan blocked:", JSON.stringify({ stage: scanStage, status, retryAfterSeconds: retryAfterSeconds || null, detail: String(error.message || "Verification failed.").slice(0, 180) }));
    // Keep the server-held cursor on a provider cooldown. Completed batches stay
    // committed; the in-progress batch is not appended until every candidate is
    // checked, so resuming re-runs that batch safely after Retry-After.
    const resumableScan = status === 429 && Boolean(sureshotScanState && sureshotScanState.id);
    if (!resumableScan) sureshotScanState = null;
    return res.status(status).json({ ok: false, scanComplete: false, signalsAllowed: false, orderPlacement: "disabled", stage: scanStage,
      error: status === 429 ? "FYERS API cooldown/rate limit paused the full-universe scan; its server cursor is retained for a safe resume."
        : status === 401 ? "FYERS session expired; reconnect and rerun the scan."
        : status === 409 ? String(error.message || "Market session closed; full-universe scan blocked.")
        : "Automatic full-universe trade-plan scan could not verify required data.",
      detail: String(error.message || "Verification failed.").slice(0, 180),
      retryAfterSeconds: retryAfterSeconds || null,
      scanPaused: resumableScan,
      scanId: resumableScan ? sureshotScanState.id : null,
      nextOffset: resumableScan ? sureshotScanState.nextOffset : null,
      scannedCandidateCount: resumableScan ? sureshotScanState.results.length : 0,
      partialPlansDiscarded: !resumableScan });
  } finally {
    nseSureshotAutoPlansInFlight = false;
    sureshotAutoPlansInFlight = mcxSureshotAutoPlansInFlight;
  }
});

// MCX Sureshot uses its own official MCX_COM master and MCX session gate.
// It shares the existing authenticated FYERS Data API budget and never touches NSE state.
app.get("/api/market/mcx-sureshot-auto-plans", requireDashboardSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const mcxSessionOpen = () => getExchangeSessionWindows().MCX?.session === "SCHEDULED_OPEN";
  if (!accessToken) return res.status(401).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "Connect FYERS first." });
  if (!mcxSessionOpen()) return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "MCX session is closed; actionable option plans are withheld." });
  const mcxSocketAgeSeconds = mcxDiagnosticTick ? (Date.now() - Date.parse(mcxDiagnosticTick.updatedAt)) / 1000 : Infinity;
  if (!streamConnected || mcxSubscribedSocket !== marketSocket || !Number.isFinite(mcxSocketAgeSeconds) || mcxSocketAgeSeconds < 0 || mcxSocketAgeSeconds > MCX_TICK_FRESHNESS_SECONDS) {
    return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "MCX WebSocket feed is not fresh; reconnect or wait for a verified MCX exchange tick before scanning." });
  }
  if (mcxSureshotAutoPlansInFlight) return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "An MCX Sureshot scan is already running." });
  mcxSureshotAutoPlansInFlight = true;
  sureshotAutoPlansInFlight = true;
  let stage = "LOAD_MCX_MASTER";
  let quoteRowsReceived = 0;
  try {
    const universe = await getMcxFnoUniverse();
    if (!universe.count) return res.status(409).json({ ok: false, scanComplete: false, signalsAllowed: false, error: "No MCX futures with active CE/PE contracts are currently inside their official trading sessions." });
    stage = "VERIFY_MCX_FUTURES_QUOTES";
    const quoteRows = [];
    for (let offset = 0; offset < universe.data.length; offset += 50) {
      const currentMcxTickAge = mcxDiagnosticTick ? (Date.now() - Date.parse(mcxDiagnosticTick.updatedAt)) / 1000 : Infinity;
      if (!streamConnected || mcxSubscribedSocket !== marketSocket || !Number.isFinite(currentMcxTickAge) || currentMcxTickAge < 0 || currentMcxTickAge > MCX_TICK_FRESHNESS_SECONDS) { const error = new Error('MCX feed became stale during quote scan; partial results discarded.'); error.statusCode = 409; throw error; }
      if (!mcxSessionOpen()) { const error = new Error("MCX session closed during quote scan; partial results discarded."); error.statusCode = 409; throw error; }
      const batch = universe.data.slice(offset, offset + 50).map(item => item.symbol);
      const url = new URL("https://api-t1.fyers.in/data/quotes");
      url.searchParams.set("symbols", batch.join(","));
      const result = await fyersReadOnlyGet(url, { priority: "sureshot" });
      const rows = Array.isArray(result?.d) ? result.d : (Array.isArray(result?.data) ? result.data : []);
      quoteRowsReceived += rows.length;
      const sample = rows[0] || null;
      const sampleQuote = sample?.v || sample || {};
      console.info("FYERS MCX futures quote batch received:", JSON.stringify({
        batchIndex: Math.floor(offset / 50) + 1,
        requestedCount: batch.length,
        receivedCount: rows.length,
        apiStatus: result?.s || "missing",
        apiCode: result?.code ?? null,
        sampleSymbol: sample?.n || sample?.symbol || null,
        sampleRowStatus: sample?.s || null,
        sampleQuoteKeys: Object.keys(sampleQuote).slice(0, 24),
        sampleTimestampFields: {
          tt: sampleQuote?.tt ?? null,
          ltt: sampleQuote?.ltt ?? null,
          exch_feed_time: sampleQuote?.exch_feed_time ?? null,
          timestamp: sampleQuote?.timestamp ?? null
        }
      }));
      quoteRows.push(...rows);
    }
    const ranked = buildVerifiedMcxShortlist({ universe: universe.data, quoteRows, now: Date.now(), limit: 5 });
    console.info("FYERS MCX Sureshot futures quote coverage:", JSON.stringify(ranked.coverage));
    const indiaNow = new Date(Date.now() + 330 * 60 * 1000);
    const today = indiaNow.toISOString().slice(0, 10);
    const from = new Date(Date.UTC(indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), indiaNow.getUTCDate() - 10)).toISOString().slice(0, 10);
    const results = [];
    const prepared = [];
    for (const candidate of ranked.data) {
      const currentMcxTickAge = mcxDiagnosticTick ? (Date.now() - Date.parse(mcxDiagnosticTick.updatedAt)) / 1000 : Infinity;
      if (!streamConnected || mcxSubscribedSocket !== marketSocket || !Number.isFinite(currentMcxTickAge) || currentMcxTickAge < 0 || currentMcxTickAge > MCX_TICK_FRESHNESS_SECONDS) { const error = new Error('MCX feed became stale during plan verification; partial plans discarded.'); error.statusCode = 409; throw error; }
      if (!mcxSessionOpen()) { const error = new Error("MCX session closed during scan; partial plans discarded."); error.statusCode = 409; throw error; }
      const base = { rank: candidate.rank, underlyingSymbol: candidate.symbol, underlying: candidate.underlying,
        changePct: candidate.changePct, ltp: candidate.price, quoteAgeSeconds: candidate.quoteAgeSeconds };
      try {
        stage = "VERIFY_MCX_UNDERLYING_CANDLES";
        const historyUrl = new URL("https://api-t1.fyers.in/data/history");
        historyUrl.searchParams.set("symbol", candidate.symbol); historyUrl.searchParams.set("resolution", "5");
        historyUrl.searchParams.set("date_format", "1"); historyUrl.searchParams.set("range_from", from);
        historyUrl.searchParams.set("range_to", today); historyUrl.searchParams.set("cont_flag", "1");
        const history = await fyersReadOnlyGet(historyUrl, { priority: "sureshot" });
        const direction = deriveVerifiedUnderlyingDirection(Array.isArray(history?.candles) ? history.candles : [], "5", Date.now(), { strictTrend: true });
        if (!direction.ok || !direction.side) {
          results.push({ ...base, status: "NO TRADE", reason: direction.reason || "No confirmed CE/PE direction." });
          continue;
        }
        const expiryMap = new Map();
        for (const option of candidate.optionContracts) {
          const n = Number(option.expiryDate);
          const ms = Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : Date.parse(option.expiryDate);
          if (!Number.isFinite(ms) || ms <= Date.now()) continue;
          const expiry = String(Math.floor(ms / 1000));
          const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ms));
          if (!expiryMap.has(expiry)) expiryMap.set(expiry, { expiry, date });
        }
        const discovery = {
          expiryData: [...expiryMap.values()].sort((a, b) => Number(a.expiry) - Number(b.expiry)),
          optionsChain: candidate.optionContracts.map(option => {
            const value = Number(option.expiryDate);
            const expiryMs = Number.isFinite(value) && value > 0
              ? (value > 1e12 ? value : value * 1000) : Date.parse(String(option.expiryDate || ""));
            return { symbol: option.symbol, strike_price: option.strike, option_type: option.side,
              expiry: Number.isFinite(expiryMs) ? String(Math.floor(expiryMs / 1000)) : "" };
          }).filter(option => option.expiry)
        };
        stage = "SELECT_MCX_OPTION_CONTRACT";
        const selected = selectNearestVerifiedOptionContract({
          discovery, underlyingSymbol: candidate.symbol, side: direction.side, spot: direction.spot, now: Date.now(),
          strikeMode: "one-otm"
        });
        if (!selected.ok) {
          results.push({ ...base, status: "NO TRADE", direction: direction.side, reason: selected.reason });
          continue;
        }
        const sizing = await getFyersOptionContractMetadata(selected.contract.symbol);
        if (!sizing) {
          results.push({ ...base, status: "NO TRADE", direction: direction.side, contract: selected.contract,
            reason: "Official MCX contract lot size or tick size is unavailable." });
          continue;
        }
        prepared.push({ candidate, base, direction,
          contract: { ...selected.contract, lotSize: sizing.lotSize, tickSize: sizing.tickSize }, sizing });
      } catch (error) {
        if ([401, 429].includes(Number(error.statusCode))) throw error;
        results.push({ ...base, status: "NO TRADE", reason: String(error.message || "MCX candidate verification failed.").slice(0, 180) });
      }
    }

    const quoteBySymbol = new Map();
    if (prepared.length) {
      stage = "VERIFY_MCX_OPTION_QUOTES";
      const url = new URL("https://api-t1.fyers.in/data/quotes");
      url.searchParams.set("symbols", prepared.map(item => item.contract.symbol).join(","));
      const result = await fyersReadOnlyGet(url, { priority: "sureshot" });
      const rows = Array.isArray(result?.d) ? result.d : (Array.isArray(result?.data) ? result.data : []);
      for (const row of rows) {
        const symbol = row?.n || row?.symbol || row?.v?.symbol;
        if (symbol && prepared.some(item => item.contract.symbol === symbol)) quoteBySymbol.set(symbol, row?.v || row);
      }
    }
    for (const item of prepared) {
      if (!mcxSessionOpen()) { const error = new Error("MCX session closed during option verification; partial plans discarded."); error.statusCode = 409; throw error; }
      const quote = quoteBySymbol.get(item.contract.symbol);
      if (!quote) {
        results.push({ ...item.base, status: "NO TRADE", direction: item.direction.side, contract: item.contract,
          reason: "FYERS returned no quote for the selected MCX option contract." });
        continue;
      }
      try {
        stage = "VERIFY_MCX_OPTION_CANDLES";
        const historyUrl = new URL("https://api-t1.fyers.in/data/history");
        historyUrl.searchParams.set("symbol", item.contract.symbol); historyUrl.searchParams.set("resolution", "5");
        historyUrl.searchParams.set("date_format", "1"); historyUrl.searchParams.set("range_from", from);
        historyUrl.searchParams.set("range_to", today); historyUrl.searchParams.set("cont_flag", "1");
        const optionHistory = await fyersReadOnlyGet(historyUrl, { priority: "sureshot" });
        stage = "BUILD_MCX_RISK_PLAN";
        const plan = buildVerifiedSureshotTradePlan({
          underlyingSymbol: item.candidate.symbol, direction: item.direction, contract: item.contract,
          quote, optionCandles: Array.isArray(optionHistory?.candles) ? optionHistory.candles : [],
          resolution: "5", lotSize: item.sizing.lotSize, tickSize: item.sizing.tickSize, riskModel: "fixed", requirePremiumRange: true, now: Date.now()
        });
        results.push(plan.ok
          ? { ...item.base, status: "VERIFIED SETUP", plan }
          : { ...item.base, status: "NO TRADE", direction: item.direction.side, contract: item.contract, reason: plan.reason });
      } catch (error) {
        if ([401, 429].includes(Number(error.statusCode))) throw error;
        results.push({ ...item.base, status: "NO TRADE", direction: item.direction.side, contract: item.contract,
          reason: String(error.message || "MCX option verification failed.").slice(0, 180) });
      }
    }
    const verified = results.filter(item => item.status === "VERIFIED SETUP").sort((a, b) => a.rank - b.rank);
    return res.json({
      ok: true, scanComplete: true, signalsAllowed: verified.length > 0,
      orderPlacement: "disabled", readOnly: true, source: "FYERS MCX_COM master + FYERS market data",
      universeCount: universe.count, rankedCandidateCount: ranked.candidateCount,
      quoteCoverage: ranked.coverage, freshFutureQuoteCount: ranked.freshQuoteCount,
      excludedFutureQuoteCount: ranked.excludedQuoteCount, missingFutureQuoteCount: ranked.missingQuoteCount,
      selectedCandidateCount: ranked.data.length, scannedCandidateCount: results.length,
      verifiedSetupCount: verified.length, bestSetup: verified[0] || null, results,
      notice: "All active MCX futures were requested from the official master. Only contracts with fresh exchange-timestamped futures quotes were ranked; stale, invalid or missing quotes were excluded and never used. Selected candidates were checked for completed underlying candles, official MCX option identity, fresh option premium, completed option candles and >=1:2 risk/reward. No OI/volume is used and no orders are placed."
    });
  } catch (error) {
    const status = Number(error.statusCode) || 503;
    console.warn("FYERS MCX Sureshot scan failed:", JSON.stringify({
      stage, status, message: String(error.message || error).slice(0, 280),
      quoteRowsReceived
    }));
    if (status === 429 && error.retryAfterSeconds) res.set("Retry-After", String(error.retryAfterSeconds));
    return res.status(status).json({
      ok: false, scanComplete: false, signalsAllowed: false, orderPlacement: "disabled", stage,
      error: status === 401 ? "FYERS session expired; reconnect and rerun the MCX scan."
        : status === 409 ? String(error.message || "MCX session closed; scan blocked.")
        : "MCX full-universe scan could not verify all required data.",
      detail: String(error.message || "MCX scan failed.").slice(0, 180), partialPlansDiscarded: true
    });
  } finally {
    mcxSureshotAutoPlansInFlight = false;
    sureshotAutoPlansInFlight = nseSureshotAutoPlansInFlight;
  }
});

// Last-known F&O equity quotes are display-only. Unlike the live movers endpoint,
// this route may return older exchange-stamped LTPs while the market is closed.
let lastKnownStockCache = { fetchedAt: 0, data: null };
let lastKnownStockPromise = null;
const LAST_KNOWN_STOCK_CACHE_MS = 5 * 60 * 1000;
app.get("/api/market/last-known-stock-quotes", requireDashboardSession, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!accessToken) return res.status(401).json({ ok: false, error: "Connect FYERS first.", data: [], signalsAllowed: false });
  if (lastKnownStockCache.data && Date.now() - lastKnownStockCache.fetchedAt < LAST_KNOWN_STOCK_CACHE_MS) {
    return res.json({ ...lastKnownStockCache.data, marketSession: getNseSessionWindow().isRegularHours ? "OPEN" : "CLOSED", cached: true, cacheAgeSeconds: Math.floor((Date.now() - lastKnownStockCache.fetchedAt) / 1000) });
  }
  if (sureshotAutoPlansInFlight) {
    return res.status(503).json({
      ok: false, error: "Sureshot scan has priority; last-known stock REST refresh is paused.",
      data: [], signalsAllowed: false, retryAfterSeconds: 5
    });
  }
  const request = lastKnownStockPromise || (lastKnownStockPromise = (async () => {
    const universe = await getNseFnoEquityUniverse();
    const symbols = universe.data.map(item => item.symbol);
    const rows = [];
    const missing = [];
    let stoppedReason = null;
    for (let offset = 0; offset < symbols.length; offset += STOCK_QUOTE_BATCH_SIZE) {
        const batch = symbols.slice(offset, offset + STOCK_QUOTE_BATCH_SIZE);
      try {
        const url = new URL("https://api-t1.fyers.in/data/quotes");
        url.searchParams.set("symbols", batch.join(","));
        const response = await fetchWithFyersBudget(url, {
          headers: { Authorization: appId + ":" + accessToken, Accept: "application/json" },
          cache: "no-store", signal: AbortSignal.timeout(12000)
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 429) { stoppedReason = "FYERS quote rate limit; remaining symbols not checked."; missing.push(...symbols.slice(offset)); break; }
        if (!response.ok || body.s !== "ok" || !Array.isArray(body.d)) {
          stoppedReason = "FYERS quote batch could not be verified; remaining symbols not checked.";
          missing.push(...symbols.slice(offset)); break;
        }
        const returned = new Set();
        for (const item of body.d) {
          if (!item || !batch.includes(item.n) || !item.v) continue;
          const v = item.v;
          const lp = Number(v.lp);
          const rawTime = v.tt ?? v.ltt ?? v.exch_feed_time;
          const numericTime = Number(rawTime);
          const timeMs = Number.isFinite(numericTime) && numericTime > 0
            ? (numericTime > 1e12 ? numericTime : numericTime * 1000)
            : Date.parse(String(rawTime || ""));
          if (!Number.isFinite(lp) || lp <= 0 || !Number.isFinite(timeMs) || timeMs <= 0 || timeMs > Date.now() + 5000) continue;
          returned.add(item.n);
          const ageSeconds = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
          rows.push({
            symbol: item.n, name: item.n.replace(/^NSE:/, "").replace(/-EQ$/, ""),
            price: lp, priceAsOf: new Date(timeMs).toISOString(), quoteAgeSeconds: ageSeconds,
            stale: ageSeconds > 120, verified: true, source: "FYERS quotes API last-known",
            changePct: v.chp != null && Number.isFinite(Number(v.chp)) ? Number(v.chp) : null
          });
        }
        for (const symbol of batch) if (!returned.has(symbol)) missing.push(symbol);
      } catch (error) {
        stoppedReason = "FYERS request interrupted; remaining symbols not checked.";
        missing.push(...symbols.slice(offset));
        break;
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const result = {
      ok: rows.length > 0, source: "FYERS quotes API last-known snapshots",
      fetchedAt: new Date().toISOString(), universeCount: symbols.length,
      quotedCount: rows.length, missingCount: Math.max(0, symbols.length - rows.length),
      complete: rows.length === symbols.length, partial: rows.length !== symbols.length,
      marketSession: getNseSessionWindow().isRegularHours ? "OPEN" : "CLOSED",
      data: rows, missingSymbols: missing.slice(0, 500), signalsAllowed: false,
      note: "Actual exchange-stamped last-known prices for display only. Old quotes are labeled by age; this endpoint never enables signals.",
      ...(stoppedReason ? { warning: stoppedReason } : {})
    };
    if (rows.length) lastKnownStockCache = { fetchedAt: Date.now(), data: result };
    return result;
  })());
  try {
    const result = await request;
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    return res.status(Number(error.statusCode) || 502).json({
      ok: false, error: "Last-known F&O stock prices could not be verified.",
      detail: String(error.message || "Upstream error").slice(0, 160),
      data: [], signalsAllowed: false
    });
  } finally {
    if (lastKnownStockPromise === request) lastKnownStockPromise = null;
  }
});

// Compatibility adapter for the Original Ultimate UI. Rankings are emitted only
// during the regular NSE clock window and only from a complete, fresh FYERS quote snapshot.
// This clock check is not a holiday calendar; any missing/stale upstream quote fails closed.

app.get('/api/market/movers', async (_req, res) => {
  if (!accessToken) return res.status(401).json({ ok: false, error: 'Connect FYERS first to load market movers.' });

  await refreshMoversUniverse();
  if ((!moversSnapshotCache || Date.now() - moversSnapshotCache.cachedAt >= MOVERS_CACHE_TTL_MS) &&
      stockQuoteCache.data && Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS) {
    syncMoversCacheFromFnoQuoteSnapshot(stockQuoteCache.data);
  }
  if (moversSnapshotCache && Date.now() - moversSnapshotCache.cachedAt < MOVERS_CACHE_TTL_MS) {
    const now = Date.now();
    const marketOpen = nseRegularSessionNow();
    const cachedPayload = moversSnapshotCache.payload;
    const data = (Array.isArray(cachedPayload.data) ? cachedPayload.data : []).map(row => {
      const timestamp = row.priceAsOf ? Date.parse(row.priceAsOf) / 1000 : null;
      const freshness = quoteTimestampStatus(timestamp, now, 30);
      return { ...row, quoteAgeSeconds: Number.isFinite(timestamp) ? Math.max(0, now / 1000 - timestamp) : null,
        marketSession: marketOpen ? 'OPEN' : 'CLOSED',
        priceStatus: marketOpen ? (freshness === 'FRESH' ? 'LIVE_QUOTE' : freshness === 'STALE' ? 'STALE_QUOTE' : 'TIME_UNVERIFIED') : 'LAST_KNOWN_PRICE' };
    });
    if (marketOpen) {
      try {
        assertFreshMoverSnapshot(data, true);
      } catch (error) {
        return res.status(502).json({ ok: false, error: error.message, staleSymbols: error.staleSymbols || [] });
      }
    }
    syncFnoQuoteCacheFromMoversPayload({ ...cachedPayload, data });
    res.set('Cache-Control', 'no-store');
    return res.json({ ...cachedPayload, data, cached: true });
  }
  // During market hours, route Movers through the same complete F&O snapshot
  // promise/cache as Stock Quotes and Sureshot. This prevents independent
  // full-universe quote loaders from spending the same FYERS request budget.
  if (nseRegularSessionNow()) {
    try {
      const universe = await getNseFnoEquityUniverse();
      const symbols = universe.data.map(item => item.symbol);
      const sameUniverse = symbols.length === moversSymbols.length &&
        symbols.every((symbol, index) => symbol === moversSymbols[index]);
      if (sameUniverse) {
        let snapshot = stockQuoteCache.data &&
          Date.now() - stockQuoteCache.fetchedAt < STOCK_QUOTE_CACHE_MS &&
          isCompleteFreshFnoQuoteSnapshot(stockQuoteCache.data, symbols, Date.now())
          ? stockQuoteCache.data : null;
        if (!snapshot) {
          if (sendFyersDataApiCooldown(res, { partialQuotesDiscarded: true })) return;
          const request = stockQuotePromise || (stockQuotePromise = loadVerifiedFnoStockQuotes());
          try { snapshot = await request; }
          finally { if (stockQuotePromise === request) stockQuotePromise = null; }
        }
        const payload = fnoQuoteSnapshotToMoversPayload(snapshot, symbols, Date.now());
        if (!payload) {
          return res.status(503).json({ ok: false, error: "Complete fresh FYERS F&O snapshot could not be shared with Movers; no partial ranking returned." });
        }
        moversSnapshotCache = { cachedAt: Date.parse(payload.fetchedAt), payload };
        res.set('Cache-Control', 'no-store');
        return res.json(payload);
      }
    } catch (error) {
      const status = Number(error.statusCode) || 503;
      if (status === 429) res.set("Retry-After", String(Number(error.retryAfterSeconds) || fetchWithFyersBudget.getStatus().retryAfterSeconds || 1));
      return res.status(status).json({
        ok: false,
        error: status === 429 ? "FYERS Data API cooldown active; shared F&O snapshot withheld." : "Shared FYERS F&O snapshot unavailable; Movers ranking withheld.",
        detail: String(error.message || "Snapshot verification failed.").slice(0, 160),
        partialQuotesDiscarded: true
      });
    }
  }
  try {
    if (!moversSnapshotInFlight) {
      moversSnapshotInFlight = (async () => {
        const quoteFetchedAt = new Date().toISOString();
        const marketOpen = nseRegularSessionNow();
        const quoteItems = [];
        const failedBatches = [];
        let batchRateLimitError = null;
        // Keep each request within the 50-symbol Quotes API limit and avoid
        // parallel bursts that can trigger FYERS 429 cooldowns.
        for (let offset = 0; offset < moversSymbols.length; offset += MOVERS_BATCH_SIZE) {
          const batch = moversSymbols.slice(offset, offset + MOVERS_BATCH_SIZE);
          try {
            const url = new URL('https://api-t1.fyers.in/data/quotes');
            url.searchParams.set('symbols', batch.join(','));
            const result = await fyersReadOnlyGet(url);
            const quotes = Array.isArray(result.d) ? result.d : (Array.isArray(result.data) ? result.data : []);
            quoteItems.push(...quotes);
            const returned = new Set(quotes.map(item => item && (item.n || item.symbol || item.v?.symbol)).filter(Boolean));
            failedBatches.push(...batch.filter(symbol => !returned.has(symbol)));
          } catch (error) {
            failedBatches.push(...batch);
            // A 429 means this endpoint is in cooldown; stop immediately rather
            // than issuing more requests that cannot succeed.
            if (Number(error.statusCode) === 429) {
              batchRateLimitError = error;
              break;
            }
          }
        }
        const received = new Set();
        const rows = quoteItems.map(item => {
          const value = item && (item.v || item);
          const symbol = item && (item.n || item.symbol || value?.symbol);
          const price = Number(value && (value.lp ?? value.ltp));
          const previousCloseRaw = value && (value.prev_close_price ?? value.prev_close ?? value.pc);
          const previousClose = Number(previousCloseRaw);
          const rawChange = value?.ch == null ? NaN : Number(value.ch);
          const rawChangePct = value?.chp == null ? NaN : Number(value.chp);
          const hasPreviousClose = Number.isFinite(previousClose) && previousClose > 0;
          const change = Number.isFinite(rawChange) ? rawChange : (hasPreviousClose && Number.isFinite(price) ? price - previousClose : null);
          const changePct = Number.isFinite(rawChangePct) ? rawChangePct : (hasPreviousClose && Number.isFinite(price) ? ((price - previousClose) / previousClose) * 100 : null);
          const tradedAtEpoch = epochSeconds(value && (value.tt ?? value.exch_feed_time ?? value.last_traded_time ?? value.ltt));
          if (!moversSymbols.includes(symbol) || (item.s && item.s !== 'ok') ||
              !Number.isFinite(price) || price <= 0) return null;
          received.add(symbol);
          const rawQuoteAgeSeconds = tradedAtEpoch
            ? Math.floor(Date.now() / 1000) - tradedAtEpoch
            : null;
          const quoteAgeSeconds = rawQuoteAgeSeconds === null ? null : Math.max(0, rawQuoteAgeSeconds);
          // A successful HTTP response is not proof that the underlying quote is fresh.
          // Missing, future-dated, or old exchange timestamps must never be called live.
          const timestampStatus = quoteTimestampStatus(tradedAtEpoch, Date.now(), 30);
          const priceStatus = !marketOpen
            ? 'LAST_KNOWN_PRICE'
            : (timestampStatus === 'FRESH' ? 'LIVE_QUOTE' : timestampStatus === 'STALE' ? 'STALE_QUOTE' : 'TIME_UNVERIFIED');
          return {
            symbol, price,
            change: Number.isFinite(change) ? change : null,
            changePct: Number.isFinite(changePct) ? changePct : null,
            previousClose: hasPreviousClose ? previousClose : null,
            priceAsOf: tradedAtEpoch ? new Date(tradedAtEpoch * 1000).toISOString() : null,
            quoteAgeSeconds,
            quoteFetchedAt,
            marketSession: marketOpen ? 'OPEN' : 'CLOSED',
            priceStatus
          };
        }).filter(Boolean);
        assertCompleteMoverSnapshot({
          requestedSymbols: moversSymbols,
          rows,
          failedBatches,
          receivedSymbols: received,
          rateLimitError: batchRateLimitError
        });
        assertFreshMoverSnapshot(rows, marketOpen);
        if (!rows.length) {
          if (batchRateLimitError) throw batchRateLimitError;
          throw new Error('FYERS returned no valid verified equity quote rows.');
        }
        return {
          ok: true, fetchedAt: quoteFetchedAt, marketSession: marketOpen ? 'OPEN' : 'CLOSED',
          universe: moversUniverseSource === 'FYERS_NSE_FO_SYMBOL_MASTER' ? 'FYERS-NSE-FO-symbol-master' : 'configured-NSE-F&O-equities-fallback',
          universeUpdatedAt: moversMasterUpdatedAt,
          requestedSymbols: moversSymbols.length, receivedSymbols: rows.length,
          partial: rows.length < moversSymbols.length || failedBatches.length > 0,
          failedSymbols: [...new Set([...moversSymbols.filter(symbol => !received.has(symbol)), ...failedBatches])],
          data: rows
        };
      })();
    }
    const payload = await moversSnapshotInFlight;
    moversSnapshotCache = { cachedAt: Date.now(), payload };
    syncFnoQuoteCacheFromMoversPayload(payload);
    res.set('Cache-Control', 'no-store');
    return res.json(payload);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502;
    return res.status(statusCode).json({
      ok: false,
      error: statusCode === 429 ? 'FYERS quote rate limit reached. Wait briefly before refreshing.' : 'FYERS did not return a verified stock-quote snapshot.',
      detail: String(error.message || 'FYERS quote request failed.').slice(0, 220),
      requestedSymbols: moversSymbols.length
    });
  } finally {
    moversSnapshotInFlight = null;
  }
});
app.get('/api/market/mcx-fno-universe', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const universe = await getMcxFnoUniverse();
    const clientData = universe.data.map(({ symbol, underlying, expiryDate, lotSize, tickSize }) =>
      ({ symbol, underlying, expiryDate, lotSize, tickSize }));
    return res.json({ ok: true, ...universe, data: clientData, signalsAllowed: false, rankingIsSignal: false });
  } catch (error) {
    return res.status(503).json({ ok: false, error: 'Official MCX F&O universe unavailable; MCX scan blocked.', detail: String(error.message || error).slice(0, 200), signalsAllowed: false });
  }
});

app.get('/api/fyers/options-chain', async (req, res) => {
  const symbol = String(req.query.symbol || 'NSE:NIFTY50-INDEX');
  const timestamp = req.query.timestamp == null ? '' : String(req.query.timestamp);
  if (symbol.startsWith('MCX:')) {
    try {
      const universe = await getMcxFnoUniverse();
      const future = universe.data.find(row => row.symbol === symbol);
      if (!future) return res.status(400).json({ ok: false, error: 'Underlying is not an active FYERS MCX future in the official master.' });
      const expiryToMillis = value => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0
          ? (number > 1e12 ? number : number * 1000)
          : Date.parse(String(value || ""));
      };
      const byExpiry = new Map();
      for (const option of future.optionContracts) {
        const expiryMs = expiryToMillis(option.expiryDate);
        if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) continue;
        const expiry = String(Math.floor(expiryMs / 1000));
        const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(expiryMs));
        if (!byExpiry.has(expiry)) byExpiry.set(expiry, { expiry, date });
      }
      const expiryData = [...byExpiry.values()].sort((a, b) => Number(a.expiry) - Number(b.expiry));
      const selectedExpiry = timestamp || expiryData[0]?.expiry;
      const optionsChain = future.optionContracts.filter(option =>
        String(Math.floor(expiryToMillis(option.expiryDate) / 1000)) === String(selectedExpiry)
      ).map(option => ({ symbol: option.symbol, strike_price: option.strike, option_type: option.side, expiry: selectedExpiry }));
      if (!optionsChain.length) return res.status(422).json({ ok: false, error: 'No active MCX options found for the selected expiry in the official master.' });
      const discovery = normalizeOptionContractDiscovery({ expiryData, optionsChain });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, contractDiscoveryOnly: true, source: 'FYERS MCX_COM symbol master', chainFreshness: 'NOT_APPLICABLE', notice: 'MCX contract identity, strike and expiry come from the official symbol master. Premium, bid/ask and candles are verified separately; OI/volume are not used.', data: discovery });
    } catch (error) {
      return res.status(503).json({ ok: false, error: 'FYERS MCX option contract discovery failed.', detail: String(error.message || error).slice(0, 200) });
    }
  }
  const allowed = [...allowedSymbols, ...moversSymbols];
  const strikeCount = Number.parseInt(String(req.query.strikecount || '10'), 10);
  if (!allowed.includes(symbol)) return res.status(400).json({ ok: false, error: 'Unsupported underlying symbol.' });
  if (!Number.isInteger(strikeCount) || strikeCount < 1 || strikeCount > 50) {
    return res.status(400).json({ ok: false, error: 'strikecount must be between 1 and 50.' });
  }
  if (timestamp && !/^\d{9,12}$/.test(timestamp)) {
    return res.status(400).json({ ok: false, error: 'Invalid expiry timestamp.' });
  }
  try {
    const url = new URL('https://api-t1.fyers.in/data/options-chain-v3');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('strikecount', String(strikeCount));
    if (timestamp) url.searchParams.set('timestamp', timestamp);
    const result = await fyersReadOnlyGet(url);
    const discovery = normalizeOptionContractDiscovery(result?.data);
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      contractDiscoveryOnly: true,
      chainFreshness: 'UNVERIFIED',
      notice: 'FYERS does not document an exchange timestamp for option-chain OI/volume/premium fields. Only contract identity, strike, side and expiry are returned; all actionable prices are verified separately.',
      data: discovery
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view option contract descriptors.' : 'FYERS option contract discovery failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/option-quote', async (req, res) => {
  const symbol = String(req.query.symbol || '');
  // Read-only single-contract quote; this endpoint never places orders.
  if (!isSupportedOptionContractSymbol(symbol)) {
    return res.status(400).json({ ok: false, error: 'Invalid NSE option contract symbol.' });
  }
  try {
    const url = new URL('https://api-t1.fyers.in/data/quotes');
    url.searchParams.set('symbols', symbol);
    const result = await fyersReadOnlyGet(url);
    const rows = Array.isArray(result.d) ? result.d : (Array.isArray(result.data) ? result.data : []);
    const row = rows.find(item => (item?.n || item?.symbol || item?.v?.symbol) === symbol);
    const v = row?.v || row;
    const ltp = Number(v?.lp ?? v?.ltp);
    const bid = Number(v?.bid ?? v?.bid_price);
    const ask = Number(v?.ask ?? v?.ask_price);
    const rawTime = v?.ltt ?? v?.tt ?? v?.exch_feed_time;
    const n = Number(rawTime);
    const quoteTimeMs = Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : Date.parse(String(rawTime || ''));
    const ageMs = Date.now() - quoteTimeMs;
    if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(bid) || bid <= 0 ||
        !Number.isFinite(ask) || ask < bid || !Number.isFinite(quoteTimeMs) ||
        ageMs < 0 || ageMs > 15000) {
      return res.status(502).json({ ok: false, error: 'Selected option contract quote is missing, stale, or invalid; no signal.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, symbol, quote: { ltp, bid, ask, quoteTimeMs, quoteAgeSeconds: Math.max(0, ageMs / 1000) } });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to verify the selected option quote.' : 'Selected option quote verification failed.',
      detail: String(error.message || 'FYERS quote request failed.').slice(0, 220)
    });
  }
});


app.get('/api/fyers/option-risk-plan', async (req, res) => {
  const symbol = String(req.query.symbol || '');
  const resolution = String(req.query.resolution || '5');
  if (!isSupportedOptionContractSymbol(symbol)) {
    return res.status(400).json({ ok: false, error: 'A selected NSE option contract symbol is required.' });
  }
  if (!['5', '15', '30', '60'].includes(resolution)) {
    return res.status(400).json({ ok: false, error: 'Option risk candles must use a 5, 15, 30 or 60 minute interval.' });
  }
  const optionExchange = symbol.split(':')[0];
  const exchangeSession = getExchangeSessionWindows()[optionExchange];
  const exchangeSessionOpen = optionExchange === 'MCX'
    ? exchangeSession?.session === 'SCHEDULED_OPEN'
    : optionExchange === 'NSE' || optionExchange === 'BSE' ? nseRegularSessionNow() : false;
  if (!exchangeSessionOpen) {
    return res.status(409).json({ ok: false, error: optionExchange + ' market session is closed; no actionable option risk plan is generated.' });
  }
  if (optionExchange === 'MCX') {
    const mcxTickAgeSeconds = mcxDiagnosticTick ? (Date.now() - Date.parse(mcxDiagnosticTick.updatedAt)) / 1000 : Infinity;
    if (!streamConnected || mcxSubscribedSocket !== marketSocket || !Number.isFinite(mcxTickAgeSeconds) ||
        mcxTickAgeSeconds < 0 || mcxTickAgeSeconds > 30) {
      return res.status(409).json({ ok: false, error: 'MCX WebSocket feed is not fresh; no MCX option risk plan is generated.' });
    }
  }
  try {
    const contractMetadata = await getFyersOptionContractMetadata(symbol);
    if (!contractMetadata) {
      return res.status(422).json({ ok: false, error: "The selected option contract is not active or its official FYERS lot size / tick size is unavailable." });
    }
    const quoteUrl = new URL('https://api-t1.fyers.in/data/quotes');
    quoteUrl.searchParams.set('symbols', symbol);
    const historyUrl = new URL('https://api-t1.fyers.in/data/history');
    historyUrl.searchParams.set('symbol', symbol);
    historyUrl.searchParams.set('resolution', resolution);
    historyUrl.searchParams.set('date_format', '1');
    historyUrl.searchParams.set('cont_flag', '1');
    const indiaNow = new Date(Date.now() + 330 * 60 * 1000);
    const today = indiaNow.toISOString().slice(0, 10);
    const from = new Date(Date.UTC(indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), indiaNow.getUTCDate() - 6)).toISOString().slice(0, 10);
    historyUrl.searchParams.set('range_from', from);
    historyUrl.searchParams.set('range_to', today);
    const [quoteResult, historyResult] = await Promise.all([
      fyersReadOnlyGet(quoteUrl),
      fyersReadOnlyGet(historyUrl)
    ]);
    const quoteRows = Array.isArray(quoteResult?.d) ? quoteResult.d :
      (Array.isArray(quoteResult?.data) ? quoteResult.data : []);
    const quoteRow = quoteRows.find(item => (item?.n || item?.symbol || item?.v?.symbol) === symbol);
    const quote = quoteRow?.v || quoteRow;
    const bid = Number(quote?.bid ?? quote?.bid_price);
    const ask = Number(quote?.ask ?? quote?.ask_price);
    const ltp = Number(quote?.lp ?? quote?.ltp);
    const quoteTime = epochSeconds(quote?.ltt ?? quote?.tt ?? quote?.exch_feed_time);
    if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask < bid ||
        !Number.isFinite(ltp) || ltp <= 0 ||
        quoteTimestampStatus(quoteTime, Date.now(), 15) !== 'FRESH') {
      return res.status(502).json({ ok: false, error: 'Selected option bid/ask/LTP quote is missing, invalid or older than 15 seconds.' });
    }
    const candles = Array.isArray(historyResult?.candles) ? historyResult.candles : [];
    if (ask < 30 || ask > 150) {
      return res.status(422).json({ ok: false, error: "Verified option ask premium must be between ₹30 and ₹150.", quote: {
        bid, ask, ltp, quoteTimeMs: quoteTime * 1000,
        quoteAgeSeconds: Number(((Date.now() - quoteTime * 1000) / 1000).toFixed(1))
      } });
    }
    const candleCheck = validateCompletedOptionCandles({ candles, resolution, now: Date.now(), lookback: 12 });
    const plan = candleCheck.ok
      ? buildFixedOptionRiskPlan({ entryPrice: ask, lotSize: contractMetadata.lotSize, tickSize: contractMetadata.tickSize })
      : { ok: false, reason: candleCheck.reason };
    if (plan.ok) {
      plan.completedCandleCount = candleCheck.completedCandleCount;
      plan.latestCompletedCandleAt = candleCheck.latestCompletedCandleAt;
    }
    if (!plan.ok) {
      return res.status(422).json({ ok: false, error: plan.reason, quote: {
        bid, ask, ltp, quoteTimeMs: quoteTime * 1000,
        quoteAgeSeconds: Number(((Date.now() - quoteTime * 1000) / 1000).toFixed(1))
      } });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, symbol, contract: contractMetadata, fetchedAt: new Date().toISOString(), quote: {
      bid, ask, ltp, quoteTimeMs: quoteTime * 1000,
      quoteAgeSeconds: Number(((Date.now() - quoteTime * 1000) / 1000).toFixed(1))
    }, data: plan });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502;
    return res.status(statusCode).json({
      ok: false,
      error: statusCode === 429 ? 'FYERS rate-limit cooldown active; retry after the stated cooldown.' : 'Unable to verify option quote and historical candles.',
      detail: String(error.message || 'FYERS option risk request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/funds', async (_req, res) => {
  try {
    const result = await fyersReadOnlyGet('https://api-t1.fyers.in/api/v3/funds');
    const data = normalizeFyersFunds(result);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, fetchedAt: new Date().toISOString(), data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view account funds.' : 'FYERS funds request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/holdings', async (_req, res) => {
  try {
    const result = await fyersReadOnlyGet('https://api-t1.fyers.in/api/v3/holdings');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, fetchedAt: new Date().toISOString(), data: result });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view holdings.' : 'FYERS holdings request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});

app.get('/api/fyers/positions', async (_req, res) => {
  try {
    const result = await fyersReadOnlyGet('https://api-t1.fyers.in/api/v3/positions');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, fetchedAt: new Date().toISOString(), data: result });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      ok: false,
      error: error.statusCode === 401 ? 'Connect FYERS to view positions.' : 'FYERS positions request failed.',
      detail: String(error.message || 'Upstream request failed.').slice(0, 220)
    });
  }
});


app.get('/api/paper/positions', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!paperStoreReady) return res.status(503).json({ ok: false, error: 'Durable Paper Mode database is not ready.' });
  try {
    const [positions, openPositions] = await Promise.all([paperStore.listPositions(), paperStore.listOpenPositions()]);
    return res.json({ ok: true, mode: 'PAPER_SIMULATION', positions, openPositionCount: openPositions.length,
      orderPlacement: 'disabled', source: 'GV2VPD PostgreSQL paper ledger; not FYERS broker positions' });
  } catch (error) {
    return res.status(503).json({ ok: false, error: 'Paper positions are unavailable.', detail: String(error.message || error).slice(0, 160) });
  }
});

app.post('/api/paper/buy', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!paperStoreReady) return res.status(503).json({ ok: false, error: 'Durable Paper Mode database is not ready; Paper BUY blocked.' });
  if (!accessToken || !nseRegularSessionNow()) return res.status(409).json({ ok: false, error: 'NSE market is not open; Paper BUY blocked.' });
  const indiaNow = new Date(Date.now() + 330 * 60_000);
  const indiaMinutes = indiaNow.getUTCHours() * 60 + indiaNow.getUTCMinutes();
  if (indiaMinutes < 9 * 60 + 15 || indiaMinutes >= 15 * 60 + 15) {
    return res.status(409).json({ ok: false, error: 'Paper BUY is allowed only from 09:15 until 15:15 Asia/Kolkata.' });
  }
  const sessionToken = /^Bearer ([a-f0-9]{64})$/.exec(String(req.get('authorization') || ''))?.[1] || '';
  const planId = String(req.body?.planId || '');
  const issued = verifiedPlanRegistry.get(sessionToken, planId);
  if (!issued) return res.status(409).json({ ok: false, error: 'Verified Sureshot plan ID is invalid, expired, or belongs to another Dashboard Session.' });
  const snapshot = issued.snapshot;
  if (snapshot.source !== 'FYERS_VERIFIED' || !isSupportedOptionContractSymbol(snapshot.symbol)) {
    return res.status(422).json({ ok: false, error: 'Server-owned verified FYERS option contract is invalid.' });
  }
  if (!streamConnected || !marketSocket) {
    return res.status(409).json({ ok: false, error: 'FYERS market WebSocket is not connected; Paper BUY blocked.' });
  }
  try {
    const metadata = await getFyersOptionContractMetadata(snapshot.symbol);
    if (!metadata || Number(metadata.lotSize) !== Number(snapshot.lotSize) ||
        Number(metadata.tickSize) !== Number(snapshot.tickSize)) {
      return res.status(409).json({ ok: false, error: 'FYERS official lot/tick metadata changed or is unavailable; rescan required.' });
    }
    const quoteUrl = new URL('https://api-t1.fyers.in/data/quotes');
    quoteUrl.searchParams.set('symbols', snapshot.symbol);
    const quoteResult = await fyersReadOnlyGet(quoteUrl, { priority: 'sureshot' });
    const rows = Array.isArray(quoteResult?.d) ? quoteResult.d : (Array.isArray(quoteResult?.data) ? quoteResult.data : []);
    const row = rows.find(item => (item?.n || item?.symbol || item?.v?.symbol) === snapshot.symbol);
    const quote = row?.v || row;
    const ask = Number(quote?.ask ?? quote?.ask_price);
    const quoteTime = epochSeconds(quote?.ltt ?? quote?.tt ?? quote?.exch_feed_time);
    if (!Number.isFinite(ask) || ask < 30 || ask > 150 ||
        quoteTimestampStatus(quoteTime, Date.now(), 10) !== 'FRESH') {
      return res.status(409).json({ ok: false, error: 'Fresh FYERS option ask (₹30–₹150) with exchange timestamp <=10 seconds is required; Paper BUY blocked.' });
    }
    const finalIndiaClock = new Date(Date.now() + 330 * 60_000);
    const finalIndiaMinutes = finalIndiaClock.getUTCHours() * 60 + finalIndiaClock.getUTCMinutes();
    if (!nseRegularSessionNow() || finalIndiaMinutes < 9 * 60 + 15 || finalIndiaMinutes >= 15 * 60 + 15 ||
        !streamConnected || !marketSocket) {
      return res.status(409).json({ ok: false, error: 'Market session, 15:15 cutoff or FYERS WebSocket changed during revalidation; Paper BUY blocked.' });
    }
    const risk = buildFixedOptionRiskPlan({ entryPrice: ask, lotSize: metadata.lotSize, tickSize: metadata.tickSize });
    if (!risk.ok || risk.rr < 2) return res.status(422).json({ ok: false, error: risk.reason || 'Fresh quote fails the minimum 1:2 risk/reward gate.' });
    if (!verifiedPlanRegistry.get(sessionToken, planId)) {
      return res.status(409).json({ ok: false, error: 'Verified Plan ID expired during quote revalidation; rerun Sureshot.' });
    }
    const idempotencyKey = 'paper:' + planId;
    paperSocketSymbols.add(snapshot.symbol);
    try {
      marketSocket.mode(marketSocket.FullMode);
      marketSocket.subscribe([snapshot.symbol]);
    } catch (subscriptionError) {
      paperSocketSymbols.delete(snapshot.symbol);
      return res.status(503).json({ ok: false, error: 'FYERS option WebSocket subscription failed; Paper BUY blocked.' });
    }
    let result;
    try {
      result = await paperStore.createPaperBuy({
        idempotencyKey,
        source: 'FYERS_VERIFIED',
        exchangeTimestamp: new Date(quoteTime * 1000).toISOString(),
        symbol: snapshot.symbol, side: snapshot.side, expiry: snapshot.expiry, strike: snapshot.strike,
        plan: { entryPrice: risk.entryPrice, stopLoss: risk.stopLoss, target1: risk.target1,
          target2: risk.target2, quantity: risk.quantity, lotSize: risk.lotSize }
      });
    } catch (error) {
      const open = await paperStore.listOpenPositions().catch(() => []);
      if (!open.some(position => position.symbol === snapshot.symbol)) await subscribeOpenPaperPositions(marketSocket);
      throw error;
    }
    // Re-read the durable open-position set after commit to close a socket reconnect race.
    void subscribeOpenPaperPositions(marketSocket);
    // Keep the short-lived plan until TTL so a retry returns the same idempotent ledger row.
    return res.status(result.created ? 201 : 200).json({
      ok: true, created: result.created, mode: 'PAPER_SIMULATION', position: result.position,
      riskAmount: result.riskAmount ?? null, orderPlacement: 'disabled',
      note: 'Simulation ledger only. No FYERS order endpoint was called.'
    });
  } catch (error) {
    const status = Number(error.statusCode) || 422;
    return res.status(status).json({ ok: false, error: String(error.message || 'Paper BUY rejected.').slice(0, 200), orderPlacement: 'disabled' });
  }
});

app.post('/api/paper/positions/:id/exit', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!paperStoreReady) return res.status(503).json({ ok: false, error: 'Durable Paper Mode database is not ready.' });
  if (!accessToken) return res.status(401).json({ ok: false, error: 'Reconnect FYERS before manual Paper Exit.' });
  try {
    const open = await paperStore.listOpenPositions();
    const position = open.find(row => String(row.id) === String(req.params.id));
    if (!position) return res.status(404).json({ ok: false, error: 'Open Paper position not found.' });
    const quoteUrl = new URL('https://api-t1.fyers.in/data/quotes');
    quoteUrl.searchParams.set('symbols', position.symbol);
    const quoteResult = await fyersReadOnlyGet(quoteUrl, { priority: 'sureshot' });
    const rows = Array.isArray(quoteResult?.d) ? quoteResult.d : (Array.isArray(quoteResult?.data) ? quoteResult.data : []);
    const row = rows.find(item => (item?.n || item?.symbol || item?.v?.symbol) === position.symbol);
    const quote = row?.v || row;
    const ltp = Number(quote?.lp ?? quote?.ltp);
    const quoteTime = epochSeconds(quote?.ltt ?? quote?.tt ?? quote?.exch_feed_time);
    if (!Number.isFinite(ltp) || quoteTimestampStatus(quoteTime, Date.now(), 10) !== 'FRESH') {
      return res.status(409).json({ ok: false, error: 'Fresh FYERS exchange-timestamped option quote required for manual Paper Exit.' });
    }
    const closed = await paperStore.manualExit({ id: position.id, confirmed: req.body?.confirmed === true,
      price: ltp, exchangeTimestamp: new Date(quoteTime * 1000).toISOString(), source: 'FYERS_VERIFIED' });
    await subscribeOpenPaperPositions(marketSocket);
    return res.json({ ok: true, mode: 'PAPER_SIMULATION', position: closed, orderPlacement: 'disabled' });
  } catch (error) {
    const status = Number(error.statusCode) || 409;
    if (status === 429 && error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    return res.status(status).json({ ok: false, error: String(error.message || 'Manual Paper Exit failed.').slice(0, 180) });
  }
});

app.all('/api/orders/*', (_req, res) => {
  res.status(403).json({ error: 'Order placement is disabled during testing.' });
});

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  res.status(500).json({ error: 'Unexpected backend error.' });
});

const port = Number(process.env.PORT || 8080);

async function initializePaperStore() {
  if (!paperStore.configured) {
    console.warn('Paper Mode disabled: DATABASE_URL is not configured; no in-memory substitute will be used.');
    return;
  }
  try {
    await paperStore.initialize();
    paperStoreReady = true;
    await subscribeOpenPaperPositions(marketSocket);
    console.log('GV2VPD durable Paper Mode ledger initialized; existing open positions loaded for FYERS quote monitoring.');
  } catch (error) {
    paperStoreReady = false;
    console.error('GV2VPD Paper Mode initialization failed closed:', String(error?.message || error).slice(0, 200));
  }
}

async function initializeFyersTokenStore() {
  if (fyersTokenStore.configured) {
    try {
      const savedAuth = await fyersTokenStore.initialize();
      fyersTokenStoreReady = true;
      if (savedAuth?.accessToken) {
        accessToken = savedAuth.accessToken;
        authenticatedAt = savedAuth.authenticatedAt;
        console.log('Encrypted FYERS token restored from PostgreSQL; reconnecting the read-only market data socket.', JSON.stringify({
          tokenFingerprint: socketTokenFingerprint(accessToken), authenticatedAt
        }));
        startMarketDataStream(accessToken, 'postgresql_startup_restore');
      } else {
        console.log('FYERS PostgreSQL token store ready; no saved token exists. Connect FYERS to authenticate.');
      }
    } catch (error) {
      fyersTokenStoreReady = false;
      console.error('FYERS PostgreSQL token store initialization failed; FYERS login remains disabled until fixed:', error?.message || 'database error');
    }
  } else {
    console.warn('FYERS PostgreSQL persistence is not configured yet; existing in-memory authentication remains enabled until DATABASE_URL and FYERS_TOKEN_ENCRYPTION_KEY are added. Tokens will not survive a backend restart yet.');
  }
}

function startServer() {
  // Bind the HTTP listener before restoring FYERS auth from PostgreSQL. The
  // health endpoint must stay responsive even when the optional token-store
  // connection is slow or unavailable; auth routes remain gated by
  // fyersTokenStoreReady until initialization completes.
  const server = app.listen(port, () => {
    console.log(`DhanPulse backend listening on ${port}`);
    void initializePaperStore();
    void initializeFyersTokenStore();
  });
  server.on('error', error => {
    console.error('DhanPulse backend listener failed:', error?.message || 'listen error');
    process.exitCode = 1;
  });
  return server;
}

startServer();