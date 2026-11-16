export function isValidFyersRecoveryPayload(pathname, payload) {
  if (!payload || typeof payload !== 'object' || payload.s !== 'ok') return false;
  if (pathname === '/data/quotes') return Array.isArray(payload.d) && payload.d.length > 0;
  if (pathname === '/data/history') return Array.isArray(payload.candles) && payload.candles.length > 0;
  if (pathname === '/data/options-chain-v3') {
    return Array.isArray(payload.data?.optionsChain) && payload.data.optionsChain.length > 0;
  }
  if (pathname === '/api/v3/screeners/config') return Array.isArray(payload.data?.screeners_standard);
  if (pathname === '/api/v3/screeners/standard') {
    return Array.isArray(payload.data?.header) && Array.isArray(payload.data?.body);
  }
  if (pathname === '/api/v3/positions') return Boolean(payload.data && typeof payload.data === 'object');
  return false;
}

export function canClearFyersDataApiCooldown({
  responseOk, responseValid, blockedPathname, responsePathname, requestGeneration, currentGeneration
}) {
  return Boolean(
    responseOk &&
    responseValid === true &&
    blockedPathname === responsePathname &&
    requestGeneration === currentGeneration
  );
}

// FYERS Data API calls share upstream/IP-level throttling. Serialize requests,
// coalesce identical in-flight reads, and briefly cache successful market-data
// snapshots so UI refreshes do not create duplicate provider traffic.
// Never retry a 429/Cloudflare 1015 automatically. Open a shared circuit breaker
// instead, including for requests that were already waiting in the queue.
export function createFyersDataApiBudget({
  fetchImpl = fetch,
  allApiPaths = false,
  maxQueuedRequests = 24,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxRequestsPerMinute = 15,
  minIntervalMs = 4000,
  windowMs = 60_000,
  historyCacheMs = 5 * 60_000,
  optionChainCacheMs = 60_000,
  maxCacheEntries = 100,
  // Cloudflare 1015 Retry-After is often zero even while the IP-level block persists.
  // Hold the circuit for a full hour before the next single probe; shorter retries
  // were observed to receive another 1015 and extend the provider block.
  cloudflareCooldownMs = [60 * 60_000, 60 * 60_000, 60 * 60_000],
  rateLimitCooldownMs = [60_000, 2 * 60_000, 5 * 60_000],
  maxCooldownMs = 60 * 60_000,
  onCooldownChange = null
} = {}) {
  const waitingQueue = [];
  let queueActive = false;
  let queueSequence = 0;
  let requestTimes = [];
  let lastRequestAt = 0;
  let consecutiveCloudflareBlocks = 0;
  let consecutiveRateLimitBlocks = 0;
  let cooldownUntil = 0;
  let cooldownReason = null;
  // A success from a different FYERS endpoint does not prove that the
  // Cloudflare-blocked endpoint/IP path has recovered. The generation also
  // prevents a request that began before a 1015 from clearing that newer block.
  let cooldownPathname = null;
  let cooldownProbeUrl = null;
  let cooldownProbeMethod = null;
  let cooldownGeneration = 0;
  let cooldownPersistenceHealthy = true;
  let queuedRequests = 0;
  let pendingRequests = 0;
  const responseCache = new Map();
  const inFlight = new Map();

  function defaultRequestPriority(pathname) {
    if (pathname === '/data/quotes') return 100;
    if (pathname === '/api/v3/positions') return 90;
    if (pathname === '/data/options-chain-v3') return 80;
    if (pathname === '/data/history') return 40;
    if (pathname.startsWith('/api/v3/screeners/')) return 20;
    return 30;
  }

  function enqueue(task, priority) {
    return new Promise((resolve, reject) => {
      waitingQueue.push({ task, priority, sequence: queueSequence++, resolve, reject });
      queuedRequests = waitingQueue.length;
      void drainQueue();
    });
  }

  async function drainQueue() {
    if (queueActive) return;
    queueActive = true;
    try {
      while (waitingQueue.length) {
        waitingQueue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        const item = waitingQueue.shift();
        queuedRequests = waitingQueue.length;
        try { item.resolve(await item.task()); }
        catch (error) { item.reject(error); }
      }
    } finally {
      queueActive = false;
      if (waitingQueue.length) void drainQueue();
    }
  }

  function cacheTtl(target) {
    if (target.pathname === '/data/history') return historyCacheMs;
    if (target.pathname === '/data/options-chain-v3') return optionChainCacheMs;
    return 0; // Quotes, including option premiums, must always be fetched live.
  }

  function makeResponse(entry, cacheAgeMs = 0, cacheHit = false) {
    const headers = new Headers(entry.headers);
    headers.set('X-DhanPulse-Cache', cacheHit ? 'HIT' : 'MISS');
    headers.set('X-DhanPulse-Cache-Age-Ms', String(Math.max(0, cacheAgeMs)));
    return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers });
  }

  function retryAfterMs(response) {
    const raw = response.headers?.get?.('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
  }

  function makeCooldownResponse() {
    const remainingMs = Math.max(0, cooldownUntil - now());
    const recoveryProbeRequired = Boolean(cooldownPathname && remainingMs === 0);
    const retrySeconds = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 5;
    return new Response(JSON.stringify({
      s: 'error',
      message: recoveryProbeRequired
        ? 'FYERS Data API recovery probe is pending; only the previously blocked endpoint may be requested. No upstream request was sent.'
        : 'FYERS Data API circuit breaker is active; no upstream request was sent.',
      retryAfterSeconds: retrySeconds,
      cooldownReason,
      recoveryProbeRequired
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retrySeconds),
        'x-dhanpulse-cooldown': 'active'
      }
    });
  }

  function cooldownBlocksPath(pathname, timestamp = now()) {
    if (!cooldownPathname) return cooldownUntil > timestamp;
    if (cooldownUntil > timestamp) return true;
    return pathname !== cooldownPathname;
  }

  function makeQueueFullResponse() {
    return new Response(JSON.stringify({s:'error',message:'FYERS REST request budget queue is full; no upstream request was sent.'}),{status:503,headers:{'content-type':'application/json','x-fyers-budget':'queue-full'}});
  }

  function makePersistenceFailureResponse() {
    return new Response(JSON.stringify({
      s: 'error', message: 'FYERS cooldown could not be durably persisted; Data API requests are blocked fail-closed.'
    }), { status: 503, headers: { 'content-type': 'application/json', 'x-dhanpulse-cooldown': 'persistence-failed' } });
  }

  async function activateCooldown(response, body, pathname, requestUrl, method) {
    const server = String(response.headers?.get?.('server') || '');
    const cfRay = String(response.headers?.get?.('cf-ray') || '');
    const cloudflare1015 =
      /error\s*1015|cloudflare.{0,120}1015|1015.{0,120}cloudflare/i.test(body) ||
      (/cloudflare/i.test(server) && Boolean(cfRay));
    const retryMs = Math.min(maxCooldownMs, retryAfterMs(response));
    let backoffMs;
    if (cloudflare1015) {
      consecutiveCloudflareBlocks += 1;
      const index = Math.min(consecutiveCloudflareBlocks - 1, cloudflareCooldownMs.length - 1);
      backoffMs = cloudflareCooldownMs[index] || cloudflareCooldownMs[cloudflareCooldownMs.length - 1] || 5 * 60_000;
      cooldownReason = 'CLOUDFLARE_1015';
    } else {
      consecutiveRateLimitBlocks += 1;
      const index = Math.min(consecutiveRateLimitBlocks - 1, rateLimitCooldownMs.length - 1);
      backoffMs = rateLimitCooldownMs[index] || rateLimitCooldownMs[rateLimitCooldownMs.length - 1] || 60_000;
      cooldownReason = 'HTTP_429';
    }
    // Retry-After: 0 is not a meaningful clearance signal. Use a conservative
    // local backoff and never let a provider header shorten it.
    cooldownPathname = pathname;
    cooldownProbeMethod = method;
    cooldownProbeUrl = method === 'GET' ? String(requestUrl) : null;
    cooldownGeneration += 1;
    cooldownUntil = Math.max(cooldownUntil, now() + Math.min(maxCooldownMs, Math.max(backoffMs, retryMs)));
    if (typeof onCooldownChange === 'function') {
      try {
        const persisted = await onCooldownChange({ cooldownUntil, cooldownReason, cooldownPathname, cooldownProbeUrl, cooldownProbeMethod, cooldownGeneration,
          consecutiveCloudflareBlocks, consecutiveRateLimitBlocks });
        if (persisted === false) throw new Error('durable cooldown store is unavailable');
      } catch (error) {
        cooldownPersistenceHealthy = false;
        console.error('FYERS cooldown persistence failed; further Data API requests are blocked until restart and state recovery:', String(error?.message || error).slice(0, 160));
      }
    }
  }

  async function run(url, init = {}) {
    const target = url instanceof URL ? new URL(url.toString()) : new URL(String(url));
    if (target.hostname !== 'api-t1.fyers.in' || (!allApiPaths && !target.pathname.startsWith('/data/'))) {
      return fetchImpl(url, init);
    }

    // timeoutMs is intentionally converted to an AbortSignal only after the
    // request has passed the shared queue, pacing and cooldown gates. Creating
    // the timeout before queueing incorrectly spent the network timeout while
    // waiting for the four-second gap / rolling-minute budget.
    const { timeoutMs = 12_000, signal: callerSignal, bypassCache = false, priority: requestedPriority, ...fetchInit } = init;
    const method = String(fetchInit.method || 'GET').toUpperCase();
    const ttl = method === 'GET' ? cacheTtl(target) : 0;
    const cacheKey = ttl > 0 ? target.toString() : null;
    const quoteFlightKey = method === 'GET' && target.pathname === '/data/quotes'
      ? 'quote:' + target.toString()
      : null;
    const inFlightKey = (cacheKey && bypassCache !== true) ? cacheKey : quoteFlightKey;
    const currentTime = now();

    // Validated callers still decide whether cached candles are fresh enough.
    // A cached historical response may be served during a quote API cooldown.
    if (cacheKey && bypassCache !== true) {
      const cached = responseCache.get(cacheKey);
      if (cached && currentTime - cached.storedAt < ttl) {
        return makeResponse(cached, currentTime - cached.storedAt, true);
      }
      if (cached) responseCache.delete(cacheKey);
    }

    if (!cooldownPersistenceHealthy) return makePersistenceFailureResponse();
    if (cooldownBlocksPath(target.pathname, currentTime)) return makeCooldownResponse();

    const pending = inFlightKey && inFlight.get(inFlightKey);
    if (pending) {
      const result = await pending;
      if (result.cacheEntry) return makeResponse(result, Math.max(0, now() - result.storedAt), true);
      return result.response.clone();
    }

    if (pendingRequests >= maxQueuedRequests) return makeQueueFullResponse();
    pendingRequests += 1;
    const requestPriority = Number.isFinite(Number(requestedPriority))
      ? Math.max(0, Math.min(100, Number(requestedPriority)))
      : defaultRequestPriority(target.pathname);
    const requestPromise = (async () => {
      const result = await enqueue(async () => {
        // Recheck inside the serial queue: calls already waiting when a 1015
        // arrives must be stopped locally instead of hitting the same WAF.
        if (!cooldownPersistenceHealthy) return { response: makePersistenceFailureResponse() };
        if (cooldownBlocksPath(target.pathname, now())) return { response: makeCooldownResponse() };

        let time = now();
        while (true) {
          time = now();
          requestTimes = requestTimes.filter(stamp => time - stamp < windowMs);
          const intervalWait = lastRequestAt ? Math.max(0, lastRequestAt + minIntervalMs - time) : 0;
          const windowWait = requestTimes.length >= maxRequestsPerMinute
            ? Math.max(0, requestTimes[0] + windowMs - time)
            : 0;
          const waitMs = Math.max(intervalWait, windowWait);
          if (waitMs <= 0) break;
          await sleep(waitMs);
        }

        // A prior queued request may have opened the circuit while this one waited.
        if (!cooldownPersistenceHealthy) return { response: makePersistenceFailureResponse() };
        if (cooldownBlocksPath(target.pathname, now())) return { response: makeCooldownResponse() };

        time = now();
        requestTimes.push(time);
        lastRequestAt = time;
        const requestCooldownGeneration = cooldownGeneration;
        const timeoutSignal = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 12_000));
        const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
        const response = await fetchImpl(url, { ...fetchInit, signal });
        let recoveryResponseValid = false;
        if (response.ok && cooldownPathname === target.pathname &&
            requestCooldownGeneration === cooldownGeneration) {
          const recoveryPayload = await response.clone().json().catch(() => null);
          recoveryResponseValid = isValidFyersRecoveryPayload(target.pathname, recoveryPayload);
        }
        if (response.status === 429) {
          const body = await response.clone().text().catch(() => '');
          await activateCooldown(response, body, target.pathname, target.toString(), method);
        } else if (canClearFyersDataApiCooldown({
          responseOk: response.ok,
          responseValid: recoveryResponseValid,
          blockedPathname: cooldownPathname,
          responsePathname: target.pathname,
          requestGeneration: requestCooldownGeneration,
          currentGeneration: cooldownGeneration
        })) {
          // Only a successful probe to the blocked endpoint, started after
          // the latest 1015, is allowed to clear that endpoint's circuit.
          consecutiveCloudflareBlocks = 0;
          consecutiveRateLimitBlocks = 0;
          cooldownPathname = null;
          cooldownProbeUrl = null;
          cooldownProbeMethod = null;
          cooldownUntil = 0;
          cooldownReason = null;
          if (typeof onCooldownChange === 'function') {
            try {
              const persisted = await onCooldownChange({ cooldownUntil: 0, cooldownReason: null, cooldownPathname: null,
                cooldownProbeUrl: null, cooldownProbeMethod: null, cooldownGeneration, consecutiveCloudflareBlocks, consecutiveRateLimitBlocks });
              if (persisted === false) throw new Error('durable cooldown store is unavailable');
              cooldownPersistenceHealthy = true;
            } catch (error) {
              cooldownPersistenceHealthy = false;
              console.error('FYERS cooldown clear could not be durably persisted; Data API requests remain blocked:', String(error?.message || error).slice(0, 160));
            }
          }
        }

        if ((cacheKey && response.ok) || quoteFlightKey) {
          const body = await response.clone().text();
          const entry = {
            body, status: response.status, statusText: response.statusText,
            headers: [...response.headers.entries()], storedAt: now()
          };
          if (cacheKey && response.ok) {
            responseCache.set(cacheKey, entry);
            while (responseCache.size > maxCacheEntries) {
              responseCache.delete(responseCache.keys().next().value);
            }
          }
          return { ...entry, cacheEntry: true };
        }
        return { response };
      }, requestPriority);
      return result.cacheEntry ? result : { response: result.response };
    })();

    if (inFlightKey) inFlight.set(inFlightKey, requestPromise);
    try {
      const result = await requestPromise;
      if (result.cacheEntry) return makeResponse(result, 0);
      return result.response;
    } finally {
      pendingRequests = Math.max(0, pendingRequests - 1);
      if (inFlightKey && inFlight.get(inFlightKey) === requestPromise) inFlight.delete(inFlightKey);
    }
  }

  run.restoreStatus = state => {
    const until = Date.parse(String(state?.blockedUntil || ''));
    // Keep an expired cooldown's blocked endpoint until its own recovery probe
    // succeeds. Otherwise a process restart after Retry-After silently reopens
    // every FYERS REST path without proving that the original path recovered.
    if (!Number.isFinite(until) || until - now() > maxCooldownMs ||
        !(String(state?.cooldownPathname || '').startsWith('/data/') || (allApiPaths && String(state?.cooldownPathname || '').startsWith('/api/v3/')))) return false;
    cooldownPersistenceHealthy = true;
    cooldownUntil = until;
    cooldownReason = String(state.cooldownReason || 'RESTORED_COOLDOWN').slice(0, 40);
    cooldownPathname = state.cooldownPathname;
    cooldownProbeMethod = String(state.cooldownProbeMethod || '').toUpperCase() === 'GET' ? 'GET' : null;
    try {
      const probeUrl = new URL(String(state.cooldownProbeUrl || ''));
      cooldownProbeUrl = cooldownProbeMethod === 'GET' && probeUrl.hostname === 'api-t1.fyers.in' &&
        probeUrl.pathname === cooldownPathname && !probeUrl.username && !probeUrl.password
        ? probeUrl.toString() : null;
    } catch { cooldownProbeUrl = null; }
    cooldownGeneration = Math.max(cooldownGeneration, Number(state.cooldownGeneration) || 0);
    consecutiveCloudflareBlocks = Math.max(0, Number(state.consecutiveCloudflareBlocks) || 0);
    consecutiveRateLimitBlocks = Math.max(0, Number(state.consecutiveRateLimitBlocks) || 0);
    return true;
  };

  run.getStatus = () => {
    const remainingMs = Math.max(0, cooldownUntil - now());
    const recoveryProbeRequired = Boolean(cooldownPathname && remainingMs === 0);
    return {
      cooldownActive: remainingMs > 0 || recoveryProbeRequired,
      recoveryProbeRequired,
      recoveryProbePathname: recoveryProbeRequired ? cooldownPathname : null,
      cooldownPersistenceHealthy,
      retryAfterSeconds: remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : recoveryProbeRequired ? 5 : 0,
      blockedUntil: cooldownPathname ? new Date(cooldownUntil).toISOString() : null,
      blockedPathname: cooldownPathname,
      recoveryProbeUrl: recoveryProbeRequired ? cooldownProbeUrl : null,
      cooldownReason: cooldownPathname ? cooldownReason : null,
      consecutiveCloudflareBlocks,
      consecutiveRateLimitBlocks,
      queuedRequests,
      pendingRequests
    };
  };

  return run;
}
