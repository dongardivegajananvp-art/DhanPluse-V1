# GV2VPD Live Trading Workstation

Standalone workstation surface, isolated from the existing multi-tab scanner app. Single backend process owns one FYERS Data Socket V3 connection. The UI polls only the local backend; no browser-to-FYERS sockets and no 218-symbol scan.

## Deployment
- Render web service root command: `cd live-workstation && npm install && npm start`
- Build command: `cd live-workstation && npm install`
- Set secrets in Render only: `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI`, `FYERS_TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `APP_ORIGIN`.
- Never commit access tokens or secrets.

## Safety status
Live order route is intentionally locked. The FYERS order/position adapter, encrypted token persistence/OAuth callback, contract lookup, quote-age gate, risk checks, and order reconciliation must be implemented and tested before enabling `LIVE_ORDERS_ENABLED=true`. No order is sent by this initial scaffold.

## Required production behavior
- One SDK-managed FYERS Data Socket V3 connection; re-subscribe on connect.
- Selected symbol changes trigger one history request; repeated selection is cached in the UI.
- No F&O full-universe scan; top gainers require a bounded, broker-approved source list and fresh ticks.
- NSE and MCX subscription/error handling must be isolated.
