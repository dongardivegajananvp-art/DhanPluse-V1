# DhanPulse Clean Rebuild

A clean, verification-first rebuild of DhanPulse for Indian-market research using FYERS market data.

## Non-negotiable rules
- Never label cached/stale data as live.
- Never generate a trade signal when required data is missing, stale, invalid, or unverified.
- FYERS credentials stay server-side; never commit secrets.
- Order placement remains disabled.
- Candles must come from validated OHLC data; no synthetic candles or placeholder prices.
- Rate limits use server-side cooldowns and bounded requests.
- A feature is complete only after API, UI, and failure-state tests pass.

## Current branch status
The `clean-rebuild` branch contains:
- Server-side FYERS OAuth exchange with a one-time state and expiring dashboard session.
- Historical daily-candle fetch and OHLCV validation for a first set of gap-analysis symbols.
- Gap direction/size calculation and historical session gap-fill statistics.
- A frontend flow for FYERS login and historical gap analysis.

It does **not** yet contain a live quote socket, full F&O Stock Explorer, general candlestick chart UI, option chain, or working scanners. Those features must not be implied by a healthy backend. No deployment has been triggered from this branch.

## Run locally
Requirements: Node.js 20+. Configure environment variables from `backend/.env.example` in the backend process, install dependencies with `npm install` in `backend/`, then run `npm test` and `npm start`. Serve `frontend/` from a local static server and set `window.DHANPULSE_API_BASE` to the backend URL when not using the default `http://localhost:10000`.

The `FYERS_REDIRECT_URI` must exactly match the redirect URI registered in the FYERS developer app and must point to the frontend page that handles the callback. Set `ALLOWED_ORIGIN` to the exact frontend origin. Keep all credentials in the deployment secret store, not in source files.
