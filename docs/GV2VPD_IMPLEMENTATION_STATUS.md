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
- Updates app identity/PWA manifest/cache to GV2VPD.
- Adds structural checks for the three-tab and App Login shell, plus App Login unit tests.

## Still blocked / not claimed complete

- Real App Login cannot pass until the existing Render service has its already-owned PostgreSQL connection and approved MSG91 credentials/template plus the owner's allowlisted mobile configured and tested. Never put any secret in GitHub or chat.
- This branch has not been run against the live MSG91 provider or production PostgreSQL.
- Home account funds / realised P&L / unrealised P&L presentation still needs a verified funds endpoint and field-by-field response mapping.
- The existing Sureshot strategy is not yet upgraded to the full Top 10 gainers + Top 10 losers, 9:30 gate, completed-candle trend, same-time five-day volume ratio, VWAP, delta and fixed risk-plan rules. Existing FYERS validation must remain intact during that work.
- Position lifecycle currently displays FYERS position data; durable paper-trade creation, fill/exit simulation, SL/target event tests and restart reconciliation remain to be implemented.
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
