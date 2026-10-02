# Entry, SL and TGT -- all 81 methods

Where each of the desk's 81 entry methods enters, where its stop goes and
where it takes profit, and the logic they all share. Written 2 Oct 2026 from
the code ([`entry/methods.ts`](../../app/server/src/entry/methods.ts) -- each
method's `sl` and `targets` -- and
[`entry/engine.ts`](../../app/server/src/entry/engine.ts)); the code is the
authority where the two differ. The twelve's own trigger formulas are in
[entry-methods-reference.md](entry-methods-reference.md); how setups are
gated and paper-logged is in [entry-setups.md](entry-setups.md).

**All 81 read the BTC perpetual (BTCUSD)** -- its candles, its last trade and
its book. BTC spot (the index) is for the options side: settlement,
moneyness, the expected move, margin. No method places an order: every TRADE
is drawn and paper-logged ([decision 0013](../decisions/0013-entry-setups-measured-before-trusted.md)).

---

## The logic every method shares

1. **Read the perpetual's closed candles** on the timeframe. *With the
   timeframe chain* the entry is on 5m, and 4H, 1H, 30m and 15m must not point
   against it; then a 3m candle must close the trade's way, and the perp's
   live last trade must be at the entry (1m execution).
2. **The method's own trigger** says long or short, which of its steps have
   happened, where it would enter (a zone) and where it is wrong (a structural
   level).
3. **The plan**, the same for all 81:
   - **Entry** -- the zone narrowed to at most **0.5 ATR**, kept at the edge
     price reaches first; the fill is that edge (a long, the top; a short, the
     bottom).
   - **SL** -- the method's structural level **+ 0.25 ATR** past it.
   - **TGT1** -- the nearest real level of the method's preferred kind that
     pays **between 1R and 2R** from the fill; none in that band, **1.5R**.
   - **TGT2** -- the next level at least **0.5 ATR past TGT1**, from the
     method's pool.
   - **TGT3** -- the day's expected-move edge, or the method's own (max pain).
4. **The hard gates** -- any one that fails makes it NO TRADE:

   | Gate | Rule | Switch |
   |---|---|---|
   | Data fresh | the newest candle is current | locked on |
   | Plan valid | stop on the losing side, TGT1 not yet reached, entry within 2 ATR of the price | locked on |
   | Spread | perp spread ≤ 0.05% | on / off |
   | Perp at mark | last trade within 0.15% of the mark | on / off |
   | Stop band | stop 0.3-2.5 ATR from the entry | on / off |
   | R:R | ≥ 1 to TGT1 | on / off |
   | HTF alignment | 1H and 4H not both against (with the chain) | on / off |
   | Big-move risk | not high / sudden pointing the other way | on / off |
   | Expected move | under 80% of the day's expected move used this way | on / off |
   | Settlement | not within 15 min of 17:30 IST | on / off |
   | Method gate | the method's own "not now" (where it has one) | on / off |

   A step not yet met makes it WAIT; everything met, TRADE.
5. **The paper log** -- a limit at the zone's edge, filled within 12 bars or
   expired; then the stop, TGT1 or 48 bars, whichever first (a bar touching
   both is the stop); after TGT1 the rest runs for TGT2 / TGT3 with its stop at
   breakeven. In points and R, before fees.

**Two kinds of entry.** *Close* -- the zone sits just behind the signal
candle's close (0.25 ATR), so the trade is in on the candle that signalled
(74 methods). *Level* -- the zone sits at a level the price must come back to:
the breakout level, the gap, the order block, the broken swing (7 methods:
#2-#7 and #11).

**Target kinds.** *swing* a swing on the entry timeframe; *nearest* the
nearest level of any kind (the method's own, a swing, a 1H / 4H swing, a book
wall, an OI wall); *own* the method's own target (VWAP, the range middle, the
projection); *book wall* a resting wall in the perp's book; *OI wall* the
option board's call / put wall; *1H-4H swing* the next 1H / 4H swing; *next*
the next level of any kind.

---

## All 81

| # | Method | Entry | SL (+0.25 ATR) | TGT1 / TGT2 |
|---|---|---|---|---|
| 1 | Breakout | close | breakout candle's far end | swing / 1H-4H swing |
| 2 | Breakout + retest | level | retest extreme | swing / 1H-4H swing |
| 3 | Liquidity sweep | level | sweep extreme | nearest / 1H-4H swing |
| 4 | FVG retest | level | displacement origin | swing / next |
| 5 | Order-block retest | level | block's far edge | swing / 1H-4H swing |
| 6 | BOS | level | last HL / LH | swing / 1H-4H swing |
| 7 | MSS / CHoCH | level | post-sweep extreme | nearest / 1H-4H swing |
| 8 | Momentum | close | momentum candle's far end | nearest / next |
| 9 | Pullback | close | pullback extreme | swing / 1H-4H swing |
| 10 | VWAP mean reversion | close | 2σ reversal extreme | VWAP / VWAP ±1σ |
| 11 | Order flow | level | absorption extreme | book wall / book wall |
| 12 | Options / derivatives | close | OI wall / rejection extreme | OI wall / OI wall (TGT3 max pain) |
| 13 | Compression break | close | box's far side | nearest / next (box projection) |
| 14 | Failed breakout (trap) | close | trap extreme | range middle / range edge |
| 15 | Opening-range breakout | close | range middle | nearest / next (OR projection) |
| 16 | Prev-day H/L rejection | close | sweep extreme | nearest / 1H-4H swing |
| 17 | Prev-day break & hold | close | retest extreme | nearest / 1H-4H swing |
| 18 | Prev-day range expansion | close | extreme bar's far end | nearest / 1H-4H swing |
| 19 | VWAP reclaim / loss | close | VWAP retest extreme | nearest / next |
| 20 | Anchored VWAP (week) | close | touch extreme | nearest / next |
| 21 | Value-area break | close | back inside value area | nearest / next |
| 22 | POC reclaim / loss | close | hold extreme | nearest / next |
| 23 | CVD divergence | close | divergent swing | nearest / next |
| 24 | Delta divergence | close | weak-delta extreme | nearest / next |
| 25 | Exhaustion reversal | close | climax bar's extreme | nearest / next |
| 26 | Equal H/L sweep | close | sweep extreme | nearest / 1H-4H swing |
| 27 | Session H/L sweep | close | sweep extreme | nearest / next |
| 28 | Funding + price divergence | close | new extreme | nearest / next |
| 29 | OI-confirmed breakout | close | break bar's far end | nearest / 1H-4H swing |
| 30 | OI flush reversal | close | turn extreme | nearest / next |
| 31 | Expected-move edge | close | edge touch extreme | own / next |
| 32 | Volatility regime transition | close | break bar's far end | nearest / next |
| 33 | Z-score reversion | close | stretch extreme | own / next |
| 34 | Multi-factor regime | close | break bar's far end | nearest / 1H-4H swing |
| 35 | Mid-range rejection | close | rejection extreme | own / next |
| 36 | Trendline break & retest | close | retest extreme | nearest / 1H-4H swing |
| 37 | Channel breakout | close | break bar's far end | nearest / next |
| 38 | Engulfing + structure | close | engulfing extreme | nearest / 1H-4H swing |
| 39 | NR7 / inside-bar break | close | narrow bar's far side | nearest / next |
| 40 | Dislocation reversion | close | turn extreme | own / next |
| 41 | Basis divergence (perp vs index) | close | turn extreme | own / next |
| 42 | Index leads, perp lags | close | four-bar extreme | nearest / next |
| 43 | Mark-perp divergence | close | turn extreme | own / next |
| 44 | Forced-flow (liquidation proxy) | close | break bar's far end | nearest / next |
| 45 | OI wall break & retest | close | retest extreme | nearest / OI wall |
| 46 | Funding flip | close | break bar's far end | nearest / next |
| 47 | IV expansion breakout | close | break bar's far end | nearest / next |
| 48 | IV crush reversion | close | stretch extreme | own / next |
| 49 | Options skew divergence | close | turn extreme | nearest / next |
| 50 | Gamma wall reaction | close | touch extreme | nearest / next |
| 51 | Expiry pin / max pain | close | turn extreme | own / next |
| 52 | Book imbalance breakout | close | break bar's far end | nearest / next |
| 53 | Microprice imbalance | close | bar's far end | nearest / next |
| 54 | Liquidity replenishment | close | past the wall | nearest / next |
| 55 | Pulled wall (spoof) | close | bar's far end | nearest / next |
| 56 | Big-print follow-through | close | print bar's far end | nearest / next |
| 57 | Aggression spike | close | spike's far end | nearest / next |
| 58 | CVD regime shift | close | six-bar extreme | nearest / next |
| 59 | Footprint stack: continuation | close | stack's far side | nearest / next |
| 60 | Footprint stack: reversal | close | bar's extreme | nearest / next |
| 61 | Naked POC reaction | close | touch extreme | nearest / next |
| 62 | Initial balance break | close | IB middle | nearest / next (IB projection) |
| 63 | IB failed break | close | failed-break extreme | IB middle / next |
| 64 | Prev-week H/L sweep | close | sweep extreme | nearest / 1H-4H swing |
| 65 | Prev-month H/L sweep | close | sweep extreme | nearest / 1H-4H swing |
| 66 | Weekly range expansion | close | extreme bar's far end | nearest / 1H-4H swing |
| 67 | Monthly range expansion | close | extreme bar's far end | nearest / 1H-4H swing |
| 68 | Prev-week break-reclaim | close | failed-break extreme | nearest / 1H-4H swing |
| 69 | Prev-month break-reclaim | close | failed-break extreme | nearest / 1H-4H swing |
| 70 | Option volume one-sided | close | break bar's far end | nearest / next |
| 71 | Call/put OI divergence | close | turn extreme | nearest / next |
| 72 | IV vs realised vol | close | bar's far end | nearest / next |
| 73 | Term-structure inversion | close | break bar's far end | nearest / next |
| 74 | Expiry OI migration | close | break bar's far end | nearest / next |
| 75 | Volatility z-spike | close | break bar's far end | nearest / next |
| 76 | Volume z-spike | close | bar's far end | nearest / next |
| 77 | Autocorrelation regime | close | bar's far end / stretch extreme | nearest / next |
| 78 | Range-efficiency entry | close | pullback extreme | nearest / 1H-4H swing |
| 79 | Trend-efficiency break | close | six-bar extreme | nearest / 1H-4H swing |
| 80 | BTC–ETH correlation break | close | break bar's far end | nearest / next |
| 81 | BTC vs ETH divergence | close | new extreme | nearest / next |

---

## Open, for the owner

From the 2 Oct 2026 audit ([history](../history/2026-10.md)):

- **#2, #4, #5 and #7 wait twice.** They signal only after the retest and
  its rejection, then rest the entry back at the level -- so they fill only if
  price returns a second time (the replay's misses: #5 64%, #7 50%, #2 36%,
  #4 30%). Entering on the confirmation candle's close, as the 74 *close*
  methods do, is the usual practice.
- **Near-duplicates.** 82% of #32's signals and 81% of #34's are also #37's,
  and 71% of #1's; #39 fires about 29 times a day on 5m.
- **40 of the 81 need live data** (the tape, the book, the option board) and
  can only be judged from the live signal history, not a replay of candles.
- **5m-only.** #80 reads ETH on 5m alone, by design.
