# DhanPulse Ultimate — FYERS Edition (starter)

This is a starter scaffold for your DhanPulse dashboard. It is **not yet a verified live-trading application**. Do not use it to place real orders until you have tested FYERS authentication, live quotes/streaming, order permissions, risk controls, and session handling in your own account.

## Included
- Premium dark dashboard with tabs for Dashboard, NIFTY, BANKNIFTY, Watchlist, Option Chain, AI Signals, Holdings, FYERS Settings, and Logs.
- Explicit live-data status; the UI does not generate random market prices.
- Node backend scaffold for server-side FYERS credentials and API requests.
- Environment-variable template and deployment notes.

## Important architecture note
Netlify is suitable for the frontend and request/response functions, but a continuously connected WebSocket bridge may need a persistent Node service. This starter includes a backend scaffold; streaming is not production-wired here. Order placement is deliberately not enabled.

## Setup
1. Deploy the contents of `site/` to Netlify, or use this folder as the project root and follow `netlify.toml`.
2. Deploy `backend/` to a Node.js host that supports your required runtime.
3. Set `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI`, and `PORT` only in the backend environment. Never place secrets in frontend JavaScript or commit `.env` files.
4. Use the official FYERS developer documentation to validate the current authentication, quotes, history, and data-websocket endpoints for your app.
5. Test using read-only market-data access before implementing order placement.

## Status labels
- `Not connected`: no confirmed backend response.
- `Backend online`: backend health check only; this does not mean FYERS data is live.
- `Live data`: must only be shown after a successful, timestamped FYERS response. This scaffold does not claim that live data is connected.
