# DhanPulse Fresh-Data Policy (Locked Requirement)

Timezone: Asia/Kolkata (IST). Readiness window: 09:00–15:30 IST. Normal NSE regular trading hours are 09:15–15:30 IST; holidays and special sessions must be verified, not guessed.

## Non-negotiable rule
During 09:00–15:30 IST, every tab must show verified fresh data or an explicit blocked/unavailable state. No stale, cached, partial, timestamp-unverified, or prior-session value may be presented as current. Backend health or FYERS authentication alone is not proof of fresh market data.

## Freshness gates
- Index WebSocket quote: valid exchange timestamp, age 0–15 seconds, connected stream; reject missing/future timestamps and replayed last-known data.
- Equity/F&O quote snapshot: valid exchange/last-traded timestamp, age 0–30 seconds for live candidates. Older/missing timestamps are STALE/TIME UNVERIFIED and excluded from rankings/signals. Illiquid/no-recent-trade symbols remain unavailable, never silently fresh.
- Option chain: chain timestamp <=15 seconds and independent selected-contract quote <=15 seconds; validate positive bid/ask/LTP, bid <= ask, expiry and liquidity/spread. Fetch time alone is not proof of exchange freshness.
- Intraday candles: valid OHLC, ordered/non-future timestamps and interval alignment. Missing/late latest expected candle blocks live signals. Historical candles are allowed only for clearly labelled historical analysis/backtests.
- Complete rankings: verify every expected symbol. Partial coverage, rate limits or failed symbols block a complete ranking and dependent signals. Never fabricate or silently reuse prior snapshots.
- Derived tabs inherit the freshness of every required input. Any failed input blocks the live result.
- Holdings/positions must show actual API update time/errors; cached values are not current account state.
- FII/DII requires a timestamped verifiable source; otherwise show DATA UNAVAILABLE, not estimates.

## Session/UI behavior
- 09:00 readiness: check backend, FYERS auth, stream/subscriptions, timestamps, clock, API limits and symbol coverage. Before regular market open, do not claim live prices unless fresh exchange ticks actually arrive.
- 09:15–15:30 regular session: every tab shows source/update time and status FRESH, STALE, DATA MISSING, TIME UNVERIFIED, PARTIAL COVERAGE or BLOCKED. Failed data gates remove/block current-price-dependent decisions.
- After 15:30/market close: last-known values may appear only with prominent LAST KNOWN / MARKET CLOSED label and actual exchange timestamp; no live signals. Confirm holidays/special sessions using a trusted exchange calendar/status.
- Disconnect/rate limit: immediately mark affected data stale/unavailable; recover only after fresh verified data arrives.
- Order placement remains disabled.

## Required acceptance tests
1. Equity quote age 31 seconds in session blocks candidate/ranking/signal.
2. Index quote age 16 seconds, missing/future timestamp, disconnected stream or last-known replay blocks signal.
3. Stale chain or stale independent option quote blocks candidate.
4. Missing expected symbol/rate limit blocks full-universe ranking and reports coverage.
5. Missing, reordered, future or corrupt latest intraday candle blocks derived signal.
6. Disconnect after a valid response transitions UI to STALE/DATA MISSING, not a current-looking old value.
7. After close, last-known values are labelled and no live signals appear.
8. All tabs use the same shared policy; no permissive tab-specific bypass.
9. No secrets in frontend/logs; order placement stays disabled.
10. Automated tests plus live-session test pass before marking complete. Merge alone does not prove live stability/OAuth success.

## Known gaps to resolve
- Static policy and unit tests do not replace browser/mobile end-to-end checks across all 24 tabs.
- Full NSE F&O symbol-master coverage and rate-limit recovery must be verified during a regular market session.
- Option-chain display intentionally blocks unless FYERS returns an explicit verifiable exchange timestamp; verify the provider response or keep the module unavailable.
- FII/DII source is not verified; keep unavailable until connected.
- OAuth redirect mismatch and repeated WebSocket disconnects require end-to-end verification.
- Historical candle freshness, account endpoint errors, post-close labels and every derived-signal gate still require regression and live-session checks.

This policy locks the requirement; it does not claim current production deployment already complies.