# Acceptance checklist

## Data integrity
- [ ] Backend health is not treated as proof of FYERS authentication.
- [ ] Connection, subscription, and latest valid tick are separate status fields.
- [ ] Each quote includes source symbol, price, exchange timestamp, receive timestamp, and freshness state.
- [ ] Old quotes are visibly marked stale; stale values cannot feed signals.
- [ ] Invalid/missing timestamps and non-finite prices are rejected.
- [ ] Rate limits trigger shared cooldown and no retry storm.

## Charts and signals
- [ ] Candles are rendered only from validated OHLC records.
- [ ] OHLC invariants are checked (high >= open/close/low; low <= open/close/high).
- [ ] Empty/error responses show explicit unavailable states, never invented chart data.
- [ ] Supply/demand zones identify their candle/time basis and are not described as guaranteed.
- [ ] A signal requires fresh underlying data and verified option-chain data where applicable.
- [ ] Planned reward:risk must be at least 1:2; otherwise show no-trade.

## Gap-Up / Gap-Down
- [ ] Gap percentage is calculated from verified previous close and opening price.
- [ ] Volume expansion is only assessed when comparable volume data is available.
- [ ] Major event risk is shown as a caution, not a directional prediction.
- [ ] No fixed gap-fill probability or FII/DII/operator attribution without evidence and backtesting.
- [ ] Missing/stale source data blocks automatic gap signals; manual analysis is clearly labeled.

## UI and deployment
- [ ] Every navigation item opens a real page/module, not only a changed heading.
- [ ] Loading, empty, stale, disconnected, rate-limited, and server-error states are tested.
- [ ] Mobile and desktop layouts are checked.
- [x] Backend automated tests pass before deployment (14 tests passed, 0 failed in test-service logs on 2026-10-21). Frontend/device and production smoke tests remain pending.
- [ ] Production smoke test verifies actual API responses and current asset version.

## Safety
- [ ] No credentials in frontend, repository, logs, or browser storage.
- [ ] Order placement stays disabled.
- [ ] No claim of live data until a recent valid tick is observed.
