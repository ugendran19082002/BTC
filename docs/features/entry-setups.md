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

The owner's reference formulas, and the audit that aligned the engine with
them, are in [entry-methods-reference.md](entry-methods-reference.md).

| # | Method | Group | Its chain | Entry zone | Stop (before the buffer) |
|---|---|---|---|---|---|
| 1 | Breakout | breakout | close past the 20-bar high/low · RVOL ≥ 1.5 · close location ≥ 0.70 (≤ 0.30 short) | just under the close | the breakout candle's far end |
| 2 | Breakout + retest | pullback | broke the 20-bar range · no close back through since · the retest bar touched the level and closed beyond it · rejected it | at the level | the retest's extreme |
| 3 | Liquidity sweep | reversal | swept an untouched swing by 0.1 ATR · closed back · MSS through the last lower high | a limit at the MSS level | past the sweep |
| 4 | FVG retest | pullback | a gap left by displacement its way · price back in (last 3 bars) · closed up out of it | the gap | past the displacement's origin |
| 5 | Order-block retest | pullback | an OB within 5 bars of a structure-breaking displacement · entered (last 3 bars) · closed back out of it | the block | past the block |
| 6 | BOS | breakout | close through the swing · by displacement · trend aligned | a limit at the broken level | the last HL / LH |
| 7 | MSS / CHoCH | reversal | structure the other way · liquidity swept first · CHoCH · displacement · retest | at the CHoCH level | past the extreme since the sweep |
| 8 | Momentum | breakout | a 1.5 ATR body · RVOL ≥ 1.5 · close location ≥ 0.75 · the next bar closes further; **no chase** if it opened > 3 ATR from the 20 EMA | just under the close | the bar's far end |
| 9 | Pullback | pullback | trend (HH/HL over the EMAs) · back to the 20 EMA · closed back over it · micro BOS | just under the close | the pullback's extreme |
| 10 | VWAP / mean reversion | reversal | 2σ from the day's VWAP at the last 3 bars' extreme · reversal candle · delta improving · returning; **off on a trend day** (efficiency > 0.6); TP1 is VWAP | just under the close | the extreme |
| 11 | Order flow | flow | at support/resistance (swing or book wall) · absorption · delta flipped · CVD turned · 1m micro BOS | at the level | the level or the held extreme |
| 12 | Options / derivatives | flow | at the put (call) OI wall · the wall held · rejected · structure not against · big-move risk compatible · the tape its way; TP to max pain when it is that way | just under the close | past the wall |

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
   | R:R 1.8 after fees | reward to TP1 net of the fees in and out at TP1, over the risk plus the fees in and out at the stop, is under 1.8 |
   | Higher timeframes (with the chain) | 1H **and** 4H are both against it |
   | Big-move risk | the desk's big-move reading is high or sudden and points the other way |
   | Expected move | the day has already moved 80% of the expected daily move in this direction |
   | Settlement | the 17:30 IST settlement is under 15 minutes away |
   | The method's own | e.g. momentum already extended, mean reversion on a trend day |

   Every read with a setup carries the whole list -- each gate's rule, what was
   read, and ✓ passed / ✗ refused / – not read (no option board, no spread) or
   not part of this mode (HTF without the chain). "Not read" refuses nothing
   and is never shown as passed.

   **Switching a gate off.** The *Hard gates* button in the entry section's
   header turns any gate but **Data fresh** (locked on) off and on again. An
   off gate is still read and shown -- "off · would refuse" -- but no longer
   makes a read NO TRADE. The switches are stored (`entry_gates`, every change
   in `entry_gate_changes`); each paper-logged setup carries the gates that
   were off (`entry_setups.gates_off`), and the record counts only setups
   taken with every gate on -- the others are counted apart (`gatesOff`), so
   turning R:R off can never quietly change what the record says the rules
   did. `GET /api/entry/gates`, `POST /api/entry/gates/:key {enabled}`.

3. **A step not yet there** -> WAIT, naming it ("waiting for 3m: confirmation").
4. **Everything holds** -> TRADE, and only then an entry, stop and targets.

**The entry zone and where it fills.** A zone is at most 0.5 ATR wide, kept
at the edge price reaches first -- the top for a long, the bottom for a short
-- and that edge is where the trade fills: risk, R:R, the stop band, the card
and the chart are all measured from it (not the middle, which made a wide
zone look cheaper than it was). An FVG enters from its near edge to its middle
(consequent encroachment), an order block from its near edge to its 50% line;
until 30 Sep 2026 both used the whole gap or candle (up to 8 ATR). The FVG's
stop is just past the gap's far edge, where it is invalidated.

**Targets come from liquidity, not a fixed number:** TP1 is the nearest level
past the entry -- a swing on this timeframe, 1H or 4H, a resting wall in the
perpetual's book, the option OI wall that way, or the method's own (VWAP, max
pain); TP2 the next that is at least 0.5 ATR past TP1 (a level 29 points on
is not a second target; none far enough, no TP2 -- never an invented one); TP3
the expected-move boundary, 0.5 ATR past TP2 likewise. Only when there is no level
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

## Live price and latency

The signals are read on **closed** candles, on purpose -- a signal never
appears and vanishes inside a candle. Everything around them is live:

| Part | Source | Latency |
|---|---|---|
| Chart price, forming candle | the perpetual's tape, `/api/stream` `ltp` | ~0.1 s |
| The 1m execution step ("price at the entry") | the tape's last trade while ≤ 15 s old, else the last closed 1m close | the tape |
| A TRADE card's live strip: LTP, IN THE ENTRY ZONE / above / under / PAST THE STOP / AT TP1, points to entry, SL, TP1 | the stream's `ltp` | ~0.1 s, every tick |
| The board (signals) | polled every 5 s, the server holding a read 3 s (~50 ms to compute) | ≤ ~8 s after the candle closes |
| Journal, paper log, Telegram | the recorder, 3 s after every 1m close | seconds |

**Fills** stay exact and conservative: a resting limit fills at the zone's
near edge, or at the open when price gapped through it; the exit is TP1
exactly, or the stop (the open, if gapped past it); a candle touching both is
the stop. Fees come off both ways.

## The signal journal and the paper log

Once a minute the server reads **every** way the screen can show -- the
chain's twelve, and the twelve without it on each of 1m, 3m, 5m, 15m, 30m, 1H
and 4H (96 reads, ~30 ms) -- so a signal is kept whichever chip was on screen,
or with no screen open at all:

- **Signal journal** (`entry_signals`, `entry-005-signals`): every WAIT and
  TRADE, one row per setup per state (a WAIT that becomes a TRADE is two), with
  when it was first and last seen, its score, reason, levels and any gates
  switched off. Kept a year. `GET /api/entry/signals?mode=&tf=&state=&limit=`.
- **Paper log**: each new TRADE, on every timeframe, graded as below. The
  without-timeframe panel shows the record for its chosen timeframe; the
  with-vs-without comparison stays at 5m, like for like.
- **Telegram**: the chain always (its entry is 5m); without it, the
  timeframes the owner picks under its switch (5m until others are chosen).
  Every attempt is written to `entry_alert_log` -- sent, or failed and why
  (Telegram refused it, the network, not set up) -- and the switch shows the
  last one: "last: 20:00 · #2 SELL 5m · sent ✓".

Table `entry_setups` (migration `entry-001-setups`):

- A TRADE is written **once**: keyed by method, mode, timeframe, direction and
  the bar its trigger closed on, however long it stays on the board.
- It is graded on the closed 1m candles: **filled** when price trades into the
  entry zone (at the zone's near edge, or the open if it gapped past it);
  **expired** if not filled within 12 entry bars of when the setup was first
  on the board (graded from the next whole minute), or if price opens past the
  stop first; then **stop**, **TP1** or **timeout** after 48 entry bars. A bar
  that touches both the stop and TP1 is the stop, and in the fill bar only the
  stop counts -- a candle cannot say which came first, and the log does not
  guess in the setup's favour. A gap through the stop exits at the open.
- `r_net` is R after the taker fee both ways. The whole position exits at TP1;
  TP2 and TP3 are drawn, not graded.

`GET /api/entry/record` gives each method's setups, trades, wins, expired,
average and total R, profit factor, max drawdown and average win and loss, with
the chain and without it; each way's total over all twelve; and the latest 50
setups. `GET /api/entry/board` also carries each timeframe's trend and swings
(`timeframes`).

## The screen

On the **desk** tab, under its header -- the desk has no other chart since
30 Sep 2026 -- laid out as the owner's reference
(30 Sep 2026): first an **Entry methods** table -- the one place the twelve
names are written, by number (1 Breakout, 2 Breakout + retest, ...), with each
method's group, what it looks for, and its signal on both sides; choosing a name
chooses that method in both panels -- then the two ways **side by side** --
*12 methods · without timeframe* and *12 methods + timeframe* -- stacked on a
phone, where a method is its **number only**. Each panel has:

- **The desk's price chart** ([price-chart.md](price-chart.md)) -- candles,
  structure, liquidity, order flow, option strikes, its readout and Layers
  menu -- on that panel's timeframe: without timeframe, the 1m-4H chips set
  what its reads use and the chart follows; with timeframe, the chips only
  change what the chart shows (the reads stay at 5m). The chart decides no
  entry of its own: it draws the panel's chosen TRADE -- the entry zone as a
  box from its trigger candle, SL and TP1-TP3 as lines to the right edge.
  Both charts share one set of reads (`entry/feed.ts`).
- **The 12 methods** as a table: the method's number (coloured by group), the
  signal -- **BUY** / **SELL** (a TRADE), **WAIT**, **NO** -- the quality score
  and a one-line why; with timeframe, a tick per timeframe (✓ passed, ✗ failed,
  ? not read, · not part of it). Hover a number for the name and its paper
  record. Until one is chosen, a panel shows its TRADE, else its WAIT, else its
  most-formed refusal.
- **Auto-select signals** (header switch, on by default, per browser): a *new*
  TRADE -- one not seen before -- chooses itself in its panel, the strongest
  first, and its row is marked **AUTO**. Only new ones: a signal that stays on
  the board does not pull the panel back from a row picked by hand. The chosen
  row, in both panels and the methods table, is tinted with a blue edge.
- **Telegram** (each panel's header, *Telegram on / off*, off by default):
  the server sends a TRADE once, when the paper log first writes it -- so it
  works with no screen open, and a setup that stays on the board is not sent
  again. The message comes in sections, every distance from the fill: the
  signal (BUY / SELL, method, way and timeframe, time in IST, the LTP); 📍
  ENTRY (the zone, and the fill edge); 🛑 STOP LOSS (points, %, −1R); 🎯
  TARGETS (TP1-3, each in points and R); then R:R after fees, quality, the
  method's own steps as the why, any gate switched off that let it through,
  and "no order placed". *test* sends a made-up signal in that format, marked
  TEST. Stored in `entry_alerts` (every change in
  `entry_alert_changes`); `GET /api/entry/alerts`,
  `POST /api/entry/alerts/:mode {enabled}`, `POST /api/entry/alerts/test`. With
  no `TG_TOKEN` / `TG_CHAT_ID` on the server the switch says "not set up".
- **Selected setup**: LONG / SHORT SETUP (or WAIT / NO TRADE with the reason),
  method, timeframe, quality, entry, stop, each target with its R multiple, risk
  and reward in points and percent, and R:R after fees -- all from the fill.
  A TRADE that stands only because a gate is switched off carries a warning:
  which gates, their values, and that with every gate on it is NO TRADE.
- **On the chart** the entry is blue -- a box for the zone and a solid ENTRY
  line where it fills -- apart from the red stop and the green targets; every
  line says its distance in R and points ("TP2 84,259 · +0.3R · 132 pts").
- **Key reasons**: every step of its chain, passed, failed or not read.
- **Hard gates** (beside the Entry methods table, a quarter of its row; under
  it below 1280 px): the chosen method's checklist, *Without TF* or *With TF*
  -- each gate's rule, what was read, ✓ / ✗ / –, and "off" for a gate switched
  off. The table itself carries the verdicts in two columns, *Gates · without*
  and *Gates · with*: "✓ 6/6" (of those read), or the gate that refuses; hover
  for the list.
- **Paper record**: that way's trades, win rate, profit factor, net R and max
  drawdown, over all twelve, after fees -- every gate on. With nothing closed
  it says what is happening ("2 setups working -- figures appear as they
  close"). Setups taken with a gate switched off are shown under it in an
  amber, dashed line -- "Including 12 setups taken with a gate off: 13 trades
  · 38% won · PF 0.70 · −2.4R. Not the rules' record" -- never mixed in.

**Timeframe analysis** is a card of its own under the **Big move catch**
(moved there from the with-timeframe panel on 30 Sep 2026): each of 4H-1m,
its trend and what its swings did (HH / HL, LH / LL, range), its job in the
chain, and a one-line trend strip. It is the entry board's own reading (the
entry section hands it up), so it costs no second request.

Underneath, **Without vs with timeframe**: the two records compared metric by
metric (setups, trades, win rate, average win and loss, profit factor, net R,
max drawdown) -- the reference's historical comparison, from the real log only
-- with a switch, *Every gate on* / *Incl. gates off (n)*, that says which it
shows. (`GET /api/entry/record` gives `totals` and `totalsAll`.)

Then the **Signal history**: every signal the server kept (the journal),
newest first, every 15 s -- time (IST), method, way and timeframe, BUY / SELL
or WAIT, how long it stood, entry, SL, TP1, R:R, quality, "gates off" -- and
for a TRADE what became of it: waiting for price, in the trade @ fill, TP1 ✓
+R, stop ✗ −R, timed out, expired never filled. Filters (both / without /
with, all / TRADE / WAIT, timeframe, today / all days) are remembered; on a
phone each signal is a card.
A **12 charts** switch shows the twelve of one way as twelve small price charts
(no readout or toolbar), each with its own TRADE, and **Setups on chart** turns
every drawn level off (the plain charts).

Until 30 Sep 2026 the desk also had a full-width main chart above this
section, with an entry logic of its own (the SMC engine's setup and the 1H
trend plan), and the chosen TRADE was drawn there too. At the owner's request
the chart lost its own logic, its main-chart place went, and it now lives in
the two panels -- one entry logic on the desk, this one.

Three things differ from the reference on purpose:

- **"Quality 72/100", not "Confidence 72%"** -- nothing measures a chance of
  winning yet, and a score must not read as one.
- **No TAKE TRADE button** -- these setups are paper-logged, never ordered
  ([decision 0013](../decisions/0013-entry-setups-measured-before-trusted.md)),
  and the desk has no order path for a BTC position.
- **No example statistics** -- every figure is the paper log's; until trades
  close it says "no record yet". (The pros-and-cons lists were removed at the
  owner's request.)

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
| [EntrySection.tsx](../../app/web/src/components/desk/entry/EntrySection.tsx), [ModePanel.tsx](../../app/web/src/components/desk/entry/ModePanel.tsx), [EntryGrid.tsx](../../app/web/src/components/desk/entry/EntryGrid.tsx), [parts.tsx](../../app/web/src/components/desk/entry/parts.tsx) | the screen |
| [feed.ts](../../app/web/src/components/desk/entry/feed.ts), [PriceChart.tsx](../../app/web/src/components/desk/PriceChart.tsx), [entry-layer.ts](../../app/web/src/components/desk/chart/entry-layer.ts) | the charts: their shared reads, the chart, the setup drawn on it |
| `test/entry/*.test.ts` | every primitive, detector, gate and grading rule |
