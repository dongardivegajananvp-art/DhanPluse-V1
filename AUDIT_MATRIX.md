# DhanPulse production acceptance matrix

Audit updated: 2026-11-04 (Asia/Kolkata)  
Production scope: original DhanPulse only — exactly two tabs: **Sureshot CE/PE** and **FYERS Connect**. No preview/test UI is part of production.

## Release safety rules

- FYERS is the only market-data source. No Yahoo, mock, demo, or synthetic prices/candles.
- Live status requires valid, fresh exchange timestamps. Missing, stale, partial, or unverified data blocks a signal.
- After market close, last-known FYERS values must be labelled as last-known, never live.
- Order placement remains disabled; all workflows are read-only.
- A green build or backend `/health` response is not proof of fresh market ticks or a verified Sureshot setup.

## Current two-tab checks

| Area | Current implementation / status | Acceptance still required |
|---|---|---|
| Sureshot CE/PE | Underlying direction uses completed FYERS candles. Option-chain response is used only for contract identity (symbol, strike, side, expiry); its undocumented LTP/OI/volume fields are discarded. Selected option bid/ask/LTP must independently pass the 15-second quote gate and option candles must pass OHLC/freshness and 1:2 risk checks. | Real-session browser test with FYERS login: verify selected contract, fresh quote timestamp, option candles, entry/SL/target/RR and blocked states on stale or incomplete data. |
| FYERS Connect | OAuth/session and backend status are separate from live-feed proof. Order placement remains disabled. | Verify actual FYERS callback and authenticated session in the production browser; verify disconnect/reconnect and expiry behavior. |
| Market socket | Fallback reconnect is restricted to regular NSE hours. If the socket remains down at market open, the 15-second watchdog initiates a controlled recovery attempt. The timer rechecks market hours before reconnecting. | Observe a full live session and confirm fresh exchange timestamps, stable socket, and recovery after an induced/real disconnect. |
| Backend | Original Render service only. `/health` reports process/config state plus whether a complete fresh index snapshot exists; it is not a substitute for live acceptance. | Confirm production health, CORS from the original Pages origin, and live tick timestamps during market hours. |
| Pages deployment | Pages artifact names include both workflow run ID and run attempt, avoiding retry collisions on the default artifact name. | Fresh custom workflow run must pass deploy, published `/site/` URL smoke, browser smoke, backend health and CORS checks. |
| Tabs | Exactly two production tabs; do not restore the retired 24-tab navigation. | CI and browser smoke must continue to assert exactly two tabs. |

## Option-chain freshness decision

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
