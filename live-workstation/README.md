# GV2VPD Live Trading Workstation

A separate single-screen app in `live-workstation/`. Scope is only the four workstation panels: Market Watch, 5-minute chart, option/order panel, and positions/orders. No scanner tabs or old-app UI are included.

## Deploy configuration (new service only)
- Root directory: `live-workstation`
- Build: `npm install`
- Start: `npm start`
- Reuse existing secret values privately: `FYERS_APP_ID`, `DATABASE_URL`, `FYERS_TOKEN_ENCRYPTION_KEY`.
- Set `APP_ORIGIN` to the exact new workstation origin.
- Do not paste secrets or tokens into source/chat.

## Existing FYERS login
The new backend SELECTs the existing AES-256-GCM encrypted `dhanpulse_fyers_auth` row, using the same key and AAD as the old backend. It does not write, clear, or refresh that row. The token stays server-side. The old app code and service are untouched.

## Implemented in this branch
- One FYERS Data Socket V3 instance for the workstation; browser refreshes read local cache only.
- NIFTY 50, BANK NIFTY, SENSEX, selected instrument, selected option, and up to five stock-futures movers share that one socket.
- FYERS Standard Screeners configuration is cached for 24 hours; the stock-futures gainer screener is refreshed at most every 15 minutes, not a 218-symbol REST quote scan. Live % is recalculated from streamed ticks after subscription. If FYERS does not expose a valid futures gainer screener, the UI shows no verified result rather than inventing one.
- 5-minute history is fetched only after chart instrument selection and cached per symbol.
- CE/PE candidates come from the FYERS Option Chain API and are cross-checked against the official NSE F&O Symbol Master for active status, lot size and tick size. The selected option premium is then read from the WebSocket.
- Positions, overall P&L and order book are read from authenticated FYERS account APIs.
- Order adapter uses FYERS synchronous order placement, market-protected order type, linked SL/target, explicit second confirmation, fresh premium gate, official lot/tick-size validation, max-quantity cap and duplicate request-ID protection. It never auto-retries an uncertain order.
- MCX chart symbol selection and NSE/MCX tick caches remain separate. No MCX full-universe REST scan.

## Production gates still closed
- `LIVE_ORDERS_ENABLED` must remain false until a reviewed production deployment is explicitly approved.
- Live order gate also requires a FYERS Trading App ID ending in `200`, `FYERS_STATIC_IP_CONFIRMED=true` (only after the backend outbound static IP is allowlisted by FYERS), and a positive `MAX_ORDER_RISK_INR` per-order loss cap. `MAX_ORDER_QTY` can further cap quantity. App-type and IP eligibility have not been confirmed.
- FYERS SDK supports automatic reconnect with a retry count up to 50. The SDK documentation does not specify a strict five-second reconnect interval; this must be measured in a deployed test before claiming a 5-second SLA.
- The code has not yet been run against the user's live FYERS session. Contract discovery, market movers, live tick timestamps, account responses, and broker order validation still need end-to-end verification. The option-chain response is parsed from FYERS' documented `data.optionsChain` envelope and contracts are checked against the exchange-specific symbol master.
- No live order has been sent. No merge or deployment has been performed.
