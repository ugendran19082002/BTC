# The price chart

Built 28–29 Sep 2026; on 30 Sep 2026 it lost its own entry logic and moved
into the entry section. The desk's price chart: BTCUSD candles on any of
1m-4H, with every price-action / SMC concept the engine finds drawn on the
candles themselves, the order flow around them -- the book's resting
liquidity, the volume profile, the aggressive flow and the big trades -- the
option board's biggest strikes, and a corner readout (the HUD) that reads the
candle and how the perpetual is positioned.

**It decides no entry.** Until 30 Sep 2026 the chart ran a setup of its own
(the SMC engine's live setup, its position box, a Trades dialog) and the 1H
trend plan, beside the entry section's twelve methods -- two entry logics on
one screen. The owner wanted one, so the chart's went and the entry section's
stayed: the one setup the chart draws is the one chosen in the entry section
([entry-setups.md](entry-setups.md)), decided on the server. There is no
full-width main chart any more: the entry section's two panels -- *without
timeframe* and *with timeframe* -- each carry this chart, and its twelve-chart
grid a small one.

This document is the chart's logic: what is read and from where, every
detection rule, every layer and how it is drawn, the tables behind them, and
what the research over 32 months of real candles says. §6–§9 describe the
engine's setup machine, which is kept for the research scripts only.

**Nothing on this chart is a signal on its own.** The SMC engine's own record
is negative after fees, and the volume profile, CVD / delta, OI, funding and
top-trader positioning, measured over 2024-26 (the flow on Binance's history),
showed no edge either (§14). The heatmap and big trades on Delta are too new to
measure. They are context: where liquidity, size and positioning are. The
Layers menu says so beside every layer.

---

## 1. The screen

```
Entry methods   1 Breakout · 2 Breakout + retest · … · 12 Options

┌─ 12 methods · without timeframe ─┐  ┌─ 12 methods + timeframe ─────────┐
│ read on 1m 3m [5m] 15m 30m 1h 4h │  │ view 1m 3m [5m] 15m 30m 1h 4h    │
│ ┌─ price chart ────────────────┐ │  │ ┌─ price chart ────────────────┐ │
│ │ HUD: price, context, OHLC,   │ │  │ │ same chart, its own timeframe│ │
│ │ OI, funding, big trades      │ │  │ │                              │ │
│ │ toolbar: LTP, Layers, Zoom   │ │  │ │ the chosen TRADE:            │ │
│ │ candles, SMC, order flow,    │ │  │ │ entry box, SL, TP1–TP3       │ │
│ │ strikes, the chosen TRADE    │ │  │ │                              │ │
│ └──────────────────────────────┘ │  │ └──────────────────────────────┘ │
│ 12 methods · selected setup      │  │ … · timeframe analysis           │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

- **Two charts, one per panel** (side by side; stacked on a phone), each on
  its own timeframe. *Without timeframe*: the chips set the timeframe the
  twelve reads use, and the chart follows. *With timeframe*: the reads stay
  at 5m (the chain's entry timeframe) and the chips only change what the
  chart shows. The 12-charts view is twelve small charts (no HUD, no
  toolbar), one per method.
- **The setup drawn** is the panel's chosen TRADE: its entry zone as a box
  from the candle its trigger closed on, the stop and TP1-TP3 as lines to the
  right edge (`chart/entry-layer.ts`, layer `entry`). A WAIT or NO TRADE draws
  nothing; **Setups on chart** off draws nothing.
- **The HUD** folds to one line (folded by default on a phone): BTCUSD's price
  and the timeframe, the context row (1H regime, 30M bias, 15M structure, 5M,
  1M -- each its last break), the candle under the crosshair, the perp's
  positioning and the volatility regime, the big trades in view, and that
  candle's flow. No setup, no plan, no record.
- **The toolbar**: the LTP chip, Layers (presets, then every layer with its
  research note; remembered per browser), Zoom (pan and zoom are off by
  default so the page scrolls over the chart), full screen.
- **Layering, back to front**: heatmap → sessions / premium-discount / zones →
  volume profile → candles and volume → lines (structure, liquidity, strikes,
  walls), marks, bubbles → labels. The entry setup's box and its labels are
  always the strongest thing drawn.

---

## 2. Files

| File | What it is |
|---|---|
| `app/web/src/lib/smc/engine.ts` | The engine: one closed candle at a time, no lookahead. `DESK_SMC_OPTIONS` is what the desk runs. |
| `app/web/src/lib/smc/types.ts` | Its vocabulary: swings, breaks, zones, pools, sessions, tags, setups, options. |
| `app/web/src/lib/smc/context.ts` | Closed-candle filter, timeframe folding, trend-as-known-at, the context row. |
| `app/web/src/lib/smc/readout.ts` | The engine's setups in words, the live setup (`liveSetup`), the context gate, a record -- used by the research scripts; the chart no longer reads it. |
| `app/web/src/lib/trend/breakout.ts` | The trend plan: 20-candle breakout, 2 ATR stop, 3 ATR chandelier, no target. Pure, no lookahead; the study and the server's paper log run it (off the chart since 30 Sep 2026). |
| `app/server/src/strategy/trend-breakout.ts` | GENERATED copy of `lib/trend/breakout.ts` (`npm run sync:trend`); a test fails if it drifts. |
| `app/server/src/strategy/trend-paper.ts` | The trend plan's paper log: replayed every 5 minutes, live trades apart from replayed, the pre-registered filters. |
| `app/web/src/lib/live-bar.ts` | The forming candle: `withLiveBar` (from the tape), `withLtp` (the spot fallback); each timeframe's length. |
| `app/web/src/components/desk/chart/scene.ts` | Engine state → boxes / lines / marks in bar index and price. Layers, colours, clutter rules. |
| `app/web/src/components/desk/chart/flow-layers.ts` | The order-flow layers as scene items: heatmap and walls, volume profile (nodes, the aggressor split), big trades, delta / CVD, the flow reading, option strikes, the volatility regime. |
| `app/web/src/components/desk/chart/smc-primitive.ts` | Draws the scene on the chart's canvas (a lightweight-charts series primitive); the bubbles' hover hit-test. |
| `app/web/src/components/desk/chart/label-layout.ts` | Label placement by priority; nothing is drawn over anything. |
| `app/web/src/components/desk/chart/ChartHud.tsx` | The corner readout: context, the candle, positioning, big trades, flow. |
| `app/web/src/components/desk/chart/entry-layer.ts` | The entry section's chosen TRADE as scene items: entry box, SL, TP1-TP3. |
| `app/web/src/components/desk/chart/LtpChip.tsx` | The last traded price, tick colour and candle countdown. |
| `app/web/src/components/desk/PriceChart.tsx` | The chart: candles, volume, the delta / CVD pane, the engine (concepts only), the primitive, the HUD, the toolbar, the tooltip, the `entry` setup; sizes `full`, `panel`, `compact`. |
| `app/web/src/components/desk/entry/feed.ts` | What the entry section's charts are drawn from, read once for all of them: the candles of every timeframe (folded where Delta has none), the context row, the flow, the big trades, the heatmap. |
| `app/web/src/components/desk/entry/ModePanel.tsx`, `EntryGrid.tsx` | Where the chart is shown: one per panel, twelve small in the grid. |
| `app/web/src/components/overview/Overview.tsx` | Hands the desk (and so the charts) the option board (strikes, max pain) and the perp's positioning (OI change, funding) it already loads. |
| `app/server/src/market/flow-socket.ts` | The perpetual's and the options' trade socket: every print, the last perp trade. |
| `app/server/src/market/flow.ts` | Flow per minute, large orders, the auto big-trade size, the live candle, the flow per candle. |
| `app/server/src/market/book-heat.ts` | The book sampler and the heatmap: minutes, columns, persistent walls. |
| `app/server/src/http/routes/desk.routes.ts` | `/api/candles`, `/api/chain`, `/api/perp` (with `perpOi`), `/api/flow/bars`, `/api/flow/large-prints`, `/api/flow/heatmap`. |
| `app/server/src/http/ttl-cache.ts` | One shared read per key for a few seconds, for the chart's pollers. |
| `app/server/src/http/routes/stream.routes.ts` | `/api/stream`, including the `ltp` event. |
| `app/web/scripts/smc-study.ts` | The engine replayed over cached history: funnel, variants. |
| `app/web/scripts/crt-study.ts`, `intraday-momentum-study.ts` | Declared studies of published / popular models (§14). |
| `app/web/scripts/momentum-study.ts`, `combo-study.ts` | Entries, stops and exits for big moves; daily trend, the layers as filters, the SMC plan against the trend (§14). |
| `app/web/scripts/profile-study.ts`, `flow-study.ts` | Declared studies of the volume profile (Delta candles) and of CVD / delta, OI, funding and top traders (Binance history in `cache/binance`) (§14). |
| `research/*.txt` | The studies' latest outputs. |

---

## 3. What is read, and from where

Read once in `entry/feed.ts` and shared by every chart on the screen.

| Input | Source | Refresh | Used for |
|---|---|---|---|
| 5m candles, ~36 hours | `/api/candles?tf=5m` (the desk's own poll, `App.tsx`) | every minute | 5m charts; 15m and 30m charts folded from them; 5M / 30M / 15M context; 15m structure on lower charts. |
| 1H candles, 14 days | `/api/candles?tf=1h` | every minute | 1h charts; 4h charts folded from them; 1H regime; 1H order blocks on lower charts. |
| 1m candles, 8 hours | `/api/candles?tf=1m` | every minute; 10 s while a 1m or 3m chart is shown | 1m charts; 3m charts folded from them; 1M context. |
| The live price | `/api/stream`, event `ltp` | pushed on each new trade (checked 10×/s) | The forming candle and the LTP chip. |
| Flow per candle | `/api/flow/bars` | 10 s, only while a 1m / 5m chart is shown | Δ / CVD pane, the Flow line. |
| Large taker orders | `/api/flow/large-prints` | 15 s | Big-trade bubbles, the Big line. |
| The book heatmap | `/api/flow/heatmap` | 20 s, newest columns only, only while a 1m / 5m chart is shown | Heatmap and walls. |
| The option board | `/api/chain` (the screen's own load) | 5 s | Strike levels (OI, its 1h change), max pain. |
| The perpetual | `/api/perp` (the screen's own load) | 5 s | OI against an hour ago and its read, funding. |

A folded chart (3m, 15m, 30m, 4h) draws its forming candle too
(`foldForChart`); the engine still reads whole, closed candles only.

**The live price is the perpetual's own tape.** The server's trade socket
holds every BTCUSD print; the stream's `ltp` event carries the last trade and
the 1m and 5m candles in progress built from those prints. The chart merges
that candle into the exchange's (`withLiveBar`): high and low widened to the
trades', close the last trade, volume whichever saw more (they agree to the
contract when the socket saw the whole minute), open the exchange's. The next
candle is added from the tape before the exchange lists it -- every value in it
traded. Only with the stream down does the forming candle fall back to the
index spot (`withLtp`), which differs from the perp by the basis and refreshes
every eight seconds; until 29 Sep 2026 that was the only source. The **LTP
chip** shows the last trade (green / red by tick), the time left in the
candle, and "N m ago" when nothing has printed for a minute.

**Latency.** A trade reaches the screen within about 0.1 s plus the network:
the stream checks for a new trade ten times a second and writes only when
there is one. The chart sends the library only what changed -- a tick of the
forming candle, or one new candle, is `update()` on the last bar, not the
whole history again (`tailFrom`); the heatmap and bubbles are rebuilt only
when a candle is added or their data arrives, not on every tick. The server
shares each flow / big-trade / heatmap read between pollers for 3-5 s
(`http/ttl-cache.ts`), so more open tabs do not mean more database reads.

**Closed candles only, for the engine.** A candle opened at *t* closes at
*t + tf*; anything not closed is left out of every engine (`closedBars`). The
forming candle is drawn, but nothing is read off it, so a label never appears
and vanishes within a candle. A higher-timeframe bucket counts only when all
of its 5m candles are there (`aggregate`). The order-flow layers are facts as
they happen (a trade that printed, an order resting now), so they do include
the forming candle.

---

## 4. The no-lookahead contract

The engine has one way in, `push(bar)`, and sees only the candles pushed before
it. Every object records:

- `at` -- the candle it belongs to and is drawn on;
- `known` -- the candle whose **close** made it knowable.

A swing with a two-candle confirmation is `at: 40, known: 42`. Nothing is ever
edited afterwards: a zone touched, filled or broken, a pool swept or taken, a
setup moving through its states, a stop moving -- each is a new event with its
own `known`. A setup's plan (entry, stop, targets) and its fill are fixed when
made.

Tests that hold it (`engine.test.ts`):

- **Replay**: over 864 candles, the history at every candle *k* is identical
  whether the engine stopped at *k* or ran to the end -- for the default options
  and for the desk's.
- The plan and the fill never change once made.
- Nothing is known before the candle it is drawn on; every swing is known two
  candles after it.
- Higher timeframes: a 1H break is not the trend until its candle has closed
  (`context.test.ts`).
- The chart hands the scene nothing past the last closed candle
  (`PriceChart.test.tsx`, `scene.test.ts`).

---

## 5. Detection rules

Each is one function in `engine.ts`, and deliberately plain. ATR is Wilder's
14. "Tolerance" is max(0.1 ATR, 0.005% of price).

| Concept | Rule |
|---|---|
| **Swing** HH / HL / LH / LL / EQH / EQL | Fractal: higher (lower) than 2 candles before it and not exceeded by 2 after. Known when those 2 have closed. Labelled against the previous confirmed swing of that side; equal within tolerance. |
| **BOS / CHoCH / MSS** | A **close** through the latest unbroken swing (a wick is not a break). With the trend: BOS. Against it: CHoCH. A CHoCH on a displacement candle: MSS. The break sets the trend. |
| **Order block** | On each break: the last opposite-coloured candle at the origin of the breaking leg (the extreme since the broken swing, up to four candles back). Its full range is the zone. |
| **FVG** | Three candles: the first's high below the third's low (bullish), or the reverse; a gap of at least 0.05 ATR. Drawn on the middle candle, known at the third. |
| **Zone events** | `touched`: the first retest of the proximal edge. `filled`: a gap's far edge reached. `broken`: a close through the far edge -- an OB is then a **breaker**, an FVG an **IFVG**, facing the other way. |
| **Liquidity** | Every confirmed swing is resting liquidity: BSL above, SSL below. Two within tolerance merge into **EQH / EQL**. Reference levels: PDH / PDL, PWH / PWL, PMH / PML (UTC day / week / month), the Asia high / low and London high / low -- each known from the first candle after its period ends. |
| **Sweep vs taken** | A wick through a pool that closes back: a **sweep** (a liquidity grab), labelled with its session ("London SSL sweep"). A close through: **taken**. Either ends the pool. |
| **Displacement** | A candle whose body is at least 1.5 ATR (of the candle before) and 60% of its range. |
| **Candle tags** | Engulfing (body at least 0.5 ATR), pin bar, inside bar, doji, volume spike (2× the 20-candle mean), volume dry-up (0.35×). |
| **Premium / discount** | Between the latest confirmed swing high and low; EQ at 50%; OTE 62–79% back into the range in the trend's direction. |
| **VWAP / day open** | Per UTC day (00:00 UTC = 05:30 IST, the desk's entry). |
| **Sessions** | By the candle's UTC hour: Asia 00–07, London 07–12, New York 12–20; 20–24 none. |
| **Retirement** | Pools and zones more than 2,000 candles old (about a week of 5m) leave play; their history stays. |

---

## 6. Setups

> **Research only since 30 Sep 2026.** The engine still builds setups
> (§6–§9), and the research scripts replay them, but the chart neither draws
> nor reads them: the desk's one entry logic is the entry section's
> ([entry-setups.md](entry-setups.md)). The rules are kept here because the
> studies in §14 are about them.

### Two ways a setup starts

**Reversal.** A sweep of sell-side liquidity starts a long (buy-side, a short):

```
SSL swept                                       SETUP FORMING
  → bullish CHoCH / BOS
  → displacement in that move: a displacement candle, or the FVG such a move leaves
  → an OB left by the break (else an FVG since the sweep)     plan fixed (READY)
  → entry                                        ENTRY (ACTIVE)
```

**Continuation.** A with-trend BOS made with displacement is itself the setup,
no sweep needed. It never replaces a setup already running on that side.

### The state machine

| State | Meaning | Ends when |
|---|---|---|
| `FORMING` | Liquidity swept; waiting for the displaced structure shift. | A newer sweep on the same side (superseded); a close beyond the sweep (it was a breakout, not a grab); 24 candles without a displaced shift. |
| `READY` | The plan is fixed. With the desk's break entry this lasts no time: the same candle enters. | Retest entries only: a close through the stop; ran to TP1 without a retest; 30 candles without a retest and a close back out. |
| `ACTIVE` | In the trade. | A target, the stop, the opposite entry, or 96 candles (time exit). |
| `TP1`, `TP2` | Targets reached, still running. | The next target, the stop in force, the opposite entry, time. |
| `TP3` | Final: every target reached. | -- |
| `STOPPED` | Final: the stop before TP1. | -- |
| `PROTECTED` | Final: after TP1, stopped at the protected stop (break-even or trailed). | -- |
| `INVALIDATED` | Final: never entered (see the refusals below), or superseded. | -- |
| `EXPIRED` | Final: never entered in time, a time exit, or **closed by the opposite entry**. | -- |

**Refusal reasons carry their numbers**: "stop too tight for the fees: risk
180 pts, needs 420 pts (0.5% of price)", "TP1 BSL pays 0.9R, under 1.5R". The
HUD shows the last refused plan as a checklist -- ✓ each confirmation, ✗ the
check that failed -- and the chart marks it on its candle.

**One position at a time.** An entry in the other direction closes the open
trade at the same price (stop and reverse); the closed trade keeps its record
("closed by the opposite entry"). The HUD and the chart both show the most
advanced open setup (`liveSetup`), so they never describe different ones.

### Refusals (a plan made but no trade)

- no OB or FVG left by the move
- stop wider than four ATR, or under the fee floor
- no liquidity at all to aim at
- (retest entries) closed through the stop first, ran without a retest, the
  confirmation came too far from the zone

Each is marked on the candle it ended, quietly: "No long: stop too wide".

### Entry modes (`entry`)

| Mode | Entry | Desk |
|---|---|---|
| `break` | At the close of the break itself -- momentum rarely comes back. | **yes** |
| `close` | After the retest: a candle that trades into the zone and closes back out of it in the trade's direction; entry at that close. | |
| `limit` | A resting limit at the zone's proximal edge. | |
| `hybrid` | The break when it came with a displacement candle and the 1H trend agrees; the retest otherwise. | |

HUD names: **SETUP FORMING**, **RETEST READY** (retest modes), **MOMENTUM
ENTRY** (entered at the break) or **ENTRY CONFIRMED** (entered on the retest),
then "— TP1 reached" and so on.

---

## 7. The stop

**Desk (`stopAt: 'swing'`):** beyond the last confirmed swing on the far side of
the entry -- the swing low under a long, the swing high over a short, the
displacement's base -- plus the buffer:

```
buffer   = max(1 point, 0.15 × ATR)
stop     = last confirmed swing low − buffer            (long)
floor    : at least 1 ATR from the entry, never nearer        (the owner's setting)
cap      : more than 4 ATR from the entry is no trade
fees     : a stop under 0.5% of the price is no trade -- the round trip
           (0.05% a side) would cost more than 0.2R of it
```

Every initial stop records why it is there (`stopNote`): "below 5m swing HL
83,120 · buffer 30 pts", or "widened to 1 ATR (190 pts) from the entry". The
chart's SL label and the HUD show it.

If there is no confirmed swing beyond the entry, the zone's distal edge is
used. Other modes: `zone` -- beyond the POI's distal edge; `sweep` -- beyond
the sweep's extreme as well.

**Once in the trade the stop only tightens:**

- **Break-even** only after TP1 **and** a newly confirmed swing in the trade's
  favour (a higher low for a long) -- not blindly at TP1.
- **After TP2** it trails behind the last confirmed swing (minus the buffer),
  and behind each new one.
- Every move is an entry in `trail` with its reason; the plan's `stop` is never
  rewritten.

---

## 8. The targets

**Desk (`targetMode: 'r-min'`, `targetR: [2, 3, 4]`):** every target is a
multiple of the risk, and the risk is measured in ATR -- so the targets are
ATR-based:

```
TP1 ≥ 2R   TP2 ≥ 3R   TP3 ≥ 4R        (R = entry to stop)
```

Each is pulled to the nearest liquidity sitting between its R and one R
further (a swing, EQH / EQL, a session high / low, a previous day / week /
month level, an opposing OB) -- the level is where orders sit, and the label
says which. With no level there it is the exact projection, labelled
"2R · 3.1 ATR projection". A target is never nearer than the previous one.

Other modes: `liquidity` -- TP1 the nearest internal liquidity, TP2 the next
external level, TP3 the opposing zone, R extensions only where the chart has
no level; `r-multiple` -- exact projections only.

---

## 9. In the trade, and the result

- **Scale out** 30% at TP1, 30% at TP2, 40% at TP3.
- **Inside one candle** the stop is checked before the targets -- the order is
  not in the candle, and the record is not allowed to guess in its own favour.
  On a retest fill candle no target is awarded (the break entry fills at a
  close, so the candle is already over).
- **Result in R** = the thirds banked at the targets reached + the rest at the
  exit price. A stop before TP1 is −1R. MFE and MAE are recorded in R.
- **Fees** in the research: 0.05% a side (taker) on the whole position; with
  maker take-profits the cost falls by about 0.03R a trade.

---

## 10. Context

- **Row:** 1H Regime, 30M Bias, 15M Structure, 5M Setup, 1M Trigger -- each the
  direction of that timeframe's last structure break, from its closed candles.
- **Gate:** a setup against the **30M bias** or the **15M structure** is shown
  but called **NO TRADE**, faded, with what it runs against. The 1H and 1M do
  not gate.
- **On the chart:** the 1H order blocks (nearest two a side) and the latest
  three 15m breaks, each named with its timeframe ("1H Bull OB", "15m CHoCH"),
  placed on the 5m candles by time.
- Each setup (research only, §6) records the 1H trend known at its own candle
  close (`htf`); the gate and the trend-plan alignment were on the chart until
  30 Sep 2026.

---

## 11. What is drawn: price action and the entry setup

**Layers** (Layers menu, remembered per browser under `chart:layers:v5`).
Everything on at once buries the entry setup, so the menu opens with **presets**
-- one click each -- and every layer stays a checkbox below them:

| Preset | Layers |
|---|---|
| **Desk** (default) | structure, liquidity, OB / FVG, levels, saved, option strikes, big trades, volume profile, Δ / CVD |
| Clean | structure, liquidity, OB / FVG, saved |
| Order flow | heatmap, big trades, volume profile, Δ / CVD, saved |
| Options | option strikes, levels, volume profile, saved |
| All | every layer |

Each layer carries **what the research says about it** under its name --
"Measured: POC no magnet, 80% rule no edge", "Recorded since 29 Sep 2026 --
too new to measure" -- so no line is read as more than it has been shown to be
(§14).

**The entry setup.** Not a layer: the entry section's **Setups on chart**
switch turns it on and off for every chart at once. For the panel's chosen
TRADE (`chart/entry-layer.ts`):

| Item | Label |
|---|---|
| Entry zone, a box from the trigger candle to the right edge | `LONG #3 Liquidity sweep (with TF) · entry 84,120–84,160` |
| Stop | `SL 83,980` |
| TP1 | `TP1 84,300 · R:R 2.1` (after fees, as the server gave it) |
| TP2, TP3 | `TP2 84,500`, `TP3 85,000 (expected move)` |

Until 30 Sep 2026 the chart drew its own SMC trade here -- a position box
with the stop's moves and each target's banked R -- and a Trades dialog of
its history and the trend plan's paper log. Both went with the chart's own
entry logic.

**Background and foreground.** History and context -- structure more than 48
candles old, swept liquidity, HTF zones, big trades more than 48 candles
old -- are drawn at reduced strength with lower label priority; the entry
setup is drawn strongest.

**Clutter rules** (`scene.ts`): three resting pools a side (nearest), three OBs
and three FVGs a direction (nearest), the latest six sweeps (one a candle and
side), the latest twelve breaks, the latest of each reference level. Labels are
placed by priority -- the entry setup, walls, structure breaks, sweeps, liquidity,
POC, zones, levels, nodes, bubbles, swings, sessions, tags -- and one that
would overlap a more important label, the HUD or the toolbar is not drawn. A
shape off the visible range is not drawn rather than clamped to the edge.

**Time axis** in IST, like the crosshair.

---

## 12. What is drawn: order flow

Each layer answers one question, and they are kept apart so each keeps its
meaning:

| Layer | Question | Traders | Source | Measured (§14) |
|---|---|---|---|---|
| Liquidity heatmap + walls | Where are orders **resting**? | passive (limit orders) | the recorded order book | too new |
| Big-trade bubbles | Where did large orders **execute**? | big, aggressive | the recorded large taker orders | too new |
| Δ / CVD pane | Who is **crossing the spread**, and how hard? | aggressive (market orders) | the recorded tape per minute | no edge (Binance) |
| Volume profile | Where has volume been **accepted**? | everyone | the candles in view (+ the flow's split) | no edge |
| Option strikes | Where is the option board **positioned**? | option sellers and buyers | the live chain | no history |
| Context line | Is the perp **adding or cutting** positions; how crowded; how volatile? | everyone | `/api/perp`, the chart's ATR | no edge (Binance) |

### Liquidity heatmap (passive traders)

- **Recorded**: the server reads Delta's order book every ten seconds (500
  levels a side, about ±1.2% around price), puts each level in its $10 of
  price, and writes each minute's **average** resting size per $10
  (`book_heat_1m`). Averaging is the first defence against spoofing: an order
  that sits for one snapshot of six shows at a sixth of its size.
- **Drawn**: one column per candle, the candle's minutes averaged, in $25 bins
  on 5m ($10 on 1m), behind everything else. Colour runs deep blue → cyan →
  yellow by the square root of the size against the **95th percentile** in
  view, so the one enormous bin at the touch does not wash out every other
  level; faint cells are not drawn, and the strongest stays translucent over
  the candles.
- **Persistent walls**: a $25 level holding at least **3× the side's median**
  resting size, in **every minute for at least five running, up to now**. The
  three biggest a side are drawn as a yellow line from where the wall began,
  labelled `Ask wall 84,200 · 12.4 BTC · 15m`.
- **What it is not**: the whole market (one exchange's visible book), or a
  promise (walls are pulled and moved). A wall is a place to watch, not a
  level that will hold.

### Big trades (big, aggressive traders)

- **Recorded**: every taker order on the perpetual of 200 contracts (0.2 BTC)
  or more, at its own millisecond, side, average price and size
  (`large_prints`). Prints sharing a millisecond and a side are one order
  filling through several levels.
- **How big is big is set by the market, not chosen**: the server takes the
  **90th percentile** of the recorded large orders over the chart's window
  (roughly the top 0.3% of all trades), never under 0.2 BTC. With too few
  recorded yet it uses the socket's last hour. The HUD's Big line shows the
  size in use; its tooltip says how it was set.
- **Drawn**: all of one candle's big buys are one bubble and all its big sells
  another, at their volume-weighted price -- at most two a candle, never
  circles stacked inside each other. **Blue for buyers, fuchsia for sellers**,
  so a bubble never reads as a green or red candle; a hollow ring with a light
  fill and a dot at the exact price, so the candle shows through. Area in
  proportion to size against the 98th percentile shown; the largest about one
  candle wide (6–18 px), so they scale with zoom; larger drawn first so a
  smaller one on the same candle stays visible. The five biggest are labelled
  (`Buy 2.1 BTC · $175k ×3`); older than 48 candles, faded.
- **Hover** a bubble: side, size, dollars, the number of orders, the average
  price and range, the time (IST), and what it means ("Taker bought: lifted the
  offer").
- **HUD**: `Big ≥0.7 BTC · ● 8 buy 4.0 · ● 4 sell 2.0 · net +2.0 BTC` -- the big
  trades in the candles in view.

### Δ / CVD pane (aggressive traders)

- A pane under the price: each candle's **taker buying minus selling**
  (contracts) as a histogram, green / red, **faded** where the candle has
  minutes missing from the record, **absent** where nothing was recorded -- a
  gap in the record is not a flat market. **CVD**, the running delta from
  00:00 UTC (05:30 IST, the VWAP's day), on its own scale in the same pane.
- **Flow line** in the HUD for the candle under the crosshair: delta, buyers'
  share, trades, and its **pace** -- trades against the average of the twenty
  whole candles before (the forming candle scaled to a whole one; amber from
  2×). With fewer than five candles before, no pace is claimed.
- From `/api/flow/bars`: the recorded minutes (`trade_flow_1m`) and the
  socket's current one, the perpetual's prints only.

### Volume profile

- Volume at price over the candles **in view**, recomputed on every scroll and
  zoom: a histogram anchored to the right edge (at most a fifth of the width),
  the value area brighter, the POC bin amber, and **POC / VAH / VAL** levels
  with their prices. Candles do not say where inside their range they traded,
  so each candle's volume is spread evenly over its high-low (48 bins); the
  value area grows from the POC towards the busier neighbour until it holds
  70% of the volume.
- **Nodes**, on the profile smoothed over three bins so one noisy bin is not a
  node: **HVN** (a peak of at least half the tallest, not the POC) as an amber
  tick at the profile's edge; **LVN** (a valley under a third of the tallest
  with a peak twice as tall on both sides -- a thin area between two areas of
  acceptance) as a cyan tick, and the LVN nearest price as a labelled level.
- **Split by the aggressor.** Where the desk recorded the candles' flow, each
  candle's taker-buy share is spread over its range like its volume, and each
  bar shows buyers (blue, nearest the price scale) against sellers (fuchsia) --
  the bubbles' colours. A bar whose volume is mostly from candles without a
  recorded split stays grey rather than implying one; the POC keeps an amber
  outline.
- Measured (§14): yesterday's POC is traded through no more often than a level
  as far from the open on the other side, and the 80% rule loses before fees
  -- the profile shows where volume was, not where price will go.

### Option strikes on price

- The option board's three biggest **call** strikes and three biggest **put**
  strikes within 3% of price, each a dashed line across the chart (orange
  calls, teal puts) as thick as its share of the biggest, labelled
  `CE 83,000 · OI 236 BTC · +12.0 1h` -- open interest in BTC (0.001 a
  contract) and its change over the last hour. The biggest of each side is
  drawn full, the others faded. **Max pain** as a dotted violet line when it
  is within 5%.
- From the chain the screen already loads; moves with the board, not the tick.
- Positioning, not a promise: OI does not say which side of each contract is
  the seller, and there is no history before September 2026 to measure it on.

### The trend plan (1H breakout) -- off the chart

- **Rules** (`lib/trend/breakout.ts`): a close beyond the 20-candle high /
  low; the stop 2 ATR(14) from the entry; then a chandelier stop, 3 ATR from
  the best price since entry, only ever tighter; **no target**. Of every entry
  and exit tested (§14) it was the only plan positive after fees in both
  halves, not significantly.
- It was a layer and a HUD line until 30 Sep 2026 -- an entry logic of its
  own -- and went with the chart's. **The paper log goes on**: `trend_paper`
  (`strategy/trend-paper.ts`) is still written every five minutes and read at
  `GET /api/trend/paper`, so its forward test and its pre-registered filters
  are still decided by live data; nothing on the screen shows it.

### Positioning and volatility (the HUD's context line)

- **Perp OI** now against an hour ago (`perp_snapshots`, every five minutes),
  in BTC, with its change and the read it makes with the price over the same
  hour: new longs / new shorts / short covering / long unwinding / flat (under
  0.5% of OI or 0.1% of price). `/api/perp` → `perpOi`.
- **Funding** as Delta publishes it, per period; red above 0.02% (crowded
  longs), green below zero.
- **Volatility regime**: this chart's ATR(14) against its median over the
  candles loaded -- expanding from 1.3×, quiet under 0.7× -- with the ATR in
  points, which is what the stop's buffer and floor are sized from.
- Measured (§14, on Binance's history): none of the four OI reads, nor
  funding at its extremes, moved the next hour or day the same way in both
  halves of 2024-26.

---

## 13. The tables behind the layers

| Table | Written by | What | Kept |
|---|---|---|---|
| `trade_flow_1m` | `market/flow.ts`, every 20 s | the perp's tape per minute: buy / sell volume and count, large ones, VWAP, high, low | a year |
| `large_prints` (`market-015`) | `market/flow.ts`, with the minute rows | every perp taker order ≥ 200 contracts: ms, side, average price, size | a year |
| `book_heat_1m` (`market-016`) | `market/book-heat.ts`, every 20 s | the book each minute: average contracts per $10, bids and asks, the touch, samples | 14 days |
| `trend_paper` (`trend-001`, `trend-002`) | `strategy/trend-paper.ts`, every 5 min | the trend plan's trades: signal, entry, stops, exit, net R, first seen, live, the two filters | kept |
| `perp_snapshots` | `market/flow.ts`, every 5 min | funding, OI, turnover, the top of the book; read for the OI change an hour back | a year |
| `oi_snapshots` | `market/oi-history.ts`, every 5 min | each strike's OI; read for the strikes' 1h change | 48 hours |

All are written `ON CONFLICT DO NOTHING` on their time key, so a restart or a
replayed snapshot cannot double a row; details in [reference/database.md](../reference/database.md).

---

## 14. What the research says

### The SMC engine

`app/web/scripts/smc-study.ts` replays the engine over every cached 5m candle
(10 Jan 2024 – 31 Aug 2026, 275,548 candles; `cache/candles`, git-ignored) with
fees of 0.05% a side. Twenty-four variants in four rounds, each round declared
before it ran, chosen on 2024–25 and judged once on 2026. Net R a trade after
fees:

| Variant | 2024–25 | 2026 | 2026 win |
|---|---|---|---|
| A as first built: zone stop, retest-close entry | −0.75 | −0.79 | 23% |
| I + continuation, stop ≥ 1.5 ATR | −0.50 | −0.66 | 27% |
| J I, no TP1 minimum | −0.43 | −0.57 | 35% |
| L J, entered at the break | −0.42 | −0.56 | 38% |
| M J, hybrid entry | −0.44 | −0.56 | 35% |
| O L on 15m candles | −0.23 | −0.20 | 42% |
| P L on 1H candles | −0.14 | −0.05 | 49% (125 trades) |
| V L, stop at the swing | −0.37 | −0.48 | 41% |
| **X V, targets ≥ 2R / 3R / 4R (the desk)** | **−0.37** | **−0.46** | 31% |

1. **Before fees every variant is near zero** (−0.24R to +0.04R a trade). The
   rules describe the chart; they do not predict its direction on BTC.
2. **Fees decide the sign.** On 5m a round trip is about 0.3R; on 15m and 1H
   the same rules lose less (−0.20R, −0.05R in 2026) because bigger moves make
   the fee a smaller share of R. Neither is an edge.
3. **The structural stop** beats the zone-edge stop in every pairing.
4. **Momentum vs retest.** Entering at the break catches about 30% of 1-hour
   moves of 1% or more; waiting for the retest caught about 8%.
5. **Target ladders** move the win rate more than the result.
6. A TP1 *minimum* removed more good trades than bad; the London / New York
   filter changed nothing.

**Round five** added the fee floor (no trade whose stop is under 0.5% of
price), which cut the loss to −0.14R (2024–25) and −0.27R (2026); the desk runs
it. **Setup-quality segmentation** (swept-liquidity type, BOS / CHoCH / MSS,
OB / FVG, displacement, entry volume, session, 1H agreement, risk size) found
**no slice** positive on 2024–25 with t ≥ 2 and positive again on 2026. Until
30 Sep 2026 the HUD printed the desk's record beside every setup: **1,665 trades, 35% winners,
−0.17R a trade after fees (2026 −0.27R), 25% of big moves caught.**

### Published and popular models

| Study | Declared rules | 2024–25 | 2026 | Verdict |
|---|---|---|---|---|
| Intraday momentum (Shen, Urquhart & Wang 2022): first half hour → last half hour | both signals from the paper, 952 UTC days | gross +0.5 bp (t 0.5) | gross −4.4 bp (t −2.3) | fees are 10 bp; not adopted |
| CRT-1H / 4H / 1D, Asia range (the CRT / Turtle Soup / PDH-PDL / PO3 family): range → first side swept → close back inside → target the far side, stop at the sweep | eight variants (four ranges × fee floor) | best: CRT-1D + floor −0.01R (172 trades) | +0.11R (54 trades, t 0.46) | slightly positive **before** fees, tight stops lose it to fees; no edge by the rule (t ≥ 2) |

`research/INTRADAY-MOMENTUM.txt`, `research/CRT-STUDY.txt`. Thirty-odd
variants on one data set is already a lot of looking; the next one is more
likely to find luck than an edge.

### The profile and the order-flow layers (29 Sep 2026)

The desk's own flow is weeks old, so the flow was measured on **Binance's
BTCUSDT perpetual** -- the dominant venue, its public 1-minute candles carry the
taker-buy volume, and its archive has 5-minute open interest, funding and the
top traders' positioning (`data.binance.vision`, cached in `cache/binance`).
Declared first, 2024-25 then 2026, a 10 bp round trip.

| Study | 2024–25 | 2026 | Verdict |
|---|---|---|---|
| A1 80% rule (open outside yesterday's value area, back inside for an hour → the far edge) | −0.17R (t −2.4) | −0.35R (t −3.1) | loses before fees |
| A2 yesterday's POC as a magnet (hit vs its mirror) | 61.5% vs 59.2% (z 0.8) | 64.8% vs 64.8% | no magnet |
| B1 CVD divergence at a new 1h high / low, faded 1h | +0.5 bp gross | +0.2 bp gross | no |
| B2 the desk's SMC trades with vs against the entry candle's delta | −0.14R vs −0.11R | −0.27R vs −0.25R | 95% already agree; no change |
| C1 OI / price reads → next 4h | +2.0 bp ("new longs") | +23.3 bp (t 3.0) | not the same in both halves |
| C2 funding in its top / bottom tenth → next 24h | not significant | not significant | no |
| D top traders adding / cutting longs → next 4h | −8.6 bp (t −3.1) / +5.8 | −2.3 (t −0.4) / +5.0 | contrarian hint, not significant on 2026 |

`research/PROFILE-STUDY.txt`, `research/FLOW-STUDY.txt`. The layers stay --
they show where volume, size and positioning are, which is worth seeing -- but
nothing on the chart claims they predict, and no signal was built from them.
The heatmap and big trades on Delta itself have no history yet; they will be
measured the same way once there are a few months.

### Entries, stops and exits for big moves (momentum study)

| Plan | 2024–25 | 2026 | Big moves positioned for |
|---|---|---|---|
| Desk SMC entries, its ladder exit | −0.14R | −0.27R | 19% / 13% |
| same entries, all out at 2R | −0.15R | −0.14R | 22% / 20% |
| same entries, 3 ATR chandelier, no target | −0.17R | −0.21R | 9% / 8% |
| same entries, break-even at 1R then chandelier | −0.16R | −0.20R | 16% / 14% |
| **20-candle breakout, 1H** (the trend plan) | **+0.11R** | **+0.00R** | **38% / 45%** |
| **20-candle breakout, 4H** | **+0.29R** | **+0.03R** | **44% / 49%** |
| 20-candle breakout, 15m | −0.34R | −0.24R | 32% / 33% |
| 1H breakout after a squeeze | +0.26R | −0.20R | 14% / 13% |
| 1H breakout with the 200 EMA | +0.07R | −0.01R | 31% / 37% |

The SMC entries lose with every exit: the entries, not the exits, are where
they lose. `research/MOMENTUM-STUDY.txt`.

### Strategy search: daily trend, the layers together, SMC against the trend

- **Daily trend following** on Binance 2020-26 (2020-23 never used before):
  no rule beat simply holding BTC's Sharpe in both halves (buy and hold 1.00 /
  0.72); trend rules cut drawdowns (~−46% against −77%) -- protection, not
  return. Best: 20-day momentum sized to 40% volatility, Sharpe 1.15 / 0.36.
- **The layers as filters on the trend plan**: a volume burst on the signal
  candle and London / New York hours beat the plain plan in both halves on 1H
  and 4H; none significant, and two of twelve is what luck gives. They are
  **pre-registered in the paper log**, not added to the plan.
- **The SMC plan against the trend plan**: with the 4H plan −0.07R / −0.15R,
  against it −0.18R / −0.33R; shown on the SMC box until 30 Sep 2026 (§10).
- 2026 has now judged several of these; the paper log is the clean test from
  here. `research/COMBO-STUDY.txt`.

**Re-run** after changing a rule, and commit the outputs:

```
app/server/node_modules/.bin/tsx app/web/scripts/smc-study.ts
# writes research/SMC-STUDY.txt
app/server/node_modules/.bin/tsx app/web/scripts/crt-study.ts
app/server/node_modules/.bin/tsx app/web/scripts/intraday-momentum-study.ts
cd app/web && ../server/node_modules/.bin/tsx scripts/profile-study.ts
cd app/web && ../server/node_modules/.bin/tsx scripts/flow-study.ts   # needs cache/binance
cd app/web && ../server/node_modules/.bin/tsx scripts/momentum-study.ts
# writes research/MOMENTUM-STUDY.txt
cd app/web && ../server/node_modules/.bin/tsx scripts/combo-study.ts  # needs cache/binance
cd app/server && npm run sync:trend    # after any change to lib/trend/breakout.ts
```

---

## 15. Not built

**Order flow, needing a new recorder or source:**

- **Footprint** (bid × ask volume at each price inside a candle), **stacked
  imbalance** and **absorption** (aggressive volume into a level that holds):
  the tape is summed per minute, not per price; a per-price, per-minute record
  is the next recorder.
- **Wall events**: pulled (gone as price came near), filled (traded through),
  moving -- need the walls' own history, then the prints at their price.
- **Basis** (perp mark against the index): recorded (`index_1m`,
  `perp_snapshots`), not shown -- small and steady on the perpetual.
- **Liquidation clusters**: Delta publishes none; third-party heatmaps are
  model estimates behind a paid API.
- **SMT divergence** (BTC vs ETH): needs ETH candles alongside.
- **TPO / market profile**, **initial balance**, **single prints**: for a
  round-the-clock market these largely repeat the volume profile.
- **Anchored VWAP** (the day VWAP is a layer); **spread / depth** and **book
  imbalance** as HUD figures (recorded in `perp_snapshots`); **gamma / greeks**
  (recorded in `option_snapshots`, but with no dealer positioning published a
  "dealer gamma" would be a guess).

**Price action and the engine:**

- Setup history in the database (every completed setup saved): needs a table
  whose schema waits for the owner's go-ahead.
- A candle that touches both the stop and a target resolved from 1m candles
  (today: the stop, the assumption that cannot flatter the record).
- Data-failure states on the chart (a gap, a duplicate, a stale feed) as
  "DATA UNAVAILABLE".
- Zone freshness by retest count (today: fresh / tested).
- BPR, Unicorn (breaker ∩ FVG), liquidity voids, CISD, internal vs external
  structure, RSI divergence.
- NDOG / NWOG: BTC trades round the clock, so the day's "gap" is close to
  nothing by construction; a definition would have to be chosen first.
