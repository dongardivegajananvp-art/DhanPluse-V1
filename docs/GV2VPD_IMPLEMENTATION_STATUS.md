# GV2VPD implementation status — Phase 1

This branch is a code implementation proposal for the existing DhanPluse-V1 repository. It does not merge, deploy, restart Render, change production environment variables, or place broker orders.

## Implemented in this branch

- Preserves the existing FYERS OAuth login and its existing backend-issued Dashboard Session. No second App Login, SMS OTP, mobile registration, or duplicate authentication gate is added.
- Private market, quote, candle, portfolio and signal endpoints continue to require the existing FYERS Dashboard Session; the existing FYERS OAuth exchange remains the only login/connect flow.
- Changes the app shell to exactly three visible navigation tabs: Home, Sureshot, Position.
- Home is the default landing page and maps to the existing Dashboard renderer. It now reads FYERS `/api/v3/funds` by `fund_limit[].title` and the current positions endpoint to show available balance, utilised margin, realised P&L and unrealised P&L; missing broker fields remain unavailable rather than being displayed as zero.
- Sureshot maps to the existing verified FYERS Sureshot scanner; existing scan behavior is retained rather than silently replacing strategy logic.
- Position reads the backend's FYERS positions endpoint and displays broker-returned rows; it does not synthesize positions or fills.
- Adds the fixed Sureshot option risk model and wires it into the existing NSE/MCX auto-plan scanner: Entry = verified ask, SL = 30% below entry, T1 = 1.5x, T2 = 2.5x, tick-rounded values, lot-level rupee risk/reward, and T2 >=1:2 T1 RR. The model still requires 12 fresh completed option candles and verified lot/tick metadata.
- NSE/MCX auto-plan selection now requires the exact ATM + 1 OTM strike, official FYERS nested delta in the absolute 0.35–0.55 band, and verified ask premium ₹30–₹150. Option-chain LTP/OI/volume remain excluded; premium is independently read from a fresh quote.
- The NSE F&O auto-scan now publishes separate Top 10 Gainers and Top 10 Losers boards from the complete verified F&O equity snapshot, then selects up to five stock candidates from those boards for option verification. Index ticks do not displace stock candidates.
- NSE/MCX Sureshot direction now has a strict trend gate: ADX(14) >=20, EMA(20) direction/slope, current-session VWAP alignment, same-elapsed-time volume ratio >=1.5 against five prior sessions, transparent Trend Score >=70, and final NSE selection blocked before 09:30. Candle history requests include a ten-calendar-day window to find five prior sessions.
- Updates app identity/PWA manifest/cache to GV2VPD.
- Adds structural checks for the three-tab shell and verifies the existing FYERS Dashboard Session remains the authentication mechanism.

## Still blocked / not claimed complete

- The current NSE auto-scan shows Top 10 gainers/losers and verifies up to five candidates from those boards. It is not yet a full five-contract shortlist when fewer than five candidates pass; it correctly returns fewer or zero rather than relaxing gates.
- Position currently displays FYERS broker positions; durable paper-trade creation, paper BUY/Manual Exit controls, automatic SL/T1/T2 paper exits, daily loss lock and restart reconciliation remain to be implemented.
- Live order placement remains disabled. Existing backend /api/orders/* still returns 403. Do not remove that block until static-IP eligibility for the FYERS Trading App, broker permissions, order-fill reconciliation, protection acknowledgement, partial-fill handling, two-target allocation, daily loss lock, max-two-position guard and emergency exit tests have all passed.
- The current Render Free service does not provide the dedicated static egress IP required by the FYERS Individual Trading App. No paid hosting change is made here.

## Required verification before merge/deploy

1. CI: backend node --test, frontend structural checks, syntax checks and all existing repository checks pass.
2. Existing FYERS OAuth callback and Dashboard Session issue/validation remain unchanged.
3. A browser without a valid FYERS Dashboard Session cannot call private market, quote, candle, portfolio or signal APIs.
4. The existing FYERS OAuth callback, socket reconnect, fresh exchange timestamps, and current Sureshot scanner pass regression tests.
5. Production UI is not changed until all remaining scope and deployment checks are complete.

**Safety:** no live orders, no fake data, no automatic deployment, and no secret/config mutation in this branch.

## Production health investigation — 2026-11-08

- The PR validation job completed JavaScript syntax, PWA asset, backend unit tests, dependency graph checks, and dependency audit successfully.
- The production health step then made six attempts against the original Render `/health` endpoint and received no valid response. The workflow exited before its CORS checks; therefore this run does not establish a CORS regression.
- Render service metadata still identifies the original service as the Free plan on the `main` branch. No service settings were changed.
- Render startup logs from 2026-11-08 08:49–08:50 UTC show the Node server binding port 10000 and Render reporting the service live. The same startup logs show the encrypted PostgreSQL-restored FYERS token was rejected as expired (`Failed to decode JWT: You are passing an expired token`), and the in-memory FYERS session was cleared. Thus FYERS authentication and live market data were not ready.
- No Render request logs or service events were returned for the CI health-check window 13:50–14:15 UTC. This is consistent with an unreachable/asleep or otherwise non-responsive Free instance at that time, but does not prove which Render runtime condition caused it.
- Required next verification: wake/check the original service through a user-approved normal visit or Render dashboard, inspect the current instance/app logs, then run `/health`, `/api/status`, allowed-origin preflight, and denied-origin checks again. Reconnect FYERS through the existing OAuth flow only when the user is present. Do not rotate, overwrite, or clear the persisted token manually.
- No deployment, restart, environment mutation, database mutation, token refresh, or live order was performed during this investigation.

## Latest verification pass — 2026-11-08 (15:10 UTC)

- Corrected PR head `e0f7f7d878ed8b5ba6f2e62aa78f42767135b158` passed JavaScript syntax, PWA/three-tab structural checks, dependency audit and backend regression tests in GitHub Actions.
- The dedicated backend workflow passed, including the new FYERS funds mapping tests. A real authenticated FYERS funds/positions response is still not available for an integration test.
- The production health/CORS workflow failed after six attempts between 15:07 and 15:08 UTC because the original Render `/health` endpoint returned no valid response. It did not reach the CORS checks.
- Render request/application logs queried for 15:08–15:10 UTC returned no records; the latest Render service events still show the last successful deploy at 08:50 UTC. This does not establish the exact reason the endpoint is unreachable.
- The original Render service remains on Free and tracks `main`; no production deploy, restart, environment/database mutation, token refresh, or live order was initiated.
- FYERS needs a fresh user-authorized OAuth connection. Persistent Paper Mode ledger/auto exits/reconciliation remain outstanding; live order routes remain HTTP 403.


## Login correction — existing login preserved

- Removed the added MSG91 OTP/mobile App Login UI, frontend storage/header requirement, backend OTP routes, and global /api OTP session middleware from this implementation branch.
- Removed the new App Login module and its OTP-only unit tests; the existing FYERS OAuth + Dashboard Session flow remains the single login/connect mechanism.
- Updated structural checks to fail if a duplicate OTP login gate returns and to assert the original Dashboard Session bearer flow remains.
- No Render environment variables, PostgreSQL tables, FYERS tokens, production deployment, or live order permissions were changed.
