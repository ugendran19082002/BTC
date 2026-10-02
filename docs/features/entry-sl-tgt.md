# Entry, SL, TGT and exit -- all 81 methods, both ways

How each of the desk's 81 entry methods decides a trade -- where it enters,
where its stop goes, where it takes profit, and how the trade ends -- read
two ways: **with the timeframe chain** (section 1) and **without it**
(section 2). Written 2 Oct 2026 from the code; the code is the authority
where the two differ:
[`entry/methods.ts`](../../app/server/src/entry/methods.ts) (each method's
trigger, `sl` and `targets`), [`entry/engine.ts`](../../app/server/src/entry/engine.ts)
(the plan, the gates, the chain), [`entry/paper.ts`](../../app/server/src/entry/paper.ts)
and [`entry/live-grade.ts`](../../app/server/src/entry/live-grade.ts) (the exit).

**Every method reads the BTC perpetual (BTCUSD)** -- its candles, its last
trade, its book. BTC spot (the index) is for the options side: settlement,
moneyness, the expected move, margin. **No method places an order**: every
TRADE is drawn on the chart, alerted if switched on, and paper-logged
([decision 0013](../decisions/0013-entry-setups-measured-before-trusted.md)).
The twelve's own trigger formulas are in
[entry-methods-reference.md](entry-methods-reference.md).

Contents: [the read](#the-read-every-minute) ·
[the plan -- entry, SL, TGT](#the-plan--entry-sl-tgt-the-same-in-both-ways) ·
[the gates](#the-hard-gates) ·
[section 1, with the chain](#section-1--with-the-timeframe-chain) ·
[section 2, without it](#section-2--without-the-timeframe-chain) ·
[the exit](#the-exit--the-paper-log-the-same-in-both-ways) ·
[a worked example](#a-worked-example) · [all 81](#all-81)

---

## The read, every minute

Every minute, 3 seconds after it closes, the server reads all 81 methods: once **with the
chain** (entry on 5m) and once **without it** on each of 3m, 5m, 15m, 30m, 1h
and 4h -- 81 + 81 × 6 = 567 reads. On closed candles only, so a signal never
appears on a forming candle and vanishes when it closes. A timeframe needs 60
closed candles before it is read at all.

Each read ends in one of three states:

| State | Means |
|---|---|
| **TRADE** | every step of the method (and of the chain, with it) has happened, and no switched-on hard gate refuses. A plan is drawn and paper-logged. |
| **WAIT** | the setup is forming, a step is still missing (or could not be read). Nothing is logged. |
| **NO TRADE** | a switched-on hard gate refuses (the method's own gate is named first), or nothing is forming. |

A TRADE is written once, keyed by method, way, timeframe, direction and the
candle its trigger closed on -- a setup that stays on the board for ten minutes
is one row, and one alert.

---

## The plan -- entry, SL, TGT (the same in both ways)

Each method's trigger hands over four things: the direction, its steps, an
**entry zone**, and a **structural stop level** (the "SL" column of the table
below). From those the engine builds the plan the same way for all 81. ATR is
Wilder's ATR(14) on the entry timeframe.

### Entry

1. **The zone.** Each method puts its zone either *at the close* -- just behind
   the signal candle's close, 0.25 ATR deep (74 methods) -- or *at a level*
   price must come back to: the broken level, the gap, the order block, the
   broken swing (7 methods: #2-#7 and #11).
2. **Narrowed to 0.5 ATR**, kept at the edge price reaches first: a long's
   zone keeps its **top**, a short's its **bottom**. A gap or an order block
   can be 8 ATR tall; that is a region, not an entry.
3. **Kept off the stop**: at least 0.1 ATR from it.
4. **The fill is the near edge** -- a long fills at the top of its zone, a
   short at the bottom. Risk and R:R are measured from there, never from the
   middle.

### SL

- **The method's structural level** -- the candle, swing, sweep or zone that
  proves the idea wrong if traded through (the table's SL column) -- **plus
  0.25 ATR** beyond it (minus for a long, plus for a short).
- **Risk** = the distance from the fill to the SL.
- The **Stop band** gate wants it **0.3 to 2.5 ATR** from the fill: nearer is
  inside the noise, further is not worth the trade. **Plan valid** wants it on
  the losing side of the fill.

### TGT1, TGT2, TGT3

Targets come from real levels **past the zone** (more than 0.2 ATR past its
edge), nearest first: the method's own targets, swings on the entry timeframe,
1H / 4H swings, the perp book's resting walls, the option board's call / put
wall. A swing price has already traded through is **consumed** -- its
liquidity is taken -- and is never a target.

- **TGT1** -- the nearest level of the method's preferred kind that pays
  **between 1R and 2R** from the fill; failing that, the nearest of any kind in
  that band. **No level in the band: TGT1 is 1.5R**, and a level further out
  becomes TGT2. Every level under 1R: TGT1 is the nearest, and the R:R gate
  refuses the read -- never an invented far target. *VWAP reversion* (#10)
  keeps VWAP as TGT1 whatever it pays: returning to it is the method.
- **TGT2** -- the next level from the method's pool at least **0.5 ATR past
  TGT1**; none in the pool, the next of any kind; none at all, no TGT2.
- **TGT3** -- the method's own (max pain, #12) or the day's **expected-move
  edge**, at least 0.5 ATR past TGT2 (or TGT1).
- **R:R** = (TGT1 - fill) / risk, in points. No fee term.

Target kinds in the table: *swing* a swing on the entry timeframe; *nearest*
the nearest level of any kind; *own* the method's own (VWAP, the range middle,
a projection); *book wall* a wall in the perp's book; *OI wall* the call / put
wall; *1H-4H swing* the next 1H / 4H swing; *next* the next level of any kind.

---

## The hard gates

Any switched-on gate that fails makes the read NO TRADE. A gate switched off
is still read and shown ("✗ would refuse") but refuses nothing, and a setup
taken with a gate off is marked so in the log.

| Gate | Rule | Switch |
|---|---|---|
| Data fresh | with the chain: the newest 1m candle ≤ 3 min old; without it: the timeframe's newest ≤ one candle + 3 min | locked on |
| Plan valid | the SL on the losing side of the fill; **TGT1 not yet reached** by the price; the entry within **2 ATR** of the price | locked on |
| Spread | the perp's spread ≤ 0.05% | on / off |
| Perp at mark | the perp's last trade within 0.15% of its mark (else a wick, not a level) | on / off |
| Stop band | SL 0.3-2.5 ATR from the fill | on / off |
| R:R | ≥ 1 to TGT1 | on / off |
| HTF alignment | **with the chain only**: 1H and 4H not both against | on / off |
| Big-move risk | not "high" / "sudden" pointing against the trade | on / off |
| Expected move | under 80% of the day's expected move already used in this direction | on / off |
| Settlement | not within 15 min of 17:30 IST | on / off |
| Method gate | the method's own "not now" -- momentum extended over 3 ATR from the 20 EMA (#8), mean reversion on a trend day (#10) | on / off |

"Plan valid" judges the plan against the price **now**: the perp's last trade
while it is under 15 s old, else the last closed candle.

---

## Section 1 -- With the timeframe chain

The method is read on **5m**, and the other timeframes must agree around it
(TEST.md's chain):

| Timeframe | Job | Weight | Step |
|---|---|---:|---|
| 4H | macro context | 5 | trend **not against** the trade |
| 1H | major structure | 10 | trend not against |
| 30m | regime | 10 | trend not against |
| 15m | setup | 15 | trend not against |
| **5m** | **entry** | 30 | **the method's own trigger -- every step** |
| 3m | confirmation | 15 | the last 3m candle **closed the trade's way** |
| 1m | execution | 15 | the price **at the entry**, the stop intact |

*Trend* is +1 / 0 / -1 and needs two readings to agree: the EMA stack (close
over the 20 EMA over the 50 EMA) **and** the swings (a higher high and a higher
low). "Not against" lets a neutral timeframe through. The weights make the
**alignment** figure on the screen -- how much of the chain agrees, 0-100 --
which is shown, not gated.

### Entry (with the chain)

1. 4H, 1H, 30m and 15m each not against the trade (a timeframe with under 60
   candles is "not read", and the read waits).
2. The method's trigger on 5m, every one of its steps.
3. The last closed **3m** candle closed the trade's way (a long: green).
4. **Execution on 1m**: the price -- the perp's last trade if under 15 s old,
   else the last closed 1m close -- is **at the entry**: for a long, at or under
   the zone's top + 0.3 ATR; for a short, at or over its bottom - 0.3 ATR; and
   the stop not traded through.
5. Every switched-on gate passes -- including **HTF alignment** (1H and 4H not
   both against) and **Data fresh** on the 1m candle (≤ 3 min old).

Then TRADE, with the plan above, measured on **5m** ATR.

### SL and TGT (with the chain)

As [the plan](#the-plan--entry-sl-tgt-the-same-in-both-ways), on 5m: the SL
is the method's level ± 0.25 ATR(5m); TGT1 from 5m swings first (for *swing*
methods), else 1H / 4H swings, walls and OI walls between 1R and 2R; TGT2 the
next 1H / 4H swing for most methods.

### Exit (with the chain)

As [the exit](#the-exit--the-paper-log-the-same-in-both-ways), on 5m clocks:
**60 minutes** to fill, then **4 hours** in the trade before the time-out.

---

## Section 2 -- Without the timeframe chain

The method is read on **one timeframe alone** -- 3m, 5m, 15m, 30m, 1h or 4h,
each logged apart (the Methods report has a tab each). 1m is the chart only:
nothing is read on it.

### Entry (without the chain)

1. The method's trigger on that timeframe, every one of its steps.
2. Every switched-on gate passes. **HTF alignment is not part of this way**
   (listed, never applied); **Data fresh** is that timeframe's newest candle
   (≤ one candle + 3 min old).

That is all: no other timeframe, no 3m confirmation, no 1m execution check.
Then TRADE, with the plan above, measured on **that timeframe's** ATR.

### SL and TGT (without the chain)

As [the plan](#the-plan--entry-sl-tgt-the-same-in-both-ways), on that
timeframe: the SL ± 0.25 of its ATR; *swing* targets from its own swings. A
4H read's stop and targets are therefore far wider than a 3m read's of the
same method.

### Exit (without the chain)

As [the exit](#the-exit--the-paper-log-the-same-in-both-ways), on that
timeframe's clock -- 12 of its candles to fill, 48 in the trade:

| Timeframe | Fill window (12 candles) | Time-out (48 candles) |
|---|---|---|
| 3m | 36 min | 2 h 24 min |
| 5m | 1 h | 4 h |
| 15m | 3 h | 12 h |
| 30m | 6 h | 24 h |
| 1h | 12 h | 2 days |
| 4h | 2 days | 8 days |

**Time-anchored methods** read the same clock on every timeframe that fits:
the opening range (#15) is the session's first 30 minutes and the initial
balance (#62, #63) the day's first hour -- so they read on 3m, 5m, 15m and 30m
(#62 / #63 on 1h too), and not at all where a candle is longer than the window.
#80 compares BTC with ETH on 5m only.

---

## The exit -- the paper log (the same in both ways)

Nothing is ordered; each TRADE is graded the way a resting limit order would
have gone, on the perp's own trades as they print (every second), with the
1-minute candles as the backstop. Clocks run on the read's timeframe (5m with
the chain).

### 1. Waiting for the fill

The grading starts at the first whole minute after the setup was first seen
(that minute traded partly before it existed). The fill window is **12
candles** of the timeframe, from when the setup was on the board.

- **Filled** -- price trades into the zone: at the **zone's edge** (a long, the
  top), or better when a candle opens already inside the zone.
- **Expired, stop first** -- price opens past the SL before the zone: the idea
  was wrong before it was in.
- **Expired, ran to TGT1 without it** -- price reaches TGT1 without coming back
  to the zone: the move went without the trade. (Signals whose TGT1 had already
  been reached when they appeared are now refused by **Plan valid** instead.)
- **Expired, window** -- the 12 candles pass with no fill.

### 2. In the trade

Checked in this order, every trade (or candle):

1. **Time-out** -- 48 candles after the fill: closed at the price when the time
   ran out.
2. **SL** -- price trades through the stop: out **at the stop**, or at the
   candle's open when it gapped past it (what a real stop gets). A candle that
   touches both the SL and TGT1 counts as the **SL** -- the reading that cannot
   flatter the record. In the fill's own candle only the SL counts.
3. **TGT1** -- price trades to TGT1: out at **exactly TGT1** (a limit).

**R** = (exit - fill) × direction / risk. A full stop is -1R; TGT1 is the
plan's R:R. The record's R is this TGT1 / SL / time-out exit. Points are the
same distance in BTC points. No fees.

### 3. After TGT1 -- the runner

The rest of the trade runs on for **TGT2** and **TGT3** with its stop moved to
the **fill (breakeven)**, checked stop first, until breakeven, TGT3 (or TGT2
when there is no TGT3), or the same 48-candle time-out. The history shows which
targets were reached and when; the record's R stays the TGT1 exit.

---

## A worked example

**#1 Breakout, long, on 5m, without the chain.** ATR(14, 5m) = 100. A candle
closes at **84,000** through the 20-candle high, on 1.6× the usual volume,
near its high. Its low is 83,850.

| | Rule | Price |
|---|---|---|
| Zone | just behind the close, 0.25 ATR | 83,975 - 84,000 |
| **Entry (fill)** | a long fills at the top | **84,000** |
| **SL** | the breakout candle's low - 0.25 ATR | 83,850 - 25 = **83,825** |
| Risk | fill - SL | 175 points = 1R |
| 1R / 2R | 84,000 + 175 / + 350 | 84,175 / 84,350 |
| **TGT1** | the nearest 5m swing high between 1R and 2R, say | **84,280** (R:R 1.6) |
| TGT1 if none in the band | 1.5R | 84,262.5 |
| **TGT2** | the next 1H / 4H swing at least 0.5 ATR past TGT1 | e.g. 84,600 |
| TGT3 | the day's expected-move edge, if past TGT2 | e.g. 84,950 |

Gates: stop 1.75 ATR (in 0.3-2.5) ✓, R:R 1.6 ✓, Plan valid ✓ (price 84,000 is
under TGT1, the stop below the fill) -- **TRADE**. Then: filled when price
trades at or under 84,000 within an hour; out at 83,825 (-1R, -175 points) if
the stop comes first, or at 84,280 (+1.6R, +280 points) if TGT1 does, or
closed at the price after 4 hours. After TGT1, the runner's stop is 84,000.

**With the chain**, the same candle is a TRADE only if 4H, 1H, 30m and 15m
are not down, the last 3m candle closed up, the live price is at or under
84,025 (the zone's top + 0.3 ATR), and 1H and 4H are not both down.

---

## All 81

Entry: *close* -- at the signal candle's close; *level* -- at a level price
must return to. SL: the structural level, + 0.25 ATR. Both ways use the same
trigger, SL and targets; only the timeframe, the chain checks and the clocks
differ.

| # | Method | Trigger (what it waits for) | Entry | SL (+0.25 ATR) | TGT1 / TGT2 |
|---|---|---|---|---|---|
| 1 | Breakout | a close through the 20-bar range, RVOL 1.5, closing near its extreme | close | breakout candle's far end | swing / 1H-4H swing |
| 2 | Breakout + retest | a breakout, then a pullback to the level that holds | level | retest extreme | swing / 1H-4H swing |
| 3 | Liquidity sweep | stops taken past a swing, a close back, then the MSS | level | sweep extreme | nearest / 1H-4H swing |
| 4 | FVG retest | back into a gap left by displacement, and a reaction | level | displacement origin | swing / next |
| 5 | Order-block retest | back into the last opposite candle before a break | level | block's far edge | swing / 1H-4H swing |
| 6 | BOS | a displacement close through a swing, with the trend | level | last HL / LH | swing / 1H-4H swing |
| 7 | MSS / CHoCH | the trend turns: a sweep, then a close through the last swing | level | post-sweep extreme | nearest / 1H-4H swing |
| 8 | Momentum | a 1.5 ATR candle, RVOL 1.5, follow-through -- no chase when extended | close | momentum candle's far end | nearest / next |
| 9 | Pullback | a trend back to its 20 EMA, then resuming | close | pullback extreme | swing / 1H-4H swing |
| 10 | VWAP mean reversion | 2σ from VWAP, turning, delta improving -- off on trend days | close | 2σ reversal extreme | VWAP / VWAP ±1σ |
| 11 | Order flow | at a level: absorption, delta flip, CVD turn, micro BOS | level | absorption extreme | book wall / book wall |
| 12 | Options / derivatives | an OI wall that holds, with structure, flow and big-move risk | close | OI wall / rejection extreme | OI wall / OI wall (TGT3 max pain) |
| 13 | Compression break | a tight hour, a close out of it on volume, then follow-through | close | box's far side | nearest / next (box projection) |
| 14 | Failed breakout (trap) | a 20-bar break with no follow-through, closed back inside | close | trap extreme | range middle / range edge |
| 15 | Opening-range breakout | a session's first 30 minutes, then the first close out of it on volume | close | range middle | nearest / next (OR projection) |
| 16 | Prev-day H/L rejection | the previous day's high or low swept, then a turn back inside | close | sweep extreme | nearest / 1H-4H swing |
| 17 | Prev-day break & hold | previous day's high (low) broken, held, retested, rejected its way | close | retest extreme | nearest / 1H-4H swing |
| 18 | Prev-day range expansion | past yesterday's range: a new extreme on volume, or one that turns | close | extreme bar's far end | nearest / 1H-4H swing |
| 19 | VWAP reclaim / loss | from the other side, a close back over the day's VWAP, retest, hold | close | VWAP retest extreme | nearest / next |
| 20 | Anchored VWAP (week) | back to the week's VWAP from the trend's side, turning away | close | touch extreme | nearest / next |
| 21 | Value-area break | a close out of the previous day's value area on volume | close | back inside value area | nearest / next |
| 22 | POC reclaim / loss | from the other side of the previous day's POC, a close over it that holds | close | hold extreme | nearest / next |
| 23 | CVD divergence | a lower low (higher high) the tape's CVD does not make, then a turn | close | divergent swing | nearest / next |
| 24 | Delta divergence | a new 20-bar extreme on weak delta, then a turn back | close | weak-delta extreme | nearest / next |
| 25 | Exhaustion reversal | a 2-ATR bar on a delta climax, no progress, a turn against it | close | climax bar's extreme | nearest / next |
| 26 | Equal H/L sweep | two swings within 0.15 ATR, traded through, closed back | close | sweep extreme | nearest / 1H-4H swing |
| 27 | Session H/L sweep | the previous session's high or low swept, then rejected | close | sweep extreme | nearest / next |
| 28 | Funding + price divergence | funding stretched one way, a new extreme that way, then a turn | close | new extreme | nearest / next |
| 29 | OI-confirmed breakout | a 20-bar break with open interest building | close | break bar's far end | nearest / 1H-4H swing |
| 30 | OI flush reversal | open interest falling 1%+ after a 2-ATR move, then a turn back | close | turn extreme | nearest / next |
| 31 | Expected-move edge | at the day's expected-move boundary, exhausted, turning back | close | edge touch extreme | own / next |
| 32 | Volatility regime transition | a quiet stretch, then range expanding into a 20-bar break | close | break bar's far end | nearest / next |
| 33 | Z-score reversion | 2.5 deviations from the 50-bar mean, then a turn back | close | stretch extreme | own / next |
| 34 | Multi-factor regime | every regime reading agreeing, and a 20-bar break | close | break bar's far end | nearest / 1H-4H swing |
| 35 | Mid-range rejection | in a 4-hour range, to the middle from one side, turning back | close | rejection extreme | own / next |
| 36 | Trendline break & retest | the line through the last two swings, closed through, retested, held | close | retest extreme | nearest / 1H-4H swing |
| 37 | Channel breakout | a close beyond the 48-bar regression channel (2 dev) on volume | close | break bar's far end | nearest / next |
| 38 | Engulfing + structure | an engulfing candle that also closes through the last swing | close | engulfing extreme | nearest / 1H-4H swing |
| 39 | NR7 / inside-bar break | the narrowest bar of seven, then the next bar breaks out of it | close | narrow bar's far side | nearest / next |
| 40 | Dislocation reversion | a 3-ATR bar, then within six bars a turn back toward its middle | close | turn extreme | own / next |
| 41 | Basis divergence (perp vs index) | the perp 0.08%+ from the index, turning back toward it | close | turn extreme | own / next |
| 42 | Index leads, perp lags | the index moved 0.1%+ in 15 min, the perp under half of it | close | four-bar extreme | nearest / next |
| 43 | Mark-perp divergence | the last trade 0.08%+ from the mark, back toward it | close | turn extreme | own / next |
| 44 | Forced-flow (liquidation proxy) | OI falling while large prints run one way 3:1, and a break that way | close | break bar's far end | nearest / next |
| 45 | OI wall break & retest | a close through the call (put) wall, held, retested, held again | close | retest extreme | nearest / OI wall |
| 46 | Funding flip | funding changed sign within two hours, a break against the payers | close | break bar's far end | nearest / next |
| 47 | IV expansion breakout | front ATM IV up 5%+ in an hour, and a 20-bar break on volume | close | break bar's far end | nearest / next |
| 48 | IV crush reversion | IV 8%+ off a spike, and a 2-deviation stretch turning back | close | stretch extreme | own / next |
| 49 | Options skew divergence | puts bid up while price rose (calls while it fell), and a turn | close | turn extreme | nearest / next |
| 50 | Gamma wall reaction | the top gamma × OI strike touched and rejected, or closed through twice | close | touch extreme | nearest / next |
| 51 | Expiry pin / max pain | in the last two hours, price turning toward max pain | close | turn extreme | own / next |
| 52 | Book imbalance breakout | 30%+ of the top five book levels one side, and a break that way | close | break bar's far end | nearest / next |
| 53 | Microprice imbalance | the size-weighted price leaning a third of the spread, closing that way | close | bar's far end | nearest / next |
| 54 | Liquidity replenishment | a wall touched and still standing (refilled), price turning off it | close | past the wall | nearest / next |
| 55 | Pulled wall (spoof) | a nearby wall pulled as price came near -- the way is open | close | bar's far end | nearest / next |
| 56 | Big-print follow-through | the bar's large-print net 3× the usual, closed past the bar before | close | print bar's far end | nearest / next |
| 57 | Aggression spike | three bars at 3× the volume, one-sided, through the 20-bar extreme | close | spike's far end | nearest / next |
| 58 | CVD regime shift | the tape's CVD turns, and price closes the new way through six bars | close | six-bar extreme | nearest / next |
| 59 | Footprint stack: continuation | 3+ $10 levels bought (sold) 3× in a bar that closed that way | close | stack's far side | nearest / next |
| 60 | Footprint stack: reversal | a bought (sold) stack at the bar's top that did not hold | close | bar's extreme | nearest / next |
| 61 | Naked POC reaction | a POC of the last five days, untouched since, touched and rejected | close | touch extreme | nearest / next |
| 62 | Initial balance break | the day's first hour broken by a close on volume, first time today | close | IB middle | nearest / next (IB projection) |
| 63 | IB failed break | the first hour broken by a close, then closed back inside | close | failed-break extreme | IB middle / next |
| 64 | Prev-week H/L sweep | the previous week's high or low swept and rejected | close | sweep extreme | nearest / 1H-4H swing |
| 65 | Prev-month H/L sweep | the previous month's high or low swept, then rejected | close | sweep extreme | nearest / 1H-4H swing |
| 66 | Weekly range expansion | past last week's range on volume, or turning back | close | extreme bar's far end | nearest / 1H-4H swing |
| 67 | Monthly range expansion | past last month's range on volume, or turning back | close | extreme bar's far end | nearest / 1H-4H swing |
| 68 | Prev-week break-reclaim | the previous week's high or low closed through, then back inside | close | failed-break extreme | nearest / 1H-4H swing |
| 69 | Prev-month break-reclaim | the previous month's high or low closed through, then back inside | close | failed-break extreme | nearest / 1H-4H swing |
| 70 | Option volume one-sided | twice the calls of puts traded in the hour (or reverse), a break that way | close | break bar's far end | nearest / next |
| 71 | Call/put OI divergence | puts' OI building while price rose (calls' while it fell), a turn | close | turn extreme | nearest / next |
| 72 | IV vs realised vol | options cheap and a break -- or rich and a stretch turning | close | bar's far end | nearest / next |
| 73 | Term-structure inversion | front IV 5+ points over the next's, and a 20-bar break | close | break bar's far end | nearest / next |
| 74 | Expiry OI migration | the front expiry's OI share falling 5 points in an hour, a 12-bar break | close | break bar's far end | nearest / next |
| 75 | Volatility z-spike | volatility 2 deviations over usual, and a 20-bar break | close | break bar's far end | nearest / next |
| 76 | Volume z-spike | volume 3 deviations over the last 50 bars, closing near the extreme | close | bar's far end | nearest / next |
| 77 | Autocorrelation regime | trending: take the 20-bar break; reverting: fade a 2-dev stretch | close | bar's far end / stretch extreme | nearest / next |
| 78 | Range-efficiency entry | travelling straight, a shallow pullback holding the 20 EMA, resuming | close | pullback extreme | nearest / 1H-4H swing |
| 79 | Trend-efficiency break | a straight run turned to chop, and a close against it | close | six-bar extreme | nearest / 1H-4H swing |
| 80 | BTC–ETH correlation break | BTC's returns decoupled from ETH's, and a 20-bar break (5m) | close | break bar's far end | nearest / next |
| 81 | BTC vs ETH divergence | a new 24-bar BTC high (low) ETH did not make, then BTC turns | close | new extreme | nearest / next |

37 methods need data beyond the perp's candles -- the tape (#10's delta step,
#11, #23-#25, #56-#60), funding, open interest, the mark or the index (#28-#30,
#41-#46), the option board (#12, #31, #47-#51, #70-#74), the book (#52-#55), or
ETH (#80, #81); on a quiet or unrecorded feed they WAIT rather than guess.

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
- **37 of the 81 need live data** and can only be judged from the live signal
  history, not a replay of candles (the six-month replay saw none of them fire).
