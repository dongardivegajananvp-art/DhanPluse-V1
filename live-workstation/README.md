# GV2VPD Live Trading Workstation

Standalone single-screen workstation in `live-workstation/`; the existing multi-tab scanner app is not modified. The workstation backend owns one FYERS Data Socket V3 connection. Browser refreshes read only the local in-memory tick cache; no 218-symbol REST scan is used.

## Render service configuration
- Root directory: `live-workstation`
- Build command: `npm install`
- Start command: `npm start`
- Copy these existing secret values into the new service's private environment settings: `FYERS_APP_ID`, `DATABASE_URL`, and `FYERS_TOKEN_ENCRYPTION_KEY`.
- `APP_ORIGIN` should be the exact deployed workstation origin.
- Never paste or commit credentials, database URLs, encryption keys, or access tokens into chat or source.

## Existing FYERS login reuse
The workstation reads the already encrypted row from `dhanpulse_fyers_auth` using the same AES-256-GCM key and AAD as the existing app. It performs a SELECT only: it does not overwrite, clear, or re-authenticate the old app's token. The existing app remains unchanged. If the shared session is absent or invalid, the market stream stays disconnected. The token is held only in backend memory and is never sent to the browser.

## Current implementation and gates
- One SDK-managed FYERS Data Socket V3 connection with automatic SDK reconnect.
- Index ticks are cached in memory; UI reads local cache, not FYERS REST quotes.
- Selected instrument change requests 5-minute history once; server and browser cache the result.
- Completed candles only (range ends one 5-minute interval before current time) and validated OHLC rows are rendered as candlesticks.
- No F&O full-universe scan. A genuine all-F&O top-five feed still needs a broker-provided movers source or explicit bounded coverage; no fake rankings are shown.
- Live BUY/SELL remains locked. Order submission, option contract resolution, NSE/MCX independent workflows, live broker positions/P&L reconciliation, and end-to-end tests are not yet production-ready. Do not set `LIVE_ORDERS_ENABLED=true`.
- No order has been sent. No merge or deployment has been performed.
