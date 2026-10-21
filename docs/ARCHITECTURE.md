# Architecture and implementation order

1. Define normalized quote/candle schemas and freshness rules.
2. Build backend health and data-status endpoints with distinct states: configured, authenticated, socket-connected, subscribed, last-valid-tick, rate-limited.
3. Implement one shared FYERS connection manager and one shared rate-limit/cooldown manager.
4. Add quote and candle endpoints with validation, timestamps, and explicit upstream errors.
5. Add a frontend API client with bounded concurrency, caching of validated responses, and stale-state labeling.
6. Build dashboard and candlestick chart on verified candles.
7. Add Stock Explorer for the supported F&O universe with batched/limited requests.
8. Add option-chain/OI validation, then scanners, zones, journal, and backtesting.
9. Add automated tests and deployment smoke tests for every stage.

Do not implement scanners or Sureshot before the quote, candle, and option-chain contracts are reliable. Do not add order placement without separate explicit approval.
