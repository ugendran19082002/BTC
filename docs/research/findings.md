# Research findings

What the studies in [research/](../../research/) found, in one page. Each line
names the report with the full tables; the scripts that produce them are
beside it. Every study here was judged the same way: **chosen on 2024-25,
judged on 2026 out of sample, net of fees**, with the rule declared before
the result was looked at.

## The one-line version

- **Selling out-of-the-money premium on the daily contract makes money on the
  record**, with a fat left tail. Every directional rule tested on BTC, from 5m
  to 4H, is roughly zero before fees and negative after them.
- **Direction is a coin flip; magnitude is not.** The share of windows closing
  higher is 49.4-50.6% at every horizon from 5m to 12h (`chain.db.horizons`,
  105,119 windows), and conditioning on trend makes it worse. A confirmed break
  predicts a *bigger* hour, not which way it goes -- an option seller's edge,
  not a directional trader's.
- **A high win rate is not an edge.** 98% of 108 trades won over Jan-May 2025
  and the baseline still lost money. At 5m the momentum call reached its
  target first 80% of the time -- but 27% of those calls were made with the
  target already behind them, and no policy cleared fees.

## Short premium (what the desk trades)

| Study | Finding | Report |
|---|---|---|
| Baseline: 05:30 -> 17:30 IST, short CE + PE, furthest strike paying ≥ $15, 95% decay target | 733 days, **+₹15,225**, 96.3% winning days, profit factor 2.09, worst day ₹-1,526, max drawdown ₹1,943 | `BASELINE-REPORT.txt` |
| Exit rules | 90-95% decay beats holding to settlement; 50% decay halves the profit for 2.8 points of win rate | `BASELINE-REPORT.txt` |
| A model-probability gate (sell only legs the calibrated model scores ≥ 95% OTM) | gives up 35% of profit; profit factor 2.09 -> 3.15, max drawdown ₹1,943 -> ₹1,242, losing days 27 -> 9. Same size earns less; same risk earns slightly more | `GATE-DECISION.txt`, `FINAL-COMPARISON.txt` |
| Chasing rich far-OTM premium | negative in every variant: a far strike is expensive when a move is coming | [research/README.md](../../research/README.md) |
| Selling the nearest-the-money strike | 25% win rate, catastrophic | [research/README.md](../../research/README.md) |
| Regime filters | results flip between regimes; only rules stable across 2025 **and** 2026 survive | `FLOOR-FILTER-REPORT.txt`, `PROBABILITY-GATES.txt` |

## Direction (tested, not adopted)

| Study | Best result, net of fees | Verdict | Report |
|---|---|---|---|
| Momentum breakouts, 5m-1h (261,713 bars) | every policy negative at every timeframe; 0 of 960 filters positive in both 2024 and 2025 | no edge | `MOMENTUM-MEASURED.txt` |
| Entries and exits for big moves | −0.14R to −0.27R a trade | no edge | `MOMENTUM-STUDY.txt` |
| SMC / price action on 5m, 24 variants | −0.56R to −1.16R a trade | no edge; the chart shows it as context only | `SMC-STUDY.txt` |
| CRT family (1H / 4H / 1D / Asia range) | slightly positive before fees, −0.03R to −1.42R after | no edge | `CRT-STUDY.txt` |
| Published intraday momentum (first half hour -> last) | gross ≈ 0, fees twice the edge | not adopted | `INTRADAY-MOMENTUM.txt` |
| Volume profile (POC as magnet, value-area fades) | −0.09R to −0.35R | no edge | `PROFILE-STUDY.txt` |
| Order flow: CVD divergence, delta-agreeing SMC | −9.5 bp; −0.14R / −0.27R | no edge | `FLOW-STUDY.txt` |
| **1H / 4H trend breakout, 2 ATR stop, 3 ATR trail** | **+0.11R (2024-25), +0.003R (2026)**, not significant | the only one positive after fees in both halves -- **in a paper forward test** (`trend_paper`) until reviewed on 31 Oct 2026 | `COMBO-STUDY.txt` |

## What is untested

The volatility risk premium on the desk's own record (implied against
realised, by expiry) -- the documented edge for an option seller, and the
next measurement. Funding / basis carry, liquidation-cascade reversal, BTC-ETH
SMT and footprint absorption need data the desk does not yet record. The order
flow the desk now records (heatmap, big prints, option flow) becomes testable
from December 2026. The full list of candidate ideas: [ideas.md](ideas.md).
Open work: [TODO.md](../TODO.md), "Research".
