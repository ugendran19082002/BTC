# Entry concepts — the owner's 130, deduplicated

The owner's research list of 1 Oct 2026 (#1-#130, from two lists — both used
#38: **38a** "Multi-factor regime entry", declined by the owner, and **38b**
"Range liquidity rotation"). Many are one idea at another level, timeframe or
anchor; each is merged into its canonical concept below, and every number has
exactly one status.

| Status | What it means | Concepts |
|---|---|---|
| **LIVE** | one of the twelve on the desk (with the numbers merged into them) | 12 (26 numbers) |
| **Tested — no edge** | replayed on 2.7 years of 5m candles (`scripts/methods-study.ts`), missed the bar | 30 detectors (43 numbers) |
| **Research track (live data)** | needs the desk's live tape / quote / option board — no history to replay; runs live, paper-logged | 12 detectors (21 numbers) |
| **Waiting for data** | the desk records the input, but not long enough to build or test on | 20 |
| **Not collected** | needs data the desk does not record | 12 |
| **Filter, not an entry** | a regime reading, used beside entries | 8 |
| **Declined** | 38a, multi-factor composite | 1 |

26 + 43 + 21 + 20 + 12 + 8 + 1 = 131: the 130 numbers, with #38 used twice.

All tested and research-track candidates run **live on the research track**
(1 Oct 2026, owner): read every minute beside the twelve on every timeframe,
written to the signal journal and paper log marked `research`, graded the
same way, **never alerted**, kept out of the twelve's history (the *Methods*
filter shows them) and record. After a week or more the forward evidence is
read with the same bar as the replay.

**The bar** (set before any run): average R above zero in 2024-25 **and** in
2026, t ≥ 2 over both, ≥ 200 closed trades. For the research track's forward
week the bar is the same in spirit — positive average R with t ≥ 2 on enough
trades — and a week is short: a candidate that looks good after one week is a
candidate for a longer week, not for the desk.

## LIVE — the twelve (and what merges into them)

| # | Concept | Merged here |
|---|---|---|
| 1 | Breakout | — |
| 2 | Breakout + retest | — |
| 3 | Liquidity sweep | 38b range liquidity rotation, 42 wick rejection |
| 4 | FVG retest | 94 HTF FVG + LTF flow (the chain) |
| 5 | Order-block retest | 95 HTF OB + LTF absorption |
| 6 | BOS | 97 BOS + CVD |
| 7 | MSS / CHoCH | 98 MSS + absorption |
| 8 | Momentum | 124 momentum persistence |
| 9 | Pullback | — |
| 10 | VWAP / mean reversion | 84 session VWAP deviation, 116 VWAP z-score |
| 11 | Order flow | 26 absorption reversal, 65 iceberg absorption |
| 12 | Options / derivatives | 53 OI wall rejection, 103 call-wall rejection, 104 put-wall rejection |

## Tested on candles — no edge (round 1 and round 2)

Each row is a detector in `app/server/src/entry/methods.ts`; results in
`research/METHODS-STUDY.txt` (5m, 2024-01 .. 2026-08, R in points, the live
SL/TGT rules). **None passed.** All now run on the research track.

| # | Concept (detector) | Merged here | 2024-25 avg R | 2026 avg R |
|---|---|---|---:|---:|
| 13 | Compression break | 120 ATR regime shift, 121 realised-vol breakout | −0.00 | +0.17 (n 9) |
| 14 / 15 | Failed breakout / breakdown (trap) | 79, 80, 81 (failed auction, acceptance / rejection) | −0.06 | +0.01 |
| 16 | Opening-range breakout · Asia / London / New York | — | −0.07 / +0.01 / −0.07 | −0.08 / −0.03 / +0.04 |
| 17 | Previous day H/L rejection | 93 multi-day liquidity sweep | −0.02 | −0.09 |
| 18 | Previous day H/L break & hold | — | −0.10 | +0.06 |
| 20 | VWAP reclaim / loss | — | −0.04 | −0.06 |
| 21 | Anchored VWAP (week) | 85 weekly VWAP, 86 monthly VWAP | −0.06 | −0.16 |
| 22 | Value-area break | 76 value-area migration | −0.05 | −0.03 |
| 23 | POC reclaim / loss | 75 POC migration, 77 HVN/LVN | +0.01 | −0.05 |
| 29 | Equal H/L sweep & reclaim | — | −0.02 | +0.04 |
| 30 | Session H/L sweep · Asia / London / New York | — | −0.01 / −0.10 / +0.03 | −0.05 / +0.12 / −0.03 |
| 36 | Volatility regime transition | — | −0.11 | −0.04 |
| 37 | Z-score reversion | 117 return z-score, 122 RV mean reversion, 125 mean-reversion half-life | −0.05 | +0.01 |
| 39 | Mid-range rejection | — | −0.04 | −0.18 |
| 40 | Trendline break & retest | — | −0.03 | −0.04 |
| 41 | Channel breakout | — | −0.11 | −0.07 |
| 43 | Engulfing + structure | — | −0.07 | −0.08 |
| 45 | NR7 / inside-bar break | 44 inside-bar expansion | −0.05 | −0.04 |
| 46 | Dislocation reversion | 28 liquidity void (without trade counts) | +0.02 | −0.04 |
| 78 | Naked POC reaction | — | −0.11 | −0.09 |
| 82 | Initial balance break | — | +0.03 | −0.10 |
| 83 | Initial balance failed break | — | +0.02 | −0.02 |
| 87 | Previous week H/L sweep | — | −0.04 | −0.17 |
| 88 | Previous month H/L sweep | — | −0.12 | −0.23 |
| 91 | Previous week H/L break-reclaim | — | −0.01 | −0.00 |
| 92 | Previous month H/L break-reclaim | — | −0.08 | +0.09 |

The closest: #29 equal H/L sweep with the higher timeframes not against —
+0.06R, t 2.42 in 2026, but −0.03R in 2024-25. A sign that flips between
periods is not an edge.

## Research track — live data only

In `app/server/src/entry/methods.ts`. Each reads what the desk records
live and says nothing when it is missing.

| # | Concept | Reads | Merged here |
|---|---|---|---|
| 24 | CVD divergence | tape per minute | — |
| 25 | Delta divergence | tape | 72 volume-delta exhaustion |
| 27 | Exhaustion reversal | tape | 51 liquidation-cascade exhaustion (without liquidations) |
| 31 | Funding + price divergence | funding rate | — |
| 35 | Expected-move edge reaction | option board (EM) | — |
| 47 | Basis divergence | perp vs index | 130 BTC vs index divergence |
| 49 | Mark-perp divergence | perp vs mark | — |
| 52 | OI wall break & retest | option board (walls) | 101 call-wall break, 102 put-wall break |
| 60 | Expiry pin / max-pain magnet | option board (max pain, time to settle) | 59 time-to-expiry compression, 105 max-pain reversion |
| 66 | Big-print follow-through | large prints | — |
| 67 | Trade velocity / aggression spike | tape | 68 aggression acceleration |
| 70 | CVD regime shift | tape | 71 delta acceleration |

## Waiting for data

Recorded since 18-29 Sep 2026 (tape, OI, funding, option snapshots, index):
too short to build a fair test. Revisit with three months.

| # | Concept | Needs |
|---|---|---|
| 32 | OI + price matrix (as a regime) | OI history |
| 33 | OI flush → reversal | OI history |
| 48 | Perp–spot lead / lag | index 1m history |
| 54 | Funding flip | funding history |
| 55 | IV expansion breakout | IV history |
| 56 | IV crush reversion | IV history |
| 57 | Options skew divergence | per-strike IV history (114 skew / smile shift merged) |
| 58 | Gamma / dealer positioning | per-strike OI + greeks (106 gamma flip, 107 gamma-wall break, 108 gamma-wall rejection merged) |
| 99 | Breakout + OI expansion | OI history |
| 100 | Breakout + OI flush | OI history |
| 109 | Options volume spike | option volume history |
| 110 | Call / put volume imbalance | option volume history |
| 111 | Call OI vs put OI divergence | OI by strike history |
| 112 | IV vs realised vol divergence | IV history |
| 113 | Term-structure shift | IV by expiry history |
| 115 | Expiry OI migration | OI by expiry history |

## Not collected

| # | Concept | Missing |
|---|---|---|
| 34, 50, 96 | Liquidation cluster reversal, cascade continuation, HTF liquidity + LTF liquidation | liquidation feed |
| 61, 62, 63, 64, 69 | Book-imbalance breakout, microprice, replenishment, spoof / pull, queue imbalance | L2 order book ticks |
| 73, 74 | Footprint stacked imbalance (continuation / reversal) | volume per price per bar |
| 128, 129 | Correlation breakdown, BTC–ETH divergence | ETH / market series |

## Filters, not entries

19 range consumed (tested as a filter: no bucket positive), 89 weekly and 90
monthly range expansion, 118 volatility z-score, 119 volume z-score, 123
autocorrelation regime, 126 range efficiency, 127 trend-efficiency break. They
describe the market a setup is taken in; their use is to sort the research
track's evidence afterwards (which methods work in which regime), not to fire.

## Declined

38a Multi-factor regime entry — the owner: not as a method.
