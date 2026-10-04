# Entry setups — 12 methods × with / without timeframe

The desk tab's entry section: the twelve entry methods of `TEST.md`, each read
**two ways**, so **24 setups** at once, each ending **TRADE**, **WAIT** or
**NO TRADE**. The server decides every state
([`app/server/src/entry/`](../../app/server/src/entry/)); the screen shows it
([`components/desk/entry/`](../../app/web/src/components/desk/entry/)).

**Display and paper log only.** Nothing here places an order. Every TRADE is
written to a paper log and graded on the live tape, and each method's own record sits
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
does the chain add anything?

Delta does not serve 3m candles; they are folded from 1m, the way 12h is folded
from 6h. Only **closed** candles are read: nothing is concluded from a forming
bar, and a swing is only a swing once two bars after it exist.

## The twelve methods (TEST.md's; 62 more since 1 Oct 2026, below)

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
   | Perp at mark | the perpetual's last trade is over 0.15% from its mark price -- a wick through a thin book, not a level (not read without a fresh trade and mark) |
   | Stop outside the noise / not too wide | the stop is under 0.3 or over 2.5 ATR away |
   | R:R 1 | the points from the fill to TP1 are fewer than the points from the fill to the stop -- TGT1 must be at least 1R, with no maximum (owner, 1 Oct 2026; TEST.md had 1.8 after fees -- the fee term is gone too) |
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
(consequent encroachment), an order block from its near edge to its 50% line.
A zone is kept wholly on the safe side of its stop, at least 0.1 ATR from it
(`zoneOf`): until 1 Oct 2026 a retest zone could reach past its own stop
(three live 1m setups); a zone left as a sliver has a tiny risk, which the
stop band gate refuses.

**SL and targets, per method** (the owner's SL/TP tables, 1 Oct 2026). The
stop is the method's own structure plus 0.25 ATR; the targets come from
liquidity, in the method's own order:

| # | Method | SL (+ 0.25 ATR) | TP1 looks first at | TP2 |
|---|---|---|---|---|
| 1 | Breakout | the breakout candle's far end | a continuation swing | next 1H/4H liquidity |
| 2 | Breakout + retest | the retest extreme | a continuation swing | next 1H/4H liquidity |
| 3 | Liquidity sweep | the sweep extreme | the nearest opposing liquidity | next 1H/4H swing |
| 4 | FVG retest | the displacement origin | the previous swing | the next level |
| 5 | Order-block retest | the block's far edge | the reaction swing | next 1H/4H liquidity |
| 6 | BOS | the last higher low / lower high | the first post-BOS swing | next 1H/4H liquidity |
| 7 | MSS / CHoCH | the post-sweep extreme | the first opposing liquidity | next 1H/4H swing |
| 8 | Momentum | the momentum candle's far end | the first continuation level | the next level |
| 9 | Pullback | the pullback extreme | the previous swing | next 1H/4H liquidity |
| 10 | VWAP reversion | the 2σ reversal extreme | **VWAP** | the VWAP band past it (1σ) |
| 11 | Order flow | the absorption / held-level extreme | a book wall, then a swing | the next book wall or swing |
| 12 | Options | the OI wall / rejection extreme | the OI wall | the next OI wall |

TP3 is the expected-move edge -- for options, max pain when it lies past TP2.

**TP1 is the nearest *valid* target, not merely the nearest** (`pickTargets`).
Of the levels past the zone -- swings on this timeframe, 1H and 4H, walls in
the perpetual's book, the OI wall, the method's own -- a swing price has
already traded through is **consumed** and dropped; of the rest, TP1 is the
first in the method's own order between **1R and 2R** from the fill
(`MIN_RR`, the same number the R:R gate uses, and `MAX_TP1_R`), else the first
of any kind in that band; with nothing real in the band, TGT1 is **1.5R** and
says so ("1.5R -- no level between 1R and 2R (the next, 4h swing high 85,200,
is 6.0R)"), and the far level becomes TGT2. A nearer level that pays less is skipped, and the reason
says so: "1h swing high 84,200 (1 nearer under 1R skipped)". The owner's
example -- a long filled at 84,000, SL 83,800: 84,150 (0.75R) is skipped,
84,200 (1R) is TP1, 84,400, 84,800, 85,200 are further targets. Only when no
level pays 1R is TP1 the nearest of its kind, and the R:R gate then refuses
the read -- never a made-up far target. VWAP reversion keeps VWAP whatever it
pays: reverting to it is the method. TP2 is the next of the method's pool at
least 0.5 ATR past TP1 (none in the pool: the next real level of any kind;
none at all: no TP2); TP3 0.5 ATR past TP2 likewise. With no level past the
zone, TP1 is 2R and says so. Every plan carries why each level is where it is
(`plan.why`), shown on the card, in the alert and in the history.

**What the replay says** (5m, Jan-Aug 2026, `scripts/entry-study.ts`, R in
points, no fees; methods 11-12 cannot be replayed from candles):

| TP1 rule | TRADEs | won | avg R | PF |
|---|---:|---:|---:|---:|
| the nearest level (until 1 Oct) | 1,322 | 23% | −0.21R | 0.73 |
| nearest valid, ≥ 1.8R | 14,944 | 25% | −0.10R | 0.87 |
| nearest valid, ≥ 1R | 15,064 | 31% | −0.10R | 0.86 |
| between 1R and 2R, else 1.5R (now) | 15,064 | 37% | −0.08R | 0.87 |

The valid-target rule halves the loss per trade; none of the three makes money
on 5m before fees, and no method is believed on this -- only MSS / CHoCH is
above zero (+0.37R with the chain, 18 trades, t 1.1: not distinguishable from
nothing). The live paper log is what decides.

**The quality score** (0-100): structure 20, liquidity 15, momentum 15, flow 15,
CVD 10, footprint 10, options 10, probability 5. Footprint and a calibrated
probability do not exist yet and score nothing, said on screen. It ranks setup
quality; it is **not** a chance of winning and is never shown as one.

### What it says today

On live data on 30 Sep 2026 every one of the 24 was NO TRADE -- mostly "R:R
after fees, no room" or "stop too wide". The owner then switched six gates off
live, and the log filled with setups whose TP1 was a third of the risk away
(1 Oct audit: average TP1 41 points against 130 of risk on 5m) -- wins too
small to pay for the stops. The nearest-valid TP1 rule above is the answer to
that. The fee term was removed from R:R and R at the owner's request; Delta's
taker fees (≈ 84 points round trip at $84k) are real, if no longer counted.

## Live price and latency

The signals are read on **closed** candles, on purpose -- a signal never
appears and vanishes inside a candle. Everything around them is live:

| Part | Source | Latency |
|---|---|---|
| Chart price, forming candle | the perpetual's tape, `/api/stream` `ltp` | ~0.1 s |
| The 1m execution step ("price at the entry") | the tape's last trade while ≤ 15 s old, else the last closed 1m close | the tape |
| A TRADE card's live strip: LTP, IN THE ENTRY ZONE / above / under / PAST THE STOP / AT TP1, points to entry, SL, TP1 | the stream's `ltp` | ~0.1 s, every tick |
| The board (signals) | polled every 5 s, the server holding a read 3 s (~50 ms to compute) | ≤ ~8 s after the candle closes |
| Journal, Telegram | the recorder, 3 s after every 1m close | seconds |
| Paper-log fills, stops, targets | the perpetual's own trades, every second (`entry/live-grade.ts`); 1m candles only when the tape is down | ~1 s |
| History | polled every 5 s | ≤ 5 s |

**Whole candles only.** A candle counts as closed only if it closed before
the data was *asked for* (less 2 s for the venue to settle), not merely before
now: the candle cache answers stale while it refreshes, and at 12:05:03 it
could hand back data asked for at 12:04:45, whose 12:04 minute held only its
first 45 seconds. Until 1 Oct 2026 that part-minute was graded and signalled
on and never read again -- stop and TP1 touches in its last seconds were
missed and turned up a minute later as "gaps" (19 of 25 live 3m stops). The
engine now asks for data fetched after the minute turned (`venueSeriesSince`,
`wholeUntil`).

**Fills** stay exact and conservative: a resting limit fills at the zone's
near edge, or at the open when price opened inside the zone (better -- the
history says by how much); TP1 is a limit, exactly the level; the stop is a
stop-market, the level or the open when a minute opened past it (a gap -- the
history says how many points past); a candle touching both is the stop. All of
it on the **perpetual** (BTCUSD): the index runs some 40 points apart, so a
target can look passed on the index (the tab title) and not be on the
perpetual. Checked against Delta's own 1m candles on 1 Oct 2026: the live
fills, stops and TP1s were exact.

## The signal journal and the paper log

Once a minute the server reads **every** way the screen can show -- the
chain's twelve, and the twelve without it on each of 3m, 5m, 15m, 30m, 1H and
4H (84 reads) -- so a signal is kept whichever chip was on screen, or with no
screen open at all. **1m without the chain is chart-only** (owner, 1 Oct 2026):
no reads, no signal, no alert, no history; `entry-008-signals-no-1m` removed
its journal rows and `entry-008-alerts-no-1m` its alert timeframe (the paper
log keeps its rows as they were). The chain still reads 1m as its execution
step.

- **Signal journal** (`entry_signals`, `entry-005-signals`): every WAIT and
  TRADE, one row per setup per state (a WAIT that becomes a TRADE is two), with
  when it was first and last seen, its score, reason, the whole plan (entry,
  SL, TP1-TP3 and why each is there -- `entry-011-signal-targets`), the LTP
  and index when it appeared, and any gates switched off. Kept a year.
  `GET /api/entry/signals?mode=&tf=&state=&dir=&live=&since=&sort=&asc=&limit=&offset=`
  gives a page, the number matching, and totals over every match;
  `GET /api/entry/signals.csv` (same filters) every matching row for Excel.
- **Clear data** (the history's red button; owner, 1 Oct 2026): a dialog with
  From and To in IST, to the minute (the To minute included), quick ranges
  (last hour, today, yesterday, last 7 days), and a live count of what would
  go before anything does: signals (TRADEs, WAITs), their paper trades, their
  alerts. The clear needs "I understand this cannot be undone" ticked.
  `GET /api/entry/signals/clear?from=&to=` counts; `POST` (same origin, signed
  in) clears, in one transaction under the grading lock, and logs the clear in
  `entry_history_clears` (`entry-020`). Each cleared key is kept two days in
  `entry_cleared`, so a setup still on the board is not written back -- or
  alerted again -- a minute later; a later state of it (a WAIT that turns
  TRADE) is new and kept. Tabs and totals recount at once (the data version
  moves).
- **Paper log**: each new TRADE, on every timeframe, graded as below.
- **Telegram**: the chain always (its entry is 5m); without it, the
  timeframes the owner picks under its switch (5m until others are chosen).
  Every attempt is written to `entry_alert_log` -- sent, or failed and why
  (Telegram refused it, the network, not set up) -- and the switch shows the
  last one: "last: 20:00 · #2 SELL 5m · sent ✓".

Table `entry_setups` (migration `entry-001-setups`):

- A TRADE is written **once**: keyed by method, mode, timeframe, direction and
  the bar its trigger closed on, however long it stays on the board.
- It is graded **live, on the perpetual's own trades** (1 Oct 2026,
  `entry/live-grade.ts`): every second each working setup is moved on by the
  trades printed since, through the same rules as a candle, one price at a
  time -- **filled** when a trade goes through the zone's near edge (a resting
  limit at its own price; one placed into a market already past it at that
  trade), **stop** at the first trade through the stop (slippage and all),
  **TP1** exactly at the level, each written the second it prints. The 1m
  candles are the backstop: they grade only the minutes the tape did not see
  (a stale or reconnected socket), and the two graders never run at once.
  Times graded off the tape show to the second, off a candle as "~06:52".
- A setup ends one of four ways. Filled, it ends at **TP1**, the **stop**, or
  on **time-out** (48 entry bars). Never filled, it is **expired**, with why
  (`expire_why`, `entry-015`): its **window** passed (12 entry bars from when
  it was first on the board), the **stop** broke first (the idea was wrong
  before it was in), or price ran to TP1 without coming back to the zone --
  **target** (the move went without it; the limit is cancelled rather than
  filled late, after the move). An expired setup was never a trade and is not
  counted as one. ("Missed" was its own state for a few hours on 1 Oct 2026;
  at the owner's word it is a reason for expiring, and those rows became
  expired by target.) On a
  candle, a bar touching both the stop and TP1 is the stop, and in the fill bar
  only the stop counts -- a candle cannot say which came first, and the log
  does not guess in the setup's favour.
- `r_net` is R: the points from the fill to the exit over the risk -- no fee
  term since 1 Oct 2026 (`entry-010-r-without-fees` recomputed every closed
  row the same way). The record's trade exits at TP1.
- **TGT1 / TGT2 / TGT3** (`entry-012-setups-targets`): after TP1 a *runner*
  goes on with its stop at the fill (breakeven), watched for TP2 then TP3
  until breakeven, TP3 or the time-out; `tp1_at`, `tp2_at`, `tp3_at` say
  which targets were reached and when (a bar touching breakeven and TP2 is
  breakeven). The record's R stays the TP1 exit; the runner says how far the
  move went.

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
  volume and its readout; its layers were removed on 4 Oct 2026 -- on that
  panel's timeframe: without timeframe, the 3m-4H chips set
  what its reads use and the chart follows, and **1m is chart-only** (the
  chart, and in place of the table a note that 1m gives no signal or alert); with timeframe, the chips only
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
  TARGETS (TP1-3, each in points and R, and why each is there); the stop's
  structure under the SL; then R:R, quality, the method's own steps as the why, any gate switched off that let it through,
  and "no order placed". *test* sends a made-up signal in that format, marked
  TEST. Stored in `entry_alerts` (every change in
  `entry_alert_changes`); `GET /api/entry/alerts`,
  `POST /api/entry/alerts/:mode {enabled}`, `POST /api/entry/alerts/test`. With
  no `TG_TOKEN` / `TG_CHAT_ID` on the server the switch says "not set up".
- **Selected setup**: LONG / SHORT SETUP (or WAIT / NO TRADE with the reason),
  method, timeframe, quality, entry, stop, each target with its R multiple and
  why it is there, risk and reward in points and percent, and R:R -- all from
  the fill. Under the live strip, the **entry clock**: when the trigger bar
  closed, when the server saw it and when the alert went (with the lag, when
  it is one), then a counter -- "Fill window closes in 42:15", "In the trade
  12:03 · time-out in 3:47:57", "Runner, stop at breakeven · TGT2 next" -- to
  the paper log's own windows (the board carries each TRADE's `paper` clock).
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
- (The per-panel **paper record** strip, and the **without vs with timeframe**
  comparison under the panels, were removed at the owner's request on
  1 Oct 2026; the signal history carries the record.)

**Timeframe analysis** is a card of its own under the **Big move catch**
(moved there from the with-timeframe panel on 30 Sep 2026): each of 4H-1m,
its trend and what its swings did (HH / HL, LH / LL, range), its job in the
chain, and a one-line trend strip. It is the entry board's own reading (the
entry section hands it up), so it costs no second request.

Then the **Signal history** (a card of its own): every signal the server
kept, a page at a time (25 / 50 / 100), every 5 s. Tabs: **All**,
**TRADING** (in play now: waiting at its zone, filled, or a runner after
TGT1), **BUY & SELL**, **BUY**, **SELL**, **WAIT**, then how each TRADE ended
-- **TGT HIT**, **SL HIT**, **TIMED OUT**, **EXPIRED** (with why) (`outcome=`
on the API); the SL column says what became of the stop (guards the order,
watching…, ✗ hit and when, → breakeven for the runner, ✓ never hit, not
filled, broken before the fill); one row that scrolls sideways on a phone. Filters,
each named -- **Way**, **Timeframe**, **Range** (today / all days) -- with
*Clear filters* when any is set (remembered; a filter saved before -- 1m, the
old R:R column -- is cleaned, so the list never hides behind a chip that is
not there; nothing yet today offers *Show all days*). Columns, **each sortable
both ways on the server** (so the order holds across pages): signal time (its
trigger bar, and "seen +3 s" when that is latency or "formed 06:55:03" when
the setup sits on an older bar; when the alert went), method, way and
timeframe, signal, LTP · index when it appeared, entry zone, SL, **TGT1**,
**TGT2**, **TGT3** (each: reached ✓ and when, watching…, or ✗ not reached),
**Entry** (the fill, its minute, at the edge or how many points better),
**Exit** (the price, by SL / TGT / time, its minute, at the level or how many
points past it -- a gap; the full sentence on hover), **Result** (R and
points, and a live counter while in play), quality, how long it stood. No R:R
column: the result carries R. Above it, totals over every match -- TRADEs,
TGT1 hits and points, SL hits and points, timed out and points, TGT2 · TGT3
reached, and **net points, which add up**: each trade is rounded to the point
as its row shows it, and net = target − SL ± time-out (no Net R -- it
disagreed with the points while R carried fees). **Excel** downloads every
row the filters match, in this order (CSV with a BOM and CRLF; text Excel
would run as a formula is defused). On a phone each signal is a card.

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

## Every method, on the desk

Since 1 Oct 2026 (owner: "no separate research -- append them like the first
twelve"; "total 81, the 12 included, remove the rest") the desk reads **81
methods -- one per unique idea**: TEST.md's twelve first, then the rest by the
owner's numbers -- 26 on candles, 32 on the desk's live data and 11 regime
ideas, all in `entry/methods.ts` -- read, shown, paper-logged
and alerted alike. A duplicate idea is never a second method: the three
sessions of #16 (opening range) and of #30 (session sweep) are one method
each, watching whichever session is live. The deduplicated list of all 130 ideas
is [research/entry-concepts.md](../research/entry-concepts.md).

- **What they read.** Candles; the tape per minute and its prints of the last
  half hour (the footprint); the book now and its heat by minute; the
  perpetual's mark, index and funding; `perp_snapshots` and `option_snapshots`
  for the last six hours (OI, funding, per-strike IV, gamma, OI and volume --
  `entry/deriv.ts`, read once a minute); ETHUSD 5m candles. Each method says
  nothing when its input is missing. **Liquidations**: Delta publishes no
  feed; #50 reads the footprint a cascade leaves (open interest falling, large
  prints one way) and its name says it is a proxy.
- **The evidence.** The 30 candle methods were replayed on 2024-01..2026-08
  (`scripts/methods-study.ts`, research/METHODS-STUDY.txt) against a bar set
  before the run: none passed. The live-data ones have no history to replay.
  The paper log is their record: `npx tsx scripts/methods-week.ts 7` reads
  every method's week, and every closed trade by the regime it was taken in.
- **The regime** (#19, #89, #90, #118, #119, #123, #126, #127, #115, #128):
  measured on every TRADE and WAIT and kept with it (`regime`, `entry-017`),
  so the record can be sorted by it -- and each is also a method on its own
  trigger, with 38a (multi-factor) firing when they all agree.
- **Numbered 1-81.** The screen, the alerts, the history and its CSV number
  the methods 1, 2, 3 ... 81 -- the twelve as 1-12, the rest in research-number
  order; each method's research number stays as `ref` (the map:
  [research/entry-concepts.md](../research/entry-concepts.md#the-desks-numbers)).
- **In the database.** `entry_methods` (`entry/catalogue.ts`, `entry-019`)
  holds the 81 -- id, number, label, research number, name, group -- written
  from methods.ts on every start; the signals, the paper setups and the alert
  log can only name a method in it (foreign keys). A method the code drops is
  kept, retired and unnumbered, because its rows are history.
- **Nothing else.** The retired per-session ids (`orb-asia` … `session-sweep-ny`)
  are deleted from the signals, the paper setups and the alert log
  (`entry-018-*-retired-methods`).
- **The screen.** The methods table and both panels list every method,
  signals first (TRADE, WAIT, then the rest), with a view -- All, Signals,
  or one group, each counted -- and a body that scrolls under a fixed header.
  The charts view draws the 24 with a signal first. A pass over all of them
  takes ~45 ms a minute.

## Which price is which

The perpetual (BTCUSD) is the price that trades: entry, SL and TP are its
levels, the candles and the live grader are its own. Delta's **mark** price
is the fair-price check (the *Perp at mark* gate); the BTC **index** is
context -- the history keeps it beside the LTP, and the strip under the entry
header names all three, with the basis (perp − index), so one is never read
for another.

## Speed

Measured on a year of data at the live rate (1 Oct 2026: ~130 signals an
hour, 1.1 M rows, 110 k paper rows, 55 k alerts) before changing anything:

| History query | before | after |
|---|---:|---:|
| today, newest first (the default) | 280 ms | 30 ms |
| all days, newest first | 1.8 s | 0.55 s |
| all days, SL HIT | 0.8 s | 0.57 s |
| today, WAIT, 1h | 14 ms | 13 ms |

What did it: each signal's paper row is looked up through its unique index
(a plain join had Postgres hash the whole paper log for a day's 972
signals); the count and the totals are separate queries, the totals over
TRADEs only with their own index (`entry-014`); newest-first walks the time
index and stops at the page. A year sorted by an unindexed column (method,
result) still costs 1-3 s the first time -- once per data change, because:

**An exact cache in the API's memory, not Redis.** History pages are kept
per filter and *data version* (`entry/version.ts`): every write to the entry
tables -- a signal recorded, a setup logged or graded, an alert logged --
moves the version, so a cached answer is never stale, and every poll between
writes is free. The writers run in the API process, so a network cache would
only add a hop and a server to run; Redis earns its place when several
processes share one cache, which this desk does not.

## Code

| Where | What |
|---|---|
| [entry/types.ts](../../app/server/src/entry/types.ts) | the shapes, the chain and its weights |
| [entry/prims.ts](../../app/server/src/entry/prims.ts) | swings, sweeps, breaks, FVGs, order blocks, displacement, VWAP, trend |
| [entry/methods.ts](../../app/server/src/entry/methods.ts) | the twelve detectors |
| [entry/engine.ts](../../app/server/src/entry/engine.ts) | gates, targets, the chain, score, state; the 24 reads |
| [entry/read.ts](../../app/server/src/entry/read.ts) | the market context, best-effort |
| [entry/paper.ts](../../app/server/src/entry/paper.ts) | the log, its grading (fill, exit, runner), the windows (`fillByOf`, `timeoutAtOf`) and the record |
| [entry/signals.ts](../../app/server/src/entry/signals.ts) | the journal, the history's page, totals, sorting and CSV, the board's clocks |
| [entry/alerts.ts](../../app/server/src/entry/alerts.ts) | Telegram switches, the message, the alert log |
| [entry.routes.ts](../../app/server/src/http/routes/entry.routes.ts) | `/api/entry/board`, `record`, `gates`, `alerts`, `signals`, `signals.csv` |
| [SignalHistory.tsx](../../app/web/src/components/desk/entry/SignalHistory.tsx), [TradeClock.tsx](../../app/web/src/components/desk/entry/TradeClock.tsx), [clock.ts](../../app/web/src/components/desk/entry/clock.ts) | the history table, the entry clock, the counters |
| [EntrySection.tsx](../../app/web/src/components/desk/entry/EntrySection.tsx), [ModePanel.tsx](../../app/web/src/components/desk/entry/ModePanel.tsx), [EntryGrid.tsx](../../app/web/src/components/desk/entry/EntryGrid.tsx), [parts.tsx](../../app/web/src/components/desk/entry/parts.tsx) | the screen |
| [feed.ts](../../app/web/src/components/desk/entry/feed.ts), [PriceChart.tsx](../../app/web/src/components/desk/PriceChart.tsx), [entry-layer.ts](../../app/web/src/components/desk/chart/entry-layer.ts) | the charts: their shared reads, the chart, the setup drawn on it |
| `test/entry/*.test.ts` | every primitive, detector, gate and grading rule |
