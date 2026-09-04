# BTC — Delta Exchange (India) daily-expiry short-premium research

Backtest + R&D toolkit for a **short strangle on BTC daily-expiry options**
on Delta Exchange India, replicating the AlgoTest `BTC_CE` strategy.

## The strategy being studied

| Setting | Value |
|---|---|
| Underlying | BTCUSD (Delta India) |
| Entry | **05:30 IST** (= 00:00 UTC, start of the contract's final day) |
| Exit | **17:29 IST** (1 minute before the 17:30 IST / 12:00 UTC settlement) |
| Legs | Sell 1 Call + Sell 1 Put, daily expiry |
| Strike rule | `Premium <= 15` (richest strike at or below the cap) |
| Size | 10 lots per leg, lot = 0.001 BTC |
| Risk | no stop-loss, no target |
| Costs | 5% slippage on entry and exit |
| FX | 1 USD = 85 INR |

Delta quotes option premium in **USD per 1 BTC**; a lot is 0.001 BTC, so
`PnL = (entry - exit) x lots x 0.001`. AlgoTest displays P&L already
multiplied by 85, i.e. in INR.

## Files

| File | Purpose |
|---|---|
| `harvest.py` | Pulls 1-minute option candles per expiry day (+ volume, MARK price, Open Interest) into `cache/` |
| `features.py` | Daily BTCUSD technical features: RSI, MACD, ADX, ATR, EMA, Bollinger width, realised vol. Every value is computed from the **prior** daily close, so it is known at the 05:30 entry — no lookahead. |
| `analyze.py` | The R&D engine: 19 strike-selection rules, 4 exit rules, ~28 regime filters, position sizing, cross-period stability test |
| `backtest.py` | Simple standalone backtest of the baseline rule |
| `RND-REPORT.txt` | Generated report. Sections are appended as they finish. |
| `test.md` | Margin / position-sizing model (funds, margin per lot, max lots) |

## Usage

```bash
python3 harvest.py 2024-09-04 2026-09-03     # fetch data into cache/
python3 analyze.py > RND-REPORT.txt          # run the full study
python3 backtest.py 2025-01-01 2025-12-31 "2025 run"
```

## What the data actually supports

- Delta **India** BTCUSD perpetual candles start **2023-12-29**.
- Daily-expiry BTC option contracts exist from **January 2024**; there are
  **no** such contracts in 2023, and none anywhere before Delta launched BTC
  options in 2020.
- Deep-ITM strikes return only a flat post-expiry settlement stub, not real
  quotes. Only near-the-money strikes have genuine intraday history.
- AlgoTest's own backtest only covers **September 2025 onward**.

## Findings so far (partial data — read `RND-REPORT.txt` for the current run)

- A **98% win rate does not mean profitable.** Over Jan–May 2025 the
  `Premium <= 15` baseline won 98.1% of 108 trades and still finished
  **negative**: a couple of large losing days outweighed ~106 small wins.
- **Chasing rich far-OTM premium loses money.** A far strike is expensive
  precisely when a large move is coming; that premium is fairly priced, not
  free. Every `rich OTM` variant tested negative.
- Selling the **nearest-the-money** strike is catastrophic (25% win rate).
- Results **flip between regimes.** Rules that look excellent over one calm
  quarter reverse over the next. Only rules marked `STABLE` in the
  cross-period stability table survived both 2025 and 2026.

## Caveat

This is research on ~2 years of history for a naked short-premium strategy.
The losses in this structure live in the tail, and two years is not enough to
observe it. Brokerage is excluded in most runs; on a daily 4-fill schedule it
is material. Nothing here is trading advice.
