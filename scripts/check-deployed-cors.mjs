const backend = process.env.DHANPULSE_TEST_BACKEND || "https://dhanpulse-clean-test.onrender.com";
const origins = (process.env.DHANPULSE_PREVIEW_ORIGINS || process.env.DHANPULSE_PREVIEW_ORIGIN || "https://deploy-preview-42--spectacular-gaufre-b5c029.netlify.app")
  .split(",").map(value => value.trim()).filter(Boolean);

async function requestWithRetry(label, makeRequest, validate) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await makeRequest();
      const detail = await validate(response);
      if (detail) throw new Error(detail);
      console.log(`PASS ${label}: HTTP ${response.status}, ACAO=${response.headers.get("access-control-allow-origin")}`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt}/4 failed for ${label}: ${String(error.message || error).slice(0, 220)}`);
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastError?.message || lastError)}`);
}

for (const origin of origins) {
  await requestWithRetry(`test backend GET /api/status CORS for ${origin}`, () =>
    fetch(new URL("/api/status", backend), {
      headers: { Origin: origin, Accept: "application/json" },
      signal: AbortSignal.timeout(90000),
      cache: "no-store"
    }), async response => {
      if (!response.ok) return `Expected HTTP 200, received ${response.status}`;
      if (response.headers.get("access-control-allow-origin") !== origin) return "Exact Access-Control-Allow-Origin header missing or incorrect";
      const payload = await response.json().catch(() => null);
      if (!payload || payload.backend !== "online") return "Backend status payload was not valid";
      return "";
    });

  await requestWithRetry(`test backend OPTIONS preflight for ${origin}`, () =>
    fetch(new URL("/api/market/last-known-stock-quotes", backend), {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type"
      },
      signal: AbortSignal.timeout(90000),
      cache: "no-store"
    }), async response => {
      if (response.status < 200 || response.status >= 300) return `Expected successful preflight, received HTTP ${response.status}`;
      if (response.headers.get("access-control-allow-origin") !== origin) return "Preflight did not echo the exact allowed preview origin";
      const methods = (response.headers.get("access-control-allow-methods") || "").toUpperCase();
      if (!methods.includes("GET")) return "Preflight did not allow GET";
      const headers = (response.headers.get("access-control-allow-headers") || "").toLowerCase();
      if (!headers.includes("authorization") || !headers.includes("content-type")) return "Preflight did not allow Authorization and Content-Type";
      return "";
    });
}

console.log("PASS deployed CORS smoke test for every configured test UI origin. This validates deployed HTTP CORS responses, not FYERS authentication, live quotes, or browser/mobile rendering.");
