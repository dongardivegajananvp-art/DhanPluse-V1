# DhanPulse Ultimate — FYERS Edition

DhanPulse is a read-only FYERS market dashboard with a Netlify frontend and a persistent Node.js backend.

## Included

- Dashboard, NIFTY 50 and BANK NIFTY quote panels.
- FYERS OAuth authorization-code exchange with short-lived, one-time state validation.
- Live market-data WebSocket stream and read-only REST quote fallback.
- Historical OHLC candles, selected large-cap movers, option-chain request, holdings and positions endpoints.
- Watchlist/scanner views, OHLC-based EMA/RSI/ATR/volume indicators for the indices, live-sample momentum summaries, local price alerts, logs and connection diagnostics.
- Premium responsive dark theme with colorful navigation and cards.
- Installable Progressive Web App (PWA) for desktop, laptop and mobile browsers, with an app manifest, branded icon, and a safe offline shell cache. API/live market responses are never cached as offline data.

## Deployment layout

- Frontend publish directory: `site/` (Netlify config is at repository root).
- Backend service root: `backend/`; start command: `npm start`.
- Backend secrets belong only in the backend host's environment: `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI`. `ALLOWED_ORIGIN` can list allowed frontend origins separated by commas.
- Keep the FYERS redirect URI exactly aligned with the value registered in the FYERS developer app and the backend environment.

## Automated checks

GitHub Actions validates frontend/backend JavaScript syntax, the PWA manifest and required site assets, and audits backend production dependencies on pushes and pull requests.

## Read-only safety

Order placement is intentionally disabled. Do not add credentials or access tokens to frontend files. The backend keeps the access token in memory, so a backend restart requires a new FYERS login. Never treat a successful health check as proof of live data.

## Monday live-market checklist

1. Open DhanPulse and choose **FYERS Settings → Test backend**.
2. Choose **Connect FYERS** and complete the FYERS authorization page.
3. Confirm the dashboard receives both `NSE:NIFTY50-INDEX` and `NSE:NIFTYBANK-INDEX` quotes.
4. Confirm `/api/status` reports a current tick and the UI says live only during market hours.
5. Verify option chain, candles, movers, holdings and positions individually; account endpoints require a valid authorized session and relevant FYERS permissions.

## Data integrity

The dashboard does not fabricate market prices. Market-closed values are described as the latest quotes returned by FYERS, not guaranteed official closing prices. Exchange holidays are not inferred by the frontend session-hours helper. Scanners use a selected large-cap universe and are not a full-exchange scan. AI/momentum summaries based on in-session quote samples are not substitutes for the OHLC-based technical-indicator panel, which requires sufficient verified historical candles. No trade signal guarantees a result.
