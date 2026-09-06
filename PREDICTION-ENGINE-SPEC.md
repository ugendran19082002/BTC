# BTC 12H Multi-Factor Prediction Engine — reference spec

Source: user brief. Kept as the design target for the forecasting half of the
system. Nothing here is implemented yet; see TODO.md for the build order.

Two **separate** models, not one:

1. **Direction model** — BTC UP / DOWN / RANGE probability over the next 12h.
2. **Structure model** — given that probability, which CE/PE strike to sell and
   how to hedge it.

Keeping them apart matters: a strike picker that quietly embeds a directional
view cannot be evaluated, because a bad fill and a bad forecast look identical
in the P&L.

---

## Factor groups

### 1. Candle / price action
Per 1m / 5m / 15m / 1H bar: body %, upper wick %, lower wick %, close location
in range, range, ATR, consecutive green/red count, HH/HL vs LH/LL, breakout /
breakdown, previous high/low break, S/R rejection, inside bar, engulfing, doji,
pin bar, hammer / shooting star.

- HH + HL + strong close → bullish
- LH + LL + weak close → bearish
- repeated wick rejection → reversal possibility

### 2. Momentum
RSI, RSI slope, RSI divergence, MACD, MACD histogram, ADX, +DI / −DI, ROC,
momentum, stochastic.

- price ↑ + momentum ↑ → trend confirmed
- price ↑ + momentum ↓ → bearish divergence warning

### 3. Trend structure (multi-timeframe)
5m / 15m / 1H / 4H, each with EMA 9 / 21 / 50 / 200, VWAP, trend slope.
Agreement across timeframes is the signal; a single timeframe is noise.

### 4. Volume
Volume, relative volume, volume MA, spike, trend, up-volume / down-volume.

    RVOL = current volume / average volume

- RVOL > 2 + breakout + strong close → breakout confirmed
- RVOL high + price flat → possible absorption

### 5. Open interest
OI, OI change, price change, volume, OI concentration, call OI, put OI,
build-up / unwinding.

| Price | OI | Reading |
|---|---|---|
| ↑ | ↑ | long buildup |
| ↓ | ↑ | short buildup |
| ↑ | ↓ | short covering |
| ↓ | ↓ | long unwinding |

Do **not** apply this table blindly to options: every option contract has a
buyer and a seller, so rising OI does not say which side initiated.

### 6. Greeks
Per strike: delta, gamma, theta, vega, IV. Aggregate:

    NetDelta       = Σ CE delta − Σ PE delta
    GammaExposure  = Σ gamma × OI

Gamma concentration marks the strikes that pin or accelerate price.

### 7. IV
ATM IV, OTM IV, call IV, put IV, IV change, IV skew, IV percentile.

- put IV ↑ strongly + put OI ↑ + spot ↓ → downside fear rising

### 8. Put–call structure
    PCR_OI     = put OI / call OI
    PCR_volume = put volume / call volume

PCR alone is not a signal. Use it with price, OI and IV together.

### 9. Support / resistance
Previous day high / low / close, daily open, weekly high / low, swing high /
low, VWAP, volume profile, high-OI strikes, high-gamma strikes. Then classify
each level strong or weak.

### 10. Volatility
ATR, realized vol, historical vol, Bollinger band width, range expansion,
range compression.

    low vol → BB squeeze → volume spike → breakout

### 11. Pattern in context
A pattern without location and volume is close to meaningless.

    PatternScore = Pattern × Location × Volume

Bullish engulfing at support on high volume is a signal; the same candle at
resistance on low volume is not.

### 12. Divergence
- bullish: price lower low, RSI higher low → possible upside reversal
- bearish: price higher high, RSI lower high → possible downside reversal

Apply to MACD and momentum as well.

### 13. Time of day
Hour, day of week, weekend flag, session, BTC volatility by hour, average
return by hour, average range by hour.

Derive these from the historical data only — never hard-code an assumption
about which hour is bullish.

### 14. Market regime
Detect the regime *first*, then run the prediction inside it:
TREND_UP, TREND_DOWN, RANGE, HIGH_VOLATILITY, LOW_VOLATILITY, BREAKOUT,
REVERSAL.

In RANGE, down-weight breakout signals and up-weight mean reversion.

### 15. External markets
ETH/BTC, BTC dominance, SPX, Nasdaq, DXY, gold, US treasury yields, funding
rate, futures basis.

---

## Combining

Normalize each group to a score before combining; never add raw values.

    TotalScore = Σ (wᵢ × Scoreᵢ)

Starting weights:

| Group | Weight |
|---|---|
| Price / candle | 15% |
| Trend | 12% |
| Options Greeks | 12% |
| Momentum | 10% |
| Open interest | 10% |
| Support / resistance | 10% |
| Volume | 8% |
| IV | 8% |
| Volatility | 7% |
| Macro | 5% |
| Funding | 3% |

These are a starting point, not a result. Fit them by walk-forward backtest,
and refit on a period the weights were not chosen on.

## Output contract

```
BTC 12H FORECAST

UP probability      68%
DOWN probability    24%
RANGE probability    8%

Expected return    +1.8%
Expected range     ±2.4%

Confidence          74%
Regime              TREND-UP

Key support         XXXXX
Key resistance      XXXXX

Signal              BULLISH
```

Probabilities and a range — never a bare "BTC will go down".
