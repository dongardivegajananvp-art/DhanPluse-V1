// FYERS Data API calls share upstream/IP-level throttling. Serialize requests,
// coalesce identical in-flight reads, and briefly cache successful market-data
// snapshots so UI refreshes do not create duplicate provider traffic.
// Never retry a 429/Cloudflare 1015 automatically.
export function createFyersDataApiBudget({
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxRequestsPerMinute = 30,
  minIntervalMs = 2000,
  windowMs = 60_000,
  // FYERS 429/Cloudflare 1015 is reported but never converted into an
  // application-side cooldown. Continue serialized, paced requests so a
  // provider block cannot freeze the workstation for 15-60 minutes.
  historyCacheMs = 5 * 60_000,
  // Contract descriptors contain identity/expiry only (never premium/OI/volume).
  optionChainCacheMs = 60_000,
  maxCacheEntries = 100
} = {}) {
  let queue = Promise.resolve();
  let requestTimes = [];
  let lastRequestAt = 0;
  let consecutiveCloudflareBlocks = 0;
  const responseCache = new Map();
  const inFlight = new Map();

  function cacheTtl(target) {
    if (target.pathname === '/data/history') return historyCacheMs;
    if (target.pathname === '/data/options-chain-v3') return optionChainCacheMs;
    return 0; // Quotes must always be fetched live; never cache option premiums.
  }

  function makeResponse(entry, cacheAgeMs = 0, cacheHit = false) {
    const headers = new Headers(entry.headers);
    headers.set('X-DhanPulse-Cache', cacheHit ? 'HIT' : 'MISS');
    headers.set('X-DhanPulse-Cache-Age-Ms', String(Math.max(0, cacheAgeMs)));
    return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers });
  }

  async function run(url, init) {
    const target = url instanceof URL ? new URL(url.toString()) : new URL(String(url));
    if (target.hostname !== 'api-t1.fyers.in' || !target.pathname.startsWith('/data/')) {
      return fetchImpl(url, init);
    }

    const method = String(init?.method || 'GET').toUpperCase();
    const ttl = method === 'GET' ? cacheTtl(target) : 0;
    const cacheKey = ttl > 0 ? target.toString() : null;
    // Quote responses (including option premiums) are never cached, but
    // identical concurrent GETs share one in-flight upstream request.
    const quoteFlightKey = method === 'GET' && target.pathname === '/data/quotes'
      ? 'quote:' + target.toString()
      : null;
    const inFlightKey = cacheKey || quoteFlightKey;
    const currentTime = now();
    if (cacheKey) {
      const cached = responseCache.get(cacheKey);
      if (cached && currentTime - cached.storedAt < ttl) {
        return makeResponse(cached, currentTime - cached.storedAt, true);
      }
      if (cached) responseCache.delete(cacheKey);
    }
    const pending = inFlightKey && inFlight.get(inFlightKey);
    if (pending) {
      const result = await pending;
      if (result.cacheEntry) {
        return makeResponse(result, Math.max(0, now() - result.storedAt), true);
      }
      return result.response.clone();
    }

    const requestPromise = (async () => {
      const current = queue.then(async () => {
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

        time = now();
        requestTimes.push(time);
        lastRequestAt = time;
        const response = await fetchImpl(url, init);
        if (response.status === 429) {
          const body = await response.clone().text().catch(() => '');
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const server = String(response.headers?.get?.('server') || '');
          const cfRay = String(response.headers?.get?.('cf-ray') || '');
          const cloudflare1015 = /error\s*1015|cloudflare.{0,120}1015|1015.{0,120}cloudflare/i.test(body) ||
            (/cloudflare/i.test(server) && Boolean(cfRay));
          if (cloudflare1015) consecutiveCloudflareBlocks += 1;
          // Record repeated upstream blocks for diagnostics only. Never impose
          // a local 429/1015 cooldown that suppresses subsequent requests.
        } else if (response.ok) {
          // A successful provider response is the only evidence that the WAF
          // throttle has cleared; do not reset the escalation merely on timer expiry.
          consecutiveCloudflareBlocks = 0;
        }

        if ((cacheKey && response.ok) || quoteFlightKey) {
          const body = await response.clone().text();
          const entry = {
            body, status: response.status, statusText: response.statusText,
            headers: [...response.headers.entries()], storedAt: now()
          };
          // Only successful history/option-chain responses persist in cache.
          // Quotes are serialized for concurrent callers and immediately
          // evicted from inFlight when the request settles.
          if (cacheKey && response.ok) {
            responseCache.set(cacheKey, entry);
            while (responseCache.size > maxCacheEntries) {
              responseCache.delete(responseCache.keys().next().value);
            }
          }
          return { ...entry, cacheEntry: true };
        }
        return { response };
      });
      queue = current.then(() => {}, () => {});
      const result = await current;
      return result.cacheEntry ? result : { response: result.response };
    })();

    if (inFlightKey) inFlight.set(inFlightKey, requestPromise);
    try {
      const result = await requestPromise;
      if (result.cacheEntry) return makeResponse(result, 0);
      return result.response;
    } finally {
      if (inFlightKey && inFlight.get(inFlightKey) === requestPromise) inFlight.delete(inFlightKey);
    }
  }

  run.getStatus = () => ({
    cooldownActive: false,
    retryAfterSeconds: 0,
    blockedUntil: null,
    cooldownReason: null,
    consecutiveCloudflareBlocks,
    queuedRequests: 0
  });

  return run;
}
