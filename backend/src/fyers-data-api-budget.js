// FYERS Standard-plan Data API budget is shared across Data API endpoints.
// Keep a safety margin below the published 50 requests/minute limit and avoid
// bursts. A Cloudflare 1015 response blocks further Data API calls globally.
export function createFyersDataApiBudget({
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxRequestsPerMinute = 45,
  minIntervalMs = 1250,
  windowMs = 60_000,
  cloudflareCooldownMs = 60 * 60_000,
  rateLimitCooldownMs = 60_000
} = {}) {
  let queue = Promise.resolve();
  let requestTimes = [];
  let lastRequestAt = 0;
  let blockedUntil = 0;

  async function run(url, init) {
    const target = url instanceof URL ? url : new URL(String(url));
    if (target.hostname !== 'api-t1.fyers.in' || !target.pathname.startsWith('/data/')) {
      return fetchImpl(url, init);
    }

    const current = queue.then(async () => {
      let currentTime = now();
      if (currentTime < blockedUntil) {
        const error = new Error(`FYERS Data API cooldown active. Retry in about ${Math.ceil((blockedUntil - currentTime) / 1000)} seconds.`);
        error.statusCode = 429;
        throw error;
      }

      while (true) {
        currentTime = now();
        requestTimes = requestTimes.filter(time => currentTime - time < windowMs);
        const intervalWait = lastRequestAt ? Math.max(0, lastRequestAt + minIntervalMs - currentTime) : 0;
        const windowWait = requestTimes.length >= maxRequestsPerMinute
          ? Math.max(0, requestTimes[0] + windowMs - currentTime)
          : 0;
        const waitMs = Math.max(intervalWait, windowWait);
        if (waitMs <= 0) break;
        await sleep(waitMs);
        if (now() < blockedUntil) {
          const error = new Error(`FYERS Data API cooldown active. Retry in about ${Math.ceil((blockedUntil - now()) / 1000)} seconds.`);
          error.statusCode = 429;
          throw error;
        }
      }

      currentTime = now();
      requestTimes.push(currentTime);
      lastRequestAt = currentTime;
      const response = await fetchImpl(url, init);
      if (response.status === 429) {
        const body = await response.clone().text().catch(() => '');
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const cloudflare1015 = /error\s*1015|cloudflare.{0,80}1015/i.test(body);
        const cooldown = cloudflare1015
          ? cloudflareCooldownMs
          : Math.max(rateLimitCooldownMs, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0);
        blockedUntil = Math.max(blockedUntil, now() + cooldown);
      }
      return response;
    });

    queue = current.catch(() => {});
    return current;
  }

  return run;
}
