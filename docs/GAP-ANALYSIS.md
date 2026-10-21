# Gap-Up / Gap-Down Analysis — data contract

## Opening-gap classification
- Previous close and current open must come from validated, timestamped FYERS daily data before the feature is labelled live/verified.
- Relative volume is optional and comparable only when the current session window and historical baseline use the same interval.
- Major event flags are contextual warnings, not directional predictions.
- Do not attribute a gap to FII/DII/operators from price alone and do not issue an automatic trade signal.

## Historical gap-fill study
- Input must be verified daily OHLC bars in chronological order.
- A gap is included only when its absolute percentage is at least the configured threshold (default 0.3%).
- A gap is marked filled if that session's low reaches the prior close for a gap-up, or its high reaches the prior close for a gap-down.
- Always show sample size and fill rate together. Do not claim predictive probability from small or biased samples.
- These are descriptive statistics; fees, slippage, event classification, market regime and executable trade rules are not yet modeled.

## Current limitation
The clean-rebuild backend currently returns 503 for market quotes/candles. Until FYERS authentication and candle retrieval are integrated and independently verified, manual calculations are not live market data.
