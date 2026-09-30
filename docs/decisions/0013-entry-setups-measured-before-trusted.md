# 0013 — The 24 entry setups are drawn and paper-logged, never traded, until their record says otherwise

**Status:** accepted · **Since:** 30 September 2026

## Context

`TEST.md` asks for twelve entry methods -- breakout, retest, sweep, FVG, OB,
BOS, MSS, momentum, pullback, VWAP reversion, order flow, options -- on a
timeframe chain, with automatic entry, stop and target boxes on the chart. The
owner asked for each both with the chain and without it: 24 setups.

This desk has already measured most of these families on its own candles:
momentum, SMC / price action, CRT, order flow and volume profile all came out
near zero before fees and negative after them
([research/findings.md](../research/findings.md)). `TEST.md` itself says the
same: no 100% accuracy, backtest and paper-trade before live money, and measure
each method's incremental value rather than stacking confirmations.

## Decision

- **Server decides, screen shows.** One engine on the server reads all 24 from
  closed candles; the screen draws what it said. The desk's thresholds are in
  one place and tested, not re-derived in the browser.
- **Three states, hard gates first.** Any failed gate is NO TRADE, however many
  confirmations are green -- a setup with no room to its target is not a trade.
  Only TRADE draws levels.
- **R:R after fees.** Delta's taker fee both ways is in every R:R and every
  graded result. On 5m that alone refuses most setups, which is the finding,
  not a bug.
- **A score is not a probability.** The 0-100 quality score is labelled as
  such; parts with no data (footprint, a calibrated probability) score nothing
  and say so.
- **Paper log, no orders.** Every TRADE is written once and graded on 1m
  candles, conservatively; each method's record, with the chain and without it,
  is on screen beside it. A method earns anything more -- an alert, an order
  button -- only with a positive record after fees over enough trades, judged
  on data it was not tuned on.

## Consequences

Most of the board reads NO TRADE most of the time, and says why. The record
needs weeks to mean anything; the review is in [TODO.md](../TODO.md). The
thresholds (R:R 1.8, 0.3-2.5 ATR stops, the chain's weights) are TEST.md's and
reasoning, not measurements; changing one is a change to what the log is
measuring, so the log should be read from that date.

**Where:** [features/entry-setups.md](../features/entry-setups.md).
