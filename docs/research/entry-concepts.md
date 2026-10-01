# Entry concepts — the owner's 130, deduplicated

The owner's research list of 1 Oct 2026 (#1-#130, from two lists — both used
#38: **38a** "Multi-factor regime entry" and **38b**
"Range liquidity rotation"). Many are one idea at another level, timeframe or
anchor; each is merged into its canonical concept below, and every number has
exactly one status.

| Status | What it means | Concepts |
|---|---|---|
| **LIVE** | one of the twelve on the desk (with the numbers merged into them) | 12 (26 numbers) |
| **Tested — no edge** | replayed on 2.7 years of 5m candles (`scripts/methods-study.ts`), missed the bar | 30 detectors (43 numbers) |
| **Live data** | needs the desk's live tape / quote / option board — no history to replay; on the desk since 1 Oct | 12 detectors (21 numbers) |
| **Waiting for data** | recorded too briefly to *test*; since 1 Oct built live from the last hours | 20 (12 detectors) |
| **Not collected** | since 1 Oct built from the live book, the tape's prints and ETH candles; liquidations as a proxy | 12 (8 detectors) |
| **Regime entry** | measured on every signal as its regime (`regime`), and since 1 Oct a method of its own | 8 |
| **Multi-factor** | 38a, every regime reading agreeing -- a method since 1 Oct | 1 |

26 + 43 + 21 + 20 + 12 + 8 + 1 = 131: the 130 numbers, with #38 used twice.

**How many are really different.** Of the 131 entries, **50 repeat another
idea** (the "merged" ones) and **81 are unique** -- and **81 run as methods**,
one each (owner: "total 81, the 12 included, remove the rest"): #16 and #30
watch all three sessions in one method; the 10 regime ideas (the 8 below, #115
and #128) fire on their own triggers and are still kept on every signal as its
regime; 38a fires when every regime reading agrees.

Since 1 Oct 2026 every buildable concept is **on the desk as a method like the
twelve** (owner: "no separate research"), **one method per unique idea** (owner:
"keep the unique ideas, remove the rest") -- 81 methods in
`app/server/src/entry/methods.ts`, read, shown, paper-logged and alerted alike.
The "waiting for data" and "not collected" groups below were then built from
what the desk records live (hours of it are enough to run a method; years were
for testing it) -- all but the liquidation feed, which Delta does not publish
(#50 is a proxy). The filters are measured on every signal as its regime.
After a week or more, `scripts/methods-week.ts` reads the forward evidence
with the same bar as the replay.

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
| 16 | Opening-range breakout (one method, all three sessions) | — | −0.07 / +0.01 / −0.07 | −0.08 / −0.03 / +0.04 |
| 17 | Previous day H/L rejection | 93 multi-day liquidity sweep | −0.02 | −0.09 |
| 18 | Previous day H/L break & hold | — | −0.10 | +0.06 |
| 20 | VWAP reclaim / loss | — | −0.04 | −0.06 |
| 21 | Anchored VWAP (week) | 85 weekly VWAP, 86 monthly VWAP | −0.06 | −0.16 |
| 22 | Value-area break | 76 value-area migration | −0.05 | −0.03 |
| 23 | POC reclaim / loss | 75 POC migration, 77 HVN/LVN | +0.01 | −0.05 |
| 29 | Equal H/L sweep & reclaim | — | −0.02 | +0.04 |
| 30 | Session H/L sweep (one method, all three sessions) | — | −0.01 / −0.10 / +0.03 | −0.05 / +0.12 / −0.03 |
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

## Live data (on the desk)

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

## Waiting for data — built live

Recorded since 18-29 Sep 2026: too short to *test* fairly (revisit with three
months), long enough to *run*: each became a method on 1 Oct 2026 reading the
last six hours (`entry/deriv.ts`).

| # | Concept | Needs |
|---|---|---|
| 32 | OI + price matrix → OI-confirmed breakout | OI, last 6 h (99 breakout + OI expansion merged) |
| 33 | OI flush → reversal | OI, last 6 h (100 breakout + OI flush merged) |
| 48 | Perp–spot lead / lag | index 1m history |
| 54 | Funding flip | funding history |
| 55 | IV expansion breakout | IV history |
| 56 | IV crush reversion | IV history |
| 57 | Options skew divergence | per-strike IV history (114 skew / smile shift merged) |
| 58 | Gamma / dealer positioning | per-strike OI + greeks (106 gamma flip, 107 gamma-wall break, 108 gamma-wall rejection merged) |
| 109 | Options volume one-sided | option volume, last hour (110 call / put volume imbalance merged) |
| 111 | Call OI vs put OI divergence | OI by strike history |
| 112 | IV vs realised vol divergence | IV history |
| 113 | Term-structure shift | IV by expiry history |
| 115 | Expiry OI migration | OI by expiry history |

## Not collected — built from what is

Built on 1 Oct 2026 from the live book (#61, #62/69, #63, #64), the tape's
prints (#73, #74 -- the footprint) and ETHUSD candles (#129; #128 as a
regime). Liquidations: no feed exists; #50 is a proxy (open interest falling,
large prints one way), #34 and #96 merged into it and #33.

| # | Concept | Missing |
|---|---|---|
| 50 | Forced-flow continuation -- a **proxy** (no liquidation feed: OI falling + large prints one way) | 34 liquidation cluster reversal, 96 HTF liquidity + LTF liquidation merged |
| 61 | Book-imbalance breakout | the live book |
| 62 | Microprice | the live book (69 queue imbalance merged) |
| 63 | Liquidity replenishment | the book's walls |
| 64 | Spoof / pull | the book's heat by minute |
| 73, 74 | Footprint stacked imbalance (continuation / reversal) | volume per price per bar |
| 128, 129 | Correlation breakdown, BTC–ETH divergence | ETH / market series |

## Regime ideas, as methods

Measured on every signal as its regime, and since 1 Oct 2026 each a method too
(`REGIME_CANDIDATES` in methods.ts):

| # | Method | Fires on |
|---|---|---|
| 19, 89, 90 | Day / week / month range expansion | past the last period's range: a new extreme on volume (continuation), or a new extreme turned back (exhaustion) |
| 115 | Expiry OI migration | the front expiry's OI share down 5 points in the hour, and a 12-bar break |
| 118 | Volatility z-score spike | volatility 2σ over usual, and a 20-bar break |
| 119 | Volume z-score spike | volume 3σ over the last 50 bars, closed near the bar's extreme |
| 123 | Autocorrelation regime | trending: the 20-bar break; reverting: a 2σ stretch turning back |
| 126 | Range efficiency | efficiency ≥ 0.6, a pullback holding the 20 EMA, resuming |
| 127 | Trend-efficiency break | efficiency 0.6+ to ≤ 0.3, and a close against the run |
| 128 | Correlation breakdown | BTC–ETH correlation ≤ 0.3 (5m), and a 20-bar break |
| 38a | Multi-factor regime entry | straight, not reverting, volatility and volume up, the hourly trend the same way, and a 20-bar break |

#19 was tested as a filter (no bucket positive); none of these has a record
yet -- the paper log is it.
