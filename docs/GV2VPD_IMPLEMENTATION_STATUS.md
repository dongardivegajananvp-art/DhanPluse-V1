# GV2VPD implementation status — Phase 1

This branch is a code implementation proposal for the existing DhanPluse-V1 repository. It does not merge, deploy, restart Render, change production environment variables, or place broker orders.

## Implemented in this branch

- Preserves the existing FYERS OAuth login and its existing backend-issued Dashboard Session. No second App Login, SMS OTP, mobile registration, or duplicate authentication gate is added.
- Private market, quote, candle, portfolio and signal endpoints continue to require the existing FYERS Dashboard Session; the existing FYERS OAuth exchange remains the only login/connect flow.
- Changes the app shell to exactly three visible navigation tabs: Home, Sureshot, Position.
- Home is the default landing page and maps to the existing Dashboard renderer. It now reads FYERS `/api/v3/funds` by `fund_limit[].title` and the current positions endpoint to show available balance, utilised margin, realised P&L and unrealised P&L; missing broker fields remain unavailable rather than being displayed as zero.
- Sureshot maps to the existing verified FYERS Sureshot scanner; existing scan behavior is retained rather than silently replacing strategy logic.
- Position reads the backend's FYERS positions endpoint and displays broker-returned rows; it does not synthesize positions or fills.
- Adds the fixed Sureshot option risk model and wires it into the existing NSE/MCX auto-plan scanner: Entry = verified ask, SL = 30% below entry, T1 = 1.5x, T2 = 2.5x, tick-rounded values, lot-level rupee risk/reward, T2 reward/risk >=1:2 (T1 ratio is shown separately). The model still requires 12 fresh completed option candles and verified lot/tick metadata.
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

- Earlier corrected PR head `e0f7f7d878ed8b5ba6f2e62aa78f42767135b158` passed JavaScript syntax, PWA/three-tab structural checks, dependency audit and backend regression tests in GitHub Actions.
- Current PR head changes the fixed-risk acceptance ratio to use T2 reward/risk (minimum 2.0) while separately reporting T1 ratio; its new CI runs are in progress.
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


## Paper Mode foundation — 2026-11-09

- Added `backend/src/paper-trading-store.js`, a PostgreSQL-backed durable ledger foundation with idempotency keys, transaction/advisory locking, maximum-two-open-position enforcement, ₹5,000 daily loss lock, fresh exchange-timestamp validation, fixed immutable entry/SL/T1/T2, paper SL/T2 quote processing, T1 milestone recording, and confirmed manual exit.
- Added regression tests for stale/future/missing exchange timestamps, non-FYERS sources, contract identity, risk/reward, and lot quantity.
- Integrated authenticated `/api/paper/positions`, `/api/paper/buy`, and manual-exit routes behind the existing Dashboard Session middleware. The Sureshot final response now issues a 30-second opaque Plan ID bound to the current Dashboard Session; the client cannot submit its own contract, strike, expiry, entry or risk values as authority.
- Paper BUY rechecks the FYERS official lot/tick metadata and fetches a fresh option quote server-side; it requires an exchange timestamp no older than 10 seconds, ask premium ₹30–₹150, the fixed tick-rounded SL/T1/T2 model and T2 reward/risk >=1:2. It also enforces the existing 09:15–15:15 window, idempotency, max-two-open limit, ₹5,000 daily loss lock and ₹5,000 one-lot outlay cap.
- FYERS WebSocket quote frames are fanned out only for server-known open Paper Mode option symbols. Active paper contracts are re-subscribed after socket reconnect/startup; verified fresh ticks update last price and process SL/T2 exits. T1 is recorded as a milestone (no fractional-lot exit is fabricated). Manual Exit fetches a fresh FYERS quote and requires explicit confirmation.
- Position UI now separates actual FYERS broker positions from the PostgreSQL Paper Mode ledger, with Paper BUY available only from a verified Best Setup response that contains a short-lived Plan ID. Paper rows are labelled simulation-only.
- Added unit tests for the opaque plan registry: session ownership, immutability, TTL expiry and one-time consumption. Route/database integration tests, restart/exit race tests and browser UI tests are still required; Paper Mode is not yet approved for production use.
- The paper ledger is simulation-only and never calls a FYERS order endpoint. Existing `/api/orders/*` HTTP 403 protection remains unchanged.
- No production deployment, Render restart, environment/database mutation, FYERS token change, or broker order was performed.


## Production verification update — 2026-11-09

- On PR head `2229af5a2165ec058af310285bbe14131fa69378`, GitHub Actions completed both validation workflows successfully. The full validation job's `Verify production backend health and CORS` step is **success**, and the backend regression job is **success**.
- The production check confirms the original Render `/health` endpoint and configured CORS behavior were reachable from the GitHub Actions runner during this run. This supersedes the earlier 2026-11-08 in-progress/failure notes above.
- The later Paper Mode foundation commit `03e73556bf53517e30ddaab817ba0dfee10fd1f1` has its own CI runs in progress; do not treat the earlier successful run as validation of that newer commit.
- The Paper Mode PostgreSQL module is currently an isolated foundation only. It is not wired to authenticated routes, a server-owned verified-plan registry, the FYERS quote stream, or the Position UI. Its client-input validation is not sufficient authorization to create a trade. Do not expose Paper BUY until those gaps and race/restart tests are closed.
- The existing Render service remains on Free and tracks `main`. No merge, PR deploy, Render restart, environment/database mutation, FYERS token change, or broker order was performed.


## Paper Mode foundation follow-up — 2026-11-09

- The first CI run on the paper-ledger foundation found one test-fixture issue: its T2 value was below T1, so validation correctly rejected the malformed ordering before reaching the intended RR assertion. The fixture was corrected to use T2=155 (still above T1=150 but below the required 2:1 reward/risk threshold).
- Serialized manual-exit database updates with the same PostgreSQL advisory transaction lock used by quote processing, preventing a manual-exit/automatic-exit race on the same ledger.
- Latest head `316af1f7e92928525bed5fcf40cb1ef41d2f82c7`: backend regression workflow **success**; full validation workflow **success**, including production `/health` and CORS verification.
- Paper Mode remains foundation-only and inactive: no authenticated paper routes, no server-owned plan registry/opaque plan ID, no server-side re-quote on BUY, no quote-stream fan-out, and no Position UI controls. The module's input validation is not a substitute for route-level authorization. Do not enable BUY until those items and DB integration/restart tests pass.
- PR remains Draft/unmerged. No Render deploy/restart, production database initialization/migration, token change, or broker order was performed.


## Paper Mode integration update — 2026-11-09

- The current implementation branch now contains server-owned short-lived verified plan IDs, Dashboard Session-bound Paper Mode routes, fresh FYERS quote/metadata revalidation at BUY, PostgreSQL ledger integration, FYERS socket subscription/fan-out for open paper contracts, and a separate Position UI ledger.
- This remains an unmerged proposal. Do not infer production activation from the branch code or CI. Production database initialization, route authorization/integration coverage, automatic exit/restart reconciliation under real PostgreSQL, and UI/browser testing must be verified before any merge/deploy.
- Live `/api/orders/*` remains HTTP 403. Paper Mode never calls FYERS order endpoints. Existing FYERS OAuth and Dashboard Session login remain unchanged.
