# DhanPulse Ultimate — FYERS Edition

DhanPulse is a read-only FYERS market dashboard. The active frontend is published on GitHub Pages and the Node.js backend runs on Render.

## Included

- Dashboard with NIFTY 50 and BANK NIFTY quote panels.
- FYERS OAuth authorization-code exchange with short-lived, one-time state validation.
- WebSocket-only index quotes with exchange-timestamp freshness checks. Index quotes deliberately do not fall back to REST polling.
- Historical OHLC candles and a selected large-cap equity quote snapshot using read-only FYERS REST endpoints.
- Option-chain request, holdings and positions endpoints (account data requires an authenticated FYERS session and relevant permissions).
- Watchlist/scanner views, OHLC-based EMA/RSI/ATR/volume indicators, live-sample momentum summaries, local price alerts, logs and connection diagnostics.
- Responsive dark theme, installable Progressive Web App (PWA), branded icon and an offline shell cache. Live/API responses are never cached as offline market data.
- Capital protection calculator, trade journal and historical-candle backtest for planning and simulation only.

## Deployment

- Frontend (GitHub Pages): https://dongardivegajananvp-art.github.io/DhanPluse-V1/
- Backend (Render): https://dhanpluse-v1.onrender.com
- Backend service root: `backend/`; start command: `npm start`.
- The repository also retains `netlify.toml` for optional alternate hosting; it is not the active GitHub Pages URL above.
- Backend secrets belong only in the backend host environment: `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI`. `ALLOWED_ORIGIN` can list allowed frontend origins separated by commas.
- Keep the FYERS redirect URI exactly aligned with the value registered in the FYERS developer app and backend environment.

## Automated checks

GitHub Actions validates frontend/backend JavaScript syntax, the PWA manifest and required site assets, and audits backend production dependencies on pushes and pull requests.

## Read-only safety

Order placement is intentionally disabled. Never add credentials or access tokens to frontend files. The backend keeps the access token in memory, so a backend restart requires a new FYERS login. A successful health check proves service availability, not live market data.

## Live-market verification (remaining external check)

1. Open DhanPulse and choose **FYERS Settings → Test backend**.
2. Choose **Connect FYERS** and complete the FYERS authorization page.
3. Confirm the dashboard receives `NSE:NIFTY50-INDEX`, `NSE:NIFTYBANK-INDEX` and `BSE:SENSEX-INDEX` with fresh exchange timestamps.
4. Confirm the UI reports live only while the quotes are fresh and the market is in regular session.
5. Verify option chain, candles, movers, holdings and positions individually. Account endpoints require a valid authorized session and relevant FYERS permissions.

## Data integrity and known limits

The dashboard does not fabricate market prices. Market-closed values are described as the latest quotes returned by FYERS, not guaranteed official closing prices. Exchange holidays are not inferred by the frontend session-hours helper. Scanners use a selected large-cap universe, not the full exchange. FII/DII flow and market breadth remain explicitly unavailable unless a verified data source is connected. Momentum summaries are not substitutes for OHLC-based technical indicators. No signal guarantees a result, and backtests do not predict future performance.
