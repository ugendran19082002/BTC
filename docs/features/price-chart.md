# The price chart

Built 28–29 Sep 2026; on 30 Sep 2026 it lost its own entry logic and moved
into the entry section; on 4 Oct 2026 it lost its layers. The desk's price
chart is now BTCUSD candles and volume on any of 1m-4H, the one setup the entry
section hands it -- entry box, stop, targets -- and a corner readout (the HUD)
that reads the candle, the timeframe context and how the perpetual is
positioned.

**It decides no entry.** Until 30 Sep 2026 the chart ran a setup of its own
(the SMC engine's live setup, its position box, a Trades dialog) and the 1H
trend plan, beside the entry section's twelve methods -- two entry logics on
one screen. The owner wanted one, so the chart's went and the entry section's
stayed: the one setup the chart draws is the one chosen in the entry section
([entry-setups.md](entry-setups.md)), decided on the server. There is no
full-width main chart any more: the entry section's two panels -- *without
timeframe* and *with timeframe* -- each carry this chart, and its twelve-chart
grid a small one.

**It draws no layers.** Until 4 Oct 2026 a Layers menu switched on fifteen
kinds of context over the candles: structure, liquidity, OB / FVG, levels,
premium / discount, sessions, VWAP, candle tags, 1H and 15m overlays, saved
levels, the book heatmap, big-trade bubbles, option strikes, the volume profile
and a delta / CVD pane. None had shown an edge (§14) and the owner no longer
used them, so they were removed -- the menu, the drawing code, the three API
routes that fed only them, and the saved-levels table. §11 says what went and
what was kept, and why.

This document is the chart's logic and its record: what is read and from
where, the engine's detection rules, and what the research over 32 months of
real candles says. §5–§10 describe the SMC engine (`lib/smc`), which still
reads the timeframe context row and is what the research scripts replay; the
chart no longer draws what it finds.

---

## 1. The screen

```
Entry methods   1 Breakout · 2 Breakout + retest · … · 12 Options

┌─ 12 methods · without timeframe ─┐  ┌─ 12 methods + timeframe ─────────┐
│ read on 1m 3m [5m] 15m 30m 1h 4h │  │ view 1m 3m [5m] 15m 30m 1h 4h    │
│ ┌─ price chart ────────────────┐ │  │ ┌─ price chart ────────────────┐ │
│ │ HUD: price, context, OHLC,   │ │  │ │ same chart, its own timeframe│ │
│ │ OI, funding, big trades      │ │  │ │                              │ │
│ │ toolbar: LTP, Zoom, full scr │ │  │ │ the chosen TRADE:            │ │
│ │ candles, volume,             │ │  │ │ entry box, SL, TP1–TP3       │ │
│ │ the chosen TRADE             │ │  │ │                              │ │
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
- **The HUD** folds to one line (folded by default in a panel and on a phone,
  remembered per chart size): BTCUSD's price
  and the timeframe, the context row (1H regime, 30M bias, 15M structure, 5M,
  1M -- each its last break), the candle under the crosshair, the perp's
  positioning and the volatility regime, the big trades in view, and that
  candle's flow. No setup, no plan, no record.
- **The toolbar**: the LTP chip, the timeframe switch where a chart has one,
  Zoom (pan and zoom are off by default so the page scrolls over the chart),
  full screen.
- **Narrow charts**: the chart sizes its toolbar from its own width (a CSS
  container query), so half a 1024 px screen gets the phone's icon-only
  toolbar and it never runs over the readout.
- **Drawn, back to front**: the setup's entry box behind the candles; the
  candles and volume; the setup's entry, stop and target lines and their
  labels in front.

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
| `app/web/src/components/desk/chart/scene.ts` | What is drawn over the candles, as data: boxes and lines in bar index and price, and the chart's colours. |
| `app/web/src/lib/volume-profile.ts`, `vol-regime.ts` | Volume at price (the profile study's measurement) and the ATR regime the readout shows. The chart's order-flow layers, which these came from, were removed on 4 Oct 2026. |
| `app/web/src/components/desk/chart/scene-primitive.ts` | Draws the scene on the chart's canvas (a lightweight-charts series primitive): boxes behind the candles, lines and labels in front. |
| `app/web/src/components/desk/chart/label-layout.ts` | Label placement by priority; nothing is drawn over anything. |
| `app/web/src/components/desk/chart/ChartHud.tsx` | The corner readout: context, the candle, positioning and the volatility regime. |
| `app/web/src/components/desk/chart/entry-layer.ts` | The entry section's chosen TRADE as scene items: entry box, SL, TP1-TP3. |
| `app/web/src/components/desk/chart/LtpChip.tsx` | The last traded price, tick colour and candle countdown. |
| `app/web/src/components/desk/PriceChart.tsx` | The chart: candles, volume, the primitive, the HUD, the toolbar, the `entry` setup; sized `full`, `panel` or `compact`. |
| `app/web/src/components/desk/entry/feed.ts` | What the entry section's charts are drawn from, read once for all of them: the candles of every timeframe (folded where Delta has none) and the context row. |
| `app/web/src/components/desk/entry/ModePanel.tsx`, `EntryGrid.tsx` | Where the chart is shown: one per panel, twelve small in the grid. |
| `app/web/src/components/overview/Overview.tsx` | Hands the desk (and so the charts) the perp's positioning (OI change, funding) it already loads. |
| `app/server/src/market/flow-socket.ts` | The perpetual's and the options' trade socket: every print, the last perp trade. |
| `app/server/src/market/flow.ts` | Flow per minute, large orders, the live candle: what the entry methods read. |
| `app/server/src/market/book-heat.ts` | The book sampler: minutes and persistent walls, read by the entry methods. |
| `app/server/src/http/routes/desk.routes.ts` | `/api/candles`, `/api/chain`, `/api/perp` (with `perpOi`). |
| `app/server/src/http/ttl-cache.ts` | One shared read per key for a few seconds, for the entry section's pollers. |
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
| The perpetual | `/api/perp` (the screen's own load) | 5 s | The readout's positioning line: OI against an hour ago and its read, funding. |

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
  (`PriceChart.test.tsx`).

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

## 11. What is drawn, and what was removed

**Drawn**: the candles and volume, and the entry section's chosen TRADE
(`chart/entry-layer.ts`): its entry zone as a blue box from the candle its
trigger closed on, the entry as a solid blue line where it fills, the stop in
red and TP1-TP3 in green, each to the right edge and labelled with its price,
its distance in R and in points. A WAIT or NO TRADE draws nothing; **Setups on
chart** off draws nothing. The price axis widens to take in the entry, the
stop, TP1 and TP2.

**Removed on 4 Oct 2026** -- the Layers menu and all fifteen layers:

| Layer | What it drew | What the research said (§14) |
|---|---|---|
| Structure, Liquidity, OB / FVG, Levels, Prem / Disc, Sessions, VWAP, Candles, HTF | the SMC engine's concepts on the candles, and 1H zones / 15m structure on lower charts | SMC rules measured 2024-26: no edge |
| Saved levels | boxes saved in `chart_annotations` | not a study; the table held no rows |
| Liquidity heatmap (book) | resting size per $10 a candle, and persistent walls | recorded since 29 Sep 2026 -- too new to measure |
| Big trades | a bubble per large taker order | recorded since 29 Sep 2026 -- too new to measure |
| Options OI (strikes) | the biggest call and put strikes near price, max pain | positioning -- no history to measure |
| Volume profile | volume at price in view, POC / VAH / VAL, nodes | measured: POC no magnet, 80% rule no edge |
| Delta / CVD pane | taker buying minus selling per candle, cumulative | measured (Binance 2024-26): divergence no edge |

What went with them: the menu and its presets, the scene builders
(`scene.ts`'s engine scene, `flow-layers.ts`), the primitive's heatmap, profile,
bubble, mark and path drawing, the readout's big-trade and flow lines, the
routes `GET /api/flow/bars`, `/api/flow/heatmap`, `/api/flow/large-prints` and
`/api/chart/annotations`, and the `chart_annotations` table
(`chart-002-drop-annotations`).

**Kept, on purpose.** The recorders and their tables stay, because the entry
methods read them: `trade_flow_1m` and `perp_snapshots` (the tape and the
perp's positioning), `book_heat_1m` (the book and its walls), `oi_snapshots`.
`large_prints` is still written and nothing reads it now -- it is the record
the planned order-flow study needs (TODO, "Research"); dropping it is a
separate decision. The SMC engine (`lib/smc`) stays for the readout's context
row and the research scripts, and `lib/volume-profile.ts` for the profile
study.

---

## 12. The tables the layers read

| Table | Written by | What | Kept |
|---|---|---|---|
| `trade_flow_1m` | `market/flow.ts`, every 20 s | the perp's tape per minute: buy / sell volume and count, large ones, VWAP, high, low | a year |
| `large_prints` (`market-015`) | `market/flow.ts`, with the minute rows | every perp taker order ≥ 200 contracts: ms, side, average price, size. Unread since the bubbles went. | a year |
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
