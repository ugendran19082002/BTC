# Entry setups — 12 methods × with / without timeframe

The desk tab's entry section: the twelve entry methods of `TEST.md`, each read
**two ways**, so **24 setups** at once, each ending **TRADE**, **WAIT** or
**NO TRADE**. The server decides every state
([`app/server/src/entry/`](../../app/server/src/entry/)); the screen shows it
([`components/desk/entry/`](../../app/web/src/components/desk/entry/)).

**Display and paper log only.** Nothing here places an order. Every TRADE is
written to a paper log and graded after fees, and each method's own record sits
beside it -- because the desk's research found no directional rule on BTC that
clears fees ([research/findings.md](../research/findings.md)), and none of these
is believed until its log says otherwise ([decision 0013](../decisions/0013-entry-setups-measured-before-trusted.md)).

---

## With the timeframe chain, and without it

| Timeframe | Job (TEST.md) | Weight | What is checked |
|---|---|---:|---|
| 4H | macro context | 5 | trend not against the setup |
| 1H | major structure | 10 | trend not against |
| 30m | regime | 10 | trend not against |
| 15m | setup | 15 | structure not against |
| 5m | **entry** | 30 | the method's own chain (below) |
| 3m | confirmation | 15 | the last 3m candle closed the setup's way |
| 1m | execution | 15 | price at the entry zone, the stop intact |

"Trend" is two readings agreeing -- the EMA stack (close over EMA 20 over
EMA 50) and the swings (higher high and higher low) -- or neutral. The weights
give the **alignment** figure (how much of the chain agrees); they are TEST.md's
starting design, not a measurement.

**Without the timeframe chain** the same method runs on one timeframe alone --
the one chosen on the screen, 5m by default -- with no higher-timeframe check.
Both are paper-logged at 5m, so the record answers the question TEST.md asks:
does the chain add anything after fees?

Delta does not serve 3m candles; they are folded from 1m, the way 12h is folded
from 6h. Only **closed** candles are read: nothing is concluded from a forming
bar, and a swing is only a swing once two bars after it exist.

## The twelve methods

Each method is a chain of its own steps on the entry timeframe. A step the
data cannot answer (the tape was not recorded, no option board) is **not read**
and never counts as confirmed.

| # | Method | Group | Its chain | Entry zone | Stop (before the buffer) |
|---|---|---|---|---|---|
| 1 | Breakout | breakout | close past the 20-bar high/low · volume ≥ 1.3× median · strong close | just under the close | the breakout candle's far end |
| 2 | Breakout + retest | pullback | broke the 20-bar range · came back to the level · no close back through · rejected it | at the level | the retest's extreme |
| 3 | Liquidity sweep | reversal | swept a swing low/high and closed back · MSS through the swing before it · displacement · retest holds | at the MSS level | past the sweep |
| 4 | FVG retest | pullback | a gap left by displacement · structure not against · price back in · reaction out | the gap | past the displacement's origin |
| 5 | Order-block retest | pullback | an OB behind a structure break · price back in · closed back out of it | the block | past the block |
| 6 | BOS | breakout | trend with it · close through the swing · by displacement · retest | at the broken level | the last HL / LH |
| 7 | MSS / CHoCH | reversal | trend the other way · liquidity swept first · CHoCH · displacement · retest | at the CHoCH level | past the extreme since the sweep |
| 8 | Momentum | breakout | a 1.5 ATR body · volume ≥ 1.8× · closed near its extreme; **not chased** if it opened > 3 ATR from the 20 EMA | just under the close | the bar's far end |
| 9 | Pullback | pullback | trend (HH/HL over the EMAs) · back to the 20 EMA · resumed | just under the close | the pullback's extreme |
| 10 | VWAP / mean reversion | reversal | 2σ from the day's VWAP · exhaustion (volume or wick) · reversal candle; **off on a trend day** (efficiency > 0.6); TP1 is VWAP | just under the close | the extreme |
| 11 | Order flow | flow | at support/resistance (swing or book wall) · delta against it · it held (absorption) · delta turned · big prints its way | at the level | the level or the held extreme |
| 12 | Options / derivatives | flow | at the put (call) OI wall · reacted · big-move reading not against; TP to max pain when it is that way | just under the close | past the wall |

Footprint -- volume at each price -- is not recorded yet, so method 11 reads
absorption from delta against price.

## From a chain to a state

1. **Nothing forming** -> NO TRADE, "nothing forming".
2. **Hard gates** -- any one fails -> NO TRADE with its reason, whatever else holds:

   | Gate | Fails when |
   |---|---|
   | Data fresh | the newest 1m candle is over 3 min old (without the chain: the entry candle over one period + 3 min) |
   | Spread | the perpetual's spread is over 0.05% |
   | Stop outside the noise / not too wide | the stop is under 0.3 or over 2.5 ATR away |
   | R:R 1.8 after fees | reward to TP1 over risk, with Delta's 0.05% taker fee both ways, is under 1.8 |
   | Higher timeframes (with the chain) | 1H **and** 4H are both against it |
   | Big-move risk | the desk's big-move reading is high or sudden and points the other way |
   | Expected move | the day has already moved 80% of the expected daily move in this direction |
   | Settlement | the 17:30 IST settlement is under 15 minutes away |
   | The method's own | e.g. momentum already extended, mean reversion on a trend day |

3. **A step not yet there** -> WAIT, naming it ("waiting for 3m: confirmation").
4. **Everything holds** -> TRADE, and only then an entry, stop and targets.

**Targets come from liquidity, not a fixed number:** TP1 is the nearest level
past the entry -- a swing on this timeframe, 1H or 4H, a resting wall in the
perpetual's book, the option OI wall that way, or the method's own (VWAP, max
pain); TP2 the next; TP3 the expected-move boundary. Only when there is no level
at all is TP1 set at 2R -- and after fees that usually fails the R:R gate, which
is the point. **The stop** is the method's structure plus 0.25 ATR.

**The quality score** (0-100): structure 20, liquidity 15, momentum 15, flow 15,
CVD 10, footprint 10, options 10, probability 5. Footprint and a calibrated
probability do not exist yet and score nothing, said on screen. It ranks setup
quality; it is **not** a chance of winning and is never shown as one.

### What it says today

On live data on 30 Sep 2026 every one of the 24 was NO TRADE -- mostly "R:R
after fees, no room" or "stop too wide". On 5m, Delta's taker fees (≈ 84 points
round trip at $84k) are larger than most of the structure; this is the same
finding as the SMC and momentum studies, and the gates are meant to say it
rather than hide it.

## The paper log

Table `entry_setups` (migration `entry-001-setups`), written by a recorder in
`index.ts` once a minute, both modes at 5m:

- A TRADE is written **once**: keyed by method, mode, timeframe, direction and
  the bar its trigger closed on, however long it stays on the board.
- It is graded on the closed 1m candles: **filled** when price trades into the
  entry zone (at the zone's near edge, or the open if it gapped past it);
  **expired** if not filled within 12 entry bars, or if price opens past the
  stop first; then **stop**, **TP1** or **timeout** after 48 entry bars. A bar
  that touches both the stop and TP1 is the stop, and in the fill bar only the
  stop counts -- a candle cannot say which came first, and the log does not
  guess in the setup's favour. A gap through the stop exits at the open.
- `r_net` is R after the taker fee both ways. The whole position exits at TP1;
  TP2 and TP3 are drawn, not graded.

`GET /api/entry/record` gives each method's setups, trades, wins, expired,
average and total R, with the chain and without it, and the latest 50 setups.

## The screen

On the **desk** tab, under the price chart:

- **Board + chart** (default): two tables -- *With timeframe* (a tick per
  timeframe: ✓ passed, ✗ failed, ? not read, · not part of it) and *Without
  timeframe* -- each row with its state, R:R, score and paper record. Choosing
  a row shows its chain, gates, levels and score; a TRADE is drawn on the chart
  above: the entry zone as a box from its trigger bar, SL, TP1, TP2, TP3.
- **12 charts**: the twelve methods of one mode as twelve small charts, each with
  its own levels; built only while shown.
- **Setups on chart**: off shows the plain price chart.
- **Without timeframe on**: the timeframe the single-timeframe reads use
  (1m-4H). The paper log records them at 5m.

## Code

| Where | What |
|---|---|
| [entry/types.ts](../../app/server/src/entry/types.ts) | the shapes, the chain and its weights |
| [entry/prims.ts](../../app/server/src/entry/prims.ts) | swings, sweeps, breaks, FVGs, order blocks, displacement, VWAP, trend |
| [entry/methods.ts](../../app/server/src/entry/methods.ts) | the twelve detectors |
| [entry/engine.ts](../../app/server/src/entry/engine.ts) | gates, targets, the chain, score, state; the 24 reads |
| [entry/read.ts](../../app/server/src/entry/read.ts) | the market context, best-effort |
| [entry/paper.ts](../../app/server/src/entry/paper.ts) | the log, its grading and the record |
| [entry.routes.ts](../../app/server/src/http/routes/entry.routes.ts) | `GET /api/entry/board`, `GET /api/entry/record` |
| [EntrySection.tsx](../../app/web/src/components/desk/entry/EntrySection.tsx), [EntryGrid.tsx](../../app/web/src/components/desk/entry/EntryGrid.tsx), [entry-layer.ts](../../app/web/src/components/desk/chart/entry-layer.ts) | the screen |
| `test/entry/*.test.ts` | every primitive, detector, gate and grading rule |
