# GV2VPD · FYERS — Canonical Website

**There is one official GV2VPD website:** the original app at the existing DhanPluse-V1 `/site/` URL. The existing FYERS OAuth/session is preserved; there is no duplicate app or second SMS OTP login.

## Official links

- **Website:** https://dongardivegajananvp-art.github.io/DhanPluse-V1/site/
- **Backend API:** https://dhanpluse-v1.onrender.com
- **Source of truth:** the `site/` frontend plus the `backend/` service in this repository.
- Root and nested compatibility pages are redirects only; they are not separate applications.

Do not share the Clean Test UI or Ultimate Test UI as the official website. Test deployments are temporary validation targets and must not be used as a second production app.

## Canonical frontend

The single frontend lives in `site/`. The current post-login workspace has exactly three tabs: **Home, Sureshot, Position**. The retired 24-tab navigation and separate `frontend/` clean-rebuild app are not part of the current production UI.

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
- FYERS Standard Data Socket allows 100 unique symbols per user across all Data Socket connections. GV2VPD's current app-owned set is limited to three baseline indices, one optional chart symbol, one MCX diagnostic symbol and at most two open Paper option symbols (at most seven distinct symbols). Closed Paper positions trigger a FYERS unsubscribe request. Full F&O universe ranking uses bounded REST quote batches, not 218 simultaneous WebSocket subscriptions.
- `/api/status` reports the GV2VPD-local tracked symbol count only; it cannot see subscriptions from the user's other FYERS apps or connections.

## Safety

**Order placement remains disabled.** DhanPulse is read-only for this project. Never add tokens or secrets to frontend assets. A healthy backend or connected socket alone does not prove fresh exchange data; actual exchange timestamps and fresh ticks are required.

## Verification status

Automated syntax/unit checks are necessary but do not prove end-to-end behavior. Before calling the consolidation complete, verify:
1. Browser API destination and CORS response on the official UI.
2. Exactly three tabs render: Home, Sureshot, and Position. The existing FYERS OAuth/session flow remains the connection gate; no second OTP login is added. All three tabs must pass desktop and Android-sized browser smoke tests without console errors.
3. NIFTY, BANK NIFTY, SENSEX and F&O last-known LTPs show only when FYERS returns valid exchange-timestamped prices.
4. Full eligible NSE F&O quote universe plus individually fresh NIFTY/BANKNIFTY/SENSEX ticks is ranked from a complete fresh snapshot. Every ranked candidate is option-verified sequentially in five-item batches under the shared FYERS Data API budget. Before publication, up to the ten highest-ranked initial passes are rechecked with fresh underlying candles, option quotes and completed option candles; only the current top three receive Paper Mode plan IDs. Missing/stale/partial/rate-limited data blocks that candidate or the incomplete scan.
5. FYERS OAuth callback and WebSocket reconnect/fresh-tick recovery in a regular market session.
6. Mobile/PWA refreshes to the current frontend without stale cached JavaScript.

Live FYERS authorization, live-session reconnect behavior and browser/mobile click-through are not considered verified until directly observed.