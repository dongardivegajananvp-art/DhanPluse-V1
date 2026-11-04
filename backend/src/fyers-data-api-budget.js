// FYERS Data API calls share upstream/IP-level throttling. Serialize requests,
// coalesce identical in-flight reads, and briefly cache successful market-data
// snapshots so UI refreshes do not create duplicate provider traffic.
// Never retry a 429/Cloudflare 1015 automatically.
export function createFyersDataApiBudget({
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxRequestsPerMinute = 40,
  minIntervalMs = 1250,
  windowMs = 60_000,
  cloudflareCooldownMs = 60 * 60_000,
  rateLimitCooldownMs = 60_000,
  // Reuse identical verified OHLC reads for three minutes. Sureshot's candle
  // validators independently reject stale completed bars before any signal.
  historyCacheMs = 3 * 60_000,
  // Contract descriptors contain identity/expiry only (never premium/OI/volume).
  optionChainCacheMs = 60_000,
  maxCacheEntries = 100
} = {}) {
  let queue = Promise.resolve();
  let requestTimes = [];
  let lastRequestAt = 0;
  let blockedUntil = 0;
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
    const currentTime = now();
    if (cacheKey) {
      const cached = responseCache.get(cacheKey);
      if (cached && currentTime - cached.storedAt < ttl) {
        return makeResponse(cached, currentTime - cached.storedAt, true);
      }
      if (cached) responseCache.delete(cacheKey);
      const pending = inFlight.get(cacheKey);
      if (pending) {
        const entry = await pending;
        return makeResponse(entry, Math.max(0, now() - entry.storedAt), true);
      }
    }

    const requestPromise = (async () => {
      const current = queue.then(async () => {
        let time = now();
        if (time < blockedUntil) {
          const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - time) / 1000));
          const error = new Error(`FYERS Data API cooldown active. Retry in about ${retryAfterSeconds} seconds.`);
          error.statusCode = 429;
          error.retryAfterSeconds = retryAfterSeconds;
          throw error;
        }

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
          if (now() < blockedUntil) {
            const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - now()) / 1000));
            const error = new Error(`FYERS Data API cooldown active. Retry in about ${retryAfterSeconds} seconds.`);
            error.statusCode = 429;
            error.retryAfterSeconds = retryAfterSeconds;
            throw error;
          }
        }

        time = now();
        requestTimes.push(time);
        lastRequestAt = time;
        const response = await fetchImpl(url, init);
        if (response.status === 429) {
          const body = await response.clone().text().catch(() => '');
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const cloudflare1015 = /error\s*1015|cloudflare.{0,120}1015|1015.{0,120}cloudflare/i.test(body);
          const cooldown = cloudflare1015
            ? cloudflareCooldownMs
            : Math.max(rateLimitCooldownMs, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0);
          blockedUntil = Math.max(blockedUntil, now() + cooldown);
        }

        if (cacheKey && response.ok) {
          const body = await response.clone().text();
          const entry = {
            body, status: response.status, statusText: response.statusText,
            headers: [...response.headers.entries()], storedAt: now()
          };
          responseCache.set(cacheKey, entry);
          while (responseCache.size > maxCacheEntries) {
            responseCache.delete(responseCache.keys().next().value);
          }
          return { ...entry, cacheEntry: true };
        }
        return { response };
      });
      queue = current.then(() => {}, () => {});
      const result = await current;
      return result.cacheEntry ? result : { response: result.response };
    })();

    if (cacheKey) inFlight.set(cacheKey, requestPromise);
    try {
      const result = await requestPromise;
      if (result.cacheEntry) return makeResponse(result, 0);
      return result.response;
    } finally {
      if (cacheKey && inFlight.get(cacheKey) === requestPromise) inFlight.delete(cacheKey);
    }
  }

  run.getStatus = () => {
    const currentTime = now();
    const retryAfterSeconds = Math.max(0, Math.ceil((blockedUntil - currentTime) / 1000));
    return {
      cooldownActive: retryAfterSeconds > 0,
      retryAfterSeconds,
      blockedUntil: blockedUntil > currentTime ? new Date(blockedUntil).toISOString() : null,
      queuedRequests: 0
    };
  };

  return run;
}
