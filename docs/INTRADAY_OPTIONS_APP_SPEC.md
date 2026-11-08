# GV2VPD / DhanPluse-V1 — Intraday Options App Specification

Status: design baseline only. This document does not enable order placement and does not authorize a production merge or deployment.

## 1. Product boundary

Build the requested intraday-options workflow inside the existing canonical repository and existing Pages/Render deployment:

- Frontend: `site/`
- Backend: `backend/`
- Existing FYERS OAuth/token persistence and existing app identity are retained.
- No second website, duplicate backend, paid data vendor, Yahoo Finance, sample feed, mock quote, fabricated candle, or synthetic ranking.
- After successful authentication, the only primary navigation is **Home**, **Sureshot**, and **Position**.
- The app remains fail-closed. If a required FYERS response, exchange timestamp, contract master, order acknowledgement, fill, or protection acknowledgement cannot be verified, show the precise unavailable/blocked state and do not represent a trade as active.
- Production order placement remains disabled until a separate, explicitly approved live-order release.

## 2. Authentication and entry flow

1. User opens the existing canonical site.
2. App Login is completed using the app's approved authentication method and creates a server-validated app session. Do not introduce mandatory SMS OTP merely by assumption; inspect and reconcile the existing draft App Login work before implementation.
3. User completes FYERS OAuth through the existing backend. OAuth state must be validated server-side; access tokens and secrets never enter browser storage, logs, URLs, or chat.
4. Backend verifies the FYERS session with a documented account/profile or equivalent authenticated endpoint and confirms the required market-data/account permissions.
5. Only when **App Session = VALID** and **FYERS Session = VALID** may the three-tab dashboard render.
6. If either session expires/revokes, block protected tabs and show the relevant reconnect/login action. Never silently fall back to cached/demo credentials.

States to display separately: App login required, FYERS login required, authenticating, connected, expired, permission missing, backend unreachable, and session verification unavailable.

## 3. Three-tab information architecture

### Home

- FYERS connection and account identity status (mask sensitive account identifiers).
- NSE feed status and MCX feed status independently: LIVE, STALE, DISCONNECTED, PERMISSION MISSING, or MARKET CLOSED.
- Last exchange tick timestamp and tick age for each feed. A tick is LIVE only if its exchange/last-traded timestamp is no more than 10 seconds old. At age >10 seconds, status becomes STALE. Fetch/receive time must never substitute for exchange time.
- Market-closed display may show genuine last-known FYERS values with their original timestamps, clearly labelled LAST KNOWN / MARKET CLOSED, never LIVE.
- Same-day P&L split into realised and unrealised, plus total; available balance and used margin.
- UI refresh target: every 5 seconds. The browser reads one backend account snapshot/cache; the backend owns a single coordinated refresh and FYERS rate-limit budget. Every field carries its own source/update timestamp. If FYERS rate limits or provider rules prevent a fresh 5-second account refresh, retain the last verified value with its age and show STALE/UPDATE DELAYED rather than pretending it refreshed.
- No NSE/MCX values or account values are generated from local calculations unless the underlying FYERS fields and calculation semantics are verified and documented.

### Sureshot

- NSE stock-F&O universe only, derived from current official FYERS NSE_FO and NSE_CM symbol masters. Exclude indices from the stock gainers/losers lists.
- Require a complete, duplicate-free, timestamp-verified quote snapshot for the entire eligible universe. Any missing, partial, stale, or inconsistent member blocks the ranking; do not rank a partial universe.
- Show Top 10 Gainers (highest positive percentage first) and Top 10 Losers (most negative percentage first), with exchange timestamp and freshness.
- Do not finalise candidates before 09:30 India time on an eligible NSE session. Also verify exchange holiday/special-session status where an authoritative source is available; clock-only checks are not proof of an open session.
- Cross-verification gates, evaluated from FYERS data:
  1. Directional trend, not sideways: use completed 5-minute candles and a deterministic, tested trend definition. Proposed baseline: ADX(14) >=20 plus EMA(20) slope and price/EMA alignment in the same direction. The threshold/indicator implementation must be documented and unit-tested before it is considered final.
  2. Volume ratio >=1.5 against the five-day average for the equivalent elapsed intraday time window (not today's partial volume against a full-day average). Require valid five-day historical volume coverage.
  3. Gainers must be above session VWAP; losers must be below session VWAP. VWAP must be computed from verified current-session FYERS candles/trades with correct volume.
  4. Completed candles only; no in-progress candle can establish the final selection.
- Only candidates passing all gates remain eligible. Show explicit rejection reasons for the rest.
- From the eligible Top-10 lists, select up to five option contracts total. Positive directional candidate maps to CE; negative directional candidate maps to PE.
- Contract identity/expiry/strike/lot size/tick size comes from the current FYERS option master/chain. Strike rule: CE one strike OTM above ATM; PE one strike OTM below ATM, with ATM determined from the verified underlying LTP and listed strike interval.
- Required contract filters: premium ₹30–₹150 inclusive; verified delta 0.35–0.55 inclusive; transparent Trend Score >=70. FYERS official Option Chain documentation confirms that `greeks=1` returns nested `greeks.delta` (along with gamma, theta, vega and IV). Use that field only when the response is valid and current; never estimate or invent delta. [FYERS Option Chain](https://fyers.in/api-docs/v3/api/market-data/option-chain/).
- Trend Score must be a deterministic, versioned, explainable score using only verified inputs. Publish its components/weights in the UI and tests before enabling selection; no opaque AI score.
- Display: rank, stock, CE/PE, expiry, strike, premium, delta, trend score, lot size, chart action, fixed entry, fixed SL, Target 1, Target 2, risk/reward in rupees, exchange timestamp, and status/reason.
- No trade row is actionable unless every required gate passes and all quote/candle/contract data is fresh.

### Position

- Show broker-reconciled positions and app trade lifecycle separately.
- Lifecycle states: ENTRY_PENDING, PARTIALLY_FILLED, OPEN, EXIT_PENDING, PARTIALLY_EXITED, CLOSED, REJECTED, PROTECTION_FAILED, and RECONCILIATION_REQUIRED.
- OPEN only after FYERS confirms an entry fill and required protective order(s) are acknowledged. CLOSED only after FYERS confirms exit fill/zero net quantity. A button click or HTTP 200 alone is not a fill.
- Display symbol, contract, expiry, side, filled quantity, average entry, current FYERS LTP, fixed SL/targets, realised/unrealised P&L, order IDs, and timestamps.
- Manual Exit requires a confirmation step and then sends an idempotent exit request for the actual remaining net quantity. Show pending until broker fill is confirmed.
- Auto-exit triggers only from verified broker order updates / fresh exchange-stamped price crossing the fixed SL or target. Never move the stored levels with market price.
- On reconnect/restart, reconcile all open broker positions and pending orders before allowing new BUYs. Persist order intent, idempotency key, broker order IDs, fills, protection IDs, and state transitions.

## 4. Fixed option risk model

For a selected option premium entry E:

- Entry E is the verified FYERS ask/limit-entry reference captured at selection time and stored with its exchange timestamp. It never trails or silently reprices. If the market moves away before the order fills, the app must cancel/expire the stale entry rather than claim the original price was filled.
- Stop Loss = E × 0.70 (30% below entry).
- Target 1 = E × 1.50.
- Target 2 = E × 2.50.
- Calculate and show rupee risk/reward using the verified contract lot size and actual filled quantity:
  - Risk per lot = (E − SL) × lot size.
  - T1 reward per lot = (T1 − E) × lot size.
  - T2 reward per lot = (T2 − E) × lot size.
- The mathematical T1 reward/risk from these formulas is 1.67:1 before charges/slippage. Still calculate from rounded exchange tick prices and reject any setup whose actual displayed T1 RR is below 1:1.5.
- Store the exact rounded entry/SL/T1/T2 values at selection. Chart lines and position risk levels read these immutable values.
- Clarify/implement target quantity allocation before live trading. If the user has only one lot, do not promise two independent partial exits that cannot be executed in lot-size increments.

## 5. Chart View

- Open the selected underlying's current trading-day 5-minute FYERS OHLC chart.
- Use completed candles only for calculations; show the in-progress candle distinctly if displayed.
- VWAP line is calculated from verified session data.
- Support/resistance are computed from a documented set of completed candles at the moment of selection and stored with a calculation timestamp.
- Entry, SL, Target 1 and Target 2 are horizontal fixed-price lines from the stored risk plan. They must not move as new candles arrive.
- Chart must show source, exchange timestamps, candle freshness, interval, and any missing-data warning. No fallback chart source.

## 6. BUY and order protection

The requested one-tap BUY is a live financial action. The implementation must use a backend order-management service, never a browser-to-FYERS order call.

Before accepting a BUY, the backend re-checks atomically:
- Both app and FYERS sessions valid.
- NSE market session is open and local India time is before 15:15:00.
- Required NSE feed and option quote are LIVE (exchange timestamp age <=10 seconds).
- Candidate/risk plan has not expired; contract master and lot size remain valid.
- Actual available balance/margin is sufficient according to FYERS.
- Fewer than two broker-reconciled open positions exist.
- Today's realised + unrealised P&L has not reached or breached -₹5,000. Once breached, lock new BUYs for the rest of the trading day.
- No duplicate active order/position exists for the same idempotency key/contract intent.
- Order quantity and product type are valid for the account and instrument.

Order lifecycle:
1. Persist a unique order intent and immutable risk plan.
2. Submit the supported FYERS entry order and persist broker acknowledgement/order ID.
3. Reconcile actual fills and average price. If fill differs from the planned entry beyond the configured tolerance, recalculate the risk plan only under an explicit, tested policy; otherwise cancel/exit safely. Never show a planned entry as an actual fill.
4. Submit broker-supported protective SL/target orders only after confirming the current FYERS API supports the exact required order types and quantities. Do not assume a bracket/OCO feature exists.
5. Do not mark OPEN until entry fill and required protection acknowledgements are confirmed.
6. If protective SL placement fails, enter PROTECTION_FAILED, block further BUYs, and execute the documented emergency risk procedure; do not leave an unprotected position silently.
7. Use broker order/trade updates where available and periodic reconciliation as a recovery mechanism. A backend restart or socket disconnect must not erase position state or protection state.

FYERS's official API reference documents order placement, order/position updates over the General WebSocket, position exit, and a position-level Stop Loss & Take Profit operation. These are promising building blocks, not proof of a tested live protection workflow. If broker-held protection is not confirmed for the exact option product/segment, do not enable live BUY based only on an in-process Render worker. First design and test a durable, reconnect-safe protection service and clearly disclose residual broker/network risk.

## 7. Safety gates

- Maximum two open positions, counting broker-reconciled net open positions and pending entry intents to prevent race conditions.
- Daily loss lock: realised + unrealised day P&L <= -₹5,000 disables all new BUYs for that India trading date. Re-enable only on the next verified trading date after reconciliation.
- No new BUY at or after 15:15:00 Asia/Kolkata.
- Any required feed STALE/DISCONNECTED/UNVERIFIED => NO TRADE; do not open new positions.
- Manual exit confirmation required; no accidental double tap or duplicate exit.
- No automatic end-of-day liquidation is added by assumption. The exact intraday product, broker RMS square-off policy, and treatment of positions after 15:15 must be verified and explicitly decided before live release.
- All guardrails are enforced server-side in a transaction/lock, not only by hiding/disabling UI buttons.
- Default state remains read-only / order placement disabled until a separately approved release.

## 8. FYERS and hosting constraints verified from official documentation

- FYERS Standard is free. Its documented limits are Data APIs: 5 requests/second, 50/minute, 5,000/day; Transaction + User Info APIs: 10/second, 200/minute, 100,000/day; Quotes: 50 symbols/request; Data Socket: 100 symbols per user across connections. More than three per-minute limit violations in a day can block the user for the rest of that day. Design around shared request budgets, one coordinated scheduler, caching, and backoff; never retry in a tight loop. [FYERS Plans & Limits](https://fyers.in/api-docs/v3/getting-started/plans-and-limits/)
- FYERS Option Chain supports `greeks=1`, which returns option Greeks including delta. [FYERS Option Chain](https://fyers.in/api-docs/v3/api/market-data/option-chain/)
- FYERS Funds returns capital and commodity ledger rows including Available Balance, Utilized Amount and Realized Profit and Loss. The app must map rows by `title`, not fixed array position. [FYERS Funds](https://fyers.in/api-docs/v3/api/account/funds/)
- FYERS Positions API documents get positions, exit position, and set/modify/cancel Stop Loss & Take Profit. The General WebSocket separately provides order, trade and position updates. Verify actual response semantics and product compatibility before production use. [FYERS Positions](https://fyers.in/api-docs/v3/api/trading/positions/) · [FYERS WebSocket Overview](https://fyers.in/api-docs/v3/api/websockets/websocket-overview/)
- **Critical live-order hosting constraint:** FYERS Individual Trading Apps require a primary static IP; an Individual Non-Trading App is data-only and cannot place orders. [FYERS Individual App](https://fyers.in/api-docs/v3/getting-started/create-an-app/individual-app/)
- The existing Render service `DhanPluse-V1` is currently on the Free plan in Singapore. Render documents shared regional outbound IP ranges for ordinary services; dedicated outbound IPs require a Pro workspace or higher plus an additional monthly fee. Therefore the current Free Render service does not provide the dedicated static egress IP required by a FYERS Individual Trading App. A no-paid-subscription live-order deployment is blocked unless the user already has another FYERS-acceptable static public IP/hosting route. Do not change hosting or incur fees without explicit approval. [Render Outbound IPs](https://render.com/docs/outbound-ip-addresses) · [Render Dedicated IPs](https://render.com/docs/dedicated-ips)
- Render Free web services can spin down after 15 minutes without inbound traffic and may restart at any time; this is unsuitable as the sole in-process auto-exit monitor. Broker-held protection must be verified and attached successfully before live order release. [Render Free limitations](https://render.com/docs/free)

## 9. Backend integration structure

Keep the existing Node/Express service and FYERS SDK. Add isolated modules with narrow contracts:

- `auth/app-session.js`: app login, session validation, logout, CSRF/session protection.
- `auth/fyers-session.js`: existing OAuth callback/state/token refresh/expiry verification; secrets remain server-side.
- `fyers/market-stream.js`: one managed FYERS data socket for permitted NSE and MCX symbols; reconnect/backoff and subscription reconciliation.
- `fyers/market-snapshot.js`: normalized FYERS quotes/candles, exchange timestamps, source metadata, per-segment freshness.
- `fyers/account-snapshot.js`: funds, margins, positions, orderbook/tradebook and day P&L normalization using documented FYERS fields; one shared rate-limited refresh.
- `scanner/fno-universe.js`: current official symbol-master parsing and contract metadata.
- `scanner/intraday-filters.js`: completed-candle trend, same-time five-day volume ratio, VWAP, 09:30 gate and rejection reasons.
- `scanner/option-selector.js`: ATM/one-OTM mapping, premium, verified delta, lot size and expiry validation.
- `scanner/trend-score.js`: transparent versioned score.
- `risk/fixed-risk-plan.js`: tick-rounded immutable E/SL/T1/T2 and rupee RR.
- `charts/intraday-chart.js`: same-day five-minute chart payload, VWAP, fixed levels and S/R snapshot.
- `orders/order-manager.js`: idempotent order intents, submit/cancel/replace, broker acknowledgements and fills.
- `orders/protection-manager.js`: verified broker-native SL/target/OCO support and protection reconciliation.
- `positions/position-manager.js`: durable lifecycle state, broker reconciliation, manual and automatic exits.
- `risk/trading-guards.js`: max-two positions, daily loss lock, 15:15 cutoff, freshness and session gates.
- `audit/trade-events.js`: append-only audit trail with timestamps and redacted broker identifiers.

Suggested read APIs: `/api/app/session`, `/api/fyers/session`, `/api/home/snapshot`, `/api/sureshot/rankings`, `/api/sureshot/chart/:candidateId`, `/api/positions`.
Suggested protected action APIs (remain disabled until release): `POST /api/orders/entry`, `POST /api/positions/:id/exit`, `POST /api/orders/:id/cancel`.
All protected routes validate app session, FYERS session, CSRF, idempotency and server-side risk guards.

## 10. Frontend structure

- Replace the current primary workspace navigation only after the three-tab shell is implemented and tested; do not leave old tabs reachable from hidden menus.
- Login screen: App Login state, FYERS Connect state, independent status/error messages.
- Home: connection/feed cards, timestamp/age badges, account summary, refresh time and clear stale states.
- Sureshot: two ranked lists (Top 10 gainers/losers), five eligible contract cards/table rows, explicit gate badges/rejection reasons, Chart View, BUY disabled indicator.
- Position: lifecycle filter (all/open/closed), order/fill/protection status, P&L, Manual Exit confirmation.
- Mobile-first responsive design; no fabricated placeholder prices or example positions in production UI.
- UI refresh every five seconds reads backend snapshots and never independently calls FYERS from the browser.

## 11. Implementation phases and acceptance gates

**Phase 0 — API capability verification (before implementation of live actions)**
- Confirm current FYERS API endpoints/response fields for profile/session, funds, positions, orderbook, tradebook, option chain, Greeks/delta, 5-minute history, NSE/MCX Data Socket, General WebSocket, order types, position SL/TP and order updates. Official docs now confirm the core endpoints/fields listed in Section 8; account-level permissions and actual live responses still need verification.
- Record actual Standard-plan rate limits, market-data permissions, FYERS app type (Trading vs Non-Trading), approved primary static IP, hosting egress-IP compatibility, and exact position SL/TP semantics. No guessed endpoint names or fields. If no accepted static IP is available without a paid service, keep live orders blocked.

**Phase 1 — Authentication + three-tab read-only shell**
- App session + existing FYERS OAuth; protect dashboard until both valid.
- Home feed states and account snapshot display; Sureshot/Position read-only skeletons.
- Acceptance: unauthenticated user cannot access any dashboard API; expired sessions close access; no mock data.

**Phase 2 — Verified market/account data**
- NSE + MCX stream and exchange-time <=10s freshness.
- Account P&L/funds/margin normalization and shared refresh budget.
- Acceptance: simulated stale/missing/partial provider responses show STALE/UNAVAILABLE; production only shows provider values.

**Phase 3 — Scanner and contract selector**
- Full-universe snapshot, Top 10 gainers/losers, 09:30 gate, directional/volume/VWAP filters, Top 5 option contracts, delta and score.
- Acceptance: deterministic fixture tests plus provider integration tests; incomplete universe yields no ranking; missing delta yields no contract.

**Phase 4 — Risk plan and chart**
- Fixed Entry/SL/T1/T2, tick rounding, amount RR, same-day chart and immutable horizontal lines.
- Acceptance: price updates never move stored risk lines; chart/plan share the same plan ID and values.

**Phase 5 — Position lifecycle in paper/test mode**
- Persist order intents, fills, protection acknowledgements, restart reconciliation, manual exit confirmation and auto-exit event handling.
- Acceptance: duplicate requests are idempotent; partial fills and disconnect/restart recovery are tested; no OPEN state without verified fill/protection.

**Phase 6 — Separate live-order release**
- Only after all prior gates, current FYERS capabilities verified, paper/test results reviewed, and explicit user authorization.
- Keep order placement disabled until then. No automatic merge/deploy/restart authorization is implied by this spec.

## 12. Required test matrix

- App login missing/expired; FYERS login missing/expired/revoked; bad OAuth state; permission denied.
- NSE fresh/stale/disconnected; MCX fresh/stale/disconnected; market closed; timestamp absent/future/invalid.
- Complete vs partial F&O quote snapshot; duplicate symbol; changed symbol master; missing five-day history; zero volume; sideways; VWAP wrong side; pre-09:30; special session/holiday.
- Option chain missing/expired contract; strike interval change; premium below/above range; delta absent/out of range; missing lot size; stale option quote/candle.
- Tick rounding; fixed SL/T1/T2; RR boundary at 1:1.5; lot-size rupee calculations; chart lines immutability.
- Insufficient funds/margin; two open positions; concurrent BUY race; daily loss exactly -₹5,000 and below; 15:14:59 vs 15:15:00.
- Order reject/timeout/unknown acknowledgement; partial fill; duplicate callback; SL rejection; target rejection; socket loss; backend restart; broker position mismatch; manual-exit double tap; exit partial fill.
- Confirm every blocked state displays NO TRADE / precise reason and does not fabricate values.

## 13. Existing repository items to reconcile (do not blindly merge)

- Existing `backend/src/sureshot-shortlist.js` ranks a complete verified quote snapshot by absolute percentage move and explicitly does not create directional signals/risk plans. It is a reusable foundation, not the requested scanner.
- Existing `backend/src/option-risk-plan.js` calculates a swing-low stop and minimum 1:2 RR from completed option candles; it does not implement the requested fixed 30% SL and 1.5x/2.5x targets.
- Existing backend `/api/orders/*` is deliberately blocked with 403. Keep it blocked until the separate live-order release.
- Existing `site/app.js` contains the legacy multi-tab workspace and read-only holdings/positions display. Replace navigation only in a controlled frontend phase.
- Open PR #159 contains a draft App Login foundation. Review its security, session model, and overlap before reusing; do not merge it automatically or assume SMS OTP is required.
- Open PR #163 contains a frontend request-timeout change and is not part of this spec. Do not merge it automatically.
- The current Render backend has previously restored an expired FYERS token and reported an unreachable health endpoint. Verify backend health and obtain a fresh FYERS OAuth session before any live integration test.

## 14. Explicit non-goals

- No fabricated/demo/sample/Yahoo/third-party paid data.
- No use of option-chain OI/volume as a substitute for the user's stated stock-volume rule.
- No AI-generated opaque ranking or guaranteed-profit language.
- No automatic end-of-day square-off unless separately specified.
- No live order placement, merge to main, production deployment, Render restart, secret rotation, or environment/database mutation under this design approval alone.
