# GV2VPD implementation status — Phase 1

This branch is a code implementation proposal for the existing DhanPluse-V1 repository. It does not merge, deploy, restart Render, change production environment variables, or place broker orders.

## Implemented in this branch

- Reuses the existing App Login foundation from draft PR #159 without merging its diverged branch wholesale.
- Adds owner-mobile allowlist + MSG91 OTP backend routes, PostgreSQL-backed hashed app sessions, OTP expiry/cooldown/daily send limit, failed-attempt lockout, session validation and revocation.
- Adds a server-side /api App Login gate. Health/status and the narrowly scoped App Login bootstrap routes remain reachable; private APIs fail closed without a valid App Login session.
- Keeps the existing FYERS OAuth and dashboard-session checks as a separate second authentication step.
- Changes the app shell to exactly three visible navigation tabs: Home, Sureshot, Position.
- Home is the default landing page and maps to the existing Dashboard renderer.
- Sureshot maps to the existing verified FYERS Sureshot scanner; existing scan behavior is retained rather than silently replacing strategy logic.
- Position reads the backend's FYERS positions endpoint and displays broker-returned rows; it does not synthesize positions or fills.
- Adds the fixed Sureshot option risk model and wires it into the existing NSE/MCX auto-plan scanner: Entry = verified ask, SL = 30% below entry, T1 = 1.5x, T2 = 2.5x, tick-rounded values, lot-level rupee risk/reward, and >=1:1.5 T1 RR. The model still requires 12 fresh completed option candles and verified lot/tick metadata.
- NSE/MCX auto-plan selection now requires the exact ATM + 1 OTM strike, official FYERS nested delta in the absolute 0.35–0.55 band, and verified ask premium ₹30–₹150. Option-chain LTP/OI/volume remain excluded; premium is independently read from a fresh quote.
- The NSE F&O auto-scan now publishes separate Top 10 Gainers and Top 10 Losers boards from the complete verified F&O equity snapshot, then selects up to five stock candidates from those boards for option verification. Index ticks do not displace stock candidates.
- NSE/MCX Sureshot direction now has a strict trend gate: ADX(14) >=20, EMA(20) direction/slope, current-session VWAP alignment, same-elapsed-time volume ratio >=1.5 against five prior sessions, transparent Trend Score >=70, and final NSE selection blocked before 09:30. Candle history requests include a ten-calendar-day window to find five prior sessions.
- Updates app identity/PWA manifest/cache to GV2VPD.
- Adds structural checks for the three-tab and App Login shell, plus App Login unit tests.

## Still blocked / not claimed complete

- Real App Login cannot pass until the existing Render service has its already-owned PostgreSQL connection and approved MSG91 credentials/template plus the owner's allowlisted mobile configured and tested. Never put any secret in GitHub or chat.
- This branch has not been run against the live MSG91 provider or production PostgreSQL.
- Home account funds / realised P&L / unrealised P&L presentation still needs a verified funds endpoint and field-by-field response mapping.
- The current NSE auto-scan shows Top 10 gainers/losers and verifies up to five candidates from those boards. It is not yet a full five-contract shortlist when fewer than five candidates pass; it correctly returns fewer or zero rather than relaxing gates.
- Home account funds / realised P&L / unrealised P&L presentation remains to be implemented and verified against live FYERS funds/positions responses.
- Position currently displays FYERS broker positions; durable paper-trade creation, paper BUY/Manual Exit controls, automatic SL/T1/T2 paper exits, daily loss lock and restart reconciliation remain to be implemented.
- Live order placement remains disabled. Existing backend /api/orders/* still returns 403. Do not remove that block until static-IP eligibility for the FYERS Trading App, broker permissions, order-fill reconciliation, protection acknowledgement, partial-fill handling, two-target allocation, daily loss lock, max-two-position guard and emergency exit tests have all passed.
- The current Render Free service does not provide the dedicated static egress IP required by the FYERS Individual Trading App. No paid hosting change is made here.

## Required verification before merge/deploy

1. CI: backend node --test, frontend structural checks, syntax checks and all existing repository checks pass.
2. Render staging/production-safe test: App Login DB initialization succeeds without disrupting the existing FYERS token store.
3. Real MSG91 send, valid/invalid/expired OTP, cooldown, daily cap, lockout, session expiry and logout/revocation pass.
4. A browser without App Login cannot call private APIs; App Login alone cannot bypass FYERS OAuth/session protection.
5. The existing FYERS OAuth callback, socket reconnect, fresh exchange timestamps, and current Sureshot scanner pass regression tests.
6. The production UI is not changed until a separately approved merge/deploy.

**Safety:** no live orders, no fake data, no automatic deployment, and no secret/config mutation in this branch.
