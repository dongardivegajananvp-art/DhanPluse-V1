# Gap-Up / Gap-Down Analysis — data contract

## Verified data flow
1. User selects **Connect FYERS**. The backend creates a short-lived, one-time OAuth state and redirects to FYERS.
2. The browser returns with the authorization code and state; the backend exchanges it server-side. The app secret and access token never go into frontend code.
3. A short-lived dashboard session token is held in browser session storage and sent as a Bearer token for the protected historical-gap endpoint.
4. The backend requests daily candles from the FYERS history API, validates every OHLCV row, and rejects the whole response if a row is invalid.
5. The gap analysis uses the adjacent daily candles. Results include candle count, selected date range, sample size, fill count, and the descriptive fill rate.

## Opening-gap classification
- Gap percentage = (session open − previous session close) / previous session close × 100.
- The historical endpoint currently supports NIFTY, BANKNIFTY, RELIANCE, TCS, and INFY.
- Relative volume is not yet calculated automatically. Do not treat an unknown volume field as low or high volume.
- Major event flags are contextual warnings, not directional predictions.
- Do not attribute a gap to FII/DII/operators from price alone and do not issue an automatic trade signal.

## Historical gap-fill study
- Input must be verified daily OHLC bars from FYERS.
- A gap is included only when its absolute percentage is at least the configured threshold (default 0.3%).
- A gap is marked filled if that session's low reaches the prior close for a gap-up, or its high reaches the prior close for a gap-down.
- Always show sample size and fill rate together. Do not claim predictive probability from small or biased samples.
- These are descriptive statistics; fees, slippage, event classification, market regime and executable trade rules are not modeled.
- Daily candles cannot tell us the intraday order in which price levels were touched, nor can they prove who caused a gap.

## API
- `GET /api/fyers/auth/start`: starts OAuth and returns an authorization URL.
- `POST /api/fyers/auth/exchange`: exchanges a valid one-time `{ "code": "...", "state": "..." }` pair.
- `GET /api/gap-analysis/history?symbol=NSE:NIFTY50-INDEX&from=YYYY-MM-DD&to=YYYY-MM-DD&minGapPct=0.3`: requires `Authorization: Bearer <dashboardSessionToken>`.
- Protected history range is limited to 365 days per request. Rate-limit responses trigger an endpoint cooldown; no repeated request storm is started.
- `/api/market/quotes` and `/api/market/candles` deliberately return unavailable because this branch does not yet implement live quotes or a general chart-candle endpoint.

## Release status
This branch now contains the server-side OAuth and historical-gap API implementation, plus a frontend flow. It is **not production-ready until** the branch's tests/build pass, FYERS OAuth redirect settings are confirmed, a real authenticated API response is smoke-tested, and rate-limit/expired-session cases are verified. No deployment was triggered. The existing main branch and Render service are untouched.
