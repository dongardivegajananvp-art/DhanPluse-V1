# DhanPulse Clean Rebuild

A clean, verification-first rebuild of DhanPulse for Indian-market research using FYERS market data.

## Non-negotiable rules
- Never label cached/stale data as live.
- Never generate a trade signal when required data is missing, stale, invalid, or unverified.
- FYERS credentials stay server-side; never commit secrets.
- Order placement remains disabled.
- Candles must come from validated OHLC data; no synthetic candles or placeholder prices.
- Rate limits use shared server-side cooldowns and bounded polling.
- A feature is complete only after API, UI, and failure-state tests pass.

## Architecture
- `backend/`: API, FYERS authentication/session, market-data normalization, shared rate limiting.
- `frontend/`: responsive single-page UI, API client, data freshness state, chart and feature modules.
- `tests/`: unit and integration tests for data validation and failure handling.
- `docs/`: architecture, acceptance criteria, deployment checklist.

## Current status
Scaffold only. No live market-data integration is claimed until the FYERS connection and returned quotes/candles are independently verified.

## Local development
Requirements: Node.js 20+. Install dependencies in each app only after its package manifest is present. Keep secrets in environment variables and never commit `.env` files.
