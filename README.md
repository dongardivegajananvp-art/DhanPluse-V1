# DhanPulse Ultimate · FYERS — Canonical Website

**There is one official DhanPulse website:** the original **DhanPulse Ultimate · FYERS** app. The separate clean-rebuild frontend is not the main app. Improvements from that work are being consolidated into this Ultimate codebase instead of maintaining two competing UIs.

## Official links

- **Website:** https://dongardivegajananvp-art.github.io/DhanPluse-V1/
- **Backend API:** https://dhanpluse-v1.onrender.com
- **Source of truth:** the `site/` frontend plus the `backend/` service in this repository.
- Root and nested compatibility pages are redirects only; they are not separate applications.

Do not share the Clean Test UI or Ultimate Test UI as the official website. Test deployments are temporary validation targets and must not be used as a second production app.

## Canonical frontend

The single frontend lives in `site/`. It retains the original Ultimate navigation and modules, including Gap-Up/Gap-Down. The separate `frontend/` clean-rebuild app is intentionally not included in the canonical site tree.

## Market-data rules

- Data first: only analyze after the quote/candle source and exchange timestamp pass validation.
- Missing, malformed, stale, or partial live-market data must block the signal; do not invent a value or rank partial F&O snapshots.
- When the market is closed, last-known FYERS LTPs are display-only and must retain their exchange timestamp. They are not live signals or a promise of the official closing price.
- Full F&O universe and chart choices must come from verified FYERS NSE_FO/NSE_CM symbol masters, not a hardcoded sample list.
- FII/DII figures are shown only when the official source response can be normalized and verified.
- SENSEX, NIFTY 50 and BANK NIFTY remain distinct index instruments.
- No signal is guaranteed. A minimum risk/reward rule does not remove market risk.

## Backend

- Root: `backend/`; Node.js >= 20; start command: `npm start`.
- Backend secrets stay server-side: `FYERS_APP_ID`, `FYERS_APP_SECRET`, `FYERS_REDIRECT_URI`. `ALLOWED_ORIGIN` lists allowed browser origins.
- FYERS redirect URI must exactly match the registered developer-app URI and the backend environment value.
- API budget/cooldown handling must avoid bursts and discard partial rankings when the upstream response is incomplete or rate-limited.

## Safety

**Order placement remains disabled.** DhanPulse is read-only for this project. Never add tokens or secrets to frontend assets. A healthy backend or connected socket alone does not prove fresh exchange data; actual exchange timestamps and fresh ticks are required.

## Verification status

Automated syntax/unit checks are necessary but do not prove end-to-end behavior. Before calling the consolidation complete, verify:
1. Browser API destination and CORS response on the official UI.
2. All 24 tabs render and work without console errors, including Gap-Up/Gap-Down.
3. NIFTY, BANK NIFTY, SENSEX and F&O last-known LTPs show only when FYERS returns valid exchange-timestamped prices.
4. Full F&O universe, historical OHLC charts, option chain, movers and FII/DII routes handle missing/rate-limited data safely.
5. FYERS OAuth callback and WebSocket reconnect/fresh-tick recovery in a regular market session.
6. Mobile/PWA refreshes to the current frontend without stale cached JavaScript.

Live FYERS authorization, live-session reconnect behavior and browser/mobile click-through are not considered verified until directly observed.