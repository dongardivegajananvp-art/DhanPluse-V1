# DhanPulse production acceptance matrix

Audit updated: 2026-11-12 (Asia/Kolkata)  
Production scope: original GV2VPD app only — the original 24-tab workstation is required. The three-tab Home/Sureshot/Position reduction was an unwanted regression and is being reversed. Existing FYERS OAuth/session is preserved; no duplicate app/login or SMS OTP gate is added.

## Release safety rules

- FYERS is the only market-data source. No Yahoo, mock, demo, or synthetic prices/candles.
- Live status requires valid, fresh exchange timestamps. Missing, stale, partial, or unverified data blocks a signal.
- After market close, last-known FYERS values must be labelled as last-known, never live.
- Order placement remains disabled; all workflows are read-only.
- A green build or backend `/health` response is not proof of fresh market ticks or a verified Sureshot setup.

## Original 24-tab workstation checks

| Area | Current implementation / status | Acceptance still required |
|---|---|---|
| Dashboard | Verified index/feed state, broker funds and actual FYERS positions; last-known prices are display-only after close. | Confirm fresh exchange timestamps and separate broker positions from Paper Mode. |
| Sureshot | Complete eligible NSE F&O quote snapshot plus individually fresh index ticks are ranked. Every ranked candidate is option-verified sequentially in five-item batches under the shared FYERS Data API budget. Every initial pass is revalidated with uncached fresh underlying and option candles. A newly completed full F&O quote snapshot refreshes the ranking, then final candidates are rechecked in groups of three with fresh underlying quotes followed by fresh option quotes. Only the current Top 3 receive Paper Mode IDs. Underlying direction requires a completed-candle supply/demand breakout on the selected 5-minute FYERS candles; the extra DMA20 crossover gate is not part of the user's requirement. Option-chain response supplies only contract identity, strike, side and expiry; Greeks/delta, chain premium, bid/ask, OI and volume are ignored. The nearest listed strike in the nearest expiry is selected. Entry is the fresh ask; SL is the 20-candle option swing low minus 0.35 x ATR(14); T1 is 2R and T2 is 3R. Selected option quotes and completed candles are verified independently. | Real-session browser test with FYERS login: verify selected contract, fresh quote timestamp, option candles, entry/SL/target/RR and blocked states on stale or incomplete data. Verify the full candidate count, all batch cursors and final top-three ordering with a real FYERS session; confirm 429 retains the cursor and incomplete scans never publish partial setups. |
| FYERS connection | Existing OAuth/session and backend status are separate from live-feed proof. Order placement remains disabled. | Verify actual FYERS callback and authenticated session in the production browser; verify disconnect/reconnect and expiry behavior. |
| Market socket | Fallback reconnect is restricted to regular NSE hours. If the socket remains down at market open, the 15-second watchdog initiates a controlled recovery attempt. The timer rechecks market hours before reconnecting. | Observe a full live session and confirm fresh exchange timestamps, stable socket, and recovery after an induced/real disconnect. |
| Backend | Original Render service only. `/health` reports process/config state plus whether a complete fresh index snapshot exists; it is not a substitute for live acceptance. | Confirm production health, CORS from the original Pages origin, and live tick timestamps during market hours. |
| Pages deployment | Pages artifact names include both workflow run ID and run attempt, avoiding retry collisions on the default artifact name. | Fresh custom workflow run must pass deploy, published `/site/` URL smoke, browser smoke, backend health and CORS checks. |
| Tabs | All original 24 production tabs must remain reachable and load their actual handlers. The 24-tab navigation is required; no second OTP login is added. | CI and browser smoke must assert all 24 tabs in the original order and exercise each tab on desktop and mobile. |

## Option-chain freshness decision

Sureshot uses the option-chain response only for contract identity, listed strike, side and expiry. Greeks/delta, chain LTP, bid/ask, OI and volume are not selection or signal inputs. The selected contract's premium and completed candles are fetched and verified separately.

FYERS' documented option-chain response does not provide a trustworthy exchange timestamp for chain LTP/OI/volume fields. Those fields are therefore not used for liquidity ranking or signals. The endpoint returns contract descriptors only and explicitly labels chain freshness as `UNVERIFIED`. Sureshot independently verifies the selected contract's live quote (bid/ask/LTP with exchange timestamp no older than 15 seconds) and completed option OHLC candles. Do not replace these checks with HTTP fetch time or weaken them to make a setup appear.

This is a safe separation of responsibilities, not proof that the option-chain response itself is fresh. If a future feature needs chain OI/volume or premium ranking, it remains blocked until FYERS documents trustworthy timestamp/provenance for those fields.

## Evidence and remaining release gates

1. JavaScript syntax, backend unit tests, dependency checks, tab count and PWA asset checks must pass in the latest main-branch validation run.
2. Custom Pages workflow must pass on a fresh run, including original `/site/` URL smoke and backend CORS smoke.
3. Original Render backend must remain live; test services must never be used as production.
4. Market-hours tick evidence must include fresh exchange timestamps for NIFTY, BANKNIFTY and SENSEX, not merely a connected socket or authenticated backend.
5. Full live-market acceptance requires a real FYERS-authenticated browser session during NSE hours. After-hours checks cannot substitute.
6. Sureshot must produce either a fully verified plan (contract, quote, candles, entry, stop, target, RR >= 1:2) or a clear NO TRADE reason. No stale/partial data may produce a signal.
7. Order placement must remain disabled.

## Operational notes

- After-hours socket reconnects are intentionally suppressed. At the next NSE session, the watchdog can recover a disconnected socket.
- The original Render health-check path is not configured in Render's service settings; if the dashboard exposes this setting, use `/health`. This does not prove live market data.
- Old test services/branches and alternate deployment files are not production. Do not delete or alter them as part of a production fix unless their ownership and dependencies are checked first.


## Confirmed design corrections in this audit

- Restore all 24 original tabs; do not replace the workstation with a three-tab shell.
- Re-enable the original dedicated Trade Journal, Capital Protection and Backtesting scripts.
- Combine FYERS holdings, broker positions and the separate Paper Mode ledger in the Holdings & Positions tab.
- Sureshot begins at the NSE regular-session open (09:15); remove the extra 09:30 delay.
- Sureshot direction is based on completed FYERS 5-minute supply/demand breakout candles. Do not require the additional DMA20 crossover, which was not in the user's Sureshot specification.
- FII/DII remains explicitly unavailable until a verifiable source is available; no fabricated values are allowed.
- Gap-Up/Down remains a known acceptance gap: the existing page currently offers per-symbol historical gap analysis, not the requested automatic ₹2,000-crore turnover-ranked 09:00–09:07 scan. Do not mark that feature complete until implemented and tested with verified FYERS fields.
