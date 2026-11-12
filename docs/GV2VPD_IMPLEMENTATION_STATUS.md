# GV2VPD current implementation status

Updated: 2026-11-12 (Asia/Kolkata)

## Canonical production system

- Repository: `dongardivegajananvp-art/DhanPluse-V1`
- Frontend: original GitHub Pages `/site/` application.
- Backend: original Render service `dhanpluse-v1`.
- Existing FYERS OAuth and dashboard-session flow is retained. No duplicate app or SMS OTP login.
- Required navigation: the original 24 tabs. The recent three-tab reduction was a regression and is being reversed.
- Broker order placement remains disabled. Paper Mode is a separate simulation ledger.

## User requirements that govern the implementation

- FYERS-only market data. No Yahoo, demo, sample or synthetic prices/candles.
- Verify source, exchange timestamp and freshness before analysis. Missing, stale, partial or unverified inputs mean NO TRADE.
- During market hours, live data must be fresh. After market close, genuine last-known FYERS values may be displayed as last-known only; live signals remain blocked.
- Sureshot covers every eligible NSE F&O equity plus independently fresh NIFTY, BANK NIFTY and SENSEX ticks.
- Underlying direction is based on completed FYERS 5-minute supply/demand breakout candles. The unrequested DMA20 crossover gate is not part of the strategy.
- Option chain is used only for listed contract identity, side, strike and expiry. Selected-contract bid/ask/LTP and completed option candles are fetched and verified independently.
- Auto-select the nearest eligible listed strike in the nearest available expiry. Entry is the fresh option ask. The option-candle structure/ATR stop and risk/reward must pass at least 1:2.
- Scan starts at the NSE regular-session open (09:15), subject to actual session/data readiness. Do not add an arbitrary 09:30 delay.
- Full-universe checks run sequentially under the existing FYERS request budget. Never bypass rate limits or clear a Cloudflare cooldown.
- Live orders stay disabled.

## Current implementation

- The Sureshot full-universe selector checks the complete verified F&O equity quote universe and fresh baseline index ticks.
- Deep option checks are paginated in five-candidate batches. Every initial pass is revalidated before Top 3 publication.
- Option-chain Greeks, chain premium, OI and volume are not Sureshot signal inputs.
- Paper BUY requires a server-issued verified plan, authenticated dashboard session and fresh FYERS option quote. Paper positions are stored separately in PostgreSQL; no broker order endpoint is called.
- The Holdings & Positions tab is intended to combine real FYERS holdings/positions with the separate Paper Mode ledger.
- Trade Journal, Capital Protection and Backtesting use dedicated frontend scripts and must remain loaded by the canonical shell.
- FII/DII values remain unavailable unless a trustworthy, verifiable source is connected; no substitute or fabricated numbers are permitted.

## Known release blockers / incomplete acceptance

1. The latest backend instance previously reached the 512 MiB Render memory ceiling and was OOM-killed. Current production memory headroom and sustained stability need another measured session.
2. FYERS returned a Cloudflare 1015 cooldown. The app must respect the provider cooldown; a full authenticated regular-session Sureshot run has not yet been proven end-to-end.
3. The Sureshot scan cursor is currently process-memory state. An instance restart during a long scan can lose progress; restart-safe persistence remains a reliability gap.
4. The audit branch now rechecks a complete fresh F&O quote snapshot after the deep scan, re-ranks candidates from current FYERS percentage changes, then rechecks each selected Top 3 underlying quote and option quote immediately before publication. CI and real-session acceptance are still required.
5. Gap-Up/Down currently offers per-symbol historical gap analysis. It does not yet implement the user's automatic ₹2,000-crore traded-value qualification and 09:00–09:07 opening scan.
6. FII/DII is not populated from a verified FYERS source and must remain clearly unavailable.
7. Real-session browser acceptance still needs a full scan result (or explicit NO TRADE) with actual exchange timestamps, selected contract, premium, completed option candles, Entry, SL, Target and RR.

## Release acceptance

- All 24 tabs render in their original order on desktop and mobile; each tab opens its actual handler.
- Dedicated Trade Journal, Capital Protection and Backtesting scripts load from the canonical `/site/` origin and are included in the PWA cache.
- Backend tests, repository checks, published Pages smoke, browser smoke, production health and CORS all pass on the exact main commit.
- During a regular NSE session, the FYERS-authenticated scan checks the entire eligible universe and either publishes only fully revalidated Top 3 setups or returns a precise NO TRADE reason.
- A successful build, healthy backend, connected socket or old tick is not evidence of a valid setup.
