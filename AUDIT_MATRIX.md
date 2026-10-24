# DhanPulse 24-Tab Audit Matrix

Audit date: 2026-10-24 (Asia/Kolkata)
Scope: static source review of `site/index.html`, `site/app.js`, and backend quote routes on `fix/fresh-data-session-policy`.
This is not a claim that a live FYERS session or production deployment has passed.

## Navigation / regression

- [x] Restored all 24 tab buttons in the original Ultimate UI.
- [x] Added CI check that the navigation and tab-description registry each contain the same 24 unique tabs.
- [x] Kept Gap-Up/Down and existing PWA assets.
- [x] Order placement remains disabled.
- [ ] Browser/mobile end-to-end click-through on the deployed test UI.

## Tab-by-tab status

| Tab | Static audit result | Remaining production gate |
|---|---|---|
| Dashboard | Index quote snapshot requires all configured index symbols; live index freshness is 15 seconds; stale/last-known/error labels now explicitly block live interpretation. | Verify OAuth + continuous WebSocket exchange ticks in a regular market session. |
| Stock Explorer | Equity rows use 30-second exchange timestamps; full ranking is blocked unless all requested symbols are fresh and coverage is complete. Backend now rejects stale/unverified live full-universe snapshots. | Verify actual FYERS NSE F&O master count, rate-limit recovery, and complete coverage live. |
| NIFTY | Uses shared index WebSocket quote state and 15-second signal gate. | Verify real exchange timestamps and reconnect behavior. |
| BANKNIFTY | Uses shared index WebSocket quote state and 15-second signal gate. | Verify real exchange timestamps and reconnect behavior. |
| Watchlist | Equity rows use the 30-second policy and do not claim a full-exchange universe. | Confirm the supported symbol universe and test stale/disconnect transitions in browser. |
| Sureshot CE/PE | Requires validated OHLC, a fresh option-chain exchange timestamp, and an independently verified selected-contract quote before candidates. Missing chain timestamp now blocks setup. | Confirm FYERS actually supplies a usable chain exchange timestamp and validate 1:2 RR, fixed entry/SL/target, liquidity, expiry and spread in live data. |
| Breakout Scanner | Fresh quote checks are 30 seconds; a quote snapshot alone is not proof of a technical breakout. | Verify all expected F&O symbols and candle-derived pattern rules; test stale/partial input blocks. |
| Momentum Scanner | Fresh quote checks are 30 seconds; configured-universe limitations are disclosed. | Verify full F&O coverage and amount/value ranking semantics against actual exchange data. |
| Zero-to-Hero | Requires verified underlying/option inputs for candidate generation; stale inputs are intended to block. | Validate selection logic, active strike quantity, risk/reward, and no-signal behavior live. |
| FII/DII Flow | Explicitly shows unavailable without a verified timestamped source; no fabricated figures. | Remains unavailable until a reliable source and timestamp are integrated. |
| Market Activity | Uses fresh equity snapshot and blocks complete metrics/ranking when the snapshot is partial or stale. | Verify breadth/volatility/volume source coverage and rate-limit behavior in live session. |
| Charts & Patterns | OHLC validator checks values, ordering, future timestamps, and interval-specific staleness. | Verify candle alignment and latest expected candle against FYERS live-session data. |
| Gap-Up/Down | Historical gap calculations use validated FYERS OHLC history and are descriptive, not forecasts. | Verify market calendar/holidays, source timestamps, and historical coverage. |
| Gainers & Losers | Equity quote rows use the 30-second policy; current UI discloses a selected large-cap universe. | Full NSE F&O ranking remains blocked until complete symbol-master coverage is verified. |
| Option Chain | Backend and frontend now require an explicit exchange-chain timestamp no older than 15 seconds; missing timestamp blocks display. | If FYERS does not expose an exchange timestamp, module will remain unavailable until a verifiable source is implemented. |
| Technical Indicators | Calculations depend on validated OHLC candles. | Validate current candle freshness and indicator values against a live FYERS chart. |
| AI Signals | Index-derived signal gate requires fresh WebSocket quotes; no signal when the required inputs are stale/missing. | Test every signal path, data loss, market close, and recovery in live session. |
| Holdings & Positions | Read-only authenticated endpoints; failed calls render unavailable rather than invented rows. | Verify real API update time, session expiry, empty account response, and account-data errors. |
| Price Alerts | Browser-local alerts are triggered only by fresh connected WebSocket ticks. | Test stale tick, disconnect, duplicate tick, and reload behavior. |
| FYERS Settings | Health and authentication are not treated as proof of fresh market data; order placement remains disabled. | Resolve `redirectUrl mismatch` with exact portal/backend URI match and successful callback. |
| Logs | Frontend event log shows local app events; it is not represented as a full server audit log. | Confirm no tokens/secrets are exposed in browser or server logs. |
| Trade Journal | Paper/journal workflow; no live market price is required to display saved journal entries. | Regression-test saved entries, validation, and rule-review flows. |
| Capital Protection | Risk calculator only; does not place orders. | Regression-test sizing, max-loss limits, and 1:2 reward/risk calculations. |
| Backtesting | Uses historical candles and is not a live prediction. | Verify historical data labelling, candle integrity, result math, and no live-signal crossover. |

## Release blockers (must pass before production deploy)

1. Latest GitHub Actions run must pass syntax, tab-parity, PWA-asset and backend tests.
2. Test UI click-through must cover all 24 tabs without console errors.
3. FYERS OAuth callback must succeed with exact redirect URI match.
4. A regular market-session test must verify exchange timestamps and continuous WebSocket reconnect/recovery.
5. Full F&O symbol master coverage, rate-limit cooldown and partial-snapshot blocking must be verified.
6. Option-chain source must provide a verifiable exchange timestamp; otherwise it stays blocked.
7. Historical candle freshness, derived-signal gates, account endpoint failures, and post-close LAST KNOWN labels must pass.
8. Production deployment is not authorized by a green CI run alone. Do not merge/deploy while live-session gates are unverified.
9. Isolate the PR UI from the production backend before browser/OAuth tests; the current frontend hardcodes the production backend URL.

## Production runtime and deployment evidence (checked 2026-10-24)

- Render production logs contain two upstream FYERS `/data/quotes` HTTP 429 / Cloudflare Error 1015 events: `2026-10-23T06:20:18Z` and `2026-10-23T08:33:14Z`. This confirms a real rate-limit incident; these log entries alone do not prove successful recovery after cooldown. Do not infer quote coverage from backend health.
- Production backend Render service remains on `main`; its latest live deploy is commit `8ae4b4f`. PR #40 is still a draft and is not deployed to Render.
- Current Render test UIs are on `test-ultimate-session-fix` and `clean-rebuild`; the test backend is also on `clean-rebuild`. The current `site/app.js` hardcodes the production backend URL. Therefore, do not use a PR-branch UI click-through for OAuth or protected API checks until the UI is safely isolated from the production backend.
- Safe next deployment step: establish a test UI/backend pairing that cannot send authentication or data requests to production; then run browser/mobile regression on that isolated pair. No production environment variables or services were changed during this check.

## Changes made on this branch

- Locked the shared fresh-data policy.
- Tightened frontend equity freshness to 30 seconds.
- Added shared timestamp validation for index, equity and option-chain paths.
- Revalidated mover cache timestamps and block live full-universe rankings when any quote is stale or timestamp-unverified.
- Require all expected index quotes before applying a dashboard snapshot; explicitly label stale/blocked dashboard data.
- Restored all 24 navigation buttons and added a CI parity test.
